import { describe, expect, it } from 'vitest'
import {
  AGENT_INSTRUCTIONS,
  buildContext,
  emptyReport,
  mergeInbox,
  normaliseName,
  parseInbox,
  readSources,
  reportSignature,
  summarise,
  trackKey,
  verifyInboxIds,
} from './agentInbox'
import { normalise } from './jsonLibrary'
import type { LibraryDocument } from './types'

/**
 * Coverage for the AI drop box.
 *
 * The rules that matter are all about what happens when the model is wrong,
 * because it will be: the same song arriving twice under two spellings, a
 * track with no playable link, a playlist naming a song that is not there. Each
 * of those has a defined outcome, and an outcome that silently drops data is a
 * bug, so they are asserted one at a time rather than through the happy path.
 */

function doc(overrides: Partial<LibraryDocument> = {}): LibraryDocument {
  return normalise(
    JSON.stringify({
      format: 'trackvault-library',
      version: 1,
      tracks: [
        {
          id: 1,
          title: 'Locust',
          artist: 'Machine Head',
          album: 'Catharsis',
          year: 2018,
          musicbrainzRecordingId: 'mb-locust',
          genres: ['thrash metal'],
          sources: [
            {
              id: 1,
              youtubeId: 'jxjeqCd6Zm0',
              url: 'https://www.youtube.com/watch?v=jxjeqCd6Zm0',
              kind: 'official',
              role: 'audio',
            },
          ],
        },
      ],
      playlists: [],
      ...overrides,
    }),
  )
}

const inbox = (json: unknown) => mergeInbox(doc(), parseInbox(JSON.stringify(json)))

describe('parseInbox', () => {
  it('reads the flat audio/video shorthand', () => {
    const parsed = parseInbox(
      JSON.stringify({
        tracks: [
          {
            title: 'Demonon Vrosis',
            artist: 'Rotting Christ',
            album: 'Lucifer Over Athens',
            year: '2015',
            genres: ['black metal', 'black metal'],
            audio: 'MHW2CF4GF-8',
            video: 'https://youtu.be/Dzc7tZB8X_k',
          },
        ],
      }),
    )
    expect(parsed.tracks).toHaveLength(1)
    expect(parsed.tracks[0].year).toBe(2015)
    // Duplicate genres are collapsed before the merge ever sees them.
    expect(parsed.tracks[0].genres).toEqual(['black metal'])
  })

  it('survives a file that is not valid JSON at all', () => {
    const parsed = parseInbox('{ this is not json')
    expect(parsed.tracks).toEqual([])
    expect(parsed.playlists).toEqual([])
  })

  it('drops entries with neither a title nor an artist rather than importing them', () => {
    const parsed = parseInbox(
      JSON.stringify({ tracks: [{ audio: 'jxjeqCd6Zm0' }, { title: 'X', artist: 'Y' }] }),
    )
    expect(parsed.tracks).toHaveLength(1)
    expect(parsed.tracks[0].title).toBe('X')
  })

  it('reads a sources array copied out of the library', () => {
    const parsed = parseInbox(
      JSON.stringify({
        tracks: [
          {
            title: 'Locust',
            artist: 'Machine Head',
            sources: [
              { youtubeId: 'jxjeqCd6Zm0', role: 'audio' },
              { url: 'https://www.youtube.com/watch?v=Dzc7tZB8X_k', role: 'video' },
            ],
          },
        ],
      }),
    )
    const { sources } = readSources(parsed.tracks[0])
    expect(sources.map((s) => s.role)).toEqual(['audio', 'video'])
  })
})

describe('readSources', () => {
  it('accepts a bare id, a watch URL and a short link alike', () => {
    const { sources } = readSources({
      title: 'T',
      artist: 'A',
      audio: 'jxjeqCd6Zm0',
      video: 'https://youtu.be/Dzc7tZB8X_k?t=30',
    })
    expect(sources[0].youtubeId).toBe('jxjeqCd6Zm0')
    expect(sources[1].youtubeId).toBe('Dzc7tZB8X_k')
    expect(sources[1].url).toContain('youtu.be')
  })

  it('keeps at most three links, audio first', () => {
    const { sources } = readSources({
      title: 'T',
      artist: 'A',
      sources: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'],
    })
    expect(sources).toHaveLength(3)
    expect(sources.map((s) => s.role)).toEqual(['audio', 'video', 'live'])
  })

  it('defaults the kind from the role rather than inventing one', () => {
    const { sources } = readSources({
      title: 'T',
      artist: 'A',
      audio: 'aaaaaaaaaaa',
      video: 'bbbbbbbbbbb',
    })
    expect(sources[0].kind).toBe('official')
    expect(sources[1].kind).toBe('video')
  })

  it('refuses to let one video fill both slots, as the editor also refuses', () => {
    // A batch can contain this because the model writing it has no idea the
    // rule exists, and the editor would never let a person save it.
    const { sources, duplicates } = readSources({
      title: 'A Shot at Redemption',
      artist: 'H.E.A.T',
      audio: 'aaaaaaaaaaa',
      video: 'aaaaaaaaaaa',
    })
    expect(sources.map((s) => s.role)).toEqual(['audio'])
    expect(duplicates).toEqual(['aaaaaaaaaaa'])
  })

  it('reports every repeat, so a batch that sent it three times is legible', () => {
    const { sources, duplicates } = readSources({
      title: 'T',
      artist: 'A',
      sources: ['aaaaaaaaaaa', 'aaaaaaaaaaa', 'aaaaaaaaaaa'],
    })
    expect(sources).toHaveLength(1)
    expect(duplicates).toEqual(['aaaaaaaaaaa', 'aaaaaaaaaaa'])
  })

  it('has nothing to report when the two slots really are two videos', () => {
    expect(
      readSources({ title: 'T', artist: 'A', audio: 'aaaaaaaaaaa', video: 'bbbbbbbbbbb' })
        .duplicates,
    ).toEqual([])
  })

  it('rescues a link wrapped in a one-key object instead of dropping it', () => {
    // A real batch sent `{"Main": url}` for every track: the link is there,
    // just under a key the contract never named. The known keys win when both
    // are present; a non-link object still resolves to nothing.
    const { sources } = readSources({
      title: 'T',
      artist: 'A',
      audio: { Main: 'https://www.youtube.com/watch?v=BNvTgFLMgsE' } as unknown as string,
    })
    expect(sources.map((s) => s.youtubeId)).toEqual(['BNvTgFLMgsE'])
    expect(sources[0].role).toBe('audio')
    expect(
      readSources({ title: 'T', artist: 'A', audio: { Main: 'not a link' } as unknown as string })
        .sources,
    ).toEqual([])
  })
})

