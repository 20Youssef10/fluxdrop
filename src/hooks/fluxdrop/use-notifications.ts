'use client'

import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'

const STORAGE_KEY = 'fluxdrop:notif-prompted'

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied'

/**
 * Manages browser notification permissions.
 * Prompts once (on first send/receive action), then remembers the choice.
 */
export function useNotifications() {
  const [permission, setPermission] = useState<NotificationState>('default')

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPermission('unsupported')
      return
    }
    setPermission(Notification.permission as NotificationState)
  }, [])

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return false
    }
    try {
      const result = await Notification.requestPermission()
      setPermission(result as NotificationState)
      try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* ignore */ }
      return result === 'granted'
    } catch {
      return false
    }
  }, [])

  const notify = useCallback(
    (title: string, options?: NotificationOptions) => {
      if (permission !== 'granted') return
      try {
        const n = new Notification(title, {
          icon: '/logo.svg',
          badge: '/logo.svg',
          ...options,
        })
        // Auto-close after 8 seconds
        setTimeout(() => n.close(), 8000)
        n.onclick = () => {
          window.focus()
          n.close()
        }
      } catch {
        // ignore
      }
    },
    [permission]
  )

  return { permission, requestPermission, notify }
}

/**
 * Prompts for notification permission on first interaction (if not already prompted).
 * Call this when a transfer starts.
 */
export function useNotificationPrompt() {
  const { permission, requestPermission } = useNotifications()

  const promptOnce = useCallback(async () => {
    if (permission === 'unsupported') return
    if (permission !== 'default') return
    // Check if we've already prompted
    try {
      if (localStorage.getItem(STORAGE_KEY)) return
    } catch { /* ignore */ }
    // Defer the prompt slightly so it doesn't interrupt the UI flow
    setTimeout(async () => {
      const granted = await requestPermission()
      if (granted) {
        toast.success('Notifications enabled', {
          description: "You'll be alerted when transfers complete in the background.",
        })
      }
    }, 1500)
  }, [permission, requestPermission])

  return { promptOnce, permission }
}
