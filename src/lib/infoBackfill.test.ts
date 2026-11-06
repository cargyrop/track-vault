import { describe, expect, it, vi } from 'vitest'
import {
  backfillTrack,
  mergeFacts,
  needsBackfill,
  readCheckedLookupKeys,
  runBackfill,
  trackLookupKey,
  unionGenres,
  writeCheckedLookupKeys,
  type BackfillTrack,
} from './infoBackfill'
import { EMPTY_FACTS, type ArtistFacts } from './artistInfo'

function track(overrides: Partial<BackfillTrack> = {}): BackfillTrack {
  return {
    id: 1,
    title: 'Locust',
    artist: 'Machine Head',
    info: null,
    year: null,
    genres: [],
    ...overrides,
  }
}

function facts(overrides: Partial<ArtistFacts> = {}): ArtistFacts {
  return { ...EMPTY_FACTS, ...overrides }
}

describe('needsBackfill', () => {
  it('wants a lookup when any of the three fields is missing', () => {
    expect(needsBackfill(track())).toBe(true)
    expect(needsBackfill(track({ info: 'A bio.' }))).toBe(true)
    expect(needsBackfill(track({ year: 1991 }))).toBe(true)
    expect(needsBackfill(track({ genres: ['grunge'] }))).toBe(true)
  })

  it('leaves a fully described track alone', () => {
    expect(
      needsBackfill(
        track({ info: 'A bio.', year: 1991, genres: ['grunge'] }),
      ),
    ).toBe(false)
  })

  it('treats whitespace-only info as missing', () => {
    expect(needsBackfill(track({ info: '   ' }))).toBe(true)
  })
})

describe('unionGenres', () => {
  it('keeps what the user had and appends what is new', () => {
    expect(unionGenres(['favourite'], ['grunge'])).toEqual(['favourite', 'grunge'])
  })

  it('does not repeat a genre the user already has', () => {
    expect(unionGenres(['Grunge'], ['grunge', 'punk'])).toEqual([
      'Grunge',
      'punk',
    ])
  })

  it('drops blanks and trims', () => {
    expect(unionGenres([' grunge ', ''], ['  ', 'punk'])).toEqual([
      'grunge',
      'punk',
    ])
  })
})

describe('mergeFacts', () => {
  it('fills an empty track completely', () => {
    const patch = mergeFacts(
      track(),
      facts({ info: 'A bio.', releaseYear: 1991, genres: ['grunge'] }),
    )
    expect(patch).toEqual({
      info: 'A bio.',
      year: 1991,
      genres: ['grunge'],
    })
  })

  it('never overwrites info the user wrote', () => {
    const patch = mergeFacts(
      track({ info: 'My own notes about this song.' }),
      facts({ info: 'From Wikipedia.', releaseYear: 1991, genres: ['grunge'] }),
    )
    expect(patch?.info).toBeUndefined()
    // The other fields still fill in.
    expect(patch?.year).toBe(1991)
    expect(patch?.genres).toEqual(['grunge'])
  })

  it('never overwrites a year the user set', () => {
    const patch = mergeFacts(
      track({ year: 1993 }),
      facts({ info: 'A bio.', releaseYear: 2020 }),
    )
    expect(patch?.year).toBeUndefined()
  })

  it('never removes a genre the user filed the track under', () => {
    const patch = mergeFacts(
      track({ genres: ['favourite', 'loud'] }),
      facts({ genres: ['grunge'] }),
    )
    expect(patch?.genres).toEqual(['favourite', 'loud', 'grunge'])
  })

  it('adds no genres key when the fetch brought none it did not have', () => {
    const patch = mergeFacts(
      track({ genres: ['grunge'] }),
      facts({ genres: ['grunge'] }),
    )
    expect(patch?.genres).toBeUndefined()
  })

  it('returns null when there was nothing to add at all', () => {
    expect(mergeFacts(track({ info: 'Mine.', year: 1991, genres: ['grunge'] }), facts())).toBeNull()
  })

  it('leaves a blank-info track alone when the lookup found nothing', () => {
    const patch = mergeFacts(track({ genres: ['grunge'] }), facts())
    expect(patch).toBeNull()
  })
})

