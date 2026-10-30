// @fluxdrop/sdk — typed client with REAL transport (v0.2.0).
//
// What was the v0.1 scaffold is now wired end-to-end:
//   ✅ connect()      — socket.io-client against any FluxDrop signaling server
//   ✅ createRoom()   — PIN-protected room, join code + deep-link payload
//   ✅ joinRoom()     — receiver-side join (peers roster)
//   ✅ sendFiles()    — the FULL production send pipeline: validate → SHA-256
//      manifest → pairing → WebRTC DataChannel (offer/answer/ICE over
//      signaling) → manifest-first framing → 64 KiB chunk stream with
//      CHUNK_ACK pacing + lost-ACK resweep → TRANSFER_COMPLETE handshake.
//
// The engine layer (./engine) IS the app's production wire code — framing,
// hashing, compression, checksums — so a widget built on this SDK speaks
// byte-for-byte the same protocol as the FluxDrop web client. A web receiver
// sees an SDK sender exactly like it sees the CLI sender: plaintext over the
// DataChannel with a visible E2EE downgrade notice (E2EE stays a web↔web
// feature — it needs the interactive PAKE handshake).
//
// Reference: cli/src/transfer.ts + cli/src/send.ts (the headless sender this
// implementation mirrors); src/hooks/fluxdrop/use-fluxdrop.ts (the full app).

import { io, type Socket } from 'socket.io-client'
import {
  CONSTANTS,
  MessageType,
  encodeChunkData,
  encodeControlMessage,
  decodeMessage,
  type Device,
  type DeviceRole,
  type FileManifestEntry,
  type TransferManifest,
  type TransferState,
} from './engine'

// ============================================================================
// Public types
// ============================================================================

/** Everything the façade can emit. */
export interface FluxdropEvents {
  /** Lifecycle/state-machine transitions (protocol.ts `TransferState`). */
  state: (state: TransferState, previous: TransferState) => void
  /** Room established (sender) — carries the join code + PIN to render. */
  roomCreated: (info: { roomId: string; joinCode: string; pin: string | null; qrData: string | null }) => void
  /** Successfully joined a room (receiver). */
  roomJoined: (info: { roomId: string; peers: Device[] }) => void
  /** A peer device appeared/disappeared in the room. */
  peer: (device: Device, change: 'joined' | 'left') => void
  /** Per-transfer progress. */
  progress: (info: { transferId: string; bytesTransferred: number; totalBytes: number; chunksAcked: number; totalChunks: number }) => void
  /** Transfer finished and checksum-verified. */
  complete: (summary: { transferId: string; verified: boolean; manifest: TransferManifest }) => void
  /** Anything fatal; the client stays usable afterwards. */
  error: (err: Error) => void
}

export type FluxdropEventName = keyof FluxdropEvents

export interface FluxdropClientOptions {
  /**
   * Base URL of a FluxDrop web instance the widget/flows can deep-link into
   * (rendered as "open in FluxDrop" affordances). Purely presentational.
   */
  endpoint?: string
  /**
   * Signaling server URL (socket.io). Defaults to the embedding page's own
   * origin (self-hosted setups proxy /socket.io); pass an explicit URL to
   * target a remote server, e.g. 'https://signal.fluxdrop.example'.
   */
  signalUrl?: string
  /** Device alias shown to peers (auto-generated when omitted). */
  alias?: string
  /** Role this instance plays; receivers join rooms, senders create them. */
  role?: DeviceRole
  /** Request a PIN-protected room when creating rooms (default true). */
  withPin?: boolean
  /** Extra RTCConfiguration iceServers appended to the public defaults. */
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>
}

/** Room handle returned by {@link FluxdropClient.createRoom}. */
export interface FluxdropRoomInfo {
  roomId: string
  joinCode: string
  pin: string | null
  /** QR payload (a fluxdrop:// join deep link). */
  qrData: string | null
  /** Web join URL derived from `endpoint` when provided. */
  joinUrl: string | null
}

