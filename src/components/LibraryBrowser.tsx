import { useMemo, useRef, useState } from 'react'
import type { PlaylistSelection } from '../hooks/useLibrary'
import type { Playlist, PlaylistFolder } from '../lib/types'
import { plural } from '../lib/format'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  LibraryIcon,
  PlaylistIcon,
} from './icons'

interface Props {
  folders: PlaylistFolder[]
  playlists: Playlist[]
  selection: PlaylistSelection
  totalCount: number
  /** Opens a list: selection and navigation are one press on a phone. */
  onOpen: (selection: PlaylistSelection) => void
  onCreateFolder: (name: string, parentId: number | null) => void
  onCreatePlaylist: (name: string, folderId: number | null) => void
  onDeleteFolder: (id: number) => void
  onDeletePlaylist: (id: number) => void
  onRenameFolder: (id: number, name: string) => void
  onRenamePlaylist: (id: number, name: string) => void
  /** A search from the library is a search of everything, then a list of it. */
  onSearch: (term: string) => void
  onAddTrack: () => void
}

type MenuTarget =
  | { kind: 'folder'; id: number; name: string }
  | { kind: 'playlist'; id: number; name: string }

/**
 * The library, as somewhere you walk rather than a tree you poke.
 *
 * The desktop tree earns its indentation and its drag targets because a pointer
 * can hit them; a phone cannot. Here a folder is a level you enter, a playlist
 * is a row that opens the list, and everything a row can do beyond opening lives
 * behind its ⋯ — rename, delete, and for folders the two "create here" verbs.
 * That is also the answer to the desktop-only problem: filing into a playlist
 * happened only by dragging, and drag events never fire on a touch screen.
 */
