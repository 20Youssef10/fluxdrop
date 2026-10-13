'use client'

import { Keyboard } from 'lucide-react'

interface ShortcutsHintProps {
  view: string
  onOpenShortcuts?: () => void
}

const SHORTCUTS = [
  { keys: ['S'], label: 'Send files', views: ['landing'] },
  { keys: ['R'], label: 'Receive files', views: ['landing'] },
  { keys: ['Esc'], label: 'Back to home', views: ['sender', 'receiver'] },
  { keys: ['P'], label: 'Pause / resume', views: ['sender', 'receiver'] },
  { keys: ['⌘', 'K'], label: 'Toggle diagnostics', views: ['sender', 'receiver'] },
  { keys: ['⌘', 'J'], label: 'Toggle theme', views: ['landing', 'sender', 'receiver'] },
]

export function ShortcutsHint({ view, onOpenShortcuts }: ShortcutsHintProps) {
  const visible = SHORTCUTS.filter((s) => s.views.includes(view))
  if (visible.length === 0) return null

  const content = (
    <>
      <Keyboard className="h-3.5 w-3.5 transition-colors group-hover:text-flux-500" />
      {visible.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1">
          {s.keys.map((k) => (
            <kbd
              key={k}
              className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted/60 px-1 font-mono text-[10px] font-medium text-foreground transition-colors group-hover:border-flux-500/40"
            >
              {k}
            </kbd>
          ))}
          <span className="ml-0.5">{s.label}</span>
        </span>
      ))}
      <span className="ml-1 inline-flex items-center gap-1 text-flux-600 dark:text-flux-400 opacity-0 transition-opacity group-hover:opacity-100">
        <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-flux-500/40 bg-flux-500/10 px-1 font-mono text-[10px] font-semibold">
          ?
        </kbd>
        all shortcuts
      </span>
    </>
  )

  if (!onOpenShortcuts) {
    return <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">{content}</div>
  }

  return (
    <button
      type="button"
      onClick={onOpenShortcuts}
      aria-label="Show all keyboard shortcuts"
      title="Show all keyboard shortcuts (press ?)"
      className="group flex flex-wrap items-center justify-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flux-500/50"
    >
      {content}
    </button>
  )
}
