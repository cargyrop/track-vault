import { useEscape } from '../hooks/useEscape'
import { useCallback, useEffect, useState } from 'react'
import {
  fetchOEmbed,
  guessFromYouTubeTitle,
  searchMusicBrainz,
  type MbMatch,
  type OEmbedInfo,
} from '../lib/metadata'
import {
  SOURCE_KINDS,
  type NewTrack,
  type Playlist,
  type SourceKind,
  type SourceRole,
} from '../lib/types'
import {
  ROLE_DEFAULT_KIND,
  ROLE_TITLE,
} from '../lib/sources'
import { mergeGenres, parseGenres } from '../lib/genres'
import { formatDuration } from '../lib/format'
import { parseYouTubeId, watchUrl, YOUTUBE_INPUT_HINT } from '../lib/youtube'
import { fetchYouTubeDuration } from '../lib/youtubeDuration'
import { fetchArtistFacts, EMPTY_FACTS } from '../lib/artistInfo'
import { canLookUpLyrics, fetchLyricsResult } from '../lib/lyrics'

interface Props {
  open: boolean
  onClose: () => void
  /** Returns the new (or merged) track id, so the caller can file it. */
  onAdd: (track: NewTrack) => Promise<number>
  /** Every playlist, so the new track can be filed as it is saved. */
  playlists: Playlist[]
  onAddToPlaylist: (playlistId: number, trackId: number) => Promise<unknown>
}

/**
 * One of the three source slots. `link` is whatever the user pasted (a URL or a
 * bare ID); `youtubeId` is only set once it resolves.
 */
interface Slot {
  link: string
  youtubeId: string
  kind: SourceKind
  label: string
}

const emptySlot = (role: SourceRole): Slot => ({
  link: '',
  youtubeId: '',
  kind: ROLE_DEFAULT_KIND[role],
  label: '',
})

const emptySlots = (): Record<SourceRole, Slot> => ({
  audio: emptySlot('audio'),
  video: emptySlot('video'),
  live: emptySlot('live'),
})

const emptyDraft = () => ({
  title: '',
  artist: '',
  album: '',
  year: '',
  coverUrl: '',
  info: '',
  genres: '',
  musicbrainzRecordingId: '',
  duration: null as number | null,
  lyrics: '',
  lyricsSource: '',
})

