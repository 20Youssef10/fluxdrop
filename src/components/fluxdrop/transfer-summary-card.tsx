'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, ShieldCheck, Clock, Database, FileStack, Gauge, Leaf, Copy, Check, FileArchive, Forward, Loader2, Route, Timer, Eraser } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { formatBytes, formatDuration, fileTypeCategory } from '@/lib/fluxdrop/format'
import { computeFileSkips } from '@/lib/fluxdrop/manifest'
import { getReceivedFilesFromCache } from '@/hooks/fluxdrop/use-fluxdrop'
import { buildZip, zipNameFor } from '@/lib/fluxdrop/zip'
import { FileIcon, getFileCategoryColors } from './file-icon'
import { toast } from 'sonner'
// v5-a3w: inline-fallback i18n for the delta-savings badge.
import { useT } from '@/lib/fluxdrop/i18n'

/** Clipboard write with a legacy fallback for restricted contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

interface TransferSummaryCardProps {
  onDone: () => void
  onSendAnother: () => void
}

/**
 * Shows a recap of the completed transfer with key stats.
 * Replaces the progress card when the transfer is COMPLETE.
 */
export function TransferSummaryCard({ onDone, onSendAnother }: TransferSummaryCardProps) {
  const t = useTransferStore()
  // v5-b1: the wipe-on-receiver action is sender-side only (the receiver's
  // own copy is out of OUR reach by design — its vault entry is what wipes).
  const isSender = useSessionStore((s) => s.view === 'sender')
  const [wipeAsked, setWipeAsked] = useState(false)
  // v5-a3w: i18n (the store owns the single-letter `t` in this component).
  const tr = useT()
  const m = t.manifest
  const [receiptCopied, setReceiptCopied] = useState(false)
  const [zipping, setZipping] = useState(false)
  // v4: receiver-side extras — verified blobs for zip (4.2), drag-out (5.3)
  // and onward sending (6.2). Sender devices (or after a reload) see none.
  const received = useMemo(
    () => (m ? getReceivedFilesFromCache(m.transferId) : null),
    [m]
  )

  // Per-file resume-skip breakdown — which portion of each file was already
  // on this device and never travelled the wire (resumed transfers only).
  // Hooks must run unconditionally — guard inside the memo instead.
  const fileSkips = useMemo(
    () => (m ? computeFileSkips(m, t.skippedIndices) : new Map()),
    [m, t.skippedIndices]
  )

  if (!m) return null

  const avgSpeed = t.elapsedMs > 0 ? (t.totalBytes / t.elapsedMs) * 1000 : 0
  const peakSpeed = t.speedHistory.length > 0 ? Math.max(...t.speedHistory) : 0
  const effectiveSpeed = t.speedBps || avgSpeed

  // Plain-text transfer receipt — handy for logging what was moved where.
  const copyReceipt = async () => {
    const lines = [
      'FluxDrop transfer receipt',
      `Date: ${new Date().toLocaleString()}`,
      `Files: ${m.files.length}`,
      ...m.files.map((f) => `  - ${f.name} (${formatBytes(f.size)})`),
      `Total: ${formatBytes(m.totalSize)}`,
      `Duration: ${formatDuration(t.elapsedMs)}`,
      `Avg speed: ${formatBytes(effectiveSpeed)}/s`,
      ...(peakSpeed > 0 ? [`Peak speed: ${formatBytes(peakSpeed)}/s`] : []),
      'Integrity: SHA-256 verified',
      ...(t.skippedChunks > 0
        ? [`Resume skips: ${t.skippedChunks} chunks · ${formatBytes(t.skippedBytes)} saved`]
        : []),
    ]
    const ok = await copyText(lines.join('\n'))
    if (ok) {
      setReceiptCopied(true)
      setTimeout(() => setReceiptCopied(false), 2000)
    } else {
      toast.error('Could not access the clipboard', {
        description: 'Your browser blocked clipboard access for this page.',
      })
    }
  }

  // v4 (4.2): zip-on-receive — one .zip for the whole transfer (STORE method,
  // checksums preserved byte-for-byte).
  const downloadZip = async () => {
    if (!received || !m) return
    setZipping(true)
    try {
      const blob = await buildZip(received.map((f) => ({ name: f.name, blob: f.blob })))
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = zipNameFor(m.files[0]?.name ?? 'fluxdrop')
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast.success('Zip archive downloaded', { description: `${received.length} files · STORE method (byte-exact).` })
    } catch (err: any) {
      toast.error('Could not build the zip', { description: err?.message ?? 'Unknown error' })
    } finally {
      setZipping(false)
    }
  }

  return (
    <Card className="flux-glass p-6 relative overflow-hidden">
      {/* Decorative gradient glow */}
      <div className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 h-32 w-64 rounded-full bg-flux-500/15 blur-3xl" />

      <div className="relative">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <motion.div
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 12 }}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-flux-500 shadow-lg shadow-flux-500/30"
          >
            <CheckCircle2 className="h-8 w-8 text-white" strokeWidth={2.5} />
          </motion.div>
          <div>
            <h3 className="text-xl font-bold">Transfer complete</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
                <ShieldCheck className="mr-1 h-3 w-3" />
                SHA-256 verified
              </Badge>
              {/* v5-a3w: delta-sync savings — only shown when a patch actually
                  saved bytes (set by BOTH sides at completion). */}
              {t.deltaSavedBytes > 0 && (
                <Badge
                  variant="outline"
                  className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300"
                  title="Delta sync sent only the changed bytes — the receiver reconstructed the rest from its kept copy"
                >
                  <Leaf className="mr-1 h-3 w-3" />
                  {tr('delta.badge', `Δ saved ${formatBytes(t.deltaSavedBytes)}`)}
                </Badge>
              )}
              {/* v5-a2: relay marker in the FINAL state too — ConnectionStatus
                  (which carries the live badge) is unmounted once the
                  transfer starts streaming, so without this the relay fact
                  would only ever flash in the pre-transfer waiting view. */}
              {t.relayed && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  title={tr(
                    'relay.tooltip',
                    'Direct connection was impossible — your end-to-end-encrypted chunks were relayed through the signaling server, rate-limited.',
                  )}
                >
                  <Route className="mr-1 h-3 w-3" />
                  {tr('relay.badge', 'Relayed via server')}
                </Badge>
              )}
              {/* v5-b1: disappearing transfer — the receiver's vault copy
                  auto-purges after the sender-requested TTL. */}
              {m.ttlMs != null && m.ttlMs > 0 && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 tabular-nums"
                  title="The receiver keeps this transfer in its vault only until the requested retention expires — then it auto-purges."
                >
                  <Timer className="mr-1 h-3 w-3" />
                  {tr('disappear.badge', `Disappears after ${formatTtl(m.ttlMs)}`)}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {m.files.length} file{m.files.length > 1 ? 's' : ''} · {formatBytes(m.totalSize)}
              </span>
            </div>
          </div>
        </div>

        {/* Stats recap grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <RecapStat
            icon={<FileStack className="h-4 w-4" />}
            label="Files"
            value={m.files.length.toString()}
          />
          <RecapStat
            icon={<Database className="h-4 w-4" />}
            label="Data"
            value={formatBytes(m.totalSize)}
          />
          <RecapStat
            icon={<Clock className="h-4 w-4" />}
            label="Duration"
            value={formatDuration(t.elapsedMs)}
          />
          <RecapStat
            icon={<Gauge className="h-4 w-4" />}
            label="Avg speed"
            value={formatBytes(effectiveSpeed) + '/s'}
          />
        </div>

        {/* Resume-skip note (only when the resume-skip bitmap saved bandwidth) */}
        {t.skippedChunks > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 rounded-lg border border-flux-500/30 bg-flux-500/5 p-3 text-xs text-muted-foreground flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <Leaf className="h-3.5 w-3.5 text-flux-500 shrink-0" />
              <span className="truncate">
                Resume skip — {t.skippedChunks} chunk{t.skippedChunks !== 1 ? 's' : ''} never re-sent
              </span>
            </span>
            <span className="font-mono font-semibold text-flux-600 dark:text-flux-400 shrink-0">
              {formatBytes(t.skippedBytes)} saved
            </span>
          </motion.div>
        )}

        {/* Peak speed note (only if we have history) */}
        {peakSpeed > 0 && (
          <div className="mb-6 rounded-lg border border-border/50 bg-card/40 p-3 text-xs text-muted-foreground flex items-center justify-between">
            <span>Peak speed during transfer</span>
            <span className="font-mono font-semibold text-foreground">{formatBytes(peakSpeed)}/s</span>
          </div>
        )}

        {/* File list summary (compact) — icons + per-file resume-skip badges */}
        <div className="mb-6 rounded-lg border border-border/50 bg-card/40 p-3 max-h-40 overflow-y-auto flux-scroll">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
            Files transferred
          </p>
          <div className="space-y-1.5">
            {m.files.map((f, i) => {
              const skip = fileSkips.get(i)
              const skipPct = skip && f.size > 0 ? Math.round((skip.skippedBytes / f.size) * 100) : 0
              const colors = getFileCategoryColors(f.type, f.name)
              const isImage = fileTypeCategory(f.type, f.name) === 'image'
              const cached = received?.[i]
              return (
                <div
                  key={i}
                  className="group flex items-center gap-2.5 rounded-md border border-transparent px-1.5 py-1 text-xs transition-colors hover:border-border/50 hover:bg-background/40"
                  draggable={!!cached}
                  onDragStart={(e) => {
                    // v4 (5.3): drag-out — received files drag straight into
                    // Finder/Explorer (Chrome desktop; harmless no-op elsewhere).
                    if (!cached) return
                    try {
                      const file = new File([cached.blob], cached.name, { type: cached.type || 'application/octet-stream' })
                      e.dataTransfer.setData('application/x-fluxdrop-file', cached.name)
                      e.dataTransfer.items.add(file)
                    } catch { /* DataTransfer File entries need a gesture context */ }
                  }}
                  title={cached ? `${f.name} — drag into a folder, or download below` : f.name}
                >
                  <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${colors.bg} ${colors.text}`}>
                    <FileIcon mime={f.type} name={f.name} className="h-3 w-3" />
                  </div>
                  <span className="truncate font-medium" title={f.name}>{f.name}</span>
                  {skipPct > 0 && (
                    <Badge
                      variant="outline"
                      className="hidden sm:inline-flex shrink-0 gap-0.5 border-flux-500/40 bg-flux-500/10 px-1.5 py-0 h-4 text-[9px] text-flux-700 dark:text-flux-300"
                      title={`${formatBytes(skip.skippedBytes)} of this file was already on this device and never re-sent`}
                    >
                      <Leaf className="h-2.5 w-2.5" />
                      {isImage ? `${skipPct}% local` : `${skipPct}% was already here`}
                    </Badge>
                  )}
                  <span className="text-muted-foreground shrink-0 ml-auto tabular-nums">{formatBytes(f.size)}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={copyReceipt}
            variant="ghost"
            className="sm:w-auto text-muted-foreground hover:text-foreground"
            title="Copy a text receipt of this transfer"
          >
            {receiptCopied ? (
              <>
                <Check className="mr-2 h-4 w-4 text-flux-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-2 h-4 w-4" />
                Copy receipt
              </>
            )}
          </Button>
          {/* v5-b1: sender-requested remote wipe — asks the receiver to purge
              its vault copy + resume cache + buffers over the still-open
              DataChannel. */}
          {isSender && (
            <Button
              onClick={() => {
                if (wipeAsked) return
                setWipeAsked(true)
                window.dispatchEvent(
                  new CustomEvent('fluxdrop:request-remote-wipe', { detail: { transferId: m.transferId } })
                )
              }}
              disabled={wipeAsked}
              variant="ghost"
              className="sm:w-auto text-muted-foreground hover:text-destructive"
              title="Ask the receiver to purge every stored copy of this transfer (vault entry, resume cache, buffers)"
            >
              <Eraser className="mr-2 h-4 w-4" />
              {wipeAsked ? 'Wipe requested' : 'Wipe on receiver'}
            </Button>
          )}
          <div className="flex-1 flex flex-col sm:flex-row gap-2">
            {/* v4 (4.2): zip-on-receive (receiver side, multi-file) */}
            {received && received.length > 1 && (
              <Button
                onClick={() => void downloadZip()}
                variant="outline"
                disabled={zipping}
                className="flex-1"
                title="Download every received file as a single .zip archive"
              >
                {zipping ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FileArchive className="mr-2 h-4 w-4" />
                )}
                Download .zip
              </Button>
            )}
            {/* v4 (6.2): relay-to-peer chaining — re-publish these verified
                files to a NEW device (explicit, consent-based mini-mesh). */}
            {received && received.length > 0 && (
              <Button
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('fluxdrop:send-onward', { detail: { transferId: m!.transferId } })
                  )
                }
                variant="outline"
                className="flex-1 border-flux-500/40 hover:bg-flux-500/10"
                title="Send these verified files onward to another device"
              >
                <Forward className="mr-2 h-4 w-4" />
                Send onward
              </Button>
            )}
            <Button
              onClick={onSendAnother}
              variant="outline"
              className="flex-1 border-flux-500/40 hover:bg-flux-500/10"
            >
              Send another
            </Button>
            <Button
              onClick={onDone}
              className="flex-1 bg-flux-600 hover:bg-flux-700 text-white"
            >
              Done
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

/** v5-b1: TTL in minutes → "1 min" / "10 min" / "1 hour" / "1 day". */
function formatTtl(ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60_000)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) {
    const h = Math.round(minutes / 60)
    return `${h} hour${h > 1 ? 's' : ''}`
  }
  const d = Math.round(minutes / 1440)
  return `${d} day${d > 1 ? 's' : ''}`
}

function RecapStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-3">
      <div className="flex items-center gap-1.5 text-flux-600 dark:text-flux-400">
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="mt-1 text-lg font-bold tabular-nums">{value}</p>
    </div>
  )
}
