// v5-a2: server-relayed fallback transport — the LAST rung of the recovery
// ladder, engaged by use-fluxdrop only when P2P is impossible (see
// tryEngageRelayFallback in the engine).
//
// ENCRYPTION NOTE (verified at v5-a2 landing): chunk payloads are already
// ciphertext at the transport boundary — the engine's send loop seals every
// chunk with AES-256-GCM under the per-peer PAKE-derived session key
// (encryptWirePayload in e2e.ts) BEFORE it reaches ANY transport. This module
// therefore carries opaque bytes as-is; it never encrypts, decrypts, or
// inspects them. Engaging the relay is gated on isE2EActive(peerId) in the
// engine so a relayed transfer can never downgrade a session to plaintext.
//
// Wire shape (socket.io events, see RELAY_EVENTS in protocol.ts):
//   relay-data: { roomId, from, to, transferId, seq, chunkIndex, data(b64), last? }
//   relay-ack:  { roomId, from, to, transferId, seq }
//   relay-error:{ roomId, reason: 'quota' }  (server → sender, best-effort)
//
// Reliability: window of RELAY_WINDOW_CHUNKS in-flight seqs, one 4 s
// retransmit timer per in-flight seq, RELAY_RETRY_MAX transmission tries per
// seq before onFatal fires. Retransmits reuse the SAME seq so the receiver's
// seen-set dedupes them (a lost first copy is delivered, a lost ACK only
// triggers a re-ACK). Control messages (manifest, consent, completion) NEVER
// ride this path — the relay carries chunk payloads only.

'use client'

import type { FluxDropSignaling } from './signaling'
import { CONSTANTS } from './protocol'

// ─── base64 helpers (chunk-wise — btoa/atob choke on huge single strings) ───

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const STRIDE = 0x8000 // 32 KB per String.fromCharCode call (arg-limit safe)
  for (let i = 0; i < bytes.length; i += STRIDE) {
    out += String.fromCharCode(...bytes.subarray(i, i + STRIDE))
  }
  return btoa(out)
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null // malformed base64 — caller ignores
  }
}

// ─── module-level stats (page lifetime, both directions) ───
// Feeds the debug bundle (see debug-bundle.ts). Cheap counters, no content.
let statsBytesSent = 0
let statsBytesReceived = 0

export function getRelayStats(): { bytesSent: number; bytesReceived: number } {
  return { bytesSent: statsBytesSent, bytesReceived: statsBytesReceived }
}

// ─── sender side ───

export interface RelayTransportOptions {
  roomId: string
  /** Our device id (the server overwrites `from` with the socket-derived id regardless — kept for routing clarity). */
  deviceId: string
  peerDeviceId: string
  transferId: string
}

interface InFlight {
  chunkIndex: number
  data: string // base64 body — retransmitted verbatim
  last: boolean
  tries: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * One sender-side relay leg for a single peer + transferId. Mirrors the
 * canSend semantics of FluxDropWebRTC so the engine's send loop treats it
 * uniformly: `sendChunk` returns false when the window is full (transient —
 * the caller waits and retries, exactly like a full DataChannel buffer).
 */
export class RelayTransport {
  readonly windowSize = CONSTANTS.RELAY_WINDOW_CHUNKS

  private signaling: FluxDropSignaling
  private opts: RelayTransportOptions
  private nextSeq = 0
  private inflight = new Map<number, InFlight>()
  private ackCb: ((chunkIndex: number) => void) | null = null
  private fatalCb: ((reason: string) => void) | null = null
  private closed = false
  private detachAck: () => void
  private detachError: () => void

  /** Wire bytes pushed (retransmits included) — observability only. */
  bytesSent = 0

  constructor(signaling: FluxDropSignaling, opts: RelayTransportOptions) {
    this.signaling = signaling
    this.opts = opts
    this.detachAck = signaling.onRelayAck((p) => this.handleAck(p))
    this.detachError = signaling.onRelayError((p) => {
      // Quota / routing errors surface here; the retransmit timer already
      // handles delivery retries once the server bucket refills.
      if (p?.reason === 'quota') {
        console.warn('[FluxDrop] v5-a2 relay: server rate limit hit — backing off to the 4s retransmit timer')
      }
    })
  }

  /** Free window slots (chunks). 0 → window full, caller must wait. */
  availableWindow(): number {
    return Math.max(0, this.windowSize - this.inflight.size)
  }

  /**
   * Send one chunk payload (already-encrypted wire bytes). Returns false when
   * the window is full or the transport is closed — the send loop then waits
   * for an ACK to free a slot, exactly like a full DataChannel buffer.
   */
  sendChunk(chunkIndex: number, bytes: Uint8Array, last = false): boolean {
    if (this.closed) return false
    if (this.inflight.size >= this.windowSize) return false
    const seq = this.nextSeq++
    const entry: InFlight = { chunkIndex, data: bytesToBase64(bytes), last, tries: 1, timer: null }
    entry.timer = setTimeout(() => this.retransmit(seq), CONSTANTS.RELAY_RETRY_TIMEOUT_MS)
    this.inflight.set(seq, entry)
    this.emitData(seq, entry)
    return true
  }

  /** Fired for every relay-ack (seq) — carries the acked chunkIndex. */
  onAck(cb: (chunkIndex: number) => void): void {
    this.ackCb = cb
  }

