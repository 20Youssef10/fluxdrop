// v1.1 wire compression: per-chunk gzip via native CompressionStream.
//
// Design notes:
// - Each chunk payload is gzipped INDEPENDENTLY before framing (opcode
//   CHUNK_DATA_GZ). Per-chunk (not per-file/stream) keeps every frame
//   self-contained: resume bitmaps, out-of-order arrival on parallel
//   DataChannels, and per-chunk ACKs all work unchanged.
// - The manifest checksums remain over the ORIGINAL bytes; the receiver
//   decompresses each chunk BEFORE storing it, so the entire downstream
//   pipeline (IndexedDB persistence, byte-offset slicing, SHA-256 verify)
//   operates on original bytes exactly as before.
// - Skipped MIME types (already-compressed formats) never pay the CPU cost.

import { CONSTANTS } from './protocol'

const COMPRESSIBLE_MIME_PREFIXES = ['text/', 'message/', 'multipart/']
const COMPRESSIBLE_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/csv',
  'application/sql',
  'application/yaml',
  'application/toml',
  'application/rtf',
  'application/wasm',
  'application/x-httpd-php',
  'application/x-sh',
  'image/svg+xml',
  'font/ttf',
  'font/otf',
  'font/woff', // woff2 is already compressed — excluded below
])

const COMPRESSIBLE_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less',
  '.html', '.htm', '.svg', '.vue', '.svelte', '.astro',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.sh', '.bash', '.zsh', '.fish', '.sql', '.lua', '.pl',
  '.r', '.swift', '.dart', '.log', '.rtf', '.tex', '.srt', '.vtt',
  '.wasm', '.ttf', '.otf', '.woff', '.gpx', '.kml', '.geojson',
]

/** MIME types / extensions that are already compressed — never gzip again. */
const INCOMPRESSIBLE_HINTS = [
  'zip', 'gzip', 'gz', 'br', 'brotli', 'xz', 'zstd', 'zst', 'lz4', 'snappy',
  '7z', 'rar', 'tar', 'compress', 'mp4', 'webm', 'mkv', 'mov', 'avi',
  'mp3', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wav',
  'jpeg', 'jpg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp',
  'woff2', 'pdf', 'epub', 'apk', 'ipa', 'dmg', 'iso',
]

export interface CompressionCheck {
  supported: boolean
  compressible: boolean
}

/** True when this browser supports the native gzip streams API. */
export function isCompressionSupported(): boolean {
  return (
    typeof globalThis.CompressionStream === 'function' &&
    typeof globalThis.DecompressionStream === 'function'
  )
}

/** Heuristic: would gzip help this MIME type / filename? */
export function isCompressibleType(mime: string, name: string): boolean {
  const lowerMime = (mime || '').toLowerCase()
  const lowerName = (name || '').toLowerCase()

  const hintHit = INCOMPRESSIBLE_HINTS.some(
    (h) => lowerMime.includes(h) || lowerName.endsWith(`.${h}`)
  )
  if (hintHit) return false

  if (COMPRESSIBLE_MIME_EXACT.has(lowerMime)) return true
  if (COMPRESSIBLE_MIME_PREFIXES.some((p) => lowerMime.startsWith(p))) return true
  if (lowerMime === '' || lowerMime === 'application/octet-stream') {
    return COMPRESSIBLE_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
  }
  return false
}

/**
 * Decide whether a transfer should use wire compression.
 * All files must look compressible (a single video would waste CPU for the
 * whole session), the browser must support the streams API, and tiny
 * transfers are skipped (framing overhead > savings).
 */
export function shouldCompressTransfer(
  files: { name: string; size: number; type: string }[],
  userPrefEnabled: boolean
): boolean {
  if (!userPrefEnabled) return false
  if (!isCompressionSupported()) return false
  if (files.length === 0) return false
  const totalSize = files.reduce((s, f) => s + f.size, 0)
  if (totalSize < CONSTANTS.GZIP_MIN_TRANSFER_BYTES) return false
  return files.every((f) => isCompressibleType(f.type, f.name))
}

/** gzip a chunk payload. Returns a fresh Uint8Array. */
export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  // Write a copy — the caller's view may be a subarray into a buffer the
  // DataChannel/reader lifecycle could touch after we return.
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  void writer.write(copy)
  void writer.close()
  const buf = await new Response(cs.readable).arrayBuffer()
  return new Uint8Array(buf)
}

/** gunzip a received chunk payload. Returns a fresh Uint8Array. */
export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  void writer.write(copy)
  void writer.close()
  const buf = await new Response(ds.readable).arrayBuffer()
  return new Uint8Array(buf)
}
