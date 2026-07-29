// FluxDrop Service Worker — caches the app shell for offline use.
// File data is NEVER cached (P2P only). Only static assets and the landing page.

const CACHE_NAME = 'fluxdrop-v1'
const APP_SHELL = [
  '/',
  '/logo.svg',
  '/manifest.json',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  // Only handle GET
  if (req.method !== 'GET') return
  // Skip WebSocket and API requests (signaling goes through gateway)
  const url = new URL(req.url)
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return
  if (url.pathname.startsWith('/_next/webpack-hmr')) return

  // Network-first for navigation, cache-first for static assets
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
    )
    return
  }

  // Cache-first for same-origin static assets
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached
        return fetch(req)
          .then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone()
              caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {})
            }
            return res
          })
          .catch(() => cached)
      })
    )
  }
})
