'use client'

// v5-a5: Network weather — pre-flight probe UI (NAT verdict, TURN heartbeat,
// loopback RTT + throughput ceiling). Collapsible and default-collapsed; the
// summary row always shows the latest verdict icon + label + last-run time ago.
// Self-contained: reads nothing from the transfer engine, only the probe lib.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  Activity,
  ChevronDown,
  CloudLightning,
  CloudRain,
  CloudSun,
  Gauge,
  RefreshCw,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import { formatSpeed } from '@/lib/fluxdrop/format'
import { useT } from '@/lib/fluxdrop/i18n'
import {
  probeNetwork,
  type NetVerdict,
  type NetWeatherReport,
  type ProbeHandle,
} from '@/lib/fluxdrop/net-weather'

type TFunc = (key: string, fallback?: string) => string

/** Machine advice keys emitted by net-weather.ts → display copy (via t()). */
const ADVICE_COPY: Record<string, string> = {
  'wifi-looks-great': 'Wi-Fi conditions look great for direct transfers',
  'enable-fast-lanes': 'Your link can carry parallel chunks — fast lanes will pay off',
  'relay-will-carry': 'Transfers will likely ride the TURN relay on this network',
  'turn-configured': 'TURN relay is configured and answering',
  'check-network': 'Check your network, VPN or firewall settings',
}

interface VerdictMeta {
  icon: LucideIcon
  labelKey: string
  fallback: string
  badgeClass: string
  iconClass: string
}

// Semantic tokens only (emerald/amber/destructive/muted + the flux accent) —
// deliberately no blue/indigo.
const VERDICT_META: Record<NetVerdict, VerdictMeta> = {
  'direct-likely': {
    icon: Sun,
    labelKey: 'netweather.verdict.direct-likely',
    fallback: 'Direct connection likely',
    badgeClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    iconClass: 'text-emerald-600 dark:text-emerald-400',
  },
  'nat-hostile': {
    icon: CloudSun,
    labelKey: 'netweather.verdict.nat-hostile',
    fallback: 'NAT looks hostile',
    badgeClass: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    iconClass: 'text-amber-600 dark:text-amber-400',
  },
  'relay-needed': {
    icon: CloudRain,
    labelKey: 'netweather.verdict.relay-needed',
    fallback: 'Relay needed',
    badgeClass: 'border-destructive/40 bg-destructive/10 text-destructive',
    iconClass: 'text-destructive',
  },
  unknown: {
    icon: CloudLightning,
    labelKey: 'netweather.verdict.unknown',
    fallback: 'Unclear',
    badgeClass: 'border-border bg-muted/50 text-muted-foreground',
    iconClass: 'text-muted-foreground',
  },
}

const AUTO_REFRESH_MS = 30_000

