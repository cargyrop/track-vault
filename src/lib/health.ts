import { hasPlayableSource } from './sources'
import type { LibraryDocument, StoredTrack } from './types'

/**
 * What is wrong with the library, as a list you can read.
 *
 * Nothing in the app checked the stored data as a whole. Every rule lived in one
 * write path: the editor refuses two slots holding the same video, the add
 * dialog refuses a track with no audio link, the merge refuses to duplicate a
 * track. But a library is written by *several* paths — the editor, the add
 * dialog, the AI drop box, an import, and a human in a text editor — and each
 * one only enforces the rules it knows. The result is data that no single code
 * path would have produced and no screen shows.
 *
 * So this reads the document and reports, in one place, the invariants the rest
 * of the app assumes. It is deliberately pure and read-only: it takes a document
 * and returns findings, so it can be run on the file the browser already holds,
 * in a test, or over the whole library without a network or a server.
 *
 * Only contradictions are reported — stored data the app itself refuses to
 * produce. Hints about improvable but legal data (a missing MusicBrainz id you
 * cannot invent, a cover deliberately picked from YouTube, a video shared by
 * two rows) are intentionally not listed: they grow without bound and there is
 * nothing to do with them.
 *
 * What it cannot see is anything that needs a request — whether a cover URL
 * still answers. That check lives beside the merge, because only the caller
 * there is allowed to do IO.
 */
export type HealthKind =
  /** Two slots of one track pointing at the same video. The editor forbids it. */
  | 'both-slots-same-video'
  /**
   * Neither a Main nor a video clip, so the track cannot stream at all. A live
   * take does not count: neither of the app's two views plays it.
   */
  | 'no-source'

export interface HealthFinding {
  kind: HealthKind
  /**
   * Every finding is stored data that is wrong. Kept as a field (rather than
   * assumed) so callers and tests can name what they mean.
   */
  severity: 'fix'
  trackIds: number[]
  /** `Artist — Title` per track, in the same order as `trackIds`. */
  labels: string[]
  /** One sentence: what is wrong, in terms of what the app assumes. */
  detail: string
}

export function libraryHealth(doc: LibraryDocument): HealthFinding[] {
  const findings: HealthFinding[] = []
  const tracks = doc.tracks
  const label = (t: StoredTrack) => `${t.artist} — ${t.title}`

  for (const track of tracks) {
    const ids = track.sources.map((s) => s.youtubeId)

    if (new Set(ids).size !== ids.length) {
      findings.push({
        kind: 'both-slots-same-video',
        severity: 'fix',
        trackIds: [track.id],
        labels: [label(track)],
        detail:
          'Both source slots point at the same video, so switching to video shows the audio stream while claiming a clip. The editor refuses to save this.',
      })
    }

    if (!hasPlayableSource(track.sources)) {
      findings.push({
        kind: 'no-source',
        severity: 'fix',
        trackIds: [track.id],
        labels: [label(track)],
        detail:
          'No Main and no video clip, so there is nothing to stream. The merge rejects a new track in this state and the editor refuses to empty the last of the two slots.',
      })
    }
  }

  return findings.sort(compareFindings)
}

/** Stable order by kind, so a report does not reshuffle. */
function compareFindings(a: HealthFinding, b: HealthFinding): number {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
  return (a.trackIds[0] ?? 0) - (b.trackIds[0] ?? 0)
}
