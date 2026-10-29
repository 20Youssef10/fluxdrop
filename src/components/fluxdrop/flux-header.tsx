'use client'

import { useTheme } from 'next-themes'
import { Moon, Sun, Settings, Wifi, WifiOff, Plus, Trash2, Server, User, Shield, ShieldCheck, HelpCircle, Bell, Volume2, BellOff, VolumeX, BadgeCheck, RotateCcw, Zap, Lock, Archive, SlidersHorizontal, Palette, Languages, Vibrate, Smartphone, PlayCircle, Timer } from 'lucide-react'
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
import { Slider } from '@/components/ui/slider'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { useSessionStore, type IceServerConfig } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { setSoundEnabled, unlockAudio } from '@/lib/fluxdrop/sound'
import { getTrustedPeers, removeTrustedPeer, clearTrustedPeers, setTrustedPeerScopes, type TrustedPeer, type TrustedScope } from '@/lib/fluxdrop/trusted-peers'
import { wipeChunkCache } from '@/lib/fluxdrop/resume'
import { listVault, deleteVaultEntry, vaultSupported, enforceVaultBudget } from '@/lib/fluxdrop/vault'
import { formatBytes } from '@/lib/fluxdrop/format'
import { usePrefsStore, ACCENTS, type AccentId, type LocaleId, type SoundPack } from '@/lib/fluxdrop/prefs'
import { LOCALES } from '@/lib/fluxdrop/i18n'
import { useT } from '@/lib/fluxdrop/i18n'
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
  // v1.1: performance & reliability prefs
  const compressionEnabled = useSessionStore((s) => s.compressionEnabled)
  const setCompressionEnabled = useSessionStore((s) => s.setCompressionEnabled)
  const useTurnRelay = useSessionStore((s) => s.useTurnRelay)
  const setUseTurnRelay = useSessionStore((s) => s.setUseTurnRelay)
  // v1.2: true end-to-end payload encryption (PAKE over the room PIN)
  const e2eEnabled = useSessionStore((s) => s.e2eEnabled)
  const setE2EEnabled = useSessionStore((s) => s.setE2EEnabled)
  // v1.2 (2.3): paranoid mode — at-rest encryption + chunk-cache wipe on close
  const paranoidMode = useSessionStore((s) => s.paranoidMode)
  const setParanoidMode = useSessionStore((s) => s.setParanoidMode)
  // v1.3 (4.1): Files vault — on-device keep of verified received transfers
  const vaultEnabled = useSessionStore((s) => s.vaultEnabled)
  const setVaultEnabled = useSessionStore((s) => s.setVaultEnabled)
  // v4: central prefs (accent, i18n, QoS, sounds, sync, a11y)
  const prefs = usePrefsStore()
  const t = useT()
  const vaultBudgetMb = useSessionStore((s) => s.vaultBudgetMb)
  const setVaultBudgetMb = useSessionStore((s) => s.setVaultBudgetMb)
  const vaultOk = vaultSupported()
  const [vaultUsage, setVaultUsage] = useState({ bytes: 0, count: 0 })
  const refreshVaultUsage = useCallback(async () => {
    const entries = await listVault()
    setVaultUsage({
      bytes: entries.reduce((s, e) => s + (Number.isFinite(e.totalSize) ? e.totalSize : 0), 0),
      count: entries.length,
    })
  }, [])
  // Shrinking the budget can evict immediately — keep the usage line honest.
  const handleBudgetChange = (mb: number) => {
    setVaultBudgetMb(mb)
    void enforceVaultBudget().then(refreshVaultUsage)
  }
  const handleClearVault = async () => {
    if (
      !window.confirm(
        'Delete every file kept in the FluxDrop vault? Saved copies outside the vault are not touched. This cannot be undone.'
      )
    ) {
      return
    }
    const entries = await listVault()
    for (const e of entries) {
      await deleteVaultEntry(e.transferId)
    }
    await refreshVaultUsage()
    toast.success(
      entries.length > 0 ? `Vault cleared — ${entries.length} transfer${entries.length === 1 ? '' : 's'} removed` : 'Vault cleared'
    )
  }
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
    if (vaultSupported()) {
      void refreshVaultUsage()
    }
  }, [open, alias, customIceServers, useCustomIce, refreshVaultUsage])

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
  // v1.3 (6.4): per-device auto-accept scopes (files / snippets / auto-save).
  // Persists immediately — the manifest auto-accept path reads localStorage.
  const handleScopeChange = (deviceId: string, scope: TrustedScope, v: boolean) => {
    setTrustedPeerScopes(deviceId, { [scope]: v })
    setTrustedList(getTrustedPeers())
  }
  const handleClearPeers = () => {
    clearTrustedPeers()
    setTrustedList([])
  }
  // v1.2 (2.3): turning paranoid mode ON immediately purges whatever chunk
  // payloads are already on disk; from then on secure-store wipes the cache on
  // every pagehide (tab close / reload). History records stay (metadata only).
  const handleParanoidToggle = (v: boolean) => {
    setParanoidMode(v)
    if (v) {
      void wipeChunkCache()
        .then((wiped) => {
          toast.info(
            wiped > 0
              ? `Chunk cache wiped — ${wiped} cached chunk${wiped === 1 ? '' : 's'} removed; future chunks are wiped when the tab closes`
              : 'Chunk cache wiped — future chunks are wiped when the tab closes'
          )
        })
        .catch(() => {
          toast.info('Chunk cache wiped — future chunks are wiped when the tab closes')
        })
    }
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
          <TabsList className="grid w-full grid-cols-6">
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
            <TabsTrigger value="vault" className="text-xs">
              <Archive className="mr-1.5 h-3.5 w-3.5" />
              Vault
            </TabsTrigger>
            {/* v4: tuning — performance, appearance & access, sounds, sync */}
            <TabsTrigger value="tuning" className="text-xs">
              <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
              Tuning
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
            {/* v1.2: true end-to-end payload encryption */}
            <div className="rounded-lg border border-flux-500/30 bg-flux-500/5 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="pr-2">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <Lock className="h-4 w-4 text-flux-500" />
                    End-to-end encryption (PIN-sealed)
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Derives a payload key from the room PIN via SPAKE2 so even a malicious signaling
                    server — or a MITM on DTLS — cannot read your files.
                  </p>
                </div>
                <Switch checked={e2eEnabled} onCheckedChange={setE2EEnabled} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Manifests, chunks and previews are AES-256-GCM sealed before they leave the device.
                The verification code becomes a real authentication string — both devices must show
                the SAME 6 digits. Transfers abort if verification fails.
              </p>
            </div>

            {/* v1.2 (2.3): at-rest encryption + paranoid wipe on tab close */}
            <div className="rounded-lg border border-flux-500/30 bg-flux-500/5 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="pr-2">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <ShieldCheck className="h-4 w-4 text-flux-500" />
                    Paranoid mode
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Encrypt resume cache + history at rest and wipe the received-chunk cache the
                    moment this tab closes. Nothing readable stays on disk.
                  </p>
                </div>
                <Switch checked={paranoidMode} onCheckedChange={handleParanoidToggle} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                History records and stored chunks are sealed with AES-256-GCM using a key that can
                never leave your browser&apos;s crypto module. Closing or reloading this tab also
                erases partial downloads (history metadata is kept), so interrupted transfers start
                over instead of resuming. If WebCrypto/IndexedDB is unavailable, storage falls back
                to plaintext rather than breaking transfers.
              </p>
            </div>

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
                  <div className="max-h-56 overflow-y-auto flux-scroll space-y-1.5 pr-1">
                    {trustedList.map((p) => (
                      <div key={p.deviceId} className="space-y-2 rounded-md border border-border/40 bg-card/50 p-2">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-flux-500/10 text-flux-600 dark:text-flux-400">
                            <BadgeCheck className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">{p.alias}</p>
                            <p className="text-[10px] text-muted-foreground">
                              trusted {new Date(p.addedAt).toLocaleDateString()}
                            </p>
                          </div>
                          {p.sasFingerprint && (
                            <code
                              className="shrink-0 rounded bg-flux-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-widest text-flux-700 dark:text-flux-300"
                              title="Verification code from the first PIN-sealed session with this device"
                            >
                              SAS {p.sasFingerprint}
                            </code>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRevokePeer(p.deviceId)}
                            aria-label={`Revoke ${p.alias}`}
                            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {/* v1.3 (6.4): what this device may auto-accept */}
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-1.5">
                          <span className="mr-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            Auto-accept
                          </span>
                          <ScopeChip
                            label="Files"
                            checked={p.scopes.files}
                            onToggle={(v) => handleScopeChange(p.deviceId, 'files', v)}
                          />
                          <ScopeChip
                            label="Snippets"
                            checked={p.scopes.snippets}
                            onToggle={(v) => handleScopeChange(p.deviceId, 'snippets', v)}
                          />
                          <ScopeChip
                            label="Auto-save"
                            checked={p.scopes.autoSave}
                            onToggle={(v) => handleScopeChange(p.deviceId, 'autoSave', v)}
                          />
                        </div>
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
              <p className="text-[11px] text-muted-foreground rounded-md border border-dashed border-border/60 p-2.5">
                Scopes decide what each device may auto-accept: <span className="font-medium text-foreground">Files</span> for
                full transfers, <span className="font-medium text-foreground">Snippets</span> for small snippet-*.txt drops only,
                and <span className="font-medium text-foreground">Auto-save</span> to skip the save picker. The SAS code is the
                verification string from your first PIN-sealed session — if it ever changes, re-verify that device.
              </p>
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

            {/* v1.1: Performance & reliability */}
            <div className="rounded-lg border border-border/60 p-3 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-flux-500" />
                Performance &amp; reliability
              </p>
              <div className="flex items-center justify-between gap-3">
                <div className="pr-2">
                  <p className="text-sm font-medium">Compress transfers</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Gzip compressible files (text, code, data) in flight. Checksums still verify the original bytes.
                  </p>
                </div>
                <Switch checked={compressionEnabled} onCheckedChange={setCompressionEnabled} />
              </div>
              <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/40">
                <div className="pr-2">
                  <p className="text-sm font-medium">Relay fallback (TURN)</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Auto-use short-lived relay credentials from the signaling server when a direct connection
                    can&apos;t be formed. Direct paths are always preferred when available.
                  </p>
                </div>
                <Switch checked={useTurnRelay} onCheckedChange={setUseTurnRelay} />
              </div>
              <p className="text-[11px] text-muted-foreground rounded-md border border-dashed border-border/60 p-2.5">
                Interrupted transfers auto-reconnect and resume from the last verified chunk (up to 3 attempts,
                exponential backoff). Retry appears as a button if all attempts fail.
              </p>
            </div>

            <div className="rounded-lg border border-flux-500/30 bg-flux-500/5 p-3 text-xs">
              <p className="font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-flux-500" />
                Defense in depth
              </p>
              <span className="text-muted-foreground">
                With PIN-sealed E2E on: payloads are AES-256-GCM encrypted app-side AND ride a
                DTLS-encrypted DataChannel — the signaling server relays only opaque blobs and can
                read nothing. With it off, DTLS still protects the pipe (an honest-server assumption).
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

          {/* v1.3 (4.1): Files vault tab */}
          <TabsContent value="vault" className="space-y-4 mt-4">
            {!vaultOk ? (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground mb-1 flex items-center gap-1.5">
                  <Archive className="h-4 w-4" />
                  Not available in this browser
                </p>
                <span>
                  The Files vault needs the Origin Private File System (OPFS), which this browser
                  does not expose. Received files can still be saved the usual way after each transfer.
                </span>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-lg border border-flux-500/30 bg-flux-500/5 p-3">
                  <div className="pr-3">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      <Archive className="h-4 w-4 text-flux-500" />
                      Keep received files in the vault
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      After a transfer verifies, a copy is kept in a private on-device vault —
                      re-download it anytime without the sender.
                    </p>
                  </div>
                  <Switch checked={vaultEnabled} onCheckedChange={setVaultEnabled} />
                </div>

                <div className="rounded-lg border border-border/60 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="pr-3">
                      <p className="text-sm font-medium">Vault budget</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        When the vault grows past this size, the oldest transfers are evicted first.
                      </p>
                    </div>
                    <Select value={String(vaultBudgetMb)} onValueChange={(v) => handleBudgetChange(Number(v))}>
                      <SelectTrigger className="w-36 h-9 shrink-0" aria-label="Vault budget">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="512">512 MB</SelectItem>
                        <SelectItem value="2048">2 GB</SelectItem>
                        <SelectItem value="8192">8 GB</SelectItem>
                        <SelectItem value="0">Unlimited</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Current usage</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {vaultUsage.count} transfer{vaultUsage.count === 1 ? '' : 's'} ·{' '}
                        {formatBytes(vaultUsage.bytes)} kept on this device
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleClearVault()}
                      disabled={vaultUsage.count === 0}
                      className="shrink-0"
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Clear vault
                    </Button>
                  </div>
                </div>

                <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Where does this live?</p>
                  <span>
                    Vault bytes are stored in your browser&apos;s private file system (OPFS) and stay on
                    this device — never on a server. Trusted devices with the Auto-save scope skip the
                    save picker entirely and land straight in the vault.
                  </span>
                </div>
              </>
            )}
          </TabsContent>

          {/* v4: Tuning tab — performance, appearance & access, sounds & haptics,
              sync & automation. Everything applies instantly via the prefs store. */}
          <TabsContent value="tuning" className="space-y-5 mt-4">
            {/* --- Performance --- */}
            <section className="space-y-3">
              <SectionLabel icon={<Zap className="h-3.5 w-3.5" />} label={t('settings.performance', 'Performance')} />
              <div className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="pr-3">
                    <p className="text-sm font-medium">Bandwidth cap (QoS)</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Polite mode — pace the send so a big transfer doesn&apos;t saturate the LAN/hotspot.
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-flux-600 dark:text-flux-400">
                    {prefs.qosCapMbps === 0 ? 'Unlimited' : `${prefs.qosCapMbps} Mbit/s`}
                  </span>
                </div>
                <Slider
                  value={[prefs.qosCapMbps]}
                  min={0}
                  max={200}
                  step={5}
                  onValueChange={([v]) => prefs.setQosCapMbps(v)}
                  className="mt-3"
                  aria-label="Bandwidth cap in megabits per second"
                />
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                  <span>0 = uncapped</span>
                  <span>100</span>
                  <span>200 Mbit/s</span>
                </div>
              </div>
              <PrefRow
                icon={<ShieldCheck className="h-4.5 w-4.5" />}
                title="Merkle integrity tree"
                desc="Seal a per-chunk Merkle root into the manifest and independently re-verify it on arrival. Adds a pre-send read pass (skipped above 2 GB)."
                checked={prefs.merkleEnabled}
                onCheckedChange={prefs.setMerkleEnabled}
              />
            </section>

            {/* --- Appearance & access --- */}
            <section className="space-y-3">
              <SectionLabel icon={<Palette className="h-3.5 w-3.5" />} label={t('settings.appearance', 'Appearance & access')} />
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-sm font-medium">{t('settings.accent', 'Accent color')}</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
                    <button
                      key={id}
                      onClick={() => prefs.setAccent(id)}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        prefs.accent === id
                          ? 'border-flux-500/60 bg-flux-500/10 font-medium'
                          : 'border-border/60 hover:bg-card/60'
                      }`}
                      aria-pressed={prefs.accent === id}
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: `oklch(0.62 ${ACCENTS[id].chroma} ${ACCENTS[id].hue})` }}
                        aria-hidden
                      />
                      {ACCENTS[id].label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Languages className="h-3.5 w-3.5" aria-hidden />
                  {t('settings.language', 'Language')}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {LOCALES.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => prefs.setLocale(l.id as LocaleId)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        prefs.locale === l.id
                          ? 'border-flux-500/60 bg-flux-500/10 font-medium'
                          : 'border-border/60 hover:bg-card/60'
                      }`}
                      aria-pressed={prefs.locale === l.id}
                    >
                      {l.native}
                    </button>
                  ))}
                </div>
              </div>
              <PrefRow
                icon={<BadgeCheck className="h-4.5 w-4.5" />}
                title="Low-vision transfer mode"
                desc="Large-type progress, extra contrast, and an ARIA live readout of the verification code."
                checked={prefs.lowVision}
                onCheckedChange={prefs.setLowVision}
              />
              <PrefRow
                icon={<Zap className="h-4.5 w-4.5" />}
                title="Reduce motion"
                desc="Force minimal animations (also honored automatically via prefers-reduced-motion)."
                checked={prefs.reduceMotion}
                onCheckedChange={prefs.setReduceMotion}
              />
              <PrefRow
                icon={<Sun className="h-4.5 w-4.5" />}
                title="High contrast"
                desc="Boost borders and text contrast across the app."
                checked={prefs.highContrast}
                onCheckedChange={prefs.setHighContrast}
              />
            </section>

            {/* --- Sounds & haptics --- */}
            <section className="space-y-3">
              <SectionLabel icon={<Volume2 className="h-3.5 w-3.5" />} label={t('settings.sounds', 'Sounds & haptics')} />
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-sm font-medium">Chime pack</p>
                <div className="mt-2.5 flex gap-2">
                  {(['calm', 'lively', 'silent'] as SoundPack[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => prefs.setSoundPack(p)}
                      className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] capitalize transition-colors ${
                        prefs.soundPack === p
                          ? 'border-flux-500/60 bg-flux-500/10 font-medium'
                          : 'border-border/60 hover:bg-card/60'
                      }`}
                      aria-pressed={prefs.soundPack === p}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <PrefRow
                icon={<Vibrate className="h-4.5 w-4.5" />}
                title="Haptics"
                desc="navigator.vibrate buzz on completion and errors (mobile browsers)."
                checked={prefs.hapticsEnabled}
                onCheckedChange={prefs.setHapticsEnabled}
              />
              <div className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="pr-3">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <Timer className="h-3.5 w-3.5" aria-hidden />
                      Quiet hours
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Mute chimes during a window (e.g. 22:00 → 08:00).
                    </p>
                  </div>
                  <Switch
                    checked={prefs.quietHours.enabled}
                    onCheckedChange={(v) => prefs.setQuietHours({ enabled: v })}
                    aria-label="Enable quiet hours"
                  />
                </div>
                {prefs.quietHours.enabled && (
                  <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      From (h)
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={prefs.quietHours.from}
                        onChange={(e) => prefs.setQuietHours({ from: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                      />
                    </label>
                    <label className="space-y-1 text-[11px] text-muted-foreground">
                      To (h)
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={prefs.quietHours.to}
                        onChange={(e) => prefs.setQuietHours({ to: Math.max(0, Math.min(23, Number(e.target.value) || 0)) })}
                      />
                    </label>
                  </div>
                )}
              </div>
            </section>

            {/* --- Sync & automation --- */}
            <section className="space-y-3">
              <SectionLabel icon={<Smartphone className="h-3.5 w-3.5" />} label={t('settings.sync', 'Sync & automation')} />
              <PrefRow
                icon={<Lock className="h-4.5 w-4.5" />}
                title="Clipboard sync (both devices opt in)"
                desc="Forward copied text to the paired device over the DataChannel — E2E-encrypted while PAKE is active."
                checked={prefs.clipboardSync}
                onCheckedChange={prefs.setClipboardSync}
              />
              <PrefRow
                icon={<PlayCircle className="h-4.5 w-4.5" />}
                title="Auto-open first file on completion"
                desc="Open the first received file the moment the transfer verifies."
                checked={prefs.autoOpenFirstFile}
                onCheckedChange={prefs.setAutoOpenFirstFile}
              />
              <PrefRow
                icon={<Smartphone className="h-4.5 w-4.5" />}
                title="Background resilience"
                desc="Auto-pause when the tab hides or freezes; auto-resume + notify on return."
                checked={prefs.backgroundResilience}
                onCheckedChange={prefs.setBackgroundResilience}
              />
              <PrefRow
                icon={<Wifi className="h-4.5 w-4.5" />}
                title="Visible to nearby devices"
                desc="Announce this device on the LAN discovery panel (same-subnet, pet names only — never IPs)."
                checked={prefs.nearbyVisible}
                onCheckedChange={prefs.setNearbyVisible}
              />
              <button
                onClick={() => {
                  onOpenChange(false)
                  setTimeout(() => window.dispatchEvent(new CustomEvent('fluxdrop:open-speedrun')), 250)
                }}
                className="w-full rounded-lg border border-flux-500/40 bg-flux-500/5 p-3 text-left text-xs transition-colors hover:bg-flux-500/10"
              >
                <span className="font-medium text-flux-700 dark:text-flux-300">Re-run the 10-second demo</span>
                <span className="mt-0.5 block text-muted-foreground">
                  The first-run speedrun that simulates a full transfer in-app.
                </span>
              </button>
            </section>
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

/**
 * v1.3 (6.4): one trust-scope toggle (Files / Snippets / Auto-save) rendered
 * as a compact chip with switch semantics — the WHOLE chip is the control
 * (role="switch" + aria-checked) so the touch target comfortably exceeds the
 * tiny bare Switch track while keeping the settings' visual language.
 */
/** v4: section label for the Tuning tab. */
function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span className="text-flux-600 dark:text-flux-400" aria-hidden>
        {icon}
      </span>
      {label}
    </p>
  )
}

/** v4: instantly-applied preference row (switch + icon + copy). */
function PrefRow({
  icon,
  title,
  desc,
  checked,
  onCheckedChange,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-3 pr-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            checked ? 'bg-flux-500/10 text-flux-600 dark:text-flux-400' : 'bg-muted text-muted-foreground'
          }`}
          aria-hidden
        >
          {icon}
        </div>
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 max-w-md text-xs text-muted-foreground">{desc}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
    </div>
  )
}

function ScopeChip({
  label,
  checked,
  onToggle,
}: {
  label: string
  checked: boolean
  onToggle: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Auto-accept ${label.toLowerCase()} from this device`}
      onClick={() => onToggle(!checked)}
      className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 transition-colors ${
        checked
          ? 'border-flux-500/40 bg-flux-500/10 text-foreground'
          : 'border-border/50 bg-transparent text-muted-foreground hover:bg-muted/40'
      }`}
    >
      {/* Visual switch indicator (decorative — the chip itself is the control) */}
      <span aria-hidden className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-flux-600' : 'bg-input'}`}>
        <span
          className={`block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-[14px]' : 'translate-x-[2px]'
          }`}
        />
      </span>
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  )
}
