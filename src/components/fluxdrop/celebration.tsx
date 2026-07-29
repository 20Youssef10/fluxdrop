'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'

interface CelebrationProps {
  trigger: boolean
  onComplete?: () => void
}

/**
 * Renders a celebratory burst of particles when `trigger` becomes true.
 * Particles fly outward from the center with random angles and colors.
 */
export function Celebration({ trigger, onComplete }: CelebrationProps) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (trigger) {
      setShow(true)
      const id = setTimeout(() => {
        setShow(false)
        onComplete?.()
      }, 2500)
      return () => clearTimeout(id)
    }
  }, [trigger, onComplete])

  const particles = Array.from({ length: 32 })

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Particles */}
          {particles.map((_, i) => {
            const angle = (i / particles.length) * Math.PI * 2
            const distance = 120 + Math.random() * 180
            const tx = Math.cos(angle) * distance
            const ty = Math.sin(angle) * distance
            const colors = [
              'oklch(0.62 0.16 172)',
              'oklch(0.72 0.14 200)',
              'oklch(0.76 0.18 145)',
              'oklch(0.78 0.16 85)',
              'oklch(0.70 0.15 170)',
            ]
            const color = colors[i % colors.length]
            const size = 6 + Math.random() * 8
            const delay = Math.random() * 0.15
            return (
              <motion.div
                key={i}
                className="absolute rounded-sm"
                style={{
                  width: size,
                  height: size,
                  backgroundColor: color,
                  top: '50%',
                  left: '50%',
                }}
                initial={{ x: 0, y: 0, opacity: 1, scale: 1, rotate: 0 }}
                animate={{
                  x: tx,
                  y: ty,
                  opacity: 0,
                  scale: 0.3,
                  rotate: Math.random() * 360,
                }}
                transition={{
                  duration: 1.2 + Math.random() * 0.5,
                  delay,
                  ease: [0.22, 1, 0.36, 1],
                }}
              />
            )
          })}

          {/* Central check badge */}
          <motion.div
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 12 }}
            className="relative"
          >
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-flux-500 shadow-2xl shadow-flux-500/40">
              <CheckCircle2 className="h-12 w-12 text-white" strokeWidth={2.5} />
            </div>
            {/* Pulsing rings */}
            {[0, 1].map((ring) => (
              <motion.div
                key={ring}
                className="absolute inset-0 rounded-full border-2 border-flux-400"
                initial={{ scale: 1, opacity: 0.6 }}
                animate={{ scale: 2.2, opacity: 0 }}
                transition={{
                  duration: 1.5,
                  delay: ring * 0.3,
                  repeat: 1,
                  ease: 'easeOut',
                }}
              />
            ))}
          </motion.div>

          {/* "Complete" text */}
          <motion.div
            className="absolute bottom-[38%] text-center"
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.4 }}
          >
            <p className="text-xl font-bold flux-gradient-text">Transfer complete</p>
            <p className="text-xs text-muted-foreground mt-0.5">Files verified · SHA-256 ✓</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
