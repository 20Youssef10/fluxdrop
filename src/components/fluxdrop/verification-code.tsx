'use client'

import { useMemo } from 'react'
import { Shield, ShieldCheck, ShieldAlert, Fingerprint } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'

/**
 * v1.2: the short authentication string (SAS) — 6 digits derived from the
 * SPAKE2 transcript once the PAKE completes. Both devices show the SAME code
 * only when they agreed on the same key: an active MITM running two separate
 * handshakes produces two DIFFERENT transcripts → codes differ → the user
 * sees it. This turns "compare these 6 digits" from decoration (v1.0's
 * room-id hash) into real authentication (FEATURES.md 2.2).
 *
 * When E2E is idle (feature off / peer unsupported) the card falls back to
 * the old DTLS status with the legacy room-hash code.
 */
export function VerificationCode() {
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)
  const roomId = useSessionStore((s) => s.roomId)
  const e2eStatus = useSessionStore((s) => s.e2eStatus)
  const e2eSas = useSessionStore((s) => s.e2eSas)
  const transferState = useTransferStore((s) => s.transferState)

  // Only show during active transfer (not before or after).
  const isVisible = dataChannelOpen && transferState !== 'COMPLETE' && transferState !== 'IDLE' && transferState !== 'FAILED'

  // Legacy fallback code (room-id hash) — unchanged from v1.0 for the
  // no-E2E path so both sides still agree trivially.
  const legacyCode = useMemo(() => {
    if (!roomId) return null
    let hash = 0
    for (let i = 0; i < roomId.length; i++) {
      hash = ((hash << 5) - hash + roomId.charCodeAt(i)) | 0
    }
    return Math.abs(hash).toString().padStart(6, '0').slice(0, 6)
  }, [roomId])

  if (!isVisible) return null

  const active = e2eStatus === 'active' && !!e2eSas
  const failed = e2eStatus === 'failed'
  const handshaking = e2eStatus === 'handshaking'
  const code = active ? e2eSas : legacyCode
  if (!code) return null

  const statusLabel = active
    ? 'End-to-end encrypted (PAKE)'
    : failed
      ? 'Encryption verification failed'
      : handshaking
        ? 'Establishing E2E key…'
        : 'DTLS in transit · no payload E2E'
  const StatusIcon = active ? ShieldCheck : failed ? ShieldAlert : Shield

  return (
    <div className="fixed bottom-20 right-4 z-30" role="status" aria-live="polite">
      <Card
        className={`flux-glass p-3 w-64 ${
          active
            ? 'border-flux-500/40'
            : failed
              ? 'border-destructive/50'
              : 'border-flux-500/20'
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
              active
                ? 'bg-flux-500/15 text-flux-600 dark:text-flux-400'
                : failed
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-flux-500/10 text-flux-600 dark:text-flux-400'
            }`}
          >
            <Fingerprint className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold flex items-center gap-1">
              <StatusIcon className={`h-3 w-3 ${active ? 'text-flux-500' : failed ? 'text-destructive' : 'text-flux-500'}`} />
              {active ? 'Verification code' : 'Connection security'}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {active ? 'Compare with the other device' : statusLabel}
            </p>
          </div>
          <code
            className={`font-mono text-xl font-bold tracking-widest ${
              active ? 'text-flux-600 dark:text-flux-400' : failed ? 'text-destructive' : 'text-muted-foreground'
            }`}
            aria-label={
              active
                ? `Security verification code. Compare with the other device: ${code.split('').join(' ')}`
                : undefined
            }
          >
            {failed ? '------' : code}
          </code>
        </div>
      </Card>
    </div>
  )
}
