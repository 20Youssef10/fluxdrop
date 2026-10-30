// v5-f19: Speedrun leaderboard — server side.
//
// Opt-in, fun-only store for the client's timed 2 MiB "race mode" runs.
// Entries carry alias + time + size + a compact progress timeline; the
// server keeps the top 100 by time and answers top-10 fetches. Persisted to
// data/leaderboard.json so restarts don't wipe the board.
//
// Abuse posture: submissions are rate-limited (5 / 10 min per IP), strictly
// validated + sanitized, and the whole thing is explicitly trust-based
// (client timing can't be proven — it's a fun board, not a competition with
// prizes). PRIVACY: aliases only, no content, no IPs in entries.

import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogFn = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void

export interface LeaderboardEntry {
  alias: string
  timeMs: number
  sizeBytes: number
  at: number
  /** Compact ghost timeline (progress ‰ at 250 ms cadence), ≤ 128 samples. */
  timeline?: number[]
}

const DATA_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'data')
const STORE_PATH = join(DATA_DIR, 'leaderboard.json')
const MAX_ENTRIES = 100
const SUBMIT_WINDOW_MS = 10 * 60 * 1000
const SUBMIT_MAX_PER_WINDOW = 5
const MIN_TIME_MS = 200
const MAX_TIME_MS = 10 * 60 * 1000

const entries: LeaderboardEntry[] = []
const submitsByIp = new Map<string, number[]>()
let initialized = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

export async function initLeaderboard(log: LogFn): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const raw = await readFile(STORE_PATH, 'utf8')
    const arr = JSON.parse(raw) as LeaderboardEntry[]
    if (Array.isArray(arr)) {
      for (const e of arr) if (sanitizeEntry(e)) entries.push(e)
      entries.sort((a, b) => a.timeMs - b.timeMs)
    }
  } catch {
    /* no store yet */
  }
  log('info', 'leaderboard_ready', { entries: entries.length })
}

function sanitizeEntry(e: unknown): LeaderboardEntry | null {
  if (!e || typeof e !== 'object') return null
  const o = e as Record<string, unknown>
  const aliasRaw = typeof o.alias === 'string' ? o.alias.trim().slice(0, 24) : ''
  if (!aliasRaw) return null
  // Strip anything that isn't safe display text.
  const alias = aliasRaw.replace(/[\u0000-\u001f\u007f]/g, '')
  const timeMs = Math.round(Number(o.timeMs))
  if (!Number.isFinite(timeMs) || timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS) return null
  const sizeBytes = Math.round(Number(o.sizeBytes))
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 1e9) return null
  let timeline: number[] | undefined
  if (Array.isArray(o.timeline)) {
    timeline = o.timeline
      .filter((s): s is number => Number.isFinite(s) && s >= 0 && s <= 1000)
      .slice(0, 128)
      .map((s) => Math.round(s))
  }
  return { alias, timeMs, sizeBytes, at: Date.now(), timeline }
}

function schedulePersist(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void (async () => {
      try {
        await mkdir(DATA_DIR, { recursive: true })
        await writeFile(STORE_PATH, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2))
      } catch {
        /* best-effort */
      }
    })()
  }, 2000)
}

function allowsSubmit(ip: string): boolean {
  const now = Date.now()
  const window = (submitsByIp.get(ip) ?? []).filter((t) => now - t < SUBMIT_WINDOW_MS)
  if (window.length >= SUBMIT_MAX_PER_WINDOW) {
    submitsByIp.set(ip, window)
    return false
  }
  window.push(now)
  submitsByIp.set(ip, window)
  return true
}

/** Handle `leaderboard-submit` from a socket. Returns a short ack for logs. */
export function handleLeaderboardSubmit(
  log: LogFn,
  ip: string,
  payload: unknown,
  onAccepted: (rank: number) => void,
  onError: (message: string) => void
): void {
  if (!allowsSubmit(ip)) {
    onError('too many submissions — try again later')
    return
  }
  const entry = sanitizeEntry(payload)
  if (!entry) {
    onError('invalid entry (alias 1-24 chars, timeMs 200..600000, sizeBytes > 0)')
    return
  }
  entries.push(entry)
  entries.sort((a, b) => a.timeMs - b.timeMs)
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
  schedulePersist()
  const rank = entries.findIndex((e) => e === entry) + 1
  log('info', 'leaderboard_submit', { rank, timeMs: entry.timeMs })
  onAccepted(rank)
}

/** Snapshot for `leaderboard-fetch` responses + the admin dashboard. */
export function leaderboardTop(n = 10): { entries: Array<LeaderboardEntry & { rank: number }>; total: number } {
  return {
    entries: entries.slice(0, n).map((e, i) => ({ ...e, rank: i + 1 })),
    total: entries.length,
  }
}
