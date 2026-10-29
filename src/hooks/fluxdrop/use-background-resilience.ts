// v4 (7.3): background transfer resilience — Page Lifecycle API.
// - Tab hidden / document frozen mid-transfer → auto-pause (mobile OSes
//   throttle or kill background WebRTC; pausing keeps the resume state clean
//   instead of timing out).
// - Resume state is ALREADY persisted continuously (resume records in
//   IndexedDB); this hook adds a session flag so the user sees why.
// - On return: auto-resume the paused-by-us transfer + fire a desktop
//   notification when granted (transfer state synced back in).

'use client'

import { useEffect, useRef } from 'react'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'
import { useTransferStore } from '@/stores/transfer-store'

export function useBackgroundResilience(
  pause: () => void,
  resume: () => void,
  onResumed?: () => void
): void {
  const pausedByBgRef = useRef(false)

  useEffect(() => {
    const notify = (title: string, body: string) => {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
        new Notification(title, { body, silent: true })
      } catch { /* ignore */ }
    }

    const handleHidden = () => {
      if (!usePrefsStore.getState().backgroundResilience) return
      const st = useTransferStore.getState().transferState
      if (st === 'TRANSFERRING') {
        pausedByBgRef.current = true
        pause()
        notify('FluxDrop paused in background', 'The transfer pauses while the tab is hidden — return to continue.')
      }
    }

    const handleVisible = () => {
      if (!pausedByBgRef.current) return
      pausedByBgRef.current = false
      const st = useTransferStore.getState().transferState
      if (st === 'PAUSED') {
        resume()
        onResumed?.()
        notify('FluxDrop resumed', 'Transfer continues where it left off.')
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') handleHidden()
      else if (document.visibilityState === 'visible') handleVisible()
    }

    // Page Lifecycle API (Chrome): 'freeze' is the last chance to persist
    // before the tab is discarded. Resume records are already durable, so
    // pausing here is about not fighting a dying DataChannel.
    const onPageState = (e: Event) => {
      if ((e as CustomEvent).detail?.state === 'frozen' || (e as unknown as { state?: string }).state === 'frozen') {
        handleHidden()
      }
    }
    const onResumeFromFreeze = () => handleVisible()

    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('freeze', onPageState)
    document.addEventListener('resume', onResumeFromFreeze)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('freeze', onPageState)
      document.removeEventListener('resume', onResumeFromFreeze)
    }
  }, [pause, resume, onResumed])
}
