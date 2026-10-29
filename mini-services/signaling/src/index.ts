// FluxDrop signaling server — room lifecycle, pairing, ICE relay, discovery.
// Stateless after session establishment: never touches file data.
//
// v2.0 additions:
//   2.5 Signaling hardening kit — per-IP room-creation rate limit, structured
//       JSON logging, enriched /healthz, Redis-adapter docs (below).
//   8.2 Admin dashboard — opt-in (ADMIN_TOKEN), token-guarded, metadata only.
//   3.4 Expiring share links — POST /link pre-creates rooms; create-room can
//       claim them; one-join semantics auto-close the room after pairing.
//   3.2 LAN discovery — GET /nearby groups peers by IPv4 /24 + IPv6 /64.
//   8.3 Region endpoint — GET /region for multi-region latency probes.
//
// ─────────────────────────────────────────────────────────────────────────────
// HORIZONTAL SCALE (optional — deliberately NOT enabled): @socket.io/redis-adapter
//
// This server is intentionally single-process and dependency-light. To run N
// replicas behind a load balancer, every socket.io instance must share the
// event bus via the Redis adapter:
//
//   bun add @socket.io/redis-adapter redis
//
// and in this file (right after `const io = new Server(...)`):
//
//   import { createAdapter } from '@socket.io/redis-adapter'
//   import { createClient } from 'redis'
//
//   const pubClient = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
//   const subClient = pubClient.duplicate()
//   await Promise.all([pubClient.connect(), subClient.connect()])
//   io.adapter(createAdapter(pubClient, subClient))
//
// Caveats: the adapter only shares socket.io BROADCASTS. The in-memory maps in
// this file (rooms, socketToRoom, nearby presence, per-IP rate-limit windows,
// PIN-attempt counters) remain per-process, so a horizontally-scaled fleet ALSO
// needs a sticky load balancer (pin every client IP to one instance) or those
// structures must move into Redis. Nothing here is installed by default — the
// stock deployment keeps zero external runtime dependencies beyond socket.io.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash, timingSafeEqual } from 'crypto'
import { Server, type Socket } from 'socket.io'

const PORT = 3003
const VERSION = '2.0.0'
const REGION = process.env.FLUXDROP_REGION || 'local'

// === v2.0 (8.2): admin dashboard — opt-in via ADMIN_TOKEN; unset = disabled ===
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''

// === v1.1: TURN relay credential minting (coturn static-auth-secret) ===
// When TURN_URL/TURN_SECRET are configured, GET /turn-credentials returns
// short-lived HMAC credentials that coturn validates without a user DB.
// Without them the endpoint reports { enabled: false } and clients fall
// back to STUN-only — the same behavior as before v1.1.
const TURN_URL = process.env.TURN_URL ?? ''
const TURN_URL_TCP = process.env.TURN_URL_TCP ?? ''
const TURN_SECRET = process.env.TURN_SECRET ?? ''
const TURN_REALM = process.env.TURN_REALM ?? 'fluxdrop'
const TURN_TTL_SECONDS = 600

function turnCredentialsResponse(): { body: Record<string, unknown>; status: number } {
  if (!TURN_URL || !TURN_SECRET) {
    return { status: 200, body: { enabled: false, reason: 'TURN not configured on this server' } }
  }
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS
  const username = `${expiry}:fluxdrop`
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64')
  const urls = [TURN_URL, TURN_URL_TCP].filter(Boolean)
  return {
    status: 200,
    body: {
      enabled: true,
      ttlSeconds: TURN_TTL_SECONDS,
      realm: TURN_REALM,
      iceServers: [{ urls, username, credential }],
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2.0 (2.5): structured logging — one JSON object per line on stdout.
// { ts, level, event, ...fields }. LOG_LEVEL=debug|info|warn|error (default info).
// PRIVACY: never log PINs, file names, aliases or SDP/message contents —
// only room codes, device/socket counts, sizes and timestamps.
// ─────────────────────────────────────────────────────────────────────────────
type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const LOG_LEVEL: LogLevel = (() => {
  const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info'
})()

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + '\n')
  } catch {
    /* logging must never take the server down */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2.0 (2.5 / 3.2): client-IP helpers. Behind the Caddy gateway the direct
// remote address is the proxy, so honor X-Forwarded-For FIRST value when
// present (per-IP rate limiting + LAN subnet grouping depend on it).
// ─────────────────────────────────────────────────────────────────────────────
function normalizeIp(ip: string): string {
  let s = (ip ?? '').trim()
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7) // IPv4-mapped IPv6
  return s
}
function ipFromXff(xff: string | string[] | undefined): string {
  const raw = Array.isArray(xff) ? xff.join(',') : xff
  if (typeof raw !== 'string') return ''
  const first = raw.split(',')[0]?.trim() ?? ''
  return first ? normalizeIp(first) : ''
}
function clientIpOfSocket(socket: Socket): string {
  const viaXff = ipFromXff(socket.handshake?.headers?.['x-forwarded-for'])
  if (viaXff) return viaXff
  return normalizeIp(socket.handshake?.address ?? 'unknown')
}
function clientIpOfRequest(req: IncomingMessage): string {
  const viaXff = ipFromXff(req.headers['x-forwarded-for'])
  if (viaXff) return viaXff
  return normalizeIp(req.socket?.remoteAddress ?? 'unknown')
}
/** Salted-free short hash of an IP for logs — correlatable, not identifying. */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 12)
}

// ─────────────────────────────────────────────────────────────────────────────
// v2.0 (2.5): per-IP room-creation rate limit — sliding 60s window.
// ROOM_CREATE_RATE_PER_MIN tunes the budget (default 10, clamped 1..1000).
// Applies to socket `create-room` (incl. share-link claims) and POST /link —
// both mint rooms, so both share the same per-IP budget.
// ─────────────────────────────────────────────────────────────────────────────
const ROOM_CREATE_WINDOW_MS = 60_000
const ROOM_CREATE_RATE_PER_MIN = (() => {
  const n = parseInt(process.env.ROOM_CREATE_RATE_PER_MIN ?? '', 10)
  if (!Number.isFinite(n)) return 10
  return Math.min(1000, Math.max(1, n))
})()
const roomCreatesByIp = new Map<string, number[]>()

// ─────────────────────────────────────────────────────────────────────────────
// v5-a2: server-relayed fallback transport — chunk relay with a hard budget.
//
// relay-data / relay-ack only ever carry the LAST-DITCH fallback traffic of
// transfers whose P2P DataChannel could not be established at all. Chunks
// arrive pre-encrypted (AES-256-GCM under the room-PIN PAKE session key — the
// client encrypts BEFORE the transport), so the server relays opaque bytes.
// PRIVACY: relayed payloads are never logged, never stored, never inspected.
//
// Budget: a per-ROOM token bucket (default 4 MB/s sustained, 8 MB burst, both
// env-tunable) plus a per-frame base64 size cap (~128 KB decoded — a 64 KB
// chunk + gzip/encryption overhead base64-encodes to ≤ ~90 KB). Over quota →
// the SENDER gets relay-error { reason: 'quota' } and the frame is dropped;
// the client's 4 s retransmit timer retries once the bucket refills.
// ─────────────────────────────────────────────────────────────────────────────
export const RELAY_RATE_BYTES_PER_SEC = (() => {
  const n = parseInt(process.env.RELAY_RATE_BYTES_PER_SEC ?? '', 10)
  if (!Number.isFinite(n) || n <= 0) return 4 * 1024 * 1024
  return n
})()
export const RELAY_BURST_BYTES = (() => {
  const n = parseInt(process.env.RELAY_BURST_BYTES ?? '', 10)
  if (!Number.isFinite(n) || n <= 0) return 8 * 1024 * 1024
  return n
})()
const RELAY_MAX_B64_CHARS = 172 * 1024 // ~128 KB decoded

