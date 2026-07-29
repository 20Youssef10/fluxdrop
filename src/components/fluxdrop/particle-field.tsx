'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'

interface ParticleFieldProps {
  count?: number
  className?: string
}

/**
 * Renders floating particle dots that drift upward slowly.
 * Purely decorative — pointer-events disabled.
 */
export function ParticleField({ count = 24, className }: ParticleFieldProps) {
  const particles = useMemo(() => {
    return Array.from({ length: count }).map((_, i) => {
      const size = 2 + Math.random() * 4
      const x = Math.random() * 100
      const delay = Math.random() * 8
      const duration = 12 + Math.random() * 10
      const drift = (Math.random() - 0.5) * 40
      const opacity = 0.15 + Math.random() * 0.35
      return { id: i, size, x, delay, duration, drift, opacity }
    })
  }, [count])

  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
      aria-hidden="true"
    >
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full"
          style={{
            width: p.size,
            height: p.size,
            left: `${p.x}%`,
            bottom: '-10px',
            backgroundColor: 'oklch(0.70 0.15 170)',
            opacity: p.opacity,
          }}
          animate={{
            y: [0, -600],
            x: [0, p.drift, 0],
            opacity: [0, p.opacity, p.opacity, 0],
          }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            repeat: Infinity,
            ease: 'linear',
          }}
        />
      ))}
    </div>
  )
}
