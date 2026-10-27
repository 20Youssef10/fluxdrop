'use client'

import { useEffect, useState } from 'react'
import {
  ArrowUp,
  ArrowDown,
  FileStack,
  Database,
  Leaf,
  ShieldCheck,
  TrendingUp,
  Clock,
  Gauge,
  Users,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { listTransfers, type StoredTransfer } from '@/lib/fluxdrop/resume'
import { formatBytes } from '@/lib/fluxdrop/format'
import { AnimatedNumber } from './animated-number'

interface Stats {
  totalTransfers: number
  sentCount: number
  receivedCount: number
  totalBytes: number
  totalFiles: number
  completedCount: number
  avgSize: number
  bandwidthSaved: number
  resumedCount: number
  totalTimeMs: number
  avgThroughput: number // bytes/ms over completed transfers' wall-clock
  devicesMet: number
}

export function StatsDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const recs = await listTransfers()
        if (cancelled) return
        const completed = recs.filter((r) => r.status === 'COMPLETE')
        const sent = recs.filter((r) => r.role === 'sender')
        const received = recs.filter((r) => r.role === 'receiver')
        const totalBytes = completed.reduce((s, r) => s + r.manifest.totalSize, 0)
        const totalFiles = completed.reduce((s, r) => s + r.manifest.files.length, 0)
        const avgSize = completed.length > 0 ? totalBytes / completed.length : 0
        const bandwidthSaved = recs.reduce((s, r) => s + (r.resumedSavedBytes ?? 0), 0)
        const resumedCount = recs.filter((r) => r.resumedAt).length
        // Wall-clock time spent in transfers (start → finish, when both exist).
        const totalTimeMs = recs.reduce(
          (s, r) => s + (r.finishedAt ? Math.max(0, r.finishedAt - r.startedAt) : 0),
          0
        )
        // Rough average throughput across completed transfers (bytes per ms).
        const avgThroughput = totalTimeMs > 0 ? totalBytes / totalTimeMs : 0
        // Unique devices we've exchanged transfers with (excluding imported
        // records whose peerDeviceId was not exported).
        const devicesMet = new Set(recs.map((r) => r.peerDeviceId).filter((id) => id && id.length > 0)).size
        setStats({
          totalTransfers: recs.length,
          sentCount: sent.length,
          receivedCount: received.length,
          totalBytes,
          totalFiles,
          completedCount: completed.length,
          avgSize,
          bandwidthSaved,
          resumedCount,
          totalTimeMs,
          avgThroughput,
          devicesMet,
        })
      } catch {
        /* ignore */
      }
    }
    load()
    const id = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (!stats || stats.totalTransfers === 0) return null

  const successRate = stats.totalTransfers > 0
    ? Math.round((stats.completedCount / stats.totalTransfers) * 100)
    : 0

  return (
    <Card className="flux-hover-border flux-glass flux-slide-up p-5">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Your transfer stats
          </h3>
        </div>
        <span className="text-[10px] text-muted-foreground/70 tabular-nums">
          {stats.completedCount}/{stats.totalTransfers} completed
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatTile
          icon={<FileStack className="h-4 w-4" />}
          label="Total transfers"
          value={<AnimatedNumber value={stats.totalTransfers} />}
          sublabel={`${stats.totalFiles} files moved`}
          color="text-flux-600 dark:text-flux-400"
        />
        <StatTile
          icon={<ArrowUp className="h-4 w-4" />}
          label="Files sent"
          value={<AnimatedNumber value={stats.sentCount} />}
          sublabel="as sender"
          color="text-flux-600 dark:text-flux-400"
        />
        <StatTile
          icon={<ArrowDown className="h-4 w-4" />}
          label="Files received"
          value={<AnimatedNumber value={stats.receivedCount} />}
          sublabel="as receiver"
          color="text-amber-600 dark:text-amber-400"
        />
        <StatTile
          icon={<Database className="h-4 w-4" />}
          label="Data transferred"
          value={formatBytes(stats.totalBytes)}
          sublabel={`avg ${formatBytes(stats.avgSize)}/transfer`}
          color="text-flux-600 dark:text-flux-400"
        />
        <StatTile
          icon={<Leaf className="h-4 w-4" />}
          label="Bandwidth saved"
          value={formatBytes(stats.bandwidthSaved)}
          sublabel={stats.resumedCount > 0 ? `${stats.resumedCount} resume${stats.resumedCount !== 1 ? 's' : ''} skipped` : 'by resume skips'}
          color="text-flux-600 dark:text-flux-400"
          highlight={stats.bandwidthSaved > 0}
        />
        <StatTile
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Success rate"
          value={`${successRate}%`}
          sublabel={stats.totalTimeMs > 0 ? `${formatSpentTime(stats.totalTimeMs)} in transfers` : 'of all transfers'}
          color={successRate >= 80 ? 'text-flux-600 dark:text-flux-400' : 'text-amber-600 dark:text-amber-400'}
        />
        <StatTile
          icon={<Gauge className="h-4 w-4" />}
          label="Avg throughput"
          value={stats.avgThroughput > 0 ? `${formatBytes(stats.avgThroughput * 1000)}/s` : '—'}
          sublabel="across completed sends"
          color="text-flux-600 dark:text-flux-400"
        />
        <StatTile
          icon={<Users className="h-4 w-4" />}
          label="Devices met"
          value={<AnimatedNumber value={stats.devicesMet} />}
          sublabel={stats.devicesMet === 1 ? 'unique peer so far' : 'unique peers so far'}
          color="text-flux-600 dark:text-flux-400"
        />
      </div>
    </Card>
  )
}

/** Compact human formatting for long cumulative durations. */
function formatSpentTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function StatTile({
  icon,
  label,
  value,
  sublabel,
  color,
  highlight,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  sublabel: string
  color: string
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
        highlight
          ? 'border-flux-500/30 bg-flux-500/5 hover:border-flux-500/50 hover:bg-flux-500/10'
          : 'border-border/50 bg-card/40 hover:border-border hover:bg-card/70'
      }`}
    >
      <div className={`flex items-center gap-1.5 ${color}`}>
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
        {highlight && (
          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-flux-500 animate-pulse" aria-hidden />
        )}
      </div>
      <p className="mt-1.5 text-xl font-bold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
        {label === 'Success rate' && <Clock className="h-2.5 w-2.5 opacity-60" aria-hidden />}
        {sublabel}
      </p>
    </div>
  )
}
