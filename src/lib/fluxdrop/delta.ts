// v5-a3: delta sync (rsync-lite) — pure library, no React / no DOM UI.
//
// Lets a sender describe a NEW file to a receiver that already holds a
// similar OLD file, as a compact list of "copy remote block" / "insert raw
// bytes" ops. Matches are UNALIGNED: a remote block may match at ANY byte
// offset of the new file (classic rsync rolling-checksum scan), not just at
// block-aligned ones.
//
// Intended pipeline (the transfer orchestrator wires this in later):
//   receiver: blockHashes(oldFile)                 → BlockHash[]
//   sender:   buildPatch(newBytes, remoteBlocks)    → { ops, stats }
//             encodePatch(ops)                      → Blob (FDDELTA1 container)
//   receiver: decodePatchStream(blob)               → PatchOp[]
//             applyPatch(ops, readBlock, onChunk)   → reassembled new file
//
// Threading note: buildPatch/applyPatch are async and yield periodically,
// but they are still CPU-heavy — the yields only keep a thread RESPONSIVE,
// they do not move work off it. Run them in a Web Worker for large files
// (the orchestrator will). buildPatch is async (rsync's core loop is
// traditionally sync) because the browser has no synchronous SHA-256 — the
// strong-hash confirmation goes through crypto.subtle.digest (or a
// caller-supplied async oracle; a WASM sync hash is out of scope).

// === Patch container format (binary) ===
//   magic      8 bytes   ASCII "FDDELTA1"
//   opCount    varint    number of op records that follow
//   opCount × op records:
//     discriminator varint   0 = copy, 1 = raw
//     copy:  varint blockIndex, varint byteLength
//     raw:   varint byteLength, then byteLength raw bytes
// Varints are unsigned LEB128 (7 bits per byte, low-order groups first,
// continuation bit 0x80) — same encoding for every field in the container.

/** Block size for the delta scan / block hash tiling (256 KiB). */
export const DELTA_BLOCK_SIZE = 262144

// === Tunables (private) ===
const ADLER_MOD = 65521
// Keeps the rolling-hash subtraction positive so one `%` suffices:
// max subtracted term is 255 * DELTA_BLOCK_SIZE = 66,846,720 < 1024 * 65521.
const ROLL_BIAS = 1024 * ADLER_MOD
// Raw runs merge into single ops, capped so a huge unmatched region can not
// materialize one multi-hundred-MB Uint8Array (bounds patch memory).
const RAW_CHUNK_MAX = 1024 * 1024 // 1 MiB
// buildPatch yields to the event loop every time the scan covers this many
// bytes (slid or jumped) so callers can keep their UI alive.
const BUILD_PATCH_YIELD_BYTES = 4 * 1024 * 1024 // 4 MiB
// applyPatch yields every N ops; decodePatchStream every N ops as well.
const APPLY_YIELD_OPS = 64
const DECODE_YIELD_OPS = 4096

// === Types ===

/** Per-block fingerprint of the OLD file: weak rolling hash + strong SHA-256. */
export interface BlockHash {
  /** Adler32-style 32-bit checksum over the block's bytes. */
  weak: number
  /** Lowercase hex SHA-256 of the block's bytes. */
  strong: string
  /** Byte offset of the block inside the old file (aligned to DELTA_BLOCK_SIZE). */
  offset: number
}

/**
 * One reconstruction step. A patch is an ordered list of these ops; replaying
 * them reproduces the new file byte-for-byte. `block` indexes into the remote
 * block list the patch was built against (i.e. readBlock(block) in applyPatch).
 */
export type PatchOp =
  | { op: 'copy'; block: number; length: number }
  | { op: 'raw'; data: Uint8Array }

/** Summary of a delta: how much of the new file came from remote blocks. */
export interface DeltaStats {
  /** Size of the OLD file (the block source the patch was built against). */
  originalSize: number
  /** Size of the NEW file (= copiedBytes + rawBytes). */
  patchedSize: number
  /** Bytes recovered from remote blocks (copy ops only). */
  copiedBytes: number
  /** Bytes that had to travel the wire verbatim (raw ops only). */
  rawBytes: number
  /** Number of blocks the old file was split into. */
  blockCount: number
  /** How many of those blocks the patch matched. */
  matchedBlocks: number
}

/** Thrown by decodePatchStream on malformed / truncated patch containers. */
export class DeltaFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeltaFormatError'
  }
}

