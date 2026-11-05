import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import {
  buildContext,
  mergeInbox,
  parseInbox,
  summarise,
  verifyInboxIds,
  type Inbox,
  type MergeReport,
} from './src/lib/agentInbox'
import { checkCoverLiveness, classifyCoverUrl } from './src/lib/covers'
import { checkVideoExists } from './src/lib/metadata'
import { normalise } from './src/lib/jsonLibrary'
import type { LibraryDocument } from './src/lib/types'

/**
 * Serves the library as a plain JSON file on disk, plus the AI drop box.
 *
 * The browser cannot read the filesystem directly, so this plugin exposes:
 *
 *   GET    /api/library          -> the current JSON document
 *   PUT    /api/library          -> replaces it with the request body
 *   GET    /api/library/revision -> just the revision, for polling
 *   GET    /api/agent/context    -> compact summary + how to write an inbox
 *   GET    /api/agent/inbox      -> what is waiting in the drop box
 *   PUT    /api/agent/inbox      -> drop an inbox in without touching the disk
 *                                   (POST does the same thing)
 *   DELETE /api/agent/inbox      -> throw the drop box away
 *   GET    /api/agent/backups    -> the snapshots a merge can be undone from
 *   POST   /api/agent/restore    -> put one of them back
 *
 * The library lives at DATA_DIR/library.json. It is plain JSON on purpose: it
 * can be opened in an editor, handed to an AI assistant, and picked up again
 * without a reload button.
 *
 * ## Why the drop box lives here rather than in the app
 *
 * An agent writes `data/inbox.json` and the merge happens on the next read of
 * the library — including a plain `curl http://localhost:1420/api/library`, so
 * a headless agent needs no browser at all.
 *
 * Two properties fall out of doing it here that would not hold in the browser:
 *
 * - **The inbox is never lost.** The file is only cleared *after* the merged
 *   library has been written. If anything else writes the library first — the
 *   app saving an edit, a second agent — the inbox is still sitting there and
 *   the next read merges it again.
 * - **A client cannot silently revert a merge.** Writes carry `If-Match`, so a
 *   browser tab holding a document from before the merge is told its write is
 *   stale instead of overwriting the merged result.
 *
 * Writes are atomic (temp file + rename) and serialised through a queue so two
 * rapid edits cannot interleave, and the library is copied into `backups/`
 * before every merge — an agent batch is an unattended bulk write, and it
 * should be undoable without a version-control system.
 */

export interface LibraryApiOptions {
  /** Directory holding library.json. Relative paths resolve against the project root. */
  dataDir?: string
  /**
   * How many pre-merge snapshots to keep. Five is deliberate rather than
   * generous: each one is the whole library, and the newest is almost always
   * the one worth restoring, so a deep history costs disk to be ignored. The
   * oldest is deleted as soon as a sixth arrives.
   */
  backups?: number
}

function emptyLibrary(): LibraryDocument {
  return {
    format: 'trackvault-library',
    version: 1,
    tracks: [],
    folders: [],
    playlists: [],
    plays: [],
  }
}

function serialise(doc: LibraryDocument): string {
  return JSON.stringify(doc, null, 2)
}

/**
 * The revision of the file, as a short content hash.
 *
 * A content hash rather than a counter so it is meaningful after a restart and
 * so a hand edit in a text editor counts as a change — which is the whole
 * reason `If-Match` exists here. Hashing a few hundred KB every four seconds
 * is nothing next to re-parsing it.
 */
function revision(body: string): string {
  return createHash('sha1').update(body).digest('hex').slice(0, 16)
}

/**
 * Drops the cover URLs an agent sent that no longer answer.
 *
 * Half of this rule is enforced by `mergeInbox` itself, because it is pure: a
 * cover on a video-still or channel-picture host is refused there, so the panel's
 * own preview refuses it too. Whether a URL still *answers* cannot be decided in
 * the browser at all — a cross-origin HEAD is blocked and Cover Art Archive sends
 * no CORS headers — so it is decided here, and the reason travels back as a note
 * so the report stays complete either way.
 *
 * The URL is nulled rather than the track refused: a missing cover is a state the
 * app already handles by deriving one from the video, and losing a track over its
 * artwork would be the wrong trade.
 */
