'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useState } from 'react'
import { useSessionStore } from '@/stores/session-store'

/**
 * Shows an expanding ripple effect when the WebRTC connection state
 * transitions to 'connected'. Renders as a full-screen overlay that
 * fades out quickly.
 */
export function ConnectionRipple() {
  const rtcState = useSessionStore((s) => s.rtcState)
  const [show, setShow] = useState(false)
  const [prevState, setPrevState] = useState<string>('new')

  useEffect(() => {
    // Trigger ripple only on the new → connected transition
    if (rtcState === 'connected' && prevState !== 'connected') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShow(true)
      const id = setTimeout(() => setShow(false), 2000)
      setPrevState(rtcState)
      return () => clearTimeout(id)
    }
    if (rtcState !== prevState) {
      setPrevState(rtcState)
    }
  }, [rtcState, prevState])

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Center ripple rings */}
          <div className="relative">
            {[0, 1, 2].map((i) => (
              <motion.div
                key={i}
                className="absolute left-1/2 top-1/2 rounded-full border-2 border-flux-500"
                style={{ width: 40, height: 40, x: '-50%', y: '-50%' }}
                initial={{ scale: 0, opacity: 0.8 }}
                animate={{ scale: 8, opacity: 0 }}
                transition={{
                  duration: 1.5,
                  delay: i * 0.25,
                  ease: [0.22, 1, 0.36, 1],
                }}
              />
            ))}
            {/* Center pulse dot */}
            <motion.div
              className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-flux-500 shadow-lg shadow-flux-500/50"
              initial={{ scale: 0 }}
              animate={{ scale: [0, 1.5, 1] }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
