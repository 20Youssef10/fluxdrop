// FluxDrop trusted peers: remember devices you've explicitly trusted so
// future incoming transfers from them can be auto-accepted (opt-in).
// Stored in localStorage (small list, synced across tabs).

'use client'

export interface TrustedPeer {
  deviceId: string
  alias: string
  addedAt: number
  lastAcceptedAt: number
}

const STORAGE_KEY = 'fluxdrop:trusted-peers'
const MAX_PEERS = 20

function load(): TrustedPeer[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is TrustedPeer => !!p && typeof p.deviceId === 'string' && typeof p.alias === 'string'
    )
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

export function isTrustedPeer(deviceId: string | null | undefined): boolean {
  if (!deviceId) return false
  return load().some((p) => p.deviceId === deviceId)
}

export function addTrustedPeer(peer: { deviceId: string; alias: string }): void {
  if (!peer.deviceId) return
  const peers = load().filter((p) => p.deviceId !== peer.deviceId)
  peers.unshift({
    deviceId: peer.deviceId,
    alias: peer.alias,
    addedAt: Date.now(),
    lastAcceptedAt: Date.now(),
  })
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
