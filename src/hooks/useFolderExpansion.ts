import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlaylistFolder } from '../lib/types'

/**
 * Which folders in the playlist tree are open — held above the tree itself.
 *
 * The tree is unmounted whenever the reader switches to the Library or folds the
 * panel away, so folder state kept inside the component would quietly reset:
 * come back and every folder that was open is shut again. It lives here, beside
 * the app's other rail state, so a view switch leaves the tree as it was left.
 *
 * **Folders start closed.** The one folder that opens by itself is one that has
 * just been created — it is opened so the thing that was just made is visible to
 * drop playlists into. A folder id seen before is never opened that way, which is
 * what stops a folder the reader deliberately closed from springing open on the
 * next refresh or import.
 *
 * `folders` is `null` until the library has loaded. That is not the same as an
 * empty list of folders, and the difference matters: the store is empty for the
 * first render or two, and treating that as the tree's opening state would make
 * every folder "new" — and so open — the moment the library arrived.
 */
export function useFolderExpansion(folders: PlaylistFolder[] | null) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const seen = useRef<ReadonlySet<number> | null>(null)

  useEffect(() => {
    // Nothing to measure against until the library has loaded.
    if (folders === null) return
    const known = seen.current
    // The first sight of a loaded tree is not news: those folders were already
    // there, and nobody has asked for any of them to be open.
    if (known === null) {
      seen.current = new Set(folders.map((folder) => folder.id))
      return
    }
    const fresh = folders.filter((folder) => !known.has(folder.id))
    if (!fresh.length) return
    const nextSeen = new Set(known)
    for (const folder of fresh) nextSeen.add(folder.id)
    seen.current = nextSeen
    setExpanded((current) => {
      const next = new Set(current)
      for (const folder of fresh) next.add(folder.id)
      return next
    })
  }, [folders])

  /** Opens a folder without closing it — used when a drop lands inside it. */
  const openFolder = useCallback((id: number) => {
    setExpanded((current) => (current.has(id) ? current : new Set(current).add(id)))
  }, [])

  /** Clicking a folder row: open it if it is shut, close it if it is open. */
  const toggleFolder = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /**
   * Shuts every folder at once.
   *
   * A tree with forty playlists in six open folders is a tree you scroll; the
   * fastest way back to the two folders you actually use is to shut the lot and
   * open the one you want. `seen` is untouched on purpose: these folders are not
   * new, so nothing may spring open by itself afterwards.
   */
  const collapseAll = useCallback(() => {
    setExpanded((current) => (current.size ? new Set<number>() : current))
  }, [])

  return { expanded, toggleFolder, openFolder, collapseAll }
}
