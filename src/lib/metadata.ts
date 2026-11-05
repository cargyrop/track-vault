import { normaliseDuration } from './libraryImport'
import { oembedUrl, readOEmbedStatus } from './oembed'
import { parseYouTubeId, watchUrl } from './youtube'

export interface OEmbedInfo {
  youtubeId: string
  title: string
  authorName: string
  thumbnailUrl: string
  url: string
}

/**
 * Whether a video id actually exists on YouTube, via the keyless oEmbed
 * endpoint — the same lookup the add dialog uses before it fills anything in.
 *
 * Tri-state on purpose: `true` means the video answered, `false` means
 * YouTube said it is not there, and `null` means the check itself failed (a
 * network hiccup, a 429, a timeout). Callers fail *open* on `null` — a
 * flaky connection must never delete or reject a track, only a definite
 * absence does that.
 */
export async function checkVideoExists(
  youtubeId: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  let res: Response
  try {
    res = await fetch(oembedUrl(youtubeId), {
      signal: signal ?? AbortSignal.timeout(10000),
    })
  } catch {
    return null
  }
  if (res.ok) return true
  // A removal or privacy change answers 404, and a well-formed id with no
  // video behind it answers 400. Anything else — a rate limit, a bad-gateway
  // day — is "could not tell". The mapping itself lives with the link probe,
  // which asks the same endpoint.
  const answer = readOEmbedStatus(res.status)
  if (answer === 'gone') return false
  return null
}

/** Fetches title + thumbnail straight from YouTube's oEmbed endpoint (no key). */
export async function fetchOEmbed(
  input: string,
  signal?: AbortSignal,
): Promise<OEmbedInfo | null> {
  const youtubeId = parseYouTubeId(input)
  if (!youtubeId) return null
  const res = await fetch(oembedUrl(youtubeId), { signal })
  if (!res.ok) return null
  const data = (await res.json()) as {
    title?: string
    author_name?: string
    thumbnail_url?: string
  }
  return {
    youtubeId,
    title: data.title?.trim() ?? '',
    authorName: data.author_name?.trim() ?? '',
    thumbnailUrl: data.thumbnail_url ?? '',
    url: watchUrl(youtubeId),
  }
}

// ---------------------------------------------------------------- MusicBrainz

export interface MbMatch {
  recordingId: string
  title: string
  artist: string
  album: string | null
  year: number | null
  coverUrl: string | null
  genres: string[]
  /** Running time in whole seconds, when MusicBrainz knows one. */
  duration: number | null
  score: number
}

interface MbRelease {
  id: string
  title?: string
  date?: string
  'cover-art-archive'?: { available?: boolean }
}

interface MbRecording {
  id: string
  title: string
  score?: number
  /** Running time in milliseconds. Absent when MusicBrainz has not timed it. */
  length?: number
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>
  releases?: MbRelease[]
  genres?: Array<{ name: string; count: number }>
}

let lastCall = 0

/**
 * MusicBrainz asks for at most one request per second.
 *
 * Exported rather than kept private so that every MusicBrainz call in the app
 * shares one limiter. Two independent limiters would each allow a request per
 * second and together double the rate MusicBrainz sees, which is how you get a
 * 503 back and a metadata lookup that mysteriously fails on busy albums.
 */
export async function throttle(): Promise<void> {
  const wait = 1000 - (Date.now() - lastCall)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
}

function joinArtistCredit(credit: MbRecording['artist-credit']): string {
  if (!credit?.length) return ''
  return credit
    .map((c) => c.artist?.name ?? c.name ?? '')
    .filter(Boolean)
    .join(', ')
}

function releaseYear(release: MbRelease): number | null {
  const date = release.date ?? ''
  const year = Number(date.slice(0, 4))
  return Number.isFinite(year) && year > 0 ? year : null
}

/**
 * Queries MusicBrainz using Lucene field syntax.
 *
 * A plain "title artist" search returns mashups and remixes that merely mention
 * the artist ("Happy (Pharrell Williams)" by Michmash), which crowds out the
 * real recording. Field-qualified queries constrain the fields directly and
 * return the correct artist at full score, so we try the strict form first and
 * only widen if it finds nothing.
 */
