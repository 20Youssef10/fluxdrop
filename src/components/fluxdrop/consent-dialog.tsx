'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { Check, X, AlertTriangle, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatBytes, fileTypeCategory } from '@/lib/fluxdrop/format'
import { FileIcon } from './file-icon'
import type { TransferManifest } from '@/lib/fluxdrop/protocol'
import { CONSTANTS } from '@/lib/fluxdrop/protocol'

interface ConsentDialogProps {
  manifest: TransferManifest | null
  peerAlias: string
  onAccept: () => void
  onReject: () => void
}

/**
 * Shows a consent dialog on the receiver side before accepting a transfer.
 * Displays the file list, total size, file count, and peer alias.
 * Validates against blocked extensions, size limits, and count limits.
 */
export function ConsentDialog({ manifest, peerAlias, onAccept, onReject }: ConsentDialogProps) {
  if (!manifest) return null

  // Validate the manifest on the receiver side (security enhancement).
  const errors: string[] = []
  if (manifest.files.length > CONSTANTS.MAX_FILES_PER_TRANSFER) {
    errors.push(`Too many files (max ${CONSTANTS.MAX_FILES_PER_TRANSFER})`)
  }
  if (manifest.totalSize > CONSTANTS.MAX_FILE_SIZE) {
    errors.push(`Total size exceeds limit (${formatBytes(CONSTANTS.MAX_FILE_SIZE)})`)
  }
  for (const f of manifest.files) {
    if (f.size > CONSTANTS.MAX_FILE_SIZE) {
      errors.push(`"${f.name}" exceeds max file size`)
    }
    const ext = '.' + (f.name.split('.').pop() || '').toLowerCase()
    if (CONSTANTS.BLOCKED_EXTENSIONS.includes(ext)) {
      errors.push(`Blocked file type: "${f.name}" (${ext})`)
    }
  }
  const hasErrors = errors.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 24 }}
        className="w-full max-w-md"
      >
        <Card className="flux-glass overflow-hidden">
          {/* Header */}
          <div className="border-b border-border/50 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-flux-500/10 text-flux-600 dark:text-flux-400">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold">Incoming transfer</h3>
                <p className="text-sm text-muted-foreground">
                  From <span className="font-medium text-foreground">{peerAlias}</span>
                </p>
              </div>
            </div>
          </div>

          {/* Summary */}
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border/50 bg-card/40 p-2.5 text-center">
                <p className="text-lg font-bold tabular-nums">{manifest.files.length}</p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Files</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-card/40 p-2.5 text-center">
                <p className="text-lg font-bold tabular-nums">{formatBytes(manifest.totalSize)}</p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</p>
              </div>
              <div className="rounded-lg border border-border/50 bg-card/40 p-2.5 text-center">
                <p className="text-lg font-bold tabular-nums">{manifest.totalChunks}</p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Chunks</p>
              </div>
            </div>

            {/* File list */}
            <ScrollArea className="max-h-48 flux-scroll">
              <div className="space-y-1.5 pr-2">
                {manifest.files.map((f, i) => {
                  const cat = fileTypeCategory(f.type, f.name)
                  return (
                    <div key={i} className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/40 p-2">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                        <FileIcon mime={f.type} name={f.name} className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" title={f.relativePath || f.name}>
                          {f.relativePath || f.name}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{formatBytes(f.size)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>

            {/* Validation errors */}
            {hasErrors && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    {errors.map((e, i) => (
                      <p key={i} className="text-xs text-destructive">• {e}</p>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2 border-t border-border/50">
              <Button
                variant="outline"
                onClick={onReject}
                className="flex-1 text-destructive hover:bg-destructive/5"
              >
                <X className="mr-1.5 h-4 w-4" />
                Reject
              </Button>
              <Button
                onClick={onAccept}
                disabled={hasErrors}
                className="flex-1 bg-flux-600 hover:bg-flux-700 text-white"
              >
                <Check className="mr-1.5 h-4 w-4" />
                Accept
              </Button>
            </div>
          </div>
        </Card>
      </motion.div>
    </div>
  )
}
