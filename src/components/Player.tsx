import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldCarryPlayback } from '../lib/playback'
import { shouldShowHud, HUD_IDLE_MS } from '../lib/hud'
import {
  createPlayer,
  YTState,
  youtubeErrorMessage,
  type YTPlayer,
} from '../lib/ytApi'
import type { Playlist, TrackWithSources } from '../lib/types'
import {
  clampVolume,
  displayVolume,
  MIN_VOLUME,
  resolveAudio,
  stepVolume,
} from '../lib/audio'
import {
  coverSourceVideoId,
  pickSourceForView,
  type PlaybackView,
} from '../lib/sources'

import {
  fitScale,
  VIDEO_FRAME_HEIGHT,
  VIDEO_FRAME_WIDTH,
} from '../lib/fit'
import {
  AUTO_QUALITY,
  AUDIO_SAVER_QUALITY,
  type PlaybackQuality,
} from '../lib/youtube'
import { formatClock, formatDuration } from '../lib/format'
import { TrackCover } from './TrackCover'
import { MediaPanel, type MediaPane } from './MediaPanel'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  QueueIcon,
} from './icons'

interface Props {
  track: TrackWithSources | null
  /**
   * Audio, video or live. Owned by the app so the choice survives track changes, but
   * changed from the transport buttons rather than a top-bar
   * toggle: the control belongs next to the thing it controls.
   */
  view: View
  /** Playlist/library context so next/prev have somewhere to go. */
  queue?: TrackWithSources[]
  onAdvance?: (direction: 1 | -1) => void
  /**
   * Bumped by the tracklist's play button. Each new value means "start this
   * track now", so the stream begins immediately rather than waiting for a
   * second press of Play.
   *
   * A counter rather than a boolean because the same track can be asked for
   * again while it is already loaded, and only a change is an instruction.
   */
  playToken?: number
  /**
   * Switches which source streams.
   *
   * Owned by the app — the choice has to outlive the track — but no longer
   * offered as a top-bar toggle: the three transport buttons are the
   * switch, so the control and the thing it controls sit together.
   */
  onViewChange?: (view: View) => void
  /**
   * How much room the player is taking.
   *
   * `dock` is the bar that is always there — art, title, transport, progress —
   * at the bottom of the window and above the tab bar on a phone. `full` is the
   * player *screen*: the same component, the same state, the same stream,
   * arranged with room for the artwork, the controls and what the track says.
   *
   * One component rather than three, because the alternative was a phone
   * player, a tablet player and a desktop player with three sets of rules for
   * the same stream — and no way for two of them to be showing at once without
   * two players fighting over one iframe.
   */
  variant?: 'dock' | 'full'
  /** Opens the full view from the dock. */
  onExpand?: () => void
  /** Puts the full view back into the dock. */
  onCollapse?: () => void
  /** Where the empty player sends you, so it is never a dead end. */
  onOpenLibrary?: () => void
  /** Info or lyrics under the controls; owned by the app so it is remembered. */
  pane?: MediaPane
  onPaneChange?: (pane: MediaPane) => void
  /** The list the queue came from, named in the full view. */
  sourceTitle?: string | null
  /** Opens a queue row: what "play this one next" means without a queue model. */
  onSelectTrack?: (track: TrackWithSources) => void
  /**
   * Opens the playing track's card — sources, info, lyrics and playlists —
   * from the corner of the player, so seeing what a track is does not mean
   * leaving for YouTube.
   */
  onOpenCard?: (track: TrackWithSources) => void
  /**
   * Reports the length YouTube actually reports for the stream.
   *
   * This is the correction path for a stored duration. MusicBrainz knows how
   * long the *studio track* is, which is the right answer for a library listing
   * but not always for the upload actually streaming: a live take runs longer, a
   * radio edit shorter. Once the player has genuinely reported a duration, that
   * is the better number, so it wins.
   *
   * Called only when the value changes, and never with a zero, so a track does
   * not get rewritten while it merely sits at the start.
   */
  /**
   * Reports a track that played to its end, once per track.
   *
   * The app logs it as a completed listen for the DJ. Fires beside — not
   * instead of — the auto-advance below, so history and playback stay two
   * separate decisions.
   */
  onTrackEnded?: (trackId: number) => void
  onDurationResolved?: (trackId: number, seconds: number) => void
  /**
   * Called once with the cover art that actually rendered, when that art came
   * from the fallback chain rather than from what the track already stored.
   *
   * This is what turns the YouTube fallback into a one-time repair. Without it
   * the chain re-runs on every load of the track, re-requesting a dead Cover
   * Art Archive or legacy `yt3` URL each time; with it, the working address is
   * written back once and the stored library is correct from then on.
   *
   * Only ever called for a candidate that has genuinely loaded, so a URL that
   * is also broken is never promoted over the one it replaced.
   */
  onCoverResolved?: (trackId: number, coverUrl: string) => void
  /** Every playlist, for filing the playing track without leaving the player. */
  playlists?: Playlist[]
  onAddToPlaylist?: (playlistId: number, trackId: number) => void
  /**
   * DJ state for the badge beside the status readout. `isDjSuggestion` says
   * the playing track is itself a drafted pick rather than a list row, and
   * `djSeedLabel` names what the station is growing from, when known.
   * `onToggleDj` turns the station off; null hides the control.
   */
  djOn?: boolean
  isDjSuggestion?: boolean
  djSeedLabel?: string | null
  onToggleDj?: (() => void) | null
  /** Playlists the playing track already belongs to, marked in the dialog. */
  memberPlaylistIds?: ReadonlySet<number>
}

/**
 * Audio is the default and the only thing that auto-starts. Video and live are
 * explicit opt-ins that expand to a large surface.
 *
 * The view also selects *which* source streams: the Main slot (best audio,
 * usually a standing picture) for audio, the official-clip slot for video, the
 * live slot for live. Main and the clip stand in for each other — audio mode
 * plays the clip when there is no Main, and video mode plays the Main when
 * there is no clip — and live falls back to the clip, then Main. Nothing is
 * downloaded either way.
 */
type View = PlaybackView

/** Lowest level that still makes sound, used when the slider is dragged to 0. */
const MIN_AUDIBLE = 1

/**
 * Leaves native fullscreen without toggling: the exit half of
 * `toggleNativeFullscreen`, for paths (HUD exit, view switch) that already
 * know which direction they are going.
 */
function exitNativeFullscreen(): void {
  if (!document.fullscreenElement) return
  const exit =
    document.exitFullscreen ??
    (document as unknown as { webkitExitFullscreen?: () => void })
      .webkitExitFullscreen
  try {
    const pending = exit?.call(document) as Promise<void> | void
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => undefined)
    }
  } catch {
    // Already out.
  }
}

function toggleNativeFullscreen(el: HTMLElement): Promise<void> {
  const request =
    el.requestFullscreen ??
    (el as unknown as { webkitRequestFullscreen?: () => Promise<void> })
      .webkitRequestFullscreen
  const exit =
    document.exitFullscreen ??
    (document as unknown as { webkitExitFullscreen?: () => Promise<void> })
      .webkitExitFullscreen

  if (document.fullscreenElement) {
    return Promise.resolve(exit?.call(document) ?? undefined)
  }
  if (!request) return Promise.reject(new Error('Fullscreen is unavailable here.'))
  return request.call(el)
}