describe('a batch that sends one video for both slots', () => {
  it('adds the track once and says what it dropped', () => {
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'Same Video',
          artist: 'Repro',
          audio: 'aaaaaaaaaaa',
          video: 'aaaaaaaaaaa',
        },
      ],
    })
    const added = after.tracks[after.tracks.length - 1]
    expect(added.sources.map((s) => s.youtubeId)).toEqual(['aaaaaaaaaaa'])
    expect(report.added).toBe(1)
    // Reported rather than swallowed: the batch asked for something the library
    // cannot represent, and the person editing it is the one who can fix it.
    expect(report.notes).toHaveLength(1)
    expect(report.notes[0]).toContain('both slots')
    expect(report.notes[0]).toContain('Repro — Same Video')
  })

  it('says nothing when the batch is ordinary', () => {
    const { report } = inbox({
      tracks: [
        { title: 'Fine', artist: 'Repro', audio: 'aaaaaaaaaaa', video: 'bbbbbbbbbbb' },
      ],
    })
    expect(report.notes).toEqual([])
  })
})

describe('covers a batch tries to store', () => {
  it('keeps real album art', () => {
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'With Art',
          artist: 'Repro',
          audio: 'aaaaaaaaaaa',
          coverUrl: 'https://coverartarchive.org/release/abc123/front-500',
        },
      ],
    })
    expect(after.tracks[after.tracks.length - 1].coverUrl).toBe(
      'https://coverartarchive.org/release/abc123/front-500',
    )
    expect(report.notes).toEqual([])
  })

  it('refuses a channel picture and says why', () => {
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'Avatar Art',
          artist: 'Repro',
          audio: 'aaaaaaaaaaa',
          coverUrl: 'https://yt3.googleusercontent.com/abc=w512',
        },
      ],
    })
    // The track still arrives — losing it over its artwork would be the wrong
    // trade — but with no cover, which the chain repairs from the video.
    expect(after.tracks[after.tracks.length - 1].coverUrl).toBeNull()
    expect(report.added).toBe(1)
    expect(report.notes).toHaveLength(1)
    expect(report.notes[0]).toContain('not album art')
  })

  it('refuses a video thumbnail the app would derive anyway', () => {
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'Still Art',
          artist: 'Repro',
          audio: 'aaaaaaaaaaa',
          coverUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/maxresdefault.jpg',
        },
      ],
    })
    expect(after.tracks[after.tracks.length - 1].coverUrl).toBeNull()
    expect(report.notes[0]).toContain('derives')
  })

  it('will not fill a blank on an existing track with a channel picture', () => {
    // `enrich` only fills a blank cover, so this is the one path where a bad
    // cover could still land on a track the person already owns.
    const base = doc()
    base.tracks[0].coverUrl = null
    const { doc: after, report } = mergeInbox(
      base,
      parseInbox(
        JSON.stringify({
          tracks: [
            {
              title: 'Locust',
              artist: 'Machine Head',
              coverUrl: 'https://yt3.googleusercontent.com/abc=w512',
            },
          ],
        }),
      ),
    )
    expect(after.tracks[0].coverUrl).toBeNull()
    expect(report.notes).toHaveLength(1)
  })

  it('records a note the caller established, which it cannot check itself', () => {
    const { report } = mergeInbox(
      doc(),
      parseInbox(
        JSON.stringify({ tracks: [{ title: 'X', artist: 'Y', audio: 'aaaaaaaaaaa' }] }),
      ),
      { notes: ['a cover answered 404'] },
    )
    expect(report.notes).toEqual(['a cover answered 404'])
  })
})

