// FluxDrop signaling — Cloudflare Worker + Durable Object (v5-E15).
//
// A serverless adapter that speaks the SAME socket.io wire contract as the
// Bun server (mini-services/signaling/src/index.ts): the web client, CLI and
// SDK connect with stock socket.io-client and nothing changes. The transport
// is engine.io v4 OVER WEBSOCKET ONLY (socket.io-client with
// transports: ['websocket', 'polling'] tries websocket first — that is this).
//
// What's implemented vs the Bun server (deltas documented in README.md):
//   ✅ rooms (create/join/rejoin/PIN/oneJoin/cap), pairing + WebRTC relay,
//      transfer lifecycle, e2e-relay, chunk relay-data/ack with per-room
//      token bucket + lifetime cap, heartbeat, room-expired/closed sweeps
//   ✅ /healthz, /region, /link (share links), /turn-credentials (disabled
//      unless env TURN_* is set)
//   ✅ /admin/api (JSON snapshot; ADMIN_TOKEN secret) — no HTML dashboard
//   ❌ /nearby LAN discovery, federation, webhooks, leaderboard (Bun-only)

import { DurableObject } from 'cloudflare:workers'

export interface Env {
  HUB: DurableObjectNamespace
  RELAY_RATE_BYTES_PER_SEC?: string
  RELAY_BURST_BYTES?: string
  RELAY_MAX_ROOM_BYTES?: string
  ADMIN_TOKEN?: string
  TURN_URL?: string
  TURN_SECRET?: string
}

const VERSION = '1.0.0-worker'
const REGION = 'edge'

// ─────────────────────────────────────────────────────────────────────────────
// Worker entry — plain HTTP endpoints + /socket.io WebSocket upgrades.
// ─────────────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  })
}

const worker = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // engine.io handshake lives on /socket.io — everything about the WS
    // upgrade is handled by the DO.
    if (path === '/socket.io' || path.startsWith('/socket.io/')) {
      const stub = env.HUB.get(env.HUB.idFromName('global'))
      return stub.fetch(req)
    }

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (path === '/healthz') {
      return json({ ok: true, region: REGION, version: VERSION, uptimeSec: 0 })
    }
    if (path === '/region') {
      return json({ region: REGION, version: VERSION, uptimeSec: 0, devices: 0 })
    }
    if (path === '/turn-credentials') {
      if (env.TURN_URL && env.TURN_SECRET) {
        const expiry = Math.floor(Date.now() / 1000) + 600
        const username = `${expiry}:fluxdrop`
        // HMAC-SHA1 via WebCrypto.
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
        const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username))
        const credential = btoa(String.fromCharCode(...new Uint8Array(sig)))
        return json({ enabled: true, ttlSeconds: 600, realm: 'fluxdrop', iceServers: [{ urls: [env.TURN_URL], username, credential }] })
      }
      return json({ enabled: false, reason: 'TURN not configured on this worker' })
    }
    if (path === '/link' && req.method === 'POST') {
      const stub = env.HUB.get(env.HUB.idFromName('global'))
      return stub.fetch(new Request('https://do/link', { method: 'POST', body: await req.text(), headers: req.headers }))
    }
    if (path === '/admin/api') {
      const token = url.searchParams.get('token') ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: 'invalid or missing token' }, env.ADMIN_TOKEN ? 401 : 503)
      const stub = env.HUB.get(env.HUB.idFromName('global'))
      return stub.fetch(new Request('https://do/admin/api'))
    }
    return json({ error: 'not found' }, 404)
  },
}

export default worker

// ─────────────────────────────────────────────────────────────────────────────
// engine.io v4 packet helpers (WebSocket framing).
// Each engine.io packet is one WS text message; socket.io packets ride the
// MESSAGE type ("4"). No binary attachments — FluxDrop signaling is JSON.
// ─────────────────────────────────────────────────────────────────────────────

type EioPacket = string

function eioOpen(sid: string): EioPacket {
  return `0${JSON.stringify({ sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`
}
function eioNsConnect(sid: string): EioPacket {
  return `40${JSON.stringify({ sid })}`
}
function sio(event: string, payload: unknown): EioPacket {
  return `42${JSON.stringify([event, payload])}`
}
function eioPing(): EioPacket {
  return '2'
}