describe('backfillTrack', () => {
  it('fills info, genres and the year from the two lookups', async () => {
    const factsFor = vi.fn(async () => facts({ info: 'A bio.', genres: ['grunge'] }))
    const yearFor = vi.fn(async () => 1991)

    const patch = await backfillTrack(track(), { factsFor, yearFor })
    expect(patch).toEqual({ info: 'A bio.', year: 1991, genres: ['grunge'] })
    expect(factsFor).toHaveBeenCalledWith('Machine Head')
    expect(yearFor).toHaveBeenCalledWith('Locust', 'Machine Head')
  })

  it('does not ask for a year the track already has', async () => {
    const yearFor = vi.fn(async () => 1991)
    await backfillTrack(track({ year: 1993 }), {
      factsFor: async () => facts({ info: 'A bio.' }),
      yearFor,
    })
    expect(yearFor).not.toHaveBeenCalled()
  })

  it('survives an artist lookup that fails', async () => {
    const factsFor = vi.fn(async () => {
      throw new Error('MusicBrainz is down')
    })
    await expect(
      backfillTrack(track(), { factsFor, yearFor: async () => null }),
    ).resolves.toBeNull()
  })

  it('keeps the bio when only the year lookup fails', async () => {
    const patch = await backfillTrack(track(), {
      factsFor: async () => facts({ info: 'A bio.' }),
      yearFor: async () => {
        throw new Error('iTunes unreachable')
      },
    })
    expect(patch).toEqual({ info: 'A bio.' })
  })

  it('rejects a nonsense year rather than storing it', async () => {
    const patch = await backfillTrack(track(), {
      factsFor: async () => facts({ info: 'A bio.' }),
      yearFor: async () => 'not a year',
    })
    expect(patch?.year).toBeUndefined()
  })
})
describe('runBackfill', () => {
  const noLookups = {
    factsFor: async () => facts({ info: 'A bio.', genres: ['grunge'] }),
    yearFor: async () => 1991,
  }

  function manyTracks(count: number): BackfillTrack[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      title: `Track ${i + 1}`,
      artist: `Band ${i + 1}`,
      info: null,
      year: null,
      genres: [],
    }))
  }

  it('fills every track it is given', async () => {
    const onApply = vi.fn(async () => {})
    const result = await runBackfill({
      tracks: manyTracks(3),
      onApply,
      ...noLookups,
    })
    expect(onApply).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ total: 3, filled: 3, cancelled: false })
  })

  it('skips tracks that already have everything', async () => {
    const onApply = vi.fn(async () => {})
    const result = await runBackfill({
      tracks: [
        track({ info: 'Mine.', year: 1991, genres: ['grunge'] }),
        track({ id: 2 }),
      ],
      onApply,
      ...noLookups,
    })
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ total: 1, filled: 1, skipped: 0 })
  })

  it('does nothing at all when there is nothing to do', async () => {
    const onApply = vi.fn(async () => {})
    const result = await runBackfill({
      tracks: [track({ info: 'Mine.', year: 1991, genres: ['grunge'] })],
      onApply,
      ...noLookups,
    })
    expect(onApply).not.toHaveBeenCalled()
    expect(result.total).toBe(0)
  })

  it('stops early when cancelled, keeping what it already wrote', async () => {
    const onApply = vi.fn(async () => {})
    let visited = 0
    const result = await runBackfill({
      tracks: manyTracks(5),
      onApply,
      ...noLookups,
      // Cancel once two tracks have been written.
      shouldStop: () => visited >= 2,
      factsFor: async () => {
        visited++
        return facts({ info: 'A bio.' })
      },
    })
    expect(onApply).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ total: 5, filled: 2, cancelled: true })
  })

  it('stops before doing anything if cancelled up front', async () => {
    const onApply = vi.fn(async () => {})
    const result = await runBackfill({
      tracks: manyTracks(4),
      onApply,
      ...noLookups,
      shouldStop: () => true,
    })
    expect(onApply).not.toHaveBeenCalled()
    expect(result).toMatchObject({ filled: 0, cancelled: true })
  })

  it('reports progress as it goes, ending on the total', async () => {
    const seen: Array<[number, number]> = []
    await runBackfill({
      tracks: manyTracks(3),
      onApply: async () => {},
      ...noLookups,
      onProgress: (done, total) => seen.push([done, total]),
    })
    expect(seen[0]).toEqual([0, 3])
    expect(seen.at(-1)).toEqual([3, 3])
  })

  it('carries on past an artist whose lookup throws', async () => {
    const onApply = vi.fn(async () => {})
    const result = await runBackfill({
      tracks: [
        { ...track({ id: 1, artist: 'Broken' }) },
        { ...track({ id: 2, artist: 'Fine' }) },
        { ...track({ id: 3, artist: 'Also Fine' }) },
      ],
      onApply,
      yearFor: async () => 1991,
      factsFor: async (artist) => {
        if (artist === 'Broken') throw new Error('rate limited')
        return facts({ info: 'A bio.' })
      },
    })
    expect(onApply).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ filled: 2, skipped: 1, cancelled: false })
  })

  it('visits tracks in order, never two at once', async () => {
    let active = 0
    let maxActive = 0
    await runBackfill({
      tracks: manyTracks(4),
      onApply: async () => {},
      ...noLookups,
      factsFor: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 1))
        active--
        return facts({ info: 'A bio.' })
      },
    })
    // MusicBrainz allows one request a second; overlapping would earn a 503.
    expect(maxActive).toBe(1)
  })
})

describe('checked lookup persistence', () => {
  it('computes a stable key preferring the primary YouTube ID', () => {
    expect(
      trackLookupKey({
        id: 42,
        artist: 'Machine Head',
        title: 'Locust',
        sources: [{ youtubeId: 'dQw4w9WgXcQ' }],
      }),
    ).toBe('yt:dQw4w9WgXcQ')
    expect(
      trackLookupKey({
        id: 42,
        artist: 'Machine Head',
        title: 'Locust',
        sources: [],
      }),
    ).toBe('meta:machine head::locust')
  })

  it('persists and restores checked lookup keys in localStorage', () => {
    const store = new Map<string, string>()
    const fakeWindow = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value)
        },
      },
    }
    vi.stubGlobal('window', fakeWindow)
    try {
      const keys = new Set(['yt:abc12345678', 'meta:band::song'])
      writeCheckedLookupKeys(keys)
      expect([...readCheckedLookupKeys()]).toEqual([
        'yt:abc12345678',
        'meta:band::song',
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

