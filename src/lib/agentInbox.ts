/**
 * The AI drop box.
 *
 * Adding tracks by handing the whole library to a model and asking for the
 * whole library back is the obvious approach and the wrong one. It costs
 * tokens proportional to the *library* rather than the *addition*, and it asks
 * the model to retype every track you already own — including the numeric ids
 * that playlists point at, which is precisely the thing a language model
 * cannot be trusted to keep consistent.
 *
 * So the model is never asked to rewrite anything. It writes a small
 * `data/inbox.json` containing only what is new, referencing existing tracks by
 * name rather than by id, and the app merges it. The round trip is proportional
 * to what you added.
 *
 * Everything in this file is pure: it takes a document and an inbox and returns
 * a new document plus a report. The file writing, the polling and the conflict
 * handling live in the caller, which is what makes the rules below testable
 * without a server or a browser.
 */

import {
  MAX_SOURCES,
  type LibraryDocument,
  type PlaylistFolder,
  type SourceKind,
  type SourceRole,
  type StoredPlaylist,
  type StoredSource,
  type StoredTrack,
} from './types'
import { hasPlayableSource, isPlayableRole, resolveRole } from './sources'
import { classifyCoverUrl, coverRefusalReason } from './covers'
import { dedupeGenres } from './genres'
import { parseYouTubeId, watchUrl } from './youtube'

export const INBOX_FORMAT = 'trackvault-agent-inbox'
export const INBOX_VERSION = 1

// ---------------------------------------------------------------- inbox shape

/**
 * One track an agent wants to exist in the library.
 *
 * `key` is optional and only useful inside one inbox: it gives a track added by
 * this batch a name that a `playlists` entry can point at before the track has
 * an id. Without it, playlists reference tracks by title/artist and the merge
 * resolves those.
 */
export interface InboxTrack {
  title: string
  artist: string
  /** Optional handle so a playlist in this same file can point at this track. */
  key?: string | null
  album?: string | null
  year?: number | null
  coverUrl?: string | null
  musicbrainzRecordingId?: string | null
  info?: string | null
  duration?: number | null
  genres?: string[]
  /**
   * Up to three YouTube links. Written as plain strings because that is what an
   * agent can produce correctly: a bare id, a watch URL or a short link, all
   * accepted. Accepts an array too, for a file copied out of the library.
   */
  audio?: string | InboxSource | null
  video?: string | InboxSource | null
  live?: string | InboxSource | null
  sources?: Array<string | InboxSource>
}

export interface InboxSource {
  youtubeId?: string | null
  url?: string | null
  kind?: string | null
  label?: string | null
  role?: string | null
}

/** A playlist an agent wants to exist, with its tracks named rather than id'd. */
export interface InboxPlaylist {
  name: string
  description?: string | null
  /** Track references: `"Artist — Title"`, a `key` from this inbox, or an id. */
  tracks?: Array<string | number>
  /**
   * Folder path like `"Metal/Thrash"`, created on demand. Absent means the
   * playlist stays where it is — top level when new, untouched when matched.
   */
  folder?: string | null
}

export interface Inbox {
  format: string
  version: number
  note?: string | null
  tracks: InboxTrack[]
  playlists: InboxPlaylist[]
}

// ------------------------------------------------------------------ outcomes

export type MergeOutcome = 'added' | 'enriched' | 'unchanged' | 'rejected'

export interface MergeLine {
  outcome: MergeOutcome
  /** What the agent called it, for reporting back. */
  label: string
  title: string
  artist: string
  /** Why it was rejected or did not need doing. Only for non-adds. */
  reason?: string
}

export interface PlaylistMergeLine {
  name: string
  created: boolean
  added: number
  /** References that matched nothing in the library or the inbox. */
  unmatched: string[]
  /** Full folder path after the merge, or null at the top level. */
  folder: string | null
  /** An existing playlist filed into a different folder by this batch. */
  moved: boolean
}

export interface MergeReport {
  at: string
  lines: MergeLine[]
  playlists: PlaylistMergeLine[]
  added: number
  enriched: number
  unchanged: number
  rejected: number
  /** Full paths of folders this batch created, in creation order. */
  foldersCreated: string[]
  /**
   * Things the merge did, but not the way the batch asked for.
   *
   * Separate from `lines` because it is a third kind of outcome. A rejection
   * means the track did not arrive; a note means it did, and one detail of it
   * was dropped or overruled. Folding notes into `reason` would put "already
   * complete" on the same list as "no playable audio link", which is how a
   * report stops being read.
   */
  notes: string[]
}

export function emptyReport(at = new Date().toISOString()): MergeReport {
  return {
    at,
    lines: [],
    playlists: [],
    added: 0,
    enriched: 0,
    unchanged: 0,
    rejected: 0,
    foldersCreated: [],
    notes: [],
  }
}

/**
 * One sentence, for the banner and for the log.
 *
 * "Nothing happened" is derived from the counts rather than stored as a flag,
 * because a stored flag can disagree with the numbers it summarises — and the
 * one place it matters most is a batch that only created playlists, which would
 * otherwise read as though nothing arrived.
 */
