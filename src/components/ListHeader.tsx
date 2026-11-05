import { useMemo, useRef, useState } from 'react'
import type { TrackWithSources } from '../lib/types'
import { plural } from '../lib/format'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { PlayButton } from './PlayButton'
import { TrackCover } from './TrackCover'
import { ChevronRightIcon, FolderIcon, PlaylistIcon } from './icons'

/**
 * What the open list is, and the one thing you do to it.
 *
 * Above the rows rather than in a panel beside them, because the identity of a
 * list and its contents are read together: the playlist name, how long it runs
 * and the button that starts it all belong to the same thought as the first
 * row. The old layout split that thought in three — a tree selection, a
 * "Now playing …" bar and an info panel in another column — and named the same
 * playlist on all three.
 *
 * The cover is a mosaic of the first four covers in the list, not an icon. A
 * generic mark says "this is a playlist"; four album covers say *which* one,
 * and it is the only large piece of imagery a list can earn.
 */

export interface HeaderTile {
  coverUrl: string | null
  videoId: string | null
}

interface Props {
  title: string
  kind: 'all' | 'folder' | 'playlist'
  /** The rows the header describes, after the filters and before the sort. */
  tracks: TrackWithSources[]
  description?: string | null
  /** Named when the audible list is *this* one, so Play reads as a repeat. */
  isAudible?: boolean
  onPlayList: (() => void) | null
  shuffle: boolean
  repeat: boolean
  onToggleShuffle: () => void
  onToggleRepeat: () => void
  djOn: boolean
  onToggleDj: (() => void) | null
  /** Extra entries for the ⋯ menu: edit notes, delete, rename, add tracks. */
  menuItems?: ContextMenuItem[]
  /** Shown under the actions when another list is what is actually playing. */
  playingFrom?: string | null
  onShowPlayingFrom?: () => void
}

/** Up to four covers, from the front of the list, for the mosaic. */
export function headerTiles(tracks: TrackWithSources[]): HeaderTile[] {
  const tiles: HeaderTile[] = []
  for (const track of tracks) {
    if (tiles.length === 4 && track.coverUrl) break
    tiles.push({ coverUrl: track.coverUrl ?? null, videoId: null })
    if (tiles.length === 4) break
  }
  return tiles
}

function listNoun(kind: Props['kind']): 'list' | 'playlist' {
  return kind === 'playlist' ? 'playlist' : 'list'
}

