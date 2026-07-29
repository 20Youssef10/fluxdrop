'use client'

import { useTheme } from 'next-themes'
import { Moon, Sun, Settings, Github, Wifi, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useState, useEffect } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { FluxLogo, FluxWordmark } from './flux-logo'

export function FluxHeader({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const signalingConnected = useSessionStore((s) => s.signalingConnected)

  // Mounted flag is the canonical next-themes pattern for avoiding hydration mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <FluxLogo size={36} />
          <div className="flex flex-col leading-none">
            <FluxWordmark className="text-lg" />
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              P2P · WebRTC · Encrypted
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Connection status badge */}
          <Badge
            variant="outline"
            className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 ${
              signalingConnected
                ? 'border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300'
                : 'border-border bg-muted/50 text-muted-foreground'
            }`}
          >
            {signalingConnected ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-flux-500 opacity-75 flux-pulse-dot" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-flux-500" />
                </span>
                <span className="text-[11px] font-medium">Online</span>
              </>
            ) : (
              <>
                <WifiOff className="h-3 w-3" />
                <span className="text-[11px] font-medium">Offline</span>
              </>
            )}
          </Badge>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
            className="h-9 w-9"
          >
            {mounted && theme === 'dark' ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>

          {onOpenSettings && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenSettings}
              aria-label="Settings"
              className="h-9 w-9"
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const alias = useSessionStore((s) => s.alias)
  const setAlias = useSessionStore((s) => s.setAlias)
  const [draft, setDraft] = useState(alias)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setDraft(alias)
  }, [open, alias])

  const save = () => {
    if (draft.trim()) {
      setAlias(draft.trim())
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Device Settings</DialogTitle>
          <DialogDescription>
            Your device alias is shown to peers during pairing. Pick something recognizable.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="alias">Device alias</Label>
            <Input
              id="alias"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              maxLength={32}
              placeholder="e.g. SwiftFalcon-42"
            />
            <p className="text-xs text-muted-foreground">
              {draft.length}/32 characters
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground mb-1">Privacy</p>
            <span>
              Files are transferred directly between devices (WebRTC). The signaling
              server only relays connection setup metadata — it never sees, stores,
              or touches your file data.
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!draft.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