export function NetworkWeather() {
  const t = useT()
  const autoId = useId()
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<NetWeatherReport | null>(null)
  const [probing, setProbing] = useState(false)
  const [auto, setAuto] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const handleRef = useRef<ProbeHandle | null>(null)

  const run = useCallback(() => {
    if (handleRef.current) return // already probing
    setProbing(true)
    const handle = probeNetwork()
    handleRef.current = handle
    void handle.result
      .then((r) => {
        handleRef.current = null
        setProbing(false)
        setReport(r)
        setNow(Date.now())
      })
      .catch(() => {
        // Contract: never rejects — defensive only.
        handleRef.current = null
        setProbing(false)
      })
  }, [])

  const cancelProbe = useCallback(() => {
    handleRef.current?.cancel()
  }, [])

  // Cancel any in-flight probe on unmount.
  useEffect(() => () => handleRef.current?.cancel(), [])

  // Auto-refresh every 30 s while enabled (skips beats while a probe runs).
  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => {
      if (!handleRef.current) run()
    }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [auto, run])

  // Keep the "time ago" label fresh.
  useEffect(() => {
    if (!report) return
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [report])

  const meta = report ? VERDICT_META[report.verdict] : null
  const statusText = probing
    ? t('netweather.summary.probing', 'Probing network conditions')
    : report && meta
      ? `${t(meta.labelKey, meta.fallback)} · ${timeAgo(report.at, now, t)}`
      : t('netweather.summary.idle', 'Not run yet')

  const SummaryIcon = probing ? Activity : (meta?.icon ?? Activity)
  const summaryIconClass = probing
    ? 'bg-flux-500/10 text-flux-600 dark:text-flux-400'
    : meta
      ? `bg-muted ${meta.iconClass}`
      : 'bg-muted text-muted-foreground'

  return (
    <div
      className="rounded-lg border border-border/40 bg-card/30 p-3"
      role="region"
      aria-label={t('netweather.title', 'Network weather')}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${summaryIconClass}`}
                aria-hidden
              >
                <SummaryIcon className={`h-3.5 w-3.5 ${probing ? 'animate-pulse' : ''}`} />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('netweather.title', 'Network weather')}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{statusText}</span>
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
          </CollapsibleTrigger>

          <div className="flex shrink-0 items-center gap-2">
            <label
              htmlFor={autoId}
              className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <span className="hidden sm:inline">{t('netweather.auto', 'Auto 30s')}</span>
              <Switch
                id={autoId}
                checked={auto}
                onCheckedChange={setAuto}
                disabled={probing}
                aria-label={t('netweather.auto.aria', 'Refresh automatically every 30 seconds')}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
              onClick={run}
              disabled={probing}
            >
              <RefreshCw className={`h-3 w-3 ${probing ? 'animate-spin' : ''}`} aria-hidden />
              {probing ? t('netweather.probing.short', 'Probing') : t('netweather.run', 'Run probe')}
            </Button>
          </div>
        </div>

        <CollapsibleContent>
          <div className="mt-3 space-y-3" aria-busy={probing}>
            {probing ? (
              <ProbingView t={t} onCancel={cancelProbe} />
            ) : report ? (
              <ReportView report={report} t={t} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {t(
                  'netweather.idle.hint',
                  'Run a pre-flight probe to preview NAT traversal, TURN reachability and loopback throughput before you connect.'
                )}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ProbingView({ t, onCancel }: { t: TFunc; onCancel: () => void }) {
  return (
    <div className="space-y-2" role="status">
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <motion.div
          className="h-full w-1/3 rounded-full bg-flux-500"
          animate={{ x: ['-100%', '300%'] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t(
            'netweather.probing.hint',
            'Gathering ICE candidates, heartbeating TURN and measuring loopback throughput — takes a few seconds.'
          )}
        </p>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={onCancel}>
          {t('netweather.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

function ReportView({ report, t }: { report: NetWeatherReport; t: TFunc }) {
  const meta = VERDICT_META[report.verdict]
  const VerdictIcon = meta.icon

  const stunBadgeClass = report.stunReachable
    ? 'border-flux-500/30 text-flux-700 dark:text-flux-300'
    : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
  const turnBadgeClass =
    report.turnTcpReachable === true
      ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
      : report.turnTcpReachable === false
        ? 'border-amber-500/40 text-amber-600 dark:text-amber-400'
        : ''
  const turnLabel =
    report.turnTcpReachable === true
      ? t('netweather.turn.reachable', 'TURN TCP reachable')
      : report.turnTcpReachable === false
        ? t('netweather.turn.unreachable', 'TURN TCP unreachable')
        : t('netweather.turn.unknown', 'TURN TCP unknown')

  return (
    <div className="space-y-3">
      {/* Verdict + reachability badges */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={`gap-1 text-[10px] ${meta.badgeClass}`}>
          <VerdictIcon className="h-3 w-3" aria-hidden />
          {t(meta.labelKey, meta.fallback)}
        </Badge>
        <Badge variant="outline" className={`text-[10px] ${stunBadgeClass}`}>
          {report.stunReachable
            ? t('netweather.stun.reachable', 'STUN reachable')
            : t('netweather.stun.unreachable', 'STUN unreachable')}
        </Badge>
        <Badge variant="outline" className={`text-[10px] ${turnBadgeClass}`}>
          {turnLabel}
        </Badge>
      </div>

      {/* Candidate counts + loopback RTT */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('netweather.stat.host', 'Host candidates')} value={`${report.candidates.host}`} />
        <Stat label={t('netweather.stat.srflx', 'STUN candidates')} value={`${report.candidates.srflx}`} />
        <Stat label={t('netweather.stat.relay', 'Relay candidates')} value={`${report.candidates.relay}`} />
        <Stat
          label={t('netweather.stat.rtt', 'Loopback RTT')}
          value={report.rttMs != null ? `${report.rttMs.toFixed(1)} ms` : '—'}
        />
      </div>

      {/* Throughput ceiling + probe duration */}
      <div className="grid grid-cols-2 gap-2">
        <Stat
          icon={<Gauge className="h-3 w-3" aria-hidden />}
          label={t('netweather.stat.loopback', 'Loopback ceiling')}
          value={report.loopbackBps != null ? formatSpeed(report.loopbackBps) : '—'}
        />
        <Stat
          label={t('netweather.stat.duration', 'Probe duration')}
          value={`${(report.durationMs / 1000).toFixed(1)} s`}
        />
      </div>

      {/* Advice chips (machine keys translated here) */}
      {report.advice.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={t('netweather.advice.label', 'Recommendations')}>
          {report.advice.map((key) => (
            <Badge
              key={key}
              variant="outline"
              className="border-flux-500/30 text-[10px] text-flux-700 dark:text-flux-300"
            >
              {t(`netweather.advice.${key}`, ADVICE_COPY[key] ?? key)}
            </Badge>
          ))}
        </div>
      )}

      {/* Probe notes — subtle, muted */}
      {report.errors.length > 0 && (
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('netweather.errors', 'Probe notes')}
          </p>
          <ul className="mt-1 space-y-0.5">
            {report.errors.map((err, i) => (
              <li key={`${i}-${err}`} className="text-xs text-muted-foreground">
                · {err}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="rounded-md border border-border/40 bg-card/30 p-2">
      <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-0.5 text-xs font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function timeAgo(ts: number, now: number, t: TFunc): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return t('netweather.ago.now', 'just now')
  if (s < 60) return t('netweather.ago.sec', `${s}s ago`)
  const m = Math.floor(s / 60)
  if (m < 60) return t('netweather.ago.min', `${m}m ago`)
  return t('netweather.ago.hour', `${Math.floor(m / 60)}h ago`)
}
