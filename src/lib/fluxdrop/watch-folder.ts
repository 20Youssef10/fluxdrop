// v5-a6: Watch folder — File System Access API directory watching with a raw
// IndexedDB mini-store (persisted folder handle, snapshot, queue metadata).
// Browser-only by nature; every entry point feature-detects and degrades to
// null/false/[] instead of throwing. The panel (watch-folder-panel.tsx) owns
// the UI state machine; this module owns disk/persistence/polling only.
//
// v5 scope: FLAT directory watching — `handle.entries()` lists the picked
// folder's direct children only. Sub-directories are seen but never descended
// into (recursive watching is a future iteration; the snapshot shape already
// keys by path so it can grow without a migration).

// === Minimal local typing for the File System Access API surface ==========
// TS's DOM lib ships FileSystemDirectoryHandle itself, but NOT
// window.showDirectoryPicker, the queryPermission/requestPermission handle
// methods, nor the entries()/values() iterators (those live in
// lib.dom.asynciterable, which this project's `lib` list does not load).
// Rather than reach for `any`, the missing surface is declared structurally here.

/** v5-a6: the picker entry point is absent from the DOM lib's Window. */
type ShowDirectoryPickerFn = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>

/** v5-a6: permission methods are not on FileSystemHandle in the DOM lib. */
interface PermissionCapableHandle {
  queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
}

/**
 * v5-a6: the async-iterator surface of FileSystemDirectoryHandle. The DOM lib
 * ships the handle itself, but entries()/values() live in lib.dom.asynciterable,
 * which this project's `lib` list does not load — so the minimal surface is
 * declared structurally here (guarded cast, no `any`).
 */
interface IterableDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

export interface WatchEvent {
  kind: 'added' | 'changed'
  name: string
  file: File
}

export interface WatchSnapshotEntry {
  size: number
  lastModified: number
}

export interface WatchSnapshot {
  /** Folder name the snapshot was taken from (guards against stale cross-folder diffs). */
  path: string
  entries: Record<string, WatchSnapshotEntry>
}

export interface WatchQueueItem {
  name: string
  size: number
  addedAt: number
}

// === IndexedDB mini-store (raw IDB, no deps) ===============================

const DB_NAME = 'fluxdrop-watch'
const DB_VERSION = 1
const STORES = {
  /** key 'folder' → FileSystemDirectoryHandle */
  handles: 'handles',
  /** key 'folder' → WatchSnapshot */
  snapshot: 'snapshot',
  /** auto-increment id → WatchQueueItem */
  queue: 'queue',
} as const

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORES.handles)) db.createObjectStore(STORES.handles)
          if (!db.objectStoreNames.contains(STORES.snapshot)) db.createObjectStore(STORES.snapshot)
          if (!db.objectStoreNames.contains(STORES.queue)) {
            db.createObjectStore(STORES.queue, { keyPath: 'id', autoIncrement: true })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

/** Single-record get. All failures resolve null — nothing here is fatal. */
async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Put with an explicit key, or keyless (auto-increment) when key is null. */
async function idbPut(store: string, key: IDBValidKey | null, value: unknown): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite')
      if (key === null) tx.objectStore(store).put(value)
      else tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onabort = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).delete(key)
      tx.oncomplete = () => resolve()
      tx.onabort = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function idbClear(store: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).clear()
      tx.oncomplete = () => resolve()
      tx.onabort = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll()
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as T[]) : [])
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

// === Public API =============================================================

/** True when the File System Access API picker is available (Chromium). */
export function watchFolderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/**
 * v5-a6: pick a folder (read-only) and persist its handle for the next visit.
 * Must be called from a user gesture. Returns null on cancel/failure.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!watchFolderSupported()) return null
  try {
    const picker = (window as unknown as { showDirectoryPicker: ShowDirectoryPickerFn }).showDirectoryPicker
    const handle = await picker({ mode: 'read' })
    await idbPut(STORES.handles, 'folder', handle)
    // Fresh folder → fresh baseline: a stale snapshot from a previous folder
    // would diff against the wrong directory and flood the feed with events.
    await idbDelete(STORES.snapshot, 'folder')
    return handle
  } catch {
    return null // cancelled, denied, or unsupported — all non-fatal
  }
}

/** v5-a6: restore the persisted folder handle (null when never picked). */
export async function loadPersistedFolder(): Promise<FileSystemDirectoryHandle | null> {
  return idbGet<FileSystemDirectoryHandle>(STORES.handles, 'folder')
}

/**
 * v5-a6: permission gate for a (possibly restored) handle. Chrome keeps grants
 * for picked handles across sessions, but may reset them — requestPermission
 * needs a user gesture, so pass { request: true } only from click handlers.
 * Handles from browsers without the permission model read as granted.
 */
