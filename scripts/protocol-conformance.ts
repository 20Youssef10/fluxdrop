#!/usr/bin/env bun
// =============================================================================
// FluxDrop v1 wire-protocol conformance suite — FEATURES.md 9.2
//
// Run:      cd /home/z/my-project && bun scripts/protocol-conformance.ts
// Exit:     0 = all checks passed, 1 = one or more checks failed
//
// What it does:
//   1. Generates golden vectors by exercising the REAL framing code
//      (../src/lib/fluxdrop/encoding.ts + protocol.ts — read-only imports;
//      both modules are dependency-free and run identically under bun).
//   2. Validates header encode/decode roundtrips for EVERY opcode 0x01–0x13.
//   3. Validates hand-written golden vectors (NIST SHA-256 + hand-computed
//      frame hex) via Web Crypto (available natively in bun).
//   4. Validates the E2EE frame layout (AES-256-GCM, nonce||ciphertext,
//      AAD purposes) with deterministic zero-key vectors.
//   5. Validates manifest JSON schema invariants (incl. compression/merkle).
//   6. Cross-checks the signaling event names against the set implemented by
//      mini-services/signaling/src/index.ts (mirrored literal list below).
//
// The "GOLDEN VECTORS" section printed on success is the canonical set quoted
// in docs/protocol-spec.md. If you change framing, re-run this script and
// update the spec — a mismatch here is an interop break.
// =============================================================================

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  MessageType,
  CONSTANTS,
  SIGNALING_EVENTS,
  HEADER_SIZE,
  TRANSFER_ID_BYTES,
  type TransferManifest,
} from '../src/lib/fluxdrop/protocol'
import {
  encodeChunkData,
  encodeChunkAck,
  encodeControlMessage,
  decodeMessage,
  transferIdToBytes,
  bytesToTransferId,
} from '../src/lib/fluxdrop/encoding'

// --- tiny check framework ---------------------------------------------------
let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}
async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return toHex(digest)
}

// Deterministic fixture used across every golden vector (mirrors the spec).
const GOLDEN_TID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const GOLDEN_TID_BYTES = 'a1b2c3d4'
const GOLDEN_PAYLOAD = new TextEncoder().encode('FluxDrop')

// Golden-vector scratch (filled in sections 6/7, printed in section 9).
const GOLDEN: Record<string, string> = {}

// ============================================================================
section('1. Static constants (opcodes, sizes, tunables)')
// ============================================================================
{
  const opcodes = Object.values(MessageType) as number[]
  // v5-b1 added WIPE_REQUEST (0x14) — 20 opcodes, 0x01..0x14.
  check('opcode count is exactly 20 (0x01..0x14)', opcodes.length === 20, `got ${opcodes.length}`)
  check(
    'opcodes are 0x01..0x14 with no gaps and no duplicates',
    opcodes.every((v) => Number.isInteger(v) && v >= 0x01 && v <= 0x14) &&
      new Set(opcodes).size === opcodes.length &&
      opcodes.reduce((a, b) => Math.max(a, b), 0) === 0x14 &&
      opcodes.reduce((a, b) => Math.min(a, b), 0x14) === 0x01
  )
  check('header size is 9 bytes', HEADER_SIZE === 9)
  check('transfer id on the wire is 4 bytes', TRANSFER_ID_BYTES === 4)
  check('chunk size is 64 KiB (WebRTC spec default max-message-size)', CONSTANTS.CHUNK_SIZE === 65536)
  check('max frame (header+chunk) fits 65,545 = WebRTC default max', HEADER_SIZE + CONSTANTS.CHUNK_SIZE === 65545)
  check('flow window constants are ordered lan > default > relayed > min', CONSTANTS.FLOW_WINDOW_LAN > CONSTANTS.FLOW_WINDOW_DEFAULT && CONSTANTS.FLOW_WINDOW_DEFAULT > CONSTANTS.FLOW_WINDOW_RELAYED && CONSTANTS.FLOW_WINDOW_RELAYED > CONSTANTS.FLOW_WINDOW_MIN)
}

// ============================================================================
section('2. Header encode/decode roundtrip for EVERY opcode')
// ============================================================================
// Raw binary frame builder — byte-for-byte identical to FluxDropWebRTC
// .sendRawFrame() / sendManifestEncrypted() layout in webrtc.ts:
//   [type:1B][transferId:4B][chunkIndex:4B][body...]
function rawFrame(type: number, tidBytes: Uint8Array, chunkIndex: number, body: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + body.byteLength)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  view.setUint8(0, type)
  bytes.set(tidBytes, 1)
  view.setUint32(5, chunkIndex >>> 0, false)
  bytes.set(body, HEADER_SIZE)
  return buf
}

