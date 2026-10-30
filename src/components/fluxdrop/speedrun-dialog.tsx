'use client'

// v4 (5.6) + v5-f19: the speedrun dialog.
//
// v4 shipped the simulated first-run demo (3-stage animation) — unchanged.
// v5-f19 adds RACE MODE on top: a real timed 2 MiB transfer through the
// normal pipeline, timed from the receiver's ACCEPT to verified COMPLETE,
// raced against a recorded GHOST (your best run's progress timeline) with an
// OPT-IN global leaderboard on the signaling server (alias + time only —
// never content). The ghost bar renders your past self; the leaderboard is
// the world's.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { CheckCircle2, FileCheck2, Ghost, Loader2, PlayCircle, Radio, SkipForward, Timer, Trophy, Zap } from 'lucide-react'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { useT } from '@/lib/fluxdrop/i18n'
import {
  SPEEDRUN_BYTES,
  SpeedrunRecorder,
  formatRunTime,
  ghostProgressAt,
  loadOwnBest,
  makeSpeedrunFile,
  racePhaseFromTransferState,
  saveOwnBest,
  type GhostTimeline,
} from '@/lib/fluxdrop/speedrun'

type Stage = 'idle' | 'hashing' | 'pairing' | 'transferring' | 'done'

const STAGES: Array<{ id: Stage; label: string; icon: typeof Zap }> = [
  { id: 'hashing', label: 'SHA-256 hashing', icon: FileCheck2 },
  { id: 'pairing', label: 'Room + PIN pairing', icon: Radio },
  { id: 'transferring', label: 'P2P streaming', icon: Zap },
]

export interface LeaderboardEntryView {
  rank: number
  alias: string
  timeMs: number
  sizeBytes: number
  at: number
}

