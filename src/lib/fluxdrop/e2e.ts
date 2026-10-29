// v1.2 "Locked down" — true end-to-end payload encryption (FEATURES.md 2.1 + 2.2).
//
// Design (why this is load-bearing, not decoration):
// - DTLS protects data in transit, but a malicious/compromised SIGNALING server
//   can MITM the DTLS handshake by swapping SDP fingerprints. The room PIN
//   already exists on both devices — v1.2 makes it cryptographically load-bearing
//   with a PAKE so the signaling server (which only ever relays opaque blobs)
//   learns NOTHING about the derived key, and an active MITM breaks key
//   confirmation instead of silently forwarding.
// - Primitive: SPAKE2 over P-256 (RFC 9382-shaped) using audited @noble/curves
//   arithmetic. The PAKE structure means every PIN guess an attacker makes
//   requires a fresh ONLINE interaction — a 6-digit PIN stays safe against
//   offline dictionary attacks.
// - Key confirmation (HMAC over the transcript) + SAS (6-digit short
//   authentication string shown on both sides) catch a two-leg MITM: each leg
//   derives a DIFFERENT key/SAS, so codes differ → user sees it.
// - Derived AES-256-GCM session key encrypts every payload-bearing frame
//   (manifest + chunks [+ previews]) BEFORE the DataChannel. Wire opcodes:
//   CHUNK_ENC / MANIFEST_ENC. Compression composes as compress-then-encrypt.
// - Control frames (ACKs, bitmaps, pause/resume) stay plaintext: they carry
//   chunk indices and booleans only — no file content, no names.
// - What the signaling server sees after v1.2: device aliases, room/PIN
//   metadata, SDP/ICE, and opaque PAKE/confirmation blobs. No names, no sizes,
//   no bytes.

import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { hmac } from '@noble/hashes/hmac.js'

// RFC 9383 test-vector constants M and N for P-256 (SPAKE2 M/N points).
const M_HEX = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f'
const N_HEX = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49'

const POINT_M = p256.Point.fromHex(M_HEX)
const POINT_N = p256.Point.fromHex(N_HEX)

// PBKDF2 work factor for password → scalar (w0). PAKE structure already
// forces online guessing; this just adds local CPU cost per guess.
const PBKDF2_ITERATIONS = 15_000
const PROTOCOL_TAG = 'fluxdrop-e2e-v1'

export type E2EStatus = 'idle' | 'handshaking' | 'active' | 'failed'

export interface E2EContext {
  roomId: string
  pin: string
  senderDeviceId: string
  receiverDeviceId: string
}

/** Messages exchanged via the signaling e2e-relay channel (opaque to the server). */
export type E2ERelayMessage =
  | { type: 'hello'; v: 1; salt: string; xPub: string }
  | { type: 'reply'; v: 1; yPub: string }
  | { type: 'confirm'; v: 1; mac: string }
  | { type: 'fail'; v: 1; reason: string }

