import { throttle } from './metadata'

/**
 * Background about an artist, for the Info field below the player.
 *
 * Three sources, none of which needs an API key or an account:
 *
 *  1. **MusicBrainz** for the facts that must be right — genres, where the
 *     band is from, when it formed. Its *search* endpoint returns an empty
 *     `genres` array even for heavily tagged artists, so the artist is looked
 *     up by id afterwards, which does hydrate them.
 *  2. **Wikidata -> Wikipedia** for the readable prose. The link is a real
 *     MusicBrainz `wikidata` URL relation, so the article is the artist's own
 *     and not whatever a title search happens to rank first.
 *  3. **iTunes** purely as a gap-filler for genre and year, because
 *     MusicBrainz returns nothing for either surprisingly often.
 *
 * Why not just look the artist up on Wikipedia directly? Because it is wrong
 * often enough to matter: `Machine_Head` resolves to the *disambiguation* page
 * ("part of the tuning mechanism of a stringed instrument"), not the thrash
 * metal band. Going through the artist's own Wikidata item gets the right
 * article, because a human has already disambiguated it.
 */

export interface ArtistFacts {
  /** Prose for the Info field, already formatted. Null when nothing was found. */
  info: string | null
  /** Style tags from MusicBrainz, most-voted first. */
  genres: string[]
  /** When the artist formed. Describes the band, not this recording. */
  formedYear: number | null
  /**
   * Release year of this particular track, when iTunes knows it.
   *
   * Kept apart from `formedYear` on purpose. Nirvana formed in 1987 and
   * "Smells Like Teen Spirit" came out in 1991; writing either number into the
   * other's slot puts a wrong date on the track the user added.
   */
  releaseYear: number | null
  /** The Wikipedia article the prose came from. */
  wikipediaUrl: string | null
  /** A photograph of the artist, when the article has one. */
  photoUrl: string | null
}

export const EMPTY_FACTS: ArtistFacts = {
  info: null,
  genres: [],
  formedYear: null,
  releaseYear: null,
  wikipediaUrl: null,
  photoUrl: null,
}

/** Removes legacy style/genre bullets now that genres have their own field. */
export function stripGenreLines(info: string): string {
  return info.split('\n').filter((line) => !/^\s*(?:styles|genres):/i.test(line)).join('\n').trim()
}

// --------------------------------------------------------------- MusicBrainz

interface MbArtistSearchResult {
  artists?: Array<{
    id: string
    name?: string
    score?: number
    disambiguation?: string
    'life-span'?: { begin?: string | null }
    area?: { name?: string }
    'begin-area'?: { name?: string }
    country?: string
    tags?: Array<{ name: string; count?: number }>
  }>
}

interface MbArtistLookup {
  id?: string
  name?: string
  disambiguation?: string
  country?: string
  area?: { name?: string }
  'begin-area'?: { name?: string }
  'life-span'?: { begin?: string | null }
  genres?: Array<{ name: string; count?: number }>
  relations?: Array<{
    type?: string
    'target-type'?: string
    url?: { resource?: string }
  }>
}

async function musicBrainzArtistId(
  artist: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const query = `artist:"${artist.replace(/"/g, '')}"`
  await throttle()
  const res = await fetch(
    `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query)}` +
      `&fmt=json&limit=5`,
    {
      signal,
      headers: { 'User-Agent': 'TrackVault/0.1 (local library app)' },
    },
  )
  if (!res.ok) throw new Error(`MusicBrainz artist search failed (${res.status}).`)
  const data = (await res.json()) as MbArtistSearchResult
  const artists = data.artists ?? []
  if (!artists.length) return null

  // The search's own ordering is by relevance score, which is usually right but
  // collapses "Machine Head" onto an unremarkable 1980s Scottish post-punk
  // band. Prefer an exact name match and only fall back to the top hit.
  const wanted = nameKey(artist)
  const exact = artists.find((a) => nameKey(a.name ?? '') === wanted)
  return (exact ?? artists[0]).id ?? null
}