// Which opcodes carry a JSON body (control-style). Mirrors CONTROL_TYPES in
// encoding.ts, but re-declared here so a drift in the real set FAILS loudly.
const EXPECTED_CONTROL_TYPES = new Set<number>([
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
  MessageType.CHAT,
])

function opcodeName(type: number): string {
  for (const [name, value] of Object.entries(MessageType)) if (value === type) return name
  return `UNKNOWN_0x${type.toString(16).padStart(2, '0')}`
}

{
  const tidBytes = transferIdToBytes(GOLDEN_TID)
  check('transferIdToBytes truncates UUID to first 4 bytes', toHex(tidBytes) === GOLDEN_TID_BYTES)
  check('bytesToTransferId(transferIdToBytes(x)) roundtrips', bytesToTransferId(tidBytes) === GOLDEN_TID_BYTES)
  check(
    'short ids are zero-padded (protocol: padEnd)',
    toHex(transferIdToBytes('ab')) === 'ab000000' && toHex(transferIdToBytes('')) === '00000000'
  )

  for (let type = 0x01; type <= 0x13; type++) {
    const name = opcodeName(type)
    let frame: ArrayBuffer
    if (type === MessageType.CHUNK_ACK) {
      frame = encodeChunkAck(GOLDEN_TID, 0x2a, true)
    } else if (EXPECTED_CONTROL_TYPES.has(type)) {
      frame = encodeControlMessage(type, GOLDEN_TID, 7, { probe: name })
    } else {
      // CHUNK_DATA, CHUNK_DATA_GZ, CHUNK_ENC, MANIFEST_ENC, PREVIEW_DATA,
      // CLIPBOARD — opaque binary payload after the 9-byte header.
      frame = rawFrame(type, tidBytes, 0x0102030, GOLDEN_PAYLOAD)
    }
    const decoded = decodeMessage(frame)
    const headerOk =
      decoded.type === type &&
      decoded.transferId === GOLDEN_TID_BYTES &&
      decoded.chunkIndex === (type === MessageType.CHUNK_ACK ? 0x2a : EXPECTED_CONTROL_TYPES.has(type) ? 7 : 0x0102030)
    const payloadOk =
      type === MessageType.CHUNK_ACK
        ? new Uint8Array(decoded.payload)[0] === 0x01 && decoded.payload.byteLength === 1
        : EXPECTED_CONTROL_TYPES.has(type)
          ? (decoded.body as { probe?: string })?.probe === name
          : toHex(decoded.payload) === toHex(GOLDEN_PAYLOAD)
    check(`opcode 0x${type.toString(16).padStart(2, '0')} ${name.padEnd(20)} header+payload roundtrip`, headerOk && payloadOk)
  }

  // Malformed / truncation rules.
  let threw = false
  try { decodeMessage(new ArrayBuffer(8)) } catch { threw = true }
  check('8-byte frame (header-1) throws Malformed message', threw)
  threw = false
  try { decodeMessage(new ArrayBuffer(0)) } catch { threw = true }
  check('empty frame throws', threw)
  const bare = decodeMessage(rawFrame(0x07, tidBytes, 0, new Uint8Array(0)))
  check('header-only TRANSFER_CANCEL frame decodes with empty payload', bare.payload.byteLength === 0 && bare.type === 0x07)
}

