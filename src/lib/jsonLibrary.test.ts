import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHttpTransport,
  createMemoryTransport,
  JsonLibrary,
  normalise,
} from './jsonLibrary'
import { EMPTY_FILTER, type LibraryFilter, type NewTrack } from './types'

async function newLibrary(initial = ''): Promise<{
  lib: JsonLibrary
  transport: ReturnType<typeof createMemoryTransport>
}> {
  const transport = createMemoryTransport(initial)
  const lib = new JsonLibrary(transport)
  await lib.migrate()
  return { lib, transport }
}

function track(overrides: Partial<NewTrack> = {}): NewTrack {
  return {
    title: 'Paranoid Android',
    artist: 'Radiohead',
    genres: ['prog rock'],
    sources: [
      {
        youtubeId: 'f7nonexistent1',
        url: 'https://www.youtube.com/watch?v=f7nonexistent1',
        kind: 'official',
      },
    ],
    ...overrides,
  }
}

function filter(overrides: Partial<LibraryFilter> = {}): LibraryFilter {
  return { ...EMPTY_FILTER, ...overrides }
}

describe('JsonLibrary', () => {
  let lib: JsonLibrary
  let transport: ReturnType<typeof createMemoryTransport>

  beforeEach(async () => {
    const made = await newLibrary()
    lib = made.lib
    transport = made.transport
  })

  it('writes the library to the transport on every change', async () => {
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    const saved = JSON.parse(transport.current())
    expect(saved.format).toBe('trackvault-library')
    expect(saved.tracks).toHaveLength(1)
    expect(saved.tracks[0].title).toBe('Paranoid Android')
    expect(saved.tracks[0].sources[0].youtubeId).toBe('f7nonexistent1')
  })

  it('reads an existing document instead of starting empty', async () => {
    const seed = JSON.stringify({
      format: 'trackvault-library',
      version: 1,
      tracks: [
        {
          id: 1,
          title: 'Seeded',
          artist: 'Someone',
          album: 'Album',
          genres: ['jazz'],
          sources: [{ id: 1, youtubeId: 'aaaaaaaaaaa', kind: 'official' }],
        },
      ],
      playlists: [],
    })
    const made = await newLibrary(seed)
    const tracks = await made.lib.listTracks(EMPTY_FILTER)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].title).toBe('Seeded')
    expect(tracks[0].sources[0].url).toContain('aaaaaaaaaaa')
  })

  it('validates required fields like the SQL store', async () => {
    await expect(lib.addTrack(track({ title: '  ' }))).rejects.toThrow(/title/i)
    await expect(lib.addTrack(track({ artist: '' }))).rejects.toThrow(/artist/i)
    await expect(lib.addTrack(track({ sources: [] }))).rejects.toThrow(/source/i)
  })

  it('merges by MusicBrainz id instead of duplicating', async () => {
    const first = await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    const second = await lib.addTrack(
      track({
        musicbrainzRecordingId: 'mb-1',
        title: 'Paranoid Android (Remastered)',
        genres: ['psychedelic'],
        sources: [
          {
            youtubeId: 'kJQP7kiw5Fk',
            url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
            kind: 'live',
          },
        ],
      }),
    )
    expect(second).toBe(first)
    const merged = await lib.getTrack(first)
    expect(merged?.sources).toHaveLength(2)
    expect(merged?.sources.map((s) => s.role)).toEqual(['audio', 'video'])
    expect(merged?.genres.sort()).toEqual(['prog rock', 'psychedelic'])
  })

  it('filters by genre, artist, album and source kind together', async () => {
    await lib.addTrack(
      track({ musicbrainzRecordingId: 'mb-1', album: 'OK Computer' }),
    )
    await lib.addTrack(
      track({
        title: 'Karma Police',
        album: 'OK Computer',
        genres: ['alternative'],
        musicbrainzRecordingId: 'mb-2',
        sources: [
          {
            youtubeId: 'kJQP7kiw5Fk',
            url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
            kind: 'live',
          },
        ],
      }),
    )
    await lib.addTrack(
      track({
        title: 'Animals',
        artist: 'Pink Floyd',
        album: 'Animals',
        genres: ['prog rock'],
        musicbrainzRecordingId: 'mb-3',
        sources: [
          {
            youtubeId: '0vFOzaXqZH0',
            url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
            kind: 'official',
          },
        ],
      }),
    )

    expect(await lib.listTracks(filter())).toHaveLength(3)
    expect(
      (await lib.listTracks(filter({ genres: ['prog rock'] }))).map((t) => t.title),
    ).toEqual(['Animals', 'Paranoid Android'])
    expect(
      (await lib.listTracks(filter({ sourceKind: 'live' }))).map((t) => t.title),
    ).toEqual(['Karma Police'])
    // AND across facets.
    expect(
      await lib.listTracks(filter({ genres: ['prog rock'], artist: 'Pink Floyd' })),
    ).toHaveLength(1)
    expect(
      await lib.listTracks(filter({ genres: ['prog rock'], artist: 'Radiohead' })),
    ).toHaveLength(1)
    expect(await lib.listTracks(filter({ search: 'nothing' }))).toHaveLength(0)
    expect(
      (await lib.listTracks(filter({ search: 'paranoi' }))).map((t) => t.title),
    ).toEqual(['Paranoid Android'])
  })

  it('reports facet counts', async () => {
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-2' }))
    await expect(lib.listGenres()).resolves.toEqual([
      { name: 'prog rock', count: 2 },
    ])
    await expect(lib.listArtists()).resolves.toEqual(['Radiohead'])
  })

  it('keeps playlist order and is case-insensitive about names', async () => {
    const a = await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    const b = await lib.addTrack(
      track({
        title: 'Karma Police',
        musicbrainzRecordingId: 'mb-2',
        sources: [
          {
            youtubeId: 'kJQP7kiw5Fk',
            url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
            kind: 'official',
          },
        ],
      }),
    )
    const pl = await lib.ensurePlaylist('Focus')
    await expect(lib.ensurePlaylist('focus')).resolves.toBe(pl)
    await lib.addToPlaylist(pl, a)
    await lib.addToPlaylist(pl, b)
    await lib.addToPlaylist(pl, a)

    expect((await lib.listPlaylistTracks(pl)).map((e) => e.trackId)).toEqual([a, b])
    await lib.removeFromPlaylist(pl, a)
    expect(await lib.listPlaylistTracks(pl)).toHaveLength(1)
  })

  it('edits the two source slots by role', async () => {
    const id = await lib.addTrack(track())
    await lib.setSource(id, 'video', {
      youtubeId: 'kJQP7kiw5Fk',
      url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
      kind: 'live',
      label: 'Live',
    })
    const filled = (await lib.getTrack(id))!.sources
    expect(filled.map((s) => s.role)).toEqual(['audio', 'video'])
    expect(filled[1].label).toBe('Live')

    // Replacing a slot swaps the video rather than piling up a third.
    await lib.setSource(id, 'video', {
      youtubeId: '0vFOzaXqZH0',
      url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
      kind: 'official',
    })
    expect((await lib.getTrack(id))!.sources.map((s) => s.youtubeId)).toEqual([
      'f7nonexistent1',
      '0vFOzaXqZH0',
    ])

    // Either slot can be emptied while the other still plays.
    await lib.setSource(id, 'video', null)
    expect((await lib.getTrack(id))!.sources).toHaveLength(1)
    await expect(lib.setSource(id, 'audio', null)).rejects.toThrow(
      /Main link or a video clip/i,
    )

    // Add the clip back, and the Main may go: the clip is the playback source.
    await lib.setSource(id, 'video', {
      youtubeId: 'kJQP7kiw5Fk',
      url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
      kind: 'official',
    })
    await lib.setSource(id, 'audio', null)
    expect((await lib.getTrack(id))!.sources.map((s) => s.role)).toEqual(['video'])
  })

  it('clearing an already-empty video slot leaves the audio source alone', async () => {
    // The edit dialog writes both slots on every save, so a track with no clip
    // attached is saved as: set audio, then clear the (empty) video slot. The
    // clear must be a no-op. It used to splice at index -1, which silently
    // removed the *last* source — the audio link the same save had just
    // written, so the edit looked like it had done nothing at all.
    const id = await lib.addTrack(track())
    await lib.setSource(id, 'audio', {
      youtubeId: 'zF2VJVEh6E8',
      url: 'https://www.youtube.com/watch?v=zF2VJVEh6E8',
      kind: 'official',
    })
    await lib.setSource(id, 'video', null)

    const saved = JSON.parse(transport.current())
    expect(saved.tracks[0].sources).toHaveLength(1)
    expect(saved.tracks[0].sources[0].youtubeId).toBe('zF2VJVEh6E8')
    expect(saved.tracks[0].sources[0].role).toBe('audio')
  })

  it('cuts a dead link from any slot, the Main included', async () => {
    const id = await lib.addTrack(track())
    await lib.setSource(id, 'video', {
      youtubeId: '0vFOzaXqZH0',
      url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
      kind: 'official',
    })

    await lib.removeSource(id, 'video')
    expect((await lib.getTrack(id))!.sources.map((s) => s.role)).toEqual(['audio'])

    // Same as the SQL store: a dead Main can be cut, and the file keeps only
    // the slots that are left.
    await lib.removeSource(id, 'audio')
    expect((await lib.getTrack(id))!.sources).toEqual([])
    expect(JSON.parse(transport.current()).tracks[0].sources).toEqual([])

    await lib.removeSource(id, 'audio')
    expect((await lib.getTrack(id))!.sources).toEqual([])
  })

  it('refuses to put the same video in both slots', async () => {
    const id = await lib.addTrack(track())
    await expect(
      lib.setSource(id, 'video', {
        youtubeId: 'f7nonexistent1',
        url: 'https://www.youtube.com/watch?v=f7nonexistent1',
        kind: 'live',
      }),
    ).rejects.toThrow(/already attached/i)
  })

  it('keeps the audio slot first in the saved file', async () => {
    const id = await lib.addTrack(track())
    await lib.setSource(id, 'video', {
      youtubeId: '0vFOzaXqZH0',
      url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
      kind: 'video',
    })
    const saved = JSON.parse(transport.current())
    expect(saved.tracks[0].sources.map((s: { role: string }) => s.role)).toEqual([
      'audio',
      'video',
    ])
    // Reloading keeps the roles rather than re-deriving them.
    const reread = await newLibrary(transport.current())
    expect(
      (await reread.lib.getTrack(id))!.sources.map((s) => s.role),
    ).toEqual(['audio', 'video'])
  })

  it('will not let two tracks claim one MusicBrainz recording', async () => {
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    const other = await lib.addTrack(
      track({
        title: 'Different',
        musicbrainzRecordingId: 'mb-2',
        sources: [
          {
            youtubeId: '0vFOzaXqZH0',
            url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
            kind: 'official',
          },
        ],
      }),
    )
    await expect(lib.setMusicBrainzId(other, 'mb-1')).rejects.toThrow(/already uses/i)
    expect((await lib.getTrack(1))?.musicbrainzRecordingId).toBe('mb-1')
  })

  it('updates fields and replaces genres', async () => {
    const id = await lib.addTrack(track())
    await lib.updateTrack(id, { title: 'Renamed', genres: ['art rock'] })
    const saved = await lib.getTrack(id)
    expect(saved?.title).toBe('Renamed')
    expect(saved?.genres).toEqual(['art rock'])
  })

  it('removes a track from playlists when it is deleted', async () => {
    const id = await lib.addTrack(track())
    const pl = await lib.createPlaylist('Temp')
    await lib.addToPlaylist(pl, id)
    await lib.deleteTrack(id)
    expect(await lib.getTrack(id)).toBeNull()
    expect(await lib.listPlaylistTracks(pl)).toHaveLength(0)
  })

  it('round-trips through export and import without duplicating', async () => {
    await lib.addTrack(
      track({ musicbrainzRecordingId: 'mb-1', album: 'OK Computer' }),
    )
    const json = await lib.exportJson()

    const fresh = await newLibrary()
    await fresh.lib.importJson(json)
    expect(await fresh.lib.listTracks(EMPTY_FILTER)).toHaveLength(1)
    await fresh.lib.importJson(json)
    expect(await fresh.lib.listTracks(EMPTY_FILTER)).toHaveLength(1)
  })

  it('picks up external edits when reloaded', async () => {
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    expect(await lib.listTracks(EMPTY_FILTER)).toHaveLength(1)

    // Simulate an agent editing the file on disk.
    const doc = JSON.parse(transport.current())
    doc.tracks[0].genres = ['prog rock', 'psychedelic']
    doc.tracks[0].coverUrl = 'https://example.com/cover.jpg'
    await transport.save(JSON.stringify(doc))

    // Without reload the in-memory copy is unchanged.
    expect((await lib.getTrack(1))?.genres).toEqual(['prog rock'])

    await lib.reload()
    expect((await lib.getTrack(1))?.genres).toEqual([
      'prog rock',
      'psychedelic',
    ])
    expect((await lib.getTrack(1))?.coverUrl).toBe('https://example.com/cover.jpg')
  })
})

