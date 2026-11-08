import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { Analytics } from '@vercel/analytics/react'
import { AddTrackDialog } from './components/AddTrackDialog'
import { LibraryBrowser } from './components/LibraryBrowser'
import { ListHeader } from './components/ListHeader'
import type { MediaPane } from './components/MediaPanel'
import { MobileNav } from './components/MobileNav'
import { Player } from './components/Player'
import { PlaylistTree } from './components/PlaylistTree'
import { ShortcutsDialog } from './components/ShortcutsDialog'
import { TopBar } from './components/TopBar'
import { TrackCardDialog } from './components/TrackCardDialog'
import { TracklistToolbar } from './components/TracklistToolbar'
import { TrackList } from './components/TrackList'
import { YouScreen } from './components/YouScreen'
import { ChevronLeftIcon } from './components/icons'
import { plural } from './lib/format'
import { useFolderExpansion } from './hooks/useFolderExpansion'
import { useLayout } from './hooks/useLayout'
import {
  readInitialSelection,
  useLibrary,
  type PlaylistSelection,
} from './hooks/useLibrary'
import { AgentBanner } from './components/AgentBanner'
import { LinkHealthDialog } from './components/LinkHealthDialog'
import { ReplaceLibraryDialog } from './components/ReplaceLibraryDialog'
import { useInfoBackfill } from './hooks/useInfoBackfill'
import {
  useLyricsBackfill,
  type LyricsBackfillSummary,
} from './hooks/useLyricsBackfill'
import type { Library } from './lib/db'
import { createHttpTransport, JsonLibrary } from './lib/jsonLibrary'
import { hasOpenEscapeLayer } from './hooks/useEscape'
import { useFocusTrap } from './hooks/useFocusTrap'
import type {
  LibraryFilter,
  Playlist,
  TrackPatch,
  TrackWithSources,
} from './lib/types'
import type { BackfillSummary } from './hooks/useInfoBackfill'
import {
  readCheckedLookupKeys,
  trackLookupKey,
  writeCheckedLookupKeys,
  type BackfillTrack,
} from './lib/infoBackfill'
import { DJ_REFILL_COUNT, draftDjPicks } from './lib/dj'
import type { LyricsBackfillTrack } from './lib/lyricsBackfill'
import { matchesTrackFilter } from './lib/trackFilter'
import type { ActiveTracklist } from './lib/activeTracklist'
import {
  emptyCycle,
  nextTrackId,
  notePlayed,
  openingTrack,
  type ShuffleCycle,
} from './lib/shuffle'
import type { PlaybackView } from './lib/sources'
import {
  INITIAL_NAV,
  readNav,
  reduceNav,
  type Tab,
} from './lib/navigation'
import {
  DEFAULT_SORT,
  sortTracks,
  type SortState,
} from './lib/trackSort'
import type { ContextMenuItem } from './components/ContextMenu'

/** The list a selection names, for the header and for "playing from …". */
function sameSelection(a: PlaylistSelection, b: PlaylistSelection): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'all') return true
  if (a.kind === 'folder' && b.kind === 'folder') return a.folderId === b.folderId
  if (a.kind === 'playlist' && b.kind === 'playlist') {
    return a.playlistId === b.playlistId
  }
  return false
}

/** How many screens deep the app is, for the browser-history entries. */
function navDepth(tab: Tab, listOpen: boolean): number {
  if (tab !== 'library') return 1
  return listOpen ? 1 : 0
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode, or storage refused: the choice still applies this session.
  }
}

/** The fields the automatic lookup is allowed to look at. */
function backfillCandidate(track: TrackWithSources): BackfillTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    info: track.info,
    year: track.year,
    genres: track.genres,
  }
}

/**
 * What the last automatic lookup did, in one line.
 *
 * Said out loud rather than swallowed: these lookups happen on their own now,
 * and "nothing was found for these three" is the difference between a track
 * that is empty because no source knows the band and one that is empty because
 * something is quietly broken.
 */
function summariseBackfill(summary: BackfillSummary): string {
  if (summary.cancelled) {
    return summary.filled
      ? `Stopped — filled in background for ${plural(summary.filled, 'track', 'tracks')}.`
      : 'Stopped looking up background information.'
  }
  if (summary.filled) {
    return `Filled in background for ${plural(summary.filled, 'track', 'tracks')}.`
  }
  return `Nothing new to add for ${plural(summary.skipped, 'track', 'tracks')}.`
}

/**
 * What the last automatic lyrics run did, in one line — the same courtesy as
 * the info lookup: a silent run that found nothing looks identical to a run
 * that never happened, and only one of those deserves a second thought.
 */
function summariseLyricsBackfill(summary: LyricsBackfillSummary): string {
  if (summary.cancelled) {
    return summary.filled
      ? `Stopped — found lyrics for ${plural(summary.filled, 'track', 'tracks')}.`
      : 'Stopped looking up lyrics.'
  }
  if (summary.filled) {
    return `Found lyrics for ${plural(summary.filled, 'track', 'tracks')}.`
  }
  return `No lyrics found for ${plural(summary.skipped, 'track', 'tracks')}.`
}

/** Hands a JSON document to the browser as a file download. */
function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** What the lyrics sweep reads off a track: identity, query, and what's there. */
function lyricsCandidate(track: TrackWithSources): LyricsBackfillTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    lyrics: track.lyrics,
  }
}


/** The library column: how wide it may be, and how wide it starts. */
const SIDEBAR_MIN = 240
const SIDEBAR_MAX = 560
const SIDEBAR_DEFAULT = 300
const SIDEBAR_WIDTH_KEY = 'trackvault.sidebar-width'

const clampSidebarWidth = (width: number): number =>
  Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width))

