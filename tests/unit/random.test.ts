/**
 * Unit tests for secure-context-safe identifiers.
 * Run: bun test tests/unit/random.test.ts
 *
 * Regression: opening FluxDrop over plain HTTP on a LAN address (anything but
 * http://localhost) hides `crypto.randomUUID`, which used to crash device
 * setup with "crypto.randomUUID is not a function".
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { randomUUID } from '../../src/lib/fluxdrop/random'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const realCrypto = globalThis.crypto

function stubCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', {
    value,
    configurable: true,
    writable: true,
  })
}

afterEach(() => stubCrypto(realCrypto))

describe('randomUUID — native secure context', () => {
  test('returns an RFC 4122 v4 UUID', () => {
    expect(randomUUID()).toMatch(UUID_V4)
  })

  test('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomUUID()))
    expect(ids.size).toBe(500)
  })
})

describe('randomUUID — insecure origin (no crypto.randomUUID)', () => {
  test('falls back to getRandomValues and still returns a v4 UUID', () => {
    stubCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    expect((globalThis.crypto as Partial<Crypto>).randomUUID).toBeUndefined()

    expect(randomUUID()).toMatch(UUID_V4)
  })

  test('stays unique across many calls', () => {
    stubCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    const ids = new Set(Array.from({ length: 500 }, () => randomUUID()))
    expect(ids.size).toBe(500)
  })

  test('sets the version and variant bits, not just random bytes', () => {
    stubCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    for (let i = 0; i < 50; i++) {
      const id = randomUUID()
      expect(id[14]).toBe('4')
      expect('89ab').toContain(id[19])
    }
  })
})

describe('randomUUID — degraded environments', () => {
  test('recovers when crypto.randomUUID throws', () => {
    stubCrypto({
      randomUUID: () => {
        throw new Error('blocked by policy')
      },
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    })
    expect(randomUUID()).toMatch(UUID_V4)
  })

  test('never throws when Web Crypto is missing entirely', () => {
    stubCrypto(undefined)
    expect(randomUUID()).toMatch(UUID_V4)
  })
})
