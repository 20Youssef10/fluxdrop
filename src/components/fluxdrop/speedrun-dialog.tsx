'use client'

// v4 (5.6): first-run speedrun — an interactive "try it now" sandbox that
// replaces the 7-step tour for FIRST visits. A simulated 3-stage mini
// transfer (hash → pair → stream) with real progress UI and a completion
// state, so the user experiences the shape of a transfer in ~10 seconds
// without a second device. Shown once (localStorage flag), re-runnable from
// the command palette and Settings.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, FileCheck2, Loader2, PlayCircle, Radio, SkipForward, Zap } from 'lucide-react'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'
import { useSessionStore } from '@/stores/session-store'
import { useT } from '@/lib/fluxdrop/i18n'

type Stage = 'idle' | 'hashing' | 'pairing' | 'transferring' | 'done'

const STAGES: Array<{ id: Stage; label: string; icon: typeof Zap }> = [
  { id: 'hashing', label: 'SHA-256 hashing', icon: FileCheck2 },
  { id: 'pairing', label: 'Room + PIN pairing', icon: Radio },
  { id: 'transferring', label: 'P2P streaming', icon: Zap },
]

export function SpeedrunDialog() {
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [pct, setPct] = useState(0)
  const speedrunDone = usePrefsStore((s) => s.speedrunDone)
  const setSpeedrunDone = usePrefsStore((s) => s.setSpeedrunDone)
  const t = useT()
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) clearTimeout(id)
    timersRef.current = []
  }, [])

  // First visit: show after a short beat (let the landing paint first).
  // NEVER auto-opens when a real task is in flight — a deep-link join (#join=)
  // or an incoming transfer consent must never be covered by this demo modal
  // (a Radix modal puts pointer-events:none on <body>, which freezes every
  // non-Radix overlay behind it, including the consent dialog).
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

  useEffect(() => {
    const onOpen = () => {
      reset()
      setOpen(true)
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

  const close = useCallback(
    (completed: boolean) => {
      clearTimers()
      setOpen(false)
      if (completed || !speedrunDone) setSpeedrunDone()
      // The speedrun REPLACES the first-run tour (its own design note) — mark
      // the tour as seen so the two first-run modals never stack. Stacking
      // them used to freeze the tour: the Radix modal sets
      // body{pointer-events:none} and the tour's buttons stopped responding.
      try { localStorage.setItem('fluxdrop:onboarding-completed', '1') } catch { /* ignore */ }
      setTimeout(reset, 350)
    },
    [clearTimers, reset, setSpeedrunDone, speedrunDone]
  )

  const activeIndex = STAGES.findIndex((s) => s.id === stage)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close(false)}>
      <DialogContent className="sm:max-w-md">
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
          {/* Stage list */}
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

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => close(false)}>
              <SkipForward className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('speedrun.skip', 'Skip')}
            </Button>
            {stage === 'idle' && (
              <Button size="sm" onClick={run} className="bg-flux-600 text-white hover:bg-flux-700 dark:text-white">
                <PlayCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('speedrun.start', 'Start demo')}
              </Button>
            )}
            {stage !== 'idle' && stage !== 'done' && (
              <Button size="sm" variant="outline" disabled>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                Running…
              </Button>
            )}
            {stage === 'done' && (
              <Button size="sm" onClick={() => close(true)} className="bg-flux-600 text-white hover:bg-flux-700 dark:text-white">
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('common.done', 'Done')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