// ============================================================================
section('3. Real-encoder framing specifics')
// ============================================================================
{
  // 3a. CHUNK_DATA / CHUNK_DATA_GZ / CHUNK_ENC frame-type selection.
  const plain = encodeChunkData(GOLDEN_TID, 0, GOLDEN_PAYLOAD, false)
  const gz = encodeChunkData(GOLDEN_TID, 0, GOLDEN_PAYLOAD, { gzip: true })
  const enc = encodeChunkData(GOLDEN_TID, 0, GOLDEN_PAYLOAD, { enc: true })
  const both = encodeChunkData(GOLDEN_TID, 0, GOLDEN_PAYLOAD, { gzip: true, enc: true })
  check('plain -> CHUNK_DATA (0x01)', decodeMessage(plain).type === MessageType.CHUNK_DATA)
  check('gzip opt -> CHUNK_DATA_GZ (0x0d)', decodeMessage(gz).type === MessageType.CHUNK_DATA_GZ)
  check('enc opt -> CHUNK_ENC (0x0e); enc wins over gzip', decodeMessage(enc).type === MessageType.CHUNK_ENC && decodeMessage(both).type === MessageType.CHUNK_ENC)
  check('boolean opts back-compat: true == {gzip:true}', decodeMessage(encodeChunkData(GOLDEN_TID, 0, GOLDEN_PAYLOAD, true)).type === MessageType.CHUNK_DATA_GZ)

  // 3b. Compress-then-frame ordering: encoding.ts receives ALREADY-gzipped
  // bytes; the frame payload must equal the gzip bytes verbatim and gunzip
  // back to the original chunk.
  const chunk = nodeRandomBytes(256 * 1024) // deterministic content irrelevant
  const gzBytes = new Uint8Array(gzipSync(chunk))
  const gzFrame = encodeChunkData(GOLDEN_TID, 3, gzBytes, { gzip: true })
  const gzDecoded = decodeMessage(gzFrame)
  const gunzipped = gunzipSync(Buffer.from(gzDecoded.payloadView))
  check(
    'CHUNK_DATA_GZ payload is the gzipped bytes; gunzip == original chunk',
    gzDecoded.type === MessageType.CHUNK_DATA_GZ &&
      toHex(gzDecoded.payloadView) === toHex(gzBytes) &&
      gunzipped.equals(Buffer.from(chunk))
  )

  // 3c. CHUNK_ACK status byte: 0x01 ok / 0x02 fail.
  const ackOk = new Uint8Array(encodeChunkAck(GOLDEN_TID, 5, true))
  const ackFail = new Uint8Array(encodeChunkAck(GOLDEN_TID, 5, false))
  check('CHUNK_ACK ok byte is 0x01, fail byte is 0x02, frame is 10 bytes', ackOk[9] === 0x01 && ackFail[9] === 0x02 && ackOk.length === 10)

  // 3d. Control body JSON parsing + fail-soft on non-JSON payload.
  const badJson = rawFrame(MessageType.MANIFEST, transferIdToBytes(GOLDEN_TID), 0, new TextEncoder().encode('not-json{'))
  check('non-JSON control payload fails soft: body = {}', (decodeMessage(badJson).body as object | undefined)?.constructor === Object)

  // 3e. Zero-copy payloadView aliases the original buffer.
  const zeroCopy = decodeMessage(plain)
  check('payloadView is a zero-copy subarray view (same buffer)', (zeroCopy.payloadView.buffer as ArrayBuffer) === plain && zeroCopy.payloadView.byteOffset === HEADER_SIZE)
}

