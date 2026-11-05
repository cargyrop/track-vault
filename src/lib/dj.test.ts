import { describe, expect, it } from 'vitest'
import { draftDjPicks } from './dj'
import type { PlayEvent, TrackWithSources } from './types'

const NOW = Date.parse('2026-10-13T12:00:00.000Z')
const iso = (daysAgo: number) =>
  new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString()

let nextId = 1

function track(overrides: Partial<TrackWithSources> = {}): TrackWithSources {
  const id = nextId++
  return {
    id,
    title: `Title ${id}`,
    artist: 'Someone',
    album: null,
    coverUrl: null,
    year: null,
    musicbrainzRecordingId: null,
    info: null,
    lyrics: null,
    lyricsSource: null,
    duration: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    genres: [],
    sources: [],
    ...overrides,
  }
}

function play(trackId: number, daysAgo: number): PlayEvent {
  return { trackId, playedAt: iso(daysAgo) }
}

describe('draftDjPicks', () => {
  it('prefers the seed artist and shared genres', () => {
    const seed = track({ artist: 'Metal Band', genres: ['metal'] })
    const mate = track({ artist: 'Metal Band', genres: ['metal'] })
    const stranger = track({ artist: 'Pop Act', genres: ['pop'] })
    const picks = draftDjPicks({
      tracks: [seed, mate, stranger],
      seedTrackId: seed.id,
      plays: [],
      count: 2,
      now: NOW,
      random: () => 0,
    })
    expect(picks.map((t) => t.id)).toEqual([mate.id, stranger.id])
  })

  it('never drafts the seed, the queue or the waiting picks', () => {
    const seed = track({ artist: 'A' })
    const queued = track({ artist: 'A' })
    const waiting = track({ artist: 'A' })
    const free = track({ artist: 'B' })
    const picks = draftDjPicks({
      tracks: [seed, queued, waiting, free],
      seedTrackId: seed.id,
      plays: [],
      count: 5,
      excludeIds: [queued.id, waiting.id],
      now: NOW,
      random: () => 0,
    })
    expect(picks.map((t) => t.id)).toEqual([free.id])
  })

  it('holds back tracks heard in the last day', () => {
    const seed = track({ artist: 'A' })
    const fresh = track({ artist: 'A' })
    const heard = track({ artist: 'A' })
    const picks = draftDjPicks({
      tracks: [seed, fresh, heard],
      seedTrackId: seed.id,
      plays: [play(heard.id, 0.04)],
      count: 2,
      now: NOW,
      random: () => 0,
    })
    expect(picks.map((t) => t.id)).toEqual([fresh.id])
  })

  it('plays the best match anyway when the cooldown leaves nothing', () => {
    const seed = track({ artist: 'A' })
    const heard = track({ artist: 'A' })
    const picks = draftDjPicks({
      tracks: [seed, heard],
      seedTrackId: seed.id,
      plays: [play(heard.id, 0.04)],
      count: 2,
      now: NOW,
      random: () => 0,
    })
    expect(picks.map((t) => t.id)).toEqual([heard.id])
  })

  it('drafts on taste alone when there is no seed', () => {
    const loved1 = track({ artist: 'Loved' })
    const loved2 = track({ artist: 'Loved' })
    const other = track({ artist: 'Other' })
    const picks = draftDjPicks({
      tracks: [loved1, loved2, other],
      seedTrackId: null,
      plays: [play(loved1.id, 2), play(loved1.id, 3), play(loved2.id, 4)],
      count: 2,
      now: NOW,
      random: () => 0,
    })
    // Both outrank the unplayed track; their own order is the shuffle's.
    expect(picks.map((t) => t.id).sort()).toEqual([loved1.id, loved2.id].sort())
  })

  it('ranks a playlist mate above an unrelated track', () => {
    const seed = track({ artist: 'A', genres: ['x'] })
    const mate = track({ artist: 'B', genres: ['y'] })
    const stranger = track({ artist: 'C', genres: ['z'] })
    const picks = draftDjPicks({
      tracks: [seed, mate, stranger],
      seedTrackId: seed.id,
      plays: [],
      playlistGroups: [[seed.id, mate.id]],
      count: 1,
      now: NOW,
      random: () => 0,
    })
    expect(picks.map((t) => t.id)).toEqual([mate.id])
  })

  it('opens on the newest additions when there is no seed and no taste', () => {
    const old = track({ artist: 'A' })
    const recent = track({ artist: 'B' })
    const picks = draftDjPicks({
      tracks: [old, recent],
      seedTrackId: null,
      plays: [],
      count: 2,
      now: NOW,
      random: () => 0,
    })
    expect(picks.map((t) => t.id)).toEqual([recent.id, old.id])
  })

  it('returns nothing when the pool is empty or nothing is wanted', () => {
    const only = track()
    expect(
      draftDjPicks({
        tracks: [only],
        seedTrackId: only.id,
        plays: [],
        count: 3,
        now: NOW,
      }),
    ).toEqual([])
    expect(
      draftDjPicks({ tracks: [only], seedTrackId: null, plays: [], count: 0, now: NOW }),
    ).toEqual([])
  })
})
