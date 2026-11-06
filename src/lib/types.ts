export type SourceKind =
  | 'official'
  | 'album'
  | 'live'
  | 'cover'
  | 'remix'
  | 'video'

export const SOURCE_KINDS: SourceKind[] = [
  'official',
  'album',
  'live',
  'cover',
  'remix',
  'video',
]

/**
 * A track has exactly three source slots with distinct jobs:
 *
 * - `audio` — Main: the preferred source, usually the best audio.
 * - `video` — the official video clip.
 * - `live` — an optional live performance.
 *
 * Main and the clip stand in for each other in playback, so either one alone is
 * a complete track (`hasPlayableSource` in `sources.ts`). Only a live take on
 * its own has nothing for the two main views to play.
 *
 * Roles are stored explicitly rather than inferred from list order so that
 * replacing or reordering a source can never silently swap what plays.
 */
export type SourceRole = 'audio' | 'video' | 'live'

export interface Track {
  id: number
  title: string
  artist: string
  album: string | null
  coverUrl: string | null
  year: number | null
  musicbrainzRecordingId: string | null
  /**
   * Free-text context the reader wants while the track plays: a memory about the
   * recording, a fact about the release, a line about the artist.
   *
   * Named `info` rather than `notes` because it is no longer only the user's own
   * notes — fetched background about the artist, album or track belongs here
   * too, and "notes" read as though it were a private annotation.
   */
  info: string | null
  /**
   * Lyrics saved with the track, either supplied by the user or looked up once.
   */
  lyrics: string | null
  /** Where the stored lyrics came from, such as LRCLIB or manual entry. */
  lyricsSource: string | null
  /**
   * Running time in whole seconds, or null when it is not known yet.
   *
   * Null is a normal state, not a failure: a track only gets a duration once
   * something trustworthy has supplied one — measured from its own YouTube link
   * when the link is added, or corrected by the player once it has reported a
   * real length for the stream. Storing it means the track list can show a
   * length before anything has ever been played.
   */
  duration: number | null
  createdAt: string
}

/** Hard cap: Main, the clip, and a live take — one row each. */
export const MAX_SOURCES = 3

export interface Source {
  id: number
  trackId: number
  youtubeId: string
  url: string
  kind: SourceKind
  label: string | null
  role: SourceRole
  position: number
}

export interface TrackWithSources extends Track {
  genres: string[]
  sources: Source[]
}

/**
 * A folder in the playlist tree. Folders nest arbitrarily and may hold both
 * subfolders and playlists, which is what lets a large collection stay
 * navigable without a flat list of names.
 *
 * `parentId` is null for a folder at the top level.
 */
export interface PlaylistFolder {
  id: number
  name: string
  parentId: number | null
  createdAt: string
}

export interface Playlist {
  id: number
  name: string
  description: string | null
  createdAt: string
  trackCount: number
  /** Owning folder, or null when the playlist sits at the top level. */
  folderId: number | null
}

export interface PlaylistEntry {
  playlistId: number
  trackId: number
  position: number
  track: TrackWithSources
}

export interface LibraryFilter {
  /**
   * The rail's one text field: matches title, artist or album.
   *
   * One box rather than three, because the three answer the same question —
   * "which track is this?" — and a name is usually remembered as one of them,
   * not as a field.
   */
  search: string
  /**
   * Selected genres. These are **additive**: a track matches if it carries any
   * one of them, so ticking two genres widens the list rather than narrowing it
   * to tracks tagged with both.
   */
  genres: string[]
  artist: string | null
  album: string | null
  sourceKind: SourceKind | null
  /**
   * Only tracks in no playlist at all. Off by default; replaces the old
   * "Not in a playlist" tree node, which could not be combined with search.
   */
  unfiledOnly: boolean
  /** Only tracks with a live-performance source attached. */
  hasLiveSource: boolean
}

export const EMPTY_FILTER: LibraryFilter = {
  search: '',
  genres: [],
  artist: null,
  album: null,
  sourceKind: null,
  unfiledOnly: false,
  hasLiveSource: false,
}

/** Payload used when adding a track. Every field except title/artist is optional. */
export interface NewTrack {
  title: string
  artist: string
  album?: string | null
  coverUrl?: string | null
  year?: number | null
  musicbrainzRecordingId?: string | null
  info?: string | null
  /** Lyrics supplied by hand or looked up during add. See `Track.lyrics`. */
  lyrics?: string | null
  lyricsSource?: string | null
  /** Running time in whole seconds. See `Track.duration`. */
  duration?: number | null
  genres: string[]
  sources: Array<{
    youtubeId: string
    url: string
    kind: SourceKind
    label?: string | null
    /** Defaults to `audio` for the first source and `video` after that. */
    role?: SourceRole
  }>
}

/**
 * The track fields a caller may change after the fact.
 *
 * Split out from `NewTrack` because `duration` is not something the add dialog
 * offers to type: it is written by the metadata lookup or corrected by the
 * player, never by hand. Keeping it out of the edit dialog's patch type makes it
 * impossible for a text field to clobber a measured value.
 */
export type TrackPatch = Partial<
  Pick<
    NewTrack,
    'title' | 'artist' | 'album' | 'coverUrl' | 'year' | 'info' | 'lyrics' | 'lyricsSource' | 'genres'
  >
>

// --------------------------------------------------------- the on-disk shape

/**
 * The literal contents of `data/library.json`.
 *
 * These are separate from `Track`/`Source` above because the file is a public
 * contract: it is read and written by the app, by hand, and by agents. The
 * difference is deliberate — a stored row carries no derived `position` or
 * `trackId`, because those are join results, not things anyone should type.
 *
 * They live here rather than in `jsonLibrary.ts` because the agent inbox
 * (`agentInbox.ts`) has to build and compare these exact structures.
 */

export interface StoredSource {
  id: number
  youtubeId: string
  url: string
  kind: SourceKind
  label: string | null
  role: SourceRole
}

export interface StoredTrack {
  id: number
  title: string
  artist: string
  album: string | null
  coverUrl: string | null
  year: number | null
  musicbrainzRecordingId: string | null
  info: string | null
  /**
   * Lyrics pasted by the user, or absent/null when there are none.
   *
   * Optional in the file shape because every library written before this field
   * existed simply does not have it — `normalise()` reads the absence as null.
   */
  lyrics?: string | null
  lyricsSource?: string | null
  duration: number | null
  createdAt: string
  genres: string[]
  sources: StoredSource[]
}

export interface StoredPlaylist {
  id: number
  name: string
  description: string | null
  createdAt: string
  /** Track ids, in playing order. */
  tracks: number[]
  /** Owning folder id in `folders`, or null at the top level. */
  folderId: number | null
}

export interface LibraryDocument {
  format: string
  version: number
  tracks: StoredTrack[]
  /** Folders that organise the playlists. Absent in old files, so always read
      through `normalise()` rather than trusted directly. */
  folders: PlaylistFolder[]
  playlists: StoredPlaylist[]
  /** Completed listens, oldest first. Absent in old files like `folders` was:
      `normalise()` reads the absence as empty, and both stores prune to a cap. */
  plays: PlayEvent[]
}

/**
 * One completed listen: the track that played to its end, and when.
 *
 * Telemetry, not library content: it is what lets the DJ score "what this
 * person actually plays" rather than only what they shelve. Append-only and
 * pruned to a cap by both stores, so it cannot grow without bound.
 */
export interface PlayEvent {
  trackId: number
  playedAt: string
}
