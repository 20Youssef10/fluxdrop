'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { Gauge, Timer, Hash, CheckCircle2, AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTransferStore } from '@/stores/transfer-store'
import { formatBytes, formatSpeed, formatEta, formatDuration } from '@/lib/fluxdrop/format'
import { FileIcon } from './file-icon'

interface TransferProgressProps {
  onCancel: () => void
  onDone: () => void
}

export function TransferProgress({ onCancel, onDone }: TransferProgressProps) {
  const t = useTransferStore()
  const pct = t.totalBytes > 0 ? (t.bytesTransferred / t.totalBytes) * 100 : 0
  const remaining = Math.max(0, t.totalBytes - t.bytesTransferred)
  const isComplete = t.transferState === 'COMPLETE'
  const isError = t.transferState === 'FAILED' || t.transferState === 'ERROR'
  const isCancelled = t.transferState === 'CANCELLED'

  return (
    <div className="space-y-4">
      {/* Big progress card */}
      <Card className="flux-glass p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold">
                {isComplete ? 'Transfer complete' : isError ? 'Transfer failed' : isCancelled ? 'Transfer cancelled' : 'Transferring…'}
              </h3>
              {isComplete && t.checksumVerified && (
                <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
                  <ShieldCheck className="mr-1 h-3 w-3" />
                  Verified
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {t.manifest?.files.length ?? 0} file{(t.manifest?.files.length ?? 0) !== 1 ? 's' : ''} ·{' '}
              {formatBytes(t.totalBytes)} total
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-3xl font-bold tabular-nums">{pct.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">
              {formatBytes(t.bytesTransferred)} / {formatBytes(t.totalBytes)}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-5 relative">
          <Progress
            value={pct}
            className="h-3 bg-muted overflow-hidden"
          />
          {!isComplete && !isError && !isCancelled && pct > 0 && (
            <div className="absolute inset-0 flux-shimmer rounded-full pointer-events-none" />
          )}
        </div>

        {/* Stats grid */}
        <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={<Gauge className="h-4 w-4" />} label="Speed" value={formatSpeed(t.speedBps)} />
          <StatCard icon={<Timer className="h-4 w-4" />} label="ETA" value={formatEta(remaining, t.speedBps)} />
          <StatCard icon={<Hash className="h-4 w-4" />} label="Chunks" value={`${t.chunksAcked} / ${t.totalChunks}`} />
          <StatCard icon={<Timer className="h-4 w-4" />} label="Elapsed" value={formatDuration(t.elapsedMs)} />
        </div>

        {/* Chunk grid visualizer */}
        {t.totalChunks > 0 && t.totalChunks <= 400 && (
          <ChunkGrid total={t.totalChunks} acked={t.chunksAcked} complete={isComplete} />
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-2">
          {isComplete || isError || isCancelled ? (
            <Button onClick={onDone} className="bg-flux-600 hover:bg-flux-700 text-white">
              Done
            </Button>
          ) : (
            <Button variant="outline" onClick={onCancel} className="text-destructive hover:bg-destructive/5">
              Cancel transfer
            </Button>
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
              return (
                <div key={f.index} className="rounded-lg border border-border/50 bg-card/60 p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <FileIcon mime={f.entry.type} name={f.entry.name} className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">{f.entry.name}</p>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatBytes(f.receivedBytes)} / {formatBytes(f.entry.size)}
                        </span>
                      </div>
                      <Progress value={filePct} className="h-1.5 mt-1.5" />
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
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
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

function ChunkGrid({ total, acked, complete }: { total: number; acked: number; complete: boolean }) {
  // Render a grid of small cells; the most recent cells flash.
  const cols = total > 200 ? 40 : total > 100 ? 32 : total > 50 ? 24 : 16
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Chunk map
        </span>
        <span className="text-[10px] text-muted-foreground">
          {acked} / {total} ACK'd
        </span>
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }).map((_, i) => {
          const done = i < acked
          return (
            <div
              key={i}
              className={`aspect-square rounded-sm transition-colors ${
                complete
                  ? 'bg-flux-500/70'
                  : done
                  ? 'bg-flux-500/60 flux-cell-flash'
                  : 'bg-muted/60'
              }`}
              style={{ animationDelay: done && !complete ? `${(i % 8) * 30}ms` : undefined }}
            />
          )
        })}
      </div>
    </div>
  )
}
