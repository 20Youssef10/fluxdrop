'use client'

import { ArrowLeft, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { JoinForm } from './join-form'
import { DeviceList } from './device-list'
import { ConnectionStatus } from './connection-status'
import { TransferProgress } from './transfer-progress'
import { Card } from '@/components/ui/card'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'

interface ReceiverPanelProps {
  onJoin: (roomId: string, pin: string) => void
  onCancel: () => void
  onDone: () => void
  onBack: () => void
}

export function ReceiverPanel({ onJoin, onCancel, onDone, onBack }: ReceiverPanelProps) {
  const session = useSessionStore()
  const transfer = useTransferStore()

  const hasRoom = !!session.roomId
  const isTransferring =
    transfer.transferState === 'TRANSFERRING' ||
    transfer.transferState === 'VERIFYING' ||
    transfer.transferState === 'MANIFEST_EXCHANGE'
  const isDone =
    transfer.transferState === 'COMPLETE' ||
    transfer.transferState === 'FAILED' ||
    transfer.transferState === 'ERROR' ||
    transfer.transferState === 'CANCELLED'

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground">
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to home
        </Button>
        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Download className="mr-1.5 h-3 w-3" />
          Receiver mode
        </Badge>
      </div>

      {!hasRoom && !isTransferring && !isDone && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-3">
            <JoinForm onJoin={onJoin} onBack={onBack} />
          </div>
          <div className="lg:col-span-2">
            <Card className="flux-glass p-5 h-full">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Receiving is safe
              </h3>
              <ul className="space-y-3 text-sm">
                <Bullet text="Files stream directly from the sender's device over an encrypted WebRTC tunnel." />
                <Bullet text="You explicitly accept each transfer after seeing the file list and total size." />
                <Bullet text="SHA-256 checksums are verified on arrival — corrupted bytes are rejected." />
                <Bullet text="Nothing is uploaded to any server. The signaling layer only sets up the connection." />
              </ul>
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
                Tip: ask the sender for the 6-character room ID and 6-digit PIN shown on their screen.
              </div>
            </Card>
          </div>
        </div>
      )}

      {hasRoom && !isTransferring && !isDone && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-3 space-y-4">
            <Card className="flux-glass p-6">
              <div className="flex flex-col items-center text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Download className="h-7 w-7 animate-pulse" />
                </div>
                <h3 className="text-lg font-semibold">Waiting for sender</h3>
                <p className="mt-1 text-sm text-muted-foreground max-w-sm">
                  You're in room <code className="font-mono font-semibold text-foreground">{session.roomId}</code>.
                  The sender will push a file manifest once the WebRTC tunnel opens.
                </p>
              </div>
            </Card>
            <ConnectionStatus transferState={transfer.transferState} />
          </div>
          <div className="lg:col-span-2 space-y-4">
            <DeviceList />
            <Button variant="outline" onClick={onCancel} className="w-full text-muted-foreground">
              Leave room
            </Button>
          </div>
        </div>
      )}

      {(isTransferring || isDone) && (
        <TransferProgress onCancel={onCancel} onDone={onDone} />
      )}
    </div>
  )
}

function Bullet({ text }: { text: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-flux-500" />
      <span className="text-sm text-muted-foreground leading-relaxed">{text}</span>
    </li>
  )
}
