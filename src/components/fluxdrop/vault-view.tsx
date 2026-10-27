'use client'

// v1.3 (4.1): the received-files vault — everything FluxDrop kept for you.
// Entries live in OPFS (disk-backed) with IndexedDB metadata, LRU-evicted
// against a configurable budget. Search, per-file re-download, whole-transfer
// folder save, and per-entry deletion. Pure client component; fail-soft when
// OPFS is unavailable.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Archive, Search, Download, FolderDown, Trash2, ShieldCheck, HardDrive, ChevronDown } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSessionStore } from '@/stores/session-store'
import { listVault, getVaultFileBlob, deleteVaultEntry, vaultSupported, type VaultEntry } from '@/lib/fluxdrop/vault'
import { formatBytes } from '@/lib/fluxdrop/format'
import { saveFilesToDirectory, saveBlobWithPicker } from '@/lib/fluxdrop/file-io'
import { toast } from 'sonner'

export function VaultView() {
  const vaultEnabled = useSessionStore((s) => s.vaultEnabled)
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // SSR gate: OPFS checks + localStorage-backed prefs differ between server
  // and client, which would hydrate-mismatch. Render nothing until mounted.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const refresh = useCallback(async () => {
    if (!vaultSupported()) {
      setLoading(false)
      return
    }
    try {
      setEntries(await listVault())
    } catch {
      setEntries([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.files.some((f) => f.name.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q))
    )
  }, [entries, query])

  const totalBytes = entries.reduce((s, e) => s + e.totalSize, 0)

  const downloadFile = useCallback(async (entry: VaultEntry, fileIdx: number) => {
    const meta = entry.files[fileIdx]
    try {
      const blob = await getVaultFileBlob(entry, meta)
      if (!blob) throw new Error('file missing')
      await saveBlobWithPicker(blob, meta.name)
    } catch {
      toast.error('Could not read the stored file', { description: meta.name })
    }
  }, [])

  const downloadAll = useCallback(async (entry: VaultEntry) => {
    try {
      const files: { name: string; blob: Blob; relativePath: string }[] = []
      for (const meta of entry.files) {
        const blob = await getVaultFileBlob(entry, meta)
        if (!blob) continue
        files.push({ name: meta.name, blob, relativePath: meta.relativePath || meta.name })
      }
      if (files.length === 0) throw new Error('empty')
      const result = await saveFilesToDirectory(files)
      if (result === 'saved') toast.success(`Saved ${files.length} file${files.length > 1 ? 's' : ''} from the vault`)
    } catch {
      toast.error('Could not export this transfer from the vault')
    }
  }, [])

  const removeEntry = useCallback(async (entry: VaultEntry) => {
    try {
      await deleteVaultEntry(entry.transferId)
      setEntries((prev) => prev.filter((e) => e.transferId !== entry.transferId))
      toast.info('Removed from vault', { description: `${entry.fileCount} file${entry.fileCount > 1 ? 's' : ''} · ${formatBytes(entry.totalSize)}` })
    } catch {
      toast.error('Could not remove this entry')
    }
  }, [])

  if (!mounted || !vaultSupported() || !vaultEnabled) return null

  return (
    <Card className="flux-hover-border flux-glass p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-flux-500/15 text-flux-600 dark:text-flux-400">
            <Archive className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Files vault</h3>
            <p className="text-[11px] text-muted-foreground">
              {entries.length} transfer{entries.length !== 1 ? 's' : ''} · {formatBytes(totalBytes)} kept on this device
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 min-w-[180px] flex-1 sm:max-w-xs">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search received files…"
            aria-label="Search vault files"
            className="h-9"
          />
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading vault…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-8 text-center">
          <HardDrive className="mx-auto mb-2 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            {entries.length === 0
              ? 'Received transfers are kept here automatically — re-download them anytime, even offline.'
              : 'No files match your search.'}
          </p>
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto flux-scroll space-y-2 pr-1">
          <AnimatePresence initial={false}>
            {filtered.map((entry) => {
              const isOpen = expanded === entry.transferId
              return (
                <motion.div
                  key={entry.transferId}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="rounded-lg border border-border/50 bg-card/60"
                >
                  <div className="flex items-center gap-3 p-3">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : entry.transferId)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flux-500/60"
                      aria-expanded={isOpen}
                      aria-label={`Vault transfer with ${entry.fileCount} files`}
                    >
                      <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {entry.files.length === 1 ? entry.files[0].name : `${entry.files.length} files`}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {formatBytes(entry.totalSize)} · {new Date(entry.storedAt).toLocaleString()}
                        </p>
                      </div>
                    </button>
                    {entry.verified && (
                      <Badge variant="outline" className="shrink-0 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px]">
                        <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />
                        SHA-256 ✓
                      </Badge>
                    )}
                    <div className="flex shrink-0 items-center gap-1">
                      {entry.files.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9"
                          onClick={() => void downloadAll(entry)}
                          aria-label="Save all files to a folder"
                          title="Save all files to a folder"
                        >
                          <FolderDown className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground hover:text-destructive"
                        onClick={() => void removeEntry(entry)}
                        aria-label="Remove from vault"
                        title="Remove from vault"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden border-t border-border/40"
                    >
                      <div className="p-2 space-y-1">
                        {entry.files.map((meta, idx) => (
                          <div key={meta.relativePath || meta.name} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium">{meta.name}</p>
                              <p className="text-[10px] text-muted-foreground">{formatBytes(meta.size)}{meta.relativePath !== meta.name ? ` · ${meta.relativePath}` : ''}</p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => void downloadFile(entry, idx)}
                              aria-label={`Download ${meta.name}`}
                              title={`Download ${meta.name}`}
                            >
                              <Download className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}
    </Card>
  )
}
