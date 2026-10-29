// FluxDrop CLI — transfer engines (sender + receiver) over the REAL v1 wire
// protocol: manifest-first, 9-byte framed 64 KiB chunks, CHUNK_ACK pacing,
// SHA-256 verification. Plaintext only — the web client surfaces a visible
// downgrade toast when a CLI peer joins without E2EE (by design; see README).

import { open, stat, mkdir, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  MessageType,
  CONSTANTS,
  encodeChunkData,
  encodeChunkAck,
  encodeControlMessage,
  decodeMessage,
  type TransferManifest,
  type FileManifestEntry,
} from './proto'
import { sha256File, randomUUID, safeJoin } from './util'

// ---------------------------------------------------------------------------
// Manifest building (mirrors src/lib/fluxdrop/manifest.ts — that module pulls
// in browser-only worker code so the CLI reimplements the pure parts).
// ---------------------------------------------------------------------------

export async function buildManifest(paths: Array<{ name: string; path: string }>): Promise<TransferManifest> {
  const entries: FileManifestEntry[] = []
  let totalSize = 0
  for (const { name, path } of paths) {
    const st = await stat(path)
    entries.push({
      name,
      size: st.size,
      type: 'application/octet-stream',
      lastModified: Math.floor(st.mtimeMs),
      checksum: await sha256File(path),
      relativePath: name,
    })
    totalSize += st.size
  }
  const now = Date.now()
  return {
    transferId: randomUUID(),
    version: 1,
    files: entries,
    totalSize,
    totalChunks: Math.ceil(totalSize / CONSTANTS.CHUNK_SIZE),
    chunkSize: CONSTANTS.CHUNK_SIZE,
    createdAt: now,
    expiresAt: now + CONSTANTS.RESUME_RECORD_TTL_MS,
  }
}

// ---------------------------------------------------------------------------
// Slice plan: global chunk index -> per-file byte ranges
// (mirrors buildSlicePlan/resolveChunk from src/lib/fluxdrop/manifest.ts)
// ---------------------------------------------------------------------------

interface FileSlice { fileIndex: number; startByte: number; endByte: number }

export function buildSlicePlan(manifest: TransferManifest): FileSlice[] {
  const plan: FileSlice[] = []
  let offset = 0
  manifest.files.forEach((file, idx) => {
    plan.push({ fileIndex: idx, startByte: offset, endByte: offset + file.size })
    offset += file.size
  })
  return plan
}

export interface ChunkSegment { fileIndex: number; localStart: number; localEnd: number }

export function resolveChunk(plan: FileSlice[], chunkIndex: number, chunkSize: number): ChunkSegment[] {
  const globalStart = chunkIndex * chunkSize
  const globalEnd = globalStart + chunkSize
  const segments: ChunkSegment[] = []
  for (const seg of plan) {
    if (seg.endByte <= globalStart) continue
    if (seg.startByte >= globalEnd) break
    const overlapStart = Math.max(globalStart, seg.startByte)
    const overlapEnd = Math.min(globalEnd, seg.endByte)
    if (overlapEnd > overlapStart) {
      segments.push({ fileIndex: seg.fileIndex, localStart: overlapStart - seg.startByte, localEnd: overlapEnd - seg.startByte })
    }
  }
  return segments
}

/** The wire transferId is the first 4 UUID bytes as hex (protocol spec §3). */
export function wireIdOf(transferId: string): string {
  return transferId.replace(/-/g, '').slice(0, 8)
}

// ---------------------------------------------------------------------------
// Shared wire plumbing
// ---------------------------------------------------------------------------

export interface Wire {
  send(frame: ArrayBuffer | Uint8Array): void
  bufferedAmount(): number
}

export class ProtocolError extends Error {}

// ---------------------------------------------------------------------------
// SENDER
// ---------------------------------------------------------------------------

export interface SenderProgress {
  sentChunks: number
  totalChunks: number
  bytesSent: number
  totalBytes: number
  acked: number
}

export class SendEngine {
  manifest!: TransferManifest
  private unacked = new Map<number, Uint8Array>() // chunkIndex -> framed bytes (re-send source)
  private ackedCount = 0
  private manifestAck: { accepted: boolean; reason?: string } | null = null
  private completeAck: { verified: boolean } | null = null
  private cancelReason: string | null = null
  private failedChunks = new Set<number>()

  constructor(private wire: Wire, private paths: Array<{ name: string; path: string }>, private onProgress?: (p: SenderProgress) => void) {}

  async handleFrame(data: ArrayBuffer): Promise<void> {
    let msg
    try {
      msg = decodeMessage(data)
    } catch (err) {
      throw new ProtocolError(`malformed frame: ${(err as Error).message}`)
    }
    switch (msg.type) {
      case MessageType.MANIFEST_ACK:
        this.manifestAck = (msg.body ?? {}) as { accepted: boolean; reason?: string }
        break
      case MessageType.CHUNK_ACK: {
        const ok = new Uint8Array(msg.payload)[0] === 0x01
        if (ok) {
          if (this.unacked.delete(msg.chunkIndex)) this.ackedCount++
        } else {
          this.failedChunks.add(msg.chunkIndex) // re-send in the endgame poll
        }
        break
      }
      case MessageType.TRANSFER_COMPLETE_ACK:
        this.completeAck = (msg.body ?? {}) as { verified: boolean }
        break
      case MessageType.TRANSFER_CANCEL:
        this.cancelReason = String((msg.body as { reason?: string })?.reason ?? 'cancelled by receiver')
        break
      default:
        break // preview/chat/E2EE frames: out of scope for the headless CLI
    }
  }