/** Result of {@link FluxdropClient.sendFiles}. */
export interface FluxdropSendResult {
  manifest: TransferManifest
  verified: boolean
}

/** Handle returned by {@link createFluxdropClient}. */
export interface FluxdropClient {
  /** Register an event handler; returns an unsubscribe function. */
  on<K extends FluxdropEventName>(event: K, handler: FluxdropEvents[K]): () => void
  /** Current state-machine value (protocol.ts `TransferState`). */
  getState(): TransferState
  /** Open the signaling connection. Resolves once the socket is connected. */
  connect(): Promise<void>
  /** SENDER: create a room. Resolves once the server answers `room-created`. */
  createRoom(): Promise<FluxdropRoomInfo>
  /** RECEIVER: join a room by code + PIN. Resolves once `room-joined` arrives. */
  joinRoom(roomId: string, pin: string): Promise<{ roomId: string; peers: Device[] }>
  /**
   * SENDER: validate + hash `files`, create the room (if not already in one),
   * wait for a receiver to pair, then run the full WebRTC send pipeline.
   * Resolves when the receiver verifies every SHA-256 checksum (or rejects).
   */
  sendFiles(files: File[]): Promise<FluxdropSendResult>
  /** Tear down signaling + any open peer connections. */
  destroy(): void
}

// ============================================================================
// Tiny typed event emitter (no runtime dependencies)
// ============================================================================

type Handler = (...args: never[]) => void

export class FluxdropEmitter {
  private handlers = new Map<string, Set<Handler>>()
  on(name: string, handler: Handler): () => void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set<Handler>()
      this.handlers.set(name, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }
  emit(name: string, ...args: unknown[]): void {
    const set = this.handlers.get(name)
    if (!set) return
    for (const handler of set) (handler as (...a: unknown[]) => void)(...args)
  }
  clear(): void {
    this.handlers.clear()
  }
}

/**
 * Kept for v0.1 source-compat: the transport is REAL now, so this error only
 * fires when a WebRTC/protocol prerequisite is genuinely missing (e.g.
 * `sendFiles` called from an environment without WebRTC).
 */
export class ScaffoldTransportError extends Error {
  readonly code = 'SCAFFOLD_TRANSPORT' as const
  /** Present when thrown from sendFiles() after the manifest was built. */
  readonly manifest?: TransferManifest
  constructor(message: string, manifest?: TransferManifest) {
    super(message)
    this.name = 'ScaffoldTransportError'
    this.manifest = manifest
  }
}

// ============================================================================
// Internals
// ============================================================================

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
]

const DC_LABEL = 'fluxdrop-0'
const MAX_INFLIGHT_CHUNKS = 64
const BUFFERED_SOFT_CAP = 8 * 1024 * 1024
const MAX_RESWEEPS = 10
const RESWEEP_INTERVAL_MS = 900
const PAIRING_TIMEOUT_MS = CONSTANTS.PAIRING_TIMEOUT_MS ?? 120_000

