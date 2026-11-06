const ID_RE = /^[A-Za-z0-9_-]{11}$/

/**
 * Extracts an 11-character YouTube video ID from any of the URL shapes YouTube
 * hands out, or returns the string unchanged if it already looks like an ID.
 * Returns null when nothing usable is present.
 */
export function parseYouTubeId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  // youtu.be/<id>
  const short = /^(?:https?:\/\/)?youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&#].*)?$/i.exec(raw)
  if (short) return short[1]

  // youtube.com/watch?v=<id> (also music.youtube.com)
  const watch = /[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(raw)
  if (watch) return watch[1]

  // youtube.com/embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
  const path = /(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[?#/].*)?$/i.exec(raw)
  if (path) return path[1]

  if (ID_RE.test(raw)) return raw

  return null
}

export function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

/**
 * Quality tiers requested from the player.
 *
 * Research finding: YouTube's DASH manifests split audio and video, and the
 * audio stream is identical across every video quality (typically itag 140,
 * ~128 kbps AAC). Requesting the smallest video rendition therefore removes
 * almost all the wasted bandwidth while keeping full audio quality.
 *
 * `audioOnly` is not a player setting — YouTube exposes no audio-only mode.
 * It is achieved by pairing the `tiny` quality with a collapsed iframe.
 */
export type PlaybackQuality = 'auto' | 'tiny' | 'small' | 'medium' | 'high'

/**
 * The one tier audio mode uses.
 *
 * Audio mode pins the lowest video rendition with no control, and video mode
 * leaves quality to YouTube.
 */
export const AUDIO_SAVER_QUALITY: PlaybackQuality = 'tiny'

/**
 * Video mode uses YouTube's own adaptive quality instead of a tier.
 *
 * `vq` is a *request*, not a lock, so forcing a tier fights the player; leaving
 * it off lets YouTube pick from the available bandwidth exactly as it does on
 * youtube.com. Audio mode still needs a tier, because the whole bandwidth
 * saving there comes from pinning the video rendition as low as possible.
 */
export const AUTO_QUALITY: PlaybackQuality = 'auto'

/** Human-readable summary of the shapes parseYouTubeId accepts. */
export const YOUTUBE_INPUT_HINT =
  'Paste a YouTube link, a youtu.be short link, or a bare 11-character video ID.'
