// Manifest creation and parsing for FluxDrop transfers.

import type { FileManifestEntry, TransferManifest } from './protocol'
import { CONSTANTS, DELTA_MIN_FILE_BYTES, DISAPPEAR_TTL_CHOICES } from './protocol'
import { computeTotalChunks } from './format'
import { hashFile } from './checksum'
// v5-a4: pooled hashing — one file per free worker, round-robin over the pool.
import { hashFilesPool, hashFileWorker } from './hash-worker-client'
import { randomUUID } from './random'
// v5-a3w: delta candidacy is gated by the user's pref (read at manifest time).
import { usePrefsStore } from './prefs'

export interface ManifestProgress {
  current: number
  total: number
  fileName: string
  bytesProcessed: number
  totalBytes: number
}

/**
 * Build a transfer manifest from a list of files.
 * Hashes every file with SHA-256 (v5-a4: through the worker POOL — several
 * files hash in parallel, one per free worker, with double-buffered reads
 * inside each worker) and reports progress in the same ManifestProgress
 * shape the hashing UI consumes.
 * `wireCompression` stamps the manifest with 'gzip' (v1.1) so the receiver
 * knows to gunzip every incoming CHUNK_DATA_GZ frame; checksums remain over
 * the ORIGINAL bytes either way.
 */
export async function buildManifest(
  files: File[],
  onProgress?: (progress: ManifestProgress) => void,
  wireCompression?: 'gzip'
): Promise<TransferManifest> {
  const totalBytes = files.reduce((s, f) => s + f.size, 0)

  // v5-a4: pooled hashing — hashFilesPool schedules one file per free worker
  // (round-robin) so multi-file sends hash in parallel instead of one-by-one.
  // `current` = files completed + 1 ("now hashing the next one"), and
  // bytesProcessed/totalBytes are now a consistent aggregate pair.
  let filesDone = 0
  let overallBytes = 0
  let activeName = files.length > 0 ? files[files.length - 1].name : ''
  const emit = (): void => {
    onProgress?.({
      current: Math.min(filesDone + 1, files.length),
      total: files.length,
      fileName: activeName,
      bytesProcessed: overallBytes,
      totalBytes,
    })
  }
  emit() // leading-edge report, matching the old loop's first update

  let digests: string[]
  try {
    digests = await hashFilesPool(files, {
      onFileStart: (_i, f) => {
        activeName = f.name
        emit()
      },
      onFileDone: () => {
        filesDone++
        emit()
      },
      onOverallProgress: (bytes) => {
        overallBytes = bytes
        emit()
      },
    })
  } catch (poolErr) {
    // Hashing must never break a send — fall back to the pre-pool sequential
    // loop (one file at a time; worker first, then main thread per file).
    console.warn(
      '[FluxDrop] Pooled hashing failed, falling back to sequential:',
      poolErr instanceof Error ? poolErr.message : String(poolErr)
    )
    digests = new Array<string>(files.length)
    let bytesProcessed = 0
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      let checksum: string
      try {
        checksum = await hashFileWorker(file, (p) => {
          onProgress?.({
            current: i + 1,
            total: files.length,
            fileName: file.name,
            bytesProcessed: p.bytesProcessed,
            totalBytes,
          })
        })
      } catch {
        checksum = await hashFile(file)
      }
      digests[i] = checksum
      bytesProcessed += file.size
      onProgress?.({ current: i + 1, total: files.length, fileName: file.name, bytesProcessed, totalBytes })
      // Yield to the event loop between files so the UI can update.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  // v5-a3w: delta candidacy — set ONLY when the pref is on, the transfer is
  // exactly one file, and its size clears the 4-block threshold. It is a
  // negotiation HINT only: the receiver still needs a readable same-name
  // prior in its vault, and the sender may yet decline (patch over guard /
  // build failure). Digest + size stay the ORIGINAL file's in every case.
  const deltaEligible =
    usePrefsStore.getState().deltaSync &&
    files.length === 1 &&
    (files[0]?.size ?? 0) >= DELTA_MIN_FILE_BYTES

  const entries: FileManifestEntry[] = files.map((file, i) => ({
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified,
    checksum: digests[i],
    // v5-a4: narrowed the old `as any` while touching this line.
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    // v5-a3w: candidacy rides only on entry 0 (single-file transfers by
    // construction here — the spread keeps older manifests byte-compatible).
    ...(i === 0 && deltaEligible ? { deltaCandidate: true } : {}),
  }))

  const now = Date.now()
  // v5-b1: sender-requested vault retention. Validated against the fixed
  // choice list so a corrupted pref can never smuggle an arbitrary TTL.
  const ttlMinutes = usePrefsStore.getState().disappearTtlMinutes
  const ttlMs = (DISAPPEAR_TTL_CHOICES as readonly number[]).includes(ttlMinutes) && ttlMinutes > 0
    ? ttlMinutes * 60_000
    : undefined
  return {
    transferId: randomUUID(),
    version: 1,
    files: entries,
    totalSize: totalBytes,
    totalChunks: computeTotalChunks(totalBytes, CONSTANTS.CHUNK_SIZE),
    chunkSize: CONSTANTS.CHUNK_SIZE,
    createdAt: now,
    expiresAt: now + CONSTANTS.RESUME_RECORD_TTL_MS,
    ...(wireCompression ? { compression: wireCompression } : {}),
    ...(ttlMs ? { ttlMs } : {}),
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

/** Per-file resume-skip breakdown for one file index. */
export interface FileSkipInfo {
  skippedBytes: number
  skippedChunks: number
  totalChunks: number
}

/**
 * Map the global resume-skip bitmap onto each file's byte range so any card
 * (mid-transfer FILES list, completion SUMMARY) can visualize which portion
 * of each file was already on this device (never travelled the wire).
 * Shared by TransferProgress and TransferSummaryCard — keep in one place.
 */
export function computeFileSkips(
  manifest: TransferManifest | null,
  skippedIndices: Set<number>
): Map<number, FileSkipInfo> {
  const out = new Map<number, FileSkipInfo>()
  if (!manifest || skippedIndices.size === 0) return out
  const plan = buildSlicePlan(manifest)
  for (const seg of plan) {
    const startChunk = Math.floor(seg.startByte / manifest.chunkSize)
    const endChunk = Math.floor((seg.endByte - 1) / manifest.chunkSize)
    let skippedBytes = 0
    let skippedChunks = 0
    for (let c = startChunk; c <= endChunk; c++) {
      if (!skippedIndices.has(c)) continue
      skippedChunks++
      const overlapStart = Math.max(seg.startByte, c * manifest.chunkSize)
      const overlapEnd = Math.min(seg.endByte, (c + 1) * manifest.chunkSize)
      skippedBytes += Math.max(0, overlapEnd - overlapStart)
    }
    out.set(seg.fileIndex, { skippedBytes, skippedChunks, totalChunks: endChunk - startChunk + 1 })
  }
  return out
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
