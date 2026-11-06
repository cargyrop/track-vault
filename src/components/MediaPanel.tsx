import { useEffect, useRef } from 'react'
import type { TrackWithSources } from '../lib/types'
import { stripGenreLines } from '../lib/artistInfo'

export type MediaPane = 'info' | 'lyrics'

interface Props {
  track: TrackWithSources | null
  pane: MediaPane
  /**
   * The card is the only editor, so both empty states point at it — and they
   * open it already in edit mode, since "no lyrics yet" is a request to write
   * some rather than to read a card that has none.
   */
  onOpenCard?: (edit?: boolean) => void
}

/**
 * What the playing track *says*, under its controls.
 *
 * One panel with two faces rather than two panels: the words and the note about
 * the recording are alternatives — you read one or the other, never both — so
 * they share a place and a scrollbar, and the reader's choice is remembered.
 * The old layout put lyrics in a whole column of their own, which cost a third
 * of the window on a desktop and was impossible on a phone.
 *
 * Reading only. Both faces say how to change what they show, and both point at
 * the track card, which owns the single editing path.
 *
 * It has no switch of its own: Info and Lyrics are transport buttons now, in the
 * row with the other controls, and this panel is the text they open.
 */
export function MediaPanel({ track, pane, onOpenCard }: Props) {
  const body = useRef<HTMLDivElement | null>(null)
  const info = track?.info ? stripGenreLines(track.info).trim() : ''
  const lyrics = track?.lyrics?.trim() ?? ''

  // A new track starts at the top of whatever is showing: keeping the previous
  // song's scroll position would open the next one halfway down.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [track?.id, pane])

  return (
    <section
      className="media-panel"
      aria-label={pane === 'info' ? 'Track information' : 'Lyrics'}
    >
      <div className="media-body" id="media-body" ref={body}>
        {pane === 'info' ? (
          info ? (
            <p className="media-text">{linkify(info)}</p>
          ) : (
            <div className="media-empty">
              <p>No info for this track yet.</p>
              {onOpenCard && (
                <button type="button" className="ghost-btn" onClick={() => onOpenCard(true)}>
                  Edit track card
                </button>
              )}
            </div>
          )
        ) : lyrics ? (
          <>
            <div className="media-text lyrics-text">
              {lyrics.split('\n').map((line, index) => (
                <span key={index} className="lyric-line">
                  {line || '\u00a0'}
                </span>
              ))}
            </div>
            {track?.lyricsSource && (
              <p className="media-credit">Words from {track.lyricsSource}</p>
            )}
          </>
        ) : (
          <div className="media-empty">
            <p>No lyrics stored for this track.</p>
            {onOpenCard && (
              <button type="button" className="ghost-btn" onClick={() => onOpenCard(true)}>
                Edit track card
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Turns bare URLs in the Info text into links.
 *
 * The point of the field is to tell you where the writing came from so you can
 * go and read more, and a Wikipedia address printed as inert text is a thing you
 * have to select and copy. Split on the URL rather than storing it in a second
 * field so the text stays one editable string.
 */
function linkify(text: string): React.ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return parts.map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a key={index} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  )
}
