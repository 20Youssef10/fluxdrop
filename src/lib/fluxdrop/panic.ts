// v5-b2 (FEATURES-v5.md B2): panic mode / duress PIN.
//
// WHAT this protects
// - A coerced user ("unlock it") can type the DURESS PIN anywhere a room PIN
//   is asked (receiver join form, share-link claim). FluxDrop then:
//     1. wipes every local trace of previous activity — transfer history,
//        the files vault, the resume chunk cache, trusted devices, recent
//        rooms, chat transcript, telemetry — and
//     2. refuses the pairing SILENTLY: the UI shows exactly what a wrong
//        room PIN shows ("Room not found"), so the coercing party learns
//        nothing about the wipe having happened.
//
// KEY model
// - The duress PIN is never stored in plaintext. localStorage keeps
//   { salt, hash } where hash = SHA-256(salt || pin) with a random 16-byte
//   salt; verification is a timing-safe compare of the derived hash. A
//   6-digit duress PIN has the same online-guessing economics as the room
//   PIN itself (each guess needs the settings UI or a room join).
// - localStorage keys use the legacy-style prefix so a paranoid sweep of
//   'fluxdrop:*' keys also disarms the panic PIN itself if the user ever
//   wants a full reset via the browser console.
//
// FAIL-SOFT RULE
// - A wipe failure of any single store never blocks the others (each step
//   is individually try/catch'd); executePanicWipe() itself never throws.

'use client'

import { sha256 } from '@noble/hashes/sha2.js'
import { wipeVault } from './vault'
import { wipeChunkCache, listTransfers, deleteTransferRecord, deleteSenderFiles } from './resume'
import { clearTrustedPeers } from './trusted-peers'
import { clearTelemetry } from './telemetry'
import { useChatStore } from '@/stores/chat-store'
import { resetE2ESession } from './e2e'

const PIN_HASH_KEY = 'fluxdrop:duress-pin-hash'
const PIN_SALT_KEY = 'fluxdrop:duress-pin-salt'
const RECENT_ROOMS_KEY = 'fluxdrop:recent-rooms'

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function toHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}

function fromHex(h: string): Uint8Array {
  const clean = h.length % 2 ? '0' + h : h
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function duressHash(pin: string, salt: Uint8Array): Uint8Array {
  return sha256(new Uint8Array([...salt, ...utf8(pin)]))
}

/** True when a duress PIN is armed on this device. */
export function hasDuressPin(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !!window.localStorage.getItem(PIN_HASH_KEY) && !!window.localStorage.getItem(PIN_SALT_KEY)
  } catch {
    return false
  }
}

/** Arm (or re-arm) the duress PIN. 6+ digits recommended; enforced ≥ 4. */
export function setDuressPin(pin: string): boolean {
  if (typeof window === 'undefined') return false
  const cleaned = pin.trim()
  if (!/^\d{4,12}$/.test(cleaned)) return false
  try {
    const salt = randomBytes(16)
    window.localStorage.setItem(PIN_SALT_KEY, toHex(salt))
    window.localStorage.setItem(PIN_HASH_KEY, toHex(duressHash(cleaned, salt)))
    return true
  } catch {
    return false
  }
}

/** Disarm the duress PIN (Settings → Privacy — the honest UI path). */
export function removeDuressPin(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(PIN_HASH_KEY)
    window.localStorage.removeItem(PIN_SALT_KEY)
  } catch { /* ignore */ }
}

/**
 * Check a user-typed room PIN against the armed duress PIN.
 * Constant-time on the digest; false when not armed.
 */
export function isDuressPin(pin: string): boolean {
  if (typeof window === 'undefined') return false
  if (!pin) return false
  try {
    const storedHash = window.localStorage.getItem(PIN_HASH_KEY)
    const storedSalt = window.localStorage.getItem(PIN_SALT_KEY)
    if (!storedHash || !storedSalt) return false
    return timingSafeEqual(duressHash(pin, fromHex(storedSalt)), fromHex(storedHash))
  } catch {
    return false
  }
}

export interface PanicWipeResult {
  /** Human-readable list of the stores that were purged (for the log only —
   * the UI NEVER shows this; the wipe is silent by design). */
  wiped: string[]
}

/**
 * Execute the panic wipe. Idempotent, never throws. Wipes:
 * transfer history records + sender file attachments, the files vault
 * (OPFS + metadata), the resume chunk cache, trusted devices, recent rooms,
 * the chat transcript, the transparency trail, and every live/in-memory E2E
 * session key. The duress PIN itself stays armed (re-entering it re-wipes
 * harmlessly; the honest removal path is Settings → Privacy).
 */
export async function executePanicWipe(): Promise<PanicWipeResult> {
  const wiped: string[] = []
  // 1. Transfer history + sender-side file attachments.
  try {
    const records = await listTransfers()
    for (const rec of records) {
      await deleteTransferRecord(rec.transferId)
      await deleteSenderFiles(rec.transferId)
    }
    if (records.length > 0) wiped.push(`history (${records.length})`)
  } catch { /* best-effort */ }
  // 2. Files vault (every entry + the OPFS subtree).
  try {
    const n = await wipeVault()
    if (n > 0) wiped.push(`vault (${n})`)
  } catch { /* best-effort */ }
  // 3. Resume chunk cache (received partial chunks).
  try {
    const n = await wipeChunkCache()
    if (n > 0) wiped.push(`chunk cache (${n})`)
  } catch { /* best-effort */ }
  // 4. Trusted devices.
  try {
    clearTrustedPeers()
    wiped.push('trusted devices')
  } catch { /* best-effort */ }
  // 5. Recent rooms.
  try {
    window.localStorage.removeItem(RECENT_ROOMS_KEY)
    wiped.push('recent rooms')
  } catch { /* best-effort */ }
  // 6. Chat transcript + transparency trail.
  try {
    useChatStore.getState().clearMessages()
    wiped.push('chat')
  } catch { /* best-effort */ }
  try {
    clearTelemetry()
    wiped.push('telemetry')
  } catch { /* best-effort */ }
  // 7. Live E2E session keys (drops every PAKE-derived key from memory).
  try {
    resetE2ESession()
    wiped.push('session keys')
  } catch { /* best-effort */ }
  return { wiped }
}
