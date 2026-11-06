import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Library } from '../lib/db'
import { fetchAgentStatus } from '../lib/agentClient'
import { reportSignature, type MergeReport } from '../lib/agentInbox'
import { EMPTY_FILTER } from '../lib/types'
import { findIssuesPlaylist, ISSUES_PLAYLIST } from '../lib/linkHealth'
import { plural } from '../lib/format'
import type {
  LibraryFilter,
  PlayEvent,
  Playlist,
  PlaylistFolder,
  SourceRole,
  TrackWithSources,
} from '../lib/types'

export interface Facets {
  genres: Array<{ name: string; count: number }>
  artists: string[]
  albums: string[]
}

/**
 * What the library tree is pointing at.
 *
 * One rail, not two tabs: `all` is the whole library through the filters, then
 * the folder tree of user playlists. The old `unfiled` virtual folder is gone —
 * it lives on as the `unfiledOnly` filter, which combines with search instead
 * of replacing it.
 */
export type PlaylistSelection =
  | { kind: 'all' }
  | { kind: 'folder'; folderId: number }
  | { kind: 'playlist'; playlistId: number }

/** Every playlist in a folder and its subfolders, at any depth. */
function playlistsInFolder(
  folderId: number,
  folders: PlaylistFolder[],
  playlists: Playlist[],
): Playlist[] {
  const folderIds = new Set<number>([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (
        folder.parentId !== null &&
        folderIds.has(folder.parentId) &&
        !folderIds.has(folder.id)
      ) {
        folderIds.add(folder.id)
        grew = true
      }
    }
  }
  return playlists.filter((p) => p.folderId !== null && folderIds.has(p.folderId))
}

/**
 * The fingerprint of the last merge report this browser was told about.
 *
 * The report lives in `data/last-merge.json` and the server re-serves it on
 * every poll, so it is the *same* report that comes back after a refresh, not a
 * new one. Remembering which one has been seen is what stops a batch merged
 * before the app started from being announced again every time the window is
 * reloaded.
 */
const SEEN_REPORT_KEY = 'trackvault.seenMergeReport'
const SELECTION_KEY = 'trackvault.selection'
const SNAPSHOT_KEY = 'trackvault.librarySnapshot'

export function readStoredSelection(raw: string | null): PlaylistSelection {
  if (!raw) return { kind: 'all' }
  try {
    const parsed = JSON.parse(raw) as Partial<PlaylistSelection>
    if (
      parsed.kind === 'playlist' &&
      typeof parsed.playlistId === 'number' &&
      Number.isFinite(parsed.playlistId)
    ) {
      return { kind: 'playlist', playlistId: parsed.playlistId }
    }
    if (
      parsed.kind === 'folder' &&
      typeof parsed.folderId === 'number' &&
      Number.isFinite(parsed.folderId)
    ) {
      return { kind: 'folder', folderId: parsed.folderId }
    }
  } catch {
    // Fall back to 'all'.
  }
  return { kind: 'all' }
}

/**
 * Resolves the initial playlist/folder selection on launch.
 *
 * Prefers the explicitly viewed playlist/folder (`trackvault.selection`), and
 * if that was left on `'all'`, falls back to the playlist/folder that was
 * actively playing (`trackvault.activeTracklist`) so re-opening the app brings
 * the listener back to what they were playing rather than `'All tracks'`.
 */
export function readInitialSelection(): PlaylistSelection {
  if (typeof window === 'undefined') return { kind: 'all' }
  try {
    const direct = readStoredSelection(window.localStorage.getItem(SELECTION_KEY))
    if (direct.kind !== 'all') return direct
    const rawActive = window.localStorage.getItem('trackvault.activeTracklist')
    if (rawActive) {
      const parsed = JSON.parse(rawActive) as {
        selection?: Partial<PlaylistSelection>
      }
      if (parsed?.selection) {
        const activeSel = readStoredSelection(JSON.stringify(parsed.selection))
        if (activeSel.kind !== 'all') return activeSel
      }
    }
    return direct
  } catch {
    return { kind: 'all' }
  }
}

