'use client'

import { useEffect } from 'react'

/**
 * Registers the FluxDrop service worker for PWA/offline support.
 * Only runs in production to avoid caching issues during development.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return
    // Only register in production (dev server HMR conflicts with SW caching)
    if (process.env.NODE_ENV !== 'production') return

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        // Poll for a new worker on each visit so updates ship without
        // waiting for all tabs to close (skipWaiting handles activation).
        setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000)
      } catch {
        // Silent fail — SW is a progressive enhancement
      }
    }
    if (document.readyState === 'complete') {
      void register()
    } else {
      window.addEventListener('load', register)
      return () => window.removeEventListener('load', register)
    }
  }, [])

  return null
}