/** Per-room token bucket state: tokens refill at RELAY_RATE_BYTES_PER_SEC. */
const relayBuckets = new Map<string, { tokens: number; last: number }>()

function relayQuotaAllows(roomId: string, costBytes: number): boolean {
  const now = Date.now()
  const b = relayBuckets.get(roomId) ?? { tokens: RELAY_BURST_BYTES, last: now }
  b.tokens = Math.min(RELAY_BURST_BYTES, b.tokens + ((now - b.last) / 1000) * RELAY_RATE_BYTES_PER_SEC)
  b.last = now
  const allowed = b.tokens >= costBytes
  if (allowed) b.tokens -= costBytes
  relayBuckets.set(roomId, b)
  return allowed
}

function checkRoomCreateRate(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now()
  const recent = (roomCreatesByIp.get(ip) ?? []).filter((t) => now - t < ROOM_CREATE_WINDOW_MS)
  if (recent.length >= ROOM_CREATE_RATE_PER_MIN) {
    roomCreatesByIp.set(ip, recent)
    const retryAfterMs = recent[0] + ROOM_CREATE_WINDOW_MS - now
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
  }
  recent.push(now)
  roomCreatesByIp.set(ip, recent)
  return { allowed: true, retryAfterSec: 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2.0 (3.2): LAN discovery presence — GET /nearby.
// Peers are grouped by IPv4 /24 or IPv6 /64 of the CLIENT IP. Presence rows
// store only the subnet key (never the raw IP) + device id/alias/role.
// PRIVACY: responses contain device ids/aliases only — no IPs, no subnets.
// ─────────────────────────────────────────────────────────────────────────────
const NEARBY_TTL_MS = 30_000       // clients poll ~every 10s to refresh
const NEARBY_MAX_PEERS = 20
const NEARBY_MAX_TRACKED = 2048    // hard cap on the presence table
interface NearbyPeer {
  deviceId: string
  alias: string
  role: 'sender' | 'receiver'
  subnet: string
  seenAt: number
}
const nearbyPeers = new Map<string, NearbyPeer>() // deviceId -> presence

/** Expand a (possibly `::`-compressed) IPv6 address into its 8 groups. */
function ipv6Groups(addr: string): string[] {
  const noZone = addr.split('%')[0].toLowerCase()
  const idx = noZone.indexOf('::')
  if (idx === -1) return noZone.split(':')
  const head = noZone.slice(0, idx)
  const tail = noZone.slice(idx + 2)
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const missing = 8 - headGroups.length - tailGroups.length
  const fill = new Array(missing > 0 ? missing : 0).fill('0')
  return [...headGroups, ...fill, ...tailGroups]
}

/** Subnet grouping key: IPv4 /24 (a.b.c.0/24) or IPv6 /64 (first 4 groups). */
function subnetKey(ip: string): string {
  const v = normalizeIp(ip)
  if (v.includes(':')) {
    return 'v6:' + ipv6Groups(v).slice(0, 4).map((g) => g.padStart(4, '0')).join(':')
  }
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return 'other:' + v
  return `v4:${m[1]}.${m[2]}.${m[3]}.0/24`
}

/** Strip control chars, trim, cap at 32 chars — aliases are echoed to LAN peers. */
function sanitizeAlias(raw: string | null): string {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32)
  return s || 'device'
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

const ROOM_TTL_MS = 5 * 60 * 1000          // 5 min pre-pairing
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000    // 30 min post-transfer idle
// v1.3 (6.1): group rooms — one sender fans out to N receivers. The cap is
// env-tunable for self-hosters (clamped to a sane 2..32 range).
const MAX_DEVICES_PER_ROOM = (() => {
  const n = parseInt(process.env.MAX_DEVICES_PER_ROOM ?? '8', 10)
  if (!Number.isFinite(n)) return 8
  return Math.min(32, Math.max(2, n))
})()
const ROOM_ID_LENGTH = 6
const JOIN_CODE_LENGTH = 6
const PIN_LENGTH = 6

interface Device {
  id: string            // crypto.randomUUID from client
  socketId: string
  alias: string
  role: 'sender' | 'receiver'
  joinedAt: number
}

interface Room {
  id: string
  joinCode: string
  pin?: string
  createdAt: number
  expiresAt: number
  lastActivityAt: number
  devices: Map<string, Device>      // deviceId -> Device
  transferActive: boolean
  state: 'waiting' | 'pairing' | 'connected' | 'transferring' | 'closed'
  // v5-a2: cumulative relayed frame bytes (base64 length) for the admin
  // dashboard — metadata only, part of the room stats object.
  relayedBytes: number
  // v5-a2: best-effort same-transferId session check for the chunk relay —
  // set when a plaintext transfer-manifest with a readable transferId
  // passes through; sealed manifests leave it unset (no enforcement).
  activeTransferId?: string
  // v2.0 (3.4): room was pre-created via POST /link and no socket has
  // claimed ownership yet. Claimed rooms keep the link's expiry + oneJoin.
  preCreated?: boolean
  // v2.0 (3.4): one-join share link — room auto-closes to new joins once it
  // reaches 2 devices (sender + one receiver = pairing complete).
  oneJoin?: boolean
  // v2.0 (3.4): set once a oneJoin room hit its 2-device cap.
  closedForJoins?: boolean
}

const rooms = new Map<string, Room>()
const socketToRoom = new Map<string, string>()   // socketId -> roomId
const socketToDevice = new Map<string, string>() // socketId -> deviceId

// v2.0 (8.2): relayed-event counters (metadata only — names + counts, never
// payloads) powering the admin dashboard.
const relayCounts = new Map<string, number>()
function bumpRelay(event: string): void {
  relayCounts.set(event, (relayCounts.get(event) ?? 0) + 1)
}

// Rate limiting: track failed PIN attempts per socket
const pinAttempts = new Map<string, { count: number; lockedUntil: number }>()
const MAX_PIN_ATTEMPTS = 5
const PIN_LOCKOUT_MS = 60 * 1000 // 1 minute lockout after 5 failures

/** Check if a socket is rate-limited for PIN attempts. */
function isRateLimited(socketId: string): boolean {
  const entry = pinAttempts.get(socketId)
  if (!entry) return false
  if (entry.lockedUntil > Date.now()) return true
  if (entry.lockedUntil <= Date.now()) {
    pinAttempts.delete(socketId) // Reset after lockout expires
  }
  return false
}

/** Record a failed PIN attempt. */
function recordFailedPin(socketId: string): void {
  const entry = pinAttempts.get(socketId) ?? { count: 0, lockedUntil: 0 }
  entry.count++
  if (entry.count >= MAX_PIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + PIN_LOCKOUT_MS
  }
  pinAttempts.set(socketId, entry)
}

/** Verify that a socket is a member of the room before relaying events. */
function verifyMembership(socketId: string, roomId: string): boolean {
  const mappedRoom = socketToRoom.get(socketId)
  if (!mappedRoom || mappedRoom !== roomId) return false
  const room = rooms.get(roomId)
  if (!room) return false
  const deviceId = socketToDevice.get(socketId)
  if (!deviceId || !room.devices.has(deviceId)) return false
  return true
}

// --- v1.3 (6.1): unicast relay ---
// With 2 devices per room, `socket.to(room).emit(...)` was equivalent to
// "send to the peer". With N receivers it would broadcast offers/ICE/acks to
// EVERY member — receiver B must never see the offer addressed to receiver A.
// All per-peer relay events are now delivered to the addressed device's
// socket only. Membership of the DESTINATION is verified server-side.
function relayToDevice(io: Server, room: Room, event: string, payload: { to?: string } & Record<string, unknown>): void {
  const to = typeof payload?.to === 'string' ? payload.to : ''
  if (!to) return
  const device = room.devices.get(to)
  if (!device) return // addressed device already gone — drop silently
  const target = io.sockets.sockets.get(device.socketId)
  if (!target) return
  target.emit(event, payload)
  bumpRelay(event) // v2.0 (8.2): metadata-only counter for the admin dashboard
}

// --- Utilities ---
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars

/**
 * Cryptographically secure random code generator.
 * Uses crypto.getRandomValues instead of Math.random for security.
 */
function randomCode(len: number): string {
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length]
  }
  return out
}
function generateRoomId(): string {
  let id: string
  do { id = randomCode(ROOM_ID_LENGTH) } while (rooms.has(id))
  return id
}
function generatePin(): string {
  const buf = new Uint8Array(PIN_LENGTH)
  crypto.getRandomValues(buf)
  let pin = ''
  for (let i = 0; i < PIN_LENGTH; i++) pin += (buf[i] % 10).toString()
  return pin
}

