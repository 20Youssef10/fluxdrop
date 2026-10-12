// SHA-256 checksum using the Web Crypto API.
// For files ≤ 256 MB: read whole file and hash directly (standard SHA-256).
// For files > 256 MB: hash in 4 MB segments and combine the segment hashes
// into a final digest. This is NOT standard SHA-256 of the file — it's a
// Merkle-like construction. The README documents this limitation.
// Yields to the event loop periodically to avoid blocking the UI.

const HASH_CHUNK_SIZE = 4 * 1024 * 1024 // 4MB read slices
const WHOLE_FILE_THRESHOLD = 256 * 1024 * 1024 // ≤256MB: read whole file
const YIELD_INTERVAL = 4 // yield to UI every N chunks

export async function hashFile(file: File | Blob): Promise<string> {
  const total = file.size
  if (total === 0) {
    const digest = await crypto.subtle.digest('SHA-256', new ArrayBuffer(0))
    return bufToHex(digest)
  }

  // Small files: read whole file into memory and hash directly.
  // This produces standard SHA-256 that matches `sha256sum`.
  if (total <= WHOLE_FILE_THRESHOLD) {
    const buf = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return bufToHex(digest)
  }

  // Large files: hash each segment, then hash the concatenated segment digests.
  // NOTE: This is NOT standard SHA-256 of the file. It's a Merkle-like
  // construction for memory-bounded hashing. The checksum still detects
  // any corruption (a single bit change in any segment changes the final
  // digest), but it won't match `sha256sum` output for files > 256 MB.
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

    // Yield to the event loop periodically so the UI stays responsive.
    if (chunkNum % YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
    }
  }

  const combined = concatArrayBuffers(digests)
  const finalDigest = await crypto.subtle.digest('SHA-256', combined)
  return bufToHex(finalDigest)
}

/** Hash a byte array (small data, no streaming needed). */
export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data.buffer.slice(0) : data
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return bufToHex(digest)
}

/** Yield control back to the event loop so the UI can paint. */
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

/** Verify a reassembled file against a manifest checksum. */
export async function verifyChecksum(file: Blob, expected: string): Promise<boolean> {
  const actual = await hashFile(file)
  return actual.toLowerCase() === expected.toLowerCase()
}
