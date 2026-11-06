import type { LibraryFilter, TrackWithSources } from './types'

/**
 * Whether one track passes the filters, decided from the track alone.
 *
 * Mirrors what the two stores do in `listTracks` — one case-insensitive
 * substring across title/artist/album, additive genres, exact artist/album,
 * a source-kind match and the live-slot flag — so a membership list (a folder
 * or playlist, which no store filters) can be narrowed with exactly the same
 * rules as the library list. `unfiledOnly` is deliberately absent: it needs
 * playlist membership, which a bare track cannot answer, so callers handle it
 * (every member of a folder/playlist view is filed by construction).
 *
 * Kept beside the stores rather than inside a component so the parity test in
 * `libraryFilters.test.ts` can hold it against both implementations: one rule,
 * three places, one test.
 */
export function matchesTrackFilter(
  track: TrackWithSources,
  filter: Pick<
    LibraryFilter,
    'search' | 'genres' | 'artist' | 'album' | 'sourceKind' | 'hasLiveSource'
  >,
): boolean {
  const search = filter.search.trim().toLowerCase()
  if (search) {
    const haystack = [track.title, track.artist, track.album ?? '']
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(search)) return false
  }
  if (filter.genres.length) {
    const selected = filter.genres.map((g) => g.toLowerCase())
    if (!track.genres.some((g) => selected.includes(g.toLowerCase()))) {
      return false
    }
  }
  if (
    filter.artist &&
    track.artist.toLowerCase() !== filter.artist.toLowerCase()
  ) {
    return false
  }
  if (
    filter.album &&
    (track.album ?? '').toLowerCase() !== filter.album.toLowerCase()
  ) {
    return false
  }
  if (
    filter.sourceKind &&
    !track.sources.some((s) => s.kind === filter.sourceKind)
  ) {
    return false
  }
  if (
    filter.hasLiveSource &&
    !track.sources.some((s) => s.role === 'live')
  ) {
    return false
  }
  return true
}
