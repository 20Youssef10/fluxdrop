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
  MessageType.PAUSE,
  MessageType.RESUME_STREAM,
])

// --- Transfer ID helpers: convert a UUID string <-> 4-byte truncated id ---
export function transferIdToBytes(uuid: string): Uint8Array {
  // Use first 8 hex chars of the UUID (no dashes) -> 4 bytes.
  const hex = uuid.replace(/-/g, '').slice(0, TRANSFER_ID_BYTES * 2)
  const bytes = new Uint8Array(TRANSFER_ID_BYTES)
  // Pad with zeros if hex is too short (malformed input safety).
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

// --- Encode a CHUNK_DATA message ---
export function encodeChunkData(transferId: string, chunkIndex: number, payload: ArrayBuffer | Uint8Array): ArrayBuffer {
  const idBytes = transferIdToBytes(transferId)
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
  const buffer = new ArrayBuffer(HEADER_SIZE + payloadBytes.byteLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  view.setUint8(0, MessageType.CHUNK_DATA)
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
  body?: unknown            // parsed JSON (for control messages)
}

/**
 * Decode a binary DataChannel message.
 * Throws if the message is too short (malformed/truncated).
 * The caller MUST wrap this in try/catch and route errors to onError.
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

  // Zero-copy: use a view into the original buffer instead of slicing.
  // Callers that need to retain the payload across GCs should copy it.
  const payloadByteLength = data.byteLength - HEADER_SIZE
  const payload =
    payloadByteLength > 0
      ? data.slice(HEADER_SIZE)
      : new ArrayBuffer(0)

  const result: DecodedMessage = { type, transferId, chunkIndex, payload }

  // Control messages carry JSON bodies
  if (CONTROL_TYPES.has(type)) {
    try {
      result.body = JSON.parse(textDecoder.decode(payload))
    } catch {
      result.body = {}
    }
  }
  return result
}
