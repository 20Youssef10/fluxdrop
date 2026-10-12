/**
 * Unit tests for FluxDrop checksum verification.
 * Run: bun test tests/unit/checksum.test.ts
 *
 * Verifies that hashFile produces standard SHA-256 for files ≤ 256 MB
 * (matches `sha256sum` output).
 */

import { describe, test, expect } from 'bun:test'
import { hashFile, hashBytes } from '../../src/lib/fluxdrop/checksum'

// Known SHA-256 hash of "hello" (from `echo -n "hello" | sha256sum`)
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

// Known SHA-256 of empty string
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('hashBytes', () => {
  test('hashes "hello" correctly (matches sha256sum)', async () => {
    const result = await hashBytes(new TextEncoder().encode('hello'))
    expect(result).toBe(HELLO_SHA256)
  })

  test('hashes empty input correctly', async () => {
    const result = await hashBytes(new ArrayBuffer(0))
    expect(result).toBe(EMPTY_SHA256)
  })

  test('produces a 64-character hex string', async () => {
    const result = await hashBytes(new Uint8Array([1, 2, 3]))
    expect(result.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(result)).toBe(true)
  })
})

describe('hashFile', () => {
  test('hashes a small Blob (matches sha256sum)', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const result = await hashFile(blob)
    expect(result).toBe(HELLO_SHA256)
  })

  test('hashes an empty Blob', async () => {
    const blob = new Blob([], { type: 'application/octet-stream' })
    const result = await hashFile(blob)
    expect(result).toBe(EMPTY_SHA256)
  })

  test('produces a 64-character hex string for larger file', async () => {
    const data = new Uint8Array(1024).fill(0x42)
    const blob = new Blob([data], { type: 'application/octet-stream' })
    const result = await hashFile(blob)
    expect(result.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(result)).toBe(true)
  })
})
