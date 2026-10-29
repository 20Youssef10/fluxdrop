// v5-a5: Network weather — pre-flight network probe for FluxDrop.
//
// Simulates the conditions a transfer will face BEFORE anyone connects:
//   1. ICE candidate classification — a throwaway RTCPeerConnection with the
//      STUN fleet gathers host/srflx/relay candidates (srflx > 0 ⇒ the NAT is
//      traversable and STUN answered).
//   2. TURN TCP reachability — derive an HTTP(S)-ish endpoint from the TURN
//      config (./turn) and heartbeat it with a no-cors HEAD fetch.
//   3. Loopback throughput ceiling — two RTCPeerConnections wired back-to-back
//      in-page (no signaling server): RTT from 32 × 1 KiB sequential echoes,
//      then a paced 64 KiB-chunk flood where only ACKed bytes count.
//
// Contract: engine-decoupled and self-contained — no imports from the transfer
// engine. Every phase is time-boxed and failure-tolerant: problems land in
// `errors`, `cancel()` resolves the result promise with partial data, and the
// result promise NEVER rejects.

import { fetchTurnCredentials } from './turn'

export type NetVerdict = 'direct-likely' | 'nat-hostile' | 'relay-needed' | 'unknown'

export interface NetWeatherReport {
  at: number
  durationMs: number
  candidates: { host: number; srflx: number; relay: number }
  stunReachable: boolean
  turnTcpReachable: boolean | null
  rttMs: number | null
  loopbackBps: number | null
  verdict: NetVerdict
  /** Machine keys (NOT display strings) — the UI maps them to translated copy. */
  advice: string[]
  errors: string[]
}

export interface ProbeHandle {
  cancel(): void
  result: Promise<NetWeatherReport>
}

export interface ProbeOptions {
  /** STUN urls; defaults to the FluxDrop STUN fleet (mirrors DEFAULT_ICE in ./webrtc, private there). */
  stunUrls?: string[]
  /** Explicit TURN url (turn:/turns:) to heartbeat; otherwise derived from ./turn credentials. */
  turnUrl?: string
  /** Total bytes to push through the loopback throughput probe; default 8 MiB. */
  throughputBytes?: number
}

// STUN fleet — mirrors DEFAULT_ICE in ./webrtc.ts (kept private there; the two
// are deliberately decoupled — update both if the fleet changes).
const MIRRORED_DEFAULT_STUN: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]

// --- time budgets (ms) ---
const GATHER_TIMEOUT_MS = 5_000 // ICE candidate gathering
const TURN_TIMEOUT_MS = 4_000 // TURN TCP heartbeat
const LOOP_SETUP_TIMEOUT_MS = 3_000 // back-to-back connect
const RTT_PING_TIMEOUT_MS = 750 // single RTT sample
const RTT_PHASE_BUDGET_MS = 2_000 // all 32 RTT samples combined
const THROUGHPUT_CAP_MS = 9_000 // wall clock for the flood
const DRAIN_WAIT_MS = 500 // bufferedamountlow safety re-check
const TOTAL_BUDGET_MS = 15_000 // hard cap for the whole probe

// --- loopback probe shapes ---
const RTT_SAMPLES = 32
const RTT_PAYLOAD_BYTES = 1_024 // 1 KiB frame per sample
const THROUGHPUT_CHUNK_BYTES = 64 * 1_024 // 64 KiB chunks
const THROUGHPUT_LOW_THRESHOLD = 256 * 1_024 // bufferedAmountLowThreshold
const DEFAULT_THROUGHPUT_BYTES = 8 * 1_024 * 1_024 // 8 MiB
const MAX_THROUGHPUT_BYTES = 64 * 1_024 * 1_024

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Derive an HTTP(S)-ish URL from a TURN url for the no-cors heartbeat:
 * `turn:host:port` → `http://host:port/`, `turns:` → `https://…`.
 * Returns null when nothing TCP-ish can be derived from the string.
 */
function turnUrlToHttpUrl(url: string): string | null {
  const m = /^(turns?):([^?]+)(?:\?.*)?$/i.exec(url.trim())
  if (!m) return null
  const hostPort = m[2]
  if (!/^[a-z0-9.\-]+:\d+$/i.test(hostPort)) return null
  return `${m[1].toLowerCase() === 'turns' ? 'https' : 'http'}://${hostPort}/`
}

