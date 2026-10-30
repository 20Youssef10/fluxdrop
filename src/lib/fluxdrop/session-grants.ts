// v5-b4 (FEATURES-v5.md B4): scoped per-session permission grants.
//
// WHAT this is
// - The RECEIVER that consents to a transfer also decides which SESSION
//   capabilities it grants the SENDER: in-room `chat` display and
//   clipboard-sync pushes (`clipboard`). `files` models future pull-mode
//   browse rights (C6) and is always false until that ships.
// - Grants ride the existing `transfer-accepted` signaling event (optional
//   `grants` field — older senders ignore it and default-allow, matching
//   pre-v5 behavior).
//
// ENFORCEMENT MODEL (receiver side is the authority)
// - RECEIVER: inbound CHAT/CLIPBOARD frames from a peer whose grant is
//   denied are dropped silently in the engine (before any UI surfaces them).
// - SENDER: outbound chat/clipboard to a peer that granted less is filtered
//   client-side (UX polish — stops "sent" messages that would be dropped
//   anyway). Absent grants for a peer (older receiver, or before the
//   accept lands) = default-allow, byte-identical to v1.3/v4 behavior.
//
// LIFETIME: per session (in-memory module state, cleared on cleanup). No
// persistence — a new pairing must re-consent, which is the point.

'use client'

import { DEFAULT_SESSION_GRANTS, type SessionGrants } from './protocol'

export type { SessionGrants }

/** Normalized (possibly partial) grants from the wire. Unknown/absent = default. */
function normalizeGrants(raw: unknown): SessionGrants {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SESSION_GRANTS }
  const g = raw as Partial<Record<keyof SessionGrants, unknown>>
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)
  return {
    files: bool(g.files, false),
    chat: bool(g.chat, true),
    clipboard: bool(g.clipboard, false),
  }
}

export interface GrantRecord {
  /** The peer deviceId the grants are ABOUT (who granted/denied whom). */
  peerId: string
  /** True when THIS device received these grants (we are the sender). */
  grantedToUs: boolean
  grants: SessionGrants
  at: number
}

// ─── module state (page lifetime) ───

const records = new Map<string, GrantRecord>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) {
    try { l() } catch { /* listener errors never break grants */ }
  }
}

/** Subscribe to grant changes (transparency panel). Returns an unsubscribe. */
export function subscribeGrants(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Every grant record this session (transparency readout). */
export function listGrantRecords(): GrantRecord[] {
  return [...records.values()].sort((a, b) => b.at - a.at)
}

/** Record grants a receiver granted US (sender side, from transfer-accepted). */
export function recordIncomingGrants(peerId: string, raw: unknown): void {
  if (!peerId) return
  records.set(peerId, {
    peerId,
    grantedToUs: true,
    grants: normalizeGrants(raw),
    at: Date.now(),
  })
  notify()
}

/** Record grants WE granted a peer (receiver side, at consent time). */
export function recordOutgoingGrants(peerId: string, grants: SessionGrants): void {
  if (!peerId) return
  records.set(peerId, {
    peerId,
    grantedToUs: false,
    grants,
    at: Date.now(),
  })
  notify()
}

// ─── enforcement queries ───

/**
 * May the peer USE this capability with us? (receiver-side inbound check —
 * the authoritative gate.) Default-allow when we hold no record for the peer.
 */
export function grantAllows(peerId: string | null | undefined, cap: keyof SessionGrants): boolean {
  if (!peerId) return true
  const rec = records.get(peerId)
  if (!rec || rec.grantedToUs) return true // no receiver-side record / wrong direction
  return rec.grants[cap] === true
}

/**
 * Are WE allowed to use this capability WITH the peer? (sender-side outbound
 * check — UX filtering; the receiver still drops denied frames defensively.)
 */
export function grantedToUse(peerId: string | null | undefined, cap: keyof SessionGrants): boolean {
  if (!peerId) return true
  const rec = records.get(peerId)
  if (!rec || !rec.grantedToUs) return true // no sender-side record (older peer)
  return rec.grants[cap] === true
}

/** Clear every grant (cleanup / new session). */
export function clearGrants(): void {
  records.clear()
  notify()
}
