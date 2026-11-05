import {
  fetchArtistFacts,
  fetchITunesFill,
  type ArtistFacts,
} from './artistInfo'
import type { TrackPatch } from './types'

/**
 * Filling in the background for tracks that were added before the lookup
 * existed.
 *
 * The rule everywhere in this file is the same one the add dialog follows: a
 * fetch may add what is missing, never overwrite what is already there. A
 * library is years of someone's own work, and a background job that quietly
 * rewrites it is worse than one that does nothing.
 */

/** The fields a fetch is allowed to look at, and the ones it may fill. */
export interface BackfillTrack {
  id: number
  title: string
  artist: string
  info: string | null
  year: number | null
  genres: string[]
}

/**
 * Whether this track would gain anything from a lookup.
 *
 * Three separate gaps count. A track can have a Wikipedia bio and still be
 * missing its year, and a lookup costs nothing extra once the artist is cached,
 * so there is no reason to leave a hole just because another field is filled.
 */
export function needsBackfill(track: BackfillTrack): boolean {
  return !track.info?.trim() || track.year === null || track.genres.length === 0
}

/**
 * Works out what to write, or null when the fetch brought nothing new.
 *
 * Genres are unioned rather than replaced: MusicBrainz might know "thrash
 * metal" about a band the user has deliberately filed under "favourite", and
 * adding to their list is a suggestion while replacing it is data loss.
 */
export function mergeFacts(
  track: BackfillTrack,
  facts: ArtistFacts,
): TrackPatch | null {
  const patch: TrackPatch = {}

  if (!track.info?.trim() && facts.info) patch.info = facts.info
  if (track.year === null && facts.releaseYear) patch.year = facts.releaseYear

  const genres = unionGenres(track.genres, facts.genres)
  if (genres.length !== track.genres.length) patch.genres = genres

  return Object.keys(patch).length ? patch : null
}

/** Existing genres first, then any new ones, matched case-insensitively. */
export function unionGenres(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const genre of [...existing, ...incoming]) {
    const name = genre.trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * Remembers each artist's facts for the length of a backfill run.
 *
 * A library is full of bands with several tracks in it, and MusicBrainz allows
 * one request a second. Looking "Machine Head" up twice for two of its songs
 * doubles the wait and doubles the chance of being rate-limited, for an answer
 * that cannot have changed.
 *
 * Only the artist-scoped facts are cached — bio, genres, article. The release
 * year is deliberately left out, because it belongs to the song rather than
 * the band, and two singles released five years apart must not share one date.
 */
export function createArtistCache(): (artist: string) => Promise<ArtistFacts> {
  const cache = new Map<string, Promise<ArtistFacts>>()
  return (artist) => {
    const hit = cache.get(artist)
    if (hit) return hit
    const pending = fetchArtistFacts({ artist })
    cache.set(artist, pending)
    return pending
  }
}

export interface BackfillDeps {
  /** Cached, artist-scoped lookup. See `createArtistCache`. */
  factsFor: (artist: string) => Promise<ArtistFacts>
  /** Per-track release year. Defaults to iTunes. */
  yearFor?: (title: string, artist: string) => Promise<string | number | null>
}

/**
 * Fills one track, returning the patch to write or null if there was nothing
 * to add.
 *
 * Both lookups are injected so the merge and failure paths can be tested
 * without a network, and so a run can share one artist cache across every track
 * it visits.
 */
export async function backfillTrack(
  track: BackfillTrack,
  deps: BackfillDeps,
): Promise<TrackPatch | null> {
  let facts: ArtistFacts
  try {
    facts = await deps.factsFor(track.artist)
  } catch {
    // One unreachable artist must not abort the rest of the run.
    return null
  }

  if (track.year === null) {
    const yearFor = deps.yearFor ?? defaultYearFor
    try {
      const year = await yearFor(track.title, track.artist)
      const parsed = Number(year)
      if (Number.isFinite(parsed) && parsed > 1000) {
        facts = { ...facts, releaseYear: parsed }
      }
    } catch {
      // A missing year is not worth failing the bio over.
    }
  }

  return mergeFacts(track, facts)
}

async function defaultYearFor(
  title: string,
  artist: string,
): Promise<number | null> {
  return (await fetchITunesFill(title, artist)).year
}

export interface BackfillRunOptions {
  tracks: BackfillTrack[]
  /** Writes one patch. Injected so a run can be exercised without a store. */
  onApply: (trackId: number, patch: TrackPatch) => Promise<unknown>
  /** Injected lookups; defaults to the live ones. */
  factsFor?: (artist: string) => Promise<ArtistFacts>
  yearFor?: (title: string, artist: string) => Promise<number | string | null>
  /**
   * Polled before every track. Returning true abandons the rest of the run,
   * keeping whatever has already been written — cancelling a lookup should not
   * throw away the work it already finished.
   */
  shouldStop?: () => boolean
  onProgress?: (done: number, total: number, current: string | null) => void
}

export interface BackfillRunResult {
  total: number
  filled: number
  skipped: number
  /** True when `shouldStop` ended the run early. */
  cancelled: boolean
}

/**
 * Walks the tracks one at a time, filling what each is missing.
 *
 * A plain function rather than a hook so the loop — the part that must not run
 * in parallel, must survive one artist failing, and must stop when asked — can
 * be tested directly instead of only through a browser.
 */
export async function runBackfill(
  options: BackfillRunOptions,
): Promise<BackfillRunResult> {
  const pending = options.tracks.filter(needsBackfill)
  const factsFor = options.factsFor ?? createArtistCache()
  const shouldStop = options.shouldStop ?? (() => false)
  let filled = 0
  let skipped = 0

  options.onProgress?.(0, pending.length, pending[0]?.artist ?? null)

  for (const track of pending) {
    if (shouldStop()) break
    // Announced before the work so the status line can name who is being looked
    // up, then again afterwards so the count ticks over. Reporting only the
    // "before" case leaves the bar permanently one step behind the truth.
    options.onProgress?.(filled + skipped, pending.length, track.artist)

    try {
      const patch = await backfillTrack(track, { factsFor, yearFor: options.yearFor })
      if (patch) {
        await options.onApply(track.id, patch)
        filled++
      } else {
        skipped++
      }
    } catch {
      // A single failure — a rate limit, a dropped connection — must not take
      // the rest of the library's lookups down with it.
      skipped++
    }

    options.onProgress?.(filled + skipped, pending.length, null)
  }

  return {
    total: pending.length,
    filled,
    skipped,
    cancelled: pending.length > filled + skipped,
  }
}