/**
 * Ordering the rows of a list.
 *
 * The library is metadata-rich — title, artist, album, year, added date, length
 * — and until now the only order was "as stored", so a playlist could not be
 * read by artist and a 1,700-track library could not be walked by album. The
 * rule lives here rather than in the list because it is a pure decision about
 * data, and because the list must be able to sort *without* touching what
 * plays: the audible list is a snapshot taken at Play time.
 */

export type SortKey =
  | 'manual'
  | 'title'
  | 'artist'
  | 'album'
  | 'year'
  | 'added'
  | 'duration'

export type SortDirection = 'asc' | 'desc'

export interface SortState {
  key: SortKey
  dir: SortDirection
}

/** A playlist's own order: the one the reader dragged into place. */
export const DEFAULT_SORT: SortState = { key: 'manual', dir: 'asc' }

export const SORT_LABELS: Record<SortKey, string> = {
  manual: 'Playlist order',
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  year: 'Year',
  added: 'Date added',
  duration: 'Length',
}

/** The keys a list offers, in the order the menu shows them. */
export const SORT_KEYS: SortKey[] = [
  'manual',
  'title',
  'artist',
  'album',
  'year',
  'added',
  'duration',
]

export interface SortableTrack {
  title: string
  artist: string
  album: string | null
  year: number | null
  duration: number | null
  createdAt: string
}

function valueOf(track: SortableTrack, key: SortKey): string | number | null {
  switch (key) {
    case 'title':
      return track.title
    case 'artist':
      return track.artist
    case 'album':
      return track.album
    case 'year':
      return track.year
    case 'duration':
      return track.duration
    case 'added':
      return track.createdAt
    case 'manual':
    default:
      return null
  }
}

/**
 * Sorts a copy of the rows.
 *
 * Two decisions worth keeping: the input is never mutated (the list is state),
 * and **a track with nothing in the sorted field is always last**, whichever
 * direction is asked for. An unknown length or a missing year is not "smaller
 * than 3:33", it is unknown, and sorting it to the top of a descending list is
 * how a column of dashes ends up in front of the reader.
 */
export function sortTracks<T extends SortableTrack>(
  tracks: readonly T[],
  sort: SortState,
): T[] {
  if (sort.key === 'manual') return [...tracks]
  const sign = sort.dir === 'desc' ? -1 : 1
  return [...tracks].sort((a, b) => {
    const left = valueOf(a, sort.key)
    const right = valueOf(b, sort.key)
    const leftEmpty = left === null || left === ''
    const rightEmpty = right === null || right === ''
    if (leftEmpty && rightEmpty) return 0
    if (leftEmpty) return 1
    if (rightEmpty) return -1
    if (typeof left === 'number' && typeof right === 'number') {
      return (left - right) * sign
    }
    const compared = String(left).localeCompare(String(right), undefined, {
      sensitivity: 'base',
      numeric: true,
    })
    return compared * sign
  })
}

/** True when the order is not the playlist's own, for the toolbar's badge. */
export function isSorted(sort: SortState): boolean {
  return sort.key !== 'manual'
}
