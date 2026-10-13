'use client'

// Eco badge for the landing hero: shows the cumulative bandwidth saved by
// resume-skips across all transfers on this device. Hidden when there is
// nothing saved yet — the hero stays clean for first-time visitors.

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Leaf } from 'lucide-react'
import { listTransfers } from '@/lib/fluxdrop/resume'
import { formatBytes } from '@/lib/fluxdrop/format'

export function EcoBadge() {
  const [saved, setSaved] = useState(0)
  const [resumes, setResumes] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const recs = await listTransfers()
        if (cancelled) return
        setSaved(recs.reduce((s, r) => s + (r.resumedSavedBytes ?? 0), 0))
        setResumes(recs.filter((r) => r.resumedAt).length)
      } catch {
        /* history unavailable — badge stays hidden */
      }
    }
    load()
    // Refresh periodically so completing a transfer updates the badge
    // without a page reload.
    const id = setInterval(load, 10000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (saved <= 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.55 }}
      className="mt-6 flex justify-center"
    >
      <div
        className="inline-flex items-center gap-2 rounded-full border border-flux-500/30 bg-flux-500/5 px-4 py-1.5 text-xs text-flux-700 dark:text-flux-300"
        title="Total data that never travelled the wire thanks to resume skips"
      >
        <Leaf className="h-3.5 w-3.5 text-flux-500" aria-hidden />
        <span>
          <span className="font-semibold tabular-nums">{formatBytes(saved)}</span> of bandwidth saved
        </span>
        <span className="text-muted-foreground" aria-hidden>
          ·
        </span>
        <span className="text-muted-foreground tabular-nums">
          {resumes} resume{resumes !== 1 ? 's' : ''}
        </span>
      </div>
    </motion.div>
  )
}
