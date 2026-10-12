// Manifest creation and parsing for FluxDrop transfers.

import type { FileManifestEntry, TransferManifest } from './protocol'
import { CONSTANTS } from './protocol'
import { computeTotalChunks } from './format'
import { hashFile } from './checksum'
import { hashFileWorker } from './hash-worker-client'

export interface ManifestProgress {
  current: number
  total: number
  fileName: string
  bytesProcessed: number
  totalBytes: number
}

/**
 * Build a transfer manifest from a list of files.
 * Hashes each file with SHA-256 and yields to the event loop between files
 * to keep the UI responsive. Accepts an optional progress callback.
 */
export async function buildManifest(
  files: File[],
  onProgress?: (progress: ManifestProgress) => void
): Promise<TransferManifest> {
  const entries: FileManifestEntry[] = []
  let totalSize = 0
  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  let bytesProcessed = 0

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress?.({
      current: i + 1,
      total: files.length,
      fileName: file.name,
      bytesProcessed,
      totalBytes,
    })

    // Use worker-based hashing for large files (off main thread, true incremental SHA-256).
    // Falls back to main-thread crypto.subtle.digest for small files.
    const checksum = file.size > 256 * 1024 * 1024
      ? await hashFileWorker(file, (p) => {
          onProgress?.({
            current: i + 1,
            total: files.length,
            fileName: file.name,
            bytesProcessed: p.bytesProcessed,
            totalBytes,
          })
        })
      : await hashFile(file)
    entries.push({
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
      checksum,
      relativePath: (file as any).webkitRelativePath || file.name,
    })
    totalSize += file.size
    bytesProcessed += file.size

    // Yield to the event loop between files so the UI can update.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  const now = Date.now()
  return {
    transferId: crypto.randomUUID(),
    version: 1,
    files: entries,
    totalSize,
    totalChunks: computeTotalChunks(totalSize, CONSTANTS.CHUNK_SIZE),
    chunkSize: CONSTANTS.CHUNK_SIZE,
    createdAt: now,
    expiresAt: now + CONSTANTS.RESUME_RECORD_TTL_MS,
  }
}

export interface ManifestSummary {
  fileCount: number
  totalSize: number
  totalChunks: number
  primaryName: string
  fileTypes: string[]
}

export function summarizeManifest(manifest: TransferManifest): ManifestSummary {
  const types = Array.from(new Set(manifest.files.map((f) => f.type.split('/')[0] || 'other')))
  const primaryName =
    manifest.files.length === 1
      ? manifest.files[0].name
      : `${manifest.files.length} files`
  return {
    fileCount: manifest.files.length,
    totalSize: manifest.totalSize,
    totalChunks: manifest.totalChunks,
    primaryName,
    fileTypes: types,
  }
}

// === Slice plan: maps global byte offsets to file boundaries ===

export interface FileSlicePlan {
  fileIndex: number
  file: FileManifestEntry
  startByte: number  // global offset
  endByte: number    // global offset (exclusive)
}

export function buildSlicePlan(manifest: TransferManifest): FileSlicePlan[] {
  const plan: FileSlicePlan[] = []
  let offset = 0
  manifest.files.forEach((file, idx) => {
    plan.push({ fileIndex: idx, file, startByte: offset, endByte: offset + file.size })
    offset += file.size
  })
  return plan
}

/**
 * A segment of a single file that contributes to a chunk.
 */
export interface ChunkSegment {
  fileIndex: number
  localStart: number
  localEnd: number
  length: number
}

/**
 * Given a global chunk index, resolve ALL file segments that compose it.
 * A chunk can span multiple files — e.g., if file 1 ends at byte 100,000
 * and chunk size is 65,536, chunk 2 (bytes 131,072-196,608) spans into
 * file 2 if file 1 is only 100,000 bytes.
 *
 * Returns null if the chunk is beyond the total data.
 */
export function resolveChunk(
  plan: FileSlicePlan[],
  chunkIndex: number,
  chunkSize: number
): { segments: ChunkSegment[]; totalLength: number } | null {
  const globalStart = chunkIndex * chunkSize
  const globalEnd = globalStart + chunkSize
  const segments: ChunkSegment[] = []
  let totalLength = 0

  for (const seg of plan) {
    // Check if this file segment overlaps with the chunk's global range.
    if (seg.endByte <= globalStart) continue  // File is entirely before the chunk
    if (seg.startByte >= globalEnd) break      // File is entirely after the chunk

    // Calculate the overlap.
    const overlapStart = Math.max(globalStart, seg.startByte)
    const overlapEnd = Math.min(globalEnd, seg.endByte)
    const localStart = overlapStart - seg.startByte
    const localEnd = overlapEnd - seg.startByte
    const length = overlapEnd - overlapStart

    if (length > 0) {
      segments.push({ fileIndex: seg.fileIndex, localStart, localEnd, length })
      totalLength += length
    }
  }

  if (segments.length === 0) return null
  return { segments, totalLength }
}
