'use client'

import { motion } from 'framer-motion'
import { Laptop, Smartphone, ArrowRight } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'

/**
 * Animated two-device visualization showing the connection state.
 * Shows data particles flowing between devices when transferring.
 */
export function ConnectionViz() {
  const session = useSessionStore()
  const transfer = useTransferStore()
  const alias = session.alias
  const peer = session.peers[0]
  const isTransferring = transfer.transferState === 'TRANSFERRING'
  const isComplete = transfer.transferState === 'COMPLETE'
  const isConnecting =
    transfer.transferState === 'CONNECTING' ||
    transfer.transferState === 'PAIRING' ||
    transfer.transferState === 'MANIFEST_EXCHANGE'
  const pct = transfer.totalBytes > 0 ? (transfer.bytesTransferred / transfer.totalBytes) * 100 : 0

  return (
    <div className="relative flex items-center justify-between gap-3 py-2">
      {/* Local device */}
      <DeviceNode
        icon={<Laptop className="h-5 w-5" />}
        label={alias}
        sublabel="you"
        active
      />

      {/* Connection wire */}
      <div className="relative flex-1 h-12 flex items-center">
        {/* Base line */}
        <div
          className={`h-0.5 w-full rounded-full transition-colors ${
            isComplete
              ? 'bg-flux-500'
              : isTransferring
              ? 'bg-flux-500/40'
              : isConnecting
              ? 'bg-amber-500/40'
              : 'bg-border'
          }`}
        />
        {/* Progress overlay */}
        {isTransferring && (
          <div
            className="absolute left-0 h-0.5 rounded-full bg-flux-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        )}
        {/* Flowing particles */}
        {isTransferring &&
          Array.from({ length: 5 }).map((_, i) => (
            <motion.div
              key={i}
              className="absolute h-1.5 w-1.5 rounded-full bg-flux-400 shadow-sm shadow-flux-400/50"
              initial={{ left: '0%', opacity: 0 }}
              animate={{ left: '100%', opacity: [0, 1, 1, 0] }}
              transition={{
                duration: 1.4,
                delay: i * 0.28,
                repeat: Infinity,
                ease: 'linear',
              }}
            />
          ))}
        {/* Connecting pulse */}
        {isConnecting && (
          <motion.div
            className="absolute h-2 w-2 rounded-full bg-amber-400"
            initial={{ left: '0%' }}
            animate={{ left: ['0%', '100%', '0%'] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
        {/* Complete checkmark */}
        {isComplete && (
          <motion.div
            className="absolute left-1/2 -translate-x-1/2 flex h-6 w-6 items-center justify-center rounded-full bg-flux-500 text-white text-xs font-bold"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200 }}
          >
            ✓
          </motion.div>
        )}
        {/* Direction arrow (static, subtle) */}
        {!isTransferring && !isConnecting && !isComplete && (
          <ArrowRight className="absolute left-1/2 -translate-x-1/2 h-3 w-3 text-muted-foreground/50" />
        )}
      </div>

      {/* Peer device */}
      <DeviceNode
        icon={peer ? <Smartphone className="h-5 w-5" /> : <Smartphone className="h-5 w-5" />}
        label={peer?.alias ?? 'waiting…'}
        sublabel={peer ? 'peer' : undefined}
        active={!!peer}
      />
    </div>
  )
}

function DeviceNode({
  icon,
  label,
  sublabel,
  active = false,
}: {
  icon: React.ReactNode
  label: string
  sublabel?: string
  active?: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 min-w-0 max-w-[100px]">
      <div
        className={`flex h-10 w-10 items-center justify-center rounded-xl transition-all ${
          active
            ? 'bg-flux-500/15 text-flux-600 dark:text-flux-400'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {icon}
      </div>
      <div className="text-center min-w-0">
        <p className="truncate text-[11px] font-medium max-w-[90px]">{label}</p>
        {sublabel && (
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{sublabel}</p>
        )}
      </div>
    </div>
  )
}
