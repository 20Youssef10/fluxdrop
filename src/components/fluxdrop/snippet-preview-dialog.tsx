'use client'

import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MessageSquareText, Copy, Check, X, FileCode2, BookOpen, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTransferStore } from '@/stores/transfer-store'
import { guessSnippetLanguage, looksLikeMarkdown } from '@/lib/fluxdrop/snippet'

/** Lazy-loaded highlighter + markdown renderer (heavy Prism bundle only pays
 * its cost when a snippet actually needs it). */
let highlighterMod: typeof import('react-syntax-highlighter') | null = null
let prismTheme: typeof import('react-syntax-highlighter').PrismTheme | null = null
let markdownMod: typeof import('react-markdown') | null = null
let modPromise: Promise<void> | null = null

function ensureMods(): Promise<void> {
  if (!modPromise) {
    modPromise = (async () => {
      const [hl, theme, md] = await Promise.all([
        import('react-syntax-highlighter'),
        // One Dark theme — matches the app's dark surfaces; harmless in light.
        import('react-syntax-highlighter/dist/esm/styles/prism').then((m) => m.vscDarkPlus),
        import('react-markdown'),
      ])
      highlighterMod = hl
      prismTheme = theme
      markdownMod = md
    })()
  }
  return modPromise
}

/**
 * Receiver-side snippet preview: when a small text snippet arrives, show its
 * content immediately with a one-click copy — no need to hunt for the file.
 * v4 (4.6): rich rendering — syntax-highlighted code (auto language guess)
 * and Markdown preview alongside the raw text.
 */
export function SnippetPreviewDialog() {
  const preview = useTransferStore((s) => s.snippetPreview)
  const setSnippetPreview = useTransferStore((s) => s.setSnippetPreview)
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'auto' | 'raw' | 'markdown'>('auto')
  const [modsReady, setModsReady] = useState(false)

  const language = useMemo(() => (preview ? guessSnippetLanguage(preview.text) : 'text'), [preview])
  const isMarkdown = useMemo(() => (preview ? looksLikeMarkdown(preview.text) : false), [preview])

  // Load the highlighter/markdown bundles only when a snippet is open.
  if (preview && !modsReady && !modPromise) {
    void ensureMods().then(() => setModsReady(true))
  }

  const close = () => {
    setSnippetPreview(null)
    setCopied(false)
    setMode('auto')
  }

  const copy = async () => {
    if (!preview) return
    try {
      await navigator.clipboard.writeText(preview.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* ignore */ }
  }

  const showHighlight = modsReady && language !== 'text' && language !== 'markdown' && mode === 'auto'
  const showMarkdown = modsReady && isMarkdown && mode === 'markdown'

  return (
    <AnimatePresence>
      {preview && (
        <motion.div
          key="snippet-preview"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-auto fixed inset-0 z-[65] flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm"
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

              {/* v4: view mode switch — highlight / markdown / raw */}
              <div className="flex items-center gap-1.5 px-4 pt-3">
                <Button
                  variant={mode === 'auto' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 gap-1 px-2 text-[10px]"
                  onClick={() => setMode('auto')}
                  aria-pressed={mode === 'auto'}
                >
                  <FileCode2 className="h-3 w-3" />
                  {language !== 'text' ? language : 'highlight'}
                </Button>
                {isMarkdown && (
                  <Button
                    variant={mode === 'markdown' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => setMode('markdown')}
                    aria-pressed={mode === 'markdown'}
                  >
                    <BookOpen className="h-3 w-3" />
                    Markdown
                  </Button>
                )}
                <Button
                  variant={mode === 'raw' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 gap-1 px-2 text-[10px]"
                  onClick={() => setMode('raw')}
                  aria-pressed={mode === 'raw'}
                >
                  <Hash className="h-3 w-3" />
                  Raw
                </Button>
              </div>

              {/* Content */}
              <div className="p-4">
                <div className="max-h-64 overflow-y-auto flux-scroll rounded-lg border border-border/50 bg-card/60">
                  {showHighlight && highlighterMod && prismTheme ? (
                    <highlighterMod.Prism language={language} style={prismTheme} customStyle={{ margin: 0, background: 'transparent', fontSize: '11px' }}>
                      {preview.text}
                    </highlighterMod.Prism>
                  ) : showMarkdown && markdownMod ? (
                    <div className="flux-markdown-preview p-3 text-xs leading-relaxed [&_h1]:text-base [&_h2]:text-sm [&_a]:text-flux-600 [&_a]:underline [&_code]:font-mono [&_code]:text-[11px] [&_pre]:overflow-x-auto [&_li]:ml-4 [&_li]:list-disc">
                      <markdownMod.default>{preview.text}</markdownMod.default>
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground p-3">
                      {preview.text}
                    </pre>
                  )}
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {preview.text.length.toLocaleString()} characters
                  {language !== 'text' ? ` · detected ${language}` : ''}
                  {isMarkdown ? ' · markdown' : ''}
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
