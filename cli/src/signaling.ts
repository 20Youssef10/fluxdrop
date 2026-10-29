// FluxDrop CLI — socket.io signaling client.
//
// Thin typed wrapper around socket.io-client speaking the FluxDrop signaling
// contract (docs/protocol-spec.md §9): rooms, PINs, pairing and the
// webrtc-offer/answer/ice relays. The server never touches file data.

import { io, type Socket } from 'socket.io-client'
import { SIGNALING_EVENTS } from './proto'

/** Normalize ws:// / wss:// / http(s):// input into a URL socket.io accepts. */
export function normalizeSignalUrl(url: string): string {
  let u = url.trim()
  if (u.startsWith('ws://')) u = 'http://' + u.slice('ws://'.length)
  else if (u.startsWith('wss://')) u = 'https://' + u.slice('wss://'.length)
  return u.replace(/\/+$/, '')
}

export interface DeviceInfo {
  id: string
  socketId?: string
  alias: string
  role: 'sender' | 'receiver'
  joinedAt?: number
}

export interface SdpPayload {
  roomId: string
  from: string
  to: string
  sdp: { type: string; sdp: string }
}

export interface IcePayload {
  roomId: string
  from: string
  to: string
  candidate: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }
}

export interface SignalingHandlers {
  onDeviceDiscovered?: (payload: { device: DeviceInfo }) => void
  onDeviceLeft?: (payload: { deviceId: string }) => void
  onRoomExpired?: (payload: { roomId: string; reason: string }) => void
  onRoomClosed?: (payload: { roomId: string }) => void
  onOffer?: (payload: SdpPayload) => void
  onAnswer?: (payload: SdpPayload) => void
  onIce?: (payload: IcePayload) => void
  onPairingRequest?: (payload: { from: string; to: string; transferSummary?: unknown }) => void
  onDisconnect?: (reason: string) => void
}

export class SignalingError extends Error {
  constructor(public code: string, message: string) {
    super(`signaling error ${code}: ${message}`)
    this.name = 'SignalingError'
  }
}

