'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, X, AlertTriangle, ShieldCheck, BadgeCheck, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { formatBytes, fileTypeCategory } from '@/lib/fluxdrop/format'
import { FileIcon } from './file-icon'
import { isTrustedPeer } from '@/lib/fluxdrop/trusted-peers'
import { getTransferRecord } from '@/lib/fluxdrop/resume'
import { useTransferStore } from '@/stores/transfer-store'
import type { TransferManifest } from '@/lib/fluxdrop/protocol'
import { CONSTANTS } from '@/lib/fluxdrop/protocol'

interface ConsentDialogProps {
  manifest: TransferManifest | null
  peerAlias: string
  peerDeviceId?: string | null
  onAccept: (trust?: boolean) => void
  onReject: () => void
}

/**
 * Shows a consent dialog on the receiver side before accepting a transfer.
 * Displays the file list, total size, file count, and peer alias.
 * Validates against blocked extensions, size limits, and count limits.
 * Offers an opt-in "trust this device" shortcut for repeat peers.
 */
export function ConsentDialog({ manifest, peerAlias, peerDeviceId, onAccept, onReject }: ConsentDialogProps) {
  const [trust, setTrust] = useState(false)
  // v1.2 (4.4): rich previews streamed over the DataChannel while this dialog
  // is open (image thumbs + text first-lines). Hook-side `requestPreviews`
  // fires when the manifest lands; entries that never arrive render plain.
  const filePreviews = useTransferStore((s) => s.filePreviews)
  // Keyboard: Esc rejects (never silently accepts), Enter accepts via autoFocus.
  useEffect(() => {
    if (!manifest) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onReject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [manifest, onReject])
  // Partial-progress lookup: if we already stored chunks for this transferId
  // (previous interrupted attempt), tell the user the re-send will skip ahead.
  const [partial, setPartial] = useState<{ id: string; pct: number } | null>(null)
  useEffect(() => {
    if (!manifest) return
    let cancelled = false
    void (async () => {
      try {
        const rec = await getTransferRecord(manifest.transferId)
        if (cancelled) return
        const acked = rec?.chunksAcked?.length ?? 0
        const pct =
          acked > 0 && manifest.totalChunks > 0 && acked < manifest.totalChunks
            ? Math.round((acked / manifest.totalChunks) * 100)
            : 0
        setPartial({ id: manifest.transferId, pct })
      } catch { /* ignore — panel is best-effort */ }
    })()
    return () => { cancelled = true }
  }, [manifest])
  const partialPercent = manifest && partial?.id === manifest.transferId && partial.pct > 0
    ? partial.pct
    : null
  if (!manifest) return null
  const alreadyTrusted = !!peerDeviceId && isTrustedPeer(peerDeviceId)

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
    if ((CONSTANTS.BLOCKED_EXTENSIONS as readonly string[]).includes(ext)) {
      errors.push(`Blocked file type: "${f.name}" (${ext})`)
    }
  }
  const hasErrors = errors.length > 0

  return (
    <div className="pointer-events-auto fixed inset-0 z-[65] flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 24 }}
        className="flex max-h-full w-full max-w-md flex-col"
      >
        <Card className="flux-glass flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Header */}
          <div className="relative shrink-0 border-b border-border/50 p-5">
            {/* Incoming pulse — animated ring behind the shield icon */}
            <div className="pointer-events-none absolute left-[26px] top-[30px] h-10 w-10 rounded-lg bg-flux-500/20 animate-ping [animation-duration:2s]" aria-hidden />
            <div className="relative flex items-center gap-3">
              <div className={`relative flex h-10 w-10 items-center justify-center rounded-lg ${alreadyTrusted ? 'bg-flux-500/15 text-flux-600 dark:text-flux-400' : 'bg-flux-500/10 text-flux-600 dark:text-flux-400'}`}>
                {alreadyTrusted ? <BadgeCheck className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">Incoming transfer</h3>
                  {alreadyTrusted && (
                    <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300 text-[10px]">
                      <BadgeCheck className="mr-1 h-3 w-3" />
                      Trusted device
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground truncate">
                  From <span className="font-medium text-foreground">{peerAlias}</span>
                </p>
              </div>
            </div>
          </div>

          {/* Summary — flex-1 + min-h-0 so this section (never the action
              buttons) absorbs height pressure on short viewports */}
          <div className="flux-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
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

            {/* Partial-progress notice: a re-send of an interrupted transfer */}
            {partialPercent !== null && !hasErrors && (
              <div className="flex items-center gap-2.5 rounded-lg border border-flux-500/30 bg-flux-500/10 px-3 py-2">
                <RotateCcw className="h-4 w-4 shrink-0 text-flux-600 dark:text-flux-400" />
                <p className="text-xs leading-relaxed text-flux-700 dark:text-flux-300">
                  You already have <span className="font-semibold tabular-nums">{partialPercent}%</span> of this
                  transfer — accepting will skip ahead and only fetch the missing parts.
                </p>
              </div>
            )}

            {/* File list — native scroll: must NEVER overflow onto the
                trust row / Accept / Reject buttons (live regression once
                covered them and made the dialog undisposable) */}
            <div className="flux-scroll max-h-40 overflow-y-auto pr-1 sm:max-h-48">
              <div className="space-y-1.5">
                {manifest.files.map((f, i) => {
                  const cat = fileTypeCategory(f.type, f.name)
                  const pv = filePreviews[i]
                  return (
                    <div key={i} className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/40 p-2 transition-colors hover:border-flux-500/30 hover:bg-flux-500/5">
                      {pv?.blobUrl ? (
                        // Image thumbnail straight from the peer's head bytes.
                        <img
                          src={pv.blobUrl}
                          alt={`Preview of ${f.name}`}
                          loading="lazy"
                          className="h-10 w-10 shrink-0 rounded-md border border-border/50 bg-muted object-cover"
                        />
                      ) : (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <FileIcon mime={f.type} name={f.name} className="h-3.5 w-3.5" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium" title={f.relativePath || f.name}>
                          {f.relativePath || f.name}
                        </p>
                        <p className="text-[10px] text-muted-foreground">{formatBytes(f.size)}</p>
                        {pv?.text && !pv.blobUrl && (
                          <p className="truncate font-mono text-[10px] leading-3 text-muted-foreground" title={pv.text}>
                            {pv.text}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

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

            {/* Trust shortcut (only for not-yet-trusted devices) */}
            {!alreadyTrusted && peerDeviceId && (
              <label
                htmlFor="trust-device"
                className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/50 bg-muted/20 p-2.5 transition-colors hover:bg-muted/40"
              >
                <Checkbox
                  id="trust-device"
                  checked={trust}
                  onCheckedChange={(v) => setTrust(v === true)}
                />
                <div className="min-w-0">
                  <span className="text-xs font-medium">Trust this device</span>
                  <p className="text-[10px] text-muted-foreground">
                    Remember {peerAlias} — future transfers can be auto-accepted (enable in Settings → Privacy).
                  </p>
                </div>
              </label>
            )}

          </div>

          {/* Actions — pinned footer OUTSIDE the scrollable summary, so
              Reject / Accept are always visible and tappable no matter how
              many files the manifest lists or how short the viewport is */}
          <div className="flex shrink-0 gap-2 border-t border-border/50 px-5 py-4">
            <Button
              variant="outline"
              onClick={onReject}
              className="flex-1 text-destructive hover:bg-destructive/5"
            >
              <X className="mr-1.5 h-4 w-4" />
              Reject
            </Button>
            <Button
              onClick={() => onAccept(trust || undefined)}
              disabled={hasErrors}
              autoFocus
              className="flex-1 bg-flux-600 hover:bg-flux-700 text-white"
            >
              <Check className="mr-1.5 h-4 w-4" />
              Accept
            </Button>
          </div>
        </Card>
      </motion.div>
    </div>
  )
}
