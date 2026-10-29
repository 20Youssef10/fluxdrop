// v4: Web NFC pairing (3.3) — tap-to-hand the join URL to an Android phone.
// Web NFC is Chrome-on-Android only; every other platform gets a clean
// "not supported" result and the QR stays the primary path. The record is a
// plain URL record (works from any scanner), nothing exotic.

'use client'

interface NdefReaderLike {
  write: (data: string, opts?: { signal?: AbortSignal }) => Promise<void>
  onreading: ((e: unknown) => void) | null
  onreadingerror: ((e: unknown) => void) | null
}

type NdefCtor = new () => NdefReaderLike

export function isNfcSupported(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window
}

/**
 * Write `url` to an NFC tag as a well-known URI record.
 * Resolves 'written' on success, 'cancelled' when the user aborted (tag
 * removed / timeout), 'unsupported' when the API is missing, or the raw
 * error message.
 */
export async function writeNfcUrl(url: string): Promise<'written' | 'cancelled' | 'unsupported' | string> {
  if (!isNfcSupported()) return 'unsupported'
  try {
    const ctor = (window as unknown as { NDEFReader: NdefCtor }).NDEFReader
    const reader = new ctor()
    const controller = new AbortController()
    // 20s window to present a tag before giving up quietly.
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      await reader.write(url, { signal: controller.signal })
      return 'written'
    } finally {
      clearTimeout(timer)
    }
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string }
    if (e?.name === 'AbortError') return 'cancelled'
    return e?.message ?? 'NFC write failed'
  }
}
