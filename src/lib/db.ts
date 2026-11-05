import {
  EMPTY_FILTER,
  MAX_SOURCES,
  type LibraryFilter,
  type NewTrack,
  type PlayEvent,
  type Playlist,
  type PlaylistEntry,
  type PlaylistFolder,
  type Source,
  type SourceKind,
  type SourceRole,
  type TrackPatch,
  type TrackWithSources,
} from './types'
import { MAX_PLAY_EVENTS } from './dj'
import { hasPlayableSource, resolveRole } from './sources'
import {
  applyImport,
  assertReplaceableDocument,
  normaliseDuration,
  type AddTrackOptions,
  type ImportResult,
} from './libraryImport'

// Kept as a re-export so callers and tests that import it from the SQL store
// keep working; the implementation lives with the document parser.
export { normaliseDuration } from './libraryImport'

/**
 * Minimal SQL surface used by the sql.js browser-local driver and tests.
 * Keeping the repository behind this interface means the same query logic is
 * exercised by the test suite without a native database toolchain.
 */
export interface SqlDriver {
  execute(sql: string, params?: unknown[]): Promise<void>
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export const SCHEMA_VERSION = 8

/**
 * A requested index pinned into a list of `length` slots.
 *
 * Shared by both playlist re-order paths so the SQL and JSON stores clamp a
 * drop in exactly the same way — a pointer can land outside the list, and "past
 * the end" has to mean the last slot in both of them.
 */
export function clampIndex(toIndex: number, length: number): number {
  const wanted = Math.trunc(toIndex)
  const safe = Number.isFinite(wanted) ? wanted : 0
  return Math.min(Math.max(safe, 0), Math.max(length, 0))
}

const MIGRATIONS: Array<{ version: number; statements: string[] }> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS tracks (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         title TEXT NOT NULL,
         artist TEXT NOT NULL,
         album TEXT,
         cover_url TEXT,
         year INTEGER,
         musicbrainz_recording_id TEXT,
         notes TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `CREATE TABLE IF NOT EXISTS genres (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL UNIQUE COLLATE NOCASE
       )`,
      `CREATE TABLE IF NOT EXISTS track_genres (
         track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
         genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
         PRIMARY KEY (track_id, genre_id)
       )`,
      `CREATE TABLE IF NOT EXISTS sources (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
         youtube_id TEXT NOT NULL,
         url TEXT NOT NULL,
         kind TEXT NOT NULL DEFAULT 'official',
         label TEXT,
         position INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE IF NOT EXISTS playlists (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         description TEXT,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `CREATE TABLE IF NOT EXISTS playlist_tracks (
         playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
         track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
         position INTEGER NOT NULL DEFAULT 0,
         added_at TEXT NOT NULL DEFAULT (datetime('now')),
         PRIMARY KEY (playlist_id, track_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist COLLATE NOCASE)`,
      `CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album COLLATE NOCASE)`,
      `CREATE INDEX IF NOT EXISTS idx_sources_track ON sources(track_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sources_youtube ON sources(youtube_id)`,
      `CREATE INDEX IF NOT EXISTS idx_track_genres_genre ON track_genres(genre_id)`,
      // A canonical MusicBrainz recording is the strongest duplicate signal we have.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_mbid
         ON tracks(musicbrainz_recording_id)
         WHERE musicbrainz_recording_id IS NOT NULL`,
    ],
  },
  {
    version: 2,
    statements: [
      // Sources gained an explicit role: slot 0 is the audio source, anything
      // after it is the video source. The backfill preserves the order the user
      // already had, so an existing library keeps playing what it played before.
      `ALTER TABLE sources ADD COLUMN role TEXT NOT NULL DEFAULT 'audio'`,
      `UPDATE sources SET role = 'video' WHERE position > 0`,
      `CREATE INDEX IF NOT EXISTS idx_sources_role ON sources(track_id, role)`,
    ],
  },
  {
    version: 3,
    statements: [
      // Tracks gained a running time, in whole seconds.
      //
      // Nullable on purpose: a track only has one once something has supplied
      // one (measured from its own YouTube link, or corrected by the player
      // once it reports a real duration), so existing rows must be allowed to sit
      // at NULL rather than being backfilled with a guess.
      `ALTER TABLE tracks ADD COLUMN duration INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_tracks_duration ON tracks(duration)`,
    ],
  },
  {
    version: 4,
    statements: [
      // `notes` became `info`, so that fetched background about the artist or
      // album has an honest home beside the user's own remarks.
      //
      // Added and copied rather than renamed in place: `ALTER TABLE ... RENAME
      // COLUMN` needs SQLite 3.25+ and a DROP would need 3.35+, and there is no
      // reason to make an existing library's readability depend on the host
      // engine's version. The old column is left in place, inert, rather than
      // dropped — an unread value that used to work is not worth a migration
      // that can fail halfway.
      `ALTER TABLE tracks ADD COLUMN info TEXT`,
      `UPDATE tracks SET info = notes WHERE notes IS NOT NULL`,
    ],
  },
  {
    version: 5,
    statements: [
      // Playlists gained a tree: a folder can hold subfolders and playlists.
      //
      // `folder_id` is nullable and defaults to NULL, so every playlist that
      // already existed simply sits at the top level rather than needing a
      // "root" row that could never be renamed or deleted.
      `CREATE TABLE IF NOT EXISTS playlist_folders (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         parent_id INTEGER REFERENCES playlist_folders(id) ON DELETE CASCADE,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `ALTER TABLE playlists ADD COLUMN folder_id INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_playlists_folder ON playlists(folder_id)`,
      `CREATE INDEX IF NOT EXISTS idx_playlist_folders_parent ON playlist_folders(parent_id)`,
    ],
  },
  {
    version: 6,
    statements: [
      // Tracks gained hand-pasted lyrics.
      //
      // Nullable and empty by default: the automatic lookup never writes here,
      // so every existing row — and every new one — simply has none until the
      // user pastes some. Keeping it on the track is what makes those words
      // survive switching tracks and restarting the app.
      `ALTER TABLE tracks ADD COLUMN lyrics TEXT`,
    ],
  },
  {
    version: 7,
    statements: [`ALTER TABLE tracks ADD COLUMN lyrics_source TEXT`],
  },
  {
    version: 8,
    statements: [
      // Completed listens, for the DJ: one row per track that played to its
      // end. A table rather than a column because a track is played many
      // times, and the *when* is the signal — recency is what turns a log
      // into taste. Cascades with the track, so deleting a song forgets it.
      `CREATE TABLE IF NOT EXISTS track_plays (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
         played_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_track_plays_track ON track_plays(track_id)`,
      `CREATE INDEX IF NOT EXISTS idx_track_plays_at ON track_plays(played_at)`,
    ],
  },
]

/**
 * SQLite-backed library.
 *
 * Everything the UI needs is behind `LibraryApi`, which `JsonLibrary` also
 * implements — so the app cannot tell the two apart, and the whole repository is
 * exercised by the test suite through the in-memory sql.js driver without a
 * native database toolchain.
 */
export class Library {
  constructor(private readonly driver: SqlDriver) {}

  async migrate(): Promise<void> {
    // SQLite ignores FOREIGN KEY constraints unless this is on per-connection.
    // Without it, deleting a track silently leaves orphaned genre rows.
    await this.driver.execute('PRAGMA foreign_keys = ON')
    await this.driver.execute(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    )
    const applied = await this.driver.select<{ version: number }>(
      'SELECT version FROM schema_migrations',
    )
    const done = new Set(applied.map((r) => r.version))

    for (const migration of MIGRATIONS) {
      if (done.has(migration.version)) continue
      for (const statement of migration.statements) {
        await this.driver.execute(statement)
      }
      await this.driver.execute(
        'INSERT OR REPLACE INTO schema_migrations (version) VALUES (?)',
        [migration.version],
      )
    }
  }

  async listGenres(): Promise<Array<{ name: string; count: number }>> {
    // Only genres in use are reported, so this matches what `JsonLibrary`
    // derives from the live tracks and a deleted track cannot leave a facet
    // with a count of zero.
    const rows = await this.driver.select<{ name: string; count: number }>(
      `SELECT g.name AS name, COUNT(tg.track_id) AS count
         FROM genres g
         JOIN track_genres tg ON tg.genre_id = g.id
        GROUP BY g.id
        ORDER BY count DESC, g.name COLLATE NOCASE ASC`,
    )
    return rows.map((r) => ({ name: String(r.name), count: Number(r.count) }))
  }

  async listArtists(): Promise<string[]> {
    const rows = await this.driver.select<{ artist: string }>(
      'SELECT DISTINCT artist FROM tracks ORDER BY artist COLLATE NOCASE ASC',
    )
    return rows.map((r) => String(r.artist))
  }

  async listAlbums(): Promise<string[]> {
    const rows = await this.driver.select<{ album: string }>(
      `SELECT DISTINCT album FROM tracks
        WHERE album IS NOT NULL AND album <> ''
        ORDER BY album COLLATE NOCASE ASC`,
    )
    return rows.map((r) => String(r.album))
  }

  async addTrack(input: NewTrack, options?: AddTrackOptions): Promise<number> {
    const title = input.title.trim()
    const artist = input.artist.trim()
    if (!title) throw new Error('A track needs a title.')
    if (!artist) throw new Error('A track needs an artist.')
    const sources = input.sources.slice(0, MAX_SOURCES)
    // A Main or a video clip, either one: they stand in for each other in
    // playback. A live take on its own is not enough, because neither of the
    // app's two views would play it. Resolved here exactly the way
    // `attachSources` will resolve them, so an omitted role counts as a Main.
    const roles: SourceRole[] = []
    for (const source of sources) roles.push(resolveRole(source.role, roles))
    // An import may store the row anyway: it is copying a library that already
    // holds tracks with no working link (see `AddTrackOptions`), not adding one.
    if (!options?.allowUnplayable && !hasPlayableSource(roles.map((role) => ({ role })))) {
      throw new Error('A track needs a Main link or a video clip.')
    }

    // The same recording added twice attaches its links to the row that already
    // exists. MusicBrainz is the authority when we have it; otherwise the
    // artist/title pair is enough to catch a double add.
    const existingId = await this.findExisting(
      input.musicbrainzRecordingId,
      title,
      artist,
    )
    if (existingId !== null) {
      await this.attachSources(existingId, input.sources)
      await this.mergeGenres(existingId, input.genres)
      // Fill blanks from the incoming copy. An import or a re-add that carries
      // more detail improves the record; one that carries less can never
      // degrade it, because nothing already set is touched.
      await this.fillBlanks(existingId, input)
      return existingId
    }

    await this.driver.execute(
      `INSERT INTO tracks
         (title, artist, album, cover_url, year, musicbrainz_recording_id, info, lyrics, lyrics_source, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        artist,
        input.album?.trim() || null,
        input.coverUrl || null,
        input.year ?? null,
        input.musicbrainzRecordingId ?? null,
        input.info?.trim() || null,
        input.lyrics?.trim() || null,
        input.lyricsSource?.trim() || null,
        normaliseDuration(input.duration),
      ],
    )
    const rows = await this.driver.select<{ id: number }>(
      'SELECT last_insert_rowid() AS id',
    )
    const trackId = rows[0].id

    await this.attachSources(trackId, input.sources)
    await this.mergeGenres(trackId, input.genres)
    return trackId
  }

  /**
   * The id of a track this add should merge onto, or null to create a new one.
   *
   * MusicBrainz first, because it is the only strong identity we have; the
   * title/artist fallback is deliberately loose, matching case and surrounding
   * space only, so two genuinely different songs are never merged by accident.
   *
   * A candidate that already claims a *different* MusicBrainz recording is
   * skipped by that fallback: two songs can share a title and an artist — a
   * single and a live version, or a re-recording — and each has its own
   * canonical id. Merging them would silently discard one of the two.
   */
  private async findExisting(
    mbid: string | null | undefined,
    title: string,
    artist: string,
  ): Promise<number | null> {
    if (mbid) {
      const byMb = await this.findByMusicBrainzId(mbid)
      if (byMb !== null) return byMb
    }
    const rows = await this.driver.select<{
      id: number
      musicbrainz_recording_id: string | null
    }>(
      `SELECT id, musicbrainz_recording_id FROM tracks
        WHERE title = ? COLLATE NOCASE AND artist = ? COLLATE NOCASE
        LIMIT 1`,
      [title.trim(), artist.trim()],
    )
    if (!rows.length) return null
    const existingMbid = rows[0].musicbrainz_recording_id ?? null
    if (mbid && existingMbid && existingMbid !== mbid) return null
    return Number(rows[0].id)
  }

  /**
   * Writes sources into the three fixed slots (audio, video, live).
   *
   * Slot assignment goes through `resolveRole`, so a caller that omits the role
   * still fills audio first, video second and live third, and a fourth link is
   * dropped rather than silently displacing one of the slots the app actually
   * has controls for.
   */
  private async attachSources(
    trackId: number,
    sources: NewTrack['sources'],
  ): Promise<void> {
    const existing = await this.sourcesForTrack(trackId)
    const taken: SourceRole[] = existing.map((s) => s.role)
    const free = new Map<SourceRole, Source | null>([
      ['audio', existing.find((s) => s.role === 'audio') ?? null],
      ['video', existing.find((s) => s.role === 'video') ?? null],
      ['live', existing.find((s) => s.role === 'live') ?? null],
    ])

    for (const source of sources) {
      if (taken.length >= MAX_SOURCES) break
      if (source.role && taken.includes(source.role)) continue
      const role = resolveRole(source.role, taken)
      // Nothing free in that slot: the hard cap on MAX_SOURCES.
      if (role === null) break
      // The same video twice on one track is a double add, not a second source.
      if (
        [...free.values()].some(
          (s) => s && s.youtubeId === source.youtubeId,
        )
      ) {
        continue
      }
      taken.push(role)
      free.set(role, {
        id: 0,
        trackId,
        youtubeId: source.youtubeId,
        url: source.url,
        kind: source.kind as SourceKind,
        label: source.label ?? null,
        role,
        position: SOURCE_ORDER.indexOf(role),
      })
    }

    for (const role of SOURCE_ORDER) {
      const source = free.get(role) ?? null
      if (source === null) continue
      // Only the sources just resolved are new; `id === 0` is the marker for
      // "not in the database yet". Re-inserting the slots the track already had
      // would duplicate them, which is exactly what a merge must not do.
      if (source.id !== 0) continue
      await this.driver.execute(
        `INSERT INTO sources (track_id, youtube_id, url, kind, label, role, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          trackId,
          source.youtubeId,
          source.url,
          source.kind,
          source.label,
          source.role,
          source.position,
        ],
      )
    }
  }

  /**
   * Fills a track's blank fields from an incoming copy, never overwriting one.
   *
   * This is what makes a re-import non-destructive in both directions: a fuller
   * record is enriched by the incoming one and a *less* complete import changes
   * nothing. The MusicBrainz id is the one field with a uniqueness rule, so the
   * incoming value is only adopted when no other track already claims it.
   */
  private async fillBlanks(trackId: number, input: NewTrack): Promise<void> {
    const rows = await this.driver.select<Record<string, unknown>>(
      'SELECT * FROM tracks WHERE id = ?',
      [trackId],
    )
    const row = rows[0]
    if (!row) return
    const sets: string[] = []
    const params: unknown[] = []
    const blank = (value: unknown) => value === null || value === undefined || value === ''

    if (blank(row.album) && input.album?.trim()) {
      sets.push('album = ?')
      params.push(input.album.trim())
    }
    if (blank(row.cover_url) && input.coverUrl) {
      sets.push('cover_url = ?')
      params.push(input.coverUrl)
    }
    if (blank(row.year) && input.year) {
      sets.push('year = ?')
      params.push(input.year)
    }
    if (blank(row.info) && input.info?.trim()) {
      sets.push('info = ?')
      params.push(input.info.trim())
    }
    if (blank(row.lyrics) && input.lyrics?.trim()) {
      sets.push('lyrics = ?')
      params.push(input.lyrics.trim())
      sets.push('lyrics_source = ?')
      params.push(input.lyricsSource?.trim() || null)
    }
    const duration = normaliseDuration(input.duration)
    if (rowDuration(row.duration) === null && duration !== null) {
      sets.push('duration = ?')
      params.push(duration)
    }
    if (
      blank(row.musicbrainz_recording_id) &&
      input.musicbrainzRecordingId &&
      (await this.findByMusicBrainzId(input.musicbrainzRecordingId)) === null
    ) {
      sets.push('musicbrainz_recording_id = ?')
      params.push(input.musicbrainzRecordingId)
    }
    if (!sets.length) return
    await this.driver.execute(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`, [
      ...params,
      trackId,
    ])
  }

  /**
   * Adds genres to a track without removing what is already there.
   *
   * The genres table is a shared vocabulary keyed case-insensitively, so the
   * same genre typed two ways must not create two rows and then make the facet
   * counts disagree with what the list shows.
   */
  private async mergeGenres(trackId: number, genres: string[]): Promise<void> {
    for (const raw of genres) {
      const name = raw.trim()
      if (!name) continue
      await this.driver.execute(
        'INSERT OR IGNORE INTO genres (name) VALUES (?)',
        [name],
      )
      const rows = await this.driver.select<{ id: number }>(
        'SELECT id FROM genres WHERE name = ? COLLATE NOCASE',
        [name],
      )
      if (!rows.length) continue
      await this.driver.execute(
        'INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)',
        [trackId, Number(rows[0].id)],
      )
    }
  }

  async findByMusicBrainzId(mbid: string | null): Promise<number | null> {
    if (!mbid) return null
    const rows = await this.driver.select<{ id: number }>(
      'SELECT id FROM tracks WHERE musicbrainz_recording_id = ?',
      [mbid],
    )
    return rows.length ? Number(rows[0].id) : null
  }

  async getTrack(id: number): Promise<TrackWithSources | null> {
    const rows = await this.driver.select<Record<string, unknown>>(
      'SELECT * FROM tracks WHERE id = ?',
      [id],
    )
    if (!rows.length) return null
    return this.hydrate(rows[0])
  }

  /** Resolves one raw `tracks` row into the shape the UI consumes. */
  /**
   * Builds the app's view of a track from its row and its two side tables.
   *
   * Kept separate from the querying so the mapping is one place: the same code
   * serves a whole list and a single look-up.
   */
  private toTrack(
    row: Record<string, unknown>,
    genres: string[],
    sources: Source[],
  ): TrackWithSources {
    return {
      id: Number(row.id),
      title: String(row.title),
      artist: String(row.artist),
      album: row.album === null ? null : String(row.album),
      coverUrl: row.cover_url === null ? null : String(row.cover_url),
      year: row.year === null ? null : Number(row.year),
      musicbrainzRecordingId:
        row.musicbrainz_recording_id === null
          ? null
          : String(row.musicbrainz_recording_id),
      info: row.info === null ? null : String(row.info),
      lyrics:
        row.lyrics === null || row.lyrics === undefined
          ? null
          : String(row.lyrics),
      lyricsSource: row.lyrics_source ? String(row.lyrics_source) : null,
      duration: rowDuration(row.duration),
      createdAt: String(row.created_at),
      genres,
      sources,
    }
  }

  /**
   * Hydrates a whole list of rows with two queries per batch of ids.
   *
   * Genres and sources live in their own tables, and asking per track turned
   * one library read into two queries per row — over three thousand statements
   * for a library of 1,700 tracks. Batching by id keeps the result identical
   * (rows in the order asked for, genres and sources in their stored order)
   * while the statement count falls to single figures.
   */
  private async hydrateMany(
    rows: Record<string, unknown>[],
  ): Promise<TrackWithSources[]> {
    if (!rows.length) return []
    const genres = new Map<number, string[]>()
    const sources = new Map<number, Source[]>()

    for (const chunk of inChunks(rows.map((row) => Number(row.id)))) {
      const marks = chunk.map(() => '?').join(', ')
      const genreRows = await this.driver.select<{
        track_id: number
        name: string
      }>(
        `SELECT tg.track_id AS track_id, g.name AS name
           FROM genres g
           JOIN track_genres tg ON tg.genre_id = g.id
          WHERE tg.track_id IN (${marks})
          ORDER BY g.name COLLATE NOCASE ASC`,
        chunk,
      )
      for (const row of genreRows) {
        const trackId = Number(row.track_id)
        const list = genres.get(trackId)
        if (list) list.push(String(row.name))
        else genres.set(trackId, [String(row.name)])
      }

      const sourceRows = await this.driver.select<Record<string, unknown>>(
        `SELECT * FROM sources
          WHERE track_id IN (${marks})
          ORDER BY position ASC, id ASC`,
        chunk,
      )
      for (const row of sourceRows) {
        const trackId = Number(row.track_id)
        const list = sources.get(trackId)
        if (list) list.push(sourceFromRow(row))
        else sources.set(trackId, [sourceFromRow(row)])
      }
    }

    return rows.map((row) =>
      this.toTrack(
        row,
        genres.get(Number(row.id)) ?? [],
        sources.get(Number(row.id)) ?? [],
      ),
    )
  }

  private async hydrate(row: Record<string, unknown>): Promise<TrackWithSources> {
    const [track] = await this.hydrateMany([row])
    return track
  }

  private async sourcesForTrack(trackId: number): Promise<Source[]> {
    const rows = await this.driver.select<Record<string, unknown>>(
      'SELECT * FROM sources WHERE track_id = ? ORDER BY position ASC, id ASC',
      [trackId],
    )
    return rows.map(sourceFromRow)
  }

  async updateTrack(id: number, patch: TrackPatch): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.title !== undefined) {
      sets.push('title = ?')
      params.push(patch.title.trim())
    }
    if (patch.artist !== undefined) {
      sets.push('artist = ?')
      params.push(patch.artist.trim())
    }
    if (patch.album !== undefined) {
      sets.push('album = ?')
      params.push(patch.album?.trim() || null)
    }
    if (patch.coverUrl !== undefined) {
      sets.push('cover_url = ?')
      params.push(patch.coverUrl || null)
    }
    if (patch.year !== undefined) {
      sets.push('year = ?')
      params.push(patch.year ?? null)
    }
    if (patch.info !== undefined) {
      sets.push('info = ?')
      params.push(patch.info?.trim() || null)
    }
    if (patch.lyrics !== undefined) {
      sets.push('lyrics = ?')
      params.push(patch.lyrics?.trim() || null)
    }
    if (patch.lyricsSource !== undefined) {
      sets.push('lyrics_source = ?')
      params.push(patch.lyricsSource?.trim() || null)
    }
    // Genres are replaced rather than merged: an edit is the one moment the
    // user is stating the full intended set, so a genre they removed has to
    // actually go.
    if (patch.genres !== undefined) {
      await this.driver.execute('DELETE FROM track_genres WHERE track_id = ?', [id])
      await this.mergeGenres(id, patch.genres)
    }
    if (!sets.length) return
    await this.driver.execute(
      `UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`,
      [...params, id],
    )
  }

