import { useRef, useState } from 'react'
import type { PlaylistSelection } from '../hooks/useLibrary'
import type { Playlist, PlaylistFolder } from '../lib/types'
import {
  folderAcceptsDrop,
  isTrackDrag,
  readTrackDrop,
  type Dragged,
} from '../lib/treeDrag'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  folders: PlaylistFolder[]
  playlists: Playlist[]
  selection: PlaylistSelection
  /** Every track in the library, for the All tracks row's count. */
  totalCount: number
  /**
   * The folders that are open, and how they change.
   *
   * Both are handed in rather than held here because the tree is unmounted
   * whenever the reader looks at the Library or folds the panel away: open
   * folders kept inside it would all be shut again on the way back. The rule
   * itself — folders start closed, a new one opens — lives in
   * `hooks/useFolderExpansion`, where it can be tested without a tree.
   */
  expanded: ReadonlySet<number>
  onToggleFolder: (folderId: number) => void
  /** Opens a folder without closing it — what a drop inside one has to do. */
  onOpenFolder: (folderId: number) => void
  /** Opens every folder at once — the other half of the same button. */
  onExpandAll: () => void
  /** Shuts every folder at once. */
  onCollapseAll: () => void
  onSelect: (selection: PlaylistSelection) => void
  onCreateFolder: (name: string, parentId: number | null) => void
  onCreatePlaylist: (name: string, folderId: number | null) => void
  onDeleteFolder: (id: number) => void
  onDeletePlaylist: (id: number) => void
  onRenameFolder: (id: number, name: string) => void
  onRenamePlaylist: (id: number, name: string) => void
  /** Moves a playlist into a folder, or out to the top level with `null`. */
  onMovePlaylist: (playlistId: number, folderId: number | null) => void
  /** Re-parents a folder. A move inside itself is refused by the store. */
  onMoveFolder: (folderId: number, parentId: number | null) => void
  /**
   * Files a dragged track into a user playlist.
   *
   * Playlists only: a folder is a grouping, not a list of tracks, and All
   * tracks is a view, not a destination — so only a playlist accepts the drop.
   */
  onAddTrackToPlaylist: (playlistId: number, trackId: number) => void
}

type Creating = 'folder' | 'playlist' | null

/** What a right-click is about, so the menu can name it and act on it. */
type MenuTarget =
  | { kind: 'folder'; id: number; name: string }
  | { kind: 'playlist'; id: number; name: string }

/**
 * A drop target: a folder row, or the strip that means the top level.
 *
 * A folder is named with its kind as well as its id, because folders and
 * playlists have independent id sequences — folder 3 and playlist 3 coexist —
 * and a bare number could not tell the two apart. That ambiguity is exactly what
 * lit up an unrelated playlist whenever a folder was the drop target.
 */
type DropTarget =
  | { kind: 'folder'; id: number }
  | { kind: 'playlist-tracks'; id: number }
  | 'root'
  | null

/** How far one level of nesting moves a row to the right. */
const INDENT = 16

/**
 * The library tree: All tracks, then nested folders of user playlists.
 *
 * Folders and playlists are drawn from the same row at the same indentation, so
 * a playlist sitting beside a folder lines up with it instead of floating a few
 * pixels off — which is the only way a tree reads as a tree.
 *
 * There is no disclosure arrow. A folder is opened by clicking its name (which
 * also selects it), and an open folder keeps a blue icon — the row itself
 * takes no highlight, because exactly one row is selected at a time and an
 * open folder that is not the selection must not read as a second one.
 * Everything a row can do beyond being clicked lives in its right-click
 * menu — rename, delete — which is why neither the ✕ nor a rename affordance
 * takes up space on every row.
 *
 * A track dragged out of the tracklist lands on a user playlist row, which
 * lights up under the pointer; folders and All tracks never do, so the
 * highlight is always the answer to "where will this land".
 *
 * Folders start closed, and this is only the rows: the panel around them (the
 * header that folds it away, the height it may take) belongs to the app, and so
 * does the list of open folders, which therefore survives a look elsewhere.
 */