export function buildMusicBrainzQuery(title: string, artist: string): string[] {
  const t = title.trim().replace(/"/g, '')
  const a = artist.trim().replace(/"/g, '')
  const queries: string[] = []
  if (t && a) queries.push(`recording:"${t}" AND artist:"${a}"`)
  if (t) queries.push(`recording:"${t}"`)
  if (!queries.length) return []
  queries.push([t, a].filter(Boolean).join(' '))
  return queries
}

export async function searchMusicBrainz(
  title: string,
  artist: string,
  signal?: AbortSignal,
): Promise<MbMatch[]> {
  const queries = buildMusicBrainzQuery(title, artist)
  if (!queries.length) return []

  for (const query of queries) {
    const matches = await runMusicBrainzQuery(query, artist, signal)
    // A strict match is authoritative; widening is only a fallback.
    if (matches.length) return matches
  }
  return []
}

async function runMusicBrainzQuery(
  query: string,
  artist: string,
  signal?: AbortSignal,
): Promise<MbMatch[]> {
  await throttle()
  const url =
    `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}` +
    `&fmt=json&limit=8&inc=releases+genres+artist-credits`

  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': 'TrackVault/0.1 (local library app)' },
  })
  if (!res.ok) throw new Error(`MusicBrainz search failed (${res.status}).`)

  const data = (await res.json()) as { recordings?: MbRecording[] }
  const matches: MbMatch[] = []

  for (const rec of data.recordings ?? []) {
    const mbArtist = joinArtistCredit(rec['artist-credit'])
    // A wildly different artist means this is the wrong recording entirely.
    if (artist && mbArtist && !looseMatch(mbArtist, artist)) continue

    const withArt = (rec.releases ?? []).find(
      (r) => r['cover-art-archive']?.available && r.title,
    )
    const firstRelease = rec.releases?.[0]
    const chosen = withArt ?? firstRelease

    matches.push({
      recordingId: rec.id,
      title: rec.title,
      artist: mbArtist || artist,
      album: chosen?.title ?? null,
      year: chosen ? releaseYear(chosen) : null,
      coverUrl: chosen?.id
        ? `https://coverartarchive.org/release/${chosen.id}/front-500`
        : null,
      genres: (rec.genres ?? [])
        .filter((g) => g.count > 0)
        .slice(0, 6)
        .map((g) => titleCase(g.name)),
      duration: normaliseDuration(rec.length ? rec.length / 1000 : null),
      score: rec.score ?? 0,
    })
  }

  return matches.sort((a, b) => b.score - a.score)
}

/**
 * Reads one recording in full, by its MusicBrainz ID.
 *
 * This exists because the search endpoint cannot answer the question the add
 * dialog asks. `runMusicBrainzQuery` sends `inc=genres`, and MusicBrainz accepts
 * it and then ignores it: a search response comes back with `genres: []` even
 * for recordings that are definitely tagged — Bohemian Rhapsody returns an empty
 * array. The lookup endpoint does hydrate the same field, so genres are only
 * ever available after resolving an ID.
 *
 * That single behaviour is why every track in the library had no genres: the
 * genres were requested correctly, returned as an empty array, and merged in as
 * nothing. One extra request per track is a cheap price for the field actually
 * arriving.
 *
 * Also the only place a track's running time can be known without playing it.
 */
export async function lookupMusicBrainzRecording(
  mbid: string,
  signal?: AbortSignal,
): Promise<MbMatch | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mbid)) {
    return null
  }
  await throttle()
  const url =
    `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(mbid)}` +
    `?fmt=json&inc=genres+artist-credits+releases`
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': 'TrackVault/0.1 (local library app)' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`MusicBrainz lookup failed (${res.status}).`)

  const rec = (await res.json()) as MbRecording
  if (!rec?.id) return null

  const withArt = (rec.releases ?? []).find(
    (r) => r['cover-art-archive']?.available && r.title,
  )
  const chosen = withArt ?? rec.releases?.[0]

  return {
    recordingId: rec.id,
    title: rec.title,
    artist: joinArtistCredit(rec['artist-credit']) || '',
    album: chosen?.title ?? null,
    year: chosen ? releaseYear(chosen) : null,
    coverUrl: chosen?.id
      ? `https://coverartarchive.org/release/${chosen.id}/front-500`
      : null,
    genres: (rec.genres ?? [])
      .filter((g) => (g.count ?? 0) > 0)
      .slice(0, 6)
      .map((g) => titleCase(g.name)),
    duration: normaliseDuration(rec.length ? rec.length / 1000 : null),
    score: 0,
  }
}

/** Normalises "Radiohead" vs "radiohead " vs "The Radioheads"-style variants. */
function looseMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return true
  return na === nb || na.includes(nb) || nb.includes(na)
}

