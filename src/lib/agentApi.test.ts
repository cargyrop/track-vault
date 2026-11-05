import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { libraryApi } from '../../vite-plugin-library'
import type { LibraryDocument } from './types'

/**
 * End-to-end coverage of the endpoints the AI workflow depends on.
 *
 * The merge is pure and tested on its own, but the parts that only exist here
 * are the ones that can lose data: consuming the inbox, taking the backup,
 * and refusing a write based on a stale read. Those need a real filesystem and
 * a real request, so the plugin is driven through its own middleware handler
 * rather than a stand-in.
 */

type Handler = (req: unknown, res: unknown, next: () => void) => void

interface Reply {
  status: number
  headers: Record<string, string>
  body: string
  json<T>(): T
}

let dir: string
let handle: Handler

const SEED: LibraryDocument = {
  format: 'trackvault-library',
  version: 1,
  tracks: [
    {
      id: 1,
      title: 'Locust',
      artist: 'Machine Head',
      album: 'Catharsis',
      coverUrl: null,
      year: 2018,
      musicbrainzRecordingId: 'mb-locust',
      info: null,
      duration: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      genres: ['thrash metal'],
      sources: [
        {
          id: 1,
          youtubeId: 'jxjeqCd6Zm0',
          url: 'https://www.youtube.com/watch?v=jxjeqCd6Zm0',
          kind: 'official',
          label: null,
          role: 'audio',
        },
      ],
    },
  ],
  folders: [],
  playlists: [],
  plays: [],
}

/** Drives one request through the plugin's middleware, like Vite would. */
async function request(
  method: string,
  url: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const req = new EventEmitter() as EventEmitter & {
    url: string
    method: string
    headers: Record<string, string>
  }
  req.url = url
  req.method = method
  req.headers = options.headers ?? {}

  let status = 200
  const headers: Record<string, string> = {}
  let body = ''

  const res = {
    set statusCode(value: number) {
      status = value
    },
    get statusCode() {
      return status
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
    end(chunk?: string) {
      if (chunk !== undefined) body = chunk
      resolve({ status, headers, body, json: <T>() => JSON.parse(body) as T })
    },
  }

  let resolve!: (r: Reply) => void
  const done = new Promise<Reply>((r) => {
    resolve = r
  })

  handle(req, res, () => resolve({ status: 404, headers, body: '', json: <T>() => ({}) as T }))
  if (options.body !== undefined) {
    req.emit('data', Buffer.from(options.body, 'utf8'))
  }
  req.emit('end')
  return done
}

const library = async () =>
  (await request('GET', '/api/library')).json<LibraryDocument>()

/** Lists a directory that may legitimately not exist yet. */
const listDir = (name: string) =>
  existsSync(join(dir, name)) ? readdirSync(join(dir, name)) : []

/**
 * The ids these batches link to, answered as alive.
 *
 * The plugin verifies every linked video against YouTube before merging, so
 * without this the suite would depend on the real network — and on whether
 * those uploads still exist. The merge's own reaction to a dead link is
 * covered below by answering 404 instead.
 */
const LIVE_IDS = ['MHW2CF4GF-8', 'Dzc7tZB8X_k']

function stubOEmbed(live: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      const alive = live.some((id) => url.includes(id))
      return alive ? { ok: true, status: 200 } : { ok: false, status: 404 }
    }),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trackvault-test-'))
  writeFileSync(join(dir, 'library.json'), JSON.stringify(SEED, null, 2), 'utf8')
  stubOEmbed(LIVE_IDS)
  const plugin = libraryApi({ dataDir: dir }) as unknown as {
    configureServer(server: { middlewares: { use(h: Handler): void } }): void
  }
  plugin.configureServer({ middlewares: { use: (h) => (handle = h) } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/library', () => {
  it('serves the document with an ETag to write against', async () => {
    const res = await request('GET', '/api/library')
    expect(res.status).toBe(200)
    expect(res.headers.etag).toMatch(/^"[0-9a-f]+"$/)
    expect(res.json<LibraryDocument>().tracks).toHaveLength(1)
  })

  it('reports the same revision when nothing changed', async () => {
    const first = await request('GET', '/api/library/revision')
    const second = await request('GET', '/api/library/revision')
    expect(second.json<{ revision: string }>().revision).toBe(
      first.json<{ revision: string }>().revision,
    )
  })
})

