// v5-f18: Chaos lab — deterministic-ish network impairment profiles applied
// INSIDE the client (test/E2E only, opt-in via Settings → Network or ?chaos=).
//
// Why in-app instead of OS-level tc/netem: the sandbox/CI harness needs
// portable, dependency-free impairment, and the interesting failure classes
// (perf-resume-1: ICE restarts mid-transfer, rejoin after signaling blips,
// slow-lane tolerance) are all exercisable by delaying/dropping the frames the
// client emits. NOTHING here ever corrupts payloads — only timing/loss.
//
// Scope guarantees (so chaos never turns into a bug farm):
//   • signaling frames are DELAYED + jittered, never dropped — except
//     webrtc-ice, where the client already tolerates redundant candidates.
//   • flake forces periodic socket.io disconnects — the v1.1 rejoin-room
//     machinery + transfer resume ladder are the recovery paths under test.
//   • DataChannel sends are delayed/throttled via a prototype-level wrapper
//     (never dropped — the chunk integrity path is not the target here).
//   • applies only to connections opened while a profile is ACTIVE; turning
//     it off restores pristine behavior for new connections.

'use client'

export interface ChaosProfile {
  id: string
  label: string
  description: string
  /** Extra delay on outbound signaling frames (ms). */
  signalingLatencyMs?: number
  /** ±random jitter added to the signaling delay (ms). */
  signalingJitterMs?: number
  /** Drop probability for redundant ICE candidate frames (0-100 %). */
  iceLossPct?: number
  /** Force a signaling socket disconnect every N ms (recovery-ladder test). */
  flakeEveryMs?: number
  /** Extra delay on DataChannel sends (ms). */
  dcLatencyMs?: number
  /** ±random jitter on DataChannel delay (ms). */
  dcJitterMs?: number
  /** Pace DataChannel sends to ~B bytes/second (0 = off). */
  dcThrottleBps?: number
}

export const CHAOS_PROFILES: ChaosProfile[] = [
  {
    id: 'latency',
    label: 'Satellite latency',
    description: '+250 ms ±80 ms on every signaling frame and DataChannel send.',
    signalingLatencyMs: 250,
    signalingJitterMs: 80,
    dcLatencyMs: 250,
    dcJitterMs: 80,
  },
  {
    id: 'lossy-wifi',
    label: 'Lossy Wi-Fi',
    description: '120 ms ±40 ms latency, 20 % of ICE candidates dropped.',
    signalingLatencyMs: 120,
    signalingJitterMs: 40,
    iceLossPct: 20,
    dcLatencyMs: 120,
    dcJitterMs: 40,
  },
  {
    id: 'edge-3g',
    label: 'Edge / 3G',
    description: '300 ms latency, DataChannel throttled to ~300 KB/s.',
    signalingLatencyMs: 300,
    dcLatencyMs: 300,
    dcThrottleBps: 300 * 1024,
  },
  {
    id: 'flaky',
    label: 'Flaky uplink',
    description: 'Signaling drops every 15 s + 150 ms latency — exercises the rejoin ladder.',
    signalingLatencyMs: 150,
    flakeEveryMs: 15_000,
  },
  {
    id: 'adversarial',
    label: 'Adversarial',
    description: 'Everything at once: 5 % ICE loss, 15 s flakes, 200 ms ±100 ms jitter.',
    signalingLatencyMs: 200,
    signalingJitterMs: 100,
    iceLossPct: 5,
    flakeEveryMs: 20_000,
    dcLatencyMs: 200,
    dcJitterMs: 100,
  },
]

const STORAGE_KEY = 'fluxdrop:chaos'

// ── Active-profile state (module-scoped; reads URL param + sessionStorage) ──

// `undefined` = never resolved (lazy boot read); `null` = explicitly off.
// NB: the distinction matters — initializing to `null` silently skipped the
// URL-param/sessionStorage resolve and turned every ?chaos= run into a
// clean no-op (caught by the F18 E2E).
let active: ChaosProfile | null | undefined

