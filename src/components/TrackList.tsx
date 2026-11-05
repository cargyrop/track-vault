import { useRef, useState } from 'react'
import type { Playlist, TrackWithSources } from '../lib/types'
import { formatDuration } from '../lib/format'
import { hasPlayableSource } from '../lib/sources'
import { TRACK_DROP_TYPE } from '../lib/treeDrag'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  tracks: TrackWithSources[]
  /** The track the player is currently on, marked in the list. */
  playingId: number | null
  /**
   * Plays a row's track immediately.
   *
   * The whole row is this button. Playing a track is what a row *is* — the old
   * model turned the row number into a play mark on hover, which meant the
   * commonest action in the app existed only for a mouse, and only for someone
   * who already knew it was there.
   */
  onPlay: (track: TrackWithSources) => void
  /** Opens the full track card — the row's ⋯ menu and its first entry. */
  onOpenCard: (track: TrackWithSources) => void
  /** Removes a track from the library, after the caller has confirmed it. */
  onDelete: (track: TrackWithSources) => void
  /** Every playlist, for the row menu's add-to-playlist step. */
  playlists: Playlist[]
  onAddToPlaylist: (playlistId: number, trackId: number) => void
  /** Removes the row from the open playlist, without touching the library. */
  onRemoveFromPlaylist?: (track: TrackWithSources) => void
  /**
   * Playlists a track already belongs to, so the add step can mark them.
   * Absent, every playlist reads as available — the add itself still guards.
   */
  onPlaylistsForTrack?: (trackId: number) => Promise<Playlist[]>
  /** Shown instead of the default empty text — used when filters exclude all. */
  emptyLabel?: string
  /**
   * When true, rows can be dragged to re-order. Playlists only — a library is a
   * view over everything and a folder is a set of playlists, so neither has an
   * order of its own to change.
   */
  reorderable?: boolean
  /** Called with the dragged track's id and its new 0-based index in the list. */
  onReorder?: (trackId: number, toIndex: number) => void
}

/**
 * The tracklist: one line per track, and nothing else.
 *
 * Two lines of text per row — title, then artist and album — because a single
 * line in a 380px column truncated both before the duration had even been
 * considered. The duration sits at the right edge; the leading gutter holds the
 * row's number, which becomes an equaliser on the row that is playing, so the
 * list still answers "what is on and where am I" without a play button that
 * only exists under a mouse.
 *
 * Pressing a row plays it. The card — where a record is edited, filed or
 * deleted — is behind the ⋯ button or a right-click, so the two gestures stop
 * competing for the same line.
 *
 * Rows are draggable on a desktop: onto a playlist in the library to file them,
 * and within a user playlist to re-order it. Dragging is deliberately not the
 * only path — the ⋯ menu does the same filing, which is what makes the list
 * usable on a touch screen, where HTML5 drag events never fire.
 */