describe('PUT /api/library', () => {
  it('accepts a write whose revision matches', async () => {
    const current = await library()
    const etag = (await request('GET', '/api/library')).headers.etag
    current.tracks[0].title = 'Locust (edited)'
    const res = await request('PUT', '/api/library', {
      body: JSON.stringify(current, null, 2),
      headers: { 'if-match': etag },
    })
    expect(res.status).toBe(204)
    expect((await library()).tracks[0].title).toBe('Locust (edited)')
  })

  it('refuses a write based on a stale read, rather than reverting a merge', async () => {
    // This is the scenario the check exists for: the app holds a document from
    // before an agent batch landed, and saving it would undo the batch.
    const staleEtag = (await request('GET', '/api/library')).headers.etag

    writeFileSync(
      join(dir, 'inbox.json'),
      JSON.stringify({
        tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
      }),
      'utf8',
    )
    expect((await library()).tracks).toHaveLength(2)

    const stale = JSON.stringify(SEED, null, 2)
    const res = await request('PUT', '/api/library', {
      body: stale,
      headers: { 'if-match': staleEtag },
    })
    expect(res.status).toBe(409)
    // The merge survives the refused write.
    expect((await library()).tracks).toHaveLength(2)
  })

  it('still accepts a write with no If-Match, for a plain file put there', async () => {
    const doc = { ...SEED, playlists: [] }
    const res = await request('PUT', '/api/library', { body: JSON.stringify(doc) })
    expect(res.status).toBe(204)
  })

  it('rejects a body that is not JSON without touching the file', async () => {
    const res = await request('PUT', '/api/library', { body: 'not json' })
    expect(res.status).toBe(400)
    expect((await library()).tracks).toHaveLength(1)
  })
})

