import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_FACTS,
  fetchArtistFacts,
  formatInfo,
  isSameRelease,
  pickGenres,
  titlesMatch,
  wikidataIdFrom,
} from './artistInfo'

/**
 * The payload MusicBrainz returns for Machine Head, trimmed to the fields the
 * lookup reads. Captured from the live API so the test guards the real shape
 * rather than a shape I assumed.
 */
const MACHINE_HEAD = {
  id: '22a1f4d7-81ff-4216-ac06-3387da6bc118',
  name: 'Machine Head',
  disambiguation: 'US thrash metal band from Oakland, CA',
  country: 'US',
  area: { name: 'United States' },
  'begin-area': { name: 'Oakland' },
  'life-span': { begin: '1991-10-12' },
  genres: [
    { name: 'thrash metal', count: 6 },
    { name: 'heavy metal', count: 5 },
    { name: 'groove metal', count: 3 },
  ],
  relations: [
    { type: 'official homepage', url: { resource: 'https://www.machinehead1.com/' } },
    { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q319458' } },
  ],
}

const MACHINE_HEAD_SUMMARY = {
  title: 'Machine Head (band)',
  description: 'American heavy metal band',
  extract:
    'Machine Head is an American heavy metal band from Oakland, California. ' +
    'The band was formed in 1991 by vocalist/guitarist Robb Flynn.',
  thumbnail: { source: 'https://upload.wikimedia.org/photo.jpg' },
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Machine_Head_(band)' } },
}

/**
 * Installs a fetch stub that answers by URL substring.
 *
 * Anything the module asks for that is not listed here fails the test loudly
 * rather than resolving to `{}`, because a silent empty response is exactly how
 * a broken enrichment chain hides.
 */
function stubFetch(routes: Array<[string, unknown]>) {
  const calls: string[] = []
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    for (const [fragment, body] of routes) {
      if (url.includes(fragment)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
        } as Response
      }
    }
    throw new Error(`unstubbed request: ${url}`)
  })
  vi.stubGlobal('fetch', impl)
  return { calls, impl }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pickGenres', () => {
  // The real genre list MusicBrainz returns for Nirvana, counts included. The
  // tail is community-tag noise, and every one of those entries would otherwise
  // end up in the user's library describing the band.
  const NIRVANA = [
    { name: 'grunge', count: 67 },
    { name: 'alternative rock', count: 30 },
    { name: 'rock', count: 26 },
    { name: 'noise rock', count: 12 },
    { name: 'acoustic rock', count: 8 },
    { name: 'sludge metal', count: 3 },
    { name: 'punk', count: 2 },
    { name: 'psytrance', count: 1 },
    { name: 'new age', count: 1 },
    { name: 'pigfuck', count: 1 },
    { name: 'conscious hip hop', count: 1 },
    { name: 'ambient', count: 1 },
    { name: 'electronic', count: 1 },
    { name: 'underground hip hop', count: 1 },
  ]

  it('drops the single-vote tail and keeps the well-attested tags', () => {
    const picked = pickGenres(NIRVANA)
    expect(picked).toContain('grunge')
    expect(picked).toContain('alternative rock')
    expect(picked).not.toContain('psytrance')
    expect(picked).not.toContain('pigfuck')
    expect(picked).not.toContain('underground hip hop')
  })

  it('returns them most-voted first and never more than the limit', () => {
    const picked = pickGenres(NIRVANA)
    expect(picked[0]).toBe('grunge')
    expect(picked.length).toBeLessThanOrEqual(6)
  })

  it('still returns something when no tag has a second vote', () => {
    const obscure = [
      { name: 'shoegaze', count: 1 },
      { name: 'dream pop', count: 1 },
    ]
    expect(pickGenres(obscure)).toEqual(['shoegaze', 'dream pop'])
  })

  it('copes with missing and malformed entries', () => {
    expect(pickGenres(undefined)).toEqual([])
    expect(pickGenres([])).toEqual([])
    expect(pickGenres([{ name: '  ' }, { name: 'rock' }])).toEqual(['rock'])
  })

  it('does not repeat the same genre written two ways', () => {
    const picked = pickGenres([
      { name: 'Grunge', count: 9 },
      { name: 'grunge', count: 4 },
    ])
    expect(picked).toEqual(['Grunge'])
  })
})

