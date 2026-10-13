'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { User, ArrowUp, ArrowDown } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useSessionStore } from '@/stores/session-store'
import type { PeerDevice } from '@/stores/session-store'
import { DeviceIcon } from './device-icon'

export function DeviceList() {
  const peers = useSessionStore((s) => s.peers)
  const alias = useSessionStore((s) => s.alias)
  // Self role follows the CURRENT view — the device list used to hardcode
  // "Sender" for the local device, so a receiver saw both rows as "Sender".
  const view = useSessionStore((s) => s.view)
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)
  const selfRole: 'sender' | 'receiver' = view === 'receiver' ? 'receiver' : 'sender'

  return (
    <Card className="flux-hover-border flux-glass p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Devices in room
        </h3>
        {peers.length > 0 && (
          <Badge variant="outline" className="text-[10px] h-4 py-0 border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
            {peers.length + 1} connected
          </Badge>
        )}
      </div>
      <div className="space-y-2">
        <DeviceRow alias={alias} role={selfRole} isSelf live={dataChannelOpen} />
        <AnimatePresence>
          {peers.map((peer) => (
            <motion.div
              key={peer.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
            >
              <DeviceRow alias={peer.alias} role={peer.role} />
            </motion.div>
          ))}
        </AnimatePresence>
        {peers.length === 0 && (
          <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <User className="h-5 w-5" />
            </div>
            <p className="text-sm text-muted-foreground">Waiting for peer to join…</p>
          </div>
        )}
      </div>
    </Card>
  )
}

function RoleIcon({ role, className }: { role: 'sender' | 'receiver'; className?: string }) {
  return role === 'sender' ? (
    <ArrowUp className={className} aria-hidden="true" />
  ) : (
    <ArrowDown className={className} aria-hidden="true" />
  )
}

function DeviceRow({
  alias,
  role,
  isSelf = false,
  live = false,
}: {
  alias: string
  role: 'sender' | 'receiver'
  isSelf?: boolean
  live?: boolean
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 p-3 transition-colors hover:border-flux-500/30">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${isSelf ? 'bg-flux-500/15 text-flux-600 dark:text-flux-400' : 'bg-muted text-muted-foreground'}`}>
        <DeviceIcon alias={alias} className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{alias}</p>
          {isSelf && (
            <Badge variant="secondary" className="text-[10px] py-0 h-4">
              you
            </Badge>
          )}
        </div>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <RoleIcon role={role} className="h-3 w-3" />
          <span className="capitalize">{role}</span>
        </p>
      </div>
      {isSelf && live && (
        <span className="relative flex h-2.5 w-2.5" title="Direct connection live">
          <span className="absolute inline-flex h-full w-full rounded-full bg-flux-500 opacity-75 flux-pulse-dot" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-flux-500" />
        </span>
      )}
      {!isSelf && (
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-flux-500 opacity-75 flux-pulse-dot" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-flux-500" />
        </span>
      )}
    </div>
  )
}
