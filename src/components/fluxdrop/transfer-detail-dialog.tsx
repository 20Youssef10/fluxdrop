'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ArrowUp, ArrowDown, CheckCircle2, AlertCircle, Clock, Hash, Database, FileIcon } from 'lucide-react'
import type { StoredTransfer } from '@/lib/fluxdrop/resume'
import { formatBytes, formatDuration, fileTypeCategory } from '@/lib/fluxdrop/format'

interface TransferDetailDialogProps {
  record: StoredTransfer | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TransferDetailDialog({ record, open, onOpenChange }: TransferDetailDialogProps) {
  if (!record) return null

  const isSender = record.role === 'sender'
  const isComplete = record.status === 'COMPLETE'
  const isError = record.status === 'FAILED' || record.status === 'ERROR'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isSender ? (
              <ArrowUp className="h-4 w-4 text-flux-500" />
            ) : (
              <ArrowDown className="h-4 w-4 text-amber-500" />
            )}
            Transfer details
          </DialogTitle>
          <DialogDescription>
            {record.manifest.files.length === 1
              ? record.manifest.files[0].name
              : `${record.manifest.files.length} files`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Status banner */}
          <div
            className={`flex items-center gap-2.5 rounded-lg border p-3 ${
              isComplete
                ? 'border-flux-500/30 bg-flux-500/5'
                : isError
                ? 'border-destructive/30 bg-destructive/5'
                : 'border-amber-500/30 bg-amber-500/5'
            }`}
          >
            {isComplete ? (
              <CheckCircle2 className="h-5 w-5 text-flux-500" />
            ) : isError ? (
              <AlertCircle className="h-5 w-5 text-destructive" />
            ) : (
              <Clock className="h-5 w-5 text-amber-500" />
            )}
            <div>
              <p className="text-sm font-medium">
                {isComplete ? 'Completed successfully' : isError ? 'Failed' : 'Incomplete'}
              </p>
              <p className="text-xs text-muted-foreground">
                {isComplete && record.checksumVerified ? 'SHA-256 checksum verified ✓' : record.status}
              </p>
            </div>
          </div>

          {/* Meta grid */}
          <div className="grid grid-cols-2 gap-3">
            <MetaItem icon={<Database className="h-3.5 w-3.5" />} label="Total size" value={formatBytes(record.manifest.totalSize)} />
            <MetaItem icon={<Clock className="h-3.5 w-3.5" />} label="Started" value={new Date(record.startedAt).toLocaleString()} />
            <MetaItem icon={<Hash className="h-3.5 w-3.5" />} label="Total chunks" value={record.manifest.totalChunks.toString()} />
            <MetaItem icon={<Hash className="h-3.5 w-3.5" />} label="Chunks acked" value={record.chunksAcked.length.toString()} />
          </div>

          <Separator />

          {/* Peer info */}
          <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground mb-1">Peer</p>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{record.peerAlias}</span>
              <Badge variant="outline" className="text-[10px] capitalize">
                {record.role}
              </Badge>
            </div>
          </div>

          {/* File list */}
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2">
              Files ({record.manifest.files.length})
            </p>
            <ScrollArea className="max-h-48 flux-scroll">
              <div className="space-y-1.5 pr-2">
                {record.manifest.files.map((file, i) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/40 p-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                      <FileIcon mime={file.type} name={file.name} className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{file.name}</p>
                      <p className="text-[10px] text-muted-foreground">{formatBytes(file.size)}</p>
                    </div>
                    <code className="text-[9px] font-mono text-muted-foreground hidden sm:block">
                      {file.checksum.slice(0, 12)}…
                    </code>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MetaItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-card/40 p-2.5">
      <div className="flex items-center gap-1 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-0.5 text-sm font-medium truncate">{value}</p>
    </div>
  )
}
