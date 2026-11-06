// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ListHeader } from './ListHeader'
import type { TrackWithSources } from '../lib/types'

/**
 * The list's head: what it is, how long it runs, and the controls that start it.
 *
 * These assertions came from `TrackList.test.ts` when the control row moved out
 * of the rows and up into the header — the wording is shared with `PlayButton`,
 * and what is pinned here is that this caller hands it the right noun, count and
 * shuffle state.
 */

function track(id: number, title: string, duration: number | null): TrackWithSources {
  return {
    id,
    title,
    artist: 'Artist',
    album: null,
    coverUrl: null,
    year: null,
    musicbrainzRecordingId: null,
    info: null,
    lyrics: null,
    lyricsSource: null,
    duration,
    createdAt: '2026-01-01T00:00:00.000Z',
    genres: [],
    sources: [],
  }
}

type Props = Parameters<typeof ListHeader>[0]

function render(overrides: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    createElement(ListHeader, {
      title: 'Rainy afternoon',
      kind: 'playlist',
      tracks: [track(1, 'Sandrina', 284), track(2, 'Εσύ Εκεί', 258)],
      onPlayList: () => undefined,
      shuffle: false,
      repeat: false,
      onToggleShuffle: () => undefined,
      onToggleRepeat: () => undefined,
      djOn: false,
      onToggleDj: () => undefined,
      ...overrides,
    }),
  )
}

describe('ListHeader', () => {
  it('names the list, its kind, its size and its running time', () => {
    const html = render()
    expect(html).toContain('Rainy afternoon')
    expect(html).toContain('Playlist')
    expect(html).toContain('2 tracks')
    // 284 + 258 = 542 seconds, rounded to the minute.
    expect(html).toContain('9 min')
  })

  it('calls a folder a folder', () => {
    expect(render({ kind: 'folder', title: 'Metal' })).toContain('>Folder<')
  })

  it('gives the list one primary Play, in words', () => {
    const html = render()
    expect(html).toContain('aria-label="Play playlist"')
    expect(html).toContain('class="play-primary"')
    expect(html).toContain('>Play</span>')
    expect(html).toContain('title="Play this playlist from the top — 2 tracks"')
  })

  it('follows the shuffle in the promise it makes', () => {
    expect(render({ shuffle: true })).toContain(
      'title="Play this playlist shuffled — 2 tracks, opening on a random one"',
    )
  })

  it('reports its state through aria-pressed as well as its colour', () => {
    const off = render()
    expect(off).toContain('aria-label="Shuffle"')
    expect(off).toContain('aria-label="Repeat"')
    const on = render({ shuffle: true, repeat: true, djOn: true })
    expect(on.match(/aria-pressed="true"/g)).toHaveLength(3)
    expect(on).toContain('title="Shuffle on"')
    expect(on).toContain('title="Repeat on — the list starts again at the end"')
  })

  it('hides the DJ control when the caller withholds it', () => {
    const html = render({ onToggleDj: null })
    expect(html).not.toContain('aria-label="DJ"')
    expect(html).toContain('aria-label="Shuffle"')
  })

  it('says when nothing is in the list, and why Play is dead', () => {
    const html = render({ tracks: [], onPlayList: null })
    expect(html).toContain('title="This playlist is empty"')
    expect(html).toContain('disabled')
  })

  it('names the list that is actually playing when it is not this one', () => {
    const html = render({ playingFrom: 'Focus' })
    expect(html).toContain('Playing from Focus')
    expect(render()).not.toContain('Playing from')
  })

  it('marks the header when this list is the audible one', () => {
    expect(render({ isAudible: true })).toContain('playing now')
  })

  it('switches the primary Play button to Pause when this audible list is playing', () => {
    const playingHtml = render({ isAudible: true, isPlaying: true })
    expect(playingHtml).toContain('aria-label="Pause playlist"')
    expect(playingHtml).toContain('>Pause</span>')

    const pausedHtml = render({ isAudible: true, isPlaying: false })
    expect(pausedHtml).toContain('aria-label="Play playlist"')
    expect(pausedHtml).toContain('>Play</span>')
  })
})
