'use client'

// v1.3 (6.1): live per-receiver roster for GROUP fan-out. Each connected
// receiver gets a row with its own progress bar + state chip, so a group send
// answers "who has what" at a glance. Sender-side (peerProgress is populated
// by the sender's scheduler); with one receiver it reads like a normal
// single-peer progress readout.

import { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Users, Check, Loader2, Hourglass, UserMinus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { DeviceIcon } from './device-icon'

export function GroupRoster() {
  const peers = useSessionStore((s) => s.peers)
  const peerProgress = useTransferStore((s) => s.peerProgress)
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)

  const rows = useMemo(
    () =>
      peers
        .filter((p) => p.role === 'receiver')
        .map((p) => ({ peer: p, progress: peerProgress[p.id] ?? null })),
    [peers, peerProgress]
  )

  if (rows.length === 0) return null

  return (
    <Card className="flux-hover-border flux-glass p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Users className="h-4 w-4" aria-hidden="true" />
          Receiving devices
        </h3>
        <Badge variant="outline" className="text-[10px] h-4 py-0 border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
          {rows.length} device{rows.length > 1 ? 's' : ''}
        </Badge>
      </div>
      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {rows.map(({ peer, progress }) => {
            const total = progress?.total ?? 0
            const acked = progress?.acked ?? 0
            const pct = total > 0 ? Math.min(100, Math.round((acked / total) * 100)) : 0
            const state = progress?.state ?? (dataChannelOpen ? 'transferring' : 'pairing')
            const stateMeta =
              state === 'complete'
                ? { icon: <Check className="h-3 w-3" />, label: 'verified', cls: 'text-emerald-600 dark:text-emerald-400' }
                : state === 'transferring'
                  ? { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: 'receiving', cls: 'text-flux-600 dark:text-flux-400' }
                  : state === 'left'
                    ? { icon: <UserMinus className="h-3 w-3" />, label: 'left', cls: 'text-muted-foreground' }
                    : { icon: <Hourglass className="h-3 w-3" />, label: 'awaiting consent', cls: 'text-amber-600 dark:text-amber-400' }
            return (
              <motion.div
                key={peer.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="rounded-lg border border-border/50 bg-card/60 p-3 transition-colors hover:border-flux-500/30"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <DeviceIcon alias={peer.alias} className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{peer.alias}</p>
                      <span className={`flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide ${stateMeta.cls}`}>
                        {stateMeta.icon}
                        {stateMeta.label}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          state === 'complete'
                            ? 'bg-emerald-500'
                            : 'bg-flux-500'
                        }`}
                        style={{ width: `${pct}%` }}
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${peer.alias} progress ${pct}%`}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {state === 'complete' ? 'All files verified' : `${pct}% · ${acked.toLocaleString()} / ${total.toLocaleString()} chunks`}
                    </p>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </Card>
  )
}
