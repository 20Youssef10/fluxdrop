// FluxDrop CLI — `fluxdrop loopback` demo.
//
// In-process sender ↔ receiver self-test: no network, no WebRTC, no
// signaling server — the REAL binary framing (src/lib/fluxdrop/encoding.ts)
// runs over a memory pipe, exercising manifest exchange, 64 KiB chunking,
// per-chunk ACKs (with simulated ACK loss to prove the re-send sweep),
// TRANSFER_COMPLETE and SHA-256 verification.
//
// Exit 0 when the received bytes hash-match the sources.

import { CONSTANTS, HEADER_SIZE, decodeFrame, type DecodedMessage, type TransferManifest, type FileManifestEntry } from './proto'
import { SenderSession, ReceiverSession, type Wire } from './session'
import { collectFiles, entryName, fmtBytes, fmtDuration, guessMime, randomUUID, sha256File } from './util'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface LoopbackOptions {
  files: string[]
  size: number
  outDir: string
  drops: number
}

/**
 * Memory pipe: `send()` validates the frame decodes (framing check both
 * ways), then schedules async delivery to the peer handler — mimicking
 * network scheduling. `dropFirstAcks` discards the first N CHUNK_ACK frames
 * that cross this pipe (lost-ACK simulation for the re-send sweep).
 */
class LoopPipe implements Wire {
  frames = 0
  bytes = 0
  private peerHandler: ((m: DecodedMessage) => void) | null = null

  constructor(private dropFirstAcks: number) {}

  onPeer(handler: (m: DecodedMessage) => void): void {
    this.peerHandler = handler
  }

  send(bytes: Uint8Array | ArrayBuffer): void {
    this.frames++
    this.bytes += bytes.byteLength
    const msg = decodeFrame(bytes) // throws on malformed framing — the point of the demo
    if (this.dropFirstAcks > 0 && msg.type === 0x02) {
      this.dropFirstAcks--
      return // simulate a lost ACK
    }
    setTimeout(() => this.peerHandler?.(msg), 0)
  }

  bufferedAmount(): number {
    return 0
  }
  maxMessageSize(): number {
    return HEADER_SIZE + CONSTANTS.CHUNK_SIZE
  }
}

export async function cmdLoopback(opts: LoopbackOptions): Promise<number> {
  const say = (s: string) => process.stdout.write(s + '\n')
  const startedAt = Date.now()

  // ---- sources ---------------------------------------------------------------
  let sources: { path: string; size: number; mtimeMs: number }[]
  if (opts.files.length > 0) {
    sources = await collectFiles(opts.files)
    say(`FluxDrop loopback — ${sources.length} file(s) from the command line`)
  } else {
    const size = Math.max(1, opts.size)
    const p = join(tmpdir(), `fluxdrop-loopback-${Date.now()}.bin`)
    // Random bytes: no compressible structure, so the hash can't pass by luck.
    const chunk = 1 << 20
    for (let off = 0; off < size; off += chunk) {
      const n = Math.min(chunk, size - off)
      const part = randomBytes(n)
      await writeFile(p, off === 0 ? part : part, { flag: off === 0 ? 'w' : 'a' })
    }
    const st = await collectFiles([p])
    sources = st
    say(`FluxDrop loopback — generated ${fmtBytes(size)} random file`)
  }
  const totalSize = sources.reduce((s, f) => s + f.size, 0)

  // ---- manifest (same shape cmdSend builds) -----------------------------------
  const entries: FileManifestEntry[] = []
  for (const f of sources) {
    entries.push({
      name: entryName(f.path),
      size: f.size,
      type: guessMime(f.path),
      lastModified: f.mtimeMs,
      checksum: await sha256File(f.path),
      relativePath: entryName(f.path),
    })
  }
  const now = Date.now()
  const manifest: TransferManifest = {
    transferId: randomUUID(),
    version: 1,
    files: entries,
    totalSize,
    totalChunks: Math.ceil(totalSize / CONSTANTS.CHUNK_SIZE),
    chunkSize: CONSTANTS.CHUNK_SIZE,
    createdAt: now,
    expiresAt: now + CONSTANTS.RESUME_RECORD_TTL_MS,
  }
  say(`manifest: ${entries.length} file(s), ${manifest.totalChunks} chunks of ${fmtBytes(CONSTANTS.CHUNK_SIZE)}`)

  // ---- wire the two sessions through memory pipes ------------------------------
  const outDir = join(opts.outDir, `loopback-${manifest.transferId.slice(0, 8)}`)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const senderWire = new LoopPipe(0)
  const receiverWire = new LoopPipe(opts.drops)
  const sender = new SenderSession(senderWire, manifest, sources, {
    log: (m) => say(`  [sender] ${m}`),
  })
  const receiver = new ReceiverSession(receiverWire, outDir, {
    log: (m) => say(`  [receiver] ${m}`),
  })
  senderWire.onPeer((m) => receiver.handleMessage(m))
  receiverWire.onPeer((m) => sender.handleMessage(m))

  // ---- run ------------------------------------------------------------------------
  sender.start()
  const done = await receiver.waitDone()

  if (!done.verified) {
    process.stderr.write('✗ loopback FAILED — receiver did not verify\n')
    return 1
  }

  // ---- independent re-verification (ground truth: sha256sum-style) ----------------
  let allOk = true
  for (let i = 0; i < entries.length; i++) {
    const produced = done.files[i]
    const expected = await sha256File(produced.path)
    const ok = expected === entries[i].checksum && produced.ok
    allOk = allOk && ok
    say(`  ${ok ? '✓' : '✗'} ${entries[i].name.padEnd(24)} ${fmtBytes(entries[i].size).padStart(9)}  sha256 ${expected.slice(0, 16)}…`)
  }

  const elapsed = Date.now() - startedAt
  say('')
  if (allOk) {
    say(`✓ loopback PASSED — ${fmtBytes(totalSize)} in ${fmtDuration(elapsed)} (${(totalSize * 8 / (elapsed / 1000) / 1e6).toFixed(1)} Mbit/s effective)`)
    say(`  frames: ${senderWire.frames} sender → receiver, ${receiverWire.frames} receiver → sender`)
    say(`  simulated lost ACKs recovered by re-send sweep: ${opts.drops}`)
    say(`  output kept in ${outDir}`)
    return 0
  }
  process.stderr.write('✗ loopback FAILED — output hashes do not match the sources\n')
  return 1
}