  /**
   * Writes a measured running time, in seconds.
   *
   * Separate from `updateTrack` on purpose. This is written by the metadata
   * lookup and by the player correcting a guess, never by a text field, and it
   * fires on its own while a track plays — so it has to be cheap and safe to
   * call repeatedly. It does nothing when the value already matches, which keeps
   * a playing track from rewriting its row on every time update.
   */
  async setDuration(trackId: number, seconds: number | null): Promise<void> {
    const duration = normaliseDuration(seconds)
    if (duration === null) return
    const rows = await this.driver.select<{ duration: number | null }>(
      'SELECT duration FROM tracks WHERE id = ?',
      [trackId],
    )
    if (rows.length && rowDuration(rows[0].duration) === duration) return
    await this.driver.execute('UPDATE tracks SET duration = ? WHERE id = ?', [
      duration,
      trackId,
    ])
  }

  /**
   * Links (or clears) the MusicBrainz recording used for deduplication.
   *
   * The owner is checked before the write rather than left to the unique index,
   * so the caller gets an error naming the conflict instead of a silent no-op —
   * and so a track's existing link is provably untouched when the write fails.
   */
  async setMusicBrainzId(
    trackId: number,
    mbid: string | null,
  ): Promise<void> {
    if (!mbid) {
      await this.driver.execute(
        'UPDATE tracks SET musicbrainz_recording_id = NULL WHERE id = ?',
        [trackId],
      )
      return
    }
    const owner = await this.findByMusicBrainzId(mbid)
    if (owner !== null && owner !== trackId) {
      throw new Error('Another track already uses that MusicBrainz recording.')
    }
    await this.driver.execute(
      'UPDATE tracks SET musicbrainz_recording_id = ? WHERE id = ?',
      [mbid, trackId],
    )
  }

