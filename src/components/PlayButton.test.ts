// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlayButton } from './PlayButton'

/**
 * The one Play button, in the two places it appears.
 *
 * The info panel and the tracklist show the same control, so what is pinned
 * here is the wording both of them inherit — including the promise about the
 * shuffle. A reworded copy in one of the two callers is what this file exists to
 * catch; `TrackList.test.ts` and `PlaylistInfo.test.ts` check that each caller
 * hands it the right count and shuffle state.
 */

type Props = Parameters<typeof PlayButton>[0]

function render(overrides: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    createElement(PlayButton, {
      noun: 'list',
      onPlay: () => undefined,
      count: 10,
      shuffled: false,
      ...overrides,
    }),
  )
}

describe('PlayButton', () => {
  it('names what it plays for assistive tech, with no words of its own', () => {
    expect(render()).toContain('aria-label="Play list"')
    expect(render({ noun: 'playlist' })).toContain('aria-label="Play playlist"')
    expect(render()).not.toContain('>Play<')
    expect(render()).toContain('class="tool-btn"')
  })

  it('says whether it opens at the top or on a drawn track', () => {
    expect(render()).toContain('title="Play this list from the top — 10 tracks"')
    expect(render({ shuffled: true })).toContain(
      'title="Play this list shuffled — 10 tracks, opening on a random one"',
    )
    expect(render({ noun: 'playlist' })).toContain(
      'title="Play this playlist from the top — 10 tracks"',
    )
    expect(render({ noun: 'playlist', shuffled: true })).toContain(
      'title="Play this playlist shuffled — 10 tracks, opening on a random one"',
    )
  })

  it('counts one track as a track, not as tracks', () => {
    expect(render({ count: 1 })).toContain('— 1 track"')
    expect(render({ count: 1 })).not.toContain('1 tracks')
    expect(render({ count: 0 })).toContain('— 0 tracks"')
  })

  it('stays in place, disabled and explained, when there is nothing to play', () => {
    const html = render({ onPlay: null })
    expect(html).toContain('disabled')
    expect(html).toContain('title="This list is empty"')
    expect(render({ noun: 'playlist', onPlay: null })).toContain(
      'title="This playlist is empty"',
    )
  })
})
