import { describe, expect, it, vi, afterEach } from 'vitest'
import { Library, SCHEMA_VERSION, normaliseDuration } from './db'
import { createMemoryDriver } from './drivers'
import { lookupMusicBrainzRecording } from './metadata'
import { normalisePlayerDuration } from './youtubeDuration'
import { createMemoryTransport, JsonLibrary } from './jsonLibrary'
import type { NewTrack } from './types'

/**
 * Coverage for the two fields the library used to leave permanently blank.
 *
 * The duration column and its normalisation rules are tested at the store level
 * rather than through the UI, because both stores have to agree: a duration
 * written through the SQL library and one written through the JSON file have to
 * mean the same thing, or a track changes length depending on which backend
 * happened to be running.
 */

async function newLibrary(): Promise<Library> {
  const library = new Library(await createMemoryDriver())
  await library.migrate()
  return library
}

async function newJsonLibrary(initial = ''): Promise<JsonLibrary> {
  const lib = new JsonLibrary(createMemoryTransport(initial))
  await lib.migrate()
  return lib
}

function track(overrides: Partial<NewTrack> = {}): NewTrack {
  return {
    title: 'Locust',
    artist: 'Machine Head',
    genres: [],
    sources: [
      {
        youtubeId: 'jxjeqCd6Zm0',
        url: 'https://www.youtube.com/watch?v=jxjeqCd6Zm0',
        kind: 'official',
      },
    ],
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normaliseDuration', () => {
  it('rounds to whole seconds', () => {
    expect(normaliseDuration(459.4)).toBe(459)
    expect(normaliseDuration(459.5)).toBe(460)
  })

  it('treats anything unmeasurable as unknown rather than zero', () => {
    // The player reports 0 before a stream is ready. Storing that would show a
    // length of 0:00 and destroy a length that was already known.
    expect(normaliseDuration(0)).toBeNull()
    expect(normaliseDuration(-12)).toBeNull()
    expect(normaliseDuration(NaN)).toBeNull()
    expect(normaliseDuration(Infinity)).toBeNull()
    expect(normaliseDuration(null)).toBeNull()
    expect(normaliseDuration(undefined)).toBeNull()
  })
})

describe('duration storage (SQL)', () => {
  it('is null on a track that was never given a duration', async () => {
    const lib = await newLibrary()
    const id = await lib.addTrack(track())
    const row = await lib.getTrack(id)
    expect(row?.duration).toBeNull()
  })

  it('keeps a duration supplied at add time', async () => {
    const lib = await newLibrary()
    const id = await lib.addTrack(track({ duration: 459 }))
    expect((await lib.getTrack(id))?.duration).toBe(459)
  })

  it('writes a duration measured after the fact', async () => {
    const lib = await newLibrary()
    const id = await lib.addTrack(track())
    await lib.setDuration(id, 461.8)
    expect((await lib.getTrack(id))?.duration).toBe(462)
  })

  it('ignores a measurement that is not a real length', async () => {
    const lib = await newLibrary()
    const id = await lib.addTrack(track())
    await lib.setDuration(id, 0)
    await lib.setDuration(id, NaN)
    await lib.setDuration(id, null)
    expect((await lib.getTrack(id))?.duration).toBeNull()
  })

  it('keeps a known duration when the player reports zero', async () => {
    const lib = await newLibrary()
    const id = await lib.addTrack(track({ duration: 459 }))
    await lib.setDuration(id, 0)
    expect((await lib.getTrack(id))?.duration).toBe(459)
  })

  it('surfaces duration in listTracks, which is what the rail renders', async () => {
    const lib = await newLibrary()
    await lib.addTrack(track({ duration: 459 }))
    await lib.addTrack(track({ title: 'Burn In Hell', artist: 'Dimmu Borgir' }))
    const all = await lib.listTracks({
      search: '',
      genres: [],
      artist: null,
      album: null,
      sourceKind: null,
      unfiledOnly: false,
      hasLiveSource: false,
    })
    // Compared as a set, not sorted: `Array.sort` coerces null to the string "null",
    // which sorts after "459" and makes the order look meaningful when it is not.
    expect(new Set(all.map((t) => t.duration))).toEqual(new Set([null, 459]))
  })

  it('exports duration so a handed-over library keeps it', async () => {
    const lib = await newLibrary()
    await lib.addTrack(track({ duration: 459 }))
    const json = await lib.exportJson()
    expect(JSON.parse(json).tracks[0].duration).toBe(459)
  })
})

