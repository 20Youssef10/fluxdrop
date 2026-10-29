// v4 (2.6): transparency telemetry — "what left your device this session".
// A voluntary, local-only audit trail: every signaling frame we EMIT, bytes
// that crossed the DataChannel (direction + size, never content), and the IP
// versions/types of ICE candidates we saw. Nothing here ever leaves the tab.

'use client'

export interface TelemetryEvent {
  ts: number
  dir: 'out' | 'in'
  event: string
  /** Frame/payload size in bytes when known. */
  bytes?: number
}

export interface TransparencyReport {
  events: TelemetryEvent[]
  totalOut: number
  totalIn: number
  datachannelBytesSent: number
  datachannelBytesReceived: number
  /** ICE candidate summary: type → count, plus IPv4/IPv6 availability. */
  iceCandidates: {
    localTypes: Record<string, number>
    remoteTypes: Record<string, number>
    sawIpv4: boolean
    sawIpv6: boolean
    /** v4 (3.5): first v6 candidate addresses (masked to prefix) for guidance. */
    ipv6Prefixes: string[]
  }
  signalingBytesOut: number
  signalingBytesIn: number
}

const MAX_EVENTS = 400

let events: TelemetryEvent[] = []
let datachannelBytesSent = 0
let datachannelBytesReceived = 0
let signalingBytesOut = 0
let signalingBytesIn = 0
const localTypes: Record<string, number> = {}
const remoteTypes: Record<string, number> = {}
let sawIpv4 = false
let sawIpv6 = false
const ipv6Prefixes = new Set<string>()

const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) {
    try {
      l()
    } catch { /* listener errors must not break the app */ }
  }
}

export function subscribeTelemetry(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Record a signaling frame we emitted or received. */
export function recordSignalingEvent(dir: 'out' | 'in', event: string, bytes?: number): void {
  events.push({ ts: Date.now(), dir, event, bytes })
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS)
  if (dir === 'out') signalingBytesOut += bytes ?? 0
  else signalingBytesIn += bytes ?? 0
  notify()
}

/** Record DataChannel wire bytes (both directions — payload sizes only). */
export function recordDatachannelBytes(sent: number, received: number): void {
  if (sent <= 0 && received <= 0) return
  datachannelBytesSent += sent
  datachannelBytesReceived += received
}

/** Record an ICE candidate (address stays local — only type/version counted). */
export function recordIceCandidate(candidate: { candidate?: string; type?: string }, side: 'local' | 'remote'): void {
  const cands = candidate.candidate ?? ''
  if (!cands) return
  const m = cands.match(/typ (\w+)/)
  const typ = m?.[1] ?? candidate.type ?? 'unknown'
  const bucket = side === 'local' ? localTypes : remoteTypes
  bucket[typ] = (bucket[typ] ?? 0) + 1
  if (cands.includes(' UDP ') || cands.includes(' TCP ')) {
    // v6 detection: candidate lines carry the connection address.
    const addr = cands.split(' ')[4] ?? ''
    if (addr.includes(':')) {
      sawIpv6 = true
      const prefix = addr.split(':').slice(0, 3).join(':')
      if (ipv6Prefixes.size < 6) ipv6Prefixes.add(prefix + '::/48')
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
      sawIpv4 = true
    }
  }
  notify()
}

export function getTransparencyReport(): TransparencyReport {
  return {
    events: [...events],
    totalOut: events.filter((e) => e.dir === 'out').length,
    totalIn: events.filter((e) => e.dir === 'in').length,
    datachannelBytesSent,
    datachannelBytesReceived,
    iceCandidates: {
      localTypes: { ...localTypes },
      remoteTypes: { ...remoteTypes },
      sawIpv4,
      sawIpv6,
      ipv6Prefixes: [...ipv6Prefixes],
    },
    signalingBytesOut,
    signalingBytesIn,
  }
}

export function clearTelemetry(): void {
  events = []
  datachannelBytesSent = 0
  datachannelBytesReceived = 0
  signalingBytesOut = 0
  signalingBytesIn = 0
  for (const k of Object.keys(localTypes)) delete localTypes[k]
  for (const k of Object.keys(remoteTypes)) delete remoteTypes[k]
  sawIpv4 = false
  sawIpv6 = false
  ipv6Prefixes.clear()
  notify()
}
