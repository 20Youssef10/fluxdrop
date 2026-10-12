/**
 * Unit tests for FluxDrop chunk slicing (multi-file resolveChunk).
 * Run: bun test tests/unit/slicing.test.ts
 *
 * This test would have caught the critical multi-file corruption bug (Issue 1)
 * where resolveChunk capped chunks at file boundaries, losing bytes.
 */

import { describe, test, expect } from 'bun:test'
import { buildSlicePlan, resolveChunk } from '../../src/lib/fluxdrop/manifest'
import type { TransferManifest } from '../../src/lib/fluxdrop/protocol'
import { CHUNK_SIZE } from '../../src/lib/fluxdrop/shared-protocol'

function makeManifest(fileSizes: number[]): TransferManifest {
  return {
    transferId: 'test-transfer-id',
    version: 1,
    files: fileSizes.map((size, i) => ({
      name: `file${i}.bin`,
      size,
      type: 'application/octet-stream',
      lastModified: Date.now(),
      checksum: `checksum-${i}`,
      relativePath: `file${i}.bin`,
    })),
    totalSize: fileSizes.reduce((s, x) => s + x, 0),
    totalChunks: Math.ceil(fileSizes.reduce((s, x) => s + x, 0) / CHUNK_SIZE),
    chunkSize: CHUNK_SIZE,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  }
}

describe('resolveChunk — single file', () => {
  test('resolves a chunk within a single file', () => {
    const manifest = makeManifest([100000])
    const plan = buildSlicePlan(manifest)
    const result = resolveChunk(plan, 0, CHUNK_SIZE)
    expect(result).not.toBeNull()
    expect(result!.segments).toHaveLength(1)
    expect(result!.segments[0].fileIndex).toBe(0)
    expect(result!.segments[0].localStart).toBe(0)
    expect(result!.segments[0].length).toBe(CHUNK_SIZE)
  })

  test('last chunk is smaller than CHUNK_SIZE', () => {
    const manifest = makeManifest([100000]) // 100000 bytes, chunkSize 65536
    const plan = buildSlicePlan(manifest)
    const lastChunkIndex = manifest.totalChunks - 1 // chunk 1 (bytes 65536-99999)
    const result = resolveChunk(plan, lastChunkIndex, CHUNK_SIZE)
    expect(result).not.toBeNull()
    expect(result!.segments).toHaveLength(1)
    expect(result!.segments[0].length).toBe(100000 - CHUNK_SIZE) // 34464 bytes
  })
})

describe('resolveChunk — multi-file (the bug that was fixed)', () => {
  test('chunk spanning two files returns both segments', () => {
    // File 1: 100000 bytes (0-99999)
    // File 2: 150000 bytes (100000-249999)
    // CHUNK_SIZE = 65536
    // Chunk 0: bytes 0-65535 → file 1 only
    // Chunk 1: bytes 65536-131071 → file 1 (65536-99999 = 34464 bytes) + file 2 (100000-131071 = 31072 bytes)
    const manifest = makeManifest([100000, 150000])
    const plan = buildSlicePlan(manifest)

    // Chunk 1 spans the file boundary.
    const result = resolveChunk(plan, 1, CHUNK_SIZE)
    expect(result).not.toBeNull()
    expect(result!.segments).toHaveLength(2)

    // First segment: tail of file 0
    expect(result!.segments[0].fileIndex).toBe(0)
    expect(result!.segments[0].localStart).toBe(65536)
    expect(result!.segments[0].length).toBe(100000 - 65536) // 34464 bytes

    // Second segment: head of file 1
    expect(result!.segments[1].fileIndex).toBe(1)
    expect(result!.segments[1].localStart).toBe(0)
    expect(result!.segments[1].length).toBe(65536 - (100000 - 65536)) // 31072 bytes

    // Total length should be exactly CHUNK_SIZE
    expect(result!.totalLength).toBe(CHUNK_SIZE)
  })

  test('total bytes across all chunks equals total file size', () => {
    const fileSizes = [100000, 150000]
    const manifest = makeManifest(fileSizes)
    const plan = buildSlicePlan(manifest)

    let totalBytes = 0
    for (let i = 0; i < manifest.totalChunks; i++) {
      const result = resolveChunk(plan, i, CHUNK_SIZE)
      if (result) totalBytes += result.totalLength
    }
    expect(totalBytes).toBe(fileSizes.reduce((s, x) => s + x, 0))
  })

  test('three files with varying sizes — no data loss', () => {
    // 3.5 MB, 812 KB, 45 KB
    const fileSizes = [3.5 * 1024 * 1024, 812 * 1024, 45 * 1024]
    const manifest = makeManifest(fileSizes)
    const plan = buildSlicePlan(manifest)

    let totalBytes = 0
    for (let i = 0; i < manifest.totalChunks; i++) {
      const result = resolveChunk(plan, i, CHUNK_SIZE)
      if (result) totalBytes += result.totalLength
    }
    const expectedTotal = fileSizes.reduce((s, x) => s + x, 0)
    expect(totalBytes).toBe(expectedTotal)
  })

  test('chunk spanning three files', () => {
    // Three tiny files that all fit in one chunk.
    // File 0: 100 bytes (0-99)
    // File 1: 200 bytes (100-299)
    // File 2: 300 bytes (300-599)
    // Chunk 0 (65536 bytes) spans all three.
    const manifest = makeManifest([100, 200, 300])
    const plan = buildSlicePlan(manifest)

    const result = resolveChunk(plan, 0, CHUNK_SIZE)
    expect(result).not.toBeNull()
    expect(result!.segments).toHaveLength(3)

    expect(result!.segments[0].fileIndex).toBe(0)
    expect(result!.segments[0].length).toBe(100)

    expect(result!.segments[1].fileIndex).toBe(1)
    expect(result!.segments[1].length).toBe(200)

    expect(result!.segments[2].fileIndex).toBe(2)
    expect(result!.segments[2].length).toBe(300)

    expect(result!.totalLength).toBe(600)
  })

  test('no chunk beyond total data', () => {
    const manifest = makeManifest([1000])
    const plan = buildSlicePlan(manifest)
    const result = resolveChunk(plan, 100, CHUNK_SIZE)
    expect(result).toBeNull()
  })
})

describe('resolveChunk — 64 KB-aligned boundaries (always worked)', () => {
  test('single 64 KB file', () => {
    const manifest = makeManifest([CHUNK_SIZE])
    const plan = buildSlicePlan(manifest)

    const result = resolveChunk(plan, 0, CHUNK_SIZE)
    expect(result!.segments).toHaveLength(1)
    expect(result!.segments[0].fileIndex).toBe(0)
    expect(result!.segments[0].localStart).toBe(0)
    expect(result!.segments[0].length).toBe(CHUNK_SIZE)
  })

  test('two 64 KB files — boundary is exactly at chunk edge', () => {
    const manifest = makeManifest([CHUNK_SIZE, CHUNK_SIZE])
    const plan = buildSlicePlan(manifest)

    // Chunk 0: file 0 only
    const result0 = resolveChunk(plan, 0, CHUNK_SIZE)
    expect(result0!.segments).toHaveLength(1)
    expect(result0!.segments[0].fileIndex).toBe(0)

    // Chunk 1: file 1 only (boundary is exact, no spanning)
    const result1 = resolveChunk(plan, 1, CHUNK_SIZE)
    expect(result1!.segments).toHaveLength(1)
    expect(result1!.segments[0].fileIndex).toBe(1)
  })
})
