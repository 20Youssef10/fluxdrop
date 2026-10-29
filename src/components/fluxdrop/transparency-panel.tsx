'use client'

// v4 (2.6): transparency panel — "What left your device this session".
// Renders the local telemetry trail: signaling events (in/out + bytes),
// DataChannel byte totals, and ICE candidate type/version availability.
// Lives inside the diagnostics panel; read-only + clear.

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArrowDownUp, Eraser, Eye, ShieldCheck } from 'lucide-react'
import {
  getTransparencyReport,
  clearTelemetry,
  subscribeTelemetry,
  type TransparencyReport,
} from '@/lib/fluxdrop/telemetry'
import { formatBytes } from '@/lib/fluxdrop/format'
import { useT } from '@/lib/fluxdrop/i18n'

export function TransparencyPanel() {
  const [report, setReport] = useState<TransparencyReport>(() => getTransparencyReport())
  const t = useT()

  useEffect(() => subscribeTelemetry(() => setReport(getTransparencyReport())), [])

  const fmt = (n: number) => new Date(n).toLocaleTimeString([], { hour12: false })

  return (
    <div className="space-y-3" aria-label={t('transparency.title', 'What left your device this session')}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {t('transparency.title', 'What left your device this session')}
        </div>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => clearTelemetry()}>
          <Eraser className="mr-1 h-3 w-3" aria-hidden />
          Clear
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat
          label={t('transparency.events', 'Signaling events')}
          value={`${report.totalOut} out · ${report.totalIn} in`}
        />
        <Stat
          label={t('transparency.bytes', 'DataChannel bytes')}
          value={`${formatBytes(report.datachannelBytesSent)} ↑ / ${formatBytes(report.datachannelBytesReceived)} ↓`}
        />
        <Stat
          label={t('transparency.ice', 'ICE candidates seen')}
          value={`${Object.values(report.iceCandidates.localTypes).reduce((a, b) => a + b, 0)} local · ${
            Object.values(report.iceCandidates.remoteTypes).reduce((a, b) => a + b, 0)
          } remote`}
        />
      </div>

      {/* IPv6 availability (3.5) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">
          IPv4 {report.iceCandidates.sawIpv4 ? 'available' : '—'}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          IPv6 {report.iceCandidates.sawIpv6 ? 'available' : '—'}
        </Badge>
        {report.iceCandidates.ipv6Prefixes.map((p) => (
          <Badge key={p} variant="outline" className="border-flux-500/30 text-[10px] text-flux-700 dark:text-flux-300">
            {p}
          </Badge>
        ))}
      </div>

      {/* Event trail */}
      <div className="max-h-40 overflow-y-auto flux-scroll rounded-md border border-border/40 bg-card/30">
        {report.events.length === 0 ? (
          <p className="p-3 text-[11px] text-muted-foreground">
            {t('transparency.empty', 'Nothing yet — signaling events will appear here.')}
          </p>
        ) : (
          <ul className="divide-y divide-border/30">
            {report.events
              .slice(-30)
              .reverse()
              .map((e, i) => (
                <li key={`${e.ts}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
                  <ArrowDownUp className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span
                    className={`w-6 shrink-0 font-mono ${e.dir === 'out' ? 'text-amber-600 dark:text-amber-400' : 'text-flux-600 dark:text-flux-400'}`}
                  >
                    {e.dir === 'out' ? '→' : '←'}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{e.event}</span>
                  {e.bytes != null && (
                    <span className="shrink-0 text-muted-foreground">{formatBytes(e.bytes)}</span>
                  )}
                  <span className="shrink-0 text-muted-foreground tabular-nums">{fmt(e.ts)}</span>
                </li>
              ))}
          </ul>
        )}
      </div>

      <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-flux-600 dark:text-flux-400" aria-hidden />
        The signaling server only ever relays connection metadata (room codes, encrypted SDP/ICE blobs) —
        file bytes flow direct peer-to-peer and never touch a server. This log lives only in this tab.
      </p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-card/30 p-2">
      <p className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs font-semibold tabular-nums">{value}</p>
    </div>
  )
}
