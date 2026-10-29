// FluxDrop CLI — transport-agnostic protocol cores.
//
// SenderSession and ReceiverSession implement the FluxDrop v1 wire protocol
// (docs/protocol-spec.md) using the REAL encoders from the app tree
// (proto.ts re-exports src/lib/fluxdrop/encoding.ts). They speak through the
// minimal `Wire` interface so they run unchanged over:
//   - a node-datachannel DataChannel (real WebRTC — send/receive commands)
//   - an in-memory pipe (loopback demo — framing + hashing only)
//
// Semantics implemented: manifest-first, 64 KiB chunks of the concatenated
// transfer stream, per-chunk CHUNK_ACK pacing with an in-flight window,
// PAUSE/RESUME_STREAM flow control, TRANSFER_COMPLETE/ACK with SHA-256
// verification, TRANSFER_CANCEL, RESUME_QUERY bitmap answers, and
// CHUNK_DATA_GZ receive-side decompression.

import { open, mkdir, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  MessageType,
  CONSTANTS,
  encodeChunkData,
  encodeChunkAck,
  encodeControlMessage,
  type DecodedMessage,
  type TransferManifest,
  type FileManifestEntry,
} from './proto'
import { sha256Range, safeRelativePath } from './util'

export interface Wire {
  send(bytes: Uint8Array | ArrayBuffer): void
  bufferedAmount(): number
  maxMessageSize(): number
}

// Pacing constants (protocol.ts tunables, expressed for a 64 KiB chunk):
// in-flight cap mirrors FLOW_WINDOW_DEFAULT (8 MiB / 64 KiB = 128 chunks);
// buffer caps mirror MAX_BUFFERED/TARGET with headroom for the ACK latency.
const MAX_INFLIGHT_CHUNKS = 128
const BUFFERED_SOFT_CAP = 16 * 1024 * 1024
const RESWEEP_INTERVAL_MS = 1_500
const MAX_RESWEEPS = 6

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function bodyOf(msg: DecodedMessage): Record<string, unknown> {
  return (msg.body ?? {}) as Record<string, unknown>
}

// ============================================================================
// Sender
// ============================================================================

export interface SenderProgress {
  ackedChunks: number
  totalChunks: number
  ackedBytes: number
  totalBytes: number
  elapsedMs: number
  rateMbps: number
}

export interface SenderEvents {
  log?: (msg: string) => void
  progress?: (p: SenderProgress) => void
}

export class SenderSession {
  private readonly tid: string
  private readonly tidWire: string // decoded 8-hex-char wire id echoed by receiver frames
  private acked = new Set<number>()
  private sent = new Set<number>()
  private paused = false
  private manifestAcked = false
  private done: { verified: boolean } | null = null
  private failure: string | null = null
  private handles: import('node:fs/promises').FileHandle[] = []
  private fileStarts: number[] = []
  private startedAt = 0
  private nextProgressAt = 0
  private readonly opts: {
    wire: Wire
    manifest: TransferManifest
    entries: FileManifestEntry[]
    sources: { path: string; size: number }[]
    events?: SenderEvents
  }
  private doneWaiters: Array<(v: { verified: boolean }) => void> = []
  private pumpPromise: Promise<void> | null = null

  constructor(
    wire: Wire,
    manifest: TransferManifest,
    sources: { path: string; size: number }[],
    events?: SenderEvents
  ) {
    this.opts = { wire, manifest, entries: manifest.files, sources, events }
    this.tid = manifest.transferId
    this.tidWire = '' // resolved from the first decoded receiver frame
    let acc = 0
    for (const f of manifest.files) {
      this.fileStarts.push(acc)
      acc += f.size
    }
  }

  /** Kick off the transfer: sends MANIFEST, then chunks, then completion. */
  start(): void {
    if (this.pumpPromise) return
    this.startedAt = Date.now()
    this.pumpPromise = this.run().catch((err) => this.fail(String(err)))
  }

  private wire(): Wire {
    return this.opts.wire
  }

  private fail(reason: string): void {
    if (this.done || this.failure) return
    this.failure = reason
    this.opts.events?.log?.(`transfer failed: ${reason}`)
    this.wakeWaiters({ verified: false })
  }

  private wakeWaiters(v: { verified: boolean }): void {
    this.done = v
    for (const w of this.doneWaiters) w(v)
    this.doneWaiters = []
  }

