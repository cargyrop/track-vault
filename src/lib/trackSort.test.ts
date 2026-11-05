import { describe, expect, it } from 'vitest'
import { DEFAULT_SORT, sortTracks, type SortableTrack } from './trackSort'

function track(patch: Partial<SortableTrack> & { title: string }): SortableTrack {
  return {
    artist: 'Artist',
    album: null,
    year: null,
    duration: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

const rows: SortableTrack[] = [
  track({ title: 'Beta', artist: 'Zed', album: 'Zoo', year: 1999, duration: 300, createdAt: '2026-01-02T00:00:00.000Z' }),
  track({ title: 'Alpha', artist: 'amy', album: 'Ark', year: null, duration: null, createdAt: '2026-01-03T00:00:00.000Z' }),
  track({ title: 'Gamma', artist: 'Mono', album: null, year: 2007, duration: 120, createdAt: '2026-01-01T00:00:00.000Z' }),
]

const titles = (list: SortableTrack[]) => list.map((t) => t.title)

describe('sortTracks', () => {
  it('leaves the playlist order alone when asked to', () => {
    expect(titles(sortTracks(rows, DEFAULT_SORT))).toEqual(['Beta', 'Alpha', 'Gamma'])
  })

  it('never mutates the list it was given', () => {
    const before = titles(rows)
    sortTracks(rows, { key: 'title', dir: 'desc' })
    expect(titles(rows)).toEqual(before)
  })

  it('sorts titles case-insensitively', () => {
    expect(titles(sortTracks(rows, { key: 'title', dir: 'asc' }))).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ])
    expect(titles(sortTracks(rows, { key: 'title', dir: 'desc' }))).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ])
  })

  it('puts an unknown year or length last in both directions', () => {
    expect(titles(sortTracks(rows, { key: 'year', dir: 'asc' }))).toEqual([
      'Beta',
      'Gamma',
      'Alpha',
    ])
    expect(titles(sortTracks(rows, { key: 'year', dir: 'desc' }))).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ])
    expect(titles(sortTracks(rows, { key: 'duration', dir: 'desc' }))).toEqual([
      'Beta',
      'Gamma',
      'Alpha',
    ])
  })

  it('sorts by the date a track was added', () => {
    expect(titles(sortTracks(rows, { key: 'added', dir: 'asc' }))).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ])
  })

  it('treats a missing album as unknown rather than as an empty string first', () => {
    expect(titles(sortTracks(rows, { key: 'album', dir: 'asc' }))).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ])
  })
})
