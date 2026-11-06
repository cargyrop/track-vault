import { describe, expect, it, vi } from 'vitest'
import {
  needsLyrics,
  runLyricsBackfill,
  type LyricsBackfillTrack,
} from './lyricsBackfill'
import type { LyricsResult } from './lyrics'

function track(overrides: Partial<LyricsBackfillTrack> = {}): LyricsBackfillTrack {
  return { id: 1, title: 'Locust', artist: 'Machine Head', lyrics: null, ...overrides }
}

function run(
  tracks: LyricsBackfillTrack[],
  opts: {
    lookup?: (query: { title: string; artist: string }) => Promise<LyricsResult | null>
    shouldStillApply?: (trackId: number) => boolean
    shouldStop?: () => boolean
  } = {},
) {
  const applied: Array<{ id: number; lyrics: string; source: string }> = []
  const progressed: Array<[number, number, string | null]> = []
  const promise = runLyricsBackfill({
    tracks,
    lookup:
      opts.lookup ??
      (async () => ({
        text: 'We\'re no strangers to love, you know the rules and so do I',
        source: 'LRCLIB',
      })),
    shouldStillApply: opts.shouldStillApply ?? (() => true),
    onApply: async (id, patch) => {
      applied.push({ id, lyrics: patch.lyrics, source: patch.lyricsSource })
    },
    shouldStop: opts.shouldStop ?? (() => false),
    onProgress: (done, total, current) => {
      progressed.push([done, total, current])
    },
    delayMs: 0,
  })
  return { promise, applied, progressed }
}

describe('needsLyrics', () => {
  it('wants words for a track with none', () => {
    expect(needsLyrics(track())).toBe(true)
  })

  it('walks past hand-pasted, looked-up, and whitespace-only lyrics alike', () => {
    expect(needsLyrics(track({ lyrics: 'pasted by hand' }))).toBe(false)
    expect(needsLyrics(track({ lyrics: '   ' }))).toBe(true)
  })

  it('does not ask the providers about a nameless track', () => {
    expect(needsLyrics(track({ title: '' }))).toBe(false)
    expect(needsLyrics(track({ artist: '' }))).toBe(false)
  })
})

describe('runLyricsBackfill', () => {
  it('fills blank tracks and reports the count', async () => {
    const { promise, applied } = run([track({ id: 1 }), track({ id: 2 })])
    const result = await promise
    expect(result).toEqual({ total: 2, filled: 2, skipped: 0, cancelled: false })
    expect(applied).toHaveLength(2)
    expect(applied[0].id).toBe(1)
    expect(applied[1].id).toBe(2)
    expect(applied[0].source).toBe('LRCLIB')
  })

  it('refuses a placeholder scrap instead of etching it into the library', async () => {
    const { promise, applied } = run([track({ id: 1 })], {
      lookup: async () => ({ text: 'probe', source: 'LRCLIB' }),
    })
    expect(await promise).toEqual({ total: 1, filled: 0, skipped: 1, cancelled: false })
    expect(applied).toEqual([])
  })

  it('never touches a track that already has words', async () => {
    const lookup = vi.fn(async () => ({
      text: 'A full verse of real words that easily clears the floor',
      source: 'LRCLIB',
    }))
    const { promise, applied } = run([track({ id: 1, lyrics: 'mine' })], {
      lookup,
    })
    expect(await promise).toEqual({ total: 0, filled: 0, skipped: 0, cancelled: false })
    expect(lookup).not.toHaveBeenCalled()
    expect(applied).toEqual([])
  })

  it('lets a paste that landed mid-run win over the lookup', async () => {
    const { promise, applied } = run([track({ id: 1 })], {
      shouldStillApply: (id) => id !== 1,
    })
    expect(await promise).toEqual({ total: 1, filled: 0, skipped: 1, cancelled: false })
    expect(applied).toEqual([])
  })

  it('counts a miss and a blank answer as skipped, not failed', async () => {
    const { promise, applied } = run(
      [track({ id: 1, title: 'Missing' }), track({ id: 2, title: 'Blank' })],
      {
        lookup: async ({ title }) =>
          title === 'Missing' ? null : { text: '   ', source: 'LRCLIB' },
      },
    )
    expect(await promise).toEqual({ total: 2, filled: 0, skipped: 2, cancelled: false })
    expect(applied).toEqual([])
  })

  it('survives a throwing lookup and stops when asked', async () => {
    const { promise, applied } = run(
      [track({ id: 1 }), track({ id: 2 }), track({ id: 3 })],
      {
        lookup: async () => {
          throw new Error('provider is down')
        },
        shouldStop: (() => {
          let calls = 0
          return () => ++calls > 2
        })(),
      },
    )
    const result = await promise
    expect(result.cancelled).toBe(true)
    expect(result.filled).toBe(0)
    expect(applied).toEqual([])
  })

  it('narrates the run for the progress line', async () => {
    const { promise, progressed } = run([
      track({ id: 1, title: 'Locust', artist: 'Machine Head' }),
    ])
    await promise
    expect(progressed[0]).toEqual([0, 1, 'Machine Head — Locust'])
    expect(progressed[progressed.length - 1]).toEqual([1, 1, null])
  })
})