function jitter(max: number): number {
  return max > 0 ? (Math.random() * 2 - 1) * max : 0
}

/** Parse `?chaos=` — either a profile id or a compact spec `latency:250,ice:10,flake:15`. */
export function parseChaosSpec(raw: string): ChaosProfile | null {
  const s = raw.trim()
  if (!s) return null
  const preset = CHAOS_PROFILES.find((p) => p.id === s)
  if (preset) return preset
  const spec: ChaosProfile = {
    id: 'custom',
    label: 'Custom profile',
    description: 'Parsed from the ?chaos= URL parameter.',
  }
  for (const part of s.split(',')) {
    const [kRaw, vRaw] = part.split(':')
    const k = (kRaw ?? '').trim().toLowerCase()
    const v = Number(vRaw)
    if (!Number.isFinite(v) || v < 0) continue
    if (k === 'latency') spec.signalingLatencyMs = Math.min(5000, v)
    else if (k === 'jitter') spec.signalingJitterMs = Math.min(2000, v)
    else if (k === 'ice') spec.iceLossPct = Math.min(100, v)
    else if (k === 'flake') spec.flakeEveryMs = Math.min(120_000, Math.max(2000, v * 1000))
    else if (k === 'dclatency') spec.dcLatencyMs = Math.min(5000, v)
    else if (k === 'dcjitter') spec.dcJitterMs = Math.min(2000, v)
    else if (k === 'throttle') spec.dcThrottleBps = Math.min(100 * 1024 * 1024, v * 1024)
  }
  const meaningful =
    spec.signalingLatencyMs != null || spec.iceLossPct != null || spec.flakeEveryMs != null ||
    spec.dcLatencyMs != null || spec.dcThrottleBps != null
  return meaningful ? spec : null
}

/** Boot-time resolution: URL param wins, else sessionStorage (set by Settings). */
function resolveInitial(): ChaosProfile | null {
  if (typeof window === 'undefined') return null
  try {
    const url = new URL(window.location.href)
    const fromUrl = url.searchParams.get('chaos')
    if (fromUrl) return parseChaosSpec(fromUrl)
    const stored = sessionStorage.getItem(STORAGE_KEY)
    if (stored) return parseChaosSpec(stored)
  } catch { /* ignore */ }
  return null
}

export function activeChaosProfile(): ChaosProfile | null {
  if (active === undefined) {
    active = resolveInitial()
    // Boot-time profile (URL param / restored session) must impair the
    // DataChannel too — not just signaling (activateChaos does this for the
    // Settings-UI path; this is the boot path).
    if (active && typeof window !== 'undefined') chaosApplyDataChannel(active)
  }
  return active
}

let flakeTimer: ReturnType<typeof setInterval> | null = null
let dcPatched = false

// ── Signaling-side helpers (used by signaling.ts) ──

/** ICE candidates are redundant (many per connection) — safe to drop a few. */
export function chaosShouldDropSignaling(profile: ChaosProfile, event: string): boolean {
  if (event === 'webrtc-ice' && profile.iceLossPct && profile.iceLossPct > 0) {
    return Math.random() * 100 < profile.iceLossPct
  }
  return false
}

export function chaosDelayForSignaling(profile: ChaosProfile, _event: string): number {
  const base = profile.signalingLatencyMs ?? 0
  if (base <= 0 && !profile.signalingJitterMs) return 0
  return Math.max(0, Math.round(base + jitter(profile.signalingJitterMs ?? 0)))
}

/**
 * Start the flake timer against a disconnect callback (the signaling wrapper
 * passes socket.disconnect — socket.io auto-reconnects, and the client's
 * rejoin-room machinery rebinds the room; exactly the recovery under test).
 */
export function chaosStartFlake(onFlake: () => void): void {
  chaosStopFlake()
  const p = activeChaosProfile()
  if (!p?.flakeEveryMs) return
  flakeTimer = setInterval(onFlake, p.flakeEveryMs)
}