async function lookupMusicBrainzArtist(
  id: string,
  signal?: AbortSignal,
): Promise<MbArtistLookup | null> {
  await throttle()
  const res = await fetch(
    `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(id)}` +
      `?inc=genres%2Burl-rels&fmt=json`,
    {
      signal,
      headers: { 'User-Agent': 'TrackVault/0.1 (local library app)' },
    },
  )
  if (!res.ok) return null
  return (await res.json()) as MbArtistLookup
}/** The minimum shape `wikidataIdFrom` needs, so it can be tested directly. */
export interface MbArtistLookupLike {
  relations?: Array<{
    type?: string
    url?: { resource?: string }
  }>
}

/** The Q-id from the artist's own `wikidata` URL relation, if MusicBrainz has one. */
export function wikidataIdFrom(artist: MbArtistLookupLike): string | null {
  for (const relation of artist.relations ?? []) {
    if (relation.type !== 'wikidata' && relation.type !== 'wikidata wikipedia') {
      continue
    }
    const resource = relation.url?.resource ?? ''
    const match = /\/wiki\/(Q\d+)$/.exec(resource)
    if (match) return match[1]
  }
  return null
}

// ------------------------------------------------- Wikidata -> Wikipedia prose

interface WdEntity {
  entities?: Record<
    string,
    {
      sitelinks?: Record<string, { title?: string }>
      descriptions?: Record<string, { value?: string }>
    }
  >
}

async function englishWikipediaTitle(
  qid: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch(
    'https://www.wikidata.org/w/api.php?action=wbgetentities' +
      `&ids=${encodeURIComponent(qid)}&props=sitelinks&sitefilter=enwiki` +
      '&format=json&origin=*',
    { signal },
  )
  if (!res.ok) return null
  const data = (await res.json()) as WdEntity
  const title = data.entities?.[qid]?.sitelinks?.enwiki?.title
  return title?.trim() || null
}

interface WikiSummary {
  title?: string
  description?: string
  extract?: string
  thumbnail?: { source?: string }
  content_urls?: { desktop?: { page?: string } }
}