/** The list's running time, or null when no row has a length yet. */
function totalTime(tracks: TrackWithSources[]): string | null {
  let seconds = 0
  for (const track of tracks) {
    if (typeof track.duration === 'number' && track.duration > 0) {
      seconds += track.duration
    }
  }
  if (!seconds) return null
  const minutes = Math.round(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`
}

export function ListHeader({
  title,
  kind,
  tracks,
  description,
  isAudible = false,
  onPlayList,
  shuffle,
  repeat,
  onToggleShuffle,
  onToggleRepeat,
  djOn,
  onToggleDj,
  menuItems,
  playingFrom,
  onShowPlayingFrom,
}: Props) {
  const menuButton = useRef<HTMLButtonElement | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const tiles = useMemo(() => headerTiles(tracks), [tracks])
  const time = totalTime(tracks)
  const count = tracks.length
  const hasArt = tiles.some((tile) => tile.coverUrl)

  const openMenu = () => {
    const rect = menuButton.current?.getBoundingClientRect()
    setMenuAt(
      rect
        ? { x: Math.min(rect.left, window.innerWidth - 260), y: rect.bottom + 6 }
        : { x: window.innerWidth - 260, y: 80 },
    )
  }

  return (
    <header className="list-header">
      <div className="list-header-top">
        {/* The cover is decoration for the reader and a label would repeat the
            title beside it, so the whole block is hidden from assistive tech. */}
        <div className={`list-cover ${hasArt ? 'has-art' : ''}`} aria-hidden="true">
          {hasArt ? (
            tiles.map((tile, index) => (
              <TrackCover
                key={index}
                coverUrl={tile.coverUrl}
                videoId={tile.videoId}
                // Decoration: the list is named in the heading beside it, and a
                // broken image's alt text would otherwise be drawn into the
                // mosaic as a word.
                alt=""
                className="list-cover-tile"
                placeholderClassName="list-cover-tile empty"
              />
            ))
          ) : (
            <span className="list-cover-icon">
              {kind === 'folder' ? <FolderIcon /> : <PlaylistIcon />}
            </span>
          )}
        </div>

        <div className="list-header-text">
          <h2 title={title}>{title}</h2>
          <p className="list-sub">
            <span>{kind === 'playlist' ? 'Playlist' : kind === 'folder' ? 'Folder' : 'Library'}</span>
            <span aria-hidden="true">·</span>
            <span>{plural(count, 'track', 'tracks')}</span>
            {time && (
              // Wrapped, not two siblings, so a narrow header can drop the
              // running time and its separator in one go.
              <span className="list-time">
                <span aria-hidden="true">·</span>
                <span>{time}</span>
              </span>
            )}
            {isAudible && (
              <>
                <span aria-hidden="true">·</span>
                <span className="list-audible">playing now</span>
              </>
            )}
          </p>
          {description && <p className="list-description">{description}</p>}
        </div>
      </div>

      <div className="list-actions">
        <PlayButton
          variant="primary"
          noun={listNoun(kind)}
          onPlay={onPlayList}
          count={count}
          shuffled={shuffle}
        />
        <button
          type="button"
          className={shuffle ? 'chip toggle on' : 'chip toggle'}
          aria-pressed={shuffle}
          aria-label="Shuffle"
          onClick={onToggleShuffle}
          title={shuffle ? 'Shuffle on' : 'Shuffle this list'}
        >
          <ShuffleGlyph />
          <span className="chip-label">Shuffle</span>
        </button>
        <button
          type="button"
          className={repeat ? 'chip toggle on' : 'chip toggle'}
          aria-pressed={repeat}
          aria-label="Repeat"
          onClick={onToggleRepeat}
          title={repeat ? 'Repeat on — the list starts again at the end' : 'Repeat this list'}
        >
          <RepeatGlyph />
          <span className="chip-label">Repeat</span>
        </button>
        {onToggleDj && (
          <button
            type="button"
            className={djOn ? 'chip toggle on' : 'chip toggle'}
            aria-pressed={djOn}
            onClick={onToggleDj}
            aria-label="DJ"
            title={
              djOn
                ? 'DJ on — similar tracks continue after this list ends'
                : 'DJ this list — keep playing similar tracks after it ends'
            }
          >
            <span aria-hidden="true">✦</span>
            <span className="chip-label">DJ</span>
          </button>
        )}
        {menuItems && menuItems.length > 0 && (
          <button
            ref={menuButton}
            type="button"
            className="chip icon"
            aria-label="More actions for this list"
            title="More actions for this list"
            onClick={openMenu}
          >
            ⋯
          </button>
        )}
      </div>

      {/* Browsing never changes what plays, so a list that is not the audible
          one says what is — one press puts it back on screen. */}
      {playingFrom && (
        <button
          type="button"
          className="playing-from"
          onClick={onShowPlayingFrom}
          title={`Playing from ${playingFrom} — show that list`}
        >
          <span className="playing-dot" aria-hidden="true" />
          <span className="playing-from-text">Playing from {playingFrom}</span>
          <ChevronRightIcon />
        </button>
      )}

      {menuAt && menuItems && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          label="Actions for this list"
          items={menuItems}
          onClose={() => setMenuAt(null)}
        />
      )}
    </header>
  )
}

/** The two state marks live here rather than in `icons.tsx`: they are this
    header's control labels, drawn once, and the list rows never show them. */
function ShuffleGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M4 7h3.2l3 5m0 0 3 5H19m0 0 2.5-2.5M19 17l2.5 2.5M4 17h3.2l2.4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15.8 7H19m0 0 2.5 2.5M19 7l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RepeatGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M5 11V9.4A3.4 3.4 0 0 1 8.4 6h10M15 3.4 18.4 6 15 8.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 13v1.6A3.4 3.4 0 0 1 15.6 18h-10M9 15.4 5.6 18 9 20.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

