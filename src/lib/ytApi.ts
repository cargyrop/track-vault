/**
 * Thin, typed wrapper around the YouTube IFrame Player API.
 *
 * The plain <iframe> embed gives us no control: no play/pause from our own
 * buttons, no seek, no quality changes, and its chrome shrinks to nothing when
 * the frame is made small (which is what broke the earlier "audio saver").
 * Driving the player through this API lets our own HUD own every control and
 * lets the iframe be hidden entirely.
 */

import { clampVolume } from './audio'

export interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  /** Cues (loads without playing) a video and leaves the player stopped. */
  cueVideoById(
    videoId: string,
    startSeconds?: number,
    suggestedQuality?: string,
  ): void
  loadVideoById(
    videoId: string,
    startSeconds?: number,
    suggestedQuality?: string,
  ): void
  setSize?(width: number, height: number): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  getVideoData(): { title: string; author: string }
  setPlaybackQuality(suggested: string): void
  getPlaybackQuality(): string
  getAvailableQualityLevels(): string[]
  mute(): void
  unMute(): void
  isMuted(): boolean
  setVolume(volume: number): void
  getVolume(): number
  /** Hides any caption track currently rendered over the video. */
  hideCaptions?(): void
  /** Low-level option setter, used to blank the caption track. */
  setOption?(option: string, key: string, value: string): void
  destroy(): void
  getIframe(): HTMLIFrameElement
}

export interface YTStateMap {
  UNSTARTED: -1
  ENDED: 0
  PLAYING: 1
  PAUSED: 2
  BUFFERING: 3
  CUED: 5
}

/**
 * Player states as plain constants, usable before the API script has loaded and
 * directly in tests. Values match YouTube's documented PlayerState constants.
 */
export const YTState: YTStateMap = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
}

export interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    options: Record<string, unknown>,
  ) => YTPlayer
  PlayerState: YTStateMap
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

const API_SRC = 'https://www.youtube.com/iframe_api'

// Monotonic counter used to give every player instance a unique DOM id.
let playerSeq = 0

let loadPromise: Promise<YTNamespace> | null = null

/** Loads the IFrame API script exactly once, even under React StrictMode. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (loadPromise) return loadPromise

  loadPromise = new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      // Preserve any other consumer's handler before resolving.
      previous?.()
      if (window.YT?.Player) resolve(window.YT)
      else reject(new Error('YouTube IFrame API loaded without a Player'))
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${API_SRC}"]`,
    )
    if (existing) return

    const script = document.createElement('script')
    script.src = API_SRC
    script.async = true
    script.onerror = () =>
      reject(new Error('Could not load the YouTube player API.'))
    document.head.appendChild(script)
  })

  return loadPromise
}

export interface CreatePlayerOptions {
  videoId: string
  /**
   * Requested quality tier. 'tiny' keeps the video payload as small as YouTube
   * allows; 'auto' hands the decision back to YouTube, which is what video mode
   * uses.
   */
  quality: string
  /** Initial level, 0-100. Applied on ready so it survives a player rebuild. */
  startVolume?: number
  /** Start muted so autoplay policies allow playback without a user gesture. */
  startMuted?: boolean
  width?: number
  height?: number
  /**
   * Fired immediately whenever the embedded player changes state.
   *
   * Essential for background tabs and mobile browsers: `setInterval` polling is
   * throttled or suspended when a tab is hidden, whereas the iframe's
   * `onStateChange` postMessage arrives as soon as a track reaches `ENDED`.
   */
  onStateChange?: (state: number, player: YTPlayer) => void
  /** Fired when a video loaded into an already-ready player reports an error. */
  onError?: (message: string, code: number) => void
}

/**
 * Player parameters that strip YouTube's own UI from the embed.
 *
 * Exported so the exact set is unit-tested and cannot silently regress.
 *
 * Deliberately absent: `modestbranding` and `showinfo`. Google deprecated both
 * and they no longer do anything, so setting them would only create a false
 * impression that the branding is hidden. Verified against Google's published
 * "YouTube Embedded Players and Player Parameters" documentation.
 *
 * Known limits, honestly stated: the YouTube wordmark and the title/channel
 * overlay are drawn inside the cross-origin iframe. No parameter and no
 * stylesheet in the host document can restyle them, because the iframe is a
 * separate origin. They are avoided rather than hidden: the frame is rendered
 * with `pointer-events: none`, so YouTube never sees a hover and never draws
 * that overlay at all.
 */
