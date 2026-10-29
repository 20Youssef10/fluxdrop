// @fluxdrop/sdk — typed client façade (scaffold).
//
// This is the documented API surface for embedding FluxDrop into any web app
// (docs site, support chat, LMS…). What you get today:
//
//   ✅ ENGINE RE-EXPORTS (production code) — protocol, encoding, compress,
//      checksum, format: the exact files the FluxDrop web client runs on
//      (see ./engine.ts).
//   ✅ A typed, dependency-free event emitter (`FluxdropEmitter`) and the
//      full `FluxdropEvents` surface.
//   ✅ Real local work in `sendFiles()`: file validation + SHA-256 hashing +
//      manifest building via the production engine modules.
//   🔌 TRANSPORT WIRING (scaffold stubs) — `connect()`, `createRoom()`,
//      `joinRoom()` and the chunk-send step of `sendFiles()` throw a
//      `ScaffoldTransportError` ("scaffold: wire to your transport") at the
//      exact point where signaling + WebRTC plug in. WebRTC is not available
//      in plain Node; the production implementations live in the web client
//      (src/hooks/fluxdrop/use-fluxdrop.ts + src/lib/fluxdrop/{signaling,
//      webrtc,e2e}.ts) and the CLI reference (cli/src/transfer.ts). Lifting
//      them behind this façade is the follow-up tracked in FEATURES.md 9.3.
//
// See README.md ("Roadmap") and docs/sdk.md for the scaffold → full client
// plan.

import {
  CONSTANTS,
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
   * (rendered as "open in FluxDrop" affordances). Purely presentational in
   * the scaffold.
   */
  endpoint?: string
  /** Signaling server URL (socket.io). The web client proxies this via its origin. */
  signalUrl?: string
  /** Device alias shown to peers (auto-generated when omitted). */
  alias?: string
  /** Role this instance plays; receivers join rooms, senders create them. */
  role?: DeviceRole
  /** Request a PIN-protected room when creating rooms (default true). */
  withPin?: boolean
}

/** Room handle returned by {@link FluxdropClient.createRoom}. */
export interface FluxdropRoomInfo {
  roomId: string
  joinCode: string
  pin: string | null
  /** QR payload (a join URL) once the transport wiring lands. */
  qrData: string | null
}

/** Result of {@link FluxdropClient.sendFiles} in the scaffold: the built manifest. */
export interface FluxdropSendResult {
  manifest: TransferManifest
}

/**
 * Thrown wherever the scaffold reaches the point that needs the transport
 * (signaling relay or WebRTC DataChannel). `manifest` is attached when the
 * local pipeline (validation + hashing) already completed, so hosts can
 * still inspect what *would* be sent.
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
   * SENDER: validate + hash `files` and build the production manifest, then
   * hand it to the WebRTC send pipeline. In the scaffold the pipeline step
   * throws a {@link ScaffoldTransportError} carrying the built manifest.
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
      set = new Set()
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

// ============================================================================
// Client façade (scaffold)
// ============================================================================

const SCAFFOLD_SIGNALING = 'scaffold: wire to your transport — connect() needs a ' +
  'signaling client (socket.io-client + src/lib/fluxdrop/signaling.ts); the SDK ' +
  'intentionally does not bundle it. See docs/sdk.md → Roadmap.'

/**
 * Create a FluxDrop client for embedding.
 *
 * SCAFFOLD SCOPE — what works today vs. what plugs in later:
 *
 *   ✅ Typed event surface + state machine mirroring the web client
 *      (`TransferState` from protocol.ts) — fully functional.
 *   ✅ `sendFiles()` local pipeline — validation, SHA-256 hashing and
 *      manifest building run the PRODUCTION engine code (checksum.ts,
 *      format.ts, protocol.ts).
 *   ✅ `on()` / `getState()` / `destroy()` — complete.
 *   🔌 `connect()` / `createRoom()` / `joinRoom()` and the DataChannel send
 *      step of `sendFiles()` throw {@link ScaffoldTransportError}
 *      ("scaffold: wire to your transport"). The production implementations
 *      live in src/hooks/fluxdrop/use-fluxdrop.ts +
 *      src/lib/fluxdrop/{signaling,webrtc,e2e}.ts; cli/src/transfer.ts is a
 *      dependency-free reference for the full send sequence.
 *
 * @example
 * ```ts
 * const fluxdrop = createFluxdropClient({ alias: 'docs-site' })
 * const off = fluxdrop.on('state', (s) => console.log('→', s))
 * try {
 *   await fluxdrop.sendFiles([file]) // validates + hashes + builds manifest
 * } catch (err) {
 *   if (err instanceof ScaffoldTransportError) console.log(err.manifest)
 * }
 * off()
 * fluxdrop.destroy()
 * ```
 */
