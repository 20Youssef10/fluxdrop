'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTheme } from 'next-themes'
import { FluxHeader, SettingsDialog } from '@/components/fluxdrop/flux-header'
import { FluxHero } from '@/components/fluxdrop/flux-hero'
import { FluxFooter } from '@/components/fluxdrop/flux-footer'
import { SenderPanel } from '@/components/fluxdrop/sender-panel'
import { ReceiverPanel } from '@/components/fluxdrop/receiver-panel'
import { TransferHistory } from '@/components/fluxdrop/transfer-history'
import { VaultView } from '@/components/fluxdrop/vault-view'
import { StatsDashboard } from '@/components/fluxdrop/stats-dashboard'
import { ShortcutsHint } from '@/components/fluxdrop/shortcuts-hint'
import { ShortcutsDialog } from '@/components/fluxdrop/shortcuts-dialog'
import { FullPageDropZone } from '@/components/fluxdrop/full-page-drop-zone'
import { HelpDialog } from '@/components/fluxdrop/help-dialog'
import { TransferAnnouncer } from '@/components/fluxdrop/transfer-announcer'
import { OnboardingTour } from '@/components/fluxdrop/onboarding-tour'
import { ConnectionRipple } from '@/components/fluxdrop/connection-ripple'
import { TipsBanner } from '@/components/fluxdrop/tips-banner'
import { ConsentDialog } from '@/components/fluxdrop/consent-dialog'
import { SnippetPreviewDialog } from '@/components/fluxdrop/snippet-preview-dialog'
import { SaveConflictDialogHost } from '@/components/fluxdrop/save-conflict-dialog'
import { ChatPanel } from '@/components/fluxdrop/chat-panel'
import { ActivityDock } from '@/components/fluxdrop/activity-dock'
import { VerificationCode } from '@/components/fluxdrop/verification-code'
// v4 additions
import { CommandPalette } from '@/components/fluxdrop/command-palette'
import { SpeedrunDialog } from '@/components/fluxdrop/speedrun-dialog'
import { NearbyDevices } from '@/components/fluxdrop/nearby-devices'
import { I18nProvider } from '@/lib/fluxdrop/i18n'
import { applyPersistedPrefs } from '@/lib/fluxdrop/prefs'
import { useBackgroundResilience } from '@/hooks/fluxdrop/use-background-resilience'
import { onClipboardSync } from '@/lib/fluxdrop/clipboard-sync'
import { useFluxDrop } from '@/hooks/fluxdrop/use-fluxdrop'
import { useKeyboardShortcuts } from '@/hooks/fluxdrop/use-keyboard-shortcuts'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { getSenderFiles, type StoredTransfer } from '@/lib/fluxdrop/resume'
import { formatBytes } from '@/lib/fluxdrop/format'
import type { TransferManifest } from '@/lib/fluxdrop/protocol'