async function wikipediaSummary(
  title: string,
  signal?: AbortSignal,
): Promise<WikiSummary | null> {
  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      title.replace(/ /g, '_'),
    )}`,
    { signal },
  )
  if (!res.ok) return null
  return (await res.json()) as WikiSummary
}

// ------------------------------------------------------- iTunes gap-filling

interface ITunesResult {
  trackName?: string
  artistName?: string
  primaryGenreName?: string
  releaseDate?: string
}

export interface ITunesFill {
  genre: string | null
  year: number | null
}

/**
 * Asks iTunes for the genre and year MusicBrainz did not have.
 *
 * The title is checked before the answer is believed. iTunes happily returns
 * `Only for the Weak (Re-Recorded)` for `Only for the Weak` — a different
 * recording with a different release date — and writing that year onto the
 * track the user actually added would be worse than writing nothing at all.
 */
export async function fetchITunesFill(
  title: string,
  artist: string,
  signal?: AbortSignal,
): Promise<ITunesFill> {
  const none: ITunesFill = { genre: null, year: null }
  try {
    const term = encodeURIComponent(`${title} ${artist}`.trim())
    const res = await fetch(
      `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`,
      { signal },
    )
    if (!res.ok) return none
    const data = (await res.json()) as { results?: ITunesResult[] }
    const hit = data.results?.[0]
    if (!hit) return none
    if (!titlesMatch(hit.trackName ?? '', title)) return none

    const genre = hit.primaryGenreName?.trim() || null
    const year = Number((hit.releaseDate ?? '').slice(0, 4))
    const sameRelease = isSameRelease(hit.trackName ?? '', title)
    return {
      genre,
      year:
        sameRelease && Number.isFinite(year) && year > 1000 ? year : null,
    }
  } catch {
    // A gap-filler is never worth surfacing an error over.
    return none
  }
}

/**
 * Whether an iTunes result is the recording that was asked for.
 *
 * Deliberately loose about the things iTunes itself changes — it title-cases
 * (`Locust` -> `Locust`) and appends a version marker (`Only for the Weak
 * (Re-Recorded)`) — but still refuses a genuinely different song.
 */
export function titlesMatch(found: string, wanted: string): boolean {
  const a = stripDecorations(found)
  const b = stripDecorations(wanted)
  if (!a || !b) return false
  if (a === b) return true
  return a.startsWith(`${b} `) || b.startsWith(`${a} `)
}

/**
 * Whether iTunes returned the *same release*, not merely the same song.
 *
 * The distinction decides whether the year can be believed. A re-record or a
 * deluxe edition is the same song, so its genre is safe to take — but its
 * release date belongs to a different recording, and writing 2020 onto a 1993
 * track because iTunes answered with the re-recorded version would be a lie
 * sitting in the user's library.
 */
export function isSameRelease(found: string, wanted: string): boolean {
  const a = stripDecorations(found)
  const b = stripDecorations(wanted)
  return Boolean(a) && a === b
}

/**
 * Removes the parts of a title that carry no identity: marketing decorations
 * and feature credits.
 *
 * Version markers (`(Re-Recorded)`, `(Deluxe Edition)`, `(Live)`) are
 * deliberately kept, because they are exactly what `isSameRelease` exists to
 * notice.
 */
function stripDecorations(value: string): string {
  return nameKey(
    value
      .replace(/\((?:official\s+)?(?:music\s+)?video\)/gi, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\bofficial\s+(?:audio|lyric\s+video|visualizer)\b/gi, ' ')
      .replace(/\b(?:feat|ft|featuring)\.?\s+[^,]+/gi, ' ')
      .replace(/\s*[-–—]\s*.*$/, ' '),
  )
}

/**
 * A comparison key for an artist name, not a name cleaner.
 *
 * Deliberately not called `normaliseName`: `agentInbox` exports a function of
 * that name which strips release noise ("(Remastered 2011)") from a title, and
 * two functions with one name that do different things is how a rule gets fixed
 * in the wrong file. This one only folds accents, case and punctuation so two
 * spellings of one artist compare equal.
 */
function nameKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
// ----------------------------------------------------------- the whole chain

export interface ArtistFactsRequest {
  /** Artist name as the user typed it. */
  artist: string
  /** The track's title, used only to sanity-check the iTunes gap-fill. */
  title?: string
  signal?: AbortSignal
}

/**
 * Looks up everything the Info panel shows for a newly added track.
 *
 * Never throws for an ordinary miss — a band that is not on MusicBrainz is a
 * normal outcome, not an error — but it does let a genuine network failure
 * through so the caller can decide whether to say anything. `signal` is the
 * only way to cancel.
 */
export async function fetchArtistFacts(
  request: ArtistFactsRequest,
): Promise<ArtistFacts> {
  const artist = request.artist.trim()
  if (!artist) return EMPTY_FACTS

  const id = await musicBrainzArtistId(artist, request.signal)
  if (!id) return EMPTY_FACTS
  const mb = await lookupMusicBrainzArtist(id, request.signal)
  if (!mb) return EMPTY_FACTS

  const qid = wikidataIdFrom(mb)
  let summary: WikiSummary | null = null
  if (qid) {
    const title = await englishWikipediaTitle(qid, request.signal)
    if (title) summary = await wikipediaSummary(title, request.signal)
  }

  const genres = pickGenres(mb.genres)
  const formedYear = formedYearOf(mb)

  // iTunes is asked for this track specifically, because MusicBrainz at the
  // artist level cannot know when a single song came out.
  let releaseYear: number | null = null
  if (request.title) {
    const fill = await fetchITunesFill(request.title, artist, request.signal)
    releaseYear = fill.year
    // MusicBrainz's own tags win; iTunes only supplies one when there are none,
    // because its genre is a single coarse shelf label ("Rock") next to real
    // ones like "grunge" and "alternative rock".
    if (!genres.length && fill.genre) genres.push(fill.genre)
  }

  return buildFacts(artist, mb, summary, genres, formedYear, releaseYear)
}

/**
 * Picks the style tags worth showing from MusicBrainz's artist genres.
 *
 * These are community votes, and the tail of the list is not merely less popular
 * but wrong: Nirvana scores 67 on "grunge" and 1 on "psytrance", "new age" and
 * "pigfuck", and every one of those trailing tags would otherwise be written
 * into the user's library as though it described the music.
 *
 * A tag needs at least two votes to count. When an obscure artist has nothing
 * that well attested, the top few are used anyway rather than showing nothing —
 * a single-vote tag is weak evidence, but it is still the community's best
 * answer, and this is a suggestion the user can always ignore.
 */
export function pickGenres(
  raw: Array<{ name?: string; count?: number }> | undefined,
  limit = 6,
): string[] {
  const ranked = (raw ?? [])
    .map((genre) => ({ name: (genre.name ?? '').trim(), count: genre.count ?? 0 }))
    .filter((genre) => genre.name)
    .sort((a, b) => b.count - a.count)

  const trusted = ranked.filter((genre) => genre.count >= 2)
  const seen = new Set<string>()
  const out: string[] = []
  for (const genre of (trusted.length ? trusted : ranked).slice(0, limit)) {
    const key = genre.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(genre.name)
  }
  return out
}

function buildFacts(
  artistName: string,
  mb: MbArtistLookup,
  summary: WikiSummary | null,
  genres: string[],
  formedYear: number | null,
  releaseYear: number | null,
): ArtistFacts {
  const facts: ArtistFacts = {
    info: null,
    genres,
    formedYear,
    releaseYear,
    wikipediaUrl: summary?.content_urls?.desktop?.page ?? null,
    photoUrl: summary?.thumbnail?.source ?? null,
  }
  facts.info = formatInfo(artistName, summary, {
    genres,
    formedYear,
    disambiguation: mb.disambiguation?.trim() || null,
    origin: mb['begin-area']?.name?.trim() || mb.area?.name?.trim() || null,
  })
  return facts
}

function formedYearOf(artist: MbArtistLookup): number | null {
  const begin = artist['life-span']?.begin ?? ''
  const year = Number(begin.slice(0, 4))
  return Number.isFinite(year) && year > 1000 ? year : null
}

// ---------------------------------------------------------------- formatting

/** The MusicBrainz-side facts the Info text is built from. */
export interface InfoBits {
  genres: string[]
  formedYear: number | null
  /** MusicBrainz's own one-line identifier for the artist. */
  disambiguation: string | null
  /** Where they are from. */
  origin: string | null
}

/**
 * Turns the lookup into the text the Info field shows.
 *
 * Info is prose and background only. Genres are saved in the dedicated Genres
 * field so they do not appear twice on the track.
 *
 * The Wikipedia description and MusicBrainz's disambiguation usually say the
 * same thing, so only the first of them is ever used — printing "American
 * heavy metal band from Oakland" twice, once in the extract and once in the
 * summary line, reads like a bug.
 */
export function formatInfo(
  artistName: string,
  summary: WikiSummary | null,
  bits: InfoBits,
): string | null {
  const blocks: string[] = []

  const extract = summary?.extract?.trim()
  if (extract) {
    blocks.push(extract)
  } else {
    const sentence = fallbackSentence(artistName, summary, bits)
    if (sentence) blocks.push(sentence)
  }

  const page = summary?.content_urls?.desktop?.page
  if (page) blocks.push(`From ${summary?.title ?? artistName} on Wikipedia: ${page}`)

  return blocks.length ? blocks.join('\n\n') : null
}

/**
 * The entry when Wikipedia has nothing.
 *
 * Built around an em dash on purpose: `<name> — <description>` stays
 * grammatical whether the description is "American heavy metal band", "solo
 * project", or a place name, which the alternatives ("is a...", "was formed
 * in...") each fail on.
 */
function fallbackSentence(
  artistName: string,
  summary: WikiSummary | null,
  bits: InfoBits,
): string | null {
  const what =
    summary?.description?.trim() || bits.disambiguation?.trim() || null
  const formed = bits.formedYear ? `formed ${bits.formedYear}` : ''
  if (!what && !formed) return null
  const detail = [what, bits.origin ? `from ${bits.origin}` : '']
    .filter(Boolean)
    .join(' ')
  const tail = [detail, formed].filter(Boolean).join(', ')
  return `${artistName} — ${tail}.`
}
