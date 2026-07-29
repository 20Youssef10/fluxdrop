// IndexedDB-backed resume store for FluxDrop.
// Stores transfer manifests, chunk-completion bitmaps, and chunk payloads (receiver).
// No file content is stored on the sender side.

import { get, set, del, keys, createStore } from 'idb-keyval'
import type { TransferManifest, TransferRecord, TransferState, DeviceRole } from './protocol'

// Separate stores for clarity
const transfersStore = createStore('fluxdrop', 'transfers')
const chunksStore = createStore('fluxdrop', 'chunks')
const prefsStore = createStore('fluxdrop', 'preferences')

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
}

const CHUNK_PREFIX = 'chunk:'

// === Transfers ===
export async function saveTransferRecord(rec: StoredTransfer): Promise<void> {
  await set(rec.transferId, { ...rec, updatedAt: Date.now() }, transfersStore)
}

export async function getTransferRecord(transferId: string): Promise<StoredTransfer | undefined> {
  return await get(transferId, transfersStore)
}

export async function listTransfers(): Promise<StoredTransfer[]> {
  const ks = await keys(transfersStore)
  const records: StoredTransfer[] = []
  for (const k of ks) {
    const r = await get(k as string, transfersStore)
    if (r) records.push(r as StoredTransfer)
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteTransferRecord(transferId: string): Promise<void> {
  await del(transferId, transfersStore)
  // Also clear any stored chunks
  const ks = await keys(chunksStore)
  for (const k of ks) {
    if (typeof k === 'string' && k.startsWith(CHUNK_PREFIX + transferId)) {
      await del(k, chunksStore)
    }
  }
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
    ackCache.set(transferId, cached)
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

/** Flush the in-memory ack cache to IndexedDB. */
async function flushAcked(transferId: string, acked: Set<number>): Promise<void> {
  const rec = await getTransferRecord(transferId)
  if (!rec) return
  rec.chunksAcked = Array.from(acked)
  // Sort once on flush (cheap, happens infrequently).
  rec.chunksAcked.sort((a, b) => a - b)
  rec.bytesTransferred = Math.min(
    rec.chunksAcked.length * rec.manifest.chunkSize,
    rec.manifest.totalSize
  )
  rec.updatedAt = Date.now()
  await saveTransferRecord(rec)
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
  await set(`${CHUNK_PREFIX}${transferId}:${chunkIndex}`, data, chunksStore)
}

export async function getChunk(transferId: string, chunkIndex: number): Promise<ArrayBuffer | undefined> {
  return await get(`${CHUNK_PREFIX}${transferId}:${chunkIndex}`, chunksStore)
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
  return await get('device', prefsStore)
}

export async function saveDevicePreferences(prefs: DevicePreferences): Promise<void> {
  await set('device', { ...prefs, lastSeen: Date.now() }, prefsStore)
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