/** Parse a client WS text frame → { kind, event?, payload? } | null. */
function parseClientFrame(raw: string): { kind: 'open-ns' | 'ping' | 'pong' | 'event' | 'close-ns'; event?: string; payload?: any } | null {
  const type = raw.charCodeAt(0) - 48 // '0'..'9'
  const rest = raw.slice(1)
  if (type === 4) {
    const sub = rest.charCodeAt(0) - 48
    if (sub === 0) return { kind: 'open-ns' }
    if (sub === 1) return { kind: 'close-ns' }
    if (sub === 2) {
      try {
        const arr = JSON.parse(rest.slice(1)) as [string, unknown]
        if (Array.isArray(arr) && typeof arr[0] === 'string') return { kind: 'event', event: arr[0], payload: arr[1] ?? {} }
      } catch { /* ignore */ }
      return null
    }
    return null
  }
  if (type === 2) return { kind: 'ping' }
  if (type === 3) return { kind: 'pong' }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Room model (mirrors the Bun server; persisted in DO storage so the hub
// survives eviction — the WS hibernation API keeps sockets alive for free).
// ─────────────────────────────────────────────────────────────────────────────

interface WsAttachment {
  sid: string
  roomId?: string
  deviceId?: string
}

interface Device {
  id: string
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
  devices: Map<string, Device>
  transferActive: boolean
  state: 'waiting' | 'pairing' | 'connected' | 'transferring' | 'closed'
  relayedBytes: number
  activeTransferId?: string
  preCreated?: boolean
  oneJoin?: boolean
  closedForJoins?: boolean
  /** Token-bucket relay quota (per-room; per-IP is approximated by the home
   * client's own server — see README deltas). */
  bucket: { tokens: number; last: number }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_DEVICES_PER_ROOM = 8
const ROOM_TTL_MS = 5 * 60_000
const ROOM_IDLE_TTL_MS = 30 * 60_000

function randomCode(len: number): string {
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length]
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The hub Durable Object.
// ─────────────────────────────────────────────────────────────────────────────

export class FluxDropHub extends DurableObject<Env> {
  private rooms = new Map<string, Room>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null

  private relayRate(): number {
    return Number(this.env.RELAY_RATE_BYTES_PER_SEC) || 4 * 1024 * 1024
  }
  private relayBurst(): number {
    return Number(this.env.RELAY_BURST_BYTES) || 8 * 1024 * 1024
  }
  private relayMaxRoom(): number {
    return Number(this.env.RELAY_MAX_ROOM_BYTES) || 512 * 1024 * 1024
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Rehydrate persisted rooms (storage keeps us eviction-proof).
    void this.loadRooms()
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweep(), 60_000)
      this.pingTimer = setInterval(() => this.pingAll(), 25_000)
    }
  }

  private async loadRooms(): Promise<void> {
    try {
      const raw = await this.ctx.storage.get<string>('rooms-v1')
      if (!raw) return
      const arr = JSON.parse(raw) as Array<Omit<Room, 'devices' | 'bucket'> & { devices: Device[] }>
      const now = Date.now()
      for (const r of arr) {
        if (r.expiresAt < now) continue
        this.rooms.set(r.id, {
          ...r,
          devices: new Map(r.devices.map((d) => [d.id, d])),
          bucket: { tokens: this.relayBurst(), last: now },
        })
      }
    } catch { /* ignore */ }
  }

  private async persistRooms(): Promise<void> {
    try {
      const arr = Array.from(this.rooms.values()).map((r) => ({
        ...r,
        devices: Array.from(r.devices.values()),
        bucket: undefined,
      }))
      await this.ctx.storage.put('rooms-v1', JSON.stringify(arr))
    } catch { /* best-effort */ }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    // engine.io appends '/' + query to the path — accept both forms.
    if (url.pathname === '/socket.io' || url.pathname === '/socket.io/') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'websocket required — engine.io polling is not supported by this adapter' }, 426)
      }
      const pair = new WebSocketPair()
      const server = pair[1]
      this.ctx.acceptWebSocket(server)
      const sid = crypto.randomUUID()
      server.serializeAttachment({ sid } as WsAttachment)
      server.send(eioOpen(sid))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (url.pathname === '/link' && req.method === 'POST') {
      let body: Record<string, unknown> = {}
      try { body = await req.json() as Record<string, unknown> } catch { /* ignore */ }
      const ttlMinutes = Number(body.ttlMinutes ?? 60)
      if (![5, 60, 1440].includes(ttlMinutes)) return json({ error: 'ttlMinutes must be one of 5, 60, 1440' }, 400)
      const oneJoin = body.oneJoin === true
      const now = Date.now()
      const room: Room = {
        id: randomCode(6),
        joinCode: randomCode(6),
        pin: String(Math.floor(100000 + Math.random() * 900000)),
        createdAt: now,
        expiresAt: now + ttlMinutes * 60_000,
        lastActivityAt: now,
        devices: new Map(),
        transferActive: false,
        state: 'waiting',
        relayedBytes: 0,
        preCreated: true,
        oneJoin,
        bucket: { tokens: this.relayBurst(), last: now },
      }
      this.rooms.set(room.id, room)
      void this.persistRooms()
      return json({
        roomCode: room.id,
        pin: room.pin,
        expiresAt: room.expiresAt,
        expiresAtIso: new Date(room.expiresAt).toISOString(),
        oneJoin,
      })
    }
    if (url.pathname === '/admin/api') {
      let devices = 0
      for (const r of this.rooms.values()) devices += r.devices.size
      return json({
        ok: true,
        version: VERSION,
        region: REGION,
        rooms: Array.from(this.rooms.values()).map((r) => ({
          code: r.id,
          deviceCount: r.devices.size,
          state: r.state,
          transferActive: r.transferActive,
          relayedBytes: r.relayedBytes,
          pending: r.preCreated === true,
          oneJoin: r.oneJoin === true,
        })),
        sockets: this.ctx.getWebSockets().length,
        devices,
        relay: {
          rateBytesPerSec: this.relayRate(),
          burstBytes: this.relayBurst(),
          maxRoomBytes: this.relayMaxRoom(),
        },
      })
    }
    return json({ error: 'not found' }, 404)
  }

  // ── WebSocket hibernation handlers ──

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return // binary never occurs in our contract
    const frame = parseClientFrame(message)
    if (!frame) return
    const att = (ws.deserializeAttachment() ?? {}) as WsAttachment
    switch (frame.kind) {
      case 'open-ns':
        ws.send(eioNsConnect(att.sid))
        return
      case 'ping':
        ws.send('3') // client pings only in v3; v4 server pings — answer anyway
        return
      case 'pong':
        return // heartbeat — hibernation keeps us alive without bookkeeping
      case 'close-ns':
        return
      case 'event':
        void this.onSocketEvent(ws, att, frame.event!, frame.payload)
        return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.leaveSocket(ws, 'disconnect')
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close() } catch { /* ignore */ }
    this.leaveSocket(ws, 'error')
  }

  private pingAll(): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(eioPing())
      } catch { /* ignore */ }
    }
  }

  // ── Socket event dispatch (the Bun server's handler set) ──

  private async onSocketEvent(ws: WebSocket, att: WsAttachment, event: string, p: any): Promise<void> {
    const emit = (ev: string, payload: unknown) => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(sio(ev, payload)) } catch { /* ignore */ }
    }
    const err = (code: string, message: string) => emit('signaling-error', { code, message })

    switch (event) {
      case 'create-room': {
        if (!p?.alias || !p?.deviceId) return err('INVALID_INPUT', 'alias and deviceId required')
        let room: Room
        if (p.claim && typeof p.claim === 'object') {
          const code = String(p.claim.roomCode ?? '').toUpperCase()
          const pin = String(p.claim.pin ?? '')
          const claimed = this.rooms.get(code)
          if (!claimed || claimed.preCreated !== true) return err('ROOM_NOT_FOUND', 'share link not found or already claimed')
          if (Date.now() > claimed.expiresAt) {
            this.closeRoom(claimed.id, 'link-expired')
            return err('ROOM_EXPIRED', 'share link has expired')
          }
          if (!claimed.pin || claimed.pin !== pin) return err('INVALID_PIN', 'incorrect PIN for this share link')
          claimed.preCreated = false
          room = claimed
        } else {
          const now = Date.now()
          room = {
            id: randomCode(6),
            joinCode: randomCode(6),
            pin: p.withPin ? String(Math.floor(100000 + Math.random() * 900000)) : undefined,
            createdAt: now,
            expiresAt: now + ROOM_TTL_MS,
            lastActivityAt: now,
            devices: new Map(),
            transferActive: false,
            state: 'waiting',
            relayedBytes: 0,
            bucket: { tokens: this.relayBurst(), last: now },
          }
          this.rooms.set(room.id, room)
        }
        const device: Device = { id: p.deviceId, alias: p.alias, role: p.role === 'receiver' ? 'receiver' : 'sender', joinedAt: Date.now() }
        room.devices.set(device.id, device)
        att.roomId = room.id
        att.deviceId = device.id
        ws.serializeAttachment(att)
        if (room.devices.size > 1) this.broadcast(room, 'device-discovered', { device }, device.id)
        if (room.oneJoin && room.devices.size >= 2) room.closedForJoins = true
        emit('room-created', {
          roomId: room.id,
          joinCode: room.joinCode,
          pin: room.pin,
          qrData: `fluxdrop://room/${room.id}?pin=${room.pin ?? ''}`,
          device,
        })
        void this.persistRooms()
        return
      }
      case 'join-room': {
        const room = this.rooms.get(String(p?.roomId ?? '').toUpperCase())
        if (!room) return err('ROOM_NOT_FOUND', 'room does not exist or has expired')
        if (room.devices.size >= MAX_DEVICES_PER_ROOM) return err('ROOM_FULL', `room already has ${MAX_DEVICES_PER_ROOM} devices`)
        if (room.closedForJoins && !room.devices.has(p.deviceId)) return err('ROOM_CLOSED', 'room is closed for new joins')
        if (room.pin && p.pin !== room.pin) return err('INVALID_PIN', 'incorrect PIN')
        const device: Device = { id: p.deviceId, alias: p.alias ?? 'device', role: p.role === 'receiver' ? 'receiver' : 'sender', joinedAt: Date.now() }
        room.devices.set(device.id, device)
        room.lastActivityAt = Date.now()
        att.roomId = room.id
        att.deviceId = device.id
        ws.serializeAttachment(att)
        if (room.oneJoin && room.devices.size >= 2) room.closedForJoins = true
        const others = Array.from(room.devices.values()).filter((d) => d.id !== device.id)
        emit('room-joined', { roomId: room.id, joinCode: room.joinCode, device, peers: others })
        this.broadcast(room, 'device-discovered', { device }, device.id)
        return
      }
      case 'rejoin-room': {
        const room = this.rooms.get(String(p?.roomId ?? '').toUpperCase())
        if (!room) return
        const existing = room.devices.get(p.deviceId)
        if (existing) {
          att.roomId = room.id
          att.deviceId = p.deviceId
          ws.serializeAttachment(att)
          room.lastActivityAt = Date.now()
          return
        }
        if (room.devices.size < MAX_DEVICES_PER_ROOM) {
          if (room.pin && p.pin !== room.pin) return err('INVALID_PIN', 'incorrect PIN')
          const device: Device = { id: p.deviceId, alias: p.alias ?? 'device', role: p.role ?? 'sender', joinedAt: Date.now() }
          room.devices.set(device.id, device)
          att.roomId = room.id
          att.deviceId = device.id
          ws.serializeAttachment(att)
          this.broadcast(room, 'device-discovered', { device }, device.id)
        }
        return
      }
      case 'pairing-request':
      case 'pairing-confirm':
      case 'pairing-reject':
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice':
      case 'transfer-accepted':
      case 'resume-request':
      case 'resume-response':
      case 'e2e-relay':
      case 'transfer-cancel': {
        const room = this.memberRoom(att)
        if (!room) return err('NOT_MEMBER', 'not a room member')
        room.lastActivityAt = Date.now()
        if (event === 'pairing-request') room.state = 'pairing'
        if (event === 'pairing-confirm' && p?.accepted === true) room.state = 'connected'
        this.relay(room, event, { ...p, from: att.deviceId })
        return
      }
      case 'transfer-manifest': {
        const room = this.memberRoom(att)
        if (!room) return err('NOT_MEMBER', 'not a room member')
        room.lastActivityAt = Date.now()
        room.transferActive = true
        room.state = 'transferring'
        const tid = p?.manifest?.transferId
        if (typeof tid === 'string' && tid) room.activeTransferId = tid
        this.relay(room, 'transfer-manifest', { ...p, from: att.deviceId })
        return
      }
      case 'transfer-complete': {
        const room = this.memberRoom(att)
        if (!room) return
        room.transferActive = false
        room.state = 'connected'
        room.lastActivityAt = Date.now()
        this.relay(room, 'transfer-complete', { ...p, from: att.deviceId })
        return
      }
      case 'relay-data': {
        const room = this.memberRoom(att)
        if (!room) return err('NOT_MEMBER', 'not a room member')
        const data = typeof p?.data === 'string' ? p.data : ''
        if (!data || data.length > 172 * 1024) return
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return
        const seq = Number(p.seq)
        const chunkIndex = Number(p.chunkIndex)
        if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunkIndex) || chunkIndex < 0) return
        if (!p.transferId) return
        if (room.activeTransferId && p.transferId !== room.activeTransferId) return
        if (room.relayedBytes + data.length > this.relayMaxRoom()) {
          emit('relay-error', { roomId: room.id, reason: 'room-cap' })
          return
        }
        // Token bucket.
        const now = Date.now()
        const b = room.bucket
        b.tokens = Math.min(this.relayBurst(), b.tokens + ((now - b.last) / 1000) * this.relayRate())
        b.last = now
        if (b.tokens < data.length) {
          emit('relay-error', { roomId: room.id, reason: 'quota' })
          return
        }
        b.tokens -= data.length
        room.relayedBytes += data.length
        room.lastActivityAt = now
        this.relay(room, 'relay-data', { ...p, from: att.deviceId })
        return
      }
      case 'relay-ack': {
        const room = this.memberRoom(att)
        if (!room) return
        this.relay(room, 'relay-ack', { ...p, from: att.deviceId })
        return
      }
      case 'heartbeat': {
        const room = this.rooms.get(String(p?.roomId ?? '').toUpperCase())
        if (room) room.lastActivityAt = Date.now()
        return
      }
      case 'leave-room': {
        this.leaveSocket(ws, 'leave')
        return
      }
      default:
        return
    }
  }

  /** Room for a socket's attachment — membership-checked like the Bun server. */
  private memberRoom(att: WsAttachment): Room | null {
    if (!att.roomId || !att.deviceId) return null
    const room = this.rooms.get(att.roomId)
    if (!room || !room.devices.has(att.deviceId)) return null
    return room
  }

  /** Unicast to the addressed device's socket (attachment-keyed lookup). */
  private relay(room: Room, event: string, payload: { to?: string } & Record<string, unknown>): void {
    const to = typeof payload?.to === 'string' ? payload.to : ''
    if (!to || !room.devices.has(to)) return
    for (const ws of this.ctx.getWebSockets()) {
      const att = (ws.deserializeAttachment() ?? {}) as WsAttachment
      if (att.roomId === room.id && att.deviceId === to) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(sio(event, { ...payload, roomId: room.id })) } catch { /* ignore */ }
        return
      }
    }
  }

  /** Broadcast to every member except one device. */
  private broadcast(room: Room, event: string, payload: Record<string, unknown>, exceptDeviceId?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = (ws.deserializeAttachment() ?? {}) as WsAttachment
      if (att.roomId !== room.id) continue
      if (exceptDeviceId && att.deviceId === exceptDeviceId) continue
      try { if (ws.readyState === WebSocket.OPEN) ws.send(sio(event, payload)) } catch { /* ignore */ }
    }
  }

  private leaveSocket(ws: WebSocket, reason: string): void {
    const att = (ws.deserializeAttachment() ?? {}) as WsAttachment
    if (!att.roomId || !att.deviceId) return
    const room = this.rooms.get(att.roomId)
    if (room) {
      room.devices.delete(att.deviceId)
      this.broadcast(room, 'device-left', { deviceId: att.deviceId })
      if (room.devices.size === 0) {
        this.rooms.delete(room.id)
        void this.persistRooms()
      }
    }
    void reason
  }

  private closeRoom(roomId: string, reason: string): void {
    const room = this.rooms.get(roomId)
    if (!room) return
    this.broadcast(room, 'room-closed', { roomId })
    this.rooms.delete(roomId)
    void this.persistRooms()
    void reason
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    let dirty = false
    for (const [id, room] of this.rooms) {
      const stale = room.state === 'waiting' && now > room.expiresAt
      const idle = (room.state === 'connected' || room.state === 'transferring') && now - room.lastActivityAt > ROOM_IDLE_TTL_MS
      if (stale || idle) {
        this.broadcast(room, 'room-expired', { roomId: id, reason: stale ? 'timeout' : 'idle' })
        this.broadcast(room, 'room-closed', { roomId: id })
        this.rooms.delete(id)
        dirty = true
      }
    }
    if (dirty) await this.persistRooms()
  }
}
