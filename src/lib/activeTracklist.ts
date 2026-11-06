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
