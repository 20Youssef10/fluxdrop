/**
 * Web Worker for off-main-thread SHA-256 hashing.
 * Uses hash-wasm for incremental (streaming) SHA-256 that matches `sha256sum`.
 *
 * Messages:
 * - { type: 'init' } → { type: 'ready' }
 * - { type: 'hash', file: File, id: string } → { type: 'progress', ... } then { type: 'result', hash }
 * - { type: 'verify', blob: Blob, expected: string, id: string } → { type: 'verified', ok }
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
      while (offset < total) {
        const end = Math.min(offset + readSize, total)
        const slice = file.slice(offset, end)
        const buf = await slice.arrayBuffer()
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
      while (offset < total) {
        const end = Math.min(offset + readSize, total)
        const slice = blob.slice(offset, end)
        const buf = await slice.arrayBuffer()
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
