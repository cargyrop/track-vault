import { describe, expect, it, vi } from 'vitest'
import {
  checkLinksOnce,
  findIssuesPlaylist,
  ISSUES_PLAYLIST,
  planLinkHealth,
  type LinkRemoval,
} from './linkHealth'
import type { LinkVerdict } from './linkProbe'
import type { Playlist, TrackWithSources } from './types'

function track(
  id: number,
  sources: Array<{ role: 'audio' | 'video' | 'live'; youtubeId: string }>,
): TrackWithSources {
  return {
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: null,
    coverUrl: null,
    year: null,
    musicbrainzRecordingId: null,
    info: null,
    lyrics: null,
    lyricsSource: null,
    duration: 200,
    createdAt: '2026-01-01T00:00:00.000Z',
    genres: [],
    sources: sources.map((s, i) => ({
      id: i + 1,
      trackId: id,
      youtubeId: s.youtubeId,
      url: `https://www.youtube.com/watch?v=${s.youtubeId}`,
      kind: 'official' as const,
      label: null,
      role: s.role,
      position: i,
    })),
  }
}

const plays: LinkVerdict = { status: 'plays' }
const gone = (detail = 'gone'): LinkVerdict => ({
  status: 'broken',
  problem: 'gone',
  detail,
})
const geo = (): LinkVerdict => ({
  status: 'broken',
  problem: 'geo-blocked',
  detail: 'blocked in this country',
})
const noEmbed = (): LinkVerdict => ({
  status: 'broken',
  problem: 'no-embed',
  detail: 'embedding is off',
})
const unknown = (): LinkVerdict => ({ status: 'unknown', detail: 'timeout' })

function verdicts(entries: Record<string, LinkVerdict>): Map<string, LinkVerdict> {
  return new Map(Object.entries(entries))
}

function rolesOf(removals: LinkRemoval[]): Array<[number, string]> {
  return removals.map((r) => [r.trackId, r.role])
}

describe('planLinkHealth', () => {
  it('removes every link YouTube says will not play here', () => {
    const plan = planLinkHealth(
      [track(1, [{ role: 'audio', youtubeId: 'a' }])],
      verdicts({ a: gone('YouTube has no video at this link.') }),
    )
    expect(rolesOf(plan.removals)).toEqual([[1, 'audio']])
    expect(plan.removals[0].problem).toBe('gone')
    expect(plan.removals[0].label).toBe('Artist — Song 1')
  })

  it('treats a geo block and a switched-off embed as removals too', () => {
    const plan = planLinkHealth(
      [
        track(1, [
          { role: 'audio', youtubeId: 'geo' },
          { role: 'video', youtubeId: 'noembed' },
        ]),
      ],
      verdicts({ geo: geo(), noembed: noEmbed() }),
    )
    expect(plan.removals.map((r) => r.problem)).toEqual([
      'geo-blocked',
      'no-embed',
    ])
  })

  it('cuts only the dead link when the other slot still plays', () => {
    const plan = planLinkHealth(
      [
        track(1, [
          { role: 'audio', youtubeId: 'fine' },
          { role: 'video', youtubeId: 'deadclip' },
        ]),
      ],
      verdicts({ fine: plays, deadclip: gone() }),
    )
    expect(rolesOf(plan.removals)).toEqual([[1, 'video']])
    // A Main is left, so the track still streams and is not an Issue.
    expect(plan.issuesTrackIds).toEqual([])
  })

  it('keeps a track with a clip when its Main is cut', () => {
    const plan = planLinkHealth(
      [
        track(1, [
          { role: 'audio', youtubeId: 'deadmain' },
          { role: 'video', youtubeId: 'clip' },
        ]),
      ],
      verdicts({ deadmain: geo(), clip: plays }),
    )
    expect(rolesOf(plan.removals)).toEqual([[1, 'audio']])
    expect(plan.issuesTrackIds).toEqual([])
  })

  it('files a track that loses both its Main and its clip', () => {
    const plan = planLinkHealth(
      [
        track(1, [
          { role: 'audio', youtubeId: 'm' },
          { role: 'video', youtubeId: 'v' },
        ]),
      ],
      verdicts({ m: gone(), v: gone() }),
    )
    expect(plan.removals).toHaveLength(2)
    expect(plan.issuesTrackIds).toEqual([1])
  })

  it('files a track whose only link was dead, and when a live take survives', () => {
    const single = planLinkHealth(
      [track(1, [{ role: 'audio', youtubeId: 'm' }])],
      verdicts({ m: gone() }),
    )
    expect(single.issuesTrackIds).toEqual([1])

    // A live take is not what Main or the clip view plays, so it does not save
    // the track from Issues.
    const withLive = planLinkHealth(
      [
        track(2, [
          { role: 'audio', youtubeId: 'm' },
          { role: 'live', youtubeId: 'l' },
        ]),
      ],
      verdicts({ m: gone(), l: plays }),
    )
    expect(withLive.issuesTrackIds).toEqual([2])
  })

  it('never cuts an unknown link, and counts what it could not ask', () => {
    const plan = planLinkHealth(
      [track(1, [{ role: 'audio', youtubeId: 'flaky' }])],
      verdicts({ flaky: unknown() }),
    )
    expect(plan.removals).toEqual([])
    expect(plan.unknown).toBe(1)
    expect(plan.plays).toBe(0)
    // Nothing was cut, so the track keeps a Main and is not an Issue.
    expect(plan.issuesTrackIds).toEqual([])
  })

  it('leaves links the run never asked about alone', () => {
    const plan = planLinkHealth(
      [track(1, [{ role: 'audio', youtubeId: 'never-asked' }])],
      verdicts({}),
    )
    expect(plan.removals).toEqual([])
    expect(plan.unknown).toBe(0)
    expect(plan.issuesTrackIds).toEqual([])
  })

  it('counts the links that play', () => {
    const plan = planLinkHealth(
      [
        track(1, [
          { role: 'audio', youtubeId: 'a' },
          { role: 'live', youtubeId: 'b' },
        ]),
      ],
      verdicts({ a: plays, b: plays }),
    )
    expect(plan.plays).toBe(2)
    expect(plan.removals).toEqual([])
  })
})

