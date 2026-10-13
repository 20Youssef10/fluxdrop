'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { History, Trash2, ArrowUp, ArrowDown, CheckCircle2, AlertCircle, RotateCcw, Info, Download, Upload, FileJson, CheckSquare, Square, Search, X, Leaf } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { listTransfers, deleteTransferRecord, saveTransferRecord, type StoredTransfer } from '@/lib/fluxdrop/resume'
import { formatBytes } from '@/lib/fluxdrop/format'
import { CONSTANTS, type TransferState, type DeviceRole } from '@/lib/fluxdrop/protocol'
import { toast } from 'sonner'
import { TransferDetailDialog } from './transfer-detail-dialog'
import { motion, AnimatePresence } from 'framer-motion'

type FilterTab = 'all' | 'sent' | 'received' | 'complete' | 'incomplete'

interface TransferHistoryProps {
  onResume?: (record: StoredTransfer) => void
}

export function TransferHistory({ onResume }: TransferHistoryProps) {
  const [records, setRecords] = useState<StoredTransfer[]>([])
  const [selected, setSelected] = useState<StoredTransfer | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const loadRefresh = useCallback(async () => {
    try {
      const recs = await listTransfers()
      setRecords(recs.slice(0, 50))
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const recs = await listTransfers()
        if (!cancelled) setRecords(recs.slice(0, 50))
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

  const filteredRecords = useMemo(() => {
    let result = records
    // Apply tab filter
    switch (activeFilter) {
      case 'sent': result = result.filter((r) => r.role === 'sender'); break
      case 'received': result = result.filter((r) => r.role === 'receiver'); break
      case 'complete': result = result.filter((r) => r.status === 'COMPLETE'); break
      case 'incomplete': result = result.filter((r) => r.status !== 'COMPLETE' && r.status !== 'CANCELLED'); break
    }
    // Apply search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      result = result.filter((r) =>
        r.manifest.files.some((f) => f.name.toLowerCase().includes(q)) ||
        r.peerAlias.toLowerCase().includes(q) ||
        r.transferId.toLowerCase().includes(q)
      )
    }
    return result
  }, [records, activeFilter, searchQuery])

  const filterCounts = useMemo(() => ({
    all: records.length,
    sent: records.filter((r) => r.role === 'sender').length,
    received: records.filter((r) => r.role === 'receiver').length,
    complete: records.filter((r) => r.status === 'COMPLETE').length,
    incomplete: records.filter((r) => r.status !== 'COMPLETE' && r.status !== 'CANCELLED').length,
  }), [records])

  const remove = async (id: string) => {
    await deleteTransferRecord(id)
    toast.success('Record removed')
    loadRefresh()
  }

  const showDetail = (rec: StoredTransfer) => {
    if (selectMode) {
      toggleSelect(rec.transferId)
      return
    }
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

  const handleRedownload = (rec: StoredTransfer) => {
    if (rec.role !== 'receiver' || rec.status !== 'COMPLETE') return
    toast.info('Re-download requires the sender', {
      description: 'Ask the sender to re-send the files, or check your downloads folder.',
    })
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return
    const count = selectedIds.size
    for (const id of selectedIds) {
      await deleteTransferRecord(id)
    }
    toast.success(`${count} record${count > 1 ? 's' : ''} removed`)
    exitSelectMode()
    loadRefresh()
  }

  const exportHistory = () => {
    if (records.length === 0) {
      toast.info('No transfers to export')
      return
    }
    const exportData = {
      app: 'fluxdrop',
      schema: 2,
      exportedAt: new Date().toISOString(),
      records: records.map((r) => ({
        transferId: r.transferId,
        role: r.role,
        status: r.status,
        peerAlias: r.peerAlias,
        startedAt: new Date(r.startedAt).toISOString(),
        updatedAt: new Date(r.updatedAt).toISOString(),
        finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
        totalSize: r.manifest.totalSize,
        totalChunks: r.manifest.totalChunks,
        chunkSize: r.manifest.chunkSize,
        fileCount: r.manifest.files.length,
        files: r.manifest.files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        chunksAckedCount: r.chunksAcked.length,
        bytesTransferred: r.bytesTransferred,
        checksumVerified: r.checksumVerified ?? null,
        resumedAt: r.resumedAt ? new Date(r.resumedAt).toISOString() : null,
        resumedSavedBytes: r.resumedSavedBytes ?? null,
      })),
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fluxdrop-history-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success('History exported', { description: `${records.length} records as JSON` })
  }

  /**
   * Import history records from a previously exported JSON file. Merges by
   * transferId (existing records always win) — imported entries are metadata
   * only (no chunks/files), so they are never resumable.
   */
  const importHistory = async (file: File) => {
    if (importing) return
    setImporting(true)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as unknown
      // Accept both the schema-2 wrapper and a bare array (schema 1 exports).
      const rawRecords: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown[] }).records)
          ? (parsed as { records: unknown[] }).records
          : []
      if (rawRecords.length === 0) {
        toast.error('Nothing to import', { description: 'No transfer records found in that file.' })
        return
      }
      if (rawRecords.length > 500) {
        toast.error('File too large', { description: 'Maximum 500 records per import.' })
        return
      }
      const existing = new Set((await listTransfers()).map((r) => r.transferId))
      let imported = 0
      let duplicates = 0
      let invalid = 0
      for (const raw of rawRecords) {
        const rec = normalizeImportedRecord(raw)
        if (!rec) { invalid++; continue }
        if (existing.has(rec.transferId)) { duplicates++; continue }
        await saveTransferRecord(rec)
        existing.add(rec.transferId)
        imported++
      }
      const parts = [`${imported} imported`]
      if (duplicates > 0) parts.push(`${duplicates} duplicate${duplicates !== 1 ? 's' : ''} skipped`)
      if (invalid > 0) parts.push(`${invalid} invalid skipped`)
      if (imported > 0) {
        toast.success('History imported', { description: parts.join(' · ') })
      } else {
        toast.info('Nothing new to import', { description: parts.join(' · ') })
      }
      loadRefresh()
    } catch {
      toast.error('Import failed', { description: 'That file is not a valid FluxDrop history export.' })
    } finally {
      setImporting(false)
      // Reset the input so re-importing the same file works.
      if (fileInputRef.current) fileInputRef.current.value = ''
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
            {/* Import from a previous export — right in the empty state. */}
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                <Upload className="mr-1.5 h-3 w-3" />
                {importing ? 'Importing…' : 'Import history'}
              </Button>
            </div>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Import history from JSON"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void importHistory(f)
          }}
        />
      </Card>
    )
  }

  const FILTER_TABS: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'sent', label: 'Sent' },
    { key: 'received', label: 'Received' },
    { key: 'complete', label: 'Complete' },
    { key: 'incomplete', label: 'Incomplete' },
  ]

  return (
    <>
      <Card className="flux-glass p-5">
        {/* Header with actions */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Recent transfers
            </h3>
            <Badge variant="outline" className="text-[10px]">
              {filteredRecords.length}{activeFilter !== 'all' ? `/${records.length}` : ''}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              title="Import from a FluxDrop history export"
            >
              <Upload className="h-3.5 w-3.5" />
              <span className="hidden sm:inline ml-1">{importing ? 'Importing…' : 'Import'}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={exportHistory}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              title="Export as JSON"
            >
              <FileJson className="h-3.5 w-3.5" />
              <span className="hidden sm:inline ml-1">Export</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (selectMode) exitSelectMode()
                else setSelectMode(true)
              }}
              className={`h-7 text-xs ${selectMode ? 'text-flux-600 dark:text-flux-400' : 'text-muted-foreground hover:text-foreground'}`}
              title={selectMode ? 'Exit select mode' : 'Select records'}
            >
              {selectMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline ml-1">{selectMode ? 'Done' : 'Select'}</span>
            </Button>
          </div>
        </div>

        {/* Filter tabs + search */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 mb-3">
          <div className="flex items-center gap-1 overflow-x-auto flux-scroll pb-1 flex-1">
            {FILTER_TABS.map((tab) => {
              const count = filterCounts[tab.key]
              if (count === 0 && tab.key !== 'all') return null
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveFilter(tab.key)}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                    activeFilter === tab.key
                      ? 'bg-flux-500/15 text-flux-600 dark:text-flux-400 border border-flux-500/30'
                      : 'bg-muted/40 text-muted-foreground border border-transparent hover:bg-muted/60'
                  }`}
                >
                  {tab.label}
                  <span className="ml-1 opacity-60">{count}</span>
                </button>
              )
            })}
          </div>
          {/* Search input */}
          <div className="relative shrink-0 w-full sm:w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files…"
              className="h-8 pl-8 pr-7 text-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Batch action bar */}
        <AnimatePresence>
          {selectMode && selectedIds.size > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden mb-3"
            >
              <div className="flex items-center justify-between rounded-lg border border-flux-500/30 bg-flux-500/5 p-2.5">
                <span className="text-xs font-medium text-flux-600 dark:text-flux-400">
                  {selectedIds.size} selected
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedIds(new Set(filteredRecords.map((r) => r.transferId)))}
                    className="h-7 text-xs"
                  >
                    Select all
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedIds(new Set())}
                    className="h-7 text-xs"
                  >
                    Clear
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={bulkDelete}
                    className="h-7 text-xs text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <ScrollArea className="max-h-80 flux-scroll">
          <div className="space-y-2 pr-2">
            {filteredRecords.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
                <p className="text-xs text-muted-foreground">
                  {searchQuery
                    ? `No records match "${searchQuery}"`
                    : 'No records match this filter'}
                </p>
              </div>
            ) : (
              filteredRecords.map((rec, index) => {
                // Incomplete transfers AND cancelled sends are resumable —
                // the sender's files stay persisted until the transfer completes.
                const isResumable =
                  rec.status !== 'COMPLETE' &&
                  (rec.status !== 'CANCELLED' || rec.role === 'sender') &&
                  rec.chunksAcked.length < rec.manifest.totalChunks
                const isSelected = selectedIds.has(rec.transferId)
                return (
                  <div
                    key={rec.transferId}
                    className={`group flux-slide-up flex items-center gap-3 rounded-lg border p-3 transition-all ${
                      selectMode && isSelected
                        ? 'border-flux-500/40 bg-flux-500/5'
                        : 'border-border/50 bg-card/60 hover:border-flux-500/30'
                    }`}
                  >
                    {/* Selection checkbox (select mode) */}
                    {selectMode && (
                      <button
                        onClick={() => toggleSelect(rec.transferId)}
                        className="shrink-0"
                        aria-label={isSelected ? 'Deselect' : 'Select'}
                      >
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-flux-500" />
                        ) : (
                          <Square className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                    )}
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
                        <p className="truncate text-sm font-medium" title={rec.manifest.files.map((f) => f.name).join(' · ')}>
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
                        {rec.resumedAt && rec.status !== 'COMPLETE' && (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-flux-500/40 bg-flux-500/10 text-[9px] uppercase tracking-wide px-1.5 py-0 text-flux-600 dark:text-flux-400"
                          >
                            <RotateCcw className="mr-0.5 h-2.5 w-2.5" />
                            Resumed
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                        <span>{formatBytes(rec.manifest.totalSize)}</span>
                        <span>·</span>
                        <span className="capitalize">{rec.role}</span>
                        <span>·</span>
                        <span>{rec.peerAlias}</span>
                        <span>·</span>
                        <span>{formatRelative(rec.updatedAt)}</span>
                        {!!rec.resumedSavedBytes && rec.resumedSavedBytes > 0 && (
                          <span className="hidden sm:inline-flex items-center gap-0.5 text-flux-600 dark:text-flux-400 font-medium">
                            <Leaf className="h-2.5 w-2.5" aria-hidden />
                            {formatBytes(rec.resumedSavedBytes)} saved
                          </span>
                        )}
                      </div>
                    </button>
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
                    {!selectMode && (
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
                        {rec.role === 'receiver' && rec.status === 'COMPLETE' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRedownload(rec)}
                            className="h-7 w-7 text-flux-600 dark:text-flux-400 hover:bg-flux-500/10"
                            aria-label="Re-download"
                            title="Re-download"
                          >
                            <Download className="h-3.5 w-3.5" />
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
                    )}
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      </Card>

      <TransferDetailDialog
        record={selected}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />

      {/* Shared import input (main view) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Import history from JSON"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void importHistory(f)
        }}
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

interface ExportedRecordV2 {
  transferId?: unknown
  role?: unknown
  status?: unknown
  peerAlias?: unknown
  startedAt?: unknown
  updatedAt?: unknown
  finishedAt?: unknown
  chunkSize?: unknown
  files?: unknown
  bytesTransferred?: unknown
  checksumVerified?: unknown
  resumedAt?: unknown
  resumedSavedBytes?: unknown
}

/**
 * Validate + convert one exported record into a StoredTransfer. Returns null
 * for entries that are structurally invalid. The reconstructed manifest is
 * metadata-only (no checksums/paths), so imported records are never resumable —
 * totalChunks is set to 0 which disables progress bars and resume actions.
 */
function normalizeImportedRecord(raw: unknown): StoredTransfer | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as ExportedRecordV2
  if (typeof r.transferId !== 'string' || r.transferId.length === 0 || r.transferId.length > 128) return null
  const role = r.role === 'sender' || r.role === 'receiver' ? (r.role as DeviceRole) : null
  if (role !== 'sender' && role !== 'receiver') return null
  const VALID_STATES: readonly string[] = ['MANIFEST_EXCHANGE', 'TRANSFERRING', 'VERIFYING', 'COMPLETE', 'CANCELLED', 'FAILED', 'ERROR', 'PAUSED']
  const status = typeof r.status === 'string' && VALID_STATES.includes(r.status) ? (r.status as TransferState) : null
  if (!status) return null
  if (!Array.isArray(r.files) || r.files.length === 0 || r.files.length > 200) return null
  const files = r.files
    .filter((f): f is { name: string; size: number; type: string } =>
      !!f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string' && typeof (f as { size?: unknown }).size === 'number' && (f as { size: number }).size >= 0)
    .map((f) => ({
      name: f.name.slice(0, 512),
      size: f.size,
      type: typeof f.type === 'string' ? f.type.slice(0, 128) : '',
      lastModified: 0,
      checksum: '',
      relativePath: f.name.slice(0, 512),
    }))
  if (files.length === 0) return null
  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const startedAt = typeof r.startedAt === 'string' && !Number.isNaN(Date.parse(r.startedAt)) ? Date.parse(r.startedAt) : Date.now()
  const updatedAt = typeof r.updatedAt === 'string' && !Number.isNaN(Date.parse(r.updatedAt)) ? Date.parse(r.updatedAt) : startedAt
  const finishedAt = typeof r.finishedAt === 'string' && !Number.isNaN(Date.parse(r.finishedAt)) ? Date.parse(r.finishedAt) : undefined
  const resumedAt = typeof r.resumedAt === 'string' && !Number.isNaN(Date.parse(r.resumedAt)) ? Date.parse(r.resumedAt) : undefined
  const resumedSavedBytes = typeof r.resumedSavedBytes === 'number' && r.resumedSavedBytes > 0 ? r.resumedSavedBytes : undefined
  return {
    transferId: r.transferId,
    role,
    manifest: {
      transferId: r.transferId,
      version: 1,
      files,
      totalSize,
      totalChunks: 0,
      chunkSize: typeof r.chunkSize === 'number' && r.chunkSize > 0 ? r.chunkSize : CONSTANTS.CHUNK_SIZE,
      createdAt: startedAt,
      expiresAt: startedAt + 24 * 60 * 60 * 1000,
    },
    status,
    chunksAcked: [],
    bytesTransferred: typeof r.bytesTransferred === 'number' && r.bytesTransferred >= 0 ? Math.min(r.bytesTransferred, totalSize) : status === 'COMPLETE' ? totalSize : 0,
    peerAlias: typeof r.peerAlias === 'string' && r.peerAlias.trim() ? r.peerAlias.slice(0, 64) : 'peer',
    peerDeviceId: '',
    startedAt,
    updatedAt,
    finishedAt,
    checksumVerified: r.checksumVerified === true ? true : undefined,
    resumedAt,
    resumedSavedBytes,
  }
}
