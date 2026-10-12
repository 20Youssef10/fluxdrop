// WebRTC DataChannel management for FluxDrop.
// Handles RTCPeerConnection lifecycle, ICE negotiation, DataChannel setup,
// backpressure-aware chunk sending, and incoming message decoding.

'use client'

import { CONSTANTS, MessageType } from './protocol'
import {
  encodeChunkData,
  encodeChunkAck,
  encodeControlMessage,
  decodeMessage,
  type DecodedMessage,
} from './encoding'

type IceCandidateHandler = (candidate: RTCIceCandidateInit) => void
type SdpHandler = (sdp: RTCSessionDescriptionInit) => void
type StateHandler = (state: RTCPeerConnectionState) => void
type MessageHandler = (msg: DecodedMessage) => void

export interface WebRTCConfig {
  onIceCandidate: IceCandidateHandler
  onRemoteSdp?: SdpHandler
  onConnectionStateChange: StateHandler
  onIceGatheringStateChange?: (state: RTCIceGatheringState) => void
  onIceConnectionStateChange?: (state: RTCIceConnectionState) => void
  onDataChannelOpen: () => void
  onDataChannelClose: () => void
  onDataChannelMessage: MessageHandler
  onError: (err: Error) => void
  /** STUN servers; defaults to a small set of public STUN. */
  iceServers?: RTCIceServer[]
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

export class FluxDropWebRTC {
  private pc: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private config: WebRTCConfig
  private isInitiator: boolean
  /** Queue of ICE candidates that arrived before setRemoteDescription. */
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false

  constructor(config: WebRTCConfig, isInitiator: boolean) {
    this.config = config
    this.isInitiator = isInitiator
    this.pc = new RTCPeerConnection({
      iceServers: config.iceServers ?? DEFAULT_ICE,
      iceTransportPolicy: 'all',
    })

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.config.onIceCandidate(event.candidate.toJSON())
      }
    }

    this.pc.onicegatheringstatechange = () => {
      this.config.onIceGatheringStateChange?.(this.pc.iceGatheringState)
    }

    this.pc.oniceconnectionstatechange = () => {
      this.config.onIceConnectionStateChange?.(this.pc.iceConnectionState)
    }

    this.pc.onconnectionstatechange = () => {
      this.config.onConnectionStateChange(this.pc.connectionState)
    }

    // Surface ICE candidate gathering errors (e.g. STUN unreachable).
    // Note: Some ICE candidate errors are benign (e.g. a STUN server is
    // unreachable but another candidate succeeds). Only surface genuinely
    // actionable errors, and suppress errors that occur after close().
    this.pc.onicecandidateerror = (event: any) => {
      // Suppress if the connection is already closed (cleanup in progress).
      if (this.pc.connectionState === 'closed') return
      const err = event?.error ?? event
      const reason = err?.message ?? err?.errorCodeText ?? 'unknown'
      // Don't surface "User-initiated Abort" — this happens when close() is
      // called during ICE gathering (normal cleanup/retry).
      if (reason.includes('Abort') || reason.includes('close')) return
      this.config.onError(new Error(`ICE candidate error: ${reason}`))
    }

    this.pc.ondatachannel = (event) => {
      // Non-initiator receives the data channel created by the initiator.
      this.bindChannel(event.channel)
    }

