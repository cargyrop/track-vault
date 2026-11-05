import { oembedUrl, readOEmbedStatus, type OEmbedAnswer } from './oembed'
import {
  buildPlayerVars,
  loadYouTubeApi,
  YTState,
  type YTNamespace,
  type YTPlayer,
} from './ytApi'

/**
 * Whether one stored link can actually play inside this app, asked of YouTube
 * the way the app itself asks: an embed, in this browser, in this country.
 *
 * There is no single endpoint that answers the whole question:
 *
 * - oEmbed (the keyless endpoint the add dialog already uses) answers
 *   *existence*: 200 with a title for a video it will hand out an embed for,
 *   and 400/404 for one it will not — a removed, private or never-existing
 *   upload. It also refuses with 401/403 a video whose uploader turned
 *   embedding off.
 * - It says nothing about the viewer's region, because it returns a title and
 *   a thumbnail rather than a playable stream. So a link that passes oEmbed is
 *   then cued in a hidden copy of the real player — the same IFrame API the
 *   transport uses — and its error codes are the ground truth for "does this
 *   play here": 100 is how YouTube surfaces a country block (it deliberately
 *   does not distinguish that from a removal), 101/150 is embedding being off
 *   (or a referrer the player will not trust), and anything else is a video
 *   the embedded player cannot play. Because the link has already answered
 *   oEmbed, a 100 here is the region: existence is not in doubt any more.
 *
 * Fail-open, like every other check in the app: an error that is not YouTube
 * saying no — a timeout, a refused connection, a stopped run — comes back as
 * `unknown` and the caller must leave that link alone. A flaky minute on the
 * network must never delete a healthy link.
 */

/** Why a link cannot play in this app. */
export type LinkProblem =
  /** Removed, private, or never existed. */
  | 'gone'
  /** The owner does not allow embedded players. */
  | 'no-embed'
  /**
   * Not served to this country. YouTube reports a region block through its
   * not-found path, so the verdict also covers a video that was taken down or
   * restricted to signed-in viewers between the two checks.
   */
  | 'geo-blocked'
  /** Anything else YouTube refuses with: invalid id, rental, player failure. */
  | 'unplayable'

/** The answer for one link. `unknown` means nobody could be asked. */
export type LinkVerdict =
  | { status: 'plays' }
  | { status: 'broken'; problem: LinkProblem; detail: string }
  | { status: 'unknown'; detail: string }

/**
 * Turns the IFrame API's numeric error into a verdict.
 *
 * The codes do not mean what their documentation names suggests: YouTube
 * surfaces a country block as 100, the same code it uses for "not found",
 * rather than as a code of its own. 101 and 150 are the pair that really means
 * "the owner does not allow this video in embedded players" — the docs call 150
 * "a 101 error in disguise" — and they also turn up when the player will not
 * trust the page it is embedded in.
 *
 * So the reading here is the one that follows from having already asked oEmbed:
 * a link whose video exists and is not refused over embedding, and that the
 * player then answers 100 for, is one YouTube will not serve to this country.
 */
export function verdictFromPlayerError(code: number): LinkVerdict {
  switch (code) {
    case 100:
      return {
        status: 'broken',
        problem: 'geo-blocked',
        detail:
          'YouTube will not serve it here — blocked in this country, or removed, private, or restricted to signed-in viewers.',
      }
    case 101:
    case 150:
      return {
        status: 'broken',
        problem: 'no-embed',
        detail: 'The owner does not allow this video to be played in embedded players.',
      }
    case 2:
      return {
        status: 'broken',
        problem: 'unplayable',
        detail: 'YouTube does not recognise this video id.',
      }
    case 5:
      return {
        status: 'broken',
        problem: 'unplayable',
        detail: 'The embedded player cannot play this video.',
      }
    default:
      return {
        status: 'broken',
        problem: 'unplayable',
        detail: `YouTube refused to play it (player error ${code}).`,
      }
  }
}

export interface ProbeOptions {
  /** Stops the check; an in-flight probe finishes as `unknown`. */
  signal?: AbortSignal
  /** Overridable so a caller (or a test) need not wait the real timeout. */
  timeoutMs?: number
}

/** How long the embed gets to answer before the link is left alone. */
const PLAYER_TIMEOUT_MS = 10000

/** How often the cued player is asked whether it has metadata yet. */
const POLL_MS = 250

const UNKNOWN_NETWORK: LinkVerdict = {
  status: 'unknown',
  detail: 'YouTube could not be reached about this link.',
}

/**
 * The whole check for one link: does it exist, may it be embedded, and does it
 * play from this machine's country?
 */
