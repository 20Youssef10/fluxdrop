// IndexedDB-backed resume store for FluxDrop.
// Stores transfer manifests, chunk-completion bitmaps, and chunk payloads (receiver).
// No file content is stored on the sender side.

import { get, set, del, keys, createStore } from 'idb-keyval'
import type { TransferManifest, TransferRecord, TransferState, DeviceRole } from './protocol'

// Separate stores for clarity.
// NOTE: idb-keyval's createStore() can only create a store when the DATABASE
// itself is new — it never upgrades an existing DB. Sharing one DB name meant
// only the first store ('transfers') ever existed and every other store
// silently failed. Each store therefore gets its OWN database now, which
// works for fresh profiles AND preserves existing 'fluxdrop' transfer records.
let transfersStore: ReturnType<typeof createStore> | null = null
let chunksStore: ReturnType<typeof createStore> | null = null
let prefsStore: ReturnType<typeof createStore> | null = null
let filesStore: ReturnType<typeof createStore> | null = null

function getStores() {
  if (!transfersStore) {
    try {
      transfersStore = createStore('fluxdrop', 'transfers')
      chunksStore = createStore('fluxdrop-chunks', 'chunks')
      prefsStore = createStore('fluxdrop-prefs', 'preferences')
      filesStore = createStore('fluxdrop-sender-files', 'sender-files')
    } catch {
      // IndexedDB unavailable — app will run in memory-only mode.
    }
  }
  return { transfersStore, chunksStore, prefsStore, filesStore }
}

export interface StoredTransfer {
  transferId: string
  role: DeviceRole
  manifest: TransferManifest
  status: TransferState
  chunksAcked: number[]      // sorted indices of acked chunks
  bytesTransferred: number
  peerAlias: string
  peerDeviceId: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  checksumVerified?: boolean
  /** Set when a transfer was continued from history via Resume. */
  resumedAt?: number
  /** Bytes that never travelled the wire thanks to the resume-skip bitmap. */
  resumedSavedBytes?: number
}

const CHUNK_PREFIX = 'chunk:'

// --- Record write serialization ---
// Transfer records are read-modify-written from multiple async paths (ack
// flushes, status transitions, cancel). Two overlapping read-modify-writes
// could clobber each other (e.g. a stale ack flush resurrecting TRANSFERRING
// over a fresh CANCELLED). All record writes go through this queue so each
// read-modify-write completes before the next begins.
let recordWriteChain: Promise<unknown> = Promise.resolve()
function enqueueRecordWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = recordWriteChain.then(fn, fn)
  recordWriteChain = next.catch(() => undefined)
  return next as Promise<T>
}

// === Transfers ===
export async function saveTransferRecord(rec: StoredTransfer): Promise<void> {
  const { transfersStore } = getStores()
  if (!transfersStore) return
  try {
    await enqueueRecordWrite(() =>
      set(rec.transferId, { ...rec, updatedAt: Date.now() }, transfersStore)
    )
  } catch { /* IndexedDB unavailable — memory-only mode */ }
}

export async function getTransferRecord(transferId: string): Promise<StoredTransfer | undefined> {
  const { transfersStore } = getStores()
  if (!transfersStore) return undefined
  try {
    return await get(transferId, transfersStore)
  } catch { return undefined }
}

/**
 * Atomically read-modify-write a transfer record INSIDE the write queue.
 * The current record is read at execution time (never stale), the updater
 * returns the fields to merge, and the result is written back — all before
 * any other queued write runs. persistTransferRecord and friends must use
 * this instead of read-then-saveTransferRecord, or a slow stale read can
 * clobber newer data (e.g. rewinding acked chunks mid-transfer).
 */
export async function updateTransferRecord(
  transferId: string,
  updater: (existing: StoredTransfer | undefined) => StoredTransfer | null
): Promise<StoredTransfer | undefined> {
  const { transfersStore } = getStores()
  if (!transfersStore) return undefined
  try {
    return await enqueueRecordWrite(async () => {
      const existing = await getTransferRecord(transferId)
      const next = updater(existing)
      if (!next) return existing
      await set(next.transferId, { ...next, updatedAt: Date.now() }, transfersStore)
      return next
    })
  } catch { return undefined }
}

