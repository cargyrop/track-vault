// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrackList } from './TrackList'
import type { TrackWithSources } from '../lib/types'

/**
 * The row's contract.
 *
 * It used to be: hover the number to reveal a play mark, or click the line to
 * open the card. That made the commonest action in a music app exist only under
 * a mouse and only for someone who already knew it was there, and it left the
 * card — where a track is edited — reachable only by the same gesture that
 * hinted at playing. The row is now one button that plays, with the card behind
 * an explicit ⋯.
 */

function track(id: number, title: string, extras: Partial<TrackWithSources> = {}): TrackWithSources {
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
    duration: 284,
    createdAt: '2026-01-01T00:00:00.000Z',
    genres: [],
    sources: [
      {
        id: 1,
        trackId: id,
        position: 0,
        youtubeId: 'dQw4w9WgXcQ',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        kind: 'official',
        label: null,
        role: 'audio',
      },
    ],
    ...extras,
  }
}

function render(overrides: Partial<Parameters<typeof TrackList>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TrackList, {
      tracks: [track(1, 'Sandrina'), track(2, 'Εσύ Εκεί')],
      playingId: null,
      onPlay: () => undefined,
      onOpenCard: () => undefined,
      onDelete: () => undefined,
      playlists: [],
      onAddToPlaylist: () => undefined,
      ...overrides,
    }),
  )
}

describe('TrackList rows', () => {
  it('makes the whole row the play button, named for assistive tech', () => {
    const html = render()
    expect(html).toContain('aria-label="Play Sandrina by Artist."')
    // The old hover-only play mark is gone: one button per row, plus the menu.
    expect(html).not.toContain('row-play')
    expect(html).not.toContain('row-num')
  })

  it('keeps the row number as position, not as a control', () => {
    const html = render()
    expect(html).toContain('class="num">1</span>')
    expect(html).toContain('class="num">2</span>')
  })

  it('marks the playing row with an equaliser instead of its number', () => {
    const html = render({ playingId: 2 })
    expect(html).toContain('playing')
    expect(html).toContain('class="eq"')
  })

  it('puts the track card behind its own button', () => {
    const html = render()
    expect(html).toContain('aria-label="More actions for Sandrina"')
  })

  it('shows the artist and the album under the title', () => {
    const html = render({ tracks: [track(1, 'Sandrina', { album: 'Low' })] })
    // The album is its own element so a phone row can drop it; on a wide row the
    // two read as one line.
    expect(html).toContain('line-artist')
    expect(html).toContain(' · Low')
  })

  it('warns in the row when a track has nothing playable', () => {
    const html = render({ tracks: [track(1, 'Sandrina', { sources: [] })] })
    expect(html).toContain('No playable link yet')
    expect(html).toContain('needs-link')
  })

  it('says so when there is nothing to show, in the caller’s words', () => {
    expect(render({ tracks: [], emptyLabel: 'No tracks match these filters.' })).toContain(
      'No tracks match these filters.',
    )
  })
})
