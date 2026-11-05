import {
  MAX_SOURCES,
  type LibraryDocument,
  type NewTrack,
  type PlayEvent,
  type Playlist,
  type PlaylistFolder,
  type SourceKind,
  type SourceRole,
  type StoredPlaylist,
  type StoredSource,
  type StoredTrack,
} from './types'
import { dedupeGenres } from './genres'
import { MAX_PLAY_EVENTS } from './dj'
import { hasPlayableSource, resolveRole } from './sources'
import { parseYouTubeId, watchUrl } from './youtube'

/**
 * Reading and writing a library as a portable document.
 *
 * Two jobs live here, and they belong together because they are two ends of one
 * contract:
 *
 * - `normalise` repairs anything read from disk or a file on its way into a
 *   store. It is deliberately forgiving: the file is meant to be hand- and
 *   agent-edited, so a missing field or a hand-written entry is fixed rather
 *   than crashing the app.
 * - `applyImport` merges a whole exported library back in. It is used by both
 *   stores, so the SQLite app and the JSON-file app import identically — which
 *   matters because the one thing a person does with a backup is move it
 *   between machines.
 *
 * The module has no dependency on either store (only on types and the pure
 * source helpers), so both can import it without a cycle.
 */

/**
 * Turns any incoming running time into a storable whole number of seconds.
 *
 * Everything that can produce a duration is fallible in the same way: the player
 * reports 0 before a stream is ready, MusicBrainz reports milliseconds, and a
 * NaN can arrive from a broken timecode. All of those mean "not known yet", so
 * they collapse to null rather than being stored as a plausible-looking 0.
 */
