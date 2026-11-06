import { plural } from '../lib/format'
import { PauseIcon, PlayIcon } from './icons'

interface Props {
  /**
   * What pressing it starts, as the tooltip names it: a `list` or a `playlist`.
   *
   * The two are the same button saying the same thing about different nouns —
   * the info panel's is the playlist it describes, the tracklist's is whatever
   * list is on screen — so the wording lives here once. Two copies of
   * "shuffled, opening on a random one" that have to agree is exactly the kind
   * of rule that drifts the first time somebody rewords one of them.
   */
  noun: 'list' | 'playlist'
  /** Starts or pauses it, or `null` when there is nothing to start. */
  onPlay: (() => void) | null
  /** How many tracks it will queue, for the tooltip. */
  count: number
  /**
   * Whether it will open on a drawn track rather than the first row.
   *
   * Set by whoever owns the shuffle, because pressing this button is a decision
   * about order as well as about starting: a Play that always began at the top
   * would quietly undo the shuffle button beside it.
   */
  shuffled: boolean
  /** True when this list is currently playing, switching the button to Pause. */
  playing?: boolean
  /**
   * How much room the button takes.
   *
   * `tool` is the 26px square that sits in a row of list controls; `primary` is
   * the accent-filled button at the head of a list, with its word spelled out,
   * because starting a list is the one thing you do to it every time. The
   * wording is shared, which is the whole reason both live here.
   */
  variant?: 'tool' | 'primary'
}

/**
 * The Play/Pause button, in the same small square as the transport's controls.
 *
 * It stays a real control when the list is empty rather than disappearing —
 * `disabled` with a tooltip that says why — so the row of buttons does not
 * change shape as a filter empties the list underneath it.
 */
export function PlayButton({
  noun,
  onPlay,
  count,
  shuffled,
  playing = false,
  variant = 'tool',
}: Props) {
  const tracks = plural(count, 'track', 'tracks')
  const label = playing ? `Pause ${noun}` : `Play ${noun}`
  const titleText = onPlay
    ? playing
      ? `Pause this ${noun}`
      : shuffled
        ? `Play this ${noun} shuffled — ${tracks}, opening on a random one`
        : `Play this ${noun} from the top — ${tracks}`
    : `This ${noun} is empty`

  if (variant === 'primary') {
    return (
      <button
        type="button"
        className="play-primary"
        aria-label={label}
        disabled={!onPlay}
        title={titleText}
        onClick={onPlay ?? undefined}
      >
        {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
        <span>{playing ? 'Pause' : 'Play'}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className="tool-btn"
      aria-label={label}
      disabled={!onPlay}
      title={titleText}
      onClick={onPlay ?? undefined}
    >
      {playing ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
    </button>
  )
}

