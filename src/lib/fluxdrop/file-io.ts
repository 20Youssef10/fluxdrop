// File I/O: streaming writes via File System Access API,
// folder preservation via showDirectoryPicker, and download fallback.

export function assembleBlob(chunks: ArrayBuffer[], mime: string = 'application/octet-stream'): Blob {
  return new Blob(chunks, { type: mime })
}

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 1000)
}

/**
 * Save a blob using the File System Access API with a save picker.
 * Falls back to a standard download if the API is unavailable.
 */
export async function saveBlobWithPicker(blob: Blob, suggestedName: string): Promise<'saved' | 'fallback' | 'cancelled'> {
  const w = window as any
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'All files', accept: { 'application/octet-stream': ['.*'] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return 'saved'
    } catch (err: any) {
      if (err?.name === 'AbortError') return 'cancelled'
    }
  }
  triggerDownload(blob, suggestedName)
  return 'fallback'
}

/**
 * Stream-write received chunks to a file using the File System Access API.
 * This avoids holding the entire file in RAM — each chunk is written as it arrives.
 * Falls back to blob assembly + download if the API is unavailable.
 */
export class StreamFileWriter {
  private writable: FileSystemWritableFileStream | null = null
  private handle: any = null
  private offset = 0
  private isStreaming = false

  /**
   * Open a file for streaming writes.
   * If File System Access API is unavailable, returns false (caller should use blob assembly).
   */
  async open(suggestedName: string): Promise<boolean> {
    const w = window as any
    if (!w.showSaveFilePicker) return false
    try {
      this.handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'All files', accept: { 'application/octet-stream': ['.*'] } }],
      })
      this.writable = await this.handle.createWritable()
      this.isStreaming = true
      this.offset = 0
      return true
    } catch (err: any) {
      if (err?.name === 'AbortError') return false
      return false
    }
  }

  /**
   * Write a chunk at a specific offset (positional write).
   * The DataChannel is ordered, so chunks arrive in order.
   */
  async writeChunk(data: ArrayBuffer, position: number): Promise<void> {
    if (!this.writable) throw new Error('Writer not open')
    // Use positional write if supported, otherwise sequential write.
    if (typeof (this.writable as any).write === 'function') {
      await (this.writable as any).write({ type: 'write', data, position })
    } else {
      await (this.writable as any).write(data)
    }
    this.offset = position + data.byteLength
  }

  /** Close the writer. Call after all chunks are written. */
  async close(): Promise<void> {
    if (this.writable) {
      await this.writable.close()
      this.writable = null
    }
    this.isStreaming = false
  }

  get isOpen(): boolean {
    return this.isStreaming
  }
}

/**
 * v1.2 (4.3): how a conflicted file (target name already exists in the chosen
 * folder) should be written. Missing resolution = 'rename' (safest default).
 */
export type SaveResolution = 'rename' | 'overwrite' | 'skip'

/** v1.2 (4.3): one target file that already exists in the destination folder. */
export interface SaveConflict {
  fileName: string
  path: string
}

/**
 * Find a free file name in `dirHandle` for a conflicted file:
 * "{base} ({n}){ext}", n = 1, 2, 3… Only the final filename is renamed —
 * subdirectory structure is untouched.
 */
async function findFreeName(dirHandle: any, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`
    const taken = await dirHandle
      .getFileHandle(candidate, { create: false })
      .then(() => true)
      .catch(() => false)
    if (!taken) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

/**
 * Save multiple files preserving folder structure via showDirectoryPicker.
 * If the API is unavailable, falls back to individual download per file.
 *
 * v1.2 (4.3) conflict-aware options:
 * - `opts.onConflict` — called (awaited) with the list of target files that
 *   already exist in the picked directory, BEFORE anything is written. It
 *   returns a per-file resolution map keyed by `relativePath` (missing key =
 *   'rename'), or `null` to cancel the whole save (nothing is written).
 * - No `opts` → legacy behavior (plain overwrite).
 */
export async function saveFilesToDirectory(
  files: { name: string; blob: Blob; relativePath: string }[],
  opts?: {
    onConflict?: (conflicts: SaveConflict[]) => Promise<Record<string, SaveResolution> | null>
  }
): Promise<'saved' | 'fallback' | 'cancelled'> {
  const w = window as any
  if (!w.showDirectoryPicker) {
    // Fallback: download each file individually.
    for (const f of files) {
      triggerDownload(f.blob, f.name)
    }
    return 'fallback'
  }
  try {
    const dirHandle = await w.showDirectoryPicker({ mode: 'readwrite' })

    // Conflict detection (only when a resolver was provided): for each target,
    // walk the existing subdirectories (create:false) and probe the file name.
    // A missing parent directory means the target is fresh — no conflict.
    let resolutions: Record<string, SaveResolution> | null = null
    const conflictPaths = new Set<string>()
    if (opts?.onConflict) {
      const conflicts: SaveConflict[] = []
      for (const f of files) {
        const parts = f.relativePath.split('/').filter(Boolean)
        let currentDir = dirHandle
        let reachable = true
        for (let i = 0; i < parts.length - 1; i++) {
          try {
            currentDir = await currentDir.getDirectoryHandle(parts[i], { create: false })
          } catch {
            reachable = false
            break
          }
        }
        if (!reachable) continue
        const fileName = parts[parts.length - 1] || f.name
        const exists = await currentDir
          .getFileHandle(fileName, { create: false })
          .then(() => true)
          .catch(() => false)
        if (exists) conflicts.push({ fileName, path: f.relativePath })
      }
      if (conflicts.length > 0) {
        const answers = await opts.onConflict(conflicts)
        if (answers === null) {
          // User backed out of the conflict dialog — write nothing.
          return 'cancelled'
        }
        // Materialize the map: a conflicted file missing a key defaults to
        // 'rename' (never clobber user data silently).
        resolutions = {}
        for (const c of conflicts) {
          resolutions[c.path] = answers[c.path] ?? 'rename'
          conflictPaths.add(c.path)
        }
      }
    }

    for (const f of files) {
      // Only conflicted files follow their resolution; everything else is
      // written as before (plain overwrite of the picked directory's content).
      if (conflictPaths.has(f.relativePath)) {
        if (resolutions?.[f.relativePath] === 'skip') continue
      }
      // Create subdirectories if needed for relativePath.
      const parts = f.relativePath.split('/').filter(Boolean)
      let currentDir = dirHandle
      // Navigate/create subdirectories (all parts except the last = filename).
      for (let i = 0; i < parts.length - 1; i++) {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
      }
      let fileName = parts[parts.length - 1] || f.name
      // 'rename': never overwrite — find the next free "name (n).ext" in the
      // same directory (only the final filename is renamed; subdirectories are
      // unaffected).
      if (conflictPaths.has(f.relativePath) && resolutions?.[f.relativePath] === 'rename') {
        fileName = await findFreeName(currentDir, fileName)
      }
      const fileHandle = await currentDir.getFileHandle(fileName, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(f.blob)
      await writable.close()
    }
    return 'saved'
  } catch (err: any) {
    if (err?.name === 'AbortError') return 'cancelled'
    // Fallback: download each file individually.
    for (const f of files) {
      triggerDownload(f.blob, f.name)
    }
    return 'fallback'
  }
}

export function isFileSystemAccessSupported(): boolean {
  return typeof (window as any).showSaveFilePicker === 'function'
}

export function isDirectoryPickerSupported(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function'
}
