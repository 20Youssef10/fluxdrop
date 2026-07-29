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
  onSignalingError: (payload: { code: string; message: string }) => void
}

export class FluxDropSignaling {
  private socket: Socket | null = null
  private callbacks: SignalingCallbacks
  private roomId: string | null = null

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
    s.on('connect', () => this.callbacks.onConnect())
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
    s.on(SIGNALING_EVENTS.SIGNALING_ERROR, (p) => this.callbacks.onSignalingError(p))
  }

  get isConnected(): boolean {
    return !!this.socket?.connected
  }

  get currentRoomId(): string | null {
    return this.roomId
  }

  setRoomId(roomId: string | null) {
    this.roomId = roomId
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

  leaveRoom() {
    this.socket?.emit(SIGNALING_EVENTS.LEAVE_ROOM)
  }

  disconnect() {
    this.socket?.disconnect()
    this.socket = null
  }
}
