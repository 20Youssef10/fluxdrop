// Binary wire-protocol encoding/decoding for FluxDrop DataChannel messages.
// Header layout (9 bytes, big-endian):
//   [0]      message type (u8)
//   [1..5]   transfer id (u32, truncated UUID)
//   [5..9]   chunk index (u32)
// Followed by variable payload for CHUNK_DATA, or a JSON body for control messages.

import { MessageType, HEADER_SIZE, TRANSFER_ID_BYTES } from './protocol'

// Hoist TextEncoder/TextDecoder to module scope (avoid per-call allocation).
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// Set of message types that carry JSON bodies (control messages).
const CONTROL_TYPES = new Set<number>([
  MessageType.MANIFEST,
  MessageType.MANIFEST_ACK,
  MessageType.TRANSFER_COMPLETE,
  MessageType.TRANSFER_COMPLETE_ACK,
  MessageType.TRANSFER_CANCEL,
  MessageType.RESUME_REQUEST,
  MessageType.RESUME_RESPONSE,
  MessageType.RESUME_QUERY,
  MessageType.PAUSE,
  MessageType.RESUME_STREAM,
  // v1.3 (6.3): in-room chat — JSON body { id, text, at }. NOTE: when the
  // E2E session is active the payload is an encrypted envelope, NOT JSON;
  // decodeMessage then parses body = {} and the router decrypts the raw
  // payload instead (see use-fluxdrop CHAT case).
  MessageType.CHAT,
])

// --- Transfer ID helpers: convert a UUID string <-> 4-byte truncated id ---
export function transferIdToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '').slice(0, TRANSFER_ID_BYTES * 2)
  const bytes = new Uint8Array(TRANSFER_ID_BYTES)
  const padded = hex.padEnd(TRANSFER_ID_BYTES * 2, '0')
  for (let i = 0; i < TRANSFER_ID_BYTES; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0
  }
  return bytes
}

export function bytesToTransferId(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

// --- View helpers (big-endian) ---
function writeU32BE(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, false)
}
function readU32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false)
}

// === Buffer pool for send path ===
// Reuse buffers to reduce GC pressure during large transfers.
// The pool holds pre-allocated ArrayBuffers of the chunk size + header.
class BufferPool {
  private pool: ArrayBuffer[] = []
  private bufferSize: number
  private maxPoolSize: number

  constructor(bufferSize: number, maxPoolSize: number = 8) {
    this.bufferSize = bufferSize
    this.maxPoolSize = maxPoolSize
  }

  acquire(): ArrayBuffer {
    const buf = this.pool.pop()
    if (buf && buf.byteLength >= this.bufferSize) return buf
    return new ArrayBuffer(this.bufferSize)
  }

  release(buf: ArrayBuffer): void {
    if (this.pool.length < this.maxPoolSize && buf.byteLength === this.bufferSize) {
      this.pool.push(buf)
    }
  }

  clear(): void {
    this.pool = []
  }
}

let chunkBufferPool: BufferPool | null = null

export function initBufferPool(chunkSize: number): void {
  chunkBufferPool = new BufferPool(HEADER_SIZE + chunkSize, 16)
}

export function clearBufferPool(): void {
  chunkBufferPool?.clear()
  chunkBufferPool = null
}

