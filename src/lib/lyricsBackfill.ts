import { canLookUpLyrics, type LyricsResult } from './lyrics'

/**
 * Automatic lyrics, filled in like the artist background.
 *
 * The info backfill proved the shape: a quiet sequential sweep over the whole
 * library that fills blanks, skips what it has already tried, and can be
 * stopped. Lyrics get the same treatment, with one stricter promise — a track
 * that already has words is never touched, however they got there. Hand-pasted
 * lyrics, a previous lookup, a manual save: all of them read as "has words",
 * and the sweep walks past.
 *
 * Everything that decides is pure and the network arrives injected, so the
 * whole rule is testable without touching either lyrics provider.
 */

/** A track as the sweep sees it: identity, query, and what's already there. */
export interface LyricsBackfillTrack {
  id: number
  title: string
  artist: string
  lyrics: string | null
}

/**
 * True when the track has no words yet and a lookup is possible.
 *
 * Blankness is read off the text, not the source: whatever put words there —
 * a paste, a press of the panel's lookup button, an earlier sweep — counts,
 * and only a track with nothing counts as missing.
 */
export function needsLyrics(track: LyricsBackfillTrack): boolean {
  if (track.lyrics && track.lyrics.trim().length > 0) return false
  return canLookUpLyrics({ title: track.title, artist: track.artist })
}

export interface LyricsBackfillRunResult {
  total: number
  filled: number
  skipped: number
  cancelled: boolean
}

/**
 * A breath between requests, so a library of hundreds does not arrive as a
 * burst. Same bargain as the info backfill's one-a-second: slow, visible and
 * cancellable rather than fast and rude to two free services.
 */
export const LYRICS_BACKFILL_DELAY_MS = 1000

/**
 * Shorter than a single line of verse is a placeholder, not words.
 *
 * Phones meet captive portals and filtering proxies that answer any request
 * with 200 and a scrap of valid JSON; saving that scrap would etch somebody
 * else's probe into the library permanently. Anything this short is skipped —
 * counted, reported, and tried again next session, when the network may be
 * sane — rather than stored.
 */
export const LYRICS_MIN_SAVE_LENGTH = 24

interface RunOptions {
  tracks: LyricsBackfillTrack[]
  lookup: (query: { title: string; artist: string }) => Promise<LyricsResult | null>
  /**
   * Re-checked just before writing: a paste that landed while its lookup was
   * in flight wins over the lookup, because typed words beat fetched ones.
   */
  shouldStillApply: (trackId: number) => boolean
  onApply: (
    trackId: number,
    patch: { lyrics: string; lyricsSource: string },
  ) => Promise<unknown>
  shouldStop: () => boolean
  onProgress?: (done: number, total: number, current: string | null) => void
  /** Zero in tests, where waiting a second per track would be the test. */
  delayMs?: number
}

export async function runLyricsBackfill(
  options: RunOptions,
): Promise<LyricsBackfillRunResult> {
  const {
    tracks,
    lookup,
    shouldStillApply,
    onApply,
    shouldStop,
    onProgress,
    delayMs = LYRICS_BACKFILL_DELAY_MS,
  } = options
  const candidates = tracks.filter(needsLyrics)
  let filled = 0
  let skipped = 0
  let cancelled = false
  for (const [index, track] of candidates.entries()) {
    if (shouldStop()) {
      cancelled = true
      break
    }
    onProgress?.(index, candidates.length, `${track.artist} — ${track.title}`)
    let found: LyricsResult | null = null
    try {
      found = await lookup({ title: track.title, artist: track.artist })
    } catch {
      // A failing lookup is a miss, not a crash: the panel is an extra, and
      // the sweep must survive one bad response the way it survives none.
      found = null
    }
    const text = found?.text?.trim() || null
    const source = found?.source ?? null
    const usable = text && text.length >= LYRICS_MIN_SAVE_LENGTH ? text : null
    if (!usable || !source || !shouldStillApply(track.id)) {
      skipped++
    } else {
      await onApply(track.id, { lyrics: usable, lyricsSource: source })
      filled++
    }
    if (delayMs > 0 && index < candidates.length - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs)
      })
    }
  }
  onProgress?.(candidates.length, candidates.length, null)
  return { total: candidates.length, filled, skipped, cancelled }
}
