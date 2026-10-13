'use client'

import { useTheme } from 'next-themes'
import { Moon, Sun, Settings, Wifi, WifiOff, Plus, Trash2, Server, User, Shield, HelpCircle, Bell, Volume2, BellOff, VolumeX, BadgeCheck, RotateCcw } from 'lucide-react'
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
import { useTransferStore } from '@/stores/transfer-store'
import { setSoundEnabled, unlockAudio } from '@/lib/fluxdrop/sound'
import { getTrustedPeers, removeTrustedPeer, clearTrustedPeers, type TrustedPeer } from '@/lib/fluxdrop/trusted-peers'
import { FluxLogo, FluxWordmark } from './flux-logo'

export function FluxHeader({ onOpenSettings, onOpenHelp }: { onOpenSettings?: () => void; onOpenHelp?: () => void }) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const signalingConnected = useSessionStore((s) => s.signalingConnected)
  const rtcState = useSessionStore((s) => s.rtcState)
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)
  const transferState = useTransferStore((s) => s.transferState)
  // A terminal transfer means the P2P session is over — "Reconnecting" would
  // imply an auto-recovery that is never coming (e.g. expired-room view).
  const transferTerminal =
    transferState === 'COMPLETE' ||
    transferState === 'CANCELLED' ||
    transferState === 'FAILED' ||
    transferState === 'ERROR'

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
          {/* Connection status badge.
              rtcState mirrors RTCPeerConnectionState: 'new' means "no P2P session yet"
              (NOT connecting) — only 'connecting', or 'connected' with the DataChannel
              still closed, represent genuine negotiation. */}
          <Badge
            variant="outline"
            className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 transition-colors ${
              dataChannelOpen
                ? 'border-flux-500/50 bg-flux-500/15 text-flux-700 dark:text-flux-300'
                : rtcState === 'connecting' || rtcState === 'connected'
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : rtcState === 'disconnected' || (rtcState === 'failed' && !transferTerminal)
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : signalingConnected
                ? 'border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300'
                : 'border-border bg-muted/50 text-muted-foreground'
            }`}
            title={`Signaling: ${signalingConnected ? 'connected' : 'disconnected'} · WebRTC: ${rtcState} · DataChannel: ${dataChannelOpen ? 'open' : 'closed'}`}
          >
            {dataChannelOpen ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-flux-500 opacity-75 flux-pulse-dot" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-flux-500" />
                </span>
                <span className="text-[11px] font-medium">P2P live</span>
              </>
            ) : rtcState === 'disconnected' || (rtcState === 'failed' && !transferTerminal) ? (
              <>
                <WifiOff className="h-3 w-3 animate-pulse" />
                <span className="text-[11px] font-medium">Reconnecting</span>
              </>
            ) : rtcState === 'connecting' || rtcState === 'connected' ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75 flux-pulse-dot" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                </span>
                <span className="text-[11px] font-medium">Connecting</span>
              </>
            ) : signalingConnected ? (
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

          {onOpenHelp && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenHelp}
              aria-label="Help"
              className="h-9 w-9"
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
          )}

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
  const soundEnabled = useSessionStore((s) => s.soundEnabled)
  const setSoundPref = useSessionStore((s) => s.setSoundEnabled)
  const notificationsEnabled = useSessionStore((s) => s.notificationsEnabled)
  const setNotificationsPref = useSessionStore((s) => s.setNotificationsEnabled)
  const autoAcceptTrusted = useSessionStore((s) => s.autoAcceptTrusted)
  const setAutoAcceptTrusted = useSessionStore((s) => s.setAutoAcceptTrusted)
  const autoAcceptResume = useSessionStore((s) => s.autoAcceptResume)
  const setAutoAcceptResume = useSessionStore((s) => s.setAutoAcceptResume)
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [trustedList, setTrustedList] = useState<TrustedPeer[]>([])

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
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setNotifPermission(Notification.permission)
    } else {
      setNotifPermission('unsupported')
    }
    setTrustedList(getTrustedPeers())
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

  // Alert prefs apply instantly (no Save needed) for immediate feedback.
  const handleSoundToggle = (v: boolean) => {
    setSoundEnabled(v) // persist to the sound module first (sync)
    setSoundPref(v) // then mirror in the store
    if (v) unlockAudio()
  }
  const handleNotifToggle = (v: boolean) => {
    setNotificationsPref(v)
    if (v && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().then((result) => {
        setNotifPermission(result)
      })
    }
  }
  const handleRevokePeer = (deviceId: string) => {
    removeTrustedPeer(deviceId)
    setTrustedList(getTrustedPeers())
  }
  const handleClearPeers = () => {
    clearTrustedPeers()
    setTrustedList([])
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
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="device" className="text-xs">
              <User className="mr-1.5 h-3.5 w-3.5" />
              Device
            </TabsTrigger>
            <TabsTrigger value="network" className="text-xs">
              <Server className="mr-1.5 h-3.5 w-3.5" />
              Network
            </TabsTrigger>
            <TabsTrigger value="alerts" className="text-xs">
              <Bell className="mr-1.5 h-3.5 w-3.5" />
              Alerts
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

          {/* Alerts tab */}
          <TabsContent value="alerts" className="space-y-4 mt-4">
            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div className="flex items-center gap-3 pr-3">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${soundEnabled ? 'bg-flux-500/10 text-flux-600 dark:text-flux-400' : 'bg-muted text-muted-foreground'}`}>
                  {soundEnabled ? <Volume2 className="h-4.5 w-4.5" /> : <VolumeX className="h-4.5 w-4.5" />}
                </div>
                <div>
                  <p className="text-sm font-medium">Sound effects</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Subtle chime when a transfer completes, pauses, or fails.
                  </p>
                </div>
              </div>
              <Switch checked={soundEnabled} onCheckedChange={handleSoundToggle} />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div className="flex items-center gap-3 pr-3">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${notificationsEnabled ? 'bg-flux-500/10 text-flux-600 dark:text-flux-400' : 'bg-muted text-muted-foreground'}`}>
                  {notificationsEnabled ? <Bell className="h-4.5 w-4.5" /> : <BellOff className="h-4.5 w-4.5" />}
                </div>
                <div>
                  <p className="text-sm font-medium">Desktop notifications</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Get alerted when background transfers finish.
                  </p>
                </div>
              </div>
              <Switch
                checked={notificationsEnabled}
                onCheckedChange={handleNotifToggle}
                disabled={notifPermission === 'unsupported'}
              />
            </div>

            {notifPermission === 'denied' && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-muted-foreground">
                <span className="font-medium text-amber-600 dark:text-amber-400">Permission blocked:</span>{' '}
                your browser has denied notification permission for this site. Enable it in the
                browser's site settings to receive background alerts.
              </div>
            )}
            {notifPermission === 'unsupported' && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
                Desktop notifications are not supported in this browser.
              </div>
            )}

            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground mb-1">Applies instantly</p>
              <span>Alert preferences save immediately — no need to press Save below.</span>
            </div>
          </TabsContent>

          {/* Privacy tab */}
          <TabsContent value="privacy" className="space-y-3 mt-4">
            {/* Trusted devices */}
            <div className="rounded-lg border border-border/60 p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="pr-2">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <BadgeCheck className="h-4 w-4 text-flux-500" />
                    Trusted devices
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Devices you explicitly trusted when accepting a transfer.
                  </p>
                </div>
                <Switch checked={autoAcceptTrusted} onCheckedChange={setAutoAcceptTrusted} />
              </div>
              <p className="text-[11px] text-muted-foreground -mt-1">
                Toggle on to <span className="font-medium text-foreground">auto-accept</span> incoming
                transfers from trusted devices without asking. Consent is always required for unknown devices.
              </p>

              {trustedList.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="max-h-32 overflow-y-auto flux-scroll space-y-1.5 pr-1">
                    {trustedList.map((p) => (
                      <div key={p.deviceId} className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/50 p-2">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-flux-500/10 text-flux-600 dark:text-flux-400">
                          <BadgeCheck className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{p.alias}</p>
                          <p className="text-[10px] text-muted-foreground">
                            trusted {new Date(p.addedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRevokePeer(p.deviceId)}
                          aria-label={`Revoke ${p.alias}`}
                          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearPeers}
                    className="h-7 text-xs text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="mr-1.5 h-3 w-3" />
                    Forget all devices
                  </Button>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground rounded-md border border-dashed border-border/60 p-2.5">
                  No trusted devices yet — check "Trust this device" in the transfer consent dialog.
                </p>
              )}
            </div>

            {/* Resume auto-accept */}
            <div className="rounded-lg border border-border/60 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="pr-2">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <RotateCcw className="h-4 w-4 text-flux-500" />
                    Auto-accept resumes
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Skip the consent dialog when the SAME device re-sends a transfer you already started receiving.
                  </p>
                </div>
                <Switch checked={autoAcceptResume} onCheckedChange={setAutoAcceptResume} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Only applies to a transfer ID you previously accepted with partial progress — never to
                new transfers. The consent dialog still appears for anything else.
              </p>
            </div>

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
