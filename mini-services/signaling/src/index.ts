// FluxDrop signaling server — room lifecycle, pairing, ICE relay, discovery.
// Stateless after session establishment: never touches file data.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHmac } from 'crypto'
import { Server } from 'socket.io'

const PORT = 3003

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

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!req.url) return
  // IMPORTANT: engine.io's polling handshake writes its response ASYNC (the
  // dispatcher returns before the transport flushes), so we can NOT rely on
  // res.headersSent to detect "socket.io handled this". Path ownership is
  // explicit: we only answer /turn-credentials and /healthz; anything under
  // the socket.io path is left 100% alone.
  if (req.url.startsWith('/socket.io')) return
  if (req.url.startsWith('/turn-credentials')) {
    const { body, status } = turnCredentialsResponse()
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(body))
    return
  }
  if (req.url.startsWith('/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptimeSec: Math.floor(process.uptime()) }))
    return
  }
  // Unknown path — socket.io's dispatcher already forwarded to its (empty)
  // cached listener list without responding, so 404 here is safe.
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
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
}

const rooms = new Map<string, Room>()
const socketToRoom = new Map<string, string>()   // socketId -> roomId
const socketToDevice = new Map<string, string>() // socketId -> deviceId

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
      io.to(id).emit('room-expired', { roomId: id, reason: stale ? 'timeout' : 'idle' })
      closeRoom(io, id)
    }
  }
}

function closeRoom(io: Server, roomId: string) {
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
}

function touchRoom(room: Room) {
  room.lastActivityAt = Date.now()
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
httpServer.on('request', handleHttpRequest)

// Periodic cleanup
setInterval(() => expireStaleRooms(io), 60 * 1000)

io.on('connection', (socket) => {
  console.log(`[signaling] connect ${socket.id}`)

  // === Room creation (sender starts here) ===
  socket.on('create-room', (payload: { alias: string; deviceId: string; role: 'sender' | 'receiver'; withPin?: boolean }) => {
    try {
      if (!payload?.alias || !payload?.deviceId) {
        socket.emit('signaling-error', { code: 'INVALID_INPUT', message: 'alias and deviceId required' })
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
      console.log(`[signaling] room ${room.id} created by ${device.alias} (pin=${room.pin ?? 'none'})`)
    } catch (err) {
      console.error('[signaling] create-room error', err)
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
      console.log(`[signaling] ${device.alias} joined room ${room.id} (${room.devices.size}/${MAX_DEVICES_PER_ROOM})`)
    } catch (err) {
      console.error('[signaling] join-room error', err)
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
        console.log(`[signaling] ${existing.alias} rebound to room ${room.id} (reconnect)`)
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
        socket.to(room.id).emit('device-discovered', { device })
        console.log(`[signaling] ${device.alias} rejoined room ${room.id} (post-disconnect)`)
      }
    } catch (err) {
      console.error('[signaling] rejoin-room error', err)
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
    console.error(`[signaling] socket error ${socket.id}:`, err)
  })
})

function handleDisconnect(socket: any) {
  const roomId = socketToRoom.get(socket.id)
  const deviceId = socketToDevice.get(socket.id)
  if (!roomId) return
  const room = rooms.get(roomId)
  if (room && deviceId) {
    room.devices.delete(deviceId)
    socket.to(roomId).emit('device-left', { deviceId })
    console.log(`[signaling] device ${deviceId} left room ${roomId} (${room.devices.size} remaining)`)
    if (room.devices.size === 0) {
      rooms.delete(roomId)
      console.log(`[signaling] room ${roomId} closed (empty)`)
    }
  }
  socketToRoom.delete(socket.id)
  socketToDevice.delete(socket.id)
  pinAttempts.delete(socket.id) // Clean up rate limiting state
}

httpServer.listen(PORT, () => {
  console.log(`[FluxDrop signaling] listening on port ${PORT} (max ${MAX_DEVICES_PER_ROOM} devices/room)`)
})

process.on('SIGTERM', () => {
  console.log('[signaling] SIGTERM, shutting down...')
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  console.log('[signaling] SIGINT, shutting down...')
  httpServer.close(() => process.exit(0))
})
