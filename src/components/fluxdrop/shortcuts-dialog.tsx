'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Keyboard, Home, Send, Download, Pause, Activity, Paintbrush, HelpCircle } from 'lucide-react'

interface ShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const GROUPS: {
  title: string
  icon: React.ReactNode
  items: { keys: string[]; label: string; hint?: string }[]
}[] = [
  {
    title: 'On the landing page',
    icon: <Home className="h-3.5 w-3.5" />,
    items: [
      { keys: ['S'], label: 'Send files', hint: 'jump straight to the send queue' },
      { keys: ['R'], label: 'Receive files', hint: 'open the join form' },
      { keys: ['⌘', 'J'], label: 'Toggle theme', hint: 'light / dark' },
      { keys: ['?'], label: 'This dialog', hint: 'press Shift + / anywhere' },
    ],
  },
  {
    title: 'During a transfer',
    icon: <Activity className="h-3.5 w-3.5" />,
    items: [
      { keys: ['P'], label: 'Pause / resume', hint: 'either side can pause the stream' },
      { keys: ['Esc'], label: 'Back to home', hint: 'cancels an in-progress room' },
      { keys: ['⌘', 'K'], label: 'Toggle diagnostics', hint: 'ICE pair, throughput, buffer' },
    ],
  },
]

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-flux-500" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            FluxDrop is fully keyboard-driven. Shortcuts are ignored while typing in a field.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {group.icon}
                {group.title}
              </p>
              <div className="space-y-1.5">
                {group.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/40 px-3 py-2 transition-colors hover:border-flux-500/30 hover:bg-flux-500/5"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{item.label}</p>
                      {item.hint && (
                        <p className="text-[10px] text-muted-foreground truncate">{item.hint}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {item.keys.map((k) => (
                        <kbd
                          key={k}
                          className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-md border border-border bg-muted/70 px-1.5 font-mono text-[11px] font-semibold text-foreground shadow-sm"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <p className="flex items-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
            <HelpCircle className="h-3.5 w-3.5 shrink-0 text-flux-500" />
            Looking for privacy details &amp; FAQ? Open the{' '}
            <span className="inline-flex items-center gap-1 font-medium text-foreground">
              <HelpCircle className="h-3 w-3" /> Help
            </span>{' '}
            dialog from the header.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