export function normaliseDuration(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

/** The largest positive whole id a raw list of rows claims, 0 when none do. */
function highestId(rows: unknown[]): number {
  let max = 0
  for (const row of rows) {
    const id = Math.trunc(Number((row as { id?: unknown } | null)?.id))
    if (Number.isFinite(id) && id > max) max = id
  }
  return max
}

/**
 * The id a normalised row takes, which is also the id a playlist entry written
 * against the file refers to.
 *
 * A usable declared id is kept unless another row already took it; otherwise
 * the row is given the next unused number above every id the file declares.
 */
function claimId(
  declared: unknown,
  used: Set<number>,
  next: () => number,
): number {
  const id = Math.trunc(Number(declared))
  const claimed = Number.isFinite(id) && id > 0 && !used.has(id) ? id : next()
  used.add(claimed)
  return claimed
}

/** A free-text field read off disk, where anything at all can turn up. */
function normaliseText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

/**
 * Repairs a track's sources and assigns their roles.
 *
 * Existing files predate the role field, so a missing one is derived from list
 * order: the first link is the audio source the app has always streamed, and
 * any second link is the video clip. An explicit `role` is always respected.
 * Extra links beyond the three slots are dropped rather than silently ignored.
 */
function normaliseSources(rawSources: unknown[], trackIndex: number): StoredSource[] {
  const taken: SourceRole[] = []
  const out: StoredSource[] = []
  const list = Array.isArray(rawSources) ? rawSources.slice(0, MAX_SOURCES) : []

  for (const [i, entry] of list.entries()) {
    const source = (entry ?? {}) as Partial<StoredSource>
    // A link may have been written as a bare URL instead of an ID.
    const youtubeId =
      String(source.youtubeId ?? '').trim() ||
      parseYouTubeId(String(source.url ?? '')) ||
      ''
    if (!youtubeId) continue

    const role = resolveRole(
      source.role === 'video' || source.role === 'audio' || source.role === 'live'
        ? source.role
        : undefined,
      taken,
    )
    taken.push(role)
    out.push({
      id: Number(source.id) || trackIndex * 1000 + i + 1,
      youtubeId,
      url: source.url ? String(source.url) : watchUrl(youtubeId),
      kind: (source.kind || 'official') as SourceKind,
      label: source.label ? String(source.label) : null,
      role,
    })
  }
  return out
}

/**
 * Parses and repairs the document.
 *
 * Returns a `LibraryDocument` — the same shape the app writes to
 * `data/library.json` — so an export from either store is readable by both and
 * by hand.
 */
export function normalise(raw: string): LibraryDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw || '{}')
  } catch {
    parsed = {}
  }
  const doc = (parsed ?? {}) as Partial<LibraryDocument>
  const rawTracks = Array.isArray(doc.tracks) ? doc.tracks : []

  // Ids are claimed one at a time so a hand- or agent-edited file that repeats
  // or omits one cannot make two tracks share a number — a playlist entry would
  // then resolve to whichever row the map happened to keep. A track that keeps
  // its id keeps it; only a missing or duplicated one is renumbered *past* the
  // highest id in the file, so no id already in use ever moves.
  const usedTrackIds = new Set<number>()
  let nextTrackId = highestId(rawTracks) + 1

  const tracks: StoredTrack[] = rawTracks.map((t) => {
    const track = (t ?? {}) as Partial<StoredTrack> & { notes?: unknown }
    const rawSources = Array.isArray(track.sources) ? track.sources : []
    const id = claimId(track.id, usedTrackIds, () => nextTrackId++)
    return {
      id,
      title: String(track.title ?? 'Untitled'),
      artist: String(track.artist ?? 'Unknown artist'),
      album: track.album ? String(track.album) : null,
      coverUrl: track.coverUrl ? String(track.coverUrl) : null,
      year: Number.isFinite(Number(track.year)) && Number(track.year) > 0
        ? Number(track.year)
        : null,
      musicbrainzRecordingId: track.musicbrainzRecordingId
        ? String(track.musicbrainzRecordingId)
        : null,
      // `notes` is the old name for this field. A file written before the
      // rename still carries the user's text, so it is read rather than dropped.
      info: normaliseText(track.info) ?? normaliseText(track.notes),
      lyrics: normaliseText(track.lyrics),
      lyricsSource: normaliseText(track.lyricsSource),
      duration: normaliseDuration(
        track.duration === null || track.duration === undefined
          ? null
          : Number(track.duration),
      ),
      createdAt: track.createdAt
        ? String(track.createdAt)
        : new Date().toISOString(),
      genres: dedupeGenres(
        Array.isArray(track.genres) ? (track.genres as string[]) : [],
      ),
      sources: normaliseSources(rawSources, id),
    }
  })

  const rawFolders = Array.isArray(doc.folders) ? doc.folders : []
  const usedFolderIds = new Set<number>()
  let nextFolderId = highestId(rawFolders) + 1
  const folders: PlaylistFolder[] = rawFolders.map((f) => {
    const folder = (f ?? {}) as Partial<PlaylistFolder>
    const id = claimId(folder.id, usedFolderIds, () => nextFolderId++)
    return {
      id,
      name: String(folder.name ?? 'Folder'),
      parentId:
        Number.isFinite(Number(folder.parentId)) && folder.parentId !== null
          ? Number(folder.parentId)
          : null,
      createdAt: folder.createdAt
        ? String(folder.createdAt)
        : new Date().toISOString(),
    }
  })

  const rawPlaylists = Array.isArray(doc.playlists) ? doc.playlists : []
  const usedPlaylistIds = new Set<number>()
  let nextPlaylistId = highestId(rawPlaylists) + 1
  const playlists: StoredPlaylist[] = rawPlaylists.map((p) => {
    const playlist = (p ?? {}) as Partial<StoredPlaylist>
    const id = claimId(playlist.id, usedPlaylistIds, () => nextPlaylistId++)
    return {
      id,
      name: String(playlist.name ?? 'Playlist'),
      description: playlist.description ? String(playlist.description) : null,
      createdAt: playlist.createdAt
        ? String(playlist.createdAt)
        : new Date().toISOString(),
      tracks: Array.isArray(playlist.tracks)
        ? playlist.tracks.map(Number).filter(Number.isFinite)
        : [],
      folderId:
        Number.isFinite(Number(playlist.folderId)) && playlist.folderId !== null
          ? Number(playlist.folderId)
          : null,
    }
  })

  const knownFolderIds = new Set(folders.map((f) => f.id))
  // A playlist pointing at a folder that does not exist (a hand edit, or a
  // folder deleted outside the app) is lifted to the top level rather than
  // becoming invisible under a missing parent.
  for (const playlist of playlists) {
    if (playlist.folderId !== null && !knownFolderIds.has(playlist.folderId)) {
      playlist.folderId = null
    }
  }

  // Completed listens. Repaired the same way as everything else: entries
  // naming no usable track or time are dropped, and the tail is kept, so a
  // hand-edited file can never smuggle in an unbounded history.
  const rawPlays = Array.isArray((doc as { plays?: unknown }).plays)
    ? ((doc as { plays?: unknown[] }).plays ?? [])
    : []
  const plays: PlayEvent[] = []
  for (const entry of rawPlays) {
    const event = (entry ?? {}) as Partial<PlayEvent>
    const trackId = Number(event.trackId)
    const playedAt = typeof event.playedAt === 'string' ? event.playedAt : ''
    if (!Number.isFinite(trackId) || !playedAt || !Number.isFinite(Date.parse(playedAt))) {
      continue
    }
    plays.push({ trackId, playedAt })
  }

  return {
    format: 'trackvault-library',
    version: Number(doc.version) || 1,
    tracks,
    folders,
    playlists,
    plays: plays.slice(-MAX_PLAY_EVENTS),
  }
}

