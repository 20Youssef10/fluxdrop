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
import { useFluxDrop } from '@/hooks/fluxdrop/use-fluxdrop'
import { useKeyboardShortcuts } from '@/hooks/fluxdrop/use-keyboard-shortcuts'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import type { StoredTransfer } from '@/lib/fluxdrop/resume'

export default function Home() {
  const flux = useFluxDrop()
  const [files, setFiles] = useState<File[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const view = useSessionStore((s) => s.view)
  const setView = useSessionStore((s) => s.setView)
  const transferState = useTransferStore((s) => s.transferState)
  const { theme, setTheme } = useTheme()

  // Deep-link parsing: if URL has #join=ROOM&pin=PIN, auto-switch to receiver mode.
  const deepLinkHandled = useRef(false)
  useEffect(() => {
    if (deepLinkHandled.current) return
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash) return
    const match = hash.match(/join=([A-Za-z0-9]+)&pin=(\d+)/)
    if (match) {
      deepLinkHandled.current = true
      const [, roomId, pin] = match
      setView('receiver')
      setTimeout(() => {
        flux.startReceive(roomId, pin)
      }, 500)
      toast.info('Joining room from link…', { description: `Room ${roomId}` })
    }
  }, [flux, setView])

  const goSend = useCallback(() => setView('sender'), [setView])
  const goReceive = useCallback(() => setView('receiver'), [setView])
  const goHome = useCallback(() => {
    flux.cleanup()
    setFiles([])
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
    },
    view
  )

  // Resume handler: re-enter sender mode with the record's files (if available)
  const handleResume = useCallback(
    (record: StoredTransfer) => {
      toast.info('Resume transfer', {
        description: `Re-creating room for transfer ${record.transferId.slice(0, 8)}…`,
      })
      setView('sender')
    },
    [setView]
  )

  // Full-page drop is enabled only in sender view before transfer starts
  const dropEnabled =
    view === 'sender' &&
    transferState !== 'TRANSFERRING' &&
    transferState !== 'MANIFEST_EXCHANGE' &&
    transferState !== 'VERIFYING' &&
    transferState !== 'COMPLETE'

  return (
    <div className="flex min-h-screen flex-col">
      <FluxHeader onOpenSettings={() => setSettingsOpen(true)} />

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
              <FluxHero onSend={goSend} onReceive={goReceive} />
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-16 space-y-6">
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
                  onStartSend={flux.startSend}
                  onCancel={() => flux.cancelTransfer('Sender cancelled')}
                  onDone={goHome}
                  onBack={goHome}
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
    </div>
  )
}
