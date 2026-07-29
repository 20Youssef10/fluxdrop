'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity,
  ChevronDown,
  Globe,
  ArrowRight,
  Zap,
  Clock,
  Server,
  Cpu,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/stores/session-store'
import { formatBytes } from '@/lib/fluxdrop/format'
import { deriveQuality, QualityBars } from './connection-quality'

export function DiagnosticsPanel() {
  const [open, setOpen] = useState(false)

  // Listen for the keyboard-shortcut toggle event
  useEffect(() => {
    const handler = () => setOpen((v) => !v)
    window.addEventListener('fluxdrop:toggle-diagnostics', handler)
    return () => window.removeEventListener('fluxdrop:toggle-diagnostics', handler)
  }, [])
  const rtcState = useSessionStore((s) => s.rtcState)
  const iceGathering = useSessionStore((s) => s.iceGatheringState)
  const iceConnection = useSessionStore((s) => s.iceConnectionState)
  const diagnostics = useSessionStore((s) => s.diagnostics)
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)

  // Don't render until there's something to show
  if (rtcState === 'new' || rtcState === 'closed') return null

  const pair = diagnostics?.selectedPair
  const rtt = pair?.currentRoundTripTime != null ? (pair.currentRoundTripTime * 1000).toFixed(0) : null
  const quality = deriveQuality(diagnostics)

  return (
    <Card className="flux-hover-border flux-glass overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-flux-500/10 text-flux-600 dark:text-flux-400">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">Connection diagnostics</p>
            <p className="text-xs text-muted-foreground">
              ICE: {iceConnection} · Gathering: {iceGathering} · DC: {dataChannelOpen ? 'open' : 'closed'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Quality bars + label */}
          {dataChannelOpen && (
            <div className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${quality.borderColor} ${quality.bgColor}`}>
              <QualityBars level={quality.level} className="h-3.5" />
              <span className={`text-[10px] font-medium ${quality.color}`}>{quality.label}</span>
            </div>
          )}
          {pair && (
            <Badge variant="outline" className="text-[10px] border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
              {pair.localCandidateType ?? '?'} → {pair.remoteCandidateType ?? '?'}
            </Badge>
          )}
          <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </motion.div>
        </div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 p-4 space-y-4">
              {/* Connection pipeline visualization */}
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-card/40 p-3">
                <Endpoint
                  icon={<Cpu className="h-3.5 w-3.5" />}
                  label="Local"
                  detail={pair ? `${pair.localAddress ?? '—'}:${pair.localPort ?? ''}` : 'gathering…'}
                />
                <div className="flex flex-1 items-center justify-center px-2 relative">
                  <div className="h-px w-full bg-border" />
                  <div className="absolute inset-x-2 flex items-center justify-center">
                    <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      dataChannelOpen
                        ? 'bg-flux-500/15 text-flux-600 dark:text-flux-400'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      <Zap className="h-2.5 w-2.5" />
                      {pair?.protocol?.toUpperCase() ?? '—'}
                      {rtt && <span className="ml-0.5">· {rtt}ms</span>}
                    </div>
                  </div>
                  {/* Animated beam when connected */}
                  {dataChannelOpen && (
                    <div className="absolute inset-x-2 top-1/2 -translate-y-1/2 h-px overflow-hidden">
                      <div className="h-full w-8 bg-flux-400/60 flux-beam" />
                    </div>
                  )}
                </div>
                <Endpoint
                  icon={<Globe className="h-3.5 w-3.5" />}
                  label="Remote"
                  detail={pair ? `${pair.remoteAddress ?? '—'}:${pair.remotePort ?? ''}` : '—'}
                />
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Stat
                  icon={<ArrowRight className="h-3 w-3" />}
                  label="Bytes sent"
                  value={formatBytes(diagnostics?.bytesSent ?? 0)}
                />
                <Stat
                  icon={<ArrowRight className="h-3 w-3 rotate-180" />}
                  label="Bytes recv"
                  value={formatBytes(diagnostics?.bytesReceived ?? 0)}
                />
                <Stat
                  icon={<Clock className="h-3 w-3" />}
                  label="RTT"
                  value={rtt ? `${rtt}ms` : '—'}
                />
                <Stat
                  icon={<Server className="h-3 w-3" />}
                  label="RTC state"
                  value={rtcState}
                />
              </div>

              {/* Candidate types explanation */}
              <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-[11px] text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Candidate types</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span><code className="text-flux-600 dark:text-flux-400">host</code> — direct local network</span>
                  <span><code className="text-flux-600 dark:text-flux-400">srflx</code> — via STUN (NAT traversal)</span>
                  <span><code className="text-flux-600 dark:text-flux-400">relay</code> — via TURN server</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

function Endpoint({
  icon,
  label,
  detail,
}: {
  icon: React.ReactNode
  label: string
  detail: string
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-0">
      <div className="flex items-center gap-1 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <code className="text-[10px] font-mono text-foreground truncate max-w-[120px]" title={detail}>
        {detail}
      </code>
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-md border border-border/40 bg-card/40 p-2.5">
      <div className="flex items-center gap-1 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-0.5 text-sm font-semibold tabular-nums truncate">{value}</p>
    </div>
  )
}
