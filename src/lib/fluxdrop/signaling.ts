// Socket.IO signaling client wrapper for FluxDrop.
// Connects via the Caddy gateway: io("/?XTransformPort=3003").

'use client'

import { io, type Socket } from 'socket.io-client'
import { SIGNALING_EVENTS } from './protocol'

const SIGNALING_PORT = 3003

export interface SignalingCallbacks {
  onConnect: () => void
  onDisconnect: () => void
  onConnectError: (err: Error) => void
  onRoomCreated: (payload: any) => void
  onRoomJoined: (payload: any) => void
  onRoomExpired: (payload: any) => void
  onRoomClosed: (payload: any) => void
  onDeviceDiscovered: (payload: any) => void
  onDeviceLeft: (payload: any) => void
  onPairingRequest: (payload: any) => void
  onPairingConfirm: (payload: any) => void
  onPairingReject: (payload: any) => void
  onWebRtcOffer: (payload: any) => void
  onWebRtcAnswer: (payload: any) => void
  onWebRtcIce: (payload: any) => void
  onTransferManifest: (payload: any) => void
  onTransferAccepted: (payload: any) => void
  onTransferComplete: (payload: any) => void
  onTransferCancel: (payload: any) => void
  onResumeRequest: (payload: any) => void
  onResumeResponse: (payload: any) => void
  onE2ERelay: (payload: { from: string; to: string; data: any }) => void
  onSignalingError: (payload: { code: string; message: string }) => void
}

export class FluxDropSignaling {
  private socket: Socket | null = null
  private callbacks: SignalingCallbacks
  private roomId: string | null = null
  // v1.1: identity needed to rebind into the room after a socket reconnect
  // (every reconnect gets a new socket.id, and the server cleans up the old
  // socket's membership on disconnect).
  private rejoinCtx: { deviceId: string; alias?: string; role?: 'sender' | 'receiver'; pin?: string } | null = null

  constructor(callbacks: SignalingCallbacks) {
    this.callbacks = callbacks
  }

  connect(): void {
    if (this.socket?.connected) return
    this.socket = io(`/?XTransformPort=${SIGNALING_PORT}`, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 15000,
    })

    const s = this.socket
    s.on('connect', () => {
      this.callbacks.onConnect()
      // v1.1: rebind into the room after ANY (re)connection — without this a
      // transient signaling blip permanently orphaned in-flight transfers
      // (offers/ICE relays silently failed server-side membership checks).
      if (this.roomId && this.rejoinCtx) {
        s.emit('rejoin-room', { roomId: this.roomId, ...this.rejoinCtx })
      }
    })
    s.on('disconnect', () => this.callbacks.onDisconnect())
    s.on('connect_error', (err: Error) => this.callbacks.onConnectError(err))