  /** Fired once when a seq exhausts its retransmit budget — the leg is dead. */
  onFatal(cb: (reason: string) => void): void {
    this.fatalCb = cb
  }

  /** Tear the leg down: drain every retransmit timer + unsubscribe. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const e of this.inflight.values()) {
      if (e.timer) clearTimeout(e.timer)
    }
    this.inflight.clear()
    this.detachAck()
    this.detachError()
  }

  // ─── internals ───

  private emitData(seq: number, e: InFlight): void {
    this.signaling.sendRelayData({
      roomId: this.opts.roomId,
      from: this.opts.deviceId,
      to: this.opts.peerDeviceId,
      transferId: this.opts.transferId,
      seq,
      chunkIndex: e.chunkIndex,
      data: e.data,
      ...(e.last ? { last: true } : {}),
    })
    this.bytesSent += e.data.length
    statsBytesSent += e.data.length
  }

  private retransmit(seq: number): void {
    if (this.closed) return
    const e = this.inflight.get(seq)
    if (!e) return // already acked
    if (e.tries >= CONSTANTS.RELAY_RETRY_MAX) {
      // Budget exhausted — hand the failure to the engine and stop cleanly.
      const reason = `no relay-ack for chunk ${e.chunkIndex} after ${e.tries} tries`
      this.close()
      this.fatalCb?.(reason)
      return
    }
    e.tries++
    e.timer = setTimeout(() => this.retransmit(seq), CONSTANTS.RELAY_RETRY_TIMEOUT_MS)
    this.emitData(seq, e)
  }

  private handleAck(p: { from?: unknown; transferId?: unknown; seq?: unknown }): void {
    if (this.closed || !p) return
    // Route to the right leg in a group (several relaying receivers share
    // the sender's socket): the ack must come from OUR peer + transfer.
    if (p.from !== this.opts.peerDeviceId) return
    if (p.transferId !== this.opts.transferId) return // different session
    const seq = Number(p.seq)
    if (!Number.isInteger(seq)) return
    const e = this.inflight.get(seq)
    if (!e) return // unknown seq → ignore (already acked / stale)
    if (e.timer) clearTimeout(e.timer)
    this.inflight.delete(seq)
    this.ackCb?.(e.chunkIndex)
  }
}

// ─── receiver side ───

export interface RelayReceiverOptions {
  /**
   * Route one decoded chunk into the engine's ingest. `meta.from` /
   * `meta.transferId` let the engine drop frames with no active transfer for
   * that peer (post-completion stragglers, unknown sessions, mid-recovery
   * races — the engine's guards are the authority, the receiver only
   * validates transport shape).
   */
  onChunk: (chunkIndex: number, bytes: Uint8Array, meta: { from: string; transferId: string; roomId: string; last: boolean }) => void
  /** Optional routing guards (the engine passes its own room/device ids). */
  roomId?: string
  deviceId?: string
}

/** Cap for the stale-duplicate seen-seq set (FIFO eviction beyond it). */
const SEEN_SEQ_CAP = 4096

/**
 * Subscribe to inbound relay-data frames: base64-decode, dedupe stale seqs,
 * hand the bytes to `onChunk`, and send a transport-level relay-ack back for
 * every well-formed frame (including duplicates — a lost first ACK must not
 * wedge the sender's window). Returns a dispose handle.
 */
export function createRelayReceiver(
  signaling: FluxDropSignaling,
  opts: RelayReceiverOptions
): { dispose(): void } {
  const seen = new Set<string>() // `${transferId}:${seq}` — insertion-ordered

  const off = signaling.onRelayData((p) => {
    try {
      if (!p || typeof p !== 'object') return
      if (opts.roomId && p.roomId !== opts.roomId) return
      const transferId = typeof p.transferId === 'string' ? p.transferId : ''
      const seq = Number(p.seq)
      const chunkIndex = Number(p.chunkIndex)
      if (!transferId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunkIndex) || chunkIndex < 0) return
      const from = typeof p.from === 'string' ? p.from : ''
      const roomId = typeof p.roomId === 'string' ? p.roomId : ''
      if (!from || !roomId) return
      const bytes = base64ToBytes(typeof p.data === 'string' ? p.data : '')
      if (!bytes) return // malformed base64 → ignore

      const key = `${transferId}:${seq}`
      if (seen.has(key)) {
        // Stale duplicate (retransmit after a lost ACK): re-ack only — the
        // engine's ackChunk dedupe already guards the ingest side.
        signaling.sendRelayAck({ roomId, from: opts.deviceId ?? '', to: from, transferId, seq })
        return
      }
      seen.add(key)
      // FIFO eviction: Sets iterate in insertion order — drop the oldest.
      if (seen.size > SEEN_SEQ_CAP) {
        for (const k of seen) {
          seen.delete(k)
          break
        }
      }

      statsBytesReceived += bytes.byteLength
      opts.onChunk(chunkIndex, bytes, { from, transferId, roomId, last: p.last === true })
      // Transport-level ack for every well-formed frame — window release on
      // the sender side depends on it.
      signaling.sendRelayAck({ roomId, from: opts.deviceId ?? '', to: from, transferId, seq })
    } catch {
      // A malformed frame must never take the page down.
    }
  })

  return {
    dispose: () => {
      off()
      seen.clear()
    },
  }
}