export function summarise(report: MergeReport): string {
  // A pure filing batch moves playlists without touching tracks, and that is
  // still a change worth announcing rather than "Nothing to add."
  const playlists = report.playlists.filter(
    (p) => p.added > 0 || p.created || p.moved,
  )
  const unmatched = report.playlists.reduce((n, p) => n + p.unmatched.length, 0)
  const counts = report.added + report.enriched + report.rejected
  const createdFolders = report.foldersCreated ?? []
  if (!counts && !playlists.length && !createdFolders.length) return 'Nothing to add.'
  const parts: string[] = []
  if (report.added) parts.push(`${report.added} added`)
  if (report.enriched) parts.push(`${report.enriched} enriched`)
  if (report.unchanged) parts.push(`${report.unchanged} already there`)
  if (report.rejected) parts.push(`${report.rejected} rejected`)
  if (createdFolders.length) {
    parts.push(
      `${createdFolders.length} folder${createdFolders.length === 1 ? '' : 's'} (${createdFolders.join(', ')})`,
    )
  }
  // Counted here as well as in the per-line detail, because a playlist
  // reference that matched nothing is a track the person asked for and did not
  // get. Leaving it out made the headline and the "could not be added" count
  // disagree with each other.
  if (unmatched) {
    parts.push(`${unmatched} playlist reference${unmatched === 1 ? '' : 's'} not found`)
  }
  const head = parts.join(', ')
  if (!playlists.length) return head || 'Nothing to add.'
  const named = playlists.map((p) => p.name).join(', ')
  const list = `${playlists.length} playlist${playlists.length === 1 ? '' : 's'} (${named})`
  return head ? `${head} · ${list}` : list
}

/**
 * A short, stable fingerprint of a merge report.
 *
 * Answers "is this the same batch I was already told about?", which is a real
 * question because the report is a file on disk: the server re-serves
 * `data/last-merge.json` on every poll, so without a fingerprint a batch merged
 * days ago would be announced again at the top of the window after every
 * refresh. The summary line alone is not enough to identify a batch — two
 * different batches can both read "2 added".
 *
 * FNV-1a over the serialised report rather than the JSON itself: the report is
 * small, but it is compared against a value kept in browser storage, and a
 * hundred lines of rejections do not belong there verbatim.
 */
export function reportSignature(report: MergeReport): string {
  const body = JSON.stringify(report)
  let hash = 0x811c9dc5
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i)
    // Math.imul keeps the multiply in 32-bit space, where `*` would lose the
    // low bits to floating point and make the hash far more collision-prone.
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// -------------------------------------------------------------------- parsing

/**
 * Reads an inbox written by anything at all: an agent, a script, a human.
 *
 * Deliberately forgiving in the same way `normalise()` is, because the file is
 * written by a language model and the point of the whole feature is that a
 * slightly wrong file still does the right thing instead of failing. Anything
 * genuinely unusable is dropped here and reported as a rejected line by the
 * merge rather than throwing.
 */
export function parseInbox(raw: string): Inbox {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw || '{}')
  } catch {
    parsed = {}
  }
  const doc = (parsed ?? {}) as Partial<Inbox>
  const rawTracks = Array.isArray(doc.tracks) ? doc.tracks : []
  const rawPlaylists = Array.isArray(doc.playlists) ? doc.playlists : []

  const tracks: InboxTrack[] = rawTracks
    .map((t) => (t ?? {}) as Partial<InboxTrack>)
    .filter((t) => String(t.title ?? '').trim() || String(t.artist ?? '').trim())
    .map((t) => ({
      title: String(t.title ?? '').trim(),
      artist: String(t.artist ?? '').trim(),
      key: t.key ? String(t.key).trim() : null,
      album: text(t.album),
      year: positiveInt(t.year),
      coverUrl: text(t.coverUrl),
      musicbrainzRecordingId: text(t.musicbrainzRecordingId),
      info: text(t.info) ?? text((t as { notes?: unknown }).notes),
      duration: positiveInt(t.duration),
      genres: Array.isArray(t.genres)
        ? dedupeGenres(
            t.genres.map((g) => String(g ?? '').trim()).filter(Boolean),
          )
        : [],
      audio: t.audio ?? null,
      video: t.video ?? null,
      live: t.live ?? null,
      sources: Array.isArray(t.sources) ? t.sources : undefined,
    }))

  const playlists: InboxPlaylist[] = rawPlaylists
    .map((p) => (p ?? {}) as Partial<InboxPlaylist>)
    .filter((p) => String(p.name ?? '').trim())
    .map((p) => ({
      name: String(p.name).trim(),
      description: text(p.description),
      tracks: Array.isArray(p.tracks)
        ? p.tracks.filter(
            (r): r is string | number =>
              typeof r === 'string' || typeof r === 'number',
          )
        : [],
      folder: text(p.folder),
    }))

  return {
    format: INBOX_FORMAT,
    version: Number(doc.version) || INBOX_VERSION,
    note: text(doc.note),
    tracks,
    playlists,
  }
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s || null
}

