import {
  type LibraryDocument,
  type LibraryFilter,
  type NewTrack,
  type PlayEvent,
  type Playlist,
  type PlaylistEntry,
  type PlaylistFolder,
  type SourceKind,
  type SourceRole,
  type StoredPlaylist,
  type StoredSource,
  type StoredTrack,
  type TrackPatch,
  type TrackWithSources,
} from './types'
import {
  applyImport,
  assertReplaceableDocument,
  clampIndex,
  normalise,
  normaliseDuration,
  type AddTrackOptions,
  type ImportResult,
} from './libraryImport'
import { dedupeGenres } from './genres'
import { MAX_PLAY_EVENTS } from './dj'
import { MAX_SOURCES } from './types'
import { hasPlayableSource, isPlayableRole, resolveRole } from './sources'

// Kept as a re-export so every existing reader (the agent panel, the tests)
// keeps importing it from here.
export { normalise } from './libraryImport'

/**
 * A library store backed by a plain JSON file.
 *
 * This implements the same surface as the SQL `Library`, so the UI is agnostic
 * about where data lives. The document is human- and agent-editable: it can be
 * opened in an editor or pasted into an AI assistant to fill in missing genres,
 * covers or notes, and the changes appear on reload.
 */

export interface LibraryApi {
  migrate(): Promise<void>
  listGenres(): Promise<Array<{ name: string; count: number }>>
  listArtists(): Promise<string[]>
  listAlbums(): Promise<string[]>
  addTrack(input: NewTrack, options?: AddTrackOptions): Promise<number>
  findByMusicBrainzId(mbid: string | null): Promise<number | null>
  getTrack(id: number): Promise<TrackWithSources | null>
  updateTrack(id: number, patch: TrackPatch): Promise<void>
  deleteTrack(id: number): Promise<void>
  setMusicBrainzId(trackId: number, mbid: string | null): Promise<void>
  /** Fills, replaces or (optional roles only) empties a source slot. */
  setSource(
    trackId: number,
    role: SourceRole,
    source: { youtubeId: string; url: string; kind: string; label?: string | null } | null,
  ): Promise<void>
  listTracks(filter: LibraryFilter): Promise<TrackWithSources[]>
  createPlaylist(
    name: string,
    description?: string,
    folderId?: number | null,
  ): Promise<number>
  listPlaylists(): Promise<Playlist[]>
  deletePlaylist(id: number): Promise<void>
  addToPlaylist(playlistId: number, trackId: number): Promise<void>
  removeFromPlaylist(playlistId: number, trackId: number): Promise<void>
  movePlaylistTrack(
    playlistId: number,
    trackId: number,
    toIndex: number,
  ): Promise<void>
  listPlaylistTracks(playlistId: number): Promise<PlaylistEntry[]>
  listFolders(): Promise<PlaylistFolder[]>
  createFolder(name: string, parentId?: number | null): Promise<number>
  renameFolder(id: number, name: string): Promise<void>
  renamePlaylist(id: number, name: string): Promise<void>
  setPlaylistDescription(
    playlistId: number,
    description: string | null,
  ): Promise<void>
  /**
   * Re-parents a folder, or lifts it to the top level when `parentId` is null.
   * Refuses a move that would put a folder inside itself or a descendant of it.
   */
  setFolderParent(id: number, parentId: number | null): Promise<void>
  deleteFolder(id: number): Promise<void>
  setPlaylistFolder(playlistId: number, folderId: number | null): Promise<void>
  listPlaylistsForTrack(trackId: number): Promise<Playlist[]>
  recordPlay(trackId: number, playedAt?: string): Promise<void>
  recordPlays(events: PlayEvent[]): Promise<void>
  listRecentPlays(limit: number): Promise<PlayEvent[]>
  ensurePlaylist(name: string, description?: string | null): Promise<number>
  exportJson(): Promise<string>
  importJson(json: string): Promise<ImportResult>
  /** Empties the store, then imports — the library mirrors the file exactly. */
  replaceJson(json: string): Promise<ImportResult>
  /** Runs a bulk write as one unit: one file write, and none if it fails. */
  transact<T>(run: () => Promise<T>): Promise<T>
}



/**
 * Raised when the file on disk moved on while an edit was in flight.
 *
 * Almost always an agent merge landing between the app reading the library and
 * the app saving. Failing loudly is the point: the alternative is writing a
 * document from before the merge and quietly undoing everything it added.
 */
export class LibraryConflictError extends Error {
  constructor() {
    super(
      'The library file changed on disk while you were editing — most likely an AI ' +
        'batch was merged in. Nothing was overwritten. Press save again to add your ' +
        'change to the current library.',
    )
    this.name = 'LibraryConflictError'
  }
}

