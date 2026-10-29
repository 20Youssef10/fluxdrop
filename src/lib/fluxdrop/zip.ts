// v4 (4.2): zip-on-receive — a dependency-free ZIP writer.
// STORE method for already-compressed payloads (zero extra CPU, exact bytes
// preserved for checksum parity) with CRC-32 per entry, local file headers +
// central directory, and UTF-8 names. Files stay Blob-backed (File.slice is
// lazy) so zipping a multi-GB vault entry never doubles RAM.

'use client'

// --- CRC-32 (IEEE 802.3, reflected) with a lazily built table ---
let crcTable: Uint32Array | null = null
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  crcTable = t
  return t
}

export function crc32(buf: Uint8Array, seed = 0xffffffff): number {
  const t = getCrcTable()
  let c = seed
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface ZipEntry {
  name: string
  blob: Blob
  crc: number
  size: number
  // Central directory fields
  offset: number
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * Build a .zip Blob from a list of named blobs (STORE method).
 * Names may contain '/' for folder structure. Returns the archive Blob.
 * Progress reports after each entry (0..1).
 */
export async function buildZip(
  files: Array<{ name: string; blob: Blob }>,
  onProgress?: (done: number, total: number) => void
): Promise<Blob> {
  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const entries: ZipEntry[] = []
  let offset = 0
  const { time, date } = dosDateTime(new Date())

  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    // Compute CRC streaming in 1 MB slices — never materialize the file.
    let crc = 0xffffffff
    let remaining = f.blob.size
    let pos = 0
    while (remaining > 0) {
      const n = Math.min(remaining, 1024 * 1024)
      const chunk = new Uint8Array(await f.blob.slice(pos, pos + n).arrayBuffer())
      crc = crc32(chunk, crc)
      pos += n
      remaining -= n
    }
    const crcFinal = (crc ^ 0xffffffff) >>> 0

    // --- Local file header ---
    const nameBytes = encoder.encode(f.name)
    const lfh = new DataView(new ArrayBuffer(30))
    lfh.setUint32(0, 0x04034b50, true) // signature
    lfh.setUint16(4, 20, true) // version needed
    lfh.setUint16(6, 0x0800, true) // UTF-8 name flag
    lfh.setUint16(8, 0, true) // method: STORE
    lfh.setUint16(10, time, true)
    lfh.setUint16(12, date, true)
    lfh.setUint32(14, crcFinal, true)
    lfh.setUint32(18, f.blob.size, true) // compressed size
    lfh.setUint32(22, f.blob.size, true) // uncompressed size
    lfh.setUint16(26, nameBytes.length, true)
    lfh.setUint16(28, 0, true) // extra length
    parts.push(lfh.buffer, nameBytes, f.blob)
    entries.push({ name: f.name, blob: f.blob, crc: crcFinal, size: f.blob.size, offset })
    offset += 30 + nameBytes.length + f.blob.size
    onProgress?.(i + 1, files.length)
    // Yield so a big zip doesn't freeze the UI.
    await new Promise((r) => setTimeout(r, 0))
  }

  // --- Central directory ---
  const cdStart = offset
  for (const e of entries) {
    const nameBytes = encoder.encode(e.name)
    const cdh = new DataView(new ArrayBuffer(46))
    cdh.setUint32(0, 0x02014b50, true)
    cdh.setUint16(4, 20, true) // version made by
    cdh.setUint16(6, 20, true) // version needed
    cdh.setUint16(8, 0x0800, true) // UTF-8
    cdh.setUint16(10, 0, true) // STORE
    cdh.setUint16(12, time, true)
    cdh.setUint16(14, date, true)
    cdh.setUint32(16, e.crc, true)
    cdh.setUint32(20, e.size, true)
    cdh.setUint32(24, e.size, true)
    cdh.setUint16(28, nameBytes.length, true)
    cdh.setUint16(30, 0, true) // extra
    cdh.setUint16(32, 0, true) // comment
    cdh.setUint16(34, 0, true) // disk number
    cdh.setUint16(36, 0, true) // internal attrs
    cdh.setUint32(38, 0, true) // external attrs
    cdh.setUint32(42, e.offset, true)
    parts.push(cdh.buffer, nameBytes)
    offset += 46 + nameBytes.length
  }

  // --- End of central directory ---
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, offset - cdStart, true) // central dir size
  eocd.setUint32(16, cdStart, true)
  eocd.setUint16(20, 0, true)
  parts.push(eocd.buffer)

  return new Blob(parts, { type: 'application/zip' })
}

/** Suggest a zip name for a multi-file transfer: primary name or transfer id. */
export function zipNameFor(primary: string): string {
  const base = primary.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[^.]+$/, '')
  return `${base || 'fluxdrop'}.zip`
}
