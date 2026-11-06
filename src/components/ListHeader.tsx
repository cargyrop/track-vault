import { useRef, useState } from 'react'
import type { TrackWithSources } from '../lib/types'
import { plural } from '../lib/format'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { PlayButton } from './PlayButton'
import { ChevronRightIcon, RepeatIcon, ShuffleIcon } from './icons'

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
 * The cover is drawn, not photographed: one record for a playlist, a shelf of
 * them for a folder or the whole library. It used to be a mosaic of the list's
 * own artwork, which said *which* list this is but went blank the moment a
 * list held no covers yet; the object says what kind of list it is, always.
 */

interface Props {
  title: string
  kind: 'all' | 'folder' | 'playlist'
  /** The rows the header describes, after the filters and before the sort. */
  tracks: TrackWithSources[]
  description?: string | null
  /** Named when the audible list is *this* one, so Play reads as a repeat. */
  isAudible?: boolean
  /** True when the audible list is actively streaming, so Play becomes Pause. */
  isPlaying?: boolean
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
  isPlaying = false,
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
  const time = totalTime(tracks)
  const count = tracks.length

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
        <div className={`list-cover ${kind === 'playlist' ? 'single' : 'shelf'}`} aria-hidden="true">
          {kind === 'playlist' ? <VinylRecord /> : <VinylShelf />}
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
          playing={isAudible && isPlaying}
        />
        <button
          type="button"
          className={shuffle ? 'chip toggle on' : 'chip toggle'}
          aria-pressed={shuffle}
          aria-label="Shuffle"
          onClick={onToggleShuffle}
          title={shuffle ? 'Shuffle on' : 'Shuffle this list'}
        >
          <ShuffleIcon />
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
          <RepeatIcon />
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

/** The list cover, drawn rather than assembled from the list's own artwork.
    One record for a playlist — a single set, played in an order; a shelf of
    them for a folder or the whole library, which hold as many as you own. */
function VinylRecord() {
  return (
    <svg className="list-cover-art" viewBox="0 0 84 84" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="list-vinyl" cx="32%" cy="22%" r="82%">
          <stop offset="0%" stopColor="#3a4860" />
          <stop offset="52%" stopColor="#151d2b" />
          <stop offset="100%" stopColor="#080c14" />
        </radialGradient>
      </defs>
      <circle cx="42" cy="42" r="31" fill="url(#list-vinyl)" stroke="rgba(148,183,255,0.28)" />
      <circle cx="42" cy="42" r="26" fill="none" stroke="rgba(255,255,255,0.07)" />
      <circle cx="42" cy="42" r="21" fill="none" stroke="rgba(255,255,255,0.06)" />
      <circle cx="42" cy="42" r="16" fill="none" stroke="rgba(255,255,255,0.05)" />
      <circle cx="42" cy="42" r="10.5" fill="var(--accent)" opacity="0.85" />
      <circle cx="42" cy="42" r="2.6" fill="#070a12" />
      <path
        d="M24 26a25 25 0 0 1 19-9"
        fill="none"
        stroke="rgba(255,255,255,0.16)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function VinylShelf() {
  return (
    <svg className="list-cover-art" viewBox="0 0 84 84" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="list-vinyl-shelf" cx="32%" cy="22%" r="82%">
          <stop offset="0%" stopColor="#33415a" />
          <stop offset="55%" stopColor="#141c29" />
          <stop offset="100%" stopColor="#080c14" />
        </radialGradient>
      </defs>
      {[
        { cx: 21, cy: 38, r: 15 },
        { cx: 42, cy: 33, r: 17 },
        { cx: 63, cy: 38, r: 15 },
      ].map(({ cx, cy, r }) => (
        <g key={cx}>
          <circle cx={cx} cy={cy} r={r} fill="url(#list-vinyl-shelf)" stroke="rgba(148,183,255,0.26)" />
          <circle cx={cx} cy={cy} r={r - 6} fill="none" stroke="rgba(255,255,255,0.06)" />
          <circle cx={cx} cy={cy} r="3.4" fill="var(--accent)" opacity="0.85" />
        </g>
      ))}
      <path d="M8 61h68" stroke="rgba(148,183,255,0.34)" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M16 67h52" stroke="rgba(148,183,255,0.16)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}