/** Classify what the probe saw into a verdict + machine advice keys. */
function applyVerdict(report: NetWeatherReport): void {
  const { host, srflx, relay } = report.candidates
  const total = host + srflx + relay
  report.stunReachable = srflx > 0

  if (srflx > 0) {
    // STUN binding came back → the NAT lets direct pairs through.
    report.verdict = 'direct-likely'
  } else if (host > 0) {
    // Host candidates but zero server-reflexive ones: STUN never made it back.
    report.verdict = 'nat-hostile'
  } else if (total === 0 && !report.stunReachable) {
    // STUN unreachable and not a single candidate → only a relay can carry this.
    report.verdict = 'relay-needed'
  } else {
    // Anything weird (e.g. relay-only gathering).
    report.verdict = 'unknown'
  }

  const advice: string[] = []
  switch (report.verdict) {
    case 'direct-likely':
      advice.push('wifi-looks-great', 'enable-fast-lanes')
      break
    case 'nat-hostile':
      advice.push('relay-will-carry')
      advice.push(report.turnTcpReachable === true ? 'turn-configured' : 'check-network')
      break
    case 'relay-needed':
      advice.push('relay-will-carry', 'check-network')
      if (report.turnTcpReachable === true) advice.push('turn-configured')
      break
    default:
      advice.push('check-network')
      break
  }
  report.advice = advice
}

