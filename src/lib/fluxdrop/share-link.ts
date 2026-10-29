// v4 (3.4): expiring share links — client half.
// POST /link pre-creates the room server-side with a selectable TTL and
// optional one-join semantics. The sender then CLAIMS that room through the
// normal create-room socket event (the claim carries code+pin), and the
// shareable URL is the existing deep-link format (#join=ROOM&pin=PIN), so
// receivers need zero new code.

'use client'

export interface ShareLinkOptions {
  /** Minutes: 5 | 60 | 1440 (server enforces the set). */
  ttlMinutes: 5 | 60 | 1440
  /** Room closes after the first pairing completes. */
  oneJoin: boolean
}

export interface ShareLink {
  roomCode: string
  pin: string
  expiresAt: number
  oneJoin: boolean
  /** Ready-to-share absolute URL (#join deep link). */
  url: string
}

const LINK_PORT = 3003

export async function createShareLink(opts: ShareLinkOptions): Promise<ShareLink> {
  const res = await fetch(`/link?XTransformPort=${LINK_PORT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttlMinutes: opts.ttlMinutes, oneJoin: opts.oneJoin }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Link creation failed (${res.status}) ${detail.slice(0, 120)}`)
  }
  const data = (await res.json()) as { roomCode: string; pin: string; expiresAt: number; oneJoin?: boolean }
  const url =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}#join=${data.roomCode}&pin=${data.pin}`
      : `#join=${data.roomCode}&pin=${data.pin}`
  return {
    roomCode: data.roomCode,
    pin: data.pin,
    expiresAt: data.expiresAt,
    oneJoin: !!data.oneJoin,
    url,
  }
}