// === bytes helpers ===
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
function toHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}
function fromHex(h: string): Uint8Array {
  const clean = h.length % 2 ? '0' + h : h
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesToBigInt(b: Uint8Array): bigint {
  let out = 0n
  for (const byte of b) out = (out << 8n) | BigInt(byte)
  return out
}
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

// === SPAKE2 core (symmetric — both sides hold the PIN) ===
interface SpakeSecrets {
  salt: Uint8Array
  w0: bigint
  scalar: bigint
  myPublic: ReturnType<typeof p256.Point.fromHex> | null
}

/** Derive w0 (password scalar) from PIN + salt. */
function deriveW0(pin: string, salt: Uint8Array): bigint {
  const key = pbkdf2(sha256, utf8(pin), salt, { c: PBKDF2_ITERATIONS, dkLen: 32 })
  return p256.Point.Fn.create(bytesToBigInt(key))
}

/**
 * Shared transcript. Binds EVERYTHING both sides must agree on: protocol tag,
 * room, both device ids, salt, both ephemeral points. Changing ANY byte here
 * changes the derived keys → confirmation fails.
 */
function transcriptBytes(ctx: E2EContext, salt: Uint8Array, xPub: Uint8Array, yPub: Uint8Array): Uint8Array {
  return concatBytes(
    utf8(PROTOCOL_TAG),
    utf8(ctx.roomId),
    utf8(ctx.senderDeviceId),
    utf8(ctx.receiverDeviceId),
    salt,
    xPub,
    yPub
  )
}

interface DerivedKeys {
  aesKeyRaw: Uint8Array
  confirmKey: Uint8Array
  sas: string
}

function deriveKeys(ctx: E2EContext, salt: Uint8Array, xPub: Uint8Array, yPub: Uint8Array, sharedPoint: ReturnType<typeof p256.Point.fromHex>): DerivedKeys {
  const sharedX = new Uint8Array(32)
  let kx = sharedPoint.x
  for (let i = 31; i >= 0; i--) {
    sharedX[i] = Number(kx & 0xffn)
    kx >>= 8n
  }
  const transcript = transcriptBytes(ctx, salt, xPub, yPub)
  const okm = hkdf(sha256, sharedX, sha256(transcript), utf8(`${PROTOCOL_TAG} keys`), 96)
  const aesKeyRaw = okm.slice(0, 32)
  const confirmKey = okm.slice(32, 64)
  const sasSeed = okm.slice(64, 96)
  let sasNum = 0n
  for (let i = 0; i < 8; i++) sasNum = (sasNum << 8n) | BigInt(sasSeed[i])
  const sas = (sasNum % 1_000_000n).toString().padStart(6, '0')
  return { aesKeyRaw, confirmKey, sas }
}

function confirmMac(confirmKey: Uint8Array, role: 'sender' | 'receiver', transcriptHash: Uint8Array): string {
  return toHex(hmac(sha256, confirmKey, concatBytes(utf8(`confirm:${role}:`), transcriptHash)))
}

/**
 * One PAKE handshake in progress. Exactly one instance per pairing attempt,
 * on each side. Roles: the sender runs the prover side ('x'), the receiver
 * the verifier side ('y') — the labels are symmetric in SPAKE2; role tags in
 * the transcript prevent reflection.
 */
export class E2EHandshake {
  readonly role: 'sender' | 'receiver'
  private ctx: E2EContext
  private secrets: SpakeSecrets | null = null
  private peerPublic: Uint8Array | null = null
  private myPublicBytes: Uint8Array | null = null
  private keys: DerivedKeys | null = null
  private transcriptHash: Uint8Array | null = null
  private done = false

  constructor(role: 'sender' | 'receiver', ctx: E2EContext) {
    this.role = role
    this.ctx = ctx
  }

  get isComplete(): boolean {
    return this.done
  }

  /** Raw derived AES key material (available once both messages processed). */
  get aesKeyRaw(): Uint8Array | null {
    return this.keys?.aesKeyRaw ?? null
  }

  /** SENDER step 1: create the hello (salt + ephemeral point X = x·G + w0·M). */
  createHello(): { salt: string; xPub: string } {
    if (this.role !== 'sender') throw new Error('createHello is sender-only')
    const salt = randomBytes(16)
    const w0 = deriveW0(this.ctx.pin, salt)
    const x = bytesToBigInt(p256.utils.randomSecretKey())
    const X = p256.Point.BASE.multiply(x).add(POINT_M.multiply(w0))
    const xPub = X.toBytes(true)
    this.secrets = { salt, w0, scalar: x, myPublic: X }
    this.myPublicBytes = xPub
    return { salt: toHex(salt), xPub: toHex(xPub) }
  }

  /** RECEIVER step 1: process hello → reply (Y = y·G + w0·N) + our confirm mac. */
  processHello(hello: { salt: string; xPub: string }): { reply: { yPub: string }; confirmMac: string; sas: string } {
    if (this.role !== 'receiver') throw new Error('processHello is receiver-only')
    const salt = fromHex(hello.salt)
    const xPub = fromHex(hello.xPub)
    const X = p256.Point.fromBytes(xPub)
    const w0 = deriveW0(this.ctx.pin, salt)
    const y = bytesToBigInt(p256.utils.randomSecretKey())
    const Y = p256.Point.BASE.multiply(y).add(POINT_N.multiply(w0))
    this.secrets = { salt, w0, scalar: y, myPublic: Y }
    this.myPublicBytes = Y.toBytes(true)
    this.peerPublic = xPub
    // K = y·(X − w0·M) == x·y·G  (the receiver's offset point is M)
    const shared = X.subtract(POINT_M.multiply(w0)).multiply(y)
    this.keys = deriveKeys(this.ctx, salt, xPub, this.myPublicBytes, shared)
    this.transcriptHash = sha256(transcriptBytes(this.ctx, salt, xPub, this.myPublicBytes))
    return {
      reply: { yPub: toHex(this.myPublicBytes) },
      confirmMac: confirmMac(this.keys.confirmKey, 'sender', this.transcriptHash), // expected FROM sender
      sas: this.keys.sas,
    }
  }

  /** SENDER step 2: process reply → keys + our confirm mac (to send). */
  processReply(reply: { yPub: string }): { confirmMac: string; sas: string } {
    if (this.role !== 'sender') throw new Error('processReply is sender-only')
    if (!this.secrets || !this.myPublicBytes) throw new Error('createHello must run first')
    const yPub = fromHex(reply.yPub)
    const Y = p256.Point.fromBytes(yPub)
    this.peerPublic = yPub
    // K = x·(Y − w0·N) == x·y·G
    const shared = Y.subtract(POINT_N.multiply(this.secrets.w0)).multiply(this.secrets.scalar)
    this.keys = deriveKeys(this.ctx, this.secrets.salt, this.myPublicBytes, yPub, shared)
    this.transcriptHash = sha256(transcriptBytes(this.ctx, this.secrets.salt, this.myPublicBytes, yPub))
    return {
      confirmMac: confirmMac(this.keys.confirmKey, 'sender', this.transcriptHash),
      sas: this.keys.sas,
    }
  }

  /** Verify the peer's confirmation mac. Throws on mismatch (MITM / wrong PIN state). */
  verifyPeerConfirm(mac: string): { sas: string } {
    if (!this.keys || !this.transcriptHash) throw new Error('handshake not ready for confirmation')
    const expected = confirmMac(this.keys.confirmKey, 'sender', this.transcriptHash)
    if (!timingSafeEqualHex(expected, mac)) {
      throw new Error('E2E confirmation mismatch — the connection may be intercepted or the PIN changed')
    }
    this.done = true
    return { sas: this.keys.sas }
  }

  /** Receiver: produce OUR confirmation mac (sent after verifying the sender's). */
  ourConfirmMac(): string {
    if (!this.keys || !this.transcriptHash) throw new Error('handshake not ready')
    return confirmMac(this.keys.confirmKey, 'receiver', this.transcriptHash)
  }

  /** Sender: verify the receiver's confirmation mac (role-tagged). */
  verifyReceiverConfirm(mac: string): { sas: string } {
    if (!this.keys || !this.transcriptHash) throw new Error('handshake not ready')
    const expected = confirmMac(this.keys.confirmKey, 'receiver', this.transcriptHash)
    if (!timingSafeEqualHex(expected, mac)) {
      throw new Error('E2E confirmation mismatch — the connection may be intercepted or the PIN changed')
    }
    this.done = true
    return { sas: this.keys.sas }
  }
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// === Session store (the single source of truth for wire crypto) ===
// v1.3 (6.1): sessions are keyed by PEER deviceId so a group sender holds one
// independent AES key per receiver (every pairing derives a fresh key from
// the SPAKE2 transcript). The receiver keeps exactly one session (its sender).
// Back-compat: call sites that don't know the peer resolve through a fallback
// chain (explicit key → sole key → legacy '__primary__' slot), so 1:1
// transfers behave exactly as before.

interface E2ESession {
  status: E2EStatus
  key: CryptoKey | null
  sas: string | null
  roomId: string | null
}

const PRIMARY_KEY = '__primary__'
const sessions = new Map<string, E2ESession>()

function blankSession(): E2ESession {
  return { status: 'idle', key: null, sas: null, roomId: null }
}
sessions.set(PRIMARY_KEY, blankSession())

/** Resolve the session that owns a wire frame. `peerId` wins when given. */
function resolveSession(peerId?: string | null): E2ESession {
  if (peerId) {
    const direct = sessions.get(peerId)
    if (direct) return direct
  }
  // Sole-session fallback: exactly one real session → that's the one.
  const real = [...sessions.entries()].filter(([k, s]) => k !== PRIMARY_KEY && s.status !== 'idle')
  if (real.length === 1) return real[0][1]
  return sessions.get(PRIMARY_KEY) ?? blankSession()
}

export function getE2EStatus(peerId?: string | null): E2EStatus {
  return resolveSession(peerId).status
}

export function getE2ESas(peerId?: string | null): string | null {
  return resolveSession(peerId).sas
}

export function setE2EStatus(status: E2EStatus): void {
  const primary = sessions.get(PRIMARY_KEY) ?? blankSession()
  primary.status = status
  if (status === 'idle') {
    primary.key = null
    primary.sas = null
    primary.roomId = null
  }
}

/**
 * Activate the session with the derived AES key (called by the hook).
 * `peerId` binds the key to that peer (group fan-out); omitted → legacy
 * primary slot (1:1 flows).
 */
export async function activateE2ESession(aesKeyRaw: Uint8Array, sas: string, roomId: string, peerId?: string | null): Promise<void> {
  const key = await crypto.subtle.importKey('raw', aesKeyRaw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const slotKey = peerId ?? PRIMARY_KEY
  sessions.set(slotKey, { status: 'active', key, sas, roomId })
  console.log(`[FluxDrop] E2E session active for peer ${peerId ? slotKey.slice(0, 8) : 'primary'} (room ${roomId.slice(0, 6)})`)
}

/** Quick check used by send/receive paths to decide wire framing. */
export function isE2EActive(peerId?: string | null): boolean {
  const s = resolveSession(peerId)
  return s.status === 'active' && !!s.key
}

/**
 * Active AND bound to a specific room+peer. A new room (or a new peer in a
 * group room) must run a FRESH handshake — keys are per-transcript.
 */
export function isE2EActiveForPeer(roomId: string | null | undefined, peerId: string | null | undefined): boolean {
  if (!roomId || !peerId) return false
  const s = sessions.get(peerId)
  return !!s && s.status === 'active' && !!s.key && s.roomId === roomId
}

/**
 * Active for the room under the legacy (peer-agnostic) resolution — used by
 * receiver-side guards that only know the room.
 */
export function isE2EActiveForRoom(roomId: string | null | undefined): boolean {
  return isE2EActive() && !!roomId && resolveSession().roomId === roomId
}

const NONCE_LEN = 12

/** AAD tags bind ciphertext to its frame type — frames can't be replayed across types. */
function aadFor(kind: 'chunk' | 'manifest' | 'preview' | 'chat' | 'clipboard'): Uint8Array {
  return utf8(`${PROTOCOL_TAG}:${kind}`)
}

/** Encrypt a wire payload → nonce(12) || ciphertext. Throws if session inactive. */
export async function encryptWirePayload(plain: ArrayBuffer | Uint8Array, kind: 'chunk' | 'manifest' | 'preview' | 'chat' | 'clipboard' = 'chunk', peerId?: string | null): Promise<ArrayBuffer> {
  const s = resolveSession(peerId)
  if (!s.key) throw new Error('E2E session not active')
  const nonce = randomBytes(NONCE_LEN)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aadFor(kind) as BufferSource, tagLength: 128 },
    s.key,
    plain as BufferSource
  )
  return concatBytes(nonce, new Uint8Array(ct)).buffer as ArrayBuffer
}

/** Decrypt a wire payload (nonce(12) || ciphertext). Throws on tamper/inactive. */
export async function decryptWirePayload(enc: ArrayBuffer | Uint8Array, kind: 'chunk' | 'manifest' | 'preview' | 'chat' | 'clipboard' = 'chunk', peerId?: string | null): Promise<ArrayBuffer> {
  const s = resolveSession(peerId)
  if (!s.key) throw new Error('E2E session not active')
  const bytes = enc instanceof Uint8Array ? enc : new Uint8Array(enc)
  if (bytes.length < NONCE_LEN + 16) throw new Error('Encrypted frame too short')
  const nonce = bytes.slice(0, NONCE_LEN)
  const ct = bytes.slice(NONCE_LEN)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aadFor(kind) as BufferSource, tagLength: 128 },
    s.key,
    ct as BufferSource
  )
  return pt
}