  /** Resolve when the receiver has confirmed verification (or failed). */
  waitDone(): Promise<{ verified: boolean }> {
    if (this.done) return Promise.resolve(this.done)
    if (this.failure) return Promise.resolve({ verified: false })
    return new Promise((resolve) => this.doneWaiters.push(resolve))
  }

  /** Feed a decoded DataChannel frame (from the receiver). */
  handleMessage(msg: DecodedMessage): void {
    // Receiver control frames echo the truncated wire id; learn it once.
    if (!this.tidWire && msg.transferId) this.tidWire = msg.transferId
    switch (msg.type) {
      case MessageType.MANIFEST_ACK: {
        const body = bodyOf(msg)
        if (body.accepted === true) {
          this.manifestAcked = true
          this.opts.events?.log?.('receiver accepted the manifest')
        } else {
          this.fail(`receiver declined: ${String(body.reason ?? 'declined')}`)
        }
        return
      }
      case MessageType.CHUNK_ACK: {
        const ok = msg.payloadView.length > 0 && msg.payloadView[0] === 0x01
        if (!ok) {
          this.fail(`receiver rejected chunk ${msg.chunkIndex}`)
          return
        }
        const idx = msg.chunkIndex
        if (!this.acked.has(idx)) {
          this.acked.add(idx)
          this.emitProgress()
        }
        return
      }
      case MessageType.PAUSE: {
        this.paused = true
        this.opts.events?.log?.('receiver requested PAUSE')
        return
      }
      case MessageType.RESUME_STREAM: {
        this.paused = false
        this.opts.events?.log?.('receiver resumed the stream')
        return
      }
      case MessageType.TRANSFER_COMPLETE_ACK: {
        const verified = bodyOf(msg).verified === true
        if (verified) {
          this.emitProgress(true)
          this.opts.events?.log?.('receiver verified all SHA-256 checksums')
        } else {
          this.opts.events?.log?.('receiver reported verification FAILURE')
        }
        this.wakeWaiters({ verified })
        return
      }
      case MessageType.TRANSFER_CANCEL: {
        this.fail(`receiver cancelled: ${String(bodyOf(msg).reason ?? 'cancelled')}`)
        return
      }
      case MessageType.RESUME_RESPONSE: {
        // Only meaningful for resume flows; log the bitmap for observability.
        const body = bodyOf(msg)
        const acked = Array.isArray(body.ackedIndices) ? (body.ackedIndices as number[]).length : 0
        this.opts.events?.log?.(`resume response: from ${String(body.fromChunkIndex)}, ${acked} stored chunks`)
        return
      }
      default:
        return // unknown/uninteresting for the sender core
    }
  }

  private emitProgress(force = false): void {
    const now = Date.now()
    if (!force && now < this.nextProgressAt) return
    this.nextProgressAt = now + 100
    const m = this.opts.manifest
    const ackedBytes = this.acked.size * m.chunkSize
    const elapsed = Math.max(1, now - this.startedAt)
    this.opts.events?.progress?.({
      ackedChunks: this.acked.size,
      totalChunks: m.totalChunks,
      ackedBytes: Math.min(ackedBytes, m.totalSize),
      totalBytes: m.totalSize,
      elapsedMs: elapsed,
      rateMbps: (Math.min(ackedBytes, m.totalSize) * 8) / (elapsed / 1000) / 1e6,
    })
  }