export function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Separators that official and label uploads use to divide artist, title and
 * boilerplate. `//` is YouTube's own convention, which is why the old parser
 * missed it entirely and left "F.E.V.E.R // Official Music Video // AFM
 * Records" glued to the track title.
 */
const SEGMENT_SPLIT = /\s*(?:\||\/{2,}|-)\s*/

/** Unicode dashes used interchangeably with a plain hyphen. */
const UNICODE_DASHES = /[\u2010-\u2015\u2212]/g

/**
 * Words that make a segment pure upload boilerplate. A segment is noise only
 * when *every* word in it appears here, so a real segment such as "Music Box"
 * or "Video Games" survives.
 */
const NOISE_WORDS = new Set([
  'official',
  'music',
  'video',
  'lyric',
  'lyrics',
  'audio',
  'visualizer',
  'hd',
  'hq',
  '4k',
  'remaster',
  'remastered',
  'explicit',
  'full',
  'album',
  'only',
  'mv',
  'm/v',
])

/**
 * Broadcaster/brand suffixes that TV music shows append after the track, e.g.
 * "Metalocalypse: Dethklok | Fansong | Adult Swim". These are whole-segment
 * matches rather than loose words, so a real title containing one of the same
 * words ("Learn to Swim") is untouched.
 */
const BRANDED_SUFFIX =
  /^(?:adult\s+swim|nickelodeon|cartoon\s+network|mtv|vh1|fuse|extended\s+session)$/i

function isNoiseSegment(segment: string): boolean {
  const words = segment
    .toLowerCase()
    .replace(/[^a-z0-9/ ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return true
  if (BRANDED_SUFFIX.test(segment.trim())) return true
  return words.every((w) => NOISE_WORDS.has(w))
}

/**
 * Drops a leading show name from the artist.
 *
 * "Metalocalypse: Dethklok - Fansong" is an episode title, and saving the
 * series name as the artist is worse than saving nothing. A colon only ever
 * introduces context here because the segment is already known to be the
 * artist, never the track.
 */
function tidyArtist(segment: string): string {
  const trimmed = segment.trim()
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0) {
    const tail = trimmed.slice(colon + 1).trim()
    if (tail) return tail
  }
  return trimmed
}

/** Strips upload boilerplate a channel name may carry, e.g. "... | Music". */
function tidyChannel(channel: string): string {
  const segments = channel
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
  const kept = segments.filter((s) => !isNoiseSegment(s))
  return (kept.length ? kept : segments).join(', ').trim()
}

/**
 * Splits messy YouTube channel/title text into a plausible artist and track
 * guess. Deliberately conservative: the user always confirms before saving.
 *
 * Observed shapes this has to survive, all from real label uploads:
 *   "Radiohead - Paranoid Android (Official Video)"
 *   "Metalocalypse: Dethklok | Fansong"
 *   "ORDEN OGAN - F.E.V.E.R (2014) // Official Music Video // AFM Records"
 */
export function guessFromYouTubeTitle(
  title: string,
  channel: string,
): { title: string; artist: string } {
  // Everything from the first "//" on is upload boilerplate, never metadata.
  const core = (title.split(/\/{2,}/)[0] ?? '')
    .replace(UNICODE_DASHES, '-')
    .replace(/\s*[\[(][^\])]*[\])]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const segments = core.split(SEGMENT_SPLIT).filter(Boolean)
  // Boilerplate can sit at either end: "[Official] Track // ..." style titles
  // put it in front.
  while (segments.length && isNoiseSegment(segments[0])) segments.shift()
  while (segments.length && isNoiseSegment(segments[segments.length - 1])) {
    segments.pop()
  }

  if (segments.length >= 2) {
    return {
      artist: tidyArtist(segments[0]),
      title: segments.slice(1).join(' - ').trim(),
    }
  }

  const single = segments.join(' - ').trim()

  // "Song Name by Artist Name". A single-word tail must be long enough to be a
  // name, which is what stops "Stand by Me" from reading "Me" as the artist.
  const by = /^(.{2,}?)\s+by\s+(.{2,})$/i.exec(single)
  if (by) {
    const left = by[1].trim()
    const right = by[2].trim()
    if (right.split(/\s+/).length >= 2 || right.length >= 4) {
      return { artist: tidyArtist(right), title: left }
    }
  }

  return { artist: tidyChannel(channel), title: single }
}