function positiveInt(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

// ------------------------------------------------------------- key resolution

/**
 * Wording that describes the *release or the file*, never a different
 * recording, so it must not stop two spellings of one track from matching.
 */
const RELEASE_NOISE = new Set([
  'remaster',
  'remastered',
  'remastered version',
  'remaster version',
  'anniversary',
  'anniversary edition',
  'bonus',
  'bonus track',
  'deluxe',
  'deluxe edition',
  'explicit',
  'clean',
  'clean version',
  'dirty',
  'album version',
  'single version',
  'radio edit',
  'official',
  'official video',
  'official audio',
  'official lyric video',
  'official music video',
  'lyric video',
  'music video',
  'video',
  'audio',
  'hd',
  'hq',
  'full album',
  'stereo',
  'mono',
])

/** Case-folds and strips punctuation, with no notion of titles or asides. */
function fold(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "Bjork" and "Björk" are the same artist.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isReleaseNoise(aside: string): boolean {
  const text = fold(aside)
  if (!text) return false
  // Phrases first ("official music video"), then word by word ("remastered
  // 2011"). Either way every word has to be accounted for — a single unknown
  // word means the aside is describing something real.
  if (RELEASE_NOISE.has(text)) return true
  // A bare year is release metadata — "(Remastered 2011)", "- Remastered 2020".
  const isYear = (w: string) => /^(1[5-9]|20)\d{2}$/.test(w)
  return text.split(' ').every((w) => RELEASE_NOISE.has(w) || isYear(w))
}

/**
 * Normalises a title or artist for comparison.
 *
 * Folds case, collapses whitespace, and drops the punctuation a model varies
 * on (a trailing `?` or `!`) so "Is There Anybody out There?" and "Is There
 * Anybody Out There" are one track rather than two.
 *
 * Bracketed asides are dropped **only when they are about the release** — the
 * `(Remastered)`, `- Official Video`, `(Deluxe)` that decorate one recording.
 * A word that names a *different performance* is kept, and this distinction is
 * load-bearing: stripping `(Live at the Ritz)` would collapse a requested live
 * take onto the studio track, and since the studio track already has both
 * source slots full, the merge would report "already complete" and throw the
 * live version away without saying so. Getting that wrong loses data
 * silently, whereas leaving a near-duplicate alone is visible and fixable, so
 * the rule only ever errs towards keeping the difference.
 */
export function normaliseName(value: string): string {
  let out = String(value ?? '')
  out = out.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (whole, paren, bracket) =>
    isReleaseNoise(String(paren ?? bracket ?? '')) ? ' ' : whole,
  )
  // The same, written as a trailing "- Remastered 2011" rather than in brackets.
  out = out.replace(/\s+[-–—]\s+([^–—-]+)$/, (whole, tail) =>
    isReleaseNoise(tail) ? ' ' : whole,
  )
  return fold(out)
}

/**
 * The identity an agent can use to point at a track it did not create.
 *
 * Deliberately human-readable rather than an opaque hash: when a reference
 * fails to resolve, the unmatched list is shown to the person, and a readable
 * one is debuggable.
 */
export function trackKey(artist: string, title: string): string {
  return `${normaliseName(artist)} :: ${normaliseName(title)}`
}

/**
 * Indexes the library so dedupe and playlist references resolve without ids.
 *
 * Both a full `artist — title` key and a bare title are indexed. A bare title
 * that matches more than one track is stored as `null`, which makes it
 * unresolvable: an ambiguous reference comes back as unmatched rather than
 * quietly landing on the wrong song.
 */
function indexLibrary(doc: LibraryDocument): {
  byKey: Map<string, StoredTrack>
  byTitle: Map<string, StoredTrack | null>
  byMbid: Map<string, StoredTrack>
} {
  const byKey = new Map<string, StoredTrack>()
  const byTitle = new Map<string, StoredTrack | null>()
  const byMbid = new Map<string, StoredTrack>()
  for (const track of doc.tracks) {
    byKey.set(trackKey(track.artist, track.title), track)
    const title = normaliseName(track.title)
    // null marks "seen more than once", which makes it unresolvable.
    byTitle.set(title, byTitle.has(title) ? null : track)
    if (track.musicbrainzRecordingId) {
      byMbid.set(track.musicbrainzRecordingId, track)
    }
  }
  return { byKey, byTitle, byMbid }
}

// -------------------------------------------------------------------- merging

/**
 * Merges an inbox into a copy of the document.
 *
 * Three rules, in order of importance:
 *
 * 1. **Never duplicate.** A track whose MusicBrainz id is already present, or
 *    whose `artist — title` key already exists, is *enriched*: blank fields are
 *    filled, genres are unioned, and a missing source slot is attached. Nothing
 *    you already have is overwritten. Re-sending the same inbox twice is
 *    therefore a no-op, which is what makes it safe to retry.
 * 2. **Never lose a bad link.** A track with no usable YouTube link is still
 *    added — with no Main and no clip, so the list shows it in red — and the
 *    line names the bad id so the link can be fixed by hand in the track card.
 * 3. **Never lose a playlist reference.** Anything that resolves to nothing is
 *    collected and reported, so the person can see the reference was wrong
 *    instead of finding an empty playlist later.
 */
/**
 * The cover a batch is allowed to store, or null.
 *
 * Reported rather than dropped quietly. A batch that arrived with ten covers
 * and stored none of them is not the same thing as a batch that had none, and
 * the person reading the report is the one who can go and supply them.
 */
function usableCover(entry: InboxTrack, report: MergeReport): string | null {
  const raw = typeof entry.coverUrl === 'string' ? entry.coverUrl.trim() : ''
  if (!raw) return null
  const verdict = classifyCoverUrl(raw)
  if (verdict === 'album-art') return raw
  report.notes.push(
    `${entry.artist} — ${entry.title}: kept no cover, because ${coverRefusalReason(verdict)}.`,
  )
  return null
}

/**
 * Checks every distinct video id a batch asks for, and returns the dead ones.
 *
 * The merge itself is pure and cannot make requests, so the caller checks
 * first — through `checkVideoExists` or any stub with the same shape — and
 * hands the answer back in. Tri-state in, set out: `false` means YouTube said
 * the video is not there; `null` (a failed check) fails open and is simply
 * not in the set, so a flaky connection never rejects a track.
 *
 * Five at a time, because a batch can hold dozens of links and the endpoint
 * is happier with a queue than a stampede.
 *
 * `onProgress` reports completed checks against the distinct total, so a bulk
 * batch can show "Checking links 12/48…" instead of a bare spinner.
 */
export async function verifyInboxIds(
  inbox: Inbox,
  check: (youtubeId: string) => Promise<boolean | null>,
  onProgress?: (done: number, total: number) => void,
): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const entry of inbox.tracks) {
    for (const source of readSources(entry).sources) {
      ids.add(source.youtubeId)
    }
  }
  const dead = new Set<string>()
  const queue = [...ids]
  let done = 0
  const workers = Array.from(
    { length: Math.min(5, queue.length) },
    async () => {
      while (queue.length) {
        const id = queue.pop()!
        let verdict: boolean | null = null
        try {
          verdict = await check(id)
        } catch {
          verdict = null
        }
        if (verdict === false) dead.add(id)
        done++
        onProgress?.(done, ids.size)
      }
    },
  )
  await Promise.all(workers)
  return dead
}

