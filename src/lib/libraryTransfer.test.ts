import { beforeEach, describe, expect, it } from 'vitest'
import { Library } from './db'
import { createMemoryDriver } from './drivers'
import { createMemoryTransport, JsonLibrary } from './jsonLibrary'
import { EMPTY_FILTER, type NewTrack, type SourceRole } from './types'

/**
 * Export and import are how a library moves between the JSON file and the
 * browser-local SQLite fallback, so every rule is asserted against both stores.
 * The questions this file exists to answer are the ones a person actually asks
 * when they import a backup: did my playlists survive, did the folder tree
 * survive, and does an older copy of a track overwrite the fuller one I have?
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
    title: 'Paranoid Android',
    artist: 'Radiohead',
    genres: ['prog rock'],
    sources: [
      {
        youtubeId: 'f7nonexistent1',
        url: 'https://www.youtube.com/watch?v=f7nonexistent1',
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

for (const [label, make] of stores) {
  describe(`library transfer (${label})`, () => {
    let lib: Store

    beforeEach(async () => {
      lib = await make()
    })

    it('round-trips tracks, folders, playlist notes and membership', async () => {
      const root = await lib.createFolder('Greek')
      const child = await lib.createFolder('Live', root)
      const pl = await lib.createPlaylist('Olive & Overdrive', 'for the drive home', child)
      const a = await lib.addTrack(
        track({ title: 'A', artist: 'One', sources: [
          { youtubeId: 'aaaaaaaaaaa', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', kind: 'official', role: 'audio' },
        ] }),
      )
      const b = await lib.addTrack(
        track({ title: 'B', artist: 'Two', lyrics: 'words to B', duration: 200, sources: [
          { youtubeId: 'bbbbbbbbbbb', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', kind: 'official', role: 'audio' },
        ] }),
      )
      await lib.setSource(a, 'video', {
        youtubeId: 'ccccccccccc',
        url: 'https://www.youtube.com/watch?v=ccccccccccc',
        kind: 'live',
        label: 'Live',
      })
      await lib.addToPlaylist(pl, a)
      await lib.addToPlaylist(pl, b)

      const json = await lib.exportJson()

      const fresh = await make()
      const result = await fresh.importJson(json)
      expect(result.tracks).toBe(2)
      expect(result.folders).toBe(2)
      expect(result.unmatched).toEqual([])
      expect(result.unplayable).toEqual([])

      // The tree came back with its nesting.
      const folders = await fresh.listFolders()
      const rootNew = folders.find((f) => f.name === 'Greek')
      const childNew = folders.find((f) => f.name === 'Live')
      expect(childNew?.parentId).toBe(rootNew?.id)

      // The playlist came back with its folder, its notes and its two tracks.
      const imported = (await fresh.listPlaylists()).find(
        (p) => p.name === 'Olive & Overdrive',
      )
      expect(imported?.folderId).toBe(childNew?.id)
      expect(imported?.description).toBe('for the drive home')
      expect(imported?.trackCount).toBe(2)

      // Track detail — including the new lyrics field and the second source.
      const restored = (await fresh.listTracks(EMPTY_FILTER)).find(
        (t) => t.title === 'B',
      )
      expect(restored?.lyrics).toBe('words to B')
      expect(restored?.duration).toBe(200)
      const withVideo = (await fresh.listTracks(EMPTY_FILTER)).find(
        (t) => t.title === 'A',
      )
      expect(withVideo?.sources.map((s) => s.role).sort()).toEqual(['audio', 'video'])
    })

    it('is idempotent: importing the same file twice adds nothing twice', async () => {
      const pl = await lib.createPlaylist('Once')
      const id = await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
      await lib.addToPlaylist(pl, id)
      const json = await lib.exportJson()

      const fresh = await make()
      await fresh.importJson(json)
      await fresh.importJson(json)

      expect(await fresh.listTracks(EMPTY_FILTER)).toHaveLength(1)
      expect(await fresh.listPlaylists()).toHaveLength(1)
      expect((await fresh.listPlaylists())[0].trackCount).toBe(1)
    })

    it('fills blanks from a richer import and keeps them from a poorer one', async () => {
      // The poor copy is the library's starting state.
      await lib.addTrack(track())
      const poor = await lib.exportJson()

      // A richer copy of the same song, in a second library.
      const rich = await make()
      await rich.addTrack(
        track({
          album: 'OK Computer',
          info: 'Recorded in 1997.',
          lyrics: 'Please could you stop the noise',
          duration: 383,
        }),
      )
      await rich.setSource(
        (await rich.listTracks(EMPTY_FILTER))[0].id,
        'video',
        {
          youtubeId: 'kJQP7kiw5Fk',
          url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
          kind: 'live',
          label: 'Live',
        },
      )
      const richJson = await rich.exportJson()

      // Rich over poor: every blank is filled.
      await lib.importJson(richJson)
      const enriched = (await lib.listTracks(EMPTY_FILTER))[0]
      expect(enriched.album).toBe('OK Computer')
      expect(enriched.info).toBe('Recorded in 1997.')
      expect(enriched.lyrics).toBe('Please could you stop the noise')
      expect(enriched.duration).toBe(383)
      expect(enriched.sources.map((s) => s.role).sort()).toEqual(['audio', 'video'])

      // Poor over rich: nothing that was filled is taken away.
      await lib.importJson(poor)
      const kept = (await lib.listTracks(EMPTY_FILTER))[0]
      expect(kept.album).toBe('OK Computer')
      expect(kept.info).toBe('Recorded in 1997.')
      expect(kept.lyrics).toBe('Please could you stop the noise')
      expect(kept.duration).toBe(383)
      expect(kept.sources).toHaveLength(2)
    })

    it('imports an older export that names playlist tracks by artist and title', async () => {
      // The shape exported by the app before the format carried ids.
      const json = JSON.stringify({
        format: 'trackvault-library',
        tracks: [
          {
            title: 'Locust',
            artist: 'Machine Head',
            genres: ['groove metal'],
            sources: [
              {
                youtubeId: 'ddddddddddd',
                url: 'https://www.youtube.com/watch?v=ddddddddddd',
                kind: 'official',
                role: 'audio',
              },
            ],
          },
        ],
        playlists: [
          {
            name: 'Old Format',
            description: null,
            tracks: [{ title: 'Locust', artist: 'Machine Head' }],
          },
        ],
      })

      const result = await lib.importJson(json)
      expect(result.tracks).toBe(1)
      expect(result.unmatched).toEqual([])
      const imported = (await lib.listPlaylists()).find((p) => p.name === 'Old Format')
      expect(imported?.trackCount).toBe(1)
    })

    it('keeps a track with no playable link, and reports it', async () => {
      // The library itself can hold these: the link-health run leaves a track
      // in place with its dead slot cut. An import that refused them dropped
      // real data — 16 tracks and the 29 playlist entries naming them on a real
      // 1765-track file — so they are stored and named in the report instead.
      const json = JSON.stringify({
        tracks: [
          {
            title: 'Ghost',
            artist: 'Nobody',
            sources: [],
          },
          {
            title: 'Real',
            artist: 'Someone',
            sources: [
              {
                youtubeId: 'eeeeeeeeeee',
                url: 'https://www.youtube.com/watch?v=eeeeeeeeeee',
                kind: 'official',
                role: 'audio' as SourceRole,
              },
            ],
          },
        ],
        playlists: [
          {
            name: 'Mixed',
            tracks: [
              { title: 'Ghost', artist: 'Nobody' },
              { title: 'Missing', artist: 'Nobody' },
              { title: 'Real', artist: 'Someone' },
            ],
          },
        ],
      })

      const result = await lib.importJson(json)
      expect(result.tracks).toBe(2)
      expect(result.unplayable).toEqual(['Nobody — Ghost'])
      // The entry naming the unplayable track resolves; the one naming a track
      // the file does not carry is reported rather than dropped silently.
      expect(result.unmatched).toEqual(['Mixed → Nobody — Missing'])
      const imported = (await lib.listPlaylists()).find((p) => p.name === 'Mixed')
      expect(imported?.trackCount).toBe(2)
      const titles = (await lib.listTracks(EMPTY_FILTER)).map((t) => t.title).sort()
      expect(titles).toEqual(['Ghost', 'Real'])
    })

    it('survives an agent-edited file that repeats a track id', async () => {
      // Hand and model edits renumber or duplicate ids. Two tracks claiming one
      // id would leave a playlist entry resolving to whichever row came first.
      const json = JSON.stringify({
        tracks: [
          {
            id: 7,
            title: 'First',
            artist: 'One',
            sources: [
              {
                youtubeId: 'fffffffffff',
                url: 'https://www.youtube.com/watch?v=fffffffffff',
                kind: 'official',
                role: 'audio',
              },
            ],
          },
          {
            id: 7,
            title: 'Second',
            artist: 'Two',
            sources: [
              {
                youtubeId: 'ggggggggggg',
                url: 'https://www.youtube.com/watch?v=ggggggggggg',
                kind: 'official',
                role: 'audio',
              },
            ],
          },
        ],
        playlists: [{ name: 'Both', tracks: [7] }],
      })

      const result = await lib.importJson(json)
      expect(result.tracks).toBe(2)
      expect(result.unmatched).toEqual([])
      const imported = (await lib.listPlaylists()).find((p) => p.name === 'Both')
      expect(imported?.trackCount).toBe(1)
      const members = await lib.listPlaylistTracks(imported!.id)
      expect(members.map((m) => m.track.title)).toEqual(['First'])
    })
  })
}
