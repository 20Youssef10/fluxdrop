'use client'

import { useEffect, useRef, useState } from 'react'

interface AnimatedNumberProps {
  value: number
  duration?: number      // ms
  format?: (n: number) => string
  className?: string
}

/**
 * Smoothly animates from the previous value to the new value.
 * Uses requestAnimationFrame with an ease-out curve.
 */
export function AnimatedNumber({
  value,
  duration = 600,
  format = (n) => Math.round(n).toString(),
  className,
}: AnimatedNumberProps) {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number>(0)

  useEffect(() => {
    if (value === display) return
    fromRef.current = display
    startRef.current = performance.now()

    const animate = (now: number) => {
      const elapsed = now - startRef.current
      const t = Math.min(1, elapsed / duration)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3)
      const current = fromRef.current + (value - fromRef.current) * eased
      setDisplay(current)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate)
      } else {
        setDisplay(value)
      }
    }

    rafRef.current = requestAnimationFrame(animate)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [value, duration])

  return <span className={className}>{format(display)}</span>
}
