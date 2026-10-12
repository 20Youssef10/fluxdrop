/**
 * Unit tests for FluxDrop encoding round-trip.
 * Run: bun test tests/unit/encoding.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  encodeChunkData,
  encodeChunkAck,
  encodeControlMessage,
  decodeMessage,
  transferIdToBytes,
  bytesToTransferId,
} from '../../src/lib/fluxdrop/encoding'
import { MessageType, HEADER_SIZE } from '../../src/lib/fluxdrop/protocol'

describe('transferIdToBytes / bytesToTransferId', () => {
  test('round-trips a UUID correctly', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const bytes = transferIdToBytes(uuid)
    expect(bytes.length).toBe(4) // TRANSFER_ID_BYTES = 4
    const recovered = bytesToTransferId(bytes)
    // The recovered ID is the truncated form (first 4 bytes of UUID as hex).
    expect(recovered).toBe('a1b2c3d4')
  })

  test('handles empty/short UUIDs without crashing', () => {
    const bytes = transferIdToBytes('')
    expect(bytes.length).toBe(4)
    const recovered = bytesToTransferId(bytes)
    expect(recovered).toBe('00000000')
  })
})

describe('encodeChunkData / decodeMessage', () => {
  test('round-trips a chunk correctly', () => {
    const transferId = 'deadbeef-1234-5678-abcd-ef1234567890'
    const chunkIndex = 42
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]).buffer

    const encoded = encodeChunkData(transferId, chunkIndex, payload)
    expect(encoded.byteLength).toBe(HEADER_SIZE + 5) // 9 header + 5 payload

    const decoded = decodeMessage(encoded)
    expect(decoded.type).toBe(MessageType.CHUNK_DATA)
    expect(decoded.chunkIndex).toBe(42)
    expect(decoded.payload.byteLength).toBe(5)
    expect(new Uint8Array(decoded.payload)).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]))
  })

  test('handles empty payload', () => {
    const transferId = 'aabbccdd-1234-5678-abcd-ef1234567890'
    const payload = new ArrayBuffer(0)

    const encoded = encodeChunkData(transferId, 0, payload)
    const decoded = decodeMessage(encoded)
    expect(decoded.payload.byteLength).toBe(0)
  })

  test('handles large payload (64 KB)', () => {
    const transferId = 'aabbccdd-1234-5678-abcd-ef1234567890'
    const payload = new Uint8Array(64 * 1024).fill(0xAB).buffer

    const encoded = encodeChunkData(transferId, 100, payload)
    const decoded = decodeMessage(encoded)
    expect(decoded.payload.byteLength).toBe(64 * 1024)
    expect(decoded.chunkIndex).toBe(100)
  })
})

describe('encodeChunkAck / decodeMessage', () => {
  test('round-trips a chunk ack (ok=true)', () => {
    const transferId = 'aabbccdd-1234-5678-abcd-ef1234567890'
    const encoded = encodeChunkAck(transferId, 5, true)
    const decoded = decodeMessage(encoded)

    expect(decoded.type).toBe(MessageType.CHUNK_ACK)
    expect(decoded.chunkIndex).toBe(5)
    // ACK payload is 1 byte: 0x01 = ok
    expect(new Uint8Array(decoded.payload)[0]).toBe(0x01)
  })

  test('round-trips a chunk ack (ok=false)', () => {
    const transferId = 'aabbccdd-1234-5678-abcd-ef1234567890'
    const encoded = encodeChunkAck(transferId, 10, false)
    const decoded = decodeMessage(encoded)

    expect(decoded.type).toBe(MessageType.CHUNK_ACK)
    expect(decoded.chunkIndex).toBe(10)
    expect(new Uint8Array(decoded.payload)[0]).toBe(0x02)
  })
})

describe('encodeControlMessage / decodeMessage', () => {
  test('round-trips a manifest message', () => {
    const transferId = 'aabbccdd-1234-5678-abcd-ef1234567890'
    const body = { transferId: 'test-123', files: [{ name: 'test.txt', size: 100 }] }

    const encoded = encodeControlMessage(MessageType.MANIFEST, transferId, 0, body)
    const decoded = decodeMessage(encoded)

    expect(decoded.type).toBe(MessageType.MANIFEST)
    expect(decoded.chunkIndex).toBe(0)
    expect(decoded.body).toEqual(body)
  })

  test('round-trips a transfer-complete message', () => {
    const transferId = 'aabbccdd-1234-5678-abcd-ef1234567890'
    const body = { finalChecksum: 'abc123' }

    const encoded = encodeControlMessage(MessageType.TRANSFER_COMPLETE, transferId, 0, body)
    const decoded = decodeMessage(encoded)

    expect(decoded.type).toBe(MessageType.TRANSFER_COMPLETE)
    expect(decoded.body).toEqual({ finalChecksum: 'abc123' })
  })

  test('round-trips a cancel message', () => {
    const transferId = 'aabbccdd-1234-5678-abcd-ef1234567890'
    const body = { reason: 'User cancelled' }

    const encoded = encodeControlMessage(MessageType.TRANSFER_CANCEL, transferId, 0, body)
    const decoded = decodeMessage(encoded)

    expect(decoded.type).toBe(MessageType.TRANSFER_CANCEL)
    expect(decoded.body).toEqual({ reason: 'User cancelled' })
  })
})

describe('decodeMessage error handling', () => {
  test('throws on messages shorter than HEADER_SIZE', () => {
    const shortMsg = new ArrayBuffer(4) // Less than 9 bytes
    expect(() => decodeMessage(shortMsg)).toThrow('Malformed message')
  })

  test('handles exactly HEADER_SIZE bytes (no payload)', () => {
    const buf = new ArrayBuffer(HEADER_SIZE)
    const view = new DataView(buf)
    view.setUint8(0, MessageType.CHUNK_DATA) // type
    const decoded = decodeMessage(buf)
    expect(decoded.type).toBe(MessageType.CHUNK_DATA)
    expect(decoded.payload.byteLength).toBe(0)
  })
})
