'use client'

import { useState } from 'react'
import { ArrowLeft, Send, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FilePicker } from './file-picker'
import { QRDisplay } from './qr-display'
import { DeviceList } from './device-list'
import { ConnectionStatus } from './connection-status'
import { TransferProgress } from './transfer-progress'
import { DiagnosticsPanel } from './diagnostics-panel'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatBytes, fileTypeCategory } from '@/lib/fluxdrop/format'
import { FileIcon, getFileCategoryColors } from './file-icon'
import { FilePreview } from './file-preview'
import { HashingProgress } from './hashing-progress'

interface SenderPanelProps {
  files: File[]
  setFiles: (f: File[]) => void
  onStartSend: (files: File[]) => void
  onCancel: () => void
  onDone: () => void
  onBack: () => void
  onPause?: () => void
  onResume?: () => void
  /** True when the queue was restored from transfer history (resume). */
  isResuming?: boolean
}

export function SenderPanel({ files, setFiles, onStartSend, onCancel, onDone, onBack, onPause, onResume, isResuming }: SenderPanelProps) {
  const session = useSessionStore()
  const transfer = useTransferStore()
  const [showFiles, setShowFiles] = useState(false)

  const hasRoom = !!session.roomId
  const isValidating = transfer.transferState === 'VALIDATING'
  const isTransferring =
    transfer.transferState === 'TRANSFERRING' ||
    transfer.transferState === 'PAUSED' ||
    transfer.transferState === 'VERIFYING' ||
    transfer.transferState === 'MANIFEST_EXCHANGE'
  const isDone =
    transfer.transferState === 'COMPLETE' ||
    transfer.transferState === 'FAILED' ||
    transfer.transferState === 'ERROR' ||
    transfer.transferState === 'CANCELLED'

  return (
    <div className="space-y-5">
      {/* Header strip */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground">
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to home
        </Button>
        <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
          <Send className="mr-1.5 h-3 w-3" />
          Sender mode
        </Badge>
      </div>

      {/* Hashing progress (during VALIDATING state) */}
      {isValidating && (
        <HashingProgress />
      )}

      {/* Resume banner — queue was restored from transfer history */}
      {isResuming && !hasRoom && !isValidating && !isTransferring && !isDone && (
        <div className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5">
          <RotateCcw className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">Resuming a previous transfer</p>
            <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70">
              Original checksums are reused — files must be unchanged since then.
            </p>
          </div>
        </div>
      )}

      {/* Pre-room: file picker */}
      {!hasRoom && !isValidating && !isTransferring && !isDone && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-3">
            <FilePicker files={files} onFilesChange={setFiles} onSend={() => onStartSend(files)} />
          </div>
          <div className="lg:col-span-2">
            <Card className="flux-glass p-5 h-full">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                What happens next
              </h3>
              <ol className="space-y-3 text-sm">
                <Step n={1} text="We hash your files with SHA-256 to enable integrity verification." />
                <Step n={2} text="A short-lived room is created on the signaling server with a 6-digit PIN." />
                <Step n={3} text="Show the QR code (or room ID + PIN) to the receiving device." />
                <Step n={4} text="Once paired, a direct WebRTC DataChannel opens — bytes flow peer-to-peer." />
                <Step n={5} text="The receiver verifies the checksum on arrival. Done." />
              </ol>
              <div className="mt-4 rounded-lg border border-flux-500/30 bg-flux-500/5 p-3 text-xs text-muted-foreground">
                No file data ever touches the signaling server — only connection setup metadata.
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* Room created, waiting for peer / pairing */}
      {hasRoom && !isTransferring && !isDone && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-3">
            <QRDisplay />
          </div>
          <div className="lg:col-span-2 space-y-4">
            <ConnectionStatus transferState={transfer.transferState} />
            <DiagnosticsPanel />
            <DeviceList />
            {files.length > 0 && (
              <Card className="flux-glass p-5">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    Queued files
                  </h4>
                  <Badge variant="outline" className="text-[10px]">
                    {files.length} · {formatBytes(files.reduce((s, f) => s + f.size, 0))}
                  </Badge>
                </div>
                <div className="max-h-48 overflow-y-auto flux-scroll space-y-1.5 pr-1">
                  {files.map((f, i) => (
                    <QueuedFileRow key={i} file={f} />
                  ))}
                </div>
              </Card>
            )}
            <Button variant="outline" onClick={onCancel} className="w-full text-muted-foreground">
              Cancel and close room
            </Button>
          </div>
        </div>
      )}

      {/* Transferring / done */}
      {(isTransferring || isDone) && (
        <TransferProgress onCancel={onCancel} onDone={onDone} onPause={onPause} onResume={onResume} />
      )}
    </div>
  )
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-flux-500/15 text-flux-600 dark:text-flux-400 text-xs font-bold">
        {n}
      </span>
      <span className="text-sm text-muted-foreground leading-relaxed pt-0.5">{text}</span>
    </li>
  )
}

function QueuedFileRow({ file }: { file: File }) {
  const isImage = fileTypeCategory(file.type, file.name) === 'image'
  const colors = getFileCategoryColors(file.type, file.name)
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/40 p-2">
      {isImage ? (
        <FilePreview file={file} size={28} className="shrink-0 ring-1 ring-border/50" />
      ) : (
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${colors.bg} ${colors.text}`}>
          <FileIcon mime={file.type} name={file.name} className="h-3.5 w-3.5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{file.name}</p>
        <p className="text-[10px] text-muted-foreground">{formatBytes(file.size)}</p>
      </div>
    </div>
  )
}
