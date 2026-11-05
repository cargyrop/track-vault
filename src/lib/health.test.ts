import { describe, expect, it } from 'vitest'
import { libraryHealth } from './health'
import type { LibraryDocument, StoredTrack } from './types'

const AUDIO = {
  id: 1,
  youtubeId: 'jxjeqCd6Zm0',
  url: 'https://www.youtube.com/watch?v=jxjeqCd6Zm0',
  kind: 'official' as const,
  label: null,
  role: 'audio' as const,
}

function track(over: Partial<StoredTrack> = {}): StoredTrack {
  return {
    id: 1,
    title: 'Locust',
    artist: 'Machine Head',
    album: 'Catharsis',
    coverUrl: 'https://coverartarchive.org/release/abc123/front-500',
    year: 2018,
    musicbrainzRecordingId: 'mb-locust',
    info: null,
    duration: 293,
    createdAt: '2026-01-01T00:00:00.000Z',
    genres: ['thrash metal'],
    sources: [{ ...AUDIO }],
    ...over,
  }
}

function doc(tracks: StoredTrack[]): LibraryDocument {
  return { format: 'trackvault-library', version: 1, tracks, folders: [], playlists: [], plays: [] }
}

const kinds = (tracks: StoredTrack[]) => libraryHealth(doc(tracks)).map((f) => f.kind)

describe('libraryHealth', () => {
  it('has nothing to say about a library that is in order', () => {
    expect(libraryHealth(doc([track()]))).toEqual([])
  })

  it('catches one video filling both slots, which the editor refuses', () => {
    const found = libraryHealth(
      doc([
        track({
          sources: [{ ...AUDIO }, { ...AUDIO, id: 2, role: 'video' }],
        }),
      ]),
    )
    // Once, not twice: one track using a video twice is one contradiction.
    expect(found.map((f) => f.kind)).toEqual(['both-slots-same-video'])
    expect(found[0].severity).toBe('fix')
    expect(found).toHaveLength(1)
  })

  it('catches a track with nothing to stream', () => {
    const found = libraryHealth(doc([track({ sources: [] })]))
    expect(found.map((f) => f.kind)).toEqual(['no-source'])
    expect(found[0].severity).toBe('fix')
  })

  it('counts a clip-only track as playable, and a live-only one as not', () => {
    // Either half of the Main/clip pair plays, so a clip with no Main is fine.
    expect(
      kinds([track({ sources: [{ ...AUDIO, id: 2, role: 'video' }] })]),
    ).toEqual([])
    // A live take on its own is not: neither main view plays it.
    expect(
      kinds([track({ sources: [{ ...AUDIO, id: 2, role: 'live' }] })]),
    ).toEqual(['no-source'])
  })

  it('ignores one video under two tracks — a hint, not a contradiction', () => {
    // The same upload catalogued twice is worth a look but legal, so the
    // fixes-only report stays silent about it.
    expect(kinds([track(), track({ id: 2, title: 'Locust (live)' })])).toEqual([])
  })

  it('ignores the same cover on two tracks — a hint, not a contradiction', () => {
    expect(
      kinds([
        track({ coverUrl: 'https://example.com/one.jpg' }),
        track({ id: 2, coverUrl: 'https://example.com/ONE.jpg' }),
      ]),
    ).toEqual([])
  })

  it('ignores a stored cover that the chain would derive anyway', () => {
    expect(
      kinds([track({ coverUrl: 'https://i.ytimg.com/vi/jxjeqCd6Zm0/maxresdefault.jpg' })]),
    ).toEqual([])
  })

  it('ignores a channel-picture cover somebody may have chosen on purpose', () => {
    expect(
      kinds([track({ coverUrl: 'https://yt3.googleusercontent.com/abc=w512' })]),
    ).toEqual([])
  })

  it('ignores a missing cover and a missing MusicBrainz id', () => {
    // Both are legal and unactionable — an id cannot be invented — so neither
    // is a contradiction.
    expect(kinds([track({ coverUrl: null, musicbrainzRecordingId: null })])).toEqual([])
  })

  it('ignores a cover that is not a URL rather than throwing', () => {
    // A value that fails to load is the cover check's business, not this one's.
    expect(kinds([track({ coverUrl: 'not a url' })])).toEqual([])
  })

  it('orders contradictions by kind so a report does not reshuffle', () => {
    const found = libraryHealth(
      doc([
        track({ id: 1, sources: [] }),
        track({
          id: 2,
          sources: [{ ...AUDIO }, { ...AUDIO, id: 3, role: 'video' }],
        }),
      ]),
    )
    expect(found.map((f) => f.kind)).toEqual(['both-slots-same-video', 'no-source'])
    expect(found).toHaveLength(2)
  })

  it('labels every finding with the tracks it names', () => {
    expect(libraryHealth(doc([track({ sources: [] })]))[0].labels).toEqual([
      'Machine Head — Locust',
    ])
  })
})
