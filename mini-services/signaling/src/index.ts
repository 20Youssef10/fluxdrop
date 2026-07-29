// FluxDrop signaling server — room lifecycle, pairing, ICE relay, discovery.
// Stateless after session establishment: never touches file data.

import { createServer } from 'http'
import { Server } from 'socket.io'

const PORT = 3003
const ROOM_TTL_MS = 5 * 60 * 1000          // 5 min pre-pairing
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000    // 30 min post-transfer idle
const MAX_DEVICES_PER_ROOM = 2
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

// --- Utilities ---
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars
function randomCode(len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}
function generateRoomId(): string {
  let id: string
  do { id = randomCode(ROOM_ID_LENGTH) } while (rooms.has(id))
  return id
}
function generatePin(): string {
  let pin = ''
  for (let i = 0; i < PIN_LENGTH; i++) pin += Math.floor(Math.random() * 10).toString()
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
const httpServer = createServer()
const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6, // 1MB (signaling messages only — SDP, ICE)
})

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
        socket.emit('signaling-error', { code: 'ROOM_FULL', message: 'room already has 2 devices' })
        return
      }
      // PIN check
      if (room.pin) {
        if (payload.pin !== room.pin) {
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
      console.log(`[signaling] ${device.alias} joined room ${room.id} (${room.devices.size}/2)`)
    } catch (err) {
      console.error('[signaling] join-room error', err)
      socket.emit('signaling-error', { code: 'INTERNAL', message: 'failed to join room' })
    }
  })

  // === Pairing handshake ===
  socket.on('pairing-request', (payload: { roomId: string; from: string; to: string; transferSummary?: { fileCount: number; totalSize: number; totalName: string } }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return socket.emit('signaling-error', { code: 'ROOM_NOT_FOUND', message: 'room gone' })
    touchRoom(room)
    room.state = 'pairing'
    socket.to(room.id).emit('pairing-request', payload)
  })

  socket.on('pairing-confirm', (payload: { roomId: string; from: string; to: string; accepted: boolean }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    if (payload.accepted) room.state = 'connected'
    socket.to(room.id).emit('pairing-confirm', payload)
  })

  socket.on('pairing-reject', (payload: { roomId: string; from: string; to: string; reason?: string }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    socket.to(room.id).emit('pairing-reject', payload)
  })

  // === WebRTC signaling relay (offer / answer / ICE) ===
  socket.on('webrtc-offer', (payload: { roomId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    socket.to(room.id).emit('webrtc-offer', payload)
  })

  socket.on('webrtc-answer', (payload: { roomId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    socket.to(room.id).emit('webrtc-answer', payload)
  })

  socket.on('webrtc-ice', (payload: { roomId: string; from: string; to: string; candidate: RTCIceCandidateInit }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    socket.to(room.id).emit('webrtc-ice', payload)
  })

  // === Transfer lifecycle coordination (metadata only — no file data) ===
  socket.on('transfer-manifest', (payload: { roomId: string; from: string; to: string; manifest: any }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    room.transferActive = true
    room.state = 'transferring'
    socket.to(room.id).emit('transfer-manifest', payload)
  })

  socket.on('transfer-accepted', (payload: { roomId: string; from: string; to: string; accepted: boolean; reason?: string }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    socket.to(room.id).emit('transfer-accepted', payload)
  })

  socket.on('transfer-complete', (payload: { roomId: string; from: string; to: string }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    touchRoom(room)
    room.transferActive = false
    room.state = 'connected'
    socket.to(room.id).emit('transfer-complete', payload)
  })

  socket.on('transfer-cancel', (payload: { roomId: string; from: string; to: string; reason?: string }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    room.transferActive = false
    socket.to(room.id).emit('transfer-cancel', payload)
  })

  // === Resume coordination ===
  socket.on('resume-request', (payload: { roomId: string; from: string; to: string; transferId: string; lastChunkIndex: number }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    socket.to(room.id).emit('resume-request', payload)
  })

  socket.on('resume-response', (payload: { roomId: string; from: string; to: string; transferId: string; accepted: boolean; fromChunkIndex?: number }) => {
    const room = rooms.get(payload.roomId)
    if (!room) return
    socket.to(room.id).emit('resume-response', payload)
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
}

httpServer.listen(PORT, () => {
  console.log(`[FluxDrop signaling] listening on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[signaling] SIGTERM, shutting down...')
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  console.log('[signaling] SIGINT, shutting down...')
  httpServer.close(() => process.exit(0))
})
