import type { LinkProblem, LinkVerdict } from './linkProbe'
import { hasPlayableSource } from './sources'
import type { Playlist, SourceRole, TrackWithSources } from './types'

/**
 * What a link-health run does with what it found: the links to cut, and the
 * tracks that are left with nothing playable.
 *
 * Pure, so the decisions are tested without a network or a player: verdicts in,
 * a plan out. The run itself lives beside this in `LinkHealthDialog`, and the
 * asking lives in `linkProbe.ts` — the same split as the inbox merge, which is
 * pure while its caller is allowed to do IO.
 */

/** The playlist a run files a track into when nothing playable is left. */
export const ISSUES_PLAYLIST = 'Issues'

export interface LinkRemoval {
  trackId: number
  /** `Artist — Title`, so the row is recognisable without opening it. */
  label: string
  role: SourceRole
  youtubeId: string
  problem: LinkProblem
  /** One sentence: why this link is going. */
  detail: string
}

export interface LinkHealthPlan {
  /** Every link YouTube said will not play here. */
  removals: LinkRemoval[]
  /**
   * Tracks left with neither a Main nor a clip, in library order. They stay in
   * the library — the repair is a new link — but they are filed where the
   * reader will find them.
   */
  issuesTrackIds: number[]
  /** Links that answered "it plays". */
  plays: number
  /** Links nobody could be asked; nothing was cut on their account. */
  unknown: number
}

/**
 * Turns the run's verdicts into the two things it writes.
 *
 * A removal is per *link*, not per track: a track with a dead clip and a live
 * Main keeps its Main and loses the clip. A track is only filed under Issues
 * when the removals leave it with neither an `audio` nor a `video` slot — the
 * two roles that carry playback, each standing in for the other — which is the
 * condition a reader would call "this track has nothing to play".
 */
export function planLinkHealth(
  tracks: TrackWithSources[],
  verdicts: ReadonlyMap<string, LinkVerdict>,
): LinkHealthPlan {
  const removals: LinkRemoval[] = []
  const issuesTrackIds: number[] = []
  let plays = 0
  let unknown = 0

  for (const track of tracks) {
    const label = `${track.artist} — ${track.title}`
    const cut = new Set<SourceRole>()

    for (const source of track.sources) {
      const verdict = verdicts.get(source.youtubeId)
      // No verdict means this link was never asked about (a stopped run), and
      // an unknown one means asking failed: both leave the link alone.
      if (!verdict) continue
      if (verdict.status === 'plays') {
        plays++
        continue
      }
      if (verdict.status === 'unknown') {
        unknown++
        continue
      }
      cut.add(source.role)
      removals.push({
        trackId: track.id,
        label,
        role: source.role,
        youtubeId: source.youtubeId,
        problem: verdict.problem,
        detail: verdict.detail,
      })
    }

    const left = track.sources.filter((source) => !cut.has(source.role))
    if (!hasPlayableSource(left)) issuesTrackIds.push(track.id)
  }

  return { removals, issuesTrackIds, plays, unknown }
}

export interface LinkCheckOptions {
  /** Stops between links; an in-flight probe finishes first. */
  signal?: AbortSignal
  /**
   * How many links to ask about at once. One by default: each probe builds a
   * player, and a stampede of embeds is the opposite of lightweight.
   */
  concurrency?: number
  onProgress?: (done: number, total: number) => void
}

/**
 * Asks about every distinct link once and returns a verdict per video id.
 *
 * The probes are taken as an argument rather than imported so the asking is
 * the caller's business — same shape as the old dead-link check, and the same
 * guarantee: a probe that throws is `unknown`, never broken.
 */
export async function checkLinksOnce(
  youtubeIds: string[],
  probe: (youtubeId: string, signal?: AbortSignal) => Promise<LinkVerdict>,
  options: LinkCheckOptions = {},
): Promise<Map<string, LinkVerdict>> {
  const { signal, concurrency = 1, onProgress } = options
  const queue = [...new Set(youtubeIds.filter(Boolean))]
  const total = queue.length
  const verdicts = new Map<string, LinkVerdict>()
  let done = 0

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, total)) },
    async () => {
      while (queue.length) {
        if (signal?.aborted) return
        const id = queue.pop()!
        let verdict: LinkVerdict
        try {
          verdict = await probe(id, signal)
        } catch {
          verdict = {
            status: 'unknown',
            detail: 'The check failed for this link.',
          }
        }
        if (signal?.aborted) return
        verdicts.set(id, verdict)
        done++
        onProgress?.(done, total)
      }
    },
  )
  await Promise.all(workers)
  return verdicts
}

/**
 * The Issues playlist a run files into, or null when there is not one yet.
 *
 * Only a playlist at the top of the tree counts: an "Issues" nested in a
 * folder was made by hand for something else, and filing into it silently
 * would hide the tracks the run was asked to collect.
 */
export function findIssuesPlaylist(playlists: Playlist[]): Playlist | null {
  const wanted = ISSUES_PLAYLIST.toLowerCase()
  return (
    playlists.find(
      (playlist) =>
        playlist.folderId === null &&
        playlist.name.trim().toLowerCase() === wanted,
    ) ?? null
  )
}