export function LibraryBrowser({
  folders,
  playlists,
  selection,
  totalCount,
  onOpen,
  onCreateFolder,
  onCreatePlaylist,
  onDeleteFolder,
  onDeletePlaylist,
  onRenameFolder,
  onRenamePlaylist,
  onSearch,
  onAddTrack,
}: Props) {
  // How deep into the folders we are. Kept here rather than in the app: it is a
  // property of this screen, and leaving the tab by any route should not
  // remember that you were three folders down.
  const [path, setPath] = useState<number[]>([])
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(
    null,
  )
  const [newAt, setNewAt] = useState<{ x: number; y: number } | null>(null)
  const newButton = useRef<HTMLButtonElement | null>(null)

  const currentFolderId = path.length ? path[path.length - 1] : null
  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null
  // The button that goes back names where back *is*, not where you are. Three
  // folders down, "Library" is a lie; "Greek" is the answer. At the top level
  // there is nothing above but the library itself, so that is what it says.
  const parentFolder =
    path.length > 1 ? folders.find((f) => f.id === path[path.length - 2]) ?? null : null
  const backLabel = parentFolder ? parentFolder.name : 'Library'

  const visibleFolders = useMemo(
    () => folders.filter((folder) => folder.parentId === currentFolderId),
    [folders, currentFolderId],
  )
  const visiblePlaylists = useMemo(
    () => playlists.filter((playlist) => playlist.folderId === currentFolderId),
    [playlists, currentFolderId],
  )

  const openMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    target: MenuTarget,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({
      x: Math.min(rect.right - 210, window.innerWidth - 230),
      y: rect.bottom + 4,
      target,
    })
  }

  const askName = (question: string, initial = ''): string | null => {
    const answer = window.prompt(question, initial)
    if (answer === null) return null
    const trimmed = answer.trim()
    return trimmed || null
  }

  const menuItems = (target: MenuTarget): ContextMenuItem[] => {
    if (target.kind === 'folder') {
      return [
        {
          key: 'open',
          label: 'Open folder',
          onSelect: () => setPath([...path, target.id]),
        },
        {
          key: 'rename',
          label: 'Rename folder…',
          group: 'Edit',
          onSelect: () => {
            const name = askName('Rename this folder', target.name)
            if (name) onRenameFolder(target.id, name)
          },
        },
        {
          key: 'playlist',
          label: 'New playlist here…',
          group: 'Create',
          onSelect: () => {
            const name = askName('Name the new playlist')
            if (name) onCreatePlaylist(name, target.id)
          },
        },
        {
          key: 'folder',
          label: 'New folder here…',
          onSelect: () => {
            const name = askName('Name the new folder')
            if (name) onCreateFolder(name, target.id)
          },
        },
        {
          key: 'delete',
          label: 'Delete folder',
          group: 'Danger',
          danger: true,
          onSelect: () => {
            if (
              window.confirm(
                `Delete the folder “${target.name}”? Its playlists move to the top level.`,
              )
            ) {
              onDeleteFolder(target.id)
            }
          },
        },
      ]
    }
    return [
      { key: 'open', label: 'Open playlist', onSelect: () => onOpen({ kind: 'playlist', playlistId: target.id }) },
      {
        key: 'rename',
        label: 'Rename playlist…',
        group: 'Edit',
        onSelect: () => {
          const name = askName('Rename this playlist', target.name)
          if (name) onRenamePlaylist(target.id, name)
        },
      },
      {
        key: 'delete',
        label: 'Delete playlist',
        group: 'Danger',
        danger: true,
        onSelect: () => {
          if (window.confirm(`Delete the playlist “${target.name}”?`)) {
            onDeletePlaylist(target.id)
          }
        },
      },
    ]
  }

  const createMenu = (): ContextMenuItem[] => [
    {
      key: 'playlist',
      label: 'New playlist…',
      onSelect: () => {
        const name = askName('Name the new playlist')
        if (name) onCreatePlaylist(name, currentFolderId)
      },
    },
    {
      key: 'folder',
      label: 'New folder…',
      onSelect: () => {
        const name = askName('Name the new folder')
        if (name) onCreateFolder(name, currentFolderId)
      },
    },
    {
      key: 'track',
      label: 'Add a track…',
      group: 'Tracks',
      onSelect: onAddTrack,
    },
  ]

  return (
    <div className="browser">
      <header className="screen-head">
        {currentFolder ? (
          <button
            type="button"
            className="screen-back"
            onClick={() => setPath(path.slice(0, -1))}
            aria-label={parentFolder ? `Back to ${parentFolder.name}` : 'Back to the library'}
            title={parentFolder ? `Back to ${parentFolder.name}` : 'Back to the library'}
          >
            <ChevronLeftIcon />
            <span>{backLabel}</span>
          </button>
        ) : (
          <h2 className="screen-title">Library</h2>
        )}
        <div className="spacer" />
        <button
          ref={newButton}
          type="button"
          className="icon-btn round"
          aria-label="Create or add"
          title="Create a folder or playlist, or add a track"
          onClick={() => {
            const rect = newButton.current?.getBoundingClientRect()
            setNewAt({
              x: Math.min((rect?.right ?? window.innerWidth) - 220, window.innerWidth - 240),
              y: (rect?.bottom ?? 60) + 4,
            })
          }}
        >
          ＋
        </button>
      </header>

      {currentFolder && <p className="browser-crumb">{currentFolder.name}</p>}

      <label className="browser-search">
        <span className="visually-hidden">Search the whole library</span>
        <input
          type="search"
          placeholder="Search every track"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && search.trim()) {
              onSearch(search.trim())
              setSearch('')
            }
          }}
        />
        {search.trim() && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              onSearch(search.trim())
              setSearch('')
            }}
          >
            Search
          </button>
        )}
      </label>

      <ul className="browser-list">
        {!currentFolder && (
          <li className="browser-row-wrap">
            <button
              type="button"
              className={
                selection.kind === 'all' ? 'browser-row on' : 'browser-row'
              }
              onClick={() => onOpen({ kind: 'all' })}
            >
              <span className="browser-icon" aria-hidden="true">
                <LibraryIcon size={19} />
              </span>
              <span className="browser-text">
                <span className="browser-name">All tracks</span>
                <span className="browser-meta">
                  {plural(totalCount, 'track', 'tracks')}
                </span>
              </span>
              <ChevronRightIcon />
            </button>
          </li>
        )}

        {visibleFolders.map((folder) => {
          const inside = playlists.filter((p) => p.folderId === folder.id).length
          const nested = folders.filter((f) => f.parentId === folder.id).length
          return (
            <li key={`folder-${folder.id}`}>
              <div className="browser-row-wrap">
                <button
                  type="button"
                  className={
                    selection.kind === 'folder' && selection.folderId === folder.id
                      ? 'browser-row on'
                      : 'browser-row'
                  }
                  onClick={() => setPath([...path, folder.id])}
                >
                  <span className="browser-icon folder" aria-hidden="true">
                    <FolderIcon size={19} />
                  </span>
                  <span className="browser-text">
                    <span className="browser-name">{folder.name}</span>
                    <span className="browser-meta">
                      {plural(inside, 'playlist', 'playlists')}
                      {nested > 0 ? ` · ${plural(nested, 'folder', 'folders')}` : ''}
                    </span>
                  </span>
                  <ChevronRightIcon />
                </button>
                <button
                  type="button"
                  className="browser-more"
                  aria-label={`Actions for ${folder.name}`}
                  onClick={(e) =>
                    openMenu(e, { kind: 'folder', id: folder.id, name: folder.name })
                  }
                >
                  ⋯
                </button>
              </div>
            </li>
          )
        })}

        {visiblePlaylists.map((playlist) => (
          <li key={`playlist-${playlist.id}`}>
            <div className="browser-row-wrap">
              <button
                type="button"
                className={
                  selection.kind === 'playlist' &&
                  selection.playlistId === playlist.id
                    ? 'browser-row on'
                    : 'browser-row'
                }
                onClick={() => onOpen({ kind: 'playlist', playlistId: playlist.id })}
              >
                <span className="browser-icon" aria-hidden="true">
                  <PlaylistIcon size={19} />
                </span>
                <span className="browser-text">
                  <span className="browser-name">{playlist.name}</span>
                  <span className="browser-meta">
                    {plural(playlist.trackCount, 'track', 'tracks')}
                  </span>
                </span>
                <ChevronRightIcon />
              </button>
              <button
                type="button"
                className="browser-more"
                aria-label={`Actions for ${playlist.name}`}
                onClick={(e) =>
                  openMenu(e, {
                    kind: 'playlist',
                    id: playlist.id,
                    name: playlist.name,
                  })
                }
              >
                ⋯
              </button>
            </div>
          </li>
        ))}

        {!visibleFolders.length && !visiblePlaylists.length && (
          <li className="browser-empty hint">
            {currentFolder
              ? 'This folder is empty — use ＋ to add a playlist or a folder.'
              : 'No playlists yet — use ＋ to create one.'}
          </li>
        )}
      </ul>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.target.name}`}
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}
      {newAt && (
        <ContextMenu
          x={newAt.x}
          y={newAt.y}
          label="Create"
          items={createMenu()}
          onClose={() => setNewAt(null)}
        />
      )}
    </div>
  )
}
