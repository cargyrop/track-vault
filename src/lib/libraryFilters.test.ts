import { beforeEach, describe, expect, it } from 'vitest'
import { Library } from './db'
import { createMemoryDriver } from './drivers'
import { createMemoryTransport, JsonLibrary } from './jsonLibrary'
import { EMPTY_FILTER, type LibraryFilter, type NewTrack } from './types'
import { matchesTrackFilter } from './trackFilter'

/**
 * The two flag filters — unfiled-only and has-live-source — are rules both
 * stores must follow, so they are asserted against both here rather than
 * against one. The pattern is the shared-contract loop from
 * `libraryTransfer.test.ts`: one list of assertions, run on SQLite and on
 * the JSON file in the same edit.
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
    title: 'T',
    artist: 'A',
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

function liveSource(id: string) {
  return {
    youtubeId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    kind: 'live' as const,
    role: 'live' as const,
  }
}

const stores: Array<[string, () => Promise<Store>]> = [
  ['SQL', sqlStore],
  ['JSON', jsonStore],
]

for (const [label, make] of stores) {
  describe(`library flag filters (${label})`, () => {
    let lib: Store

    beforeEach(async () => {
      lib = await make()
    })

    it('unfiledOnly returns only tracks in no playlist', async () => {
      const filed = await lib.addTrack(track({ title: 'Filed', artist: 'A' }))
      await lib.addTrack(track({ title: 'Loose', artist: 'B' }))
      const pl = await lib.createPlaylist('P')
      await lib.addToPlaylist(pl, filed)

      const rows = await lib.listTracks({ ...EMPTY_FILTER, unfiledOnly: true })
      expect(rows.map((t) => t.title)).toEqual(['Loose'])
    })

    it('unfiledOnly combines with search instead of replacing it', async () => {
      await lib.addTrack(track({ title: 'Locust', artist: 'Machine Head' }))
      await lib.addTrack(track({ title: 'Location', artist: 'Other Band' }))
      const pl = await lib.createPlaylist('P')
      const filed = (await lib.listTracks(EMPTY_FILTER)).find(
        (t) => t.title === 'Location',
      )!
      await lib.addToPlaylist(pl, filed.id)

      const rows = await lib.listTracks({
        ...EMPTY_FILTER,
        search: 'Loc',
        unfiledOnly: true,
      })
      expect(rows.map((t) => t.title)).toEqual(['Locust'])
    })

    it('hasLiveSource returns only tracks with a live slot', async () => {
      await lib.addTrack(track({ title: 'Studio', artist: 'A' }))
      await lib.addTrack(
        track({
          title: 'Concert',
          artist: 'B',
          sources: [
            {
              youtubeId: 'aaaaaaaaaaa',
              url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
              kind: 'official',
              role: 'audio',
            },
            liveSource('bbbbbbbbbbb'),
          ],
        }),
      )

      const rows = await lib.listTracks({ ...EMPTY_FILTER, hasLiveSource: true })
      expect(rows.map((t) => t.title)).toEqual(['Concert'])
    })

    it('the two flags combine', async () => {
      const filedLive = await lib.addTrack(
        track({
          title: 'Filed live',
          artist: 'A',
          sources: [
            {
              youtubeId: 'aaaaaaaaaaa',
              url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
              kind: 'official',
              role: 'audio',
            },
            liveSource('bbbbbbbbbbb'),
          ],
        }),
      )
      await lib.addTrack(
        track({
          title: 'Loose live',
          artist: 'B',
          sources: [
            {
              youtubeId: 'ccccccccccc',
              url: 'https://www.youtube.com/watch?v=ccccccccccc',
              kind: 'official',
              role: 'audio',
            },
            liveSource('ddddddddddd'),
          ],
        }),
      )
      await lib.addTrack(track({ title: 'Loose studio', artist: 'C' }))
      const pl = await lib.createPlaylist('P')
      await lib.addToPlaylist(pl, filedLive)

      const rows = await lib.listTracks({
        ...EMPTY_FILTER,
        unfiledOnly: true,
        hasLiveSource: true,
      })
      expect(rows.map((t) => t.title)).toEqual(['Loose live'])
    })
  })
}

/**
 * The client-side helper the app uses for folder/playlist views must agree
 * with both stores on every facet except `unfiledOnly`, which needs
 * membership no bare track can answer. One library, several filters, three
 * implementations, one verdict each — so the day one of them learns a new
 * rule, this is the test that says so.
 */
for (const [label, make] of stores) {
  describe(`trackFilter parity (${label})`, () => {
    const filters: LibraryFilter[] = [
      { ...EMPTY_FILTER, search: 'loc' },
      { ...EMPTY_FILTER, genres: ['Black Metal'] },
      { ...EMPTY_FILTER, artist: 'venom' },
      { ...EMPTY_FILTER, album: 'Welcome to Hell' },
      { ...EMPTY_FILTER, sourceKind: 'live' },
      { ...EMPTY_FILTER, hasLiveSource: true },
      { ...EMPTY_FILTER, search: 'venom', genres: ['black metal'], hasLiveSource: true },
    ]

    it('agrees with the store on every facet', async () => {
      const lib = await make()
      await lib.addTrack(
        track({
          title: 'In League With Satan',
          artist: 'Venom',
          album: 'Welcome to Hell',
          genres: ['black metal', 'speed metal'],
          sources: [
            {
              youtubeId: 'aaaaaaaaaaa',
              url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
              kind: 'official',
              role: 'audio',
            },
            liveSource('bbbbbbbbbbb'),
          ],
        }),
      )
      await lib.addTrack(
        track({
          title: 'Locust',
          artist: 'Machine Head',
          album: 'Unto the Locust',
          genres: ['groove metal'],
        }),
      )
      const all = await lib.listTracks(EMPTY_FILTER)
      for (const filter of filters) {
        const fromStore = (await lib.listTracks(filter)).map((t) => t.id).sort()
        const fromHelper = all
          .filter((t) => matchesTrackFilter(t, filter))
          .map((t) => t.id)
          .sort()
        expect(fromHelper, JSON.stringify(filter)).toEqual(fromStore)
      }
    })
  })
}