// --- Room lifecycle ---
function createRoom(opts: { withPin?: boolean; alias: string; deviceId: string; role: 'sender' | 'receiver' }): Room {
  const id = generateRoomId()
  const joinCode = randomCode(JOIN_CODE_LENGTH)
  const now = Date.now()
  const room: Room = {
    id,
    joinCode,
    pin: opts.withPin ? generatePin() : undefined,
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
    lastActivityAt: now,
    devices: new Map(),
    transferActive: false,
    state: 'waiting',
    relayedBytes: 0,
  }
  rooms.set(id, room)
  return room
}

// v2.0 (3.4): pre-create a room for a share link. No socket owns it yet; the
// first create-room with { claim: { roomCode, pin } } takes ownership and the
// room then behaves exactly like a normal room (keeping this expiry + oneJoin).
function createPreCreatedRoom(ttlMinutes: number, oneJoin: boolean): Room {
  const id = generateRoomId()
  const now = Date.now()
  const room: Room = {
    id,
    joinCode: randomCode(JOIN_CODE_LENGTH),
    pin: generatePin(),
    createdAt: now,
    expiresAt: now + ttlMinutes * 60_000,
    lastActivityAt: now,
    devices: new Map(),
    transferActive: false,
    state: 'waiting',
    relayedBytes: 0,
    preCreated: true,
    oneJoin,
  }
  rooms.set(id, room)
  return room
}

function expireStaleRooms(io: Server) {
  const now = Date.now()
  for (const [id, room] of rooms) {
    const stale = room.state === 'waiting' && now > room.expiresAt
    const idle = (room.state === 'connected' || room.state === 'transferring') &&
                 now - room.lastActivityAt > ROOM_IDLE_TTL_MS
    if (stale || idle) {
      log('info', 'room_expired', { roomId: id, reason: stale ? 'timeout' : 'idle', devices: room.devices.size })
      io.to(id).emit('room-expired', { roomId: id, reason: stale ? 'timeout' : 'idle' })
      closeRoom(io, id, stale ? 'timeout' : 'idle')
    }
  }
}

function closeRoom(io: Server, roomId: string, reason = 'manual') {
  const room = rooms.get(roomId)
  if (!room) return
  for (const device of room.devices.values()) {
    const s = io.sockets.sockets.get(device.socketId)
    if (s) {
      s.leave(roomId)
      s.emit('room-closed', { roomId })
    }
  }
  room.devices.clear()
  room.state = 'closed'
  rooms.delete(roomId)
  log('info', 'room_closed', { roomId, reason })
}

function touchRoom(room: Room) {
  room.lastActivityAt = Date.now()
}

// ─────────────────────────────────────────────────────────────────────────────
// v2.0 (8.2): admin dashboard — token-guarded, metadata only.
// No PINs, no IPs, no aliases, no file data: room codes, counts, timestamps.
// ─────────────────────────────────────────────────────────────────────────────

/** Constant-time token comparison (both sides hashed to equal length). */
function tokenMatches(provided: string | null): boolean {
  if (!ADMIN_TOKEN || !provided) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(ADMIN_TOKEN).digest()
  return timingSafeEqual(a, b)
}

function adminTokenFromRequest(query: URLSearchParams, req: IncomingMessage): string | null {
  const q = query.get('token')
  if (q) return q
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return null
}

function findRoomByCode(code: string): Room | undefined {
  const c = (code ?? '').trim().toUpperCase()
  const byId = rooms.get(c)
  if (byId) return byId
  return Array.from(rooms.values()).find((r) => r.joinCode === c)
}

function adminSnapshot(): Record<string, unknown> {
  const roomList = Array.from(rooms.values()).map((r) => ({
    code: r.id,
    deviceCount: r.devices.size,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    senderPresent: Array.from(r.devices.values()).some((d) => d.role === 'sender'),
    state: r.state,
    transferActive: r.transferActive,
    // v5-a2: relay fallback counters (metadata only — bytes, never content).
    relayedBytes: r.relayedBytes,
    pending: r.preCreated === true,
    oneJoin: r.oneJoin === true,
  }))
  roomList.sort((a, b) => b.createdAt - a.createdAt)
  const relayedEvents: Record<string, number> = {}
  let totalRelayed = 0
  for (const [event, count] of relayCounts) {
    relayedEvents[event] = count
    totalRelayed += count
  }
  return {
    ok: true,
    version: VERSION,
    region: REGION,
    uptimeSec: Math.floor(process.uptime()),
    sockets: io.engine.clientsCount,
    maxDevicesPerRoom: MAX_DEVICES_PER_ROOM,
    rooms: roomList,
    relayedEvents,
    totalRelayed,
  }
}

