'use client'

import { useTheme } from 'next-themes'
import { Moon, Sun, Settings, Wifi, WifiOff, Plus, Trash2, Server, User, Shield } from 'lucide-react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { useState, useEffect } from 'react'
import { useSessionStore, type IceServerConfig } from '@/stores/session-store'
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
  const customIceServers = useSessionStore((s) => s.customIceServers)
  const useCustomIce = useSessionStore((s) => s.useCustomIce)
  const setCustomIceServers = useSessionStore((s) => s.setCustomIceServers)
  const setUseCustomIce = useSessionStore((s) => s.setUseCustomIce)

  const [draft, setDraft] = useState(alias)
  const [iceDraft, setIceDraft] = useState<IceServerConfig[]>([])
  const [useIceDraft, setUseIceDraft] = useState(false)

  useEffect(() => {
    if (!open) return
    // Sync draft state from the store when the dialog opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(alias)
    setIceDraft(
      customIceServers.length > 0
        ? customIceServers
        : [{ urls: 'stun:stun.l.google.com:19302' }]
    )
    setUseIceDraft(useCustomIce)
  }, [open, alias, customIceServers, useCustomIce])

  const save = () => {
    if (draft.trim()) setAlias(draft.trim())
    setCustomIceServers(iceDraft)
    setUseCustomIce(useIceDraft)
    onOpenChange(false)
  }

  const addIceServer = () => {
    setIceDraft([...iceDraft, { urls: 'turn:your-turn-server.com:3478' }])
  }
  const removeIceServer = (idx: number) => {
    setIceDraft(iceDraft.filter((_, i) => i !== idx))
  }
  const updateIceServer = (idx: number, field: keyof IceServerConfig, value: string) => {
    setIceDraft(iceDraft.map((s, i) => (i === idx ? { ...s, [field]: value } : s)))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure your device identity and network preferences.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="device" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="device" className="text-xs">
              <User className="mr-1.5 h-3.5 w-3.5" />
              Device
            </TabsTrigger>
            <TabsTrigger value="network" className="text-xs">
              <Server className="mr-1.5 h-3.5 w-3.5" />
              Network
            </TabsTrigger>
            <TabsTrigger value="privacy" className="text-xs">
              <Shield className="mr-1.5 h-3.5 w-3.5" />
              Privacy
            </TabsTrigger>
          </TabsList>

          {/* Device tab */}
          <TabsContent value="device" className="space-y-4 mt-4">
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
                {draft.length}/32 characters · shown to peers during pairing
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground mb-1">Device identity</p>
              <span>
                A unique device ID is generated locally and stored in your browser.
                It persists across sessions to identify you to peers.
              </span>
            </div>
          </TabsContent>

          {/* Network tab */}
          <TabsContent value="network" className="space-y-4 mt-4">
            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div className="pr-3">
                <p className="text-sm font-medium">Custom ICE servers</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Use TURN/STUN servers for restrictive networks (e.g. corporate firewalls).
                </p>
              </div>
              <Switch checked={useIceDraft} onCheckedChange={setUseIceDraft} />
            </div>

            {useIceDraft && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                    Servers ({iceDraft.length})
                  </Label>
                  <Button variant="ghost" size="sm" onClick={addIceServer} className="h-7 text-xs">
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add
                  </Button>
                </div>
                <div className="max-h-48 overflow-y-auto flux-scroll space-y-2 pr-1">
                  {iceDraft.map((srv, idx) => (
                    <div key={idx} className="rounded-lg border border-border/50 bg-card/60 p-2.5 space-y-2">
                      <div className="flex items-center gap-2">
                        <Input
                          value={srv.urls}
                          onChange={(e) => updateIceServer(idx, 'urls', e.target.value)}
                          placeholder="turn:host:port or stun:host:port"
                          className="h-8 text-xs font-mono"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeIceServer(idx)}
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          value={srv.username ?? ''}
                          onChange={(e) => updateIceServer(idx, 'username', e.target.value)}
                          placeholder="username (optional)"
                          className="h-8 text-xs"
                        />
                        <Input
                          value={srv.credential ?? ''}
                          onChange={(e) => updateIceServer(idx, 'credential', e.target.value)}
                          placeholder="credential (optional)"
                          className="h-8 text-xs"
                          type="password"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-muted-foreground">
                  <span className="font-medium text-amber-600 dark:text-amber-400">Tip:</span>{' '}
                  TURN servers relay traffic when direct P2P fails. Use a trusted provider —
                  relayed traffic passes through the TURN server (still encrypted via DTLS).
                </div>
              </div>
            )}
            {!useIceDraft && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Default STUN servers</p>
                <span>Using public Google + Cloudflare STUN servers. Sufficient for most home/mobile networks.</span>
              </div>
            )}
          </TabsContent>

          {/* Privacy tab */}
          <TabsContent value="privacy" className="space-y-3 mt-4">
            <div className="rounded-lg border border-flux-500/30 bg-flux-500/5 p-3 text-xs">
              <p className="font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-flux-500" />
                End-to-end encrypted
              </p>
              <span className="text-muted-foreground">
                All file data flows over a DTLS-encrypted WebRTC DataChannel. Not even the
                signaling server can read your files.
              </span>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground space-y-2">
              <div>
                <p className="font-medium text-foreground mb-0.5">What the signaling server sees</p>
                <span>Your device alias, room ID, PIN, and WebRTC connection metadata (SDP/ICE).</span>
              </div>
              <Separator />
              <div>
                <p className="font-medium text-foreground mb-0.5">What stays on your device</p>
                <span>File contents, transfer history (IndexedDB), device preferences.</span>
              </div>
              <Separator />
              <div>
                <p className="font-medium text-foreground mb-0.5">What is never stored</p>
                <span>File data on any server. Transfers are ephemeral and peer-to-peer.</span>
              </div>
            </div>
          </TabsContent>
        </Tabs>
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
