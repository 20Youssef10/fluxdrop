'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTheme } from 'next-themes'
import { FluxHeader, SettingsDialog } from '@/components/fluxdrop/flux-header'
import { FluxHero } from '@/components/fluxdrop/flux-hero'
import { FluxFooter } from '@/components/fluxdrop/flux-footer'
import { SenderPanel } from '@/components/fluxdrop/sender-panel'
import { ReceiverPanel } from '@/components/fluxdrop/receiver-panel'
import { TransferHistory } from '@/components/fluxdrop/transfer-history'
import { StatsDashboard } from '@/components/fluxdrop/stats-dashboard'
import { ShortcutsHint } from '@/components/fluxdrop/shortcuts-hint'
import { FullPageDropZone } from '@/components/fluxdrop/full-page-drop-zone'
import { HelpDialog } from '@/components/fluxdrop/help-dialog'
import { TransferAnnouncer } from '@/components/fluxdrop/transfer-announcer'
import { OnboardingTour } from '@/components/fluxdrop/onboarding-tour'
import { ConnectionRipple } from '@/components/fluxdrop/connection-ripple'
import { TipsBanner } from '@/components/fluxdrop/tips-banner'
import { ConsentDialog } from '@/components/fluxdrop/consent-dialog'
import { SnippetPreviewDialog } from '@/components/fluxdrop/snippet-preview-dialog'
import { VerificationCode } from '@/components/fluxdrop/verification-code'
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

  const goSend = useCallback(() => setView('sender'), [setView])
  const goReceive = useCallback(() => setView('receiver'), [setView])
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
    },
    view
  )

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

  return (
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
                <TransferHistory onResume={handleResume} />
                <div className="flex justify-center">
                  <ShortcutsHint view={view} />
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
                  onStartSend={(fs) => {
                    const rm = resumeManifest
                    setResumeManifest(null)
                    void flux.startSend(fs, rm ?? undefined)
                  }}
                  onCancel={() => flux.cancelTransfer('Sender cancelled')}
                  onDone={goHome}
                  onBack={goHome}
                  onPause={flux.pauseTransfer}
                  onResume={flux.resumeTransfer}
                />
              </FullPageDropZone>
              <div className="mt-6 flex justify-center">
                <ShortcutsHint view={view} />
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
                <ShortcutsHint view={view} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <FluxFooter />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
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

      {/* Security verification code (shown during active transfer) */}
      <VerificationCode />
    </div>
  )
}