export function mergeInbox(
  doc: LibraryDocument,
  inbox: Inbox,
  /**
   * `notes` carries findings the caller established before the merge — a cover
   * URL that no longer answers, which is a request this pure function cannot
   * make, and which the panel therefore cannot reproduce in its own preview.
   *
   * `deadIds` is the other half of that: video ids YouTube says do not exist
   * (see `verifyInboxIds`). A new track whose audio link is dead is added
   * without it — the red flag in the list — with the id named on the line; a
   * dead clip or live take is dropped with a note; an enrichment never
   * attaches a dead link. Absent entirely, the merge behaves exactly as it
   * always did — which is what lets old callers and every old test keep
   * working.
   */
  options: { now?: string; notes?: string[]; deadIds?: ReadonlySet<string> } = {},
): { doc: LibraryDocument; report: MergeReport } {
  const now = options.now ?? new Date().toISOString()
  const report = emptyReport(now)
  if (options.notes?.length) report.notes.push(...options.notes)

  const next: LibraryDocument = {
    ...doc,
    tracks: doc.tracks.map((t) => ({
      ...t,
      genres: [...t.genres],
      sources: t.sources.map((s) => ({ ...s })),
    })),
    folders: doc.folders.map((f) => ({ ...f })),
    playlists: doc.playlists.map((p) => ({ ...p, tracks: [...p.tracks] })),
  }

  let nextTrackId =
    next.tracks.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1
  let nextSourceId =
    next.tracks.reduce(
      (max, t) => Math.max(max, ...t.sources.map((s) => Number(s.id) || 0), 0),
      0,
    ) + 1
  let nextFolderId =
    next.folders.reduce((max, f) => Math.max(max, Number(f.id) || 0), 0) + 1

  const library = indexLibrary(next)
  // Tracks created by *this* batch, addressable by key so a playlist in the same
  // inbox can name them. Keyed by both the declared `key` and the artist-title
  // pair, so either way of referring to a new track works.
  const inboxTracks = new Map<string, StoredTrack>()

  for (const rawEntry of inbox.tracks) {
    // Sanitised once, so both the add and the enrich path below see the same
    // cover decision and neither has to remember to check.
    const entry: InboxTrack = {
      ...rawEntry,
      coverUrl: usableCover(rawEntry, report),
    }
    const label = entry.key ? `${entry.key}` : `${entry.artist} — ${entry.title}`
    const { sources: resolved, duplicates } = readSources(entry)
    // Dead links never reach the track below: it is built from what actually
    // plays, and every dropped id is named in the notes so the batch can come
    // back with a replacement — or the link can be fixed by hand.
    const dead = resolved.filter((s) => options.deadIds?.has(s.youtubeId))
    const sources = resolved.filter((s) => !options.deadIds?.has(s.youtubeId))
    for (const gone of dead) {
      report.notes.push(
        `${entry.artist} — ${entry.title}: dropped the ${gone.role} link (${gone.youtubeId}) — YouTube says that video does not exist.`,
      )
    }

    // Reported even when the entry is rejected below: the batch really did ask
    // for one video twice, and that is worth knowing before editing it.
    for (const id of duplicates) {
      report.notes.push(
        `${entry.artist} — ${entry.title}: the same video (${id}) was sent for both slots, so only the first use was kept.`,
      )
    }

    if (!entry.title || !entry.artist) {
      reject(report, label, entry, 'no title or artist')
      continue
    }

    const existing =
      (entry.musicbrainzRecordingId
        ? library.byMbid.get(entry.musicbrainzRecordingId)
        : undefined) ?? library.byKey.get(trackKey(entry.artist, entry.title))

    if (existing) {
      // Deliberately no audio-link check here. "Add the official video to
      // Locust" is a complete instruction against a track that already has a
      // source, and refusing it for want of a second link would reject the most
      // ordinary thing anyone asks this box to do.
      const changed = enrich(existing, entry, sources, nextSourceId)
      if (changed.fields.length) {
        nextSourceId += changed.sources
        report.enriched++
        report.lines.push({
          outcome: 'enriched',
          label,
          title: existing.title,
          artist: existing.artist,
          reason: changed.fields.join(', '),
        })
      } else {
        report.unchanged++
        report.lines.push({
          outcome: 'unchanged',
          label,
          title: existing.title,
          artist: existing.artist,
          // "Already complete" would be a lie here: something was offered and
          // could not be attached. Say which slot was in the way, so the person
          // can go and replace it rather than believing they now have it.
          reason: changed.skipped.length
            ? changed.skipped.join('; ')
            : 'already complete',
        })
      }
      registerInboxRefs(inboxTracks, entry, existing)
      continue
    }

    // A new track with neither a Main nor a clip left is still added — with
    // whatever live slots survived, possibly none — so it shows up in the list
    // with red text instead of vanishing into the report. The line names
    // the bad id so the link can be fixed by hand in the track card.
    const deadPlayable = dead.find((s) => isPlayableRole(s.role))
    const needsLink = !hasPlayableSource(sources)
    const needsLinkReason = needsLink
      ? deadPlayable
        ? `${deadPlayable.role === 'audio' ? 'Main' : 'video clip'} link (${deadPlayable.youtubeId}) does not exist on YouTube — added without a playable link so it can be fixed by hand`
        : 'no playable Main or video clip — added without one so it can be fixed by hand'
      : undefined

    const track: StoredTrack = {
      id: nextTrackId++,
      title: entry.title,
      artist: entry.artist,
      album: entry.album ?? null,
      coverUrl: entry.coverUrl ?? null,
      year: entry.year ?? null,
      musicbrainzRecordingId: entry.musicbrainzRecordingId ?? null,
      info: entry.info ?? null,
      duration: entry.duration ?? null,
      createdAt: now,
      genres: dedupeGenres(entry.genres ?? []),
      sources: sources.slice(0, MAX_SOURCES).map((s) => ({
        id: nextSourceId++,
        youtubeId: s.youtubeId,
        url: s.url ?? watchUrl(s.youtubeId),
        kind: s.kind,
        label: s.label,
        role: s.role,
      })),
    }
    next.tracks.push(track)
    library.byKey.set(trackKey(track.artist, track.title), track)
    const title = normaliseName(track.title)
    library.byTitle.set(title, library.byTitle.has(title) ? null : track)
    if (track.musicbrainzRecordingId) {
      library.byMbid.set(track.musicbrainzRecordingId, track)
    }
    registerInboxRefs(inboxTracks, entry, track)
    report.added++
    report.lines.push({
      outcome: 'added',
      label,
      title: track.title,
      artist: track.artist,
      ...(needsLinkReason ? { reason: needsLinkReason } : {}),
    })
  }

  // Playlists last: by now every track they can refer to exists, including the
  // ones added above, so a playlist can be built purely from new material.
  for (const entry of inbox.playlists) {
    const existing = next.playlists.find(
      (p) => p.name.toLowerCase() === entry.name.toLowerCase(),
    )
    // A `folder` path files the playlist there, creating what does not exist.
    // Without one a new playlist lands at the top level and a matched one
    // stays where it is — filing is always an explicit ask, never a guess.
    let folderId = existing?.folderId ?? null
    // A path of only slashes is not a folder — it is a model that forgot the
    // names — so it files nothing rather than a `-1` that points nowhere.
    if (entry.folder?.split('/').some((s) => s.trim())) {
      const resolved = resolveFolderPath(next, entry.folder, () => nextFolderId++, now)
      folderId = resolved.id
      for (const path of resolved.created) {
        if (!report.foldersCreated.includes(path)) report.foldersCreated.push(path)
      }
    }
    const playlist: StoredPlaylist =
      existing ?? {
        id:
          next.playlists.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0) +
          1,
        name: entry.name,
        description: entry.description ?? null,
        createdAt: now,
        tracks: [],
        folderId,
      }
    if (!existing) next.playlists.push(playlist)
    const moved = Boolean(existing && existing.folderId !== folderId)
    if (moved) playlist.folderId = folderId

    const unmatched: string[] = []
    let added = 0
    for (const ref of entry.tracks ?? []) {
      const track = resolvePlaylistRef(ref, next, inboxTracks)
      if (!track) {
        unmatched.push(String(ref))
        continue
      }
      if (playlist.tracks.includes(track.id)) continue
      playlist.tracks.push(track.id)
      added++
    }
    if (!existing && entry.description) playlist.description = entry.description
    report.playlists.push({
      name: playlist.name,
      created: !existing,
      added,
      unmatched,
      folder: folderPath(next, folderId),
      moved,
    })
  }

  return { doc: next, report }
}