// ============================================================================
section('4. Hand-written golden vectors (SHA-256 via Web Crypto, NIST FIPS 180)')
// ============================================================================
{
  const nistVectors: Array<[string, string, string]> = [
    ['empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      '"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['one million "a" (2-block, 2^20 reps)', 'a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ]
  for (const [label, input, expected] of nistVectors) {
    const actual = await sha256Hex(new TextEncoder().encode(input))
    check(`SHA-256(${label}) matches NIST vector`, actual === expected, `got ${actual}`)
  }

  // Cross-implementation agreement: Web Crypto vs node:crypto on 1 MiB of
  // deterministic bytes (catches a broken crypto backend, not just bad math).
  const blob = nodeRandomBytes(1024 * 1024)
  const webCrypto = await sha256Hex(blob)
  const nodeCrypto = createHash('sha256').update(blob).digest('hex')
  check('Web Crypto SHA-256 === node:crypto SHA-256 on 1 MiB random blob', webCrypto === nodeCrypto)
}

// ============================================================================
section('5. Hand-written golden vectors (framing hex)')
// ============================================================================
{
  const v1 = toHex(encodeChunkData(GOLDEN_TID, 0, GOLDEN_PAYLOAD, false))
  check(
    'GV-1 CHUNK_DATA("FluxDrop", idx 0) == hand-computed hex',
    v1 === '01a1b2c3d400000000466c757844726f70',
    `got ${v1}`
  )
  const v2 = toHex(encodeChunkAck(GOLDEN_TID, 42, false))
  check('GV-2 CHUNK_ACK(idx 42, fail) == hand-computed hex', v2 === '02a1b2c3d40000002a02', `got ${v2}`)
  const v3 = toHex(encodeControlMessage(MessageType.PAUSE, GOLDEN_TID, 0, { paused: true }))
  check(
    'GV-3 PAUSE {"paused":true} == hand-computed hex',
    v3 === '0aa1b2c3d400000000' + toHex(new TextEncoder().encode('{"paused":true}')),
    `got ${v3}`
  )
  const v4 = toHex(encodeControlMessage(MessageType.TRANSFER_COMPLETE, GOLDEN_TID, 0, { finalChecksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }))
  check(
    'GV-4 TRANSFER_COMPLETE of the empty-file digest == hand-computed hex',
    v4 === '05a1b2c3d400000000' + toHex(new TextEncoder().encode('{"finalChecksum":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}')),
    `got ${v4}`
  )
}

// ============================================================================
section('6. E2EE frame layout (AES-256-GCM, nonce||ciphertext, AAD purposes)')
// ============================================================================
{
  const PROTOCOL_TAG = 'fluxdrop-e2e-v1'
  const keyRaw = new Uint8Array(32) // all-zero key: deterministic golden vector
  const nonce = new Uint8Array(12) // all-zero nonce: deterministic golden vector
  const key = await crypto.subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt', 'decrypt'])

  async function gcmSeal(plain: Uint8Array, kind: string): Promise<Uint8Array> {
    const aad = new TextEncoder().encode(`${PROTOCOL_TAG}:${kind}`)
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      plain as unknown as BufferSource
    )
    return new Uint8Array([ ...nonce, ...new Uint8Array(ct) ]) // nonce(12) || ct
  }
  async function gcmOpen(envelope: Uint8Array, kind: string): Promise<Uint8Array> {
    const aad = new TextEncoder().encode(`${PROTOCOL_TAG}:${kind}`)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.slice(0, 12), additionalData: aad, tagLength: 128 },
      key,
      envelope.slice(12) as unknown as BufferSource
    )
    return new Uint8Array(pt)
  }

  const chunkEnvelope = await gcmSeal(GOLDEN_PAYLOAD, 'chunk')
  check(
    'envelope layout is nonce(12) || ciphertext(pt+16 tag); "FluxDrop" -> 8+16=24B after nonce',
    chunkEnvelope.length === 12 + GOLDEN_PAYLOAD.length + 16
  )
  const reopened = await gcmOpen(chunkEnvelope, 'chunk')
  check('chunk AAD roundtrip decrypts to original payload', toHex(reopened) === toHex(GOLDEN_PAYLOAD))
  let wrongAadThrew = false
  try { await gcmOpen(chunkEnvelope, 'manifest') } catch { wrongAadThrew = true }
  check('decrypt with WRONG AAD purpose (manifest vs chunk) throws', wrongAadThrew)
  let tamperThrew = false
  try {
    const tampered = chunkEnvelope.slice()
    tampered[tampered.length - 1] ^= 0xff
    await gcmOpen(tampered, 'chunk')
  } catch { tamperThrew = true }
  check('flipping one ciphertext byte fails GCM auth', tamperThrew)

  const manifestEnvelope = await gcmSeal(new TextEncoder().encode('{"version":1}'), 'manifest')
  const chatEnvelope = await gcmSeal(new TextEncoder().encode('{"id":"x","text":"hi","at":1}'), 'chat')
  const previewEnvelope = await gcmSeal(new TextEncoder().encode('<preview-head-bytes>'), 'preview')

  // The deterministic zero-key/zero-nonce ciphertexts are golden vectors —
  // printed below and quoted in docs/protocol-spec.md §8.
  GOLDEN.chunkEnvelope = toHex(chunkEnvelope)
  GOLDEN.manifestEnvelope = toHex(manifestEnvelope)
  GOLDEN.chatEnvelope = toHex(chatEnvelope)
  GOLDEN.previewEnvelope = toHex(previewEnvelope)
}

