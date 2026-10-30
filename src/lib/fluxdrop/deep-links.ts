// v5-d12: ONE parser for every FluxDrop link shape.
//
// Three entry surfaces meet here:
//   1. Web hash links (QR codes, kiosk walls):  https://host/#claim=ROOM&pin=PIN
//      and the older  #join=ROOM&pin=PIN  (both produced by the web app).
//   2. The custom URL scheme (native shells):   fluxdrop://join?room=ROOM&pin=PIN
//      / fluxdrop://claim?... / fluxdrop://open  — delivered by the Tauri
//      deep-link plugin on desktop and by the Android intent filter in the
//      Capacitor shell.
//   3. `.fluxdrop` room-link FILES (desktop file association) whose tiny text
//      content is a fluxdrop:// URL — the Rust shell reads them and forwards
//      the URL through the same event channel.
//
// Room codes and PINs are NOT trusted here — the signaling server validates
// both exactly like a hand-typed join; this parser only routes.

export type FluxLinkKind = 'join' | 'claim' | 'open'

export interface ParsedFluxLink {
  kind: FluxLinkKind
  roomCode: string
  pin: string
}

const CLAIM_HASH_RE = /claim=([A-Za-z0-9]+)&pin=(\d+)/
const JOIN_HASH_RE = /join=([A-Za-z0-9]+)&pin=(\d+)/

/**
 * Parse any FluxDrop link shape (hash fragment, full https URL with a hash,
 * or a fluxdrop:// scheme URL). Returns null when nothing actionable.
 * Order matters for hash links: claim wins over join (kiosk QRs mint claims).
 */
export function parseFluxLink(input: string | null | undefined): ParsedFluxLink | null {
  if (!input) return null
  const raw = input.trim()
  if (!raw) return null

  // --- Custom scheme: fluxdrop://join?room=X&pin=Y | claim | open -----------
  if (/^fluxdrop:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      const host = u.hostname.toLowerCase()
      if (host === 'open') return { kind: 'open', roomCode: '', pin: '' }
      if (host === 'join' || host === 'claim') {
        const roomCode = (u.searchParams.get('room') ?? '').trim()
        const pin = (u.searchParams.get('pin') ?? '').trim()
        if (roomCode.length > 0 && pin.length > 0) {
          return { kind: host, roomCode, pin }
        }
      }
      return null
    } catch {
      return null
    }
  }

  // --- Hash links: #claim=ROOM&pin=PIN | #join=ROOM&pin=PIN -----------------
  // Accept the bare fragment (window.location.hash), a full URL containing
  // one, or a raw "claim=...&pin=..." string (test convenience).
  const hashIdx = raw.indexOf('#')
  const hash = hashIdx >= 0 ? raw.slice(hashIdx) : raw
  const claim = CLAIM_HASH_RE.exec(hash)
  if (claim) return { kind: 'claim', roomCode: claim[1], pin: claim[2] }
  const join = JOIN_HASH_RE.exec(hash)
  if (join) return { kind: 'join', roomCode: join[1], pin: join[2] }
  return null
}

/** Build a fluxdrop:// scheme link (native shells, .fluxdrop room-link files). */
export function buildFluxdropSchemeUrl(kind: 'join' | 'claim', roomCode: string, pin: string): string {
  return `fluxdrop://${kind}?room=${encodeURIComponent(roomCode)}&pin=${encodeURIComponent(pin)}`
}

/** Build the web hash link shape the QR codes and kiosk walls already use. */
export function buildWebHashUrl(kind: 'join' | 'claim', roomCode: string, pin: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '/'
  return `${origin}#${kind}=${encodeURIComponent(roomCode)}&pin=${encodeURIComponent(pin)}`
}