// === Signaling-path helpers (manifest relayed via server stays confidential) ===

/** Encrypt a JSON object for the signaling relay → "enc1.<b64 iv+ct>". */
export async function encryptJsonForSignaling(obj: unknown, kind: 'manifest' | 'preview' = 'manifest'): Promise<string> {
  const json = utf8(JSON.stringify(obj))
  const enc = await encryptWirePayload(json, kind)
  return `enc1.${toHex(new Uint8Array(enc))}`
}

/** Decrypt a "enc1.<hex>" payload from the signaling relay. Returns null if not an encrypted envelope. */
export async function decryptJsonFromSignaling(payload: string, kind: 'manifest' | 'preview' = 'manifest'): Promise<unknown | null> {
  if (!payload.startsWith('enc1.')) return null
  const enc = fromHex(payload.slice(5))
  const json = await decryptWirePayload(enc, kind)
  return JSON.parse(new TextDecoder().decode(json))
}

export function isEncryptedSignalingPayload(payload: unknown): boolean {
  return typeof payload === 'string' && payload.startsWith('enc1.')
}

/** Reset everything (cancel/cleanup/new pairing). With `peerId`: only that peer's session. */
export function resetE2ESession(peerId?: string | null): void {
  if (peerId) {
    sessions.delete(peerId)
  } else {
    sessions.clear()
    sessions.set(PRIMARY_KEY, blankSession())
  }
}