// ------------------------------------------------------------------- import

/**
 * The one thing an import may do that an ordinary add may not.
 *
 * Everyday adds and the AI inbox refuse a track with no Main link and no clip,
 * because a fresh row nobody can play is a mistake. An import is not adding a
 * song, though: it is copying a library that already holds such rows (the
 * link-health run keeps them and files them under Issues), so refusing them
 * would silently delete data the file still has.
 */
export interface AddTrackOptions {
  allowUnplayable?: boolean
}

/**
 * What an import needs from a store. Both `Library` and `JsonLibrary` satisfy
 * this structurally, which is what lets one merge implementation serve both.
 */
export interface ImportSink {
  listFolders(): Promise<PlaylistFolder[]>
  createFolder(name: string, parentId?: number | null): Promise<number>
  listPlaylists(): Promise<Playlist[]>
  ensurePlaylist(name: string, description?: string | null): Promise<number>
  setPlaylistFolder(playlistId: number, folderId: number | null): Promise<void>
  setPlaylistDescription(playlistId: number, description: string | null): Promise<void>
  addToPlaylist(playlistId: number, trackId: number): Promise<void>
  addTrack(input: NewTrack, options?: AddTrackOptions): Promise<number>
  /** Records completed listens, ignoring ones already held (re-import is safe). */
  recordPlays(events: PlayEvent[]): Promise<void>
  /**
   * Runs a bulk write as one unit.
   *
   * An import of a few thousand tracks otherwise costs one whole-document write
   * per track, which is quadratic: every add re-serialises the entire file and
   * writes it again. Inside `transact` the JSON store defers its write to the
   * end (and writes nothing at all if the import fails, so a failed import can
   * no longer leave a half-filled library). The SQL store needs nothing here —
   * its driver already coalesces snapshots — but it implements the call so the
   * two stores share one contract rather than one of them knowing the other's
   * internals.
   */
  transact<T>(run: () => Promise<T>): Promise<T>
}

export interface ImportResult {
  /** Tracks that were added or merged (merged ones are enriched, not replaced). */
  tracks: number
  playlists: number
  folders: number
  /**
   * Tracks that came in with neither a Main link nor a clip.
   *
   * They are **stored**, not refused: the library itself can hold such rows (the
   * link-health run leaves a track in place and files it under Issues), so an
   * export that dropped them on the way back in would quietly shrink the
   * library — 16 tracks and the 29 playlist entries pointing at them, the last
   * time this was measured on a real 1765-track file. Stored, they show in red
   * and a playlist that names them still resolves. The list is reported so the
   * banner can say how many need a fresh link.
   */
  unplayable: string[]
  /** Playlist entries that matched no track in the file. */
  unmatched: string[]
}

/** One playlist reference: by file id when it has one, else by name. */
interface TrackRef {
  id?: number
  title?: string
  artist?: string
}

interface ImportedPlaylist {
  name: string
  description: string | null
  folderId: number | null
  refs: TrackRef[]
}

interface ImportedLibrary {
  document: LibraryDocument
  /**
   * The ids the file gives its tracks, in the same order as `document.tracks`,
   * so a playlist's numeric references can be resolved even when a hand-written
   * file had missing or clashing ids.
   */
  fileIds: number[]
  playlists: ImportedPlaylist[]
}

function readTrackRef(value: unknown): TrackRef | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { id: value }
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? splitName(text) : null
  }
  if (value && typeof value === 'object') {
    const entry = value as Record<string, unknown>
    const id = Number(entry.id)
    const title = entry.title ? String(entry.title).trim() : ''
    const artist = entry.artist ? String(entry.artist).trim() : ''
    if (Number.isFinite(id) && (entry.id !== null || title)) {
      return { id: Number(entry.id), title: title || undefined, artist: artist || undefined }
    }
    if (title) return { title, artist: artist || undefined }
  }
  return null
}

/**
 * Reads `"Artist — Title"` (the shape an agent inbox uses) into its two halves.
 *
 * Only used as a fallback: a plain-name reference is tried whole first, because
 * a title really can contain a dash.
 */
function splitName(text: string): TrackRef {
  const match = text.match(/^(.+?)\s+[—–-]\s+(.+)$/)
  if (!match) return { title: text }
  return { artist: match[1].trim(), title: match[2].trim() }
}

