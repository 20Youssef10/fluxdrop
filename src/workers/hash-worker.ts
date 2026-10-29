/**
 * Web Worker for off-main-thread SHA-256 hashing.
 * Uses hash-wasm for incremental (streaming) SHA-256 that matches `sha256sum`.
 *
 * Messages:
 * - { type: 'init' } → { type: 'ready' }
 * - { type: 'hash', file: File, id: string } → { type: 'progress', ... } then { type: 'result', hash }
 * - { type: 'verify', blob: Blob, expected: string, id: string } → { type: 'verified', ok }
 *
 * v5-a4: the production client (hash-worker-client.ts) now drives a POOL of
 * inline Blob-URL workers built from the same algorithm; this standalone
 * module mirrors that worker body — including the v5-a4 double-buffered
 * reads (the next 4 MiB slice's arrayBuffer() is issued before the current
 * slice is hashed, overlapping I/O and crypto).
 */

import { createSHA256 } from 'hash-wasm'

let hasher: Awaited<ReturnType<typeof createSHA256>> | null = null

async function ensureHasher() {
  if (!hasher) {
    hasher = await createSHA256()
  }
  return hasher
}

self.onmessage = async (e: MessageEvent) => {
  const { type, data } = e.data

  if (type === 'init') {
    await ensureHasher()
    ;(self as any).postMessage({ type: 'ready' })
    return
  }

  if (type === 'hash') {
    const { file, id } = data as { file: File; id: string }
    const readSize = 4 * 1024 * 1024
    const total = file.size
    let offset = 0
    let chunkNum = 0

    const h = await ensureHasher()
    h.init()

    try {
      // v5-a4: double-buffered reads — issue the NEXT slice's arrayBuffer()
      // before feeding the CURRENT slice to the hasher, so I/O and crypto
      // overlap instead of serializing. Progress cadence is unchanged.
      let pendingRead = total > 0 ? file.slice(0, Math.min(readSize, total)).arrayBuffer() : null
      while (offset < total) {
        const end = Math.min(offset + readSize, total)
        // v5-a4: inside the loop pendingRead is never null — it is only
        // cleared when the previous slice reached EOF, which exits the loop.
        const buf = (await pendingRead)!
        pendingRead = end < total
          ? file.slice(end, Math.min(end + readSize, total)).arrayBuffer()
          : null
        h.update(new Uint8Array(buf))
        offset = end
        chunkNum++

        if (chunkNum % 4 === 0) {
          ;(self as any).postMessage({
            type: 'progress',
            id,
            bytesProcessed: offset,
            totalBytes: total,
          })
        }
        if (chunkNum % 16 === 0) {
          await new Promise((r) => setTimeout(r, 0))
        }
      }

      const hash = h.digest('hex')
      ;(self as any).postMessage({ type: 'result', id, hash })
    } catch (err: any) {
      ;(self as any).postMessage({ type: 'error', id, message: err.message })
    }
    return
  }

  if (type === 'verify') {
    const { blob, expected, id } = data as { blob: Blob; expected: string; id: string }
    const h = await ensureHasher()
    h.init()

    try {
      const readSize = 4 * 1024 * 1024
      const total = blob.size
      let offset = 0
      // v5-a4: double-buffered reads (same I/O/crypto overlap as 'hash').
      let pendingRead = total > 0 ? blob.slice(0, Math.min(readSize, total)).arrayBuffer() : null
      while (offset < total) {
        const end = Math.min(offset + readSize, total)
        // v5-a4: inside the loop pendingRead is never null (see 'hash' above).
        const buf = (await pendingRead)!
        pendingRead = end < total
          ? blob.slice(end, Math.min(end + readSize, total)).arrayBuffer()
          : null
        h.update(new Uint8Array(buf))
        offset = end
      }
      const hash = h.digest('hex')
      const ok = hash.toLowerCase() === expected.toLowerCase()
      ;(self as any).postMessage({ type: 'verified', id, ok, hash })
    } catch (err: any) {
      ;(self as any).postMessage({ type: 'error', id, message: err.message })
    }
    return
  }
}

export {}
