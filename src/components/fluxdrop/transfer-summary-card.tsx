'use client'

import { motion } from 'framer-motion'
import { CheckCircle2, ShieldCheck, Clock, Database, FileStack, Gauge } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTransferStore } from '@/stores/transfer-store'
import { formatBytes, formatDuration } from '@/lib/fluxdrop/format'

interface TransferSummaryCardProps {
  onDone: () => void
  onSendAnother: () => void
}

/**
 * Shows a recap of the completed transfer with key stats.
 * Replaces the progress card when the transfer is COMPLETE.
 */
export function TransferSummaryCard({ onDone, onSendAnother }: TransferSummaryCardProps) {
  const t = useTransferStore()
  const m = t.manifest
  if (!m) return null

  const avgSpeed = t.elapsedMs > 0 ? (t.totalBytes / t.elapsedMs) * 1000 : 0
  const peakSpeed = t.speedHistory.length > 0 ? Math.max(...t.speedHistory) : 0
  const effectiveSpeed = t.speedBps || avgSpeed

  return (
    <Card className="flux-glass p-6 relative overflow-hidden">
      {/* Decorative gradient glow */}
      <div className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 h-32 w-64 rounded-full bg-flux-500/15 blur-3xl" />

      <div className="relative">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <motion.div
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 12 }}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-flux-500 shadow-lg shadow-flux-500/30"
          >
            <CheckCircle2 className="h-8 w-8 text-white" strokeWidth={2.5} />
          </motion.div>
          <div>
            <h3 className="text-xl font-bold">Transfer complete</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
                <ShieldCheck className="mr-1 h-3 w-3" />
                SHA-256 verified
              </Badge>
              <span className="text-xs text-muted-foreground">
                {m.files.length} file{m.files.length > 1 ? 's' : ''} · {formatBytes(m.totalSize)}
              </span>
            </div>
          </div>
        </div>

        {/* Stats recap grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <RecapStat
            icon={<FileStack className="h-4 w-4" />}
            label="Files"
            value={m.files.length.toString()}
          />
          <RecapStat
            icon={<Database className="h-4 w-4" />}
            label="Data"
            value={formatBytes(m.totalSize)}
          />
          <RecapStat
            icon={<Clock className="h-4 w-4" />}
            label="Duration"
            value={formatDuration(t.elapsedMs)}
          />
          <RecapStat
            icon={<Gauge className="h-4 w-4" />}
            label="Avg speed"
            value={formatBytes(effectiveSpeed) + '/s'}
          />
        </div>

        {/* Peak speed note (only if we have history) */}
        {peakSpeed > 0 && (
          <div className="mb-6 rounded-lg border border-border/50 bg-card/40 p-3 text-xs text-muted-foreground flex items-center justify-between">
            <span>Peak speed during transfer</span>
            <span className="font-mono font-semibold text-foreground">{formatBytes(peakSpeed)}/s</span>
          </div>
        )}

        {/* File list summary (compact) */}
        <div className="mb-6 rounded-lg border border-border/50 bg-card/40 p-3 max-h-32 overflow-y-auto flux-scroll">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
            Files transferred
          </p>
          <div className="space-y-1">
            {m.files.map((f, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="truncate font-medium">{f.name}</span>
                <span className="text-muted-foreground shrink-0 ml-2">{formatBytes(f.size)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={onSendAnother}
            variant="outline"
            className="flex-1 border-flux-500/40 hover:bg-flux-500/10"
          >
            Send another
          </Button>
          <Button
            onClick={onDone}
            className="flex-1 bg-flux-600 hover:bg-flux-700 text-white"
          >
            Done
          </Button>
        </div>
      </div>
    </Card>
  )
}

function RecapStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3">
      <div className="flex items-center gap-1.5 text-flux-600 dark:text-flux-400">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="mt-1 text-lg font-bold tabular-nums">{value}</p>
    </div>
  )
}
