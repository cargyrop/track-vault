import { normaliseDuration } from './libraryImport'
import { createPlayer } from './ytApi'
import { parseYouTubeId } from './youtube'

/**
 * Asks YouTube how long a video is, without playing it and without a key.
 *
 * There is no key-free HTTP endpoint that answers this. The oEmbed endpoint the
 * app already uses returns a title, a channel and a thumbnail, but no length,
 * and scraping the watch page for `lengthSeconds` is not an option either: that
 * request is cross-origin and blocked by CORS, which is the same reason the
 * description/tag scraper in `ytMeta.ts` cannot succeed from the browser.
 *
 * So this goes through the one channel that definitely works and is already
 * allowed by the app's Content Security Policy: the IFrame Player API, which the app uses for playback
 * anyway. The player is built 1x1 and offscreen, cued rather than started, the
 * duration read once, and the player destroyed immediately. Nothing is
 * downloaded beyond the metadata the embed needs to answer the question — the
 * stream is never buffered.
 *
 * That makes this the authoritative answer for *a link*: it is the length of the
 * upload that will actually stream, which is not always the length of the studio
 * recording MusicBrainz has timed.
 */

/** How long to wait before giving up. A dead embed must not hang a dialog. */
const TIMEOUT_MS = 8000

/**
 * Rounds whatever the player reported into a storable number of seconds.
 *
 * Split out and pure so it can be tested without a browser. The player reports 0
 * before metadata has loaded and can return a non-number for a video it refuses,
 * so anything that is not a positive finite number means "unknown" rather than
 * zero.
 */
export function normalisePlayerDuration(raw: unknown): number | null {
  // The rule for "a storable number of seconds" lives in one place; the player
  // just reports a number that may not be one.
  return normaliseDuration(Number(raw))
}

export interface FetchDurationOptions {
  signal?: AbortSignal
  /** Overridable so tests do not have to wait out the real timeout. */
  timeoutMs?: number
}

/**
 * Returns the video's running time in whole seconds, or null if it cannot be
 * determined.
 *
 * Never throws: a caller showing this in a form must not have to decide what to
 * do about a network failure, because the correct behaviour on failure is
 * "leave the duration unknown and carry on".
 */
export async function fetchYouTubeDuration(
  input: string,
  options: FetchDurationOptions = {},
): Promise<number | null> {
  const videoId = parseYouTubeId(input)
  if (!videoId) return null

  const { signal, timeoutMs = TIMEOUT_MS } = options

  // The mount is hidden rather than removed from the document: the player needs
  // a real element to attach to, and a 1x1 offscreen host is what audio mode
  // already uses for the streaming frame.
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
  document.body.appendChild(host)

  let timer: number | undefined
  let onAbort: (() => void) | undefined

  try {
    const player = await Promise.race([
      createPlayer(host, {
        videoId,
        // The cheapest rendition available. We only want metadata; if anything
        // does stream it must be the smallest thing YouTube offers.
        quality: 'tiny',
        // Not muted-and-unmuted-then-started: the player is cued, never played,
        // so there is nothing to unmute and no autoplay policy to fight.
        startMuted: true,
        startVolume: 0,
        width: 1,
        height: 1,
      }),
      new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), timeoutMs)
      }),
      new Promise<null>((resolve) => {
        if (!signal) return
        if (signal.aborted) return resolve(null)
        onAbort = () => resolve(null)
        signal.addEventListener('abort', onAbort)
      }),
    ])

    if (!player) return null
    // The duration is only meaningful once the player is cued; a player that is
    // still UNSTARTED has nothing to report yet.
    const duration = normalisePlayerDuration(player.getDuration())
    player.destroy()
    return duration
  } catch {
    // A refused embed, an invalid id, a CSP block — all the same to a caller.
    return null
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
    if (onAbort && signal) signal.removeEventListener('abort', onAbort)
    host.remove()
  }
}
