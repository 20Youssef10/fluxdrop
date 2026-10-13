'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { Gauge, Timer, Hash, CheckCircle2, AlertTriangle, Loader2, ShieldCheck, TrendingUp, Pause, Play, RotateCcw, SkipForward, Leaf } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTransferStore } from '@/stores/transfer-store'
import { formatBytes, formatSpeed, formatEta, formatDuration } from '@/lib/fluxdrop/format'
import { buildSlicePlan } from '@/lib/fluxdrop/manifest'
import { FileIcon, getFileCategoryColors } from './file-icon'
import { AnimatedNumber } from './animated-number'
import { SpeedSparkline } from './speed-sparkline'
import { Celebration } from './celebration'
import { ConnectionViz } from './connection-viz'
import { TransferSummaryCard } from './transfer-summary-card'
import { ErrorLogPanel } from './error-log-panel'
import { useState, useEffect, useRef, useMemo, memo } from 'react'

interface TransferProgressProps {
  onCancel: () => void
  onDone: () => void
  onPause?: () => void
  onResume?: () => void
}

export function TransferProgress({ onCancel, onDone, onPause, onResume }: TransferProgressProps) {
  const t = useTransferStore()
  const pct = t.totalBytes > 0 ? Math.min(100, (t.bytesTransferred / t.totalBytes) * 100) : 0
  const remaining = Math.max(0, t.totalBytes - t.bytesTransferred)
  const isComplete = t.transferState === 'COMPLETE'
  const isError = t.transferState === 'FAILED' || t.transferState === 'ERROR'
  const isCancelled = t.transferState === 'CANCELLED'
  const isTransferring = t.transferState === 'TRANSFERRING'
  const isPaused = t.transferState === 'PAUSED'

  // Trigger celebration exactly once when transfer completes
  const [celebrate, setCelebrate] = useState(false)
  const celebratedRef = useRef(false)
  useEffect(() => {
    if (isComplete && !celebratedRef.current) {
      celebratedRef.current = true
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCelebrate(true)
    }
  }, [isComplete])

  // Milestone pulse: flash the 25/50/75/90% marker when the progress bar
  // crosses it upward. Purely decorative feedback that the transfer is moving.
  const [milestone, setMilestone] = useState<number | null>(null)
  const prevPctRef = useRef(0)
  useEffect(() => {
    const prev = prevPctRef.current
    prevPctRef.current = pct
    if (!isTransferring || pct <= prev) return
    const crossed = [25, 50, 75, 90].find((m) => prev < m && pct >= m)
    if (!crossed) return
    const show = setTimeout(() => setMilestone(crossed), 0)
    const hide = setTimeout(() => setMilestone(null), 1100)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
    }
  }, [pct, isTransferring])

  // Per-file skip breakdown (resumed transfers): map the global skip bitmap
  // onto each file's byte range so the FILES card can visualize which portion
  // of each file was already on this device (never travelled the wire).
  const fileSkips = useMemo(() => {
    const out = new Map<number, { skippedBytes: number; skippedChunks: number; totalChunks: number }>()
    const m = t.manifest
    if (!m || t.skippedIndices.size === 0) return out
    const plan = buildSlicePlan(m)
    for (const seg of plan) {
      const startChunk = Math.floor(seg.startByte / m.chunkSize)
      const endChunk = Math.floor((seg.endByte - 1) / m.chunkSize)
      let skippedBytes = 0
      let skippedChunks = 0
      for (let c = startChunk; c <= endChunk; c++) {
        if (!t.skippedIndices.has(c)) continue
        skippedChunks++
        const overlapStart = Math.max(seg.startByte, c * m.chunkSize)
        const overlapEnd = Math.min(seg.endByte, (c + 1) * m.chunkSize)
        skippedBytes += Math.max(0, overlapEnd - overlapStart)
      }
      out.set(seg.fileIndex, { skippedBytes, skippedChunks, totalChunks: endChunk - startChunk + 1 })
    }
    return out
  }, [t.manifest, t.skippedIndices])

  return (
    <div className="space-y-4">
      <Celebration trigger={celebrate} onComplete={() => setCelebrate(false)} />

      {/* Connection viz strip */}
      <Card className="flux-glass px-5 py-3">
        <ConnectionViz />
      </Card>

      {/* Summary card when complete (replaces progress card) */}
      {isComplete ? (
        <TransferSummaryCard onDone={onDone} onSendAnother={onDone} />
      ) : (
      /* Big progress card */
      <>
      <Card className="flux-glass p-6 relative overflow-hidden">
        {/* Decorative glow when transferring */}
        {isTransferring && (
          <div className="pointer-events-none absolute -top-20 left-1/2 -translate-x-1/2 h-40 w-80 rounded-full bg-flux-500/10 blur-3xl" />
        )}
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold">
                {isComplete ? 'Transfer complete' : isError ? 'Transfer failed' : isCancelled ? 'Transfer cancelled' : isPaused ? 'Paused' : 'Transferring…'}
              </h3>
              {isComplete && t.checksumVerified && (
                <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
                  <ShieldCheck className="mr-1 h-3 w-3" />
                  Verified
                </Badge>
              )}
              {isPaused && (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Pause className="mr-1 h-3 w-3" />
                  Paused
                </Badge>
              )}
              {t.skippedChunks > 0 && !isComplete && (
                <Badge
                  variant="outline"
                  className="border-flux-500/40 bg-flux-500/10 text-flux-600 dark:text-flux-400"
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  Resumed · {formatBytes(t.skippedBytes)} saved
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {t.manifest?.files.length ?? 0} file{(t.manifest?.files.length ?? 0) !== 1 ? 's' : ''} ·{' '}
              {formatBytes(t.totalBytes)} total
            </p>
          </div>
          <div className="text-right shrink-0">
            <AnimatedNumber
              value={pct}
              format={(n) => `${n.toFixed(1)}%`}
              className="text-3xl font-bold tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              {formatBytes(t.bytesTransferred)} / {formatBytes(t.totalBytes)}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-5 relative">
          <Progress
            value={pct}
            className="h-3 bg-muted overflow-hidden [&>div]:bg-gradient-to-r [&>div]:from-flux-400 [&>div]:via-flux-500 [&>div]:to-flux-600 [&>div]:shadow-[0_0_12px_rgba(16,185,129,0.35)] [&>div]:transition-[width,background-color] [&>div]:duration-300"
          />
          {!isComplete && !isError && !isCancelled && pct > 0 && (
            <div className="absolute inset-0 flux-shimmer rounded-full pointer-events-none" />
          )}
          {/* Milestone markers at 25/50/75% — pulse when freshly crossed */}
          <div className="absolute inset-0 flex pointer-events-none">
            {[25, 50, 75].map((m) => (
              <div
                key={m}
                className={`h-full w-px transition-colors duration-500 ${
                  milestone === m ? 'bg-flux-400 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-border/60'
                }`}
                style={{ marginLeft: `${m}%` }}
              />
            ))}
          </div>
          {/* Milestone ping dot */}
          {milestone !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
              style={{ left: `${milestone}%` }}
            >
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-flux-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-flux-500 shadow shadow-flux-500/50" />
              </span>
            </div>
          )}
        </div>

        {/* Speed sparkline */}
        {isTransferring && t.speedHistory.length >= 2 && (
          <div className="mt-4 rounded-lg border border-border/50 bg-card/40 p-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                <TrendingUp className="h-3 w-3" />
                Speed history
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'oklch(0.72 0.14 200)' }} />
                  avg {formatSpeed(t.speedHistory.reduce((s, v) => s + v, 0) / t.speedHistory.length)}
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'oklch(0.78 0.16 85)' }} />
                  peak {formatSpeed(Math.max(...t.speedHistory, 0))}
                </span>
              </div>
            </div>
            <SpeedSparkline data={t.speedHistory} width={520} height={48} className="w-full h-12" />
          </div>
        )}

        {/* Stats grid */}
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            icon={<Gauge className="h-4 w-4" />}
            label="Speed"
            value={<AnimatedNumber value={t.speedBps} format={(n) => formatSpeed(n)} />}
          />
          <StatCard
            icon={<Timer className="h-4 w-4" />}
            label="ETA"
            value={formatEta(remaining, t.speedBps)}
          />
          <StatCard
            icon={<Hash className="h-4 w-4" />}
            label="Chunks"
            value={
              <span>
                <AnimatedNumber value={t.chunksAcked} /> / {t.totalChunks}
              </span>
            }
          />
          <StatCard
            icon={<Timer className="h-4 w-4" />}
            label="Elapsed"
            value={formatDuration(t.elapsedMs)}
          />
        </div>

        {/* Chunk grid visualizer (up to 1000 chunks for performance) */}
        {t.totalChunks > 0 && t.totalChunks <= 1000 && (
          <ChunkGrid
            total={t.totalChunks}
            acked={t.chunksAcked}
            complete={isComplete}
            ackedSet={t.ackedSet}
            skippedSet={t.skippedIndices}
          />
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-2">
          {isComplete || isError || isCancelled ? (
            <Button onClick={onDone} className="bg-flux-600 hover:bg-flux-700 text-white">
              Done
            </Button>
          ) : (
            <>
              {isPaused ? (
                <Button
                  onClick={onResume}
                  disabled={!onResume}
                  className="bg-flux-600 hover:bg-flux-700 text-white"
                >
                  <Play className="mr-2 h-4 w-4" />
                  Resume
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={onPause}
                  disabled={!onPause || !isTransferring}
                  className="text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 border-amber-500/40"
                >
                  <Pause className="mr-2 h-4 w-4" />
                  Pause
                </Button>
              )}
              <Button variant="outline" onClick={onCancel} className="text-destructive hover:bg-destructive/5">
                Cancel transfer
              </Button>
            </>
          )}
        </div>
      </Card>

      {/* Per-file list */}
      {t.files.length > 0 && (
        <Card className="flux-glass p-5">
          <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Files
          </h4>
          <div className="max-h-64 overflow-y-auto flux-scroll space-y-2 pr-1">
            {t.files.map((f) => {
              const filePct = f.entry.size > 0 ? (f.receivedBytes / f.entry.size) * 100 : 0
              const colors = getFileCategoryColors(f.entry.type, f.entry.name)
              const skip = fileSkips.get(f.index)
              const skipPct = f.entry.size > 0 && skip ? Math.min(100, (skip.skippedBytes / f.entry.size) * 100) : 0
              return (
                <div key={f.index} className="rounded-lg border border-border/50 bg-card/60 p-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${colors.bg} ${colors.text}`}>
                      <FileIcon mime={f.entry.type} name={f.entry.name} className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">{f.entry.name}</p>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatBytes(f.receivedBytes)} / {formatBytes(f.entry.size)}
                        </span>
                      </div>
                      {/* Stacked bar on resumed transfers: the leading muted-ring
                          segment is data that was ALREADY on this device (resume
                          skip) — it never travelled the wire this session. */}
                      {skipPct > 0 ? (
                        <div className="relative h-1.5 mt-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(filePct)} aria-valuemin={0} aria-valuemax={100}>
                          <div
                            className="absolute inset-y-0 left-0 rounded-full bg-flux-500/20 ring-1 ring-inset ring-flux-500/50"
                            style={{ width: `${skipPct}%` }}
                          />
                          <div
                            className="absolute inset-y-0 rounded-full bg-flux-500 transition-all duration-300"
                            style={{ left: `${skipPct}%`, width: `${Math.max(0, Math.min(100, filePct) - skipPct)}%` }}
                          />
                        </div>
                      ) : (
                        <Progress value={filePct} className="h-1.5 mt-1.5" />
                      )}
                      {skip && skip.skippedChunks > 0 && (
                        <p className="mt-1 flex items-center gap-1 text-[10px] text-flux-600 dark:text-flux-400">
                          <Leaf className="h-2.5 w-2.5 shrink-0" aria-hidden />
                          {skip.skippedChunks} of {skip.totalChunks} chunks already on this device — never re-sent
                        </p>
                      )}
                    </div>
                    {f.complete ? (
                      <CheckCircle2 className="h-4 w-4 text-flux-500 shrink-0" />
                    ) : filePct > 0 ? (
                      <Loader2 className="h-4 w-4 text-flux-500 animate-spin shrink-0" />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Error message */}
      {t.error && (isError || isCancelled) && (
        <Card className="border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive">{t.transferState === 'CANCELLED' ? 'Transfer cancelled' : 'Transfer error'}</p>
              <p className="text-xs text-muted-foreground mt-1">{t.error}</p>
            </div>
          </div>
        </Card>
      )}
      </>
      )}

      {/* Persistent error log (doesn't disappear like toasts) */}
      <ErrorLogPanel />
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="mt-1 text-base font-semibold tabular-nums">{value}</p>
    </div>
  )
}

const ChunkGrid = memo(function ChunkGrid({
  total,
  acked,
  complete,
  ackedSet,
  skippedSet,
}: {
  total: number
  acked: number
  complete: boolean
  ackedSet: Set<number>
  skippedSet: Set<number>
}) {
  const cols = total > 200 ? 40 : total > 100 ? 32 : total > 50 ? 24 : 16
  const hasLiveBitmap = ackedSet.size > 0 || skippedSet.size > 0
  const skippedCount = skippedSet.size
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Chunk map
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {acked} / {total} ACK'd{skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}
        </span>
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }).map((_, i) => {
          // With the live bitmap, "done" means acked THIS session and "skipped"
          // means it never travelled the wire (resume skip) — visually distinct.
          // Without a bitmap (edge cases), fall back to the count heuristic.
          const done = hasLiveBitmap ? ackedSet.has(i) : i < acked
          const skipped = skippedSet.has(i)
          return (
            <div
              key={i}
              className={`aspect-square rounded-sm transition-colors ${
                complete
                  ? 'bg-flux-500/70'
                  : skipped
                  ? 'bg-flux-500/15 ring-1 ring-inset ring-flux-500/50'
                  : done
                  ? 'bg-flux-500/60 flux-cell-flash'
                  : 'bg-muted/60'
              }`}
              style={{ animationDelay: done && !complete ? `${(i % 8) * 30}ms` : undefined }}
            />
          )
        })}
      </div>
      {/* Legend — only when there is something to distinguish */}
      {skippedCount > 0 && !complete && (
        <div className="mt-2 flex items-center gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-flux-500/15 ring-1 ring-inset ring-flux-500/50" />
            <SkipForward className="h-2.5 w-2.5" aria-hidden />
            skipped (already had)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-flux-500/60" />
            streamed now
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-muted/60" />
            pending
          </span>
        </div>
      )}
    </div>
  )
})