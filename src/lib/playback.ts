import { YTState } from './ytApi'

/**
 * The rule for what happens when the user moves to another track:
 *
 * - playing -> the next track starts playing
 * - paused  -> the next track is cued and silent
 * - stopped -> the next track is cued and silent
 * - ended   -> the next track always plays (that is what ending means)
 *
 * Kept as a pure function so the decision is testable without a browser or a
 * real YouTube player. Player.tsx calls this directly, so the tests cover the
 * behaviour that actually ships rather than a copy of it.
 */
export function shouldAutoplayNext(state: number, forced = false): boolean {
  if (forced) return true
  return state === YTState.PLAYING
}

/**
 * Whether a skip should carry playback across to the next track.
 *
 * The player state alone is not enough. `getPlayerState()` is transient: for a
 * moment after starting, and for a moment after every skip, it reports
 * BUFFERING (3) or CUED (5) rather than PLAYING (1). Asking it alone therefore
 * dropped the carry-over and silently left the next track paused — most
 * visibly when skipping straight after pressing Play, which is exactly how
 * fullscreen viewing is used.
 *
 * So our own `playing` state is the primary signal: it is what the Play/Pause
 * button already shows, so the skip agrees with what the viewer can see. The
 * live state remains a fallback for the moments React has not caught up.
 */
export function shouldCarryPlayback(input: {
  /** React's `playing` state, which is what the transport button reflects. */
  playing: boolean
  /** The player's live state, or null when there is no player. */
  playerState: number | null
  /** Set when advancing because the track ended, which always continues. */
  forced?: boolean
}): boolean {
  if (input.forced) return true
  if (input.playing) return true
  return shouldAutoplayNext(input.playerState ?? YTState.UNSTARTED)
}