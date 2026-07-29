'use client'

import { useEffect, useState } from 'react'
import { ArrowUp, ArrowDown, FileStack, Database, Zap, TrendingUp } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { listTransfers, type StoredTransfer } from '@/lib/fluxdrop/resume'
import { formatBytes } from '@/lib/fluxdrop/format'
import { AnimatedNumber } from './animated-number'

interface Stats {
  totalTransfers: number
  sentCount: number
  receivedCount: number
  totalBytes: number
  completedCount: number
  avgSize: number
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
        const avgSize = completed.length > 0 ? totalBytes / completed.length : 0
        setStats({
          totalTransfers: recs.length,
          sentCount: sent.length,
          receivedCount: received.length,
          totalBytes,
          completedCount: completed.length,
          avgSize,
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

  return (
    <Card className="flux-glass p-5">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Your transfer stats
        </h3>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile
          icon={<FileStack className="h-4 w-4" />}
          label="Total transfers"
          value={<AnimatedNumber value={stats.totalTransfers} />}
          sublabel={`${stats.completedCount} completed`}
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
      </div>
    </Card>
  )
}

function StatTile({
  icon,
  label,
  value,
  sublabel,
  color,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  sublabel: string
  color: string
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3.5">
      <div className={`flex items-center gap-1.5 ${color}`}>
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="mt-1.5 text-xl font-bold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5">{sublabel}</p>
    </div>
  )
}