describe('normaliseName', () => {
  it('ignores case, punctuation and accents', () => {
    const base = normaliseName('Is There Anybody out There?')
    expect(normaliseName('is there anybody out there')).toBe(base)
    expect(normaliseName('Is There Anybody Out There!')).toBe(base)
    expect(normaliseName('Björk')).toBe(normaliseName('Bjork'))
  })

  it('ignores wording about the release or the file', () => {
    const base = normaliseName('Is There Anybody out There?')
    expect(normaliseName('Is There Anybody Out There (Remastered)')).toBe(base)
    expect(normaliseName('Is There Anybody Out There [Remastered 2011]')).toBe(base)
    expect(normaliseName('Is There Anybody Out There - Official Video')).toBe(base)
    expect(normaliseName('Is There Anybody Out There (Official Music Video)')).toBe(base)
    expect(normaliseName('Is There Anybody Out There (Deluxe Edition)')).toBe(base)
    expect(normaliseName('Is There Anybody Out There - Remastered')).toBe(base)
  })

  it('keeps wording that names a different performance', () => {
    // Stripping this is how a requested live take gets silently folded into
    // the studio track and reported as "already complete".
    const studio = normaliseName('In League with Satan')
    expect(normaliseName('In League with Satan (Live at the Ritz)')).not.toBe(studio)
    expect(normaliseName('Take This Life (Live)')).not.toBe(normaliseName('Take This Life'))
    expect(normaliseName('Wolf Totem (Acoustic)')).not.toBe(normaliseName('Wolf Totem'))
    expect(normaliseName('Locust (Demo)')).not.toBe(normaliseName('Locust'))
    expect(normaliseName('Locust (Instrumental)')).not.toBe(normaliseName('Locust'))
  })

  it('keeps letters that are not Latin, so non-English titles still compare', () => {
    expect(normaliseName('月光')).toBe('月光')
  })
})

describe('mergeInbox — adding', () => {
  it('adds a new track and assigns ids that do not collide', () => {
    const { doc: after, report } = inbox({
      tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
    })
    expect(report.added).toBe(1)
    expect(after.tracks).toHaveLength(2)
    expect(after.tracks[1].id).toBe(2)
    expect(after.tracks[1].sources[0].role).toBe('audio')
  })

  it('fills the watch URL from a bare video id', () => {
    const { doc: after } = inbox({
      tracks: [{ title: 'New', artist: 'Someone', audio: 'MHW2CF4GF-8' }],
    })
    expect(after.tracks[1].sources[0].url).toBe(
      'https://www.youtube.com/watch?v=MHW2CF4GF-8',
    )
  })

  it('adds a track whose link arrived wrapped in an object, with the link attached', () => {
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'Ghost',
          artist: 'Nobody',
          audio: { Main: 'https://www.youtube.com/watch?v=BNvTgFLMgsE' } as unknown as string,
        },
      ],
    })
    expect(report.added).toBe(1)
    expect(after.tracks[1].sources.map((s) => s.youtubeId)).toEqual(['BNvTgFLMgsE'])
    expect(report.lines[0].reason).toBeUndefined()
  })

  it('adds a track with no playable link and flags it for a manual link', () => {
    const { doc: after, report } = inbox({
      tracks: [{ title: 'Ghost', artist: 'Nobody', audio: 'the official video' }],
    })
    expect(report.added).toBe(1)
    expect(report.lines[0].reason).toMatch(/fixed by hand/)
    expect(after.tracks).toHaveLength(2)
    expect(after.tracks[1].sources).toHaveLength(0)
  })

  it('rejects a track missing a title or artist, naming the problem', () => {
    const { doc: after, report } = inbox({
      tracks: [{ title: '', artist: 'Nobody', audio: 'MHW2CF4GF-8' }],
    })
    expect(report.rejected).toBe(1)
    expect(after.tracks).toHaveLength(1)
  })

  it('does not modify the document it was given', () => {
    const before = doc()
    const snapshot = JSON.stringify(before)
    inbox({ tracks: [{ title: 'New', artist: 'Someone', audio: 'aaaaaaaaaaa' }] })
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('verifyInboxIds + dead links', () => {
  // No network in these tests: the checker is injected, and the merge only
  // ever sees the resulting set of dead ids.
  const check = (live: string[], seen: string[] = []) => async (id: string) => {
    seen.push(id)
    return live.includes(id)
  }
  const deadInbox = (json: unknown, deadIds: Set<string>) =>
    mergeInbox(doc(), parseInbox(JSON.stringify(json)), { deadIds })

  it('checks each distinct id once, however many slots mention it', async () => {
    const seen: string[] = []
    const dead = await verifyInboxIds(
      parseInbox(
        JSON.stringify({
          tracks: [
            { title: 'A', artist: 'X', audio: 'aaaaaaaaaaa', video: 'bbbbbbbbbbb' },
            { title: 'B', artist: 'Y', audio: 'aaaaaaaaaaa', live: 'ccccccccccc' },
          ],
        }),
      ),
      check(['aaaaaaaaaaa', 'bbbbbbbbbbb'], seen),
    )
    expect(dead).toEqual(new Set(['ccccccccccc']))
    expect([...new Set(seen)].sort()).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])
  })

  it('treats a failed check as unknown, never as dead', async () => {
    const dead = await verifyInboxIds(
      parseInbox(JSON.stringify({ tracks: [{ title: 'A', artist: 'X', audio: 'aaaaaaaaaaa' }] })),
      async () => null,
    )
    expect(dead).toEqual(new Set())
  })

  it('reports progress against the distinct total', async () => {
    const seen: Array<[number, number]> = []
    await verifyInboxIds(
      parseInbox(
        JSON.stringify({
          tracks: [
            { title: 'A', artist: 'X', audio: 'aaaaaaaaaaa', video: 'bbbbbbbbbbb' },
            { title: 'B', artist: 'Y', audio: 'aaaaaaaaaaa' },
          ],
        }),
      ),
      async () => true,
      (done, total) => seen.push([done, total]),
    )
    // Two distinct ids, however many slots mention them — and the last call
    // always lands on the total, which is what a progress line needs.
    expect(seen.at(-1)).toEqual([2, 2])
    expect(seen.every(([, total]) => total === 2)).toBe(true)
  })

  it('adds a new track whose audio link is dead, flagging it with the id named', () => {
    const { doc: after, report } = deadInbox(
      { tracks: [{ title: 'Ghost', artist: 'Nobody', audio: 'ddddddddddd' }] },
      new Set(['ddddddddddd']),
    )
    expect(report.added).toBe(1)
    expect(report.lines[0].reason).toContain('ddddddddddd')
    expect(report.lines[0].reason).toMatch(/does not exist/)
    expect(after.tracks).toHaveLength(2)
    expect(after.tracks[1].sources).toHaveLength(0)
  })

  it('adds the live slots and drops the dead clip with a note', () => {
    const { doc: after, report } = deadInbox(
      {
        tracks: [
          {
            title: 'Real',
            artist: 'Somebody',
            audio: 'aaaaaaaaaaa',
            video: 'ddddddddddd',
          },
        ],
      },
      new Set(['ddddddddddd']),
    )
    expect(report.added).toBe(1)
    expect(after.tracks[1].sources.map((s) => s.youtubeId)).toEqual(['aaaaaaaaaaa'])
    expect(report.notes.join(' ')).toContain('ddddddddddd')
  })

  it('never attaches a dead link while enriching, but still fills the blanks', () => {
    const { doc: after, report } = deadInbox(
      {
        tracks: [
          {
            title: 'Locust',
            artist: 'Machine Head',
            info: 'Eighth studio album.',
            video: 'ddddddddddd',
          },
        ],
      },
      new Set(['ddddddddddd']),
    )
    // The info is blank on the stored track, so the batch still enriches —
    // just without the dead clip.
    expect(report.enriched).toBe(1)
    expect(after.tracks[0].info).toBe('Eighth studio album.')
    expect(after.tracks[0].sources.map((s) => s.youtubeId)).toEqual(['jxjeqCd6Zm0'])
    expect(report.notes.join(' ')).toContain('ddddddddddd')
  })

  it('behaves exactly as before when nothing was checked', () => {
    const { report } = inbox({
      tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
    })
    expect(report.added).toBe(1)
    expect(report.notes).toEqual([])
  })
})

