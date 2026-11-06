/**
 * Optional lyrics, fetched on demand.
 *
 * There is no lyrics column in the library and no scraping: a track's lyrics
 * are looked up only when requested. LRCLIB is preferred; Lyrics.ovh is a
 * fallback when LRCLIB has no match. Results are stored on the track.
 *
 * Everything that decides *what* to show is a pure function so it can be tested
 * without a network: only the final `fetchLyrics` call touches the network, and
 * it is allowed to fail.
 */

/** The service. Public and unauthenticated; documented at lrclib.net. */
export const LYRICS_ENDPOINT = 'https://lrclib.net/api/get'

/**
 * Shown next to the lyrics in the UI.
 *
 * The words are somebody else's, fetched at play time, and mostly
 * community-supplied. Naming the source is the difference between a lyric
 * panel and an unattributed quote.
 */
export const LYRICS_CREDIT = 'LRCLIB (lrclib.net)'
export const LYRICS_OVH_CREDIT = 'Lyrics.ovh API (lyrics.ovh)'
const LYRICS_OVH_ENDPOINT = 'https://api.lyrics.ovh/v1'

export interface LyricsQuery {
  title: string
  artist: string
}

/** Fields of the LRCLIB response this module cares about. */
export interface LyricsPayload {
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

const MAX_FIELD = 120

/**
 * Builds the lookup URL.
 *
 * Trimmed and length-capped because the artist and title come from a library
 * the user types into, and an untrimmed name makes the service miss. An empty
 * artist is dropped rather than sent as `artist_name=` — some tracks are only
 * findable by title alone.
 */
export function lyricsLookupUrl(query: LyricsQuery): string {
  const params = new URLSearchParams()
  const title = query.title.trim().slice(0, MAX_FIELD)
  const artist = query.artist.trim().slice(0, MAX_FIELD)
  if (artist) params.set('artist_name', artist)
  if (title) params.set('track_name', title)
  return `${LYRICS_ENDPOINT}?${params.toString()}`
}

/**
 * True when there is nothing worth searching for.
 *
 * A nameless track cannot be looked up, and the panel must not then sit there
 * saying "no lyrics found" about a track that has no name yet.
 */
export function canLookUpLyrics(query: LyricsQuery): boolean {
  return query.title.trim().length > 0 && query.artist.trim().length > 0
}

const TIMESTAMP = /^\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]$/
const METADATA_TAG = /^\[[a-z]{2,12}:.*\]$/i

/**
 * Turns an LRC line into the words, dropping the timestamp.
 *
 * A line can carry both (`[01:23.45] words`), and a metadata line such as
 * `[ar:Someone]` is not a lyric at all — showing it verbatim would put a
 * credit block above the song.
 */
export function stripLrcLine(line: string): string {
  let out = line
  while (out.startsWith('[')) {
    const close = out.indexOf(']')
    if (close === -1) break
    const tag = out.slice(0, close + 1)
    if (!TIMESTAMP.test(tag) && !METADATA_TAG.test(tag)) break
    out = out.slice(close + 1).trim()
  }
  return out
}

/**
 * Picks the text to display from a service response.
 *
 * Plain text wins because it needs no cleaning. Synced lyrics are the fallback,
 * reduced to plain lines. Returns null — "no lyrics" — rather than an empty
 * string, so the caller can hide the section instead of rendering a blank box.
 */
export function pickLyrics(payload: LyricsPayload | null | undefined): string | null {
  const plain = payload?.plainLyrics?.trim()
  if (plain) return plain

  const synced = payload?.syncedLyrics
  if (!synced) return null
  const lines = synced
    .split('\n')
    .map((line) => stripLrcLine(line.replace(/\r$/, '')))
    .filter((line) => line.length > 0)
  const text = lines.join('\n').trim()
  return text.length > 0 ? text : null
}

type CacheEntry = { text: string | null; source: string | null; at: number }

const cache = new Map<string, CacheEntry>()
const CACHE_MS = 10 * 60 * 1000

/** Cache key: the pair that identifies a recording, normalised for case. */
export function lyricsCacheKey(query: LyricsQuery): string {
  return `${query.artist.trim().toLowerCase()}|${query.title.trim().toLowerCase()}`
}

/** Clears the memo. Exported for tests and for a manual "look again". */
export function clearLyricsCache(): void {
  cache.clear()
}

/**
 * Looks up lyrics, returning null when there are none, the lookup is not
 * possible, or the network fails.
 *
 * Never throws: a lyrics panel is an extra, and a failing it must not put an
 * error in front of someone who just wanted to play a track.
 */
export interface LyricsResult {
  text: string
  source: string
}

/** LRCLIB first, Lyrics.ovh if it has no match; report the actual provider. */
export async function fetchLyricsResult(
  query: LyricsQuery,
  signal?: AbortSignal,
): Promise<LyricsResult | null> {
  if (!canLookUpLyrics(query)) return null
  const key = lyricsCacheKey(query)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.text && hit.source ? { text: hit.text, source: hit.source } : null
  }

  try {
    const res = await fetch(lyricsLookupUrl(query), { signal })
    if (res.ok) {
      const text = pickLyrics((await res.json()) as LyricsPayload)
      if (text) {
        cache.set(key, { text, source: LYRICS_CREDIT, at: Date.now() })
        return { text, source: LYRICS_CREDIT }
      }
    }
  } catch { /* Try the fallback provider. */ }

  try {
    const artist = encodeURIComponent(query.artist.trim().slice(0, MAX_FIELD))
    const title = encodeURIComponent(query.title.trim().slice(0, MAX_FIELD))
    const res = await fetch(`${LYRICS_OVH_ENDPOINT}/${artist}/${title}`, { signal })
    if (res.ok) {
      const payload = await res.json() as { lyrics?: string | null }
      const text = payload.lyrics?.trim() || null
      if (text) {
        cache.set(key, { text, source: LYRICS_OVH_CREDIT, at: Date.now() })
        return { text, source: LYRICS_OVH_CREDIT }
      }
    }
  } catch { /* A lookup miss or network failure stays a quiet miss. */ }

  cache.set(key, { text: null, source: null, at: Date.now() })
  return null
}

