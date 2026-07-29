'use client'

import { motion } from 'framer-motion'

interface FluxLogoProps {
  size?: number
  className?: string
  animated?: boolean
}

export function FluxLogo({ size = 40, className = '', animated = true }: FluxLogoProps) {
  return (
    <div
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="flux-grad-main" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
            <stop stopColor="oklch(0.70 0.15 170)" />
            <stop offset="0.5" stopColor="oklch(0.72 0.14 200)" />
            <stop offset="1" stopColor="oklch(0.76 0.18 145)" />
          </linearGradient>
          <linearGradient id="flux-grad-ring" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
            <stop stopColor="oklch(0.70 0.15 170 / 0.9)" />
            <stop offset="1" stopColor="oklch(0.76 0.18 145 / 0.4)" />
          </linearGradient>
        </defs>
        {/* Outer rotating ring */}
        {animated && (
          <circle
            cx="24"
            cy="24"
            r="22"
            stroke="url(#flux-grad-ring)"
            strokeWidth="1.5"
            strokeDasharray="4 6"
            className="flux-orb-ring"
            style={{ transformOrigin: 'center' }}
          />
        )}
        {/* Main rounded square */}
        <rect
          x="6"
          y="6"
          width="36"
          height="36"
          rx="11"
          fill="url(#flux-grad-main)"
          className={animated ? 'flux-orb' : ''}
          style={{ transformOrigin: 'center' }}
        />
        {/* Drop glyph */}
        <path
          d="M24 13c0 0-7 8-7 13.5a7 7 0 0 0 14 0C31 21 24 13 24 13z"
          fill="white"
          fillOpacity="0.95"
        />
        {/* Flow arrows inside drop */}
        <path
          d="M20.5 26.5a3.5 3.5 0 0 0 3.5 3.5"
          stroke="oklch(0.54 0.15 174)"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  )
}

export function FluxWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-bold tracking-tight ${className}`}>
      <span className="flux-gradient-text">Flux</span>
      <span className="text-foreground">Drop</span>
    </span>
  )
}
