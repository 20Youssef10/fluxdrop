'use client'

import { useState } from 'react'
import { MessageSquare, Send, X, Copy } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

interface TextSnippetShareProps {
  onShare: (text: string) => void
  disabled?: boolean
}

const MAX_TEXT_LENGTH = 10000

/**
 * Allows sending a short text snippet (up to 10,000 chars) as a "file"
 * to the receiver. The text is wrapped in a .txt File object.
 */
export function TextSnippetShare({ onShare, disabled }: TextSnippetShareProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')

  const handleShare = () => {
    if (!text.trim()) return
    const blob = new Blob([text], { type: 'text/plain' })
    const file = new File([blob], `snippet-${Date.now()}.txt`, { type: 'text/plain' })
    onShare(text)
    // Also add the file to the transfer
    // (The parent component handles the actual file list)
    setOpen(false)
    setText('')
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch { /* ignore */ }
  }

  const handlePaste = async () => {
    try {
      const clipText = await navigator.clipboard.readText()
      setText(clipText)
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
          <Card className="flux-glass w-full max-w-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-flux-500" />
                  Share text snippet
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Send a short text message as a .txt file
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="snippet-text">Text content</Label>
                <Badge variant="outline" className="text-[10px]">
                  {text.length} / {MAX_TEXT_LENGTH}
                </Badge>
              </div>
              <Textarea
                id="snippet-text"
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT_LENGTH))}
                placeholder="Type or paste text to share…"
                className="min-h-[160px] font-mono text-sm"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handlePaste} className="text-xs">
                Paste from clipboard
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopy} disabled={!text} className="text-xs">
                <Copy className="mr-1 h-3 w-3" />
                Copy
              </Button>
            </div>

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
