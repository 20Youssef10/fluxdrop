'use client'

import { useMemo } from 'react'

interface SpeedSparklineProps {
  data: number[]      // speed samples in bytes/sec
  max?: number        // optional fixed max; otherwise derived
  width?: number
  height?: number
  className?: string
}

/**
 * Renders a live SVG sparkline of transfer speed samples.
 * Fills the area under the curve with a gradient.
 */
export function SpeedSparkline({
  data,
  max,
  width = 280,
  height = 56,
  className,
}: SpeedSparklineProps) {
  const { path, area, peak, current } = useMemo(() => {
    if (data.length === 0) {
      return { path: '', area: '', peak: 0, current: 0 }
    }
    const derivedMax = max ?? Math.max(...data, 1) * 1.15
    const step = data.length > 1 ? width / (data.length - 1) : width
    const points = data.map((v, i) => {
      const x = i * step
      const y = height - (v / derivedMax) * (height - 4) - 2
      return [x, y] as const
    })
    const linePath = points
      .map(([x, y], i) => (i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`))
      .join(' ')
    const areaPath = `${linePath} L ${width.toFixed(1)} ${height} L 0 ${height} Z`
    return {
      path: linePath,
      area: areaPath,
      peak: Math.max(...data),
      current: data[data.length - 1] ?? 0,
    }
  }, [data, max, width, height])

  if (data.length < 2) {
    return (
      <div
        className={`flex items-center justify-center text-[10px] text-muted-foreground ${className ?? ''}`}
        style={{ width, height }}
      >
        collecting speed data…
      </div>
    )
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="flux-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.62 0.16 172)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="oklch(0.62 0.16 172)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#flux-spark-grad)" />
      <path
        d={path}
        fill="none"
        stroke="oklch(0.62 0.16 172)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* last-point dot */}
      {data.length > 0 && (() => {
        const step = data.length > 1 ? width / (data.length - 1) : width
        const x = (data.length - 1) * step
        const derivedMax = max ?? Math.max(...data, 1) * 1.15
        const y = height - (current / derivedMax) * (height - 4) - 2
        return (
          <circle cx={x} cy={y} r="3" fill="oklch(0.70 0.15 170)">
            <animate attributeName="r" values="3;5;3" dur="1.5s" repeatCount="indefinite" />
          </circle>
        )
      })()}
    </svg>
  )
}