    s.on(SIGNALING_EVENTS.ROOM_CREATED, (p) => this.callbacks.onRoomCreated(p))
    s.on(SIGNALING_EVENTS.ROOM_JOINED, (p) => this.callbacks.onRoomJoined(p))
    s.on(SIGNALING_EVENTS.ROOM_EXPIRED, (p) => this.callbacks.onRoomExpired(p))
    s.on(SIGNALING_EVENTS.ROOM_CLOSED, (p) => this.callbacks.onRoomClosed(p))
    s.on(SIGNALING_EVENTS.DEVICE_DISCOVERED, (p) => this.callbacks.onDeviceDiscovered(p))
    s.on(SIGNALING_EVENTS.DEVICE_LEFT, (p) => this.callbacks.onDeviceLeft(p))
    s.on(SIGNALING_EVENTS.PAIRING_REQUEST, (p) => this.callbacks.onPairingRequest(p))
    s.on(SIGNALING_EVENTS.PAIRING_CONFIRM, (p) => this.callbacks.onPairingConfirm(p))
    s.on(SIGNALING_EVENTS.PAIRING_REJECT, (p) => this.callbacks.onPairingReject(p))
    s.on(SIGNALING_EVENTS.WEBRTC_OFFER, (p) => this.callbacks.onWebRtcOffer(p))
    s.on(SIGNALING_EVENTS.WEBRTC_ANSWER, (p) => this.callbacks.onWebRtcAnswer(p))
    s.on(SIGNALING_EVENTS.WEBRTC_ICE, (p) => this.callbacks.onWebRtcIce(p))
    s.on(SIGNALING_EVENTS.TRANSFER_MANIFEST, (p) => this.callbacks.onTransferManifest(p))
    s.on(SIGNALING_EVENTS.TRANSFER_ACCEPTED, (p) => this.callbacks.onTransferAccepted(p))
    s.on(SIGNALING_EVENTS.TRANSFER_COMPLETE, (p) => this.callbacks.onTransferComplete(p))
    s.on(SIGNALING_EVENTS.TRANSFER_CANCEL, (p) => this.callbacks.onTransferCancel(p))
    s.on(SIGNALING_EVENTS.RESUME_REQUEST, (p) => this.callbacks.onResumeRequest(p))
    s.on(SIGNALING_EVENTS.RESUME_RESPONSE, (p) => this.callbacks.onResumeResponse(p))
    s.on(SIGNALING_EVENTS.E2E_RELAY, (p) => this.callbacks.onE2ERelay(p))
    s.on(SIGNALING_EVENTS.SIGNALING_ERROR, (p) => this.callbacks.onSignalingError(p))
  }

  get isConnected(): boolean {
    return !!this.socket?.connected
  }

  /**
   * Resolves once the socket is actually connected (or immediately if it
   * already is). Falls back to resolving after `timeoutMs` so callers never
   * hang — socket.io buffers emits sent while disconnected, so emitting
   * after the fallback is still safe, just potentially delayed.
   *
   * This eliminates the createRoom/joinRoom race where a blind 300ms delay
   * wasn't enough on a cold connect (deep links were observed to miss).
   */
  waitUntilConnected(timeoutMs = 8000): Promise<void> {
    const s = this.socket
    if (!s || s.connected) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        s.off('connect', done)
        s.off('connect_error', fail)
        resolve()
      }
      const fail = () => {
        // A connection attempt failed — socket.io will retry (reconnection:
        // true). Don't wait for `connect` exclusively; keep the timeout as a
        // safety net but don't resolve early on transient errors.
      }
      const timer = setTimeout(done, timeoutMs)
      s.on('connect', done)
      s.on('connect_error', fail)
    })
  }

  get currentRoomId(): string | null {
    return this.roomId
  }

  setRoomId(
    roomId: string | null,
    rejoin?: { deviceId: string; alias?: string; role?: 'sender' | 'receiver'; pin?: string }
  ) {
    this.roomId = roomId
    if (rejoin) this.rejoinCtx = rejoin
    if (!roomId) this.rejoinCtx = null
  }

  // === Emit helpers ===
  createRoom(payload: { alias: string; deviceId: string; role: 'sender' | 'receiver'; withPin?: boolean }) {
    this.socket?.emit(SIGNALING_EVENTS.CREATE_ROOM, payload)
  }

  joinRoom(payload: { roomId: string; joinCode?: string; pin?: string; alias: string; deviceId: string; role: 'sender' | 'receiver' }) {
    this.socket?.emit(SIGNALING_EVENTS.JOIN_ROOM, payload)
  }

  sendPairingRequest(payload: { roomId: string; from: string; to: string; transferSummary?: any }) {
    this.socket?.emit(SIGNALING_EVENTS.PAIRING_REQUEST, payload)
  }

  sendPairingConfirm(payload: { roomId: string; from: string; to: string; accepted: boolean }) {
    this.socket?.emit(SIGNALING_EVENTS.PAIRING_CONFIRM, payload)
  }

  sendPairingReject(payload: { roomId: string; from: string; to: string; reason?: string }) {
    this.socket?.emit(SIGNALING_EVENTS.PAIRING_REJECT, payload)
  }

  sendOffer(payload: { roomId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }) {
    this.socket?.emit(SIGNALING_EVENTS.WEBRTC_OFFER, payload)
  }

  sendAnswer(payload: { roomId: string; from: string; to: string; sdp: RTCSessionDescriptionInit }) {
    this.socket?.emit(SIGNALING_EVENTS.WEBRTC_ANSWER, payload)
  }

  sendIce(payload: { roomId: string; from: string; to: string; candidate: RTCIceCandidateInit }) {
    this.socket?.emit(SIGNALING_EVENTS.WEBRTC_ICE, payload)
  }

  sendTransferManifest(payload: { roomId: string; from: string; to: string; manifest: any }) {
    this.socket?.emit(SIGNALING_EVENTS.TRANSFER_MANIFEST, payload)
  }

  sendTransferAccepted(payload: { roomId: string; from: string; to: string; accepted: boolean; reason?: string }) {
    this.socket?.emit(SIGNALING_EVENTS.TRANSFER_ACCEPTED, payload)
  }

  sendTransferComplete(payload: { roomId: string; from: string; to: string }) {
    this.socket?.emit(SIGNALING_EVENTS.TRANSFER_COMPLETE, payload)
  }

  sendTransferCancel(payload: { roomId: string; from: string; to: string; reason?: string }) {
    this.socket?.emit(SIGNALING_EVENTS.TRANSFER_CANCEL, payload)
  }

  sendResumeRequest(payload: { roomId: string; from: string; to: string; transferId: string; lastChunkIndex: number }) {
    this.socket?.emit(SIGNALING_EVENTS.RESUME_REQUEST, payload)
  }

  sendResumeResponse(payload: { roomId: string; from: string; to: string; transferId: string; accepted: boolean; fromChunkIndex?: number }) {
    this.socket?.emit(SIGNALING_EVENTS.RESUME_RESPONSE, payload)
  }

  heartbeat(roomId: string) {
    this.socket?.emit(SIGNALING_EVENTS.HEARTBEAT, { roomId })
  }

  /**
   * v1.2: relay an opaque E2E (PAKE) handshake message to the room peer.
   * The server membership-checks and forwards without looking inside.
   */
  sendE2ERelay(payload: { roomId: string; from: string; to: string; data: unknown }) {
    this.socket?.emit(SIGNALING_EVENTS.E2E_RELAY, payload)
  }

  leaveRoom() {
    this.socket?.emit(SIGNALING_EVENTS.LEAVE_ROOM)
  }

  disconnect() {
    this.socket?.disconnect()
    this.socket = null
  }
}