/** Adds a track under every name a later reference might use for it. */
function registerInboxRefs(
  into: Map<string, StoredTrack>,
  entry: InboxTrack,
  track: StoredTrack,
): void {
  if (entry.key) into.set(entry.key.toLowerCase(), track)
  into.set(trackKey(entry.artist, entry.title), track)
  into.set(normaliseName(entry.title), track)
}

/**
 * Files a playlist at a `"Metal/Thrash"`-style path, creating what is missing.
 *
 * Each level matches case-insensitively under its own parent, so `"metal"`
 * reuses the existing `Metal` folder instead of doubling it. Empty segments
 * are skipped and names are capped, because the path arrives from a model and
 * a 400-character folder name helps nobody. Returns the deepest folder's id
 * plus every path created along the way, so the report can name them.
 */
function resolveFolderPath(
  doc: LibraryDocument,
  path: string,
  takeId: () => number,
  now: string,
): { id: number; created: string[] } {
  const created: string[] = []
  let parentId: number | null = null
  let id = -1
  const trail: string[] = []
  for (const raw of String(path).split('/')) {
    const name = raw.trim().slice(0, 100)
    if (!name) continue
    trail.push(name)
    const hit = doc.folders.find(
      (f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase(),
    )
    if (hit) {
      parentId = hit.id
      id = hit.id
    } else {
      const folder: PlaylistFolder = { id: takeId(), name, parentId, createdAt: now }
      doc.folders.push(folder)
      parentId = folder.id
      id = folder.id
      created.push(trail.join('/'))
    }
  }
  return { id, created }
}

/** A folder's full path from the top, or null at the top level. */
function folderPath(doc: LibraryDocument, folderId: number | null): string | null {
  if (folderId === null || folderId === undefined) return null
  const names: string[] = []
  let current = doc.folders.find((f) => f.id === folderId) ?? null
  while (current) {
    names.unshift(current.name)
    current = doc.folders.find((f) => f.id === current?.parentId) ?? null
  }
  return names.length ? names.join('/') : null
}

/**
 * Resolves a playlist reference against the merged document.
 *
 * Numeric ids are honoured because a reference may be copied from an export
 * the person already has; names are the normal case. `id` lookup is exact and
 * bounded to the document, so a stale id from an older export is reported as
 * unmatched rather than pointing somewhere arbitrary.
 */
function resolvePlaylistRef(
  ref: string | number,
  doc: LibraryDocument,
  inboxTracks: Map<string, StoredTrack>,
): StoredTrack | null {
  if (typeof ref === 'number') {
    return doc.tracks.find((t) => t.id === ref) ?? null
  }
  const raw = String(ref ?? '').trim()
  if (!raw) return null

  const direct = inboxTracks.get(raw.toLowerCase())
  if (direct) return direct

  // Split on the *first* separator only: the artist comes before it and the
  // whole remainder is the title. Splitting on every dash broke titles that
  // carry their own suffix ("Summer in the City - Remastered"), which split
  // into three parts and never matched the track added in the same batch.
  const sep = raw.search(/\s+[—–-]\s+/)
  if (sep !== -1) {
    const artist = raw.slice(0, sep).trim()
    const title = raw
      .slice(sep)
      .replace(/^\s*[—–-]\s*/, '')
      .trim()
    if (artist && title) {
      const key = trackKey(artist, title)
      const hit = doc.tracks.find(
        (t) => trackKey(t.artist, t.title) === key,
      )
      if (hit) return hit
      const fromInbox = inboxTracks.get(key)
      if (fromInbox) return fromInbox
    }
  }

  const title = normaliseName(raw)
  const hits = doc.tracks.filter((t) => normaliseName(t.title) === title)
  // Ambiguous bare title: refuse rather than guess.
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return null
  return inboxTracks.get(title) ?? null
}

/**
 * Reads an inbox track's sources into at most three role-tagged slots.
 *
 * Accepts the flat `audio`/`video` shorthand and the full `sources` array, and
 * a bare string, a URL or an id in every position. A model sometimes wraps the
 * link in a one-key object (`{"Main": url}`) instead of sending the link
 * itself — the known keys are tried first, then every string value is scanned,
 * so a link under any key still plays. Unparseable links are dropped silently
 * here; the "no audio" check in the merge is what reports them, once, rather
 * than once per link.
 */
export interface ResolvedSource {
  youtubeId: string
  url: string
  kind: SourceKind
  label: string | null
  role: SourceRole
}

/** First YouTube id among arbitrary values, for links wrapped in unknown keys. */
function firstParsableId(values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v !== 'string') continue
    const id = parseYouTubeId(v)
    if (id) return id
  }
  return null
}

