import { describe, expect, it } from 'vitest'
import {
  describeActiveTracklist,
  describeActiveTracklistFull,
  describeFilter,
  isFilterEmpty,
} from './activeTracklist'
import { EMPTY_FILTER } from './types'

describe('describeFilter', () => {
  it('returns null when nothing is set', () => {
    expect(describeFilter(EMPTY_FILTER)).toBeNull()
    expect(isFilterEmpty(EMPTY_FILTER)).toBe(true)
  })

  it('names search and genres together', () => {
    const text = describeFilter({ ...EMPTY_FILTER, search: 'miles', genres: ['bop', 'cool'] })
    expect(text).toContain('“miles”')
    expect(text).toContain('bop')
    expect(isFilterEmpty({ ...EMPTY_FILTER, search: 'miles' })).toBe(false)
  })

  it('names the flags', () => {
    const text = describeFilter({ ...EMPTY_FILTER, unfiledOnly: true, hasLiveSource: true })
    expect(text).toContain('not in a playlist')
    expect(text).toContain('has live take')
  })
})

describe('describeActiveTracklist', () => {
  it('names the list alone when unfiltered', () => {
    expect(
      describeActiveTracklist({
        selection: { kind: 'all' },
        filter: EMPTY_FILTER,
        trackIds: [1, 2],
        title: 'All tracks',
      }),
    ).toBe('Now playing All tracks')
  })

  it('says only "with filters" on the button when some were set', () => {
    expect(
      describeActiveTracklist({
        selection: { kind: 'playlist', playlistId: 3 },
        filter: { ...EMPTY_FILTER, search: 'miles' },
        trackIds: [1],
        title: 'Jazz nights',
      }),
    ).toBe('Now playing Jazz nights with filters')
  })

  it('keeps the full detail for the tooltip', () => {
    expect(
      describeActiveTracklistFull({
        selection: { kind: 'playlist', playlistId: 3 },
        filter: { ...EMPTY_FILTER, search: 'miles' },
        trackIds: [1],
        title: 'Jazz nights',
      }),
    ).toBe('Now playing Jazz nights with “miles”')
  })
})