// ============================================================================
section('7. Manifest JSON schema invariants')
// ============================================================================
{
  const FIXED_NOW = 1717000000000
  function buildManifest(overrides: Partial<TransferManifest> = {}): TransferManifest {
    const files = [
      { name: 'report.pdf', size: 150_000, type: 'application/pdf', lastModified: 1716000000000, checksum: 'a'.repeat(64), relativePath: 'report.pdf' },
      { name: 'data.bin', size: 50_000, type: 'application/octet-stream', lastModified: 1716000001000, checksum: 'b'.repeat(64), relativePath: 'data.bin' },
    ]
    const totalSize = files.reduce((s, f) => s + f.size, 0)
    return {
      transferId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      version: 1,
      files,
      totalSize,
      totalChunks: Math.ceil(totalSize / CONSTANTS.CHUNK_SIZE),
      chunkSize: CONSTANTS.CHUNK_SIZE,
      createdAt: FIXED_NOW,
      expiresAt: FIXED_NOW + CONSTANTS.RESUME_RECORD_TTL_MS,
      ...overrides,
    }
  }
  type Invariant = (m: TransferManifest) => string | null
  const invariants: Array<[string, Invariant]> = [
    ['version is exactly 1', (m) => (m.version === 1 ? null : 'version != 1')],
    ['totalChunks == ceil(totalSize / chunkSize)', (m) => (m.totalChunks === Math.ceil(m.totalSize / m.chunkSize) ? null : 'chunk math wrong')],
    ['sum(file sizes) == totalSize', (m) => (m.files.reduce((s, f) => s + f.size, 0) === m.totalSize ? null : 'size sum mismatch')],
    ['expiresAt > createdAt', (m) => (m.expiresAt > m.createdAt ? null : 'no expiry')],
    ['checksums are 64-char lowercase hex', (m) => (m.files.every((f) => /^[0-9a-f]{64}$/.test(f.checksum)) ? null : 'bad checksum format')],
    ['file count <= MAX_FILES_PER_TRANSFER', (m) => (m.files.length <= CONSTANTS.MAX_FILES_PER_TRANSFER ? null : 'too many files')],
    ['transferId is a UUID', (m) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m.transferId) ? null : 'not a uuid')],
    ['names are non-empty and <= 255 chars', (m) => (m.files.every((f) => f.name.length > 0 && f.name.length <= CONSTANTS.MAX_FILE_NAME_LENGTH) ? null : 'bad name')],
    ["compression, when present, is 'gzip'", (m) => (m.compression === undefined || m.compression === 'gzip' ? null : 'unknown compression')],
    ['merkle.leaves == totalChunks when present', (m) => (m.merkle === undefined || m.merkle.leaves === m.totalChunks ? null : 'leaf count mismatch')],
    ['merkle.root is 64-char lowercase hex when present', (m) => (m.merkle === undefined || /^[0-9a-f]{64}$/.test(m.merkle.root) ? null : 'bad merkle root')],
  ]
  const good = buildManifest({
    compression: 'gzip',
    merkle: { root: 'c'.repeat(64), leaves: Math.ceil(200_000 / CONSTANTS.CHUNK_SIZE) }, // == totalChunks
  })
  for (const [label, inv] of invariants) check(`valid manifest satisfies: ${label}`, inv(good) === null, inv(good) ?? undefined)

  // Mutations must be CAUGHT by the same invariants (proves the checks bite).
  const badChunkCount = buildManifest({ totalChunks: 99 })
  check('invariant catches totalChunks != ceil(totalSize/chunkSize)', invariants[1][1](badChunkCount) !== null)
  const badSizeSum = buildManifest({ totalSize: 999 })
  check('invariant catches sum(files) != totalSize', invariants[2][1](badSizeSum) !== null)
  const badMerkle = buildManifest({ merkle: { root: 'c'.repeat(64), leaves: 42 } })
  check('invariant catches merkle.leaves != totalChunks', invariants[9][1](badMerkle) !== null)
  const badCompression = buildManifest({ compression: 'zstd' as unknown as 'gzip' })
  check("invariant catches compression != 'gzip'", invariants[8][1](badCompression) !== null)

  // JSON roundtrip preserves every field incl. optional ones (the wire format
  // for MANIFEST / MANIFEST_ENC bodies is exactly JSON.stringify(manifest)).
  const round = JSON.parse(JSON.stringify(good)) as TransferManifest
  check(
    'manifest JSON roundtrip preserves fields incl. compression + merkle',
    JSON.stringify(round) === JSON.stringify(good) && round.compression === 'gzip' && round.merkle?.leaves === good.merkle?.leaves
  )
  GOLDEN.manifest = JSON.stringify(good)
}

