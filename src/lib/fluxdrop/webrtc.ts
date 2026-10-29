// WebRTC DataChannel management for FluxDrop.
// Handles RTCPeerConnection lifecycle, ICE negotiation, DataChannel setup,
// backpressure-aware chunk sending, and incoming message decoding.

'use client'

import { CONSTANTS, MessageType, HEADER_SIZE, type TransportClass } from './protocol'
import { recordDatachannelBytes, recordIceCandidate } from './telemetry'
import { usePrefsStore } from './prefs'
import {
  encodeChunkData,
  encodeChunkAck,
  encodeControlMessage,
  decodeMessage,
  transferIdToBytes,
  type ChunkEncodeOpts,
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

/**
 * Extract the o= (origin) line from an SDP. Stable across ICE restarts on the
 * same RTCPeerConnection (only ice-ufrag/pwd change); different for offers
 * produced by a brand-new PC. The receiver uses this to decide whether an
 * incoming offer should be answered in place (transport kept) or treated as a
 * full reconnect (fresh PC).
 */
export function sdpOrigin(sdp: string): string | null {
  if (!sdp) return null
  const line = sdp.split(/\r?\n/).find((l) => l.startsWith('o='))
  return line ?? null
}

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
  // True while an ICE-restart offer is being prepared (guards re-entry and
  // lets callers skip recovery paths that would collide with the restart).
  private iceRestartInFlight: boolean = false

  // --- v1.1 adaptive flow window (AIMD) ---
  // The in-flight byte budget on the SEND path. Grows while sends are clean,
  // halves under send-queue pressure. Replaces the old fixed 8 MB threshold
  // everywhere backpressure is checked.
  private flowWindow: number = CONSTANTS.FLOW_WINDOW_DEFAULT
  private cleanSends: number = 0

  // --- v4 (1.3) QoS pacing: sender-side bandwidth cap ---
  // Token-bucket rate limiter: tokens refill at qosCapBytesPerSec; a send
  // needs tokens ≥ chunk size. The flow window is also clamped to ~0.5 s of
  // capped data so AIMD growth doesn't fight the pacer. null = unlimited.
  private qosCapBytesPerSec: number | null = null
  private qosTokens: number = 0
  private qosLastRefill: number = 0

  /**
   * v4 (1.3): cap the send rate ("polite mode" QoS slider). Pass 0/null to
   * lift the cap. Takes effect immediately on live transfers.
   */
  setQosCapMbps(mbps: number | null): void {
    const mbpsNum = typeof mbps === 'number' && mbps > 0 ? mbps : null
    this.qosCapBytesPerSec = mbpsNum ? mbpsNum * 125_000 : null
    if (this.qosCapBytesPerSec) {
      const burst = this.qosBurst()
      this.qosTokens = burst
      this.qosLastRefill = performance.now()
      // Clamp the AIMD window to the burst size — the pacer is the boss now.
      if (this.flowWindow > burst) {
        this.flowWindow = burst
        this.cleanSends = 0
        this.applyWindowThreshold()
      }
      console.log(`[FluxDrop] QoS cap set to ${mbpsNum} Mbit/s (window ${ (burst / 1024 / 1024).toFixed(2) } MB)`)
    } else {
      this.qosTokens = 0
    }
  }

  get qosCapMbps(): number | null {
    return this.qosCapBytesPerSec ? this.qosCapBytesPerSec / 125_000 : null
  }

  /** Token bucket capacity: half a second of capped data (≥ 1 chunk). */
  private qosBurst(): number {
    if (!this.qosCapBytesPerSec) return Infinity
    return Math.max(this.qosCapBytesPerSec / 2, CONSTANTS.CHUNK_SIZE)
  }

  private refillQosTokens(): void {
    if (!this.qosCapBytesPerSec) return
    const now = performance.now()
    const elapsed = (now - this.qosLastRefill) / 1000
    if (elapsed <= 0) return
    this.qosLastRefill = now
    this.qosTokens = Math.min(this.qosBurst(), this.qosTokens + elapsed * this.qosCapBytesPerSec)
  }

  private qosAllowsSend(): boolean {
    if (!this.qosCapBytesPerSec) return true
    this.refillQosTokens()
    return this.qosTokens >= CONSTANTS.CHUNK_SIZE
  }

  private qosConsume(n: number): void {
    if (!this.qosCapBytesPerSec) return
    this.refillQosTokens()
    this.qosTokens = Math.max(0, this.qosTokens - n)
  }

  /** Current adaptive flow window (bytes). */
  get flowWindowBytes(): number {
    return this.flowWindow
  }

  /** Seed the window from the transport class (call once after DC opens). */
  seedFlowWindow(transport: TransportClass): void {
    this.flowWindow =
      transport === 'lan' ? CONSTANTS.FLOW_WINDOW_LAN
      : transport === 'relayed' ? CONSTANTS.FLOW_WINDOW_RELAYED
      : CONSTANTS.FLOW_WINDOW_DEFAULT
    this.cleanSends = 0
    this.applyWindowThreshold()
    console.log(`[FluxDrop] Flow window seeded to ${(this.flowWindow / (1024 * 1024)).toFixed(1)} MB (${transport})`)
  }

  /** Push the current window into the channel low-water thresholds. */
  private applyWindowThreshold(): void {
    const low = Math.max(this.flowWindow / 4, 64 * 1024)
    if (this.channel) this.channel.bufferedAmountLowThreshold = low
    for (const ch of this.secondaryChannels.values()) {
      ch.bufferedAmountLowThreshold = low
    }
  }

  /** AIMD: send-queue pressure → halve the window (floored). */
  noteSendStall(): void {
    const next = Math.max(
      Math.floor(this.flowWindow * CONSTANTS.FLOW_WINDOW_SHRINK_FACTOR),
      CONSTANTS.FLOW_WINDOW_MIN
    )
    if (next !== this.flowWindow) {
      this.flowWindow = next
      this.cleanSends = 0
      this.applyWindowThreshold()
      console.log(`[FluxDrop] Flow window shrunk to ${(this.flowWindow / (1024 * 1024)).toFixed(1)} MB (send pressure)`)
    }
  }

  /** AIMD: clean send → grow slowly after a streak (capped at MAX_BUFFERED,
   * and never beyond the QoS burst when a cap is active). */
  private noteSendOk(): void {
    this.cleanSends++
    if (this.cleanSends >= CONSTANTS.FLOW_WINDOW_CLEAN_STREAK) {
      this.cleanSends = 0
      const next = Math.min(
        Math.floor(this.flowWindow * CONSTANTS.FLOW_WINDOW_GROW_FACTOR),
        CONSTANTS.MAX_BUFFERED_BYTES,
        this.qosBurst()
      )
      if (next !== this.flowWindow) {
        this.flowWindow = next
        this.applyWindowThreshold()
      }
    }
  }

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
    // v4 (1.3): a live QoS cap from Settings applies to every NEW transport
    // too (the prefs subscribe-effect in use-fluxdrop handles live changes).
    try {
      const cap = usePrefsStore.getState().qosCapMbps
      if (cap > 0) this.setQosCapMbps(cap)
    } catch { /* prefs unavailable — uncapped */ }

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        // v4 (2.6/3.5): transparency + IPv6 availability tracking.
        try { recordIceCandidate(event.candidate.toJSON(), 'local') } catch { /* ignore */ }
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
      // A settled restart (success or definitive failure) frees the guard so
      // the next recovery rung may run.
      const st = this.pc.connectionState
      if (st === 'connected' || st === 'failed' || st === 'closed') {
        this.iceRestartInFlight = false
      }
      this.config.onConnectionStateChange(st)
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
    channel.bufferedAmountLowThreshold = Math.max(this.flowWindow / 4, 64 * 1024)

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
      // v4 (2.6): transparency — wire bytes received (payload sizes only).
      recordDatachannelBytes(0, event.data.byteLength)
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
    channel.bufferedAmountLowThreshold = Math.max(this.flowWindow / 4, 64 * 1024)

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
      recordDatachannelBytes(0, event.data.byteLength)
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
  sendChunkDataOnChannel(transferId: string, chunkIndex: number, payload: ArrayBuffer | Uint8Array, channelIndex: number, gzipOrOpts: boolean | ChunkEncodeOpts = false): boolean {
    let ch: RTCDataChannel | null = null
    if (channelIndex === 0) {
      ch = this.channel
    } else {
      ch = this.secondaryChannels.get(channelIndex) ?? null
    }
    if (!ch || ch.readyState !== 'open') return false
    // v4 (1.3): pacing gate — the token bucket must hold a chunk's worth.
    if (!this.qosAllowsSend()) return false
    const msg = encodeChunkData(transferId, chunkIndex, payload, gzipOrOpts)
    try {
      ch.send(msg)
      this.qosConsume(msg.byteLength)
      recordDatachannelBytes(msg.byteLength, 0)
      this.noteSendOk()
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
        this.noteSendStall()
        return false
      }
      console.warn(`[FluxDrop] Failed to send chunk ${chunkIndex} on channel ${channelIndex}: ${errMsg}`)
      return false
    }
  }

  /** Check if a specific channel can send (backpressure + QoS tokens). */
  canSendOnChannel(channelIndex: number): boolean {
    if (channelIndex === 0) return this.canSend()
    const ch = this.secondaryChannels.get(channelIndex)
    return !!ch && ch.readyState === 'open' && ch.bufferedAmount < this.flowWindow && this.qosAllowsSend()
  }

  /** Wait for a specific channel to drain (also waits for QoS tokens). */
  async waitForDrainOnChannel(channelIndex: number): Promise<void> {
    if (channelIndex === 0) return this.waitForDrain()
    const ch = this.secondaryChannels.get(channelIndex)
    if (!ch) return
    if (ch.bufferedAmount < this.flowWindow && this.qosAllowsSend()) return
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
        if (ch.bufferedAmount < this.flowWindow && this.qosAllowsSend()) finish()
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

  /** True while an ICE-restart offer/answer cycle is in flight. */
  get isRestartingIce(): boolean {
    return this.iceRestartInFlight
  }

  /**
   * In-place ICE restart: re-gathers candidates and rebuilds the transport on
   * the SAME RTCPeerConnection — the SCTP association and DataChannel object
   * survive (onopen does NOT refire, onclose does NOT fire on success). Far
   * cheaper and more reliable than the old teardown path, which lost all
   * channel state and forced the receiver onto a brand-new connection.
   *
   * Returns the restart offer to relay via signaling, or null when a restart
   * is impossible (PC closed, one already in flight, or the DataChannel has
   * already died — a closed DC cannot be revived in place, use a fresh PC).
   */
  async createIceRestartOffer(): Promise<RTCSessionDescriptionInit | null> {
    if (this.iceRestartInFlight) return null
    if (this.pc.connectionState === 'closed' || this.pc.signalingState === 'closed') return null
    if (!this.isOpen) return null
    this.iceRestartInFlight = true
    try {
      // Hint the browser (no-op where unsupported); the explicit offer below
      // is what actually restarts ICE.
      try { (this.pc as any).restartIce?.() } catch { /* older browsers */ }
      const offer = await this.pc.createOffer({ iceRestart: true })
      await this.pc.setLocalDescription(offer)
      console.log('[FluxDrop] ICE restart offer created — re-negotiating in place')
      return offer
    } catch (err: any) {
      console.warn('[FluxDrop] ICE restart offer failed:', err?.message)
      this.iceRestartInFlight = false
      return null
    }
  }

  /**
   * Whether THIS connection can take an incoming (possibly ICE-restart) offer
   * and answer it IN PLACE — same PC, renegotiated transport, DataChannel
   * preserved. Only possible while signaling is stable and our channel object
   * is still alive; a dead channel needs the fresh-PC fallback.
   */
  supportsInPlaceAnswer(): boolean {
    if (this.pc.connectionState === 'closed' || this.pc.signalingState !== 'stable') return false
    return !!this.channel && this.channel.readyState === 'open'
  }

  /** The o= (origin) line of the current remote description. Stable across
   * ICE restarts on the same PC; different for offers from a brand-new PC —
   * the discriminator between "renegotiate in place" and "full reconnect". */
  get remoteSessionOrigin(): string | null {
    const sdp = this.pc.remoteDescription?.sdp
    if (!sdp) return null
    return sdpOrigin(sdp)
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
    // Adaptive AIMD window (v1.1) — replaces the fixed 8 MB threshold.
    // v4 (1.3): QoS token bucket gates the rate on top of the window.
    return this.channel.bufferedAmount < this.flowWindow && this.qosAllowsSend()
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
    if (channel.bufferedAmount < this.flowWindow && this.qosAllowsSend()) return

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
      // v4 (1.3): the poll also honors the QoS pacer so a capped sender
      // sleeps exactly as long as the token bucket needs.
      const pollId = setInterval(() => {
        if (channel.bufferedAmount < this.flowWindow && this.qosAllowsSend()) {
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
  sendChunkData(transferId: string, chunkIndex: number, payload: ArrayBuffer | Uint8Array, gzipOrOpts: boolean | ChunkEncodeOpts = false): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false
    if (!this.qosAllowsSend()) return false
    const msg = encodeChunkData(transferId, chunkIndex, payload, gzipOrOpts)
    try {
      this.channel.send(msg)
      this.qosConsume(msg.byteLength)
      recordDatachannelBytes(msg.byteLength, 0)
      this.noteSendOk()
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
        this.noteSendStall()
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

  /**
   * v1.2: send the manifest ENCRYPTED (opcode MANIFEST_ENC). `encBody` is the
   * raw binary envelope (nonce || GCM ciphertext of the manifest JSON) from
   * e2e.encryptWirePayload — the DataChannel never sees plaintext names/sizes.
   */
  sendManifestEncrypted(transferId: string, encBody: ArrayBuffer | Uint8Array): void {
    if (!this.channel || this.channel.readyState !== 'open') return
    try {
      const idBytes = transferIdToBytes(transferId)
      const body = encBody instanceof Uint8Array ? encBody : new Uint8Array(encBody)
      const buffer = new ArrayBuffer(HEADER_SIZE + body.byteLength)
      const view = new DataView(buffer)
      const bytes = new Uint8Array(buffer)
      view.setUint8(0, MessageType.MANIFEST_ENC)
      bytes.set(idBytes, 1)
      view.setUint32(5, 0, false)
      bytes.set(body, HEADER_SIZE)
      this.channel.send(buffer)
    } catch (err: any) {
      this.config.onError(new Error(`Failed to send encrypted manifest: ${err.message}`))
    }
  }

  /**
   * v1.2: raw binary frame with an arbitrary opcode (used by the preview
   * pipeline and any future binary extensions). Body is appended after the
   * 9-byte header verbatim.
   */
  sendRawFrame(type: number, transferId: string, chunkIndex: number, body: ArrayBuffer | Uint8Array): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false
    try {
      const idBytes = transferIdToBytes(transferId)
      const bodyBytes = body instanceof Uint8Array ? body : new Uint8Array(body)
      const buffer = new ArrayBuffer(HEADER_SIZE + bodyBytes.byteLength)
      const view = new DataView(buffer)
      const bytes = new Uint8Array(buffer)
      view.setUint8(0, type)
      bytes.set(idBytes, 1)
      view.setUint32(5, chunkIndex, false)
      bytes.set(bodyBytes, HEADER_SIZE)
      this.channel.send(buffer)
      return true
    } catch (err: any) {
      this.config.onError(new Error(`Failed to send frame (type ${type}): ${err.message}`))
      return false
    }
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

  sendResumeResponse(transferId: string, accepted: boolean, fromChunkIndex: number, ackedIndices?: number[]): void {
    this.sendControl(MessageType.RESUME_RESPONSE, transferId, fromChunkIndex, { accepted, fromChunkIndex, ackedIndices })
  }

  /**
   * Ask the receiver how much of this transfer it already has. Used when a
   * transfer is re-sent after a resume-from-history: the receiver answers
   * with RESUME_RESPONSE { fromChunkIndex } so already-stored chunks never
   * travel the wire again.
   */
  sendResumeQuery(transferId: string): void {
    this.sendControl(MessageType.RESUME_QUERY, transferId, 0, {})
  }

  /** Ask the peer to pause streaming (flow control). Uses the PAUSE opcode. */
  sendPause(transferId: string): void {
    this.sendControl(MessageType.PAUSE, transferId, 0, { paused: true })
  }

  /** Tell the peer to continue streaming. Uses the RESUME_STREAM opcode. */
  sendResumeStream(transferId: string): void {
    this.sendControl(MessageType.RESUME_STREAM, transferId, 0, { paused: false })
  }

  /**
   * Classify the transport from the selected ICE candidate pair (v1.1).
   * host↔host = direct LAN, anything relayed = TURN, otherwise unknown
   * (srflx/srflx or stats unavailable). Drives the initial flow window.
   */
  async getTransportClass(): Promise<TransportClass> {
    try {
      const stats = await this.pc.getStats()
      let localType: string | undefined
      let remoteType: string | undefined
      stats.forEach((report: any) => {
        if (report.type === 'candidate-pair' && (report.selected === true || report.nominated === true)) {
          const local = stats.get(report.localCandidateId)
          const remote = stats.get(report.remoteCandidateId)
          localType = local?.candidateType
          remoteType = remote?.candidateType
        }
      })
      if (localType === 'relay' || remoteType === 'relay') return 'relayed'
      if (localType === 'host' && remoteType === 'host') return 'lan'
      return 'unknown'
    } catch {
      return 'unknown'
    }
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
    this.iceRestartInFlight = false
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
