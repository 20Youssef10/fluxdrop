'use client'

// v4 (3.2): LAN zero-config discovery — "Nearby devices" landing panel.
// Polls the signaling service's /nearby endpoint (subnet-grouped presence,
// no IPs ever returned). Presence is announced only while this panel is
// mounted AND the nearby-visibility pref is on.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Loader2, Radar, Send, Shield, Wifi } from 'lucide-react'
import { useSessionStore } from '@/stores/session-store'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'
import { pollNearby, type NearbyDevice } from '@/lib/fluxdrop/lan-discovery'
import { useT } from '@/lib/fluxdrop/i18n'
import { DeviceIcon } from './device-icon'

export function NearbyDevices() {
  const [peers, setPeers] = useState<NearbyDevice[] | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const deviceId = useSessionStore((s) => s.deviceId)
  const alias = useSessionStore((s) => s.alias)
  const setView = useSessionStore((s) => s.setView)
  const visible = usePrefsStore((s) => s.nearbyVisible)
  const setVisible = usePrefsStore((s) => s.setNearbyVisible)
  const t = useT()
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!deviceId || !alias) return
    if (!visible) {
      // Hidden: still LIST (read-only presence isn't announced without the
      // deviceId param — poll with visibility off means we skip announcing).
      // The endpoint requires deviceId, so hidden devices simply don't poll.
      setPeers([])
      return
    }
    const found = await pollNearby(deviceId, alias, 'sender')
    if (found === null) {
      setAvailable(false)
      return
    }
    setAvailable(true)
    setPeers(found)
  }, [deviceId, alias, visible])

  useEffect(() => {
    // Deferred via setTimeout: setState inside an effect body triggers a
    // cascading-render lint error, and the tick delay is imperceptible.
    const kickoff = setTimeout(() => void refresh(), 0)
    timerRef.current = setInterval(() => void refresh(), 10_000)
    return () => {
      clearTimeout(kickoff)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  return (
    <Card className="flux-glass p-5" aria-label={t('nearby.title', 'Nearby devices')}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-flux-600 dark:text-flux-400" aria-hidden />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t('nearby.title', 'Nearby devices')}
          </h3>
          {available === false && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              unavailable
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="sr-only">Toggle nearby visibility</span>
          <Switch checked={visible} onCheckedChange={setVisible} aria-label="Nearby visibility" />
        </div>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        {visible ? t('nearby.visible', 'You are visible to nearby devices') : t('nearby.hidden', 'You are hidden from nearby devices')}
        {' · '}
        {t('nearby.hint', 'Devices on the same network show up here. Create a room to pair.')}
      </p>

      <div className="max-h-48 overflow-y-auto flux-scroll">
        {peers === null && (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Scanning this network…
          </div>
        )}
        {peers !== null && peers.length === 0 && (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Wifi className="h-3.5 w-3.5" aria-hidden />
            {t('nearby.empty', 'No FluxDrop devices found on this network yet.')}
          </div>
        )}
        {peers?.map((p) => (
          <div
            key={p.deviceId}
            className="flex items-center gap-2.5 rounded-md border border-border/40 bg-card/40 p-2"
          >
            <DeviceIcon alias={p.alias || 'Anonymous device'} className="h-4 w-4 text-flux-600 dark:text-flux-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{p.alias || 'Anonymous device'}</p>
              <p className="text-[10px] text-muted-foreground">
                same network · {p.role === 'receiver' ? 'receiving' : 'sending'}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setView('sender')}
            >
              <Send className="mr-1 h-3 w-3" aria-hidden />
              Pair
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-lg border border-flux-500/20 bg-flux-500/5 p-2.5 text-[10px] text-muted-foreground">
        <Shield className="mt-0.5 h-3 w-3 shrink-0 text-flux-600 dark:text-flux-400" aria-hidden />
        <span>
          Discovery never shares IP addresses — the server groups devices by subnet and returns only
          pet names. Pairing itself stays end-to-end encrypted with the room PIN.
        </span>
      </div>
    </Card>
  )
}