/** Transport for the JSON document. Injected so tests need no HTTP server. */
export interface JsonTransport {
  load(): Promise<string>
  save(json: string, options?: { ifMatch?: string | null }): Promise<void>
  /**
   * The revision of the document returned by the last `load` or `save`, when
   * the transport has one. Used as the `If-Match` value so a save based on a
   * stale read is refused rather than applied over someone else's changes.
   */
  lastRevision?(): string | null
}

/**
 * The browser reports a refused connection as a bare `TypeError: Failed to
 * fetch`, which tells the user nothing. Every transport call that can hit the
 * network goes through this so a dead server reads as what it is.
 */
function withNetworkHint<T>(action: string, run: () => Promise<T>): Promise<T> {
  return run().catch((e: unknown) => {
    if (e instanceof TypeError) {
      throw new Error(
        `${action} failed — the TrackVault server is not responding. ` +
          `It serves the library file, so keep the launcher window open ` +
          `(or run \`npx vite preview --port 1420 --strictPort\`) and try again.`,
      )
    }
    throw e
  })
}

/** Talks to the local file via the dev/preview server middleware. */
export function createHttpTransport(endpoint = '/api/library'): JsonTransport {
  let revision: string | null = null
  return {
    load() {
      return withNetworkHint('Reading the library', async () => {
        const res = await fetch(endpoint, { cache: 'no-store' })
        if (!res.ok) throw new Error(`Could not read the library (${res.status}).`)
        revision = res.headers.get('ETag')?.replace(/"/g, '') ?? null
        return res.text()
      })
    },
    save(json, options) {
      return withNetworkHint('Saving the library', async () => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        const ifMatch = options?.ifMatch ?? null
        if (ifMatch) headers['If-Match'] = `"${ifMatch}"`
        const res = await fetch(endpoint, { method: 'PUT', headers, body: json })
        if (res.status === 409) throw new LibraryConflictError()
        if (!res.ok) throw new Error(`Could not save the library (${res.status}).`)
        revision = res.headers.get('ETag')?.replace(/"/g, '') ?? revision
      })
    },
    lastRevision() {
      return revision
    },
  }
}

/** In-memory transport, used by tests and as a fallback when no server exists. */
export function createMemoryTransport(initial = ''): JsonTransport & {
  current(): string
} {
  let state = initial
  return {
    async load() {
      return state
    },
    async save(json) {
      state = json
    },
    current() {
      return state
    },
  }
}

export class JsonLibrary implements LibraryApi {
  private doc: LibraryDocument = {
    format: 'trackvault-library',
    version: 1,
    tracks: [],
    folders: [],
    playlists: [],
    plays: [],
  }
  private nextTrackId = 1
  private nextSourceId = 1
  private nextPlaylistId = 1
  private nextFolderId = 1
  /** Serialises reads and writes so they cannot interleave. */
  private writeQueue: Promise<void> = Promise.resolve()
  private loaded = false
  /**
   * How many `transact` calls are open, and whether one left a write owed.
   *
   * Every mutating method ends in `persist()`. Inside a transaction that is
   * recorded rather than performed, so importing 1765 tracks is one file write
   * instead of 1765 of them — each of which re-serialised the whole growing
   * document. That quadratic cost is why an import took minutes.
   */
  private bulkDepth = 0
  private writeOwed = false
  /** A poll asked for a refresh while a transaction was running. */
  private reloadOwed = false
  /**
   * Bumped on every write, so a reload can tell that the document it read from
   * disk is older than an edit that is already in memory.
   */
  private mutating = 0

  constructor(private readonly transport: JsonTransport) {}

  async migrate(): Promise<void> {
    await this.load()
  }

  /** Reads the document once, normalising anything an agent may have changed. */
  private async load(): Promise<void> {
    if (this.loaded) return
    const raw = await this.transport.load()
    this.adopt(raw)
  }

  private adopt(raw: string): void {
    this.doc = normalise(raw)
    this.loaded = true
    this.recomputeIds()
  }

  /**
   * Reloads from disk, to pick up edits made outside the app.
   *
   * Two guards make this safe against the import it runs beside:
   *
   * - **Never during a transaction.** A bulk import owns the document until it
   *   finishes; re-reading the file mid-import used to replace the in-memory
   *   document with an older one, and the *next* write then persisted that
   *   older document. That is how an import lost tracks, and why it reported
   *   "Playlist not found." — the playlist it had just created was gone from
   *   the document by the time its members were added.
   * - **Never when an edit landed while the read was in flight.** The document
   *   is newer than the file in that case, so adopting the file would drop the
   *   edit.
   *
   * The read is also queued behind pending writes, so it cannot observe a file
   * that is one write behind memory.
   */
  async reload(): Promise<void> {
    if (this.bulkDepth > 0) {
      this.reloadOwed = true
      return
    }
    // Taken before the read starts, so an edit that lands while it is in
    // flight — even one scheduled after this call — is seen as newer.
    const version = this.mutating
    await this.enqueue(async () => {
      // A transaction may have started while this read sat in the queue.
      if (this.bulkDepth > 0) {
        this.reloadOwed = true
        return
      }
      const raw = await this.transport.load()
      if (version !== this.mutating || this.bulkDepth > 0) {
        this.reloadOwed = true
        return
      }
      this.adopt(raw)
      this.reloadOwed = false
    })
  }

  /** Queues `run` behind everything already in flight without poisoning the queue. */
  private async enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(run)
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    await next
  }

  private recomputeIds(): void {
    this.nextTrackId =
      this.doc.tracks.reduce((max, t) => Math.max(max, t.id), 0) + 1
    this.nextPlaylistId =
      this.doc.playlists.reduce((max, p) => Math.max(max, p.id), 0) + 1
    this.nextFolderId =
      this.doc.folders.reduce((max, f) => Math.max(max, f.id), 0) + 1
    this.nextSourceId =
      this.doc.tracks.reduce(
        (max, t) =>
          Math.max(max, ...t.sources.map((s) => Number(s.id) || 0), 0),
        0,
      ) + 1
  }

  /**
   * Writes the document out, tagged with the revision it was read at.
   *
   * A rejected write means the file changed underneath us — an agent batch was
   * merged in, or another window saved. The local copy is dropped and the file
   * re-read so the UI shows what is actually on disk, and the error explains
   * that nothing was overwritten. Reloading here rather than retrying is the
   * point: retrying would be the very overwrite the check exists to prevent.
   */
  private async persist(): Promise<void> {
    if (this.bulkDepth > 0) {
      this.writeOwed = true
      return
    }
    this.mutating++
    const snapshot = JSON.stringify(this.doc, null, 2)
    await this.enqueue(async () => {
      try {
        await this.transport.save(snapshot, {
          ifMatch: this.transport.lastRevision?.() ?? null,
        })
      } catch (e: unknown) {
        if (e instanceof LibraryConflictError) {
          this.loaded = false
          await this.load()
        }
        throw e
      }
    })
  }

  /**
   * Runs a bulk write as one unit.
   *
   * Mutations inside it accumulate in memory and are written once, at the end.
   * A failure writes nothing and drops the half-applied document, so an import
   * that cannot finish leaves the library exactly as it found it instead of a
   * prefix of the file — which is what a failed replace used to leave behind.
   */
  async transact<T>(run: () => Promise<T>): Promise<T> {
    this.bulkDepth++
    let result: T | undefined
    let failed = false
    let failure: unknown
    try {
      result = await run()
    } catch (e: unknown) {
      failed = true
      failure = e
    }
    this.bulkDepth--
    // A nested transaction neither writes nor rolls back: the outermost one
    // owns both, so a replace that wraps the importer still commits once.
    if (this.bulkDepth > 0) {
      if (failed) throw failure
      return result as T
    }
    if (!failed) {
      try {
        await this.settle()
        return result as T
      } catch (e: unknown) {
        failed = true
        failure = e
      }
    }
    this.writeOwed = false
    this.reloadOwed = false
    // The document in memory is a library that was never written (or one whose
    // write failed), so it is dropped and the file is taken back: memory and
    // disk agree again about the library this transaction did not finish.
    await this.enqueue(async () => {
      this.loaded = false
      await this.load()
    }).catch(() => undefined)
    throw failure
  }

  /** Writes what a finished transaction owes, then honours a deferred reload. */
  private async settle(): Promise<void> {
    if (this.writeOwed) {
      this.writeOwed = false
      await this.persist()
    }
    if (this.reloadOwed) {
      this.reloadOwed = false
      await this.reload()
    }
  }

  private touch(track: StoredTrack): TrackWithSources {
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverUrl: track.coverUrl,
      year: track.year,
      musicbrainzRecordingId: track.musicbrainzRecordingId,
      info: track.info,
      lyrics: track.lyrics ?? null,
      lyricsSource: track.lyricsSource ?? null,
      duration: track.duration ?? null,
      createdAt: track.createdAt,
      genres: [...track.genres].sort((a, b) => a.localeCompare(b)),
      sources: track.sources.map((s, index) => ({
        ...s,
        trackId: track.id,
        position: index,
      })),
    }
  }

  // ---------------------------------------------------------------- genres

  async listGenres(): Promise<Array<{ name: string; count: number }>> {
    const counts = new Map<string, number>()
    for (const track of this.doc.tracks) {
      for (const genre of track.genres) {
        counts.set(genre, (counts.get(genre) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  async listArtists(): Promise<string[]> {
    return uniqueSorted(this.doc.tracks.map((t) => t.artist))
  }

  async listAlbums(): Promise<string[]> {
    return uniqueSorted(
      this.doc.tracks.map((t) => t.album).filter((a): a is string => !!a),
    )
  }

  // ---------------------------------------------------------------- tracks

  async findByMusicBrainzId(mbid: string | null): Promise<number | null> {
    if (!mbid) return null
    return this.doc.tracks.find((t) => t.musicbrainzRecordingId === mbid)?.id ?? null
  }

  /**
   * The id an add should merge onto, or null to create a new track.
   *
   * Deliberately the same two-step rule as the SQL store's `findExisting`: the
   * MusicBrainz id when there is one, otherwise the artist/title pair compared
   * case-insensitively and trimmed. The two stores feeding `applyImport` must
   * agree here, or an import merges on one machine and duplicates on the other.
   */
  private async findExistingForAdd(
    mbid: string | null,
    title: string,
    artist: string,
  ): Promise<number | null> {
    const byMb = await this.findByMusicBrainzId(mbid)
    if (byMb !== null) return byMb
    const match = this.doc.tracks.find(
      (t) =>
        t.title.trim().toLowerCase() === title.trim().toLowerCase() &&
        t.artist.trim().toLowerCase() === artist.trim().toLowerCase(),
    )
    if (!match) return null
    if (mbid && match.musicbrainzRecordingId && match.musicbrainzRecordingId !== mbid) {
      return null
    }
    return match.id
  }

  async addTrack(input: NewTrack, options?: AddTrackOptions): Promise<number> {
    const title = input.title.trim()
    const artist = input.artist.trim()
    if (!title) throw new Error('Track title is required.')
    if (!artist) throw new Error('Track artist is required.')
    // Only an import may store a track with no link at all: it is copying rows
    // the library already had, not proposing a new one. See `AddTrackOptions`.
    if (!input.sources.length && !options?.allowUnplayable) {
      throw new Error('A track needs at least one YouTube source.')
    }

    // Merge onto the row that already exists, matching the SQL behaviour: the
    // canonical MusicBrainz id first, then the case-insensitive artist/title
    // pair, which catches a double add of the same song that has no id. A
    // candidate claiming a *different* recording is skipped by that fallback, so
    // a single and its live version are never merged into one row.
    const existingId = await this.findExistingForAdd(
      input.musicbrainzRecordingId ?? null,
      title,
      artist,
    )
    if (existingId !== null) {
      const track = this.doc.tracks.find((t) => t.id === existingId)!
      const taken = track.sources.map((s) => s.role)
      for (const source of input.sources) {
        if (track.sources.some((s) => s.youtubeId === source.youtubeId)) continue
        if (source.role && taken.includes(source.role)) continue
        // The three fixed roles cap how many links a track can hold.
        if (track.sources.length >= MAX_SOURCES) break
        const role = resolveRole(source.role, taken)
        taken.push(role)
        track.sources.push(makeSource(source, this.nextSourceId++, role))
      }
      track.genres = dedupeGenres([...track.genres, ...input.genres])
      // Fill blanks from the incoming copy. An import or a re-add that carries
      // more detail improves the record; one that carries less can never
      // degrade it, because nothing already set is touched.
      if (!track.album && input.album?.trim()) track.album = input.album.trim()
      if (!track.coverUrl && input.coverUrl) track.coverUrl = input.coverUrl
      if (track.year === null && input.year) track.year = input.year
      if (!track.info && input.info?.trim()) track.info = input.info.trim()
      if (!track.lyrics && input.lyrics?.trim()) track.lyrics = input.lyrics.trim()
      if (!track.lyricsSource && input.lyricsSource?.trim()) track.lyricsSource = input.lyricsSource.trim()
      if (track.duration === null && normaliseDuration(input.duration) !== null) {
        track.duration = normaliseDuration(input.duration)
      }
      if (
        !track.musicbrainzRecordingId &&
        input.musicbrainzRecordingId &&
        !this.doc.tracks.some(
          (t) =>
            t.id !== existingId &&
            t.musicbrainzRecordingId === input.musicbrainzRecordingId,
        )
      ) {
        track.musicbrainzRecordingId = input.musicbrainzRecordingId
      }
      await this.persist()
      return existingId
    }

    const taken: SourceRole[] = []
    const sources = input.sources.slice(0, MAX_SOURCES).map((s) => {
      const role = resolveRole(s.role, taken)
      taken.push(role)
      return makeSource(s, this.nextSourceId++, role)
    })
    // A Main or a video clip: they stand in for each other in playback, so
    // either one is enough. A live take on its own is not.
    if (!hasPlayableSource(sources) && !options?.allowUnplayable) {
      throw new Error('A track needs a Main link or a video clip.')
    }

    const track: StoredTrack = {
      id: this.nextTrackId++,
      title,
      artist,
      album: input.album?.trim() || null,
      coverUrl: input.coverUrl || null,
      year: input.year ?? null,
      musicbrainzRecordingId: input.musicbrainzRecordingId ?? null,
      info: input.info?.trim() || null,
      lyrics: input.lyrics?.trim() || null,
      lyricsSource: input.lyricsSource?.trim() || null,
      duration: normaliseDuration(input.duration),
      createdAt: new Date().toISOString(),
      genres: dedupeGenres(input.genres),
      sources,
    }
    this.doc.tracks.push(track)
    await this.persist()
    return track.id
  }

  async getTrack(id: number): Promise<TrackWithSources | null> {
    const track = this.doc.tracks.find((t) => t.id === id)
    return track ? this.touch(track) : null
  }

  async updateTrack(id: number, patch: TrackPatch): Promise<void> {
    const track = this.doc.tracks.find((t) => t.id === id)
    if (!track) throw new Error('Track not found.')
    if (patch.title !== undefined) track.title = patch.title.trim()
    if (patch.artist !== undefined) track.artist = patch.artist.trim()
    if (patch.album !== undefined) track.album = patch.album?.trim() || null
    if (patch.coverUrl !== undefined) track.coverUrl = patch.coverUrl || null
    if (patch.year !== undefined) track.year = patch.year ?? null
    if (patch.info !== undefined) track.info = patch.info?.trim() || null
    if (patch.lyrics !== undefined) track.lyrics = patch.lyrics?.trim() || null
    if (patch.lyricsSource !== undefined) track.lyricsSource = patch.lyricsSource?.trim() || null
    if (patch.genres) track.genres = dedupeGenres(patch.genres)
    await this.persist()
  }

  async deleteTrack(id: number): Promise<void> {
    this.doc.tracks = this.doc.tracks.filter((t) => t.id !== id)
    for (const playlist of this.doc.playlists) {
      playlist.tracks = playlist.tracks.filter((tid) => tid !== id)
    }
    // History follows the track out, matching the SQL store's cascade: plays
    // naming a deleted track are no one’s taste.
    this.doc.plays = this.doc.plays.filter((p) => p.trackId !== id)
    await this.persist()
  }

  async setDuration(id: number, seconds: number | null): Promise<void> {
    const duration = normaliseDuration(seconds)
    if (duration === null) return
    const track = this.doc.tracks.find((t) => t.id === id)
    if (!track || track.duration === duration) return
    track.duration = duration
    await this.persist()
  }

  async setMusicBrainzId(trackId: number, mbid: string | null): Promise<void> {
    const track = this.doc.tracks.find((t) => t.id === trackId)
    if (!track) throw new Error('Track not found.')
    if (mbid) {
      const clash = this.doc.tracks.find(
        (t) => t.id !== trackId && t.musicbrainzRecordingId === mbid,
      )
      if (clash) {
        throw new Error(
          'Another track in your library already uses that MusicBrainz recording.',
        )
      }
    }
    track.musicbrainzRecordingId = mbid
    await this.persist()
  }

  async setSource(
    trackId: number,
    role: SourceRole,
    source: { youtubeId: string; url: string; kind: string; label?: string | null } | null,
  ): Promise<void> {
    const track = this.doc.tracks.find((t) => t.id === trackId)
    if (!track) throw new Error('Track not found.')
    const index = track.sources.findIndex((s) => s.role === role)

    if (source === null) {
      // Either half of the pair may be emptied; only emptying the last of them
      // would leave nothing to stream, and then the track should go rather than
      // the link. Same rule as the SQL store.
      if (isPlayableRole(role)) {
        const staysPlayable = track.sources.some(
          (s) => s.role !== role && isPlayableRole(s.role),
        )
        if (!staysPlayable) {
          throw new Error(
            'A track needs a Main link or a video clip. Delete the whole track instead.',
          )
        }
      }
      // Nothing to clear. `index` is -1 for an empty slot and splice(-1, 1)
      // removes the *last* element, which here is the audio source the same
      // save just wrote — so the edit dialog appeared to save nothing at all.
      // The edit form writes all three slots every time, so this path is the normal
      // one for any track without a video or live take.
      if (index < 0) return
      track.sources.splice(index, 1)
      await this.persist()
      return
    }

    const clash = track.sources.find((s) => s.youtubeId === source.youtubeId)
    if (clash && clash.role !== role) {
      throw new Error('This video is already attached to the track.')
    }

    const stored = makeSource(source, this.nextSourceId++, role)
    if (index >= 0) {
      // Replacing a slot keeps the existing row id so the UI stays stable.
      stored.id = track.sources[index].id
      track.sources[index] = stored
    } else {
      if (track.sources.length >= MAX_SOURCES) {
        throw new Error(
          'A track has three source slots: Main, official video clip, and Live.',
        )
      }
      // Keep audio first in the file so it is obvious which link is which.
      track.sources.splice(['audio', 'video', 'live'].indexOf(role), 0, stored)
    }
    await this.persist()
  }

  /**
   * Cuts one source slot outright — the audio slot included.
   *
   * Same rule and same reason as the SQL store's: `setSource(…, null)` guards
   * the editor against emptying the Main slot by accident, while a link-health
   * run has YouTube's verdict in hand and needs the dead slot gone. The caller
   * files a track left with no Main and no clip under Issues.
   */
  async removeSource(trackId: number, role: SourceRole): Promise<void> {
    const track = this.doc.tracks.find((t) => t.id === trackId)
    if (!track) throw new Error('Track not found.')
    const index = track.sources.findIndex((s) => s.role === role)
    if (index < 0) return
    track.sources.splice(index, 1)
    await this.persist()
  }

  /** Filters mirror the SQL query: every selected facet is AND-ed. */
  async listTracks(filter: LibraryFilter): Promise<TrackWithSources[]> {
    const search = filter.search.trim().toLowerCase()
    const selected = filter.genres.map((g) => g.toLowerCase())
    // Membership for the unfiled-only filter: every track id in any playlist.
    const filed = new Set<number>()
    if (filter.unfiledOnly) {
      for (const playlist of this.doc.playlists) {
        for (const id of playlist.tracks) filed.add(id)
      }
    }
    return this.doc.tracks
      .filter((track) => {
        if (search) {
          const haystack = [
            track.title,
            track.artist,
            track.album ?? '',
            ...track.sources.map((s) => s.label ?? ''),
          ]
            .join(' ')
            .toLowerCase()
          if (!haystack.includes(search)) return false
        }
        // Additive: any one selected genre is enough, so two genres widen the
        // list instead of requiring a track to carry both.
        if (
          selected.length &&
          !track.genres.some((g) => selected.includes(g.toLowerCase()))
        ) {
          return false
        }
        if (filter.artist && track.artist.toLowerCase() !== filter.artist.toLowerCase()) {
          return false
        }
        if (filter.album && (track.album ?? '').toLowerCase() !== filter.album.toLowerCase()) {
          return false
        }
        if (
          filter.sourceKind &&
          !track.sources.some((s) => s.kind === filter.sourceKind)
        ) {
          return false
        }
        if (filter.unfiledOnly && filed.has(track.id)) {
          return false
        }
        if (
          filter.hasLiveSource &&
          !track.sources.some((s) => s.role === 'live')
        ) {
          return false
        }
        return true
      })
      .sort(
        (a, b) =>
          a.artist.localeCompare(b.artist) ||
          (a.album ?? '').localeCompare(b.album ?? '') ||
          a.title.localeCompare(b.title),
      )
      .map((t) => this.touch(t))
  }

  // ------------------------------------------------------------- playlists

  async createPlaylist(
    name: string,
    description?: string,
    folderId?: number | null,
  ): Promise<number> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Playlist name is required.')
    const playlist: StoredPlaylist = {
      id: this.nextPlaylistId++,
      name: trimmed,
      description: description?.trim() || null,
      createdAt: new Date().toISOString(),
      tracks: [],
      folderId: folderId ?? null,
    }
    this.doc.playlists.push(playlist)
    await this.persist()
    return playlist.id
  }

  async listPlaylists(): Promise<Playlist[]> {
    return this.doc.playlists
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: p.createdAt,
        trackCount: p.tracks.length,
        folderId: p.folderId ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async deletePlaylist(id: number): Promise<void> {
    this.doc.playlists = this.doc.playlists.filter((p) => p.id !== id)
    await this.persist()
  }

  /**
   * Renames a playlist in place.
   *
   * Same contract as `renameFolder` above: a blank name is refused rather than
   * silently stored, and an id that is not there is a no-op.
   */
  async renamePlaylist(id: number, name: string): Promise<void> {
    const playlist = this.doc.playlists.find((p) => p.id === id)
    if (!playlist) return
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Playlist name is required.')
    playlist.name = trimmed
    await this.persist()
  }

  /**
   * Writes a playlist's own notes, or clears them with an empty value.
   *
   * Unlike a genre or a track title, an empty description is meaningful — it is
   * how the panel's Clear button works — so the value is stored as null rather
   * than refused.
   */
  async setPlaylistDescription(
    playlistId: number,
    description: string | null,
  ): Promise<void> {
    const playlist = this.doc.playlists.find((p) => p.id === playlistId)
    if (!playlist) return
    playlist.description = description?.trim() || null
    await this.persist()
  }

  // ------------------------------------------------------- playlist folders

  async listFolders(): Promise<PlaylistFolder[]> {
    return [...this.doc.folders].sort((a, b) => a.name.localeCompare(b.name))
  }

  async createFolder(name: string, parentId?: number | null): Promise<number> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Folder name is required.')
    const folder: PlaylistFolder = {
      id: this.nextFolderId++,
      name: trimmed,
      parentId: parentId ?? null,
      createdAt: new Date().toISOString(),
    }
    this.doc.folders.push(folder)
    await this.persist()
    return folder.id
  }

  async renameFolder(id: number, name: string): Promise<void> {
    const folder = this.doc.folders.find((f) => f.id === id)
    if (!folder) return
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Folder name is required.')
    folder.name = trimmed
    await this.persist()
  }

  /**
   * Deletes a folder and everything under it, keeping the playlists inside.
   *
   * Playlists are lifted to the top level rather than destroyed with the folder:
   * a folder is an organising decision, and a playlist holds hand-built ordering
   * that no folder deletion should silently take with it.
   */
  async deleteFolder(id: number): Promise<void> {
    const doomed = new Set<number>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const folder of this.doc.folders) {
        if (
          folder.parentId !== null &&
          doomed.has(folder.parentId) &&
          !doomed.has(folder.id)
        ) {
          doomed.add(folder.id)
          grew = true
        }
      }
    }
    for (const playlist of this.doc.playlists) {
      if (playlist.folderId !== null && doomed.has(playlist.folderId)) {
        playlist.folderId = null
      }
    }
    this.doc.folders = this.doc.folders.filter((f) => !doomed.has(f.id))
    await this.persist()
  }

  async setPlaylistFolder(
    playlistId: number,
    folderId: number | null,
  ): Promise<void> {
    const playlist = this.doc.playlists.find((p) => p.id === playlistId)
    if (!playlist) return
    playlist.folderId = folderId
    await this.persist()
  }

  /**
   * Re-parents a folder, or lifts it to the top level when `parentId` is null.
   *
   * Refuses a move that would put a folder inside itself or inside one of its
   * own descendants: that would detach the subtree from the root, leaving the
   * folders in the file and unreachable. The check runs before the write, so a
   * refused move leaves the tree exactly as it was.
   */
  async setFolderParent(id: number, parentId: number | null): Promise<void> {
    if (parentId === id) throw new Error('A folder cannot contain itself.')
    const folder = this.doc.folders.find((f) => f.id === id)
    if (!folder) return
    if (parentId !== null) {
      if (!this.doc.folders.some((f) => f.id === parentId)) {
        throw new Error('Folder not found.')
      }
      const byId = new Map(this.doc.folders.map((f) => [f.id, f]))
      let cursor: number | null = parentId
      while (cursor !== null) {
        if (cursor === id) {
          throw new Error('A folder cannot be moved inside itself.')
        }
        cursor = byId.get(cursor)?.parentId ?? null
      }
    }
    folder.parentId = parentId
    await this.persist()
  }

  /** Every playlist a track belongs to, for the track card. */
  async listPlaylistsForTrack(trackId: number): Promise<Playlist[]> {
    return this.doc.playlists
      .filter((p) => p.tracks.includes(trackId))
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        createdAt: p.createdAt,
        trackCount: p.tracks.length,
        folderId: p.folderId ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Records a track that played to its end.
   *
   * Same promise as the SQL store's: an append, pruned to the shared cap, so
   * history can never outgrow the file it lives in.
   */
  async recordPlay(trackId: number, playedAt = new Date().toISOString()): Promise<void> {
    this.doc.plays.push({ trackId, playedAt })
    this.prunePlays()
    await this.persist()
  }

  /**
   * Records imported listens, skipping ones already held — the half of the
   * re-import idempotence the shared importer cannot do on its own, because
   * only the store knows what it holds.
   */
  async recordPlays(events: PlayEvent[]): Promise<void> {
    const held = new Set(this.doc.plays.map((p) => `${p.trackId}|${p.playedAt}`))
    for (const event of events) {
      const key = `${event.trackId}|${event.playedAt}`
      if (held.has(key)) continue
      held.add(key)
      this.doc.plays.push({ ...event })
    }
    this.prunePlays()
    await this.persist()
  }

  private prunePlays(): void {
    if (this.doc.plays.length > MAX_PLAY_EVENTS) {
      this.doc.plays = this.doc.plays.slice(-MAX_PLAY_EVENTS)
    }
  }

  /**
   * Completed listens, newest first — what the DJ learns taste from.
   *
   * Sorted by listen time like the SQL store's, so an imported backup reads
   * back in the order its listens happened rather than the order they were
   * inserted. Ties keep reverse-insertion order via the stable sort.
   */
  async listRecentPlays(limit: number): Promise<PlayEvent[]> {
    return [...this.doc.plays]
      .reverse()
      .sort((a, b) => (b.playedAt < a.playedAt ? -1 : b.playedAt > a.playedAt ? 1 : 0))
      .slice(0, Math.max(0, Math.trunc(limit)))
  }

  async addToPlaylist(playlistId: number, trackId: number): Promise<void> {
    const playlist = this.doc.playlists.find((p) => p.id === playlistId)
    if (!playlist) throw new Error('Playlist not found.')
    if (!playlist.tracks.includes(trackId)) playlist.tracks.push(trackId)
    await this.persist()
  }

  async removeFromPlaylist(playlistId: number, trackId: number): Promise<void> {
    const playlist = this.doc.playlists.find((p) => p.id === playlistId)
    if (!playlist) return
    playlist.tracks = playlist.tracks.filter((id) => id !== trackId)
    await this.persist()
  }

  /**
   * Re-orders one track inside one playlist.
   *
   * The playlist's own order *is* the array, so this is the whole write: the
   * track leaves `tracks` and is spliced back in at `toIndex`, and everything
   * it crossed shifts by one. Same clamp as the SQL store's, out of the same
   * `clampIndex`, because the drop is a pointer position and "past the end"
   * has to mean the last slot in both stores.
   *
   * A playlist that is not there, or a track that is not in it, is a quiet
   * no-op rather than an error — and nothing is written in that case, so a
   * stray drag cannot rewrite the file for nothing.
   */
  async movePlaylistTrack(
    playlistId: number,
    trackId: number,
    toIndex: number,
  ): Promise<void> {
    const playlist = this.doc.playlists.find((p) => p.id === playlistId)
    if (!playlist) return
    const from = playlist.tracks.indexOf(trackId)
    if (from === -1) return

    playlist.tracks.splice(from, 1)
    const target = clampIndex(toIndex, playlist.tracks.length)
    playlist.tracks.splice(target, 0, trackId)
    await this.persist()
  }

  async listPlaylistTracks(playlistId: number): Promise<PlaylistEntry[]> {
    const playlist = this.doc.playlists.find((p) => p.id === playlistId)
    if (!playlist) return []
    // By id, once: a folder view asks this for every playlist under it, and a
    // linear search per member is quadratic on a library of a few thousand.
    const byId = new Map(this.doc.tracks.map((t) => [t.id, t]))
    const entries: PlaylistEntry[] = []
    for (const trackId of playlist.tracks) {
      const track = byId.get(trackId)
      // A track deleted from the library may still be listed by hand-edited JSON.
      if (!track) continue
      entries.push({
        playlistId,
        trackId,
        position: entries.length,
        track: this.touch(track),
      })
    }
    return entries
  }

  async ensurePlaylist(name: string, description?: string | null): Promise<number> {
    const existing = this.doc.playlists.find(
      (p) => p.name.toLowerCase() === name.trim().toLowerCase(),
    )
    return existing ? existing.id : this.createPlaylist(name, description ?? undefined)
  }

  // ---------------------------------------------------------------- export

  async exportJson(): Promise<string> {
    return JSON.stringify(this.doc, null, 2)
  }

  async importJson(json: string): Promise<ImportResult> {
    return applyImport(json, this)
  }

  /**
   * Replaces the whole library with the file: the document is emptied and the
   * file is imported into the empty store. The sibling of `importJson`, which
   * merges instead.
   *
   * The emptying, the import and the one write at the end are a single
   * transaction, so this is now atomic: a file that fails halfway leaves the
   * library it was replacing untouched. It used to save the empty document
   * first, so a failure — a refresh landing mid-import was enough — left a
   * partial library where the old one had been.
   */
  async replaceJson(json: string): Promise<ImportResult> {
    assertReplaceableDocument(json)
    await this.load()
    return this.transact(async () => {
      this.doc = {
        format: 'trackvault-library',
        version: 1,
        tracks: [],
        folders: [],
        playlists: [],
        plays: [],
      }
      this.recomputeIds()
      return applyImport(json, this)
    })
  }
}

// ------------------------------------------------------------------ helpers

function makeSource(
  source: { youtubeId: string; url: string; kind: string; label?: string | null },
  id: number,
  role: SourceRole,
): StoredSource {
  return {
    id,
    youtubeId: source.youtubeId,
    url: source.url,
    kind: (source.kind || 'official') as SourceKind,
    label: source.label?.trim() || null,
    role,
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
}

export { EMPTY_FILTER } from './types'
