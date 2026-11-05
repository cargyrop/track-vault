// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AddTrackDialog } from './AddTrackDialog'
import type { Playlist } from '../lib/types'

/**
 * The new line on the add card: the playlists the track is filed into are picked
 * while it is being typed, so the dialog has to offer them. Rendered statically —
 * nothing here saves or looks anything up.
 */

function playlist(id: number, name: string): Playlist {
  return {
    id,
    name,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    trackCount: 0,
    folderId: null,
  }
}

function render(playlists: Playlist[]): string {
  return renderToStaticMarkup(
    createElement(AddTrackDialog, {
      open: true,
      onClose: () => undefined,
      onAdd: async () => 1,
      playlists,
      onAddToPlaylist: async () => undefined,
    }),
  )
}

describe('AddTrackDialog', () => {
  it('offers every playlist in a dropdown while the track is being added', () => {
    const html = render([playlist(1, 'Frostbitten North'), playlist(2, 'Olive & Overdrive')])
    // One dropdown, as the track card uses, rather than a chip per playlist —
    // a chip for every list would turn the dialog into a wall of names.
    expect(html).toContain('id="add-playlist"')
    expect(html).toContain('<option value="1">Frostbitten North</option>')
    expect(html).toContain('Olive &amp; Overdrive</option>')
    expect(html).toContain('Add to playlist…')
    // Nothing chosen to start: saving must not file a track by surprise.
    expect(html).not.toContain('card-playlists')
  })

  it('says where to create a playlist when there are none', () => {
    const html = render([])
    expect(html).toContain('No playlists yet')
    expect(html).toContain('Playlists tab')
  })
})
