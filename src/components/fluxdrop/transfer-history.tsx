'use client'

import { useEffect, useState } from 'react'
import { History, Trash2, ArrowUp, ArrowDown, CheckCircle2, AlertCircle, RotateCcw, Info } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { listTransfers, deleteTransferRecord, type StoredTransfer } from '@/lib/fluxdrop/resume'
import { formatBytes } from '@/lib/fluxdrop/format'
import { toast } from 'sonner'
import { TransferDetailDialog } from './transfer-detail-dialog'

interface TransferHistoryProps {
  onResume?: (record: StoredTransfer) => void
}

export function TransferHistory({ onResume }: TransferHistoryProps) {
  const [records, setRecords] = useState<StoredTransfer[]>([])
  const [selected, setSelected] = useState<StoredTransfer | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const recs = await listTransfers()
        if (!cancelled) setRecords(recs.slice(0, 20))
      } catch {
        /* ignore */
      }
    }
    load()
    const id = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const remove = async (id: string) => {
    await deleteTransferRecord(id)
    toast.success('Record removed')
    loadRefresh()
  }

  const loadRefresh = async () => {
    try {
      const recs = await listTransfers()
      setRecords(recs.slice(0, 20))
    } catch {
      /* ignore */
    }
  }

  const showDetail = (rec: StoredTransfer) => {
    setSelected(rec)
    setDetailOpen(true)
  }

  const handleResume = (rec: StoredTransfer) => {
    if (onResume) {
      onResume(rec)
    } else {
      toast.info('Resume not available', {
        description: 'Partial transfer resume requires the original peer to be online.',
      })
    }
  }

  if (records.length === 0) {
    return (
      <Card className="flux-glass p-5">
        <div className="flex items-center gap-2 mb-3">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Recent transfers
          </h3>
        </div>
        <div className="relative overflow-hidden rounded-lg border border-dashed border-border/60 p-8 text-center">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-[0.04]">
            <ArrowUp className="h-24 w-24 rotate-45" />
          </div>
          <div className="relative">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-flux-500/10 text-flux-600 dark:text-flux-400">
              <History className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium">No transfers yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
              Your transfer history will appear here, stored locally in your browser via IndexedDB.
              Start by sending or receiving a file.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <>
      <Card className="flux-glass p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Recent transfers
            </h3>
          </div>
          <Badge variant="outline" className="text-[10px]">
            {records.length}
          </Badge>
        </div>
        <ScrollArea className="max-h-80 flux-scroll">
          <div className="space-y-2 pr-2">
            {records.map((rec) => {
              const isResumable =
                rec.status !== 'COMPLETE' &&
                rec.status !== 'CANCELLED' &&
                rec.chunksAcked.length < rec.manifest.totalChunks
              return (
                <div
                  key={rec.transferId}
                  className="group flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 p-3 hover:border-flux-500/30 transition-colors"
                >
                  <button
                    onClick={() => showDetail(rec)}
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md cursor-pointer ${
                      rec.role === 'sender'
                        ? 'bg-flux-500/10 text-flux-600 dark:text-flux-400'
                        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    }`}
                    aria-label="View details"
                  >
                    {rec.role === 'sender' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => showDetail(rec)}
                    className="min-w-0 flex-1 text-left cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {rec.manifest.files.length === 1
                          ? rec.manifest.files[0].name
                          : `${rec.manifest.files.length} files`}
                      </p>
                      {rec.status === 'COMPLETE' && (
                        <CheckCircle2 className="h-3.5 w-3.5 text-flux-500 shrink-0" />
                      )}
                      {rec.status === 'FAILED' || rec.status === 'ERROR' ? (
                        <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      <span>{formatBytes(rec.manifest.totalSize)}</span>
                      <span>·</span>
                      <span className="capitalize">{rec.role}</span>
                      <span>·</span>
                      <span>{rec.peerAlias}</span>
                      <span>·</span>
                      <span>{formatRelative(rec.updatedAt)}</span>
                    </div>
                  </button>
                  {/* Progress bar for incomplete transfers */}
                  {rec.status !== 'COMPLETE' && rec.manifest.totalChunks > 0 && (
                    <div className="hidden sm:block w-16 shrink-0">
                      <div className="h-1 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-flux-500 rounded-full transition-all"
                          style={{
                            width: `${(rec.chunksAcked.length / rec.manifest.totalChunks) * 100}%`,
                          }}
                        />
                      </div>
                      <p className="text-[9px] text-muted-foreground text-center mt-0.5">
                        {Math.round((rec.chunksAcked.length / rec.manifest.totalChunks) * 100)}%
                      </p>
                    </div>
                  )}
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {isResumable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleResume(rec)}
                        className="h-7 w-7 text-flux-600 dark:text-flux-400 hover:bg-flux-500/10"
                        aria-label="Resume transfer"
                        title="Resume transfer"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => showDetail(rec)}
                      className="h-7 w-7 text-muted-foreground hover:bg-muted/50"
                      aria-label="View details"
                      title="View details"
                    >
                      <Info className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => remove(rec.transferId)}
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label="Delete record"
                      title="Delete record"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </Card>

      <TransferDetailDialog
        record={selected}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </>
  )
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}
