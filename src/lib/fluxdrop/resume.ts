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
export async function markChunkAcked(transferId: string, chunkIndex: number): Promise<void> {
  const rec = await getTransferRecord(transferId)
  if (!rec) return
  if (!rec.chunksAcked.includes(chunkIndex)) {
    rec.chunksAcked.push(chunkIndex)
    rec.chunksAcked.sort((a, b) => a - b)
    rec.bytesTransferred += rec.manifest.chunkSize
    if (rec.bytesTransferred > rec.manifest.totalSize) rec.bytesTransferred = rec.manifest.totalSize
    await saveTransferRecord(rec)
  }
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
