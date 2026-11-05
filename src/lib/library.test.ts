import { beforeEach, describe, expect, it } from 'vitest'
import { Library } from './db'
import { createMemoryDriver } from './drivers'
import { buildMusicBrainzQuery, guessFromYouTubeTitle, titleCase } from './metadata'
import { parseYouTubeId } from './youtube'
import {
  embedUrlWithQuality,
  estimateSavings,
  type PlaybackQuality,
} from './youtube'
import { youtubeErrorMessage } from './ytApi'
import { thumbnailUrls, coverCandidates, isPlaceholderThumbnail } from './ytMeta'
import { EMPTY_FILTER, type LibraryFilter, type NewTrack } from './types'

async function newLibrary(): Promise<Library> {
  const library = new Library(await createMemoryDriver())
  await library.migrate()
  return library
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

describe('parseYouTubeId', () => {
  it('accepts every URL shape YouTube hands out', () => {
    const id = 'dQw4w9WgXcQ'
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${id}`)).toBe(id)
    expect(parseYouTubeId(`https://music.youtube.com/watch?v=${id}&list=abc`)).toBe(id)
    expect(parseYouTubeId(`https://youtu.be/${id}?t=42`)).toBe(id)
    expect(parseYouTubeId(`https://www.youtube.com/embed/${id}`)).toBe(id)
    expect(parseYouTubeId(`https://www.youtube.com/shorts/${id}`)).toBe(id)
    expect(parseYouTubeId(`https://www.youtube.com/live/${id}`)).toBe(id)
    expect(parseYouTubeId(id)).toBe(id)
    expect(parseYouTubeId(`  ${id}  `)).toBe(id)
  })

  it('rejects junk rather than guessing', () => {
    expect(parseYouTubeId('')).toBeNull()
    expect(parseYouTubeId('https://vimeo.com/12345')).toBeNull()
    expect(parseYouTubeId('too-short')).toBeNull()
  })
})

describe('guessFromYouTubeTitle', () => {
  it('splits on the channel separator and drops the noise', () => {
    const g = guessFromYouTubeTitle(
      'Radiohead - Paranoid Android (Official Video)',
      'Radiohead',
    )
    expect(g.artist).toBe('Radiohead')
    expect(g.title).toBe('Paranoid Android')
  })

  it('falls back to the channel when there is no separator', () => {
    const g = guessFromYouTubeTitle('Paranoid Android', 'RadioheadVEVO')
    expect(g.artist).toBe('RadioheadVEVO')
    expect(g.title).toBe('Paranoid Android')
  })

  // Real title/channel pairs captured from oEmbed while adding these tracks.
  // Each one previously produced a mangled guess that had to be corrected by
  // hand in the add dialog.
  it('reads a pipe-separated episode title and drops the show name', () => {
    const g = guessFromYouTubeTitle(
      'Metalocalypse: Dethklok | Fansong | Adult Swim',
      'Metalocalypse: Dethklok | Music ',
    )
    expect(g.artist).toBe('Dethklok')
    expect(g.title).toBe('Fansong')
  })

  it('does not treat a title that merely contains a brand word as a suffix', () => {
    const g = guessFromYouTubeTitle('The Beach - Learn to Swim', 'The Beach')
    expect(g.artist).toBe('The Beach')
    expect(g.title).toBe('Learn to Swim')
  })

  it('ignores everything after the // upload-boilerplate tail', () => {
    const g = guessFromYouTubeTitle(
      'ORDEN OGAN - F.E.V.E.R (2014) // Official Music Video // AFM Records',
      'AFM Records',
    )
    expect(g.artist).toBe('ORDEN OGAN')
    expect(g.title).toBe('F.E.V.E.R')
  })

  it('handles a trailing official-video tag without a channel', () => {
    const g = guessFromYouTubeTitle(
      'Amon Amarth - The Pursuit Of Vikings (OFFICIAL VIDEO)',
      'Metal Blade Records',
    )
    expect(g.artist).toBe('Amon Amarth')
    expect(g.title).toBe('The Pursuit Of Vikings')
  })

  it('treats en dashes and repeated dashes as separators', () => {
    const g = guessFromYouTubeTitle('In Flames – Only for the Weak – Official Video', 'In Flames')
    expect(g.artist).toBe('In Flames')
    expect(g.title).toBe('Only for the Weak')
  })

  it('reads the "Song by Artist" shape', () => {
    const g = guessFromYouTubeTitle('Yellow (Official Video) by Coldplay', 'Coldplay')
    expect(g.artist).toBe('Coldplay')
    expect(g.title).toBe('Yellow')
  })

  it('does not mistake the word "by" inside a title for a separator', () => {
    const g = guessFromYouTubeTitle('Stand by Me', 'Ben E. King')
    expect(g.title).toBe('Stand by Me')
    expect(g.artist).toBe('Ben E. King')
  })

  it('keeps real words that merely resemble boilerplate', () => {
    const g = guessFromYouTubeTitle('Lana Del Rey - Video Games', 'Lana Del Rey')
    expect(g.artist).toBe('Lana Del Rey')
    expect(g.title).toBe('Video Games')
  })

  it('strips a boilerplate tail without eating the title before it', () => {
    const g = guessFromYouTubeTitle(
      'Lana Del Rey - Video Games - Official Video',
      'Lana Del Rey',
    )
    expect(g.artist).toBe('Lana Del Rey')
    expect(g.title).toBe('Video Games')
  })

  it('strips boilerplate suffixes from the fallback channel', () => {
    const g = guessFromYouTubeTitle('Hanging Around', 'KSI | Official')
    expect(g.artist).toBe('KSI')
    expect(g.title).toBe('Hanging Around')
  })
})

describe('Library', () => {
  let lib: Library

  beforeEach(async () => {
    lib = await newLibrary()
  })

  it('requires a title, artist and a Main or a clip', async () => {
    await expect(lib.addTrack(track({ title: '  ' }))).rejects.toThrow(/title/i)
    await expect(lib.addTrack(track({ artist: '' }))).rejects.toThrow(/artist/i)
    await expect(lib.addTrack(track({ sources: [] }))).rejects.toThrow(
      /Main link or a video clip/i,
    )
    // A live take is a third slot, not a playback source: on its own it leaves
    // nothing for either main view to play.
    await expect(
      lib.addTrack(
        track({
          sources: [
            { youtubeId: 'kJQP7kiw5Fk', url: 'u', kind: 'live', role: 'live' },
          ],
        }),
      ),
    ).rejects.toThrow(/Main link or a video clip/i)

    // A clip with no Main is a whole track: it plays in both modes.
    const clipOnly = await lib.addTrack(
      track({
        title: 'Clip only',
        sources: [
          { youtubeId: '0vFOzaXqZH0', url: 'u', kind: 'official', role: 'video' },
        ],
      }),
    )
    const stored = (await lib.getTrack(clipOnly))!.sources
    expect(stored.map((s) => s.role)).toEqual(['video'])
  })

  it('stores a track with genres and sources', async () => {
    const id = await lib.addTrack(track({ album: 'OK Computer', year: 1997 }))
    const saved = await lib.getTrack(id)
    expect(saved?.album).toBe('OK Computer')
    expect(saved?.year).toBe(1997)
    expect(saved?.genres).toEqual(['prog rock'])
    expect(saved?.sources).toHaveLength(1)
  })

  it('merges by MusicBrainz id instead of creating a duplicate', async () => {
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
    // Two distinct videos, two genres, one library entry.
    expect(merged?.sources).toHaveLength(2)
    expect(merged?.sources.map((s) => s.role)).toEqual(['audio', 'video'])
    expect(merged?.genres.sort()).toEqual(['prog rock', 'psychedelic'])
  })

  it('never attaches the same video twice to one track', async () => {
    const id = await lib.addTrack(track())
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    expect((await lib.getTrack(id))?.sources).toHaveLength(1)
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
        title: 'Everything In Its Right Place',
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
    ).toEqual(['Everything In Its Right Place', 'Paranoid Android'])
    // Sorted by artist, then album, then title; NULL albums sort first.
    expect(
      (await lib.listTracks(filter({ artist: 'Radiohead' }))).map((t) => t.title),
    ).toEqual(['Karma Police', 'Paranoid Android'])
    expect(
      (await lib.listTracks(filter({ album: 'OK Computer' }))).map((t) => t.title),
    ).toEqual(['Karma Police', 'Paranoid Android'])
    expect(
      (await lib.listTracks(filter({ sourceKind: 'live' }))).map((t) => t.title),
    ).toEqual(['Karma Police'])
    // AND across facets, not OR.
    expect(
      await lib.listTracks(filter({ genres: ['prog rock'], artist: 'Pink Floyd' })),
    ).toHaveLength(1)
    expect(
      await lib.listTracks(filter({ genres: ['prog rock'], artist: 'Radiohead' })),
    ).toHaveLength(1)
    expect(
      (await lib.listTracks(filter({ search: 'paranoi' }))).map((t) => t.title),
    ).toEqual(['Paranoid Android'])
    expect(
      await lib.listTracks(filter({ search: 'nothing here' })),
    ).toHaveLength(0)
  })

  it('reports facet counts for the filter UI', async () => {
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-2' }))
    await expect(lib.listGenres()).resolves.toEqual([{ name: 'prog rock', count: 2 }])
    await expect(lib.listArtists()).resolves.toEqual(['Radiohead'])
  })

  it('round-trips a playlist and preserves order', async () => {
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
    await expect(lib.ensurePlaylist('focus')).resolves.toBe(pl) // case-insensitive
    await lib.addToPlaylist(pl, a)
    await lib.addToPlaylist(pl, b)
    await lib.addToPlaylist(pl, a) // idempotent

    const entries = await lib.listPlaylistTracks(pl)
    expect(entries.map((e) => e.trackId)).toEqual([a, b])
    expect(await lib.listPlaylists()).toEqual([
      expect.objectContaining({ name: 'Focus', trackCount: 2 }),
    ])

    await lib.removeFromPlaylist(pl, a)
    expect(await lib.listPlaylistTracks(pl)).toHaveLength(1)
  })

  it('exports and re-imports without duplicating', async () => {
    const trackId = await lib.addTrack(
      track({ musicbrainzRecordingId: 'mb-1', album: 'OK Computer' }),
    )
    const pl = await lib.createPlaylist('Road Trip')
    await lib.addToPlaylist(pl, trackId)
    const json = await lib.exportJson()
    const parsed = JSON.parse(json)
    expect(parsed.format).toBe('trackvault-library')
    expect(parsed.tracks).toHaveLength(1)
    // The export is the document the app itself stores, so a playlist
    // references the file's own track ids — which `importJson` remaps onto
    // whatever ids the receiving library assigns.
    expect(parsed.playlists[0].tracks).toEqual([trackId])
    expect(parsed.folders).toEqual([])

    const fresh = await newLibrary()
    const result = await fresh.importJson(json)
    expect(result.tracks).toBe(1)
    const restored = await fresh.listTracks(EMPTY_FILTER)
    expect(restored[0].album).toBe('OK Computer')
    expect(restored[0].sources[0].youtubeId).toBe('f7nonexistent1')
    expect((await fresh.listPlaylists())[0].trackCount).toBe(1)

    // Second import must not duplicate, thanks to the MBID unique index.
    await fresh.importJson(json)
    expect(await fresh.listTracks(EMPTY_FILTER)).toHaveLength(1)
  })

  it('edits a saved track and manages extra sources', async () => {
    const id = await lib.addTrack(
      track({ musicbrainzRecordingId: 'mb-1', album: 'OK Computer' }),
    )

    await lib.setSource(id, 'video', {
      youtubeId: 'kJQP7kiw5Fk',
      url: 'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
      kind: 'live',
      label: 'Live',
    })
    const filled = (await lib.getTrack(id))!.sources
    expect(filled).toHaveLength(2)
    expect(filled.map((s) => s.role)).toEqual(['audio', 'video'])

    // The same video cannot fill the other slot as well.
    await expect(
      lib.setSource(id, 'video', {
        youtubeId: filled[0].youtubeId,
        url: 'https://www.youtube.com/watch?v=x',
        kind: 'live',
      }),
    ).rejects.toThrow(/already attached/i)

    // Replacing a slot swaps the video, it does not add a third.
    await lib.setSource(id, 'video', {
      youtubeId: '0vFOzaXqZH0',
      url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
      kind: 'official',
      label: null,
    })
    const replaced = (await lib.getTrack(id))!.sources
    expect(replaced.map((s) => s.youtubeId)).toEqual([
      'f7nonexistent1',
      '0vFOzaXqZH0',
    ])
    expect(replaced.map((s) => s.label)).toEqual([null, null])
  })

  it('keeps exactly one audio source and one video source', async () => {
    const id = await lib.addTrack(track())
    expect((await lib.getTrack(id))!.sources[0].role).toBe('audio')

    // The video slot can be emptied, and refilled.
    await lib.setSource(id, 'video', {
      youtubeId: '0vFOzaXqZH0',
      url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
      kind: 'official',
    })
    await lib.setSource(id, 'video', null)
    expect((await lib.getTrack(id))!.sources).toHaveLength(1)

    // The last playable slot cannot be emptied: a track must stay playable.
    await expect(lib.setSource(id, 'audio', null)).rejects.toThrow(
      /Main link or a video clip/i,
    )
    expect((await lib.getTrack(id))!.sources).toHaveLength(1)

    // With a clip in place the Main may go: the clip carries playback from then
    // on, in both modes.
    await lib.setSource(id, 'video', {
      youtubeId: '0vFOzaXqZH0',
      url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
      kind: 'official',
    })
    await lib.setSource(id, 'audio', null)
    expect((await lib.getTrack(id))!.sources.map((s) => s.role)).toEqual(['video'])
  })

  it('clearing an already-empty video slot leaves the audio source alone', async () => {
    // Same scenario as the JSON store, because the edit dialog writes both
    // slots on every save: a track with no clip is saved as "set audio, then
    // clear the empty video slot". The clear must be a no-op rather than
    // taking the audio row with it.
    const id = await lib.addTrack(track())
    await lib.setSource(id, 'audio', {
      youtubeId: 'zF2VJVEh6E8',
      url: 'https://www.youtube.com/watch?v=zF2VJVEh6E8',
      kind: 'official',
    })
    await lib.setSource(id, 'video', null)

    const sources = (await lib.getTrack(id))!.sources
    expect(sources).toHaveLength(1)
    expect(sources[0].youtubeId).toBe('zF2VJVEh6E8')
    expect(sources[0].role).toBe('audio')
  })

  it('cuts a dead link from any slot, the Main included', async () => {
    const id = await lib.addTrack(track())
    await lib.setSource(id, 'video', {
      youtubeId: '0vFOzaXqZH0',
      url: 'https://www.youtube.com/watch?v=0vFOzaXqZH0',
      kind: 'official',
    })

    // The optional slot goes first, and the Main survives it.
    await lib.removeSource(id, 'video')
    expect((await lib.getTrack(id))!.sources.map((s) => s.role)).toEqual(['audio'])

    // A link-health run may cut the Main too: `setSource` is the one that
    // refuses to empty it, because the editor must not leave a track
    // unplayable — here YouTube has already said the link will not play.
    await lib.removeSource(id, 'audio')
    expect((await lib.getTrack(id))!.sources).toEqual([])

    // Cutting an empty slot is a quiet no-op rather than an error.
    await lib.removeSource(id, 'audio')
    expect((await lib.getTrack(id))!.sources).toEqual([])
  })

  it('ignores a fourth link when merging onto an existing track', async () => {
    const first = await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    await lib.addTrack(
      track({
        musicbrainzRecordingId: 'mb-1',
        sources: [
          { youtubeId: 'kJQP7kiw5Fk', url: 'u', kind: 'video' },
          { youtubeId: '0vFOzaXqZH0', url: 'u', kind: 'official' },
          { youtubeId: 'dQw4w9WgXcQ', url: 'u', kind: 'live' },
        ],
      }),
    )
    const sources = (await lib.getTrack(first))!.sources
    expect(sources).toHaveLength(3)
    expect(sources.map((s) => s.role)).toEqual(['audio', 'video', 'live'])
  })

  it('honours an explicit role when the caller knows it', async () => {
    const id = await lib.addTrack(
      track({
        sources: [
          { youtubeId: '0vFOzaXqZH0', url: 'u', kind: 'official', role: 'video' },
        ],
      }),
    )
    // A track with no audio source is repaired to have one.
    const only = (await lib.getTrack(id))!.sources
    expect(only).toHaveLength(1)

    await lib.setSource(id, 'audio', {
      youtubeId: 'f7nonexistent1',
      url: 'u',
      kind: 'official',
    })
    const both = (await lib.getTrack(id))!.sources
    expect(both.map((s) => s.role).sort()).toEqual(['audio', 'video'])
  })

  it('will not let two tracks claim the same MusicBrainz recording', async () => {
    await lib.addTrack(track({ musicbrainzRecordingId: 'mb-1' }))
    const other = await lib.addTrack(
      track({
        title: 'Different Song',
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
    await expect(lib.setMusicBrainzId(other, 'mb-1')).rejects.toThrow(
      /already uses/i,
    )
    // The failed link must not have overwritten the original owner.
    expect((await lib.getTrack(1))?.musicbrainzRecordingId).toBe('mb-1')
    expect((await lib.getTrack(other))?.musicbrainzRecordingId).toBe('mb-2')
  })

  it('updates fields and replaces genres', async () => {
    const id = await lib.addTrack(track())
    await lib.updateTrack(id, { title: 'Renamed', genres: ['art rock'] })
    const saved = await lib.getTrack(id)
    expect(saved?.title).toBe('Renamed')
    expect(saved?.genres).toEqual(['art rock'])
  })

  it('cascades deletes', async () => {
    const id = await lib.addTrack(track())
    const pl = await lib.createPlaylist('Temp')
    await lib.addToPlaylist(pl, id)
    await lib.deleteTrack(id)
    expect(await lib.getTrack(id)).toBeNull()
    expect((await lib.listPlaylistTracks(pl))).toHaveLength(0)
    expect(await lib.listGenres()).toHaveLength(0)
  })

  it('is safe to migrate twice', async () => {
    await lib.migrate()
    await expect(lib.migrate()).resolves.toBeUndefined()
    expect(await lib.listTracks(EMPTY_FILTER)).toHaveLength(0)
  })
})

describe('youtubeErrorMessage', () => {
  it('explains the errors users actually hit', () => {
    expect(youtubeErrorMessage(150)).toMatch(/embedding/i)
    expect(youtubeErrorMessage(2)).toMatch(/invalid video id/i)
    expect(youtubeErrorMessage(100)).toMatch(/private|unavailable/i)
    expect(youtubeErrorMessage(9999)).toContain('9999')
  })
})

describe('YouTube metadata heuristics', () => {
  it('offers thumbnails best-quality first with a guaranteed fallback', () => {
    const urls = thumbnailUrls('dQw4w9WgXcQ')
    expect(urls[0]).toContain('maxresdefault')
    // hqdefault always exists for a valid video, so it must be in the list.
    expect(urls.some((u) => u.includes('hqdefault'))).toBe(true)
    expect(urls.every((u) => u.includes('dQw4w9WgXcQ'))).toBe(true)
  })

  it('falls back through the video thumbnails when there is no stored cover', () => {
    const list = coverCandidates(null, 'M-43pOqheMY')
    expect(list).toHaveLength(3)
    expect(list.every((u) => u.includes('M-43pOqheMY'))).toBe(true)
    // hqdefault exists for every valid video, so the chain always ends somewhere.
    expect(list.some((u) => u.includes('hqdefault'))).toBe(true)
  })

  it('keeps a stored cover first so real album art always wins', () => {
    const list = coverCandidates(
      'https://coverartarchive.org/release/abc/front-500',
      'M-43pOqheMY',
    )
    expect(list[0]).toBe('https://coverartarchive.org/release/abc/front-500')
    expect(list).toHaveLength(4)
  })

  it('still offers a thumbnail for a track with neither cover nor video', () => {
    // Nothing to derive from, so the placeholder is all that is left — the
    // important part is that it does not throw or invent a URL.
    expect(coverCandidates(null, null)).toEqual([])
    expect(coverCandidates('', undefined)).toEqual([])
  })

  it('ignores a blank stored cover rather than trying to load it', () => {
    const list = coverCandidates('   ', 'zPmJ7MFwjIk')
    expect(list).toHaveLength(3)
    expect(list.every((u) => u.trim() !== '')).toBe(true)
  })

  it('never lists the same address twice', () => {
    // A cover already pointing at one of this video's thumbnails must not be
    // retried after it fails.
    const thumb = thumbnailUrls('zPmJ7MFwjIk')[2]
    const list = coverCandidates(thumb, 'zPmJ7MFwjIk')
    expect(list).toHaveLength(3)
    expect(new Set(list).size).toBe(list.length)
  })

  it('recognises YouTube 120x90 stand-in images, which load rather than fail', () => {
    // A missing rendition answers 200 with a 120x90 grey placeholder, so
    // onError never fires and the chain would stall on a blank rectangle.
    const src = thumbnailUrls('GRiC35zeziU')[0]
    expect(isPlaceholderThumbnail(src, 120)).toBe(true)
    expect(isPlaceholderThumbnail(src, 1280)).toBe(false)
  })

  it('leaves a small but real stored cover alone', () => {
    // Cover Art Archive art is not held to YouTube's rendition sizes.
    expect(
      isPlaceholderThumbnail(
        'https://coverartarchive.org/release/abc/front-500',
        120,
      ),
    ).toBe(false)
  })

  it('does not treat an image that never loaded as a placeholder', () => {
    // naturalWidth 0 means "no image", which is onError's job, not this one's.
    expect(isPlaceholderThumbnail(thumbnailUrls('xY12zY34X56')[0], 0)).toBe(false)
  })
})

describe('buildMusicBrainzQuery', () => {
  it('prefers field-qualified queries so mashups do not crowd out the real track', () => {
    const [strict] = buildMusicBrainzQuery('Happy', 'Pharrell Williams')
    expect(strict).toBe('recording:"Happy" AND artist:"Pharrell Williams"')
  })

  it('widens progressively when the strict form finds nothing', () => {
    expect(buildMusicBrainzQuery('Happy', '')[0]).toBe('recording:"Happy"')
    const queries = buildMusicBrainzQuery('Happy', 'Pharrell Williams')
    expect(queries).toHaveLength(3)
    expect(queries[1]).toBe('recording:"Happy"')
    expect(queries[2]).toBe('Happy Pharrell Williams')
  })

  it('sanitizes quotes that would break the Lucene syntax', () => {
    expect(buildMusicBrainzQuery('Song "Live"', 'Band')[0]).toBe(
      'recording:"Song Live" AND artist:"Band"',
    )
  })

  it('returns nothing when there is no title', () => {
    expect(buildMusicBrainzQuery('', 'Pharrell Williams')).toEqual([])
  })
})

describe('titleCase', () => {
  it('normalises tag casing from MusicBrainz', () => {
    expect(titleCase('hip hop')).toBe('Hip Hop')
  })
})

describe('bandwidth tiers', () => {
  it('requests the preferred quality via YouTube params', () => {
    const url = new URL(embedUrlWithQuality('dQw4w9WgXcQ', 'tiny'))
    expect(url.hostname).toBe('www.youtube-nocookie.com')
    expect(url.pathname).toBe('/embed/dQw4w9WgXcQ')
    expect(url.searchParams.get('vq')).toBe('tiny')
    expect(url.searchParams.get('rel')).toBe('0')
  })

  it('leaves quality to YouTube in auto mode', () => {
    const url = new URL(embedUrlWithQuality('dQw4w9WgXcQ', 'auto'))
    expect(url.searchParams.get('vq')).toBeNull()
    // The parameters that do apply in video mode are still sent.
    expect(url.searchParams.get('rel')).toBe('0')
  })

  it('saves real data on a music-length track', () => {
    // A 6-minute track: audio is a small fraction of full-quality video.
    const audio = estimateSavings(360, 'high', 'tiny')
    expect(audio.savedMb).toBeGreaterThan(0)
    expect(audio.toMb).toBeLessThan(audio.fromMb)
    // Audio-only mode drops the video track entirely.
    const floor = (128 * 360) / 8 / 1024
    expect(audio.toMb).toBeGreaterThanOrEqual(Math.floor(floor))
    expect(audio.toMb).toBeLessThanOrEqual(Math.ceil(floor))
  })

  it('keeps audio bitrate constant across tiers, so quality only cuts video', () => {
    // The audio floor is the audio-only size regardless of what we came from.
    const fromHigh = estimateSavings(360, 'high', 'tiny').toMb
    const fromLow = estimateSavings(360, 'small', 'tiny').toMb
    expect(fromHigh).toBe(fromLow)
    // And it is strictly below any tier that still ships video.
    expect(fromHigh).toBeLessThan(estimateSavings(360, 'high', 'small').toMb)
  })

  it('reports no saving when already at the target tier', () => {
    expect(estimateSavings(360, 'tiny', 'tiny').savedMb).toBe(0)
    expect(estimateSavings(360, 'high', 'high').savedMb).toBe(0)
  })

  it('is monotonic: saving more bandwidth never costs more data', () => {
    // Listed worst-to-best, so each step must cost the same or less. The tiers
    // are spelled out here rather than imported, because the Bandwidth dropdown
    // that once listed them was removed: audio mode pins the lowest rendition
    // with no control. The ladder is kept as a property of the estimate, not of
    // a menu.
    const ladder: PlaybackQuality[] = ['high', 'medium', 'small', 'tiny']
    let previous = estimateSavings(1800, 'high', 'high').toMb
    for (const tier of ladder) {
      const size = estimateSavings(1800, 'high', tier).toMb
      expect(size).toBeLessThanOrEqual(previous)
      previous = size
    }
  })

  it('handles zero and negative durations without NaN', () => {
    expect(estimateSavings(0, 'high', 'tiny').toMb).toBe(0)
    expect(Number.isNaN(estimateSavings(-50, 'high', 'tiny').toMb)).toBe(false)
  })
})