// === Weak hash: adler32-style, fixed window (private) ===
// Two sums over the window bytes: a = 1 + Σx_i, b = Σ (running a), both mod
// 65521; combined weak = (b << 16) | a. The init always starts a at 1
// (offset-independent), so a window's weak hash depends only on its CONTENT
// — that is what allows matching a remote block at any offset in the new
// file. Sliding one byte is O(1):
//   a' = a - out + in         (mod 65521)
//   b' = b - out·N + a' - 1  (mod 65521, N = window length)
// (derived from b = N + Σ (N-j)·x_j; the roll lives inline in buildPatch's
// hot loop to avoid a per-byte object allocation.)

interface AdlerSums {
  a: number
  b: number
}

/** Init the two adler32 sums over bytes[start, end). */
function adler32Sums(bytes: Uint8Array, start: number, end: number): AdlerSums {
  let a = 1
  let b = 0
  for (let i = start; i < end; i++) {
    a = (a + bytes[i]) % ADLER_MOD
    b = (b + a) % ADLER_MOD
  }
  return { a, b }
}

/** Combine the two sums into the 32-bit weak hash stored in BlockHash. */
function combineWeak(a: number, b: number): number {
  return ((b << 16) | a) >>> 0
}

// === Strong hash (private default) ===

/**
 * SHA-256 hex of `data` via crypto.subtle — the default strong oracle used
 * by blockHashes and buildPatch. Mirrors checksum.ts's view narrowing for
 * TS 5.7+ DOM lib (BufferSource must be ArrayBuffer-backed; no copy when
 * `data` already is). Works in secure contexts and in Bun.
 */