describe('the drop box', () => {
  const inbox = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      tracks: [
        { title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' },
      ],
      playlists: [{ name: 'Gym', tracks: ['Rotting Christ — Demonon Vrosis'] }],
      ...extra,
    })

  it('merges the inbox on the next read, with nothing else to do', async () => {
    writeFileSync(join(dir, 'inbox.json'), inbox(), 'utf8')
    const doc = await library()
    expect(doc.tracks).toHaveLength(2)
    expect(doc.playlists).toHaveLength(1)
    expect(doc.playlists[0].tracks).toEqual([2])
  })

  it('enriches a track it already has instead of duplicating it', async () => {
    writeFileSync(
      join(dir, 'inbox.json'),
      JSON.stringify({
        tracks: [
          {
            title: 'Locust',
            artist: 'Machine Head',
            genres: ['groove metal'],
            video: 'Dzc7tZB8X_k',
          },
        ],
      }),
      'utf8',
    )
    const doc = await library()
    expect(doc.tracks).toHaveLength(1)
    expect(doc.tracks[0].genres).toEqual(['thrash metal', 'groove metal'])
    expect(doc.tracks[0].sources).toHaveLength(2)
  })

  it('consumes the inbox and keeps a copy of what was sent', async () => {
    writeFileSync(join(dir, 'inbox.json'), inbox(), 'utf8')
    await library()
    expect(existsSync(join(dir, 'inbox.json'))).toBe(false)
    const archived = listDir('inbox-applied')
    expect(archived).toHaveLength(1)
    expect(
      JSON.parse(readFileSync(join(dir, 'inbox-applied', archived[0]), 'utf8')).tracks,
    ).toHaveLength(1)
  })

  it('snapshots the library before merging, so the batch can be undone', async () => {
    writeFileSync(join(dir, 'inbox.json'), inbox(), 'utf8')
    await library()
    const backups = listDir('backups')
    expect(backups).toHaveLength(1)
    const before = JSON.parse(readFileSync(join(dir, 'backups', backups[0]), 'utf8'))
    expect(before.tracks).toHaveLength(1)
  })

  it('is idempotent: a second read does not re-apply the same inbox', async () => {
    writeFileSync(join(dir, 'inbox.json'), inbox(), 'utf8')
    const first = await library()
    const second = await library()
    expect(second.tracks).toHaveLength(first.tracks.length)
    expect(listDir('backups')).toHaveLength(1)
  })

  it('leaves a half-written inbox in place instead of consuming the truncated part', async () => {
    // An agent mid-write is the normal reason a file is briefly invalid.
    writeFileSync(join(dir, 'inbox.json'), '{"tracks": [{"title": "Half', 'utf8')
    const doc = await library()
    expect(doc.tracks).toHaveLength(1)
    expect(existsSync(join(dir, 'inbox.json'))).toBe(true)
  })

  it('treats an empty inbox as nothing to do, leaving no snapshot behind', async () => {
    writeFileSync(join(dir, 'inbox.json'), '', 'utf8')
    await library()
    await library()
    expect(listDir('backups')).toHaveLength(0)
    expect(listDir('inbox-applied')).toHaveLength(0)
  })

  it('writes the report the UI and the agent both read back', async () => {
    writeFileSync(
      join(dir, 'inbox.json'),
      JSON.stringify({
        tracks: [{ title: 'Ghost', artist: 'Nobody', audio: 'the official video' }],
      }),
      'utf8',
    )
    await library()
    const report = JSON.parse(readFileSync(join(dir, 'last-merge.json'), 'utf8'))
    expect(report.added).toBe(1)
    expect(report.summary).toContain('1 added')
  })

  it('adds a batch track whose link YouTube says does not exist, flagging it', async () => {
    stubOEmbed([])
    const res = await request('PUT', '/api/agent/inbox', {
      body: JSON.stringify({
        tracks: [{ title: 'Ghost', artist: 'Nobody', audio: 'ddddddddddd' }],
      }),
    })
    expect(res.status).toBe(200)
    const report = res.json<{
      report: { added: number; lines: Array<{ reason?: string }> }
    }>().report
    expect(report.added).toBe(1)
    expect(report.lines[0].reason).toContain('ddddddddddd')
    // Stored without a source: red in the list until the link is fixed by hand.
    const tracks = (await library()).tracks
    expect(tracks).toHaveLength(2)
    expect(tracks[1].sources).toHaveLength(0)
  })

  it('refreshes the agent context file on every write', async () => {
    const res = await request('GET', '/api/agent/context')
    expect(res.status).toBe(200)
    expect(res.json<{ counts: { tracks: number } }>().counts.tracks).toBe(1)
    const onDisk = JSON.parse(readFileSync(join(dir, 'agent-context.json'), 'utf8'))
    expect(onDisk.tracks[0].title).toBe('Locust')
  })

  it('regenerates a context file that a hand-restored backup left behind', async () => {
    await request('GET', '/api/library')
    writeFileSync(
      join(dir, 'inbox.json'),
      JSON.stringify({
        tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
      }),
      'utf8',
    )
    await request('GET', '/api/library')
    expect(
      JSON.parse(readFileSync(join(dir, 'agent-context.json'), 'utf8')).counts.tracks,
    ).toBe(2)

    // Undoing the batch by copying a file, which bypasses the API entirely.
    const undone = { ...SEED }
    const undoneBody = JSON.stringify(undone, null, 2)
    writeFileSync(join(dir, 'library.json'), undoneBody, 'utf8')
    // Force the timestamps to order the way a real restore would.
    utimesSync(join(dir, 'library.json'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))

    await request('GET', '/api/library')
    // An assistant must not be told about a batch the person just undid.
    expect(
      JSON.parse(readFileSync(join(dir, 'agent-context.json'), 'utf8')).counts.tracks,
    ).toBe(1)
  })

  it('does not rewrite an already-current context file on every poll', async () => {
    await request('GET', '/api/library')
    const first = statSync(join(dir, 'agent-context.json')).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await request('GET', '/api/library')
    await request('GET', '/api/library')
    expect(statSync(join(dir, 'agent-context.json')).mtimeMs).toBe(first)
  })
})