export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  opts?: { request?: boolean }
): Promise<boolean> {
  const h = handle as unknown as PermissionCapableHandle
  if (typeof h?.queryPermission !== 'function') return true
  try {
    if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true
    if (opts?.request && typeof h.requestPermission === 'function') {
      return (await h.requestPermission({ mode: 'read' })) === 'granted'
    }
    return false
  } catch {
    return false
  }
}

/** v5-a6: snapshot helpers (read by startWatching, written fire-and-forget). */
export async function getSnapshot(): Promise<WatchSnapshot | null> {
  return idbGet<WatchSnapshot>(STORES.snapshot, 'folder')
}

export async function saveSnapshot(s: WatchSnapshot): Promise<void> {
  await idbPut(STORES.snapshot, 'folder', s)
}

/**
 * v5-a6: queue metadata helpers. Only metadata is persisted — the File
 * objects live in memory and die with the tab, so the panel clears the
 * store on mount ("Queued files live until this tab closes").
 */
export async function getQueueMeta(): Promise<WatchQueueItem[]> {
  return idbGetAll<WatchQueueItem>(STORES.queue)
}

export async function saveQueueMeta(items: WatchQueueItem[]): Promise<void> {
  await idbClear(STORES.queue)
  for (const item of items) await idbPut(STORES.queue, null, item)
}

export async function clearQueueMeta(): Promise<void> {
  await idbClear(STORES.queue)
}

/** Read the flat directory listing (files only — v5 does not recurse). */
async function readEntries(handle: FileSystemDirectoryHandle): Promise<Record<string, WatchSnapshotEntry>> {
  const out: Record<string, WatchSnapshotEntry> = {}
  const dir = handle as unknown as IterableDirectoryHandle
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file') continue
    try {
      const f = await (entry as FileSystemFileHandle).getFile()
      out[name] = { size: f.size, lastModified: f.lastModified }
    } catch {
      /* unreadable file — skip it */
    }
  }
  return out
}

async function getFile(handle: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    return await (await handle.getFileHandle(name)).getFile()
  } catch {
    return null
  }
}

/**
 * v5-a6: poll `handle.entries()` every intervalMs (default 4000, clamped to a
 * 2000ms floor) and diff against the persisted snapshot. Emits 'added' /
 * 'changed' events carrying the live File. The first poll with no snapshot
 * (or a snapshot from a different folder) takes a silent baseline instead, so
 * pre-existing files don't flood the feed. The snapshot is written back to
 * IDB fire-and-forget. Returns a stop() that clears the timer. Never throws
 * to the caller: poll failures (permission revoked, disk gone) are swallowed
 * and retried on the next tick.
 */
export function startWatching(
  handle: FileSystemDirectoryHandle,
  onEvents: (events: WatchEvent[]) => void,
  opts?: { intervalMs?: number }
): () => void {
  const interval = Math.max(2000, opts?.intervalMs ?? 4000)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let snapshot: WatchSnapshot | null = null
  let snapshotLoaded = false

  const schedule = () => {
    if (!stopped) timer = setTimeout(() => void tick(), interval)
  }

  const tick = async () => {
    if (stopped) return
    try {
      if (!snapshotLoaded) {
        snapshot = await getSnapshot()
        snapshotLoaded = true
        if (!snapshot || snapshot.path !== handle.name) {
          // Silent baseline poll: record what's already there, emit nothing.
          snapshot = { path: handle.name, entries: await readEntries(handle) }
          void saveSnapshot(snapshot)
          schedule()
          return
        }
      }
      const entries = await readEntries(handle)
      if (stopped) return // stop() raced this poll — drop the result
      const prev = snapshot?.entries ?? {}
      const events: WatchEvent[] = []
      for (const [name, meta] of Object.entries(entries)) {
        const old = prev[name]
        if (!old) {
          const file = await getFile(handle, name)
          if (file) events.push({ kind: 'added', name, file })
        } else if (old.size !== meta.size || old.lastModified !== meta.lastModified) {
          const file = await getFile(handle, name)
          if (file) events.push({ kind: 'changed', name, file })
        }
      }
      snapshot = { path: handle.name, entries }
      void saveSnapshot(snapshot) // fire-and-forget
      if (events.length > 0) {
        try {
          onEvents(events)
        } catch {
          /* listener errors must not kill the watcher */
        }
      }
    } catch {
      /* poll failed (permission revoked mid-watch, folder unmounted…) —
         keep polling; the panel re-checks permission via ensurePermission */
    }
    schedule()
  }

  void tick() // immediate first poll, then every intervalMs
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
