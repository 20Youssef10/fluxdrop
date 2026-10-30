// v5-e17: Federated signaling — server-to-server room peering.
//
// Rooms live on the server that CREATED them; a client can join a remote
// room by addressing it `ROOM@peer` (e.g. `A7B2C1@berlin`). Its home server
// tunnels the join (and every subsequent room frame) to the room owner over
// an authenticated server-to-server link; the OWNER keeps running all room
// logic (PIN checks, capacity, pairing, relay quotas). To the owner, the
// remote client is just another device with a `fedVia` marker; to the home
// server, the room is a tunnel target. The two browsers still connect
// WebRTC DIRECTLY to each other — only signaling crosses the link.
//
// Links are mutual: each server dials every configured peer (socket.io
// namespace `/federation`, websocket transport). Auth is a shared per-pair
// secret: token = HMAC-SHA256(secret, `${selfId}.${ts}`) with a ±60 s window.
//
// Wire (namespace events, server↔server):
//   fed-join     {room, device{id,alias,role}, pin?}      home → owner
//   fed-joined   {room, joinCode, device, peers}           owner → home
//   fed-leave    {room, deviceId}                          home → owner
//   fed-frame    {room, to, event, payload}                both directions*
//   fed-broadcast{room, event, payload}                    owner → home
//   fed-close    {room, reason}                            owner → home
//   fed-error    {room, code, message}                     owner → home
//   fed-ping     {t} / fed-pong {t}                        both, 10 s cadence
//
// * fed-frame always addresses a device ON THE RECEIVING SERVER; the sending
//   side pins `from` to the device identity it registered/verified.

import { createHmac, timingSafeEqual } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { io as ioc, type Socket } from 'socket.io-client'
import type { Server } from 'socket.io'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFn = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void

export interface FedPeerConfig {
  id: string
  url: string
  secret: string
}

interface PeerRuntime extends FedPeerConfig {
  state: 'connecting' | 'up' | 'down'
  latencyMs: number | null
  lastPongAt: number | null
}

const DATA_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'data')
const STORE_PATH = join(DATA_DIR, 'federation.json')
const AUTH_WINDOW_MS = 60_000
const PING_INTERVAL_MS = 10_000

