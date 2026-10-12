// SHA-256 checksum using the Web Crypto API.
// For files ≤ 256 MB: read whole file and hash directly (standard SHA-256).
// For files > 256 MB: hash in 4 MB segments and combine segment digests
// (Merkle-like construction — detects corruption but won't match sha256sum).
//
// For production use, prefer hashFileWorker() from hash-worker-client.ts
// which uses hash-wasm in a Web Worker for true incremental SHA-256
// that matches sha256sum for ALL file sizes, off the main thread.

const HASH_CHUNK_SIZE = 4 * 1024 * 1024 // 4MB read slices
const WHOLE_FILE_THRESHOLD = 256 * 1024 * 1024 // ≤256MB: read whole file
const YIELD_INTERVAL = 4 // yield to UI every N chunks

export async function hashFile(file: File | Blob): Promise<string> {
  const total = file.size
  if (total === 0) {
    const digest = await crypto.subtle.digest('SHA-256', new ArrayBuffer(0))
    return bufToHex(digest)
  }

  if (total <= WHOLE_FILE_THRESHOLD) {
    const buf = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return bufToHex(digest)
  }

  // Large files: segment hashing (Merkle-like).
  const digests: ArrayBuffer[] = []
  let offset = 0
  let chunkNum = 0

  while (offset < total) {
    const end = Math.min(offset + HASH_CHUNK_SIZE, total)
    const slice = file.slice(offset, end)
    const buf = await slice.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    digests.push(digest)
    offset = end
    chunkNum++

    if (chunkNum % YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
    }
  }

  const combined = concatArrayBuffers(digests)
  const finalDigest = await crypto.subtle.digest('SHA-256', combined)
  return bufToHex(finalDigest)
}

export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data.buffer.slice(0) : data
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return bufToHex(digest)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset)
    offset += b.byteLength
  }
  return out.buffer
}

export async function verifyChecksum(file: Blob, expected: string): Promise<boolean> {
  const actual = await hashFile(file)
  return actual.toLowerCase() === expected.toLowerCase()
}
