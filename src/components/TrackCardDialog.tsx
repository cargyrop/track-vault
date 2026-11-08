import { useEscape } from '../hooks/useEscape'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useCallback, useEffect, useRef, useState } from 'react'
import { searchMusicBrainz, type MbMatch } from '../lib/metadata'
import { fetchOEmbed, guessFromYouTubeTitle } from '../lib/metadata'
import { bestThumbnail } from '../lib/ytMeta'
import {
  ROLE_DEFAULT_KIND,
  ROLE_TITLE,
  sourceForRole,
} from '../lib/sources'
import { coverSourceVideoId } from '../lib/sources'
import { mergeGenres, parseGenres } from '../lib/genres'
import { formatDuration } from '../lib/format'
import {
  type SourceKind,
  type SourceRole,
  type Playlist,
  type TrackWithSources,
} from '../lib/types'
import { parseYouTubeId, watchUrl } from '../lib/youtube'
import { fetchYouTubeDuration } from '../lib/youtubeDuration'
import { canLookUpLyrics, fetchLyricsResult } from '../lib/lyrics'
import { fetchArtistFacts, EMPTY_FACTS, stripGenreLines } from '../lib/artistInfo'
import { TrackCover } from './TrackCover'

/**
 * The fields a save writes.
 *
 * One shape for the form's save and for a lookup run from the read view, so a
 * lookup that fills two fields cannot accidentally blank the other six.
 */
type CardPatch = {
  title: string
  artist: string
  album: string | null
  year: number | null
  coverUrl: string | null
  info: string | null
  genres: string[]
  lyrics: string | null
  lyricsSource: string | null
}

interface Props {
  track: TrackWithSources | null
  /**
   * Opens the card as the edit form rather than the read view.
   *
   * The player's empty Info and Lyrics panes send the reader here to write what
   * is missing, and making them press Edit first would be a second step for a
   * request they already made. A track opened any other way (a row, a search
   * result) still arrives in its read view.
   */
  startInEdit?: boolean
  /** Playlists this track is currently in. */
  memberPlaylists: Playlist[]
  /** Every playlist, for the add-to-playlist picker. */
  allPlaylists: Playlist[]
  onClose: () => void
  /**
   * Plays this track and closes the card.
   *
   * The card used to have no way to hear the thing it describes: you opened it
   * to look, then closed it and hunted for the row again. The footer carries
   * Play as its primary action, where a dialog's primary action belongs.
   */
  onPlay: (track: TrackWithSources) => void
  onDelete: (track: TrackWithSources) => void
  onRemoveFromPlaylist: (playlistId: number, trackId: number) => void
  onAddToPlaylist: (playlistId: number, trackId: number) => void
  onSave: (id: number, patch: CardPatch) => Promise<unknown>
  onSetSource: (
    trackId: number,
    role: SourceRole,
    source: {
      youtubeId: string
      url: string
      kind: string
      label: string | null
    } | null,
  ) => Promise<unknown>
  onSetMusicBrainzId: (trackId: number, mbid: string | null) => Promise<unknown>
  onSetDuration: (trackId: number, seconds: number | null) => Promise<unknown>
}

interface SlotDraft {
  link: string
  kind: SourceKind
  label: string
}

interface Draft {
  title: string
  artist: string
  album: string
  year: string
  coverUrl: string
  info: string
  genres: string
  lyrics: string
  lyricsSource: string
}

const emptyDraft = (): Draft => ({
  title: '',
  artist: '',
  album: '',
  year: '',
  coverUrl: '',
  info: '',
  genres: '',
  lyrics: '',
  lyricsSource: '',
})

/**
 * Everything about one track, and everything you can do to it.
 *
 * Opening the card is what a click on a tracklist row does, so this is where the
 * row's old actions live. It shows the whole record — including the three source
 * links — and pressing **Edit** turns the same card into a form, so editing
 * never opens a second window over the first. Saving keeps the card open so the
 * result is visible immediately.
 */
