// v1.1: TURN relay fallback.
//
// FluxDrop ships with public STUN only, so transfers between peers behind
// symmetric NATs (or strict corporate firewalls) used to fail outright —
// the #1 "it didn't connect" scenario. A TURN relay fixes that at the cost
// of relaying bytes through a server, so it is strictly a FALLBACK: the ICE
// agent still prefers direct host/srflx pairs whenever they exist.
//
// Credentials use the standard coturn "static-auth-secret" scheme: the
// signaling server mints `username = <expiry>:<prefix>` and
// `password = base64(HMAC-SHA256(secret, username))`. Short-lived by
// construction, no TURN user database needed.
//
// The endpoint is served by the signaling mini-service (port 3003) and
// reaches the browser through the same Caddy gateway as socket.io.

import type { IceServerConfig } from '@/stores/session-store'

const SESSION_CACHE_KEY = 'fluxdrop:turn-creds'

export interface TurnCredentials {
  enabled: boolean
  ttlSeconds?: number
  iceServers?: RTCIceServer[]
}

interface CachedCreds {
  fetchedAt: number
  creds: TurnCredentials
}

/**
 * Fetch short-lived TURN credentials from the signaling service.
 * Cached in sessionStorage for 80% of the TTL (coturn default realm TTL is
 * 600s → refetch ~every 8 minutes). Never throws: on any failure we return
 * { enabled: false } and the connection proceeds STUN-only.
 */
export async function fetchTurnCredentials(signal?: AbortSignal): Promise<TurnCredentials> {
  if (typeof window === 'undefined') return { enabled: false }
  try {
    const cachedRaw = sessionStorage.getItem(SESSION_CACHE_KEY)
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CachedCreds
      const ttl = (cached.creds.ttlSeconds ?? 600) * 1000
      if (Date.now() - cached.fetchedAt < ttl * 0.8) {
        return cached.creds
      }
    }
  } catch { /* ignore cache errors */ }

  try {
    const res = await fetch('/turn-credentials?XTransformPort=3003', { signal })
    if (!res.ok) return { enabled: false }
    const data = (await res.json()) as TurnCredentials
    if (!data?.enabled || !Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      return { enabled: false }
    }
    try {
      sessionStorage.setItem(
        SESSION_CACHE_KEY,
        JSON.stringify({ fetchedAt: Date.now(), creds: data } satisfies CachedCreds)
      )
    } catch { /* ignore */ }
    return data
  } catch {
    return { enabled: false }
  }
}

/**
 * Merge auto-minted TURN credentials into the effective ICE server list.
 * Precedence: user-configured custom servers win entirely (they may be
 * pointing at their own TURN); otherwise STUN defaults + TURN fallback.
 */
export function mergeTurnIntoIceServers(
  base: RTCIceServer[] | undefined,
  turn: TurnCredentials,
  allowRelay: boolean
): RTCIceServer[] {
  const baseServers = base ?? []
  if (!allowRelay || !turn.enabled || !turn.iceServers) return baseServers
  // Avoid duplicating the same TURN URL if the user already added one.
  const existingUrls = new Set(
    baseServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
  )
  const extra = turn.iceServers.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
    return !urls.every((u) => existingUrls.has(u))
  })
  return extra.length > 0 ? [...baseServers, ...extra] : baseServers
}

/** Convenience for the settings UI: shape TURN creds as editable entries. */
export function turnToIceServerConfigs(creds: TurnCredentials): IceServerConfig[] {
  if (!creds.enabled || !creds.iceServers) return []
  return creds.iceServers.map((s) => ({
    urls: Array.isArray(s.urls) ? s.urls.join(', ') : s.urls,
    username: s.username,
    credential: s.credential,
  }))
}