describe('agent endpoints', () => {
  it('merges an inbox submitted over HTTP and returns the report', async () => {
    const res = await request('PUT', '/api/agent/inbox', {
      body: JSON.stringify({
        tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.json<{ report: { added: number } }>().report.added).toBe(1)
    expect((await library()).tracks).toHaveLength(2)
  })

  it('accepts POST as well, since that is what a person submitting a batch reaches for', async () => {
    // The README documents `curl -X POST`. Answering that with a bare 405 is
    // the kind of thing that makes someone conclude the feature is broken.
    const res = await request('POST', '/api/agent/inbox', {
      body: JSON.stringify({
        tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(res.json<{ report: { added: number } }>().report.added).toBe(1)
    expect((await library()).tracks).toHaveLength(2)
  })

  it('rejects an inbox that is not valid JSON', async () => {
    const res = await request('PUT', '/api/agent/inbox', { body: 'nope' })
    expect(res.status).toBe(400)
    expect((await library()).tracks).toHaveLength(1)
  })

  it('reports what is waiting without merging it', async () => {
    writeFileSync(join(dir, 'inbox.json'), '{"tracks":[]}', 'utf8')
    const res = await request('GET', '/api/agent/inbox')
    expect(res.json<{ present: boolean }>().present).toBe(true)
    expect((await library()).tracks).toHaveLength(1)
  })

  it('flags a malformed inbox as invalid so the UI can say so', async () => {
    writeFileSync(join(dir, 'inbox.json'), '{ broken', 'utf8')
    const res = await request('GET', '/api/agent/inbox')
    expect(res.json<{ valid: boolean }>().valid).toBe(false)
  })

  it('throws the drop box away on DELETE', async () => {
    writeFileSync(join(dir, 'inbox.json'), '{"tracks":[]}', 'utf8')
    const res = await request('DELETE', '/api/agent/inbox')
    expect(res.status).toBe(200)
    expect(existsSync(join(dir, 'inbox.json'))).toBe(false)
  })

  it('polls revision, inbox state and the last report in one request', async () => {
    writeFileSync(
      join(dir, 'inbox.json'),
      JSON.stringify({
        tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
      }),
      'utf8',
    )
    const res = await request('GET', '/api/library/revision')
    const body = res.json<{
      revision: string
      inbox: { present: boolean }
      report: unknown
    }>()
    expect(body.revision).toMatch(/^[0-9a-f]+$/)
    // Reported, not applied: a poll must be able to see a batch as pending, or
    // the banner that says one is waiting could never appear.
    expect(body.inbox.present).toBe(true)
    expect(body.report).toBeNull()
    expect(existsSync(join(dir, 'inbox.json'))).toBe(true)
    expect((await library()).tracks).toHaveLength(2)
  })

  it('passes unrelated requests through to the next middleware', async () => {
    const res = await request('GET', '/something-else')
    expect(res.status).toBe(404)
  })
})

/**
 * Undo, which only exists as files until it exists as a button.
 *
 * A batch is an unattended bulk write, so the safety net has to be reachable
 * from the same screen that fires the write — otherwise restoring a backup means
 * opening a file manager and copying a file over another one, which is exactly
 * the mistake that leaves the library half-restored.
 */
describe('backups', () => {
  /** Merges a distinct track, so each merge takes its own snapshot. */
  const merge = async (title: string) => {
    writeFileSync(
      join(dir, 'inbox.json'),
      JSON.stringify({
        tracks: [{ title, artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
      }),
      'utf8',
    )
    return library()
  }

  it('keeps the five most recent and deletes the oldest beyond that', async () => {
    for (let i = 1; i <= 7; i++) await merge(`Track ${i}`)
    const kept = listDir('backups')
    expect(kept).toHaveLength(5)
    // Sorted by name, and the stamp is an ISO time, so the newest is last.
    expect(kept[kept.length - 1]).toContain('library-')
    expect([...kept].sort()).toEqual(kept)
  })

  it('lists them newest first, with the track count of each', async () => {
    await merge('Demonon Vrosis')
    const res = await request('GET', '/api/agent/backups')
    expect(res.status).toBe(200)
    const { backups } = res.json<{
      backups: Array<{ name: string; at: string; tracks: number | null }>
    }>()
    expect(backups).toHaveLength(1)
    expect(backups[0].name.startsWith('library-')).toBe(true)
    expect(backups[0].tracks).toBe(1)
    expect(Number.isNaN(Date.parse(backups[0].at))).toBe(false)
  })

  it('puts a snapshot back', async () => {
    await merge('Demonon Vrosis')
    expect((await library()).tracks).toHaveLength(2)
    const [{ name }] = (
      await request('GET', '/api/agent/backups')
    ).json<{ backups: Array<{ name: string }> }>().backups

    const res = await request('POST', '/api/agent/restore', {
      body: JSON.stringify({ name }),
    })
    expect(res.status).toBe(200)
    expect(res.json<{ tracks: number }>().tracks).toBe(1)
    expect((await library()).tracks).toHaveLength(1)
  })

  it('snapshots the library again on the way back, so a restore is undoable', async () => {
    await merge('Demonon Vrosis')
    const [{ name }] = (
      await request('GET', '/api/agent/backups')
    ).json<{ backups: Array<{ name: string }> }>().backups
    await request('POST', '/api/agent/restore', { body: JSON.stringify({ name }) })

    const { backups } = (
      await request('GET', '/api/agent/backups')
    ).json<{ backups: Array<{ name: string; tracks: number }> }>()
    expect(backups[0].tracks).toBe(2)
    // And the newer backup is the one to put back.
    await request('POST', '/api/agent/restore', {
      body: JSON.stringify({ name: backups[0].name }),
    })
    expect((await library()).tracks).toHaveLength(2)
  })

  it('drops the merge report, which describes a batch that no longer happened', async () => {
    await merge('Demonon Vrosis')
    expect(existsSync(join(dir, 'last-merge.json'))).toBe(true)
    const [{ name }] = (
      await request('GET', '/api/agent/backups')
    ).json<{ backups: Array<{ name: string }> }>().backups
    await request('POST', '/api/agent/restore', { body: JSON.stringify({ name }) })
    expect(existsSync(join(dir, 'last-merge.json'))).toBe(false)
  })

  it('regenerates the context file, so an assistant is not told about the undone batch', async () => {
    await merge('Demonon Vrosis')
    const [{ name }] = (
      await request('GET', '/api/agent/backups')
    ).json<{ backups: Array<{ name: string }> }>().backups
    await request('POST', '/api/agent/restore', { body: JSON.stringify({ name }) })
    const res = await request('GET', '/api/agent/context')
    expect(res.json<{ counts: { tracks: number } }>().counts.tracks).toBe(1)
  })

  it('refuses a backup that is not there', async () => {
    const res = await request('POST', '/api/agent/restore', {
      body: JSON.stringify({ name: 'library-nope.json' }),
    })
    expect(res.status).toBe(400)
    expect(res.json<{ error: string }>().error).toMatch(/no longer exists/)
    expect((await library()).tracks).toHaveLength(1)
  })

  it('refuses a name that tries to climb out of the backups directory', async () => {
    const res = await request('POST', '/api/agent/restore', {
      body: JSON.stringify({ name: '../library.json' }),
    })
    expect(res.status).toBe(400)
    expect((await library()).tracks).toHaveLength(1)
  })

  it('refuses a snapshot that is not a library, without touching the current one', async () => {
    await merge('Demonon Vrosis')
    writeFileSync(join(dir, 'backups', 'library-broken.json'), '{"nope":true}', 'utf8')
    const res = await request('POST', '/api/agent/restore', {
      body: JSON.stringify({ name: 'library-broken.json' }),
    })
    expect(res.status).toBe(400)
    expect((await library()).tracks).toHaveLength(2)
  })
})