'use client'

// v5-c6 (FEATURES-v5.md C6): the receiver-side pull-mode browser.
// When a sender shares a library instead of pushing a manifest, this panel
// replaces the "Waiting for sender" card: folder-grouped list with icons +
// image thumbs (PREVIEW over the DataChannel), multi-select, running total,
// and a one-tap Request that sends the sealed PULL_MSG.REQUEST.

import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, FolderOpen, Image as ImageIcon, Library, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { formatBytes, fileTypeCategory } from '@/lib/fluxdrop/format'
import { FileIcon, getFileCategoryColors } from './file-icon'

interface LibraryBrowserProps {
  onRequest: (indices: number[]) => void
}

export function LibraryBrowser({ onRequest }: LibraryBrowserProps) {
  const pendingLibrary = useSessionStore((s) => s.pendingLibrary)
  const libraryPreviews = useTransferStore((s) => s.libraryPreviews)
  const transferState = useTransferStore((s) => s.transferState)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [query, setQuery] = useState('')

  // Ask for image thumbs once per library (page.tsx bridges this event to
  // the hook's requestLibraryPreviews — components stay dumb). A ref, not
  // state: the request is a fire-once side effect, never render input.
  const requestedThumbsRef = useRef<string | null>(null)
  useEffect(() => {
    const lib = pendingLibrary
    if (!lib || requestedThumbsRef.current === lib.libraryId) return
    requestedThumbsRef.current = lib.libraryId
    window.dispatchEvent(new CustomEvent('fluxdrop:request-library-previews'))
  }, [pendingLibrary])

  const files = pendingLibrary?.files ?? []

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return files
    return files.filter(
      (f) => f.name.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q)
    )
  }, [files, query])

  // Group by top-level folder (relativePath minus the file name).
  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>()
    for (const f of filtered) {
      const rel = f.relativePath || f.name
      const parts = rel.split('/')
      const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
      const list = map.get(folder) ?? []
      list.push(f)
      map.set(folder, list)
    }
    return [...map.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
  }, [filtered])

  const selectedBytes = useMemo(
    () => files.filter((_, i) => selected.has(i)).reduce((s, f) => s + f.size, 0),
    [files, selected]
  )

  const requested = transferState === 'MANIFEST_EXCHANGE' && !pendingLibrary

  if (requested) {
    return (
      <Card className="flux-glass p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-flux-500/15 text-flux-600 dark:text-flux-400">
          <Library className="h-6 w-6 animate-pulse" aria-hidden />
        </div>
        <h3 className="text-base font-semibold">Request sent</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The sender is preparing your files — the transfer starts the moment they&apos;re hashed.
        </p>
        <Progress value={100} className="mt-4 h-1.5 flux-shimmer" />
      </Card>
    )
  }

  if (!pendingLibrary) return null

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  const toggleAllVisible = () => {
    const allVisible = new Set(filtered.map((f) => f.i))
    const allSelected = filtered.every((f) => selected.has(f.i))
    setSelected(allSelected ? new Set() : allVisible)
  }

  return (
    <Card className="flux-glass p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-flux-500/15 text-flux-600 dark:text-flux-400">
            <Library className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Shared library
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {files.length} file{files.length !== 1 ? 's' : ''} · {formatBytes(files.reduce((s, f) => s + f.size, 0))} — pick what you want
            </p>
          </div>
        </div>
        <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300 text-[10px]">
          Pull mode
        </Badge>
      </div>

      {/* Search + select-all */}
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            aria-label="Search shared library"
            className="h-9 w-full rounded-md border border-border/60 bg-card/50 px-3 text-xs outline-none focus:border-flux-500/50"
          />
        </div>
        <Button variant="outline" size="sm" className="h-9 shrink-0 text-[11px]" onClick={toggleAllVisible}>
          {filtered.length > 0 && filtered.every((f) => selected.has(f.i)) ? (
            <>
              <Square className="mr-1.5 h-3 w-3" aria-hidden />
              Clear
            </>
          ) : (
            <>
              <CheckSquare className="mr-1.5 h-3 w-3" aria-hidden />
              All
            </>
          )}
        </Button>
      </div>

      {/* Folder-grouped file list */}
      <div className="max-h-96 space-y-3 overflow-y-auto flux-scroll pr-1">
        {groups.map(([folder, list]) => (
          <div key={folder || '__root__'}>
            {folder && (
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <FolderOpen className="h-3 w-3" aria-hidden />
                {folder}
              </div>
            )}
            <div className="space-y-1">
              {list.map((f) => {
                const pv = libraryPreviews[f.i]
                const colors = getFileCategoryColors(f.type, f.name)
                const isImage = fileTypeCategory(f.type, f.name) === 'image'
                const isSel = selected.has(f.i)
                return (
                  <label
                    key={`${f.i}-${f.name}`}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-md border p-2 transition-colors ${
                      isSel
                        ? 'border-flux-500/50 bg-flux-500/10'
                        : 'border-border/40 bg-card/40 hover:border-flux-500/30'
                    }`}
                  >
                    <Checkbox
                      checked={isSel}
                      onCheckedChange={() => toggle(f.i)}
                      aria-label={`Select ${f.name}`}
                    />
                    {pv?.blobUrl ? (
                      <img
                        src={pv.blobUrl}
                        alt={`Thumbnail of ${f.name}`}
                        loading="lazy"
                        className="h-9 w-9 shrink-0 rounded-md border border-border/50 bg-muted object-cover"
                      />
                    ) : isImage ? (
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${colors.bg} ${colors.text}`}>
                        <ImageIcon className="h-4 w-4" aria-hidden />
                      </div>
                    ) : (
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${colors.bg} ${colors.text}`}>
                        <FileIcon mime={f.type} name={f.name} className="h-4 w-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={f.relativePath || f.name}>
                        {f.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatBytes(f.size)}
                        {f.lastModified > 0 ? ` · ${new Date(f.lastModified).toLocaleDateString()}` : ''}
                      </p>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">No files match your search.</p>
        )}
      </div>

      {/* Request action */}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/40 pt-3">
        <p className="text-[11px] text-muted-foreground">
          {selected.size === 0
            ? 'Select files to pull them from the sender.'
            : `${selected.size} selected · ${formatBytes(selectedBytes)}`}
        </p>
        <Button
          onClick={() => onRequest([...selected].sort((a, b) => a - b))}
          disabled={selected.size === 0}
          className="bg-flux-600 hover:bg-flux-700 text-white"
        >
          Request {selected.size > 0 ? `${selected.size} file${selected.size !== 1 ? 's' : ''}` : ''}
        </Button>
      </div>
    </Card>
  )
}
