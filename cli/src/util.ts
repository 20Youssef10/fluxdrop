// FluxDrop CLI — small shared utilities (hashing, formatting, FS helpers).

import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, stat } from 'node:fs/promises'
import { basename } from 'node:path'

const READ_SLICE = 1024 * 1024 // 1 MiB read slices

/** Streaming SHA-256 of a file on disk — matches `sha256sum` at any size. */
export async function sha256File(path: string): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(READ_SLICE)
    let pos = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, READ_SLICE, pos)
      if (bytesRead === 0) break
      hash.update(bytesRead === READ_SLICE ? buf : buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await fh.close()
  }
}

/** SHA-256 of an in-memory byte range of an open file handle. */
export async function sha256Range(
  fh: import('node:fs/promises').FileHandle,
  start: number,
  end: number
): Promise<string> {
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(Math.min(READ_SLICE, Math.max(1, end - start)))
  let pos = start
  while (pos < end) {
    const want = Math.min(buf.byteLength, end - pos)
    const { bytesRead } = await fh.read(buf, 0, want, pos)
    if (bytesRead === 0) break
    hash.update(bytesRead === buf.byteLength && want === buf.byteLength ? buf : buf.subarray(0, bytesRead))
    pos += bytesRead
  }
  return hash.digest('hex')
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

export { randomUUID }

/** Minimal extension → MIME map for manifest `type` fields. */
const MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', html: 'text/html',
  css: 'text/css', js: 'application/javascript', ts: 'application/typescript',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  wasm: 'application/wasm',
}
export function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

export interface SourceFile {
  path: string
  size: number
  mtimeMs: number
}

/** Stat + normalize a list of files for sending. Throws on missing files. */
export async function collectFiles(paths: string[]): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (const p of paths) {
    const st = await stat(p)
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`)
    out.push({ path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) })
  }
  return out
}

/** Manifest entry name — basename of the source path. */
export function entryName(p: string): string {
  return basename(p)
}

/**
 * Sanitize a manifest relativePath for local writes: no leading slashes,
 * no `..` segments — anything fishy collapses to the entry name.
 */
export function safeRelativePath(name: string, relativePath: string): string {
  const candidate = (relativePath || name).split(/[/\\]+/).filter((seg) => seg && seg !== '.' && seg !== '..')
  return candidate.length ? candidate.join('/') : name.replace(/[/\\]/g, '_')
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Simple byte-formatting progress line renderer (rewrites one line). */
export class ProgressLine {
  private last = ''
  private lastAt = 0
  constructor(private enabled: boolean) {}
  update(text: string, force = false): void {
    if (!this.enabled) return
    const now = Date.now()
    if (!force && now - this.lastAt < 100 && text !== this.last) return
    this.lastAt = now
    if (this.last) process.stdout.write('\r\x1b[2K')
    process.stdout.write(text.slice(0, 120))
    this.last = text
  }
  done(final?: string): void {
    if (!this.enabled) return
    if (this.last) process.stdout.write('\r\x1b[2K')
    if (final) process.stdout.write(final + '\n')
    else if (this.last) process.stdout.write('\n')
    this.last = ''
  }
}
