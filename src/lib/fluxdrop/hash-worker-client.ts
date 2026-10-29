'use client'

/**
 * Worker-pool hashing client (v5-a4).
 * Provides off-main-thread SHA-256 hashing using hash-wasm in a POOL of Web
 * Workers (sized from hardwareConcurrency, clamped to [1, 6]) so multi-file
 * sends hash several files in parallel instead of one at a time. Each worker
 * uses double-buffered reads: while the hasher digests the current 4 MiB
 * slice, the NEXT slice's arrayBuffer() is already in flight, overlapping
 * I/O and crypto. Digests stay byte-identical SHA-256 (matches sha256sum).
 *
 * Falls back to the main-thread implementation (checksum.ts) when workers
 * are unavailable (SSR, tests, non-browser runtimes) or if the pool fails.
 *
 * Uses inline workers (Blob URL) to avoid Turbopack/webpack worker-loader
 * issues — preserved exactly from the single-worker era. The worker code is
 * a string that imports hash-wasm via a dynamic import inside the worker.
 */

import { hashFile as hashFileMainThread, verifyChecksum as verifyMainThread } from './checksum'

/** Progress payload forwarded from a worker while a file is hashing. */
export interface HashProgress {
  bytesProcessed: number
  totalBytes: number
}

// v5-a4: ── Inline worker code (Blob URL) ────────────────────────────────
// Kept as a template string on purpose (dodges bundler worker-loader
// issues). The worker dynamically imports hash-wasm INSIDE the worker
// context. v5-a4 adds double-buffered reads to both the 'hash' and 'verify'
// loops: the next 4 MiB slice's arrayBuffer() is issued BEFORE the current
// slice is fed to the hasher, so file I/O and SHA-256 crypto overlap
// instead of serializing. Progress cadence is unchanged (every 4th chunk).
const WORKER_CODE = `
let hasher = null;

async function ensureHasher() {
  if (!hasher) {
    // Dynamic import hash-wasm (works in worker context)
    const { createSHA256 } = await import('hash-wasm');
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

      // v5-a4: double-buffered reads — issue the NEXT slice's arrayBuffer()
      // before feeding the CURRENT slice to the hasher, so I/O and crypto
      // overlap instead of serializing.
      let pendingRead = total > 0 ? file.slice(0, Math.min(readSize, total)).arrayBuffer() : null;
      while (offset < total) {
        const end = Math.min(offset + readSize, total);
        const buf = await pendingRead;
        pendingRead = end < total
          ? file.slice(end, Math.min(end + readSize, total)).arrayBuffer()
          : null;
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

      // v5-a4: double-buffered reads (same I/O/crypto overlap as 'hash').
      let pendingRead = total > 0 ? blob.slice(0, Math.min(readSize, total)).arrayBuffer() : null;
      while (offset < total) {
        const end = Math.min(offset + readSize, total);
        const buf = await pendingRead;
        pendingRead = end < total
          ? blob.slice(end, Math.min(end + readSize, total)).arrayBuffer()
          : null;
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

// v5-a4: ── Pool state ────────────────────────────────────────────────────

/** A single hash job destined for one pool worker. */
interface HashJob {
  id: string
  kind: 'hash'
  file: File
  onProgress?: (progress: HashProgress) => void
  /** Fired when the job is actually picked up (worker assigned or main-thread start). */
  onStart?: () => void
  resolve: (digest: string) => void
  reject: (err: Error) => void
}

/** A single verify job destined for one pool worker. */
interface VerifyJob {
  id: string
  kind: 'verify'
  blob: Blob
  expected: string
  resolve: (ok: boolean) => void
  reject: (err: Error) => void
}

type PoolJob = HashJob | VerifyJob

/** One worker in the pool plus its scheduling state. */
interface PoolSlot {
  worker: Worker
  ready: boolean
  dead: boolean
  busyId: string | null
}

/** Messages the worker posts back to the pool client. */
interface WorkerOutMessage {
  type: 'ready' | 'progress' | 'result' | 'verified' | 'error'
  id?: string
  bytesProcessed?: number
  totalBytes?: number
  hash?: string
  ok?: boolean
  message?: string
}

let slots: PoolSlot[] | null = null
let poolFailed = false
let nextId = 0
let rrCursor = 0
const queue: PoolJob[] = []
const pending = new Map<string, PoolJob>()

/**
 * v5-a4: worker-pool sizing — `Math.max(1, Math.min(6, hc || 2))`.
 * Kept pure (only reads `navigator` when no explicit value is given) so it
 * can be unit-tested outside a browser; the non-browser guard lives in pool
 * creation instead (no `window`/`Worker` → no pool → main-thread fallback,
 * i.e. effectively "1" = the main thread itself).
 */
export function computePoolSize(hardwareConcurrency?: number): number {
  const hc =
    hardwareConcurrency ??
    (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined)
  return Math.max(1, Math.min(6, hc || 2))
}

/** Lazily create the worker pool (all workers share one Blob URL). */
function getPool(): PoolSlot[] | null {
  // v5-a4: non-browser guard (SSR, tests, bun) or no Worker support →
  // fall back to the main-thread hashing path.
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null
  if (poolFailed) return null
  if (slots) return slots
  try {
    const size = computePoolSize()
    // Create workers from a Blob URL (avoids bundler worker-loader issues).
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    const created: PoolSlot[] = []
    for (let i = 0; i < size; i++) {
      const worker = new Worker(url)
      const slot: PoolSlot = { worker, ready: false, dead: false, busyId: null }
      attachHandlers(slot)
      worker.postMessage({ type: 'init' })
      created.push(slot)
    }
    slots = created
    // All workers were spawned synchronously from this URL; revoke lazily
    // (workers keep their own reference once constructed).
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    // v5-a4: watchdog — if no worker ever reports ready within 3s (mirrors
    // the old per-call ready timeout), fail the whole pool over to the main
    // thread so callers never hang.
    setTimeout(() => {
      if (slots !== created) return // pool was destroyed/replaced meanwhile
      if (!created.some((s) => !s.dead && s.ready)) failPool('hash workers did not initialize')
    }, 3000)
    return created
  } catch (err) {
    console.warn('[FluxDrop] Could not create hash worker pool, using main thread:', err)
    poolFailed = true
    return null
  }
}

/** Wire up the per-worker message/error handlers for one pool slot. */
function attachHandlers(slot: PoolSlot): void {
  slot.worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorkerOutMessage
    if (msg.type === 'ready') {
      slot.ready = true
      pump() // queued jobs can now be assigned to this worker
      return
    }
    const id = msg.id
    if (!id) return

    if (msg.type === 'progress') {
      const job = pending.get(id)
      if (job && job.kind === 'hash') {
        job.onProgress?.({
          bytesProcessed: msg.bytesProcessed ?? 0,
          totalBytes: msg.totalBytes ?? 0,
        })
      }
      return
    }

    // Terminal messages: result / verified / error.
    const job = pending.get(id)
    if (!job) return
    pending.delete(id)
    slot.busyId = null
    if (msg.type === 'result' && job.kind === 'hash') {
      job.resolve(String(msg.hash))
    } else if (msg.type === 'verified' && job.kind === 'verify') {
      job.resolve(msg.ok === true)
    } else if (msg.type === 'error') {
      job.reject(new Error(msg.message || 'Unknown hashing error'))
    } else {
      job.reject(new Error(`Unexpected hash-worker message: ${msg.type}`))
    }
    pump() // this worker is free again
  }

  slot.worker.onerror = (e: ErrorEvent) => {
    console.warn('[FluxDrop] Hash worker error:', e.message)
    slot.dead = true
    try {
      slot.worker.terminate()
    } catch {
      /* already gone */
    }
    if (slot.busyId) {
      const job = pending.get(slot.busyId)
      pending.delete(slot.busyId)
      slot.busyId = null
      // Reject only THIS slot's in-flight job — callers fall back
      // (hashFilesPool retries the file on the main thread).
      job?.reject(new Error('Worker error'))
    }
    if (!slots || slots.every((s) => s.dead)) {
      failPool('all hash workers failed')
    } else {
      pump()
    }
  }
}

/**
 * v5-a4: pool-level failure — terminate everything and finish all pending
 * and queued work on the main thread so hashing never breaks a send.
 */
function failPool(reason: string): void {
  if (slots) {
    console.warn('[FluxDrop] Hash worker pool failed, falling back to main thread:', reason)
    for (const s of slots) {
      s.dead = true
      try {
        s.worker.terminate()
      } catch {
        /* already gone */
      }
    }
  }
  slots = null
  poolFailed = true
  // Re-run in-flight jobs (their worker is gone) plus everything queued.
  const orphans = [...pending.values()]
  pending.clear()
  for (const job of orphans) void runOnMainThread(job)
  while (queue.length > 0) {
    const job = queue.shift()
    if (job) void runOnMainThread(job)
  }
}

/** Execute one job on the main thread (pool unavailable / failed). */
async function runOnMainThread(job: PoolJob): Promise<void> {
  try {
    if (job.kind === 'hash') {
      job.onStart?.()
      job.resolve(await hashFileMainThread(job.file))
    } else {
      job.resolve(await verifyMainThread(job.blob, job.expected))
    }
  } catch (err) {
    job.reject(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * v5-a4: round-robin scheduler — hand one queued job to each free, ready
 * worker; when every worker is busy the remaining jobs stay queued (and get
 * pumped as workers report results).
 */
function pump(): void {
  if (!slots || queue.length === 0) return
  const n = slots.length
  for (let scanned = 0; scanned < n && queue.length > 0; scanned++) {
    const slot = slots[rrCursor]
    rrCursor = (rrCursor + 1) % n
    if (slot.dead || !slot.ready || slot.busyId !== null) continue
    const job = queue.shift()
    if (!job) break
    pending.set(job.id, job)
    slot.busyId = job.id
    if (job.kind === 'hash') {
      job.onStart?.()
      slot.worker.postMessage({ type: 'hash', data: { file: job.file, id: job.id } })
    } else {
      slot.worker.postMessage({ type: 'verify', data: { blob: job.blob, expected: job.expected, id: job.id } })
    }
  }
}

/** Route one job into the pool (or straight to the main thread if pool-less). */
function enqueue(job: PoolJob): void {
  const pool = getPool()
  if (!pool) {
    // v5-a4: non-browser / workers unavailable / pool failed → main thread.
    void runOnMainThread(job)
    return
  }
  queue.push(job)
  pump()
}

/** Internal options for a hash job routed through the pool. */
interface HashJobOptions {
  onProgress?: (progress: HashProgress) => void
  onStart?: () => void
}

function runHashJob(file: File, opts?: HashJobOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    enqueue({
      id: `hash-${nextId++}`,
      kind: 'hash',
      file,
      onProgress: opts?.onProgress,
      onStart: opts?.onStart,
      resolve,
      reject,
    })
  })
}

/**
 * Hash a file using the worker pool (off-main-thread, double-buffered reads
 * inside the worker). Falls back to main-thread hashing if workers are
 * unavailable. Uses hash-wasm for incremental SHA-256 that matches
 * `sha256sum`. Signature unchanged from the single-worker era (v5-a4).
 */
export async function hashFileWorker(
  file: File,
  onProgress?: (progress: HashProgress) => void
): Promise<string> {
  return runHashJob(file, { onProgress })
}

/**
 * Verify a blob's checksum using the worker pool (double-buffered reads).
 * Falls back to the main thread if workers are unavailable.
 * Signature unchanged from the single-worker era (v5-a4).
 */
export async function verifyChecksumWorker(blob: Blob, expected: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    enqueue({
      id: `verify-${nextId++}`,
      kind: 'verify',
      blob,
      expected,
      resolve,
      reject,
    })
  })
}

/** Options for {@link hashFilesPool}. */
export interface HashFilesPoolOptions {
  /** Fired when file `i` is picked up by a pool worker (or the main-thread fallback starts it). */
  onFileStart?: (i: number, f: File) => void
  /** Per-file hashing progress: bytes hashed so far within file `i` vs its size. */
  onFileProgress?: (i: number, bytes: number, total: number) => void
  /** Fired when file `i` finishes (completion order, not input order). */
  onFileDone?: (i: number, digest: string) => void
  /** Aggregate progress across all files (monotonic bytes vs the grand total). */
  onOverallProgress?: (bytes: number, total: number) => void
}

/**
 * v5-a4: hash many files through the worker pool.
 * Schedules one file per free worker (round-robin over the pool); when all
 * workers are busy, files wait in the queue. A worker-side failure for one
 * file retries that file on the main thread — a bad job never sinks the
 * batch. Resolves with digests in INPUT order.
 */
export async function hashFilesPool(files: File[], opts?: HashFilesPoolOptions): Promise<string[]> {
  if (files.length === 0) return []
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  let settledBytes = 0 // bytes of fully-hashed files
  let runningBytes = 0 // Σ latest progress of still-in-flight files
  const inFlight: number[] = new Array(files.length).fill(0)

  const digests = await Promise.all(
    files.map(
      async (file, i): Promise<string> => {
        let digest: string
        try {
          digest = await runHashJob(file, {
            onStart: () => opts?.onFileStart?.(i, file),
            onProgress: (p) => {
              // v5-a4: aggregate = settled + latest in-flight progress per
              // file (monotonic even with several workers interleaving).
              runningBytes += p.bytesProcessed - inFlight[i]
              inFlight[i] = p.bytesProcessed
              opts?.onFileProgress?.(i, p.bytesProcessed, p.totalBytes)
              opts?.onOverallProgress?.(settledBytes + runningBytes, totalBytes)
            },
          })
        } catch {
          // v5-a4: hashing must never break a send — retry this ONE file on
          // the main thread instead of rejecting the whole batch.
          digest = await hashFileMainThread(file)
        }
        settledBytes += file.size
        runningBytes -= inFlight[i]
        inFlight[i] = 0
        opts?.onFileDone?.(i, digest)
        opts?.onOverallProgress?.(settledBytes, totalBytes)
        return digest
      },
    ),
  )
  return digests
}

/**
 * v5-a4: drain and close the whole worker pool (call on unmount).
 * Queued and in-flight jobs are rejected with a typed error — the API is
 * synchronous (kept from the single-worker era), so work cannot be awaited.
 * The pool is re-created on demand by the next hashing call.
 */
export function destroyHashPool(): void {
  for (const slot of slots ?? []) {
    try {
      slot.worker.terminate()
    } catch {
      /* already gone */
    }
  }
  slots = null
  poolFailed = false // allow on-demand re-creation after teardown
  rrCursor = 0
  const err = new Error('Hash pool destroyed')
  for (const job of queue) job.reject(err)
  queue.length = 0
  for (const job of pending.values()) job.reject(err)
  pending.clear()
}

/** Back-compat alias for {@link destroyHashPool} (v5-a4). */
export function destroyHashWorker(): void {
  destroyHashPool()
}
