// File I/O: assembly of received chunks into a downloadable Blob,
// plus File System Access API integration when available.

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

export async function saveBlobWithPicker(blob: Blob, suggestedName: string): Promise<'saved' | 'fallback' | 'cancelled'> {
  // Try File System Access API
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
      // fall through to fallback
    }
  }
  triggerDownload(blob, suggestedName)
  return 'fallback'
}

export function isFileSystemAccessSupported(): boolean {
  return typeof (window as any).showSaveFilePicker === 'function'
}