export function Player({
  track,
  view,
  queue = [],
  onAdvance,
  playToken = 0,
  onViewChange,
  variant = 'dock',
  onExpand,
  onCollapse,
  onOpenLibrary,
  pane = 'info',
  onPaneChange,
  sourceTitle = null,
  onSelectTrack,
  onOpenCard,
  onDurationResolved,
  onCoverResolved,
  onTrackEnded,
  playlists,
  onAddToPlaylist,
  djOn = false,
  isDjSuggestion = false,
  djSeedLabel = null,
  onToggleDj = null,
  memberPlaylistIds,
}: Props) {
  const [quality] = useState<PlaybackQuality>(AUDIO_SAVER_QUALITY)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  // The stored level is kept separately from `muted`, so unmuting restores the
  // volume you had instead of snapping back to 100.
  const [volume, setVolumeState] = useState(100)
  // Set when the browser refused to unmute an autoplaying track, so the UI can
  // say so instead of leaving the user hunting for the reason there is no sound.
  const [soundBlocked, setSoundBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  // Scale that fits the fixed-size video frame inside the current surface. 0
  // until the first measurement lands, which keeps the frame from flashing at
  // full size before it is sized to its container.
  const [frameScale, setFrameScale] = useState(0)
  // True while the pointer is moving over a fullscreen video. Drives the fade of
  // the fullscreen control bar.
  const [cursorActive, setCursorActive] = useState(false)
  // The fullscreen bar has no room for a permanent slider, so the sound button
  // opens one instead. Kept in state rather than a CSS :hover so a click can
  // pin it open long enough to drag with a keyboard too.
  const [fsVolumeOpen, setFsVolumeOpen] = useState(false)
  // Filing the playing track: a DJ pick may live outside every visible list,
  // so the player is the only place it can be kept. A transport button opens
  // a quick dialog rather than a permanent row, so the player and its info
  // stay together. Reset per track so a confirmation never lingers on.
  const [fileOpen, setFileOpen] = useState(false)
  // The queue is a sheet over the full view rather than a third column: it is
  // read for a moment and dismissed, and what is coming next is never worth a
  // permanent third of the window.
  const [queueOpen, setQueueOpen] = useState(false)
  useEffect(() => {
    setFileOpen(false)
  }, [track?.id])
  // Dismiss the filing dialog the way a native menu goes: Escape closes it.
  useEffect(() => {
    if (!fileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fileOpen])

  const playerRef = useRef<YTPlayer | null>(null)
  // The track id already reported as ended. The poll below sees ENDED on every
  // tick until the next track loads, so without this one listen would be
  // logged dozens of times. Reset whenever the track changes.
  const endedForId = useRef<number | null>(null)
  useEffect(() => {
    endedForId.current = null
  }, [track?.id])
  const mountRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stopRequested = useRef(false)
  // Set when a track change should begin playing, cleared once consumed.
  const autoplayNext = useRef(false)
  // Guards against two loads racing when the user clicks quickly.
  const loadToken = useRef(0)
  // What the live player was built for. The view can only be rebuilt in place
  // when it is the *same track* in a different view; when the track changes,
  // the normal load path already builds for the current view.
  const builtView = useRef<View | null>(null)
  const builtTrack = useRef<number | null>(null)

  // The player streams whichever source fills the slot matching the current view.
  const source = pickSourceForView(track?.sources ?? [], view)
  const trackId = track?.id ?? null
  // The role of the source the player is *actually* streaming. It differs from
  // `view` for a track with no video clip in video mode, and the card's YouTube
  // button must not describe a clip that isn't there.

  // Cover art comes from the audio source, not from whatever is on screen: in
  // video mode `source` is the music video, which is the wrong picture to put
  // beside the album listing. `TrackCover` owns the fallback chain itself.
  const coverVideoId = coverSourceVideoId(track?.sources ?? [])

  /**
   * Records a fallback candidate that rendered, so it is not rediscovered on
   * every load.
   *
   * Only for a track with no cover at all. A stored cover that failed to render
   * is left alone on purpose: the failure is often transient — a `yt3` URL that
   * Chrome refused once with ERR_BLOCKED_BY_ORB has loaded perfectly minutes
   * later — and overwriting it would replace hand-picked square album art with a
   * centre-cropped 16:9 video thumbnail, with no way back.
   */
  const rememberCover = useCallback(
    (url: string) => {
      if (!track || !onCoverResolved) return
      if (track.coverUrl) return
      onCoverResolved(track.id, url)
    },
    [track, onCoverResolved],
  )

  // Audio mode pins the lowest tier to keep the video rendition as small as
  // possible; video mode hands quality back to YouTube, which adapts on its own.
  // There is no control for either — see AUDIO_SAVER_QUALITY.
  const effectiveQuality: PlaybackQuality =
    view === 'audio' ? quality : AUTO_QUALITY

  // ------------------------------------------------------------ video sizing

  /**
   * Keeps the video frame fitted to its surface.
   *
   * YouTube's IFrame API writes the frame size onto the iframe as inline
   * styles, which no stylesheet rule can override, so the frame is created at a
   * fixed logical size and scaled with a transform instead. A ResizeObserver is
   * needed rather than a one-shot measurement because the surface changes size
   * on window resize, on entering fullscreen, and when the layout reflows.
   */
  useEffect(() => {
    const el = containerRef.current
    if (!el || view === 'audio') return

    const measure = () => {
      const rect = el.getBoundingClientRect()
      setFrameScale(
        fitScale(
          rect.width,
          rect.height,
          VIDEO_FRAME_WIDTH,
          VIDEO_FRAME_HEIGHT,
          // Fullscreen is meant to fill the screen, so the no-upscale cap used
          // in the card is lifted there.
          maximized ? Infinity : 1,
        ),
      )
    }
    measure()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [view, maximized])

  // ------------------------------------------------------------ lifecycle

  /**
   * Tears down the current player.
   *
   * Note: YouTube's iframe script logs a benign cross-origin `postMessage`
   * warning after a track change, because it still holds a reference to the
   * frame it created. Blanking the iframe src first was tried to silence that,
   * but it detaches the player from the DOM and produces a worse "player is not
   * attached to the DOM" warning on every subsequent call. A plain destroy() is
   * the lesser warning, so that is what we do.
   */
  const destroyPlayer = useCallback(() => {
    // Invalidate any in-flight load so its result is ignored.
    loadToken.current++
    try {
      playerRef.current?.destroy()
    } catch {
      // Destroying an already-detached player throws in some browsers.
    }
    playerRef.current = null
    builtView.current = null
    builtTrack.current = null
  }, [])

  /**
   * Changing track resets the transport to a fresh, not-yet-started state, so
   * selecting a track always shows a Play button rather than inheriting the
   * previous track's playback UI. `autoplayNext` decides whether it starts
   * immediately or waits for a click.
   *
   * Two things are deliberately *not* reset:
   *
   * - The audio/video choice, because it is a top-bar preference and staying in
   *   video mode across a skip is what you want.
   * - Fullscreen, because skipping with `n`/`p` while watching fullscreen must
   *   not dump you back into the little card. The surface stays mounted and the
   *   replacement player is built inside it, so fullscreen is continuous.
   */
  useEffect(() => {
    destroyPlayer()
    setPlaying(false)
    setStarted(false)
    setTime(0)
    setDuration(0)
    setError(null)
  }, [track?.id, destroyPlayer])

  // Leaving video view has no surface to stay fullscreen on, so fullscreen ends.
  useEffect(() => {
    if (view !== 'audio') return
    setMaximized(false)
    if (document.fullscreenElement) void document.exitFullscreen?.()
  }, [view])

  /**
   * Handles the view switch.
   *
   * The two views usually stream *different* videos, so switching changes which
   * source is current. That makes a source change ambiguous: it is either the
   * deliberate audio<->video switch, or a track change. The two were previously
   * separate effects racing each other, and whichever ran first tore the player
   * down, so switching views stopped playback and required a second click on
   * Play — the bug this replaces.
   *
   * One effect now decides, using the track the live player was built for:
   *
   * - Same track, different view -> rebuild in place, keeping the position and
   *   the playing/stopped state.
   * - Track change, or no live player -> reset and wait for a Play press (or the
   *   pending `autoplayNext` intent from a skip).
   *
   * A stopped track stays stopped across the switch, which is why the rebuild
   * is driven by the *previous* playing state rather than always autoplaying.
   */
  useEffect(() => {
    // The player belongs to this track and a view switch is in progress: the
    // dedicated effect below owns it. Bail so this one does not destroy it.
    if (builtTrack.current !== null && builtTrack.current === trackId) {
      return
    }

    destroyPlayer()
    setPlaying(false)
    setStarted(false)
    setTime(0)
    setDuration(0)
    setError(null)
  }, [source?.youtubeId, trackId, destroyPlayer])

  useEffect(() => destroyPlayer, [destroyPlayer])

  // ------------------------------------------------------------- playback

  /**
   * Raises the sound on a player that started muted for autoplay reasons.
   *
   * Chrome allows this without a gesture; stricter engines may refuse, in which
   * case the player stays muted and we say so rather than staying silent and
   * unexplained. Any later volume interaction from the user is a real gesture
   * and always succeeds.
   */
  const unmuteIfAllowed = useCallback((player: YTPlayer) => {
    try {
      player.unMute()
    } catch {
      // Ignore: reported below by checking the resulting state.
    }
    const allowed = !player.isMuted()
    setMuted(!allowed)
    setSoundBlocked(!allowed)
  }, [])

  /**
   * Applies a level and mute state to the live player.
   *
   * `setVolume` and `mute` are separate calls because unmuting must restore the
   * level the user had chosen, not YouTube's default of 100.
   */
  const applyAudio = useCallback(
    (player: YTPlayer, level: number, isMuted: boolean) => {
      const audio = resolveAudio(level, isMuted)
      try {
        player.setVolume(audio.volume)
      } catch {
        // Older players without setVolume keep their own level.
      }
      if (audio.muted) player.mute()
      else player.unMute()
    },
    [],
  )

  /** Creates the player and optionally begins playback. */
  const start = useCallback(
    async (autoplay: boolean, fromGesture = true) => {
      const host = mountRef.current
      if (!source || !host) return

      // Already have a player for this track: just play or pause it.
      const existing = playerRef.current
      if (existing) {
        if (autoplay) {
          if (existing.getCurrentTime() > 1) existing.seekTo(0, true)
          existing.playVideo()
          setPlaying(true)
        } else {
          existing.pauseVideo()
          setPlaying(false)
        }
        builtView.current = view
        builtTrack.current = trackId
        return
      }

      // Browsers only allow audible playback started from a user gesture. A
      // muted start is therefore used *only* for the gesture-less case (skipping
      // to the next track), and unmuted as soon as playback is running. Starting
      // muted on a plain Play press was the bug: every track began silent and
      // needed the mute button pressed.
      const mustStartMuted = autoplay && !fromGesture

      const token = ++loadToken.current
      try {
        setError(null)
        const player = await createPlayer(host, {
          videoId: source.youtubeId,
          quality: effectiveQuality,
          // A 1x1 frame in audio mode keeps YouTube's own quality heuristic
          // pinned to the lowest video rendition. Video mode uses one fixed
          // logical size and scales it to fit, since the API writes this size
          // onto the iframe inline and CSS cannot override it.
          width: view === 'audio' ? 1 : VIDEO_FRAME_WIDTH,
          height: view === 'audio' ? 1 : VIDEO_FRAME_HEIGHT,
          startVolume: volume,
          startMuted: mustStartMuted && !muted,
        })
        // A newer load superseded this one.
        if (token !== loadToken.current) return

        playerRef.current = player
        builtView.current = view
        builtTrack.current = trackId
        setStarted(true)
        setDuration(player.getDuration() || 0)

        if (autoplay) {
          player.playVideo()
          setPlaying(true)
          if (mustStartMuted && !muted) unmuteIfAllowed(player)
        }
      } catch (e: unknown) {
        if (token !== loadToken.current) return
        setError(e instanceof Error ? e.message : youtubeErrorMessage(-1))
        setStarted(false)
      }
    },
    [source, effectiveQuality, view, volume, muted, unmuteIfAllowed, trackId],
  )

  const togglePlay = useCallback(() => {
    // Not started yet: the first press starts the stream.
    const player = playerRef.current
    if (!started || !player) {
      // This press is a user gesture, so the stream starts audible.
      void start(true, true)
      return
    }
    // Decide from our own `playing` state rather than getPlayerState(). While a
    // video is BUFFERING the live state is 3, which is not PLAYING, so a
    // state-based check would read "not playing" and call playVideo() — turning
    // a pause press into an unpause.
    if (playing) {
      player.pauseVideo()
      setPlaying(false)
    } else {
      player.playVideo()
      setPlaying(true)
    }
  }, [started, start, playing])

  /**
   * Stops playback and returns to the beginning.
   *
   * `stopVideo()` alone is unreliable here: on a cued or buffering player it can
   * be a no-op, and the state can fall through to playing. Pausing first and then
   * re-cueing the same video ID is the reliable sequence — `cueVideoById` loads
   * without starting, so the result is a genuinely stopped player.
   */
  const stop = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    stopRequested.current = true
    // Stopping is an explicit halt: a later track change must not resume.
    autoplayNext.current = false
    const videoId = source?.youtubeId
    player.pauseVideo()
    if (videoId && typeof player.cueVideoById === 'function') {
      try {
        player.cueVideoById(videoId, 0)
      } catch {
        // Fall through to the best-effort path below.
      }
    } else {
      player.stopVideo()
      player.seekTo(0, true)
    }
    setPlaying(false)
    setTime(0)
  }, [source?.youtubeId])

  const seek = useCallback((seconds: number) => {
    const player = playerRef.current
    if (!player) return
    player.seekTo(seconds, true)
    setTime(seconds)
  }, [])

  /** Moves the level. Dragging the slider is a gesture, so this also unblocks sound. */
  const setVolume = useCallback(
    (value: number) => {
      const level = clampVolume(value)
      // Dragged to zero means silence, but a stored level of 1 is kept so that
      // unmuting later brings sound back rather than staying silent.
      const nextMuted = level === MIN_VOLUME
      setVolumeState(nextMuted ? MIN_AUDIBLE : level)
      setMuted(nextMuted)
      setSoundBlocked(false)
      const player = playerRef.current
      if (player) applyAudio(player, level, false)
    },
    [applyAudio],
  )

  const toggleMute = useCallback(() => {
    const next = !muted
    setMuted(next)
    setSoundBlocked(false)
    const player = playerRef.current
    // Unmuting restores the stored level rather than snapping to 100.
    if (player) applyAudio(player, volume, next)
  }, [muted, volume, applyAudio])

  const nudgeVolume = useCallback(
    (delta: number) => setVolume(stepVolume(volume, delta)),
    [setVolume, volume],
  )

  /**
   * Moves to the next/previous track, carrying over whether playback should
   * continue. The intent is captured *before* the source changes, because
   * switching tracks tears the player down.
   */
  const advance = useCallback(
    (direction: 1 | -1, forcePlay = false) => {
      if (!onAdvance) return
      let liveState: number | null = null
      try {
        liveState = playerRef.current?.getPlayerState() ?? null
      } catch {
        // A detached player throws; fall back to the React state alone.
      }
      autoplayNext.current = shouldCarryPlayback({
        playing,
        playerState: liveState,
        forced: forcePlay,
      })
      onAdvance(direction)
    },
    [onAdvance, playing],
  )

  // Consume the carry-over intent once the new track's player is built.
  useEffect(() => {
    if (!autoplayNext.current || !source || !mountRef.current) return
    autoplayNext.current = false
    // No user gesture here, so the stream may have to start muted. This works in
    // video mode too: skipping on should stay on video, not drop to audio.
    void start(true, false)
  }, [source, view, start])

  // A play request from the tracklist. This is an explicit "start this now",
  // made with a real user gesture, so it always begins playback — unlike a skip,
  // which carries the paused/playing state across.
  const seenPlayToken = useRef(playToken)
  useEffect(() => {
    if (playToken === seenPlayToken.current) return
    seenPlayToken.current = playToken
    // The track-change effect above has already torn the old player down when
    // the request also changed track; if it did not, `start` resumes in place.
    void start(true, true)
  }, [playToken, start])

  // Poll for time and end-of-track.
  useEffect(() => {
    const id = window.setInterval(() => {
      const player = playerRef.current
      if (!player) return

      // A stop request is honoured here rather than in stop(): the player can
      // still report PLAYING for a tick after the call, which would otherwise
      // immediately overwrite the stopped state.
      if (stopRequested.current) {
        stopRequested.current = false
        setPlaying(false)
        setTime(0)
        return
      }

      setTime(player.getCurrentTime())
      const total = player.getDuration()
      if (total > 0) setDuration(total)

      const state = player.getPlayerState()
      // BUFFERING is deliberately ignored: it says nothing about whether the
      // user wants audio, and treating it as "playing" would flip the button
      // back to Pause mid-seek.
      if (state === YTState.PLAYING) setPlaying(true)
      else if (state === YTState.PAUSED) setPlaying(false)
      else if (state === YTState.ENDED) {
        setPlaying(false)
        if (trackId !== null && endedForId.current !== trackId) {
          endedForId.current = trackId
          onTrackEnded?.(trackId)
        }
        // A track reaching its end always continues into the next.
        if (queue.length > 1) advance(1, true)
      }
    }, 250)
    return () => window.clearInterval(id)
  }, [queue.length, advance, trackId, onTrackEnded])

  /**
   * Reports the stream's real length back to the library.
   *
   * Two guards matter here. The duration is reset to 0 whenever a track changes
   * or playback stops, and 0 is never a real length, so a zero is ignored
   * rather than stored — otherwise stopping a track would erase what we know.
   * And the last reported value is remembered per track, so the 250ms poll
   * above cannot turn into a write every tick; a change is reported once and
   * then not again until the number genuinely differs.
   */
  const reportedDuration = useRef(0)

  useEffect(() => {
    reportedDuration.current = 0
  }, [track?.id])

  useEffect(() => {
    if (!track || !onDurationResolved) return
    // The guard this effect was missing.
    //
    // The reset effects above clear `duration` on a track change, but they do it
    // *in the same commit* as the render that already has the new track. So on
    // that render `track` is the incoming track while `duration` is still the
    // outgoing one, and without this check the outgoing track's length gets
    // written onto the incoming track. It looked correct afterwards only because
    // pressing play later reported the real number and quietly overwrote it.
    //
    // `builtTrack` is the one thing that is unambiguous: it holds the id of the
    // track the live player was actually constructed for, and it is cleared the
    // moment the old player is torn down.
    if (builtTrack.current !== track.id) return
    const total = Math.round(duration)
    if (total <= 0 || total === reportedDuration.current) return
    reportedDuration.current = total
    onDurationResolved(track.id, total)
  }, [duration, track, onDurationResolved])

  /**
   * Rebuilds the player for a view, restoring position and playback.
   *
   * Both directions need a rebuild: audio and video stream different videos, so
   * the existing instance cannot simply be resized. Video also needs a bigger
   * frame, which is another reason YouTube's player cannot be reused here.
   */
  const rebuildFor = useCallback(
    (next: View, at: number, autoplay: boolean) => {
      const target = pickSourceForView(track?.sources ?? [], next)
      const host = mountRef.current
      if (!target || !host) return
      const token = ++loadToken.current
      void createPlayer(host, {
        videoId: target.youtubeId,
        // Video mode lets YouTube choose the rendition; audio mode pins a tier.
        quality: next === 'video' ? AUTO_QUALITY : quality,
        // One fixed logical size, scaled to fit by the resize observer.
        width: next === 'audio' ? 1 : VIDEO_FRAME_WIDTH,
        height: next === 'audio' ? 1 : VIDEO_FRAME_HEIGHT,
        // The switch itself is a user gesture, so this one stays audible.
        startVolume: volume,
        startMuted: muted,
      })
        .then((player) => {
          if (token !== loadToken.current) return
          playerRef.current = player
          builtView.current = next
          builtTrack.current = trackId
          setStarted(true)
          setDuration(player.getDuration() || 0)
          if (at > 1) player.seekTo(at, true)
          setTime(at)
          if (autoplay) {
            player.playVideo()
            setPlaying(true)
            // The gesture is spent by the time this promise settles, so a
            // browser may refuse audible autoplay here exactly as it does on a
            // skip. Raise the sound and report it if it was refused, rather
            // than leaving the switch silently muted.
            if (!muted) unmuteIfAllowed(player)
          }
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : youtubeErrorMessage(-1))
        })
    },
    [track, quality, volume, muted, unmuteIfAllowed, trackId],
  )

  /**
   * Rebuilds when the audio/video choice changes.
   *
   * Driven by the view value rather than by a click, so both routes into the
   * switch behave identically. It only applies to a player already built for
   * *this* track:
   * a track change builds through the normal load path instead, and guessing
   * wrong here would race it and produce two players.
   *
   * The previous guard compared source IDs, which was wrong: the whole point of
   * switching views is that the two stream different videos, so the ID always
   * differed and the rebuild was skipped — the player was torn down by the
   * effect above and the switch silently stopped playback. Comparing the track
   * is what actually distinguishes the two cases.
   *
   * `wasPlaying` carries the previous state: playing continues automatically
   * (the toggle click is a user gesture), while stopped stays stopped and waits
   * for a Play press.
   */
  useEffect(() => {
    if (builtView.current === null) return
    if (builtView.current === view) return
    if (builtTrack.current !== trackId) return

    const wasPlaying = playing
    const at = time
    destroyPlayer()
    setStarted(false)
    // Wait for React to swap the mount node before re-creating the player.
    const timer = window.setTimeout(
      () => rebuildFor(view, at, wasPlaying),
      0,
    )
    return () => window.clearTimeout(timer)
    // `playing`/`time` are read as the state at the moment of the switch; adding
    // them would re-run this effect on every poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, trackId, rebuildFor, destroyPlayer])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (maximized) {
      // Leaving fullscreen returns to the Main source in single-pane mode:
      // the overlay was the video, so closing it ends the video view rather
      // than stranding an inline surface nobody asked to watch.
      setMaximized(false)
      exitNativeFullscreen()
      onViewChange?.('audio')
      return
    }
    // Always take over the window first: this works in every browser.
    setMaximized(true)
    void toggleNativeFullscreen(el).catch(() => undefined)
  }, [maximized, onViewChange])

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        // Esc out of native fullscreen counts as the same gesture as the
        // HUD's exit button: back to Main in single-pane mode.
        setMaximized(false)
        // Leaving fullscreen releases the landscape hold the video overlay
        // took: without this the phone would stay landscape-locked back in
        // the library afterwards.
        try {
          // `lock`/`unlock` are missing from this project's DOM types, so
          // they are read structurally: unsupported browsers simply skip.
          const orientation = screen.orientation as
            | { lock?: (orientation: string) => unknown; unlock?: () => void }
            | undefined
          if (orientation && typeof orientation.unlock === 'function') {
            orientation.unlock()
          }
        } catch {
          // Never locked, or lock unsupported.
        }
      }
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // While the maximized overlay covers the viewport, the page underneath must
  // not scroll: its scrollbars are browser chrome drawn *over* the overlay, so a
  // window that overflows for any reason (a narrow window, a long header) would
  // otherwise lay a scrollbar across the bottom of the fullscreen video, on top
  // of the control bar. Restored verbatim on exit.
  useEffect(() => {
    if (!maximized) return
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = overflow
    }
  }, [maximized])

  // --------------------------------------------------------- fullscreen HUD

  /**
   * Reveals the fullscreen control bar while the pointer moves, then hides it
   * after a pause.
   *
   * Listeners are attached only while maximized: outside fullscreen the normal
   * transport is always on screen and a global mousemove handler would be pure
   * overhead. Keyboard activity reveals the bar too, since a viewer using `n`/`p`
   * or `space` may not be touching the pointer at all — and the bar is what
   * shows those shortcuts' effect.
   *
   * Any interaction with the bar itself must also keep it awake, or clicking
   * Play would hide the controls out from under the pointer.
   */
  useEffect(() => {
    if (!maximized) {
      setCursorActive(false)
      return
    }

    let timer: number | undefined
    const reveal = () => {
      setCursorActive(true)
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => setCursorActive(false), HUD_IDLE_MS)
    }

    reveal()
    window.addEventListener('mousemove', reveal)
    window.addEventListener('keydown', reveal)
    window.addEventListener('touchstart', reveal)
    window.addEventListener('wheel', reveal)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener('mousemove', reveal)
      window.removeEventListener('keydown', reveal)
      window.removeEventListener('touchstart', reveal)
      window.removeEventListener('wheel', reveal)
    }
  }, [maximized])

  // Keyboard transport.
  useEffect(() => {
    if (!track) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowRight':
          e.preventDefault()
          seek(Math.min(time + 10, duration || time + 10))
          break
        case 'ArrowLeft':
          e.preventDefault()
          seek(Math.max(0, time - 10))
          break
        case 'n':
          advance(1)
          break
        case 'p':
          advance(-1)
          break
        case 'm':
          toggleMute()
          break
        case '-':
        case '_':
          e.preventDefault()
          nudgeVolume(-5)
          break
        case '=':
        case '+':
          e.preventDefault()
          nudgeVolume(5)
          break
        case 's':
          stop()
          break
        case 'f':
          toggleFullscreen()
          break
        case 'Escape':
          setMaximized(false)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    track,
    togglePlay,
    seek,
    time,
    duration,
    advance,
    toggleMute,
    nudgeVolume,
    stop,
    toggleFullscreen,
  ])

  // ------------------------------------------------------------- render

  if (!track) {
    if (variant === 'dock') {
      return (
        <div className="player dock empty">
          <span className="dock-cover dock-cover-empty" aria-hidden="true">
            <DiscIcon />
          </span>
          <p className="dock-empty-text">Nothing playing</p>
          <button
            type="button"
            className="ghost-btn dock-empty-action"
            onClick={onOpenLibrary}
          >
            Open the library
          </button>
        </div>
      )
    }
    return (
      <section className="player full empty">
        <span className="player-empty-mark" aria-hidden="true">
          <DiscIcon />
        </span>
        <h2>Nothing is playing</h2>
        <p className="hint">
          Pick a playlist or a folder in the library, then press Play.
        </p>
        <button type="button" className="play-primary" onClick={onOpenLibrary}>
          Open the library
        </button>
      </section>
    )
  }

  const progress = duration > 0 ? (time / duration) * 100 : 0

  // The fullscreen bar fades while the pointer rests, but never while paused:
  // hiding the controls when nothing is playing would leave no visible way back
  // to playback.
  const hudVisible = shouldShowHud({ cursorActive, playing })

  // One button that reads Play before anything has started, Pause while
  // playing, and Resume once paused.
  const primaryLabel = playing ? 'Pause' : started ? 'Resume' : 'Play'
  const primaryTitle = playing
    ? 'Pause (space)'
    : started
      ? 'Resume (space)'
      : 'Start streaming (space)'

  // The dock: three zones, the way a hi-fi is laid out. What is playing on the
  // left, the transport and the position in the middle, and the things you set
  // once on the right. Centre is where the eye goes, so centre is where Play
  // and the seek bar are.
  if (variant === 'dock') {
    return (
      <div className="player dock">
        <div className="dock-left">
          <button
            type="button"
            className="dock-cover"
            onClick={onExpand}
            title="Open the player"
            aria-label="Open the player"
          >
            <TrackCover
              coverUrl={track.coverUrl}
              videoId={coverVideoId}
              className="dock-cover-img"
              placeholderClassName="dock-cover-img empty"
            />
          </button>

          <button type="button" className="dock-meta" onClick={onExpand}>
            <span className="dock-title">{track.title}</span>
            <span className="dock-artist">{track.artist}</span>
          </button>
        </div>

        <div className="dock-center">
          <div className="dock-controls">
            <button
              type="button"
              className="dock-btn dock-prev"
              onClick={() => advance(-1)}
              disabled={!onAdvance || queue.length < 2}
              aria-label="Previous track"
              title="Previous (p)"
            >
              <PrevIcon />
            </button>
            <button
              type="button"
              className="dock-btn primary"
              onClick={togglePlay}
              aria-label={primaryLabel}
              title={primaryTitle}
            >
              <PlayIcon playing={playing} />
            </button>
            <button
              type="button"
              className="dock-btn"
              onClick={() => advance(1)}
              disabled={!onAdvance || queue.length < 2}
              aria-label="Next track"
              title="Next (n)"
            >
              <NextIcon />
            </button>
          </div>

          <div className="dock-seek">
            <span className="dock-time">{formatClock(time)}</span>
            <input
              className="seek dock-seek-input"
              type="range"
              min={0}
              max={1000}
              step={1}
              value={duration > 0 ? Math.round((time / duration) * 1000) : 0}
              onChange={(e) => seek((Number(e.target.value) / 1000) * duration)}
              disabled={!started}
              aria-label="Seek"
              aria-valuetext={`${formatClock(time)} of ${formatClock(duration)}`}
              style={{ ['--progress' as string]: `${progress}%` }}
            />
            <span className="dock-time">{formatClock(duration)}</span>
          </div>
        </div>

        <div className="dock-right">
          <div className="dock-volume">
            <button
              type="button"
              className="dock-btn"
              onClick={toggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
              aria-pressed={muted}
              title={muted ? `Unmute (m) — volume ${volume}%` : `Mute (m) — volume ${volume}%`}
            >
              <VolumeIcon muted={muted} />
            </button>
            <input
              className="volume-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={displayVolume(volume, muted)}
              onChange={(e) => setVolume(Number(e.target.value))}
              aria-label="Volume"
              aria-valuetext={muted ? 'muted' : `${volume} percent`}
              style={{ ['--progress' as string]: `${displayVolume(volume, muted)}%` }}
            />
          </div>

          <button
            type="button"
            className="dock-btn dock-expand"
            onClick={onExpand}
            aria-label="Open the player"
            title="Open the player"
          >
            <ChevronUpIcon />
          </button>
        </div>

        {/* The stream lives here in both shapes: the mount is the same node, so
            opening the full view never interrupts what is playing. */}
        <div ref={view !== 'audio' ? undefined : mountRef} className="yt-mount audio" />

        {/* No hairline along the bar's bottom edge any more: the seek bar is in
            the middle of the dock now, and two progress indicators 30px apart
            is one too many. */}
      </div>
    )
  }

  return (
    <section className="player full">
      {/* The way back to the dock, the queue, and the fact that this is a
          screen rather than a corner of one. */}
      <header className="player-screen-head">
        <button
          type="button"
          className="ghost-btn player-back"
          onClick={onCollapse}
          aria-label="Back to the dock"
          title="Back to the dock (Esc)"
        >
          <ChevronDownIcon />
          <span>Back</span>
        </button>
        <span className="player-screen-title">
          {sourceTitle ? `Playing from ${sourceTitle}` : 'Now playing'}
        </span>
        <button
          type="button"
          className={queueOpen ? 'ghost-btn on' : 'ghost-btn'}
          onClick={() => setQueueOpen((open) => !open)}
          aria-expanded={queueOpen}
          aria-label="Show the queue"
          title="Show the queue"
        >
          <QueueIcon />
          <span>{queue.length}</span>
        </button>
      </header>

      {/* Full track information sits above the player. */}
      {/* `has-source` reserves the corner the track-card button sits in, so a
          long note or a wrapped genre row can never run underneath it. */}
      <div className="player-info has-source">
        <TrackCover
          coverUrl={track?.coverUrl}
          videoId={coverVideoId}
          alt={`${track.album ?? track.title} cover`}
          placeholderClassName="cover-placeholder"
          // `rememberCover` decides whether the library should keep a rendered
          // candidate — it only writes over a genuinely empty cover, so index 0
          // on a track that already has one is a no-op.
          onRendered={rememberCover}
        />
        <div className="player-meta">
          {/* The label above the title. It turns a block of metadata into a
              status readout, and the equalizer beside it is the only thing in
              the window that moves on its own — and only while audio really is
              playing, so it can never contradict the transport. */}
          <p className="now-playing">
            <span className={playing ? 'eq' : 'eq off'} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {started ? 'Now playing' : 'Ready'}
            {/* The DJ badge, inline in the status line so it takes no extra
                row: with no Up-next dialog, a drafted pick needs a trace of
                why it is playing. The seed lives in the tooltip (and the
                accessible label) so a long name truncates instead of wrapping. */}
            {djOn && onToggleDj && (
              <span
                className="dj-badge"
                role="status"
                title={
                  isDjSuggestion && djSeedLabel
                    ? `Suggested by DJ — because you played ${djSeedLabel}`
                    : 'DJ on — similar tracks continue after this list'
                }
                aria-label={
                  isDjSuggestion && djSeedLabel
                    ? `Suggested by DJ — because you played ${djSeedLabel}`
                    : 'DJ on — similar tracks continue after this list'
                }
              >
                <span className="dj-badge-mark" aria-hidden="true">
                  ✦
                </span>
                <span className="dj-badge-text" aria-hidden="true">
                  {isDjSuggestion ? 'Suggested by DJ' : 'DJ on'}
                </span>
                <button
                  type="button"
                  className="ghost-btn dj-badge-off"
                  onClick={onToggleDj}
                  title="Turn DJ off"
                  aria-label="Turn DJ off"
                >
                  Turn off
                </button>
              </span>
            )}
          </p>
          <h2>{track.title}</h2>
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

      {error && <p className="surface-error">{error}</p>}

      {/* Video surface only when explicitly requested. */}
      {view !== 'audio' && (
        <div
          ref={containerRef}
          className={`surface video ${maximized ? 'maximized' : ''}`}
        >
          {/* The frame keeps YouTube's fixed logical size and is scaled to fit,
              because the API writes that size inline where CSS cannot reach it. */}
          <div
            className="yt-frame-fit"
            style={{
              transform: `translate(-50%, -50%) scale(${frameScale || 0})`,
            }}
          >
            <div ref={mountRef} className="yt-mount" />
          </div>

          {/* Fullscreen-only control bar. The transport below the surface is
              hidden behind it while maximized, so the controls have to exist
              here too. `pointer-events` is re-enabled on the bar itself (the
              frame disables it so YouTube never sees a hover) so it stays
              clickable, and the whole bar keeps itself awake on interaction. */}
          {maximized && (
            <div
              className={`fs-hud ${hudVisible ? 'show' : 'hide'}`}
              onPointerEnter={() => setCursorActive(true)}
              onPointerLeave={() => setCursorActive(false)}
            >
              <div className="fs-hud-row">
                <button
                  type="button"
                  className="fs-btn"
                  onClick={() => advance(-1)}
                  disabled={!onAdvance || queue.length < 2}
                  aria-label="Previous track"
                  title="Previous (p)"
                >
                  <PrevIcon />
                </button>
                <button
                  type="button"
                  className="fs-btn primary"
                  onClick={togglePlay}
                  aria-label={primaryLabel}
                  title={primaryTitle}
                >
                  <PlayIcon playing={playing} />
                </button>
                <button
                  type="button"
                  className="fs-btn"
                  onClick={stop}
                  disabled={!started}
                  aria-label="Stop"
                  title="Stop (s)"
                >
                  <StopIcon />
                </button>
                <button
                  type="button"
                  className="fs-btn"
                  onClick={() => advance(1)}
                  disabled={!onAdvance || queue.length < 2}
                  aria-label="Next track"
                  title="Next (n)"
                >
                  <NextIcon />
                </button>
                <span className="fs-time">
                  {formatClock(time)} / {formatClock(duration)}
                </span>
                {/* Sound: the button toggles mute and reveals a slider, which
                    is what the transport has permanently. The bar has no room
                    for both, and a control you cannot reach in fullscreen is not
                    a control. Hover opens it too, and it closes when the pointer
                    leaves — but not on blur, so it survives keyboard use. */}
                <div
                  className="fs-volume"
                  onPointerEnter={() => setFsVolumeOpen(true)}
                  onPointerLeave={() => setFsVolumeOpen(false)}
                >
                  <button
                    type="button"
                    className="fs-btn"
                    onClick={() => {
                      toggleMute()
                      setFsVolumeOpen(true)
                    }}
                    aria-label={muted ? 'Unmute and show volume' : 'Mute and show volume'}
                    aria-pressed={muted}
                    aria-expanded={fsVolumeOpen}
                    title={
                      muted
                        ? `Unmute (m) — volume ${volume}%`
                        : `Mute (m) — volume ${volume}%`
                    }
                  >
                    {/* The same drawn mark as the transport, for the same
                        reason: the emoji version was the one coloured thing in
                        an otherwise monochrome bar. */}
                    <VolumeIcon muted={muted} />
                  </button>
                  {fsVolumeOpen && (
                    <input
                      className="volume-slider fs-volume-slider"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={displayVolume(volume, muted)}
                      onChange={(e) => setVolume(Number(e.target.value))}
                      aria-label="Volume"
                      aria-valuetext={muted ? 'muted' : `${volume} percent`}
                      title={`Volume ${displayVolume(volume, muted)}%`}
                      style={{
                        ['--progress' as string]: `${displayVolume(volume, muted)}%`,
                      }}
                    />
                  )}
                </div>
                <button
                  type="button"
                  className="fs-btn"
                  onClick={toggleFullscreen}
                  aria-label="Exit fullscreen"
                  title="Exit fullscreen (Esc)"
                >
                  <FullscreenIcon />
                </button>
              </div>
              <input
                className="seek fs-seek"
                type="range"
                min={0}
                max={Math.max(duration, 1)}
                step={1}
                value={Math.min(time, duration || 0)}
                onChange={(e) => seek(Number(e.target.value))}
                disabled={!started}
                aria-label="Seek"
                style={{ ['--progress' as string]: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Progress, directly under the picture and above the buttons: the bar
          belongs to what is playing, so it sits between the video and the
          controls rather than below them. */}
      {/* Progress */}
      <div className="progress-row">
        <span className="time">{formatClock(time)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={1}
          value={Math.min(time, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!started}
          aria-label="Seek"
          style={{ ['--progress' as string]: `${progress}%` }}
        />
        <span className="time">{formatClock(duration)}</span>
      </div>

      {/* Transport. Always present, always with a working Play button.
          Both groups sit on one centred row while they fit and wrap as whole
          groups when they do not: five icons scattered one-per-line reads as a
          broken layout, two rows read as a decision. */}
      <div className="transport">
        <div className="transport-main">
        <button
          type="button"
          className="t-btn"
          onClick={() => advance(-1)}
          disabled={!onAdvance || queue.length < 2}
          aria-label="Previous track"
          title="Previous (p)"
        >
          <PrevIcon />
        </button>

        <button
          type="button"
          className="t-btn primary"
          onClick={togglePlay}
          aria-label={primaryLabel}
          title={primaryTitle}
        >
          <PlayIcon playing={playing} />
          <span className="t-label">{primaryLabel}</span>
        </button>

        <button
          type="button"
          className="t-btn"
          onClick={() => advance(1)}
          disabled={!onAdvance || queue.length < 2}
          aria-label="Next track"
          title="Next (n)"
        >
          <NextIcon />
        </button>

        {/* Mute and volume ride with the main controls: on narrow screens the
            whole row — previous through volume — stays on one line. */}
        <button
          type="button"
          className="t-btn volume-btn"
          onClick={toggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          title={muted ? `Unmute (m) — volume ${volume}%` : `Mute (m) — volume ${volume}%`}
        >
          <VolumeIcon muted={muted} />
        </button>

        {/* Volume slider. Dragging it is a user gesture, so it also clears a
            sound block left over from an autoplay start. */}
        <input
          className="volume-slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={displayVolume(volume, muted)}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="Volume"
          aria-valuetext={muted ? 'muted' : `${volume} percent`}
          title={`Volume ${displayVolume(volume, muted)}%`}
          style={{
            ['--progress' as string]: `${displayVolume(volume, muted)}%`,
          }}
        />
        </div>

        {/* The card and the filing button belong with the transport, not in a
            corner of the artwork: they act on the track that is playing, which
            is what everything in this row acts on. */}
        {track && (
          <div className="transport-actions">
            {onAddToPlaylist && playlists && (
              <button
                type="button"
                className="t-btn"
                onClick={() => setFileOpen(true)}
                aria-label="Add playing track to playlist"
                title="Add playing track to playlist"
              >
                <FileIcon />
              </button>
            )}
            <button
              type="button"
              className="t-btn"
              onClick={() => onOpenCard?.(track)}
              disabled={!onOpenCard}
              aria-label={`Open ${track.title}'s track card`}
              title="Open the track card — sources, notes, lyrics"
            >
              <TrackCardIcon />
            </button>

          </div>
        )}

        {/* What you are listening to, kept apart from what you do with the
            record: the mode switch is a setting, the two buttons above are
            actions. Three buttons rather than one that flips, because the filled
            one has to answer "which source am I hearing?" at a glance. */}
        <div className="transport-views">
          {(['audio', 'video', 'live'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="t-btn"
                onClick={() => onViewChange?.(option)}
                aria-pressed={view === option}
                aria-label={`Play ${option === 'audio' ? 'Main' : option === 'video' ? 'official video clip' : 'Live'}`}
                title={`Play ${option === 'audio' ? 'Main' : option === 'video' ? 'official video clip' : 'Live'}`}
              >
                {option === 'audio' ? <AudioIcon /> : option === 'video' ? <VideoIcon /> : <span className="live-mark">LIVE</span>}
            </button>
          ))}
        </div>
      </div>

      {soundBlocked && (
        <p className="hint warn">
          Your browser blocked sound on the autoplay. Move the volume slider or
          press <code>m</code> to unmute.
        </p>
      )}

      {/* Quick filing dialog for the playing track: with the DJ on it may come
          from outside the visible list, so the tracklist's own menu cannot
          reach it. A transport button opens it; picking a playlist files the
          track and closes it again. */}
      {fileOpen && onAddToPlaylist && playlists && track && (
        <div
          className="modal-backdrop"
          onClick={() => setFileOpen(false)}
          role="presentation"
        >
          <div
            className="modal file-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${track.title} to a playlist`}
          >
            <header className="modal-header">
              <h2>Add to playlist</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => setFileOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </header>
            <p className="hint file-track">
              {track.title} — {track.artist}
            </p>
            {playlists.length === 0 ? (
              <p className="hint">No playlists yet — create one in the library tree.</p>
            ) : (
              <ul className="file-list">
                {playlists.map((playlist) => {
                  const filed = memberPlaylistIds?.has(playlist.id) ?? false
                  return (
                    <li key={playlist.id}>
                      <button
                        type="button"
                        disabled={filed}
                        title={filed ? 'Already in this playlist' : `Add to ${playlist.name}`}
                        onClick={() => {
                          onAddToPlaylist(playlist.id, track.id)
                          setFileOpen(false)
                        }}
                      >
                        <strong>{playlist.name}</strong>
                        <span className="tally">{filed ? '✓' : playlist.trackCount}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}


      {/* The hidden 1x1 iframe that actually streams the audio. */}
      <div ref={view !== 'audio' ? undefined : mountRef} className="yt-mount audio" />

      <MediaPanel
        track={track}
        pane={pane}
        onPaneChange={onPaneChange ?? (() => undefined)}
        onOpenCard={onOpenCard ? () => onOpenCard(track) : undefined}
      />

      {queueOpen && (
        <section className="queue-panel" aria-label="Queue">
          <div className="queue-head">
            <strong>Up next</strong>
            <span className="hint">
              {queue.length} {queue.length === 1 ? 'track' : 'tracks'}
              {sourceTitle ? ` from ${sourceTitle}` : ''}
            </span>
          </div>
          <ul className="queue-list">
            {queue.map((entry, index) => (
              <li key={entry.id} className={entry.id === trackId ? 'playing' : ''}>
                <button
                  type="button"
                  onClick={() => onSelectTrack?.(entry)}
                  disabled={!onSelectTrack}
                  title={`Play ${entry.title}`}
                >
                  <span className="queue-num">{index + 1}</span>
                  {/* Title and artist read as one line of text, the way a
                      tracklist does; the artist is not a second column. */}
                  <span className="queue-text">
                    <span className="queue-title">{entry.title}</span>
                    <span className="queue-artist">{entry.artist}</span>
                  </span>
                  <span className="queue-time">{formatDuration(entry.duration)}</span>
                </button>
              </li>
            ))}
            {queue.length === 0 && <li className="hint">No list is playing.</li>}
          </ul>
        </section>
      )}
    </section>
  )
}

/**
 * The player's drawn marks.
 *
 * Every control in the transport used to be a Unicode character — ⏮ ▶ ⏹ ⏭ ⛶ 🔊
 * — which looked fine on one machine and not on the next. Those glyphs come out
 * of the system font, so they differ per platform, carry their own weight and
 * colour (the speaker arrived as whatever the emoji font felt like, a yellow
 * shape in an otherwise monochrome row), and sit at wildly different optical
 * sizes inside the same 44px button: the ⏹ rendered as a tiny square next to a
 * ⏭ that filled the box. Drawn here, every mark is the same viewBox, the same
 * stroke weight, and inherits `currentColor`, so the row reads as one set of
 * objects rather than as eight unrelated characters.
 */

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M18 5.6 8.6 12 18 18.4Z" fill="currentColor" />
      <rect x="5" y="5.6" width="2.4" height="12.8" rx="1.2" fill="currentColor" />
    </svg>
  )
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M6 5.6 15.4 12 6 18.4Z" fill="currentColor" />
      <rect x="16.6" y="5.6" width="2.4" height="12.8" rx="1.2" fill="currentColor" />
    </svg>
  )
}

/** Play and pause are the same mark in two states, so they share one glyph. */
function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {playing ? (
        <path d="M7 4.8h3.4v14.4H7zM13.6 4.8H17v14.4h-3.4z" fill="currentColor" />
      ) : (
        <path d="M7.6 4.9 19 12 7.6 19.1Z" fill="currentColor" />
      )}
    </svg>
  )
}


/** Stop: the fullscreen bar keeps it, the transport no longer does. */
function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="5.6" y="5.6" width="12.8" height="12.8" rx="2.4" fill="currentColor" />
    </svg>
  )
}

/** The empty state's mark: the same record as the brand, at rest. */
function DiscIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

/** Four corners: expand on the console, collapse in fullscreen. One mark for
    both, because the button already changes its label and tooltip. */
function FullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M4.5 9V5.6a1 1 0 0 1 1-1H9M15 4.6h3.5a1 1 0 0 1 1 1V9M19.5 15v3.4a1 1 0 0 1-1 1H15M9 19.4H5.5a1 1 0 0 1-1-1V15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The speaker, the lyrics, and the two source modes.
 *
 * These had no Unicode glyph worth using, for the same reasons as the transport
 * marks above. Drawn, they inherit `currentColor` like the YouTube mark on the
 * card above.
 */
function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      {/* The cone: filled, so the button still reads as "sound" at a glance. */}
      <path fill="currentColor" d="M3.5 9.5h3L11 5.4a.6.6 0 0 1 1 .46v12.28a.6.6 0 0 1-1 .46L6.5 14.5h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
      {muted ? (
        /* Muted: the waves are replaced by a cross, rather than drawn as waves
           with something over them, which reads as dirt at 20px. */
        <path
          d="M15 9.5 20.5 15M20.5 9.5 15 15"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <>
          <path
            d="M15 9.6a3.6 3.6 0 0 1 0 4.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M17.9 6.8a7.4 7.4 0 0 1 0 10.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  )
}

/** Words, as lines of text — the lyrics column in one mark. */

/** A note: the audio source. */
function AudioIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M8.6 17.6V5.3L20 3.1v11.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="6.2" cy="18.2" r="2.6" fill="currentColor" />
      <circle cx="17.6" cy="15.6" r="2.6" fill="currentColor" />
    </svg>
  )
}

/** A list with a plus: filing the playing track into a playlist. */
function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M4 6.5h9M4 11h9M4 15.5h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M15.5 13.5v8M11.5 17.5h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** A screen with a play mark: the video source. */
function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <rect
        x="2.6"
        y="4.6"
        width="18.8"
        height="14.8"
        rx="2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M10.2 9.3 15.4 12l-5.2 2.7Z" fill="currentColor" />
    </svg>
  )
}

/** A card with a cover and two lines of text: the record's own page. */
function TrackCardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <rect
        x="2.9"
        y="4.9"
        width="18.2"
        height="14.2"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <circle cx="8" cy="10.1" r="1.75" fill="currentColor" />
      <path
        d="M11.9 9.1h6M11.9 12h4.4M5.8 15.6h12.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}
