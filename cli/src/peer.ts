// FluxDrop CLI — WebRTC transport via node-datachannel (libdatachannel).
//
// Wraps the native PeerConnection into the small surface the protocol cores
// (session.ts) need. node-datachannel is loaded LAZILY so that
// `fluxdrop loopback` (pure framing demo, no network) still runs on platforms
// where the native module cannot load.

import type { Wire } from './session'

type RawDataChannel = {
  getLabel(): string
  sendMessageBinary(buf: Uint8Array): boolean
  bufferedAmount(): number
  maxMessageSize(): number
  isOpen(): boolean
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void
  onOpen(cb: () => void): void
  onClosed(cb: () => void): void
  onError(cb: (err: string) => void): void
  close(): void
}

type RawPeerConnection = {
  close(): void
  setRemoteDescription(sdp: string, type: string): void
  addRemoteCandidate(candidate: string, mid: string): void
  createDataChannel(label: string): RawDataChannel
  onDataChannel(cb: (dc: RawDataChannel) => void): void
  onLocalDescription(cb: (sdp: string, type: string) => void): void
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void
  onStateChange(cb: (state: string) => void): void
  state(): string
  rtt(): number
  getSelectedCandidatePair(): { local: { type: string }; remote: { type: string } } | null
}

/** Loads node-datachannel or throws with a pointer to loopback mode. */
export async function loadNodeDatachannel(): Promise<
  new (name: string, cfg: { iceServers: string[] }) => RawPeerConnection
> {
  try {
    const mod: { PeerConnection: new (name: string, cfg: { iceServers: string[] }) => RawPeerConnection } =
      await import('node-datachannel')
    return mod.PeerConnection
  } catch (err) {
    throw new Error(
      `node-datachannel failed to load on this platform (${(err as Error).message}). ` +
        `WebRTC transport is unavailable — run "fluxdrop loopback" for the in-process ` +
        `framing+hashing demo, or use the web client at http://localhost:3000.`
    )
  }
}

/** A libdatachannel DataChannel presented as the transport-agnostic Wire. */
export class DcWire implements Wire {
  constructor(readonly dc: RawDataChannel) {}
  send(bytes: Uint8Array | ArrayBuffer): void {
    // node-datachannel's native binding under bun requires a Node Buffer
    // (a plain Uint8Array view over an ArrayBuffer throws "Buffer expected").
    const buf =
      bytes instanceof ArrayBuffer
        ? Buffer.from(bytes)
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // The boolean return of sendMessageBinary is "false if buffered"
    // (libdatachannel v0.24 SctpTransport::send): the usrsctp send buffer
    // was full and the message went into the send queue — it WILL be
    // flushed. Real failures (channel closed, message > max) throw from the
    // native binding instead. Backpressure is observed via bufferedAmount().
    this.dc.sendMessageBinary(buf)
  }
  bufferedAmount(): number {
    return this.dc.bufferedAmount()
  }
  maxMessageSize(): number {
    return this.dc.maxMessageSize()
  }
  onOpen(cb: () => void): void {
    this.dc.onOpen(cb)
  }
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.dc.onMessage(cb)
  }
  isOpen(): boolean {
    return this.dc.isOpen()
  }
}

export interface RtcPeerHandlers {
  onDescription: (sdp: string, type: 'offer' | 'answer') => void
  onCandidate: (candidate: string, mid: string) => void
  onDataChannel: (wire: DcWire) => void
  onDataChannelClosed: () => void
  onStateChange?: (state: string) => void
}

/**
 * One PeerConnection + its primary DataChannel.
 *
 * libdatachannel quirk (verified against 0.33.6): onLocalDescription /
 * onLocalCandidate MUST be registered BEFORE createDataChannel() or
 * setRemoteDescription() — the local description is emitted synchronously at
 * that point and a late registration misses it. The constructor registers
 * everything up front.
 */
export class RtcPeer {
  private pc: RawPeerConnection
  private dc: RawDataChannel | null = null
  private closed = false

  constructor(
    peerName: string,
    PeerCtor: new (name: string, cfg: { iceServers: string[] }) => RawPeerConnection,
    iceServers: string[],
    private handlers: RtcPeerHandlers
  ) {
    this.pc = new PeerCtor(peerName, { iceServers })
    this.pc.onLocalDescription((sdp, type) => {
      if (type === 'offer' || type === 'answer') handlers.onDescription(sdp, type)
    })
    this.pc.onLocalCandidate((candidate, mid) => handlers.onCandidate(candidate, mid))
    this.pc.onStateChange((state) => handlers.onStateChange?.(state))
    this.pc.onDataChannel((dc) => this.attach(dc))
  }

  /** Sender side: create the outgoing channel (triggers offer generation). */
  createSendChannel(): DcWire {
    if (this.dc) throw new Error('data channel already created')
    const dc = this.pc.createDataChannel('fluxdrop-0')
    return this.attach(dc)
  }

  private attach(dc: RawDataChannel): DcWire {
    this.dc = dc
    dc.onClosed(() => {
      if (this.closed) return
      this.closed = true
      this.handlers.onDataChannelClosed()
    })
    dc.onError((err) => process.stderr.write(`[dc] ${err}\n`))
    const wire = new DcWire(dc)
    // Receiver path: deliver the incoming channel to the command layer.
    // (Sender path: createSendChannel returns the wire to its caller.)
    this.handlers.onDataChannel(wire)
    return wire
  }

  /** Apply a remotely-relayed SDP (answer on sender, offer on receiver). */
  applyRemoteDescription(sdp: string, type: string): void {
    this.pc.setRemoteDescription(sdp, type)
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    try {
      this.pc.addRemoteCandidate(candidate, mid)
    } catch {
      // libdatachannel throws on candidates arriving before the remote
      // description is set — safe to drop, other candidates complete ICE.
    }
  }

  state(): string {
    return this.pc.state()
  }

  rtt(): number {
    return this.pc.rtt()
  }

  candidatePair(): string {
    const pair = this.pc.getSelectedCandidatePair()
    return pair ? `${pair.local.type} ↔ ${pair.remote.type}` : 'unknown'
  }

  close(): void {
    this.closed = true
    try {
      this.dc?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc.close()
    } catch {
      /* ignore */
    }
  }
}

/** A ready-to-use peer factory bound to an ICE server list. */
export type PeerFactory = (
  peerName: string,
  handlers: RtcPeerHandlers
) => RtcPeer

export async function createPeerFactory(iceServers: string[]): Promise<PeerFactory> {
  const PeerCtor = await loadNodeDatachannel()
  return (peerName, handlers) => new RtcPeer(peerName, PeerCtor, iceServers, handlers)
}
