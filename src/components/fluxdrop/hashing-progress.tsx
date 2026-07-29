'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useTransferStore } from '@/stores/transfer-store'
import { formatBytes } from '@/lib/fluxdrop/format'

/**
 * Shows a hashing progress card during the VALIDATING state.
 * Displays which file is currently being hashed and overall progress.
 */
export function HashingProgress() {
  const hashingProgress = useTransferStore((s) => s.hashingProgress)
  const transferState = useTransferStore((s) => s.transferState)

  const isVisible = transferState === 'VALIDATING' && hashingProgress !== null

  return (
    <AnimatePresence>
      {isVisible && hashingProgress && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.25 }}
        >
          <Card className="flux-glass p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-flux-500/10 text-flux-600 dark:text-flux-400">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  Hashing files for integrity verification
                </p>
                <p className="text-xs text-muted-foreground">
                  SHA-256 · {hashingProgress.current} of {hashingProgress.total} files
                </p>
              </div>
            </div>

            {/* Progress bar */}
            <Progress
              value={(hashingProgress.current / hashingProgress.total) * 100}
              className="h-2"
            />

            {/* Current file */}
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" title={hashingProgress.fileName}>
                {hashingProgress.fileName}
              </span>
            </div>

            <p className="mt-2 text-[10px] text-muted-foreground">
              Computing checksums ensures your files arrive uncorrupted.
              This happens once before the transfer begins.
            </p>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