export function App() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  // Audio, video or live. Lives here so the choice survives skipping to the next
  // track, but the control is in the player: the view buttons at the end of
  // the transport are the switch, which puts them next to what they switch.
  const [playbackView, setPlaybackView] = useState<PlaybackView>('audio')
  const [dialogOpen, setDialogOpen] = useState(false)
  // The track the player is on, and the track whose card is open. They are
  // deliberately separate: clicking a row opens the card, and only pressing a
  // row's play button changes what is playing. Restored synchronously on boot
  // so re-opening the app immediately shows the last played track at 0ms.
  const [playingTrack, setPlayingTrack] = useState<TrackWithSources | null>(
    () => {
      const stored = readStored<TrackWithSources | null>(
        'trackvault.playingTrack',
        null,
      )
      return stored &&
        typeof stored.id === 'number' &&
        typeof stored.title === 'string' &&
        Array.isArray(stored.sources)
        ? stored
        : null
    },
  )
  // Bumped whenever the tracklist asks for a track to play. The player watches
  // it and starts the stream, so a play press does not just load the track and
  // wait for a second press.
  const [playToken, setPlayToken] = useState(0)
  const [togglePlayToken, setTogglePlayToken] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [cardId, setCardId] = useState<number | null>(null)
  // Opened as the form, not the read view: the player's empty Info and Lyrics
  // panes ask for what is missing, so they skip the extra press on Edit.
  const [cardEdit, setCardEdit] = useState(false)
  const [cardPlaylists, setCardPlaylists] = useState<Playlist[]>([])
  // The link-health run lives in its own dialog; its verdict lives here so
  // the rows stay marked while the reader works through the fixes.
  const [linkHealthOpen, setLinkHealthOpen] = useState(false)
  // The file picked for a replace import, waiting in the confirm dialog.
  // Kept apart from the merge import's fire-and-forget picker: replacing
  // empties the library first, so the file is previewed and confirmed before
  // anything is deleted.
  const [replaceFile, setReplaceFile] = useState<{
    name: string
    text: string
  } | null>(null)
  const [replacePending, setReplacePending] = useState(false)
  // The two tracklist controls. Shuffle decides *what plays next* — it leaves
  // the list alone — and repeat decides whether the sequence starts again when
  // it runs out or stops. See `lib/shuffle.ts` for why the list must not move.
  const [shuffle, setShuffle] = useState(
    () => readStored<boolean>('trackvault.shuffle', false) === true,
  )
  const [repeat, setRepeat] = useState(
    () => readStored<boolean>('trackvault.repeat', false) === true,
  )
  // DJ mode: when the list runs out, suggested songs drafted from what is
  // playing continue instead of stopping. The session is the picks in draft
  // order — heard ones stay for Previous — so it is never spliced, only
  // appended to. There is no Up-next dialog: the picks simply play on.
  const [djOn, setDjOn] = useState(false)
  const [djSeedId, setDjSeedId] = useState<number | null>(null)
  const [djSession, setDjSession] = useState<TrackWithSources[]>([])
  const [djHeard, setDjHeard] = useState<ReadonlySet<number>>(new Set())
  // Mirrors of the above for the top-up effect's pruning: read inside a
  // setState updater, where the state values are not in scope.
  const djHeardRef = useRef<Set<number>>(new Set())
  const djRefilling = useRef(false)
  /**
   * The shuffle's state, in a ref rather than state: it decides one thing (the
   * next track) and is read at the moment of a skip, so putting it in state
   * would re-render the whole window on every draw for no visible reason.
   */
  const shuffleCycle = useRef<ShuffleCycle>(emptyCycle())
  // The list Play was last pressed on, frozen at press time.
  //
  // Browsing the tree or typing in the filters changes what is *shown*, but
  // the player walks this snapshot instead — so exploring folders and
  // playlists never changes what plays, and the "Now playing …" line under
  // the filters can put the audible list back on screen. Only a new Play
  // press replaces it; row play snapshots the list the row was in.
  const [activeTracklist, setActiveTracklist] = useState<ActiveTracklist | null>(
    () => readStored<ActiveTracklist | null>('trackvault.activeTracklist', null),
  )
  // Full rows at snapshot time, so tracks filtered out of every visible list
  // afterwards still resolve for the player.
  const [activeSnapshot, setActiveSnapshot] = useState<TrackWithSources[]>(() => {
    const stored = readStored<TrackWithSources[]>('trackvault.activeSnapshot', [])
    return Array.isArray(stored) ? stored : []
  })
  const sessionRestoredRef = useRef(false)
  /**
   * The shape of the window, and where in the app we are.
   *
   * Three modes rather than one breakpoint, and only two shells: a phone and a
   * tablet both show one screen at a time behind a tab bar (`singlePane` below
   * is the one switch), while a desktop holds the library column and the list
   * side by side with the player docked underneath. The navigation itself is a pure reducer
   * (`lib/navigation.ts`), so the back gesture, the tab bar and the "open this
   * playlist" press all move through one rule.
   */
  const layout = useLayout()
  const [nav, dispatchNav] = useReducer(reduceNav, INITIAL_NAV, () => {
    const base = readNav(
      typeof window === 'undefined'
        ? null
        : window.localStorage.getItem('trackvault.nav'),
    )
    if (typeof window !== 'undefined') {
      const sel = readInitialSelection()
      if (sel.kind !== 'all') {
        return { ...base, listOpen: true }
      }
    }
    return base
  })
  // Which face the track's panel shows. Remembered, because a reader who wants
  // the words usually wants them again next track.
  const [pane, setPane] = useState<MediaPane>(() =>
    readStored<MediaPane>('trackvault.pane', 'info') === 'lyrics' ? 'lyrics' : 'info',
  )
  // The order of the rows. A playlist's own order is the default, because that
  // is the one the reader dragged into place.
  const [sort, setSort] = useState<SortState>(() => {
    const stored = readStored<SortState>('trackvault.sort', DEFAULT_SORT)
    return stored && typeof stored.key === 'string' ? stored : DEFAULT_SORT
  })
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // The `You` sheet's panel: the trap needs the element, and `You` is rendered
  // here rather than owning a hook of its own.
  const youDialog = useRef<HTMLDivElement | null>(null)
  useFocusTrap(youDialog, nav.tab === 'you')

  const expanded = nav.tab === 'playing'
  const singlePane = layout !== 'desktop'

  useEffect(() => {
    const connectSql = () =>
      Promise.all([import('./lib/db'), import('./lib/drivers')]).then(
        async ([{ Library: SqlLibrary }, { createDefaultDriver }]) => {
          const driver = await createDefaultDriver()
          const sqlInstance = new SqlLibrary(driver)
          await sqlInstance.migrate()
          writeStored('trackvault.storageBackend', 'sql')
          setLibrary(sqlInstance)
        },
      )

    const connectJson = () => {
      const instance = new JsonLibrary(createHttpTransport())
      return instance.migrate().then(() => {
        writeStored('trackvault.storageBackend', 'json')
        setLibrary(instance as unknown as Library)
      })
    }

    const host =
      typeof window !== 'undefined' ? window.location.hostname : 'localhost'
    const isLocalHost = host === 'localhost' || host === '127.0.0.1'
    const preferSql =
      !isLocalHost &&
      readStored<string | null>('trackvault.storageBackend', null) === 'sql'

    if (preferSql) {
      // Hosted deployment where `/api/library` is known to be absent: open the
      // browser-local database directly without waiting on a failed HTTP request.
      connectSql().catch((e: unknown) =>
        setBootError(e instanceof Error ? e.message : String(e)),
      )
      return
    }

    connectJson().catch(() =>
      connectSql().catch((e: unknown) =>
        setBootError(e instanceof Error ? e.message : String(e)),
      ),
    )
  }, [])

  const api = useLibrary(library)
  // Which tree folders are open. `null` while the library is loading, because
  // an empty store is not an empty library: without that, every folder would
  // arrive as "new" and open itself the moment the load finished.
  const treeFolders = useFolderExpansion(api.loading ? null : api.folders)

  /**
   * Every track the app currently knows about, by id.
   *
   * Built from both lists because a track can be on screen in the library and
   * in a playlist, and resolved by id so the player and dialogs keep working
   * when a filter has narrowed the visible list.
   */
  const knownTracks = useMemo(() => {
    const map = new Map<number, TrackWithSources>()
    for (const track of api.tracks) map.set(track.id, track)
    for (const track of api.playlistTracks) {
      if (!map.has(track.id)) map.set(track.id, track)
    }
    // DJ picks may come from outside every visible list, so they are known
    // too — otherwise opening a pick's card would find nothing.
    for (const track of djSession) {
      if (!map.has(track.id)) map.set(track.id, track)
    }
    if (playingTrack) map.set(playingTrack.id, playingTrack)
    return map
  }, [api.tracks, api.playlistTracks, djSession, playingTrack])

  // Keep the player's copy of its track in step with edits and enrichment: the
  // card can rename a track, and the row the player holds would otherwise go
  // stale until the next selection.
  useEffect(() => {
    if (!playingTrack) return
    const fresh =
      api.tracks.find((t) => t.id === playingTrack.id) ??
      api.playlistTracks.find((t) => t.id === playingTrack.id) ??
      djSession.find((t) => t.id === playingTrack.id)
    if (fresh && fresh !== playingTrack) setPlayingTrack(fresh)
  }, [api.tracks, api.playlistTracks, djSession, playingTrack])

  const cardTrack = useMemo(
    () => (cardId === null ? null : knownTracks.get(cardId) ?? null),
    [knownTracks, cardId],
  )

  const selection = api.playlistSelection
  /**
   * A folder or playlist shows its membership narrowed by the filters, with
   * the same rules as the library list (`matchesTrackFilter`, held against
   * both stores by the parity test). One exception needs no membership data:
   * every member of these views is filed by construction, so `unfiledOnly`
   * empties them on its own.
   */
  const filteredMembership = useMemo(() => {
    if (api.filter.unfiledOnly) return []
    return api.playlistTracks.filter((track) => matchesTrackFilter(track, api.filter))
  }, [api.playlistTracks, api.filter])
  const unsortedRows =
    selection.kind === 'playlist' || selection.kind === 'folder'
      ? filteredMembership
      : api.tracks
  /**
   * The rows as they are shown *and* as they will play.
   *
   * Sorting is a view of the list, not a change to it: nothing is written back,
   * and a playlist returns to its dragged order the moment "Playlist order" is
   * chosen again. Pressing Play on a sorted list queues it in the order on
   * screen, which is what anybody pressing it would expect.
   */
  const rows = useMemo(() => sortTracks(unsortedRows, sort), [unsortedRows, sort])

  /**
   * The playlist being looked at, or null for anything else.
   *
   * Drag-to-re-order hangs off this one value rather than off a flag set per
   * view, so the library and the folder views cannot accidentally acquire it:
   * they are not a playlist, so there is no id to move anything within.
   */
  const openPlaylistId =
    api.playlistSelection.kind === 'playlist'
      ? api.playlistSelection.playlistId
      : null

  // An empty library and an over-narrowed one look the same otherwise, and
  // "add a YouTube link" is wrong advice when the tracks exist but are filtered
  // out.
  const filtering =
    !!api.filter.search ||
    !!api.filter.artist ||
    !!api.filter.album ||
    api.filter.genres.length > 0 ||
    !!api.filter.sourceKind ||
    api.filter.unfiledOnly ||
    api.filter.hasLiveSource

  // The rows are shown exactly as the library or the playlist ordered them, in
  // both modes. Shuffling changes which one plays next, not where it sits.
  const queue = rows
  /**
   * The audible list: the snapshot taken when Play was last pressed, with
   * each row refreshed from the library when it is still known (so renames
   * and enrichment reach the player) and kept as snapshotted otherwise (so
   * a track filtered out of every visible list keeps playing).
   *
   * Browsing never touches this — `rows` is what is on screen, this is what
   * is playing — which is what lets the reader explore without reordering
   * the music.
   */
  const activeTracks = useMemo(() => {
    if (!activeTracklist) return []
    const byId = new Map<number, TrackWithSources>()
    for (const track of knownTracks.values()) byId.set(track.id, track)
    const fallback = new Map<number, TrackWithSources>()
    for (const track of activeSnapshot) fallback.set(track.id, track)
    const out: TrackWithSources[] = []
    for (const id of activeTracklist.trackIds) {
      const fresh = byId.get(id) ?? fallback.get(id)
      if (fresh) out.push(fresh)
    }
    return out
  }, [activeTracklist, activeSnapshot, knownTracks])
  /**
   * What the player walks: the audible snapshot with the DJ picks after it.
   *
   * The tracklist still shows `rows` alone — the picks simply play on once
   * the list ends — but Previous from a pick and Next into one both need the
   * picks to be addressable by the same id walk as everything else.
   */
  const playerQueue = useMemo(
    () => [
      ...activeTracks,
      ...djSession.filter((t) => !activeTracks.some((r) => r.id === t.id)),
    ],
    [activeTracks, djSession],
  )
  /** The DJ button lives on folder and playlist lists only. */
  const djAvailable =
    selection.kind === 'playlist' || selection.kind === 'folder'
  // Filing feedback: every add-to-playlist path (row menu, player dialog,
  // tree drop) reports here, so a quiet no-op never passes for success.
  const [fileToast, setFileToast] = useState<string | null>(null)
  const fileToastTimer = useRef<number | undefined>(undefined)
  const showFileToast = useCallback((message: string) => {
    setFileToast(message)
    window.clearTimeout(fileToastTimer.current)
    fileToastTimer.current = window.setTimeout(() => setFileToast(null), 4000)
  }, [])
  useEffect(
    () => () => window.clearTimeout(fileToastTimer.current),
    [],
  )
  /**
   * Files one track into one playlist, saying what happened.
   *
   * The stores treat a repeat add as a silent no-op, so the check lives here:
   * "already in" is reported rather than re-announced as added. All three
   * filing paths go through this one function so the words never drift.
   */
  const handleAddToPlaylist = useCallback(
    async (playlistId: number, trackId: number) => {
      const playlist = api.playlists.find((p) => p.id === playlistId)
      const track = knownTracks.get(trackId)
      const name = playlist?.name ?? 'playlist'
      const title = track ? `“${track.title}”` : 'Track'
      let already = false
      try {
        const members = await api.playlistsForTrack(trackId)
        already = members.some((p) => p.id === playlistId)
      } catch {
        // Membership unknown: attempt the add and let the store decide.
      }
      if (already) {
        showFileToast(`${title} is already in ${name}.`)
        return
      }
      try {
        await api.addToPlaylist(playlistId, trackId)
        showFileToast(`${title} added to ${name}.`)
      } catch {
        // The store reports failures through its own banner.
      }
    },
    [api, knownTracks, showFileToast],
  )
  /** Which playlists the playing track is already in, for the player dialog. */
  const [playerMembers, setPlayerMembers] = useState<ReadonlySet<number>>(
    new Set(),
  )
  useEffect(() => {
    if (playingTrack === null) {
      setPlayerMembers(new Set())
      return
    }
    let cancelled = false
    void api
      .playlistsForTrack(playingTrack.id)
      .then((members) => {
        if (!cancelled) setPlayerMembers(new Set(members.map((p) => p.id)))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [
    playingTrack,
    api.playlistsForTrack,
    api.playlists,
    api.playlistTracks,
  ])
  /** Whether the playing track is itself a drafted pick, for the player badge. */
  const isDjSuggestion = playingTrack
    ? djSession.some((t) => t.id === playingTrack.id)
    : false
  /** What the station is growing from, named for the player badge. */
  const djSeedLabel =
    djSeedId !== null ? knownTracks.get(djSeedId) ?? null : null
  const djSeedText = djSeedLabel
    ? `${djSeedLabel.artist} — ${djSeedLabel.title}`
    : null

  /** What the tree is pointing at, named for the list header. */
  const selectionTitle = useMemo(() => {
    if (selection.kind === 'folder') {
      return api.folders.find((f) => f.id === selection.folderId)?.name ?? 'Folder'
    }
    if (selection.kind === 'playlist') {
      return (
        api.playlists.find((p) => p.id === selection.playlistId)?.name ??
        'Playlist'
      )
    }
    return 'All tracks'
  }, [selection, api.folders, api.playlists])

  /** The playlist the tree is pointing at, for the notes panel below it. */
  const selectedPlaylist = useMemo(() => {
    // Held in a local so the narrowing survives into the callback.
    const selection = api.playlistSelection
    if (selection.kind !== 'playlist') return null
    return api.playlists.find((p) => p.id === selection.playlistId) ?? null
  }, [api.playlistSelection, api.playlists])

  /**
   * The audible list's live name: the snapshot title until the folders and
   * playlists arrive, then whatever they call it now — so a rename while it
   * plays shows up in the "Now playing …" line.
   */
  const activeTitle = useMemo(() => {
    if (!activeTracklist) return ''
    const current = activeTracklist.selection
    if (current.kind === 'folder') {
      return (
        api.folders.find((f) => f.id === current.folderId)?.name ??
        activeTracklist.title
      )
    }
    if (current.kind === 'playlist') {
      return (
        api.playlists.find((p) => p.id === current.playlistId)?.name ??
        activeTracklist.title
      )
    }
    return 'All tracks'
  }, [activeTracklist, api.folders, api.playlists])

  /**
   * Puts the audible list back on screen: its tree selection and its
   * filters, as they were when Play was pressed. Opens the folder chain so
   * a restored playlist buried in a closed folder is visible. The panels'
   * folded state is left alone — a collapsed Filters section stays collapsed,
   * the way the Library view already behaves.
   */
  const restoreActiveTracklist = useCallback(() => {
    if (!activeTracklist) return
    api.setPlaylistSelection(activeTracklist.selection)
    api.setFilter({
      ...activeTracklist.filter,
      genres: [...activeTracklist.filter.genres],
    })
    const current = activeTracklist.selection
    if (current.kind === 'folder') {
      treeFolders.openFolder(current.folderId)
    } else if (current.kind === 'playlist') {
      const playlist = api.playlists.find((p) => p.id === current.playlistId)
      let folderId = playlist?.folderId ?? null
      const guard = new Set<number>()
      while (folderId !== null && !guard.has(folderId)) {
        guard.add(folderId)
        treeFolders.openFolder(folderId)
        folderId =
          api.folders.find((f) => f.id === folderId)?.parentId ?? null
      }
    }
  }, [activeTracklist, api, treeFolders])

  // Membership for the card. Re-read whenever the library or the card changes,
  // so adding or removing a playlist updates the list in place.
  useEffect(() => {
    if (cardId === null) {
      setCardPlaylists([])
      return
    }
    let cancelled = false
    void api.playlistsForTrack(cardId).then((playlists) => {
      if (!cancelled) setCardPlaylists(playlists)
    })
    return () => {
      cancelled = true
    }
  }, [cardId, api.playlistsForTrack, api.playlists, api.playlistTracks])

  const backfill = useInfoBackfill(
    useCallback(
      (trackId: number, patch: TrackPatch) => api.patchTrackFields(trackId, patch),
      [api],
    ),
    // Re-read once the run has ended, so the genres it found appear in the
    // facet list in one step instead of climbing one track at a time.
    useCallback(() => void api.refresh(), [api]),
  )

  const lyricsBackfill = useLyricsBackfill(
    useCallback(
      (
        trackId: number,
        patch: { lyrics: string; lyricsSource: string },
      ) => api.updateTrack(trackId, patch),
      [api],
    ),
    // Re-read once the run has ended, so words it found reach the lyrics
    // panel in one step rather than whenever the track is next touched.
    useCallback(() => void api.refresh(), [api]),
  )

  /**
   * Tracks that were already in the library when the app opened, plus tracks
   * whose initial lookup has already run in a previous session.
   *
   * Automatic background lookups must only run the first time a library is
   * loaded (via Import / Replace) or when new tracks arrive outside the add
   * dialog — never when closing and re-opening the app.
   */
  const checkedLookupKeys = useRef<Set<string> | null>(null)
  if (checkedLookupKeys.current === null) {
    const initialKeys = readCheckedLookupKeys()
    for (const track of api.tracks) {
      initialKeys.add(trackLookupKey(track))
    }
    checkedLookupKeys.current = initialKeys
  }
  const arrivedAt = useRef<Set<string> | null>(null)

  const handleAddTrack = useCallback(
    async (payload: Parameters<Library['addTrack']>[0]) => {
      // `AddTrackDialog` already looks up artist info and lyrics before calling
      // `onAdd`, so record this track as checked now to avoid a duplicate
      // background sweep right after saving or on subsequent launches.
      const key = trackLookupKey(payload)
      checkedLookupKeys.current?.add(key)
      arrivedAt.current?.add(key)
      if (checkedLookupKeys.current) {
        writeCheckedLookupKeys(checkedLookupKeys.current)
      }
      return api.addTrack(payload)
    },
    [api],
  )

  /**
   * Unified background lookup for newly imported/loaded tracks that have never
   * been checked before. Waits until `library` is connected so the Frame-1
   * cached state (`library === null`) never mistakes an uninitialized store
   * for an empty library.
   */
  useEffect(() => {
    if (!library || api.loading) return
    let cancelled = false
    void api.listAllTracks().then((tracks) => {
      if (cancelled) return
      const checked = checkedLookupKeys.current ?? new Set<string>()
      checkedLookupKeys.current = checked

      if (arrivedAt.current === null) {
        // Initial database load on startup: mark every existing track as
        // already present and checked so re-opening the app never re-runs
        // info or lyrics lookups.
        const initial = new Set<string>()
        let dirty = false
        for (const track of tracks) {
          const key = trackLookupKey(track)
          initial.add(key)
          if (!checked.has(key)) {
            checked.add(key)
            dirty = true
          }
        }
        arrivedAt.current = initial
        if (dirty) writeCheckedLookupKeys(checked)
        return
      }

      const here = arrivedAt.current
      const arrived: TrackWithSources[] = []
      let dirty = false
      for (const track of tracks) {
        const key = trackLookupKey(track)
        if (!here.has(key) && !checked.has(key)) {
          arrived.push(track)
        }
        here.add(key)
        if (!checked.has(key)) {
          checked.add(key)
          dirty = true
        }
      }
      if (dirty) writeCheckedLookupKeys(checked)
      if (!arrived.length) return

      void backfill.sweep(arrived.map(backfillCandidate))
      void lyricsBackfill.sweep(
        arrived.map(lyricsCandidate),
        (id) => {
          const current = knownTracks.get(id)
          return !current || !current.lyrics?.trim()
        },
      )
    })
    return () => {
      cancelled = true
    }
  }, [
    library,
    api.loading,
    api.listAllTracks,
    api.tracks,
    knownTracks,
    backfill.sweep,
    lyricsBackfill.sweep,
  ])

  /** Marks a DJ pick heard, so it leaves Up next but stays reachable. */
  const markDjHeard = useCallback((id: number) => {
    if (djHeardRef.current.has(id)) return
    djHeardRef.current.add(id)
    setDjHeard((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  /**
   * Moves playback by one track within the audible queue.
   *
   * Past the end it wraps only when repeat is on; with repeat off and the DJ
   * off the list simply stops, which is what makes the repeat button mean
   * something. With the DJ on, past the end opens the station's next pick —
   * repeat still wins when both are on, because "this list again" is the
   * more specific promise.
   */
  const advance = useCallback(
    (direction: 1 | -1) => {
      if (!playerQueue.length) return
      // What plays next is one decision, in `lib/shuffle.ts`, so the shuffled
      // and unshuffled paths cannot drift apart. It is given ids and returns an
      // id: nothing here reads the list's positions, which is what keeps the
      // rows where they are.
      const { next, cycle } = nextTrackId({
        ids: playerQueue.map((t) => t.id),
        current: playingTrack?.id ?? null,
        direction,
        repeat,
        shuffle,
        cycle: shuffleCycle.current,
      })
      shuffleCycle.current = cycle
      if (next === null) {
        if (direction === 1 && djOn) {
          const head = djSession.find((t) => !djHeardRef.current.has(t.id))
          if (head) {
            markDjHeard(head.id)
            setPlayingTrack(head)
          }
        }
        return
      }
      const drawn = playerQueue.find((t) => t.id === next)
      if (!drawn) return
      // A pick reached through the normal walk — a shuffle draw, or Next from
      // the rows — counts as heard the same as one opened past the end.
      if (direction === 1 && djOn && djSession.some((t) => t.id === drawn.id)) {
        markDjHeard(drawn.id)
      }
      setPlayingTrack(drawn)
    },
    [playerQueue, playingTrack, repeat, shuffle, djOn, djSession, markDjHeard],
  )

  /** Starts or stops the station, seeding it from what is playing. */
  const toggleDj = useCallback(() => {
    if (djOn) {
      setDjOn(false)
      setDjSession([])
      setDjHeard(new Set())
      djHeardRef.current = new Set()
      setDjSeedId(null)
      return
    }
    // The seed is what is playing, or the top of the audible list when
    // nothing is: a station Deejayed from silence still needs a first record.
    // The audible snapshot wins over the rows on screen, so arming the DJ
    // while browsing never re-seeds it from the wrong list.
    setDjSeedId(playingTrack?.id ?? activeTracks[0]?.id ?? rows[0]?.id ?? null)
    setDjOn(true)
  }, [djOn, playingTrack, activeTracks, rows])

  // The station belongs to the audible snapshot, not to the browsed view:
  // leaving a folder or playlist must not switch it off, or exploring the
  // library would silence the very list it continues. It ends only when
  // toggled off (here or from the player).

  /**
   * Keeps fewer than three picks waiting, drafting more when it runs low.
   *
   * Runs as an effect rather than inside `advance` so the end-of-queue path
   * stays synchronous: by the time the list runs out, the picks are already
   * there. The seed follows what is playing, so a station that started on
   * metal and wandered somewhere better keeps wandering from where it is.
   */
  useEffect(() => {
    if (!djOn || djRefilling.current) return
    const waiting = djSession.filter((t) => !djHeardRef.current.has(t.id)).length
    if (waiting >= 3) return
    djRefilling.current = true
    void (async () => {
      try {
        const [all, plays, groups] = await Promise.all([
          api.listAllTracks(),
          api.listRecentPlays(200),
          api.listPlaylistGroups(),
        ])
        // The audible list's own tracks are never drafted: a pick that is
        // also a row would walk straight back into the list instead of past
        // it. Picks already waiting or heard are always excluded too.
        const exclude = new Set<number>()
        for (const t of djSession) exclude.add(t.id)
        for (const id of djHeardRef.current) exclude.add(id)
        for (const t of activeTracks) exclude.add(t.id)
        const picks = draftDjPicks({
          tracks: all,
          seedTrackId: playingTrack?.id ?? djSeedId,
          plays,
          playlistGroups: groups,
          count: DJ_REFILL_COUNT,
          excludeIds: exclude,
        })
        if (picks.length) {
          setDjSession((prev) => {
            const heard = djHeardRef.current
            // Heard picks older than the last twenty are forgotten: Previous
            // stays useful without the session growing all evening.
            const heardTail = prev.filter((t) => heard.has(t.id)).slice(-20)
            const waiting = prev.filter((t) => !heard.has(t.id))
            const fresh = picks.filter((p) => !prev.some((q) => q.id === p.id))
            return [...heardTail, ...waiting, ...fresh]
          })
        }
      } finally {
        djRefilling.current = false
      }
    })()
  }, [djOn, djSession, djHeard, activeTracks, playingTrack, djSeedId, api])

  /** A completed listen is a vote: the player reports it, the store keeps it. */
  const handleTrackEnded = useCallback(
    (trackId: number) => {
      void api.recordPlay(trackId)
    },
    [api],
  )

  const handleFilter = useCallback(
    (patch: Partial<LibraryFilter>) => api.setFilter({ ...api.filter, ...patch }),
    [api],
  )

  /**
   * Freezes the rows on screen as the audible list.
   *
   * Only a Play press replaces the snapshot — browsing the tree or typing in
   * the filters never does — so the player keeps walking the list that was
   * started while the reader explores elsewhere.
   */
  const snapshotActiveList = useCallback(
    (tracks: TrackWithSources[]) => {
      setActiveTracklist({
        selection: api.playlistSelection,
        filter: { ...api.filter, genres: [...api.filter.genres] },
        trackIds: tracks.map((t) => t.id),
        title: selectionTitle,
      })
      setActiveSnapshot(tracks)
    },
    [api.playlistSelection, api.filter, selectionTitle],
  )

  /** A row's play button: starts this track now, without opening its card. */
  const playTrack = useCallback(
    (track: TrackWithSources) => {
      // Playing does not navigate: the dock is already showing what is on, and
      // a row press that threw the reader out of their list was the reason the
      // old narrow layout felt like two apps.
      // The row's list becomes the audible one, so Next walks what was on
      // screen at press time rather than whatever is browsed to afterwards.
      snapshotActiveList(queue.some((t) => t.id === track.id) ? queue : [track])
      // A track picked by hand is one the shuffle must not deal back later in the
      // same pass — it has been heard, however it was chosen.
      shuffleCycle.current = notePlayed(shuffleCycle.current, track.id)
      setPlayingTrack(track)
      setIsPlaying(true)
      setPlayToken((token) => token + 1)
    },
    [queue, snapshotActiveList],
  )

  /**
   * Starts or pauses the whole list — the list header's Play/Pause button.
   *
   * When this list is already the audible one and has a loaded track, pressing
   * the button toggles pause/resume in place. Otherwise it snapshots the rows
   * on screen and starts from the first row (or a drawn row when shuffle is on).
   */
  const playList = useCallback(() => {
    if (!queue.length) return
    const alreadyAudible =
      activeTracklist !== null &&
      sameSelection(activeTracklist.selection, api.playlistSelection)
    if (alreadyAudible && playingTrack !== null) {
      setIsPlaying((prev) => !prev)
      setTogglePlayToken((token) => token + 1)
      return
    }
    // Pressing Play makes these rows the audible list — with the shuffle,
    // repeat and DJ settings as they stand — and browsing afterwards leaves
    // them alone until the next Play press.
    snapshotActiveList(queue)
    const { next, cycle } = openingTrack({
      ids: queue.map((track) => track.id),
      current: playingTrack?.id ?? null,
      shuffle,
      cycle: shuffleCycle.current,
    })
    shuffleCycle.current = cycle
    const drawn = queue.find((track) => track.id === next) ?? queue[0]
    shuffleCycle.current = notePlayed(shuffleCycle.current, drawn.id)
    setPlayingTrack(drawn)
    setIsPlaying(true)
    setPlayToken((token) => token + 1)
  }, [
    queue,
    activeTracklist,
    api.playlistSelection,
    playingTrack,
    shuffle,
    snapshotActiveList,
  ])

  // Refresh the active queue snapshot once the library finishes loading, and
  // fall back to `trackvault.playingId` if an older session stored only the ID.
  useEffect(() => {
    if (api.loading || sessionRestoredRef.current) return
    sessionRestoredRef.current = true
    const storedPlayingId = readStored<number | null>('trackvault.playingId', null)
    if (activeTracklist && activeSnapshot.length === 0) {
      const resolved: TrackWithSources[] = []
      for (const id of activeTracklist.trackIds) {
        const match = knownTracks.get(id)
        if (match) resolved.push(match)
      }
      if (resolved.length > 0) setActiveSnapshot(resolved)
    }
    if (playingTrack === null && typeof storedPlayingId === 'number') {
      const restored = knownTracks.get(storedPlayingId)
      if (restored) setPlayingTrack(restored)
    }
  }, [api.loading, activeTracklist, activeSnapshot.length, knownTracks, playingTrack])

  useEffect(() => {
    writeStored('trackvault.nav', nav)
  }, [nav])

  useEffect(() => {
    writeStored('trackvault.pane', pane)
  }, [pane])

  useEffect(() => {
    writeStored('trackvault.sort', sort)
  }, [sort])

  useEffect(() => {
    writeStored('trackvault.shuffle', shuffle)
  }, [shuffle])

  useEffect(() => {
    writeStored('trackvault.repeat', repeat)
  }, [repeat])

  useEffect(() => {
    writeStored('trackvault.activeTracklist', activeTracklist)
  }, [activeTracklist])

  useEffect(() => {
    writeStored('trackvault.activeSnapshot', activeSnapshot)
  }, [activeSnapshot])

  useEffect(() => {
    writeStored('trackvault.playingTrack', playingTrack)
    writeStored('trackvault.playingId', playingTrack ? playingTrack.id : null)
  }, [playingTrack])

  /**
   * One history entry per screen, so the back gesture is the app's own.
   *
   * Without this, Android's back button closes the tab from three screens deep,
   * which reads as a crash. Opening a level pushes an entry; going back through
   * the chevrons walks the history back with it, and the popstate listener is
   * what turns the hardware gesture into the same reducer action.
   */
  const depth = useRef(navDepth(nav.tab, nav.listOpen))
  const selfPop = useRef(false)
  useEffect(() => {
    const onPop = () => {
      if (selfPop.current) {
        selfPop.current = false
        return
      }
      dispatchNav({ type: 'back' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    const next = navDepth(nav.tab, nav.listOpen)
    if (next > depth.current) {
      window.history.pushState({ depth: next }, '')
    } else if (next < depth.current) {
      selfPop.current = true
      window.history.back()
    }
    depth.current = next
  }, [nav.tab, nav.listOpen])

  const openCard = useCallback((track: TrackWithSources, edit = false) => {
    setCardId(track.id)
    setCardEdit(edit)
  }, [])

  const deleteFromCard = useCallback(
    (track: TrackWithSources) => {
      void api
        .deleteTrack(track.id)
        .catch(() => undefined)
        .finally(() => setCardId(null))
      setPlayingTrack((current) =>
        current && current.id === track.id ? null : current,
      )
    },
    [api],
  )

  /**
   * Deletes a track from the tracklist's own menu.
   *
   * The confirmation lives here rather than in the menu, so deleting from the
   * list and deleting from the card ask the same question in the same words —
   * and so the menu does not get to be the only place a track can vanish from
   * without anything having asked.
   */
  const deleteFromList = useCallback(
    (track: TrackWithSources) => {
      if (
        !window.confirm(
          `Delete "${track.title}" from the library? This cannot be undone.`,
        )
      ) {
        return
      }
      if (cardId === track.id) setCardId(null)
      setPlayingTrack((current) =>
        current && current.id === track.id ? null : current,
      )
      void api.deleteTrack(track.id).catch(() => undefined)
    },
    [api, cardId],
  )

  const downloadExport = useCallback(async () => {
    const json = await api.exportLibrary()
    if (json) {
      downloadJson(json, `trackvault-${new Date().toISOString().slice(0, 10)}.json`)
    }
  }, [api])

  /**
   * Saves the library to disk before a replace empties it.
   *
   * Replace is the one action that deletes tracks the incoming file does not
   * contain, so the library being replaced is written out first, stamped to the
   * minute so two replaces in an afternoon cannot overwrite each other's
   * backup. A downloaded export is the same document Import reads back, which
   * is why this works for both stores.
   */
  const backupBeforeReplace = useCallback(async () => {
    const json = await api.exportLibrary()
    if (!json) return false
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
    downloadJson(json, `trackvault-backup-${stamp}.json`)
    return true
  }, [api])

  const importFromFile = useCallback(
    async (file: File) => {
      await api.importLibrary(await file.text())
    },
    [api],
  )

  /**
   * Replaces the library with the confirmed file, then drops whatever pointed
   * at the old one: a playing or open track the file did not contain would
   * otherwise linger as a ghost of a deleted row.
   */
  const confirmReplace = useCallback(async () => {
    if (!replaceFile) return
    setReplacePending(true)
    try {
      // Nothing is deleted unbacked: if the copy cannot be written, the replace
      // is abandoned rather than leaving the library with no way back.
      if (!(await backupBeforeReplace())) {
        showFileToast(
          'Replace cancelled — the current library could not be backed up.',
        )
        return
      }
      await api.replaceLibrary(replaceFile.text)
      const remaining = new Set((await api.listAllTracks()).map((t) => t.id))
      setPlayingTrack((current) =>
        current && remaining.has(current.id) ? current : null,
      )
      setCardId((id) => (id !== null && remaining.has(id) ? id : null))
    } finally {
      setReplacePending(false)
      setReplaceFile(null)
    }
  }, [api, replaceFile, backupBeforeReplace, showFileToast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      if (typing) return
      if (e.key === '?') {
        setShortcutsOpen((open) => !open)
        return
      }
      // Escape leaves the player screen, but never out from under a dialog that
      // is already using the key to close itself. Asking the dialogs' own stack
      // rather than looking for a backdrop element keeps this one rule: a
      // dialog counts as open when it registered, not when it rendered.
      if (e.key === 'Escape' && !hasOpenEscapeLayer()) {
        if (nav.tab === 'playing') dispatchNav({ type: 'tab', tab: 'library' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav.tab])

  /** Opening a list: on a phone that is a screen, on a desktop a column. */
  const openList = (next: PlaylistSelection) => {
    api.setPlaylistSelection(next)
    dispatchNav({ type: 'openList' })
  }

  const editDescription = () => {
    if (selection.kind !== 'playlist') return
    const playlist = api.playlists.find((p) => p.id === selection.playlistId)
    if (!playlist) return
    const next = window.prompt(
      'Describe this playlist',
      playlist.description ?? '',
    )
    if (next === null) return
    void api.setPlaylistDescription(playlist.id, next.trim() || null)
  }

  const renameSelection = () => {
    if (selection.kind === 'playlist') {
      const playlist = api.playlists.find((p) => p.id === selection.playlistId)
      if (!playlist) return
      const next = window.prompt('Rename this playlist', playlist.name)
      if (next && next.trim()) void api.renamePlaylist(playlist.id, next.trim())
    } else if (selection.kind === 'folder') {
      const folder = api.folders.find((f) => f.id === selection.folderId)
      if (!folder) return
      const next = window.prompt('Rename this folder', folder.name)
      if (next && next.trim()) void api.renameFolder(folder.id, next.trim())
    }
  }

  const deleteSelection = () => {
    if (selection.kind === 'playlist') {
      const playlist = api.playlists.find((p) => p.id === selection.playlistId)
      if (!playlist) return
      if (!window.confirm(`Delete the playlist “${playlist.name}”?`)) return
      void api.deletePlaylist(playlist.id)
      dispatchNav({ type: 'closeList' })
    } else if (selection.kind === 'folder') {
      const folder = api.folders.find((f) => f.id === selection.folderId)
      if (!folder) return
      if (
        !window.confirm(
          `Delete the folder “${folder.name}”? Its playlists move to the top level.`,
        )
      ) {
        return
      }
      void api.deleteFolder(folder.id)
      dispatchNav({ type: 'closeList' })
    }
  }

  const listMenu: ContextMenuItem[] = []
  if (selection.kind !== 'all') {
    listMenu.push({
      key: 'rename',
      label: selection.kind === 'playlist' ? 'Rename playlist…' : 'Rename folder…',
      onSelect: renameSelection,
    })
  }
  if (selection.kind === 'playlist') {
    listMenu.push({
      key: 'description',
      label: 'Edit description…',
      onSelect: editDescription,
    })
  }
  listMenu.push({
    key: 'add',
    label: 'Add a track…',
    group: 'Tracks',
    onSelect: () => setDialogOpen(true),
  })
  if (selection.kind !== 'all') {
    listMenu.push({
      key: 'delete',
      label: selection.kind === 'playlist' ? 'Delete playlist' : 'Delete folder',
      group: 'Danger',
      danger: true,
      onSelect: deleteSelection,
    })
  }

  const isAudibleList = activeTracklist
    ? sameSelection(activeTracklist.selection, selection)
    : false

  const listKind: 'all' | 'folder' | 'playlist' =
    selection.kind === 'folder'
      ? 'folder'
      : selection.kind === 'playlist'
        ? 'playlist'
        : 'all'

  /**
   * One shuffle switch for the two places it appears — the list header and the
   * queue — so the two can never disagree about the pass's cycle.
   */
  const toggleShuffle = useCallback(() => {
    setShuffle((on) => !on)
    // Either way the next pass starts clean, so the first draw after the
    // toggle is a real choice rather than a leftover.
    shuffleCycle.current = emptyCycle()
  }, [])

  const toggleRepeat = useCallback(() => setRepeat((on) => !on), [])

  const listColumn = (
    <>
      <ListHeader
        title={selectionTitle}
        kind={listKind}
        tracks={rows}
        description={selectedPlaylist?.description ?? null}
        isAudible={isAudibleList}
        isPlaying={isPlaying}
        onPlayList={rows.length ? playList : null}
        shuffle={shuffle}
        repeat={repeat}
        onToggleShuffle={toggleShuffle}
        onToggleRepeat={toggleRepeat}
        djOn={djOn}
        onToggleDj={djAvailable ? toggleDj : null}
        menuItems={listMenu}
        playingFrom={activeTitle && !isAudibleList ? activeTitle : null}
        onShowPlayingFrom={restoreActiveTracklist}
      />

      <TracklistToolbar
        facets={api.facets}
        filter={api.filter}
        onChange={handleFilter}
        onToggleGenre={api.toggleGenre}
        onClear={api.clearFilter}
        sort={sort}
        onSortChange={setSort}
        shown={rows.length}
      />

      <div className="list-scroll">
        <TrackList
          tracks={rows}
          playingId={playingTrack?.id ?? null}
          onPlay={playTrack}
          onOpenCard={openCard}
          onDelete={deleteFromList}
          playlists={api.playlists}
          onAddToPlaylist={handleAddToPlaylist}
          onPlaylistsForTrack={api.playlistsForTrack}
          // Re-ordering belongs to a playlist and nowhere else, and never while
          // filtering: the rows on show are then a subset, and an index into
          // the subset is not an index into the playlist.
          reorderable={openPlaylistId !== null}
          onReorder={
            openPlaylistId === null || filtering
              ? undefined
              : (trackId, toIndex) =>
                  void api.movePlaylistTrack(openPlaylistId, trackId, toIndex)
          }
          onRemoveFromPlaylist={
            openPlaylistId === null
              ? undefined
              : (track) => void api.removeFromPlaylist(openPlaylistId, track.id)
          }
          emptyLabel={
            filtering
              ? 'No tracks match these filters. Remove one below the search box to widen the list.'
              : api.totalCount === 0
                ? 'This library is empty. Add a track with the button at the top right, or bring a whole library in with Import on the You screen.'
                : 'This list is empty. Add tracks to it from any row\u2019s \u22ef menu, or drag one in.'
          }
        />
      </div>
    </>
  )

  /**
   * The library column's width, dragged from its own edge.
   *
   * A playlist called "Everything I listened to in the autumn of 2019" is the
   * normal case, not the edge case: a fixed 300px column truncates it, and the
   * only way to read it was to open the list. The width is clamped so the list
   * beside it can never be squeezed to nothing, and remembered so the window
   * comes back the shape it was left.
   */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(stored) && stored >= SIDEBAR_MIN ? stored : SIDEBAR_DEFAULT
  })
  const resizing = useRef(false)

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizing.current) return
      setSidebarWidth(clampSidebarWidth(event.clientX))
    }
    const onUp = () => {
      if (!resizing.current) return
      resizing.current = false
      document.body.classList.remove('dragging-col')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebarWidth)))
  }, [sidebarWidth])

  const treeProps = {
    folders: api.folders,
    playlists: api.playlists,
    selection: api.playlistSelection,
    totalCount: api.totalCount,
    expanded: treeFolders.expanded,
    onToggleFolder: treeFolders.toggleFolder,
    onOpenFolder: treeFolders.openFolder,
    onExpandAll: treeFolders.expandAll,
    onCollapseAll: treeFolders.collapseAll,
    onSelect: (next: PlaylistSelection) => openList(next),
    onCreateFolder: (name: string, parentId: number | null) =>
      void api.createFolder(name, parentId),
    onCreatePlaylist: (name: string, folderId: number | null) =>
      void api.createPlaylist(name, undefined, folderId),
    onDeleteFolder: (id: number) => void api.deleteFolder(id),
    onDeletePlaylist: (id: number) => void api.deletePlaylist(id),
    onRenameFolder: (id: number, name: string) => void api.renameFolder(id, name),
    onRenamePlaylist: (id: number, name: string) =>
      void api.renamePlaylist(id, name),
    onMovePlaylist: (id: number, folderId: number | null) =>
      void api.movePlaylist(id, folderId),
    onMoveFolder: (id: number, parentId: number | null) =>
      void api.moveFolder(id, parentId),
    onAddTrackToPlaylist: handleAddToPlaylist,
  }

  if (bootError) {
    return (
      <main className="boot">
        <h1>TrackVault could not start</h1>
        <p className="error">{bootError}</p>
      </main>
    )
  }

  return (
    <div className={`app layout-${layout} tab-${nav.tab}`}>
      {!singlePane && (
        <TopBar
          mode={layout}
          tab={nav.tab}
          sidebarOpen={nav.sidebarOpen}
          onToggleSidebar={() => dispatchNav({ type: 'toggleSidebar' })}
          onBrowse={() => dispatchNav({ type: 'browse' })}
          onAddTrack={() => setDialogOpen(true)}
          onOpenYou={() => dispatchNav({ type: 'tab', tab: 'you' })}
        />
      )}

      <div className="body">
        {/* The library column. A desktop keeps it beside the list because
            dragging a row onto a playlist is the fastest way to file it. */}
        {layout === 'desktop' && nav.sidebarOpen && (
          <aside
            className="sidebar"
            style={{ width: `${sidebarWidth}px` }}
            aria-label="Library"
          >
            <div className="sidebar-head">
              <span>Library</span>
              <button
                type="button"
                className="icon-btn round"
                title="Hide the library column"
                aria-label="Hide the library column"
                onClick={() => dispatchNav({ type: 'toggleSidebar' })}
              >
                <ChevronLeftIcon size={16} />
              </button>
            </div>
            <div className="sidebar-scroll">
              <PlaylistTree {...treeProps} />
            </div>
            {/* The edge of the column is the control: no handle to hunt for, no
                width setting buried in a dialog. Double-click resets it. */}
            <div
              className="sidebar-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the library column"
              aria-valuenow={Math.round(sidebarWidth)}
              aria-valuemin={SIDEBAR_MIN}
              aria-valuemax={SIDEBAR_MAX}
              tabIndex={0}
              onPointerDown={(e) => {
                e.preventDefault()
                resizing.current = true
                document.body.classList.add('dragging-col')
              }}
              onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') {
                  e.preventDefault()
                  setSidebarWidth((w) => clampSidebarWidth(w - 16))
                }
                if (e.key === 'ArrowRight') {
                  e.preventDefault()
                  setSidebarWidth((w) => clampSidebarWidth(w + 16))
                }
              }}
            />
          </aside>
        )}

        <main className="content">
          {singlePane && nav.tab === 'library' && !nav.listOpen && (
            <div className="screen">
              <LibraryBrowser
                folders={api.folders}
                playlists={api.playlists}
                selection={selection}
                totalCount={api.totalCount}
                onOpen={openList}
                onCreateFolder={(name, parentId) =>
                  void api.createFolder(name, parentId)
                }
                onCreatePlaylist={(name, folderId) =>
                  void api.createPlaylist(name, undefined, folderId)
                }
                onDeleteFolder={(id) => void api.deleteFolder(id)}
                onDeletePlaylist={(id) => void api.deletePlaylist(id)}
                onRenameFolder={(id, name) => void api.renameFolder(id, name)}
                onRenamePlaylist={(id, name) => void api.renamePlaylist(id, name)}
                onSearch={(term) => {
                  api.setFilter({ ...api.filter, search: term })
                  openList({ kind: 'all' })
                }}
                onAddTrack={() => setDialogOpen(true)}
              />
            </div>
          )}

          {((singlePane && nav.tab === 'library' && nav.listOpen) ||
            (layout === 'desktop' && nav.tab === 'library')) && (
            <div className="screen list-screen">
              {singlePane && (
                <header className="screen-head">
                  <button
                    type="button"
                    className="screen-back"
                    onClick={() => dispatchNav({ type: 'closeList' })}
                    aria-label="Back to the library"
                  >
                    <ChevronLeftIcon />
                    <span>Library</span>
                  </button>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="icon-btn round"
                    onClick={() => setDialogOpen(true)}
                    aria-label="Add a track"
                    title="Add a track"
                  >
                    ＋
                  </button>
                </header>
              )}
              {listColumn}
            </div>
          )}


          {/* The player screen on a desktop is an overlay over the content, so
              the list keeps its place and scroll behind it. */}
          {layout === 'desktop' && nav.tab === 'playing' && (
            <button
              type="button"
              className="player-scrim"
              aria-label="Close the player"
              onClick={() => dispatchNav({ type: 'tab', tab: 'library' })}
            />
          )}
        </main>
      </div>

      {/* One player, moved rather than copied: docked it is the bar at the
          bottom, expanded it is the screen. Nothing about the stream is
          re-created on the way, so opening the player never interrupts it. */}
      {/* A desktop opens the player as a sheet over the window, so it needs
          something to press to leave: the scrim is that target, and it is
          rendered before the host so the sheet stays on top. */}
      {expanded && !singlePane && (
        <button
          type="button"
          className="player-scrim"
          aria-label="Close the player"
          onClick={() => dispatchNav({ type: 'tab', tab: 'library' })}
        />
      )}
      <div className={expanded ? 'player-host expanded' : 'player-host docked'}>
        <Player
          variant={expanded ? 'full' : 'dock'}
          track={playingTrack}
          view={playbackView}
          playToken={playToken}
          toggleToken={togglePlayToken}
          onPlayingChange={setIsPlaying}
          queue={playerQueue}
          onAdvance={advance}
          onViewChange={setPlaybackView}
          onExpand={() => dispatchNav({ type: 'tab', tab: 'playing' })}
          onCollapse={() => dispatchNav({ type: 'tab', tab: 'library' })}
          onOpenLibrary={() => dispatchNav({ type: 'tab', tab: 'library' })}
          pane={pane}
          onPaneChange={setPane}
          sourceTitle={activeTitle || null}
          onSelectTrack={(track) => {
            setPlayingTrack(track)
            setPlayToken((token) => token + 1)
          }}
          onDurationResolved={api.setDuration}
          onTrackEnded={handleTrackEnded}
          onCoverResolved={(id, coverUrl) => api.patchTrackFields(id, { coverUrl })}
          playlists={api.playlists}
          onAddToPlaylist={handleAddToPlaylist}
          memberPlaylistIds={playerMembers}
          djOn={djOn}
          isDjSuggestion={isDjSuggestion}
          djSeedLabel={djSeedText}
          onToggleDj={djAvailable ? toggleDj : null}
          shuffle={shuffle}
          repeat={repeat}
          onToggleShuffle={toggleShuffle}
          onToggleRepeat={toggleRepeat}
          onOpenCard={openCard}
        />
      </div>

      {singlePane && (
        <MobileNav
          tab={nav.tab}
          listOpen={nav.listOpen}
          onTab={(tab) => dispatchNav({ type: 'tab', tab })}
          onBrowse={() => dispatchNav({ type: 'browse' })}
        />
      )}

      {api.error && (
        <div className="banner error" role="alert">
          {api.error}
          <button
            type="button"
            className="ghost icon-btn"
            onClick={api.dismissError}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {api.notice && (
        <div className="banner notice" role="status">
          {api.notice}
          <button
            type="button"
            className="ghost icon-btn"
            onClick={api.dismissNotice}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <AgentBanner
        report={api.mergeReport}
        inboxPending={api.inboxPending}
        onDismiss={api.dismissMergeReport}
      />

      {fileToast && (
        <div className="banner notice file-toast" role="status">
          {fileToast}
          <button
            type="button"
            className="ghost icon-btn"
            onClick={() => {
              window.clearTimeout(fileToastTimer.current)
              setFileToast(null)
            }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {(backfill.progress.running ||
        backfill.summary ||
        lyricsBackfill.progress.running ||
        lyricsBackfill.summary) && (
        <div className="lookup-status">
          {backfill.progress.running ? (
            <p className="backfill-status" role="status">
              <span>
                Looking up {backfill.progress.done + 1} of{' '}
                {backfill.progress.total}
                {backfill.progress.current ? ` — ${backfill.progress.current}` : ''}
              </span>
              <span className="backfill-bar">
                <span
                  style={{
                    width: `${Math.round(
                      (backfill.progress.done /
                        Math.max(1, backfill.progress.total)) *
                        100,
                    )}%`,
                  }}
                />
              </span>
              <button type="button" className="ghost-btn" onClick={backfill.cancel}>
                Stop
              </button>
            </p>
          ) : backfill.summary ? (
            <p className="backfill-status done" role="status">
              <span>{summariseBackfill(backfill.summary)}</span>
              <button
                type="button"
                className="ghost icon-btn"
                aria-label="Dismiss"
                onClick={backfill.dismissSummary}
              >
                ✕
              </button>
            </p>
          ) : null}
          {lyricsBackfill.progress.running ? (
            <p className="backfill-status" role="status">
              <span>
                Looking up lyrics {lyricsBackfill.progress.done + 1} of{' '}
                {lyricsBackfill.progress.total}
                {lyricsBackfill.progress.current
                  ? ` — ${lyricsBackfill.progress.current}`
                  : ''}
              </span>
              <span className="backfill-bar">
                <span
                  style={{
                    width: `${Math.round(
                      (lyricsBackfill.progress.done /
                        Math.max(1, lyricsBackfill.progress.total)) *
                        100,
                    )}%`,
                  }}
                />
              </span>
              <button
                type="button"
                className="ghost-btn"
                onClick={lyricsBackfill.cancel}
              >
                Stop
              </button>
            </p>
          ) : lyricsBackfill.summary ? (
            <p className="backfill-status done" role="status">
              <span>{summariseLyricsBackfill(lyricsBackfill.summary)}</span>
              <button
                type="button"
                className="ghost icon-btn"
                aria-label="Dismiss"
                onClick={lyricsBackfill.dismissSummary}
              >
                ✕
              </button>
            </p>
          ) : null}
        </div>
      )}

      <AddTrackDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdd={handleAddTrack}
        playlists={api.playlists}
        onAddToPlaylist={api.addToPlaylist}
      />

      {/* Before the card, so the card opens above it: fixing a flagged row
          keeps the health list underneath to work through. */}
      {replaceFile && (
        <ReplaceLibraryDialog
          fileName={replaceFile.name}
          fileText={replaceFile.text}
          pending={replacePending}
          onCancel={() => {
            if (!replacePending) setReplaceFile(null)
          }}
          onConfirm={() => void confirmReplace()}
        />
      )}

      <LinkHealthDialog
        open={linkHealthOpen}
        onClose={() => setLinkHealthOpen(false)}
        onListTracks={api.listAllTracks}
        onRemoveSource={api.removeSource}
        onFileIssues={api.fileIssues}
        onRefresh={() => void api.refresh()}
        onOpenCard={openCard}
      />

      <TrackCardDialog
        track={cardTrack}
        startInEdit={cardEdit}
        memberPlaylists={cardPlaylists}
        allPlaylists={api.playlists}
        onClose={() => setCardId(null)}
        onPlay={(track: TrackWithSources) => {
          playTrack(track)
          setCardId(null)
        }}
        onDelete={deleteFromCard}
        onRemoveFromPlaylist={(playlistId, trackId) =>
          void api.removeFromPlaylist(playlistId, trackId)
        }
        onAddToPlaylist={handleAddToPlaylist}
        onSave={api.updateTrack}
        onSetSource={api.setSource}
        onSetMusicBrainzId={api.setMusicBrainzId}
        onSetDuration={api.setDuration}
      />

      {/* `You` is about the library file, not a place inside it: a dialog keeps
          the list you were reading behind it, and the same dialog is what a
          phone's You tab opens. */}
      {nav.tab === 'you' && (
        <div
          className="modal-backdrop"
          onClick={() => dispatchNav({ type: 'tab', tab: 'library' })}
          role="presentation"
        >
          <div
            ref={youDialog}
            className="modal you-modal"
            role="dialog"
            aria-modal="true"
            aria-label="You"
            onClick={(e) => e.stopPropagation()}
          >
            <YouScreen
              storageLabel={
                library instanceof JsonLibrary
                  ? 'data/library.json on this machine'
                  : 'this browser’s own storage (SQLite in IndexedDB)'
              }
              counts={{
                tracks: api.totalCount,
                playlists: api.playlists.length,
                folders: api.folders.length,
              }}
              onClose={() => dispatchNav({ type: 'tab', tab: 'library' })}
              onExport={() => void downloadExport()}
              onImport={(file) => void importFromFile(file)}
              onReplace={(file) => setReplaceFile(file)}
              onHealthCheck={() => setLinkHealthOpen(true)}
              onShowShortcuts={() => setShortcutsOpen(true)}
            />
          </div>
        </div>
      )}

      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      <Analytics />
    </div>
  )
}
