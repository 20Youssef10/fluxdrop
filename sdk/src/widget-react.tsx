// @fluxdrop/sdk/react — <FluxDropWidget> React wrapper.
//
// A thin React shell around the framework-free `<fluxdrop-widget>` custom
// element (./widget.ts — ONE implementation, two consumptions). Props map to
// the element's attributes; callbacks map to its CustomEvents.
//
//   import { FluxDropWidget } from '@fluxdrop/sdk/react'
//   <FluxDropWidget signalUrl="/signal" accent="#0d9488" onComplete={(e) => …} />

import React, { useEffect, useRef } from 'react'
import './widget'

export interface FluxDropWidgetProps {
  /** Signaling server base URL (default: page origin). */
  signalUrl?: string
  /** FluxDrop web instance for the join link (default: page origin). */
  endpoint?: string
  /** Theme color. */
  accent?: string
  /** Label locale: 'en' | 'ar' (RTL). */
  lang?: 'en' | 'ar'
  /** Extra class for the wrapper div. */
  className?: string
  /** Room created — { roomId, pin, joinUrl }. */
  onReady?: (detail: { roomId: string; pin: string | null; joinUrl: string }) => void
  /** Transfer progress — { bytesTransferred, totalBytes }. */
  onProgress?: (detail: { bytesTransferred: number; totalBytes: number }) => void
  /** Transfer finished — { verified, files, totalBytes }. */
  onComplete?: (detail: { verified: boolean; files: string[]; totalBytes: number }) => void
  /** Fatal error — { message }. */
  onError?: (detail: { message: string }) => void
}

export function FluxDropWidget({
  signalUrl,
  endpoint,
  accent,
  lang = 'en',
  className,
  onReady,
  onProgress,
  onComplete,
  onError,
}: FluxDropWidgetProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const el = document.createElement('fluxdrop-widget') as HTMLElement & {
      addEventListener: (t: string, l: EventListener) => void
    }
    if (signalUrl) el.setAttribute('signal-url', signalUrl)
    if (endpoint) el.setAttribute('endpoint', endpoint)
    if (accent) el.setAttribute('accent', accent)
    if (lang) el.setAttribute('lang', lang)
    const listen = (name: string, cb?: (d: never) => void) => {
      const handler = (ev: Event) => cb?.((ev as CustomEvent).detail as never)
      el.addEventListener(name, handler)
      return () => el.removeEventListener(name, handler)
    }
    const offs = [
      listen('fluxdrop-ready', onReady as (d: never) => void | undefined),
      listen('fluxdrop-progress', onProgress as (d: never) => void | undefined),
      listen('fluxdrop-complete', onComplete as (d: never) => void | undefined),
      listen('fluxdrop-error', onError as (d: never) => void | undefined),
    ]
    host.appendChild(el)
    return () => {
      for (const off of offs) off()
      el.remove()
    }
    // Props are captured per-mount on purpose: re-mounting mid-transfer would
    // abort the widget's room. Change them via a key when you really want it.
  }, [])

  return <div ref={hostRef} className={className} />
}