interface LibrarySnapshotCache {
  tracks: TrackWithSources[]
  totalCount: number
  playlists: Playlist[]
  folders: PlaylistFolder[]
  facets: Facets
  selection: PlaylistSelection
  playlistTracks: TrackWithSources[]
}

function sameSelectionCache(a: PlaylistSelection, b: PlaylistSelection): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'playlist' && b.kind === 'playlist') {
    return a.playlistId === b.playlistId
  }
  if (a.kind === 'folder' && b.kind === 'folder') {
    return a.folderId === b.folderId
  }
  return true
}

function readLibrarySnapshot(): LibrarySnapshotCache | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LibrarySnapshotCache>
    if (
      !Array.isArray(parsed.tracks) ||
      !Array.isArray(parsed.playlists) ||
      !Array.isArray(parsed.folders)
    ) {
      return null
    }
    return {
      tracks: parsed.tracks,
      totalCount:
        typeof parsed.totalCount === 'number'
          ? parsed.totalCount
          : parsed.tracks.length,
      playlists: parsed.playlists,
      folders: parsed.folders,
      facets: parsed.facets ?? { genres: [], artists: [], albums: [] },
      selection: readStoredSelection(JSON.stringify(parsed.selection)),
      playlistTracks: Array.isArray(parsed.playlistTracks)
        ? parsed.playlistTracks
        : [],
    }
  } catch {
    return null
  }
}

function writeLibrarySnapshot(snapshot: LibrarySnapshotCache): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage quota or private mode: ignore.
  }
}

async function fetchSelectionMembership(
  library: Library,
  selection: PlaylistSelection,
  folders: PlaylistFolder[],
  playlists: Playlist[],
): Promise<TrackWithSources[]> {
  if (selection.kind === 'all') return []
  if (selection.kind === 'playlist') {
    const entries = await library.listPlaylistTracks(selection.playlistId)
    return entries.map((e) => e.track)
  }
  const members = playlistsInFolder(selection.folderId, folders, playlists)
  const lists = await Promise.all(
    members.map((p) => library.listPlaylistTracks(p.id)),
  )
  const seen = new Set<number>()
  const out: TrackWithSources[] = []
  for (const entries of lists) {
    for (const entry of entries) {
      if (seen.has(entry.trackId)) continue
      seen.add(entry.trackId)
      out.push(entry.track)
    }
  }
  return out
}

function readSeenReport(): string | null {
  try {
    return window.localStorage.getItem(SEEN_REPORT_KEY)
  } catch {
    // Private mode, or storage refused. The report then shows every launch,
    // which is the old behaviour rather than a broken one.
    return null
  }
}

function rememberSeenReport(signature: string): void {
  try {
    window.localStorage.setItem(SEEN_REPORT_KEY, signature)
  } catch {
    // Nothing to do: the banner is a convenience.
  }
}