export function TrackList({
  tracks,
  playingId,
  onPlay,
  onOpenCard,
  onDelete,
  playlists,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onPlaylistsForTrack,
  emptyLabel,
  reorderable = false,
  onReorder,
}: Props) {
  const canReorder = Boolean(reorderable && onReorder)
  // Which row is being dragged, and where it would land. The slot is a gap
  // index (0…length), one bigger than the last row, which is what makes
  // "drop past the end" expressible.
  const [drag, setDrag] = useState<{ id: number; from: number } | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    track: TrackWithSources
  } | null>(null)
  // The menu's second step: the playlist to file the row into. Kept here rather
  // than in a submenu so it is one flat list at one position, which is what the
  // pointer is already sitting on.
  const [picking, setPicking] = useState(false)
  // Playlists the open menu's track is already in, marked with a tick.
  const [menuMembers, setMenuMembers] = useState<ReadonlySet<number>>(new Set())
  // Guards the membership read against a second menu opening first.
  const menuReq = useRef(0)

  const closeMenu = () => {
    menuReq.current++
    setMenu(null)
    setPicking(false)
    setMenuMembers(new Set())
  }

  const openMenu = (x: number, y: number, track: TrackWithSources) => {
    const req = ++menuReq.current
    setPicking(false)
    setMenu({ x, y, track })
    setMenuMembers(new Set())
    if (onPlaylistsForTrack) {
      void onPlaylistsForTrack(track.id)
        .then((members) => {
          if (menuReq.current !== req) return
          setMenuMembers(new Set(members.map((p) => p.id)))
        })
        .catch(() => undefined)
    }
  }

  const itemsFor = (track: TrackWithSources): ContextMenuItem[] => {
    if (picking) {
      return [
        {
          key: 'back',
          label: '‹ Back',
          group: 'Add to playlist',
          keepOpen: true,
          onSelect: () => setPicking(false),
        },
        ...(playlists.length
          ? playlists.map((playlist) => {
              const filed = menuMembers.has(playlist.id)
              return {
                key: `p-${playlist.id}`,
                label: playlist.name,
                meta: filed ? '✓' : String(playlist.trackCount),
                disabled: filed,
                onSelect: () => onAddToPlaylist(playlist.id, track.id),
              }
            })
          : [
              {
                key: 'none',
                label: 'No playlists yet',
                disabled: true,
                onSelect: () => undefined,
              },
            ]),
      ]
    }
    return [
      { key: 'play', label: 'Play', onSelect: () => onPlay(track) },
      {
        key: 'card',
        label: 'Open track card',
        onSelect: () => onOpenCard(track),
      },
      {
        key: 'add',
        label: 'Add to playlist…',
        group: 'Filing',
        keepOpen: true,
        onSelect: () => setPicking(true),
      },
      ...(onRemoveFromPlaylist
        ? [
            {
              key: 'remove',
              label: 'Remove from this playlist',
              onSelect: () => onRemoveFromPlaylist(track),
            },
          ]
        : []),
      {
        key: 'delete',
        label: 'Delete track',
        group: 'Library',
        danger: true,
        onSelect: () => onDelete(track),
      },
    ]
  }

  if (!tracks.length) {
    return (
      <p className="list-empty hint">
        {emptyLabel ?? 'No tracks here yet.'}
      </p>
    )
  }

  return (
    <div className="track-list-wrap">
      <ul
        className={reorderable ? 'track-list reorder' : 'track-list'}
        onDragLeave={(e) => {
          const next = e.relatedTarget as Node | null
          if (!next || !e.currentTarget.contains(next)) setSlot(null)
        }}
      >
        {tracks.map((track, index) => {
          const playing = track.id === playingId
          const needsLink = !hasPlayableSource(track.sources)
          const marks = [
            playing ? 'playing' : '',
            needsLink ? 'needs-link' : '',
            drag?.id === track.id ? 'dragging' : '',
            slot === index ? 'drop-top' : '',
            slot === tracks.length && index === tracks.length - 1
              ? 'drop-bottom'
              : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <li
              key={track.id}
              className={marks || undefined}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = canReorder ? 'move' : 'copy'
                // Firefox refuses to start a drag with an empty payload.
                e.dataTransfer.setData('text/plain', String(track.id))
                e.dataTransfer.setData(TRACK_DROP_TYPE, String(track.id))
                if (!canReorder) return
                setDrag({ id: track.id, from: index })
                setSlot(null)
              }}
              onDragOver={(e) => {
                if (!canReorder || !drag) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientY > rect.top + rect.height / 2
                setSlot(index + (after ? 1 : 0))
              }}
              onDrop={(e) => {
                if (!canReorder || !drag) return
                e.preventDefault()
                const landing = slot ?? index
                const toIndex = landing > drag.from ? landing - 1 : landing
                if (toIndex !== drag.from) onReorder?.(drag.id, toIndex)
                setDrag(null)
                setSlot(null)
              }}
              onDragEnd={() => {
                setDrag(null)
                setSlot(null)
              }}
            >
              {canReorder && (
                <span className="row-grip" title="Drag to re-order">
                  <GripIcon />
                </span>
              )}

              <button
                type="button"
                className="row-line"
                onClick={() => onPlay(track)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(e.clientX, e.clientY, track)
                }}
                title={
                  needsLink
                    ? 'No playable link — open the track card to add one'
                    : `Play ${track.title}`
                }
                aria-label={`Play ${track.title} by ${track.artist}${
                  needsLink ? '. No playable link yet.' : '.'
                }`}
              >
                <span className="row-state" aria-hidden="true">
                  {playing ? (
                    <span className="eq">
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <span className="num">{index + 1}</span>
                  )}
                </span>
                {/* One line per row, everywhere: the title, then the artist
                    beside it, then the album when there is room. A list of a
                    hundred tracks is read by scanning titles, not by reading
                    two-line blocks. */}
                <span className="row-text">
                  <span className="line-title">{track.title}</span>
                  <span className="line-sub">
                    <span className="line-artist">{track.artist}</span>
                    {track.album && (
                      <span className="line-album"> · {track.album}</span>
                    )}
                  </span>
                </span>
                <span className="line-duration" title={durationTitle(track.duration)}>
                  {formatDuration(track.duration)}
                </span>
              </button>

              <button
                type="button"
                className="row-more"
                onClick={(e) => {
                  e.stopPropagation()
                  const rect = e.currentTarget.getBoundingClientRect()
                  openMenu(rect.right - 200, rect.bottom + 4, track)
                }}
                aria-label={`More actions for ${track.title}`}
                title="More actions"
              >
                ⋯
              </button>
            </li>
          )
        })}
      </ul>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.track.title}`}
          items={itemsFor(menu.track)}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

/** The length a tooltip states: a dash when the length is genuinely unknown. */
function durationTitle(duration: number | null): string {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return 'Length unknown'
  }
  return `Runs ${formatDuration(duration)}`
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