describe('findIssuesPlaylist', () => {
  const playlist = (over: Partial<Playlist>): Playlist => ({
    id: 1,
    name: 'Issues',
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    trackCount: 0,
    folderId: null,
    ...over,
  })

  it('finds the top-level playlist whatever its capitalisation', () => {
    expect(findIssuesPlaylist([playlist({ name: ' issues ' })])?.id).toBe(1)
    expect(findIssuesPlaylist([playlist({ name: 'ISSUES' })])?.id).toBe(1)
  })

  it('ignores one nested in a folder, which was made for something else', () => {
    expect(findIssuesPlaylist([playlist({ folderId: 4 })])).toBeNull()
  })

  it('returns null when there is none', () => {
    expect(findIssuesPlaylist([playlist({ name: 'Road trip' })])).toBeNull()
    expect(ISSUES_PLAYLIST).toBe('Issues')
  })
})

describe('checkLinksOnce', () => {
  it('asks once per distinct link and keeps every verdict', async () => {
    const probe = vi.fn(async (id: string) => (id === 'dead' ? gone() : plays))
    const progress: Array<[number, number]> = []
    const result = await checkLinksOnce(['dead', 'dead', 'ok'], probe, {
      concurrency: 2,
      onProgress: (d, t) => progress.push([d, t]),
    })
    expect(result.get('dead')?.status).toBe('broken')
    expect(result.get('ok')).toEqual(plays)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(progress.at(-1)).toEqual([2, 2])
  })

  it('treats a throwing probe as unknown, never broken', async () => {
    const result = await checkLinksOnce(['x'], async () => {
      throw new Error('network down')
    })
    expect(result.get('x')?.status).toBe('unknown')
  })

  it('stops early when aborted', async () => {
    const controller = new AbortController()
    const probe = vi.fn(async () => {
      controller.abort()
      return plays
    })
    const result = await checkLinksOnce(['a', 'b', 'c'], probe, {
      signal: controller.signal,
      concurrency: 1,
    })
    expect(result.size).toBe(0)
    expect(probe.mock.calls.length).toBeLessThan(3)
  })
})