describe('mergeInbox — never duplicating', () => {
  it('matches an existing track on MusicBrainz id even when the title differs', () => {
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'Locust (Remastered 2020)',
          artist: 'Machine Head',
          musicbrainzRecordingId: 'mb-locust',
          genres: ['groove metal'],
          audio: 'jxjeqCd6Zm0',
        },
      ],
    })
    expect(report.added).toBe(0)
    expect(report.enriched).toBe(1)
    expect(after.tracks).toHaveLength(1)
    expect(after.tracks[0].genres).toEqual(['thrash metal', 'groove metal'])
  })

  it('matches an existing track on artist and title with no id at all', () => {
    const { doc: after, report } = inbox({
      tracks: [{ title: 'Locust', artist: 'Machine Head', audio: 'jxjeqCd6Zm0' }],
    })
    expect(report.unchanged).toBe(1)
    expect(after.tracks).toHaveLength(1)
  })

  it('treats a differently punctuated title as the same track', () => {
    const { doc: after, report } = inbox({
      tracks: [
        { title: 'locust!', artist: 'MACHINE HEAD', genres: ['metal'], audio: 'jxjeqCd6Zm0' },
      ],
    })
    expect(report.added).toBe(0)
    expect(after.tracks).toHaveLength(1)
    expect(after.tracks[0].genres).toContain('metal')
  })

  it('is idempotent: sending the same inbox twice changes nothing the second time', () => {
    const payload = {
      tracks: [
        {
          title: 'Locust',
          artist: 'Machine Head',
          album: 'Catharsis',
          genres: ['thrash metal', 'metal'],
          video: 'Dzc7tZB8X_k',
        },
      ],
    }
    const first = inbox(payload)
    expect(first.report.enriched).toBe(1)

    // Second pass, against the document the first pass produced.
    const second = mergeInbox(first.doc, parseInbox(JSON.stringify(payload)))
    expect(second.report.unchanged).toBe(1)
    expect(second.report.enriched).toBe(0)
    expect(second.report.added).toBe(0)
    expect(JSON.stringify(second.doc)).toBe(JSON.stringify(first.doc))
  })

  it('attaches a missing video slot without touching the audio one', () => {
    const { doc: after } = inbox({
      tracks: [{ title: 'Locust', artist: 'Machine Head', video: 'Dzc7tZB8X_k' }],
    })
    const sources = after.tracks[0].sources
    expect(sources).toHaveLength(2)
    expect(sources.find((s) => s.role === 'audio')!.youtubeId).toBe('jxjeqCd6Zm0')
    expect(sources.find((s) => s.role === 'video')!.youtubeId).toBe('Dzc7tZB8X_k')
  })

  it('never replaces a field that already has a value', () => {
    const base = doc()
    base.tracks[0].coverUrl = 'https://coverartarchive.org/release/keep-me/front-500'
    const { doc: after } = mergeInbox(
      base,
      parseInbox(
        JSON.stringify({
          tracks: [
            {
              title: 'Locust',
              artist: 'Machine Head',
              album: 'Something Else Entirely',
              coverUrl: 'https://example.com/other.jpg',
              audio: 'jxjeqCd6Zm0',
            },
          ],
        }),
      ),
    )
    expect(after.tracks[0].album).toBe('Catharsis')
    expect(after.tracks[0].coverUrl).toBe(
      'https://coverartarchive.org/release/keep-me/front-500',
    )
  })

  it('attaches a clip as the video slot even when the inbox names no audio link', () => {
    // The failure this guards against: an inbox that only supplies `video` has
    // its clip resolved into the first free slot, which is `audio` — silently
    // becoming the thing that auto-plays.
    const { doc: after } = inbox({
      tracks: [{ title: 'Locust', artist: 'Machine Head', video: 'Dzc7tZB8X_k' }],
    })
    expect(after.tracks[0].sources.map((s) => s.role)).toEqual(['audio', 'video'])
  })

  it('fills a blank album, because that is the point of the box', () => {
    const base = doc()
    base.tracks[0].album = null
    const { doc: after, report } = mergeInbox(
      base,
      parseInbox(
        JSON.stringify({
          tracks: [
            { title: 'Locust', artist: 'Machine Head', album: 'Catharsis', audio: 'jxjeqCd6Zm0' },
          ],
        }),
      ),
    )
    expect(report.enriched).toBe(1)
    expect(after.tracks[0].album).toBe('Catharsis')
  })

  it('does not attach a third link to a track that already has both slots', () => {
    const base = doc()
    base.tracks[0].sources.push({
      id: 2,
      youtubeId: 'Dzc7tZB8X_k',
      url: 'https://www.youtube.com/watch?v=Dzc7tZB8X_k',
      kind: 'video',
      label: null,
      role: 'video',
    })
    const { doc: after, report } = mergeInbox(
      base,
      parseInbox(
        JSON.stringify({
          tracks: [
            {
              title: 'Locust',
              artist: 'Machine Head',
              audio: 'jxjeqCd6Zm0',
              video: 'aaaaaaaaaaa',
            },
          ],
        }),
      ),
    )
    expect(after.tracks[0].sources).toHaveLength(2)
    // And it names the slot that is in the way, rather than claiming the track
    // was already complete — otherwise the person believes they have a version
    // the library does not.
    expect(report.lines[0].reason).toBe('the video slot is already filled')
  })

  it('names the audio slot when only the audio link was refused', () => {
    const base = doc()
    base.tracks[0].sources.push({
      id: 2,
      youtubeId: 'Dzc7tZB8X_k',
      url: 'https://www.youtube.com/watch?v=Dzc7tZB8X_k',
      kind: 'video',
      label: null,
      role: 'video',
    })
    const { report } = mergeInbox(
      base,
      parseInbox(
        JSON.stringify({
          tracks: [
            {
              title: 'Locust',
              artist: 'Machine Head',
              audio: 'aaaaaaaaaaa',
            },
          ],
        }),
      ),
    )
    expect(report.lines[0].reason).toBe('the audio slot is already filled')
  })

  it('adds a live version as its own track rather than folding it into the studio one', () => {
    // The real bug this guards: stripping "(Live at the Ritz)" made the live
    // take match the studio track, whose two slots were full, so the request
    // was dropped with the reason "already complete".
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'In League With Satan (Live at the Ritz)',
          artist: 'Venom',
          audio: 'ZXwKsExdHMk',
        },
      ],
    })
    expect(report.added).toBe(1)
    expect(after.tracks).toHaveLength(2)
    expect(after.tracks[1].title).toBe('In League With Satan (Live at the Ritz)')
  })
})