async function verifyInboxCovers(
  inbox: Inbox,
): Promise<{ inbox: Inbox; notes: string[] }> {
  const notes: string[] = []
  const tracks = await Promise.all(
    inbox.tracks.map(async (track) => {
      const url = typeof track.coverUrl === 'string' ? track.coverUrl.trim() : ''
      // Anything else is the merge's business, and asking about it would waste a
      // request on a URL that is about to be refused anyway.
      if (!url || classifyCoverUrl(url) !== 'album-art') return track
      const check = await checkCoverLiveness(url)
      if (check.ok) return track
      notes.push(
        `${track.artist} — ${track.title}: kept no cover, because ${check.reason}.`,
      )
      return { ...track, coverUrl: null }
    }),
  )
  return { inbox: { ...inbox, tracks }, notes }
}

export function libraryApi(options: LibraryApiOptions = {}): Plugin {
  const dataDir = resolve(process.cwd(), options.dataDir ?? 'data')
  const file = resolve(dataDir, 'library.json')
  const temp = resolve(dataDir, 'library.json.tmp')
  const inboxFile = resolve(dataDir, 'inbox.json')
  const contextFile = resolve(dataDir, 'agent-context.json')
  const reportFile = resolve(dataDir, 'last-merge.json')
  const backupDir = resolve(dataDir, 'backups')
  const keepBackups = options.backups ?? 5

  const readLibrary = (): string => {
    if (!existsSync(file)) {
      mkdirSync(dataDir, { recursive: true })
      const seed = serialise(emptyLibrary())
      writeFileSync(file, seed, 'utf8')
      return seed
    }
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return serialise(emptyLibrary())
    return raw
  }

  // Serialise writes so concurrent PUTs cannot clobber each other.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run, run)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const writeLibrary = (body: string): void => {
    // Validate before touching the real file.
    JSON.parse(body)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(temp, body, 'utf8')
    // Atomic swap: readers never observe a half-written library.
    renameSync(temp, file)
  }

  /** Copies the current library aside so a merge can be undone. */
  const snapshot = (): void => {
    try {
      mkdirSync(backupDir, { recursive: true })
      // Colons are illegal in Windows filenames, so the stamp uses dashes.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      // Two snapshots in the same millisecond would otherwise be one file: the
      // second copy would overwrite the first and the undo list would claim a
      // step that no longer exists. The counter keeps names sortable (fixed
      // width stamp, then a fixed width sequence) as well as unique.
      let name = `library-${stamp}-01.json`
      for (let seq = 2; existsSync(join(backupDir, name)); seq += 1) {
        name = `library-${stamp}-${String(seq).padStart(2, '0')}.json`
      }
      copyFileSync(file, join(backupDir, name))
      const existing = readdirSync(backupDir)
        .filter((n) => n.startsWith('library-') && n.endsWith('.json'))
        .sort()
      for (const old of existing.slice(0, Math.max(0, existing.length - keepBackups))) {
        rmSync(join(backupDir, old), { force: true })
      }
    } catch {
      // A failed backup must not stop the merge; the merge itself is the
      // thing that matters, and the inbox is archived either way.
    }
  }

  /**
   * The digest an agent reads before writing anything.
   *
   * Regenerated on every library write so it can never be stale, and written to
   * `data/agent-context.json` as well as served over HTTP — an agent working in
   * a checkout should not have to start a server to find out what is already in
   * the library.
   */
  const refreshContext = (raw: string): void => {
    try {
      const context = buildContext(normalise(raw))
      writeFileSync(contextFile, JSON.stringify(context, null, 2), 'utf8')
    } catch {
      // The context is a convenience. Never fail a write because of it.
    }
  }

  /**
   * Regenerates the context only when it is behind the library.
   *
   * Comparing timestamps rather than always rewriting matters because the app
   * reads the library every few seconds, and writing a file on each read would
   * be pointless churn. It also covers the case the unconditional version
   * missed: restoring a backup by copying it over `library.json` bypasses the
   * API entirely, and an assistant reading a context file that still described
   * the undone batch would be working from a lie.
   */
  const refreshContextIfStale = (raw: string): void => {
    try {
      if (existsSync(contextFile)) {
        if (statSync(contextFile).mtimeMs >= statSync(file).mtimeMs) return
      }
    } catch {
      // If the comparison cannot be made, fall through and write it.
    }
    refreshContext(raw)
  }

  /**
   * Merges `data/inbox.json` into the library if it is new.
   *
   * Idempotent by content hash rather than by "clear the file", so the same
   * inbox submitted twice is a no-op the second time — and, more importantly,
   * so an inbox is never consumed by a merge that failed to write.
   */
  let mergedInbox: string | null = null

  const applyInbox = (): Promise<string> =>
    enqueue(async () => {
      const raw = readLibrary()
      const digest = revision(raw)
      if (!existsSync(inboxFile)) return raw

      let inboxRaw: string
      try {
        inboxRaw = readFileSync(inboxFile, 'utf8')
        JSON.parse(inboxRaw || '{}')
      } catch {
        // A half-written or malformed inbox is left exactly where it is. The
        // agent is probably still writing it, and consuming the truncated part
        // would silently throw away the rest.
        console.warn(
          '[trackvault] data/inbox.json is not valid JSON yet; leaving it in place.',
        )
        return raw
      }

      const parsedInbox = parseInbox(inboxRaw)
      if (!parsedInbox.tracks.length && !parsedInbox.playlists.length) {
        // An empty drop box is the resting state, not a batch. Clear it without
        // archiving or snapshotting, so a repeated read does not fill the data
        // directory with copies of nothing.
        if (inboxRaw.trim()) rmSync(inboxFile, { force: true })
        mergedInbox = digest
        return raw
      }

      if (mergedInbox === digest) return raw

      const { inbox, notes } = await verifyInboxCovers(parsedInbox)
      // Every linked video is asked if it exists before the merge judges the
      // batch on it. A hallucinated id becomes a named rejection with a fix
      // path (send a replacement) rather than an unplayable track. Failed
      // checks fail open inside `verifyInboxIds`, so a flaky connection
      // merges unchecked rather than rejecting the batch.
      const deadIds = await verifyInboxIds(inbox, (id) => checkVideoExists(id))

      snapshot()
      const { doc, report } = mergeInbox(normalise(raw), inbox, { notes, deadIds })
      writeLibrary(serialise(doc))
      archiveInbox(inboxRaw, digest)
      mergedInbox = digest

      const merged = serialise(doc)
      refreshContext(merged)
      try {
        writeFileSync(
          reportFile,
          JSON.stringify({ ...report, summary: summarise(report) }, null, 2),
          'utf8',
        )
      } catch {
        // The report is a convenience for the UI and for the agent to read back.
      }
      console.log(`[trackvault] inbox merged — ${summarise(report)}`)
      return merged
    })

  /** Keeps what the agent sent, so a merge can be inspected or redone. */
  const archiveInbox = (inboxRaw: string, digest: string): void => {
    try {
      const dir = resolve(dataDir, 'inbox-applied')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      writeFileSync(join(dir, `inbox-${digest}-${stamp}.json`), inboxRaw, 'utf8')
      rmSync(inboxFile, { force: true })
    } catch {
      // Failing to archive must not stop the merge. If the inbox file is still
      // there, the content hash above still makes the next merge a no-op.
    }
  }

  const readInbox = (): { present: boolean; valid: boolean; body: string | null } => {
    if (!existsSync(inboxFile)) return { present: false, valid: true, body: null }
    const body = readFileSync(inboxFile, 'utf8')
    if (!body.trim()) return { present: false, valid: true, body: null }
    try {
      JSON.parse(body)
      return { present: true, valid: true, body }
    } catch {
      return { present: true, valid: false, body }
    }
  }

  /**
   * The snapshots a merge can be undone from, newest first.
   *
   * Read from the directory rather than from any index, so a backup copied in
   * by hand shows up here too. The track count comes from parsing each file,
   * which is a few hundred KB at most and buys the one thing the panel needs to
   * say: which of these is the library *before* the batch.
   */
  const listBackups = (): Array<{ name: string; at: string; tracks: number | null }> => {
    if (!existsSync(backupDir)) return []
    return readdirSync(backupDir)
      .filter((name) => name.startsWith('library-') && name.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => {
        let tracks: number | null = null
        try {
          const parsed = JSON.parse(readFileSync(join(backupDir, name), 'utf8'))
          if (Array.isArray(parsed?.tracks)) tracks = parsed.tracks.length
        } catch {
          // A truncated or hand-mangled snapshot is still listed — it can be
          // seen, and skipped — rather than hidden until the app restarts.
        }
        let at = ''
        try {
          at = statSync(join(backupDir, name)).mtime.toISOString()
        } catch {
          at = ''
        }
        return { name, at, tracks }
      })
  }

  /**
   * Puts a snapshot back.
   *
   * The current library is snapshotted first, so undoing a restore is a matter
   * of clicking the newest backup rather than of digging in a file manager. A
   * merge report is dropped at the same time: it describes a batch that no
   * longer happened, and leaving it on screen would be a lie about what the
   * library contains.
   */
  const restoreBackup = (name: string): { tracks: number } => {
    // Resolved against what is actually on disk rather than joined from the
    // name, so a crafted name cannot climb out of the backups directory.
    const known = existsSync(backupDir)
      ? readdirSync(backupDir).filter(
          (entry) => entry.startsWith('library-') && entry.endsWith('.json'),
        )
      : []
    const target = known.find((entry) => entry === name)
    if (!target) throw new Error('That backup no longer exists.')

    const body = readFileSync(join(backupDir, target), 'utf8')
    // Validated before the current library is snapshotted, so a corrupt file
    // leaves both the library and the backup list exactly as they were.
    // Parsed here rather than relying on `normalise`, which repairs a broken
    // file into an *empty* library — exactly the wrong thing to restore.
    const parsed: unknown = JSON.parse(body || '{}')
    if (!Array.isArray((parsed as { tracks?: unknown })?.tracks)) {
      throw new Error('That backup is not a TrackVault library.')
    }
    const restored = normalise(body)

    snapshot()
    writeLibrary(serialise(restored))
    mergedInbox = null
    refreshContext(serialise(restored))
    try {
      rmSync(reportFile, { force: true })
    } catch {
      // The report is a convenience; failing to remove it must not fail the
      // restore that already succeeded.
    }
    return { tracks: restored.tracks.length }
  }

  const readReport = (): MergeReport | null => {
    if (!existsSync(reportFile)) return null
    try {
      return JSON.parse(readFileSync(reportFile, 'utf8')) as MergeReport
    } catch {
      return null
    }
  }

  const handler = async (
    req: unknown,
    res: {
      statusCode: number
      setHeader(k: string, v: string): void
      end(chunk?: string): void
    },
    next: () => void,
  ) => {
    const request = req as {
      url?: string
      method?: string
      headers?: Record<string, string | string[] | undefined>
    }
    const url = (request.url ?? '').split('?')[0]
    const method = (request.method ?? 'GET').toUpperCase()
    if (
      url !== '/api/library' &&
      url !== '/api/library/revision' &&
      url !== '/api/agent/context' &&
      url !== '/api/agent/inbox' &&
      url !== '/api/agent/backups' &&
      url !== '/api/agent/restore'
    ) {
      return next()
    }

    const sendJson = (status: number, value: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(value))
    }

    const readBody = (onDone: (body: string) => void): void => {
      const chunks: Buffer[] = []
      const stream = req as {
        on(event: 'data', fn: (chunk: Buffer) => void): unknown
        on(event: 'end', fn: () => void): unknown
      }
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => onDone(Buffer.concat(chunks).toString('utf8')))
    }

    // ------------------------------------------------------------- library

    if (url === '/api/library' && (method === 'GET' || method === 'HEAD')) {
      const body = await applyInbox()
      refreshContextIfStale(body)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      // The client polls this, and a merge changes the body under it.
      res.setHeader('ETag', `"${revision(body)}"`)
      res.end(method === 'HEAD' ? undefined : body)
      return
    }

    if (url === '/api/library/revision' && method === 'GET') {
      // Deliberately does *not* merge. This is the endpoint the app polls every
      // four seconds, and its job is to report: what revision the library is
      // on, and whether something is waiting. If it merged, a batch could never
      // be observed as pending, and the banner that says one is waiting would
      // be unreachable. The merge happens when the app next reads the library.
      const body = readLibrary()
      refreshContextIfStale(body)
      sendJson(200, {
        revision: revision(body),
        inbox: readInbox(),
        report: readReport(),
      })
      return
    }

    if (url === '/api/library' && method === 'PUT') {
      readBody((body) => {
        enqueue(async () => {
          const current = readLibrary()
          // Refuse a write based on a document that is no longer on disk. The
          // usual cause is an agent merge landing between the client reading
          // the library and saving an edit; without this the save would revert
          // everything the merge just added.
          const ifMatch = String(request.headers?.['if-match'] ?? '').replace(
            /"/g,
            '',
          )
          if (ifMatch && ifMatch !== revision(current)) {
            sendJson(409, {
              error:
                'The library changed on disk since you loaded it. Reload and try again.',
              revision: revision(current),
            })
            return
          }
          try {
            writeLibrary(body)
          } catch (err: unknown) {
            sendJson(400, {
              error: err instanceof Error ? err.message : 'Write failed',
            })
            return
          }
          refreshContext(body)
          res.statusCode = 204
          res.setHeader('ETag', `"${revision(body)}"`)
          res.end()
        }).catch((err: unknown) => {
          sendJson(500, {
            error: err instanceof Error ? err.message : 'Write failed',
          })
        })
      })
      return
    }

    // --------------------------------------------------------------- agent

    if (url === '/api/agent/context' && method === 'GET') {
      const body = await applyInbox()
      refreshContext(body)
      sendJson(200, buildContext(normalise(body)))
      return
    }

    if (url === '/api/agent/inbox' && method === 'GET') {
      const inbox = readInbox()
      sendJson(200, {
        present: inbox.present,
        valid: inbox.valid,
        inbox: inbox.valid && inbox.body ? parseInbox(inbox.body) : null,
        report: readReport(),
      })
      return
    }

    // PUT is the literal verb — it replaces the whole drop box — but POST is what