async function defaultStrongHash(data: Uint8Array): Promise<string> {
  const source: Uint8Array<ArrayBuffer> =
    data.buffer instanceof ArrayBuffer
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', source)
  let hex = ''
  const raw = new Uint8Array(digest)
  for (let i = 0; i < raw.length; i++) {
    hex += raw[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** setTimeout-0 yield (a real macrotask — lets rendering/timers run). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// === Receiver side: fingerprint the old file ===

/**
 * Split `file` into DELTA_BLOCK_SIZE blocks and fingerprint each: the weak
 * rolling hash over the block plus a strong SHA-256 (crypto.subtle, hex).
 * Blocks are read strictly sequentially (Blob slices — RAM stays bounded on
 * multi-GB files); the last block may be shorter than DELTA_BLOCK_SIZE.
 * An empty file yields []. Between blocks the event loop gets a turn
 * (setTimeout 0 every other block — the per-block awaits plus this keep
 * hashing UI-friendly without halving throughput).
 *
 * Progress reports cumulative hashed bytes and the file total.
 */
export async function blockHashes(
  file: Blob,
  onProgress?: (bytes: number, total: number) => void
): Promise<BlockHash[]> {
  const total = file.size
  if (total === 0) return []

  const hashes: BlockHash[] = []
  let offset = 0
  let blockNum = 0
  while (offset < total) {
    const end = Math.min(offset + DELTA_BLOCK_SIZE, total)
    const block = new Uint8Array(await file.slice(offset, end).arrayBuffer())
    const sums = adler32Sums(block, 0, block.length)
    hashes.push({
      weak: combineWeak(sums.a, sums.b),
      strong: await defaultStrongHash(block),
      offset,
    })
    offset = end
    blockNum++
    onProgress?.(offset, total)
    if ((blockNum & 1) === 1) await yieldToEventLoop()
  }
  return hashes
}

// === Sender side: build the patch ===

/** Optional overrides for buildPatch. */
export interface BuildPatchOptions {
  /**
   * Strong-hash oracle used to confirm weak-hash hits. Receives a TRANSIENT
   * view into `newBytes` (valid only during the call) and must return the
   * same lowercase-hex encoding as BlockHash.strong. Defaults to SHA-256 via
   * crypto.subtle. Inject a cached/wasm implementation to taste.
   */
  strongHash?: (bytes: Uint8Array) => Promise<string>
}

/**
 * Classic rsync scan of `newBytes` against the receiver's `remoteBlocks`
 * (as produced by blockHashes — offsets must tile the old file in
 * DELTA_BLOCK_SIZE steps). The rolling window starts at offset 0 and slides
 * byte-by-byte, so remote blocks match at UNALIGNED offsets of the new
 * file. A match requires both the weak hash and the strong SHA-256 of the
 * window to agree; on a match a `copy` op is emitted and the scan jumps
 * forward by DELTA_BLOCK_SIZE (skip-ahead — windows overlapping the copied
 * region are never retested). Unmatched bytes accumulate and are flushed as
 * merged `raw` ops (capped at 1 MiB each) whenever a copy interrupts the
 * run and at EOF.
 *
 * `copy.block` is the INDEX into `remoteBlocks` (readBlock semantics in
 * applyPatch), not a byte offset. The new file's trailing partial block
 * (< DELTA_BLOCK_SIZE) and any short trailing remote block can never match
 * a full window, so tails are always carried as raw bytes.
 *
 * CPU-heavy: yields to the event loop every 4 MiB scanned (and awaits the
 * strong oracle on weak hits), but callers should still run this in a
 * worker for large files — see the module header. A short trailing remote
 * block never matches (its strong hash covers a different byte count), so
 * `stats.blockCount` counts it as unmatched by construction.
 *
 * `stats.originalSize` is the old file's implied size (last block offset +
 * one full block — exact when the old size is a multiple of
 * DELTA_BLOCK_SIZE, at most DELTA_BLOCK_SIZE - 1 too high otherwise);
 * recompute with deltaStats(ops, exactOldSize) when the exact figure is
 * known.
 */
export async function buildPatch(
  newBytes: Uint8Array,
  remoteBlocks: BlockHash[],
  opts: BuildPatchOptions = {}
): Promise<{ ops: PatchOp[]; stats: DeltaStats }> {
  const strongHash = opts.strongHash ?? defaultStrongHash
  const len = newBytes.length
  const ops: PatchOp[] = []
  let rawStart = 0 // start of the pending unmatched (raw) run

  // Weak-hash index: weak → candidates (array index + strong hash). Buckets
  // keep every candidate so a weak collision can never shadow the real hit —
  // the strong comparison decides.
  const index = new Map<number, { block: number; strong: string }[]>()
  for (let i = 0; i < remoteBlocks.length; i++) {
    const remote = remoteBlocks[i]
    let bucket = index.get(remote.weak)
    if (!bucket) {
      bucket = []
      index.set(remote.weak, bucket)
    }
    bucket.push({ block: i, strong: remote.strong })
  }

  // Scan only when there is something to match against and at least one
  // full window exists; otherwise everything below is raw (or empty).
  if (index.size > 0 && len >= DELTA_BLOCK_SIZE) {
    let pos = 0 // byte offset the current window starts at
    let winA = 0 // adler32 sums of the window starting at `pos`…
    let winB = 0
    let hashAt = -1 // …valid only while hashAt === pos (-1 = needs reseed)
    let lastYield = 0

    while (pos + DELTA_BLOCK_SIZE <= len) {
      // Yield every 4 MiB scanned (slid or jumped) — see module header.
      if (pos - lastYield >= BUILD_PATCH_YIELD_BYTES) {
        await yieldToEventLoop()
        lastYield = pos
      }

      if (hashAt !== pos) {
        // (Re)seed the rolling window — at scan start or after a copy jump.
        // O(DELTA_BLOCK_SIZE): the same cost as rolling forward a byte at a
        // time, so the skip-ahead is pure win.
        const sums = adler32Sums(newBytes, pos, pos + DELTA_BLOCK_SIZE)
        winA = sums.a
        winB = sums.b
        hashAt = pos
      }

      const bucket = index.get(combineWeak(winA, winB))
      if (bucket) {
        // Weak hit — confirm with the strong hash of the window bytes.
        const strong = await strongHash(
          newBytes.subarray(pos, pos + DELTA_BLOCK_SIZE)
        )
        const hit = bucket.find((c) => c.strong === strong)
        if (hit) {
          flushRawRun(ops, newBytes, rawStart, pos)
          ops.push({ op: 'copy', block: hit.block, length: DELTA_BLOCK_SIZE })
          pos += DELTA_BLOCK_SIZE
          rawStart = pos
          hashAt = -1
          continue
        }
      }

      // No match here: the byte at `pos` stays in the pending raw run and
      // the window slides one byte (only when a full window still exists —
      // a shorter tail can never match and is left to the final raw flush).
      if (pos + 1 + DELTA_BLOCK_SIZE <= len) {
        const outByte = newBytes[pos]
        const inByte = newBytes[pos + DELTA_BLOCK_SIZE]
        winA = (winA - outByte + inByte + ADLER_MOD) % ADLER_MOD
        winB = (winB - outByte * DELTA_BLOCK_SIZE + winA - 1 + ROLL_BIAS) % ADLER_MOD
        pos++
        hashAt = pos
      } else {
        pos++
        hashAt = -1
      }
    }
  }

  flushRawRun(ops, newBytes, rawStart, len)

  const impliedOldSize =
    remoteBlocks.length === 0
      ? 0
      : remoteBlocks[remoteBlocks.length - 1].offset + DELTA_BLOCK_SIZE
  return { ops, stats: deltaStats(ops, impliedOldSize) }
}

/** Flush [start, end) of newBytes as merged raw ops (≤ RAW_CHUNK_MAX each). */
function flushRawRun(
  ops: PatchOp[],
  newBytes: Uint8Array,
  start: number,
  end: number
): void {
  let s = start
  while (s < end) {
    const e = Math.min(s + RAW_CHUNK_MAX, end)
    // slice() copies — a raw op must never alias the caller's (possibly huge)
    // newBytes buffer; ops outlive the buildPatch call.
    ops.push({ op: 'raw', data: newBytes.slice(s, e) })
    s = e
  }
}

// === Patch container (encode / size / decode) ===

const PATCH_MAGIC = 'FDDELTA1' // 8 ASCII bytes
const PATCH_MAGIC_BYTES = new TextEncoder().encode(PATCH_MAGIC)
const OP_COPY = 0
const OP_RAW = 1

/** Byte length of a LEB128 varint for a non-negative value. */
function varintSize(value: number): number {
  let n = 1
  let v = Math.floor(value / 128)
  while (v > 0) {
    n++
    v = Math.floor(v / 128)
  }
  return n
}

/** Write a LEB128 varint at pos; returns the next write offset. */
function writeVarint(out: Uint8Array, pos: number, value: number): number {
  let v = value
  while (v >= 128) {
    out[pos++] = (v % 128) | 0x80
    v = Math.floor(v / 128)
  }
  out[pos] = v
  return pos + 1
}

/** Sequential reader over a decoded patch buffer (varints + bounds). */
class PatchReader {
  pos = 0
  constructor(private readonly buf: Uint8Array) {}

  readVarint(): number {
    let value = 0
    let multiplier = 1
    for (let n = 0; ; n++) {
      if (n >= 10) throw new DeltaFormatError('varint longer than 10 bytes')
      if (this.pos >= this.buf.length) {
        throw new DeltaFormatError('truncated varint')
      }
      const byte = this.buf[this.pos++]
      value += (byte & 0x7f) * multiplier
      if (value > Number.MAX_SAFE_INTEGER) {
        throw new DeltaFormatError('varint overflows safe integer')
      }
      if ((byte & 0x80) === 0) return value
      multiplier *= 128
    }
  }
}

/**
 * Byte length of encodePatch(ops)'s output WITHOUT building it — size the
 * container for wire/UI accounting without materializing the payload.
 */
export function patchEncodedSize(ops: PatchOp[]): number {
  let size = PATCH_MAGIC_BYTES.length + varintSize(ops.length)
  for (const op of ops) {
    if (op.op === 'copy') {
      size += 1 + varintSize(op.block) + varintSize(op.length)
    } else {
      size += 1 + varintSize(op.data.length) + op.data.length
    }
  }
  return size
}

/**
 * Serialize ops into the binary FDDELTA1 container (layout documented at
 * the top of this module): magic, varint op count, then per op a varint
 * discriminator (0=copy: block+length varints, 1=raw: length varint + bytes).
 */
export function encodePatch(ops: PatchOp[]): Blob {
  const out = new Uint8Array(patchEncodedSize(ops))
  out.set(PATCH_MAGIC_BYTES, 0)
  let pos = PATCH_MAGIC_BYTES.length
  pos = writeVarint(out, pos, ops.length)
  for (const op of ops) {
    if (op.op === 'copy') {
      out[pos++] = OP_COPY
      pos = writeVarint(out, pos, op.block)
      pos = writeVarint(out, pos, op.length)
    } else {
      out[pos++] = OP_RAW
      pos = writeVarint(out, pos, op.data.length)
      out.set(op.data, pos)
      pos += op.data.length
    }
  }
  if (pos !== out.length) {
    // Invariant: the sizing pass and the writer must agree exactly — a
    // mismatch would mean silent truncation (typed-array OOB writes drop).
    throw new Error('patch encoding size mismatch (sizing bug)')
  }
  return new Blob([out])
}

/**
 * Decode a FDDELTA1 container back into ops (inverse of encodePatch).
 * Raw-op data are zero-copy views into the decoded buffer — they are safe
 * to retain (nothing mutates that buffer). Throws DeltaFormatError on a bad
 * magic, impossible op counts, bad discriminators, zero-length ops,
 * truncated payloads, or trailing garbage. Yields every 4096 ops so huge
 * patches don't stall the caller's thread.
 */
export async function decodePatchStream(blob: Blob): Promise<PatchOp[]> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  if (
    buf.length < PATCH_MAGIC_BYTES.length ||
    !bytesEqual(buf.subarray(0, PATCH_MAGIC_BYTES.length), PATCH_MAGIC_BYTES)
  ) {
    throw new DeltaFormatError('bad magic (not an FDDELTA1 patch)')
  }

  const reader = new PatchReader(buf)
  reader.pos = PATCH_MAGIC_BYTES.length
  const opCount = reader.readVarint()
  // Each op needs ≥ 3 bytes (discriminator + two varints / disc + len + 1
  // data byte) — fail fast on corrupt counts instead of looping forever.
  if (opCount * 3 > buf.length - reader.pos) {
    throw new DeltaFormatError(`op count ${opCount} exceeds encoded size`)
  }

  const ops: PatchOp[] = []
  for (let i = 0; i < opCount; i++) {
    const discriminator = reader.readVarint()
    if (discriminator === OP_COPY) {
      const block = reader.readVarint()
      const length = reader.readVarint()
      if (length < 1) throw new DeltaFormatError('copy op with zero length')
      ops.push({ op: 'copy', block, length })
    } else if (discriminator === OP_RAW) {
      const length = reader.readVarint()
      if (length < 1) throw new DeltaFormatError('raw op with zero length')
      if (reader.pos + length > buf.length) {
        throw new DeltaFormatError('raw op data truncated')
      }
      ops.push({ op: 'raw', data: buf.subarray(reader.pos, reader.pos + length) })
      reader.pos += length
    } else {
      throw new DeltaFormatError(`unknown op discriminator ${discriminator}`)
    }
    if (i % DECODE_YIELD_OPS === DECODE_YIELD_OPS - 1) await yieldToEventLoop()
  }
  if (reader.pos !== buf.length) {
    throw new DeltaFormatError('trailing bytes after last op')
  }
  return ops
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// === Receiver side: reconstruct ===

/**
 * Streaming reconstruction: replay `ops` against the old file and feed each
 * produced segment to `onChunk` in order — the full output is NEVER
 * materialized (the caller writes chunks to disk as they arrive).
 *
 * `readBlock(blockIndex)` must return the bytes of remote block `blockIndex`
 * (i.e. oldFile[blockIndex * DELTA_BLOCK_SIZE, …+DELTA_BLOCK_SIZE)) or null
 * when unavailable. A null block ABORTS the reconstruction — { ok: false,
 * bytesWritten } reports how many bytes had already been emitted. A block
 * shorter than the op's length likewise aborts (it would silently corrupt
 * the output); a longer one is truncated to the op's length (honors
 * hand-built patches). Yields every 64 ops to keep the thread responsive.
 */
export async function applyPatch(
  ops: PatchOp[],
  readBlock: (blockIndex: number) => Promise<Uint8Array | null>,
  onChunk?: (bytes: Uint8Array) => void | Promise<void>
): Promise<{ ok: boolean; bytesWritten: number }> {
  let bytesWritten = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.op === 'copy') {
      const data = await readBlock(op.block)
      if (data == null || data.length < op.length) {
        return { ok: false, bytesWritten }
      }
      const segment = data.length === op.length ? data : data.subarray(0, op.length)
      await onChunk?.(segment)
      bytesWritten += segment.length
    } else {
      await onChunk?.(op.data)
      bytesWritten += op.data.length
    }
    if (i % APPLY_YIELD_OPS === APPLY_YIELD_OPS - 1) await yieldToEventLoop()
  }
  return { ok: true, bytesWritten }
}

// === Stats ===

/**
 * Compute DeltaStats from an op list. `originalSize` is the OLD file's size
 * (the block source) — blockCount is derived as ceil(originalSize /
 * DELTA_BLOCK_SIZE). patchedSize/copy/raw sums come straight from the ops,
 * so this is also the exact recomputation for buildPatch's returned stats
 * (whose originalSize is the implied upper bound — see buildPatch).
 */
export function deltaStats(ops: PatchOp[], originalSize: number): DeltaStats {
  let patchedSize = 0
  let copiedBytes = 0
  let rawBytes = 0
  let matchedBlocks = 0
  for (const op of ops) {
    if (op.op === 'copy') {
      copiedBytes += op.length
      patchedSize += op.length
      matchedBlocks++
    } else {
      rawBytes += op.data.length
      patchedSize += op.data.length
    }
  }
  return {
    originalSize,
    patchedSize,
    copiedBytes,
    rawBytes,
    blockCount: Math.ceil(originalSize / DELTA_BLOCK_SIZE),
    matchedBlocks,
  }
}