  async deleteTrack(id: number): Promise<void> {
    await this.driver.execute('DELETE FROM tracks WHERE id = ?', [id])
    // track_genres cascades, but the shared genres vocabulary does not, so the
    // rows the deleted track was the last user of are now dead weight.
    await this.driver.execute(
      'DELETE FROM genres WHERE NOT EXISTS (SELECT 1 FROM track_genres WHERE genre_id = genres.id)',
    )
  }

  /**
   * Fills or replaces a source slot; only the optional slots may be emptied.
   *
   * Emptying the audio slot is refused rather than allowed to leave a track
   * with nothing to stream — that state is unrecoverable from the UI, because
   * the only control that can add a link back lives on a track row that would
   * no longer be playing.
   */
  async setSource(
    trackId: number,
    role: SourceRole,
    source: { youtubeId: string; url: string; kind: string; label?: string | null } | null,
  ): Promise<void> {
    const rows = await this.driver.select<{ id: number }>(
      'SELECT id FROM sources WHERE track_id = ? AND role = ?',
      [trackId, role],
    )
    const existing = rows.length ? Number(rows[0].id) : null

    if (source === null) {
      // Either half of the pair may be emptied; only emptying the last of them
      // would leave nothing to stream. Main and the clip stand in for each
      // other in playback, so a track with only a clip is as playable as a
      // track with only a Main.
      if (role === 'audio' || role === 'video') {
        const left = await this.driver.select<{ role: string }>(
          'SELECT role FROM sources WHERE track_id = ? AND role <> ?',
          [trackId, role],
        )
        const stillPlayable = left.some(
          (s) => s.role === 'audio' || s.role === 'video',
        )
        if (!stillPlayable) {
          throw new Error(
            'A track needs a Main link or a video clip. Delete the whole track instead.',
          )
        }
      }
      if (existing !== null) {
        await this.driver.execute('DELETE FROM sources WHERE id = ?', [existing])
      }
      return
    }

    // One video cannot fill both slots. Letting it would leave the track with
    // two rows playing the same audio, and the player would offer the "play the
    // video" button as a way of hearing the track it is already playing.
    const clash = await this.driver.select<{ id: number }>(
      `SELECT id FROM sources
        WHERE track_id = ? AND youtube_id = ? AND id IS NOT ?`,
      [trackId, source.youtubeId, existing],
    )
    if (clash.length) {
      throw new Error('That video is already attached to this track.')
    }

    const position = SOURCE_ORDER.indexOf(role)
    if (existing === null) {
      await this.driver.execute(
        `INSERT INTO sources (track_id, youtube_id, url, kind, label, role, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          trackId,
          source.youtubeId,
          source.url,
          source.kind,
          source.label ?? null,
          role,
          position,
        ],
      )
      return
    }
    await this.driver.execute(
      `UPDATE sources
          SET youtube_id = ?, url = ?, kind = ?, label = ?, position = ?
        WHERE id = ?`,
      [
        source.youtubeId,
        source.url,
        source.kind,
        source.label ?? null,
        position,
        existing,
      ],
    )
  }

  /**
   * Cuts one source slot outright — the audio slot included.
   *
   * Deliberately not `setSource(trackId, role, null)`: that refuses to empty the
   * Main slot, because the editor must never leave a track unplayable by
   * accident. A link-health run is the opposite case — YouTube has said the link
   * will not play here, so keeping it only leaves a track that fails when
   * pressed — and its caller needs a way to cut the dead slot. A track that
   * loses its Main and has no clip is the caller's signal to file it under
   * Issues.
   */
  async removeSource(trackId: number, role: SourceRole): Promise<void> {
    await this.driver.execute(
      'DELETE FROM sources WHERE track_id = ? AND role = ?',
      [trackId, role],
    )
  }

  async listTracks(filter: LibraryFilter): Promise<TrackWithSources[]> {
    const where: string[] = []
    const params: unknown[] = []

    if (filter.search) {
      // One LIKE across the three fields people actually search by, rather than
      // three separate constraints a track has to satisfy all of.
      where.push(
        `(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)`,
      )
      const like = `%${filter.search}%`
      params.push(like, like, like)
    }
    if (filter.artist) {
      where.push('t.artist = ? COLLATE NOCASE')
      params.push(filter.artist)
    }
    if (filter.album) {
      where.push('t.album = ? COLLATE NOCASE')
      params.push(filter.album)
    }
    if (filter.genres.length) {
      // Additive, not exclusive: a track matches if it carries *any* selected
      // genre, so ticking two genres widens the list. One EXISTS with an IN over
      // the set, rather than one EXISTS per genre AND-ed together.
      const placeholders = filter.genres.map(() => '?').join(', ')
      where.push(
        `EXISTS (
           SELECT 1 FROM track_genres tg4
             JOIN genres g4 ON g4.id = tg4.genre_id
            WHERE tg4.track_id = t.id AND g4.name COLLATE NOCASE IN (${placeholders})
         )`,
      )
      params.push(...filter.genres)
    }
    if (filter.sourceKind) {
      where.push(
        `EXISTS (
           SELECT 1 FROM sources s3
            WHERE s3.track_id = t.id AND s3.kind = ?
         )`,
      )
      params.push(filter.sourceKind)
    }
    if (filter.unfiledOnly) {
      // The old "Not in a playlist" tree node as a filter, so it combines
      // with search and genres instead of replacing them.
      where.push(
        `NOT EXISTS (
           SELECT 1 FROM playlist_tracks pt5 WHERE pt5.track_id = t.id
         )`,
      )
    }
    if (filter.hasLiveSource) {
      where.push(
        `EXISTS (
           SELECT 1 FROM sources s6
            WHERE s6.track_id = t.id AND s6.role = 'live'
         )`,
      )
    }

    const rows = await this.driver.select<Record<string, unknown>>(
      `SELECT t.* FROM tracks t
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.artist COLLATE NOCASE ASC, t.album COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC`,
      params,
    )

    return this.hydrateMany(rows)
  }

  // ------------------------------------------------------------- playlists

  async createPlaylist(
    name: string,
    description?: string,
    folderId?: number | null,
  ): Promise<number> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Playlist name is required.')
    await this.driver.execute(
      'INSERT INTO playlists (name, description, folder_id) VALUES (?, ?, ?)',
      [trimmed, description?.trim() || null, folderId ?? null],
    )
    const rows = await this.driver.select<{ id: number }>(
      'SELECT last_insert_rowid() AS id',
    )
    return Number(rows[0].id)
  }

  /** Playlist names are not unique, so this matches the caller's intent rather
      than the type system's: a trimmed, case-insensitive first match. */
  async ensurePlaylist(name: string, description?: string | null): Promise<number> {
    const trimmed = name.trim()
    const rows = await this.driver.select<{ id: number }>(
      'SELECT id FROM playlists WHERE name = ? COLLATE NOCASE ORDER BY id ASC LIMIT 1',
      [trimmed],
    )
    if (rows.length) return Number(rows[0].id)
    return this.createPlaylist(trimmed, description ?? undefined)
  }

  async listPlaylists(): Promise<Playlist[]> {
    const rows = await this.driver.select<Record<string, unknown>>(
      `SELECT p.*, COUNT(pt.track_id) AS track_count
         FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
        GROUP BY p.id
        ORDER BY p.name COLLATE NOCASE ASC`,
    )
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      description: row.description === null ? null : String(row.description),
      createdAt: String(row.created_at),
      trackCount: Number(row.track_count),
      folderId:
        row.folder_id === null || row.folder_id === undefined
          ? null
          : Number(row.folder_id),
    }))
  }

  async deletePlaylist(id: number): Promise<void> {
    await this.driver.execute('DELETE FROM playlists WHERE id = ?', [id])
  }

  /**
   * Renames a playlist in place.
   *
   * Same contract as `renameFolder` beside it: a blank name is refused rather
   * than silently stored, and an id that is not there is a no-op.
   */
  async renamePlaylist(id: number, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Playlist name is required.')
    await this.driver.execute('UPDATE playlists SET name = ? WHERE id = ?', [
      trimmed,
      id,
    ])
  }

  /**
   * Writes a playlist's own notes, or clears them with an empty value.
   *
   * An empty description is a legitimate value — it is how Clear works — so it
   * is stored as NULL rather than refused.
   */
  async setPlaylistDescription(
    playlistId: number,
    description: string | null,
  ): Promise<void> {
    await this.driver.execute('UPDATE playlists SET description = ? WHERE id = ?', [
      description?.trim() || null,
      playlistId,
    ])
  }

  // ------------------------------------------------------- playlist folders

  async listFolders(): Promise<PlaylistFolder[]> {
    const rows = await this.driver.select<Record<string, unknown>>(
      `SELECT * FROM playlist_folders ORDER BY name COLLATE NOCASE ASC`,
    )
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      parentId:
        row.parent_id === null || row.parent_id === undefined
          ? null
          : Number(row.parent_id),
      createdAt: String(row.created_at),
    }))
  }

  async createFolder(name: string, parentId?: number | null): Promise<number> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Folder name is required.')
    await this.driver.execute(
      'INSERT INTO playlist_folders (name, parent_id) VALUES (?, ?)',
      [trimmed, parentId ?? null],
    )
    const rows = await this.driver.select<{ id: number }>(
      'SELECT last_insert_rowid() AS id',
    )
    return Number(rows[0].id)
  }

  async renameFolder(id: number, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Folder name is required.')
    await this.driver.execute('UPDATE playlist_folders SET name = ? WHERE id = ?', [
      trimmed,
      id,
    ])
  }

  /**
   * Deletes a folder and everything under it.
   *
   * Playlists inside are *kept* and lifted to the top level rather than deleted
   * with the folder: a folder is an organising decision, and a playlist can hold
   * hand-built ordering that no folder deletion should silently destroy.
   */
  async deleteFolder(id: number): Promise<void> {
    const folders = await this.listFolders()
    const doomed: number[] = [id]
    let grew = true
    while (grew) {
      grew = false
      for (const folder of folders) {
        if (folder.parentId !== null && doomed.includes(folder.parentId) && !doomed.includes(folder.id)) {
          doomed.push(folder.id)
          grew = true
        }
      }
    }
    const placeholders = doomed.map(() => '?').join(', ')
    await this.driver.execute(
      `UPDATE playlists SET folder_id = NULL WHERE folder_id IN (${placeholders})`,
      doomed,
    )
    await this.driver.execute(
      `DELETE FROM playlist_folders WHERE id IN (${placeholders})`,
      doomed,
    )
  }

  async setPlaylistFolder(
    playlistId: number,
    folderId: number | null,
  ): Promise<void> {
    await this.driver.execute(
      'UPDATE playlists SET folder_id = ? WHERE id = ?',
      [folderId, playlistId],
    )
  }

  /**
   * Re-parents a folder, or lifts it to the top level when `parentId` is null.
   *
   * Refuses a move that would put a folder inside itself or inside one of its
   * own descendants. That would detach the whole subtree from the root — the
   * folders would still be in the table and no longer be reachable — so the
   * check runs *before* the write and a forgotten drag changes nothing.
   */
  async setFolderParent(id: number, parentId: number | null): Promise<void> {
    if (parentId === id) throw new Error('A folder cannot contain itself.')
    if (parentId !== null) {
      const folders = await this.listFolders()
      if (!folders.some((f) => f.id === parentId)) {
        throw new Error('Folder not found.')
      }
      const byId = new Map(folders.map((f) => [f.id, f]))
      let cursor: number | null = parentId
      while (cursor !== null) {
        if (cursor === id) {
          throw new Error('A folder cannot be moved inside itself.')
        }
        cursor = byId.get(cursor)?.parentId ?? null
      }
    }
    await this.driver.execute(
      'UPDATE playlist_folders SET parent_id = ? WHERE id = ?',
      [parentId, id],
    )
  }

  /** Every playlist a track belongs to, for the track card. */
  async listPlaylistsForTrack(trackId: number): Promise<Playlist[]> {
    const rows = await this.driver.select<Record<string, unknown>>(
      `SELECT p.*,
              (SELECT COUNT(*) FROM playlist_tracks pt2 WHERE pt2.playlist_id = p.id) AS track_count
         FROM playlists p
         JOIN playlist_tracks pt ON pt.playlist_id = p.id
        WHERE pt.track_id = ?
        ORDER BY p.name COLLATE NOCASE ASC`,
      [trackId],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      description: row.description === null ? null : String(row.description),
      createdAt: String(row.created_at),
      trackCount: Number(row.track_count),
      folderId:
        row.folder_id === null || row.folder_id === undefined
          ? null
          : Number(row.folder_id),
    }))
  }

  /**
   * The latest additions, newest first, capped — the stable set the Recently
   * added view narrows within, so filtering never swaps the tracks out from
   * under the reader. `id` breaks `created_at` ties, which are the rule
   * rather than the exception when a batch lands several tracks in one
   * second.
   */
  async listRecentTracks(limit: number): Promise<TrackWithSources[]> {
    const rows = await this.driver.select<Record<string, unknown>>(
      `SELECT t.* FROM tracks t
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ?`,
      [Math.max(0, Math.trunc(limit))],
    )
    return this.hydrateMany(rows)
  }

  /** Every track id filed in at least one playlist, for client-side filters. */
  async listFiledTrackIds(): Promise<number[]> {
    const rows = await this.driver.select<{ track_id: number }>(
      'SELECT DISTINCT track_id FROM playlist_tracks',
    )
    return rows.map((r) => Number(r.track_id))
  }

  /**
   * Records a track that played to its end.
   *
   * Telemetry, never a user-facing write: the caller reports it and moves on,
   * and the table is pruned to the shared cap on every insert so a library
   * left playing overnight cannot grow it without bound.
   */
  async recordPlay(trackId: number, playedAt = new Date().toISOString()): Promise<void> {
    await this.driver.execute(
      'INSERT INTO track_plays (track_id, played_at) VALUES (?, ?)',
      [trackId, playedAt],
    )
    await this.prunePlays()
  }

  /**
   * Records imported listens, skipping ones already held.
   *
   * The guard is what makes re-importing a backup a no-op for history exactly
   * as it is for tracks: the same file twice adds nothing twice.
   */
  async recordPlays(events: PlayEvent[]): Promise<void> {
    for (const event of events) {
      await this.driver.execute(
        `INSERT INTO track_plays (track_id, played_at)
         SELECT ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM track_plays WHERE track_id = ? AND played_at = ?
          )`,
        [event.trackId, event.playedAt, event.trackId, event.playedAt],
      )
    }
    await this.prunePlays()
  }

  private async prunePlays(): Promise<void> {
    await this.driver.execute(
      `DELETE FROM track_plays
        WHERE id NOT IN (SELECT id FROM track_plays ORDER BY id DESC LIMIT ?)`,
      [MAX_PLAY_EVENTS],
    )
  }

  /**
   * Completed listens, newest first — what the DJ learns taste from.
   *
   * Ordered by the listen time, not the row id: an imported backup inserts old
   * listens after newer live ones, and they still have to read back in the
   * order they happened.
   */
  async listRecentPlays(limit: number): Promise<PlayEvent[]> {
    const rows = await this.driver.select<{ trackId: number; playedAt: string }>(
      `SELECT track_id AS trackId, played_at AS playedAt FROM track_plays
       ORDER BY played_at DESC, id DESC
       LIMIT ?`,
      [Math.max(0, Math.trunc(limit))],
    )
    return rows.map((row) => ({
      trackId: Number(row.trackId),
      playedAt: String(row.playedAt),
    }))
  }

  async addToPlaylist(playlistId: number, trackId: number): Promise<void> {
    const rows = await this.driver.select<{ position: number }>(
      'SELECT COALESCE(MAX(position), -1) AS position FROM playlist_tracks WHERE playlist_id = ?',
      [playlistId],
    )
    const next = Number(rows[0]?.position ?? -1) + 1
    await this.driver.execute(
      'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)',
      [playlistId, trackId, next],
    )
  }

  async removeFromPlaylist(playlistId: number, trackId: number): Promise<void> {
    await this.driver.execute(
      'DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?',
      [playlistId, trackId],
    )
  }

  /**
   * Re-orders one track inside one playlist.
   *
   * A playlist's own order is what the rows show, so this is the single write
   * behind dragging a row: the track leaves the sequence and goes back in at
   * `toIndex`, and everything it crossed shifts by one. An index past either
   * end is clamped rather than refused — the caller is a pointer, and a row
   * dropped below the last one means "last".
   *
   * Positions are rewritten for the whole playlist rather than just for the
   * moved row, because they only mean anything as a sequence: patching one row
   * would leave two rows claiming the same index.
   *
   * A track that is not in this playlist — including one in a playlist that
   * does not exist — is a quiet no-op, not an error: a drag can race a removal,
   * and refusing it would only produce an error the user can do nothing about.
   */
  async movePlaylistTrack(
    playlistId: number,
    trackId: number,
    toIndex: number,
  ): Promise<void> {
    const rows = await this.driver.select<{ track_id: number }>(
      `SELECT track_id FROM playlist_tracks
        WHERE playlist_id = ?
        ORDER BY position ASC, track_id ASC`,
      [playlistId],
    )
    const order = rows.map((row) => Number(row.track_id))
    const from = order.indexOf(trackId)
    if (from === -1) return

    order.splice(from, 1)
    const target = clampIndex(toIndex, order.length)
    order.splice(target, 0, trackId)

    for (let index = 0; index < order.length; index++) {
      await this.driver.execute(
        'UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?',
        [index, playlistId, order[index]],
      )
    }
  }

  async listPlaylistTracks(playlistId: number): Promise<PlaylistEntry[]> {
    const rows = await this.driver.select<Record<string, unknown>>(
      `SELECT t.*, pt.position AS entry_position
         FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position ASC, pt.track_id ASC`,
      [playlistId],
    )
    const hydrated = await this.hydrateMany(rows)
    return hydrated.map((track, index) => ({
      playlistId,
      trackId: track.id,
      position: Number(rows[index].entry_position),
      track,
    }))
  }

  // ------------------------------------------------------------ import/export

  /**
   * Writes the library as the same document `data/library.json` holds.
   *
   * One format for both stores, on purpose: the file is the app's public
   * contract, and a backup has to be readable across browser storage modes and
   * by a person. Ids are local to the file and are remapped on
   * import, which is why a playlist can reference its tracks by number.
   */
  async exportJson(): Promise<string> {
    const tracks = await this.listTracks(EMPTY_FILTER)
    const folders = await this.listFolders()
    const playlists = await this.listPlaylists()

    const payload = {
      format: 'trackvault-library',
      version: 1,
      exportedAt: new Date().toISOString(),
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        coverUrl: t.coverUrl,
        year: t.year,
        musicbrainzRecordingId: t.musicbrainzRecordingId,
        info: t.info,
        lyrics: t.lyrics,
        lyricsSource: t.lyricsSource,
        duration: t.duration,
        createdAt: t.createdAt,
        genres: t.genres,
        sources: t.sources.map((s) => ({
          id: s.id,
          youtubeId: s.youtubeId,
          url: s.url,
          kind: s.kind,
          label: s.label,
          role: s.role,
        })),
      })),
      folders,
      playlists: await Promise.all(
        playlists.map(async (playlist) => ({
          id: playlist.id,
          name: playlist.name,
          description: playlist.description,
          createdAt: playlist.createdAt,
          tracks: (await this.listPlaylistTracks(playlist.id)).map((e) => e.trackId),
          folderId: playlist.folderId,
        })),
      ),
      // History travels with the backup: a restore onto new ids keeps its
      // taste, remapped on import like playlist entries are.
      plays: await this.listRecentPlays(MAX_PLAY_EVENTS),
    }
    return JSON.stringify(payload, null, 2)
  }

  /**
   * Merges an exported library into this one, through the shared importer.
   *
   * The rules — never duplicate, never overwrite, never lose a playlist
   * reference — live in `libraryImport.ts`, so the SQLite store and the JSON
   * store behave identically and a file moves between them intact.
   */
  async importJson(json: string): Promise<ImportResult> {
    return applyImport(json, this)
  }

  /**
   * Runs a bulk write as one unit — the `ImportSink` half of the contract.
   *
   * The JSON store needs this to write once per import instead of once per
   * track. This store does not: sql.js already coalesces its snapshots onto a
   * microtask, so a batch of inserts costs one IndexedDB write either way. It
   * is still implemented here so a caller (or an import test) can ask either
   * store for the same thing and get the same answer.
   */
  async transact<T>(run: () => Promise<T>): Promise<T> {
    return run()
  }

  /**
   * Replaces the whole library with the file: every track, playlist, folder
   * and listen is deleted first, then the file is imported into the empty
   * store, so the library mirrors it exactly. Children before parents,
   * because foreign keys are on for this connection. The sibling of
   * `importJson`, which merges instead — kept because merging is the safe
   * default and replacing is the deliberate mirror.
   */
  async replaceJson(json: string): Promise<ImportResult> {
    assertReplaceableDocument(json)
    await this.driver.execute('DELETE FROM track_plays')
    await this.driver.execute('DELETE FROM playlist_tracks')
    await this.driver.execute('DELETE FROM sources')
    await this.driver.execute('DELETE FROM track_genres')
    await this.driver.execute('DELETE FROM genres')
    await this.driver.execute('DELETE FROM playlists')
    await this.driver.execute('DELETE FROM playlist_folders')
    await this.driver.execute('DELETE FROM tracks')
    return applyImport(json, this)
  }
}

/** Reads a duration column back out of a row, tolerating pre-migration rows. */
function rowDuration(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return normaliseDuration(Number(value))
}

/** Fixed slot order, so a track always writes audio before video. */
const SOURCE_ORDER: SourceRole[] = ['audio', 'video', 'live']

/** Reads a source row, tolerating rows written before the role column existed. */
function sourceFromRow(row: Record<string, unknown>): Source {
  return {
    id: Number(row.id),
    trackId: Number(row.track_id),
    youtubeId: String(row.youtube_id),
    url: String(row.url),
    kind: String(row.kind) as SourceKind,
    label: row.label === null ? null : String(row.label),
    role: (row.role as SourceRole | undefined) ?? 'audio',
    position: Number(row.position),
  }
}

/**
 * Splits a list of ids into batches small enough for one bound-parameter list.
 *
 * SQLite has a cap on how many parameters a statement may bind, and a library
 * is not bounded by it, so a list read goes in batches rather than in one
 * statement that would fail on a big library.
 */
function inChunks<T>(items: T[], size = 400): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
