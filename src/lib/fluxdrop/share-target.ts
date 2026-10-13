// Web Share Target handoff — main-thread side.
//
// The service worker (public/sw.js) receives POST /share-target (from the OS
// share sheet), stashes the payload into IndexedDB under a one-time token and
// redirects to /?shared=<token>. This module retrieves and deletes that
// record. DB/store names MUST stay in sync with the SW copy.

export interface SharedFileEntry {
  name: string
  type: string
  size: number
  lastModified: number
  data: ArrayBuffer
}

export interface SharedPayload {
  files: SharedFileEntry[]
  text: string
  receivedAt: number
}

const DB_NAME = 'fluxdrop-share'
const DB_VERSION = 1
const STORE = 'shares'

function openShareDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('share-db open failed'))
  })
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error ?? new Error('share-db get failed'))
  })
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('share-db delete failed'))
  })
}

/** Fetch the stashed payload for a token (returns null if absent/expired). */
export async function getSharedPayload(token: string): Promise<SharedPayload | null> {
  try {
    const db = await openShareDb()
    try {
      const rec = await idbGet<SharedPayload>(db, token)
      if (!rec || typeof rec !== 'object' || !Array.isArray(rec.files)) return null
      return rec
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Remove the stashed payload (one-time handoff — never leave data behind). */
export async function deleteSharedPayload(token: string): Promise<void> {
  try {
    const db = await openShareDb()
    try {
      await idbDelete(db, token)
    } finally {
      db.close()
    }
  } catch {
    /* best-effort */
  }
}

/** Sweep stale stashes (older than 10 minutes) that were never consumed. */
export async function sweepStaleShares(): Promise<void> {
  try {
    const db = await openShareDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const req = store.openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          const rec = cursor.value as SharedPayload | undefined
          if (!rec || Date.now() - (rec.receivedAt ?? 0) > 10 * 60 * 1000) {
            cursor.delete()
          }
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('sweep failed'))
      })
    } finally {
      db.close()
    }
  } catch {
    /* best-effort */
  }
}
