// Secure-context-safe random identifiers.
//
// `crypto.randomUUID()` only exists in secure contexts — HTTPS, `http://localhost`
// or `file://`. FluxDrop is routinely opened from another device over plain HTTP
// on a LAN address (e.g. http://192.168.1.20:8081), where `crypto.randomUUID` is
// `undefined` and device/transfer setup dies with
// "crypto.randomUUID is not a function".
//
// `crypto.getRandomValues()` is NOT gated behind secure contexts, so it still
// provides cryptographically strong randomness there — enough to build a proper
// RFC 4122 v4 UUID. The Math.random path is a last resort for browsers with no
// Web Crypto at all: IDs stay unique enough to route a transfer, but they are
// no longer unguessable.

const UUID_V4_TEMPLATE = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'

interface WebCryptoLike {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

function getWebCrypto(): WebCryptoLike | undefined {
  if (typeof globalThis === 'undefined') return undefined
  return (globalThis as unknown as { crypto?: WebCryptoLike }).crypto
}

/**
 * RFC 4122 version-4 UUID that also works on insecure origins.
 * Uses the native implementation when the browser exposes it.
 */
export function randomUUID(): string {
  const webCrypto = getWebCrypto()

  if (typeof webCrypto?.randomUUID === 'function') {
    try {
      return webCrypto.randomUUID()
    } catch {
      // Some embedded browsers expose the method but refuse to run it.
    }
  }

  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    webCrypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return UUID_V4_TEMPLATE.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