function randomAlias(): string {
  const animals = ['falcon', 'otter', 'ibex', 'heron', 'lynx', 'puffin', 'gecko', 'tapir']
  const beast = animals[Math.floor(Math.random() * animals.length)]
  return beast + '-' + Math.random().toString(36).slice(2, 6)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Build the transfer manifest with the production hashing path. */
async function buildManifest(files: File[]): Promise<TransferManifest> {
  const { hashFile, computeTotalChunks } = await import('./engine')
  const entries: FileManifestEntry[] = []
  let totalSize = 0
  for (const file of files) {
    entries.push({
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
      checksum: await hashFile(file),
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    })
    totalSize += file.size
  }
  const now = Date.now()
  return {
    transferId: crypto.randomUUID(),
    version: 1,
    files: entries,
    totalSize,
    totalChunks: computeTotalChunks(totalSize, CONSTANTS.CHUNK_SIZE),
    chunkSize: CONSTANTS.CHUNK_SIZE,
    createdAt: now,
    expiresAt: now + CONSTANTS.RESUME_RECORD_TTL_MS,
  }
}

// ============================================================================
// Client façade (real transport)
// ============================================================================

export function createFluxdropClient(options: FluxdropClientOptions = {}): FluxdropClient {
  const emitter = new FluxdropEmitter()
  let state: TransferState = 'IDLE'
  let destroyed = false
  let socket: Socket | null = null
  let pc: RTCPeerConnection | null = null
  let dc: RTCDataChannel | null = null
  const alias = options.alias ?? randomAlias()
  const deviceId = crypto.randomUUID()
  const role: DeviceRole = options.role ?? 'sender'
  let room: FluxdropRoomInfo | null = null

  function setState(next: TransferState): void {
    const previous = state
    state = next
    emitter.emit('state', next, previous)
  }

  function fail(message: string, manifest?: TransferManifest): never {
    const err = new Error(message) as Error & { manifest?: TransferManifest }
    err.name = 'FluxDropError'
    err.manifest = manifest
    emitter.emit('error', err)
    setState('ERROR')
    throw err
  }

  function onceEvent<T>(event: string, predicate: (payload: any) => T | null, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out waiting for ${event}`))
      }, timeoutMs)
      const handler = (payload: any) => {
        const v = predicate(payload)
        if (v === null) return
        clearTimeout(timer)
        cleanup()
        resolve(v)
      }
      const cleanup = () => {
        socket?.off(event, handler)
        socket?.off('signaling-error', onError)
      }
      const onError = (payload: { code?: string; message?: string }) => {
        clearTimeout(timer)
        cleanup()
        reject(new Error(`${payload?.code ?? 'SIGNALING_ERROR'}: ${payload?.message ?? 'signaling error'}`))
      }
      socket?.on(event, handler)
      socket?.on('signaling-error', onError)
    })
  }

  function teardownPeer(): void {
    try { dc?.close() } catch { /* ignore */ }
    try { pc?.close() } catch { /* ignore */ }
    dc = null
    pc = null
  }

  const client: FluxdropClient = {
    on(event, handler) {
      return emitter.on(event, handler as Handler)
    },

    getState() {
      return state
    },

    async connect() {
      if (destroyed) throw new Error('client destroyed')
      if (socket?.connected) return
      setState('CONNECTING')
      await new Promise<void>((resolve, reject) => {
        socket = io(options.signalUrl ?? window.location.origin, {
          transports: ['websocket', 'polling'],
          forceNew: true,
          reconnection: true,
          timeout: 15000,
        })
        const onConnect = () => {
          socket?.off('connect_error', onErr)
          resolve()
        }
        const onErr = (err: Error) => {
          socket?.off('connect', onConnect)
          socket?.disconnect()
          reject(err)
        }
        socket.once('connect', onConnect)
        socket.once('connect_error', onErr)
        setTimeout(() => reject(new Error('connect timeout')), 16_000)
      })
      setState('IDLE')

      // Room roster upkeep for embedders.
      socket?.on('device-discovered', (p: { device: Device }) => emitter.emit('peer', p.device, 'joined'))
      socket?.on('device-left', (p: { deviceId: string }) => {
        emitter.emit('peer', { id: p.deviceId, alias: '', role: 'receiver', joinedAt: 0 } as Device, 'left')
      })
      socket?.on('disconnect', () => {
        if (!destroyed) emitter.emit('error', new Error('signaling connection lost'))
      })
    },

    async createRoom() {
      if (destroyed) throw new Error('client destroyed')
      if (role === 'receiver') throw new Error('createRoom is a sender-side operation')
      if (!socket?.connected) await client.connect()
      setState('PAIRING')
      socket!.emit('create-room', {
        alias,
        deviceId,
        role: 'sender',
        withPin: options.withPin !== false,
      })
      const payload = await onceEvent<any>(
        'room-created',
        (p) => (p?.roomId ? p : null),
        10_000
      )
      room = {
        roomId: payload.roomId,
        joinCode: payload.joinCode,
        pin: payload.pin ?? null,
        qrData: payload.qrData ?? null,
        joinUrl: options.endpoint
          ? `${options.endpoint.replace(/\/+$/, '')}/#join=${payload.roomId}&pin=${payload.pin ?? ''}`
          : null,
      }
      emitter.emit('roomCreated', { ...room })
      return room
    },

    async joinRoom(roomId, pin) {
      if (destroyed) throw new Error('client destroyed')
      if (!socket?.connected) await client.connect()
      setState('PAIRING')
      socket!.emit('join-room', {
        roomId,
        pin,
        alias,
        deviceId,
        role: 'receiver',
      })
      const payload = await onceEvent<any>(
        'room-joined',
        (p) => (p?.roomId ? p : null),
        10_000
      )
      room = { roomId: payload.roomId, joinCode: payload.joinCode, pin: pin ?? null, qrData: null, joinUrl: null }
      emitter.emit('roomJoined', { roomId: payload.roomId, peers: payload.peers ?? [] })
      return { roomId: payload.roomId, peers: payload.peers ?? [] }
    },

    async sendFiles(files) {
      if (destroyed) throw new Error('client destroyed')
      if (files.length === 0) throw new Error('no files given')

      // --- Local pipeline: production engine code ---------------------------
      setState('VALIDATING')
      const { validateFiles } = await import('./engine')
      const validation = validateFiles(files)
      if (!validation.ok) throw new Error(validation.errors.join('; '))

      setState('MANIFEST_EXCHANGE')
      const manifest = await buildManifest(files)

      if (!socket?.connected) await client.connect()
      if (!room) await client.createRoom()

      // --- Wait for a receiver to pair (mirrors the CLI sender) -------------
      setState('PAIRING')
      const peerId: string = await new Promise<string>((resolve, reject) => {
        let done = false
        const settle = (id: string) => {
          if (done) return
          done = true
          clearTimeout(timer)
          cleanup()
          resolve(id)
        }
        const timer = setTimeout(() => {
          if (done) return
          done = true
          cleanup()
          reject(new Error(`no receiver joined within ${Math.round(PAIRING_TIMEOUT_MS / 1000)}s — room expired`))
        }, PAIRING_TIMEOUT_MS)
        // A web receiver sends pairing-request right after joining → confirm
        // (flips its UI to "connected") and pair with it.
        const onPairing = (p: { from?: string }) => {
          if (!p?.from) return
          socket?.emit('pairing-confirm', { roomId: room!.roomId, from: deviceId, to: p.from, accepted: true })
          settle(p.from)
        }
        // Fallback trigger: a receiver was discovered before it could send
        // its own pairing-request → pair proactively (CLI behavior).
        const onDiscovered = (p: { device?: Device }) => {
          if (p?.device?.role === 'receiver' && p.device?.id) {
            setTimeout(() => settle(p.device!.id), 500)
          }
        }
        const cleanup = () => {
          socket?.off('pairing-request', onPairing)
          socket?.off('device-discovered', onDiscovered)
        }
        socket!.on('pairing-request', onPairing)
        socket!.on('device-discovered', onDiscovered)
      })

      // --- WebRTC: dedicated PC + primary DataChannel (we offer) -------------
      setState('CONNECTING')
      const iceServers = [...DEFAULT_ICE, ...(options.iceServers ?? [])]
      pc = new RTCPeerConnection({ iceServers })
      dc = pc.createDataChannel(DC_LABEL, { ordered: true })
      dc.binaryType = 'arraybuffer'

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket?.emit('webrtc-ice', { roomId: room!.roomId, from: deviceId, to: peerId, candidate: e.candidate.toJSON() })
        }
      }
      socket!.on('webrtc-answer', (p: { from?: string; sdp?: RTCSessionDescriptionInit }) => {
        if (p?.from === peerId && p.sdp && pc) void pc.setRemoteDescription(p.sdp)
      })
      socket!.on('webrtc-ice', (p: { from?: string; candidate?: RTCIceCandidateInit }) => {
        if (p?.from === peerId && p.candidate && pc) void pc.addIceCandidate(p.candidate).catch(() => undefined)
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      socket!.emit('webrtc-offer', { roomId: room!.roomId, from: deviceId, to: peerId, sdp: offer })

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DataChannel never opened')), 30_000)
        dc!.onopen = () => { clearTimeout(timer); resolve() }
        dc!.onerror = () => { clearTimeout(timer); reject(new Error('DataChannel error')) }
        pc!.onconnectionstatechange = () => {
          if (pc?.connectionState === 'failed') {
            clearTimeout(timer)
            reject(new Error('WebRTC connection failed'))
          }
        }
      })

      // --- Wire protocol: manifest → chunks → complete -----------------------
      setState('MANIFEST_EXCHANGE')
      const wire = new DcWire(dc!)
      const session = new SenderSession(wire, manifest, files, (p) => {
        emitter.emit('progress', {
          transferId: manifest.transferId,
          bytesTransferred: Math.min(p.acked * manifest.chunkSize, manifest.totalSize),
          totalBytes: manifest.totalSize,
          chunksAcked: p.acked,
          totalChunks: manifest.totalChunks,
        })
      })
      // Tell the signaling server a transfer started (drives the admin
      // dashboard + webhooks even for embedded sends).
      socket!.emit('transfer-manifest', { roomId: room!.roomId, from: deviceId, to: peerId, manifest })

      dc!.onmessage = (ev: MessageEvent<ArrayBuffer | Blob>) => {
        try {
          const data = ev.data instanceof ArrayBuffer ? ev.data : new Blob([ev.data]).arrayBuffer()
          void session.handleMessage(data)
        } catch (err) {
          emitter.emit('error', err as Error)
        }
      }

      setState('TRANSFERRING')
      const verified = await session.run()
      socket!.emit('transfer-complete', { roomId: room!.roomId, from: deviceId, to: peerId })
      setState(verified ? 'COMPLETE' : 'ERROR')
      emitter.emit('complete', { transferId: manifest.transferId, verified, manifest })
      return { manifest, verified }
    },

    destroy() {
      destroyed = true
      teardownPeer()
      socket?.disconnect()
      socket = null
      setState('CANCELLED')
      emitter.clear()
    },
  }

  return client
}