describe('normalise', () => {
  it('repairs a hand-written or agent-written document', () => {
    const doc = normalise(
      JSON.stringify({
        tracks: [
          // Missing album, year, genres, sources url and kind.
          { title: 'Only A Title', artist: 'Someone', sources: [{ youtubeId: 'bbbbbbbbbbb' }] },
        ],
        playlists: [{ name: 'Mix' }],
      }),
    )
    expect(doc.tracks[0].album).toBeNull()
    expect(doc.tracks[0].year).toBeNull()
    expect(doc.tracks[0].genres).toEqual([])
    expect(doc.tracks[0].sources[0].kind).toBe('official')
    expect(doc.tracks[0].sources[0].url).toBe(
      'https://www.youtube.com/watch?v=bbbbbbbbbbb',
    )
    expect(doc.playlists[0].tracks).toEqual([])
  })

  it('survives malformed JSON without throwing', () => {
    expect(normalise('{not json').tracks).toEqual([])
    expect(normalise('').tracks).toEqual([])
    expect(normalise('null').tracks).toEqual([])
  })

  it('ignores non-array tracks and playlists', () => {
    const doc = normalise(JSON.stringify({ tracks: 'oops', playlists: 42 }))
    expect(doc.tracks).toEqual([])
    expect(doc.playlists).toEqual([])
  })

  it('deduplicates genres case-insensitively', () => {
    const doc = normalise(
      JSON.stringify({
        tracks: [
          {
            title: 'T',
            artist: 'A',
            genres: ['Rock', 'rock', 'ROCK', 'Pop'],
            sources: [{ youtubeId: 'ccccccccccc' }],
          },
        ],
      }),
    )
    expect(doc.tracks[0].genres).toEqual(['Rock', 'Pop'])
  })

  it('derives source roles from list order for older files', () => {
    const doc = normalise(
      JSON.stringify({
        tracks: [
          {
            title: 'T',
            artist: 'A',
            sources: [
              { youtubeId: 'aaaaaaaaaaa' },
              { youtubeId: 'bbbbbbbbbbb' },
            ],
          },
        ],
      }),
    )
    expect(doc.tracks[0].sources.map((s) => s.role)).toEqual(['audio', 'video'])
  })

  it('respects an explicit role and never fills a slot twice', () => {
    const doc = normalise(
      JSON.stringify({
        tracks: [
          {
            title: 'T',
            artist: 'A',
            sources: [
              { youtubeId: 'aaaaaaaaaaa', role: 'audio' },
              { youtubeId: 'bbbbbbbbbbb', role: 'audio' },
            ],
          },
        ],
      }),
    )
    expect(doc.tracks[0].sources.map((s) => s.role)).toEqual(['audio', 'video'])
  })

  it('keeps only the three slots and drops unusable links', () => {
    const doc = normalise(
      JSON.stringify({
        tracks: [
          {
            title: 'T',
            artist: 'A',
            sources: [
              { youtubeId: 'aaaaaaaaaaa' },
              { youtubeId: 'bbbbbbbbbbb' },
              { youtubeId: 'ccccccccccc' },
              { youtubeId: 'ddddddddddd' },
              { youtubeId: '   ' },
            ],
          },
        ],
      }),
    )
    expect(doc.tracks[0].sources.map((s) => s.youtubeId)).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'ccccccccccc',
    ])
    expect(doc.tracks[0].sources.map((s) => s.role)).toEqual([
      'audio',
      'video',
      'live',
    ])
  })

  it('recovers a video id written as a bare URL', () => {
    const doc = normalise(
      JSON.stringify({
        tracks: [
          {
            title: 'T',
            artist: 'A',
            sources: [{ url: 'https://youtu.be/dQw4w9WgXcQ?t=42' }],
          },
        ],
      }),
    )
    expect(doc.tracks[0].sources[0].youtubeId).toBe('dQw4w9WgXcQ')
    expect(doc.tracks[0].sources[0].role).toBe('audio')
  })
})

describe('createHttpTransport', () => {
  // Port 1 is never served locally, so every fetch to it is a connection
  // refusal — exactly what the browser reports when the preview server dies.
  const dead = 'http://127.0.0.1:1/api/library'

  it('explains a refused connection instead of saying "Failed to fetch"', async () => {
    const transport = createHttpTransport(dead)
    await expect(transport.load()).rejects.toThrow(/server is not responding/)
    await expect(transport.save('{}')).rejects.toThrow(/server is not responding/)
    await expect(transport.save('{}')).rejects.toThrow(/vite preview/)
  })

  it('lets real HTTP errors through with their status', async () => {
    const transport = createHttpTransport('/api/library')
    const res = { ok: false, status: 500, text: async () => '' } as Response
    vi.stubGlobal('fetch', async () => res)
    await expect(transport.load()).rejects.toThrow('Could not read the library (500).')
    await expect(transport.save('{}')).rejects.toThrow(
      'Could not save the library (500).',
    )
    vi.unstubAllGlobals()
  })
})