export async function listTransfers(): Promise<StoredTransfer[]> {
  const { transfersStore } = getStores()
  if (!transfersStore) return []
  try {
    const ks = await keys(transfersStore)
    const records: StoredTransfer[] = []
    for (const k of ks) {
      const r = await get(k as string, transfersStore)
      if (r) records.push(r as StoredTransfer)
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch { return [] }
}

export async function deleteTransferRecord(transferId: string): Promise<void> {
  const { transfersStore, chunksStore } = getStores()
  if (!transfersStore) return
  try {
    await del(transferId, transfersStore)
    // Also clear any stored chunks
    if (chunksStore) {
      const ks = await keys(chunksStore)
      for (const k of ks) {
        if (typeof k === 'string' && k.startsWith(CHUNK_PREFIX + transferId)) {
          await del(k, chunksStore)
        }
      }
    }
    await deleteSenderFiles(transferId)
  } catch { /* ignore */ }
}

// === Sender file persistence ===
// File objects are structured-cloneable, so they can live in IndexedDB and
// survive page reloads. This powers "Resume" from transfer history: the
// sender's original files are re-attached without re-picking them.
// Files stay on the user's own device — same privacy posture as receiver chunks.
const FILE_PREFIX = 'file:'
// Cap on total stored size per transfer (2 GB). Larger queues skip persistence
// gracefully — resume then falls back to the "files unavailable" toast.
const MAX_PERSIST_BYTES = 2 * 1024 * 1024 * 1024

export async function saveSenderFiles(transferId: string, files: File[]): Promise<boolean> {
  const { filesStore } = getStores()
  if (!filesStore || files.length === 0) return false
  try {
    const total = files.reduce((s, f) => s + f.size, 0)
    if (total > MAX_PERSIST_BYTES) return false
    // Respect the browser's storage quota — skip persistence when free space
    // can't comfortably hold the queue (best-effort feature, never block sends).
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate()
      const free = (est.quota ?? 0) - (est.usage ?? 0)
      if (free > 0 && free < total * 1.25) return false
    }
    await set(`${FILE_PREFIX}${transferId}`, files, filesStore)
    return true
  } catch { return false }
}

export async function getSenderFiles(transferId: string): Promise<File[] | null> {
  const { filesStore } = getStores()
  if (!filesStore) return null
  try {
    const files = await get(`${FILE_PREFIX}${transferId}`, filesStore)
    if (!Array.isArray(files) || files.length === 0) return null
    return files as File[]
  } catch { return null }
}

export async function deleteSenderFiles(transferId: string): Promise<void> {
  const { filesStore } = getStores()
  if (!filesStore) return
  try {
    await del(`${FILE_PREFIX}${transferId}`, filesStore)
  } catch { /* ignore */ }
}

// === Chunk ack tracking ===
// In-memory cache + write debounce to avoid IndexedDB read-modify-write on every chunk.
const ackCache = new Map<string, Set<number>>()
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

export async function markChunkAcked(transferId: string, chunkIndex: number): Promise<void> {
  // Use in-memory Set for O(1) deduplication.
  let cached = ackCache.get(transferId)
  if (!cached) {
    const rec = await getTransferRecord(transferId)
    cached = new Set(rec?.chunksAcked ?? [])
    // Another concurrent init may have won the race while we awaited — keep
    // theirs (it already contains the record acks) so no entries are lost.
    const winner = ackCache.get(transferId)
    if (winner) {
      cached = winner
    } else {
      ackCache.set(transferId, cached)
    }
  }
  if (cached.has(chunkIndex)) return
  cached.add(chunkIndex)

  // Debounce the IndexedDB write — flush every 2s or when 50 chunks accumulate.
  const FLUSH_INTERVAL_MS = 2000
  const FLUSH_THRESHOLD = 50

  if (pendingWrites.has(transferId)) {
    clearTimeout(pendingWrites.get(transferId)!)
  }

  if (cached.size % FLUSH_THRESHOLD === 0) {
    // Threshold reached — flush immediately.
    pendingWrites.delete(transferId)
    await flushAcked(transferId, cached)
  } else {
    // Schedule a debounced write.
    pendingWrites.set(
      transferId,
      setTimeout(() => {
        pendingWrites.delete(transferId)
        void flushAcked(transferId, cached!)
      }, FLUSH_INTERVAL_MS)
    )
  }
}

/**
 * Bulk-mark chunks as acked (resume-skip: chunks the receiver already holds
 * count as delivered for the sender's own history record). One IDB read for
 * cache init, then O(1) in-memory adds and a single debounced flush.
 */
export async function markChunksAcked(transferId: string, indices: number[]): Promise<void> {
  if (indices.length === 0) return
  // Initialize the cache once (same race handling as markChunkAcked).
  let cached = ackCache.get(transferId)
  if (!cached) {
    const rec = await getTransferRecord(transferId)
    cached = new Set(rec?.chunksAcked ?? [])
    const winner = ackCache.get(transferId)
    if (winner) {
      cached = winner
    } else {
      ackCache.set(transferId, cached)
    }
  }
  let added = false
  for (const i of indices) {
    if (!cached.has(i)) {
      cached.add(i)
      added = true
    }
  }
  if (!added) return
  const FLUSH_INTERVAL_MS = 2000
  if (pendingWrites.has(transferId)) {
    clearTimeout(pendingWrites.get(transferId)!)
  }
  pendingWrites.set(
    transferId,
    setTimeout(() => {
      pendingWrites.delete(transferId)
      void flushAcked(transferId, cached!)
    }, FLUSH_INTERVAL_MS)
  )
}

/** Flush the in-memory ack cache to IndexedDB (merging with existing acks). */
async function flushAcked(transferId: string, acked: Set<number>): Promise<void> {
  // Atomic read-modify-write inside the record write queue so a concurrent
  // status save (e.g. cancel) can't be clobbered by a stale read.
  await enqueueRecordWrite(async () => {
    const rec = await getTransferRecord(transferId)
    if (!rec) return
    // MERGE with the stored acks — the cache only knows about chunks acked in
    // the current session, and wiping pre-existing acks (e.g. from a previous
    // attempt of a resumed transfer) would corrupt history progress.
    const merged = new Set<number>([...(rec.chunksAcked ?? []), ...acked])
    rec.chunksAcked = Array.from(merged)
    // Sort once on flush (cheap, happens infrequently).
    rec.chunksAcked.sort((a, b) => a - b)
    rec.bytesTransferred = Math.min(
      rec.chunksAcked.length * rec.manifest.chunkSize,
      rec.manifest.totalSize
    )
    rec.updatedAt = Date.now()
    const { transfersStore } = getStores()
    if (transfersStore) {
      await set(rec.transferId, rec, transfersStore)
    }
  })
}

/** Flush all pending ack writes (call on transfer complete or page unload). */
export async function flushAllPendingAcks(): Promise<void> {
  for (const [transferId] of pendingWrites) {
    clearTimeout(pendingWrites.get(transferId)!)
  }
  pendingWrites.clear()
  for (const [transferId, acked] of ackCache) {
    await flushAcked(transferId, acked)
  }
  ackCache.clear()
}

export async function getLastAckedIndex(transferId: string): Promise<number> {
  const rec = await getTransferRecord(transferId)
  if (!rec || rec.chunksAcked.length === 0) return -1
  return rec.chunksAcked[rec.chunksAcked.length - 1]
}

// === Chunk payloads (receiver) ===
export async function saveChunk(transferId: string, chunkIndex: number, data: ArrayBuffer): Promise<void> {
  const { chunksStore } = getStores()
  if (!chunksStore) return
  try {
    await set(`${CHUNK_PREFIX}${transferId}:${chunkIndex}`, data, chunksStore)
  } catch { /* IndexedDB unavailable */ }
}

export async function getChunk(transferId: string, chunkIndex: number): Promise<ArrayBuffer | undefined> {
  const { chunksStore } = getStores()
  if (!chunksStore) return undefined
  try {
    return await get(`${CHUNK_PREFIX}${transferId}:${chunkIndex}`, chunksStore)
  } catch { return undefined }
}

/**
 * Indices of THIS transfer's chunks that are actually stored in IndexedDB.
 * One bulk key read — far cheaper than per-chunk gets. Used to build the
 * resume-skip bitmap: acks alone can outrun payloads (ack flush vs payload
 * flush timing), and skipping a chunk with no stored payload would corrupt
 * the reassembled file.
 */
export async function getStoredChunkIndices(transferId: string): Promise<Set<number>> {
  const { chunksStore } = getStores()
  if (!chunksStore) return new Set()
  try {
    const ks = await keys(chunksStore)
    const out = new Set<number>()
    const prefix = `${CHUNK_PREFIX}${transferId}:`
    for (const k of ks) {
      if (typeof k === 'string' && k.startsWith(prefix)) {
        const idx = parseInt(k.slice(prefix.length), 10)
        if (!Number.isNaN(idx)) out.add(idx)
      }
    }
    return out
  } catch { return new Set() }
}

export async function getAllChunks(transferId: string, totalChunks: number): Promise<ArrayBuffer[]> {
  const out: ArrayBuffer[] = new Array(totalChunks)
  for (let i = 0; i < totalChunks; i++) {
    const c = await getChunk(transferId, i)
    if (c) out[i] = c
  }
  return out
}

// === Preferences ===
export interface DevicePreferences {
  deviceId: string
  alias: string
  createdAt: number
  lastSeen: number
}

export async function getDevicePreferences(): Promise<DevicePreferences | undefined> {
  const { prefsStore } = getStores()
  if (!prefsStore) return undefined
  try {
    return await get('device', prefsStore)
  } catch { return undefined }
}

export async function saveDevicePreferences(prefs: DevicePreferences): Promise<void> {
  const { prefsStore } = getStores()
  if (!prefsStore) return
  try {
    await set('device', { ...prefs, lastSeen: Date.now() }, prefsStore)
  } catch { /* IndexedDB unavailable */ }
}

// === Cleanup ===
export async function purgeExpiredTransfers(): Promise<number> {
  const now = Date.now()
  const all = await listTransfers()
  let purged = 0
  for (const r of all) {
    if (now - r.updatedAt > 24 * 60 * 60 * 1000) {
      await deleteTransferRecord(r.transferId)
      purged++
    }
  }
  return purged
}

export async function getStorageEstimate(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate()
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
  }
  return { usage: 0, quota: 0 }
}