// ============================================================================
// DataChannel adapter + sender wire session (mirrors cli/src/session.ts)
// ============================================================================

class DcWire {
  constructor(private dc: RTCDataChannel) {}
  send(bytes: Uint8Array | ArrayBuffer): void {
    this.dc.send(bytes as ArrayBuffer)
  }
  bufferedAmount(): number {
    return this.dc.bufferedAmount
  }
}

interface Wire {
  send(bytes: Uint8Array | ArrayBuffer): void
  bufferedAmount(): number
}

interface SenderProgress {
  sent: number
  acked: number
}

class SenderSession {
  private acked = new Set<number>()
  private manifestAck: { accepted: boolean; reason?: string } | null = null
  private completeAck: { verified: boolean } | null = null
  private cancelReason: string | null = null

  constructor(
    private wire: Wire,
    private manifest: TransferManifest,
    private files: File[],
    private onProgress?: (p: SenderProgress) => void
  ) {}

  async handleMessage(data: ArrayBuffer | Promise<ArrayBuffer>): Promise<void> {
    const buf = await data
    const msg = decodeMessage(buf)
    switch (msg.type) {
      case MessageType.MANIFEST_ACK:
        this.manifestAck = (msg.body ?? {}) as { accepted: boolean; reason?: string }
        break
      case MessageType.CHUNK_ACK: {
        const ok = msg.payloadView.length > 0 && msg.payloadView[0] === 0x01
        if (ok) this.acked.add(msg.chunkIndex)
        break
      }
      case MessageType.TRANSFER_COMPLETE_ACK:
        this.completeAck = (msg.body ?? {}) as { verified: boolean }
        break
      case MessageType.TRANSFER_CANCEL:
        this.cancelReason = String((msg.body as { reason?: string })?.reason ?? 'cancelled by receiver')
        break
      default:
        break
    }
  }

