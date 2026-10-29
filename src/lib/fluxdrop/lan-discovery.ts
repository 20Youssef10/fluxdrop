// v4 (3.2): LAN discovery client — polls the signaling service's /nearby
// endpoint, which groups devices by subnet (IPv4 /24, IPv6 /64). Presence is
// announced by the poll itself (30s TTL server-side); the response NEVER
// contains IP addresses — only device ids, aliases and roles.

'use client'

export interface NearbyDevice {
  deviceId: string
  alias: string
  role: 'sender' | 'receiver' | string
  seenAt: number
}

const NEARBY_PORT = 3003

/**
 * Announce this device and list same-subnet peers. Returns null when the
 * endpoint is unreachable (older signaling server, offline, etc.) — callers
// treat null as "feature unavailable", never as "no devices".
 */
export async function pollNearby(deviceId: string, alias: string, role: 'sender' | 'receiver'): Promise<NearbyDevice[] | null> {
  if (typeof window === 'undefined') return null
  try {
    const url =
      `/nearby?XTransformPort=${NEARBY_PORT}` +
      `&deviceId=${encodeURIComponent(deviceId)}` +
      `&alias=${encodeURIComponent(alias.slice(0, 32))}` +
      `&role=${encodeURIComponent(role)}`
    const res = await fetch(url, { method: 'GET', cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { peers?: NearbyDevice[] }
    if (!Array.isArray(data.peers)) return null
    return data.peers
  } catch {
    return null
  }
}

/** Probe the signaling region endpoint (8.3 client half). */
export async function fetchSignalingRegion(): Promise<{ region: string; version: string; uptimeSec: number } | null> {
  if (typeof window === 'undefined') return null
  try {
    const res = await fetch(`/region?XTransformPort=${NEARBY_PORT}`, { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as { region: string; version: string; uptimeSec: number }
  } catch {
    return null
  }
}
