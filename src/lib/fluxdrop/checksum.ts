// SHA-256 checksum.
// For files ≤ 256 MB: read whole file and hash directly (standard SHA-256).
// For files > 256 MB: hash in 4 MB segments and combine segment digests
// (Merkle-like construction — detects corruption but won't match sha256sum).
//
// Hashing works in every context FluxDrop can be opened in:
//   - `crypto.subtle.digest()` (native, preferred) on secure contexts;
//   - `hash-wasm` (already a dependency, also used by the hash worker) on
//     insecure origins, where browsers hide `crypto.subtle` entirely — e.g.
//     plain-HTTP LAN URLs like http://192.168.1.20:8081.
// Both backends emit byte-identical digests, so checksums stay comparable no
// matter how each device reached the app.
//
// For production use, prefer hashFileWorker() from hash-worker-client.ts
// which uses hash-wasm in a Web Worker for true incremental SHA-256
// that matches sha256sum for ALL file sizes, off the main thread.

const HASH_CHUNK_SIZE = 4 * 1024 * 1024 // 4MB read slices
const WHOLE_FILE_THRESHOLD = 256 * 1024 * 1024 // ≤256MB: read whole file
const YIELD_INTERVAL = 4 // yield to UI every N chunks
// v1.3 (1.6): streamed-verification read slices — RAM-bounded at 8 MB.
const STREAM_SLICE_SIZE = 8 * 1024 * 1024

type ByteSource = ArrayBuffer | Uint8Array

/**
 * Native Web Crypto digest — only present in secure contexts.
 * Returns null on insecure origins (plain-HTTP LAN addresses).
 */
function getSubtle(): SubtleCrypto | null {
  if (typeof globalThis === 'undefined') return null
  const webCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (!webCrypto || typeof webCrypto.subtle?.digest !== 'function') return null
  return webCrypto.subtle
}

/** SHA-256 digest of `data` as raw bytes, using the best available backend. */
async function sha256(data: ByteSource): Promise<Uint8Array> {
  const subtle = getSubtle()
  if (subtle) {
    // A Uint8Array is a valid BufferSource at runtime. TS 5.7's DOM lib only
    // accepts ArrayBuffer-backed views, so narrow the union to a plain view
    // (no copy) and copy only for SharedArrayBuffer-backed arrays.
    const source: ArrayBuffer | Uint8Array<ArrayBuffer> = data instanceof Uint8Array
      ? data.buffer instanceof ArrayBuffer
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
      : data
    return new Uint8Array(await subtle.digest('SHA-256', source))
  }
  return sha256Wasm(data)
}

/** hash-wasm fallback for insecure contexts — byte-identical to native. */
async function sha256Wasm(data: ByteSource): Promise<Uint8Array> {
  const { createSHA256 } = await import('hash-wasm')
  const hasher = await createSHA256()
  hasher.init()
  hasher.update(data instanceof Uint8Array ? data : new Uint8Array(data))
  return hexToBytes(hasher.digest('hex'))
}

export async function hashFile(file: File | Blob): Promise<string> {
  const total = file.size
  if (total === 0) {
    return bufToHex(await sha256(new ArrayBuffer(0)))
  }

  if (total <= WHOLE_FILE_THRESHOLD) {
    const buf = await file.arrayBuffer()
    return bufToHex(await sha256(buf))
  }

  // Large files: segment hashing (Merkle-like).
  const digests: Uint8Array[] = []
  let offset = 0
  let chunkNum = 0

  while (offset < total) {
    const end = Math.min(offset + HASH_CHUNK_SIZE, total)
    const slice = file.slice(offset, end)
    const buf = await slice.arrayBuffer()
    digests.push(await sha256(buf))
    offset = end
    chunkNum++

    if (chunkNum % YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
    }
  }

  const finalDigest = await sha256(concatBytes(digests))
  return bufToHex(finalDigest)
}

export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  return bufToHex(await sha256(data))
}

/**
 * v1.3 (1.6): incremental SHA-256 over the byte range [start, end) of a
 * Blob/File, read in 8 MB slices — RAM-bounded no matter how large the range
 * is. Uses hash-wasm's incremental hasher so the digest matches `sha256sum`
 * for ALL sizes (unlike hashFile's Merkle-like construction above 256 MB).
 * Used by the streamed receive pipeline to verify a file's byte range
 * directly from the OPFS temp file without ever assembling it in memory.
 */
export async function hashBlobRange(
  file: Blob,
  start: number,
  end: number,
  onProgress?: (bytesProcessed: number, totalBytes: number) => void
): Promise<string> {
  const { createSHA256 } = await import('hash-wasm')
  const hasher = await createSHA256()
  hasher.init()
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(from, end)
  let offset = from
  let chunkNum = 0
  while (offset < to) {
    const sliceEnd = Math.min(offset + STREAM_SLICE_SIZE, to)
    const buf = await file.slice(offset, sliceEnd).arrayBuffer()
    hasher.update(new Uint8Array(buf))
    offset = sliceEnd
    chunkNum++
    onProgress?.(offset - from, to - from)
    if (chunkNum % YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
    }
  }
  return hasher.digest('hex')
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function bufToHex(buf: ByteSource): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export async function verifyChecksum(file: Blob, expected: string): Promise<boolean> {
  const actual = await hashFile(file)
  return actual.toLowerCase() === expected.toLowerCase()
}
