import type { LibraryFilter } from './types'
import type { PlaylistSelection } from '../hooks/useLibrary'

/**
 * A frozen copy of the list that was playing when Play was pressed.
 *
 * Browsing the tree or typing in the filters changes what is *shown* (`rows`
 * in App), but playback walks this snapshot instead — so leaving the list
 * that started the music never changes what plays next. Restoring it means
 * putting the selection and the filter back the way they were when Play was
 * pressed, which is why both are kept beside the track ids.
 */
export interface ActiveTracklist {
  selection: PlaylistSelection
  filter: LibraryFilter
  /** Track ids in the order they were shown when Play was pressed. */
  trackIds: number[]
  /** The list's name at Play time, kept as a fallback if it is renamed away. */
  title: string
}

/** True when no filter narrows the list — nothing to name after the title. */
export function isFilterEmpty(filter: LibraryFilter): boolean {
  return (
    !filter.search.trim() &&
    filter.genres.length === 0 &&
    !filter.artist &&
    !filter.album &&
    !filter.sourceKind &&
    !filter.unfiledOnly &&
    !filter.hasLiveSource
  )
}

/**
 * Short human summary of the filters, for "with …" after the list's name.
 *
 * Kept here rather than in the component so the wording is tested in one
 * place: `Now playing Jazz nights with "miles", genres bop, not in a
 * playlist`. Returns null when no filter is set.
 */
export function describeFilter(filter: LibraryFilter): string | null {
  const parts: string[] = []
  const search = filter.search.trim()
  if (search) parts.push(`“${search}”`)
  if (filter.genres.length) parts.push(`genre${filter.genres.length === 1 ? '' : 's'} ${filter.genres.join(', ')}`)
  if (filter.artist) parts.push(`artist ${filter.artist}`)
  if (filter.album) parts.push(`album ${filter.album}`)
  if (filter.sourceKind) parts.push(`${filter.sourceKind} sources`)
  if (filter.unfiledOnly) parts.push('not in a playlist')
  if (filter.hasLiveSource) parts.push('has live take')
  if (!parts.length) return null
  return parts.join(', ')
}

/**
 * The clickable "Now playing …" button text.
 *
 * Always names the list; when filters were set it says only "with filters"
 * so the button stays on one truncated line no matter how many filters were
 * on. The full detail lives in the tooltip (`describeActiveTracklistFull`).
 */
export function describeActiveTracklist(active: ActiveTracklist): string {
  return isFilterEmpty(active.filter)
    ? `Now playing ${active.title}`
    : `Now playing ${active.title} with filters`
}

/**
 * The tooltip for the button: the list's full name with every filter named,
 * so a long playlist name or a stack of filters can still be read in full
 * on hover. Falls back to the short line when nothing was filtered.
 */
export function describeActiveTracklistFull(active: ActiveTracklist): string {
  const filters = describeFilter(active.filter)
  return filters
    ? `Now playing ${active.title} with ${filters}`
    : `Now playing ${active.title}`
}