    if (isInitiator) {
      // Initiator creates the data channel.
      this.channel = this.pc.createDataChannel('fluxdrop', {
        ordered: true,
        negotiated: false,
      })
      this.bindChannel(this.channel)
    }
  }

  private bindChannel(channel: RTCDataChannel) {
    this.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = CONSTANTS.TARGET_BUFFERED_BYTES

    channel.onopen = () => this.config.onDataChannelOpen()
    channel.onclose = () => this.config.onDataChannelClose()
    channel.onerror = (e: any) => {
      // RTCErrorEvent stores the actual Error on `e.error`, not `e.message`.
      const err = e?.error ?? e
      this.config.onError(new Error(err?.message ?? 'DataChannel error'))
    }
    channel.onmessage = (event) => {
      // Guard against non-ArrayBuffer messages (strings, Blobs).
      if (!(event.data instanceof ArrayBuffer)) {
        this.config.onError(new Error(`Unexpected DataChannel message type: ${typeof event.data}`))
        return
      }
      // Wrap decode in try/catch so a malformed frame doesn't kill the channel.
      try {
        const msg = decodeMessage(event.data)
        this.config.onDataChannelMessage(msg)
      } catch (err: any) {
        this.config.onError(new Error(`Failed to decode message: ${err.message}`))
      }
    }
  }

  // === SDP flow ===
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    return offer
  }

  async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer)
    this.remoteDescriptionSet = true
    // Flush any ICE candidates that arrived before the offer.
    await this.flushPendingCandidates()
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    return answer
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer)
    this.remoteDescriptionSet = true
    await this.flushPendingCandidates()
  }

  /** Apply any ICE candidates that were queued before setRemoteDescription. */
  private async flushPendingCandidates(): Promise<void> {
    if (this.pendingCandidates.length === 0) return
    const queued = this.pendingCandidates.splice(0)
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate)
      } catch (err: any) {
        this.config.onError(new Error(`Failed to apply queued ICE candidate: ${err.message}`))
      }
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    // If remote description isn't set yet, queue the candidate for later.
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate)
      return
    }
    try {
      await this.pc.addIceCandidate(candidate)
    } catch (err: any) {
      // Distinguish "no remote description" (shouldn't happen due to queue) from genuine errors.
      if (err?.name === 'InvalidStateError') {
        this.pendingCandidates.push(candidate)
      } else {
        this.config.onError(new Error(`Failed to add ICE candidate: ${err.message}`))
      }
    }
  }

  // === Backpressure-aware chunk sending ===
  canSend(): boolean {
    if (!this.channel) return false
    // Target: soft threshold for flow control.
    // Hard guard: never exceed MAX_BUFFERED_BYTES to avoid unbounded buffering.
    return (
      this.channel.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES &&
      this.channel.bufferedAmount < CONSTANTS.MAX_BUFFERED_BYTES
    )
  }

  async waitForDrain(): Promise<void> {
    const channel = this.channel
    if (!channel) return
    if (channel.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES) return
    await new Promise<void>((resolve) => {
      let resolved = false
      const cleanup = () => {
        if (resolved) return
        resolved = true
        channel.removeEventListener('bufferedamountlow', onLow)
        channel.removeEventListener('close', onClose)
        if (timerId) clearTimeout(timerId)
        resolve()
      }
      const onLow = () => cleanup()
      const onClose = () => cleanup()
      channel.addEventListener('bufferedamountlow', onLow)
      channel.addEventListener('close', onClose)
      // Safety timeout: 500ms is enough — the browser flushes the buffer quickly.
      // 2s was too long and stalled the pipeline on every backpressure event.
      const timerId = setTimeout(cleanup, 500)
    })
  }

  /**
   * Send a chunk. Returns true on success, false if the channel is closed
   * or the send throws (e.g. buffer overflow, message too large).
   */
  sendChunkData(transferId: string, chunkIndex: number, payload: ArrayBuffer): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false
    try {
      const msg = encodeChunkData(transferId, chunkIndex, payload)
      // Safety check: if the encoded message exceeds a safe size, log a warning.
      // The chunk size should be 16 KB which is safe for all browsers, but
      // if someone changes the constant, this catches it before the send throws.
      if (msg.byteLength > 256 * 1024) {
        console.warn(`[FluxDrop] Chunk ${chunkIndex} is ${msg.byteLength} bytes — may exceed browser max-message-size. Consider reducing CHUNK_SIZE.`)
      }
      this.channel.send(msg)
      return true
    } catch (err: any) {
      // "Trying to send message larger than max-message-size" — this means
      // the chunk size exceeds the browser's negotiated SCTP max message size.
      // This should not happen with the 16 KB default, but if it does, surface
      // a clear error message.
      const msg = err.message || ''
      if (msg.includes('max-message-size') || msg.includes('larger than')) {
        this.config.onError(new Error(
          `Chunk ${chunkIndex} (${payload.byteLength + 9} bytes) exceeds browser max-message-size. ` +
          `Reduce CHUNK_SIZE in protocol.ts (current: ${CONSTANTS.CHUNK_SIZE} bytes).`
        ))
      } else {
        this.config.onError(new Error(`Failed to send chunk ${chunkIndex}: ${msg}`))
      }
      return false
    }
  }

  /**
   * Safely send a control message. Silently returns if the channel is not open.
   */
  private sendControl(type: number, transferId: string, chunkIndex: number, body: unknown): void {
    if (!this.channel || this.channel.readyState !== 'open') return
    try {
      const msg = encodeControlMessage(type, transferId, chunkIndex, body)
      this.channel.send(msg)
    } catch (err: any) {
      this.config.onError(new Error(`Failed to send control message (type ${type}): ${err.message}`))
    }
  }

  sendChunkAck(transferId: string, chunkIndex: number, ok: boolean): void {
    if (!this.channel || this.channel.readyState !== 'open') return
    try {
      const msg = encodeChunkAck(transferId, chunkIndex, ok)
      this.channel.send(msg)
    } catch (err: any) {
      this.config.onError(new Error(`Failed to send chunk ack: ${err.message}`))
    }
  }

  sendManifest(transferId: string, manifest: unknown): void {
    this.sendControl(MessageType.MANIFEST, transferId, 0, manifest)
  }

  sendManifestAck(transferId: string, accepted: boolean, reason?: string): void {
    this.sendControl(MessageType.MANIFEST_ACK, transferId, 0, { accepted, reason })
  }

  sendTransferComplete(transferId: string, finalChecksum: string): void {
    this.sendControl(MessageType.TRANSFER_COMPLETE, transferId, 0, { finalChecksum })
  }

  sendTransferCompleteAck(transferId: string, verified: boolean): void {
    this.sendControl(MessageType.TRANSFER_COMPLETE_ACK, transferId, 0, { verified })
  }

  sendCancel(transferId: string, reason: string): void {
    this.sendControl(MessageType.TRANSFER_CANCEL, transferId, 0, { reason })
  }

  sendResumeRequest(transferId: string, lastChunkIndex: number): void {
    this.sendControl(MessageType.RESUME_REQUEST, transferId, lastChunkIndex, { lastChunkIndex })
  }

  sendResumeResponse(transferId: string, accepted: boolean, fromChunkIndex: number): void {
    this.sendControl(MessageType.RESUME_RESPONSE, transferId, fromChunkIndex, { accepted, fromChunkIndex })
  }

  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState
  }

  get iceGatheringState(): RTCIceGatheringState {
    return this.pc.iceGatheringState
  }

  get iceConnectionState(): RTCIceConnectionState {
    return this.pc.iceConnectionState
  }

  get isOpen(): boolean {
    return this.channel?.readyState === 'open'
  }

  /** Fetch the selected candidate pair + transport stats. */
  async getStats(): Promise<{
    selectedPair?: {
      localCandidateType?: string
      localAddress?: string
      localPort?: number
      remoteCandidateType?: string
      remoteAddress?: string
      remotePort?: number
      protocol?: string
      currentRoundTripTime?: number
      bytesSent?: number
      bytesReceived?: number
      requestsSent?: number
      requestsReceived?: number
      nominated?: boolean
    }
    bytesSent: number
    bytesReceived: number
  }> {
    try {
      const rawStats = await this.pc.getStats()
      let bytesSent = 0
      let bytesReceived = 0
      let selectedPair: any = undefined

      rawStats.forEach((report: any) => {
        if (report.type === 'transport' && report.bytesSent != null) {
          bytesSent = report.bytesSent ?? 0
          bytesReceived = report.bytesReceived ?? 0
        }
        if (report.type === 'candidate-pair' && (report.selected === true || report.nominated === true)) {
          const local = rawStats.get(report.localCandidateId)
          const remote = rawStats.get(report.remoteCandidateId)
          selectedPair = {
            localCandidateType: local?.candidateType,
            localAddress: local?.address,
            localPort: local?.port,
            remoteCandidateType: remote?.candidateType,
            remoteAddress: remote?.address,
            remotePort: remote?.port,
            protocol: local?.protocol,
            currentRoundTripTime: report.currentRoundTripTime,
            bytesSent: report.bytesSent,
            bytesReceived: report.bytesReceived,
            requestsSent: report.requestsSent,
            requestsReceived: report.requestsReceived,
            nominated: report.nominated,
          }
        }
      })

      return { selectedPair, bytesSent, bytesReceived }
    } catch {
      return { bytesSent: 0, bytesReceived: 0 }
    }
  }

  close(): void {
    // Null out handlers to prevent stale callbacks during retry/reconnect.
    if (this.channel) {
      this.channel.onopen = null
      this.channel.onclose = null
      this.channel.onerror = null
      this.channel.onmessage = null
      try { this.channel.close() } catch { /* noop */ }
      this.channel = null
    }
    this.pc.onicecandidate = null
    this.pc.onicegatheringstatechange = null
    this.pc.oniceconnectionstatechange = null
    this.pc.onconnectionstatechange = null
    this.pc.onicecandidateerror = null
    this.pc.ondatachannel = null
    try { this.pc.close() } catch { /* noop */ }
    this.pendingCandidates = []
  }
}