  /** Chunk pump: open sources, send MANIFEST, stream with windowing, complete. */
  private async run(): Promise<void> {
    const m = this.opts.manifest
    const total = m.totalChunks

    // 0. open source files + send the manifest (first frame of the transfer).
    for (const s of this.opts.sources) {
      this.handles.push(await open(s.path, 'r'))
    }
    this.opts.events?.log?.(
      `manifest: ${this.opts.entries.length} file(s), ${total} chunks of ${m.chunkSize} B`
    )
    this.wire().send(encodeControlMessage(MessageType.MANIFEST, this.tid, 0, m))

    // 1. wait for MANIFEST_ACK (receiver consent).
    const giveUpAt = Date.now() + 60_000
    while (!this.manifestAcked) {
      if (this.failure || this.done) return
      if (Date.now() > giveUpAt) throw new Error('timed out waiting for MANIFEST_ACK')
      await sleep(20)
    }

    // 2. stream chunks (contiguous transfer stream — spec §8.3).
    for (let i = 0; i < total; i++) {
      if (this.failure || this.done) return
      await this.windowSlot()
      const bytes = await this.readChunk(i)
      if (this.failure || this.done) return
      this.wire().send(encodeChunkData(this.tid, i, bytes))
      this.sent.add(i)
    }

    // 3. lost-ACK recovery: re-send un-ACKed chunks in bounded sweeps.
    for (let sweep = 0; sweep < MAX_RESWEEPS; sweep++) {
      if (this.acked.size >= total) break
      const missing: number[] = []
      for (let i = 0; i < total; i++) if (!this.acked.has(i)) missing.push(i)
      this.opts.events?.log?.(`resweep ${sweep + 1}: re-sending ${missing.length} un-ACKed chunk(s)`)
      for (const i of missing) {
        if (this.failure || this.done) return
        await this.windowSlot()
        const bytes = await this.readChunk(i)
        this.wire().send(encodeChunkData(this.tid, i, bytes))
      }
      await sleep(RESWEEP_INTERVAL_MS)
    }

    // 4. completion handshake.
    if (this.acked.size < total) {
      throw new Error(`receiver never ACKed ${total - this.acked.size} chunk(s)`)
    }
    const finalChecksum = this.opts.entries.map((f) => f.checksum).join('')
    this.opts.events?.log?.('all chunks ACKed — sending TRANSFER_COMPLETE')
    this.wire().send(encodeControlMessage(MessageType.TRANSFER_COMPLETE, this.tid, 0, { finalChecksum }))

    // 5. TRANSFER_COMPLETE_ACK resolves waitDone() via handleMessage.
    const deadline = Date.now() + 60_000
    while (!this.done && !this.failure && Date.now() < deadline) await sleep(50)
  }

  /** Block while paused, over the in-flight cap, or over the buffer cap. */
  private async windowSlot(): Promise<void> {
    for (;;) {
      if (this.failure || this.done) throw new Error('transfer aborted')
      const inFlight = this.sent.size - this.acked.size
      if (!this.paused && inFlight < MAX_INFLIGHT_CHUNKS && this.wire().bufferedAmount() < BUFFERED_SOFT_CAP) {
        return
      }
      await sleep(5)
    }
  }

  /** Read chunk `i` of the concatenated transfer stream from the sources. */
  private async readChunk(i: number): Promise<Uint8Array> {
    const m = this.opts.manifest
    const start = i * m.chunkSize
    const end = Math.min(start + m.chunkSize, m.totalSize)
    const buf = new Uint8Array(end - start)
    let w = 0
    for (let f = 0; f < this.opts.entries.length; f++) {
      const fStart = this.fileStarts[f]
      const fEnd = fStart + this.opts.entries[f].size
      if (fEnd <= start) continue
      if (fStart >= end) break
      const from = Math.max(fStart, start) - fStart
      const to = Math.min(fEnd, end) - fStart
      const n = to - from
      const { bytesRead } = await this.handles[f].read(buf, w, n, from)
      if (bytesRead !== n) throw new Error(`short read from ${this.opts.sources[f].path}`)
      w += n
    }
    return buf
  }

  /** Close file handles (call after waitDone resolves or on abort). */
  async close(): Promise<void> {
    for (const h of this.handles) {
      try {
        await h.close()
      } catch {
        /* ignore */
      }
    }
    this.handles = []
  }

  /** Send TRANSFER_CANCEL and abort (best effort). */
  cancel(reason: string): void {
    if (this.done) return
    try {
      this.wire().send(encodeControlMessage(MessageType.TRANSFER_CANCEL, this.tid, 0, { reason }))
    } catch {
      /* channel may be gone */
    }
    this.fail(`cancelled: ${reason}`)
  }

  get finalChecksum(): string {
    return this.opts.entries.map((f) => f.checksum).join('')
  }
}

// ============================================================================
// Receiver
// ============================================================================

export interface ReceiverFileResult {
  name: string
  path: string
  checksum: string
  ok: boolean
}

export interface ReceiverProgress {
  storedChunks: number
  totalChunks: number
  storedBytes: number
  totalBytes: number
}

export interface ReceiverEvents {
  log?: (msg: string) => void
  progress?: (p: ReceiverProgress) => void
  onManifest?: (m: TransferManifest) => void
}