// --- Encode a CHUNK_DATA message ---
// Frame type resolution (v1.2): opts.enc wins (CHUNK_ENC — E2E encrypted),
// then opts.gzip (CHUNK_DATA_GZ), else plain CHUNK_DATA. A boolean 4th arg
// keeps the v1.1 signature working (gzip only).
export interface ChunkEncodeOpts {
  gzip?: boolean
  enc?: boolean
}
export function encodeChunkData(
  transferId: string,
  chunkIndex: number,
  payload: ArrayBuffer | Uint8Array,
  opts: boolean | ChunkEncodeOpts = false
): ArrayBuffer {
  const norm: ChunkEncodeOpts = typeof opts === 'boolean' ? { gzip: opts } : opts ?? {}
  const frameType = norm.enc
    ? MessageType.CHUNK_ENC
    : norm.gzip
      ? MessageType.CHUNK_DATA_GZ
      : MessageType.CHUNK_DATA
  const idBytes = transferIdToBytes(transferId)
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)

  // Try to use a pooled buffer if the payload fits.
  if (chunkBufferPool && payloadBytes.byteLength + HEADER_SIZE <= chunkBufferPool['bufferSize']) {
    const buffer = chunkBufferPool.acquire()
    // Truncate to exact size needed (subarray of the pooled buffer).
    // We can't resize ArrayBuffer, so we use a view.
    const view = new DataView(buffer, 0, HEADER_SIZE + payloadBytes.byteLength)
    const bytes = new Uint8Array(buffer, 0, HEADER_SIZE + payloadBytes.byteLength)
    view.setUint8(0, frameType)
    bytes.set(idBytes, 1)
    writeU32BE(view, 5, chunkIndex)
    bytes.set(payloadBytes, HEADER_SIZE)
    // Return a slice that owns its own memory (can't return pooled buffer
    // because the caller may hold it past the pool's reuse).
    // For pooled buffers, we still copy — but the pool reduces allocation
    // overhead by reusing the backing store for the next acquire.
    const result = buffer.slice(0, HEADER_SIZE + payloadBytes.byteLength)
    chunkBufferPool.release(buffer)
    return result
  }

  // Fallback: allocate directly (no pool).
  const buffer = new ArrayBuffer(HEADER_SIZE + payloadBytes.byteLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setUint8(0, frameType)
  bytes.set(idBytes, 1)
  writeU32BE(view, 5, chunkIndex)
  bytes.set(payloadBytes, HEADER_SIZE)
  return buffer
}

// --- Encode a CHUNK_ACK message (no payload beyond header) ---
export function encodeChunkAck(transferId: string, chunkIndex: number, ok: boolean): ArrayBuffer {
  const idBytes = transferIdToBytes(transferId)
  const buffer = new ArrayBuffer(HEADER_SIZE + 1)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setUint8(0, MessageType.CHUNK_ACK)
  bytes.set(idBytes, 1)
  writeU32BE(view, 5, chunkIndex)
  view.setUint8(HEADER_SIZE, ok ? 0x01 : 0x02)
  return buffer
}

// --- Encode a control message (MANIFEST, TRANSFER_COMPLETE, etc.) with JSON body ---
export function encodeControlMessage(
  type: number,
  transferId: string,
  chunkIndex: number,
  body: unknown
): ArrayBuffer {
  const idBytes = transferIdToBytes(transferId)
  const jsonBytes = textEncoder.encode(JSON.stringify(body ?? {}))
  const buffer = new ArrayBuffer(HEADER_SIZE + jsonBytes.byteLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setUint8(0, type)
  bytes.set(idBytes, 1)
  writeU32BE(view, 5, chunkIndex)
  bytes.set(jsonBytes, HEADER_SIZE)
  return buffer
}

// --- Decode any incoming DataChannel message ---
export interface DecodedMessage {
  type: number
  transferId: string
  chunkIndex: number
  payload: ArrayBuffer      // raw bytes after header (for CHUNK_DATA)
  payloadView: Uint8Array  // zero-copy view into the original buffer
  body?: unknown            // parsed JSON (for control messages)
}

/**
 * Decode a binary DataChannel message.
 * Throws if the message is too short (malformed/truncated).
 * The caller MUST wrap this in try/catch and route errors to onError.
 *
 * Uses zero-copy views (subarray) for the payload instead of slicing,
 * reducing per-chunk allocation on the receive hot path.
 */
export function decodeMessage(data: ArrayBuffer): DecodedMessage {
  if (data.byteLength < HEADER_SIZE) {
    throw new Error(`Malformed message: ${data.byteLength} bytes (minimum ${HEADER_SIZE} required)`)
  }

  const view = new DataView(data)
  const type = view.getUint8(0)
  const idBytes = new Uint8Array(data, 1, TRANSFER_ID_BYTES)
  const transferId = bytesToTransferId(idBytes)
  const chunkIndex = readU32BE(view, 5)

  // Zero-copy: use a subarray view into the original buffer.
  // The DataChannel message buffer is not reused by the browser,
  // so this view is safe to retain.
  const payloadByteLength = data.byteLength - HEADER_SIZE
  const payloadView = new Uint8Array(data, HEADER_SIZE, payloadByteLength)

  const result: DecodedMessage = {
    type,
    transferId,
    chunkIndex,
    payload: data.slice(HEADER_SIZE), // Keep for backwards compat (callers that expect ArrayBuffer)
    payloadView,                      // Zero-copy view for new callers
  }

  // Control messages carry JSON bodies
  if (CONTROL_TYPES.has(type)) {
    try {
      result.body = JSON.parse(textDecoder.decode(payloadView))
    } catch {
      result.body = {}
    }
  }
  return result
}
