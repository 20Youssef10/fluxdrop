'use client'

import { Keyboard, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface ShortcutsHintProps {
  view: string
}

const SHORTCUTS = [
  { keys: ['S'], label: 'Send files', views: ['landing'] },
  { keys: ['R'], label: 'Receive files', views: ['landing'] },
  { keys: ['Esc'], label: 'Back to home', views: ['sender', 'receiver'] },
  { keys: ['P'], label: 'Pause / resume', views: ['sender', 'receiver'] },
  { keys: ['⌘', 'K'], label: 'Toggle diagnostics', views: ['sender', 'receiver'] },
  { keys: ['⌘', 'J'], label: 'Toggle theme', views: ['landing', 'sender', 'receiver'] },
]

export function ShortcutsHint({ view }: ShortcutsHintProps) {
  const visible = SHORTCUTS.filter((s) => s.views.includes(view))
  if (visible.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <Keyboard className="h-3.5 w-3.5" />
      {visible.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1">
          {s.keys.map((k) => (
            <kbd
              key={k}
              className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted/60 px-1 font-mono text-[10px] font-medium text-foreground"
            >
              {k}
            </kbd>
          ))}
          <span className="ml-0.5">{s.label}</span>
        </span>
      ))}
    </div>
  )
}