export default function Home() {
  const flux = useFluxDrop()
  const [files, setFiles] = useState<File[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [resumeManifest, setResumeManifest] = useState<TransferManifest | null>(null)
  const view = useSessionStore((s) => s.view)
  const setView = useSessionStore((s) => s.setView)
  const transferState = useTransferStore((s) => s.transferState)
  const { theme, setTheme } = useTheme()

  // Deep-link parsing: if URL has #join=ROOM&pin=PIN, auto-switch to receiver mode.
  // Handles BOTH a full page load and hash-only navigation (hashchange), and
  // each distinct link is handled exactly once. startReceive waits for the
  // signaling socket internally, so no fixed delay is needed here.
  const deepLinkHandled = useRef('') // hash of the last handled link
  const handleDeepLink = useCallback(
    (fluxApi: ReturnType<typeof useFluxDrop>) => {
      if (typeof window === 'undefined') return
      const hash = window.location.hash
      if (!hash) return
      const match = hash.match(/join=([A-Za-z0-9]+)&pin=(\d+)/)
      if (!match) return
      if (deepLinkHandled.current === hash) return
      deepLinkHandled.current = hash
      const [, roomId, pin] = match
      // Clean the hash so a reload doesn't re-join a (probably expired) room.
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      setView('receiver')
      void fluxApi.startReceive(roomId, pin)
      toast.info('Joining room from link…', { description: `Room ${roomId}` })
    },
    [setView]
  )
  useEffect(() => {
    handleDeepLink(flux)
    const onHashChange = () => handleDeepLink(flux)
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [flux, handleDeepLink])

  // Web Share Target ingestion: the service worker receives the OS share-sheet
  // POST /share-target, stashes the payload in IndexedDB and redirects here
  // with ?shared=<token>. Retrieve the payload, feed it through the same
  // paths as clipboard paste (files → send queue, text → snippet composer),
  // then clean the URL and delete the stash. Runs once per real page load.
  const sharedHandled = useRef<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const token = new URLSearchParams(window.location.search).get('shared')
    if (!token || sharedHandled.current === token) return
    sharedHandled.current = token
    window.history.replaceState(null, '', window.location.pathname)
    let cancelled = false
    void (async () => {
      try {
        const { getSharedPayload, deleteSharedPayload, sweepStaleShares } = await import(
          '@/lib/fluxdrop/share-target'
        )
        void sweepStaleShares()
        const payload = await getSharedPayload(token)
        await deleteSharedPayload(token)
        if (cancelled || !payload) {
          if (!cancelled && token !== 'empty' && token !== 'error') {
            toast.error('Shared content expired', { description: 'Please share again.' })
          } else if (!cancelled && token === 'empty') {
            toast.info('Nothing shareable', { description: 'The shared item had no files or text.' })
          } else if (!cancelled && token === 'error') {
            toast.error('Could not read shared content', { description: 'The share handoff failed.' })
          }
          return
        }
        if (payload.files.length > 0) {
          const incoming = payload.files.map(
            (f) => new File([f.data], f.name, { type: f.type, lastModified: f.lastModified })
          )
          setFiles((prev) => {
            const seen = new Set(prev.map((x) => `${x.name}:${x.size}`))
            const fresh = incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))
            if (fresh.length === 0) {
              toast.info('Already in the queue', { description: incoming[0]?.name })
              return prev
            }
            toast.success(`Added ${fresh.length} shared file${fresh.length > 1 ? 's' : ''}`, {
              description: `${fresh.length} item${fresh.length > 1 ? 's' : ''} received from the share sheet · ${formatBytes(fresh.reduce((n, f) => n + f.size, 0))}`,
            })
            return [...prev, ...fresh]
          })
          setView('sender')
        } else if (payload.text.trim()) {
          // The snippet composer lives in sender view — switch first, then
          // dispatch on the next tick so the listener is attached.
          setView('sender')
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('fluxdrop:paste-snippet', { detail: { text: payload.text } }))
          }, 400)
        }
      } catch {
        if (!cancelled) toast.error('Could not read shared content')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setView])

  const goSend = useCallback(() => setView('sender'), [setView])
  const goReceive = useCallback(() => setView('receiver'), [setView])  // v1.3 (5.1): the activity dock's "Go to transfer" — navigate to whichever
  // side owns the ACTIVE transfer: the sender view when this device is
  // streaming to receiver-role peers, otherwise the receiver view.
  const jumpToActiveTransfer = useCallback(() => {
    const m = useTransferStore.getState().manifest
    const hasReceiverPeers = useSessionStore.getState().peers.some((p) => p.role === 'receiver')
    setView(m && hasReceiverPeers ? 'sender' : 'receiver')
  }, [setView])
  const goHome = useCallback(() => {
    flux.cleanup()
    setFiles([])
    setResumeManifest(null)
    setView('landing')
    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [flux, setView])

  // Keyboard shortcuts
  useKeyboardShortcuts(
    {
      onSend: goSend,
      onReceive: goReceive,
      onBack: goHome,
      onToggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      onToggleDiagnostics: () => {
        window.dispatchEvent(new CustomEvent('fluxdrop:toggle-diagnostics'))
      },
      // P toggles pause/resume of the live transfer (state-aware).
      onTogglePause: () => {
        const st = useTransferStore.getState().transferState
        if (st === 'PAUSED') flux.resumeTransfer()
        else flux.pauseTransfer()
      },
      // "?" opens the keyboard shortcuts dialog from any view.
      onShowShortcuts: () => setShortcutsOpen(true),
    },
    view
  )

  // v4 (7.3): background resilience — auto-pause when hidden/frozen, resume + notify on return.
  useBackgroundResilience(
    flux.pauseTransfer,
    flux.resumeTransfer,
    () => toast.info('Transfer resumed', { description: 'Welcome back — continuing where we left off.' })
  )

  // v4: external openers (command palette) for the dialogs the page owns.
  useEffect(() => {
    const openSettings = () => setSettingsOpen(true)
    const openHelp = () => setHelpOpen(true)
    const openShortcuts = () => setShortcutsOpen(true)
    window.addEventListener('fluxdrop:open-settings', openSettings)
    window.addEventListener('fluxdrop:open-help', openHelp)
    window.addEventListener('fluxdrop:open-shortcuts', openShortcuts)
    return () => {
      window.removeEventListener('fluxdrop:open-settings', openSettings)
      window.removeEventListener('fluxdrop:open-help', openHelp)
      window.removeEventListener('fluxdrop:open-shortcuts', openShortcuts)
    }
  }, [])

  // v4 (4.6): incoming clipboard sync — surfaces a one-tap Copy toast (direct
  // clipboard writes need a user gesture on most browsers).
  useEffect(() => {
    const un = onClipboardSync((frame) => {
      const preview = frame.text.length > 60 ? `${frame.text.slice(0, 60)}…` : frame.text
      const id = `clip-sync-${Date.now()}`
      toast('Clipboard synced from your peer', {
        id,
        description: preview,
        duration: 12_000,
        action: {
          label: 'Copy',
          onClick: () => {
            void navigator.clipboard.writeText(frame.text).then(() => toast.success('Copied to your clipboard'))
          },
        },
      })
    })
    return un
  }, [])

  // v4 (6.2): "Send onward" — re-queue verified received files into a fresh send.
  useEffect(() => {
    const onOnward = (e: Event) => {
      const transferId = (e as CustomEvent).detail?.transferId as string | undefined
      if (!transferId) return
      const files = flux.getReceivedFiles(transferId)
      if (!files || files.length === 0) {
        toast.error('Files no longer available', {
          description: 'The received blobs live in memory — they were cleared by a reload. Use the Files vault instead.',
        })
        return
      }
      setFiles(files)
      setView('sender')
      toast.success(`${files.length} file${files.length > 1 ? 's' : ''} re-queued`, {
        description: 'Verified bytes forwarded as a fresh transfer — create a room to send them onward.',
      })
    }
    window.addEventListener('fluxdrop:send-onward', onOnward)
    return () => window.removeEventListener('fluxdrop:send-onward', onOnward)
  }, [flux, setView])

  // v4 (5.5/10.3): apply persisted visual prefs (accent, low-vision, contrast) once on mount.
  useEffect(() => {
    applyPersistedPrefs()
  }, [])

  // Resume handler: re-enter sender mode with the record's persisted files.
  // Files are stored in IndexedDB when a send starts and removed on completion.
  const handleResume = useCallback(
    async (record: StoredTransfer) => {
      if (record.role === 'sender') {
        const stored = await getSenderFiles(record.transferId)
        if (!stored || stored.length === 0) {
          toast.error('Original files unavailable', {
            description: 'They may have been cleared by the browser or the transfer already completed.',
          })
          return
        }
        // Sanity-check against the manifest: count, names and sizes must match.
        const mismatched =
          stored.length !== record.manifest.files.length ||
          stored.some(
            (f, i) => f.name !== record.manifest.files[i].name || f.size !== record.manifest.files[i].size
          )
        if (mismatched) {
          toast.error('Files no longer match this transfer', {
            description: 'Start a new transfer instead — the stored files were changed or replaced.',
          })
          return
        }
        const pct = Math.round((record.chunksAcked.length / Math.max(1, record.manifest.totalChunks)) * 100)
        setFiles(stored)
        setResumeManifest(record.manifest)
        setView('sender')
        toast.success(`${stored.length} file${stored.length > 1 ? 's' : ''} re-attached`, {
          description: `${formatBytes(record.manifest.totalSize)} · ${pct}% was transferred before. Create a room to continue.`,
        })
      } else {
        // Receiver-side resume needs the sender to re-send with the same
        // transfer ID — once they do, stored chunks are reused automatically.
        toast.info('Waiting for the sender to resume', {
          description: 'Ask the sender to resume this transfer from their history — received chunks will be reused.',
        })
      }
    },
    [setView]
  )

  // Full-page drop is enabled only in sender view before transfer starts
  const dropEnabled =
    view === 'sender' &&
    transferState !== 'TRANSFERRING' &&
    transferState !== 'PAUSED' &&
    transferState !== 'MANIFEST_EXCHANGE' &&
    transferState !== 'VERIFYING' &&
    transferState !== 'COMPLETE'

  // Clipboard paste-to-send (sender view, pre-transfer):
  //  - pasted FILES (e.g. a screenshot) join the send queue directly
  //  - pasted TEXT opens the snippet composer pre-filled
  // Fires only when the paste didn't target an editable field (so pasting
  // into the room-code input or snippet box behaves normally).
  useEffect(() => {
    if (view !== 'sender' || !dropEnabled) return
    const isEditable = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.isContentEditable ||
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT')
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target)) return
      const dt = e.clipboardData
      if (!dt) return
      const pastedFiles = Array.from(dt.files ?? [])
      if (pastedFiles.length > 0) {
        e.preventDefault()
        setFiles((prev) => {
          // Clipboard re-pastes of the same content produce fresh File objects
          // with a new lastModified — dedupe on name+size instead.
          const seen = new Set(prev.map((f) => `${f.name}:${f.size}`))
          const fresh = pastedFiles.filter((f) => !seen.has(`${f.name}:${f.size}`))
          if (fresh.length === 0) {
            toast.info('Already in the queue', { description: pastedFiles[0]?.name })
            return prev
          }
          toast.success(
            `Added ${fresh.length} file${fresh.length > 1 ? 's' : ''} from clipboard`,
            { description: fresh.map((f) => f.name).join(', ').slice(0, 120) }
          )
          return [...prev, ...fresh]
        })
        return
      }
      const text = dt.getData('text/plain')?.trim()
      if (text) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('fluxdrop:paste-snippet', { detail: { text } }))
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [view, dropEnabled])

  return (
    <I18nProvider>
      <div className="flex min-h-screen flex-col">
      <FluxHeader onOpenSettings={() => setSettingsOpen(true)} onOpenHelp={() => setHelpOpen(true)} />

      <main className="flex-1">
        <AnimatePresence mode="wait">
          {view === 'landing' && (
            <motion.div
              key="landing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              <FluxHero onSend={goSend} onReceive={goReceive} onHelp={() => setHelpOpen(true)} />
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-16 space-y-6">
                <TipsBanner />
                <StatsDashboard />
                {/* v4 (3.2): LAN discovery — same-subnet FluxDrop devices */}
                <NearbyDevices />
                {/* v1.3 (4.1): persistent received-files vault (kept in OPFS) */}
                <VaultView />
                <TransferHistory onResume={handleResume} />
                <div className="flex justify-center">
                  <ShortcutsHint view={view} onOpenShortcuts={() => setShortcutsOpen(true)} />
                </div>
              </div>
            </motion.div>
          )}

          {view === 'sender' && (
            <motion.div
              key="sender"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8"
            >
              <FullPageDropZone
                enabled={dropEnabled}
                onFiles={(incoming) => setFiles((prev) => [...prev, ...incoming])}
              >
                <SenderPanel
                  files={files}
                  setFiles={setFiles}
                  isResuming={!!resumeManifest}
                  onStartSend={(fs, rm, claim) => {
                    const rmv = rm ?? resumeManifest
                    setResumeManifest(null)
                    void flux.startSend(fs, rmv ?? undefined, claim)
                  }}
                  onCancel={() => flux.cancelTransfer('Sender cancelled')}
                  onDone={goHome}
                  onBack={goHome}
                  onPause={flux.pauseTransfer}
                  onResume={flux.resumeTransfer}
                />
              </FullPageDropZone>
              <div className="mt-6 flex justify-center">
                <ShortcutsHint view={view} onOpenShortcuts={() => setShortcutsOpen(true)} />
              </div>
            </motion.div>
          )}

          {view === 'receiver' && (
            <motion.div
              key="receiver"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8"
            >
              <ReceiverPanel
                onJoin={flux.startReceive}
                onCancel={() => flux.cancelTransfer('Receiver cancelled')}
                onDone={goHome}
                onBack={goHome}
                onPause={flux.pauseTransfer}
                onResume={flux.resumeTransfer}
              />
              <div className="mt-6 flex justify-center">
                <ShortcutsHint view={view} onOpenShortcuts={() => setShortcutsOpen(true)} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* v1.3 (5.1): floating activity dock — fixed overlay outside <main>, so
          the footer keeps its sticky-bottom layout and the dock floats above it */}
      <ActivityDock
        onCancel={() => flux.cancelTransfer('Cancelled from dock')}
        onPause={flux.pauseTransfer}
        onResume={flux.resumeTransfer}
        onJump={jumpToActiveTransfer}
      />

      <FluxFooter />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <TransferAnnouncer />
      <OnboardingTour />
      <ConnectionRipple />

      {/* Receiver consent dialog */}
      <ConsentDialog
        manifest={flux.session.pendingManifest}
        peerAlias={flux.session.peers[0]?.alias ?? 'Unknown'}
        peerDeviceId={flux.session.peers[0]?.id ?? null}
        onAccept={flux.acceptTransfer}
        onReject={flux.rejectTransfer}
      />

      {/* Received text snippet preview (receiver-side instant read/copy) */}
      <SnippetPreviewDialog />

      {/* v1.2 (4.3): conflict-aware save dialog (promise-controller host) */}
      <SaveConflictDialogHost />

      {/* v1.3 (6.3): in-room chat over the DataChannel — P2P only, mounts once
          and self-hides unless a room is live with an open DataChannel */}
      <ChatPanel onSend={flux.sendChat} />

      {/* Security verification code (shown during active transfer) */}
      <VerificationCode />

      {/* v4 (5.2): command palette (⌘K) */}
      <CommandPalette />

      {/* v4 (5.6): first-run speedrun / demo */}
      <SpeedrunDialog />
      </div>
    </I18nProvider>
  )
}