const PEER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** Parse a federated room reference (`ROOM@peer`); null when not federated. */
export function parseFederatedRoomRef(ref: string): { roomId: string; peerId: string } | null {
  const raw = (ref ?? '').trim()
  const m = /^([A-Za-z0-9]{4,12})@([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/.exec(raw)
  if (!m) return null
  return { roomId: m[1].toUpperCase(), peerId: m[2].toLowerCase() }
}

export interface FederationCallbacks {
  /** An authenticated event arrived from a peer server. */
  onFedEvent: (peerId: string, event: string, payload: Record<string, unknown>) => void
  /** A peer link (re)connected — index.ts may replay state if needed. */
  onLinkUp?: (peerId: string) => void
}

export class Federation {
  readonly selfId: string
  private peers = new Map<string, PeerRuntime>()
  /** Merged inbound+outbound links, keyed by the REMOTE server's peer id. */
  private links = new Map<string, Socket>()
  private cbs: FederationCallbacks
  private log: LogFn
  private started = false

  constructor(log: LogFn, cbs: FederationCallbacks) {
    this.log = log
    this.cbs = cbs
    this.selfId = (() => {
      const v = (process.env.FEDERATION_ID ?? '').toLowerCase()
      return PEER_ID_RE.test(v) ? v : 'self'
    })()
  }

  // ── Boot: env seeds + persisted peers + link dialing ──

  async start(server: Server): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      const raw = await readFile(STORE_PATH, 'utf8')
      const arr = JSON.parse(raw) as FedPeerConfig[]
      if (Array.isArray(arr)) {
        for (const p of arr) this.registerPeer(p, false)
      }
    } catch { /* no store yet */ }
    try {
      const env = process.env.FEDERATION_PEERS
      if (env) {
        const arr = JSON.parse(env) as FedPeerConfig[]
        if (Array.isArray(arr)) for (const p of arr) this.registerPeer(p, false)
      }
    } catch {
      this.log('warn', 'federation_env_invalid', {})
    }
    // Inbound: authenticate peer servers dialing OUR /federation namespace.
    const ns = server.of('/federation')
    ns.use((socket, next) => {
      try {
        const auth = (socket.handshake?.auth ?? {}) as { peerId?: string; ts?: number; token?: string }
        const peerId = String(auth.peerId ?? '').toLowerCase()
        const ts = Number(auth.ts)
        const token = String(auth.token ?? '')
        const peer = this.peers.get(peerId)
        if (!peer) return next(new Error('unknown peer'))
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > AUTH_WINDOW_MS) return next(new Error('stale auth timestamp'))
        const expect = createHmac('sha256', peer.secret).update(`${peerId}.${ts}`).digest('hex')
        const a = Buffer.from(expect)
        const b = Buffer.from(token)
        if (a.length !== b.length || !timingSafeEqual(a, b)) return next(new Error('bad auth token'))
        // Claim the link (replaces any previous socket from this peer).
        const prev = this.links.get(peerId)
        if (prev) prev.disconnect()
        this.links.set(peerId, socket)
        ;(socket as unknown as { data: { peerId: string } }).data = { peerId }
        socket.onAny((event: string, ...args: unknown[]) => {
          if (args.length === 1 && typeof event === 'string' && event.startsWith('fed-')) {
            this.cbs.onFedEvent(peerId, event, (args[0] ?? {}) as Record<string, unknown>)
          }
        })
        socket.on('disconnect', () => {
          if (this.links.get(peerId) === socket) this.links.delete(peerId)
          this.log('info', 'federation_link_down', { peer: peerId, direction: 'in' })
        })
        socket.on('fed-ping', (p: { t?: number }) => socket.emit('fed-pong', { t: p?.t ?? Date.now() }))
        this.log('info', 'federation_link_up', { peer: peerId, direction: 'in' })
        next()
      } catch (err) {
        next(err as Error)
      }
    })
    // Outbound: dial every configured peer.
    for (const peer of this.peers.values()) this.dial(peer)
    // Heartbeat on all links.
    setInterval(() => {
      for (const [peerId, sock] of this.links) {
        if (!sock.connected) continue
        sock.emit('fed-ping', { t: Date.now() })
        const peer = this.peers.get(peerId)
        if (peer && peer.lastPongAt && Date.now() - peer.lastPongAt > PING_INTERVAL_MS * 3) {
          peer.state = 'down'
        }
      }
    }, PING_INTERVAL_MS)
    this.log('info', 'federation_ready', { selfId: this.selfId, peers: this.peers.size })
  }

  private registerPeer(p: FedPeerConfig, persistNow: boolean): boolean {
    const id = String(p?.id ?? '').toLowerCase()
    const url = String(p?.url ?? '').trim().replace(/\/+$/, '')
    const secret = String(p?.secret ?? '')
    if (!PEER_ID_RE.test(id) || id === this.selfId) return false
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    } catch {
      return false
    }
    if (secret.length < 8) return false
    const existing = this.peers.get(id)
    this.peers.set(id, { id, url, secret, state: existing?.state ?? 'connecting', latencyMs: existing?.latencyMs ?? null, lastPongAt: existing?.lastPongAt ?? null })
    if (persistNow) void this.persist()
    return true
  }

  private dial(peer: PeerRuntime): void {
    if (peer.id === this.selfId) return
    // Function-form auth: socket.io re-evaluates it on EVERY (re)connection
    // attempt, so the HMAC timestamp never goes stale after a reconnect.
    const sock = ioc(`${peer.url}/federation`, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: (cb: (a: Record<string, unknown>) => void) => {
        const ts = Date.now()
        const token = createHmac('sha256', peer.secret).update(`${this.selfId}.${ts}`).digest('hex')
        cb({ peerId: this.selfId, ts, token })
      },
    })
    sock.on('connect', () => {
      if (this.links.get(peer.id)?.connected) {
        // Prefer a live link; keep this one parked for failover.
        return
      }
      this.links.set(peer.id, sock)
      peer.state = 'up'
      this.log('info', 'federation_link_up', { peer: peer.id, direction: 'out' })
      this.cbs.onLinkUp?.(peer.id)
    })
    sock.on('fed-pong', (p: { t?: number }) => {
      peer.state = 'up'
      peer.latencyMs = Date.now() - (Number(p?.t) || Date.now())
      peer.lastPongAt = Date.now()
    })
    sock.onAny((event: string, ...args: unknown[]) => {
      if (args.length === 1 && typeof event === 'string' && event.startsWith('fed-')) {
        this.cbs.onFedEvent(peer.id, event, (args[0] ?? {}) as Record<string, unknown>)
      }
    })
    sock.on('disconnect', () => {
      if (this.links.get(peer.id) === sock) this.links.delete(peer.id)
      peer.state = this.links.get(peer.id)?.connected ? 'up' : 'down'
      this.log('info', 'federation_link_down', { peer: peer.id, direction: 'out' })
    })
    sock.on('connect_error', (err: Error) => {
      peer.state = 'down'
      this.log('warn', 'federation_link_error', { peer: peer.id, message: String(err?.message ?? err) })
    })
  }

  /** Is `peerId` a configured peer? (fed joins to unknown peers fail fast.) */
  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId.toLowerCase())
  }

  peerName(peerId: string): string | null {
    return this.peers.get(peerId.toLowerCase())?.id ?? null
  }

  /** Send an event to a peer's server. Returns false when no live link. */
  emitToPeer(peerId: string, event: string, payload: Record<string, unknown>): boolean {
    const sock = this.links.get(peerId.toLowerCase())
    if (!sock || !sock.connected) return false
    sock.emit(event, payload)
    return true
  }

  /** Every distinct peer id that owns at least one device in `room`. */
  fedPeersInRoom(deviceFedVia: Iterable<string | undefined>): Set<string> {
    const out = new Set<string>()
    for (const v of deviceFedVia) if (v) out.add(v)
    return out
  }

  // ── Admin surface ──

  snapshot(): Record<string, unknown> {
    return {
      selfId: this.selfId,
      peers: Array.from(this.peers.values()).map((p) => ({
        id: p.id,
        url: p.url,
        state: this.links.get(p.id)?.connected ? 'up' : p.state === 'up' ? 'up' : p.state,
        latencyMs: p.latencyMs,
      })),
      liveLinks: Array.from(this.links.entries()).filter(([, s]) => s.connected).map(([id]) => id),
    }
  }

  async adminAction(action: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    if (action === 'federation-add') {
      const ok = this.registerPeer(
        { id: String(body.id ?? ''), url: String(body.url ?? ''), secret: String(body.secret ?? '') },
        true
      )
      if (!ok) return { status: 400, body: { error: 'id must match [a-z0-9_-]{1,32} (not self), url http(s), secret ≥ 8 chars' } }
      const peer = this.peers.get(String(body.id).toLowerCase())!
      this.dial(peer)
      this.log('info', 'federation_peer_added', { peer: peer.id })
      return { status: 200, body: { ok: true, action } }
    }
    if (action === 'federation-remove') {
      const id = String(body.id ?? '').toLowerCase()
      const peer = this.peers.get(id)
      if (!peer) return { status: 404, body: { error: 'peer not found' } }
      const sock = this.links.get(id)
      if (sock) {
        sock.disconnect()
        this.links.delete(id)
      }
      this.peers.delete(id)
      await this.persist()
      this.log('info', 'federation_peer_removed', { peer: id })
      return { status: 200, body: { ok: true, action } }
    }
    return { status: 400, body: { error: `unknown federation action '${action}'` } }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(DATA_DIR, { recursive: true })
      await writeFile(
        STORE_PATH,
        JSON.stringify(Array.from(this.peers.values()).map(({ id, url, secret }) => ({ id, url, secret })), null, 2)
      )
    } catch { /* best-effort */ }
  }
}
