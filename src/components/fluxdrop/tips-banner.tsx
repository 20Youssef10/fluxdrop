'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Lightbulb, X } from 'lucide-react'
import { Card } from '@/components/ui/card'

const TIPS = [
  {
    title: 'Keyboard shortcut',
    body: 'Press S to send or R to receive — no mouse needed.',
  },
  {
    title: 'Shareable links',
    body: 'Generate a link with the room ID + PIN embedded, so receivers can join in one click.',
  },
  {
    title: 'Drag anywhere',
    body: 'In sender mode, drop files anywhere on the page — not just in the upload zone.',
  },
  {
    title: 'Folder uploads',
    body: 'Use "Select folder" to send an entire directory while preserving its structure.',
  },
  {
    title: 'Resume transfers',
    body: 'Interrupted transfers can resume from the last verified chunk — no restart needed.',
  },
  {
    title: 'TURN servers',
    body: 'On restrictive networks, configure a TURN server in Settings → Network for reliable connectivity.',
  },
  {
    title: 'Checksum verification',
    body: 'Every file is SHA-256 verified on arrival. Tampered or corrupted bytes are rejected.',
  },
  {
    title: 'Diagnostics panel',
    body: 'Press ⌘K to inspect ICE candidates, RTT, and connection quality in real time.',
  },
]

const STORAGE_KEY = 'fluxdrop:tips-dismissed'

export function TipsBanner() {
  const [index, setIndex] = useState(0)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY)) return
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(true)
  }, [])

  useEffect(() => {
    if (!visible) return
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % TIPS.length)
    }, 6000)
    return () => clearInterval(id)
  }, [visible])

  const dismiss = () => {
    setVisible(false)
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* ignore */ }
  }

  if (!visible) return null

  const tip = TIPS[index]

  return (
    <Card className="flux-glass p-0 overflow-hidden border-flux-500/20">
      <div className="flex items-center gap-3 p-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-flux-500/15 text-flux-600 dark:text-flux-400">
          <Lightbulb className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={index}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
            >
              <p className="text-xs font-semibold text-flux-600 dark:text-flux-400 uppercase tracking-wider">
                {tip.title}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">{tip.body}</p>
            </motion.div>
          </AnimatePresence>
        </div>
        {/* Dot indicators */}
        <div className="hidden sm:flex items-center gap-1 shrink-0">
          {TIPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setIndex(i)}
              className={`h-1 rounded-full transition-all ${
                i === index ? 'w-4 bg-flux-500' : 'w-1 bg-muted-foreground/30 hover:bg-muted-foreground/50'
              }`}
              aria-label={`Tip ${i + 1}`}
            />
          ))}
        </div>
        <button
          onClick={dismiss}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-1"
          aria-label="Dismiss tips"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </Card>
  )
}
