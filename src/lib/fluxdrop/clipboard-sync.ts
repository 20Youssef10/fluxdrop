// v4 (4.6a): opt-in clipboard sync over the DataChannel (opcode CLIPBOARD).
// Sending side: captures what the user copied (document 'copy' event — no
// permission needed, gesture-free) and forwards ≤4 KB text to paired peers.
// Receiving side: browsers require a user gesture for direct clipboard
// writes, so incoming text lands in a "pending sync" the UI surfaces with a
// one-tap Copy button (toast) instead of fighting the permission model.

'use client'

export const CLIPBOARD_MAX_LEN = 4000

export interface ClipboardSyncFrame {
  text: string
  at: number
}

type Listener = (frame: ClipboardSyncFrame) => void

const listeners = new Set<Listener>()

export function onClipboardSync(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Called by the wire handler when a CLIPBOARD frame arrives (decoded). */
export function deliverClipboardSync(frame: ClipboardSyncFrame): void {
  for (const l of listeners) {
    try {
      l(frame)
    } catch { /* listener errors must not break the wire */ }
  }
}

export function isValidClipboardFrame(body: unknown): body is ClipboardSyncFrame {
  if (!body || typeof body !== 'object') return false
  const b = body as { text?: unknown; at?: unknown }
  return typeof b.text === 'string' && b.text.length > 0 && b.text.length <= CLIPBOARD_MAX_LEN
}

/**
 * Wire up the SENDING side (document 'copy' capture). Returns a cleanup fn.
 * The hook is idempotent per mount; callers gate it on the sync pref.
 */
export function attachClipboardSender(send: (text: string) => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const onCopy = (e: ClipboardEvent) => {
    try {
      const sel = document.getSelection()?.toString() ?? ''
      const text = e.clipboardData?.getData('text/plain') || sel
      const trimmed = text.trim()
      if (!trimmed || trimmed.length > CLIPBOARD_MAX_LEN) return
      send(trimmed)
    } catch { /* never break a native copy */ }
  }
  document.addEventListener('copy', onCopy, true)
  return () => document.removeEventListener('copy', onCopy, true)
}
