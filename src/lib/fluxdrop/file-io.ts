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
 * Save multiple files preserving folder structure via showDirectoryPicker.
 * If the API is unavailable, falls back to individual download per file.
 */
export async function saveFilesToDirectory(
  files: { name: string; blob: Blob; relativePath: string }[]
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
    for (const f of files) {
      // Create subdirectories if needed for relativePath.
      const parts = f.relativePath.split('/').filter(Boolean)
      let currentDir = dirHandle
      // Navigate/create subdirectories (all parts except the last = filename).
      for (let i = 0; i < parts.length - 1; i++) {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
      }
      const fileName = parts[parts.length - 1] || f.name
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