export function useLibrary(library: Library | null) {
  const initialCache = useRef<LibrarySnapshotCache | null | undefined>(undefined)
  if (initialCache.current === undefined) {
    initialCache.current = readLibrarySnapshot()
  }
  const cached = initialCache.current
  const [playlistSelection, setPlaylistSelection] = useState<PlaylistSelection>(
    () => readInitialSelection(),
  )
  const selectionRef = useRef<PlaylistSelection>(playlistSelection)
  selectionRef.current = playlistSelection

  const [tracks, setTracks] = useState<TrackWithSources[]>(
    () => cached?.tracks ?? [],
  )
  const [totalCount, setTotalCount] = useState<number>(
    () => cached?.totalCount ?? 0,
  )
  const [playlists, setPlaylists] = useState<Playlist[]>(
    () => cached?.playlists ?? [],
  )
  const [folders, setFolders] = useState<PlaylistFolder[]>(
    () => cached?.folders ?? [],
  )
  const [facets, setFacets] = useState<Facets>(
    () =>
      cached?.facets ?? {
        genres: [],
        artists: [],
        albums: [],
      },
  )
  const [filter, setFilter] = useState<LibraryFilter>(EMPTY_FILTER)
  const filterRef = useRef<LibraryFilter>(filter)
  filterRef.current = filter

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SELECTION_KEY,
        JSON.stringify(playlistSelection),
      )
    } catch {
      // Storage unavailable.
    }
  }, [playlistSelection])
  const [playlistTracks, setPlaylistTracks] = useState<TrackWithSources[]>(() =>
    cached && sameSelectionCache(cached.selection, playlistSelection)
      ? cached.playlistTracks
      : [],
  )
  const [error, setError] = useState<string | null>(null)
  /**
   * What the last file operation did, said out loud.
   *
   * An import is the one action that can move hundreds of records at once, and
   * it used to report nothing at all — so a merge that quietly matched nothing
   * was indistinguishable from one that worked. Separate from `error` because
   * a finished import is not a failure, even when it has a caveat.
   */
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(() => cached === null)
  /**
   * What the last AI batch did, and anything it could not do.
   *
   * Held separately from `error` because a merge that added forty tracks and
   * rejected two is not a failure — it is the normal outcome of asking a model
   * for a hundred songs. The rejections are the part worth reading, so they get
   * their own dismissible panel rather than being buried in a thrown error.
   */
  const [mergeReport, setMergeReport] = useState<MergeReport | null>(null)
  const [inboxPending, setInboxPending] = useState(false)

  const refreshFacets = useCallback(async () => {
    if (!library) return { genres: [], artists: [], albums: [] }
    const [genres, artists, albums] = await Promise.all([
      library.listGenres(),
      library.listArtists(),
      library.listAlbums(),
    ])
    const nextFacets = { genres, artists, albums }
    setFacets(nextFacets)
    return nextFacets
  }, [library])

  const refresh = useCallback(
    async (fromDisk = false) => {
      if (!library) return
      // Re-reading the file picks up edits made outside the app (an agent
      // filling in genres, or a hand edit while the app is open).
      if (fromDisk && 'reload' in library) {
        await (library as unknown as { reload(): Promise<void> }).reload()
      }
      const currentFilter = filterRef.current
      const isUnfiltered =
        !currentFilter.search &&
        !currentFilter.artist &&
        !currentFilter.album &&
        currentFilter.genres.length === 0 &&
        !currentFilter.sourceKind &&
        !currentFilter.unfiledOnly &&
        !currentFilter.hasLiveSource
      const [nextTracks, nextPlaylists, nextFolders, allTracks, nextFacets] =
        await Promise.all([
          library.listTracks(currentFilter),
          library.listPlaylists(),
          library.listFolders(),
          isUnfiltered ? Promise.resolve(null) : library.listTracks(EMPTY_FILTER),
          refreshFacets(),
        ])

      const currentSel = selectionRef.current
      let effectiveSelection: PlaylistSelection = currentSel
      if (
        currentSel.kind === 'playlist' &&
        !nextPlaylists.some((p) => p.id === currentSel.playlistId)
      ) {
        effectiveSelection = { kind: 'all' }
      } else if (
        currentSel.kind === 'folder' &&
        !nextFolders.some((f) => f.id === currentSel.folderId)
      ) {
        effectiveSelection = { kind: 'all' }
      }

      const nextPlaylistTracks = await fetchSelectionMembership(
        library,
        effectiveSelection,
        nextFolders,
        nextPlaylists,
      )

      const resolvedTotal = allTracks ? allTracks.length : nextTracks.length
      setTracks(nextTracks)
      setTotalCount(resolvedTotal)
      setPlaylists(nextPlaylists)
      setFolders(nextFolders)
      setPlaylistTracks(nextPlaylistTracks)
      if (!sameSelectionCache(effectiveSelection, selectionRef.current)) {
        selectionRef.current = effectiveSelection
        setPlaylistSelection(effectiveSelection)
      }

      writeLibrarySnapshot({
        tracks: allTracks ?? nextTracks,
        totalCount: resolvedTotal,
        playlists: nextPlaylists,
        folders: nextFolders,
        facets: nextFacets,
        selection: effectiveSelection,
        playlistTracks: nextPlaylistTracks,
      })
    },
    [library, refreshFacets],
  )

  /**
   * Loads the tracklist for a folder or playlist selection.
   *
   * `all` is not a membership list — it reads through `tracks`, the filtered
   * library — so it leaves this empty. A folder is the union of
   * every playlist under it, deduplicated but left in first-seen order, so a
   * track shared by two playlists appears once and the folder reads as a set
   * of songs rather than a set of memberships.
   */
  const refreshPlaylistTracks = useCallback(async () => {
    if (!library) return
    const nextPlaylistTracks = await fetchSelectionMembership(
      library,
      playlistSelection,
      folders,
      playlists,
    )
    setPlaylistTracks(nextPlaylistTracks)
  }, [library, playlistSelection, folders, playlists])

  useEffect(() => {
    let cancelled = false
    if (!library) return
    if (!cached) setLoading(true)
    refresh(false)
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [library, refresh, cached])

  /**
   * Re-queries tracks in memory when only the filter changes, without
   * re-downloading `library.json` from disk or resetting the poll timer.
   */
  useEffect(() => {
    if (!library) return
    let cancelled = false
    void library
      .listTracks(filter)
      .then((nextTracks) => {
        if (!cancelled) setTracks(nextTracks)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [library, filter])

  /**
   * Polls the server so edits made outside the app appear automatically.
   *
   * This asks for the *revision* rather than the document, because the whole
   * point is to avoid re-downloading a file that grows without limit. It also
   * fixed a bug the old signature had: it compared the byte length and the
   * number of `"id"` keys, so editing a title in place — changing neither — was
   * invisible until you restarted. A content hash notices any change at all,
   * and it is what tells us an agent batch was merged in.
   */
  useEffect(() => {
    if (!('reload' in (library ?? {}))) return
    let cancelled = false
    let seen = ''
    let seenPending = false
    let seenReport = readSeenReport()
    // The first poll reports whatever is *already* on disk, which is a batch
    // that landed while nobody was watching. That is history: it is shown by
    // `data/last-merge.json`, the Agent panel and the backups list, and
    // announcing it at the top of the window on every launch is what made
    // "2 added" reappear after every refresh. Only a batch that arrives while
    // this session is running is worth interrupting the person for.
    let firstPoll = true
    const id = window.setInterval(async () => {
      const status = await fetchAgentStatus()
      if (cancelled || !status) return
      const pending = status.inbox.present
      setInboxPending(pending)
      if (status.report) {
        const signature = reportSignature(status.report)
        if (signature !== seenReport) {
          seenReport = signature
          // Recorded as shown even when it is history, so the same report
          // cannot come back on the next poll.
          rememberSeenReport(signature)
          if (!firstPoll) setMergeReport(status.report)
        }
      }
      firstPoll = false
      // Reading the library is what applies a batch, so a newly-dropped inbox
      // has to trigger a read — not just be reported as waiting. The first poll
      // after launch is skipped: the load effect has already read the file.
      if (seen && (status.revision !== seen || (pending && !seenPending))) {
        await refresh(true)
      }
      seen = status.revision
      seenPending = pending
    }, 4000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [library, refresh])

  useEffect(() => {
    void refreshPlaylistTracks()
  }, [refreshPlaylistTracks])

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn()
      setError(null)
      return result
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }, [])

  const addTrack = useCallback(
    async (payload: Parameters<Library['addTrack']>[0]) =>
      guard(async () => {
        const id = await library!.addTrack(payload)
        await refresh()
        return id
      }),
    [library, guard, refresh],
  )

  const updateTrack = useCallback(
    async (id: number, patch: Parameters<Library['updateTrack']>[1]) =>
      guard(async () => {
        await library!.updateTrack(id, patch)
        await refresh()
        await refreshPlaylistTracks()
      }),
    [library, guard, refresh, refreshPlaylistTracks],
  )

  const setSource = useCallback(
    async (
      trackId: number,
      role: SourceRole,
      source: Parameters<Library['setSource']>[2],
    ) =>
      guard(async () => {
        await library!.setSource(trackId, role, source)
        await refresh()
        await refreshPlaylistTracks()
      }),
    [library, guard, refresh, refreshPlaylistTracks],
  )

  /**
   * Cuts one source slot from a track, the Main included.
   *
   * No refresh: a link-health run cuts every dead link in one pass and asks for
   * one refresh at the end, because re-reading the whole library after each of
   * fifty cuts would re-render the list fifty times.
   */
  const removeSource = useCallback(
    async (trackId: number, role: SourceRole) => {
      if (!library) return
      await library.removeSource(trackId, role)
    },
    [library],
  )

  /**
   * Files tracks into the top-level Issues playlist, creating it once.
   *
   * A place to look rather than a change to the tracks, so it asks nothing: an
   * existing top-level playlist with that name is reused, which is what keeps a
   * second run from making a second Issues.
   */
  const fileIssues = useCallback(
    async (
      trackIds: number[],
    ): Promise<{ playlistId: number; created: boolean; added: number }> => {
      const libraryRef = library
      if (!libraryRef || !trackIds.length) {
        return { playlistId: -1, created: false, added: 0 }
      }
      const existing = findIssuesPlaylist(await libraryRef.listPlaylists())
      const playlistId =
        existing?.id ?? (await libraryRef.createPlaylist(ISSUES_PLAYLIST, undefined, null))
      const already = new Set<number>(
        existing
          ? (await libraryRef.listPlaylistTracks(existing.id)).map((e) => e.trackId)
          : [],
      )
      let added = 0
      for (const trackId of trackIds) {
        if (already.has(trackId)) continue
        await libraryRef.addToPlaylist(playlistId, trackId)
        added++
      }
      await refresh()
      return { playlistId, created: !existing, added }
    },
    [library, refresh],
  )

  /**
   * Records a measured running time for a track.
   *
   * Does not go through `guard`, because it is written by the player while audio
   * is playing: a failed write here is not a user-facing error, and the caller
   * has a better fallback (the duration the player is already showing). It also
   * deliberately does *not* refresh the whole library — that would re-read every
   * track and re-render the list several times a minute. The row is patched in
   * place instead.
   */
  const setDuration = useCallback(
    async (trackId: number, seconds: number | null) => {
      const libraryRef = library
      if (!libraryRef) return
      try {
        const before = await libraryRef.getTrack(trackId)
        if (!before || before.duration === seconds) return
        await libraryRef.setDuration(trackId, seconds)
        setTracks((current) =>
          current.map((t) =>
            t.id === trackId ? { ...t, duration: seconds ?? null } : t,
          ),
        )
      } catch {
        // A duration we failed to store is a cosmetic loss; never interrupt
        // playback to report it.
      }
    },
    [library],
  )

  /**
   * Writes a set of plain fields onto one track, patching the row in place.
   *
   * Same reasoning as `setDuration`, and for the same reason: a backfill run
   * touches a dozen tracks in a row, and going through `guard`/`refresh` for
   * each one re-reads and re-renders the entire library every time. The caller
   * refreshes once when the run finishes, which also picks up the new genres in
   * the facet list — a per-track refresh would show those appearing one at a
   * time, which looks like flicker rather than progress.
   */
  const patchTrackFields = useCallback(
    async (trackId: number, patch: Parameters<Library['updateTrack']>[1]) => {
      const libraryRef = library
      if (!libraryRef) return
      await libraryRef.updateTrack(trackId, patch)
      setTracks((current) =>
        current.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
      )
    },
    [library],
  )

  const setMusicBrainzId = useCallback(
    async (trackId: number, mbid: string | null) =>
      guard(async () => {
        await library!.setMusicBrainzId(trackId, mbid)
        await refresh()
      }),
    [library, guard, refresh],
  )

  const deleteTrack = useCallback(
    async (id: number) =>
      guard(async () => {
        await library!.deleteTrack(id)
        await refresh()
        await refreshPlaylistTracks()
      }),
    [library, guard, refresh, refreshPlaylistTracks],
  )

  const createPlaylist = useCallback(
    async (
      name: string,
      description?: string,
      folderId?: number | null,
    ): Promise<number> =>
      guard(async () => {
        const id = await library!.createPlaylist(name, description, folderId)
        await refresh()
        return id
      }),
    [library, guard, refresh],
  )

  const deletePlaylist = useCallback(
    async (id: number) =>
      guard(async () => {
        await library!.deletePlaylist(id)
        setPlaylistSelection((current) =>
          current.kind === 'playlist' && current.playlistId === id
            ? { kind: 'all' }
            : current,
        )
        await refresh()
      }),
    [library, guard, refresh],
  )

  const createFolder = useCallback(
    async (name: string, parentId?: number | null): Promise<number> =>
      guard(async () => {
        const id = await library!.createFolder(name, parentId)
        await refresh()
        return id
      }),
    [library, guard, refresh],
  )

  const deleteFolder = useCallback(
    async (id: number) =>
      guard(async () => {
        await library!.deleteFolder(id)
        setPlaylistSelection((current) =>
          current.kind === 'folder' && current.folderId === id
            ? { kind: 'all' }
            : current,
        )
        await refresh()
      }),
    [library, guard, refresh],
  )

  const renameFolder = useCallback(
    async (id: number, name: string) =>
      guard(async () => {
        await library!.renameFolder(id, name)
        await refresh()
      }),
    [library, guard, refresh],
  )

  const renamePlaylist = useCallback(
    async (id: number, name: string) =>
      guard(async () => {
        await library!.renamePlaylist(id, name)
        await refresh()
      }),
    [library, guard, refresh],
  )

  /** The notes shown under the folder tree, or null to clear them. */
  const setPlaylistDescription = useCallback(
    async (id: number, description: string | null) =>
      guard(async () => {
        await library!.setPlaylistDescription(id, description)
        await refresh()
      }),
    [library, guard, refresh],
  )

  /**
   * Drag-and-drop re-parenting of the tree.
   *
   * A move out of a folder is `null` in both cases. A move that would put a
   * folder inside itself is refused by the store rather than here, so the rule
   * is the same one the tests assert against both implementations.
   */
  const movePlaylist = useCallback(
    async (playlistId: number, folderId: number | null) =>
      guard(async () => {
        await library!.setPlaylistFolder(playlistId, folderId)
        await refresh()
      }),
    [library, guard, refresh],
  )

  const moveFolder = useCallback(
    async (folderId: number, parentId: number | null) =>
      guard(async () => {
        await library!.setFolderParent(folderId, parentId)
        await refresh()
      }),
    [library, guard, refresh],
  )

  /** Membership for the track card: which playlists this track is in. */
  const playlistsForTrack = useCallback(
    async (trackId: number): Promise<Playlist[]> => {
      if (!library) return []
      return library.listPlaylistsForTrack(trackId)
    },
    [library],
  )

  const addToPlaylist = useCallback(
    async (playlistId: number, trackId: number) =>
      guard(async () => {
        await library!.addToPlaylist(playlistId, trackId)
        await refresh()
        await refreshPlaylistTracks()
      }),
    [library, guard, refresh, refreshPlaylistTracks],
  )

  /**
   * Moves a track to a new position inside one playlist.
   *
   * Only the selected playlist's own order changes, so there is no need to
   * re-read the library: `refreshPlaylistTracks` re-orders the visible list and
   * every other count — membership, unfiled totals, the tree — is unaffected by
   * a move. That also keeps a drag from re-rendering the whole window.
   */
  const movePlaylistTrack = useCallback(
    async (playlistId: number, trackId: number, toIndex: number) =>
      guard(async () => {
        await library!.movePlaylistTrack(playlistId, trackId, toIndex)
        await refreshPlaylistTracks()
      }),
    [library, guard, refreshPlaylistTracks],
  )

  /**
   * Every track in the library, whatever the filter currently says.
   *
   * The list on screen is the filtered one, which is exactly the wrong input
   * for the automatic lookup: a track hidden by the search box, or by a genre
   * chip, still deserves its bio, and sweeping only what happens to be visible
   * would leave those gaps until the filters were cleared.
   */
  const listAllTracks = useCallback(async (): Promise<TrackWithSources[]> => {
    if (!library) return []
    return library.listTracks(EMPTY_FILTER)
  }, [library])

  const removeFromPlaylist = useCallback(
    async (playlistId: number, trackId: number) =>
      guard(async () => {
        await library!.removeFromPlaylist(playlistId, trackId)
        await refresh()
        await refreshPlaylistTracks()
      }),
    [library, guard, refresh, refreshPlaylistTracks],
  )

  const toggleGenre = useCallback((name: string) => {
    setFilter((prev) => ({
      ...prev,
      genres: prev.genres.includes(name)
        ? prev.genres.filter((g) => g !== name)
        : [...prev.genres, name],
    }))
  }, [])

  const clearFilter = useCallback(() => setFilter(EMPTY_FILTER), [])

  /**
   * Records a track that played to its end.
   *
   * Telemetry, so it never surfaces an error: a listen the store failed to
   * note is a cosmetic loss, and interrupting playback to report it would be
   * the wrong trade. Same reasoning as `setDuration` beside it.
   */
  const recordPlay = useCallback(
    async (trackId: number) => {
      const libraryRef = library
      if (!libraryRef) return
      try {
        await libraryRef.recordPlay(trackId)
      } catch {
        // Nothing to do: the listen happened whether or not it was logged.
      }
    },
    [library],
  )

  /** Completed listens, newest first — what the DJ learns taste from. */
  const listRecentPlays = useCallback(
    async (limit: number): Promise<PlayEvent[]> => {
      if (!library) return []
      return library.listRecentPlays(limit)
    },
    [library],
  )

  /**
   * Playlist memberships as track-id groups, for the DJ's shelved-together
   * signal. One query per playlist, so it is called only when drafting picks
   * rather than on every render.
   */
  const listPlaylistGroups = useCallback(async (): Promise<number[][]> => {
    if (!library) return []
    const lists = await library.listPlaylists()
    const groups = await Promise.all(
      lists.map((playlist) =>
        library
          .listPlaylistTracks(playlist.id)
          .then((entries) => entries.map((e) => e.trackId))
          .catch(() => [] as number[]),
      ),
    )
    return groups.filter((group) => group.length > 1)
  }, [library])

  const exportLibrary = useCallback(async () => {
    if (!library) return null
    return library.exportJson()
  }, [library])

  const importLibrary = useCallback(
    async (json: string) =>
      guard(async () => {
        const result = await library!.importJson(json)
        await refresh()
        // The open folder/playlist view reads through `playlistTracks`, not
        // `tracks` — without this an import while a playlist is open would
        // update the counts but leave the rows on show stale.
        await refreshPlaylistTracks()
        const parts = [
          plural(result.tracks, 'track', 'tracks'),
          plural(result.playlists, 'playlist', 'playlists'),
        ]
        if (result.folders) parts.push(plural(result.folders, 'folder', 'folders'))
        const caveats: string[] = []
        if (result.unmatched.length) {
          caveats.push(
            `${plural(result.unmatched.length, 'playlist entry', 'playlist entries')} matched no track`,
          )
        }
        if (result.unplayable.length) {
          caveats.push(
            `${plural(result.unplayable.length, 'track', 'tracks')} imported with no playable link`,
          )
        }
        setNotice(
          `Import finished: ${parts.join(', ')} processed.${
            caveats.length ? ` ${caveats.join('; ')}.` : ''
          } Existing records keep the details they already had; a re-import never duplicates.`,
        )
        return result
      }),
    [library, guard, refresh, refreshPlaylistTracks],
  )

  /**
   * The mirror sibling of the merge import: the store is emptied first, so
   * afterwards the library holds exactly what the file held. The dialog owns
   * the confirmation — by the time this runs, the person has said yes twice.
   */
  const replaceLibrary = useCallback(
    async (json: string) =>
      guard(async () => {
        const result = await library!.replaceJson(json)
        await refresh()
        await refreshPlaylistTracks()
        const parts = [
          plural(result.tracks, 'track', 'tracks'),
          plural(result.playlists, 'playlist', 'playlists'),
        ]
        if (result.folders) parts.push(plural(result.folders, 'folder', 'folders'))
        setNotice(
          `Replace finished: the library now holds ${parts.join(', ')} — exactly what the file held. Anything the file did not contain is gone.`,
        )
        return result
      }),
    [library, guard, refresh, refreshPlaylistTracks],
  )

  return useMemo(
    () => ({
      tracks,
      totalCount,
      playlists,
      folders,
      playlistTracks,
      playlistSelection,
      facets,
      filter,
      loading,
      error,
      refresh,
      setFilter,
      setPlaylistSelection,
      toggleGenre,
      clearFilter,
      addTrack,
      updateTrack,
      deleteTrack,
      setSource,
      removeSource,
      fileIssues,
      setDuration,
      patchTrackFields,
      setMusicBrainzId,
      createPlaylist,
      deletePlaylist,
      createFolder,
      deleteFolder,
      renameFolder,
      renamePlaylist,
      setPlaylistDescription,
      movePlaylist,
      moveFolder,
      playlistsForTrack,
      addToPlaylist,
      removeFromPlaylist,
      movePlaylistTrack,
      listAllTracks,
      recordPlay,
      listRecentPlays,
      listPlaylistGroups,
      exportLibrary,
      importLibrary,
      replaceLibrary,
      mergeReport,
      inboxPending,
      notice,
      dismissError: () => setError(null),
      dismissNotice: () => setNotice(null),
      dismissMergeReport: () => setMergeReport(null),
    }),
    [
      tracks,
      totalCount,
      playlists,
      folders,
      playlistTracks,
      playlistSelection,
      facets,
      filter,
      loading,
      error,
      refresh,
      toggleGenre,
      clearFilter,
      addTrack,
      updateTrack,
      deleteTrack,
      setSource,
      removeSource,
      fileIssues,
      setDuration,
      patchTrackFields,
      setMusicBrainzId,
      createPlaylist,
      deletePlaylist,
      createFolder,
      deleteFolder,
      renameFolder,
      renamePlaylist,
      setPlaylistDescription,
      movePlaylist,
      moveFolder,
      playlistsForTrack,
      addToPlaylist,
      removeFromPlaylist,
      movePlaylistTrack,
      listAllTracks,
      recordPlay,
      listRecentPlays,
      listPlaylistGroups,
      exportLibrary,
      importLibrary,
      replaceLibrary,
      mergeReport,
      inboxPending,
      notice,
    ],
  )
}

export type LibraryApi = ReturnType<typeof useLibrary>