// anyone actually reaches for when submitting a batch, and answering that with
// a bare 405 helps nobody. Both merge; the README documents POST.
if (url === '/api/agent/inbox' && (method === 'PUT' || method === 'POST')) {
      readBody((body) => {
        try {
          JSON.parse(body || '{}')
        } catch (err: unknown) {
          sendJson(400, {
            error: err instanceof Error ? err.message : 'Invalid JSON',
          })
          return
        }
        try {
          mkdirSync(dataDir, { recursive: true })
          const tmp = resolve(dataDir, 'inbox.json.tmp')
          writeFileSync(tmp, body, 'utf8')
          renameSync(tmp, inboxFile)
        } catch (err: unknown) {
          sendJson(500, {
            error: err instanceof Error ? err.message : 'Could not write the inbox',
          })
          return
        }
        // Merge straight away so a headless caller gets the result of its write
        // instead of having to poll for it.
        applyInbox().then(() =>
          sendJson(200, { ok: true, report: readReport() }),
        )
      })
      return
    }

    if (url === '/api/agent/backups' && method === 'GET') {
      sendJson(200, { backups: listBackups() })
      return
    }

    if (url === '/api/agent/restore' && method === 'POST') {
      readBody((body) => {
        let name = ''
        try {
          name = String(JSON.parse(body || '{}').name ?? '')
        } catch {
          sendJson(400, { error: 'Invalid JSON' })
          return
        }
        enqueue(async () => {
          try {
            const { tracks } = restoreBackup(name)
            console.log(`[trackvault] restored a backup — ${tracks} tracks`)
            sendJson(200, { ok: true, tracks })
          } catch (err: unknown) {
            sendJson(400, {
              error: err instanceof Error ? err.message : 'Could not restore it',
            })
          }
        }).catch((err: unknown) => {
          sendJson(500, {
            error: err instanceof Error ? err.message : 'Restore failed',
          })
        })
      })
      return
    }

    if (url === '/api/agent/inbox' && method === 'DELETE') {
      enqueue(async () => {
        if (existsSync(inboxFile)) {
          try {
            rmSync(inboxFile, { force: true })
          } catch (err: unknown) {
            sendJson(500, {
              error: err instanceof Error ? err.message : 'Could not clear it',
            })
            return
          }
        }
        sendJson(200, { ok: true })
      })
      return
    }

    res.statusCode = 405
    res.end()
  }

  return {
    name: 'trackvault-library-api',
    // `configurePreviewServer` covers `vite preview`, which is what the
    // double-click launcher uses.
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
    configureServer(server) {
      server.middlewares.use(handler)
    },
  }
}