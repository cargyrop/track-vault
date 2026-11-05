import { beforeEach, describe, expect, it } from 'vitest'
import { Library } from './db'
import { createMemoryDriver } from './drivers'
import { createMemoryTransport, JsonLibrary } from './jsonLibrary'
import { EMPTY_FILTER, type NewTrack } from './types'

/**
 * Replace is the mirror sibling of the merge import: the store is emptied
 * first, so afterwards it holds exactly what the file held — no leftovers.
 * Asserted against both stores, like every other rule two implementations
 * must agree on.
 *
 * The scenario is the phone that imported last month's export: it holds a
 * track the file no longer has, a playlist the file no longer has, a removed
 * member still filed, a renamed playlist under its old name, and its own
 * listen history. After replacing with this month's export, none of that may
 * remain.
 */

type Store = Library | JsonLibrary

async function sqlStore(): Promise<Store> {
  const lib = new Library(await createMemoryDriver())
  await lib.migrate()
  return lib
}

async function jsonStore(): Promise<Store> {
  const lib = new JsonLibrary(createMemoryTransport(''))
  await lib.migrate()
  return lib
}

function track(overrides: Partial<NewTrack> = {}): NewTrack {
  return {
    title: 'Keep',
    artist: 'Someone',
    genres: [],
    sources: [
      {
        youtubeId: 'aaaaaaaaaaa',
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        kind: 'official',
        role: 'audio',
      },
    ],
    ...overrides,
  }
}

const stores: Array<[string, () => Promise<Store>]> = [
  ['SQL', sqlStore],
  ['JSON', jsonStore],
]

/** The newer export: what the library must look like afterwards, exactly. */
async function newerExport(make: () => Promise<Store>): Promise<string> {
  const file = await make()
  const keep = await file.addTrack(track({ album: 'File album' }))
  const fresh = await file.addTrack(
    track({
      title: 'New',
      artist: 'Someone Else',
      musicbrainzRecordingId: 'mb-new',
    }),
  )
  const shared = await file.createPlaylist('Shared', 'file notes')
  await file.addToPlaylist(shared, keep)
  await file.addToPlaylist(shared, fresh)
  await file.recordPlay(keep)
  return file.exportJson()
}

for (const [label, make] of stores) {
  describe(`library replace (${label})`, () => {
    let lib: Store

    beforeEach(async () => {
      lib = await make()
    })

    it('mirrors the file: drops what the file no longer holds', async () => {
      // The phone's stale state: its own copy of Keep (with its own album), a
      // track, playlist and folder the file never had, and Shared holding the
      // removed member plus its own notes.
      const keepId = await lib.addTrack(track({ album: 'Phone album' }))
      const ghostId = await lib.addTrack(
        track({ title: 'Ghost', artist: 'Nobody' }),
      )
      await lib.createFolder('Stale')
      const old = await lib.createPlaylist('Old')
      await lib.addToPlaylist(old, ghostId)
      const shared = await lib.createPlaylist('Shared', 'phone notes')
      await lib.addToPlaylist(shared, keepId)
      await lib.addToPlaylist(shared, ghostId)
      await lib.recordPlay(ghostId)

      await lib.replaceJson(await newerExport(make))

      // Tracks: exactly the file's, with the file's details winning.
      const tracks = await lib.listTracks(EMPTY_FILTER)
      expect(tracks.map((t) => t.title).sort()).toEqual(['Keep', 'New'])
      expect(tracks.find((t) => t.title === 'Keep')?.album).toBe('File album')

      // Playlists: the deleted one is gone, Shared holds exactly the file's
      // members with the file's notes. Looked up by name: ids are local, so
      // the pre-replace id is meaningless afterwards.
      const playlists = await lib.listPlaylists()
      expect(playlists.map((p) => p.name)).toEqual(['Shared'])
      const members = await lib.listPlaylistTracks(playlists[0].id)
      const memberTitles = (
        await Promise.all(members.map((m) => lib.getTrack(m.trackId)))
      )
        .map((t) => t?.title)
        .sort()
      expect(memberTitles).toEqual(['Keep', 'New'])
      expect(playlists[0].description).toBe('file notes')

      // Folders: the file had none, so none remain.
      expect(await lib.listFolders()).toEqual([])

      // Listen history belongs to the mirrored library: the ghost's play is
      // forgotten, the file's play for Keep is kept.
      const plays = await lib.listRecentPlays(50)
      expect(plays).toHaveLength(1)
      const keep = tracks.find((t) => t.title === 'Keep')
      expect(plays[0].trackId).toBe(keep?.id)
    })

    it('imports into an empty store exactly like a merge import does', async () => {
      const result = await lib.replaceJson(await newerExport(make))
      expect(result.tracks).toBe(2)
      expect(result.playlists).toBe(1)
      expect(result.unmatched).toEqual([])
      expect((await lib.listTracks(EMPTY_FILTER)).map((t) => t.title).sort()).toEqual([
        'Keep',
        'New',
      ])
    })

    it('empties the library for a valid empty export', async () => {
      await lib.addTrack(track())
      await lib.createPlaylist('Old')
      await lib.replaceJson(
        JSON.stringify({
          format: 'trackvault-library',
          version: 1,
          tracks: [],
          folders: [],
          playlists: [],
          plays: [],
        }),
      )
      expect(await lib.listTracks(EMPTY_FILTER)).toEqual([])
      expect(await lib.listPlaylists()).toEqual([])
      expect(await lib.listFolders()).toEqual([])
    })

    it('refuses a file that is not a library export and deletes nothing', async () => {
      await lib.addTrack(track())
      await expect(lib.replaceJson('this is not json')).rejects.toThrow(
        /nothing was deleted/,
      )
      await expect(
        lib.replaceJson(JSON.stringify({ arbitrary: 'json' })),
      ).rejects.toThrow(/nothing was deleted/)
      expect(await lib.listTracks(EMPTY_FILTER)).toHaveLength(1)
    })
  })
}
