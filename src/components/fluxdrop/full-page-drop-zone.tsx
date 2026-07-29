'use client'

import { useState, useCallback, useRef, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { UploadCloud } from 'lucide-react'

interface FullPageDropZoneProps {
  onFiles: (files: File[]) => void
  children: ReactNode
  /** When true, drops are accepted (e.g. only in pre-transfer sender state). */
  enabled: boolean
}

/**
 * Wraps children and shows a full-page drop overlay when files are dragged
 * anywhere over the page. Calls onFiles when dropped.
 */
export function FullPageDropZone({ onFiles, children, enabled }: FullPageDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return
      e.preventDefault()
      // Only react to drags that contain files
      if (!e.dataTransfer.types.includes('Files')) return
      dragCounter.current += 1
      setIsDragging(true)
    },
    [enabled]
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return
      e.preventDefault()
      dragCounter.current -= 1
      if (dragCounter.current <= 0) {
        dragCounter.current = 0
        setIsDragging(false)
      }
    },
    [enabled]
  )

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [enabled]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return
      e.preventDefault()
      dragCounter.current = 0
      setIsDragging(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) onFiles(files)
    },
    [enabled, onFiles]
  )

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="relative"
    >
      {children}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center"
          >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />
            {/* Drop zone card */}
            <motion.div
              initial={{ scale: 0.9, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 10 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              className="relative rounded-2xl border-2 border-dashed border-flux-500 bg-flux-500/10 px-12 py-10 text-center shadow-2xl"
            >
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-flux-500/20 text-flux-600 dark:text-flux-400">
                <UploadCloud className="h-8 w-8" />
              </div>
              <p className="text-lg font-semibold">Drop files to add them</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Release anywhere to add to your transfer
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