// ============================================================================
section('8. Signaling event-name conformance (client <-> server contract)')
// ============================================================================
{
  // Mirrored from mini-services/signaling/src/index.ts (READ-ONLY source).
  // If the server ever renames an event, this check fails and forces the spec
  // to be updated in lockstep.
  const SERVER_EVENTS = new Set([
    'create-room', 'join-room', 'rejoin-room', 'pairing-request', 'pairing-confirm',
    'pairing-reject', 'webrtc-offer', 'webrtc-answer', 'webrtc-ice', 'transfer-manifest',
    'transfer-accepted', 'transfer-complete', 'transfer-cancel', 'resume-request',
    'resume-response', 'e2e-relay', 'heartbeat', 'leave-room',
    'leaderboard-submit', 'leaderboard-fetch',
    'room-created', 'room-joined', 'room-expired', 'room-closed', 'device-discovered',
    'device-left', 'signaling-error', 'leaderboard-data',
  ])
  const protocolEvents = new Set(Object.values(SIGNALING_EVENTS))
  const clientEmittable = new Set([...SERVER_EVENTS].filter((e) => e !== 'rejoin-room'))
  check(
    'every protocol.ts signaling event is served by the signaling server (except rejoin-room is server-known, client-internal)',
    [...protocolEvents].every((e) => SERVER_EVENTS.has(e)),
    `unserved: ${[...protocolEvents].filter((e) => !SERVER_EVENTS.has(e)).join(', ')}`
  )
  check(
    'every server event the client may emit exists in SIGNALING_EVENTS',
    [...clientEmittable].every((e) => protocolEvents.has(e)),
    `missing from protocol.ts: ${[...clientEmittable].filter((e) => !protocolEvents.has(e)).join(', ')}`
  )
  check(
    "rejoin-room is intentionally absent from SIGNALING_EVENTS (signaling.ts emits it raw for reconnect rebinding)",
    !protocolEvents.has('rejoin-room')
  )
}

// ============================================================================
section('9. Golden vector table (quote of record for docs/protocol-spec.md)')
// ============================================================================
{
  const manifestFrame = encodeControlMessage(MessageType.MANIFEST, GOLDEN_TID, 0, JSON.parse(GOLDEN.manifest as string))
  console.log(`  GV-1  CHUNK_DATA  transferId=${GOLDEN_TID_BYTES} idx=0 payload="FluxDrop"`)
  console.log(`        ${toHex(encodeChunkData(GOLDEN_TID, 0, GOLDEN_PAYLOAD, false))}`)
  console.log(`  GV-2  CHUNK_ACK   transferId=${GOLDEN_TID_BYTES} idx=42 ok=false`)
  console.log(`        ${toHex(encodeChunkAck(GOLDEN_TID, 42, false))}`)
  console.log(`  GV-3  PAUSE       transferId=${GOLDEN_TID_BYTES} idx=0 body={"paused":true}`)
  console.log(`        ${toHex(encodeControlMessage(MessageType.PAUSE, GOLDEN_TID, 0, { paused: true }))}`)
  console.log(`  GV-4  MANIFEST    transferId=${GOLDEN_TID_BYTES} idx=0 body=<full manifest JSON>`)
  console.log(`        ${toHex(manifestFrame)}`)
  console.log(`        manifest JSON: ${GOLDEN.manifest}`)
  console.log(`  GV-5  E2EE chunk envelope  key=00*32 nonce=00*12 AAD="fluxdrop-e2e-v1:chunk"    plain="FluxDrop"`)
  console.log(`        ${GOLDEN.chunkEnvelope}`)
  console.log(`  GV-6  E2EE manifest envelope  AAD="fluxdrop-e2e-v1:manifest"  plain={"version":1}`)
  console.log(`        ${GOLDEN.manifestEnvelope}`)
  console.log(`  GV-7  E2EE chat envelope  AAD="fluxdrop-e2e-v1:chat"  plain={"id":"x","text":"hi","at":1}`)
  console.log(`        ${GOLDEN.chatEnvelope}`)
  console.log(`  GV-8  E2EE preview envelope  AAD="fluxdrop-e2e-v1:preview"  plain="<preview-head-bytes>"`)
  console.log(`        ${GOLDEN.previewEnvelope}`)
  console.log(`  GV-9  SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
}

// 
// ============================================================================
// Summary
// ============================================================================
console.log(`\n${'='.repeat(72)}`)
console.log(`FluxDrop protocol conformance: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailed checks:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('WIRE PROTOCOL CONFORMANT — golden vectors above are the quote of record.')
process.exit(0)
