'use client'

/**
 * Worker-based hashing client.
 * Provides off-main-thread SHA-256 hashing using hash-wasm in a Web Worker.
 * Falls back to the main-thread implementation if workers are unavailable.
 *
 * Uses an inline worker (Blob URL) to avoid Turbopack/webpack worker
 * loader issues. The worker code is a string that imports hash-wasm
 * via importScripts.
 */

import { hashFile as hashFileMainThread, verifyChecksum as verifyMainThread } from './checksum'

let worker: Worker | null = null
let workerReady = false
let nextId = 0
const pendingPromises = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
const progressCallbacks = new Map<string, (progress: { bytesProcessed: number; totalBytes: number }) => void>()

// Inline worker code — avoids bundler worker-loader issues.
// The worker uses importScripts to load hash-wasm from the CDN.
// This is a common pattern for workers in Next.js/Turbopack.
const WORKER_CODE = `
let hasher = null;

async function ensureHasher() {
  if (!hasher) {
    // Dynamic import hash-wasm (works in worker context)
    const { createSHA256 } = await import('https://esm.sh/hash-wasm@4.12.0');
    hasher = await createSHA256();
  }
  return hasher;
}

self.onmessage = async (e) => {
  const { type, data } = e.data;

  if (type === 'init') {
    await ensureHasher();
    self.postMessage({ type: 'ready' });
    return;
  }

  if (type === 'hash') {
    const { file, id } = data;
    const readSize = 4 * 1024 * 1024;
    const total = file.size;
    let offset = 0;
    let chunkNum = 0;

    try {
      const h = await ensureHasher();
      h.init();

      while (offset < total) {
        const end = Math.min(offset + readSize, total);
        const slice = file.slice(offset, end);
        const buf = await slice.arrayBuffer();
        h.update(new Uint8Array(buf));
        offset = end;
        chunkNum++;

        if (chunkNum % 4 === 0) {
          self.postMessage({
            type: 'progress',
            id,
            bytesProcessed: offset,
            totalBytes: total,
          });
        }
        if (chunkNum % 16 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      const hash = h.digest('hex');
      self.postMessage({ type: 'result', id, hash });
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err.message || 'Unknown error' });
    }
    return;
  }

  if (type === 'verify') {
    const { blob, expected, id } = data;
    const readSize = 4 * 1024 * 1024;
    const total = blob.size;
    let offset = 0;

    try {
      const h = await ensureHasher();
      h.init();

      while (offset < total) {
        const end = Math.min(offset + readSize, total);
        const slice = blob.slice(offset, end);
        const buf = await slice.arrayBuffer();
        h.update(new Uint8Array(buf));
        offset = end;
      }
      const hash = h.digest('hex');
      const ok = hash.toLowerCase() === expected.toLowerCase();
      self.postMessage({ type: 'verified', id, ok, hash });
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err.message || 'Unknown error' });
    }
    return;
  }
};
`

function getWorker(): Worker | null {
  if (typeof window === 'undefined') return null
  if (worker) return worker
  try {
    // Create worker from a Blob URL (avoids bundler worker-loader issues).
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    worker = new Worker(url)
    // Revoke after creation (worker keeps its own reference).
    setTimeout(() => URL.revokeObjectURL(url), 1000)

    worker.onmessage = (e: MessageEvent) => {
      const { type, id } = e.data
      if (type === 'ready') {
        workerReady = true
        return
      }
      if (type === 'progress' && id && progressCallbacks.has(id)) {
        progressCallbacks.get(id)!(e.data)
        return
      }
      const pending = pendingPromises.get(id)
      if (!pending) return
      pendingPromises.delete(id)
      progressCallbacks.delete(id)
      if (type === 'result') pending.resolve(e.data.hash)
      else if (type === 'verified') pending.resolve(e.data.ok)
      else if (type === 'error') pending.reject(new Error(e.data.message))
    }
    worker.onerror = (e) => {
      console.warn('[FluxDrop] Hash worker error:', e.message)
      for (const [, p] of pendingPromises) p.reject(new Error('Worker error'))
      pendingPromises.clear()
      progressCallbacks.clear()
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
  if (!w) {
    return hashFileMainThread(file)
  }

  // Wait for worker to be ready (max 3 seconds).
  if (!workerReady) {
    for (let i = 0; i < 30 && !workerReady; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!workerReady) return hashFileMainThread(file)
  }

  const id = `hash-${nextId++}`
  if (onProgress) progressCallbacks.set(id, onProgress)

  return new Promise<string>((resolve, reject) => {
    pendingPromises.set(id, { resolve, reject })
    w.postMessage({ type: 'hash', data: { file, id } })
  })
}

/**
 * Verify a blob's checksum using a Web Worker.
 * Falls back to main-thread if workers are unavailable.
 */
export async function verifyChecksumWorker(blob: Blob, expected: string): Promise<boolean> {
  const w = getWorker()
  if (!w) {
    return verifyMainThread(blob, expected)
  }

  if (!workerReady) {
    for (let i = 0; i < 30 && !workerReady; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!workerReady) return verifyMainThread(blob, expected)
  }

  const id = `verify-${nextId++}`
  return new Promise<boolean>((resolve, reject) => {
    pendingPromises.set(id, { resolve, reject })
    w.postMessage({ type: 'verify', data: { blob, expected, id } })
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
