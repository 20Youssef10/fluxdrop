'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MessageSquareText, Copy, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTransferStore } from '@/stores/transfer-store'

/**
 * Receiver-side snippet preview: when a small text snippet arrives, show its
 * content immediately with a one-click copy — no need to hunt for the file.
 */
export function SnippetPreviewDialog() {
  const preview = useTransferStore((s) => s.snippetPreview)
  const setSnippetPreview = useTransferStore((s) => s.setSnippetPreview)
  const [copied, setCopied] = useState(false)

  const close = () => {
    setSnippetPreview(null)
    setCopied(false)
  }

  const copy = async () => {
    if (!preview) return
    try {
      await navigator.clipboard.writeText(preview.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* ignore */ }
  }

  return (
    <AnimatePresence>
      {preview && (
        <motion.div
          key="snippet-preview"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) close() }}
          role="dialog"
          aria-modal="true"
          aria-label="Received text snippet"
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            className="w-full max-w-lg"
          >
            <Card className="flux-glass overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border/50 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-flux-500/10 text-flux-600 dark:text-flux-400">
                    <MessageSquareText className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Text snippet received</h3>
                    <p className="text-[11px] text-muted-foreground">
                      Saved as <code className="font-mono">{preview.name}</code>
                    </p>
                  </div>
                </div>
                <Badge variant="outline" className="border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
                  SHA-256 ✓
                </Badge>
              </div>

              {/* Content */}
              <div className="p-4">
                <div className="max-h-64 overflow-y-auto flux-scroll rounded-lg border border-border/50 bg-card/60 p-3">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                    {preview.text}
                  </pre>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {preview.text.length.toLocaleString()} characters
                </p>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2 border-t border-border/50 p-4 pt-3">
                <Button variant="outline" size="sm" onClick={copy} className="text-xs">
                  {copied ? <Check className="mr-1.5 h-3.5 w-3.5 text-flux-500" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy text'}
                </Button>
                <Button size="sm" onClick={close} className="bg-flux-600 hover:bg-flux-700 text-white text-xs">
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Close
                </Button>
              </div>
            </Card>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
