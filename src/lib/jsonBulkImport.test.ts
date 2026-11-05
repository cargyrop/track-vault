import { describe, expect, it } from 'vitest'
import { createMemoryTransport, JsonLibrary, type JsonTransport } from './jsonLibrary'
import { EMPTY_FILTER } from './types'

/**
 * The JSON store's side of an import: how much it writes, and what a refresh
 * landing in the middle of one is allowed to do.
 *
 * Both are invisible to the shared importer — `libraryImport.ts` asks each store
 * to `transact` and gets on with it — so they are asserted here, against the
 * store that has a file to write.
 */

function audioSource(id: string) {
  return {
    youtubeId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    kind: 'official' as const,
    role: 'audio' as const,
  }
}

/** A library of `count` tracks, each filed in one of two playlists. */
function exportOf(count: number): string {
  const tracks = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Song ${i + 1}`,
    artist: `Artist ${i % 7}`,
    album: null,
    coverUrl: null,
    year: null,
    musicbrainzRecordingId: null,
    info: null,
    duration: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    genres: ['rock'],
    sources: [
      {
        id: i + 1,
        youtubeId: `vid${String(i).padStart(8, '0')}`,
        url: `https://www.youtube.com/watch?v=vid${String(i).padStart(8, '0')}`,
        kind: 'official',
        role: 'audio',
      },
    ],
  }))
  return JSON.stringify(
    {
      format: 'trackvault-library',
      version: 1,
      tracks,
      folders: [],
      playlists: [
        {
          id: 1,
          name: 'First half',
          description: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          tracks: tracks.slice(0, Math.ceil(count / 2)).map((t) => t.id),
          folderId: null,
        },
        {
          id: 2,
          name: 'Second half',
          description: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          tracks: tracks.slice(Math.ceil(count / 2)).map((t) => t.id),
          folderId: null,
        },
      ],
      plays: [],
    },
    null,
    2,
  )
}

describe('JsonLibrary bulk import', () => {
  it('writes the file once for a whole import, not once per track', async () => {
    let saves = 0
    const memory = createMemoryTransport('')
    const transport: JsonTransport = {
      load: () => memory.load(),
      save: (json, options) => {
        saves++
        return memory.save(json, options)
      },
    }
    const lib = new JsonLibrary(transport)
    await lib.migrate()

    const result = await lib.replaceJson(exportOf(300))

    expect(result.tracks).toBe(300)
    expect(await lib.listTracks(EMPTY_FILTER)).toHaveLength(300)
    // One write for the empty start and the finished library together. A
    // per-track write here is 300 whole-document serialisations — the quadratic
    // cost that made a 1765-track import take minutes.
    expect(saves).toBe(1)
    // And what landed on disk is the finished library, not a prefix.
    expect(JSON.parse(memory.current()).tracks).toHaveLength(300)
  })

  it('leaves the library untouched when the import cannot be written', async () => {
    const memory = createMemoryTransport(exportOf(3))
    let failNextSave = false
    const transport: JsonTransport = {
      load: () => memory.load(),
      save: (json, options) => {
        if (failNextSave) return Promise.reject(new Error('disk full'))
        return memory.save(json, options)
      },
    }
    const lib = new JsonLibrary(transport)
    await lib.migrate()
    expect(await lib.listTracks(EMPTY_FILTER)).toHaveLength(3)

    failNextSave = true
    await expect(lib.replaceJson(exportOf(50))).rejects.toThrow('disk full')

    // The replacing file never arrived, so the library it was replacing is
    // still there — in memory and on disk. It used to be emptied first.
    expect(await lib.listTracks(EMPTY_FILTER)).toHaveLength(3)
    failNextSave = false
    expect(JSON.parse(memory.current()).tracks).toHaveLength(3)
  })

  it('does not let a refresh in flight drop an edit it read past', async () => {
    // The shape of the bug: the poll reads the file, then an edit is saved, then
    // the poll's older copy is installed as the document — and the next write
    // persists that older copy, losing the edit. Here the read is held open
    // until after the first save so the stale body is guaranteed to be what
    // comes back.
    const memory = createMemoryTransport('')
    let releaseRead: (() => void) | null = null
    let readHeld = false
    let holdNextLoad = false
    const transport: JsonTransport = {
      load: async () => {
        const body = await memory.load()
        if (holdNextLoad) {
          holdNextLoad = false
          readHeld = true
          await new Promise<void>((resolve) => {
            releaseRead = resolve
          })
        }
        return body
      },
      save: (json, options) => memory.save(json, options),
    }

    const lib = new JsonLibrary(transport)
    await lib.migrate()
    await lib.addTrack({
      title: 'Before',
      artist: 'Somebody',
      genres: [],
      sources: [audioSource('beforevid01')],
    })

    holdNextLoad = true
    const refreshing = lib.reload()
    // Not awaited yet: its save queues behind the read that is being held open.
    const adding = lib.addTrack({
      title: 'During',
      artist: 'Somebody',
      genres: [],
      sources: [audioSource('duringvid01')],
    })
    while (!readHeld) await new Promise((resolve) => setTimeout(resolve, 1))
    releaseRead!()
    await adding
    await refreshing

    await lib.addTrack({
      title: 'After',
      artist: 'Somebody',
      genres: [],
      sources: [audioSource('aftervid001')],
    })

    const titles = (await lib.listTracks(EMPTY_FILTER)).map((t) => t.title).sort()
    expect(titles).toEqual(['After', 'Before', 'During'])
    const onDisk = JSON.parse(memory.current()).tracks.map(
      (t: { title: string }) => t.title,
    )
    expect(onDisk.sort()).toEqual(['After', 'Before', 'During'])
  })

  it('keeps every track and playlist while a refresh runs during an import', async () => {
    // A refresh every four seconds is what the app actually does, and an import
    // of a real library takes long enough to overlap several. Before the guard,
    // one of them could drop a playlist the import had just created, and the
    // import then failed with "Playlist not found." — leaving a partial library.
    const lib = new JsonLibrary(createMemoryTransport(''))
    await lib.migrate()

    const importing = lib.replaceJson(exportOf(120))
    await Promise.all(
      Array.from({ length: 30 }, () => lib.reload().catch(() => undefined)),
    )
    const result = await importing

    expect(result.tracks).toBe(120)
    expect(result.playlists).toBe(2)
    expect(result.unmatched).toEqual([])
    expect(await lib.listTracks(EMPTY_FILTER)).toHaveLength(120)
    const playlists = await lib.listPlaylists()
    expect(playlists.reduce((n, p) => n + p.trackCount, 0)).toBe(120)
  })
})