export async function probeLink(
  youtubeId: string,
  options: ProbeOptions = {},
): Promise<LinkVerdict> {
  if (!youtubeId) return { status: 'unknown', detail: 'The link holds no video id.' }
  const answer = await askOEmbed(youtubeId, options.signal)
  if (answer === 'gone') {
    return {
      status: 'broken',
      problem: 'gone',
      detail: 'YouTube has no video at this link — it was removed, made private, or never existed.',
    }
  }
  if (answer === 'no-embed') {
    return {
      status: 'broken',
      problem: 'no-embed',
      detail: 'Embedding is turned off for this video, so it cannot play inside the app.',
    }
  }
  if (answer === 'unknown') return UNKNOWN_NETWORK
  return probeInPlayer(youtubeId, options)
}

/** One keyless oEmbed request, read as an `OEmbedAnswer`. */
async function askOEmbed(
  youtubeId: string,
  signal?: AbortSignal,
): Promise<OEmbedAnswer> {
  let res: Response
  try {
    res = await fetch(oembedUrl(youtubeId), {
      signal: signal ?? AbortSignal.timeout(10000),
    })
  } catch {
    return 'unknown'
  }
  return readOEmbedStatus(res.status)
}

/**
 * Cues the link in a hidden player and waits for YouTube either to admit the
 * video has metadata (it plays here) or to report why it will not.
 *
 * Cued rather than started: a probe must not make a sound, and a video that
 * will not play errors just as reliably while being cued — the player resolves
 * the link before it streams anything. The mount is 1x1 and offscreen for the
 * same reason `fetchYouTubeDuration` hides its player: this is a question, not
 * a listen.
 */
async function probeInPlayer(
  videoId: string,
  options: ProbeOptions,
): Promise<LinkVerdict> {
  if (typeof document === 'undefined') {
    return { status: 'unknown', detail: 'There is no browser to play the link in.' }
  }
  const { signal, timeoutMs = PLAYER_TIMEOUT_MS } = options
  if (signal?.aborted) {
    return { status: 'unknown', detail: 'The check was stopped before this link.' }
  }

  let YT: YTNamespace
  try {
    YT = await loadYouTubeApi()
  } catch {
    return { status: 'unknown', detail: 'The YouTube player API did not load.' }
  }
  if (signal?.aborted) {
    return { status: 'unknown', detail: 'The check was stopped before this link.' }
  }

  // A real element to attach to, hidden the same way audio mode hides its
  // streaming frame.
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
  document.body.appendChild(host)

  return new Promise<LinkVerdict>((resolve) => {
    let settled = false
    let timer: number | undefined
    let poll: number | undefined
    let player: YTPlayer | null = null

    const finish = (verdict: LinkVerdict) => {
      if (settled) return
      settled = true
      if (timer !== undefined) window.clearTimeout(timer)
      if (poll !== undefined) window.clearInterval(poll)
      signal?.removeEventListener('abort', onAbort)
      try {
        player?.destroy()
      } catch {
        // A player already gone has nothing left to clean up.
      }
      host.remove()
      resolve(verdict)
    }

    const onAbort = () =>
      finish({ status: 'unknown', detail: 'The check was stopped at this link.' })
    signal?.addEventListener('abort', onAbort)

    timer = window.setTimeout(
      () =>
        finish({
          status: 'unknown',
          detail: 'The player did not answer in time, so the link was left alone.',
        }),
      timeoutMs,
    )

    const playsOn = (state: number): boolean =>
      state === YTState.CUED ||
      state === YTState.PLAYING ||
      state === YTState.BUFFERING

    try {
      // YT.Player replaces the element it is given with its iframe, so the
      // player attaches to a child of the hidden host: removing the host then
      // takes the iframe with it even if `destroy()` was too late.
      const mount = document.createElement('div')
      host.appendChild(mount)
      player = new YT.Player(mount, {
        videoId,
        playerVars: buildPlayerVars({
          videoId,
          quality: 'tiny',
          width: 1,
          height: 1,
        }),
        width: 1,
        height: 1,
        events: {
          onReady: (event: { target: YTPlayer }) => {
            const ready = event.target
            player = ready
            try {
              ready.mute()
              ready.cueVideoById(videoId)
            } catch {
              finish({
                status: 'unknown',
                detail: 'The player would not load this link.',
              })
              return
            }
            // A cued video reports zero seconds until its metadata arrives, so
            // the length is polled rather than read once — and a non-zero
            // length is the player admitting the video really is available.
            poll = window.setInterval(() => {
              if (settled) return
              let state: number = YTState.UNSTARTED
              let duration = 0
              try {
                state = ready.getPlayerState()
                duration = ready.getDuration()
              } catch {
                return
              }
              if (playsOn(state) || duration > 0) finish({ status: 'plays' })
            }, POLL_MS)
          },
          onStateChange: (event: { data: number }) => {
            if (playsOn(event.data)) finish({ status: 'plays' })
          },
          onError: (event: { data: number }) =>
            finish(verdictFromPlayerError(event.data)),
        },
      })
    } catch {
      finish({
        status: 'unknown',
        detail: 'The player would not start for this link.',
      })
    }
  })
}