export interface ResolvedSources {
  /** At most three role-tagged slots: Main, official clip, and Live. */
  sources: ResolvedSource[]
  /**
   * Video ids the entry asked to use more than once. Only the first survives.
   *
   * One video cannot be both the audio source and the clip. The editor refuses
   * to save that — switching to video would then show the audio stream while
   * claiming a clip — because the slots exist precisely to be different videos. A *batch* can still contain it, since the model writing the JSON has
   * no idea the rule exists, so it is dropped here rather than stored and the
   * reason travels back in the merge report.
   */
  duplicates: string[]
}

export function readSources(entry: InboxTrack): ResolvedSources {
  const taken: SourceRole[] = []
  const seenIds = new Set<string>()
  const duplicates: string[] = []
  const out: ResolvedSource[] = []

  const push = (
    value: string | InboxSource | null | undefined,
    wanted?: SourceRole,
  ) => {
    if (value === null || value === undefined) return
    const bare = typeof value === 'string' ? value : null
    const obj: InboxSource = typeof value === 'string' ? { url: value } : value
    const youtubeId =
      parseYouTubeId(String(obj.youtubeId ?? '')) ||
      parseYouTubeId(String(obj.url ?? '')) ||
      (typeof value === 'object' && value !== null && !Array.isArray(value)
        ? firstParsableId(Object.values(value))
        : null)
    if (!youtubeId) return

    // Claimed before the role is worked out, so the second sighting of a video
    // is reported whatever happens to the slot it asked for.
    if (seenIds.has(youtubeId)) {
      duplicates.push(youtubeId)
      return
    }
    seenIds.add(youtubeId)

    // A named role wins over position. `resolveRole` alone would hand the
    // first free slot, which means an inbox that supplies only `video` would
    // quietly attach its clip as the *audio* source — and on a track that
    // already has audio, it would then be discarded entirely.
    const explicit =
      obj.role === 'audio' || obj.role === 'video' || obj.role === 'live' ? obj.role : undefined
    const requested = explicit ?? wanted
    const role =
      requested && !taken.includes(requested)
        ? requested
        : resolveRole(undefined, taken)
    if (taken.includes(role)) return
    taken.push(role)

    // A bare id is not a URL, and storing it as one produces a link that does
    // not open. Anything the caller gave as a real URL is kept as given.
    const url =
      bare && !/^https?:/i.test(bare)
        ? watchUrl(youtubeId)
        : obj.url
          ? String(obj.url)
          : watchUrl(youtubeId)
    out.push({
      youtubeId,
      url,
      kind: normaliseKind(obj.kind, role),
      label: text(obj.label),
      role,
    })
  }

  if (entry.sources?.length) {
    for (const s of entry.sources) push(s)
  }
  push(entry.audio, 'audio')
  push(entry.video, 'video')
  push(entry.live, 'live')

  // The hard cap is three roles: Main, official clip and Live.
  return { sources: out.slice(0, MAX_SOURCES), duplicates }
}

