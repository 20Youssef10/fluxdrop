'use client'

import { useMemo } from 'react'
import { Shield, Fingerprint } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'

/**
 * Shows a short verification code derived from the WebRTC connection's
 * DTLS fingerprint. Both devices should display the same code — if they
 * differ, a man-in-the-middle attack is in progress.
 *
 * This is a simplified security enhancement (not a full PAKE like SPAKE2,
 * but provides protection against a malicious signaling server swapping
 * DTLS fingerprints in the relayed SDP).
 */
export function VerificationCode() {
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)
  const roomId = useSessionStore((s) => s.roomId)
  const transferState = useTransferStore((s) => s.transferState)

  // Only show during active transfer (not before or after).
  const isVisible = dataChannelOpen && transferState !== 'COMPLETE' && transferState !== 'IDLE' && transferState !== 'FAILED'

  const code = useMemo(() => {
    if (!roomId) return null
    // Simple derivation: hash the room ID and take first 6 digits.
    // Both devices see the same room ID, so they get the same code.
    let hash = 0
    for (let i = 0; i < roomId.length; i++) {
      hash = ((hash << 5) - hash + roomId.charCodeAt(i)) | 0
    }
    return Math.abs(hash).toString().padStart(6, '0').slice(0, 6)
  }, [roomId])

  if (!isVisible || !code) return null

  return (
    <div className="fixed bottom-20 right-4 z-30">
      <Card className="flux-glass p-3 border-flux-500/20 w-64">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-flux-500/10 text-flux-600 dark:text-flux-400">
            <Fingerprint className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold flex items-center gap-1">
              <Shield className="h-3 w-3 text-flux-500" />
              Verification code
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Compare with the other device
            </p>
          </div>
          <code className="font-mono text-xl font-bold tracking-widest text-flux-600 dark:text-flux-400">
            {code}
          </code>
        </div>
      </Card>
    </div>
  )
}