export function SpeedrunDialog() {
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [pct, setPct] = useState(0)
  const speedrunDone = usePrefsStore((s) => s.speedrunDone)
  const setSpeedrunDone = usePrefsStore((s) => s.setSpeedrunDone)
  const t = useT()
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])

  // ── v5-f19: race mode state ──
  const transferState = useTransferStore((s) => s.transferState)
  const manifest = useTransferStore((s) => s.manifest)
  const checksumVerified = useTransferStore((s) => s.checksumVerified)
  const bytesTransferred = useTransferStore((s) => s.bytesTransferred)
  const totalBytes = useTransferStore((s) => s.totalBytes)
  const alias = useSessionStore((s) => s.alias)
  const optIn = usePrefsStore((s) => s.speedrunLeaderboardOptIn)
  const setOptIn = usePrefsStore((s) => s.setSpeedrunLeaderboardOptIn)

  const [raceStarted, setRaceStarted] = useState(false)
  const [raceElapsed, setRaceElapsed] = useState(0)
  const [raceProgress, setRaceProgress] = useState(0)
  const [ghost, setGhost] = useState<GhostTimeline | null>(null)
  const [result, setResult] = useState<{ timeMs: number; pr: boolean; mbps: number; ghostTimeMs: number | null } | null>(null)
  const [board, setBoard] = useState<{ entries: LeaderboardEntryView[]; total: number } | null>(null)
  const [boardLoading, setBoardLoading] = useState(false)
  const [submitRank, setSubmitRank] = useState<number | null>(null)
  const recorderRef = useRef<SpeedrunRecorder | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const racePhase = racePhaseFromTransferState(transferState, raceStarted)

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) clearTimeout(id)
    timersRef.current = []
  }, [])

  // First visit: show after a short beat (let the landing paint first).
  // NEVER auto-opens when a real task is in flight — a deep-link join (#join=)
  // or an incoming transfer consent must never be covered by this demo modal.
  useEffect(() => {
    if (speedrunDone) return
    if (typeof window !== 'undefined') {
      if (window.location.hash.includes('join=')) return
      if (useSessionStore.getState().pendingManifest) return
    }
    const id = setTimeout(() => setOpen(true), 900)
    return () => clearTimeout(id)
  }, [speedrunDone])

  // External openers (command palette / settings).
  const reset = useCallback(() => {
    clearTimers()
    setStage('idle')
    setPct(0)
  }, [clearTimers])

  // ── v5-f19: race lifecycle, driven by the REAL transfer state machine ──

  const fetchBoard = useCallback(() => {
    setBoardLoading(true)
    window.dispatchEvent(new CustomEvent('fluxdrop:leaderboard-fetch'))
  }, [])

  useEffect(() => {
    const onOpen = () => {
      reset()
      setOpen(true)
      setGhost(loadOwnBest())
      if (usePrefsStore.getState().speedrunLeaderboardOptIn) fetchBoard()
    }
    window.addEventListener('fluxdrop:open-speedrun', onOpen)
    return () => window.removeEventListener('fluxdrop:open-speedrun', onOpen)
     
  }, [reset])

  const finish = useCallback(() => {
    clearTimers()
    setSpeedrunDone()
  }, [clearTimers, setSpeedrunDone])

  const run = useCallback(() => {
    clearTimers()
    setPct(0)

    // Stage 1: hashing (0 → 100 over ~1.6s)
    setStage('hashing')
    const hashTick = setInterval(() => {
      setPct((p) => Math.min(100, p + 7 + Math.random() * 9))
    }, 90)
    timersRef.current.push(hashTick as unknown as ReturnType<typeof setTimeout>)

    // Stage 2: pairing (~1.4s)
    timersRef.current.push(
      setTimeout(() => {
        clearInterval(hashTick)
        setPct(0)
        setStage('pairing')
      }, 1700)
    )

    // Stage 3: transferring (0 → 100 over ~2.8s with realistic jitter)
    timersRef.current.push(
      setTimeout(() => {
        setPct(0)
        setStage('transferring')
        const txTick = setInterval(() => {
          setPct((p) => {
            const next = Math.min(100, p + 4 + Math.random() * 6)
            if (next >= 100) clearInterval(txTick)
            return next
          })
        }, 110)
        timersRef.current.push(txTick as unknown as ReturnType<typeof setTimeout>)
      }, 3100)
    )

    // Done
    timersRef.current.push(
      setTimeout(() => {
        setStage('done')
        setSpeedrunDone()
      }, 6300)
    )
  }, [clearTimers, setSpeedrunDone])

  useEffect(() => {
    const onData = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { entries?: LeaderboardEntryView[]; total?: number; rank?: number } | undefined
      if (!d) return
      setBoardLoading(false)
      if (d.rank != null) setSubmitRank(d.rank)
      if (Array.isArray(d.entries)) setBoard({ entries: d.entries, total: d.total ?? d.entries.length })
    }
    window.addEventListener('fluxdrop:leaderboard-data', onData)
    return () => window.removeEventListener('fluxdrop:leaderboard-data', onData)
  }, [])

  // Timer starts when the receiver ACCEPTS (transfer enters TRANSFERRING).
  useEffect(() => {
    if (!raceStarted) return
    if (transferState === 'TRANSFERRING' && !recorderRef.current?.running) {
      const rec = new SpeedrunRecorder()
      recorderRef.current = rec
      rec.start(
        () => (useTransferStore.getState().totalBytes > 0
          ? (useTransferStore.getState().bytesTransferred / useTransferStore.getState().totalBytes) * 100
          : 0),
        manifest?.totalSize ?? SPEEDRUN_BYTES
      )
      tickRef.current = setInterval(() => {
        setRaceElapsed(rec.elapsedMs)
        setRaceProgress(
          useTransferStore.getState().totalBytes > 0
            ? (useTransferStore.getState().bytesTransferred / useTransferStore.getState().totalBytes) * 100
            : 0
        )
      }, 100)
    }
     
  }, [transferState, raceStarted])

  // Completion: verified COMPLETE while racing → record, save PR, submit.
  useEffect(() => {
    if (!raceStarted || transferState !== 'COMPLETE' || result) return
    const rec = recorderRef.current
    const timeline = rec?.finish() ?? null
    if (tickRef.current) clearInterval(tickRef.current)
    const timeMs = timeline?.totalMs ?? 0
    const sizeBytes = timeline?.sizeBytes ?? manifest?.totalSize ?? SPEEDRUN_BYTES
    const pr = timeline ? saveOwnBest(timeline) : false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pr && timeline) setGhost(timeline)
    const mbps = timeMs > 0 ? (sizeBytes * 8) / (timeMs / 1000) / 1e6 : 0
    setResult({ timeMs, pr, mbps, ghostTimeMs: ghost?.totalMs ?? null })
    if (usePrefsStore.getState().speedrunLeaderboardOptIn && timeline) {
      window.dispatchEvent(
        new CustomEvent('fluxdrop:leaderboard-submit', {
          detail: {
            alias: (alias || 'racer').slice(0, 24),
            timeMs,
            sizeBytes,
            timeline: timeline.samples,
          },
        })
      )
    }
     
  }, [transferState])

  // Failure/cancel while racing → back to idle with an honest message.
  useEffect(() => {
    if (!raceStarted || result) return
    if (transferState === 'CANCELLED' || transferState === 'FAILED' || transferState === 'ERROR') {
      recorderRef.current?.stop()
      if (tickRef.current) clearInterval(tickRef.current)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRaceStarted(false)
      setResult(null)
    }
     
  }, [transferState])

  const startRace = useCallback(() => {
    setResult(null)
    setSubmitRank(null)
    setRaceProgress(0)
    setRaceElapsed(0)
    recorderRef.current = null
    const file = makeSpeedrunFile()
    setRaceStarted(true)
    // The orchestrator runs the REAL send pipeline with the fixed 2 MiB file.
    window.dispatchEvent(new CustomEvent('fluxdrop:start-speedrun-run', { detail: { file } }))
  }, [])

  const ghostPct = ghost ? ghostProgressAt(ghost, raceElapsed) : 0

  const close = useCallback(
    (completed: boolean) => {
      clearTimers()
      setOpen(false)
      if (completed || !speedrunDone) setSpeedrunDone()
      // The speedrun REPLACES the first-run tour (its own design note) — mark
      // the tour as seen so the two first-run modals never stack.
      try { localStorage.setItem('fluxdrop:onboarding-completed', '1') } catch { /* ignore */ }
      setTimeout(reset, 350)
    },
    [clearTimers, reset, setSpeedrunDone, speedrunDone]
  )

  const activeIndex = STAGES.findIndex((s) => s.id === stage)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close(false)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlayCircle className="h-5 w-5 text-flux-600 dark:text-flux-400" aria-hidden />
            {t('speedrun.title', 'Try FluxDrop in 10 seconds')}
          </DialogTitle>
          <DialogDescription>
            {t('speedrun.desc', 'Watch a simulated transfer — the real thing works exactly like this.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2" aria-live="polite">
          {/* Stage list (simulated demo) */}
          <ol className="space-y-2">
            {STAGES.map((s, i) => {
              const state =
                stage === 'done' || (activeIndex > i && activeIndex !== -1)
                  ? 'done'
                  : stage === s.id
                    ? 'active'
                    : 'pending'
              const Icon = s.icon
              return (
                <li
                  key={s.id}
                  className={`flex items-center gap-3 rounded-lg border p-2.5 transition-colors ${
                    state === 'active'
                      ? 'border-flux-500/50 bg-flux-500/10'
                      : state === 'done'
                        ? 'border-flux-500/30 bg-flux-500/5'
                        : 'border-border/50 bg-card/30'
                  }`}
                >
                  {state === 'done' ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-flux-600 dark:text-flux-400" aria-hidden />
                  ) : state === 'active' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-flux-600 dark:text-flux-400" aria-hidden />
                  ) : (
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className={`flex-1 text-sm ${state === 'pending' ? 'text-muted-foreground' : 'font-medium'}`}>
                    {s.label}
                  </span>
                  {state === 'active' && stage !== 'pairing' && (
                    <span className="text-xs tabular-nums text-flux-600 dark:text-flux-400">
                      {Math.round(pct)}%
                    </span>
                  )}
                  {state === 'active' && stage === 'pairing' && (
                    <Badge variant="outline" className="border-flux-500/40 text-[10px] text-flux-700 dark:text-flux-300">
                      ROOM 4F7KQ2 · PIN 903•••
                    </Badge>
                  )}
                </li>
              )
            })}
          </ol>

          {/* Progress bar for the active streaming stage */}
          {(stage === 'transferring' || stage === 'hashing') && (
            <div className="space-y-1.5">
              <Progress value={pct} className="h-1.5" aria-label="Demo progress" />
              <p className="text-[10px] text-muted-foreground">
                {stage === 'hashing' ? 'demo-photo.jpg · integrity tree' : 'direct WebRTC DataChannel · encrypted'}
              </p>
            </div>
          )}

          {stage === 'done' && (
            <div className="rounded-lg border border-flux-500/40 bg-flux-500/10 p-3 text-sm">
              <p className="font-medium text-flux-700 dark:text-flux-300">demo-photo.jpg received &amp; verified ✓</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                That&apos;s the whole flow — now do it for real: pick files, share the QR, done.
              </p>
            </div>
          )}

          {/* ── v5-f19: race mode ── */}
          <div className="rounded-lg border border-flux-500/30 bg-flux-500/5 p-3">
            {!raceStarted && !result && (
              <>
                <div className="flex items-center gap-2">
                  <Timer className="h-4 w-4 text-flux-600 dark:text-flux-400" aria-hidden />
                  <p className="text-sm font-medium">{t('speedrun.race', 'Race mode — 2 MiB, for real')}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('speedrun.raceDesc', 'Sends a fixed 2 MiB file through the real pipeline. Timer runs from the receiver accept to verified complete. Race your best run ghost.')}
                </p>
                <Button size="sm" className="mt-2.5 bg-flux-600 text-white hover:bg-flux-700" onClick={startRace}>
                  <Zap className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t('speedrun.raceStart', 'Start timed run')}
                </Button>
              </>
            )}

            {(raceStarted || result) && (
              <div className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    {result ? (
                      <>
                        <Trophy className="h-4 w-4 text-flux-600 dark:text-flux-400" aria-hidden />
                        {result.pr ? t('speedrun.racePR', 'New personal best!') : t('speedrun.raceDone', 'Run complete')}
                      </>
                    ) : (
                      <>
                        <Timer className="h-4 w-4 animate-pulse text-flux-600 dark:text-flux-400" aria-hidden />
                        {racePhase === 'pairing' && t('speedrun.raceWaiting', 'Waiting for the receiver…')}
                        {racePhase === 'live' && t('speedrun.raceRacing', 'Racing…')}
                        {racePhase === 'arming' && 'Arming…'}
                      </>
                    )}
                  </p>
                  <span className="font-mono text-2xl font-bold tabular-nums text-flux-700 dark:text-flux-300">
                    {formatRunTime(result ? result.timeMs : raceElapsed)}
                  </span>
                </div>

                {/* Live progress vs ghost */}
                <div className="space-y-1.5">
                  <Progress value={result ? 100 : raceProgress} className="h-2" aria-label="Your run" />
                  {ghost && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <Ghost className="h-3 w-3" aria-hidden />
                        ghost best: {formatRunTime(ghost.totalMs)}
                      </div>
                      <Progress value={ghostPct} className="h-1 opacity-60" aria-label="Ghost run" />
                    </div>
                  )}
                </div>

                {result && (
                  <div className="rounded-md border border-border/60 bg-card/60 p-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span>
                        <span className="text-muted-foreground">effective</span>{' '}
                        <b className="tabular-nums">{result.mbps.toFixed(1)} Mbit/s</b>
                      </span>
                      {result.ghostTimeMs != null && (
                        <span>
                          <span className="text-muted-foreground">vs ghost</span>{' '}
                          <b className={`tabular-nums ${result.timeMs <= result.ghostTimeMs ? 'text-flux-600 dark:text-flux-400' : 'text-amber-600 dark:text-amber-400'}`}>
                            {result.timeMs <= result.ghostTimeMs ? '−' : '+'}
                            {formatRunTime(Math.abs(result.timeMs - result.ghostTimeMs))}
                          </b>
                        </span>
                      )}
                      {checksumVerified === false && <span className="text-destructive">checksum NOT verified</span>}
                    </div>
                    {submitRank != null && (
                      <p className="mt-1.5 flex items-center gap-1 text-flux-700 dark:text-flux-300">
                        <Trophy className="h-3 w-3" aria-hidden />
                        Submitted — world rank #{submitRank}
                      </p>
                    )}
                    <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={startRace}>
                      {t('speedrun.raceAgain', 'Race again')}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Opt-in + leaderboard */}
            <div className="mt-3 border-t border-border/50 pt-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    <Trophy className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    {t('speedrun.lb', 'Global leaderboard (opt-in)')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {t('speedrun.lbDesc', 'Shares your alias + time only — never file names or content.')}
                  </p>
                </div>
                <Switch checked={optIn} onCheckedChange={(v) => { setOptIn(v); if (v) fetchBoard() }} aria-label="Leaderboard opt-in" />
              </div>
              {optIn && (
                <div className="mt-2 space-y-1">
                  {boardLoading && !board && <p className="text-[10px] text-muted-foreground">loading…</p>}
                  {board?.entries.map((e) => (
                    <div
                      key={`${e.rank}-${e.at}`}
                      className="flex items-center justify-between rounded-md px-2 py-1 text-[11px] odd:bg-muted/40"
                    >
                      <span className="flex items-center gap-2">
                        <span className={`w-5 font-mono font-bold ${e.rank === 1 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                          {e.rank}
                        </span>
                        <span className="max-w-[140px] truncate">{e.alias}</span>
                      </span>
                      <span className="font-mono tabular-nums">{formatRunTime(e.timeMs)}</span>
                    </div>
                  ))}
                  {board && board.entries.length === 0 && (
                    <p className="text-[10px] text-muted-foreground">no runs yet — set the first time!</p>
                  )}
                  {submitRank != null && !result && (
                    <p className="flex items-center gap-1 text-[10px] font-medium text-flux-700 dark:text-flux-300">
                      <Trophy className="h-3 w-3" aria-hidden />
                      Submitted — world rank #{submitRank}
                    </p>
                  )}
                  <p className="text-[9px] text-muted-foreground">
                    as “{alias.slice(0, 24)}” · {board?.total ?? 0} total runs
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => close(false)}>
              <SkipForward className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('speedrun.skip', 'Skip')}
            </Button>
            {stage === 'idle' && !raceStarted && (
              <Button size="sm" onClick={run} className="bg-flux-600 text-white hover:bg-flux-700 dark:text-white">
                <PlayCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('speedrun.start', 'Start demo')}
              </Button>
            )}
            {stage !== 'idle' && stage !== 'done' && !raceStarted && (
              <Button size="sm" variant="outline" disabled>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                Running…
              </Button>
            )}
            {(stage === 'done' || raceStarted) && !result && (
              <Button size="sm" variant="outline" onClick={() => close(true)}>
                {t('common.done', 'Done')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
