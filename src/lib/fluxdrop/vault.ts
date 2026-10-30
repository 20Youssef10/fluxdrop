// FluxDrop Files vault (v1.3 · FEATURES.md 4.1).
// A persistent, on-device store of everything ever received:
//   - file bytes live in the Origin Private File System (OPFS) under
//     `vault/<transferId>/<relativePath…>` — disk-backed, never fully in RAM;
//   - metadata lives in IndexedDB (idb-keyval, OWN database 'fluxdrop-vault'
//     store 'meta') keyed `meta:<transferId>` — see the store-per-DB note in
//     resume.ts: idb-keyval's createStore can only create a store in a NEW db.
// Budgeting: a user-set byte budget evicts the OLDEST entries first (LRU by
// storedAt). Every function is fail-soft — vault problems can never break a
// transfer, so nothing here throws.

import { get, set, del, keys, createStore } from 'idb-keyval'

export interface VaultFileMeta {
  name: string
  relativePath: string
  size: number
  type: string
  checksum: string
}

export interface VaultEntry {
  transferId: string
  storedAt: number
  totalSize: number
  fileCount: number
  files: VaultFileMeta[]
  verified: boolean
  /**
   * v5-b1: disappearing transfers — epoch ms when this entry auto-purges.
   * Absent = keep until budget/LRU eviction. Stamped from the manifest's
   * ttlMs hint at save time; enforced by sweepVaultExpiry() (idempotent,
   * called on every list + on visibility changes + after each save).
   */
  expiresAt?: number
}

// Budget source of truth. The session store persists `fluxdrop:vault-budget-mb`
// (and mirrors it in bytes); this reader accepts BOTH so the module works
// standalone. Default 2 GB, 0 = unlimited.
export const DEFAULT_VAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024
const BUDGET_BYTES_KEY = 'fluxdrop:vault-budget-bytes'
const BUDGET_MB_KEY = 'fluxdrop:vault-budget-mb'

const META_KEY_PREFIX = 'meta:'
const VAULT_DIR_NAME = 'vault'

// undefined = not initialized yet, null = IndexedDB unavailable.
let metaStore: ReturnType<typeof createStore> | null | undefined = undefined

function getMetaStore(): ReturnType<typeof createStore> | null {
  if (metaStore === undefined) {
    try {
      // Own database (see resume.ts note): createStore can't upgrade an
      // existing DB, so sharing one would silently drop this store.
      metaStore = createStore('fluxdrop-vault', 'meta')
    } catch {
      metaStore = null
    }
  }
  return metaStore
}

/** True when this browser exposes the Origin Private File System. */
export function vaultSupported(): boolean {
  if (typeof navigator === 'undefined') return false
  return 'storage' in navigator && !!navigator.storage?.getDirectory
}

function isVaultEntryShape(v: unknown): v is VaultEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<VaultEntry>
  return (
    typeof e.transferId === 'string' &&
    typeof e.storedAt === 'number' &&
    Array.isArray(e.files)
  )
}

/** Split a relativePath into safe OPFS path segments (no traversal). */
function splitRelativePath(relativePath: string): string[] {
  return relativePath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..')
}

/** The `vault/` directory handle (created on demand), or null. */
async function getVaultDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!vaultSupported()) return null
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(VAULT_DIR_NAME, { create: true })
  } catch {
    return null
  }
}

/** Walk (and optionally create) every directory segment under `base`. */
async function resolveDirForPath(
  base: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean
): Promise<FileSystemDirectoryHandle | null> {
  let dir = base
  for (const seg of segments) {
    try {
      dir = await dir.getDirectoryHandle(seg, { create })
    } catch {
      return null
    }
  }
  return dir
}

