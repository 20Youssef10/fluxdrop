'use client'

// v5-c7 (FEATURES-v5.md C7): kiosk / broadcast receive station.
//
// A fullscreen overlay for classrooms / events / TVs. The station MINTS
// pre-created share-link rooms (POST /link), joins its own room as receiver
// and shows a huge QR + PIN. Senders open the link (or type the code) and
// claim the room; incoming transfers are AUTO-ACCEPTED (trusted-only by
// default, everyone via the open-mode toggle) and saved straight to the
// Files vault — no pickers on a TV. After each transfer the station rotates
// to a FRESH room so the next sender can claim it. The wall shows everything
// received this run.

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { QRCodeCanvas } from 'qrcode.react'
import { CheckCircle2, Monitor, RefreshCw, ShieldCheck, X, Users, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { useKioskStore, type KioskSession } from '@/stores/kiosk-store'
import { useTransferStore } from '@/stores/transfer-store'
import { createShareLink } from '@/lib/fluxdrop/share-link'
import { formatBytes } from '@/lib/fluxdrop/format'
import { toast } from 'sonner'

interface KioskModeProps {
  /** Join a room as receiver (the station's own room). */
  onJoinRoom: (roomCode: string, pin: string) => void
  /** Full reset (leave room, tear down the session) — used on rotate/exit. */
  onReset: () => void
}

export function KioskMode({ onJoinRoom, onReset }: KioskModeProps) {
  const active = useKioskStore((s) => s.active)
  const acceptMode = useKioskStore((s) => s.acceptMode)
  const setAcceptMode = useKioskStore((s) => s.setAcceptMode)
  const session = useKioskStore((s) => s.session)
  const setSession = useKioskStore((s) => s.setSession)
  const minting = useKioskStore((s) => s.minting)
  const setMinting = useKioskStore((s) => s.setMinting)
  const wall = useKioskStore((s) => s.wall)
  const totalReceived = useKioskStore((s) => s.totalReceived)
  const closeKiosk = useKioskStore((s) => s.close)

  const transfer = useTransferStore()
  const rotatingRef = useRef(false)
  const [now, setNow] = useState(Date.now())
  // The manifest object that was current when the station opened — a
  // terminal state for IT is stale history (from before the kiosk), never a
  // fresh completion to wall + rotate on.
  const manifestAtOpenRef = useRef<unknown>(null)

  useEffect(() => {
    if (active) {
      manifestAtOpenRef.current = transfer.manifest
    }
  }, [active])

  // Live clock for the link-expiry countdown.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])

  /** Mint a fresh pre-created room and join it as the receiver. */
  const rotate = useCallback(async () => {
    if (rotatingRef.current) return
    rotatingRef.current = true
    try {
      setMinting(true)
      // Leave the previous room first (its sender may still be streaming —
      // rotation only runs at terminal states).
      onReset()
      const link = await createShareLink({ ttlMinutes: 60, oneJoin: false })
      // The QR is for SENDERS: the #claim deep link arms the pre-created room
      // on their device (pick files → Send claims it). #join would wrongly
      // route them to receiver mode.
      const claimUrl =
        typeof window !== 'undefined'
          ? `${window.location.origin}${window.location.pathname}#claim=${link.roomCode}&pin=${link.pin}`
          : link.url
      const next: KioskSession = {
        roomCode: link.roomCode,
        pin: link.pin,
        url: claimUrl,
        expiresAt: link.expiresAt,
      }
      setSession(next)
      onJoinRoom(link.roomCode, link.pin)
      console.log(`[FluxDrop] v5-c7 kiosk: room ${link.roomCode} minted + joined`)
    } catch (err: any) {
      toast.error('Kiosk could not create a room', { description: err?.message ?? 'The signaling server is unreachable.' })
    } finally {
      setMinting(false)
      rotatingRef.current = false
    }
  }, [onJoinRoom, onReset, setMinting, setSession])

  // Boot: mint the first room when the station opens.
  useEffect(() => {
    if (active && !session && !minting && !rotatingRef.current) {
      void rotate()
    }
  }, [active, session, minting, rotate])

  // Terminal states → wall entry + rotate to a fresh room (bounded delay so
  // the completion flash stays readable on the big screen).
  const st = transfer.transferState
  const lastTerminalRef = useRef<string | null>(null)
  useEffect(() => {
    if (!active) {
      lastTerminalRef.current = null
      return
    }
    if (st !== 'COMPLETE' && st !== 'FAILED' && st !== 'CANCELLED' && st !== 'ERROR') return
    // De-dupe: one wall entry + one rotation per terminal manifest.
    const key = `${st}:${transfer.manifest?.transferId ?? ''}`
    if (!transfer.manifest || lastTerminalRef.current === key) return
    // Stale history guard: a terminal state for a manifest that predates the
    // kiosk session is NOT a fresh completion (found in E2E: opening the
    // station right after a finished transfer rotated the room instantly).
    if (transfer.manifest === manifestAtOpenRef.current) return
    lastTerminalRef.current = key
    useKioskStore.getState().pushWall({
      id: transfer.manifest.transferId,
      name:
        transfer.manifest.files.length === 1
          ? transfer.manifest.files[0].name
          : `${transfer.manifest.files.length} files`,
      fileCount: transfer.manifest.files.length,
      totalSize: transfer.manifest.totalSize,
      at: Date.now(),
      status: st === 'COMPLETE' ? 'complete' : 'failed',
    })
    const failed = st !== 'COMPLETE'
    const t = setTimeout(() => void rotate(), failed ? 2500 : 6000)
    return () => clearTimeout(t)
  }, [st, active, transfer.manifest, rotate])

  const exit = useCallback(() => {
    onReset()
    closeKiosk()
  }, [onReset, closeKiosk])

  if (!active) return null

  const isLive = st === 'TRANSFERRING' || st === 'VERIFYING' || st === 'MANIFEST_EXCHANGE' || st === 'PAUSED'
  const pct = transfer.totalBytes > 0 ? Math.min(100, (transfer.bytesTransferred / transfer.totalBytes) * 100) : 0
  const expiryMin = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 60000)) : 0

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background text-foreground" role="dialog" aria-label="Kiosk receive station">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border/40 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-flux-500/15 text-flux-600 dark:text-flux-400">
            <Monitor className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h2 className="text-lg font-bold">FluxDrop Kiosk</h2>
            <p className="text-xs text-muted-foreground">
              Scan to send files here · {wall.length} received · {formatBytes(totalReceived)} this session
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {/* Accept whitelist */}
          <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
            {acceptMode === 'trusted' ? (
              <ShieldCheck className="h-4 w-4 text-flux-500" aria-hidden />
            ) : (
              <ShieldAlert className="h-4 w-4 text-amber-500" aria-hidden />
            )}
            <div className="text-left">
              <p className="text-[11px] font-medium leading-none">
                {acceptMode === 'trusted' ? 'Trusted devices only' : 'Everyone (open kiosk)'}
              </p>
              <p className="text-[10px] text-muted-foreground leading-none mt-0.5">
                {acceptMode === 'trusted' ? 'Auto-accept from devices you trusted before' : 'Auto-accept from anyone — use on trusted networks'}
              </p>
            </div>
            <Switch
              checked={acceptMode === 'all'}
              onCheckedChange={(v) => setAcceptMode(v ? 'all' : 'trusted')}
              aria-label="Accept from everyone"
            />
          </div>
          <Button variant="outline" size="icon" onClick={exit} aria-label="Exit kiosk mode">
            <X className="h-5 w-5" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Body: QR (left) + wall (right) */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        {/* QR panel */}
        <div className="flex flex-col items-center justify-center gap-5 p-6">
          {minting || !session ? (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <RefreshCw className="h-8 w-8 animate-spin" aria-hidden />
              <p className="text-sm">Minting a fresh room…</p>
            </div>
          ) : (
            <>
              <motion.div
                key={session.roomCode}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                className="rounded-2xl bg-white p-6 shadow-2xl"
              >
                <QRCodeCanvas value={session.url} size={260} marginSize={1} aria-label="QR code to send files to this kiosk" />
              </motion.div>
              <div className="text-center">
                <p className="text-sm text-muted-foreground">Room</p>
                <p className="font-mono text-4xl font-bold tracking-[0.2em]">{session.roomCode}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  PIN <span className="font-mono font-semibold text-foreground">{session.pin}</span> · link expires in {expiryMin} min
                </p>
              </div>
              <p className="max-w-sm text-center text-xs text-muted-foreground">
                Scan the QR (or open the link, then claim the room) and pick files on your phone — they land here
                automatically{acceptMode === 'trusted' ? ' once your device is trusted' : ''}. A fresh code appears after every transfer.
              </p>
            </>
          )}
        </div>

        {/* Progress wall */}
        <div className="flex min-h-0 flex-col gap-4 border-t border-border/40 p-6 lg:border-l lg:border-t-0">
          {/* Live transfer */}
          {isLive && transfer.manifest ? (
            <div className="rounded-xl border border-flux-500/40 bg-flux-500/5 p-5">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-flux-400 opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-flux-500" />
                  </span>
                  Receiving now
                </p>
                <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300 text-[10px]">
                  {transfer.manifest.files.length} file{transfer.manifest.files.length !== 1 ? 's' : ''} · {formatBytes(transfer.totalBytes)}
                </Badge>
              </div>
              <p className="mb-3 truncate text-xs text-muted-foreground" title={transfer.manifest.files[0]?.name}>
                {transfer.manifest.files.length === 1
                  ? transfer.manifest.files[0].name
                  : `from ${transfer.manifest.files[0]?.name} + ${transfer.manifest.files.length - 1} more`}
              </p>
              <Progress value={pct} className="h-3" />
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                <span>{pct.toFixed(0)}%</span>
                <span>{formatBytes(transfer.bytesTransferred)} / {formatBytes(transfer.totalBytes)}</span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/60 p-8 text-center">
              <Users className="mx-auto mb-2 h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">Waiting for a sender…</p>
              <p className="mt-1 text-xs text-muted-foreground">Everything received this session appears below.</p>
            </div>
          )}

          {/* Wall history */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto flux-scroll pr-1">
            {wall.map((e) => (
              <div
                key={e.id}
                className={`flex items-center gap-3 rounded-lg border p-3 ${
                  e.status === 'complete'
                    ? 'border-flux-500/30 bg-flux-500/5'
                    : 'border-destructive/30 bg-destructive/5'
                }`}
              >
                {e.status === 'complete' ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-flux-500" aria-hidden />
                ) : (
                  <X className="h-5 w-5 shrink-0 text-destructive" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatBytes(e.totalSize)} · {new Date(e.at).toLocaleTimeString()}
                  </p>
                </div>
                {e.status === 'complete' && (
                  <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300 text-[10px]">
                    in vault
                  </Badge>
                )}
              </div>
            ))}
            {wall.length === 0 && (
              <p className="pt-2 text-center text-[11px] text-muted-foreground">No transfers yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