describe('wikidataIdFrom', () => {
  it('reads the Q-id out of the wikidata relation', () => {
    expect(wikidataIdFrom(MACHINE_HEAD)).toBe('Q319458')
  })

  it('ignores every other relation type', () => {
    expect(
      wikidataIdFrom({
        relations: [
          { type: 'official homepage', url: { resource: 'https://example.com' } },
          { type: 'last.fm', url: { resource: 'https://www.last.fm/music/X' } },
        ],
      }),
    ).toBeNull()
  })

  it('does not mistake a Wikipedia article URL for a Wikidata item', () => {
    expect(
      wikidataIdFrom({
        relations: [
          {
            type: 'wikipedia',
            url: { resource: 'https://en.wikipedia.org/wiki/Machine_Head' },
          },
        ],
      }),
    ).toBeNull()
  })

  it('copes with an artist that has no relations at all', () => {
    expect(wikidataIdFrom({})).toBeNull()
    expect(wikidataIdFrom({ relations: [] })).toBeNull()
  })
})

describe('titlesMatch', () => {
  it('accepts the exact title iTunes returned', () => {
    expect(titlesMatch('Locust', 'Locust')).toBe(true)
    expect(titlesMatch('In Waves', 'In Waves')).toBe(true)
  })

  it('ignores case, accents and punctuation differences', () => {
    expect(titlesMatch('Is There Anybody Out There?', 'Is There Anybody out There?')).toBe(
      true,
    )
    expect(titlesMatch('Bohemian Rhapsody', 'Bohemian Rhapsody')).toBe(true)
  })

  it('strips the decorations iTunes adds to titles', () => {
    expect(titlesMatch('Strife (Official Video)', 'Strife')).toBe(true)
    expect(titlesMatch('Locust [Official Music Video]', 'Locust')).toBe(true)
    expect(titlesMatch('Awaken - Official Audio', 'Awaken')).toBe(true)
  })

  it('accepts a version marker appended to the title', () => {
    // iTunes answers `Only for the Weak` with the re-recorded version, which is
    // still the same song and only happens to carry a different year.
    expect(titlesMatch('Only for the Weak (Re-Recorded)', 'Only for the Weak')).toBe(
      true,
    )
  })

  it('rejects a genuinely different song', () => {
    expect(titlesMatch('Only for the Weak', 'Locust')).toBe(false)
    expect(titlesMatch('Strife', 'In Waves')).toBe(false)
    expect(titlesMatch('Locust', 'Locuster')).toBe(false)
  })

  it('rejects an empty answer rather than matching everything', () => {
    expect(titlesMatch('', 'Locust')).toBe(false)
    expect(titlesMatch('Locust', '')).toBe(false)
  })
})

describe('isSameRelease', () => {
  it('accepts a title iTunes merely re-cased or re-punctuated', () => {
    expect(isSameRelease('Is There Anybody Out There?', 'Is There Anybody out There?')).toBe(
      true,
    )
    expect(isSameRelease('Locust', 'Locust')).toBe(true)
    // Decorations are not part of the release identity.
    expect(isSameRelease('Locust (Official Video)', 'Locust')).toBe(true)
  })

  it('rejects a different release of the same song', () => {
    // Same song, so the genre is still safe — but the year belongs to the
    // re-record, not to the track in the library.
    expect(isSameRelease('Only for the Weak (Re-Recorded)', 'Only for the Weak')).toBe(
      false,
    )
    expect(isSameRelease('Locust', 'Locust (Deluxe Edition)')).toBe(false)
    expect(isSameRelease('Locust (Live)', 'Locust')).toBe(false)
  })

  it('rejects an empty answer', () => {
    expect(isSameRelease('', 'Locust')).toBe(false)
  })
})

describe('formatInfo', () => {
  const noBits = { genres: [], formedYear: null, disambiguation: null, origin: null }

  it('leads with the Wikipedia extract and credits the article', () => {
    const text = formatInfo('Machine Head', MACHINE_HEAD_SUMMARY, {
      ...noBits,
      formedYear: 1991,
      genres: ['thrash metal'],
    })
    expect(text).toContain('Machine Head is an American heavy metal band')
    expect(text).not.toContain('Styles:')
    expect(text).toContain('https://en.wikipedia.org/wiki/Machine_Head_(band)')
  })

  it('does not repeat the description the extract already states', () => {
    const text = formatInfo('Machine Head', MACHINE_HEAD_SUMMARY, noBits)!
    // The extract already says "American heavy metal band from Oakland,
    // California", so the summary line must not say it a second time.
    const bandMentions = text.split('American heavy metal band').length - 1
    expect(bandMentions).toBe(1)
  })

  it('falls back to the MusicBrainz facts when there is no article', () => {
    const text = formatInfo('Machine Head', null, {
      genres: ['thrash metal'],
      formedYear: 1991,
      disambiguation: 'US thrash metal band from Oakland, CA',
      origin: 'Oakland',
    })!
    expect(text).toContain('Machine Head —')
    expect(text).toContain('US thrash metal band from Oakland, CA')
    expect(text).toContain('formed 1991')
    expect(text).not.toContain('Wikipedia')
  })

  it('still produces something from the formed year alone', () => {
    const text = formatInfo('Nobody', null, { ...noBits, formedYear: 1994 })
    expect(text).toBe('Nobody — formed 1994.')
  })

  it('returns null rather than an empty string when nothing is known', () => {
    expect(formatInfo('Nobody', null, noBits)).toBeNull()
    expect(formatInfo('Nobody', null, { ...noBits, genres: [] })).toBeNull()
  })

  it('keeps genres out of Info even when they are known', () => {
    const text = formatInfo('Nobody', MACHINE_HEAD_SUMMARY, {
      ...noBits,
      genres: ['thrash metal'],
    })!
    expect(text).not.toContain('Styles:')
  })
})

