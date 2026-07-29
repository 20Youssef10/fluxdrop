// Manifest creation and parsing for FluxDrop transfers.

import type { FileManifestEntry, TransferManifest } from './protocol'
import { CONSTANTS } from './protocol'
import { computeTotalChunks } from './format'
import { hashFile } from './checksum'

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

    const checksum = await hashFile(file)
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

// Convert a transfer manifest into a flat ordered byte range so we can chunk it
// uniformly across multiple files. Returns the cumulative byte offsets per file
// so the sender knows which slice of which file maps to chunk index N.
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

// Given a global chunk index, resolve which file + local offset it belongs to.
export function resolveChunk(
  plan: FileSlicePlan[],
  chunkIndex: number,
  chunkSize: number
): { fileIndex: number; localStart: number; localEnd: number; length: number } | null {
  const globalStart = chunkIndex * chunkSize
  for (const seg of plan) {
    if (globalStart >= seg.startByte && globalStart < seg.endByte) {
      const localStart = globalStart - seg.startByte
      const remaining = seg.endByte - globalStart
      const length = Math.min(chunkSize, remaining)
      return { fileIndex: seg.fileIndex, localStart, localEnd: localStart + length, length }
    }
  }
  return null
}
