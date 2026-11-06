import type { LibraryFilter } from './types'

/**
 * The filters that are switched on, as removable chips.
 *
 * The filter panel used to be a permanent band of every genre in the library,
 * which grows with the collection and shrinks the list it filters. The panel is
 * gone; what replaces it is one search box, a popover for the things you only
 * occasionally narrow by, and this: the filters that are actually on, named in
 * one line, each removable. A filter you cannot see is a filter you cannot
 * explain to yourself when the list comes back short.
 */

export interface FilterToken {
  /** Stable key for React and for the remove handler. */
  key: string
  label: string
  /** What clearing this token does. */
  clear: Partial<LibraryFilter>
}

export function filterTokens(filter: LibraryFilter): FilterToken[] {
  const tokens: FilterToken[] = []
  for (const genre of filter.genres) {
    tokens.push({
      key: `genre:${genre}`,
      label: genre,
      clear: { genres: filter.genres.filter((g) => g !== genre) },
    })
  }
  if (filter.artist) {
    tokens.push({
      key: 'artist',
      label: `Artist: ${filter.artist}`,
      clear: { artist: null },
    })
  }
  if (filter.album) {
    tokens.push({
      key: 'album',
      label: `Album: ${filter.album}`,
      clear: { album: null },
    })
  }
  if (filter.sourceKind) {
    tokens.push({
      key: 'sourceKind',
      label: `Link: ${filter.sourceKind}`,
      clear: { sourceKind: null },
    })
  }
  if (filter.unfiledOnly) {
    tokens.push({
      key: 'unfiledOnly',
      label: 'Not in a playlist',
      clear: { unfiledOnly: false },
    })
  }
  if (filter.hasLiveSource) {
    tokens.push({
      key: 'hasLiveSource',
      label: 'Has a live take',
      clear: { hasLiveSource: false },
    })
  }
  return tokens
}

/** How many filters are on, for the toolbar's badge. The search box has its own. */
export function filterCount(filter: LibraryFilter): number {
  return filterTokens(filter).length
}