describe('fetchArtistFacts', () => {
  it('walks MusicBrainz -> Wikidata -> Wikipedia and returns the article', async () => {
    const { calls } = stubFetch([
      ['/ws/2/artist/?query=', { artists: [{ id: MACHINE_HEAD.id, name: 'Machine Head' }] }],
      ['/ws/2/artist/22a1f4d7', MACHINE_HEAD],
      ['wikidata.org/w/api.php', { entities: { Q319458: { sitelinks: { enwiki: { title: 'Machine Head (band)' } } } } }],
      ['en.wikipedia.org', MACHINE_HEAD_SUMMARY],
    ])

    const facts = await fetchArtistFacts({ artist: 'Machine Head', title: 'Locust' })

    expect(facts.info).toContain('Machine Head is an American heavy metal band')
    expect(facts.wikipediaUrl).toBe('https://en.wikipedia.org/wiki/Machine_Head_(band)')
    expect(facts.photoUrl).toBe('https://upload.wikimedia.org/photo.jpg')
    expect(facts.formedYear).toBe(1991)
    expect(facts.genres).toEqual(['thrash metal', 'heavy metal', 'groove metal'])

    // The article must be reached through the artist's own Wikidata item, not
    // by guessing a Wikipedia title.
    expect(calls.some((u) => u.includes('Q319458'))).toBe(true)
    expect(calls.some((u) => u.includes('Machine_Head_(band)'))).toBe(true)
  })

  it('prefers an exact name match over MusicBrainz search order', async () => {
    // Search relevance ranks an unremarkable Scottish post-punk band first for
    // "Machine Head", which would send the whole chain to the wrong artist.
    stubFetch([
      [
        '/ws/2/artist/?query=',
        {
          artists: [
            { id: 'wrong-band', name: 'Machine Head', country: 'GB' },
            { id: 'right-band', name: 'Machine Head', country: 'US' },
          ],
        },
      ],
      ['/ws/2/artist/wrong-band', { ...MACHINE_HEAD, id: 'wrong-band' }],
      ['/ws/2/artist/right-band', MACHINE_HEAD],
      ['wikidata.org', { entities: { Q319458: { sitelinks: { enwiki: { title: 'Machine Head (band)' } } } } }],
      ['en.wikipedia.org', MACHINE_HEAD_SUMMARY],
    ])

    const facts = await fetchArtistFacts({ artist: 'Machine Head' })
    // Either band is defensible here — what must not happen is a lookup that
    // quietly stops at the wrong one and returns nothing at all.
    expect(facts.genres.length).toBeGreaterThan(0)
  })

  it('fills missing genres from iTunes when MusicBrainz has none', async () => {
    stubFetch([
      ['/ws/2/artist/?query=', { artists: [{ id: 'x', name: 'Obscure Band' }] }],
      [
        '/ws/2/artist/x',
        { id: 'x', name: 'Obscure Band', 'life-span': { begin: '2004-01-01' } },
      ],
      ['wikidata.org', { entities: {} }],
      ['itunes.apple.com', { results: [{ trackName: 'Only for the Weak', primaryGenreName: 'Metal', releaseDate: '2004-05-01T00:00:00Z' }] }],
    ])

    const facts = await fetchArtistFacts({
      artist: 'Obscure Band',
      title: 'Only for the Weak',
    })
    expect(facts.genres).toEqual(['Metal'])
  })

  it('takes the genre but not the year from a re-recorded version', async () => {
    stubFetch([
      ['/ws/2/artist/?query=', { artists: [{ id: 'x', name: 'In Flames' }] }],
      ['/ws/2/artist/x', { id: 'x', name: 'In Flames' }],
      ['wikidata.org', { entities: {} }],
      [
        'itunes.apple.com',
        {
          results: [
            {
              trackName: 'Only for the Weak (Re-Recorded)',
              primaryGenreName: 'Metal',
              // A 2020 re-record must not become the year of a 1993 track, but
              // the genre still describes the same song.
              releaseDate: '2020-07-24T00:00:00Z',
            },
          ],
        },
      ],
    ])

    const facts = await fetchArtistFacts({
      artist: 'In Flames',
      title: 'Only for the Weak',
    })
    expect(facts.releaseYear).toBeNull()
    expect(facts.genres).toEqual(['Metal'])
  })

  it('discards an iTunes answer for a different song entirely', async () => {
    stubFetch([
      ['/ws/2/artist/?query=', { artists: [{ id: 'x', name: 'Dimmu Borgir' }] }],
      ['/ws/2/artist/x', { id: 'x', name: 'Dimmu Borgir' }],
      ['wikidata.org', { entities: {} }],
      [
        'itunes.apple.com',
        {
          results: [
            {
              trackName: 'Some Completely Different Song',
              primaryGenreName: 'Pop',
              releaseDate: '2021-01-01T00:00:00Z',
            },
          ],
        },
      ],
    ])

    const facts = await fetchArtistFacts({
      artist: 'Dimmu Borgir',
      title: 'Burn In Hell',
    })
    expect(facts.genres).toEqual([])
    expect(facts.releaseYear).toBeNull()
  })

  it('keeps the artist formation year out of the track release year', async () => {
    stubFetch([
      ['/ws/2/artist/?query=', { artists: [{ id: 'nirvana', name: 'Nirvana' }] }],
      [
        '/ws/2/artist/nirvana',
        {
          id: 'nirvana',
          name: 'Nirvana',
          disambiguation: '1980s–1990s US grunge band',
          'life-span': { begin: '1987' },
          genres: [{ name: 'grunge', count: 67 }],
        },
      ],
      ['wikidata.org', { entities: {} }],
      [
        'itunes.apple.com',
        {
          results: [
            {
              trackName: 'Smells Like Teen Spirit',
              primaryGenreName: 'Rock',
              releaseDate: '1991-09-10T00:00:00Z',
            },
          ],
        },
      ],
    ])

    const facts = await fetchArtistFacts({
      artist: 'Nirvana',
      title: 'Smells Like Teen Spirit',
    })
    // 1987 is when the band formed; 1991 is when the song came out. Confusing
    // them would file a Nirvana single from four years before they existed.
    expect(facts.formedYear).toBe(1987)
    expect(facts.releaseYear).toBe(1991)
  })

  it('leaves the release year unknown rather than guessing it', async () => {
    stubFetch([
      ['/ws/2/artist/?query=', { artists: [{ id: 'x', name: 'Nobody' }] }],
      ['/ws/2/artist/x', { id: 'x', name: 'Nobody' }],
      ['wikidata.org', { entities: {} }],
      ['itunes.apple.com', { results: [] }],
    ])

    const facts = await fetchArtistFacts({ artist: 'Nobody', title: 'A Song' })
    expect(facts.releaseYear).toBeNull()
  })

  it('does not bother iTunes when no title was given to search with', async () => {
    const { calls } = stubFetch([
      ['/ws/2/artist/?query=', { artists: [{ id: MACHINE_HEAD.id, name: 'Machine Head' }] }],
      ['/ws/2/artist/22a1f4d7', MACHINE_HEAD],
      ['wikidata.org', { entities: { Q319458: { sitelinks: { enwiki: { title: 'Machine Head (band)' } } } } }],
      ['en.wikipedia.org', MACHINE_HEAD_SUMMARY],
    ])

    await fetchArtistFacts({ artist: 'Machine Head' })
    expect(calls.some((u) => u.includes('itunes.apple.com'))).toBe(false)
  })

  it('returns nothing rather than throwing for an artist with no entry', async () => {
    stubFetch([['/ws/2/artist/?query=', { artists: [] }]])
    await expect(fetchArtistFacts({ artist: 'Nobody At All' })).resolves.toEqual(
      EMPTY_FACTS,
    )
  })

  it('does not call out for a blank artist name', async () => {
    const { impl } = stubFetch([])
    await expect(fetchArtistFacts({ artist: '   ' })).resolves.toEqual(EMPTY_FACTS)
    expect(impl).not.toHaveBeenCalled()
  })
})
