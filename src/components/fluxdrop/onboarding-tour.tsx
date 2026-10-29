'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'

const STORAGE_KEY = 'fluxdrop:onboarding-completed'

const STEPS = [
  {
    title: 'Welcome to FluxDrop',
    body: 'Transfer files directly between devices over WebRTC. No cloud, no servers holding your data — just a direct, encrypted tunnel.',
    accent: 'Peer-to-peer · End-to-end encrypted',
  },
  {
    title: 'Send files in one click',
    body: 'Click "Send files" to create a transfer room. You\'ll get a QR code and PIN to share with the receiver. Files are hashed with SHA-256 for integrity verification.',
    accent: 'Press S to start sending',
  },
  {
    title: 'Receive with a scan',
    body: 'Click "Receive files" and enter the room ID + PIN from the sender. Or open a shareable link — FluxDrop auto-joins the room for you.',
    accent: 'Press R to start receiving',
  },
  {
    title: 'Pause, resume & snippets',
    body: 'Either side can pause mid-transfer and pick up again. Share text snippets instantly with a built-in preview on arrival — no files needed.',
    accent: 'New · Pause / Resume / Snippets',
  },
  {
    title: 'Trust the devices you own',
    body: 'Tick "Trust this device" when accepting a transfer, then enable auto-accept in Settings → Privacy. Future transfers from that device start without asking.',
    accent: 'Trusted devices · Auto-accept',
  },
  {
    title: 'Keyboard shortcuts',
    body: 'S sends, R receives, Esc goes back. ⌘K toggles diagnostics, ⌘J toggles theme. Look for the shortcut hints at the bottom of each page.',
    accent: 'Power-user friendly',
  },
  {
    title: 'Your data stays yours',
    body: 'Transfer history is stored locally in your browser (IndexedDB). The signaling server only relays connection setup — it never sees, stores, or touches file data.',
    accent: 'Zero footprint',
  },
]

// Transfer states during which the tour must never appear.
const BUSY_STATES = new Set(['TRANSFERRING', 'PAUSED', 'VERIFYING', 'RESUMING'])

export function OnboardingTour() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [deferred, setDeferred] = useState(false)
  const view = useSessionStore((s) => s.view)
  const pendingManifest = useSessionStore((s) => s.pendingManifest)
  const transferState = useTransferStore((s) => s.transferState)

  useEffect(() => {
    if (typeof window === 'undefined') return
    let seen = false
    try {
      seen = !!localStorage.getItem(STORAGE_KEY)
    } catch { /* ignore */ }
    if (seen) return
    // The speedrun demo REPLACES this tour for first visits — never compete
    // with it. (Two stacked first-run modals used to freeze the page: the
    // Radix modal set body{pointer-events:none} and this overlay's buttons
    // became unclickable.) The speedrun marks this flag when it closes.
    if (!usePrefsStore.getState().speedrunDone) return
    // Deep-link join: the user came here to receive a specific transfer.
    // Defer the tour so it never blocks the incoming-transfer consent dialog.
    if (window.location.hash.includes('join=')) {
      const id = setTimeout(() => setDeferred(true), 0)
      return () => clearTimeout(id)
    }
    // Small delay so it doesn't compete with the hero animation
    const id = setTimeout(() => setOpen(true), 1200)
    return () => clearTimeout(id)
  }, [])

  // A transfer is asking for consent (or already streaming) — get out of the
  // way. State updates are deferred via setTimeout to avoid cascading renders.
  useEffect(() => {
    if (!open && !deferred) return
    if (!pendingManifest && !BUSY_STATES.has(transferState)) return
    const id = setTimeout(() => {
      setOpen(false)
      setDeferred(true)
    }, 0)
    return () => clearTimeout(id)
  }, [open, deferred, pendingManifest, transferState])

  // Deferred tour: show it once the user is back on the landing page with
  // nothing in flight and they still haven't seen it.
  useEffect(() => {
    if (!deferred) return
    if (view !== 'landing') return
    if (pendingManifest) return
    if (BUSY_STATES.has(transferState)) return
    // Same first-run rule as the mount effect: the tour never auto-opens
    // while the speedrun demo hasn't been dealt with.
    if (!usePrefsStore.getState().speedrunDone) return
    let seen = false
    try {
      seen = !!localStorage.getItem(STORAGE_KEY)
    } catch { /* ignore */ }
    if (seen) {
      const clear = setTimeout(() => setDeferred(false), 0)
      return () => clearTimeout(clear)
    }
    const id = setTimeout(() => {
      setDeferred(false)
      setOpen(true)
    }, 600)
    return () => clearTimeout(id)
  }, [deferred, view, pendingManifest, transferState])

  const close = () => {
    setOpen(false)
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* ignore */ }
  }

  const next = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1)
    } else {
      close()
    }
  }

  const skip = close

  // Keyboard dismissal: Escape, Enter (next), and shortcut keys (s, r) close the tour
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        next()
      } else if (e.key === 's' || e.key === 'S' || e.key === 'r' || e.key === 'R') {
        // Dismiss onboarding and let the shortcut propagate to the page.
        // We stopPropagation in capture phase, then re-dispatch after a tick
        // so the page-level shortcut handler picks it up.
        e.stopPropagation()
        close()
        setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, bubbles: true }))
        }, 100)
      }
    }
    window.addEventListener('keydown', onKey, true) // capture phase to intercept before page
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, step])

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="pointer-events-auto fixed inset-0 z-[90] flex items-center justify-center p-4"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={skip}
          />

          {/* Coach mark card */}
          <motion.div
            key={step}
            initial={{ scale: 0.92, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 24 }}
            className="relative w-full max-w-md rounded-2xl border border-border/60 bg-card shadow-2xl overflow-hidden"
          >
            {/* Gradient header bar */}
            <div className="h-1.5 bg-gradient-to-r from-flux-500 via-flux-400 to-flux-600" />

            {/* Close button */}
            <button
              onClick={skip}
              className="absolute right-3 top-4 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Skip tour"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="p-6">
              {/* Step indicator */}
              <div className="flex items-center gap-1.5 mb-4">
                {STEPS.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1 rounded-full transition-all ${
                      i === step ? 'w-6 bg-flux-500' : i < step ? 'w-1.5 bg-flux-500/50' : 'w-1.5 bg-muted'
                    }`}
                  />
                ))}
              </div>

              {/* Accent badge */}
              <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-flux-500/30 bg-flux-500/10 px-2.5 py-0.5 text-[10px] font-medium text-flux-600 dark:text-flux-400 uppercase tracking-wider">
                {current.accent}
              </div>

              <h3 className="text-lg font-bold mb-2">{current.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                {current.body}
              </p>

              {/* Actions */}
              <div className="flex items-center justify-between">
                <button
                  onClick={skip}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Skip tour
                </button>
                <Button
                  onClick={next}
                  size="sm"
                  className="bg-flux-600 hover:bg-flux-700 text-white"
                >
                  {isLast ? (
                    <>
                      <Check className="mr-1.5 h-4 w-4" />
                      Got it
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight className="ml-1.5 h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>

              {/* Step counter */}
              <p className="mt-4 text-center text-[10px] text-muted-foreground">
                Step {step + 1} of {STEPS.length}
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