export class ReceiverSession {
  private manifest: TransferManifest | null = null
  private tempPath: string | null = null
  private tempHandle: import('node:fs/promises').FileHandle | null = null
  private stored = new Set<number>()
  private nextProgressAt = 0
  private result: { verified: boolean; files: ReceiverFileResult[] } | null = null
  private failure: string | null = null
  private doneWaiters: Array<(v: { verified: boolean; files: ReceiverFileResult[] }) => void> = []
  private finishPromise: Promise<void> | null = null

  constructor(
    private wire: Wire,
    private outDir: string,
    private events?: ReceiverEvents
  ) {}

  waitDone(): Promise<{ verified: boolean; files: ReceiverFileResult[] }> {
    if (this.result) return Promise.resolve(this.result)
    if (this.failure) return Promise.resolve({ verified: false, files: [] })
    return new Promise((resolve) => this.doneWaiters.push(resolve))
  }

  private wake(v: { verified: boolean; files: ReceiverFileResult[] }): void {
    this.result = v
    for (const w of this.doneWaiters) w(v)
    this.doneWaiters = []
  }

  private fail(reason: string): void {
    if (this.result || this.failure) return
    this.failure = reason
    this.events?.log?.(`receive failed: ${reason}`)
    for (const w of this.doneWaiters) w({ verified: false, files: [] })
    this.doneWaiters = []
  }

  handleMessage(msg: DecodedMessage): void {
    switch (msg.type) {
      case MessageType.MANIFEST:
      case MessageType.MANIFEST_ENC: {
        // CLI receiver is plaintext-only by design (spec §7.2 downgrade note);
        // a MANIFEST_ENC body cannot be decrypted here — decline cleanly.
        if (msg.type === MessageType.MANIFEST_ENC) {
          this.fail('sender used E2E encryption (MANIFEST_ENC); the CLI supports plaintext transfers only')
          this.wire.send(encodeControlMessage(MessageType.MANIFEST_ACK, msg.transferId, 0, {
            accepted: false,
            reason: 'cli receiver cannot decrypt MANIFEST_ENC',
          }))
          return
        }
        void this.handleManifest(msg)
        return
      }
      case MessageType.CHUNK_DATA:
      case MessageType.CHUNK_DATA_GZ: {
        void this.handleChunk(msg)
        return
      }
      case MessageType.CHUNK_ENC: {
        this.fail('sender used E2E encryption (CHUNK_ENC); the CLI supports plaintext transfers only')
        return
      }
      case MessageType.TRANSFER_COMPLETE: {
        void this.finish(String(bodyOf(msg).finalChecksum ?? ''))
        return
      }
      case MessageType.TRANSFER_CANCEL: {
        this.fail(`sender cancelled: ${String(bodyOf(msg).reason ?? 'cancelled')}`)
        void this.cleanupTemp()
        return
      }
      case MessageType.RESUME_QUERY: {
        void this.answerResumeQuery(msg)
        return
      }
      case MessageType.PAUSE:
      case MessageType.RESUME_STREAM: {
        return // sender-side flow control — nothing to do on the receiver
      }
      default:
        return
    }
  }

  /** Validate manifest invariants, accept, open the temp file. */
  private async handleManifest(msg: DecodedMessage): Promise<void> {
    try {
      const m = bodyOf(msg) as unknown as TransferManifest
      const problems = validateManifest(m)
      if (problems.length > 0) {
        this.fail(`invalid manifest: ${problems.join('; ')}`)
        this.wire.send(encodeControlMessage(MessageType.MANIFEST_ACK, msg.transferId, 0, {
          accepted: false,
          reason: problems[0],
        }))
        return
      }
      this.manifest = m
      this.events?.onManifest?.(m)
      await mkdir(this.outDir, { recursive: true })
      const safe = m.transferId.replace(/[^0-9a-zA-Z-]/g, '').slice(0, 12) || 'x'
      this.tempPath = join(this.outDir, `.fluxdrop-recv-${safe}.part`)
      this.tempHandle = await open(this.tempPath, 'w+')
      this.wire.send(encodeControlMessage(MessageType.MANIFEST_ACK, msg.transferId, 0, { accepted: true }))
      this.events?.log?.(
        `accepted ${m.files.length} file(s), ${m.totalChunks} chunks (${m.compression === 'gzip' ? 'gzip wire compression' : 'uncompressed'})`
      )
    } catch (err) {
      this.fail(`manifest handling error: ${String(err)}`)
    }
  }