function normaliseKind(
  kind: string | null | undefined,
  role: SourceRole,
): SourceKind {
  const value = String(kind ?? '').trim().toLowerCase()
  const known: SourceKind[] = [
    'official',
    'album',
    'live',
    'cover',
    'remix',
    'video',
  ]
  if (known.includes(value as SourceKind)) return value as SourceKind
  return role === 'video' ? 'video' : 'official'
}

/**
 * Fills the blanks on an existing track and returns what actually changed.
 *
 * Blank-only is the whole point: an inbox is a request to *add* information, so
 * a value already in the library is never overwritten and a re-sent inbox
 * settles to no changes at all.
 */
function enrich(
  track: StoredTrack,
  entry: InboxTrack,
  sources: ResolvedSource[],
  nextSourceId: number,
): { fields: string[]; sources: number; skipped: string[] } {
  const fields: string[] = []
  const skipped: string[] = []
  let newSources = 0

  if (!track.album && entry.album) {
    track.album = entry.album
    fields.push('album')
  }
  if (!track.coverUrl && entry.coverUrl) {
    track.coverUrl = entry.coverUrl
    fields.push('cover')
  }
  if (!track.year && entry.year) {
    track.year = entry.year
    fields.push('year')
  }
  if (!track.info && entry.info) {
    track.info = entry.info
    fields.push('info')
  }
  if (!track.musicbrainzRecordingId && entry.musicbrainzRecordingId) {
    track.musicbrainzRecordingId = entry.musicbrainzRecordingId
    fields.push('mbid')
  }
  if (!track.duration && entry.duration) {
    track.duration = entry.duration
    fields.push('duration')
  }

  const before = track.genres.length
  track.genres = dedupeGenres([...track.genres, ...(entry.genres ?? [])])
  if (track.genres.length > before) fields.push('genres')

  // A source is only attached if that role is still empty, and only if the
  // video is not already attached under the other role.
  for (const source of sources) {
    if (track.sources.some((s) => s.youtubeId === source.youtubeId)) continue
    // The role check comes first because it names the slot that is in the way,
    // which is the actionable half of "you already have an audio source".
    if (track.sources.some((s) => s.role === source.role)) {
      skipped.push(`the ${source.role} slot is already filled`)
      continue
    }
    if (track.sources.length >= MAX_SOURCES) {
      skipped.push('all three source slots are already filled')
      continue
    }
    const stored: StoredSource = {
      id: nextSourceId + newSources,
      youtubeId: source.youtubeId,
      url: source.url,
      kind: source.kind,
      label: source.label,
      role: source.role,
    }
    track.sources.splice(
      ['audio', 'video', 'live'].indexOf(source.role),
      0,
      stored,
    )
    newSources++
    fields.push(`${source.role} source`)
  }

  return { fields, sources: newSources, skipped }
}

