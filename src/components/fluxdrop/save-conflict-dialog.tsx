'use client'

// v1.2 (4.3): conflict-aware save dialog.
//
// Promise-based imperative controller: `resolveSaveConflicts()` can be called
// from ANY non-React context (e.g. the save pipeline inside useFluxDrop) and
// returns a promise that settles when the user confirms or cancels. The
// <SaveConflictDialogHost /> rendered once from page.tsx reads the module
// state and mounts the actual dialog — the hook never touches JSX.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Check, FileWarning, FolderSync, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SaveResolution } from '@/lib/fluxdrop/file-io'

export interface SaveConflictItem {
  fileName: string
  path: string
}

export type SaveConflictResolutions = Record<string, SaveResolution>
type Resolver = (result: SaveConflictResolutions | null) => void

// --- Module-level singleton state (the tiny event bus) ---
let openConflicts: SaveConflictItem[] | null = null
let activeResolver: Resolver | null = null
const listeners = new Set<() => void>()

function notifyListeners() {
  for (const l of listeners) l()
}

/**
 * Ask the user how to resolve conflicting target file names. Resolves with a
 * per-file resolution map keyed by `path`, or `null` when cancelled
 * (Esc / Cancel button / a newer request supersedes this one).
 */
export function resolveSaveConflicts(conflicts: SaveConflictItem[]): Promise<SaveConflictResolutions | null> {
  // A pending dialog must never strand its caller — settle it as cancelled.
  if (activeResolver) activeResolver(null)
  return new Promise<SaveConflictResolutions | null>((resolve) => {
    activeResolver = resolve
    openConflicts = conflicts
    notifyListeners()
  })
}

function settleDialog(result: SaveConflictResolutions | null) {
  const resolver = activeResolver
  activeResolver = null
  openConflicts = null
  notifyListeners()
  resolver?.(result)
}

const RESOLUTION_LABEL: Record<SaveResolution, string> = {
  rename: 'Auto-rename',
  overwrite: 'Overwrite',
  skip: 'Skip',
}

/**
 * Mount ONCE (page.tsx, next to <ConsentDialog />). Renders the conflict
 * dialog whenever `resolveSaveConflicts` is pending.
 */
export function SaveConflictDialogHost() {
  const [conflicts, setConflicts] = useState<SaveConflictItem[] | null>(null)
  useEffect(() => {
    const sync = () => setConflicts(openConflicts ? [...openConflicts] : null)
    sync()
    listeners.add(sync)
    return () => {
      listeners.delete(sync)
    }
  }, [])
  if (!conflicts) return null
  return <SaveConflictDialogView conflicts={conflicts} />
}

function SaveConflictDialogView({ conflicts }: { conflicts: SaveConflictItem[] }) {
  // Per-file choices keyed by path — Auto-rename is the safe default.
  const [choices, setChoices] = useState<SaveConflictResolutions>(() =>
    Object.fromEntries(conflicts.map((c) => [c.path, 'rename' as SaveResolution]))
  )
  const [applyAll, setApplyAll] = useState<string>('')

  const cancel = useCallback(() => settleDialog(null), [])
  const confirm = useCallback(() => settleDialog({ ...choices }), [choices])

  // Esc = cancel (never silently overwrite).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        settleDialog(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setChoice = (path: string, value: SaveResolution) =>
    setChoices((prev) => ({ ...prev, [path]: value }))

  const applyToAll = (value: SaveResolution) => {
    setApplyAll(value)
    setChoices(Object.fromEntries(conflicts.map((c) => [c.path, value])))
  }

  const skipped = Object.values(choices).filter((v) => v === 'skip').length
  const renamed = Object.values(choices).filter((v) => v === 'rename').length
  const overwritten = Object.values(choices).filter((v) => v === 'overwrite').length

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Resolve file name conflicts"
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 24 }}
        className="w-full max-w-md"
      >
        <Card className="flux-glass overflow-hidden">
          {/* Header */}
          <div className="relative border-b border-border/50 p-5">
            <div className="pointer-events-none absolute left-[26px] top-[30px] h-10 w-10 rounded-lg bg-amber-500/15 animate-ping [animation-duration:2s]" aria-hidden />
            <div className="relative flex items-center gap-3">
              <div className="relative flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <FolderSync className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold">Files already exist</h3>
                <p className="text-sm text-muted-foreground truncate">
                  {conflicts.length} of the incoming file{conflicts.length > 1 ? 's are' : ' is'} already in this folder
                </p>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="p-5 space-y-4">
            {/* Apply to all */}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
              <span className="text-xs font-medium">Apply to all conflicts</span>
              <Select value={applyAll} onValueChange={(v) => applyToAll(v as SaveResolution)}>
                <SelectTrigger className="h-7 w-[132px] text-xs" aria-label="Apply one choice to all conflicts">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(RESOLUTION_LABEL) as SaveResolution[]).map((r) => (
                    <SelectItem key={r} value={r} className="text-xs">
                      {RESOLUTION_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Per-file list */}
            <ScrollArea className="max-h-56 flux-scroll">
              <div className="space-y-1.5 pr-2">
                {conflicts.map((c) => (
                  <div
                    key={c.path}
                    className="flex items-center gap-2.5 rounded-md border border-amber-500/25 bg-amber-500/5 p-2 transition-colors hover:border-amber-500/40"
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      <FileWarning className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium" title={c.path}>
                        {c.path}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        &ldquo;{c.fileName}&rdquo; already exists in this folder
                      </p>
                    </div>
                    <Select
                      value={choices[c.path] ?? 'rename'}
                      onValueChange={(v) => setChoice(c.path, v as SaveResolution)}
                    >
                      <SelectTrigger className="h-7 w-[112px] shrink-0 text-xs" aria-label={`Resolution for ${c.fileName}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(RESOLUTION_LABEL) as SaveResolution[]).map((r) => (
                          <SelectItem key={r} value={r} className="text-xs">
                            {RESOLUTION_LABEL[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </ScrollArea>

            {/* Choice summary */}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>
                {renamed > 0 && <>{renamed} renamed</>}
                {renamed > 0 && (overwritten > 0 || skipped > 0) && ' · '}
                {overwritten > 0 && <>{overwritten} overwritten</>}
                {overwritten > 0 && skipped > 0 && ' · '}
                {skipped > 0 && <>{skipped} skipped</>}
                {renamed + overwritten + skipped === 0 && 'Choose how to handle each file'}
              </span>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2 border-t border-border/50">
              <Button
                variant="outline"
                onClick={cancel}
                className="flex-1 text-destructive hover:bg-destructive/5"
              >
                <X className="mr-1.5 h-4 w-4" />
                Cancel
              </Button>
              <Button
                onClick={confirm}
                autoFocus
                className="flex-1 bg-flux-600 hover:bg-flux-700 text-white"
              >
                <Check className="mr-1.5 h-4 w-4" />
                Save
              </Button>
            </div>
          </div>

          {/* Screen-reader summary */}
          <Badge variant="outline" className="sr-only">
            Save conflict resolution pending
          </Badge>
        </Card>
      </motion.div>
    </div>
  )
}