  private async handleChunk(msg: DecodedMessage): Promise<void> {
    const m = this.manifest
    if (!m || !this.tempHandle) return
    const idx = msg.chunkIndex
    if (idx >= m.totalChunks) {
      this.wire.send(encodeChunkAck(msg.transferId, idx, false))
      return
    }
    try {
      let payload: Uint8Array = msg.payloadView
      if (msg.type === MessageType.CHUNK_DATA_GZ) {
        payload = new Uint8Array(gunzipSync(Buffer.from(payload)))
      }
      const position = idx * m.chunkSize
      const expectedLen = Math.min(m.chunkSize, m.totalSize - position)
      if (payload.byteLength !== expectedLen) {
        this.wire.send(encodeChunkAck(msg.transferId, idx, false))
        return
      }
      await this.tempHandle.write(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength), 0, payload.byteLength, position)
      this.stored.add(idx)
      this.wire.send(encodeChunkAck(msg.transferId, idx, true))
      this.emitProgress()
    } catch (err) {
      this.events?.log?.(`chunk ${idx} write error: ${String(err)}`)
      try {
        this.wire.send(encodeChunkAck(msg.transferId, idx, false))
      } catch {
        /* ignore */
      }
    }
  }

  private answerResumeQuery(msg: DecodedMessage): void {
    // Spec §5.12 — answer with our stored-chunk bitmap so a resuming sender
    // skips what we already hold (the temp file holds those bytes).
    const indices = [...this.stored].sort((a, b) => a - b)
    let firstMissing = 0
    while (this.stored.has(firstMissing)) firstMissing++
    this.wire.send(
      encodeControlMessage(MessageType.RESUME_RESPONSE, msg.transferId, firstMissing, {
        accepted: true,
        fromChunkIndex: firstMissing,
        ackedIndices: indices,
      })
    )
  }

  private emitProgress(): void {
    const now = Date.now()
    if (now < this.nextProgressAt || !this.manifest) return
    this.nextProgressAt = now + 100
    const m = this.manifest
    this.events?.progress?.({
      storedChunks: this.stored.size,
      totalChunks: m.totalChunks,
      storedBytes: Math.min(this.stored.size * m.chunkSize, m.totalSize),
      totalBytes: m.totalSize,
    })
  }

  /** Verify per-file SHA-256 from the temp stream, then write outputs. */
  private async finish(finalChecksum: string): Promise<void> {
    if (this.finishPromise) {
      await this.finishPromise
      return
    }
    this.finishPromise = (async () => {
      const m = this.manifest
      const th = this.tempHandle
      if (!m || !th) {
        this.fail('TRANSFER_COMPLETE without a manifest')
        return
      }
      try {
        // 0. completeness — every chunk stored?
        const giveUpAt = Date.now() + 30_000
        while (this.stored.size < m.totalChunks && Date.now() < giveUpAt) {
          await sleep(100)
        }
        if (this.stored.size < m.totalChunks) {
          this.fail(`missing ${m.totalChunks - this.stored.size} chunk(s) at completion`)
          this.wire.send(encodeControlMessage(MessageType.TRANSFER_COMPLETE_ACK, m.transferId, 0, { verified: false }))
          return
        }

        // 1. per-file verification against the temp stream.
        const files: ReceiverFileResult[] = []
        let allOk = true
        let cursor = 0
        for (const f of m.files) {
          const start = cursor
          const end = cursor + f.size
          const digest = await sha256Range(th, start, end)
          const ok = digest === f.checksum.toLowerCase()
          allOk = allOk && ok
          files.push({ name: f.name, path: '', checksum: digest, ok })
          cursor = end
        }

        // Cross-check the aggregate (spec §5.5): finalChecksum is the
        // concatenation of per-file digests in manifest order.
        if (finalChecksum && finalChecksum.toLowerCase() !== files.map((f) => f.checksum).join('')) {
          this.events?.log?.('note: sender finalChecksum does not match the per-file digest concatenation')
        }

        // 2. write the outputs (only when everything verified).
        if (allOk) {
          await mkdir(this.outDir, { recursive: true })
          cursor = 0
          for (let i = 0; i < m.files.length; i++) {
            const f = m.files[i]
            const dest = join(this.outDir, safeRelativePath(f.name, f.relativePath))
            await mkdir(dirname(dest), { recursive: true })
            const out = await open(dest + '.part', 'w')
            try {
              const COPY = 1024 * 1024
              const buf = Buffer.allocUnsafe(Math.min(COPY, Math.max(1, f.size)))
              let pos = cursor
              while (pos < cursor + f.size) {
                const want = Math.min(buf.byteLength, cursor + f.size - pos)
                const { bytesRead } = await th.read(buf, 0, want, pos)
                if (bytesRead === 0) break
                await out.write(buf.subarray(0, bytesRead), 0, bytesRead)
                pos += bytesRead
              }
            } finally {
              await out.close()
            }
            await rename(dest + '.part', dest)
            files[i].path = dest
            cursor += f.size
          }
        }

        this.wire.send(encodeControlMessage(MessageType.TRANSFER_COMPLETE_ACK, m.transferId, 0, { verified: allOk }))
        if (allOk) {
          this.events?.log?.('verified: all file checksums match')
        } else {
          this.events?.log?.('verification FAILED — temp file kept for inspection')
        }
        this.wake({ verified: allOk, files })
        if (allOk) await this.cleanupTemp()
      } catch (err) {
        this.fail(`completion error: ${String(err)}`)
      }
    })()
  }

  private async cleanupTemp(): Promise<void> {
    if (this.tempHandle) {
      try {
        await this.tempHandle.close()
      } catch {
        /* ignore */
      }
      this.tempHandle = null
    }
    if (this.tempPath) {
      try {
        await rm(this.tempPath, { force: true })
      } catch {
        /* ignore */
      }
      this.tempPath = null
    }
  }

  async close(): Promise<void> {
    await this.cleanupTemp()
  }
}

