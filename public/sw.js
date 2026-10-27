// FluxDrop Service Worker — caches the app shell for offline use.
// File data is NEVER cached (P2P only). Only static assets and the landing page.
// Additionally: Web Share Target relay — POST /share-target from the OS share
// sheet is stashed in IndexedDB and the page is opened at /?shared=<token>.
//
// Bump CACHE_VERSION on every release so installed clients pick up fresh
// assets on the next activate (old caches are purged).

const CACHE_NAME = 'fluxdrop-v3'
const APP_SHELL = [
  '/',
  '/offline.html',
  '/logo.svg',
  '/manifest.json',
]

// ---- Share Target stash (raw IDB — mirrors src/lib/fluxdrop/share-target.ts) ----
const SHARE_DB = 'fluxdrop-share'
const SHARE_STORE = 'shares'

function openShareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SHARE_STORE)) db.createObjectStore(SHARE_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('share-db open failed'))
  })
}

function sharePut(key, value) {
  return openShareDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(SHARE_STORE, 'readwrite')
        tx.objectStore(SHARE_STORE).put(value, key)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error ?? new Error('share put failed')) }
      })
  )
}

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
  const url = new URL(req.url)

  // Web Share Target: OS share sheet POSTs multipart files here when the PWA
  // is installed. Stash into IDB, bounce the app to /?shared=<token>.
  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleSharePost(req))
    return
  }

  // Only handle GET
  if (req.method !== 'GET') return
  // Skip WebSocket and API requests (signaling goes through gateway)
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return
  if (url.pathname.startsWith('/_next/webpack-hmr')) return

  // Network-first for navigation, stale-while-revalidate for static assets.
  // If the network AND the cache both miss, show the branded offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {})
          return res
        })
        .catch(async () =>
          (await caches.match(req)) ||
          (await caches.match('/')) ||
          (await caches.match('/offline.html')) ||
          new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        )
    )
    return
  }

  // Stale-while-revalidate for same-origin static assets: serve the cached
  // copy instantly (offline-friendly) while refreshing it in the background,
  // so code updates reach users on their NEXT load even if CACHE_NAME was
  // not bumped. Cache-first here would pin old chunks forever (same-URL,
  // content changed) — that bug shipped stale chunks to installed PWAs.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req)
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok && res.type === 'basic') {
              const copy = res.clone()
              cache.put(req, copy).catch(() => {})
            }
            return res
          })
          .catch(() => null)
        if (cached) {
          network.catch(() => {}) // refresh in the background
          return cached
        }
        return (await network) || cached || Response.error()
      })
    )
  }
})

// ---- Share Target POST handler ----
async function handleSharePost(req) {
  try {
    const form = await req.formData()
    const files = []
    const blobs = form.getAll('files')
    for (const blob of blobs) {
      if (typeof blob === 'string') continue
      files.push({
        name: blob.name || 'shared-file',
        type: blob.type || 'application/octet-stream',
        size: blob.size,
        lastModified: blob.lastModified || Date.now(),
        data: await blob.arrayBuffer(),
      })
    }
    const rawText = form.get('text') ?? form.get('title') ?? ''
    const text = typeof rawText === 'string' ? rawText : ''
    if (files.length === 0 && !text.trim()) {
      return Response.redirect(self.location.origin + '/?shared=empty', 303)
    }
    const token = 'sh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    await sharePut(token, { files, text, receivedAt: Date.now() })
    return Response.redirect(self.location.origin + '/?shared=' + encodeURIComponent(token), 303)
  } catch (err) {
    return Response.redirect(self.location.origin + '/?shared=error', 303)
  }
}
