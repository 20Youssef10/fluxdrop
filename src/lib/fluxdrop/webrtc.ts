// WebRTC DataChannel management for FluxDrop.
// Handles RTCPeerConnection lifecycle, ICE negotiation, DataChannel setup,
// backpressure-aware chunk sending, and incoming message decoding.

'use client'

import { CONSTANTS, MessageType, HEADER_SIZE } from './protocol'
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
  /** Secondary channels for parallel transfer (speed #8). */
  private secondaryChannels: Map<number, RTCDataChannel> = new Map()
  private numChannels: number = 2 // primary + 1 secondary
  private config: WebRTCConfig
  private isInitiator: boolean
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private negotiatedChunkSize: number = CONSTANTS.CHUNK_SIZE

  /** Get the effective chunk size (negotiated or default). */
  get effectiveChunkSize(): number {
    return this.negotiatedChunkSize || CONSTANTS.CHUNK_SIZE
  }

  /** Get the number of open channels (for parallel sending). */
  get openChannelCount(): number {
    let count = this.channel?.readyState === 'open' ? 1 : 0
    for (const ch of this.secondaryChannels.values()) {
      if (ch.readyState === 'open') count++
    }
    return count
  }

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

    // ICE candidate errors are almost always benign — STUN servers may be
    // unreachable but other candidates succeed. We suppress ALL ICE candidate
    // errors from the error log and toasts. They are still logged to console
    // for debugging if needed.
    this.pc.onicecandidateerror = (event: any) => {
      // Suppress if the connection is already closed (cleanup in progress).
      if (this.pc.connectionState === 'closed') return
      const err = event?.error ?? event
      const reason = err?.message ?? err?.errorCodeText ?? 'unknown'
      // Log to console only — don't surface to error log or toasts.
      console.debug('[FluxDrop] ICE candidate error (benign):', reason)
    }

    this.pc.ondatachannel = (event) => {
      // Non-initiator receives data channels created by the initiator.
      // The primary channel is 'fluxdrop-0', additional channels are 'fluxdrop-1', etc.
      const label = event.channel.label
      if (label === 'fluxdrop-0' || label === 'fluxdrop') {
        this.bindChannel(event.channel)
      } else if (label.startsWith('fluxdrop-')) {
        this.bindSecondaryChannel(event.channel, parseInt(label.split('-')[1]) || 0)
      }
    }

    if (isInitiator) {
      // Initiator creates the primary data channel.
      this.channel = this.pc.createDataChannel('fluxdrop-0', {
        ordered: true,
        negotiated: false,
      })
      this.bindChannel(this.channel)

      // Create secondary channels for parallel transfer (speed #8).
      // Multiple DataChannels on one RTCPeerConnection share one SCTP
      // association and congestion window, so they add limited bandwidth.
      // However, they can reduce per-message queuing and improve utilization.
      // Default: 2 channels (primary + 1 secondary). Configurable via NUM_CHANNELS.
      for (let i = 1; i < this.numChannels; i++) {
        const ch = this.pc.createDataChannel(`fluxdrop-${i}`, { ordered: true })
        this.bindSecondaryChannel(ch, i)
      }
    }
  }

  private bindChannel(channel: RTCDataChannel) {
    this.channel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = CONSTANTS.TARGET_BUFFERED_BYTES

    channel.onopen = () => {
      // Read the negotiated SCTP max message size to use the largest safe chunk.
      // Chromium negotiates well above 64 KB (often 256 KB+), so this cuts
      // message count ~4x without SDP munging.
      const sctp = (this.pc as any).sctp
      if (sctp?.maxMessageSize) {
        // Use 90% of the negotiated max to leave room for the 9-byte header
        // and any overhead. Clamp to [16 KB, 1 MB] for safety.
        const negotiated = sctp.maxMessageSize as number
        this.negotiatedChunkSize = Math.min(
          Math.max(Math.floor(negotiated * 0.9) - HEADER_SIZE, 16 * 1024),
          1024 * 1024
        )
        console.log(`[FluxDrop] Negotiated max-message-size: ${negotiated} bytes, using chunk size: ${this.negotiatedChunkSize}`)
      }
      this.config.onDataChannelOpen()
    }
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

  /** Bind a secondary channel (for parallel transfer). */
  private bindSecondaryChannel(channel: RTCDataChannel, index: number) {
    this.secondaryChannels.set(index, channel)
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = CONSTANTS.TARGET_BUFFERED_BYTES

    channel.onopen = () => {
      console.log(`[FluxDrop] Secondary channel ${index} opened`)
    }
    channel.onclose = () => {
      this.secondaryChannels.delete(index)
    }
    channel.onerror = (e: any) => {
      const err = e?.error ?? e
      console.warn(`[FluxDrop] Secondary channel ${index} error:`, err?.message ?? 'unknown')
    }
    channel.onmessage = (event) => {
      // Secondary channels use the same message handler (for ACKs, etc.)
      if (!(event.data instanceof ArrayBuffer)) return
      try {
        const msg = decodeMessage(event.data)
        this.config.onDataChannelMessage(msg)
      } catch (err: any) {
        console.warn(`[FluxDrop] Failed to decode message on channel ${index}:`, err.message)
      }
    }
  }

  /**
   * Send a chunk on a specific channel (for parallel transfer).
   * Channel 0 = primary, 1+ = secondary.
   */
  sendChunkDataOnChannel(transferId: string, chunkIndex: number, payload: ArrayBuffer, channelIndex: number): boolean {
    let ch: RTCDataChannel | null = null
    if (channelIndex === 0) {
      ch = this.channel
    } else {
      ch = this.secondaryChannels.get(channelIndex) ?? null
    }
    if (!ch || ch.readyState !== 'open') return false
    const msg = encodeChunkData(transferId, chunkIndex, payload)
    try {
      ch.send(msg)
      return true
    } catch (err: any) {
      const errMsg = err.message || ''
      if (errMsg.includes('max-message-size') || errMsg.includes('larger than')) {
        this.config.onError(new Error(
          `Chunk ${chunkIndex} (${msg.byteLength} bytes) exceeds max-message-size.`
        ))
        return false
      }
      if (errMsg.includes('send queue') || errMsg.includes('Failure to send') || errMsg.includes('buffer')) {
        console.warn(`[FluxDrop] Send failed on channel ${channelIndex} for chunk ${chunkIndex}: ${errMsg}`)
        return false
      }
      console.warn(`[FluxDrop] Failed to send chunk ${chunkIndex} on channel ${channelIndex}: ${errMsg}`)
      return false
    }
  }

  /** Check if a specific channel can send (backpressure). */
  canSendOnChannel(channelIndex: number): boolean {
    if (channelIndex === 0) return this.canSend()
    const ch = this.secondaryChannels.get(channelIndex)
    return !!ch && ch.readyState === 'open' && ch.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES
  }

  /** Wait for a specific channel to drain. */
  async waitForDrainOnChannel(channelIndex: number): Promise<void> {
    if (channelIndex === 0) return this.waitForDrain()
    const ch = this.secondaryChannels.get(channelIndex)
    if (!ch) return
    if (ch.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES) return
    await new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        ch.removeEventListener('bufferedamountlow', onLow)
        ch.removeEventListener('close', onClose)
        if (pollId) clearInterval(pollId)
        if (timeoutId) clearTimeout(timeoutId)
        resolve()
      }
      const onLow = () => finish()
      const onClose = () => finish()
      ch.addEventListener('bufferedamountlow', onLow)
      ch.addEventListener('close', onClose)
      const pollId = setInterval(() => {
        if (ch.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES) finish()
      }, 50)
      const timeoutId = setTimeout(finish, 10000)
    })
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
    // Only send when buffer is below the 8 MB target threshold.
    return this.channel.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES
  }

  /**
   * Wait for the DataChannel buffer to drain below the low threshold.
   * Uses the `bufferedamountlow` event with a polling fallback.
   * Properly handles the "send queue is full" error by waiting long enough
   * for the queue to actually empty.
   */
  async waitForDrain(): Promise<void> {
    const channel = this.channel
    if (!channel) return
    if (channel.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES) return

    // Wait for bufferedamountlow event, with polling fallback.
    // The key: poll every 50ms AND listen for the event, whichever fires first.
    await new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        channel.removeEventListener('bufferedamountlow', onLow)
        channel.removeEventListener('close', onClose)
        if (pollId) clearInterval(pollId)
        if (timeoutId) clearTimeout(timeoutId)
        resolve()
      }
      const onLow = () => finish()
      const onClose = () => finish()

      channel.addEventListener('bufferedamountlow', onLow)
      channel.addEventListener('close', onClose)

      // Poll every 50ms — more reliable than just the event in some browsers.
      const pollId = setInterval(() => {
        if (channel.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES) {
          finish()
        }
      }, 50)

      // Safety timeout: 10 seconds (for very slow connections).
      const timeoutId = setTimeout(finish, 10000)
    })
  }

  /**
   * Send a chunk. Returns true on success, false if the channel is closed.
   * If the send fails due to buffer overflow ("Failure to send data"), waits
   * for the buffer to drain and retries once before giving up.
   */
  sendChunkData(transferId: string, chunkIndex: number, payload: ArrayBuffer): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false
    const msg = encodeChunkData(transferId, chunkIndex, payload)
    try {
      this.channel.send(msg)
      return true
    } catch (err: any) {
      const errMsg = err.message || ''
      // Check max-message-size FIRST — Chrome's error message contains "send"
      // ("Failed to execute 'send' on RTCDataChannel"), so the generic "send"
      // check would swallow the real cause.
      if (errMsg.includes('max-message-size') || errMsg.includes('larger than')) {
        this.config.onError(new Error(
          `Chunk ${chunkIndex} (${msg.byteLength} bytes) exceeds max-message-size. ` +
          `Current CHUNK_SIZE: ${CONSTANTS.CHUNK_SIZE} bytes.`
        ))
        return false
      }
      // "send queue is full", "Failure to send data" — transient, retry after drain.
      if (
        errMsg.includes('send queue') ||
        errMsg.includes('Failure to send') ||
        errMsg.includes('buffer')
      ) {
        console.warn(`[FluxDrop] Send failed for chunk ${chunkIndex}, will retry after drain: ${errMsg}`)
        return false
      }
      // Unknown error — log but don't spam the error log.
      console.warn(`[FluxDrop] Failed to send chunk ${chunkIndex}: ${errMsg}`)
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

  /** Ask the peer to pause streaming (flow control). Uses the PAUSE opcode. */
  sendPause(transferId: string): void {
    this.sendControl(MessageType.PAUSE, transferId, 0, { paused: true })
  }

  /** Tell the peer to continue streaming. Uses the RESUME_STREAM opcode. */
  sendResumeStream(transferId: string): void {
    this.sendControl(MessageType.RESUME_STREAM, transferId, 0, { paused: false })
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
    // Close primary channel.
    if (this.channel) {
      this.channel.onopen = null
      this.channel.onclose = null
      this.channel.onerror = null
      this.channel.onmessage = null
      try { this.channel.close() } catch { /* noop */ }
      this.channel = null
    }
    // Close secondary channels.
    for (const [idx, ch] of this.secondaryChannels) {
      ch.onopen = null
      ch.onclose = null
      ch.onerror = null
      ch.onmessage = null
      try { ch.close() } catch { /* noop */ }
    }
    this.secondaryChannels.clear()
    // Close peer connection.
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