function readImport(raw: string): ImportedLibrary {
  const document = normalise(raw)
  let parsed: { playlists?: unknown[] } = {}
  try {
    parsed = (JSON.parse(raw) ?? {}) as typeof parsed
  } catch {
    parsed = {}
  }
  // The id each track ended up with *is* its file id, so a playlist's numeric
  // references resolve against the very rows that get written. Reading the raw
  // ids again would disagree with `normalise` whenever it had to renumber one.
  const fileIds = document.tracks.map((track) => track.id)

  const rawPlaylists = Array.isArray(parsed.playlists) ? parsed.playlists : []
  const playlists: ImportedPlaylist[] = rawPlaylists
    .map((entry) => {
      const playlist = (entry ?? {}) as Record<string, unknown>
      const refs = Array.isArray(playlist.tracks)
        ? playlist.tracks.map(readTrackRef).filter((ref): ref is TrackRef => ref !== null)
        : []
      return {
        name: String(playlist.name ?? '').trim(),
        description: playlist.description ? String(playlist.description) : null,
        folderId:
          Number.isFinite(Number(playlist.folderId)) && playlist.folderId !== null
            ? Number(playlist.folderId)
            : null,
        refs,
      }
    })
    .filter((playlist) => playlist.name.length > 0)

  return { document, fileIds, playlists }
}

function toNewTrack(track: StoredTrack): NewTrack {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.coverUrl,
    year: track.year,
    musicbrainzRecordingId: track.musicbrainzRecordingId,
    info: track.info,
    lyrics: track.lyrics,
    lyricsSource: track.lyricsSource,
    duration: track.duration,
    genres: [...track.genres],
    sources: track.sources.map((source) => ({
      youtubeId: source.youtubeId,
      url: source.url,
      kind: source.kind,
      label: source.label,
      role: source.role,
    })),
  }
}

const pairKey = (title: string, artist: string) =>
  `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`

/**
 * Merges an exported library into a store.
 *
 * The rules are the inbox's rules, because an import is the same kind of event
 * — new material arriving for a library that may already hold some of it:
 *
 * - **Never duplicates.** A track is matched on MusicBrainz id or on
 *   artist + title, and merged rather than added twice.
 * - **Never overwrites.** A track that is already there keeps every field it
 *   has; the incoming copy only fills what is blank. Importing an older backup
 *   over a fuller library therefore changes nothing, while importing a richer
 *   one fills the gaps.
 * - **Never loses a reference.** Playlist entries are resolved to the tracks
 *   that were actually written, and anything that matches nothing is reported
 *   rather than dropped silently.
 * - **Re-import is safe.** Playlists are matched by name and membership is
 *   additive and idempotent, so importing the same file twice is a no-op.
 */
/**
 * Refuses anything that is not a library export, before a replace deletes a
 * single row.
 *
 * `normalise` is deliberately forgiving — garbage parses to an empty document
 * — which is right for a merge and catastrophic for a replace, where an empty
 * document means an empty library. So replacing validates first: the file must
 * parse and must carry a track list (possibly an empty one, which is a valid
 * way of saying "start over"). Errors are worded for the person holding the
 * file, because they read them in the banner.
 */
export function assertReplaceableDocument(raw: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      'That file could not be read as a library — nothing was deleted. Export a fresh copy and try again.',
    )
  }
  const doc = (parsed ?? {}) as { tracks?: unknown }
  if (!doc || !Array.isArray(doc.tracks)) {
    throw new Error(
      'That file is not a TrackVault library export — nothing was deleted. Use a file from Export, not an arbitrary JSON file.',
    )
  }
}

export async function applyImport(raw: string, sink: ImportSink): Promise<ImportResult> {
  const { document, fileIds, playlists } = readImport(raw)
  // One write for the whole merge, not one per record. See `ImportSink.transact`.
  return sink.transact(() => importInto(document, fileIds, playlists, sink))
}