describe('mergeInbox — playlists', () => {
  const twoTracks = {
    tracks: [
      { title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' },
      { title: 'Locust', artist: 'Machine Head', audio: 'jxjeqCd6Zm0', key: 'mh' },
    ],
    playlists: [
      {
        name: 'Gym',
        description: 'Heavy',
        tracks: ['Rotting Christ — Demonon Vrosis', 'mh'],
      },
    ],
  }

  it('builds a playlist naming tracks that already exist and ones added in the same batch', () => {
    const { doc: after, report } = inbox(twoTracks)
    expect(after.playlists).toHaveLength(1)
    expect(after.playlists[0].name).toBe('Gym')
    expect(after.playlists[0].description).toBe('Heavy')
    // Both resolved: the second through the `key` the inbox declared for it.
    expect(after.playlists[0].tracks).toHaveLength(2)
    expect(report.playlists[0].created).toBe(true)
    expect(report.playlists[0].unmatched).toEqual([])
  })

  it('accepts a hyphen instead of an em dash', () => {
    const { doc: after } = inbox({
      playlists: [{ name: 'P', tracks: ['Machine Head - Locust'] }],
    })
    expect(after.playlists[0].tracks).toEqual([1])
  })

  it('accepts an en dash too, since the README promises all three', () => {
    for (const dash of ['—', '–', '-']) {
      const { doc: after } = inbox({
        playlists: [{ name: 'P', tracks: [`Machine Head ${dash} Locust`] }],
      })
      expect(after.playlists[0].tracks, `failed for ${dash}`).toEqual([1])
    }
  })

  it('accepts a bare title when it is unambiguous', () => {
    const { doc: after } = inbox({
      playlists: [{ name: 'P', tracks: ['Locust'] }],
    })
    expect(after.playlists[0].tracks).toEqual([1])
  })

  it('refuses a bare title that matches more than one track, rather than guessing', () => {
    const base = doc()
    base.tracks.push({
      ...base.tracks[0],
      id: 2,
      artist: 'Someone Else',
      musicbrainzRecordingId: null,
    })
    const { doc: after, report } = mergeInbox(
      base,
      parseInbox(JSON.stringify({ playlists: [{ name: 'P', tracks: ['Locust'] }] })),
    )
    expect(after.playlists[0].tracks).toEqual([])
    expect(report.playlists[0].unmatched).toEqual(['Locust'])
  })

  it('resolves a reference whose title carries its own " - " suffix', () => {
    // The user's inbox: "Artist — Title - Remastered" split into three
    // parts and never matched the track added in the same batch.
    const { doc: after, report } = inbox({
      tracks: [
        {
          title: 'Summer in the City - Remastered',
          artist: "The Lovin' Spoonful",
          audio: '5YgevxRGXIU',
        },
        {
          title: 'Hush - 1998 Remaster',
          artist: 'Deep Purple',
          audio: 'Y4eH033TGOo',
        },
        {
          title: "Gimme Some Lovin' - Single Mix",
          artist: 'The Spencer Davis Group',
          audio: 'eaU6EYHSBTw',
        },
      ],
      playlists: [
        {
          name: 'Oldies',
          tracks: [
            "The Lovin' Spoonful — Summer in the City - Remastered",
            'Deep Purple — Hush - 1998 Remaster',
            "The Spencer Davis Group — Gimme Some Lovin' - Single Mix",
          ],
        },
      ],
    })
    expect(report.playlists[0].unmatched).toEqual([])
    expect(after.playlists[0].tracks).toHaveLength(3)
  })

  it('reports a reference that matches nothing instead of silently dropping it', () => {
    const { doc: after, report } = inbox({
      playlists: [{ name: 'P', tracks: ['Machine Head — Locust', 'Nobody — Nothing'] }],
    })
    // The good reference still made it in; the bad one is reported.
    expect(after.playlists[0].tracks).toEqual([1])
    expect(report.playlists[0].unmatched).toEqual(['Nobody — Nothing'])
  })

  it('appends to an existing playlist rather than replacing it', () => {
    const base = doc()
    base.playlists.push({
      id: 1,
      name: 'Gym',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      tracks: [1],
      folderId: null,
    })
    const { doc: after } = mergeInbox(
      base,
      parseInbox(
        JSON.stringify({
          tracks: [{ title: 'Demonon Vrosis', artist: 'Rotting Christ', audio: 'MHW2CF4GF-8' }],
          playlists: [{ name: 'gym', tracks: ['Rotting Christ — Demonon Vrosis'] }],
        }),
      ),
    )
    expect(after.playlists).toHaveLength(1)
    // Case-insensitive match on the name, and the existing entry kept.
    expect(after.playlists[0].tracks).toEqual([1, 2])
  })

  it('is idempotent, so re-sending an inbox does not duplicate playlist entries', () => {
    const first = inbox(twoTracks)
    const second = mergeInbox(first.doc, parseInbox(JSON.stringify(twoTracks)))
    expect(second.doc.playlists[0].tracks).toEqual(first.doc.playlists[0].tracks)
    expect(second.report.playlists[0].added).toBe(0)
  })

  it('creates an empty playlist rather than failing when every reference is bad', () => {
    const { doc: after } = inbox({
      playlists: [{ name: 'Empty', tracks: ['Nobody — Nothing'] }],
    })
    expect(after.playlists[0].name).toBe('Empty')
    expect(after.playlists[0].tracks).toEqual([])
  })
})

describe('mergeInbox — folders', () => {
  it('creates nested folders for a new playlist and reports them', () => {
    const { doc: after, report } = inbox({
      playlists: [{ name: 'Thrash', folder: 'Metal/Thrash', tracks: [] }],
    })
    expect(after.folders.map((f) => f.name)).toEqual(['Metal', 'Thrash'])
    expect(after.folders[1].parentId).toBe(after.folders[0].id)
    expect(after.playlists[0].folderId).toBe(after.folders[1].id)
    expect(report.foldersCreated).toEqual(['Metal', 'Metal/Thrash'])
    expect(report.playlists[0].folder).toBe('Metal/Thrash')
    expect(report.playlists[0].moved).toBe(false)
  })

  it('reuses an existing folder case-insensitively instead of doubling it', () => {
    const base = doc()
    base.folders.push({ id: 1, name: 'Metal', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' })
    const { doc: after, report } = mergeInbox(
      base,
      parseInbox(JSON.stringify({ playlists: [{ name: 'Thrash', folder: 'metal', tracks: [] }] })),
    )
    expect(after.folders).toHaveLength(1)
    expect(after.playlists[0].folderId).toBe(1)
    expect(report.foldersCreated).toEqual([])
  })

  it('moves a matched playlist into the asked folder and says so', () => {
    const base = doc()
    base.playlists.push({
      id: 1,
      name: 'Gym',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      tracks: [],
      folderId: null,
    })
    const { doc: after, report } = mergeInbox(
      base,
      parseInbox(JSON.stringify({ playlists: [{ name: 'gym', folder: 'Workout', tracks: [] }] })),
    )
    expect(after.playlists[0].folderId).toBe(after.folders[0].id)
    expect(report.playlists[0].moved).toBe(true)
    expect(report.playlists[0].folder).toBe('Workout')
    expect(report.foldersCreated).toEqual(['Workout'])
  })

  it('leaves a matched playlist where it is when no folder is asked for', () => {
    const base = doc()
    base.folders.push({ id: 1, name: 'Metal', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' })
    base.playlists.push({
      id: 1,
      name: 'Gym',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      tracks: [],
      folderId: 1,
    })
    const { doc: after, report } = mergeInbox(
      base,
      parseInbox(JSON.stringify({ playlists: [{ name: 'gym', tracks: [] }] })),
    )
    expect(after.playlists[0].folderId).toBe(1)
    expect(report.playlists[0].moved).toBe(false)
    expect(report.playlists[0].folder).toBe('Metal')
  })

  it('treats a slashes-only folder as no folder rather than a nowhere id', () => {
    const { doc: after, report } = inbox({
      playlists: [{ name: 'Top', folder: '///', tracks: [] }],
    })
    expect(after.playlists[0].folderId).toBe(null)
    expect(after.folders).toHaveLength(0)
    expect(report.foldersCreated).toEqual([])
  })

  it('announces a pure filing batch instead of calling it nothing', () => {
    const { report } = inbox({
      playlists: [{ name: 'Thrash', folder: 'Metal', tracks: [] }],
    })
    expect(summarise(report)).toContain('1 folder (Metal)')
  })
})

describe('buildContext', () => {
  it('omits the bulky fields that do not affect the decision to add a track', () => {
    const base = doc()
    base.tracks[0].coverUrl = 'https://coverartarchive.org/release/abc/front-500'
    base.tracks[0].info = 'A very long paragraph '.repeat(50)
    base.tracks[0].createdAt = '2026-01-01T00:00:00.000Z'
    const context = buildContext(base)
    const entry = context.tracks[0]
    expect(Object.keys(entry).sort()).toEqual([
      'album',
      'artist',
      'genres',
      'hasCover',
      'hasVideo',
      'id',
      'musicbrainzRecordingId',
      'title',
      'year',
    ])
    // The cover arrives as a boolean, not as an address: the field exists so a
    // model stops re-sending guesses, which is the lightest possible way to say
    // it, and the long blobs above still do not ship at all.
    expect(entry.hasCover).toBe(true)
    expect(JSON.stringify(entry)).not.toContain('coverartarchive')
    expect(JSON.stringify(context)).not.toContain('very long paragraph')
  })

  it('is dramatically smaller than the document it summarises', () => {
    const base = doc()
    // Enough tracks that the fixed instruction overhead is amortised: what is
    // measured here is scaling (per-track summary vs per-track metadata
    // weight), not the length of any one instruction sentence.
    for (let i = 0; i < 80; i++) {
      base.tracks.push({
        ...base.tracks[0],
        id: i + 2,
        title: `Track ${i}`,
        musicbrainzRecordingId: `mb-${i}`,
        info: 'Background text. '.repeat(20),
      })
    }
    const full = JSON.stringify(base)
    const context = JSON.stringify(buildContext(base))
    // The whole argument for the drop box: the prompt does not grow with the
    // weight of the metadata, only with the number of tracks.
    expect(context.length).toBeLessThan(full.length / 3)
  })

  it('carries the instructions an agent needs, so one request is enough', () => {
    const context = buildContext(doc())
    expect(context.instructions).toBe(AGENT_INSTRUCTIONS)
    expect(context.instructions).toContain('data/inbox.json')
    // The reply contract lives here rather than in the panel: the copied prompt
    // points at this field instead of restating it, so a rule that stops being
    // written here stops being asked for anywhere.
    expect(context.instructions).toContain('no code fences')
    expect(context.instructions).toContain('coverUrl')
    expect(context.instructions).toContain('"video"')
    expect(context.instructions).toContain('"live"')
    expect(context.instructions).toContain('"description"')
    expect(context.counts).toEqual({ tracks: 1, playlists: 0, genres: 1 })
  })

  it('tells filing what exists: folder paths on playlists and the folder tree', () => {
    const base = doc()
    base.folders.push(
      { id: 1, name: 'Metal', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, name: 'Thrash', parentId: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    )
    base.playlists.push({
      id: 1,
      name: 'Gym',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      tracks: [],
      folderId: 2,
    })
    const context = buildContext(base)
    expect(context.playlists[0].folder).toBe('Metal/Thrash')
    expect(context.folders).toEqual(['Metal', 'Metal/Thrash'])
  })

  it('lists genres most-used first so new tags stay consistent with the library', () => {
    const base = doc()
    base.tracks.push({ ...base.tracks[0], id: 2, genres: ['thrash metal', 'nu metal'] })
    base.tracks.push({ ...base.tracks[0], id: 3, genres: ['thrash metal'] })
    expect(buildContext(base).genres[0]).toBe('thrash metal')
  })

  it('says whether a track already has art, without publishing the URL', () => {
    const base = doc()
    base.tracks[0].coverUrl = 'https://coverartarchive.org/release/abc/front-500'
    const context = buildContext(base)
    expect(context.tracks[0].hasCover).toBe(true)
    // The URL itself stays out of the per-track entry: the point of the field is
    // to stop a model re-sending a guess, not to invite it to copy the address.
    // (The host does appear in the instructions, which is where it belongs.)
    expect(JSON.stringify(context.tracks[0])).not.toContain('coverartarchive')

    base.tracks[0].coverUrl = null
    expect(buildContext(base).tracks[0].hasCover).toBe(false)
  })

  it('reports whether a track already has a clip, so an agent knows what is missing', () => {
    const base = doc()
    expect(buildContext(base).tracks[0].hasVideo).toBe(false)
    base.tracks[0].sources.push({
      id: 2,
      youtubeId: 'Dzc7tZB8X_k',
      url: 'https://www.youtube.com/watch?v=Dzc7tZB8X_k',
      kind: 'video',
      label: null,
      role: 'video',
    })
    expect(buildContext(base).tracks[0].hasVideo).toBe(true)
  })
})

describe('summarise', () => {
  it('reads as a sentence', () => {
    expect(summarise(emptyReport())).toBe('Nothing to add.')
    const report = emptyReport()
    report.added = 3
    report.enriched = 1
    report.rejected = 2
    expect(summarise(report)).toBe('3 added, 1 enriched, 2 rejected')
  })

  it('names the playlists it touched', () => {
    const report = emptyReport()
    report.added = 1
    report.playlists = [
      { name: 'Gym', created: true, added: 4, unmatched: [], folder: null, moved: false },
    ]
    expect(summarise(report)).toBe('1 added · 1 playlist (Gym)')
  })

  it('reports a batch that only made playlists, rather than reading as empty', () => {
    const report = emptyReport()
    report.playlists = [
      { name: 'Gym', created: true, added: 4, unmatched: [], folder: null, moved: false },
    ]
    expect(summarise(report)).toBe('1 playlist (Gym)')
  })

  it('counts an unmatched playlist reference, so the headline matches the detail list', () => {
    const report = emptyReport()
    report.added = 2
    report.rejected = 1
    report.playlists = [
      {
        name: 'Friday set',
        created: true,
        added: 1,
        unmatched: ['Nobody — Nothing'],
        folder: null,
        moved: false,
      },
    ]
    // Otherwise the banner reads "1 rejected" while its own list says
    // "2 could not be added", and neither number explains the other.
    expect(summarise(report)).toBe(
      '2 added, 1 rejected, 1 playlist reference not found · 1 playlist (Friday set)',
    )
  })
})

describe('reportSignature', () => {
  it('is stable for the same batch, so a refresh does not re-announce it', () => {
    const report = emptyReport('2026-10-01T10:00:00.000Z')
    report.added = 2
    report.lines.push({
      outcome: 'added',
      label: 'Amon Amarth — Awaken',
      title: 'Awaken',
      artist: 'Amon Amarth',
    })
    expect(reportSignature(report)).toBe(reportSignature({ ...report }))
  })

  it('separates two batches the summary line cannot tell apart', () => {
    // The whole reason the summary is not used as the identity: two different
    // batches both read "2 added".
    const first = emptyReport()
    first.added = 2
    first.lines.push({
      outcome: 'added',
      label: 'A — One',
      title: 'One',
      artist: 'A',
    })
    const second = emptyReport()
    second.added = 2
    second.lines.push({
      outcome: 'added',
      label: 'B — Two',
      title: 'Two',
      artist: 'B',
    })
    expect(summarise(first)).toBe(summarise(second))
    expect(reportSignature(first)).not.toBe(reportSignature(second))
  })

  it('stays short enough to keep in browser storage', () => {
    const report = emptyReport()
    report.added = 500
    for (let i = 0; i < 500; i++) {
      report.lines.push({
        outcome: 'added',
        label: `Artist ${i} — Track ${i}`,
        title: `Track ${i}`,
        artist: `Artist ${i}`,
      })
    }
    expect(reportSignature(report).length).toBe(8)
  })
})

describe('trackKey', () => {
  it('reads well enough to be shown to a person in an error', () => {
    expect(trackKey('Machine Head', 'Locust')).toBe('machine head :: locust')
  })
})