export function probeNetwork(opts?: ProbeOptions): ProbeHandle {
  const startedAt = Date.now()
  const report: NetWeatherReport = {
    at: startedAt,
    durationMs: 0,
    candidates: { host: 0, srflx: 0, relay: 0 },
    stunReachable: false,
    turnTcpReachable: null,
    rttMs: null,
    loopbackBps: null,
    verdict: 'unknown',
    advice: [],
    errors: [],
  }

  const stunUrls =
    opts?.stunUrls && opts.stunUrls.length > 0 ? [...opts.stunUrls] : [...MIRRORED_DEFAULT_STUN]
  const throughputBytes = Math.min(
    MAX_THROUGHPUT_BYTES,
    Math.max(THROUGHPUT_CHUNK_BYTES, opts?.throughputBytes ?? DEFAULT_THROUGHPUT_BYTES),
  )

  let cancelled = false
  let settled = false
  const cleanups: Array<() => void> = []
  let fireFinishSignal!: () => void
  const finishSignal = new Promise<void>((res) => {
    fireFinishSignal = res
  })

  let resolveResult!: (r: NetWeatherReport) => void
  const result = new Promise<NetWeatherReport>((res) => {
    resolveResult = res
  })

  /** Idempotent terminal step: stamp duration, compute verdict, clean up, resolve. */
  const finish = (reason?: 'cancelled' | 'timeout') => {
    if (settled) return
    settled = true
    if (reason === 'cancelled') report.errors.push('probe-cancelled')
    if (reason === 'timeout') report.errors.push('probe-budget-exceeded')
    report.durationMs = Date.now() - startedAt
    applyVerdict(report)
    fireFinishSignal()
    const fns = cleanups.splice(0)
    for (const fn of fns) {
      try {
        fn()
      } catch {
        /* never throw */
      }
    }
    resolveResult({
      ...report,
      candidates: { ...report.candidates },
      advice: [...report.advice],
      errors: [...report.errors],
    })
  }

  /**
   * Time-boxed sleep. Resolves `true` when the whole probe finished/was
   * cancelled (so callers can bail immediately), `false` on the timer.
   */
  const sleep = (ms: number): Promise<boolean> =>
    new Promise((res) => {
      const id = setTimeout(() => res(false), ms)
      cleanups.push(() => clearTimeout(id))
      void finishSignal.then(() => {
        clearTimeout(id)
        res(true)
      })
    })

  // --- Phase A: ICE candidate classification (throwaway PC + STUN) ---

  const gatherCandidates = async (): Promise<void> => {
    let pc: RTCPeerConnection | null = null
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrls }] })
      const pcRef = pc
      cleanups.push(() => {
        try {
          pcRef.close()
        } catch {
          /* ignore */
        }
      })

      // A data channel is required before the offer for some ICE stacks to gather.
      pcRef.createDataChannel('net-weather-gather', { ordered: false })

      let gatherDone: (() => void) | null = null
      const done = new Promise<void>((res) => {
        gatherDone = res
      })
      pcRef.onicecandidate = (ev) => {
        const cand = ev.candidate
        if (!cand) {
          gatherDone?.()
          return
        }
        if (cand.type === 'host') report.candidates.host += 1
        else if (cand.type === 'srflx') report.candidates.srflx += 1
        else if (cand.type === 'relay') report.candidates.relay += 1
        // (prflx candidates only appear from peer traffic, never while gathering)
      }
      pcRef.addEventListener('icegatheringstatechange', () => {
        if (pcRef.iceGatheringState === 'complete') gatherDone?.()
      })

      const offer = await pcRef.createOffer()
      await pcRef.setLocalDescription(offer)

      await Promise.race([done, sleep(GATHER_TIMEOUT_MS)])
      if (cancelled) return
      if (pcRef.iceGatheringState !== 'complete') report.errors.push('ice-gather-timeout')
      report.stunReachable = report.candidates.srflx > 0
    } catch (err) {
      report.errors.push(`ice-gather-failed: ${errorMessage(err)}`)
    } finally {
      try {
        pc?.close()
      } catch {
        /* ignore */
      }
    }
  }

  // --- Phase B: TURN TCP reachability heartbeat ---

  const probeTurnTcp = async (): Promise<void> => {
    try {
      let turnUrl = opts?.turnUrl ?? null
      if (!turnUrl && typeof window !== 'undefined') {
        // Derive from the signaling-minted TURN config (never throws).
        const lookup = new AbortController()
        cleanups.push(() => {
          try {
            lookup.abort()
          } catch {
            /* ignore */
          }
        })
        const creds = await fetchTurnCredentials(lookup.signal)
        if (creds.enabled && creds.iceServers && creds.iceServers.length > 0) {
          const urls = creds.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
          turnUrl =
            urls.find((u) => /transport=tcp/i.test(u)) ??
            urls.find((u) => /^turns?:/i.test(u)) ??
            null
        }
      }
      if (cancelled) return
      if (!turnUrl) {
        report.turnTcpReachable = null // unknown — no TURN endpoint derivable
        return
      }
      const httpUrl = turnUrlToHttpUrl(turnUrl)
      if (!httpUrl) {
        report.turnTcpReachable = null
        report.errors.push('turn-url-underivable')
        return
      }
      // Avoid a mixed-content false negative: an http: heartbeat fired from an
      // https: page is blocked by the browser before it ever reaches the socket.
      if (httpUrl.startsWith('http:') && typeof window !== 'undefined' && window.location.protocol === 'https:') {
        report.turnTcpReachable = null
        report.errors.push('turn-endpoint-insecure-on-https')
        return
      }
      if (typeof fetch === 'undefined') {
        report.turnTcpReachable = null
        return
      }

      const ac = new AbortController()
      const timer = setTimeout(() => {
        try {
          ac.abort()
        } catch {
          /* ignore */
        }
      }, TURN_TIMEOUT_MS)
      cleanups.push(() => clearTimeout(timer))
      cleanups.push(() => {
        try {
          ac.abort()
        } catch {
          /* ignore */
        }
      })
      try {
        // Opaque (no-cors) HEAD — any completed response proves the TCP endpoint
        // answered an HTTP request, i.e. reachable-ish.
        await fetch(httpUrl, { method: 'HEAD', mode: 'no-cors', signal: ac.signal })
        report.turnTcpReachable = true
      } catch {
        // The fetch itself rejected (connection refused / timeout): the endpoint
        // did not complete the heartbeat → unreachable.
        report.turnTcpReachable = false
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      // Unexpected probe-level failure → unknown, never throw.
      report.turnTcpReachable = null
      report.errors.push(`turn-probe-failed: ${errorMessage(err)}`)
    }
  }

  // --- Phase C: loopback RTT + throughput ceiling (two PCs back-to-back) ---

  const loopbackProbe = async (): Promise<void> => {
    let pc1: RTCPeerConnection | null = null
    let pc2: RTCPeerConnection | null = null
    try {
      // No ICE servers needed for an in-page loop — host candidates connect instantly.
      pc1 = new RTCPeerConnection({ iceServers: [] })
      pc2 = new RTCPeerConnection({ iceServers: [] })
      const pc1Ref = pc1
      const pc2Ref = pc2
      cleanups.push(() => {
        try {
          pc1Ref.close()
        } catch {
          /* ignore */
        }
        try {
          pc2Ref.close()
        } catch {
          /* ignore */
        }
      })

      // Wire the pair back-to-back; no signaling server involved.
      pc1Ref.onicecandidate = (ev) => {
        if (ev.candidate) void pc2Ref.addIceCandidate(ev.candidate.toJSON()).catch(() => {
          /* ignore */
        })
      }
      pc2Ref.onicecandidate = (ev) => {
        if (ev.candidate) void pc1Ref.addIceCandidate(ev.candidate.toJSON()).catch(() => {
          /* ignore */
        })
      }

      const dc = pc1Ref.createDataChannel('net-weather-loop', { ordered: true })
      dc.binaryType = 'arraybuffer'

      // pc2 is the echo/ACK server: strings are echoed verbatim (RTT pings);
      // binary chunks bump the cumulative counter and are ACKed as 'a|<n>'.
      let peerAcked = 0
      pc2Ref.ondatachannel = (ev) => {
        const ch = ev.channel
        ch.binaryType = 'arraybuffer'
        ch.onmessage = (msg: MessageEvent) => {
          try {
            if (typeof msg.data === 'string') {
              ch.send(msg.data)
            } else {
              peerAcked += msg.data.byteLength
              ch.send(`a|${peerAcked}`)
            }
          } catch {
            /* channel closed mid-flight */
          }
        }
      }

      // Single mutable client-side message handler, swapped per phase.
      let onMessage: ((data: string) => void) | null = null
      dc.onmessage = (msg: MessageEvent) => {
        const data = msg.data
        if (typeof data === 'string' && onMessage) onMessage(data)
      }

      // Negotiate: offer → answer, directly between the two PCs.
      const offer = await pc1Ref.createOffer()
      await pc1Ref.setLocalDescription(offer)
      await pc2Ref.setRemoteDescription(offer)
      const answer = await pc2Ref.createAnswer()
      await pc2Ref.setLocalDescription(answer)
      await pc1Ref.setRemoteDescription(answer)

      // Wait for the channel to open (close/failure events short-circuit; the
      // outer sleep wakes on cancel/timeout).
      const openPromise = new Promise<boolean>((resolve) => {
        let settledOpen = false
        const finishOpen = (ok: boolean) => {
          if (settledOpen) return
          settledOpen = true
          dc.removeEventListener('open', onOpen)
          dc.removeEventListener('close', onClose)
          pc1Ref.removeEventListener('connectionstatechange', onState)
          resolve(ok)
        }
        const onOpen = () => finishOpen(true)
        const onClose = () => finishOpen(false)
        const onState = () => {
          const s = pc1Ref.connectionState
          if (s === 'failed' || s === 'closed' || s === 'disconnected') finishOpen(false)
        }
        if (dc.readyState === 'open') {
          finishOpen(true)
          return
        }
        dc.addEventListener('open', onOpen)
        dc.addEventListener('close', onClose)
        pc1Ref.addEventListener('connectionstatechange', onState)
      })
      await Promise.race([openPromise, sleep(LOOP_SETUP_TIMEOUT_MS)])
      if (cancelled) return
      if (dc.readyState !== 'open') {
        report.errors.push('loopback-open-failed')
        return
      }

      // --- RTT: 32 × 1 KiB sequential echo round-trips, averaged ---
      const pingPayload = 'p'.repeat(RTT_PAYLOAD_BYTES)
      const pingOnce = (): Promise<number | null> =>
        new Promise((resolve) => {
          let settledPing = false
          const t0 = Date.now()
          const finishPing = (v: number | null) => {
            if (settledPing) return
            settledPing = true
            onMessage = null
            dc.removeEventListener('close', onPingClose)
            clearTimeout(tid)
            resolve(v)
          }
          const onPingClose = () => finishPing(null)
          const tid = setTimeout(() => finishPing(null), RTT_PING_TIMEOUT_MS)
          dc.addEventListener('close', onPingClose)
          onMessage = () => finishPing(Date.now() - t0)
          try {
            dc.send(pingPayload)
          } catch {
            finishPing(null)
          }
        })

      const rttStart = Date.now()
      const samples: number[] = []
      for (let i = 0; i < RTT_SAMPLES; i++) {
        if (cancelled || dc.readyState !== 'open' || Date.now() - rttStart > RTT_PHASE_BUDGET_MS) break
        const sample = await pingOnce()
        if (sample == null) break
        samples.push(sample)
      }
      if (samples.length > 0) {
        const sum = samples.reduce((a, b) => a + b, 0)
        report.rttMs = Math.round((sum / samples.length) * 10) / 10
      } else if (!cancelled) {
        report.errors.push('rtt-no-samples')
      }

      // --- Throughput ceiling: paced 64 KiB flood, only ACKed bytes count ---
      const tThroughputStart = Date.now()
      const deadline = tThroughputStart + THROUGHPUT_CAP_MS
      let ackedBytes = 0
      let sentBytes = 0
      let fireAllAcked: (() => void) | null = null
      const allAckedPromise = new Promise<void>((res) => {
        fireAllAcked = res
      })
      onMessage = (data) => {
        if (data.startsWith('a|')) {
          const n = Number.parseInt(data.slice(2), 10)
          if (Number.isFinite(n) && n > ackedBytes) ackedBytes = n
          if (ackedBytes >= throughputBytes) fireAllAcked?.()
        }
      }

      // Pacing: fill the SCTP buffer past the 256 KiB low-water mark, then wait
      // for `onbufferedamountlow` before queuing more.
      dc.bufferedAmountLowThreshold = THROUGHPUT_LOW_THRESHOLD
      const chunk = new Uint8Array(THROUGHPUT_CHUNK_BYTES) // zeros — SCTP does not compress
      const waitForDrain = (): Promise<void> =>
        new Promise((resolve) => {
          let settledDrain = false
          const finishDrain = () => {
            if (settledDrain) return
            settledDrain = true
            dc.removeEventListener('bufferedamountlow', onLow)
            dc.removeEventListener('close', onDrainClose)
            clearTimeout(tid)
            resolve()
          }
          const onLow = () => finishDrain()
          const onDrainClose = () => finishDrain()
          const tid = setTimeout(finishDrain, DRAIN_WAIT_MS)
          dc.addEventListener('bufferedamountlow', onLow)
          dc.addEventListener('close', onDrainClose)
        })

      while (sentBytes < throughputBytes && !cancelled && dc.readyState === 'open') {
        if (Date.now() >= deadline) {
          if (ackedBytes < throughputBytes) report.errors.push('throughput-time-capped')
          break
        }
        if (dc.bufferedAmount > THROUGHPUT_LOW_THRESHOLD) {
          await waitForDrain()
          continue
        }
        try {
          dc.send(chunk)
        } catch (err) {
          report.errors.push(`loopback-send-failed: ${errorMessage(err)}`)
          break
        }
        sentBytes += chunk.byteLength
      }

      // Let the ACK tail land, bounded by the same wall-clock cap.
      while (
        ackedBytes < throughputBytes &&
        !cancelled &&
        dc.readyState === 'open' &&
        Date.now() < deadline
      ) {
        await Promise.race([allAckedPromise, sleep(100)])
      }

      const elapsedSec = (Date.now() - tThroughputStart) / 1000
      if (ackedBytes > 0 && elapsedSec > 0.05) {
        report.loopbackBps = Math.round(ackedBytes / elapsedSec)
      } else if (!cancelled) {
        report.errors.push('throughput-no-acks')
      }
    } catch (err) {
      report.errors.push(`loopback-failed: ${errorMessage(err)}`)
    } finally {
      try {
        pc1?.close()
      } catch {
        /* ignore */
      }
      try {
        pc2?.close()
      } catch {
        /* ignore */
      }
    }
  }

  const runPhases = async (): Promise<void> => {
    if (typeof RTCPeerConnection === 'undefined') {
      report.errors.push('webrtc-unavailable')
      return
    }
    await Promise.allSettled([gatherCandidates(), probeTurnTcp(), loopbackProbe()])
  }

  // Global watchdog: nothing may hang past the total budget — partials win.
  const watchdog = setTimeout(() => finish('timeout'), TOTAL_BUDGET_MS)
  cleanups.push(() => clearTimeout(watchdog))
  void runPhases().then(
    () => finish(),
    () => finish(),
  )

  return {
    cancel: () => {
      cancelled = true
      finish('cancelled')
    },
    result,
  }
}
