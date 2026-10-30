// v5-f19: Speedrun ghosts + leaderboard — the client side.
//
// "Race mode" turns the v4 intro demo into a REAL timed run: a fixed 2 MiB
// file is sent through the normal transfer path; the timer runs from the
// moment the receiver ACCEPTS (TRANSFERRING entry) to verified COMPLETE.
// A "ghost" is the recorded progress timeline of the best run — rendered as
// a second progress marker so you race your own past self. Opt-in global
// leaderboard shares alias + time ONLY (never content) via the signaling
// server's in-memory store.

'use client'

import type { TransferState } from './protocol'

/** Fixed payload size so leaderboard times are comparable across devices. */
export const SPEEDRUN_BYTES = 2 * 1024 * 1024
export const SPEEDRUN_FILE_NAME = 'fluxdrop-speedrun-2mib.bin'

/** Progress sampling cadence for ghost timelines (ms). */
export const GHOST_SAMPLE_MS = 250

export interface GhostTimeline {
  /** Total run time in ms (accept → verified complete). */
  totalMs: number
  /** Bytes moved (SPEEDRUN_BYTES for comparable runs). */
  sizeBytes: number
  /** Progress % (0-100, one decimal space ×10 int) at each GHOST_SAMPLE_MS tick. */
  samples: number[]
  /** Epoch ms of when the run was recorded. */
  at: number
}

const BEST_KEY = 'fluxdrop:speedrun-best'

/** Deterministically-named random 2 MiB file for a comparable run. */
export function makeSpeedrunFile(): File {
  const chunks: BlobPart[] = []
  const block = new Uint8Array(64 * 1024)
  let remaining = SPEEDRUN_BYTES
  // crypto.getRandomValues caps at 65536 bytes per call — loop per 64 KiB block.
  while (remaining > 0) {
    crypto.getRandomValues(block)
    const take = Math.min(block.length, remaining)
    chunks.push(take === block.length ? block.slice(0) : block.slice(0, take))
    remaining -= take
  }
  return new File(chunks, SPEEDRUN_FILE_NAME, { type: 'application/octet-stream' })
}

export function loadOwnBest(): GhostTimeline | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(BEST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GhostTimeline
    if (typeof parsed?.totalMs !== 'number' || !Array.isArray(parsed?.samples)) return null
    return parsed
  } catch {
    return null
  }
}

export function saveOwnBest(t: GhostTimeline): boolean {
  if (typeof window === 'undefined') return false
  const prev = loadOwnBest()
  if (prev && prev.totalMs <= t.totalMs) return false
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(t))
    return true
  } catch {
    return false
  }
}

/** Progress (0-100) a ghost had reached at `elapsedMs` into its run. */
export function ghostProgressAt(ghost: GhostTimeline, elapsedMs: number): number {
  if (elapsedMs >= ghost.totalMs) return 100
  const idx = Math.floor(elapsedMs / GHOST_SAMPLE_MS)
  if (idx < ghost.samples.length) return ghost.samples[idx] / 10
  // Past recorded samples but before totalMs — hold the last sample.
  return (ghost.samples[ghost.samples.length - 1] ?? 0) / 10
}

export function formatRunTime(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

// ── Run recorder: samples the transfer store while TRANSFERRING ──

export class SpeedrunRecorder {
  private samples: number[] = []
  private startedAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private stageMarks: Record<string, number> = {}
  private sizeBytes = 0

  /** Begin sampling — call exactly when the run's TRANSFERRING state starts. */
  start(getProgressPct: () => number, sizeBytes: number): void {
    this.stop()
    this.samples = []
    this.stageMarks = {}
    this.sizeBytes = sizeBytes
    this.startedAt = Date.now()
    this.timer = setInterval(() => {
      this.samples.push(Math.max(0, Math.min(1000, Math.round(getProgressPct() * 10))))
    }, GHOST_SAMPLE_MS)
  }

  /** Optional stage marker (e.g. first chunk received). */
  mark(stage: string): void {
    if (!this.stageMarks[stage]) this.stageMarks[stage] = Date.now() - this.startedAt
  }

  /** Finish — returns the recorded timeline (empty if never started). */
  finish(): GhostTimeline | null {
    if (!this.startedAt) return null
    this.stop()
    return {
      totalMs: Date.now() - this.startedAt,
      sizeBytes: this.sizeBytes,
      samples: this.samples,
      at: Date.now(),
    }
  }

  get elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0
  }

  get running(): boolean {
    return this.timer !== null
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

/** The states a race run moves through (mirrors the transfer machine). */
export type RacePhase = 'idle' | 'arming' | 'pairing' | 'live' | 'done' | 'failed'

export function racePhaseFromTransferState(s: TransferState, started: boolean): RacePhase {
  if (!started) return 'idle'
  switch (s) {
    case 'PAIRING':
    case 'CONNECTING':
    case 'RETRYING':
      return 'pairing'
    case 'MANIFEST_EXCHANGE':
    case 'TRANSFERRING':
    case 'PAUSED':
    case 'RESUMING':
      return 'live'
    case 'VERIFYING':
    case 'COMPLETE':
      return 'done'
    case 'CANCELLED':
    case 'FAILED':
    case 'ERROR':
      return 'failed'
    default:
      return 'arming'
  }
}