  get cancelled(): boolean {
    return this.cancelReason !== null
  }

  private async waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (this.cancelled) throw new Error(`transfer cancelled: ${this.cancelReason}`)
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }

  /** Read chunk `i` of the concatenated transfer stream from the files. */
  private async readChunk(i: number): Promise<Uint8Array> {
    const { chunkSize, totalSize } = this.manifest
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, totalSize)
    const out = new Uint8Array(end - start)
    let w = 0
    let fileStart = 0
    for (const file of this.files) {
      const fileEnd = fileStart + file.size
      if (fileEnd <= start) { fileStart = fileEnd; continue }
      if (fileStart >= end) break
      const from = Math.max(fileStart, start) - fileStart
      const to = Math.min(fileEnd, end) - fileStart
      const slice = await file.slice(from, to).arrayBuffer()
      out.set(new Uint8Array(slice), w)
      w += to - from
      fileStart = fileEnd
    }
    return w === out.length ? out : out.subarray(0, w)
  }

  async run(): Promise<boolean> {
    const { totalChunks, transferId } = this.manifest

    // 1. MANIFEST (the receiver's consent dialog answers MANIFEST_ACK).
    this.wire.send(encodeControlMessage(MessageType.MANIFEST, transferId, 0, this.manifest))
    await this.waitUntil(() => this.manifestAck !== null, 120_000, 'MANIFEST_ACK (receiver consent)')
    if (!this.manifestAck?.accepted) {
      throw new Error(`receiver declined the transfer: ${this.manifestAck?.reason ?? 'no reason given'}`)
    }

    // 2. CHUNK_DATA stream with CHUNK_ACK pacing + backpressure.
    for (let i = 0; i < totalChunks; i++) {
      if (this.cancelled) throw new Error(`transfer cancelled: ${this.cancelReason}`)
      for (;;) {
        const inFlight = i - this.acked.size
        if (inFlight < MAX_INFLIGHT_CHUNKS && this.wire.bufferedAmount() < BUFFERED_SOFT_CAP) break
        await sleep(5)
      }
      const bytes = await this.readChunk(i)
      this.wire.send(encodeChunkData(transferId, i, bytes))
      this.onProgress?.({ sent: i + 1, acked: this.acked.size })
    }

    // 3. Lost-ACK recovery: bounded resweep rounds.
    for (let sweep = 0; sweep < MAX_RESWEEPS && this.acked.size < totalChunks && !this.cancelled; sweep++) {
      for (let i = 0; i < totalChunks; i++) {
        if (this.acked.has(i)) continue
        const bytes = await this.readChunk(i)
        this.wire.send(encodeChunkData(transferId, i, bytes))
      }
      await sleep(RESWEEP_INTERVAL_MS)
    }
    if (this.acked.size < totalChunks) {
      throw new Error(`receiver never ACKed ${totalChunks - this.acked.size} chunk(s)`)
    }

    // 4. Completion handshake (finalChecksum = concatenated per-file digests).
    const finalChecksum = this.manifest.files.map((f) => f.checksum).join('')
    this.wire.send(encodeControlMessage(MessageType.TRANSFER_COMPLETE, transferId, 0, { finalChecksum }))
    await this.waitUntil(() => this.completeAck !== null, 60_000, 'TRANSFER_COMPLETE_ACK')
    if (!this.completeAck?.verified) throw new Error('receiver reported checksum verification FAILURE')
    return true
  }
}

// ============================================================================
// Convenience re-exports (the engine layer — production code)
// ============================================================================

export * from './engine'
