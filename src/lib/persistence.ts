/**
 * Browser-side persistence for the sql.js driver.
 *
 * sql.js is in-memory by design, so the browser build would lose the whole
 * library on every refresh. This stores a serialized snapshot of the database
 * in IndexedDB and writes it back after any mutating statement.
 *
 * The shared SQL store uses this in browser-only mode when the local JSON API
 * is unavailable.
 */

const DB_NAME = 'trackvault'
const STORE = 'snapshots'
const KEY = 'main'

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadSnapshot(): Promise<ArrayBuffer | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const db = await openStore()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    // A corrupt or unavailable store must not stop the app from starting.
    return null
  }
}

/**
 * Persists the database snapshot. Serialized through a queue so overlapping
 * writes cannot interleave and persist a stale image.
 */
let writeChain: Promise<void> = Promise.resolve()

export function saveSnapshot(exportBytes: () => Uint8Array): Promise<void> {
  writeChain = writeChain.then(async () => {
    if (typeof indexedDB === 'undefined') return
    try {
      const db = await openStore()
      const bytes = exportBytes()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(bytes.buffer, KEY)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      // Quota or private-mode failures are non-fatal; the session still works.
    }
  })
  return writeChain
}

