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

    this.pc.onconnectionstatechange = () => {
      this.config.onConnectionStateChange(this.pc.connectionState)
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
    channel.onerror = (e: any) => this.config.onError(new Error(e?.message ?? 'DataChannel error'))
    channel.onmessage = (event) => {
      const data = event.data as ArrayBuffer
      const msg = decodeMessage(data)
      this.config.onDataChannelMessage(msg)
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
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    return answer
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(answer)
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate)
    } catch (err) {
      // Ignore errors from out-of-order candidates; common during aggressive ICE.
    }
  }

  // === Backpressure-aware chunk sending ===
  canSend(): boolean {
    if (!this.channel) return false
    return this.channel.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES
  }

  async waitForDrain(): Promise<void> {
    if (!this.channel) return
    const channel = this.channel
    if (channel.bufferedAmount < CONSTANTS.TARGET_BUFFERED_BYTES) return
    await new Promise<void>((resolve) => {
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow)
        resolve()
      }
      channel.addEventListener('bufferedamountlow', onLow)
      // Safety timeout in case the event never fires
      setTimeout(() => {
        channel.removeEventListener('bufferedamountlow', onLow)
        resolve()
      }, 2000)
    })
  }

  sendChunkData(transferId: string, chunkIndex: number, payload: ArrayBuffer): void {
    if (!this.channel) throw new Error('DataChannel not open')
    const msg = encodeChunkData(transferId, chunkIndex, payload)
    this.channel.send(msg)
  }

  sendChunkAck(transferId: string, chunkIndex: number, ok: boolean): void {
    if (!this.channel) return
    const msg = encodeChunkAck(transferId, chunkIndex, ok)
    this.channel.send(msg)
  }

  sendManifest(transferId: string, manifest: unknown): void {
    if (!this.channel) return
    const msg = encodeControlMessage(MessageType.MANIFEST, transferId, 0, manifest)
    this.channel.send(msg)
  }

  sendManifestAck(transferId: string, accepted: boolean, reason?: string): void {
    if (!this.channel) return
    const msg = encodeControlMessage(
      MessageType.MANIFEST_ACK,
      transferId,
      0,
      { accepted, reason }
    )
    this.channel.send(msg)
  }

  sendTransferComplete(transferId: string, finalChecksum: string): void {
    if (!this.channel) return
    const msg = encodeControlMessage(
      MessageType.TRANSFER_COMPLETE,
      transferId,
      0,
      { finalChecksum }
    )
    this.channel.send(msg)
  }

  sendTransferCompleteAck(transferId: string, verified: boolean): void {
    if (!this.channel) return
    const msg = encodeControlMessage(
      MessageType.TRANSFER_COMPLETE_ACK,
      transferId,
      0,
      { verified }
    )
    this.channel.send(msg)
  }

  sendCancel(transferId: string, reason: string): void {
    if (!this.channel) return
    const msg = encodeControlMessage(MessageType.TRANSFER_CANCEL, transferId, 0, { reason })
    this.channel.send(msg)
  }

  sendResumeRequest(transferId: string, lastChunkIndex: number): void {
    if (!this.channel) return
    const msg = encodeControlMessage(MessageType.RESUME_REQUEST, transferId, lastChunkIndex, { lastChunkIndex })
    this.channel.send(msg)
  }

  sendResumeResponse(transferId: string, accepted: boolean, fromChunkIndex: number): void {
    if (!this.channel) return
    const msg = encodeControlMessage(
      MessageType.RESUME_RESPONSE,
      transferId,
      fromChunkIndex,
      { accepted, fromChunkIndex }
    )
    this.channel.send(msg)
  }

  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState
  }

  get isOpen(): boolean {
    return this.channel?.readyState === 'open'
  }

  close(): void {
    try { this.channel?.close() } catch { /* noop */ }
    try { this.pc.close() } catch { /* noop */ }
    this.channel = null
  }
}
