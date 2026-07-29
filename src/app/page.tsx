'use client'

import { useState, useEffect } from 'react'
import { FluxHeader, SettingsDialog } from '@/components/fluxdrop/flux-header'
import { FluxHero } from '@/components/fluxdrop/flux-hero'
import { FluxFooter } from '@/components/fluxdrop/flux-footer'
import { SenderPanel } from '@/components/fluxdrop/sender-panel'
import { ReceiverPanel } from '@/components/fluxdrop/receiver-panel'
import { TransferHistory } from '@/components/fluxdrop/transfer-history'
import { useFluxDrop } from '@/hooks/fluxdrop/use-fluxdrop'
import { useSessionStore } from '@/stores/session-store'
import { motion, AnimatePresence } from 'framer-motion'

export default function Home() {
  const flux = useFluxDrop()
  const [files, setFiles] = useState<File[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const view = useSessionStore((s) => s.view)
  const setView = useSessionStore((s) => s.setView)

  const goSend = () => {
    setView('sender')
  }
  const goReceive = () => {
    setView('receiver')
  }
  const goHome = () => {
    flux.cleanup()
    setFiles([])
    setView('landing')
  }

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
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pb-16">
                <TransferHistory />
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
              <SenderPanel
                files={files}
                setFiles={setFiles}
                onStartSend={flux.startSend}
                onCancel={() => flux.cancelTransfer('Sender cancelled')}
                onDone={goHome}
                onBack={goHome}
              />
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
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <FluxFooter />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
