'use client'

import { useEffect, useRef, useState } from 'react'
import { MessageSquare, Send, X, Copy, ClipboardPaste, QrCode } from 'lucide-react'
import { QRCodeCanvas } from 'qrcode.react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { SNIPPET_MAX_CHARS, SNIPPET_QR_MAX_CHARS } from '@/lib/fluxdrop/snippet'

interface TextSnippetShareProps {
  /** Called with a ready-to-transfer .txt File built from the snippet text. */
  onShare: (file: File) => void
  disabled?: boolean
}

const MAX_TEXT_LENGTH = SNIPPET_MAX_CHARS

/** Build a friendly, sortable snippet filename like `snippet-2026-10-12-0930.txt`. */
export function makeSnippetFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `snippet-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`
}

/** Wrap raw text into a text/plain File ready for the transfer pipeline. */
export function makeSnippetFile(text: string): File {
  const blob = new Blob([text], { type: 'text/plain' })
  return new File([blob], makeSnippetFileName(), {
    type: 'text/plain',
    lastModified: Date.now(),
  })
}

/**
 * Allows sending a short text snippet (up to 10,000 chars) as a "file"
 * to the receiver. The text is wrapped in a .txt File object and handed
 * to the parent via onShare, joining the regular file queue.
 */
export function TextSnippetShare({ onShare, disabled }: TextSnippetShareProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autofocus + Escape-to-close while the dialog is open.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => textareaRef.current?.focus(), 50)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Clipboard paste-to-draft: the page-level paste handler in sender view
  // dispatches `fluxdrop:paste-snippet` with plain text (no files present),
  // and we open the composer pre-filled — paste a link anywhere to send it.
  useEffect(() => {
    const onPasteSnippet = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail
      const text = (detail?.text ?? '').slice(0, MAX_TEXT_LENGTH)
      if (!text.trim()) return
      setText(text)
      setOpen(true)
    }
    window.addEventListener('fluxdrop:paste-snippet', onPasteSnippet)
    return () => window.removeEventListener('fluxdrop:paste-snippet', onPasteSnippet)
  }, [])

  const handleShare = () => {
    if (!text.trim()) return
    onShare(makeSnippetFile(text))
    setOpen(false)
    setText('')
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  const handlePaste = async () => {
    try {
      const clipText = await navigator.clipboard.readText()
      if (clipText) setText(clipText.slice(0, MAX_TEXT_LENGTH))
    } catch { /* ignore */ }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="w-full border-flux-500/30 hover:bg-flux-500/5 text-xs"
      >
        <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
        Share text snippet
      </Button>

      {open && (
        <div
          className="pointer-events-auto fixed inset-0 z-[65] flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          role="dialog"
          aria-modal="true"
          aria-label="Share text snippet"
        >
          <Card className="flux-glass w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-flux-500" />
                  Share text snippet
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Send a link, note, or code block as a .txt file
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} className="h-8 w-8" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="snippet-text">Text content</Label>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${text.length >= MAX_TEXT_LENGTH ? 'border-amber-500/40 text-amber-600 dark:text-amber-400' : ''}`}
                >
                  {text.length.toLocaleString()} / {MAX_TEXT_LENGTH.toLocaleString()}
                </Badge>
              </div>
              <Textarea
                id="snippet-text"
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT_LENGTH))}
                placeholder="Type or paste text to share…"
                className="min-h-[160px] font-mono text-sm"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleShare()
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handlePaste} className="text-xs">
                <ClipboardPaste className="mr-1 h-3 w-3" />
                Paste
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopy} disabled={!text} className="text-xs">
                <Copy className="mr-1 h-3 w-3" />
                {copied ? 'Copied' : 'Copy'}
              </Button>
              {/* v4 (4.6): snippet → QR for tiny payloads — no connection needed */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowQr((v) => !v)}
                disabled={!text || text.length > SNIPPET_QR_MAX_CHARS}
                className="text-xs"
                title={
                  text.length > SNIPPET_QR_MAX_CHARS
                    ? `QR scan works up to ${SNIPPET_QR_MAX_CHARS} characters`
                    : 'Show a QR of this snippet — scannable without any connection'
                }
              >
                <QrCode className="mr-1 h-3 w-3" />
                QR
              </Button>
              <span className="ml-auto text-[10px] text-muted-foreground hidden sm:inline">
                ⌘/Ctrl + Enter to add
              </span>
            </div>

            {/* QR preview for tiny snippets */}
            {showQr && text.length <= SNIPPET_QR_MAX_CHARS && (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-flux-500/30 bg-flux-500/5 p-4">
                <QRCodeCanvas value={text} size={180} marginSize={2} aria-label="Snippet QR code" />
                <p className="text-[10px] text-muted-foreground">
                  Scan on the other device — no pairing, no connection, no server.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-border/50">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleShare}
                disabled={!text.trim()}
                className="bg-flux-600 hover:bg-flux-700 text-white"
              >
                <Send className="mr-1.5 h-4 w-4" />
                Add to transfer
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}
