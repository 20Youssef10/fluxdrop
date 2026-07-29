'use client'

import { Wifi, WifiOff, AlertTriangle } from 'lucide-react'

export type QualityLevel = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'

export interface ConnectionQuality {
  level: QualityLevel
  rttMs: number | null
  label: string
  color: string
  bgColor: string
  borderColor: string
}

/**
 * Derives a connection quality rating from the WebRTC diagnostics.
 * Based on RTT (round-trip time) of the selected candidate pair.
 */
export function deriveQuality(diagnostics: any): ConnectionQuality {
  const rtt = diagnostics?.selectedPair?.currentRoundTripTime
  const rttMs = rtt != null ? rtt * 1000 : null

  if (rttMs == null) {
    return {
      level: 'unknown',
      rttMs: null,
      label: 'Unknown',
      color: 'text-muted-foreground',
      bgColor: 'bg-muted/50',
      borderColor: 'border-border',
    }
  }

  if (rttMs < 50) {
    return {
      level: 'excellent',
      rttMs,
      label: 'Excellent',
      color: 'text-flux-600 dark:text-flux-400',
      bgColor: 'bg-flux-500/10',
      borderColor: 'border-flux-500/40',
    }
  }
  if (rttMs < 150) {
    return {
      level: 'good',
      rttMs,
      label: 'Good',
      color: 'text-flux-600 dark:text-flux-400',
      bgColor: 'bg-flux-500/10',
      borderColor: 'border-flux-500/30',
    }
  }
  if (rttMs < 400) {
    return {
      level: 'fair',
      rttMs,
      label: 'Fair',
      color: 'text-amber-600 dark:text-amber-400',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/40',
    }
  }
  return {
    level: 'poor',
    rttMs,
    label: 'Poor',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
    borderColor: 'border-destructive/40',
  }
}

export function QualityIcon({ level, className }: { level: QualityLevel; className?: string }) {
  switch (level) {
    case 'excellent':
    case 'good':
      return <Wifi className={className} />
    case 'fair':
      return <AlertTriangle className={className} />
    case 'poor':
      return <WifiOff className={className} />
    default:
      return <Wifi className={className} />
  }
}

/**
 * Renders a signal-strength-style bar indicator.
 */
export function QualityBars({ level, className }: { level: QualityLevel; className?: string }) {
  const bars = level === 'excellent' ? 4 : level === 'good' ? 3 : level === 'fair' ? 2 : level === 'poor' ? 1 : 0
  const colorClass =
    level === 'excellent' || level === 'good'
      ? 'bg-flux-500'
      : level === 'fair'
      ? 'bg-amber-500'
      : level === 'poor'
      ? 'bg-destructive'
      : 'bg-muted-foreground/40'

  return (
    <div className={`flex items-end gap-0.5 ${className ?? ''}`} aria-label={`Signal quality: ${level}`}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={`w-1 rounded-sm transition-all ${i < bars ? colorClass : 'bg-muted-foreground/20'}`}
          style={{ height: `${(i + 1) * 3 + 3}px` }}
        />
      ))}
    </div>
  )
}
