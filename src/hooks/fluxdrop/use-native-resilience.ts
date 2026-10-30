// v5-d13: background transfer resilience FOR NATIVE SHELLS.
//
// The web build's answer to a locked screen is auto-pause (see
// use-background-resilience.ts) because background tabs get throttled or
// killed. Native shells flip that around:
//   - Android: the FluxDropShell foreground service (partial wake lock +
//     dataSync notification) keeps the WebView process fully alive — the
//     DataChannel pipeline keeps flowing with the screen off.
//   - Desktop (Tauri): the process survives window close (hide-to-tray) and
//     screen lock; the tray status line mirrors the transfer.
//
// This hook subscribes to the transfer store and drives the shell lifecycle
// (`nativeTransferStatus`) on active↔idle transitions plus status-text
// refreshes while active. On the plain web build it is a no-op.

'use client'

import { useEffect } from 'react'
import { useTransferStore } from '@/stores/transfer-store'
import { useSessionStore } from '@/stores/session-store'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'
import { getNativeShellInfo, nativeTransferStatus, nativeKeepScreenAwake } from '@/lib/fluxdrop/native-bridge'

/** States where the pipeline is mid-flight and must stay alive. */
const ACTIVE_STATES = new Set(['TRANSFERRING', 'PAUSED', 'RESUMING', 'VERIFYING', 'MANIFEST_EXCHANGE'])

const TERMINAL_LABELS: Record<string, string> = {
  COMPLETE: 'Transfer complete',
  FAILED: 'Transfer failed',
  ERROR: 'Transfer error',
  CANCELLED: 'Transfer cancelled',
}

/** Human status line for the tray / foreground-service notification. */
function statusLabel(state: string): string {
  const terminal = TERMINAL_LABELS[state]
  if (terminal) return terminal
  // Whose transfer is this? Same heuristic as the activity dock's jump.
  const m = useTransferStore.getState().manifest
  const hasReceiverPeers = useSessionStore.getState().peers.some((p) => p.role === 'receiver')
  const sending = !!(m && hasReceiverPeers)
  switch (state) {
    case 'TRANSFERRING':
      return sending ? 'Sending files…' : 'Receiving files…'
    case 'PAUSED':
      return 'Paused'
    case 'RESUMING':
      return 'Resuming…'
    case 'VERIFYING':
      return 'Verifying checksums…'
    case 'MANIFEST_EXCHANGE':
      return sending ? 'Sealing manifest…' : 'Reading manifest…'
    default:
      return state
  }
}

/** How long the final status stays on the tray/service before going idle. */
const SETTLE_MS = 4_000

export function useNativeResilience(): void {
  // Depends on the simulation pref so enabling/disabling the sim (or a real
  // shell's globals appearing) re-arms the subscription.
  const sim = usePrefsStore((s) => s.nativeShellSim)

  useEffect(() => {
    const info = getNativeShellInfo()
    if (info.kind === 'web') return

    let active = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let awake = false

    const syncAwake = (on: boolean) => {
      if (on === awake) return
      awake = on
      nativeKeepScreenAwake(on && usePrefsStore.getState().keepAwakeDuringTransfers)
    }

    const stop = (immediate: boolean) => {
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      const finish = () => {
        active = false
        syncAwake(false)
        nativeTransferStatus(false, 'Idle')
      }
      if (immediate) finish()
      else settleTimer = setTimeout(finish, SETTLE_MS)
    }

    const onState = (state: string, prevState: string) => {
      const nowActive = ACTIVE_STATES.has(state)
      const wasActive = ACTIVE_STATES.has(prevState)

      if (nowActive) {
        // A fresh start OR a mid-flight status refresh (pause/resume/verify).
        // Also cancels any pending "go idle" settle from a previous transfer.
        if (settleTimer) {
          clearTimeout(settleTimer)
          settleTimer = null
        }
        active = true
        syncAwake(true)
        nativeTransferStatus(true, statusLabel(state))
        return
      }
      if (wasActive && !nowActive) {
        // Active → terminal (or idle via reset): let the final status sit on
        // the tray/notification briefly, then stop the service.
        const label = TERMINAL_LABELS[state]
        if (label) {
          if (settleTimer) clearTimeout(settleTimer)
          settleTimer = setTimeout(() => stop(true), SETTLE_MS)
          // Keep the service up (with the final text) during the settle.
          nativeTransferStatus(true, label)
        } else {
          stop(true)
        }
      }
    }

    // Catch a transfer that was already mid-flight when the shell mounted
    // (e.g. an OS share-sheet open during an active receive).
    const current = useTransferStore.getState().transferState
    if (ACTIVE_STATES.has(current)) {
      active = true
      syncAwake(true)
      nativeTransferStatus(true, statusLabel(current))
    }

    const unsub = useTransferStore.subscribe((s, prev) => {
      if (s.transferState !== prev.transferState) onState(s.transferState, prev.transferState)
    })

    return () => {
      unsub()
      if (settleTimer) clearTimeout(settleTimer)
      if (active) nativeTransferStatus(false, 'Idle')
      if (awake) nativeKeepScreenAwake(false)
    }
  }, [sim])
}
