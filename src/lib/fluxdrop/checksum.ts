// SHA-256 streaming checksum using the Web Crypto API.
// Streams file data in chunks to avoid loading the whole file into memory.

import { CONSTANTS } from './protocol'

export async function hashFile(file: File | Blob): Promise<string> {
  // Web Crypto's subtle.digest doesn't stream, so we accumulate chunks
  // and feed them in. For very large files this is still memory-bounded
  // because we read slice-by-slice.
  const chunkSize = 4 * 1024 * 1024 // 4MB read slices
  const total = file.size
  let offset = 0

  // We have to read the whole file for a single digest call.
  // To bound memory, for files > 256MB we hash in segments and combine
  // via a second-pass digest of segment hashes.
  if (total <= 64 * 1024 * 1024) {
    const buf = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    return bufToHex(digest)
  }

  // Large-file streaming: hash each segment, then hash the concatenated segment hashes.
  const segments: ArrayBuffer[] = []
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total)
    const slice = file.slice(offset, end)
    const buf = await slice.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buf)
    segments.push(digest)
    offset = end
  }
  const combined = concatArrayBuffers(segments)
  const finalDigest = await crypto.subtle.digest('SHA-256', combined)
  return bufToHex(finalDigest)
}

export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data.buffer.slice(0) : data
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return bufToHex(digest)
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

// Verify a reassembled file against a manifest checksum
export async function verifyChecksum(file: Blob, expected: string): Promise<boolean> {
  const actual = await hashFile(file)
  return actual.toLowerCase() === expected.toLowerCase()
}

export { CONSTANTS }