/** Manifest invariant checks (mirror of the conformance suite's section 7). */
export function validateManifest(m: TransferManifest | null | undefined): string[] {
  const problems: string[] = []
  if (!m || typeof m !== 'object') return ['manifest is not an object']
  if (m.version !== 1) problems.push(`version must be 1, got ${String(m.version)}`)
  if (!Array.isArray(m.files) || m.files.length === 0) problems.push('files must be a non-empty array')
  else {
    if (m.files.length > CONSTANTS.MAX_FILES_PER_TRANSFER) problems.push(`too many files (> ${CONSTANTS.MAX_FILES_PER_TRANSFER})`)
    const sizeSum = m.files.reduce((s, f) => s + (f?.size ?? 0), 0)
    if (sizeSum !== m.totalSize) problems.push(`sum(files.size)=${sizeSum} != totalSize=${m.totalSize}`)
    if (m.chunkSize !== CONSTANTS.CHUNK_SIZE) problems.push(`unexpected chunkSize ${m.chunkSize} (expected ${CONSTANTS.CHUNK_SIZE})`)
    const expectedChunks = m.totalSize === 0 ? 0 : Math.ceil(m.totalSize / m.chunkSize)
    if (m.totalChunks !== expectedChunks) problems.push(`totalChunks=${m.totalChunks} != ceil(totalSize/chunkSize)=${expectedChunks}`)
    if (m.expiresAt !== undefined && m.createdAt !== undefined && m.expiresAt <= m.createdAt) problems.push('expiresAt <= createdAt')
    for (const f of m.files) {
      if (!f || typeof f.name !== 'string' || f.name.length === 0 || f.name.length > CONSTANTS.MAX_FILE_NAME_LENGTH) {
        problems.push(`bad file name: ${JSON.stringify(f?.name)}`)
      }
      if (f && !/^[0-9a-f]{64}$/.test(String(f.checksum ?? ''))) problems.push(`bad checksum for ${f?.name}`)
    }
  }
  if (m.compression !== undefined && m.compression !== 'gzip') problems.push(`unknown compression ${String(m.compression)}`)
  if (m.merkle !== undefined) {
    if (m.merkle.leaves !== m.totalChunks) problems.push('merkle.leaves != totalChunks')
    if (!/^[0-9a-f]{64}$/.test(String(m.merkle.root ?? ''))) problems.push('bad merkle.root')
  }
  return problems
}
