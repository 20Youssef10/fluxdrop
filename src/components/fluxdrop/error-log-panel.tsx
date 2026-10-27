'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X, ScrollText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTransferStore } from '@/stores/transfer-store'

/**
 * Persistent error log panel that doesn't disappear like toasts.
 * Shows the last 20 errors during a transfer, so users can see what went wrong
 * even after rapid-fire errors.
 */
export function ErrorLogPanel() {
  const errorLog = useTransferStore((s) => s.errorLog)
  const clearErrorLog = useTransferStore((s) => s.clearErrorLog)
  const transferState = useTransferStore((s) => s.transferState)

  // Only show if there are errors and we're in an active or failed transfer
  const isVisible = errorLog.length > 0 && (
    transferState === 'TRANSFERRING' ||
    transferState === 'RESUMING' ||
    transferState === 'FAILED' ||
    transferState === 'ERROR'
  )

  if (!isVisible) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={{ duration: 0.25 }}
      >
        <Card className="border-destructive/30 bg-destructive/5 overflow-hidden">
          <div className="flex items-center justify-between p-4 pb-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-destructive">
                  Transfer errors ({errorLog.length})
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Last {errorLog.length} error{errorLog.length > 1 ? 's' : ''} — these persist so you can review them
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearErrorLog}
              className="h-7 text-xs text-muted-foreground"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          </div>

          <ScrollArea className="max-h-48 flux-scroll">
            <div className="px-4 pb-4 space-y-1">
              {errorLog.map((entry, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-xs"
                >
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0 mt-0.5">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="text-destructive">{entry.message}</span>
                  {entry.chunkIndex != null && (
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">
                      chunk #{entry.chunkIndex}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </Card>
      </motion.div>
    </AnimatePresence>
  )
}
