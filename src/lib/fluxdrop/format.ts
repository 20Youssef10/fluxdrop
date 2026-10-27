// Formatting & validation helpers for FluxDrop.

import { CONSTANTS } from './protocol'

// --- File size ---
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes < 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / Math.pow(1024, i)
  const d = i === 0 ? 0 : decimals
  return `${value.toFixed(d)} ${UNITS[i]}`
}

// --- Speed (bytes/sec) ---
export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec < 0) return '0 B/s'
  return `${formatBytes(bytesPerSec)}/s`
}

// --- Duration ---
export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// --- ETA ---
export function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '—'
  return formatDuration((remainingBytes / bytesPerSec) * 1000)
}

// --- Percentage ---
export function formatPercent(value: number, total: number, decimals = 0): string {
  if (!total) return '0%'
  return `${((value / total) * 100).toFixed(decimals)}%`
}

// --- Device alias generation ---
const ADJECTIVES = [
  'Swift', 'Brave', 'Calm', 'Eager', 'Frost', 'Gentle', 'Hidden', 'Jolly',
  'Keen', 'Lucky', 'Mighty', 'Noble', 'Proud', 'Quiet', 'Rapid', 'Steady',
  'Tranquil', 'Valiant', 'Wise', 'Zesty', 'Amber', 'Cobalt', 'Crimson', 'Emerald',
]
const NOUNS = [
  'Falcon', 'Otter', 'Lynx', 'Heron', 'Panda', 'Fox', 'Wolf', 'Hawk',
  'Raven', 'Stag', 'Bear', 'Cat', 'Dove', 'Seal', 'Koala', 'Owl',
  'Pixel', 'Comet', 'Nova', 'Quartz', 'Echo', 'Drift', 'Spark', 'Tide',
]

export function generateDeviceAlias(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  const num = Math.floor(Math.random() * 90 + 10)
  return `${adj}${noun}-${num}`
}

// --- File type detection / icon hint ---
export function fileTypeCategory(mime: string, name: string): 'image' | 'video' | 'audio' | 'document' | 'archive' | 'code' | 'other' {
  const lower = name.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (/\.(pdf|doc|docx|txt|md|rtf|odt|xls|xlsx|ppt|pptx|csv)$/.test(lower)) return 'document'
  if (/\.(zip|rar|7z|tar|gz|bz2)$/.test(lower)) return 'archive'
  if (/\.(js|ts|tsx|jsx|py|go|rs|java|c|cpp|rb|php|sh|json|yaml|xml|html|css)$/.test(lower)) return 'code'
  return 'other'
}

// --- Validation ---
export interface ValidationResult {
  ok: boolean
  errors: string[]
}

export function validateFiles(files: File[]): ValidationResult {
  const errors: string[] = []
  if (files.length === 0) {
    errors.push('No files selected')
    return { ok: false, errors }
  }
  if (files.length > CONSTANTS.MAX_FILES_PER_TRANSFER) {
    errors.push(`Too many files (max ${CONSTANTS.MAX_FILES_PER_TRANSFER})`)
  }
  let total = 0
  for (const f of files) {
    total += f.size
    if (f.size > CONSTANTS.MAX_FILE_SIZE) {
      errors.push(`"${f.name}" exceeds max file size (${CONSTANTS.MAX_FILE_SIZE / 1e9} GB)`)
    }
    if (f.name.length > CONSTANTS.MAX_FILE_NAME_LENGTH) {
      errors.push(`Filename too long: "${f.name.slice(0, 20)}..."`)
    }
    const ext = '.' + (f.name.split('.').pop() || '').toLowerCase()
    if ((CONSTANTS.BLOCKED_EXTENSIONS as readonly string[]).includes(ext)) {
      errors.push(`Blocked file type: "${f.name}" (${ext})`)
    }
  }
  if (total > CONSTANTS.MAX_FILE_SIZE) {
    errors.push(`Total transfer size exceeds limit (${CONSTANTS.MAX_FILE_SIZE / 1e9} GB)`)
  }
  return { ok: errors.length === 0, errors }
}

// --- Chunk math ---
export function computeTotalChunks(totalSize: number, chunkSize: number = CONSTANTS.CHUNK_SIZE): number {
  if (totalSize <= 0) return 0
  return Math.ceil(totalSize / chunkSize)
}

// --- Copy to clipboard ---
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// --- Short hex for display ---
export function shortId(id: string, len = 8): string {
  return id.replace(/-/g, '').slice(0, len).toUpperCase()
}
