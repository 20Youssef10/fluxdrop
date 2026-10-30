'use client'

// v4 (5.2): command palette (⌘K / Ctrl+K) — one home for every shortcut that
// already existed plus the v4 tools (debug bundle, speedrun). Built on cmdk
// via the shadcn command primitives; actions target stores and custom window
// events so no prop drilling from the page is needed.

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  ArrowLeft,
  Copy,
  Download,
  Gauge,
  Keyboard,
  MessageSquare,
  Monitor,
  Moon,
  PlayCircle,
  Receipt,
  Send,
  Settings,
  Sparkles,
} from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { useT } from '@/lib/fluxdrop/i18n'
import { copyDebugBundle } from '@/lib/fluxdrop/debug-bundle'
import { toast } from 'sonner'

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const setView = useSessionStore((s) => s.setView)
  const { theme, setTheme } = useTheme()
  const t = useT()

  // ⌘K / Ctrl+K toggles; Escape is handled by cmdk itself.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} aria-label={t('palette.open', 'Command palette')}>
      <CommandInput placeholder={t('palette.placeholder', 'Type a command or search…')} />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading={t('palette.transfer', 'Transfer')}>
          <CommandItem onSelect={() => run(() => setView('sender'))}>
            <Send className="mr-2 h-4 w-4" />
            {t('palette.send', 'Go to send mode')}
          </CommandItem>
          <CommandItem onSelect={() => run(() => setView('receiver'))}>
            <Download className="mr-2 h-4 w-4" />
            {t('palette.receive', 'Go to receive mode')}
          </CommandItem>
          {/* v5-c7: kiosk receive station (fullscreen QR + auto-accept). */}
          <CommandItem onSelect={() => run(() => window.dispatchEvent(new CustomEvent('fluxdrop:open-kiosk')))}>
            <Monitor className="mr-2 h-4 w-4" />
            {t('kiosk.open', 'Kiosk mode')}
            <span className="ml-auto text-[10px] text-muted-foreground">{t('kiosk.desc', 'Fullscreen receive station')}</span>
          </CommandItem>
          <CommandItem onSelect={() => run(() => setView('landing'))}>
            <ArrowLeft className="flux-flip-rtl me-2 h-4 w-4" />
            {t('palette.home', 'Back to home')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('palette.appearance', 'Appearance')}>
          <CommandItem
            onSelect={() =>
              run(() => setTheme(theme === 'dark' ? 'light' : 'dark'))
            }
          >
            <Moon className="mr-2 h-4 w-4" />
            {t('palette.theme', 'Toggle dark mode')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('palette.tools', 'Tools')}>
          <CommandItem onSelect={() => run(() => window.dispatchEvent(new CustomEvent('fluxdrop:toggle-diagnostics')))}>
            <Gauge className="mr-2 h-4 w-4" />
            {t('palette.diagnostics', 'Toggle diagnostics')}
          </CommandItem>
          <CommandItem onSelect={() => run(() => window.dispatchEvent(new CustomEvent('fluxdrop:open-settings')))}>
            <Settings className="mr-2 h-4 w-4" />
            {t('palette.settings', 'Open settings')}
          </CommandItem>
          <CommandItem onSelect={() => run(() => window.dispatchEvent(new CustomEvent('fluxdrop:open-help')))}>
            <MessageSquare className="mr-2 h-4 w-4" />
            Help &amp; FAQ
          </CommandItem>
          <CommandItem onSelect={() => run(() => window.dispatchEvent(new CustomEvent('fluxdrop:open-shortcuts')))}>
            <Keyboard className="mr-2 h-4 w-4" />
            {t('palette.shortcuts', 'Keyboard shortcuts')}
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(async () => {
                const ok = await copyDebugBundle()
                if (ok) toast.success('Debug bundle copied', { description: 'Sanitized: no file names, no IPs.' })
                else toast.error('Could not copy the debug bundle')
              })
            }
          >
            <Receipt className="mr-2 h-4 w-4" />
            {t('palette.debug', 'Copy debug bundle')}
          </CommandItem>
          <CommandItem onSelect={() => run(() => window.dispatchEvent(new CustomEvent('fluxdrop:open-speedrun')))}>
            <PlayCircle className="mr-2 h-4 w-4" />
            {t('palette.speedrun', 'Try the 10-second demo')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        <Sparkles className="h-3 w-3" /> FluxDrop command palette · ⌘K
      </div>
    </CommandDialog>
  )
}