async function importInto(
  document: LibraryDocument,
  fileIds: number[],
  playlists: ImportedPlaylist[],
  sink: ImportSink,
): Promise<ImportResult> {
  // ---------------------------------------------------------------- tracks
  const byFileId = new Map<number, number>()
  const byPair = new Map<string, number>()
  const byTitle = new Map<string, number | null>()
  const unplayable: string[] = []
  let trackCount = 0

  for (const [index, track] of document.tracks.entries()) {
    // A row with neither a Main link nor a clip still comes in. It is the
    // library's own state, not a mistake: dropping it (and with it every
    // playlist entry naming it) is what made a 1765-track export come back as
    // 1581 tracks. It is reported instead, so the banner can name it.
    const playable = hasPlayableSource(track.sources)
    if (!playable) unplayable.push(`${track.artist} — ${track.title}`)
    const id = await sink.addTrack(toNewTrack(track), { allowUnplayable: !playable })
    trackCount++
    byFileId.set(fileIds[index], id)
    const pair = pairKey(track.title, track.artist)
    if (!byPair.has(pair)) byPair.set(pair, id)
    const title = track.title.trim().toLowerCase()
    // A title that fits two tracks is not an identity, so it is remembered as
    // ambiguous rather than resolved to whichever came last.
    byTitle.set(title, byTitle.has(title) ? null : id)
  }

  // --------------------------------------------------------------- folders
  // Parents are created before children, and a folder that already exists under
  // the same parent is reused, so re-importing does not grow a second copy of
  // the tree.
  const known = [...(await sink.listFolders())]
  const byFileFolder = new Map<number, number>()
  const pending = [...document.folders]
  let folderCount = 0

  const findExisting = (name: string, parentId: number | null) =>
    known.find(
      (folder) =>
        folder.name.toLowerCase() === name.toLowerCase() &&
        folder.parentId === parentId,
    )

  while (pending.length) {
    let progressed = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const folder = pending[i]
      if (folder.parentId !== null && !byFileFolder.has(folder.parentId)) continue
      const parentId =
        folder.parentId === null ? null : (byFileFolder.get(folder.parentId) ?? null)
      const existing = findExisting(folder.name, parentId)
      const id = existing ? existing.id : await sink.createFolder(folder.name, parentId)
      if (!existing) {
        folderCount++
        known.push({ ...folder, id, parentId })
      }
      byFileFolder.set(folder.id, id)
      pending.splice(i, 1)
      progressed = true
    }
    // A cycle in a hand-edited file: the remainder is created at the top level
    // so no folder is silently lost.
    if (!progressed) break
  }
  for (const folder of pending) {
    const existing = findExisting(folder.name, null)
    const id = existing ? existing.id : await sink.createFolder(folder.name, null)
    if (!existing) folderCount++
    byFileFolder.set(folder.id, id)
  }

  // ------------------------------------------------------------- playlists
  const current = await sink.listPlaylists()
  const unmatched: string[] = []
  let playlistCount = 0

  for (const playlist of playlists) {
    const id = await sink.ensurePlaylist(playlist.name, playlist.description)
    playlistCount++

    const holding = current.find((p) => p.id === id)
    // Notes and folder placement are filled in, never overwritten: a playlist
    // the user already filed or described keeps their decision. A playlist that
    // was just created by this import is "holding nothing", which is exactly
    // the blank those fields want.
    if (playlist.description && !holding?.description) {
      await sink.setPlaylistDescription(id, playlist.description)
    }
    if (playlist.folderId !== null && (holding?.folderId ?? null) === null) {
      const folderId = byFileFolder.get(playlist.folderId)
      if (folderId !== undefined) await sink.setPlaylistFolder(id, folderId)
    }

    for (const ref of playlist.refs) {
      const trackId = resolveRef(ref, byFileId, byPair, byTitle)
      if (trackId === null) {
        const label = ref.id !== undefined && !ref.title
          ? `#${ref.id}`
          : [ref.artist, ref.title].filter(Boolean).join(' — ') || `#${ref.id}`
        unmatched.push(`${playlist.name} → ${label}`)
        continue
      }
      await sink.addToPlaylist(id, trackId)
    }
  }

  // ------------------------------------------------------------- play history
  // Remapped through the same file-id table as playlist entries: a backup
  // restored onto new ids keeps its history, and plays naming tracks the file
  // did not carry at all are dropped rather than orphaned.
  // The sink ignores events it already holds, so re-importing is a no-op here
  // exactly as it is for tracks and membership.
  const incoming: PlayEvent[] = []
  for (const play of document.plays) {
    const trackId = byFileId.get(play.trackId)
    if (trackId !== undefined) incoming.push({ trackId, playedAt: play.playedAt })
  }
  if (incoming.length) await sink.recordPlays(incoming)

  return { tracks: trackCount, playlists: playlistCount, folders: folderCount, unplayable, unmatched }
}

function resolveRef(
  ref: TrackRef,
  byFileId: Map<number, number>,
  byPair: Map<string, number>,
  byTitle: Map<string, number | null>,
): number | null {
  if (ref.id !== undefined) {
    const direct = byFileId.get(ref.id)
    if (direct !== undefined) return direct
  }
  if (ref.title && ref.artist) {
    const pair = byPair.get(pairKey(ref.title, ref.artist))
    if (pair !== undefined) return pair
  }
  if (ref.title) {
    const byName = byTitle.get(ref.title.trim().toLowerCase())
    if (typeof byName === 'number') return byName
  }
  return null
}