export function PlaylistTree({
  folders,
  playlists,
  selection,
  totalCount,
  expanded,
  onToggleFolder,
  onOpenFolder,
  onExpandAll,
  onCollapseAll,
  onSelect,
  onCreateFolder,
  onCreatePlaylist,
  onDeleteFolder,
  onDeletePlaylist,
  onRenameFolder,
  onRenamePlaylist,
  onMovePlaylist,
  onMoveFolder,
  onAddTrackToPlaylist,
}: Props) {
  const [creating, setCreating] = useState<Creating>(null)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<MenuTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(
    null,
  )
  // Held in a ref as well as in state: `dataTransfer` cannot be read during
  // dragover (only on drop), and dragover is exactly where we need to know
  // whether the row under the pointer is a legal target.
  const dragRef = useRef<Dragged | null>(null)
  const [dragging, setDragging] = useState<Dragged | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget>(null)

  const targetFolder =
    selection.kind === 'folder' ? selection.folderId : null

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed) {
      if (creating === 'folder') onCreateFolder(trimmed, targetFolder)
      else if (creating === 'playlist') onCreatePlaylist(trimmed, targetFolder)
    }
    setName('')
    setCreating(null)
  }

  /** How many playlists live in a folder and everything under it. */
  const countInFolder = (folderId: number): number => {
    const ids = new Set<number>([folderId])
    let grew = true
    while (grew) {
      grew = false
      for (const folder of folders) {
        if (
          folder.parentId !== null &&
          ids.has(folder.parentId) &&
          !ids.has(folder.id)
        ) {
          ids.add(folder.id)
          grew = true
        }
      }
    }
    return playlists.filter((p) => p.folderId !== null && ids.has(p.folderId))
      .length
  }

  const resetDrag = () => {
    dragRef.current = null
    setDragging(null)
    setDropTarget(null)
  }

  /** True when this folder is the row the current drag would drop into. */
  const isDropTarget = (folderId: number): boolean =>
    dropTarget !== null &&
    dropTarget !== 'root' &&
    dropTarget.kind === 'folder' &&
    dropTarget.id === folderId

  /** True when this playlist is about to receive a dragged track. */
  const isTrackTarget = (playlistId: number): boolean =>
    dropTarget !== null &&
    dropTarget !== 'root' &&
    dropTarget.kind === 'playlist-tracks' &&
    dropTarget.id === playlistId

  const clearTarget = (id: number) =>
    setDropTarget((current) =>
      current !== null && current !== 'root' && current.id === id ? null : current,
    )

  const startDrag = (e: React.DragEvent, payload: Dragged) => {
    dragRef.current = payload
    setDragging(payload)
    e.dataTransfer.effectAllowed = 'move'
    // Chromium will not begin a drag that has no data attached to it.
    e.dataTransfer.setData('text/plain', payload.name)
  }

  /**
   * Whether dropping on this folder would actually move anything.
   *
   * The rule itself lives in `lib/treeDrag.ts`, where it is unit-tested: it is
   * the one place that knows folder ids and playlist ids are separate
   * sequences, so an id must never be compared across the two.
   */
  const canDropInto = (folderId: number): boolean =>
    folderAcceptsDrop(dragRef.current, folderId, folders, playlists)

  const dropOnFolder = (e: React.DragEvent, folderId: number) => {
    e.preventDefault()
    e.stopPropagation()
    const dragged = dragRef.current
    // The same question dragover asked, asked again: a drop can arrive without
    // an accepted dragover, and moving a folder into its own descendant is the
    // one move that would corrupt the tree. The store refuses it too; refusing
    // it here means the person never sees an error for something they were not
    // offered in the first place.
    const allowed = canDropInto(folderId)
    resetDrag()
    if (!dragged || !allowed) return
    if (dragged.kind === 'playlist') onMovePlaylist(dragged.id, folderId)
    else onMoveFolder(dragged.id, folderId)
    // Opened on drop, so the thing that just moved is visible where it went.
    onOpenFolder(folderId)
  }

  const dropOnRoot = (e: React.DragEvent) => {
    e.preventDefault()
    const dragged = dragRef.current
    resetDrag()
    if (!dragged) return
    if (dragged.kind === 'playlist') onMovePlaylist(dragged.id, null)
    else onMoveFolder(dragged.id, null)
  }

  /** Whether the thing being dragged is already at the top level. */
  const draggedAtRoot = (): boolean => {
    if (!dragging) return true
    if (dragging.kind === 'folder') {
      return folders.find((f) => f.id === dragging.id)?.parentId === null
    }
    return playlists.find((p) => p.id === dragging.id)?.folderId === null
  }

  const commitRename = () => {
    const target = renaming
    if (!target) return
    setRenaming(null)
    const trimmed = draft.trim()
    if (!trimmed || trimmed === target.name) return
    if (target.kind === 'folder') onRenameFolder(target.id, trimmed)
    else onRenamePlaylist(target.id, trimmed)
  }

  const startRename = (target: MenuTarget) => {
    setDraft(target.name)
    setRenaming(target)
  }

  /**
   * Whether this row is the one being renamed.
   *
   * Folders and playlists have independent id sequences, so id `1` is a valid
   * folder *and* playlist at the same time — comparing the id alone would take
   * the drag handle off an unrelated row.
   */
  const isRenaming = (kind: MenuTarget['kind'], id: number): boolean =>
    renaming !== null && renaming.kind === kind && renaming.id === id

  const askDelete = (target: MenuTarget) => {
    if (target.kind === 'folder') {
      if (
        window.confirm(
          `Delete the folder "${target.name}"? Playlists inside it are kept and moved to the top level.`,
        )
      ) {
        onDeleteFolder(target.id)
      }
      return
    }
    if (window.confirm(`Delete the playlist "${target.name}"?`)) {
      onDeletePlaylist(target.id)
    }
  }

  const menuItems = (target: MenuTarget): ContextMenuItem[] => [
    {
      key: 'rename',
      label: 'Rename…',
      group: target.kind === 'folder' ? 'Folder' : 'Playlist',
      onSelect: () => startRename(target),
    },
    {
      key: 'delete',
      label: target.kind === 'folder' ? 'Delete folder' : 'Delete playlist',
      danger: true,
      // The wording matches what the confirmation goes on to say, so the menu
      // does not promise to destroy the playlists the dialog then keeps.
      onSelect: () => askDelete(target),
    },
  ]

  /** The name area of a row: a label, or an input while it is being renamed. */
  const nameCell = (
    target: MenuTarget,
    icon: React.ReactNode,
    count: number,
    onActivate: () => void,
    expandedNow?: boolean,
  ) => {
    if (isRenaming(target.kind, target.id)) {
      return (
        <input
          className="tree-rename"
          autoFocus
          value={draft}
          aria-label={`Rename ${target.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitRename()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setRenaming(null)
            }
          }}
          onBlur={commitRename}
        />
      )
    }
    return (
      <button
        type="button"
        className="tree-label"
        onClick={onActivate}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, target })
        }}
        title={
          expandedNow === undefined
            ? target.name
            : `${target.name} — ${expandedNow ? 'click to close' : 'click to open'}`
        }
        aria-expanded={expandedNow}
      >
        {icon}
        <span className="tree-name">{target.name}</span>
        <span className="tree-count">{count}</span>
      </button>
    )
  }

  const renderFolder = (folder: PlaylistFolder, depth: number) => {
    const children = folders.filter((f) => f.parentId === folder.id)
    const owned = playlists.filter((p) => p.folderId === folder.id)
    const open = expanded.has(folder.id)
    const selected =
      selection.kind === 'folder' && selection.folderId === folder.id
    const target: MenuTarget = {
      kind: 'folder',
      id: folder.id,
      name: folder.name,
    }
    const className = [
      'tree-row',
      selected ? 'selected' : '',
      open ? 'open' : '',
      isDropTarget(folder.id) ? 'drop' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <li key={`folder-${folder.id}`} className="tree-branch">
        <div
          className={className}
          style={{ paddingLeft: 8 + depth * INDENT }}
          draggable={!isRenaming('folder', folder.id)}
          onDragStart={(e) =>
            startDrag(e, { kind: 'folder', id: folder.id, name: folder.name })
          }
          onDragEnd={resetDrag}
          onDragOver={(e) => {
            if (!canDropInto(folder.id)) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            setDropTarget({ kind: 'folder', id: folder.id })
          }}
          onDragLeave={() => clearTarget(folder.id)}
          onDrop={(e) => dropOnFolder(e, folder.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, target })
          }}
        >
          {nameCell(
            target,
            <FolderIcon />,
            countInFolder(folder.id),
            () => {
              onSelect({ kind: 'folder', folderId: folder.id })
              // Clicking a folder is also how it opens, now that there is no
              // arrow to press.
              onToggleFolder(folder.id)
            },
            open,
          )}
        </div>

        {open && (
          <ul className="tree-children">
            {children.map((child) => renderFolder(child, depth + 1))}
            {owned.map((playlist) => renderPlaylist(playlist, depth + 1))}
            {children.length === 0 && owned.length === 0 && (
              <li>
                <p
                  className="tree-empty"
                  style={{ paddingLeft: 8 + (depth + 1) * INDENT }}
                >
                  Empty folder
                </p>
              </li>
            )}
          </ul>
        )}
      </li>
    )
  }

  const renderPlaylist = (playlist: Playlist, depth: number) => {
    const target: MenuTarget = {
      kind: 'playlist',
      id: playlist.id,
      name: playlist.name,
    }
    const selected =
      selection.kind === 'playlist' && selection.playlistId === playlist.id
    const className = [
      'tree-row',
      selected ? 'selected' : '',
      isTrackTarget(playlist.id) ? 'drop' : '',
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <li key={`playlist-${playlist.id}`}>
        <div
          className={className}
          style={{ paddingLeft: 8 + depth * INDENT }}
          draggable={!isRenaming('playlist', playlist.id)}
          onDragStart={(e) =>
            startDrag(e, {
              kind: 'playlist',
              id: playlist.id,
              name: playlist.name,
            })
          }
          onDragEnd={resetDrag}
          // A track dragged out of the tracklist lands here. Folders
          // deliberately have no such handler: a folder is a grouping, not a
          // list of tracks, so there is nothing to file the track into.
          onDragOver={(e) => {
            if (!isTrackDrag(e)) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'copy'
            setDropTarget({ kind: 'playlist-tracks', id: playlist.id })
          }}
          onDragLeave={() => clearTarget(playlist.id)}
          onDrop={(e) => {
            if (!isTrackDrag(e)) return
            e.preventDefault()
            e.stopPropagation()
            const trackId = readTrackDrop(e)
            setDropTarget(null)
            if (trackId !== null) onAddTrackToPlaylist(playlist.id, trackId)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, target })
          }}
        >
          {nameCell(target, <ListIcon />, playlist.trackCount, () =>
            onSelect({ kind: 'playlist', playlistId: playlist.id }),
          )}
        </div>
      </li>
    )
  }

  const rootFolders = folders.filter((f) => f.parentId === null)
  const rootPlaylists = playlists.filter((p) => p.folderId === null)

  return (
    <div className={dragging ? 'playlist-tree dragging' : 'playlist-tree'}>
      {/* Making folders and playlists, and shutting them again, lives in the
          body with the rows they act on — not in the panel's header, which is
          one collapse control and nothing else (the app draws it, the same one
          the filters have). The three buttons are one size and one shape, and
          the shut-everything button sits last because it is the one you reach
          for when the list has got away from you. */}
      <div className="tree-tool-actions">
        <button
          type="button"
          className={creating === 'folder' ? 'tool-btn on' : 'tool-btn'}
          aria-label="Create folder"
          title={
            targetFolder === null
              ? 'New folder at the top level'
              : 'New folder inside the selected folder'
          }
          onClick={() => {
            setCreating(creating === 'folder' ? null : 'folder')
            setName('')
          }}
        >
          <FolderPlusIcon />
        </button>
        <button
          type="button"
          className={creating === 'playlist' ? 'tool-btn on' : 'tool-btn'}
          aria-label="Create playlist"
          title={
            targetFolder === null
              ? 'New playlist at the top level'
              : 'New playlist inside the selected folder'
          }
          onClick={() => {
            setCreating(creating === 'playlist' ? null : 'playlist')
            setName('')
          }}
        >
          <ListPlusIcon />
        </button>
        {/* One button for both directions: it shuts everything while anything is
            open, and opens everything while nothing is. The icon says which of
            the two the next press will do, so the button never lies about it. */}
        <button
          type="button"
          className="tool-btn"
          aria-label={expanded.size ? 'Collapse all folders' : 'Expand all folders'}
          title={expanded.size ? 'Close every folder' : 'Open every folder'}
          disabled={folders.length === 0}
          onClick={expanded.size ? onCollapseAll : onExpandAll}
        >
          {expanded.size ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      </div>

      {creating !== null && (
        <div className="tree-new">
          <input
            autoFocus
            placeholder={creating === 'folder' ? 'Folder name' : 'Playlist name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              } else if (e.key === 'Escape') {
                setCreating(null)
                setName('')
              }
            }}
          />
          <button
            type="button"
            className="ghost-btn"
            onClick={submit}
            disabled={!name.trim()}
          >
            Create
          </button>
        </div>
      )}

      <ul className="tree-root">
        <li>
          <div
            className={
              selection.kind === 'all' ? 'tree-row selected' : 'tree-row'
            }
            style={{ paddingLeft: 8 }}
          >
            <button
              type="button"
              className="tree-label"
              onClick={() => onSelect({ kind: 'all' })}
              title="Every track in the library, through the filters below"
            >
              <LibraryIcon />
              <span className="tree-name">All tracks</span>
              <span className="tree-count">{totalCount}</span>
            </button>
          </div>
        </li>
        {rootFolders.map((folder) => renderFolder(folder, 0))}

        {rootPlaylists.map((playlist) => renderPlaylist(playlist, 0))}
      </ul>

      {/* One drop affordance at a time: while a folder is the target the root
          strip is withdrawn, so the highlight on screen is always the answer to
          "where will this land". */}
      {dragging &&
        !draggedAtRoot() &&
        (dropTarget === null || dropTarget === 'root') && (
        <div
          className={
            dropTarget === 'root' ? 'tree-drop-root drop' : 'tree-drop-root'
          }
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropTarget('root')
          }}
          onDragLeave={() =>
            setDropTarget((current) => (current === 'root' ? null : current))
          }
          onDrop={dropOnRoot}
        >
          {dragging.kind === 'folder'
            ? 'Drop here to move the folder to the top level'
            : 'Drop here to move the playlist to the top level'}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.target.name}`}
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7.5A1.5 1.5 0 0 1 20 8.5v8A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M4 6.5h10M4 12h10M4 17.5h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path d="M17 14.5v5l4-2.5Z" fill="currentColor" />
    </svg>
  )
}

/** Three stacked discs: every track the library holds. */
function LibraryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <ellipse cx="12" cy="6" rx="7.5" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4.5 6v6c0 1.4 3.4 2.6 7.5 2.6s7.5-1.2 7.5-2.6V6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M4.5 12v6c0 1.4 3.4 2.6 7.5 2.6s7.5-1.2 7.5-2.6v-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  )
}

/** Two chevrons pointing outwards: open every folder. */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M6.5 9.5 12 4l5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 14.5 12 20l5.5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Two chevrons folding inwards: shut every folder. */
function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M6.5 11.5 12 6l5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 19 12 13.5l5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7.5A1.5 1.5 0 0 1 20 8.5v8A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M12 10v5M9.5 12.5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ListPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path
        d="M4 6.5h9M4 12h9M4 17.5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M17 11v6M14 14h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}
