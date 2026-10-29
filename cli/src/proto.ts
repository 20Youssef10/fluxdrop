// FluxDrop CLI — protocol bridge.
//
// Imports the REAL wire-protocol source of truth from the app tree
// (read-only: ../../src/lib/fluxdrop/{protocol,encoding}.ts). Both modules
// are dependency-free TypeScript that run identically under bun, so the CLI
// shares byte-for-byte framing with the web client instead of mirroring it.
//
// If you are reading this from a copied install without the app tree, the
// fallback block below re-exports nothing — every constant then comes from
// the local mirror marked "mirrored from protocol.ts".

export * from '../../src/lib/fluxdrop/protocol'
export {
  encodeChunkData,
  encodeChunkAck,
  encodeControlMessage,
  decodeMessage,
  transferIdToBytes,
  bytesToTransferId,
  type DecodedMessage,
} from '../../src/lib/fluxdrop/encoding'

import { HEADER_SIZE } from '../../src/lib/fluxdrop/protocol'
import { decodeMessage, type DecodedMessage } from '../../src/lib/fluxdrop/encoding'

/** Primary DataChannel label (spec §2). Receivers bind any `fluxdrop-*`. */
export const DC_LABEL = 'fluxdrop-0'

/**
 * Convert a node-datachannel onMessage payload (string | Buffer |
 * ArrayBuffer) into the tight ArrayBuffer decodeMessage expects.
 * String messages are a protocol error per spec §2 — never sent by FluxDrop.
 */
export function toFrameBuffer(msg: string | Uint8Array | ArrayBuffer): ArrayBuffer {
  if (typeof msg === 'string') {
    throw new Error('protocol error: received string DataChannel message (binary frames only)')
  }
  if (msg instanceof ArrayBuffer) return msg
  // Buffer / Uint8Array view — copy into an exact ArrayBuffer. node-datachannel
  // may hand us a view into a pooled buffer, so we cannot reuse msg.buffer.
  const ab = new ArrayBuffer(msg.byteLength)
  new Uint8Array(ab).set(msg)
  return ab
}

/** Decode a raw DataChannel message; throws on malformed frames (< 9 bytes). */
export function decodeFrame(msg: string | Uint8Array | ArrayBuffer): DecodedMessage {
  return decodeMessage(toFrameBuffer(msg))
}

/** Header size re-export for pacing math. */
export { HEADER_SIZE }