export class Signaling {
  private socket: Socket
  private roomId: string | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private handlers: SignalingHandlers = {}
  /** Resolves on room-created / rejects on signaling-error. */
  private pendingRoom: {
    resolve: (v: { roomId: string; joinCode: string; pin?: string; qrData: string; device: DeviceInfo }) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private pendingJoin: {
    resolve: (v: { roomId: string; joinCode: string; device: DeviceInfo; peers: DeviceInfo[] }) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(private url: string, private alias: string, private deviceId: string) {
    this.socket = io(normalizeSignalUrl(url), {
      path: '/socket.io',
      reconnectionAttempts: 3,
      reconnectionDelay: 1000,
      timeout: 10_000,
    })
    this.wire()
  }

  setHandlers(handlers: SignalingHandlers): void {
    this.handlers = handlers
  }

  private wire(): void {
    const s = this.socket
    const E = SIGNALING_EVENTS
    s.on('connect_error', (err: Error) => {
      // surface but let reconnection retries continue
      process.stderr.write(`[signal] connection error: ${err.message}\n`)
    })
    s.on('disconnect', (reason: string) => this.handlers.onDisconnect?.(reason))
    s.on(E.ROOM_CREATED, (payload: { roomId: string; joinCode: string; pin?: string; qrData: string; device: DeviceInfo }) => {
      this.roomId = payload.roomId
      this.startHeartbeat()
      if (this.pendingRoom) {
        clearTimeout(this.pendingRoom.timer)
        this.pendingRoom.resolve(payload)
        this.pendingRoom = null
      }
    })
    s.on(E.ROOM_JOINED, (payload: { roomId: string; joinCode: string; device: DeviceInfo; peers: DeviceInfo[] }) => {
      this.roomId = payload.roomId
      this.startHeartbeat()
      if (this.pendingJoin) {
        clearTimeout(this.pendingJoin.timer)
        this.pendingJoin.resolve(payload)
        this.pendingJoin = null
      }
    })
    s.on(E.DEVICE_DISCOVERED, (p: { device: DeviceInfo }) => this.handlers.onDeviceDiscovered?.(p))
    s.on(E.DEVICE_LEFT, (p: { deviceId: string }) => this.handlers.onDeviceLeft?.(p))
    s.on(E.ROOM_EXPIRED, (p: { roomId: string; reason: string }) => this.handlers.onRoomExpired?.(p))
    s.on(E.ROOM_CLOSED, (p: { roomId: string }) => this.handlers.onRoomClosed?.(p))
    s.on(E.WEBRTC_OFFER, (p: SdpPayload) => this.handlers.onOffer?.(p))
    s.on(E.WEBRTC_ANSWER, (p: SdpPayload) => this.handlers.onAnswer?.(p))
    s.on(E.WEBRTC_ICE, (p: IcePayload) => this.handlers.onIce?.(p))
    s.on(E.PAIRING_REQUEST, (p: { from: string; to: string; transferSummary?: unknown }) => this.handlers.onPairingRequest?.(p))
    s.on(E.SIGNALING_ERROR, (p: { code: string; message: string }) => {
      const err = new SignalingError(p.code, p.message)
      if (this.pendingRoom) {
        clearTimeout(this.pendingRoom.timer)
        this.pendingRoom.reject(err)
        this.pendingRoom = null
      } else if (this.pendingJoin) {
        clearTimeout(this.pendingJoin.timer)
        this.pendingJoin.reject(err)
        this.pendingJoin = null
      } else {
        process.stderr.write(`[signal] ${err.message}\n`)
      }
    })
  }

  /** Wait for the socket.io connection (throws after `timeoutMs`). */
  connect(timeoutMs = 10_000): Promise<void> {
    if (this.socket.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`could not reach signaling server at ${this.url} (timeout)`)), timeoutMs)
      this.socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.once('connect_error', (err: Error) => {
        clearTimeout(timer)
        reject(new Error(`could not reach signaling server at ${this.url}: ${err.message}`))
      })
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || !this.roomId) return
    // Spec §9.4: 30 s cadence keeps lastActivityAt fresh during long
    // DataChannel-only phases.
    this.heartbeatTimer = setInterval(() => {
      if (this.roomId) this.socket.emit(SIGNALING_EVENTS.HEARTBEAT, { roomId: this.roomId })
    }, 30_000)
  }

  createRoom(role: 'sender' | 'receiver', withPin: boolean, timeoutMs = 10_000) {
    return new Promise<{ roomId: string; joinCode: string; pin?: string; qrData: string; device: DeviceInfo }>(
      (resolve, reject) => {
        this.pendingRoom = {
          resolve,
          reject,
          timer: setTimeout(() => {
            this.pendingRoom = null
            reject(new Error('create-room timed out'))
          }, timeoutMs),
        }
        this.socket.emit(SIGNALING_EVENTS.CREATE_ROOM, {
          alias: this.alias,
          deviceId: this.deviceId,
          role,
          withPin,
        })
      }
    )
  }

  joinRoom(roomId: string, pin: string | undefined, timeoutMs = 10_000) {
    return new Promise<{ roomId: string; joinCode: string; device: DeviceInfo; peers: DeviceInfo[] }>(
      (resolve, reject) => {
        this.pendingJoin = {
          resolve,
          reject,
          timer: setTimeout(() => {
            this.pendingJoin = null
            reject(new Error('join-room timed out'))
          }, timeoutMs),
        }
        this.socket.emit(SIGNALING_EVENTS.JOIN_ROOM, {
          roomId: roomId.toUpperCase(),
          pin,
          alias: this.alias,
          deviceId: this.deviceId,
          role: 'receiver' as const,
        })
      }
    )
  }

  sendPairingRequest(to: string, transferSummary?: { fileCount: number; totalSize: number; totalName: string }): void {
    if (!this.roomId) return
    this.socket.emit(SIGNALING_EVENTS.PAIRING_REQUEST, {
      roomId: this.roomId,
      from: this.deviceId,
      to,
      ...(transferSummary ? { transferSummary } : {}),
    })
  }

  sendPairingConfirm(to: string, accepted: boolean): void {
    if (!this.roomId) return
    this.socket.emit(SIGNALING_EVENTS.PAIRING_CONFIRM, { roomId: this.roomId, from: this.deviceId, to, accepted })
  }

  sendOffer(to: string, sdp: { type: string; sdp: string }): void {
    if (!this.roomId) return
    this.socket.emit(SIGNALING_EVENTS.WEBRTC_OFFER, { roomId: this.roomId, from: this.deviceId, to, sdp })
  }

  sendAnswer(to: string, sdp: { type: string; sdp: string }): void {
    if (!this.roomId) return
    this.socket.emit(SIGNALING_EVENTS.WEBRTC_ANSWER, { roomId: this.roomId, from: this.deviceId, to, sdp })
  }

  sendIce(to: string, candidate: string, mid: string): void {
    if (!this.roomId) return
    this.socket.emit(SIGNALING_EVENTS.WEBRTC_ICE, {
      roomId: this.roomId,
      from: this.deviceId,
      to,
      candidate: { candidate, sdpMid: mid },
    })
  }

  sendTransferCancel(reason: string): void {
    if (!this.roomId) return
    this.socket.emit(SIGNALING_EVENTS.TRANSFER_CANCEL, {
      roomId: this.roomId,
      from: this.deviceId,
      to: '*',
      reason,
    })
  }

  leaveRoom(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.socket.emit(SIGNALING_EVENTS.LEAVE_ROOM, {})
    this.socket.disconnect()
  }

  get connected(): boolean {
    return this.socket.connected
  }
}