// Self-contained admin page: inline CSS + JS, zero external assets, dark theme.
// Polls /admin/api every 3s; kill-switch buttons POST /admin/action.
const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>FluxDrop · Signaling Admin</title>
<style>
  :root {
    --bg: #0a0e16; --panel: #111827; --panel-2: #0d1320; --border: #1f2a3d;
    --text: #e6edf3; --muted: #8b98ab; --accent: #4f8cff; --danger: #ff5c5c;
    --ok: #3fd68f; --warn: #ffb454;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 28px 32px; }
  header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 22px; }
  .logo { width: 26px; height: 26px; flex: none; }
  .brand { font-size: 22px; font-weight: 800; letter-spacing: .3px; }
  .brand b { color: var(--accent); }
  .brand small { color: var(--muted); font-weight: 500; font-size: 13px; margin-left: 8px; }
  .meta { color: var(--muted); font-size: 12px; margin-left: auto; font-family: ui-monospace, monospace; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; }
  .card .v { font-size: 24px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  section { margin-bottom: 22px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted);
    margin-bottom: 10px; display: flex; align-items: center; gap: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px;
    padding: 3px 12px; font-size: 12px; font-family: ui-monospace, monospace; }
  .chip b { color: var(--accent); }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; background: var(--panel-2); }
  tr:last-child td { border-bottom: none; }
  td.code { font-family: ui-monospace, monospace; font-weight: 700; letter-spacing: 1px; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); }
  .pill.ok { color: var(--ok); border-color: rgba(63,214,143,.35); }
  .pill.warn { color: var(--warn); border-color: rgba(255,180,84,.35); }
  .pill.muted { color: var(--muted); }
  button { font: inherit; border-radius: 8px; border: 1px solid var(--border);
    background: var(--panel-2); color: var(--text); padding: 6px 14px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.danger { color: var(--danger); border-color: rgba(255,92,92,.4); }
  button.danger:hover { background: rgba(255,92,92,.12); border-color: var(--danger); }
  .empty { color: var(--muted); padding: 18px; text-align: center;
    background: var(--panel); border: 1px dashed var(--border); border-radius: 10px; }
  footer { color: var(--muted); font-size: 11px; margin-top: 26px; }
  .err { color: var(--danger); }
</style>
</head>
<body>
<header>
  <svg class="logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 2c3.5 4.2 7 7.6 7 11.5A7 7 0 0 1 5 13.5C5 9.6 8.5 6.2 12 2Z" fill="#4f8cff" opacity=".9"/>
    <path d="M9 13.5h6M12 10.5v6" stroke="#0a0e16" stroke-width="1.6" stroke-linecap="round"/>
  </svg>
  <div class="brand">Flux<b>Drop</b><small>signaling admin</small></div>
  <div class="meta" id="meta">connecting…</div>
</header>

<div class="stats">
  <div class="card"><div class="k">Uptime</div><div class="v" id="uptime">–</div></div>
  <div class="card"><div class="k">Connected sockets</div><div class="v" id="sockets">–</div></div>
  <div class="card"><div class="k">Rooms</div><div class="v" id="roomCount">–</div></div>
  <div class="card"><div class="k">Relayed events</div><div class="v" id="relayed">–</div></div>
</div>

<section>
  <h2>Relayed events by type</h2>
  <div class="chips" id="relayChips"><span class="pill muted">none yet</span></div>
</section>

<section>
  <h2>Live rooms
    <button id="closeAll" class="danger">Close all rooms</button>
  </h2>
  <div id="roomsTable"><div class="empty">loading…</div></div>
</section>

<footer>FluxDrop signaling admin · metadata only — room codes, device counts and timestamps.
No PINs, IP addresses, aliases or file data are ever displayed or stored here.</footer>

<script>
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('token') || '';
  var XPORT = qs.get('XTransformPort'); // keep gateway port-rewrite when proxied
  function apiUrl(path) {
    var p = new URLSearchParams();
    if (XPORT) p.set('XTransformPort', XPORT);
    p.set('token', TOKEN);
    return path + '?' + p.toString();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDur(sec) {
    if (sec == null) return '–';
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + m + 'm ' + s + 's';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  }
  function fmtTime(ms) {
    return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '–';
  }
  function fmtIn(ms) {
    var delta = Math.floor((ms - Date.now()) / 1000);
    if (delta <= 0) return 'expired';
    return 'in ' + fmtDur(delta);
  }
  function render(d) {
    document.getElementById('meta').textContent =
      d.region + ' · v' + d.version + ' · max ' + d.maxDevicesPerRoom + ' devices/room';
    document.getElementById('uptime').textContent = fmtDur(d.uptimeSec);
    document.getElementById('sockets').textContent = d.sockets;
    document.getElementById('roomCount').textContent = d.rooms.length;
    document.getElementById('relayed').textContent = d.totalRelayed;
    var keys = Object.keys(d.relayedEvents || {}).sort();
    document.getElementById('relayChips').innerHTML = keys.length
      ? keys.map(function (k) {
          return '<span class="chip">' + esc(k) + ' <b>' + d.relayedEvents[k] + '</b></span>';
        }).join('')
      : '<span class="pill muted">none yet</span>';
    var rooms = d.rooms || [];
    if (!rooms.length) {
      document.getElementById('roomsTable').innerHTML = '<div class="empty">No live rooms</div>';
      return;
    }
    var rows = rooms.map(function (r) {
      var sender = r.senderPresent
        ? '<span class="pill ok">yes</span>'
        : '<span class="pill warn">no</span>';
      var flags = '';
      if (r.pending) flags += ' <span class="pill warn">link · unclaimed</span>';
      if (r.oneJoin) flags += ' <span class="pill muted">one-join</span>';
      if (r.transferActive) flags += ' <span class="pill ok">transferring</span>';
      return '<tr>'
        + '<td class="code">' + esc(r.code) + '</td>'
        + '<td>' + esc(r.state) + flags + '</td>'
        + '<td>' + r.deviceCount + ' / ' + d.maxDevicesPerRoom + '</td>'
        + '<td>' + sender + '</td>'
        + '<td>' + fmtTime(r.createdAt) + '</td>'
        + '<td>' + fmtTime(r.expiresAt) + ' <span class="pill muted">' + fmtIn(r.expiresAt) + '</span></td>'
        + '<td><button class="danger kill" data-code="' + esc(r.code) + '">Kill</button></td>'
        + '</tr>';
    }).join('');
    document.getElementById('roomsTable').innerHTML =
      '<table><thead><tr><th>Code</th><th>State</th><th>Devices</th><th>Sender</th>'
      + '<th>Created</th><th>Expires</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  function action(body, cb) {
    fetch(apiUrl('/admin/action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () { cb && cb(); }, function () { cb && cb(); });
  }
  function refresh() {
    fetch(apiUrl('/admin/api')).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(render).catch(function (e) {
      document.getElementById('meta').innerHTML =
        '<span class="err">lost: ' + esc(e.message) + '</span>';
    });
  }
  document.getElementById('roomsTable').addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || t.tagName !== 'BUTTON' || !t.hasAttribute('data-code')) return;
    var code = t.getAttribute('data-code');
    if (confirm('Close room ' + code + '? Members will receive room-closed.')) {
      action({ action: 'close-room', roomCode: code }, refresh);
    }
  });
  document.getElementById('closeAll').addEventListener('click', function () {
    if (confirm('Close ALL rooms? Every member of every room receives room-closed.')) {
      action({ action: 'close-all' }, refresh);
    }
  });
  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>
`

async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  if (!ADMIN_TOKEN) {
    sendJson(res, 503, { error: 'admin disabled' })
    return
  }
  if (!tokenMatches(adminTokenFromRequest(query, req))) {
    sendJson(res, 401, { error: 'invalid or missing token' })
    return
  }
  if (path === '/admin' || path === '/admin/') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(ADMIN_HTML)
    return
  }
  if (path === '/admin/api') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
    sendJson(res, 200, adminSnapshot())
    return
  }
  if (path === '/admin/action') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' })
    }
    const action = body.action
    if (action === 'close-room') {
      const code = String(body.roomCode ?? '').trim()
      if (!code) return sendJson(res, 400, { error: 'roomCode required' })
      const room = findRoomByCode(code)
      if (!room) return sendJson(res, 404, { error: 'room not found' })
      closeRoom(io, room.id, 'admin')
      log('warn', 'admin_close_room', { roomId: room.id })
      sendJson(res, 200, { ok: true, action, roomCode: room.id, closed: 1 })
      return
    }
    if (action === 'close-all') {
      const codes = Array.from(rooms.keys())
      for (const code of codes) closeRoom(io, code, 'admin')
      log('warn', 'admin_close_all', { count: codes.length })
      sendJson(res, 200, { ok: true, action, closed: codes.length })
      return
    }
    sendJson(res, 400, { error: "unknown action — expected 'close-room' or 'close-all'" })
    return
  }
  sendJson(res, 404, { error: 'not found' })
}

// ─────────────────────────────────────────────────────────────────────────────
// v2.0 (3.4): POST /link — pre-create a room for a share link.
// Body: { ttlMinutes: 5|60|1440 (default 60), oneJoin: boolean (default false) }
// ─────────────────────────────────────────────────────────────────────────────
async function handleLink(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { error: String((err as Error)?.message ?? 'invalid body') })
    return
  }
  const ttlMinutes = Number(body.ttlMinutes ?? 60)
  if (![5, 60, 1440].includes(ttlMinutes)) {
    sendJson(res, 400, { error: 'ttlMinutes must be one of 5, 60, 1440' })
    return
  }
  const oneJoin = body.oneJoin === true
  const ip = clientIpOfRequest(req)
  const rl = checkRoomCreateRate(ip)
  if (!rl.allowed) {
    log('warn', 'rate_limited', { source: 'http', path: '/link', ipHash: hashIp(ip), retryAfterSec: rl.retryAfterSec })
    sendJson(res, 429, { error: 'too many rooms created from your network', retryAfterSec: rl.retryAfterSec }, { 'Retry-After': String(rl.retryAfterSec) })
    return
  }
  const room = createPreCreatedRoom(ttlMinutes, oneJoin)
  log('info', 'link_created', { roomId: room.id, ttlMinutes, oneJoin })
  sendJson(res, 200, {
    roomCode: room.id,
    pin: room.pin,
    expiresAt: room.expiresAt,
    expiresAtIso: new Date(room.expiresAt).toISOString(),
    oneJoin,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// v2.0 (3.2): GET /nearby?deviceId=&alias=&role=sender|receiver — LAN presence.
// ─────────────────────────────────────────────────────────────────────────────
function handleNearby(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const deviceId = (query.get('deviceId') ?? '').trim().slice(0, 128)
  if (!deviceId) {
    sendJson(res, 400, { error: 'deviceId required' })
    return
  }
  const role = (query.get('role') ?? '').trim()
  if (role !== 'sender' && role !== 'receiver') {
    sendJson(res, 400, { error: 'role must be "sender" or "receiver"' })
    return
  }
  const alias = sanitizeAlias(query.get('alias'))
  const subnet = subnetKey(clientIpOfRequest(req))
  const now = Date.now()

  // Refresh caller presence + drop stale rows (TTL 30s).
  for (const [id, entry] of nearbyPeers) {
    if (now - entry.seenAt > NEARBY_TTL_MS) nearbyPeers.delete(id)
  }
  nearbyPeers.set(deviceId, { deviceId, alias, role, subnet, seenAt: now })
  if (nearbyPeers.size > NEARBY_MAX_TRACKED) {
    const byAge = Array.from(nearbyPeers.entries()).sort((a, b) => a[1].seenAt - b[1].seenAt)
    for (let i = 0; i < byAge.length - Math.floor(NEARBY_MAX_TRACKED / 2); i++) nearbyPeers.delete(byAge[i][0])
  }

  // Same-subnet peers only, caller excluded, newest first, capped — and the
  // response carries NO IP/subnet information whatsoever.
  const peers = Array.from(nearbyPeers.values())
    .filter((e) => e.deviceId !== deviceId && e.subnet === subnet && now - e.seenAt <= NEARBY_TTL_MS)
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, NEARBY_MAX_PEERS)
    .map((e) => ({ deviceId: e.deviceId, alias: e.alias, role: e.role, seenAt: e.seenAt }))

  log('debug', 'nearby_seen', { peers: peers.length })
  sendJson(res, 200, { peers })
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!req.url) return
  // IMPORTANT: engine.io's polling handshake writes its response ASYNC (the
  // dispatcher returns before the transport flushes), so we can NOT rely on
  // res.headersSent to detect "socket.io handled this". Path ownership is
  // explicit: we only answer our HTTP endpoints; anything under the socket.io
  // path is left 100% alone.
  if (req.url.startsWith('/socket.io')) return
  let url: URL
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    sendJson(res, 400, { error: 'bad request' })
    return
  }
  const path = url.pathname
  const query = url.searchParams

  // Cross-origin preflight for the public HTTP API (share links are POSTed
  // cross-origin from the landing page / other origins).
  if (req.method === 'OPTIONS' && (path === '/link' || path === '/nearby' || path === '/region' || path === '/healthz' || path === '/turn-credentials')) {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  // v1.1 (3.1): TURN credential minting — behavior unchanged.
  if (path.startsWith('/turn-credentials')) {
    const { body, status } = turnCredentialsResponse()
    sendJson(res, status, body)
    return
  }

  // v2.0 (2.5): enriched health check.
  if (path.startsWith('/healthz')) {
    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      rooms: rooms.size,
      sockets: io.engine.clientsCount,
      region: REGION,
      version: VERSION,
      memUsageBytes: process.memoryUsage().rss,
    })
    return
  }

  // v2.0 (8.3): region probe — unauthenticated by design (latency probes).
  if (path === '/region') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
    let devices = 0
    for (const room of rooms.values()) devices += room.devices.size
    sendJson(res, 200, {
      region: REGION,
      version: VERSION,
      uptimeSec: Math.floor(process.uptime()),
      devices,
    })
    return
  }

  // v2.0 (3.4): share-link room pre-creation.
  if (path === '/link') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed — POST a JSON body' })
    handleLink(req, res).catch((err) => {
      log('error', 'http_error', { path, message: String((err as Error)?.message ?? err) })
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
    })
    return
  }

  // v2.0 (3.2): LAN discovery.
  if (path === '/nearby') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
    handleNearby(req, res, query)
    return
  }

  // v2.0 (8.2): admin dashboard (503 when ADMIN_TOKEN is unset).
  if (path === '/admin' || path.startsWith('/admin/')) {
    handleAdminRequest(req, res, path, query).catch((err) => {
      log('error', 'http_error', { path, message: String((err as Error)?.message ?? err) })
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
    })
    return
  }

  // Unknown path — socket.io's dispatcher already forwarded to its (empty)
  // cached listener list without responding, so 404 here is safe.
  sendJson(res, 404, { error: 'not found' })
}

// --- Server setup ---
// v1.1: scope socket.io to its default client path ('/socket.io' — the client
// uses the library default) so the HTTP endpoints below own every other path.
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6, // 1MB (signaling messages only — SDP, ICE)
})

// v1.1: register HTTP endpoints alongside socket.io. engine.io only claims
// '/socket.io*' requests; everything else falls through to these listeners.
httpServer.on('request', (req, res) => {
  try {
    handleHttpRequest(req, res)
  } catch (err) {
    log('error', 'http_error', { message: String((err as Error)?.message ?? err) })
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
  }
})

// Periodic cleanup
setInterval(() => expireStaleRooms(io), 60 * 1000)

// v2.0: housekeeping — prune expired LAN presence + aged rate-limit windows so
// the per-IP maps never grow unbounded. v5-a2: drop relay token buckets of
// rooms that no longer exist (the bucket map is otherwise bounded by the
// live-room count, but expired rooms never evict their entry).
setInterval(() => {
  const now = Date.now()
  for (const [ip, stamps] of roomCreatesByIp) {
    const recent = stamps.filter((t) => now - t < ROOM_CREATE_WINDOW_MS)
    if (recent.length) roomCreatesByIp.set(ip, recent)
    else roomCreatesByIp.delete(ip)
  }
  for (const [id, entry] of nearbyPeers) {
    if (now - entry.seenAt > NEARBY_TTL_MS) nearbyPeers.delete(id)
  }
  for (const roomId of relayBuckets.keys()) {
    if (!rooms.has(roomId)) relayBuckets.delete(roomId)
  }
}, 30 * 1000)

io.on('connection', (socket) => {
  log('debug', 'socket_connect', { socketId: socket.id })

  // === Room creation (sender starts here) ===
  // v2.0 (3.4): payload may carry { claim: { roomCode, pin } } to claim a room
  // pre-created via POST /link instead of minting a fresh one.
  socket.on('create-room', (payload: { alias: string; deviceId: string; role: 'sender' | 'receiver'; withPin?: boolean; claim?: { roomCode: string; pin: string } }) => {
    try {
      if (!payload?.alias || !payload?.deviceId) {
        socket.emit('signaling-error', { code: 'INVALID_INPUT', message: 'alias and deviceId required' })
        return
      }
      // v2.0 (2.5): per-IP sliding-window rate limit on room creation.
      const ip = clientIpOfSocket(socket)
      const rl = checkRoomCreateRate(ip)
      if (!rl.allowed) {
        log('warn', 'rate_limited', { source: 'socket', event: 'create-room', ipHash: hashIp(ip), retryAfterSec: rl.retryAfterSec })
        socket.emit('signaling-error', {
          code: 'RATE_LIMITED',
          message: `too many rooms created from your network — retry in ${rl.retryAfterSec}s`,
          retryAfterSec: rl.retryAfterSec,
        })
        return
      }

      // v2.0 (3.4): claim a pre-created share-link room.
      if (payload.claim && typeof payload.claim === 'object') {
        const code = String((payload.claim as { roomCode?: string }).roomCode ?? '').trim().toUpperCase()
        const pin = String((payload.claim as { pin?: string }).pin ?? '')
        const room = rooms.get(code)
        if (!room || room.preCreated !== true) {
          socket.emit('signaling-error', { code: 'ROOM_NOT_FOUND', message: 'share link not found or already claimed' })
          return
        }
        if (Date.now() > room.expiresAt) {
          closeRoom(io, room.id, 'link-expired')
          socket.emit('signaling-error', { code: 'ROOM_EXPIRED', message: 'share link has expired' })
          return
        }
        if (!room.pin || room.pin !== pin) {
          recordFailedPin(socket.id)
          socket.emit('signaling-error', { code: 'INVALID_PIN', message: 'incorrect PIN for this share link' })
          return
        }
        room.preCreated = false // the claiming socket now owns this room
        const device: Device = {
          id: payload.deviceId,
          socketId: socket.id,
          alias: payload.alias,
          role: payload.role,
          joinedAt: Date.now(),
        }
        room.devices.set(device.id, device)
        socket.join(room.id)
        socketToRoom.set(socket.id, room.id)
        socketToDevice.set(socket.id, device.id)
        touchRoom(room)
        // A receiver may have joined the pre-created room before the sender
        // claimed it — announce the sender to whoever is already inside.
        if (room.devices.size > 1) socket.to(room.id).emit('device-discovered', { device })
        if (room.oneJoin && room.devices.size >= 2) room.closedForJoins = true
        const qrData = `fluxdrop://room/${room.id}?pin=${room.pin ?? ''}`
        socket.emit('room-created', {
          roomId: room.id,
          joinCode: room.joinCode,
          pin: room.pin,
          qrData,
          device,
        })
        log('info', 'room_claimed', { roomId: room.id, devices: room.devices.size, oneJoin: room.oneJoin === true })
        return
      }

      const room = createRoom({
        withPin: payload.withPin,
        alias: payload.alias,
        deviceId: payload.deviceId,
        role: payload.role,
      })
      const device: Device = {
        id: payload.deviceId,
        socketId: socket.id,
        alias: payload.alias,
        role: payload.role,
        joinedAt: Date.now(),
      }
      room.devices.set(device.id, device)
      socket.join(room.id)
      socketToRoom.set(socket.id, room.id)
      socketToDevice.set(socket.id, device.id)

      const qrData = `fluxdrop://room/${room.id}?pin=${room.pin ?? ''}`
      socket.emit('room-created', {
        roomId: room.id,
        joinCode: room.joinCode,
        pin: room.pin,
        qrData,
        device,
      })
      log('info', 'room_created', { roomId: room.id, hasPin: room.pin !== undefined, devices: room.devices.size })
    } catch (err) {
      log('error', 'create_room_error', { message: String((err as Error)?.message ?? err) })
      socket.emit('signaling-error', { code: 'INTERNAL', message: 'failed to create room' })
    }
  })

  // === Join existing room (receiver) ===
  socket.on('join-room', (payload: { roomId: string; joinCode?: string; pin?: string; alias: string; deviceId: string; role: 'sender' | 'receiver' }) => {
    try {
      const room = rooms.get(payload?.roomId?.toUpperCase?.() ?? payload.roomId)
      if (!room) {
        socket.emit('signaling-error', { code: 'ROOM_NOT_FOUND', message: 'room does not exist or has expired' })
        return
      }
      if (room.devices.size >= MAX_DEVICES_PER_ROOM) {
        socket.emit('signaling-error', { code: 'ROOM_FULL', message: `room already has ${MAX_DEVICES_PER_ROOM} devices` })
        return
      }
      // v2.0 (3.4): one-join share links close after their first pairing.
      if (room.closedForJoins && !room.devices.has(payload.deviceId)) {
        socket.emit('signaling-error', { code: 'ROOM_CLOSED', message: 'room is closed for new joins (share link already used)' })
        return
      }
      // Rate limit check
      if (isRateLimited(socket.id)) {
        socket.emit('signaling-error', { code: 'RATE_LIMITED', message: 'Too many failed attempts. Try again in 1 minute.' })
        return
      }
      // PIN check
      if (room.pin) {
        if (payload.pin !== room.pin) {
          recordFailedPin(socket.id)
          socket.emit('signaling-error', { code: 'INVALID_PIN', message: 'incorrect PIN' })
          return
        }
      }
      const device: Device = {
        id: payload.deviceId,
        socketId: socket.id,
        alias: payload.alias,
        role: payload.role,
        joinedAt: Date.now(),
      }
      room.devices.set(device.id, device)
      socket.join(room.id)
      socketToRoom.set(socket.id, room.id)
      socketToDevice.set(socket.id, device.id)
      touchRoom(room)
      // v2.0 (3.4): a oneJoin room that reached sender + receiver is spent.
      if (room.oneJoin && room.devices.size >= 2) room.closedForJoins = true

      // Notify the joiner of existing devices (the sender)
      const others = Array.from(room.devices.values()).filter(d => d.id !== device.id)
      socket.emit('room-joined', {
        roomId: room.id,
        joinCode: room.joinCode,
        device,
        peers: others,
      })
      // Notify existing devices of the newcomer
      socket.to(room.id).emit('device-discovered', { device })
      log('info', 'room_joined', { roomId: room.id, devices: room.devices.size, max: MAX_DEVICES_PER_ROOM })
    } catch (err) {
      log('error', 'join_room_error', { message: String((err as Error)?.message ?? err) })
      socket.emit('signaling-error', { code: 'INTERNAL', message: 'failed to join room' })
    }
  })

  // === Rejoin after socket reconnection (v1.1) ===
  // A socket.io client gets a NEW socket.id on every (re)connect, and the
  // disconnect handler deletes its device from the room. Without this event
  // a transient signaling blip permanently orphaned an in-flight transfer:
  // offers/ICE relays silently failed verifyMembership. Rebinds a still-
  // registered device without a PIN (it was PIN-vetted at original join);
  // re-adds a cleaned-up device WITH a PIN (disconnect-cleanup race).
  socket.on('rejoin-room', (payload: { roomId: string; deviceId: string; alias?: string; role?: 'sender' | 'receiver'; pin?: string }) => {
    try {
      const room = rooms.get(payload?.roomId?.toUpperCase?.() ?? payload.roomId)
      if (!room) return // room gone — subsequent relays will error visibly
      const existing = room.devices.get(payload.deviceId)
      if (existing) {
        existing.socketId = socket.id
        if (payload.alias) existing.alias = payload.alias
        socket.join(room.id)
        socketToRoom.set(socket.id, room.id)
        socketToDevice.set(socket.id, payload.deviceId)
        touchRoom(room)
        log('info', 'device_rebound', { roomId: room.id, devices: room.devices.size })
      } else if (room.devices.size < MAX_DEVICES_PER_ROOM) {
        if (room.pin && payload.pin !== room.pin) {
          recordFailedPin(socket.id)
          socket.emit('signaling-error', { code: 'INVALID_PIN', message: 'incorrect PIN' })
          return
        }
        const device: Device = {
          id: payload.deviceId,
          socketId: socket.id,
          alias: payload.alias ?? 'device',
          role: payload.role ?? 'sender',
          joinedAt: Date.now(),
        }
        room.devices.set(device.id, device)
        socket.join(room.id)
        socketToRoom.set(socket.id, room.id)
        socketToDevice.set(socket.id, device.id)
        touchRoom(room)
        if (room.oneJoin && room.devices.size >= 2) room.closedForJoins = true
        socket.to(room.id).emit('device-discovered', { device })
        log('info', 'device_rejoined', { roomId: room.id, devices: room.devices.size })
      }
    } catch (err) {
      log('error', 'rejoin_room_error', { message: String((err as Error)?.message ?? err) })
    }
  })

  // === Pairing handshake (unicast per peer) ===
  socket.on('pairing-request', (payload: { roomId: string; from: string; to: string; transferSummary?: { fileCount: number; totalSize: number; totalName: string } }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return socket.emit('signaling-error', { code: 'NOT_MEMBER', message: 'not a room member' })
    const room = rooms.get(payload.roomId)
    if (!room) return socket.emit('signaling-error', { code: 'ROOM_NOT_FOUND', message: 'room gone' })
    touchRoom(room)
    room.state = 'pairing'
    relayToDevice(io, room, 'pairing-request', payload)
  })

  socket.on('pairing-confirm', (payload: { roomId: string; from: string; to: string; accepted: boolean }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    if (payload.accepted) room.state = 'connected'
    log('info', 'pairing_result', { roomId: room.id, accepted: payload.accepted === true })
    relayToDevice(io, room, 'pairing-confirm', payload)
  })

  socket.on('pairing-reject', (payload: { roomId: string; from: string; to: string; reason?: string }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    relayToDevice(io, room, 'pairing-reject', payload)
  })

  // === WebRTC signaling relay (offer / answer / ICE) — unicast per peer ===
  socket.on('webrtc-offer', (payload: { roomId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    relayToDevice(io, room, 'webrtc-offer', payload)
  })

  socket.on('webrtc-answer', (payload: { roomId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    relayToDevice(io, room, 'webrtc-answer', payload)
  })

  socket.on('webrtc-ice', (payload: { roomId: string; from: string; to: string; candidate: RTCIceCandidateInit }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    relayToDevice(io, room, 'webrtc-ice', payload)
  })

  // === Transfer lifecycle coordination (metadata only — no file data) ===
  socket.on('transfer-manifest', (payload: { roomId: string; from: string; to: string; manifest: any }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    room.transferActive = true
    room.state = 'transferring'
    // v5-a2 (best effort): remember the plaintext transferId so the chunk
    // relay can drop frames of a DIFFERENT session. Sealed (enc1.*) manifests
    // carry no readable id — relay then simply skips this check.
    const tid = (payload?.manifest as { transferId?: unknown } | null | undefined)?.transferId
    if (typeof tid === 'string' && tid) room.activeTransferId = tid
    log('info', 'transfer_started', { roomId: room.id, devices: room.devices.size })
    relayToDevice(io, room, 'transfer-manifest', payload)
  })

  socket.on('transfer-accepted', (payload: { roomId: string; from: string; to: string; accepted: boolean; reason?: string }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    relayToDevice(io, room, 'transfer-accepted', payload)
  })

  socket.on('transfer-complete', (payload: { roomId: string; from: string; to: string }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    room.transferActive = false
    room.state = 'connected'
    log('info', 'transfer_complete', { roomId: room.id })
    relayToDevice(io, room, 'transfer-complete', payload)
  })

  socket.on('transfer-cancel', (payload: { roomId: string; from: string; to: string; reason?: string }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    room.transferActive = false
    relayToDevice(io, room, 'transfer-cancel', payload)
  })

  // === Resume coordination (unicast) ===
  socket.on('resume-request', (payload: { roomId: string; from: string; to: string; transferId: string; lastChunkIndex: number }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    relayToDevice(io, room, 'resume-request', payload)
  })

  socket.on('resume-response', (payload: { roomId: string; from: string; to: string; transferId: string; accepted: boolean; fromChunkIndex?: number }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return
    const room = rooms.get(payload.roomId)
    if (!room) return
    relayToDevice(io, room, 'resume-response', payload)
  })

  // === v1.2: opaque E2E (PAKE) handshake relay (unicast) ===
  // The payload is a sealed SPAKE2 message (hello/reply/confirm/fail). The
  // server membership-checks the sender and forwards it to the room peer
  // WITHOUT looking inside — it cannot, and that's the point: the handshake
  // derives the payload-encryption key from the room PIN in a way that never
  // exposes key material to the relay.
  socket.on('e2e-relay', (payload: { roomId: string; from: string; to: string; data: unknown }) => {
    if (!verifyMembership(socket.id, payload.roomId)) return socket.emit('signaling-error', { code: 'NOT_MEMBER', message: 'not a room member' })
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    relayToDevice(io, room, 'e2e-relay', payload)
  })

  // === v5-a2: server-relayed fallback chunk transport (unicast) ===
  // LAST rung of the client recovery ladder — only used when P2P is
  // impossible. relay-data carries one chunk payload (base64 ciphertext);
  // relay-ack is the receiver's per-seq transport ack. `from` is NEVER
  // trusted: like every membership-checked relay, the sender is resolved
  // from the socket (socketToDevice) and overwritten before forwarding.
  // Both events are validated + rate-limited (see RELAY_* constants).
  socket.on('relay-data', (payload: { roomId: string; from: string; to: string; transferId: string; seq: number; chunkIndex: number; data: string; last?: boolean }) => {
    try {
      if (!payload || typeof payload !== 'object') return
      if (!verifyMembership(socket.id, payload.roomId)) {
        return socket.emit('signaling-error', { code: 'NOT_MEMBER', message: 'not a room member' })
      }
      const room = rooms.get(payload.roomId)
      if (!room) return
      // Resolve + overwrite the sender identity from the socket — a spoofed
      // `from` must never route another device's traffic.
      const fromDevice = socketToDevice.get(socket.id)
      if (!fromDevice || !room.devices.has(fromDevice)) return
      // Destination must be a connected member (relayToDevice double-checks).
      const to = typeof payload.to === 'string' ? payload.to : ''
      const dest = room.devices.get(to)
      if (!dest || !io.sockets.sockets.get(dest.socketId)) return
      // Shape guards.
      const data = typeof payload.data === 'string' ? payload.data : ''
      if (!data || data.length > RELAY_MAX_B64_CHARS) return
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return // must be base64
      const seq = Number(payload.seq)
      const chunkIndex = Number(payload.chunkIndex)
      if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunkIndex) || chunkIndex < 0) return
      const transferId = typeof payload.transferId === 'string' ? payload.transferId : ''
      if (!transferId) return
      // Best-effort same-session check (sealed manifests leave it unset).
      if (room.activeTransferId && transferId !== room.activeTransferId) {
        log('debug', 'relay_data_session_mismatch', { roomId: room.id })
        return
      }
      // Per-room token bucket — over quota: tell the SENDER, drop the frame.
      if (!relayQuotaAllows(room.id, data.length)) {
        socket.emit('relay-error', { roomId: room.id, reason: 'quota' })
        log('warn', 'relay_quota_exceeded', { roomId: room.id })
        return
      }
      touchRoom(room)
      room.relayedBytes += data.length
      relayToDevice(io, room, 'relay-data', {
        roomId: room.id,
        from: fromDevice,
        to,
        transferId,
        seq,
        chunkIndex,
        data,
        ...(payload.last === true ? { last: true } : {}),
      })
    } catch (err) {
      log('error', 'relay_data_error', { message: String((err as Error)?.message ?? err) })
    }
  })

  socket.on('relay-ack', (payload: { roomId: string; from: string; to: string; transferId: string; seq: number }) => {
    try {
      if (!payload || typeof payload !== 'object') return
      if (!verifyMembership(socket.id, payload.roomId)) return
      const room = rooms.get(payload.roomId)
      if (!room) return
      const fromDevice = socketToDevice.get(socket.id)
      if (!fromDevice || !room.devices.has(fromDevice)) return
      const to = typeof payload.to === 'string' ? payload.to : ''
      const seq = Number(payload.seq)
      const transferId = typeof payload.transferId === 'string' ? payload.transferId : ''
      if (!to || !transferId || !Number.isInteger(seq) || seq < 0) return
      // Tiny control frame — no quota, no room byte counter.
      relayToDevice(io, room, 'relay-ack', { roomId: room.id, from: fromDevice, to, transferId, seq })
    } catch (err) {
      log('error', 'relay_ack_error', { message: String((err as Error)?.message ?? err) })
    }
  })

  // === Heartbeat / activity ping ===
  socket.on('heartbeat', (payload: { roomId: string }) => {
    const room = rooms.get(payload.roomId)
    if (room) touchRoom(room)
  })

  // === Disconnect cleanup ===
  socket.on('leave-room', () => {
    handleDisconnect(socket)
  })

  socket.on('disconnect', () => {
    handleDisconnect(socket)
  })

  socket.on('error', (err) => {
    log('error', 'socket_error', { socketId: socket.id, message: String((err as Error)?.message ?? err) })
  })
})

