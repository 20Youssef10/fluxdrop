'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

interface ParticleFieldProps {
  count?: number
  className?: string
}

interface Particle {
  id: number
  size: number
  x: number
  delay: number
  duration: number
  drift: number
  opacity: number
}

/**
 * Renders floating particle dots that drift upward slowly.
 * Purely decorative — pointer-events disabled.
 *
 * Particles are generated client-side only (after mount): Math.random()
 * during SSR would produce a different sequence in the browser and trigger
 * a hydration attribute mismatch. Until mounted we render the (invisible)
 * container so layout stays identical.
 */
export function ParticleField({ count = 24, className }: ParticleFieldProps) {
  const [particles, setParticles] = useState<Particle[]>([])

  // v4 (10.2): skip generating particles entirely when the user (or OS) asks
  // for reduced motion — zero animated nodes instead of frozen ones.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (mq?.matches || document.documentElement.classList.contains('flux-reduce-motion')) return
    // Deferred via setTimeout: setState inside an effect body triggers a
    // cascading-render lint error, and the tick delay is imperceptible.
    const id = setTimeout(() => {
      setParticles(
        Array.from({ length: count }).map((_, i) => ({
          id: i,
          size: 2 + Math.random() * 4,
          x: Math.random() * 100,
          delay: Math.random() * 8,
          duration: 12 + Math.random() * 10,
          drift: (Math.random() - 0.5) * 40,
          opacity: 0.15 + Math.random() * 0.35,
        }))
      )
    }, 0)
    return () => clearTimeout(id)
  }, [count])

  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}
      aria-hidden="true"
    >
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full bg-flux-500"
          style={{
            width: p.size,
            height: p.size,
            left: `${p.x}%`,
            bottom: '-10px',
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
