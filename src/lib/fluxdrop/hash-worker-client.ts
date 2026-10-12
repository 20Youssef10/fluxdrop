'use client'

/**
 * Worker-based hashing client.
 * Provides off-main-thread SHA-256 hashing using hash-wasm in a Web Worker.
 * Falls back to the main-thread implementation if workers are unavailable.
 */

import { hashFile as hashFileMainThread, verifyChecksum as verifyMainThread } from './checksum'

let worker: Worker | null = null
let workerReady = false
let nextId = 0
const pendingPromises = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()

function getWorker(): Worker | null {
  if (typeof window === 'undefined') return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('../workers/hash-worker.ts', import.meta.url))
    worker.onmessage = (e: MessageEvent) => {
      const { type, id } = e.data
      if (type === 'ready') {
        workerReady = true
        return
      }
      const pending = pendingPromises.get(id)
      if (!pending) return
      pendingPromises.delete(id)
      if (type === 'result') pending.resolve(e.data.hash)
      else if (type === 'verified') pending.resolve(e.data.ok)
      else if (type === 'error') pending.reject(new Error(e.data.message))
    }
    worker.onerror = (e) => {
      console.warn('[FluxDrop] Hash worker error:', e.message)
      // Reject all pending promises.
      for (const [, p] of pendingPromises) p.reject(new Error('Worker error'))
      pendingPromises.clear()
      worker = null
      workerReady = false
    }
    worker.postMessage({ type: 'init' })
    return worker
  } catch (err) {
    console.warn('[FluxDrop] Could not create hash worker, using main thread:', err)
    return null
  }
}

export interface HashProgress {
  bytesProcessed: number
  totalBytes: number
}

/**
 * Hash a file using a Web Worker (off-main-thread).
 * Falls back to main-thread hashing if workers are unavailable.
 * Uses hash-wasm for incremental SHA-256 that matches `sha256sum`.
 */
export async function hashFileWorker(
  file: File,
  onProgress?: (progress: HashProgress) => void
): Promise<string> {
  const w = getWorker()
  if (!w || !workerReady) {
    // Worker not ready yet — wait briefly, then fall back.
    if (w) {
      await new Promise((r) => setTimeout(r, 500))
      if (!workerReady) return hashFileMainThread(file)
    } else {
      return hashFileMainThread(file)
    }
  }

  const id = `hash-${nextId++}`
  return new Promise<string>((resolve, reject) => {
    // Set up progress handler.
    const originalOnMessage = w!.onmessage
    w!.onmessage = (e: MessageEvent) => {
      const { type, id: msgId } = e.data
      if (msgId === id && type === 'progress' && onProgress) {
        onProgress({ bytesProcessed: e.data.bytesProcessed, totalBytes: e.data.totalBytes })
        return
      }
      if (msgId === id && type === 'result') {
        w!.onmessage = originalOnMessage
        resolve(e.data.hash)
        return
      }
      if (msgId === id && type === 'error') {
        w!.onmessage = originalOnMessage
        reject(new Error(e.data.message))
        return
      }
      // Pass through other messages (like 'ready').
      if (originalOnMessage) originalOnMessage.call(w, e)
    }
    w!.postMessage({ type: 'hash', data: { file, id } })
  })
}

/**
 * Verify a blob's checksum using a Web Worker.
 * Falls back to main-thread if workers are unavailable.
 */
export async function verifyChecksumWorker(blob: Blob, expected: string): Promise<boolean> {
  const w = getWorker()
  if (!w || !workerReady) {
    return verifyMainThread(blob, expected)
  }

  const id = `verify-${nextId++}`
  return new Promise<boolean>((resolve, reject) => {
    const originalOnMessage = w!.onmessage
    w!.onmessage = (e: MessageEvent) => {
      const { type, id: msgId } = e.data
      if (msgId === id && type === 'verified') {
        w!.onmessage = originalOnMessage
        resolve(e.data.ok)
        return
      }
      if (msgId === id && type === 'error') {
        w!.onmessage = originalOnMessage
        reject(new Error(e.data.message))
        return
      }
      if (originalOnMessage) originalOnMessage.call(w, e)
    }
    w!.postMessage({ type: 'verify', data: { blob, expected, id } })
  })
}

/** Clean up the worker (call on unmount). */
export function destroyHashWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
    workerReady = false
  }
}
