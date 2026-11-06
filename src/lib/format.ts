/**
 * How numbers are shown, in one place.
 *
 * These are small functions that were being copied into whichever component
 * needed them — the same running time was formatted three times, with two of
 * the copies agreeing by luck. A display rule that exists twice is a rule an
 * agent will fix once, so the ones that are genuinely shared live here.
 */

/**
 * A track's length: `4:33`.
 *
 * Unknown is an em dash, never `0:00`: a length the app has not measured yet
 * must not read as a track that lasts no time at all. Hours are not rolled up
 * — a track longer than an hour is vanishingly rare next to how often a
 * two-digit minute count would make the column jump around.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return '—'
  }
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

/**
 * A running clock: `1:05`, as the player's transport shows it.
 *
 * The same minutes and seconds as `formatDuration` and deliberately not the
 * same function: a clock is never unknown — before the player knows its length
 * it is at 0:00, and a station that reports nothing must not put a dash on a
 * moving timeline — and it counts whole seconds rather than rounding, because a
 * position that reads ahead of what has played is a lie the eye catches.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  return formatDuration(Math.floor(seconds))
}

/**
 * "1 track", "2 tracks" — a count and its noun.
 *
 * Every "N tracks" line in the app used to spell the ternary out for itself,
 * six times over, in the toast, the replace dialog, the play button and the
 * tracklist. One of those copies would eventually have shipped "1 tracks".
 */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}
