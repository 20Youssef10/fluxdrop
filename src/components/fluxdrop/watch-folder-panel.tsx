'use client'

// v5-a6: Watch folder + scheduled send — a compact card in the sender flow
// (mounted by sender-panel.tsx, always visible while in sender view).
//
// State machine:
//  - status: idle → (pick) → paused ⇄ watching, or needs-permission whenever
//    Chrome revoked the folder grant (re-grant requires a click = gesture).
//  - queue: watch events land in a VISIBLE pending queue (File objects in
//    memory only — metadata mirrored to IndexedDB, cleared on mount because
//    the previous tab's Files are gone).
//  - sending paths (all funnel through dispatchSend):
//      1. manual — "Send queued files" button (works with or without a room)
//      2. auto   — "Auto-send when session is live" pref + sender view with
//                  an OPEN room + no transfer in flight
//      3. scheduled — daily/one-shot clock; sends like (2), otherwise toasts
//                  the queued count as a reminder
//  - when a room is already open, dispatch mirrors the sender queue editor's
//    refresh dance: cancel the room, then startSend with the full queue 400ms
//    later so the fresh manifest covers every queued file.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarClock,
  Clock,
  FilePlus2,
  FolderOpen,
  FolderSync,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/lib/fluxdrop/i18n'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { formatBytes } from '@/lib/fluxdrop/format'
import { CONSTANTS } from '@/lib/fluxdrop/protocol'
import {
  clearQueueMeta,
  ensurePermission,
  loadPersistedFolder,
  pickFolder,
  saveQueueMeta,
  startWatching,
  watchFolderSupported,
  type WatchEvent,
} from '@/lib/fluxdrop/watch-folder'

interface WatchFolderPanelProps {
  /** Same entry point the file picker's "Create transfer room" uses. */
  onStartSend: (files: File[]) => void
  /** Cancels/closes the live room (same prop the sender flow passes around). */
  onCancel: () => void
}

type WatchStatus = 'idle' | 'paused' | 'needs-permission' | 'watching'

interface FeedRow {
  kind: 'added' | 'changed'
  name: string
  size: number
  at: number
}

interface QueueRow {
  file: File
  name: string
  size: number
  addedAt: number
}

/** Transfer states where a startSend would collide with the live engine. */
const BUSY_STATES: ReadonlySet<string> = new Set([
  'VALIDATING',
  'PAIRING',
  'CONNECTING',
  'RETRYING',
  'MANIFEST_EXCHANGE',
  'TRANSFERRING',
  'PAUSED',
  'RESUMING',
  'VERIFYING',
])

function parseHHMM(v: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return { h, m }
}