export function chaosStopFlake(): void {
  if (flakeTimer) {
    clearInterval(flakeTimer)
    flakeTimer = null
  }
}

// ── DataChannel-side helpers (prototype wrapper, applied on activation) ──

/**
 * Patch RTCDataChannel.prototype.send ONCE while chaos is active. The wrapper
 * delays (latency + jitter) and throttles (token bucket) sends but never
 * drops or mutates — integrity paths stay intact.
 */
export function chaosApplyDataChannel(profile: ChaosProfile): void {
  if (typeof window === 'undefined' || dcPatched) return
  const proto = (window as unknown as { RTCDataChannel?: typeof RTCDataChannel }).RTCDataChannel
  if (!proto?.prototype?.send) return
  // UNBOUND original: the wrapper re-binds per call via .call(this, …).
  // Pre-binding to the PROTOTYPE throws "Illegal invocation" on every send —
  // native RTCDataChannel methods need the real receiver's internal slots
  // (found by the F18 chaos harness: manifests silently never arrived).
  const original = proto.prototype.send
  let bucket = profile.dcThrottleBps ? profile.dcThrottleBps : 0
  let lastRefill = Date.now()
  dcPatched = true
  proto.prototype.send = function patchedSend(
    this: RTCDataChannel,
    data: ArrayBufferView | ArrayBuffer | Blob | string,
  ) {
    const p = activeChaosProfile()
    if (!p) {
      // Profile cleared since patch — restore pristine behavior.
      proto.prototype.send = original as typeof proto.prototype.send
      dcPatched = false
      original.call(this, data as never)
      return
    }
    const go = () => original.call(this, data as never)
    const delay = Math.max(0, Math.round((p.dcLatencyMs ?? 0) + jitter(p.dcJitterMs ?? 0)))
    if (p.dcThrottleBps) {
      const now = Date.now()
      bucket = Math.min(p.dcThrottleBps, bucket + ((now - lastRefill) / 1000) * p.dcThrottleBps)
      lastRefill = now
      const size = typeof data === 'string'
        ? data.length
        : data instanceof Blob
          ? data.size
          : data.byteLength
      if (size > bucket) {
        const waitMs = Math.ceil(((size - bucket) / p.dcThrottleBps) * 1000)
        bucket = 0
        setTimeout(go, waitMs + delay)
        return
      }
      bucket -= size
    }
    if (delay > 0) setTimeout(go, delay)
    else go()
  }
}

// ── Public activation API (Settings UI + chaos harness) ──

export function activateChaos(profile: ChaosProfile): void {
  active = profile
  if (typeof window !== 'undefined') {
    try { sessionStorage.setItem(STORAGE_KEY, profile.id === 'custom' ? serializeProfile(profile) : profile.id) } catch { /* ignore */ }
    chaosApplyDataChannel(profile)
  }
}

export function deactivateChaos(): void {
  active = null
  chaosStopFlake()
  if (typeof window !== 'undefined') {
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }
  // The DataChannel wrapper self-restores on the next send once `active` is
  // null (see chaosApplyDataChannel); nothing else to undo eagerly.
}

function serializeProfile(p: ChaosProfile): string {
  const parts: string[] = []
  if (p.signalingLatencyMs) parts.push(`latency:${p.signalingLatencyMs}`)
  if (p.signalingJitterMs) parts.push(`jitter:${p.signalingJitterMs}`)
  if (p.iceLossPct) parts.push(`ice:${p.iceLossPct}`)
  if (p.flakeEveryMs) parts.push(`flake:${Math.round(p.flakeEveryMs / 1000)}`)
  if (p.dcLatencyMs) parts.push(`dclatency:${p.dcLatencyMs}`)
  if (p.dcJitterMs) parts.push(`dcjitter:${p.dcJitterMs}`)
  if (p.dcThrottleBps) parts.push(`throttle:${Math.round(p.dcThrottleBps / 1024)}`)
  return parts.join(',')
}
