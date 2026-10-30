'use client'

// v5-e16: Settings → Developers tab — the in-app face of the SDK deliverable:
//   • LIVE wire-conformance badge (runs the golden-vector suite on demand)
//   • npm install + usage snippets (copy buttons)
//   • a REAL <fluxdrop-widget> demo — the production custom element, pointed
//     at this instance's signaling server, ready to send to your other tab.

import { useCallback, useEffect, useRef, useState } from 'react'
import { BadgeCheck, BookOpen, Copy, Loader2, Package, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
// v5-e17: the app's signaling URL resolver (pref-aware) — the widget demo
// talks to the SAME server the app itself uses.
import { signalingUrl } from '@/lib/fluxdrop/signaling'

interface ConformanceResult {
  ok: boolean
  passed: number
  failed: number
  durationMs: number
  cached?: boolean
  output?: string
}

const SNIPPETS: Array<{ id: string; label: string; code: string }> = [
  {
    id: 'install',
    label: '1 · Install',
    code: `npm install @fluxdrop/sdk
# or: bun add @fluxdrop/sdk`,
  },
  {
    id: 'element',
    label: '2 · Web component (zero framework)',
    code: `<!-- one import registers the element -->
<script type="module">
  import '@fluxdrop/sdk/widget'
</script>

<fluxdrop-widget
  signal-url="https://your-fluxdrop-instance"
  accent="#0d9488"
></fluxdrop-widget>`,
  },
  {
    id: 'client',
    label: '3 · Typed client (full transport)',
    code: `import { createFluxdropClient } from '@fluxdrop/sdk'

const fluxdrop = createFluxdropClient({
  alias: 'docs-site',
  signalUrl: 'https://your-fluxdrop-instance',
})

const room = await fluxdrop.createRoom()
console.log(room.roomId, room.pin)   // -> share these

const { verified } = await fluxdrop.sendFiles([file])
console.log(verified)                // -> true when every SHA-256 matched`,
  },
]

export function DevelopersTab() {
  const [conf, setConf] = useState<ConformanceResult | null>(null)
  const [running, setRunning] = useState(false)
  const widgetHostRef = useRef<HTMLDivElement>(null)

  const runConformance = useCallback(async (force = false) => {
    setRunning(true)
    try {
      const res = await fetch(`/api/conformance${force ? `?t=${Date.now()}` : ''}`, { cache: 'no-store' })
      const data = (await res.json()) as ConformanceResult
      setConf(data)
    } catch {
      setConf({ ok: false, passed: 0, failed: -1, durationMs: 0 })
    } finally {
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    void runConformance()
  }, [runConformance])

  // Mount the REAL <fluxdrop-widget> custom element (the production SDK
  // source — same code that ships in the npm package). Re-imported on every
  // mount; customElements.define is idempotent.
  useEffect(() => {
    const host = widgetHostRef.current
    if (!host) return
    let el: HTMLElement | null = null
    let cancelled = false
    void (async () => {
      try {
        await import('../../../sdk/src/widget')
        if (cancelled) return
        el = document.createElement('fluxdrop-widget')
        // The app's own pref-aware resolver — behind the sandbox gateway that
        // is "/?XTransformPort=3003"; self-hosted deployments get their proxy.
        el.setAttribute('signal-url', signalingUrl())
        el.setAttribute('endpoint', window.location.origin)
        el.setAttribute('accent', '#0d9488')
        el.style.maxWidth = '340px'
        host.appendChild(el)
      } catch (err) {
        console.warn('[FluxDrop] widget demo failed to load:', err)
      }
    })()
    return () => {
      cancelled = true
      el?.remove()
    }
  }, [])

  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code)
    toast.success('Copied to clipboard')
  }

  return (
    <div className="space-y-4">
      {/* Conformance badge */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Wire conformance</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Golden-vector suite from docs/protocol-spec.md §10 — framing, checksums, E2EE envelopes,
              signaling event contract.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void runConformance(true)} disabled={running}>
            {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
            Run
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          {conf ? (
            conf.ok ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-flux-500/40 bg-flux-500/10 px-3 py-1 text-xs font-semibold text-flux-700 dark:text-flux-300">
                <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                conformance · {conf.passed} passed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive">
                <XCircle className="h-3.5 w-3.5" aria-hidden />
                conformance · {conf.failed < 0 ? 'suite error' : `${conf.failed} failed`}
              </span>
            )
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              running suite…
            </span>
          )}
          {conf?.ok && (
            <span className="text-[11px] text-muted-foreground">
              {conf.durationMs} ms {conf.cached ? '· cached' : '· fresh'}
            </span>
          )}
        </div>
      </div>

      {/* Live widget demo */}
      <div className="rounded-lg border border-flux-500/30 bg-flux-500/5 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Package className="h-4 w-4 text-flux-600 dark:text-flux-400" aria-hidden />
          <p className="text-sm font-medium">Live widget demo — <code className="text-xs">&lt;fluxdrop-widget&gt;</code></p>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          The production web component from <code className="text-xs">@fluxdrop/sdk</code>, wired to this
          instance&apos;s signaling server. Pick a file, then open FluxDrop in{' '}
          <a
            className="font-medium text-flux-600 underline-offset-2 hover:underline dark:text-flux-400"
            href="/"
            target="_blank"
            rel="noopener noreferrer"
          >
            a second tab
          </a>{' '}
          and join the room it shows.
        </p>
        <div ref={widgetHostRef} />
      </div>

      {/* Snippets */}
      <div className="space-y-2">
        {SNIPPETS.map((s) => (
          <div key={s.id} className="overflow-hidden rounded-lg border border-border/60">
            <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">{s.label}</span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => copy(s.code)}>
                <Copy className="mr-1 h-3 w-3" aria-hidden />
                Copy
              </Button>
            </div>
            <pre className="flux-scroll overflow-x-auto p-3 text-[11px] leading-relaxed">
              <code>{s.code}</code>
            </pre>
          </div>
        ))}
      </div>

      {/* Docs pointer */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          Docs & publishing
        </p>
        <span>
          Full docs live in the repo: <code className="text-xs">docs/sdk.md</code> (API),{' '}
          <code className="text-xs">docs-site/</code> (static site),{' '}
          <code className="text-xs">sdk/README.md</code> (publish runbook: <code className="text-xs">npm pack</code> is
          verified; <code className="text-xs">npm publish</code> from the sdk/ folder ships it).
        </span>
      </div>
    </div>
  )
}