/** Next occurrence of the HH:MM slot strictly after `now`. */
function nextFireTs(now: number, h: number, m: number): number {
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function WatchFolderPanel({ onStartSend, onCancel }: WatchFolderPanelProps) {
  const t = useT()
  const supported = watchFolderSupported()

  const [status, setStatus] = useState<WatchStatus>('idle')
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null)
  const [feed, setFeed] = useState<FeedRow[]>([])
  const [queue, setQueue] = useState<QueueRow[]>([])
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const stopRef = useRef<(() => void) | null>(null)
  /** Guards the cancel→re-send settle window against a second auto dispatch. */
  const lastDispatchAtRef = useRef(0)
  const lastFiredRef = useRef(0)
  const armedAtRef = useRef(Date.now())

  // prefs (v5-a6)
  const watchAutoSend = usePrefsStore((s) => s.watchAutoSend)
  const setWatchAutoSend = usePrefsStore((s) => s.setWatchAutoSend)
  const scheduleEnabled = usePrefsStore((s) => s.scheduleEnabled)
  const setScheduleEnabled = usePrefsStore((s) => s.setScheduleEnabled)
  const scheduleTime = usePrefsStore((s) => s.scheduleTime)
  const setScheduleTime = usePrefsStore((s) => s.setScheduleTime)
  const scheduleDaily = usePrefsStore((s) => s.scheduleDaily)
  const setScheduleDaily = usePrefsStore((s) => s.setScheduleDaily)

  // session / transfer state — "session live" = sender view with an open room
  const view = useSessionStore((s) => s.view)
  const roomId = useSessionStore((s) => s.roomId)
  const transferState = useTransferStore((s) => s.transferState)
  const isBusy = BUSY_STATES.has(transferState)
  const sessionLive = view === 'sender' && !!roomId
  const canAutoSend =
    watchAutoSend && sessionLive && !isBusy && transferState !== 'FAILED' && transferState !== 'ERROR'

  // ---- restore persisted folder (grant usually survives in Chrome) ----
  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Stale queue metadata only — the File objects died with the last tab.
      await clearQueueMeta()
      if (!supported) return
      const handle = await loadPersistedFolder()
      if (cancelled || !handle) return
      setFolder(handle)
      const granted = await ensurePermission(handle)
      if (cancelled) return
      setStatus(granted ? 'paused' : 'needs-permission')
    })()
    return () => {
      cancelled = true
    }
  }, [supported])

  // Stop the poller when the panel leaves the sender flow.
  useEffect(() => () => stopRef.current?.(), [])

  // Mirror queue metadata to IndexedDB (metadata only — Files stay in memory).
  useEffect(() => {
    if (queue.length === 0) {
      void clearQueueMeta()
      return
    }
    void saveQueueMeta(queue.map((q) => ({ name: q.name, size: q.size, addedAt: q.addedAt })))
  }, [queue])

  // While watching, re-check the grant: Chrome can revoke folder access from
  // site settings, and a silently-failing watcher would look alive.
  useEffect(() => {
    if (status !== 'watching' || !folder) return
    const id = setInterval(() => {
      void ensurePermission(folder).then((ok) => {
        if (!ok) {
          stopRef.current?.()
          stopRef.current = null
          setStatus('needs-permission')
        }
      })
    }, 30_000)
    return () => clearInterval(id)
  }, [status, folder])

  const haltWatch = useCallback((next: WatchStatus) => {
    stopRef.current?.()
    stopRef.current = null
    setStatus(next)
  }, [])

  const handleEvents = useCallback(
    (events: WatchEvent[]) => {
      if (events.length === 0) return
      const at = Date.now()
      setFeed((prev) => {
        const rows: FeedRow[] = events.map((e) => ({ kind: e.kind, name: e.name, size: e.file.size, at }))
        return [...rows, ...prev].slice(0, 50) // newest first, capped
      })
      setQueue((prev) => {
        // A changed file replaces its queued copy (same name).
        const names = new Set(events.map((e) => e.name))
        const next = prev.filter((q) => !names.has(q.name))
        for (const e of events) next.push({ file: e.file, name: e.name, size: e.file.size, addedAt: at })
        // Engine cap — keep the newest N (oldest silently drop off).
        return next.slice(-CONSTANTS.MAX_FILES_PER_TRANSFER)
      })
      toast.info(t('watch.detected', 'Watched folder detected files'), {
        description: events.map((e) => e.name).join(', ').slice(0, 120),
      })
    },
    [t]
  )

  const startWatchOn = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      const granted = await ensurePermission(handle, { request: true })
      if (!granted) {
        setStatus('needs-permission')
        return
      }
      // Idempotent start — a rapid double-click must not spawn two pollers.
      stopRef.current?.()
      stopRef.current = null
      setStatus('watching')
      stopRef.current = startWatching(handle, handleEvents, { intervalMs: 4000 })
    },
    [handleEvents]
  )

  const handlePick = useCallback(async () => {
    // Must run inside the click gesture — the picker requires user activation.
    const handle = await pickFolder()
    if (!handle) return // cancelled / denied — keep whatever was running
    stopRef.current?.()
    stopRef.current = null
    setFolder(handle)
    setFeed([])
    // pickFolder reset the snapshot, so the first poll baselines silently.
    void startWatchOn(handle)
  }, [startWatchOn])

  const dispatchSend = useCallback(
    (items: QueueRow[], reason: string) => {
      if (items.length === 0) return
      lastDispatchAtRef.current = Date.now()
      const files = items.map((i) => i.file)
      const total = files.reduce((s, f) => s + f.size, 0)
      setQueue([])
      void clearQueueMeta()
      toast.success(t('watch.sending', 'Sending queued files'), {
        description: `${files.length} file${files.length > 1 ? 's' : ''} · ${formatBytes(total)} · ${reason}`,
      })
      if (roomId) {
        // Room already open — same refresh dance as the sender queue editor:
        // close it, then re-send so the fresh manifest covers the whole queue.
        onCancel()
        setTimeout(() => onStartSend(files), 400)
      } else {
        onStartSend(files)
      }
    },
    [roomId, onCancel, onStartSend, t]
  )

  // ---- auto-send: opt-in + live session + idle engine ----
  useEffect(() => {
    if (!canAutoSend || queue.length === 0) return
    // The cancel→re-send window needs ~400ms to settle; hold off a moment so a
    // second batch can't fire a colliding startSend.
    if (Date.now() - lastDispatchAtRef.current < 2500) return
    dispatchSend(queue, t('watch.autoSendLabel', 'auto-send'))
  }, [canAutoSend, queue, dispatchSend, t])

  // ---- scheduled send (daily or one-shot) ----
  useEffect(() => {
    if (scheduleEnabled) armedAtRef.current = Date.now()
  }, [scheduleEnabled])

  // Latest-closure ref so the 1s ticker never needs re-arming.
  const scheduledFireRef = useRef<() => void>(() => {})
  useEffect(() => {
    scheduledFireRef.current = () => {
      if (watchAutoSend && queue.length > 0 && sessionLive && !isBusy) {
        dispatchSend(queue, t('watch.schedule.label', 'scheduled send'))
      } else {
        const count = queue.length
        toast.info(t('watch.schedule.toast', 'Scheduled send'), {
          description:
            count === 0
              ? t('watch.schedule.empty', 'Nothing is queued from the watch folder yet.')
              : `${count} file${count > 1 ? 's' : ''} ${t('watch.schedule.queued', 'waiting in the watch queue')}${
                  watchAutoSend ? '' : ' — ' + t('watch.schedule.enableAuto', 'turn on auto-send to send automatically')
                }.`,
        })
      }
      if (!scheduleDaily) setScheduleEnabled(false) // one-shot: ring once, then off
    }
  })

  // 1s ticker: countdown + schedule trigger. Fires when the clock crosses the
  // slot (60s catch-up window), only if the schedule was armed before the
  // window opened, and only once per slot. Ticks only while enabled so a
  // disabled scheduler costs no re-renders.
  useEffect(() => {
    const id = setInterval(() => {
      if (!scheduleEnabled) return
      const now = Date.now()
      setNowMs(now)
      const slot = parseHHMM(scheduleTime)
      if (!slot) return
      const fire = new Date(now)
      fire.setHours(slot.h, slot.m, 0, 0)
      const fireTs = fire.getTime()
      if (
        now >= fireTs &&
        now - fireTs < 60_000 &&
        armedAtRef.current <= fireTs + 60_000 &&
        lastFiredRef.current !== fireTs
      ) {
        lastFiredRef.current = fireTs
        scheduledFireRef.current()
      }
    }, 1000)
    return () => clearInterval(id)
  }, [scheduleEnabled, scheduleTime])

  const clearQueue = useCallback(() => {
    setQueue([])
    void clearQueueMeta()
  }, [])

  const slot = parseHHMM(scheduleTime)
  const countdown = slot ? formatCountdown(nextFireTs(nowMs, slot.h, slot.m) - nowMs) : null

  const statusBadge = !supported ? (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      {t('watch.unsupported.badge', 'Unsupported')}
    </Badge>
  ) : status === 'watching' ? (
    <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
      {t('watch.status.watching', 'Watching')}
    </Badge>
  ) : status === 'needs-permission' ? (
    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
      {t('watch.status.permission', 'Needs permission')}
    </Badge>
  ) : status === 'paused' ? (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      {t('watch.status.paused', 'Paused')}
    </Badge>
  ) : (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      {t('watch.status.idle', 'Not set up')}
    </Badge>
  )

  return (
    <Card className="flux-glass p-4" aria-label={t('watch.title', 'Watch folder')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FolderSync className="h-4 w-4 text-flux-600 dark:text-flux-400" aria-hidden />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('watch.title', 'Watch folder')}
          </h3>
        </div>
        {statusBadge}
      </div>

      {!supported ? (
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t(
            'watch.unsupported.note',
            'Folder watching needs a Chromium browser (Chrome or Edge). Scheduled send is still available.'
          )}
        </p>
      ) : (
        <>
          {/* Folder row */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5">
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-flux-600 dark:text-flux-400" aria-hidden />
              <span className="truncate text-xs font-medium" title={folder?.name}>
                {folder ? folder.name : t('watch.none', 'No folder picked yet')}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handlePick()}
              aria-label={t('watch.pick', 'Pick folder')}
            >
              {folder ? t('watch.change', 'Change') : t('watch.pick', 'Pick folder')}
            </Button>
            {folder &&
              (status === 'watching' ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => haltWatch('paused')}
                  aria-label={t('watch.stop', 'Stop watching')}
                >
                  <Pause className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t('watch.stop', 'Stop')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => folder && void startWatchOn(folder)}
                  aria-label={t('watch.start', 'Start watching')}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t('watch.start', 'Start')}
                </Button>
              ))}
          </div>

          {status === 'needs-permission' && (
            <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <p className="min-w-0 flex-1 text-[11px] text-amber-700 dark:text-amber-300">
                {t('watch.needsPermission', 'The browser needs permission again to read this folder.')}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-[11px]"
                onClick={() => folder && void startWatchOn(folder)}
              >
                {t('watch.regrant', 'Re-grant')}
              </Button>
            </div>
          )}

          {/* Live feed of detected files */}
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('watch.feed', 'Detected files')}
            </p>
            <div
              className="max-h-40 space-y-1 overflow-y-auto flux-scroll pr-1"
              role="log"
              aria-live="polite"
              aria-label={t('watch.feed', 'Detected files')}
            >
              {feed.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  {status === 'watching'
                    ? t('watch.waiting', 'Watching for new or changed files…')
                    : t('watch.notWatching', 'Start watching to see files here.')}
                </p>
              ) : (
                feed.map((row, i) => (
                  <div
                    key={`${row.name}-${row.at}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2 py-1.5"
                  >
                    {row.kind === 'added' ? (
                      <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-flux-600 dark:text-flux-400" aria-hidden />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium" title={row.name}>
                      {row.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(row.size)}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {new Date(row.at).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Pending queue */}
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('watch.queue', 'Pending queue')}
                <span className="ml-1.5 font-mono text-[10px] font-normal normal-case text-muted-foreground">
                  {queue.length} · {formatBytes(queue.reduce((s, q) => s + q.size, 0))}
                </span>
              </p>
              {queue.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11px] text-muted-foreground hover:text-destructive"
                    onClick={clearQueue}
                    aria-label={t('watch.clear', 'Clear queue')}
                  >
                    <Trash2 className="mr-1 h-3 w-3" aria-hidden />
                    {t('watch.clear', 'Clear')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    disabled={isBusy}
                    onClick={() =>
                      dispatchSend(queue, t('watch.manualLabel', 'manual send'))
                    }
                  >
                    <Send className="mr-1 h-3 w-3" aria-hidden />
                    {t('watch.sendQueued', 'Send queued files')}
                  </Button>
                </div>
              )}
            </div>
            {queue.length > 0 && (
              <div className="max-h-40 space-y-1 overflow-y-auto flux-scroll pr-1">
                {queue.map((q, i) => (
                  <div
                    key={`${q.name}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2 py-1.5"
                  >
                    <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-xs" title={q.name}>
                      {q.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatBytes(q.size)}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => setQueue(queue.filter((_, j) => j !== i))}
                      aria-label={`${t('watch.remove', 'Remove')} ${q.name}`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2.5">
              <div className="min-w-0 space-y-0.5 pr-2">
                <Label htmlFor="watch-auto-send" className="text-xs font-medium">
                  {t('watch.autoSend', 'Auto-send when session is live')}
                </Label>
                <p className="text-[10px] text-muted-foreground">
                  {t(
                    'watch.autoSendHint',
                    'Sends the queue whenever a send room is open and no transfer is running.'
                  )}
                </p>
              </div>
              <Switch
                id="watch-auto-send"
                checked={watchAutoSend}
                onCheckedChange={setWatchAutoSend}
                aria-label={t('watch.autoSend', 'Auto-send when session is live')}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              {t(
                'watch.queueLifetime',
                'Queued files live in memory only — leaving send mode or closing this tab clears them.'
              )}
            </p>
          </div>
        </>
      )}

      {/* Scheduled send — available with or without folder watching */}
      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-flux-600 dark:text-flux-400" aria-hidden />
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('watch.schedule.title', 'Scheduled send')}
            </h4>
          </div>
          <div className="flex items-center gap-2">
            <span className="sr-only">{t('watch.schedule.enable', 'Enable scheduled send')}</span>
            <Switch
              checked={scheduleEnabled}
              onCheckedChange={setScheduleEnabled}
              aria-label={t('watch.schedule.enable', 'Enable scheduled send')}
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Label htmlFor="watch-schedule-time" className="text-xs text-muted-foreground">
            {t('watch.schedule.time', 'Send time')}
          </Label>
          <Input
            id="watch-schedule-time"
            type="time"
            value={scheduleTime}
            onChange={(e) => setScheduleTime(e.target.value)}
            disabled={!scheduleEnabled}
            className="h-8 w-[110px] text-xs"
          />
          <div className="flex items-center gap-1.5">
            <Switch
              id="watch-schedule-daily"
              checked={scheduleDaily}
              onCheckedChange={setScheduleDaily}
              disabled={!scheduleEnabled}
              aria-label={t('watch.schedule.daily', 'Daily')}
            />
            <Label htmlFor="watch-schedule-daily" className="text-xs text-muted-foreground">
              {t('watch.schedule.daily', 'Daily')}
            </Label>
          </div>
          <p className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" aria-hidden />
            {scheduleEnabled && countdown
              ? `${t('watch.schedule.next', 'Next fire')} · ${countdown}`
              : t('watch.schedule.off', 'Off')}
          </p>
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {t(
            'watch.schedule.hint',
            'At the scheduled time the queue sends automatically (auto-send on, room open, queue non-empty) — otherwise you get a reminder with the queued count. One-shot schedules switch themselves off after firing.'
          )}
        </p>
      </div>
    </Card>
  )
}
