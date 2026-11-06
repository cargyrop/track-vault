import { describe, expect, it } from 'vitest'
import {
  canLookUpLyrics,
  clearLyricsCache,
  lyricsCacheKey,
  lyricsLookupUrl,
  pickLyrics,
  stripLrcLine,
} from './lyrics'

describe('lyricsLookupUrl', () => {
  it('asks the service by artist and title', () => {
    const url = new URL(lyricsLookupUrl({ artist: 'Venom', title: 'In League With Satan' }))
    expect(url.origin + url.pathname).toBe('https://lrclib.net/api/get')
    expect(url.searchParams.get('artist_name')).toBe('Venom')
    expect(url.searchParams.get('track_name')).toBe('In League With Satan')
  })

  it('escapes names that need it and trims stray whitespace', () => {
    const url = new URL(
      lyricsLookupUrl({ artist: '  Blue Öyster Cult  ', title: 'Godzilla & Friends' }),
    )
    expect(url.searchParams.get('artist_name')).toBe('Blue Öyster Cult')
    expect(url.searchParams.get('track_name')).toBe('Godzilla & Friends')
  })

  it('caps an absurd field so the request stays a request', () => {
    const url = new URL(lyricsLookupUrl({ artist: 'A'.repeat(400), title: 'B'.repeat(400) }))
    expect(url.searchParams.get('artist_name')).toHaveLength(120)
    expect(url.searchParams.get('track_name')).toHaveLength(120)
  })

  it('leaves out a missing artist rather than sending an empty one', () => {
    const url = new URL(lyricsLookupUrl({ artist: '   ', title: 'Untitled' }))
    expect(url.searchParams.has('artist_name')).toBe(false)
    expect(url.searchParams.get('track_name')).toBe('Untitled')
  })
})

describe('canLookUpLyrics', () => {
  it('needs both a title and an artist', () => {
    expect(canLookUpLyrics({ title: 'Locust', artist: 'Machine Head' })).toBe(true)
    expect(canLookUpLyrics({ title: 'Locust', artist: '' })).toBe(false)
    expect(canLookUpLyrics({ title: '', artist: 'Machine Head' })).toBe(false)
  })
})

describe('stripLrcLine', () => {
  it('removes a leading timestamp', () => {
    expect(stripLrcLine('[00:12.34] words in the night')).toBe('words in the night')
    expect(stripLrcLine('[01:02] short')).toBe('short')
  })

  it('removes several tags in a row', () => {
    expect(stripLrcLine('[ar:Someone][al:An album][00:01.00] first line')).toBe('first line')
  })

  it('drops a metadata tag on its own', () => {
    expect(stripLrcLine('[ar:Someone]')).toBe('')
    expect(stripLrcLine('[ti:Title]')).toBe('')
  })

  it('leaves a line that only looks tagged alone', () => {
    expect(stripLrcLine('[not a tag] words')).toBe('[not a tag] words')
    expect(stripLrcLine('plain words')).toBe('plain words')
  })
})

describe('pickLyrics', () => {
  it('prefers plain lyrics', () => {
    expect(pickLyrics({ plainLyrics: 'one\ntwo', syncedLyrics: '[00:01] one' })).toBe('one\ntwo')
  })

  it('falls back to synced lyrics, timestamps removed', () => {
    expect(
      pickLyrics({ plainLyrics: '', syncedLyrics: '[00:01.00] first\n[00:05.00] second' }),
    ).toBe('first\nsecond')
  })

  it('drops metadata tags from synced lyrics', () => {
    expect(pickLyrics({ syncedLyrics: '[ar:Nobody]\n[00:01.00] actual lyric' })).toBe(
      'actual lyric',
    )
  })

  it('reports nothing rather than an empty string', () => {
    expect(pickLyrics(null)).toBeNull()
    expect(pickLyrics({})).toBeNull()
    expect(pickLyrics({ plainLyrics: '   ' })).toBeNull()
    expect(pickLyrics({ syncedLyrics: '[ar:Nobody]\n[00:00.00]' })).toBeNull()
  })
})

describe('lyricsCacheKey', () => {
  it('ignores case and surrounding space so lookups are reused', () => {
    expect(lyricsCacheKey({ title: ' Locust ', artist: 'Machine Head' })).toBe(
      lyricsCacheKey({ title: 'locust', artist: 'machine head' }),
    )
  })

  it('separates different recordings', () => {
    expect(lyricsCacheKey({ title: 'Locust', artist: 'Machine Head' })).not.toBe(
      lyricsCacheKey({ title: 'Locust', artist: 'Decapitated' }),
    )
  })
})

describe('clearLyricsCache', () => {
  it('is callable without a lookup having happened', () => {
    expect(() => clearLyricsCache()).not.toThrow()
  })
})