export function TrackCardDialog({
  track,
  startInEdit = false,
  memberPlaylists,
  allPlaylists,
  onClose,
  onPlay,
  onDelete,
  onRemoveFromPlaylist,
  onAddToPlaylist,
  onSave,
  onSetSource,
  onSetMusicBrainzId,
  onSetDuration,
}: Props) {
  useEscape(onClose, Boolean(track))
  const dialog = useRef<HTMLDivElement | null>(null)
  useFocusTrap(dialog, Boolean(track))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [slots, setSlots] = useState<Record<SourceRole, SlotDraft>>({
    audio: { link: '', kind: ROLE_DEFAULT_KIND.audio, label: '' },
    video: { link: '', kind: ROLE_DEFAULT_KIND.video, label: '' },
    live: { link: '', kind: ROLE_DEFAULT_KIND.live, label: '' },
  })
  const [matches, setMatches] = useState<MbMatch[]>([])
  const [busy, setBusy] = useState<'none' | 'autofill' | 'info' | 'lyrics' | 'saving'>('none')
  const [measured, setMeasured] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState('')

  /** Fills the form from the track. Used on open and to discard an edit. */
  const resetDrafts = useCallback((t: TrackWithSources) => {
    setDraft({
      title: t.title,
      artist: t.artist,
      album: t.album ?? '',
      year: t.year ? String(t.year) : '',
      coverUrl: t.coverUrl ?? '',
      info: stripGenreLines(t.info ?? ''),
      genres: t.genres.join(', '),
      lyrics: t.lyrics ?? '',
      lyricsSource: t.lyricsSource ?? '',
    })
    setSlots({
      audio: toSlotDraft('audio', sourceForRole(t.sources, 'audio') ?? undefined),
      video: toSlotDraft('video', sourceForRole(t.sources, 'video') ?? undefined),
      live: toSlotDraft('live', sourceForRole(t.sources, 'live') ?? undefined),
    })
    setMatches([])
    setError(null)
    setMeasured(null)
  }, [])

  // A new track resets the card; the same track keeps whatever mode it is in,
  // so saving does not snap the form shut mid-edit. `startInEdit` is part of the
  // reset because it is the caller saying "open this one as a form" — the
  // lyrics and info panes do, the tracklist rows do not.
  useEffect(() => {
    if (!track) return
    resetDrafts(track)
    setEditing(startInEdit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, startInEdit])

  const memberIds = new Set(memberPlaylists.map((p) => p.id))
  const candidates = allPlaylists.filter((p) => !memberIds.has(p.id))

  /** Pulls YouTube details and trusted release/artist facts in one action. */
  const autoFillFromTrustedSources = useCallback(async () => {
    if (!track) return
    setBusy('autofill')
    setMatches([])
    setError(null)
    try {
      // The link the track actually plays: the Main when there is one, the clip
      // when there is not. A clip-only track must still be measurable.
      const audioId =
        parseYouTubeId(slots.audio.link) ??
        sourceForRole(track.sources, 'audio')?.youtubeId ??
        parseYouTubeId(slots.video.link) ??
        sourceForRole(track.sources, 'video')?.youtubeId ??
        ''
      const { seconds, youtubeInfo, guess: youtubeGuess, facts, results } =
        await gatherInfo({
          title: draft.title || track.title,
          artist: draft.artist || track.artist,
          audioId,
        })
      if (seconds !== null) {
        await onSetDuration(track.id, seconds)
        setMeasured(seconds)
      }
      setMatches(results)
      setDraft((prev) => ({
        ...prev,
        title: prev.title || youtubeGuess?.title || '',
        artist: prev.artist || youtubeGuess?.artist || '',
        year: prev.year || (facts.releaseYear ? String(facts.releaseYear) : ''),
        info: mergeInfo(prev.info, facts.info),
        genres: mergeGenres(prev.genres, facts.genres),
        coverUrl: prev.coverUrl || (audioId ? bestThumbnail(audioId) : ''),
      }))
      const used: string[] = []
      if (youtubeInfo) used.push('YouTube')
      if (facts.genres.length || facts.formedYear || results.length) used.push('MusicBrainz')
      if (facts.info && facts.wikipediaUrl) used.push('Wikipedia')
      if (facts.releaseYear) used.push('iTunes')
      const sourceNote = used.length ? `Sources used: ${used.join(', ')}.` : 'No trusted source returned usable details.'
      setError(results.length
        ? `${sourceNote} Choose a MusicBrainz recording below if it matches.`
        : `${sourceNote} No MusicBrainz recording matched.`)
    } catch {
      setError('Could not retrieve some metadata. Existing edits were kept.')
    } finally {
      setBusy('none')
    }
  }, [track, slots.audio.link, slots.video.link, draft.artist, draft.title, onSetDuration])

  const lookupLyrics = useCallback(async () => {
    if (!track || !canLookUpLyrics({ title: draft.title, artist: draft.artist })) {
      setError('Enter the title and artist before looking up lyrics.')
      return
    }
    setBusy('lyrics')
    setError(null)
    const found = await fetchLyricsResult({ title: draft.title, artist: draft.artist })
    if (found) {
      setDraft((prev) => ({ ...prev, lyrics: found.text, lyricsSource: found.source }))
      setError(`Lyrics found from ${found.source}.`)
    } else setError('No lyrics were found in LRCLIB or Lyrics.ovh.')
    setBusy('none')
  }, [track, draft.title, draft.artist])

  /**
   * Looks the background text up on its own.
   *
   * The wide auto-fill above fills whatever is blank, which makes it the wrong
   * tool for a paragraph that already exists: it also moves the title, year and
   * cover. This asks only for the info and merges it, so a line written by hand
   * stays where it is and gains the found text beside it.
   */
  const lookUpInfoText = useCallback(async () => {
    if (!track) return
    setBusy('info')
    setError(null)
    try {
      const facts = await fetchArtistFacts({
        artist: draft.artist || track.artist,
        title: draft.title || track.title,
      }).catch(() => EMPTY_FACTS)
      if (!facts.info) {
        setError('No information was found for this track.')
        return
      }
      setDraft((prev) => ({ ...prev, info: mergeInfo(prev.info, facts.info) }))
      setError(
        facts.wikipediaUrl
          ? 'Info found on Wikipedia.'
          : 'Info found in the trusted sources.',
      )
    } finally {
      setBusy('none')
    }
  }, [track, draft.artist, draft.title])

  const applyMatch = useCallback(
    async (match: MbMatch) => {
      setDraft((prev) => ({
        ...prev,
        title: prev.title || match.title,
        artist: prev.artist || match.artist,
        album: prev.album || match.album || '',
        year: prev.year || (match.year ? String(match.year) : ''),
        coverUrl: prev.coverUrl || match.coverUrl || '',
        genres: mergeGenres(prev.genres, match.genres),
      }))
      setMatches([])
      if (track) await onSetMusicBrainzId(track.id, match.recordingId)
    },
    [track, onSetMusicBrainzId],
  )

  const save = useCallback(async () => {
    if (!track) return
    if (!draft.title.trim() || !draft.artist.trim()) {
      setError('Title and artist are required.')
      return
    }
    const roleIds: Record<SourceRole, string | null> = { audio: null, video: null, live: null }
    for (const role of ['audio', 'video', 'live'] as const) {
      const link = slots[role].link.trim()
      roleIds[role] = link ? parseYouTubeId(link) : null
      if (link && !roleIds[role]) {
        setError(`The ${ROLE_TITLE[role]} link could not be read. Check it and try again.`)
        return
      }
    }
    // Either half of the pair is enough: a clip with no Main plays in both
    // modes, and so does a Main with no clip.
    if (!roleIds.audio && !roleIds.video) {
      setError('Add a Main link or a video clip — the track needs one to play.')
      return
    }
    const ids = Object.values(roleIds).filter(Boolean)
    if (new Set(ids).size !== ids.length) {
      setError('Each source must use a different YouTube video.')
      return
    }

    setBusy('saving')
    try {
      await onSave(track.id, {
        title: draft.title.trim(),
        artist: draft.artist.trim(),
        album: draft.album.trim() || null,
        year: draft.year ? Number(draft.year) : null,
        coverUrl: draft.coverUrl.trim() || null,
        info: draft.info.trim() || null,
        genres: parseGenres(draft.genres),
        lyrics: draft.lyrics.trim() || null,
        lyricsSource: draft.lyrics.trim() ? draft.lyricsSource || 'Manually supplied' : null,
      })
      // The slots that now hold a link are written before the ones being
      // cleared: moving a track from Main to clip in one save must never pass
      // through a moment where neither is attached, because the store refuses
      // to leave a track with nothing to play.
      const roles = ['audio', 'video', 'live'] as const
      const order = [
        ...roles.filter((role) => roleIds[role]),
        ...roles.filter((role) => !roleIds[role]),
      ]
      for (const role of order) {
        const id = roleIds[role]
        await onSetSource(track.id, role, id ? {
          youtubeId: id,
          url: watchUrl(id),
          kind: slots[role].kind,
          label: slots[role].label.trim() || null,
        } : null)
      }
      setEditing(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save changes.')
    } finally {
      setBusy('none')
    }
  }, [track, draft, slots, onSave, onSetSource])

  if (!track) return null

  const audio = sourceForRole(track.sources, 'audio')
  const video = sourceForRole(track.sources, 'video')
  const live = sourceForRole(track.sources, 'live')


  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialog}
        className="modal track-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${track.title} track card`}
      >
        <header className="modal-header">
          <h2>{editing ? 'Edit track' : 'Track'}</h2>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {editing ? (
          <>
            {(['audio', 'video', 'live'] as const).map((role) => {
              const slot = slots[role]
              const current = sourceForRole(track.sources, role)
              return (
                <section className="field" key={role}>
                  <label htmlFor={`c-src-${role}`}>
                    {ROLE_TITLE[role]}{role === 'live' ? ' (optional)' : ''}
                  </label>
                  <input
                    id={`c-src-${role}`}
                    value={slot.link}
                    placeholder={
                      role === 'audio'
                        ? 'YouTube link or video ID'
                        : role === 'video'
                          ? 'Paste the video clip link'
                          : 'Paste the Live link (optional)'
                    }
                    onChange={(e) =>
                      setSlots((prev) => ({
                        ...prev,
                        [role]: { ...slot, link: e.target.value },
                      }))
                    }
                  />
                  <div className="row">
                    {current && (
                      <a
                        href={watchUrl(current.youtubeId)}
                        target="_blank"
                        rel="noreferrer"
                        className="mono"
                      >
                        {current.youtubeId}
                      </a>
                    )}
                  </div>
                </section>
              )
            })}

            <p className="hint">
              A track needs a Main link or a video clip. Either one plays — audio
              mode falls back to the clip, and video mode falls back to Main.
            </p>

            <div className="row">
              <button
                type="button"
                className="ghost icon-btn"
                onClick={() => void autoFillFromTrustedSources()}
                disabled={busy !== 'none'}
                aria-label="Look up details"
                title="Look up details from YouTube, MusicBrainz and Wikipedia"
              >
                <LookupIcon />
              </button>
              {track.musicbrainzRecordingId && (
                <span className="badge ok">MusicBrainz linked</span>
              )}
            </div>

            <p className="hint duration-readout">
              Length:{' '}
              <strong className="mono">
                {formatDuration(measured ?? track.duration)}
              </strong>
              <span className="muted">
                {measured === null
                  ? ' · stored; use Auto-fill to re-measure'
                  : ' · just measured from the track’s YouTube source'}
              </span>
            </p>

            {matches.length > 0 && (
              <ul className="match-list">
                {matches.map((match) => (
                  <li key={match.recordingId}>
                    <button type="button" onClick={() => void applyMatch(match)}>
                      <strong>{match.title}</strong>
                      <span>
                        {match.artist}
                        {match.album ? ` — ${match.album}` : ''}
                        {match.year ? ` (${match.year})` : ''}
                      </span>
                      {match.genres.length > 0 && <em>{match.genres.join(', ')}</em>}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <section className="grid-2">
              <div className="field">
                <label htmlFor="c-title">Title *</label>
                <input
                  id="c-title"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="c-artist">Artist *</label>
                <input
                  id="c-artist"
                  value={draft.artist}
                  onChange={(e) => setDraft({ ...draft, artist: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="c-album">Album</label>
                <input
                  id="c-album"
                  value={draft.album}
                  onChange={(e) => setDraft({ ...draft, album: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="c-year">Year</label>
                <input
                  id="c-year"
                  inputMode="numeric"
                  value={draft.year}
                  onChange={(e) => setDraft({ ...draft, year: e.target.value })}
                />
              </div>
              <div className="field span-2">
                <label htmlFor="c-genres">Genres (comma separated)</label>
                <input
                  id="c-genres"
                  value={draft.genres}
                  onChange={(e) =>
                    // Lower-cased as it is typed, matching the add dialog: one
                    // stored spelling per genre, so the facets stay clean.
                    setDraft({ ...draft, genres: e.target.value.toLowerCase() })
                  }
                />
              </div>
              <div className="field span-2">
                <label htmlFor="c-cover">Cover art URL</label>
                <div className="row">
                  <input
                    id="c-cover"
                    value={draft.coverUrl}
                    onChange={(e) =>
                      setDraft({ ...draft, coverUrl: e.target.value })
                    }
                  />
                  {draft.coverUrl && (
                    <img className="cover-preview" src={draft.coverUrl} alt="" />
                  )}
                </div>
              </div>
              <div className="field span-2">
                <label htmlFor="c-info">Info</label>
                <textarea
                  id="c-info"
                  rows={3}
                  value={draft.info}
                  onChange={(e) => setDraft({ ...draft, info: e.target.value })}
                />
                <div className="row">
                  <button
                    type="button"
                    className="ghost icon-btn"
                    onClick={() => void lookUpInfoText()}
                    disabled={busy !== 'none'}
                    aria-label="Look up info"
                    title="Look up info for this track — fills only the Info text"
                  >
                    <LookupIcon />
                  </button>
                  <span className="hint">Only the Info text.</span>
                </div>
              </div>
            </section>

            <div className="field span-2">
              <label htmlFor="c-lyrics">Lyrics</label>
              <textarea
                id="c-lyrics"
                rows={5}
                value={draft.lyrics}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    lyrics: e.target.value,
                    lyricsSource: e.target.value.trim() ? 'Manually supplied' : '',
                  })
                }
              />
              <div className="row">
                <button
                  type="button"
                  className="ghost icon-btn"
                  onClick={() => void lookupLyrics()}
                  disabled={busy !== 'none' || !draft.title.trim() || !draft.artist.trim()}
                  aria-label="Look up lyrics"
                  title="Look up lyrics from LRCLIB and Lyrics.ovh"
                >
                  <LookupIcon />
                </button>
                {draft.lyrics.trim() && <span className="hint">Source: {draft.lyricsSource || 'not recorded'}</span>}
              </div>
            </div>

            {error && <p className="error">{error}</p>}

            <footer className="modal-footer">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  resetDrafts(track)
                  setEditing(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy !== 'none'}
              >
                Save changes
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="card-identity">
              <TrackCover
                coverUrl={track.coverUrl}
                videoId={coverSourceVideoId(track.sources)}
                className="card-cover"
                placeholderClassName="card-cover card-cover-ph"
                placeholderTag="div"
                alt={`${track.album ?? track.title} cover`}
              />
              <div className="card-meta">
                <h3>{track.title}</h3>
                <p className="artist">{track.artist}</p>
                <dl className="facts">
                  {track.album && (
                    <>
                      <dt>Album</dt>
                      <dd>{track.album}</dd>
                    </>
                  )}
                  {track.year && (
                    <>
                      <dt>Year</dt>
                      <dd>{track.year}</dd>
                    </>
                  )}
                  <dt>Length</dt>
                  <dd className="mono">{formatDuration(track.duration)}</dd>
                </dl>
                {track.genres.length > 0 && (
                  <p className="chips">
                    {track.genres.map((genre) => (
                      <span key={genre} className="chip">
                        {genre}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </div>

            <section className="card-section">
              <h4>Sources</h4>
              <ul className="card-sources">
                {(['audio', 'video', 'live'] as const).map((role) => {
                  const source = [audio, video, live].find((item) => item?.role === role)
                  return (
                    <li key={role}>
                      <span className="src-role">{ROLE_TITLE[role]}</span>
                      {source ? <>
                        <span className="src-kind">{source.kind}</span>
                        {source.label && <span className="src-label">{source.label}</span>}
                        <a href={source.url || watchUrl(source.youtubeId)} target="_blank" rel="noreferrer" className="mono src-link">
                          {source.url || watchUrl(source.youtubeId)}
                        </a>
                      </> : <span className="muted">Not set{role === 'video' ? ' · falls back to Main' : role === 'live' ? ' · falls back to video, then Main' : ''}</span>}
                    </li>
                  )
                })}
              </ul>
              {track.coverUrl && (
                <p className="card-line">
                  <span className="src-role">Cover</span>
                  <a
                    href={track.coverUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {track.coverUrl}
                  </a>
                </p>
              )}
              {track.musicbrainzRecordingId && (
                <p className="card-line">
                  <span className="src-role">MusicBrainz</span>
                  <a
                    href={`https://musicbrainz.org/recording/${track.musicbrainzRecordingId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {track.musicbrainzRecordingId}
                  </a>
                </p>
              )}            </section>

            {/* Shown, not acted on: looking up and writing both live behind the
                Edit button, so the read view stays a record of what is stored. */}
            <section className="card-section">
              <h4>Info</h4>
              {track.info ? (
                <p className="card-info">{track.info}</p>
              ) : (
                <p className="hint">No info yet.</p>
              )}
            </section>

            <section className="card-section">
              <h4>Lyrics</h4>
              {track.lyrics ? (
                <>
                  <pre className="card-lyrics">{track.lyrics}</pre>
                  <p className="hint">
                    Source: {track.lyricsSource ?? 'not recorded'}
                  </p>
                </>
              ) : (
                <p className="hint">No lyrics yet.</p>
              )}
            </section>

            <section className="card-section">
              <h4>In playlists</h4>
              {memberPlaylists.length === 0 ? (
                <p className="hint">Not in any playlist yet.</p>
              ) : (
                <ul className="card-playlists">
                  {memberPlaylists.map((playlist) => (
                    <li key={playlist.id}>
                      <span className="tree-name">{playlist.name}</span>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => onRemoveFromPlaylist(playlist.id, track.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {candidates.length > 0 && (
                <div className="card-add">
                  <select
                    aria-label="Add to playlist"
                    value={pick}
                    onChange={(e) => setPick(e.target.value)}
                  >
                    <option value="">Add to playlist…</option>
                    {candidates.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={!pick}
                    onClick={() => {
                      if (!pick) return
                      onAddToPlaylist(Number(pick), track.id)
                      setPick('')
                    }}
                  >
                    Add
                  </button>
                </div>
              )}
            </section>

            <footer className="modal-footer">
              <button
                type="button"
                className="ghost danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete "${track.title}" from the library? This cannot be undone.`,
                    )
                  ) {
                    onDelete(track)
                  }
                }}
              >
                Delete track
              </button>
              <div className="spacer" />
              <button type="button" className="play-primary" onClick={() => onPlay(track)}>
                Play
              </button>
              <button type="button" className="ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="ghost" onClick={onClose}>
                Close
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

function toSlotDraft(
  role: SourceRole,
  source: { youtubeId: string; kind: SourceKind; label: string | null } | undefined,
): SlotDraft {
  return {
    link: source?.youtubeId ?? '',
    kind: source?.kind ?? ROLE_DEFAULT_KIND[role],
    label: source?.label ?? '',
  }
}

/**
 * Asks every trusted source once.
 *
 * Shared by the form's auto-fill and the read view's lookup, so the two cannot
 * disagree about which sources are consulted: the only difference between them
 * is where the answer is written.
 */
async function gatherInfo(seed: { title: string; artist: string; audioId: string }) {
  const seconds = seed.audioId ? await fetchYouTubeDuration(seed.audioId) : null
  const youtubeInfo = seed.audioId
    ? await fetchOEmbed(watchUrl(seed.audioId)).catch(() => null)
    : null
  const guess = youtubeInfo
    ? guessFromYouTubeTitle(youtubeInfo.title, youtubeInfo.authorName)
    : null
  const artist = seed.artist || guess?.artist || ''
  const title = seed.title || guess?.title || ''
  const [facts, results] = await Promise.all([
    fetchArtistFacts({ artist, title }).catch(() => EMPTY_FACTS),
    searchMusicBrainz(title, artist).catch(() => [] as MbMatch[]),
  ])
  return { seconds, youtubeInfo, guess, facts, results }
}

/** A magnifier: asks the trusted sources for this track's details. */
function LookupIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m15.5 15.5 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function mergeInfo(existing: string, found: string | null): string {
  const parts = [stripGenreLines(existing), stripGenreLines(found ?? '')]
    .flatMap((part) => part.split(/\n\s*\n/))
    .map((part) => part.trim())
    .filter(Boolean)
  return [...new Set(parts)].join('\n\n')
}