function reject(
  report: MergeReport,
  label: string,
  entry: InboxTrack,
  reason: string,
): void {
  report.rejected++
  report.lines.push({
    outcome: 'rejected',
    label,
    title: entry.title,
    artist: entry.artist,
    reason,
  })
}

// ------------------------------------------------------------------- context

/**
 * What an agent is shown before it writes anything.
 *
 * The full document is the wrong thing to put in a prompt: it is mostly cover
 * URLs, `createdAt` stamps and long `info` blobs, none of which affect the
 * decision "is this track already in the library, and what should I call it".
 * This keeps only the fields used for that decision, so the context stays small
 * as the library grows — which is the entire reason the drop box is cheaper than
 * handing over the file.
 */
export interface AgentContext {
  format: string
  version: number
  instructions: string
  counts: { tracks: number; playlists: number; genres: number }
  tracks: Array<{
    id: number
    title: string
    artist: string
    album: string | null
    year: number | null
    musicbrainzRecordingId: string | null
    genres: string[]
    hasVideo: boolean
    /**
     * Whether real cover art is already stored.
     *
     * Published even though the cover URL itself is not, because the alternative
     * is worse than useless: the instructions invite a `coverUrl` for anything
     * missing one, and without this field a model cannot tell which tracks those
     * are. It re-sent guesses for rows that already had sleeves, and the guesses
     * were the video's own still or the band's channel picture.
     */
    hasCover: boolean
  }>
  playlists: Array<{
    id: number
    name: string
    description: string | null
    trackCount: number
    /** Full folder path, or null at the top level — what filing is planned against. */
    folder: string | null
  }>
  /** Every folder as a full `"Metal/Thrash"`-style path, so new ones nest correctly. */
  folders: string[]
  genres: string[]
}

export const AGENT_INSTRUCTIONS = [
  'Reply with ONE JSON object and nothing else: no explanation, no markdown, no code fences — only the text from the first { to the last } is imported.',
  'Write that object to data/inbox.json with "tracks" and "playlists".',
  'One batch can do any mix of everything below: add tracks, fill in what is missing on tracks I own, build playlists with descriptions, and file them into folders.',
  'List only what is new or what you want filled in — do not copy the library back.',
  'A track needs "title", "artist" and at least one YouTube link in "audio" (Main) or "video" (the official clip) — either one plays, and each mode falls back to the other; id, watch URL or youtu.be link all work, as a plain string, never wrapped in an object.',
  'Every YouTube link must be one you have actually checked. An unverified link is worse than a missing track, because I cannot tell which it was.',
  'Every link is checked against YouTube when the batch is applied: a video that does not exist is left out and the track is added without a playable link, shown in red until its link is fixed by hand — read data/last-merge.json back and send a replacement link for anything it lists.',
  'Leave out anything you are not sure about rather than guessing; the app reports back what it could not match, and a wrong track is harder to spot than a missing one.',
  'Optional per track: "album", "year", "coverUrl", "musicbrainzRecordingId", "genres", "info", "video" (official clip), "live" (live performance), "key".',
  'For every new track, also try to find the official video clip in "video" and a live performance in "live" — checked YouTube links like "audio". Leave a slot out when you cannot verify one rather than guessing.',
  'Only send "coverUrl" for a track whose "hasCover" is false, and only as a Cover Art Archive release URL (https://coverartarchive.org/release/<id>/front-500). A video thumbnail or a channel picture is not album art and is refused.',
  'A track already in the library is enriched, never duplicated: blank fields are filled and genres are merged.',
  'Genres must be spelled exactly as they appear in the "genres" list in this file — do not add a new capitalisation of a genre I already use.',
  'Do not send a track I already own unless the task is to fill in what is missing on it.',
  'In "playlists", name tracks as "Artist — Title" — no ids needed. Give a new track a "key" and refer to it by that.',
  'Give every playlist you create a short "description" (what it is for, 1-2 sentences) — a playlist without one is incomplete.',
  'A playlist takes an optional "folder" path like "Metal/Thrash", created when it does not exist yet — one segment per level, filed under what is already there. Without one a new playlist lands at the top level.',
  'A reference that matches nothing is reported back rather than guessed at.',
].join('\n')

export function buildContext(doc: LibraryDocument): AgentContext {
  const genres = new Map<string, number>()
  for (const track of doc.tracks) {
    for (const g of track.genres) genres.set(g, (genres.get(g) ?? 0) + 1)
  }
  return {
    format: 'trackvault-agent-context',
    version: 1,
    instructions: AGENT_INSTRUCTIONS,
    counts: {
      tracks: doc.tracks.length,
      playlists: doc.playlists.length,
      genres: genres.size,
    },
    tracks: doc.tracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year,
      musicbrainzRecordingId: t.musicbrainzRecordingId,
      genres: t.genres,
      hasVideo: t.sources.some((s) => s.role === 'video'),
      hasCover: Boolean(t.coverUrl?.trim()),
    })),
    playlists: doc.playlists.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      trackCount: p.tracks.length,
      folder: folderPath(doc, p.folderId),
    })),
    folders: doc.folders
      .map((f) => folderPath(doc, f.id))
      .filter((p): p is string => p !== null)
      .sort((a, b) => a.localeCompare(b)),
    genres: [...genres.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name),
  }
}