export function AddTrackDialog({
  open,
  onClose,
  onAdd,
  playlists,
  onAddToPlaylist,
}: Props) {
  useEscape(onClose)
  const [slots, setSlots] = useState<Record<SourceRole, Slot>>(emptySlots)
  const [draft, setDraft] = useState(emptyDraft())
  const [oembed, setOembed] = useState<Record<SourceRole, OEmbedInfo | null>>({
    audio: null,
    video: null,
    live: null,
  })
  const [matches, setMatches] = useState<MbMatch[]>([])
  const [autoFillSources, setAutoFillSources] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [looking, setLooking] = useState<SourceRole | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [measuring, setMeasuring] = useState<SourceRole | null>(null)
  const [lookup, setLookup] = useState<string | null>(null)
  const [lookingLyrics, setLookingLyrics] = useState(false)
  // Playlists to file the new track into, chosen while it is being typed.
  const [chosenPlaylists, setChosenPlaylists] = useState<number[]>([])
  const [pickPlaylist, setPickPlaylist] = useState('')

  useEffect(() => {
    if (!open) {
      setSlots(emptySlots())
      setDraft(emptyDraft())
      setOembed({ audio: null, video: null, live: null })
      setMatches([])
      setAutoFillSources([])
      setError(null)
      setMeasuring(null)
      setLookup(null)
      setChosenPlaylists([])
      setPickPlaylist('')
    }
  }, [open])

  /**
   * Looks the artist up, reporting progress and never failing the add.
   *
   * A missing entry is the normal case for an unknown band, and a network
   * hiccup is not a reason to refuse to save a track the user just spent a
   * minute entering — so every failure resolves to "no extra information"
   * rather than an error the user has to dismiss.
   *
   * There is deliberately no "…and here is what we found" message: the dialog
   * closes the moment the track is saved, so anything said afterwards would be
   * said to nobody. Whether background arrived is answered by the Info panel
   * under the player, which lasts as long as the track does.
   */
  const enrichArtist = useCallback(async (artist: string, title: string) => {
    setLookup(`Looking up ${artist} on Wikipedia and MusicBrainz…`)
    try {
      return await fetchArtistFacts({ artist, title })
    } catch {
      return EMPTY_FACTS
    }
  }, [])

  const patchSlot = useCallback(
    (role: SourceRole, patch: Partial<Slot>) => {
      setSlots((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }))
    },
    [],
  )

  /**
   * Pulls title/thumbnail from YouTube and proposes an artist + track guess.
   * The first slot to resolve fills the blanks; a second one never overwrites
   * what the user already has.
   */
  const resolveLink = useCallback(
    async (role: SourceRole) => {
      const link = slots[role].link
      const id = parseYouTubeId(link)
      if (!id) {
        setError(YOUTUBE_INPUT_HINT)
        return
      }
      setError(null)
      setLooking(role)
      patchSlot(role, { youtubeId: id, link: id })
      try {
        const info = await fetchOEmbed(link)
        setOembed((prev) => ({ ...prev, [role]: info }))
        if (info) {
          const guess = guessFromYouTubeTitle(info.title, info.authorName)
          setDraft((prev) => ({
            ...prev,
            title: prev.title || guess.title,
            artist: prev.artist || guess.artist,
          }))
        }

        // Measure the upload while we already have its id, so the length is
        // known from the moment the link resolves and never has to be guessed
        // at or backfilled later. This is the only place a duration is measured
        // for a new track: once, from the link that will actually stream.
        setMeasuring(role)
        try {
          const seconds = await fetchYouTubeDuration(id)
          // The Main speaks for the track's running time whenever it exists: a
          // video slot is frequently a live take or an edited version, and
          // letting it win would silently give a studio track a concert's
          // length. With no Main, the clip *is* what plays, so it speaks.
          const speaksForTrack =
            role === 'audio' || (role === 'video' && !slots.audio.youtubeId)
          if (speaksForTrack && seconds !== null) {
            setDraft((prev) =>
              prev.duration === null ? { ...prev, duration: seconds } : prev,
            )
          }
        } finally {
          setMeasuring(null)
        }
      } catch {
        setError('Could not reach YouTube. You can still enter details manually.')
      } finally {
        setLooking(null)
      }
    },
    [slots, patchSlot],
  )

  const autoFill = useCallback(async () => {
    setSearching(true)
    setMatches([])
    setError(null)
    setLookup('Looking up track and artist information…')
    try {
      const [facts, results] = await Promise.all([
        fetchArtistFacts({ artist: draft.artist, title: draft.title }).catch(() => EMPTY_FACTS),
        searchMusicBrainz(draft.title, draft.artist).catch(() => [] as MbMatch[]),
      ])
      setMatches(results)
      const used: string[] = []
      if (oembed.audio) used.push('YouTube')
      if (facts.genres.length || facts.formedYear || results.length) used.push('MusicBrainz')
      if (facts.info && facts.wikipediaUrl) used.push('Wikipedia')
      if (facts.releaseYear) used.push('iTunes')
      setAutoFillSources(used)
      setDraft((prev) => {
        const mergedGenres = [...parseGenres(prev.genres)]
        for (const genre of facts.genres) {
          const value = genre.trim().toLowerCase()
          if (value && !mergedGenres.includes(value)) mergedGenres.push(value)
        }
        return {
          ...prev,
          year: prev.year || (facts.releaseYear ? String(facts.releaseYear) : ''),
          genres: mergedGenres.join(', '),
          info: prev.info.trim() || facts.info || '',
        }
      })
      setError(results.length
        ? 'Track and artist details were filled where available. Choose a matching MusicBrainz recording below to add its album and release details.'
        : 'Artist information was filled where available. No MusicBrainz recording matched.')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Auto-fill could not retrieve metadata.')
    } finally {
      setSearching(false)
      setLookup(null)
    }
  }, [draft.title, draft.artist, oembed.audio])

  const applyMatch = useCallback((match: MbMatch) => {
    setDraft((prev) => ({
      ...prev,
      title: match.title,
      artist: match.artist,
      album: match.album ?? '',
      year: match.year ? String(match.year) : '',
      coverUrl: match.coverUrl ?? '',
      musicbrainzRecordingId: match.recordingId,
      genres: mergeGenres(prev.genres, match.genres),
    }))
    setMatches([])
  }, [])

  const lookupDraftLyrics = useCallback(async () => {
    if (!canLookUpLyrics({ title: draft.title, artist: draft.artist })) {
      setError('Enter the title and artist before looking up lyrics.')
      return
    }
    setLookingLyrics(true)
    setError(null)
    const found = await fetchLyricsResult({ title: draft.title, artist: draft.artist })
    if (found) {
      setDraft((prev) => ({ ...prev, lyrics: found.text, lyricsSource: found.source }))
      setError(`Lyrics found from ${found.source} and added to this draft.`)
    } else {
      setError('No lyrics were found in LRCLIB or Lyrics.ovh.')
    }
    setLookingLyrics(false)
  }, [draft.title, draft.artist])

  const submit = useCallback(async () => {
    setError(null)
    const genres = parseGenres(draft.genres)
    if (!draft.title.trim() || !draft.artist.trim()) {
      setError('Title and artist are both required.')
      return
    }
    // A Main or a video clip: either one carries the audio, and each mode falls
    // back to the other, so a clip-only track is a complete track.
    if (!slots.audio.youtubeId && !slots.video.youtubeId) {
      setError('Add a Main link or a video clip — the track needs one to play.')
      return
    }
    setSaving(true)
    try {
      const title = draft.title.trim()
      const artist = draft.artist.trim()

      // Background about the artist, fetched once at add time and written
      // straight into the track. Done before the save rather than after it so
      // the track is stored complete and there is no second write to make.
      //
      // Anything the user typed or MusicBrainz already matched always wins:
      // the lookup only fills blanks, because silently replacing a genre the
      // user chose with one a server guessed is the wrong kind of helpful.
      const facts = await enrichArtist(artist, title)
      const fetchedLyrics = draft.lyrics.trim() ? null : (canLookUpLyrics({ title, artist })
        ? await fetchLyricsResult({ title, artist })
        : null)
      const lyrics = draft.lyrics.trim() || fetchedLyrics?.text || ''
      const mergedGenres = [...genres]
      for (const genre of facts.genres) {
        // Genres are stored lower-case everywhere, so a looked-up spelling is
        // folded the same way the typed ones were rather than creating a second
        // capitalisation of the same word in the facet list.
        const name = genre.trim().toLowerCase()
        if (name && !mergedGenres.includes(name)) mergedGenres.push(name)
      }
      const info = draft.info.trim() || facts.info
      // The lookup knows when the *band* formed; only iTunes knows when this
      // particular song came out, so the two never get swapped.
      const year = draft.year ? Number(draft.year) : facts.releaseYear

      const trackId = await onAdd({
        title: draft.title.trim(),
        artist: draft.artist.trim(),
        album: draft.album.trim() || null,
        year: year ?? null,
        coverUrl: draft.coverUrl.trim() || null,
        info: info || null,
        musicbrainzRecordingId: draft.musicbrainzRecordingId.trim() || null,
        duration: draft.duration,
        lyrics: lyrics || null,
        lyricsSource: lyrics ? draft.lyricsSource || fetchedLyrics?.source || 'Manually supplied' : null,
        genres: mergedGenres,
        // Only slots that actually resolved are stored, audio first so it
        // remains the default source.
        sources: (['audio', 'video', 'live'] as const)
          .filter((role) => slots[role].youtubeId)
          .map((role) => ({
            youtubeId: slots[role].youtubeId,
            url: watchUrl(slots[role].youtubeId),
            kind: slots[role].kind,
            label: slots[role].label.trim() || null,
            role,
          })),
      })
      // Filed after the save, through the same call the track card uses, so a
      // merge — re-adding a track that already exists — still lands in the
      // playlists that were picked for it.
      for (const playlistId of chosenPlaylists) {
        await onAddToPlaylist(playlistId, trackId)
      }
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not save the track.')
    } finally {
      setSaving(false)
    }
  }, [draft, slots, onAdd, onClose, chosenPlaylists, onAddToPlaylist])

  if (!open) return null

  // The slot that speaks for the track's running time: the Main when there is
  // one, otherwise the clip — which is then what plays.
  const lengthSlot: SourceRole = slots.audio.youtubeId ? 'audio' : 'video'


  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add a track"
      >
        <header className="modal-header">
          <h2>Add a track</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {(['audio', 'video', 'live'] as const).map((role) => {
          const slot = slots[role]
          const found = oembed[role]
          return (
            <section className="field" key={role}>
              <label htmlFor={`src-${role}`}>
                {ROLE_TITLE[role]}{role === 'live' ? ' (optional)' : ''}
              </label>
              <div className="row">
                <input
                  id={`src-${role}`}
                  value={slot.link}
                  autoFocus={role === 'audio'}
                  placeholder={
                    role === 'audio'
                      ? 'Best-quality audio, usually a standing picture'
                      : role === 'video'
                        ? 'Official video clip — plays when there is no Main'
                        : 'Live performance'
                  }
                  onChange={(e) => {
                    const link = e.target.value
                    patchSlot(role, {
                      link,
                      ...(role === 'audio' ? {} : { youtubeId: parseYouTubeId(link) ?? '' }),
                    })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && role !== 'live') {
                      e.preventDefault()
                      void resolveLink(role)
                    }
                  }}
                />
                {/* Fetch for the clip as well as the Main: with no Main the
                    clip is what plays and what the length is read from. */}
                {role !== 'live' && <button
                  type="button"
                  onClick={() => void resolveLink(role)}
                  disabled={looking === role}
                >
                  {looking === role ? 'Fetching…' : 'Fetch'}
                </button>}
              </div>
              {/* The measured length, shown as it is found. It is never typed:
                  it comes from the link, so a human has nothing to correct and
                  nothing to get wrong. */}
              {role === lengthSlot && draft.duration !== null && (
                <p className="hint duration-readout">
                  Length: <strong className="mono">{formatDuration(draft.duration)}</strong>
                  <span className="muted"> · read from the YouTube link</span>
                </p>
              )}
              {role === lengthSlot && measuring === role && (
                <p className="hint">Measuring length…</p>
              )}
              {slot.youtubeId && (
                <div className="row source-slot-meta">
                  <a
                    href={watchUrl(slot.youtubeId)}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {slot.youtubeId}
                  </a>
                  <select
                    value={slot.kind}
                    aria-label={`${ROLE_TITLE[role]} type`}
                    onChange={(e) =>
                      patchSlot(role, { kind: e.target.value as SourceKind })
                    }
                  >
                    {SOURCE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="label (optional)"
                    value={slot.label}
                    onChange={(e) => patchSlot(role, { label: e.target.value })}
                  />
                </div>
              )}
              {found && (
                <p className="hint">
                  Found: <strong>{found.title}</strong> · {found.authorName}
                </p>
              )}
            </section>
          )
        })}

        <div className="row">
          <button type="button" onClick={() => void autoFill()} disabled={searching}>
            {searching ? 'Auto-filling…' : 'Auto-fill'}
          </button>
          {draft.musicbrainzRecordingId && (
            <span className="badge ok">matched</span>
          )}
        </div>

        {lookup && <p className="hint lookup-status">{lookup}</p>}
        {autoFillSources.length > 0 && <p className="hint">Sources used: {autoFillSources.join(', ')}</p>}

        {matches.length > 0 && (
          <ul className="match-list">
            {matches.map((match) => (
              <li key={match.recordingId}>
                <button type="button" onClick={() => applyMatch(match)}>
                  <strong>{match.title}</strong>
                  <span>
                    {match.artist}
                    {match.album ? ` — ${match.album}` : ''}
                    {match.year ? ` (${match.year})` : ''}
                  </span>
                  {match.genres.length > 0 && (
                    <em>{match.genres.join(', ')}</em>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <section className="grid-2">
          <div className="field">
            <label htmlFor="title">Title *</label>
            <input
              id="title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="artist">Artist *</label>
            <input
              id="artist"
              value={draft.artist}
              onChange={(e) => setDraft({ ...draft, artist: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="album">Album</label>
            <input
              id="album"
              value={draft.album}
              onChange={(e) => setDraft({ ...draft, album: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="year">Year</label>
            <input
              id="year"
              inputMode="numeric"
              value={draft.year}
              onChange={(e) => setDraft({ ...draft, year: e.target.value })}
            />
          </div>
          <div className="field span-2">
            <label htmlFor="genres">Genres (comma separated)</label>
            <input
              id="genres"
              placeholder="prog rock, psychedelic"
              value={draft.genres}
              onChange={(e) =>
                // Lower-cased as it is typed: genres are one vocabulary, and a
                // capitalised spelling would sit beside its twin in the facets.
                setDraft({ ...draft, genres: e.target.value.toLowerCase() })
              }
            />
          </div>
          <div className="field span-2">
            <label htmlFor="cover">Cover art URL</label>
            <input
              id="cover"
              value={draft.coverUrl}
              onChange={(e) => setDraft({ ...draft, coverUrl: e.target.value })}
            />
          </div>
          <div className="field span-2">
            <label htmlFor="add-playlist">Playlists</label>
            {playlists.length === 0 ? (
              <p className="hint">
                No playlists yet — create one in the Playlists tab.
              </p>
            ) : (
              <>
                {/* A dropdown with an Add button, exactly as the track card
                    files a track: one chip per playlist turns this dialog into
                    a wall of names as the library grows, and the picker is the
                    same decision the card already asks. */}
                <div className="row">
                  <select
                    id="add-playlist"
                    value={pickPlaylist}
                    onChange={(e) => setPickPlaylist(e.target.value)}
                  >
                    <option value="">Add to playlist…</option>
                    {playlists
                      .filter((playlist) => !chosenPlaylists.includes(playlist.id))
                      .map((playlist) => (
                        <option key={playlist.id} value={playlist.id}>
                          {playlist.name}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!pickPlaylist}
                    onClick={() => {
                      if (!pickPlaylist) return
                      setChosenPlaylists((current) => [
                        ...current,
                        Number(pickPlaylist),
                      ])
                      setPickPlaylist('')
                    }}
                  >
                    Add
                  </button>
                </div>
                {chosenPlaylists.length > 0 && (
                  <ul className="card-playlists">
                    {chosenPlaylists.map((id) => {
                      const playlist = playlists.find((p) => p.id === id)
                      if (!playlist) return null
                      return (
                        <li key={id}>
                          <span className="tree-name">{playlist.name}</span>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() =>
                              setChosenPlaylists((current) =>
                                current.filter((chosen) => chosen !== id),
                              )
                            }
                          >
                            Remove
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
          <div className="field span-2">
            <label htmlFor="info">Info</label>
            <textarea
              id="info"
              rows={2}
              value={draft.info}
              onChange={(e) => setDraft({ ...draft, info: e.target.value })}
            />
          </div>
          <div className="field span-2">
            <label htmlFor="add-lyrics">Lyrics (saved with this track)</label>
            <textarea id="add-lyrics" rows={4} value={draft.lyrics} onChange={(e) => setDraft({ ...draft, lyrics: e.target.value, lyricsSource: e.target.value.trim() ? 'Manually supplied' : '' })} placeholder="Paste lyrics or look them up." />
            <div className="row">
              <button type="button" className="ghost-btn" onClick={() => void lookupDraftLyrics()} disabled={lookingLyrics || !draft.title.trim() || !draft.artist.trim()}>
                {lookingLyrics ? 'Looking up lyrics…' : 'Look up lyrics now'}
              </button>
              {draft.lyrics.trim() && <span className="hint">Source: {draft.lyricsSource || 'not recorded'}</span>}
            </div>
          </div>
        </section>

        {error && <p className="error">{error}</p>}

        <footer className="modal-footer">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={saving}>
            {saving ? 'Saving…' : 'Save to library'}
          </button>
        </footer>
      </div>
    </div>
  )
}