function handleDisconnect(socket: any) {
  const roomId = socketToRoom.get(socket.id)
  const deviceId = socketToDevice.get(socket.id)
  log('debug', 'socket_disconnect', { socketId: socket.id })
  if (!roomId) return
  const room = rooms.get(roomId)
  if (room && deviceId) {
    room.devices.delete(deviceId)
    socket.to(roomId).emit('device-left', { deviceId })
    log('info', 'device_left', { roomId, devices: room.devices.size })
    if (room.devices.size === 0) {
      rooms.delete(roomId)
      log('info', 'room_closed', { roomId, reason: 'empty' })
    }
  }
  socketToRoom.delete(socket.id)
  socketToDevice.delete(socket.id)
  pinAttempts.delete(socket.id) // Clean up rate limiting state
}

httpServer.listen(PORT, () => {
  log('info', 'server_started', {
    port: PORT,
    version: VERSION,
    region: REGION,
    maxDevicesPerRoom: MAX_DEVICES_PER_ROOM,
    roomCreateRatePerMin: ROOM_CREATE_RATE_PER_MIN,
    adminEnabled: ADMIN_TOKEN !== '',
    turnEnabled: TURN_URL !== '' && TURN_SECRET !== '',
  })
})

process.on('SIGTERM', () => {
  log('info', 'shutdown', { signal: 'SIGTERM' })
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  log('info', 'shutdown', { signal: 'SIGINT' })
  httpServer.close(() => process.exit(0))
})
