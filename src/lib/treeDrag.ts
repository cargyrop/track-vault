import type { Playlist, PlaylistFolder } from './types'

/** What is being dragged, and therefore what a drop would move. */
export interface Dragged {
  kind: 'folder' | 'playlist'
  id: number
  name: string
}

/**
 * The payload a tracklist row puts on the drag when it leaves the list.
 *
 * A MIME-ish type rather than the tree's internal ref, because the drag
 * crosses components: the tree cannot read a `dataTransfer` payload during
 * dragover (only on drop), but it *can* read the type list, which is what
 * tells a playlist row to light up. Only user playlists accept it — never
 * folders or All tracks.
 */
export const TRACK_DROP_TYPE = 'application/x-trackvault-track-id'

/** True when the pointer is carrying a track over a drop target. */
export function isTrackDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(TRACK_DROP_TYPE)
}

/** The track id a track-drag carries, or null when it carries none. */
export function readTrackDrop(e: React.DragEvent): number | null {
  try {
    const raw = e.dataTransfer.getData(TRACK_DROP_TYPE)
    const id = Number(raw)
    return Number.isFinite(id) ? id : null
  } catch {
    return null
  }
}

/**
 * True when `candidate` is `folderId` itself or somewhere beneath it.
 *
 * Walks the parent chain rather than recursing into children, so a cycle in a
 * hand-edited file cannot make this loop forever.
 */
export function isSelfOrBelow(
  folderId: number,
  candidate: number,
  folders: PlaylistFolder[],
): boolean {
  const seen = new Set<number>()
  let cursor: number | null = candidate
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === folderId) return true
    seen.add(cursor)
    cursor = folders.find((f) => f.id === cursor)?.parentId ?? null
  }
  return false
}

/**
 * Whether dropping `dragged` onto the folder `folderId` would actually move
 * anything.
 *
 * A drop that is refused here is simply not accepted by the browser, so the
 * pointer shows "no entry" rather than offering a drop that does nothing —
 * including the one case that would corrupt the tree, moving a folder inside a
 * folder it already contains.
 *
 * The kind check before the id comparison is load-bearing. Folders and playlists
 * have **independent** id sequences: folder 3 and playlist 3 routinely coexist.
 * Comparing the bare numbers (as this once did) made a playlist whose id matched
 * a folder's id undroppable into that folder, and made a folder drag look like
 * it was the same row as an unrelated playlist. Ids are therefore only ever
 * compared within one kind.
 */
export function folderAcceptsDrop(
  dragged: Dragged | null,
  folderId: number,
  folders: PlaylistFolder[],
  playlists: Playlist[],
): boolean {
  if (!dragged) return false
  if (dragged.kind === 'folder') {
    if (dragged.id === folderId) return false
    if (isSelfOrBelow(dragged.id, folderId, folders)) return false
    return folders.find((f) => f.id === dragged.id)?.parentId !== folderId
  }
  const playlist = playlists.find((p) => p.id === dragged.id)
  // A playlist that is not there (a stale drag) has nothing to move.
  if (!playlist) return false
  return playlist.folderId !== folderId
}
