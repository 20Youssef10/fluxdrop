'use client'

import { memo, useMemo } from 'react'

interface SpeedSparklineProps {
  data: number[]      // speed samples in bytes/sec
  max?: number        // optional fixed max; otherwise derived
  width?: number
  height?: number
  className?: string
  showAverage?: boolean  // draw an average speed dashed line
  showMax?: boolean      // draw a max-speed marker dot
}

/**
 * Renders a live SVG sparkline of transfer speed samples.
 * Fills the area under the curve with a gradient.
 * Optionally draws a dashed average line and a max-speed marker.
 */
export const SpeedSparkline = memo(function SpeedSparkline({
  data,
  max,
  width = 280,
  height = 56,
  className,
  showAverage = true,
  showMax = true,
}: SpeedSparklineProps) {
  const { path, area, peak, current, avgY, maxMarker } = useMemo(() => {
    if (data.length === 0) {
      return { path: '', area: '', peak: 0, current: 0, avgY: null, maxMarker: null }
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

    // Average line
    const avg = data.reduce((s, v) => s + v, 0) / data.length
    const avgYVal = height - (avg / derivedMax) * (height - 4) - 2

    // Max marker (find the index of the max value)
    const maxIdx = data.indexOf(Math.max(...data))
    const maxMarkerVal = maxIdx >= 0
      ? { x: maxIdx * step, y: height - (data[maxIdx] / derivedMax) * (height - 4) - 2 }
      : null

    return {
      path: linePath,
      area: areaPath,
      peak: Math.max(...data),
      current: data[data.length - 1] ?? 0,
      avgY: avgYVal,
      maxMarker: maxMarkerVal,
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

      {/* Average speed dashed line */}
      {showAverage && avgY != null && (
        <g>
          <line
            x1="0"
            y1={avgY}
            x2={width}
            y2={avgY}
            stroke="oklch(0.72 0.14 200)"
            strokeWidth="1"
            strokeDasharray="4 3"
            opacity="0.6"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}

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

      {/* Max speed marker */}
      {showMax && maxMarker && (
        <g>
          <circle cx={maxMarker.x} cy={maxMarker.y} r="3.5" fill="oklch(0.78 0.16 85)" stroke="white" strokeWidth="1" />
          <circle cx={maxMarker.x} cy={maxMarker.y} r="6" fill="none" stroke="oklch(0.78 0.16 85)" strokeWidth="1" opacity="0.4">
            <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" repeatCount="indefinite" />
          </circle>
        </g>
      )}

      {/* Last-point dot */}
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
})