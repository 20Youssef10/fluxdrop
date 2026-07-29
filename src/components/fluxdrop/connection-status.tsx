'use client'

import { motion } from 'framer-motion'
import { Wifi, CheckCircle2, AlertCircle, Loader2, XCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useSessionStore } from '@/stores/session-store'
import type { TransferState } from '@/lib/fluxdrop/protocol'

const STATE_LABELS: Record<TransferState, { label: string; color: string }> = {
  IDLE: { label: 'Idle', color: 'text-muted-foreground' },
  VALIDATING: { label: 'Validating', color: 'text-flux-600 dark:text-flux-400' },
  PAIRING: { label: 'Pairing', color: 'text-amber-500' },
  CONNECTING: { label: 'Connecting', color: 'text-amber-500' },
  RETRYING: { label: 'Retrying', color: 'text-amber-500' },
  MANIFEST_EXCHANGE: { label: 'Exchanging manifest', color: 'text-flux-600 dark:text-flux-400' },
  TRANSFERRING: { label: 'Transferring', color: 'text-flux-600 dark:text-flux-400' },
  RESUMING: { label: 'Resuming', color: 'text-amber-500' },
  VERIFYING: { label: 'Verifying checksum', color: 'text-flux-600 dark:text-flux-400' },
  COMPLETE: { label: 'Complete', color: 'text-emerald-500' },
  CANCELLED: { label: 'Cancelled', color: 'text-muted-foreground' },
  FAILED: { label: 'Failed', color: 'text-destructive' },
  ERROR: { label: 'Error', color: 'text-destructive' },
}

export function ConnectionStatus({ transferState }: { transferState: TransferState }) {
  const rtcState = useSessionStore((s) => s.rtcState)
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)

  const meta = STATE_LABELS[transferState] ?? STATE_LABELS.IDLE

  return (
    <Card className="flux-glass p-4">
      <div className="flex items-center gap-4">
        <div className="relative">
          <div className={`flex h-12 w-12 items-center justify-center rounded-xl bg-flux-500/10 ${meta.color}`}>
            <motion.div
              key={transferState}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              <StateIcon state={transferState} className={`h-6 w-6 ${transferState === 'TRANSFERRING' || transferState === 'CONNECTING' || transferState === 'VERIFYING' ? 'animate-pulse' : ''}`} />
            </motion.div>
          </div>
          {transferState === 'TRANSFERRING' && (
            <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-flux-500 opacity-75 flux-pulse-dot" />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-flux-500 border-2 border-background" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-sm">{meta.label}</p>
            <Badge variant="outline" className="text-[10px] py-0 h-4 capitalize">
              {transferState}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {describeState(transferState, rtcState, dataChannelOpen)}
          </p>
        </div>
      </div>

      {/* Connection pipeline visualization */}
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <PipelineStep
          label="Signal"
          active={rtcState !== 'new'}
          done={rtcState === 'connected' || rtcState === 'completed'}
        />
        <PipelineStep
          label="P2P"
          active={dataChannelOpen}
          done={rtcState === 'connected' && dataChannelOpen}
        />
        <PipelineStep
          label="Data"
          active={transferState === 'TRANSFERRING'}
          done={transferState === 'COMPLETE'}
        />
      </div>
    </Card>
  )
}

function PipelineStep({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div
      className={`rounded-md border px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
        done
          ? 'border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300'
          : active
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
          : 'border-border bg-muted/30 text-muted-foreground'
      }`}
    >
      {label}
    </div>
  )
}

function StateIcon({ state, className }: { state: TransferState; className?: string }) {
  switch (state) {
    case 'COMPLETE': return <CheckCircle2 className={className} />
    case 'FAILED':
    case 'ERROR': return <XCircle className={className} />
    case 'CANCELLED': return <AlertCircle className={className} />
    case 'TRANSFERRING':
    case 'CONNECTING':
    case 'VERIFYING':
    case 'PAIRING':
    case 'RETRYING':
    case 'RESUMING':
    case 'MANIFEST_EXCHANGE':
    case 'VALIDATING': return <Loader2 className={className} />
    default: return <Wifi className={className} />
  }
}

function describeState(state: TransferState, rtcState: string, dcOpen: boolean): string {
  if (state === 'COMPLETE') return 'Transfer finished and verified successfully'
  if (state === 'FAILED' || state === 'ERROR') return 'Something went wrong — see the error below'
  if (state === 'CANCELLED') return 'Transfer was cancelled'
  if (state === 'TRANSFERRING') return dcOpen ? 'Streaming chunks over the encrypted P2P channel' : 'Waiting for data channel…'
  if (state === 'VERIFYING') return 'Computing SHA-256 checksum to verify integrity'
  if (state === 'MANIFEST_EXCHANGE') return 'Exchanging file manifest with peer'
  if (state === 'CONNECTING' || state === 'RETRYING') return `Negotiating WebRTC connection (${rtcState})`
  if (state === 'PAIRING') return 'Exchanging pairing handshake via signaling'
  if (state === 'RESUMING') return 'Reconnecting to resume from last chunk'
  if (state === 'VALIDATING') return 'Hashing files and validating constraints'
  return 'Ready'
}