  get cancelled(): boolean { return this.cancelReason !== null }

  private async waitUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (this.cancelled) throw new ProtocolError(`transfer cancelled: ${this.cancelReason}`)
      if (Date.now() > deadline) throw new ProtocolError(`timed out waiting for ${what}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async run(): Promise<TransferManifest> {
    // 1. MANIFEST
    this.manifest = await buildManifest(this.paths)
    this.wire.send(encodeControlMessage(MessageType.MANIFEST, this.manifest.transferId, 0, this.manifest))

    // 2. MANIFEST_ACK (CLI receivers accept unconditionally; the web client
    //    answers after its consent dialog).
    await this.waitUntil(() => this.manifestAck !== null, 30_000, 'MANIFEST_ACK')
    if (!this.manifestAck?.accepted) {
      throw new ProtocolError(`receiver declined the transfer: ${this.manifestAck?.reason ?? 'no reason given'}`)
    }

    // 3. CHUNK_DATA stream with CHUNK_ACK pacing.
    const { totalChunks, chunkSize, totalSize, transferId } = this.manifest
    const plan = buildSlicePlan(this.manifest)
    const handles: FileHandle[] = []
    let bytesSent = 0
    try {
      for (const p of this.paths) handles.push(await open(p.path, 'r'))
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const segments = resolveChunk(plan, chunkIndex, chunkSize)
        const payload = new Uint8Array(chunkSize)
        let fill = 0
        for (const seg of segments) {
          const len = seg.localEnd - seg.localStart
          const buf = Buffer.allocUnsafe(len)
          const { bytesRead } = await handles[seg.fileIndex].read(buf, 0, len, seg.localStart)
          payload.set(bytesRead === len ? buf : buf.subarray(0, bytesRead), fill)
          fill += bytesRead
        }
        const body = payload.subarray(0, fill)

        // Backpressure: stop enqueueing above 32 MiB (MAX_BUFFERED_BYTES).
        while (this.wire.bufferedAmount() > CONSTANTS.MAX_BUFFERED_BYTES) {
          await new Promise((r) => setTimeout(r, 5))
        }

        const frame = encodeChunkData(transferId, chunkIndex, body, false)
        this.wire.send(frame)
        this.unacked.set(chunkIndex, frame)
        bytesSent += fill
        this.onProgress?.({ sentChunks: chunkIndex + 1, totalChunks, bytesSent, totalBytes: totalSize, acked: this.ackedCount })
      }

      // 4. Endgame: let in-flight ACKs land first, then recover lost/failing
      // ACKs with bounded re-send rounds.
      await new Promise((r) => setTimeout(r, 250))
      for (let round = 0; round < 10 && this.unacked.size > 0 && !this.cancelled; round++) {
        for (const idx of [...this.unacked.keys()]) {
          this.failedChunks.delete(idx)
          this.wire.send(this.unacked.get(idx)!)
        }
        await this.waitUntil(() => this.unacked.size === 0 || this.cancelled, 10_000, `remaining CHUNK_ACKs (${this.unacked.size})`).catch(() => undefined)
      }
      if (this.unacked.size > 0) {
        throw new ProtocolError(`receiver did not acknowledge ${this.unacked.size} chunk(s) after retries`)
      }

      // 5. TRANSFER_COMPLETE — finalChecksum is the concatenated per-file hex
      //    digests in manifest order (matches the web sender).
      const finalChecksum = this.manifest.files.map((f) => f.checksum).join('')
      this.wire.send(encodeControlMessage(MessageType.TRANSFER_COMPLETE, transferId, 0, { finalChecksum }))
      await this.waitUntil(() => this.completeAck !== null, 60_000, 'TRANSFER_COMPLETE_ACK')
      if (!this.completeAck?.verified) {
        throw new ProtocolError('receiver reported checksum verification FAILURE')
      }
    } finally {
      for (const fh of handles) await fh.close().catch(() => undefined)
    }
    return this.manifest
  }
}

// ---------------------------------------------------------------------------
// RECEIVER
// ---------------------------------------------------------------------------

export interface ReceiverProgress {
  receivedChunks: number
  totalChunks: number
  bytesReceived: number
  totalBytes: number
}

export class ReceiveEngine {
  manifest: TransferManifest | null = null
  private received = new Set<number>()
  private bytesReceived = 0
  private completeReceived: { finalChecksum: string } | null = null
  verified: boolean | null = null
  private cancelReason: string | null = null
  private plan: FileSlice[] | null = null
  private outPaths: string[] = []
  private handles: FileHandle[] = []
  private lastActivity = Date.now()

  constructor(private wire: Wire, private outDir: string, private onProgress?: (p: ReceiverProgress) => void) {}

  get stalled(): boolean {
    return this.manifest !== null && this.completeReceived === null && Date.now() - this.lastActivity > 120_000
  }

  get cancelled(): boolean { return this.cancelReason !== null }
  get isComplete(): boolean { return this.completeReceived !== null }

  async handleFrame(data: ArrayBuffer): Promise<void> {
    let msg
    try {
      msg = decodeMessage(data)
    } catch (err) {
      throw new ProtocolError(`malformed frame: ${(err as Error).message}`)
    }
    this.lastActivity = Date.now()
    const m = this.manifest
    switch (msg.type) {
      case MessageType.MANIFEST: {
        this.manifest = (msg.body ?? null) as TransferManifest | null
        if (!this.manifest?.transferId) throw new ProtocolError('invalid manifest (missing transferId)')
        // Accept unconditionally — the CLI has no consent UI.
        this.wire.send(encodeControlMessage(MessageType.MANIFEST_ACK, this.manifest.transferId, 0, { accepted: true }))
        await this.prepareOutput(this.manifest)
        console.log(`\n📦 manifest: ${this.manifest.files.length} file(s), ${this.manifest.totalSize} bytes, ${this.manifest.totalChunks} chunks`)
        for (const f of this.manifest.files) console.log(`   • ${f.name} (${f.size} bytes, sha256 ${f.checksum.slice(0, 12)}…)`)
        break
      }
      case MessageType.CHUNK_DATA: {
        if (!m) throw new ProtocolError('CHUNK_DATA before MANIFEST')
        if (msg.transferId !== wireIdOf(m.transferId)) throw new ProtocolError(`chunk for unknown transfer ${msg.transferId} (expected ${wireIdOf(m.transferId)})`)
        await this.storeChunk(m, msg.chunkIndex, msg.payloadView)
        this.wire.send(encodeChunkAck(m.transferId, msg.chunkIndex, true))
        this.received.add(msg.chunkIndex)
        this.onProgress?.({
          receivedChunks: this.received.size,
          totalChunks: m.totalChunks,
          bytesReceived: this.bytesReceived,
          totalBytes: m.totalSize,
        })
        break
      }
      case MessageType.TRANSFER_COMPLETE: {
        if (!m) throw new ProtocolError('TRANSFER_COMPLETE before MANIFEST')
        this.completeReceived = (msg.body ?? { finalChecksum: '' }) as { finalChecksum: string }
        this.verified = await this.verify(m)
        this.wire.send(encodeControlMessage(MessageType.TRANSFER_COMPLETE_ACK, m.transferId, 0, { verified: this.verified }))
        break
      }
      case MessageType.TRANSFER_CANCEL:
        this.cancelReason = String((msg.body as { reason?: string })?.reason ?? 'cancelled by sender')
        break
      default:
        break // previews/chat/pause/resume: irrelevant for the headless CLI
    }
  }

  private async prepareOutput(m: TransferManifest): Promise<void> {
    this.plan = buildSlicePlan(m)
    this.handles = []
    this.outPaths = []
    for (const file of m.files) {
      const target = safeJoin(this.outDir, file.relativePath || file.name)
      await mkdir(dirname(target), { recursive: true })
      const fh = await open(target, 'w')
      // Pre-allocate the file so positional chunk writes land at the right
      // offsets even when chunks arrive out of order (retry path).
      if (file.size > 0) await fh.truncate(file.size).catch(() => undefined)
      this.handles.push(fh)
      this.outPaths.push(target)
    }
  }

  private async storeChunk(m: TransferManifest, chunkIndex: number, bytes: Uint8Array): Promise<void> {
    const segments = resolveChunk(this.plan!, chunkIndex, m.chunkSize)
    let offset = 0
    const isNew = !this.received.has(chunkIndex)
    for (const seg of segments) {
      const len = Math.min(seg.localEnd - seg.localStart, bytes.byteLength - offset)
      if (len <= 0) break // short final chunk tail
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset + offset, len)
      await this.handles[seg.fileIndex].write(buf, 0, len, seg.localStart)
      if (isNew) this.bytesReceived += len
      offset += len
    }
  }

  private async verify(m: TransferManifest): Promise<boolean> {
    let allOk = true
    for (let i = 0; i < m.files.length; i++) {
      const actual = await sha256File(this.outPaths[i]).catch(() => null)
      const expected = m.files[i].checksum.toLowerCase()
      const ok = actual === expected
      console.log(`${ok ? '✅' : '❌'} sha256 ${m.files[i].name}: ${actual ?? '<unreadable>'} ${ok ? '==' : '!='} ${expected}`)
      if (!ok) allOk = false
    }
    return allOk
  }

  async close(): Promise<void> {
    for (const fh of this.handles) await fh.close().catch(() => undefined)
    this.handles = []
  }

  get resultPaths(): string[] { return this.outPaths }
}
