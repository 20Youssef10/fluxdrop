// v1.2 (FEATURES.md 2.3): at-rest encryption for FluxDrop's local persistence.
//
// WHAT this protects
// - Receiver chunk payloads (the resume cache) and transfer-history records
//   live in IndexedDB and used to be plaintext on disk. Values routed through
//   this module are sealed with AES-256-GCM before they ever hit storage.
//
// KEY model
// - A single non-extractable AES-256-GCM key is generated ONCE per browser
//   profile and the live CryptoKey OBJECT itself is persisted in its own
//   IndexedDB database ('fluxdrop-keys' / 'keys'). CryptoKeys are structured-
//   cloneable, so they survive the IDB round-trip while REMAINING
//   non-extractable: `crypto.subtle.exportKey` always refuses, so neither this
//   code nor any other script on the origin can ever read the raw key bytes
//   back out. This is defense-in-depth (it seals stored values against offline
//   inspection and key exfiltration by scripts), not a substitute for
//   OS-level disk encryption.
//
// ENVELOPE format (versioned, so plaintext legacy values stay distinguishable)
//   { __fluxdropEnc: 1, data: <nonce(12B) || AES-256-GCM ciphertext> }
// - AAD is the constant string 'fluxdrop:at-rest:v1'.
//
// FALLBACK RULE (never break transfers)
// - If WebCrypto or IndexedDB is unavailable (insecure context, private-mode
//   quirks, storage blocked), `atRestEncryptionAvailable()` returns false and
//   callers persist plaintext exactly as before. Sealing failures also fall
//   back to plaintext — encryption is an upgrade, never a blocker.
//
// PARANOID MODE
// - `initParanoidMode()` runs once from module scope (client-only guard) and
//   arms listeners that purge every 'chunk:'-prefixed key from the chunks
//   store on pagehide (tab close / reload). It also purges leftovers from a
//   previous session at load time if the flag is already on (a crash or
//   force-kill can prevent the pagehide wipe from completing). The flag is
//   read straight from localStorage ('fluxdrop:paranoid-mode') so the wipe is
//   armed even before React hydrates the settings UI.

import { createStore, get as idbGet, set as idbSet, type UseStore } from 'idb-keyval'

// --- Key store (its own DB — see resume.ts for why each store gets its own DB) ---

let keysStore: UseStore | null = null

function getKeyStore(): UseStore | null {
  if (typeof window === 'undefined' || !window.indexedDB) return null
  if (!keysStore) {
    try {
      keysStore = createStore('fluxdrop-keys', 'keys')
    } catch {
      // IndexedDB unavailable (private mode / blocked storage) — plaintext fallback.
      return null
    }
  }
  return keysStore
}

const AT_REST_KEY_ID = 'at-rest:v1'
const NONCE_BYTES = 12
// Additional authenticated data — binds every ciphertext to this exact
// purpose/version so blobs can never be replayed into another context.
const AAD = new TextEncoder().encode('fluxdrop:at-rest:v1')

let cachedKey: CryptoKey | null = null
let keyPromise: Promise<CryptoKey> | null = null
// Set when the environment can't support at-rest encryption at all.
let unavailable = false

/** True when WebCrypto + IndexedDB are usable in this context. */
export function atRestEncryptionAvailable(): boolean {
  if (unavailable) return false
  if (typeof window === 'undefined') return false
  try {
    // crypto.subtle only exists in secure contexts (https / localhost).
    if (!window.crypto?.subtle || !window.indexedDB) return false
  } catch {
    return false
  }
  return true
}

/** Minimal runtime guard for a persisted (cloned) CryptoKey of the right shape. */
function isAtRestKey(value: unknown): value is CryptoKey {
  const k = value as CryptoKey | undefined
  return (
    !!k &&
    k instanceof CryptoKey &&
    k.type === 'secret' &&
    (k.algorithm as AesKeyAlgorithm | undefined)?.name === 'AES-GCM' &&
    (k.algorithm as AesKeyAlgorithm | undefined)?.length === 256 &&
    !k.extractable &&
    k.usages.includes('encrypt') &&
    k.usages.includes('decrypt')
  )
}

/**
 * The profile-wide at-rest key. Generated once (non-extractable, encrypt/
 * decrypt only) and persisted as a structured-cloned CryptoKey object.
 * Concurrent callers share one in-flight generation promise.
 * Throws when WebCrypto/IndexedDB is unavailable — callers must check
 * `atRestEncryptionAvailable()` first or handle the rejection.
 */
export async function getAtRestKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  if (keyPromise) return keyPromise
  keyPromise = (async () => {
    const store = getKeyStore()
    if (!store) throw new Error('secure-store: IndexedDB unavailable')
    // Reuse the existing key if this profile already generated one.
    const existing = await idbGet(AT_REST_KEY_ID, store)
    if (isAtRestKey(existing)) {
      cachedKey = existing
      return existing
    }
    const key = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable — the raw key material can never leave WebCrypto
      ['encrypt', 'decrypt']
    )
    // Store the CryptoKey OBJECT (structured-cloneable; stays non-extractable
    // after the clone), not exported bytes — there ARE no exported bytes.
    await idbSet(AT_REST_KEY_ID, key, store)
    cachedKey = key
    return key
  })()
  try {
    return await keyPromise
  } catch (err) {
    unavailable = true
    keyPromise = null
    throw err
  }
}