describe('duration storage (JSON)', () => {
  it('round-trips a duration through the file', async () => {
    const lib = await newJsonLibrary()
    const id = await lib.addTrack(track({ duration: 459 }))
    expect((await lib.getTrack(id))?.duration).toBe(459)
    const exported = await lib.exportJson()
    expect(JSON.parse(exported).tracks[0].duration).toBe(459)
  })

  it('reads a library written before the field existed', async () => {
    const legacy = JSON.stringify({
      format: 'trackvault-library',
      version: 1,
      tracks: [
        {
          id: 1,
          title: 'Locust',
          artist: 'Machine Head',
          album: null,
          coverUrl: null,
          year: null,
          musicbrainzRecordingId: null,
          notes: null,
          createdAt: '2026-10-02T09:56:31.948Z',
          genres: [],
          sources: [
            {
              id: 1,
              youtubeId: 'jxjeqCd6Zm0',
              url: 'https://www.youtube.com/watch?v=jxjeqCd6Zm0',
              kind: 'official',
              label: null,
              role: 'audio',
            },
          ],
        },
      ],
      playlists: [],
    })
    const lib = await newJsonLibrary(legacy)
    const rows = await lib.listTracks({
      search: '',
      genres: [],
      artist: null,
      album: null,
      sourceKind: null,
      unfiledOnly: false,
      hasLiveSource: false,
    })
    // The whole point of a new optional field: an old file loads, it does not
    // come back as undefined leaking into the UI.
    expect(rows[0].duration).toBeNull()
  })

  it('ignores a zero measurement rather than overwriting a known length', async () => {
    const lib = await newJsonLibrary()
    const id = await lib.addTrack(track({ duration: 459 }))
    await lib.setDuration(id, 0)
    expect((await lib.getTrack(id))?.duration).toBe(459)
  })
})

describe('lookupMusicBrainzRecording', () => {
  const MBID = 'f3c8877a-fbd8-424a-bf7f-eeeb3de0a4fd'

  it('reads genres and length from the lookup endpoint', async () => {
    // The regression this guards: the search endpoint answers `genres: []` even
    // for tagged recordings, so a match applied from search silently carries no
    // genres at all. The lookup endpoint is what makes the field arrive.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: MBID,
            title: 'Locust',
            length: 459000,
            'artist-credit': [{ name: 'Machine Head' }],
            genres: [
              { name: 'groove metal', count: 3 },
              { name: 'thrash metal', count: 1 },
              { name: 'ignored', count: 0 },
            ],
            releases: [],
          }),
          { status: 200 },
        ),
      ),
    )

    const match = await lookupMusicBrainzRecording(MBID)
    expect(match?.genres).toEqual(['Groove Metal', 'Thrash Metal'])
    expect(match?.duration).toBe(459)
  })

  it('returns null for a malformed id without touching the network', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await lookupMusicBrainzRecording('not-a-uuid')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns null for a recording that no longer exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    expect(await lookupMusicBrainzRecording(MBID)).toBeNull()
  })

  it('reports a missing length as unknown rather than zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: MBID, title: 'Locust', releases: [] }), {
            status: 200,
          }),
      ),
    )
    const match = await lookupMusicBrainzRecording(MBID)
    expect(match?.duration).toBeNull()
  })
})

describe('normalisePlayerDuration', () => {
  it('rounds a real player reading to whole seconds', () => {
    expect(normalisePlayerDuration(459.6)).toBe(460)
    expect(normalisePlayerDuration(212)).toBe(212)
  })

  it('treats the pre-load zero as unknown rather than a length', () => {
    // The player reports 0 until metadata arrives. Storing that would write a
    // 0:00 duration over a length that was already known.
    expect(normalisePlayerDuration(0)).toBeNull()
    expect(normalisePlayerDuration(-4)).toBeNull()
    expect(normalisePlayerDuration(NaN)).toBeNull()
    expect(normalisePlayerDuration(undefined)).toBeNull()
    expect(normalisePlayerDuration('nonsense')).toBeNull()
    expect(normalisePlayerDuration(Infinity)).toBeNull()
  })

  it('accepts a numeric string, which some player builds return', () => {
    expect(normalisePlayerDuration('459')).toBe(459)
  })
})

describe('schema version', () => {
  it('has advanced past the migration that introduced role', () => {
    // Bumped to 7 by the migration that stores lyrics provenance.
    expect(SCHEMA_VERSION).toBe(8)
  })
})
