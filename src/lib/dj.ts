import type { PlayEvent, TrackWithSources } from './types'

/**
 * The DJ's drafting rule: which tracks a seed should pull in next.
 *
 * Kept pure (and store-free) like `shuffle.ts` beside it: it scores candidates
 * from data the caller already holds — the library, recent plays and playlist
 * membership — so it is testable without a database and identical wherever it
 * runs. The app calls it when DJ mode needs picks and plays whatever comes
 * back; nothing here touches playback.
 *
 * Similarity is metadata, honestly: same artist, shared genres, same era and
 * "shelved together" (playlist co-membership), bent toward what the plays say
 * is actually listened to. Nothing here has heard the music.
 */

/** How many completed listens each store keeps for the DJ to learn from. */
export const MAX_PLAY_EVENTS = 1000

/** How many picks one refill drafts. Small on purpose: the tray stays readable. */
export const DJ_REFILL_COUNT = 10

const DAY_MS = 24 * 60 * 60 * 1000
/** Only plays this fresh count toward taste. Older ones are history, not habit. */
const TASTE_WINDOW_DAYS = 180
/** A track heard inside this window is never drafted — radio must not echo. */
const COOLDOWN_DAYS = 1

export interface DjDraftInput {
  /** Every track the library holds, unfiltered. The pool is drawn from here. */
  tracks: TrackWithSources[]
  /** The track the station grows out of: what is playing when DJ starts, or the
      last DJ pick when a refill extends the station. Null drafts on taste alone. */
  seedTrackId: number | null
  /** Completed listens, any order. Only what falls in the taste window counts. */
  plays: PlayEvent[]
  /** Playlist memberships as track-id groups: the shelved-together signal. */
  playlistGroups?: number[][]
  /** How many picks to return. Capped by the pool, never padded. */
  count: number
  /**
   * Never draft these: the picks already waiting, the seed, anything heard.
   *
   * The visible rows are deliberately *not* excluded here — excluding them
   * empties the pool exactly when the station grows out of the whole library.
   * List tracks are demoted by the recency rule instead, once the play log
   * says they have been heard.
   */
  excludeIds?: Iterable<number>
  /** Now, as ms since the epoch. Injected so tests can fix time. */
  now?: number
  random?: () => number
}

/**
 * Drafts up to `count` tracks for the station.
 *
 * Exclusions always hold (queue, waiting picks, seed). The recency cooldown is
 * relaxed only when it would otherwise leave nothing to play, so a three-track
 * library still gets a station rather than silence.
 */
export function draftDjPicks({
  tracks,
  seedTrackId,
  plays,
  playlistGroups = [],
  count,
  excludeIds = [],
  now = Date.now(),
  random = Math.random,
}: DjDraftInput): TrackWithSources[] {
  const wanted = Math.trunc(count)
  if (wanted <= 0 || !tracks.length) return []
  const excluded = new Set(excludeIds)
  if (seedTrackId !== null) excluded.add(seedTrackId)
  const pool = tracks.filter((t) => !excluded.has(t.id))
  if (!pool.length) return []

  const byId = new Map(tracks.map((t) => [t.id, t]))
  const seed = seedTrackId === null ? null : (byId.get(seedTrackId) ?? null)

  const { artistPlays, genrePlays, lastPlayedAt } = summarisePlays(plays, byId, now)
  const seedGroups = seed
    ? playlistGroups.filter((group) => group.includes(seed.id))
    : []

  const score = (t: TrackWithSources, strict: boolean): number | null => {
    const last = lastPlayedAt.get(t.id)
    if (last !== undefined) {
      const ageDays = (now - last) / DAY_MS
      if (strict && ageDays < COOLDOWN_DAYS) return null
      // Kept small deliberately: affinity for a favourite must outrank the
      // penalty for having heard it last week, or taste could never win.
      if (ageDays < 7) return scoreRest(t) - 1
      if (ageDays < 30) return scoreRest(t) - 0.5
    }
    return scoreRest(t)

    function scoreRest(t: TrackWithSources): number {
      let s = 0
      if (seed) {
        if (sameText(t.artist, seed.artist)) s += 5
        s += 2 * sharedGenres(t.genres, seed.genres)
        if (t.year && seed.year && decade(t.year) === decade(seed.year)) s += 1
        if (seedGroups.some((group) => group.includes(t.id))) s += 3
      }
      s += Math.min(3, (artistPlays.get(t.artist.toLowerCase()) ?? 0) * 0.5)
      let genreBonus = 0
      for (const genre of t.genres) {
        genreBonus += Math.min(1, (genrePlays.get(genre.toLowerCase()) ?? 0) * 0.25)
      }
      s += Math.min(2, genreBonus)
      return s
    }
  }

  // Shuffled first so ties — the rule in small libraries — come out varied.
  const shuffled = [...pool]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const ordered = (strict: boolean) =>
    shuffled
      .map((t) => ({ t, s: score(t, strict) }))
      .filter((e): e is { t: TrackWithSources; s: number } => e.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((e) => e.t)

  // No seed and no taste is a new library: the newest additions are the only
  // signal, so the station opens there instead of on a random draw.
  if (!seed && artistPlays.size === 0 && genrePlays.size === 0) {
    return [...pool]
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.min(wanted, pool.length))
  }

  const strict = ordered(true)
  const picks = strict.slice(0, wanted)
  if (picks.length) return picks
  // The cooldown excluded everything: play the best match anyway.
  return ordered(false).slice(0, wanted)
}

/**
 * Play counts per artist/genre plus each track's most recent listen.
 *
 * Affinity counts only plays inside the taste window — a band played daily
 * last month outranks one played daily three years ago. The most-recent
 * listen is kept at any age, because the cooldown and penalties need the
 * last time regardless of when it was. Plays naming tracks that no longer
 * exist are ignored rather than counted against anyone.
 */
function summarisePlays(
  plays: PlayEvent[],
  byId: Map<number, TrackWithSources>,
  now: number,
): {
  artistPlays: Map<string, number>
  genrePlays: Map<string, number>
  lastPlayedAt: Map<number, number>
} {
  const artistPlays = new Map<string, number>()
  const genrePlays = new Map<string, number>()
  const lastPlayedAt = new Map<number, number>()
  for (const play of plays) {
    const at = Date.parse(play.playedAt)
    if (!Number.isFinite(at) || at > now) continue
    const track = byId.get(play.trackId)
    if (!track) continue
    const seen = lastPlayedAt.get(play.trackId) ?? Number.NEGATIVE_INFINITY
    if (at > seen) lastPlayedAt.set(play.trackId, at)
    if (now - at > TASTE_WINDOW_DAYS * DAY_MS) continue
    artistPlays.set(
      track.artist.toLowerCase(),
      (artistPlays.get(track.artist.toLowerCase()) ?? 0) + 1,
    )
    for (const genre of track.genres) {
      const key = genre.toLowerCase()
      genrePlays.set(key, (genrePlays.get(key) ?? 0) + 1)
    }
  }
  return { artistPlays, genrePlays, lastPlayedAt }
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function sharedGenres(a: string[], b: string[]): number {
  const have = new Set(b.map((g) => g.toLowerCase()))
  return a.filter((g) => have.has(g.toLowerCase())).length
}

function decade(year: number): number {
  return Math.floor(year / 10)
}