export function createFluxdropClient(options: FluxdropClientOptions = {}): FluxdropClient {
  const emitter = new FluxdropEmitter()
  let state: TransferState = 'IDLE'
  let destroyed = false

  function setState(next: TransferState): void {
    const previous = state
    state = next
    emitter.emit('state', next, previous)
  }

  function fail(message: string, manifest?: TransferManifest): never {
    const err = new ScaffoldTransportError(message, manifest)
    // Surface the scaffold limitation both as an event and as a terminal
    // state — the client stays usable (hosts may retry after wiring).
    emitter.emit('error', err)
    setState('ERROR')
    throw err
  }

  /**
   * Build the transfer manifest for `files` — this part is REAL: it uses the
   * production hashing path (checksum.ts — crypto.subtle with the hash-wasm
   * fallback for insecure origins) and the 64 KiB chunk math from protocol.ts.
   */
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

  const client: FluxdropClient = {
    on(event, handler) {
      return emitter.on(event, handler as Handler)
    },

    getState() {
      return state
    },

    async connect() {
      if (destroyed) throw new Error('client destroyed')
      setState('CONNECTING')
      // 🔌 INTEGRATION POINT — construct the signaling socket here
      // (FluxDropSignaling wraps socket.io-client; the web client connects
      // through its origin with XTransformPort=3003). Resolve on the
      // socket's connect callback, emit 'error' + fall back to IDLE on a
      // connect_error. Until then the scaffold refuses to pretend:
      fail(SCAFFOLD_SIGNALING)
    },

    async createRoom() {
      if (destroyed) throw new Error('client destroyed')
      if (options.role === 'receiver') throw new Error('createRoom is a sender-side operation')
      setState('PAIRING')
      // 🔌 INTEGRATION POINT — wire FluxDropSignaling.createRoom here and
      // resolve on SIGNALING_EVENTS.ROOM_CREATED (payload: roomId, joinCode,
      // pin, qrData). The 'roomCreated' event surface above already covers
      // the UI updates.
      fail('scaffold: wire to your transport — createRoom() relays through the ' +
        'signaling server; requires connect(). See docs/sdk.md → Roadmap.')
    },

    async joinRoom(roomId, _pin) {
      if (destroyed) throw new Error('client destroyed')
      setState('PAIRING')
      void _pin
      // 🔌 INTEGRATION POINT — wire FluxDropSignaling.joinRoom +
      // SIGNALING_EVENTS.ROOM_JOINED (payload: peers).
      fail('scaffold: wire to your transport — joinRoom() relays through the ' +
        `signaling server (room ${roomId}); requires connect(). See docs/sdk.md → Roadmap.`)
    },

    async sendFiles(files) {
      if (destroyed) throw new Error('client destroyed')
      if (files.length === 0) throw new Error('no files given')

      // --- Local pipeline: production engine code, fully functional -----
      setState('VALIDATING')
      const { validateFiles } = await import('./engine')
      const validation = validateFiles(files)
      if (!validation.ok) throw new Error(validation.errors.join('; '))

      setState('MANIFEST_EXCHANGE')
      const manifest = await buildManifest(files)

      // --- Transport step: scaffold --------------------------------------
      // 🔌 INTEGRATION POINT — hand `manifest` to the WebRTC send pipeline:
      // encodeControlMessage(MessageType.MANIFEST, …) over the DataChannel,
      // then the chunk loop with encodeChunkData + CHUNK_ACK pacing and the
      // AIMD flow window (see cli/src/transfer.ts for a dependency-free
      // reference implementation of the full sequence). Progress flows out
      // through the 'progress' event.
      setState('TRANSFERRING')
      fail(
        'scaffold: wire to your transport — manifest built (' +
          `${manifest.files.length} file(s), ${manifest.totalChunks} chunks); ` +
          'connect() a signaling session and drive the DataChannel send loop ' +
          '(cli/src/transfer.ts is the reference). See docs/sdk.md → Roadmap.',
        manifest,
      )
    },

    destroy() {
      destroyed = true
      setState('CANCELLED')
      emitter.clear()
    },
  }

  return client
}

// ============================================================================
// Convenience re-exports (the engine layer — production code)
// ============================================================================

export * from './engine'