export function buildPlayerVars(options: CreatePlayerOptions): Record<string, unknown> {
  return {
    // Our own transport replaces the player controls entirely.
    controls: 0,
    // Host-page keyboard shortcuts would fight our HUD.
    disablekb: 1,
    // No related-video suggestions on the end screen.
    rel: 0,
    // Suppresses interactive annotations (cards, polls, shop overlays) that
    // the uploader burned into the video.
    iv_load_policy: 3,
    // Never force captions on. They are also blanked via the API on ready.
    cc_load_policy: 0,
    // Size drives YouTube's own quality heuristic.
    width: String(options.width ?? 1),
    height: String(options.height ?? 1),
    autoplay: 0,
    playsinline: 1,
    // 'auto' is expressed by leaving vq out entirely, so YouTube adapts to the
    // available bandwidth the way it does on youtube.com. Forcing a tier here
    // would fight the player, because vq is only a request.
    ...(options.quality === 'auto' ? {} : { vq: options.quality }),
  }
}

export async function createPlayer(
  host: HTMLElement,
  options: CreatePlayerOptions,
): Promise<YTPlayer> {
  const YT = await loadYouTubeApi()
  // YT.Player REPLACES its target element with the iframe it creates, and
  // destroy() removes that iframe without restoring the original node. Re-using
  // the same mount would therefore attach to a detached element and silently
  // produce no player at all. Each player gets a fresh child host instead.
  host.textContent = ''
  const mount = document.createElement('div')
  const mountId = `yt-player-${playerSeq++}`
  mount.id = mountId
  host.appendChild(mount)

  return new Promise<YTPlayer>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      mount.remove()
      reject(error)
    }
    // The element exists before YT.Player attaches to it; the instance itself
    // arrives later via the onReady callback below.
    new YT.Player(mountId, {
      videoId: options.videoId,
      playerVars: buildPlayerVars(options),
      width: options.width ?? 1,
      height: options.height ?? 1,
      events: {
        onReady: (event: { target: YTPlayer }) => {
          settled = true
          const ready = event.target
          try {
            const iframe = ready.getIframe?.()
            if (iframe) {
              iframe.setAttribute(
                'allow',
                'autoplay; encrypted-media; picture-in-picture; fullscreen',
              )
            }
          } catch {
            // Stubs without getIframe are unaffected.
          }
          // Apply the level before muting: setVolume(0) and mute() are not the
          // same thing to the player, and unmuting later must restore the level
          // rather than fall back to 100.
          if (options.startVolume !== undefined) {
            try {
              ready.setVolume(clampVolume(options.startVolume))
            } catch {
              // A player that refuses setVolume still plays at its default.
            }
          }
          if (options.startMuted) ready.mute()
          else ready.unMute()
          // Apply the requested quality once playback actually starts. With
          // 'auto' we deliberately do not call this: leaving it alone is what
          // lets YouTube pick the best rendition for the connection.
          if (options.quality !== 'auto') {
            ready.setPlaybackQuality(options.quality)
          }
          // Captions are not offered in our UI, so force the track off. The
          // parameter alone only avoids *forcing* them on; a viewer whose
          // YouTube preference has captions enabled would otherwise still get
          // subtitles burned over the video.
          try {
            ready.hideCaptions?.()
            ready.setOption?.('captions', 'track', '')
          } catch {
            // Older builds lack these helpers; captions simply stay as-is.
          }
          resolve(ready)
        },
        onStateChange: (event: { data: number; target: YTPlayer }) => {
          options.onStateChange?.(Number(event.data), event.target)
        },
        onError: (event: { data: number }) => {
          const code = Number(event.data)
          const message = youtubeErrorMessage(code)
          if (settled) {
            options.onError?.(message, code)
          } else {
            fail(new Error(message))
          }
        },
      },
    })
  })
}

/** Human-readable text for the IFrame API's numeric error codes. */
export function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'Invalid video ID.'
    case 5:
      return 'This video cannot play in an embedded player.'
    case 100:
      return 'This video is private or unavailable.'
    case 101:
    case 150:
      return 'The owner has disabled embedding for this video.'
    default:
      return `YouTube player error (${code}).`
  }
}