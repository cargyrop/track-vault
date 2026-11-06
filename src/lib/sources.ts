import type { Source, SourceKind, SourceRole } from './types'

/** Which surface the player is showing. */
export type PlaybackView = 'audio' | 'video' | 'live'

export const ROLE_TITLE: Record<SourceRole, string> = {
  audio: 'Main',
  video: 'Official video clip',
  live: 'Live',
}

/**
 * Whether a track has anything to stream.
 *
 * Either half of the pair is enough: a Main with no clip plays audio mode and
 * shows a still in video mode, and a clip with no Main plays in both. Only a
 * track with neither — the live take alone does not count, since nothing in
 * the app's two main views would play it — has nothing to offer.
 *
 * Shared so the rule cannot drift: both stores, the import, the inbox merge,
 * the editor, the health report and the link-health run all ask this question
 * here rather than each spelling out "audio or video" for itself.
 */
export function hasPlayableSource(sources: Array<{ role: SourceRole }>): boolean {
  return sources.some((s) => isPlayableRole(s.role))
}

/** The two roles that carry playback, and so the two that may not both be empty. */
export function isPlayableRole(role: SourceRole): boolean {
  return role === 'audio' || role === 'video'
}

export const ROLE_DEFAULT_KIND: Record<SourceRole, SourceKind> = {
  audio: 'official',
  video: 'video',
  live: 'live',
}

export function sourceForRole(sources: Source[], role: SourceRole): Source | null {
  return sources.find((s) => s.role === role) ?? null
}

/**
 * Which source each view streams.
 *
 * Main and the video clip stand in for each other: a track with only a clip
 * plays that clip in audio mode, and a track with only a Main shows it in video
 * mode. Requiring a Main is what used to make a clip-only track unplayable, and
 * there is no reason for it — both are YouTube videos, and either one carries
 * the audio.
 */
export function pickSourceForView(sources: Source[], view: PlaybackView): Source | null {
  const main = sourceForRole(sources, 'audio')
  const video = sourceForRole(sources, 'video')
  const first = sources[0] ?? null
  if (view === 'audio') return main ?? video ?? first
  if (view === 'video') return video ?? main ?? first
  return sourceForRole(sources, 'live') ?? video ?? main ?? first
}

export function coverSourceVideoId(sources: Source[]): string | null {
  return pickSourceForView(sources, 'audio')?.youtubeId ?? null
}

export function resolveRole(requested: SourceRole | undefined, taken: SourceRole[]): SourceRole {
  if (requested && !taken.includes(requested)) return requested
  return (['audio', 'video', 'live'] as SourceRole[]).find((role) => !taken.includes(role)) ?? 'live'
}
