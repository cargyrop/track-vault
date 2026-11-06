import { useCallback, useRef, useState } from 'react'
import {
  runBackfill,
  needsBackfill,
  type BackfillRunResult,
  type BackfillTrack,
} from '../lib/infoBackfill'
import type { TrackPatch } from '../lib/types'

export interface BackfillProgress {
  running: boolean
  total: number
  done: number
  current: string | null
  filled: number
  skipped: number
}

/** What the last sweep did, for the quiet line under the top bar. */
export interface BackfillSummary {
  filled: number
  skipped: number
  /** True when the run was stopped part-way through. */
  cancelled: boolean
}

const IDLE: BackfillProgress = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  filled: 0,
  skipped: 0,
}

/**
 * Fills in the background for tracks that are missing it, without being asked.
 *
 * This used to be a button — "Fill in info (12)" — and the button was the wrong
 * shape for it: knowing which tracks lack a bio is the app's job, not the
 * listener's, and the moment they noticed the gap was the moment they had just
 * added the track. So the lookup now runs by itself for a track that arrives
 * missing something, and nobody has to press anything. Adding a track through
 * the dialog still looks the artist up itself, before the save; this is the
 * safety net underneath, for the ones whose lookup failed the first time and
 * for tracks that arrive by other routes (an AI batch merged from the inbox, an
 * import, a hand edit of the file).
 *
 * **The caller decides which tracks are new.** This hook sweeps whatever it is
 * handed, and `App` hands it only the tracks that appeared after the window
 * opened: a launch used to re-sweep the whole library, one request a second,
 * for tracks that were looked up when they were added. That is also why the
 * report line lives above the library rather than in it — the sweep is about
 * the app, not about the list on screen.
 *
 * Sequential on purpose, exactly as before: MusicBrainz allows one request a
 * second, and firing the whole library at once would earn a 503 from most of
 * it — so the run is slow, visible and cancellable rather than fast and
 * unreliable.
 *
 * The loop itself lives in `runBackfill`; this is just the React plumbing for
 * deciding what to sweep, showing its progress and holding the cancel flag.
 */
export function useInfoBackfill(
  onApply: (trackId: number, patch: TrackPatch) => Promise<unknown>,
  /**
   * Called once when a run ends, whatever it managed to do. The caller uses it
   * to re-read the library — after the run rather than during it, since genres
   * feed the facet list and reloading per track would make the genre counts
   * climb one at a time.
   */
  onFinished?: (result: BackfillRunResult) => void,
) {
  const [progress, setProgress] = useState<BackfillProgress>(IDLE)
  const [summary, setSummary] = useState<BackfillSummary | null>(null)
  const stop = useRef(false)
  const busy = useRef(false)
  /**
   * The two callbacks are kept in refs so `sweep` itself can be stable. The
   * caller hands it to an effect that watches the track list, and a `sweep`
   * whose identity changed with every render would make that effect run on
   * every render — re-reading the library in a loop to discover, each time,
   * that there is nothing to do.
   */
  const apply = useRef(onApply)
  apply.current = onApply
  const finished = useRef(onFinished)
  finished.current = onFinished
  /**
   * Ids already looked up in this session, whether the lookup found anything or
   * not.
   *
   * The mark goes on *before* the run rather than after it, and that is the
   * whole point of the set. A band MusicBrainz has never heard of comes back
   * with nothing, which leaves the track just as empty as it was — so a sweep
   * that only remembered its successes would offer the same hopeless lookup
   * again on the next render, and once a second after that. One attempt per
   * track per session, then silence until the window is reloaded.
   */
  const attempted = useRef(new Set<number>())

  /**
   * Looks up everything in `tracks` that is still missing something.
   *
   * Returns without doing anything when a run is already in progress, when
   * nothing needs looking up, or when the only gaps belong to tracks already
   * attempted this session — which is what makes it safe to call on every
   * change to the library.
   */
  const sweep = useCallback(async (tracks: BackfillTrack[]) => {
    // Refuse a second run rather than interleaving two, which would double
    // the request rate and write the same track twice.
    if (busy.current) return
    const candidates = tracks.filter(
      (track) => needsBackfill(track) && !attempted.current.has(track.id),
    )
    if (!candidates.length) return

    for (const track of candidates) attempted.current.add(track.id)
    busy.current = true
    stop.current = false
    setSummary(null)
    setProgress({ ...IDLE, running: true })

    let result: BackfillRunResult
    try {
      result = await runBackfill({
        tracks: candidates,
        onApply: (trackId, patch) => apply.current(trackId, patch),
        shouldStop: () => stop.current,
        onProgress: (done, total, current) =>
          setProgress((prev) => ({ ...prev, done, total, current })),
      })
    } finally {
      busy.current = false
      stop.current = false
    }

    setProgress({
      running: false,
      total: result.total,
      done: result.filled + result.skipped,
      current: null,
      filled: result.filled,
      skipped: result.skipped,
    })
    setSummary({
      filled: result.filled,
      skipped: result.skipped,
      cancelled: result.cancelled,
    })
    finished.current?.(result)
  }, [])

  const cancel = useCallback(() => {
    stop.current = true
  }, [])

  const dismissSummary = useCallback(() => setSummary(null), [])

  return { progress, summary, sweep, cancel, dismissSummary }
}