/** Read the configured vault budget in bytes (0 = unlimited). */
export function readVaultBudgetBytes(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_VAULT_BUDGET_BYTES
  try {
    const rawBytes = localStorage.getItem(BUDGET_BYTES_KEY)
    if (rawBytes !== null) {
      const n = Number(rawBytes)
      if (Number.isFinite(n) && n >= 0) return Math.floor(n)
    }
    const rawMb = localStorage.getItem(BUDGET_MB_KEY)
    if (rawMb !== null) {
      const n = Number(rawMb)
      if (Number.isFinite(n) && n >= 0) return Math.floor(n) * 1024 * 1024
    }
  } catch { /* ignore */ }
  return DEFAULT_VAULT_BUDGET_BYTES
}

/**
 * Write a transfer into the vault. Each blob lands in OPFS at
 * `vault/<transferId>/<relativePath>` (createWritable streams the Blob to
 * disk internally — no full-file RAM copy), then the metadata record is
 * stored. Returns the complete entry, or null when unsupported/failed.
 * Never throws.
 */
export async function saveToVault(
  entry: Omit<VaultEntry, 'storedAt'>,
  blobs: { relativePath: string; blob: Blob }[]
): Promise<VaultEntry | null> {
  try {
    if (!vaultSupported()) return null
    const store = getMetaStore()
    if (!store) return null
    const vaultDir = await getVaultDir()
    if (!vaultDir) return null

    const blobByPath = new Map(blobs.map((b) => [b.relativePath, b.blob]))
    const full: VaultEntry = { ...entry, storedAt: Date.now() }

    for (const meta of full.files) {
      const blob = blobByPath.get(meta.relativePath)
      if (!blob) {
        // Incomplete payload — refuse to store a partial entry.
        return null
      }
      const parts = splitRelativePath(meta.relativePath)
      const fileName = parts.pop() ?? meta.name
      let dir = await resolveDirForPath(vaultDir, [full.transferId, ...parts], true)
      if (!dir) return null
      const fileHandle = await dir.getFileHandle(fileName, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()
    }

    await set(`${META_KEY_PREFIX}${full.transferId}`, full, store)
    return full
  } catch (err: any) {
    console.warn('[FluxDrop] Vault save failed:', err?.message ?? err)
    // Best-effort cleanup so a half-written transfer never lingers as a ghost
    // (and a failed overwrite never leaves a mixed old/new copy).
    try { await deleteVaultEntry(entry.transferId) } catch { /* ignore */ }
    return null
  }
}

/** Every vault entry, newest first (v5-b1: expiry-swept first). */
export async function listVault(): Promise<VaultEntry[]> {
  try {
    await sweepVaultExpiry()
    const store = getMetaStore()
    if (!store) return []
    const ks = await keys(store)
    const out: VaultEntry[] = []
    for (const k of ks) {
      if (typeof k !== 'string' || !k.startsWith(META_KEY_PREFIX)) continue
      const v = await get<VaultEntry>(k, store)
      if (isVaultEntryShape(v)) out.push(v)
    }
    return out.sort((a, b) => b.storedAt - a.storedAt)
  } catch {
    return []
  }
}

/** One entry by transferId, or undefined. */
export async function getVaultEntry(transferId: string): Promise<VaultEntry | undefined> {
  try {
    const store = getMetaStore()
    if (!store) return undefined
    const v = await get<VaultEntry>(`${META_KEY_PREFIX}${transferId}`, store)
    return isVaultEntryShape(v) ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one stored file back as a disk-backed File. OPFS getFile() hands out a
 * File that streams from disk — it is NOT copied into memory, so re-downloading
 * a multi-GB vault entry is as cheap as the original download.
 */
export async function getVaultFileBlob(
  entry: VaultEntry,
  file: VaultFileMeta
): Promise<Blob | null> {
  try {
    const vaultDir = await getVaultDir()
    if (!vaultDir) return null
    const parts = splitRelativePath(file.relativePath)
    const fileName = parts.pop() ?? file.name
    const dir = await resolveDirForPath(vaultDir, [entry.transferId, ...parts], false)
    if (!dir) return null
    const fileHandle = await dir.getFileHandle(fileName, { create: false })
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

/**
 * Remove a transfer from the vault: the whole `vault/<transferId>` subtree in
 * one recursive removeEntry, plus the metadata record. Missing pieces are
 * ignored so partial states clean up fully.
 */
export async function deleteVaultEntry(transferId: string): Promise<void> {
  try {
    const vaultDir = await getVaultDir()
    if (vaultDir) {
      await vaultDir.removeEntry(transferId, { recursive: true })
    }
  } catch { /* dir may not exist — meta still needs deleting */ }
  try {
    const store = getMetaStore()
    if (store) await del(`${META_KEY_PREFIX}${transferId}`, store)
  } catch { /* ignore */ }
}

/**
 * Enforce the vault budget. Primary accounting is the sum of every entry's
 * totalSize (navigator.storage.estimate() mixes in the WHOLE origin's usage —
 * it stays a hint, never the trigger). Evicts the OLDEST storedAt entries
 * until the vault is under budget. 0 = unlimited. Never throws.
 */
export async function enforceVaultBudget(): Promise<void> {
  try {
    const budget = readVaultBudgetBytes()
    if (budget <= 0) return // unlimited
    const entries = await listVault()
    let total = entries.reduce((s, e) => s + (Number.isFinite(e.totalSize) ? e.totalSize : 0), 0)
    if (total <= budget) return
    const oldestFirst = [...entries].sort((a, b) => a.storedAt - b.storedAt)
    for (const e of oldestFirst) {
      if (total <= budget) break
      await deleteVaultEntry(e.transferId)
      total -= Number.isFinite(e.totalSize) ? e.totalSize : 0
    }
  } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// v5-b1: disappearing transfers — TTL enforcement + full wipe (panic mode)
// ─────────────────────────────────────────────────────────────────────────────

/** Purge every vault entry whose expiresAt has passed. Idempotent, never throws. */
export async function sweepVaultExpiry(): Promise<number> {
  let wiped = 0
  try {
    const store = getMetaStore()
    if (!store) return 0
    const ks = await keys(store)
    const now = Date.now()
    for (const k of ks) {
      if (typeof k !== 'string' || !k.startsWith(META_KEY_PREFIX)) continue
      const v = await get<VaultEntry>(k, store)
      if (isVaultEntryShape(v) && typeof v.expiresAt === 'number' && v.expiresAt <= now) {
        await deleteVaultEntry(v.transferId)
        wiped++
      }
    }
  } catch { /* best-effort — never break a list */ }
  return wiped
}

/**
 * Wipe the ENTIRE vault (every entry + the OPFS vault subtree) — used by panic
 * mode (v5-b2). Returns the number of entries removed. Never throws.
 */
export async function wipeVault(): Promise<number> {
  let wiped = 0
  try {
    const entries = await listVault()
    for (const e of entries) {
      await deleteVaultEntry(e.transferId)
      wiped++
    }
    // Belt-and-braces: clear the OPFS vault subtree too (orphaned blobs from
    // partially-written entries have no metadata record to discover).
    // OPFS has no recursive "remove self" — enumerate + remove children
    // (entries() exists at runtime; the TS DOM lib lags behind, hence the cast).
    const vaultDir = await getVaultDir()
    if (vaultDir) {
      try {
        const iterable = (vaultDir as unknown as {
          entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>
        }).entries
        if (typeof iterable === 'function') {
          for await (const [name, handle] of iterable.call(vaultDir)) {
            try {
              await vaultDir.removeEntry(name, { recursive: handle.kind === 'directory' })
            } catch { /* best-effort per entry */ }
          }
        }
      } catch {
        // Enumeration unsupported — the per-entry loop above is the
        // authoritative wipe; this is only orphan cleanup.
      }
    }
  } catch { /* best-effort */ }
  return wiped
}
