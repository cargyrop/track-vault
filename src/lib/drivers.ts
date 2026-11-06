import type { SqlDriver } from './db'
import { loadSnapshot, saveSnapshot } from './persistence'

/**
 * Resolves the sql.js wasm binary. Vite turns the `?url` import into a served
 * asset for the browser build, but under Vitest (node) we must read it from
 * disk, so we fall back to node_modules via createRequire.
 */
async function resolveWasmUrl(): Promise<string> {
  const viteUrl = (await import('sql.js/dist/sql-wasm.wasm?url')).default
  if (typeof window !== 'undefined') return viteUrl
  const nodeModuleSpec = `node:${'module'}`
  const { createRequire } = (await import(/* @vite-ignore */ nodeModuleSpec)) as typeof import('node:module')
  const require = createRequire(import.meta.url)
  return require.resolve('sql.js/dist/sql-wasm.wasm')
}

/** Node-only; guarded by readWasmBinary so the browser build never calls it. */

/**
 * Browser/preview driver backed by sql.js, persisted to IndexedDB so the
 * library survives a refresh or a browser restart.
 */
export async function createMemoryDriver(): Promise<SqlDriver> {
  const initSqlJs = (await import('sql.js')).default
  const wasmPath = await resolveWasmUrl()
  const SQL = await initSqlJs({
    locateFile: () => wasmPath,
    // Required when the path is not a URL that sql.js' loader can fetch.
    wasmBinary: await readWasmBinary(wasmPath),
  })

  const saved = await loadSnapshot()
  const db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database()

  // Writes are the only trigger for a snapshot; reads never touch storage.
  // DDL and DML both arrive via execute, and a migration fires dozens of
  // statements, so snapshotting is coalesced onto a microtask rather than
  // serializing the whole database after every single one.
  let scheduled = false
  const schedulePersist = () => {
    if (scheduled) return
    scheduled = true
    void Promise.resolve().then(() => {
      scheduled = false
      void saveSnapshot(() => db.export())
    })
  }

  return {
    async execute(sql, params = []) {
      db.run(sql, params as never[])
      schedulePersist()
    },
    async select(sql, params = []) {
      const stmt = db.prepare(sql)
      try {
        stmt.bind(params as never[])
        const rows: Array<Record<string, unknown>> = []
        while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>)
        return rows as never
      } finally {
        stmt.free()
      }
    },
  }
}

async function readWasmBinary(path: string): Promise<ArrayBuffer | undefined> {
  if (typeof window !== 'undefined') return undefined
  // Kept out of the browser bundle graph while remaining resolvable in Node/Vitest.
  const nodeFsSpec = `node:${'fs/promises'}`
  const { readFile } = (await import(/* @vite-ignore */ nodeFsSpec)) as typeof import('node:fs/promises')
  const buf = await readFile(path)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** Browser-local fallback, persisted in IndexedDB when the local JSON API is unavailable. */
export const createDefaultDriver = createMemoryDriver
