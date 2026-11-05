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

export function embedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}`
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
 * There used to be a Bandwidth dropdown offering four tiers. It was removed
 * because it traded a real saving against a confusing knob: the lower settings
 * were strictly worse in every respect (same audio, blurrier video nobody can
 * see in a 1x1 frame), so the only sensible choice was the lowest tier and the
 * menu existed only to let people pick worse. Audio mode now pins this value
 * with no control, and video mode leaves quality to YouTube.
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

/** Approximate video bitrate per tier, used only for the bandwidth estimate. */
const VIDEO_KBPS: Record<PlaybackQuality, number> = {
  // Adaptive playback is assumed to land near the top tier for an estimate.
  auto: 2500,
  tiny: 0,
  small: 100,
  medium: 500,
  high: 2500,
}

/** YouTube's shared audio rendition is roughly this, regardless of video quality. */
const AUDIO_KBPS = 128

/**
 * Estimates transfer for a track, so the UI can show the real saving rather
 * than a vague claim. Assumes a constant ~128 kbps audio stream, which is what
 * YouTube serves across quality levels.
 */
export function estimateSavings(
  durationSeconds: number,
  from: PlaybackQuality,
  to: PlaybackQuality,
): { fromMb: number; toMb: number; savedMb: number } {
  const seconds = Math.max(0, durationSeconds)
  const audioMb = (AUDIO_KBPS * seconds) / 8 / 1024
  const fromMb = audioMb + (VIDEO_KBPS[from] * seconds) / 8 / 1024
  const toMb = audioMb + (VIDEO_KBPS[to] * seconds) / 8 / 1024
  return {
    fromMb: Math.round(fromMb),
    toMb: Math.round(toMb),
    savedMb: Math.max(0, Math.round(fromMb - toMb)),
  }
}

/**
 * Builds the embed URL with the requested quality.
 *
 * `vq` is YouTube's own documented player parameter for a preferred quality
 * tier. It is a *request*, not a lock — the player may adapt upward on a fast
 * connection, which is why the collapsed iframe in audio mode is the more
 * reliable lever.
 */
export function embedUrlWithQuality(
  id: string,
  quality: PlaybackQuality,
): string {
  const params = new URLSearchParams({
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
  })
  // 'auto' means "let YouTube decide", which is expressed by omitting vq.
  if (quality !== 'auto') params.set('vq', quality)
  return `${embedUrl(id)}?${params.toString()}`
}

/** Human-readable summary of the shapes parseYouTubeId accepts. */
export const YOUTUBE_INPUT_HINT =
  'Paste a YouTube link, a youtu.be short link, or a bare 11-character video ID.'