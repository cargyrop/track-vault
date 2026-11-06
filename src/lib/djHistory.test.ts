import { describe, expect, it } from 'vitest'
import { Library } from './db'
import { createMemoryDriver } from './drivers'
import { createMemoryTransport, JsonLibrary } from './jsonLibrary'
import { MAX_PLAY_EVENTS } from './dj'
import { normalise } from './libraryImport'
import { EMPTY_FILTER, type NewTrack } from './types'

/**
 * Play history is telemetry both stores must keep identically: the DJ learns
 * taste from it, so a listen recorded in one storage mode has to read back the
 * same in the other. Shared-contract file — every assertion loops over both
 * stores, per the architectural rule.
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
    title: 'Song',
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

for (const [label, make] of stores) {
  describe(`play history (${label})`, () => {
    it('reads back completed listens newest first', async () => {
      const lib = await make()
      const id = await lib.addTrack(track())
      await lib.recordPlay(id, '2026-10-10T10:00:00.000Z')
      await lib.recordPlay(id, '2026-10-12T10:00:00.000Z')
      await lib.recordPlay(id, '2026-10-11T10:00:00.000Z')
      const plays = await lib.listRecentPlays(10)
      expect(plays).toEqual([
        { trackId: id, playedAt: '2026-10-12T10:00:00.000Z' },
        { trackId: id, playedAt: '2026-10-11T10:00:00.000Z' },
        { trackId: id, playedAt: '2026-10-10T10:00:00.000Z' },
      ])
    })

    it('forgets a deleted track’s listens with it', async () => {
      const lib = await make()
      const id = await lib.addTrack(track())
      await lib.recordPlay(id)
      await lib.deleteTrack(id)
      expect(await lib.listRecentPlays(10)).toEqual([])
    })

    it('prunes to the shared cap instead of growing forever', async () => {
      const lib = await make()
      const id = await lib.addTrack(track())
      const events = Array.from({ length: MAX_PLAY_EVENTS + 5 }, (_, i) => ({
        trackId: id,
        playedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      }))
      await lib.recordPlays(events)
      const plays = await lib.listRecentPlays(MAX_PLAY_EVENTS + 5)
      expect(plays).toHaveLength(MAX_PLAY_EVENTS)
      // The tail is kept: the oldest five fell off, the newest survived.
      expect(plays[plays.length - 1]).toEqual(events[5])
      expect(plays[0]).toEqual(events[events.length - 1])
    })

    it('round-trips history through export and import without duplicating', async () => {
      const lib = await make()
      const id = await lib.addTrack(track())
      await lib.recordPlay(id, '2026-10-12T10:00:00.000Z')
      await lib.recordPlay(id, '2026-10-11T10:00:00.000Z')
      const json = await lib.exportJson()

      const fresh = await make()
      await fresh.importJson(json)
      const only = (await fresh.listTracks(EMPTY_FILTER))[0]
      expect(await fresh.listRecentPlays(10)).toEqual([
        { trackId: only.id, playedAt: '2026-10-12T10:00:00.000Z' },
        { trackId: only.id, playedAt: '2026-10-11T10:00:00.000Z' },
      ])

      // Re-importing the same backup adds nothing twice.
      await fresh.importJson(json)
      expect(await fresh.listRecentPlays(10)).toHaveLength(2)
    })
  })
}

describe('normalise play history', () => {
  it('keeps sound entries and drops the rest', () => {
    const doc = normalise(
      JSON.stringify({
        tracks: [],
        playlists: [],
        plays: [
          { trackId: 1, playedAt: '2026-10-12T10:00:00.000Z' },
          { trackId: 'oops', playedAt: '2026-10-12T10:00:00.000Z' },
          { trackId: 2, playedAt: 'not a date' },
          null,
        ],
      }),
    )
    expect(doc.plays).toEqual([{ trackId: 1, playedAt: '2026-10-12T10:00:00.000Z' }])
  })

  it('reads old files without history as empty', () => {
    expect(normalise(JSON.stringify({ tracks: [] })).plays).toEqual([])
  })
})
