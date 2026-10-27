// FluxDrop trusted peers: remember devices you've explicitly trusted so
// future incoming transfers from them can be auto-accepted (opt-in).
// Stored in localStorage (small list, synced across tabs).
//
// v1.3 (6.4) — trust LEVELS:
// - `scopes` gate what a trusted device may auto-accept: full file
//   transfers ('files'), tiny snippet-*.txt-only drops ('snippets'), and
//   auto-saving straight into the Files vault without pickers ('autoSave').
// - `sasFingerprint` is a trust-on-first-use (TOFU) record: the 6-digit SAS
//   from the first PAKE session with that device. If a later session with
//   the same device shows a DIFFERENT code in the verification card, the
//   identity is no longer the one you trusted — visible in Settings → Privacy.

'use client'

export interface TrustedPeerScopes {
  files: boolean
  snippets: boolean
  autoSave: boolean
}

export type TrustedScope = keyof TrustedPeerScopes

export interface TrustedPeer {
  deviceId: string
  alias: string
  addedAt: number
  lastAcceptedAt: number
  // v1.3 (6.4): per-device auto-accept scopes (legacy entries map to all-true).
  scopes: TrustedPeerScopes
  // v1.3 (6.4): TOFU fingerprint — the SAS of the first PAKE session.
  sasFingerprint?: string
}

const STORAGE_KEY = 'fluxdrop:trusted-peers'
const MAX_PEERS = 20

/** Normalize a stored (possibly legacy/partial) scopes blob. Missing = granted. */
function normalizeScopes(raw: unknown): TrustedPeerScopes {
  const s = raw && typeof raw === 'object' ? (raw as Partial<Record<TrustedScope, unknown>>) : {}
  const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : true)
  return {
    files: bool(s.files),
    snippets: bool(s.snippets),
    autoSave: bool(s.autoSave),
  }
}

function load(): TrustedPeer[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Back-compat: entries written before v1.3 carry no `scopes` — they meant
    // "auto-accept everything from this device", so map them to all-true.
    return parsed
      .filter(
        (p): p is Omit<TrustedPeer, 'scopes'> & { scopes?: unknown } =>
          !!p && typeof p.deviceId === 'string' && typeof p.alias === 'string'
      )
      .map((p) => ({
        ...p,
        scopes: normalizeScopes(p.scopes),
        sasFingerprint: typeof p.sasFingerprint === 'string' ? p.sasFingerprint : undefined,
      }))
  } catch {
    return []
  }
}

function save(peers: TrustedPeer[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(peers.slice(0, MAX_PEERS)))
  } catch { /* ignore */ }
}

export function getTrustedPeers(): TrustedPeer[] {
  return load().sort((a, b) => b.lastAcceptedAt - a.lastAcceptedAt)
}

export function getTrustedPeer(deviceId: string | null | undefined): TrustedPeer | null {
  if (!deviceId) return null
  return load().find((p) => p.deviceId === deviceId) ?? null
}

/**
 * Trusted check. WITHOUT `scope`: plain presence (back-compat for existing
 * callers). WITH `scope`: presence AND that scope granted — the gate used by
 * the manifest auto-accept path (v1.3 6.4).
 */
export function isTrustedPeer(deviceId: string | null | undefined, scope?: TrustedScope): boolean {
  if (!deviceId) return false
  const peer = load().find((p) => p.deviceId === deviceId)
  if (!peer) return false
  if (!scope) return true
  return peer.scopes[scope] === true
}

export function addTrustedPeer(peer: { deviceId: string; alias: string; sasFingerprint?: string }): void {
  if (!peer.deviceId) return
  const peers = load()
  const existingIdx = peers.findIndex((p) => p.deviceId === peer.deviceId)
  if (existingIdx >= 0) {
    const existing = peers[existingIdx]
    peers[existingIdx] = {
      ...existing,
      alias: peer.alias || existing.alias,
      lastAcceptedAt: Date.now(),
      // TOFU: the FIRST SAS recorded with this device stays authoritative —
      // later sessions are verified against it in Settings → Privacy.
      sasFingerprint: existing.sasFingerprint ?? (peer.sasFingerprint || undefined),
    }
    save(peers)
    return
  }
  peers.unshift({
    deviceId: peer.deviceId,
    alias: peer.alias,
    addedAt: Date.now(),
    lastAcceptedAt: Date.now(),
    // New trusts default to every scope — the user explicitly accepted this
    // device once; scopes can be tightened afterwards in Settings → Privacy.
    scopes: { files: true, snippets: true, autoSave: true },
    ...(peer.sasFingerprint ? { sasFingerprint: peer.sasFingerprint } : {}),
  })
  save(peers)
}

/** Merge-update one device's auto-accept scopes (Settings → Privacy editor). */
export function setTrustedPeerScopes(deviceId: string, scopes: Partial<TrustedPeerScopes>): void {
  const peers = load()
  const idx = peers.findIndex((p) => p.deviceId === deviceId)
  if (idx < 0) return
  peers[idx] = { ...peers[idx], scopes: { ...peers[idx].scopes, ...scopes } }
  save(peers)
}

export function removeTrustedPeer(deviceId: string): void {
  save(load().filter((p) => p.deviceId !== deviceId))
}

export function clearTrustedPeers(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}