// --- Raw seal / open (nonce || ciphertext, AAD-bound) ---

/** Encrypt `data` → `nonce(12B) || ciphertext`. */
export async function encryptAtRest(data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  const key = await getAtRestKey()
  const nonce = window.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  // WebCrypto's BufferSource wants an ArrayBuffer-backed view. Chunk saves
  // pass an ArrayBuffer (zero-copy); any Uint8Array is copied once into a
  // plain ArrayBuffer-backed view (records are tiny — negligible).
  const payload: ArrayBuffer | Uint8Array<ArrayBuffer> =
    data instanceof Uint8Array ? new Uint8Array(data) : data
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: AAD },
    key,
    payload
  )
  const out = new Uint8Array(NONCE_BYTES + ciphertext.byteLength)
  out.set(nonce, 0)
  out.set(new Uint8Array(ciphertext), NONCE_BYTES)
  return out.buffer
}

/** Inverse of `encryptAtRest`. Throws on tampered/undecryptable input. */
export async function decryptAtRest(enc: ArrayBuffer): Promise<ArrayBuffer> {
  if (enc.byteLength <= NONCE_BYTES) throw new Error('secure-store: ciphertext too short')
  const key = await getAtRestKey()
  const nonce = new Uint8Array(enc, 0, NONCE_BYTES)
  const ciphertext = new Uint8Array(enc, NONCE_BYTES)
  return window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: AAD },
    key,
    ciphertext
  )
}

// --- Versioned envelope for IndexedDB values ---

export const ENVELOPE_VERSION = 1

export interface EncryptedEnvelope {
  __fluxdropEnc: typeof ENVELOPE_VERSION
  data: ArrayBuffer
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false
  const v = value as { __fluxdropEnc?: unknown; data?: unknown }
  return v.__fluxdropEnc === ENVELOPE_VERSION && v.data instanceof ArrayBuffer
}

/**
 * Seal a value into an envelope for storage. Returns `null` when encryption
 * is unavailable or fails — callers then write the plaintext value as before.
 */
export async function sealValue(
  plain: ArrayBuffer | Uint8Array
): Promise<EncryptedEnvelope | null> {
  if (!atRestEncryptionAvailable()) return null
  try {
    const data = await encryptAtRest(plain)
    return { __fluxdropEnc: ENVELOPE_VERSION, data }
  } catch {
    return null
  }
}

/** Open an envelope back to plaintext bytes. Throws on corruption. */
export async function unsealBytes(env: EncryptedEnvelope): Promise<ArrayBuffer> {
  return decryptAtRest(env.data)
}

// --- Paranoid mode: wipe the chunk cache on tab close ---

const PARANOID_FLAG = 'fluxdrop:paranoid-mode'

/** Paranoid-mode flag, read straight from localStorage (no store round-trip). */
export function paranoidModeEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PARANOID_FLAG) === 'true'
  } catch {
    return false
  }
}

/**
 * Purge every 'chunk:'-prefixed key from the chunks store. Implemented in
 * resume.ts (owner of the chunks store); resolved via dynamic import so the
 * two modules never form a static import cycle — resume.ts loads this module
 * for its sealing helpers, and by the time any purge runs the module graph
 * (and `wipeChunkCache`) is fully evaluated.
 */
async function purgeChunkCacheNow(): Promise<number> {
  try {
    const resume = await import('./resume')
    return await resume.wipeChunkCache()
  } catch {
    return 0
  }
}

let paranoidArmed = false

/**
 * Arm paranoid mode (idempotent, client-only):
 * 1. If the flag is already on at load time, purge any chunk keys a previous
 *    session left behind (crash / force-kill before the pagehide wipe ran).
 * 2. Register pagehide (fired on tab close, reload, and bfcache eviction) and
 *    a best-effort beforeunload listener that purges the chunk cache.
 * Called once from module scope; resume.ts statically imports this module, so
 * it is armed app-wide on page load without touching use-fluxdrop.ts.
 */
export function initParanoidMode(): void {
  if (typeof window === 'undefined') return
  if (paranoidArmed) return
  paranoidArmed = true

  if (paranoidModeEnabled()) {
    // Leftover purge for a previous session. Fire-and-forget: the dynamic
    // import resolves once resume.ts finishes evaluating (we may currently be
    // mid-cycle inside its import phase).
    void purgeChunkCacheNow()
  }

  const onLeave = () => {
    if (paranoidModeEnabled()) void purgeChunkCacheNow()
  }
  window.addEventListener('pagehide', onLeave)
  // Best-effort for engines/paths where pagehide may not fire (hard unload).
  window.addEventListener('beforeunload', onLeave)
}

// Arm on load (client only — the guard inside covers SSR evaluation).
initParanoidMode()
