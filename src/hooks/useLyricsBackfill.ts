import { useCallback, useRef, useState } from 'react'
import {
  needsLyrics,
  runLyricsBackfill,
  type LyricsBackfillRunResult,
  type LyricsBackfillTrack,
} from '../lib/lyricsBackfill'
import { fetchLyricsResult } from '../lib/lyrics'

export interface LyricsBackfillProgress {
  running: boolean
  total: number
  done: number
  current: string | null
  filled: number
  skipped: number
}

/** What the last sweep did, for the quiet line under the top bar. */
export interface LyricsBackfillSummary {
  filled: number
  skipped: number
  /** True when the run was stopped part-way through. */
  cancelled: boolean
}

const IDLE: LyricsBackfillProgress = {
  running: false,
  total: 0,
  done: 0,
  current: null,
  filled: 0,
  skipped: 0,
}

/**
 * Finds words for tracks that have none, without being asked.
 *
 * The same shape as the info backfill on purpose — a sweep the caller runs
 * when the library changes, one attempt per track per session, slow and
 * cancellable — because it is the same kind of event: material arriving for
 * gaps nobody pressed a button about. Two differences matter:
 *
 * - The write goes through the store onto blank tracks only, and a paste
 *   that lands mid-run is re-checked before each write, so typed words always
 *   beat fetched ones.
 * - The network arrives from `../lib/lyrics` directly rather than injected:
 *   the providers already memoise (including misses) and never throw, so the
 *   sweep needs no fakes of its own outside tests.
 *
 * Like its twin, it sweeps only what the caller calls new: `App` passes the
 * tracks that arrived after the window opened, so a launch no longer walks the
 * whole library looking for words. Selecting a track still looks its words up
 * on the spot, so nothing old is left unreachable.
 */
export function useLyricsBackfill(
  onApply: (
    trackId: number,
    patch: { lyrics: string; lyricsSource: string },
  ) => Promise<unknown>,
  /**
   * Called once when a run ends, whatever it managed to do. The caller uses it
   * to re-read the library, so a filled track reaches the lyrics panel.
   */
  onFinished?: (result: LyricsBackfillRunResult) => void,
) {
  const [progress, setProgress] = useState<LyricsBackfillProgress>(IDLE)
  const [summary, setSummary] = useState<LyricsBackfillSummary | null>(null)
  const stop = useRef(false)
  const busy = useRef(false)
  const apply = useRef(onApply)
  apply.current = onApply
  const finished = useRef(onFinished)
  finished.current = onFinished
  /**
   * Ids already looked up in this session, hit or miss. A track neither
   * provider knows comes back just as empty as it was, so without this the
   * next render would offer the same hopeless lookup again — and the one
   * after that. One attempt per track per session, then silence until reload.
   */
  const attempted = useRef(new Set<number>())

  /**
   * Looks up everything in `tracks` that still has no words.
   *
   * `shouldStillApply` is read per track at write time, so the caller can
   * hold back a write for a track that gained words since the sweep began.
   * Safe to call on every change to the library: concurrent runs refuse each
   * other, and a pass with nothing new costs a filter.
   */
  const sweep = useCallback(
    async (
      tracks: LyricsBackfillTrack[],
      shouldStillApply: (trackId: number) => boolean,
    ) => {
      if (busy.current) return
      const candidates = tracks.filter(
        (track) => needsLyrics(track) && !attempted.current.has(track.id),
      )
      if (!candidates.length) return

      for (const track of candidates) attempted.current.add(track.id)
      busy.current = true
      stop.current = false
      setSummary(null)
      setProgress({ ...IDLE, running: true })

      let result: LyricsBackfillRunResult
      try {
        result = await runLyricsBackfill({
          tracks: candidates,
          lookup: (query) => fetchLyricsResult(query),
          shouldStillApply,
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
    },
    [],
  )

  const cancel = useCallback(() => {
    stop.current = true
  }, [])

  const dismissSummary = useCallback(() => setSummary(null), [])

  return { progress, summary, sweep, cancel, dismissSummary }
}
