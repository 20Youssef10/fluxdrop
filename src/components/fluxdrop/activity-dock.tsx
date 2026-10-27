'use client'

// v1.3 (5.1): transfer activity dock — a fixed bottom-center floating bar so
// live transfer progress stays visible from ANYWHERE in the app (history,
// settings, the other panel's view) without losing the ability to pause,
// cancel, or jump back to the active side. Reuses the transfer store's
// aggregate data + the v1.3 group-roster's per-peer progress RECORD (not the
// component). Mounted ONCE in page.tsx as a fixed overlay — zero layout impact.

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronUp, Pause, Play, X, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTransferStore, type PeerTransferProgress } from '@/stores/transfer-store'
import { formatBytes, formatDuration } from '@/lib/fluxdrop/format'
import type { TransferState } from '@/lib/fluxdrop/protocol'

/** States in which the dock is visible (everything mid-flight). */
const DOCK_STATES: TransferState[] = [
  'PAIRING',
  'CONNECTING',
  'MANIFEST_EXCHANGE',
  'TRANSFERRING',
  'PAUSED',
  'RESUMING',
  'VERIFYING',
]

const STATE_LABELS: Record<string, string> = {
  PAIRING: 'Pairing',
  CONNECTING: 'Connecting',
  MANIFEST_EXCHANGE: 'Waiting for consent',
  TRANSFERRING: 'Transferring',
  PAUSED: 'Paused',
  RESUMING: 'Resuming',
  VERIFYING: 'Verifying',
}

interface ActivityDockProps {
  /** Cancel the live transfer (page wires flux.cancelTransfer). */
  onCancel: () => void
  onPause: () => void
  onResume: () => void
  /** Navigate to whichever side owns the active transfer. */
  onJump: () => void
}

function PeerRow({ peer }: { peer: PeerTransferProgress }) {
  const pct = peer.total > 0 ? Math.min(100, Math.round((peer.acked / peer.total) * 100)) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-[11px] text-muted-foreground" title={peer.alias}>
        {peer.alias}
      </span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-flux-500 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
      <Badge
        variant="outline"
        className="h-4 shrink-0 px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
      >
        {peer.state}
      </Badge>
    </div>
  )
}

export function ActivityDock({ onCancel, onPause, onResume, onJump }: ActivityDockProps) {
  const transferState = useTransferStore((s) => s.transferState)
  const chunksAcked = useTransferStore((s) => s.chunksAcked)
  const totalChunks = useTransferStore((s) => s.totalChunks)
  const bytesTransferred = useTransferStore((s) => s.bytesTransferred)
  const totalBytes = useTransferStore((s) => s.totalBytes)
  const speedBps = useTransferStore((s) => s.speedBps)
  const elapsedMs = useTransferStore((s) => s.elapsedMs)
  const peerProgress = useTransferStore((s) => s.peerProgress)

  const [expanded, setExpanded] = useState(false)
  const visible = DOCK_STATES.includes(transferState)

  const pct = totalChunks > 0 ? Math.min(100, Math.round((chunksAcked / totalChunks) * 100)) : 0
  const label = STATE_LABELS[transferState] ?? transferState
  const paused = transferState === 'PAUSED'
  const peers = Object.values(peerProgress)
  // Per-receiver mini-rows only matter in a GROUP fan-out (>1 receiver).
  const showPeers = peers.length > 1

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-3"
    >
      <AnimatePresence>
        {visible && (
          <motion.div
            key="activity-dock"
            role="status"
            aria-label="Transfer activity dock"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="flux-glass pointer-events-auto w-full max-w-xl overflow-hidden rounded-2xl border border-border/60 shadow-xl shadow-black/10"
          >
            {/* Collapsed bar */}
            <div className="flex items-center gap-2 px-3 py-2 sm:gap-2.5 sm:px-4">
              {/* Live dot — pulsing while active, solid amber while paused */}
              <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
                {!paused && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-flux-500 opacity-60" />
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${paused ? 'bg-amber-500' : 'bg-flux-500'}`}
                />
              </span>

              {/* State + compact progress (min-w-0 so the bar never overflows) */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold leading-tight text-foreground">
                  {label}
                  <span className="ml-2 font-normal tabular-nums text-muted-foreground">
                    {pct}%
                    {speedBps > 0 && (
                      <span className="ml-2 hidden sm:inline">{formatBytes(speedBps)}/s</span>
                    )}
                  </span>
                </p>
                <p className="truncate text-[10px] leading-tight text-muted-foreground">
                  {formatBytes(bytesTransferred)} / {formatBytes(totalBytes)}
                </p>
              </div>

              {/* Pause / Resume — 44px touch target, state-aware */}
              <Button
                variant="ghost"
                size="icon"
                onClick={paused ? onResume : onPause}
                disabled={!paused && transferState !== 'TRANSFERRING'}
                aria-label={paused ? 'Resume transfer' : 'Pause transfer'}
                className="h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground"
              >
                {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </Button>

              {/* Expand / collapse */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? 'Collapse transfer details' : 'Expand transfer details'}
                aria-expanded={expanded}
                className="h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground"
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>

              {/* Cancel */}
              <Button
                variant="ghost"
                size="icon"
                onClick={onCancel}
                aria-label="Cancel transfer"
                className="h-11 w-11 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Expanded details */}
            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div
                  key="dock-details"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                  className="overflow-hidden"
                >
                  <div className="space-y-2.5 border-t border-border/50 px-4 py-3">
                    {/* Mini progress bar */}
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-flux-500 transition-[width] duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    {/* Stats grid */}
                    <div className="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                      <div>
                        <p className="font-medium text-foreground">{formatDuration(elapsedMs)}</p>
                        <p>elapsed</p>
                      </div>
                      <div>
                        <p className="font-medium text-foreground tabular-nums">
                          {chunksAcked}/{totalChunks}
                        </p>
                        <p>chunks</p>
                      </div>
                      <div>
                        <p className="font-medium text-foreground tabular-nums">
                          {formatBytes(bytesTransferred)}
                        </p>
                        <p>of {formatBytes(totalBytes)}</p>
                      </div>
                    </div>

                    {/* Per-receiver rows (group fan-out only) */}
                    {showPeers && (
                      <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/20 p-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Receivers
                        </p>
                        {peers.map((p) => (
                          <PeerRow key={p.deviceId} peer={p} />
                        ))}
                      </div>
                    )}

                    {/* Jump to the active side */}
                    <Button
                      size="sm"
                      onClick={onJump}
                      className="h-11 w-full bg-flux-600 text-white hover:bg-flux-700 sm:h-9"
                    >
                      <ArrowUpRight className="mr-1.5 h-4 w-4" />
                      Go to transfer
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
