import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'
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
import {
  bindMediaSessionHandlers,
  createKeepAliveAudio,
  shouldResumeBackgroundPause,
  syncMediaSessionMetadata,
  syncMediaSessionPlaybackState,
  syncMediaSessionPosition,
  type KeepAliveAudio,
} from '../lib/backgroundAudio'
import { TrackCover } from './TrackCover'
import { MediaPanel, type MediaPane } from './MediaPanel'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  QueueIcon,
  RepeatIcon,
  ShuffleIcon,
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
  /** Bumped when the header Play/Pause button toggles playback in place. */
  toggleToken?: number
  /** Reports whether the player is actively streaming, for the list header's Play/Pause button. */
  onPlayingChange?: (playing: boolean) => void
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
  onOpenCard?: (track: TrackWithSources, edit?: boolean) => void
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
  /**
   * The list-level switches, repeated beside Up next.
   *
   * The header beside the tracklist owns them, but the queue is where you
   * notice that the end of the list is coming — so the two settings that decide
   * what happens there sit next to the tracks they apply to.
   */
  shuffle?: boolean
  repeat?: boolean
  onToggleShuffle?: (() => void) | null
  onToggleRepeat?: (() => void) | null
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

const PROGRESS_STORAGE_KEY = 'trackvault.playbackProgress'

interface StoredPlaybackProgress {
  trackId: number
  time: number
  duration: number
}

function readStoredProgress(trackId: number | null): StoredPlaybackProgress | null {
  if (trackId === null || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PROGRESS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredPlaybackProgress>
    if (
      parsed.trackId === trackId &&
      typeof parsed.time === 'number' &&
      Number.isFinite(parsed.time) &&
      parsed.time >= 0
    ) {
      return {
        trackId,
        time: parsed.time,
        duration:
          typeof parsed.duration === 'number' &&
          Number.isFinite(parsed.duration) &&
          parsed.duration > 0
            ? parsed.duration
            : 0,
      }
    }
  } catch {
    // Ignore storage errors.
  }
  return null
}

function writeStoredProgress(
  trackId: number | null,
  time: number,
  duration: number,
): void {
  if (trackId === null || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      PROGRESS_STORAGE_KEY,
      JSON.stringify({
        trackId,
        time: Math.max(0, Math.floor(time)),
        duration: Math.max(0, Math.floor(duration)),
      }),
    )
  } catch {
    // Ignore storage errors.
  }
}

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
  toggleToken = 0,
  onPlayingChange,
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
  shuffle = false,
  repeat = false,
  onToggleShuffle = null,
  onToggleRepeat = null,
  memberPlaylistIds,
}: Props) {
  const initialProgress = useMemo(
    () => readStoredProgress(track?.id ?? null),
    // Read once on mount for the restored track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [quality] = useState<PlaybackQuality>(AUDIO_SAVER_QUALITY)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [time, setTime] = useState(() => initialProgress?.time ?? 0)
  const [duration, setDuration] = useState(
    () => initialProgress?.duration || track?.duration || 0,
  )
  const resumeOffsetRef = useRef<number>(initialProgress?.time ?? 0)
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
  const fileDialog = useRef<HTMLDivElement | null>(null)
  useFocusTrap(fileDialog, fileOpen)
  // The queue is a sheet over the full view rather than a third column: it is
  // read for a moment and dismissed, and what is coming next is never worth a
  // permanent third of the window.
  const [queueOpen, setQueueOpen] = useState(false)
  // Whether the words under the transport are showing. Closed on arrival: the
  // text is something you ask for, and asking for the face that is already
  // showing puts it away again.
  const [paneOpen, setPaneOpen] = useState(false)
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
  // The YouTube video ID currently loaded inside `playerRef.current`. Keeping
  // the single YT.Player iframe alive across track changes and calling
  // `loadVideoById` preserves the browser's gesture-unlocked media session so
  // background tabs and mobile browsers continue playing when a track ends.
  const loadedVideoId = useRef<string | null>(null)
  // True once the current load's ENDED transition has been handled, preventing
  // `onStateChange(ENDED)` and the 250ms poll from double-advancing.
  const endedHandledRef = useRef(false)
  // Tracks whether the listener intends for audio to be playing (as opposed to
  // an unsolicited pause emitted by mobile browsers when switching apps).
  const wantPlayingRef = useRef(false)
  // Timestamp when the document was last hidden or blurred, and consecutive
  // auto-resume attempts during that background session.
  const lastBackgroundedAtRef = useRef(0)
  const bgResumeAttemptsRef = useRef(0)
  // Top-level silent looping <audio> session so mobile browsers keep the tab's
  // audio focus alive across track transitions and app switches.
  const keepAliveRef = useRef<KeepAliveAudio | null>(null)
  useEffect(() => {
    const keepAlive = createKeepAliveAudio()
    keepAliveRef.current = keepAlive
    return () => {
      keepAlive.destroy()
      keepAliveRef.current = null
    }
  }, [])

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
  // What the live player was built for.
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
   * Tears down the current player on unmount or when the active track is
   * cleared entirely.
   */
  const destroyPlayer = useCallback(() => {
    // Invalidate any in-flight load so its result is ignored.
    loadToken.current++
    wantPlayingRef.current = false
    keepAliveRef.current?.stop()
    try {
      playerRef.current?.destroy()
    } catch {
      // Destroying an already-detached player throws in some browsers.
    }
    playerRef.current = null
    loadedVideoId.current = null
    builtView.current = null
    builtTrack.current = null
    endedHandledRef.current = false
  }, [])

  // Leaving video view has no surface to stay fullscreen on, so fullscreen ends.
  useEffect(() => {
    if (view !== 'audio') return
    setMaximized(false)
    if (document.fullscreenElement) void document.exitFullscreen?.()
  }, [view])

  // The dock has no picture on it, so a track being watched goes back to Main
  // the moment the player shrinks. Left alone it would keep fetching video for
  // a one-pixel stage nobody can see, and reopening the sheet would then show a
  // clip that had been running off-screen the whole time.
  useEffect(() => {
    if (variant !== 'dock' || view === 'audio') return
    onViewChange?.('audio')
  }, [variant, view, onViewChange])

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

  // Stable refs for event callbacks attached when YT.Player is first created.
  const onPlayerStateChangeRef = useRef<(state: number) => void>(() => undefined)
  const onPlayerErrorRef = useRef<(message: string) => void>(() => undefined)

  /**
   * Creates the player on first play and reuses it across subsequent track
   * changes and view switches via `loadVideoById` / `cueVideoById`.
   *
   * Keeping the single `YT.Player` iframe alive is what allows continuous
   * background playback: once the user's initial Play gesture unlocks the
   * iframe's media element, loading the next track into that same instance
   * preserves the active audio session even when the browser tab is hidden.
   */
  const start = useCallback(
    async (autoplay: boolean, fromGesture = true, startSeconds = 0) => {
      const host = mountRef.current
      if (!source || !host) return

      stopRequested.current = false
      wantPlayingRef.current = autoplay
      if (autoplay) keepAliveRef.current?.start()
      else keepAliveRef.current?.stop()

      const frameWidth = view === 'audio' ? 1 : VIDEO_FRAME_WIDTH
      const frameHeight = view === 'audio' ? 1 : VIDEO_FRAME_HEIGHT

      // Reuse the live player instance whenever one already exists.
      const existing = playerRef.current
      if (existing) {
        loadToken.current++
        try {
          existing.setSize?.(frameWidth, frameHeight)
          const iframe = existing.getIframe?.()
          if (iframe) {
            iframe.setAttribute('width', String(frameWidth))
            iframe.setAttribute('height', String(frameHeight))
          }
        } catch {
          // Stubs without setSize/getIframe are unaffected.
        }

        applyAudio(existing, volume, muted)
        setError(null)
        setSoundBlocked(false)
        endedHandledRef.current = false
        bgResumeAttemptsRef.current = 0
        builtView.current = view
        builtTrack.current = trackId

        const sameVideo = loadedVideoId.current === source.youtubeId
        loadedVideoId.current = source.youtubeId

        if (autoplay) {
          setStarted(true)
          setPlaying(true)
          if (sameVideo) {
            if (startSeconds > 0) {
              existing.seekTo(startSeconds, true)
              setTime(startSeconds)
            } else if (
              existing.getCurrentTime() > 1 ||
              existing.getPlayerState() === YTState.ENDED
            ) {
              existing.seekTo(0, true)
              setTime(0)
            }
            existing.playVideo()
          } else {
            setTime(startSeconds)
            if (startSeconds === 0) setDuration(0)
            existing.loadVideoById(
              source.youtubeId,
              startSeconds,
              effectiveQuality === AUTO_QUALITY ? undefined : effectiveQuality,
            )
            existing.playVideo()
          }
          if (effectiveQuality !== AUTO_QUALITY) {
            try {
              existing.setPlaybackQuality(effectiveQuality)
            } catch {
              // Quality hint only.
            }
          }
        } else {
          setPlaying(false)
          if (!sameVideo) {
            setStarted(false)
            setTime(startSeconds)
            setDuration(0)
            if (typeof existing.cueVideoById === 'function') {
              existing.cueVideoById(
                source.youtubeId,
                startSeconds,
                effectiveQuality === AUTO_QUALITY ? undefined : effectiveQuality,
              )
            } else {
              existing.stopVideo()
            }
          } else {
            if (startSeconds > 0) {
              existing.seekTo(startSeconds, true)
              setTime(startSeconds)
            }
            existing.pauseVideo()
          }
        }
        return
      }

      // First-time player creation. Browsers only allow audible playback
      // started from a user gesture, so a muted start is used only if initial
      // creation ever happens without one.
      const mustStartMuted = autoplay && !fromGesture

      const token = ++loadToken.current
      try {
        setError(null)
        const player = await createPlayer(host, {
          videoId: source.youtubeId,
          quality: effectiveQuality,
          width: frameWidth,
          height: frameHeight,
          startVolume: volume,
          startMuted: mustStartMuted && !muted,
          onStateChange: (state) => onPlayerStateChangeRef.current(state),
          onError: (message) => onPlayerErrorRef.current(message),
        })
        // A newer load superseded this one.
        if (token !== loadToken.current) {
          try {
            player.destroy()
          } catch {
            // Ignore
          }
          return
        }

        playerRef.current = player
        loadedVideoId.current = source.youtubeId
        builtView.current = view
        builtTrack.current = trackId
        endedHandledRef.current = false
        bgResumeAttemptsRef.current = 0
        setStarted(true)
        setDuration(player.getDuration() || 0)
        if (startSeconds > 1) {
          player.seekTo(startSeconds, true)
          setTime(startSeconds)
        }

        if (autoplay) {
          player.playVideo()
          setPlaying(true)
          if (mustStartMuted && !muted) unmuteIfAllowed(player)
        }
      } catch (e: unknown) {
        if (token !== loadToken.current) return
        wantPlayingRef.current = false
        keepAliveRef.current?.stop()
        setError(e instanceof Error ? e.message : youtubeErrorMessage(-1))
        setStarted(false)
      }
    },
    [
      source,
      effectiveQuality,
      view,
      volume,
      muted,
      applyAudio,
      unmuteIfAllowed,
      trackId,
    ],
  )

  /**
   * Opens or closes the text below the transport.
   *
   * One face at a time: choosing the other face swaps the text instead of
   * stacking it, and choosing the face that is already showing puts it away.
   */
  const showPane = useCallback(
    (next: MediaPane) => {
      if (paneOpen && pane === next) {
        setPaneOpen(false)
        return
      }
      onPaneChange?.(next)
      setPaneOpen(true)
    },
    [paneOpen, pane, onPaneChange],
  )

  const togglePlay = useCallback(() => {
    // Not started yet: the first press starts the stream (resuming from any
    // saved playback timestamp when re-opening the app).
    const player = playerRef.current
    if (!started || !player) {
      const startAt = resumeOffsetRef.current
      resumeOffsetRef.current = 0
      void start(true, true, startAt)
      return
    }
    // Decide from our own `playing` state rather than getPlayerState(). While a
    // video is BUFFERING the live state is 3, which is not PLAYING, so a
    // state-based check would read "not playing" and call playVideo() — turning
    // a pause press into an unpause.
    if (playing) {
      wantPlayingRef.current = false
      keepAliveRef.current?.stop()
      player.pauseVideo()
      setPlaying(false)
    } else {
      wantPlayingRef.current = true
      keepAliveRef.current?.start()
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
    wantPlayingRef.current = false
    keepAliveRef.current?.stop()
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
    setTime(seconds)
    const player = playerRef.current
    if (!player) {
      resumeOffsetRef.current = seconds
      return
    }
    player.seekTo(seconds, true)
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
   * continue.
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
      const carry = shouldCarryPlayback({
        playing: playing || wantPlayingRef.current,
        playerState: liveState,
        forced: forcePlay,
      })
      autoplayNext.current = carry
      onAdvance(direction)
      // When repeating a single-track list, `onAdvance` selects the same track
      // ID, so restart it in place when playback should carry.
      if (carry && repeat && queue.length === 1 && trackId !== null) {
        autoplayNext.current = false
        void start(true, false, 0)
      }
    },
    [onAdvance, playing, repeat, queue.length, trackId, start],
  )

  /**
   * Unified transition effect for track changes, view switches, and explicit
   * Play requests (`playToken`).
   *
   * Handling all three in one place avoids competing effects tearing down or
   * racing the shared `YT.Player` instance.
   */
  const seenState = useRef<{
    trackId: number | null
    videoId: string | null
    view: View
    playToken: number
  }>({
    trackId,
    videoId: source?.youtubeId ?? null,
    view,
    playToken,
  })

  // Persist playback position so closing and re-opening the app restores the
  // exact timestamp in the song.
  useEffect(() => {
    if (trackId === null) return
    writeStoredProgress(trackId, time, duration || track?.duration || 0)
  }, [trackId, time, duration, track?.duration])

  useEffect(() => {
    onPlayingChange?.(playing)
  }, [playing, onPlayingChange])

  const seenToggleTokenRef = useRef(toggleToken)
  useEffect(() => {
    if (toggleToken === seenToggleTokenRef.current) return
    seenToggleTokenRef.current = toggleToken
    if (trackId !== null) {
      togglePlay()
    }
  }, [toggleToken, trackId, togglePlay])

  useEffect(() => {
    const prev = seenState.current
    const videoId = source?.youtubeId ?? null
    const tokenChanged = playToken !== prev.playToken
    const trackChanged = trackId !== prev.trackId
    const viewChanged = view !== prev.view
    const videoChanged = videoId !== prev.videoId

    seenState.current = {
      trackId,
      videoId,
      view,
      playToken,
    }

    if (!tokenChanged && !trackChanged && !viewChanged && !videoChanged) {
      return
    }

    // Track was cleared (e.g. deleted while playing) or has no playable source.
    if (trackId === null || !source) {
      autoplayNext.current = false
      wantPlayingRef.current = false
      resumeOffsetRef.current = 0
      keepAliveRef.current?.stop()
      if (trackId === null) {
        destroyPlayer()
      } else {
        try {
          playerRef.current?.stopVideo()
        } catch {
          // Ignore
        }
      }
      setPlaying(false)
      setStarted(false)
      setTime(0)
      setDuration(0)
      setError(null)
      return
    }

    // 1. Explicit Play press from tracklist, playlist header, or queue row.
    if (tokenChanged) {
      autoplayNext.current = false
      resumeOffsetRef.current = 0
      if (trackChanged || videoChanged) {
        setTime(0)
        setDuration(0)
        setError(null)
      }
      void start(true, true, 0)
      return
    }

    // 2. Track changed (via Next / Previous or end-of-track auto-advance).
    if (trackChanged) {
      const shouldPlay = autoplayNext.current
      autoplayNext.current = false
      resumeOffsetRef.current = 0
      setTime(0)
      setDuration(track?.duration ?? 0)
      setError(null)
      if (shouldPlay) {
        void start(true, false, 0)
      } else {
        wantPlayingRef.current = false
        keepAliveRef.current?.stop()
        setPlaying(false)
        setStarted(false)
        if (playerRef.current) {
          void start(false, false, 0)
        }
      }
      return
    }

    // 3. Same track, view switched (Main <-> Video <-> Live) or source URL edited.
    if (viewChanged || videoChanged) {
      if (!playerRef.current && !wantPlayingRef.current && !playing) {
        return
      }
      const resumePlay = wantPlayingRef.current || playing
      const resumeAt = viewChanged && !trackChanged ? time : 0
      void start(resumePlay, true, resumeAt)
    }
  }, [trackId, track?.duration, source, view, playToken, start, destroyPlayer, playing, time])

  /**
   * Handles state transitions reported by the YouTube iframe (`onStateChange`)
   * or detected by the fallback poll.
   *
   * Processing `YTState.ENDED` immediately from `onStateChange` is critical for
   * background playback: browsers throttle `setInterval` when a tab is hidden,
   * whereas the iframe's `onStateChange` event arrives as soon as the track
   * finishes.
   */
  const handleTrackEnd = useCallback(() => {
    if (endedHandledRef.current) return
    endedHandledRef.current = true
    setPlaying(false)
    if (trackId !== null && endedForId.current !== trackId) {
      endedForId.current = trackId
      onTrackEnded?.(trackId)
    }
    // Always ask `advance(1, true)` to step to the next track; `App.tsx`
    // checks the queue, repeat, and DJ station and stops cleanly if none remain.
    if (queue.length > 0) {
      advance(1, true)
      // If `onAdvance` was at the end of a non-repeating list, no track change
      // will consume `autoplayNext`; clear it on the next macrotask if still idle.
      window.setTimeout(() => {
        if (endedHandledRef.current) {
          autoplayNext.current = false
          wantPlayingRef.current = false
          keepAliveRef.current?.stop()
        }
      }, 500)
    } else {
      wantPlayingRef.current = false
      keepAliveRef.current?.stop()
    }
  }, [trackId, onTrackEnded, queue.length, advance])

  useEffect(() => {
    onPlayerStateChangeRef.current = (state: number) => {
      const player = playerRef.current
      if (!player) return
      if (stopRequested.current) {
        stopRequested.current = false
        setPlaying(false)
        setTime(0)
        return
      }

      if (state === YTState.PLAYING) {
        endedHandledRef.current = false
        bgResumeAttemptsRef.current = 0
        setPlaying(true)
        setStarted(true)
        setError(null)
        if (wantPlayingRef.current) keepAliveRef.current?.start()
        const total = player.getDuration()
        if (total > 0) setDuration(total)
        return
      }

      if (state === YTState.ENDED) {
        handleTrackEnd()
        return
      }

      if (state === YTState.PAUSED) {
        const visibilityState =
          typeof document !== 'undefined' ? document.visibilityState : 'visible'
        const msSinceBackgrounded =
          lastBackgroundedAtRef.current > 0
            ? Date.now() - lastBackgroundedAtRef.current
            : Number.POSITIVE_INFINITY

        // Mobile browsers and YouTube's embed script often emit an unsolicited
        // PAUSED event when the user switches to another app. If the listener
        // did not pause playback, immediately resume the stream.
        if (
          shouldResumeBackgroundPause({
            wantPlaying: wantPlayingRef.current,
            stopRequested: stopRequested.current,
            visibilityState,
            msSinceBackgrounded,
            resumeAttempts: bgResumeAttemptsRef.current,
          })
        ) {
          bgResumeAttemptsRef.current += 1
          keepAliveRef.current?.start()
          try {
            player.playVideo()
          } catch {
            // Ignore
          }
          window.setTimeout(() => {
            if (wantPlayingRef.current && playerRef.current) {
              try {
                playerRef.current.playVideo()
              } catch {
                // Ignore
              }
            }
          }, 180)
          return
        }

        setPlaying(false)
      }
    }

    onPlayerErrorRef.current = (message: string) => {
      setError(message)
      setPlaying(false)
      // If a broken link is encountered during continuous queue playback,
      // skip ahead to the next track rather than stalling background music.
      if (wantPlayingRef.current && queue.length > 1) {
        advance(1, true)
      } else {
        wantPlayingRef.current = false
        keepAliveRef.current?.stop()
      }
    }
  }, [handleTrackEnd, queue.length, advance])

  // Poll for progress time and act as a safety net for state changes.
  useEffect(() => {
    const id = window.setInterval(() => {
      const player = playerRef.current
      if (!player) return

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
      if (state === YTState.PLAYING) {
        endedHandledRef.current = false
        setPlaying(true)
      } else if (state === YTState.PAUSED) {
        onPlayerStateChangeRef.current(YTState.PAUSED)
      } else if (state === YTState.ENDED) {
        handleTrackEnd()
      }
    }, 250)
    return () => window.clearInterval(id)
  }, [handleTrackEnd])

  // Keep background playback alive across tab switches and mobile app switches.
  useEffect(() => {
    const onBackground = () => {
      lastBackgroundedAtRef.current = Date.now()
      bgResumeAttemptsRef.current = 0
      const player = playerRef.current
      if (!player || !wantPlayingRef.current) return
      // Pinning the lowest video tier while hidden avoids mobile GPU video
      // decoder suspension when the browser leaves the foreground.
      try {
        player.setPlaybackQuality(quality)
      } catch {
        // Ignore
      }
      keepAliveRef.current?.start()
      try {
        const state = player.getPlayerState()
        if (state === YTState.PAUSED) {
          player.playVideo()
        } else if (state === YTState.ENDED) {
          handleTrackEnd()
        }
      } catch {
        // Ignore
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        onBackground()
      } else if (document.visibilityState === 'visible') {
        bgResumeAttemptsRef.current = 0
        const player = playerRef.current
        if (!player) return
        try {
          const state = player.getPlayerState()
          if (state === YTState.ENDED) {
            handleTrackEnd()
          } else if (state === YTState.PLAYING) {
            setPlaying(true)
          } else if (state === YTState.PAUSED && !wantPlayingRef.current) {
            setPlaying(false)
          }
        } catch {
          // Ignore
        }
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onBackground)
    window.addEventListener('blur', onBackground)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onBackground)
      window.removeEventListener('blur', onBackground)
    }
  }, [quality, handleTrackEnd])

  // OS lock-screen, notification-shade, and hardware media key integration.
  useEffect(() => {
    syncMediaSessionMetadata(track, coverVideoId)
  }, [track, coverVideoId])

  useEffect(() => {
    syncMediaSessionPlaybackState(playing, track !== null)
  }, [playing, track])

  useEffect(() => {
    if (started && duration > 0) {
      syncMediaSessionPosition(time, duration)
    }
  }, [started, time, duration])

  useEffect(() => {
    if (!track) return
    return bindMediaSessionHandlers({
      onPlay: () => {
        wantPlayingRef.current = true
        keepAliveRef.current?.start()
        const player = playerRef.current
        if (!started || !player) {
          void start(true, true)
        } else {
          player.playVideo()
          setPlaying(true)
        }
      },
      onPause: () => {
        wantPlayingRef.current = false
        keepAliveRef.current?.stop()
        const player = playerRef.current
        if (player) player.pauseVideo()
        setPlaying(false)
      },
      onPrevious:
        onAdvance && queue.length > 0 ? () => advance(-1) : undefined,
      onNext:
        onAdvance && queue.length > 0 ? () => advance(1) : undefined,
      onSeekTo: started ? (seconds) => seek(seconds) : undefined,
      onStop: started ? () => stop() : undefined,
    })
  }, [track, started, start, onAdvance, queue.length, advance, seek, stop])

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
    if (builtTrack.current !== track.id) return
    const total = Math.round(duration)
    if (total <= 0 || total === reportedDuration.current) return
    reportedDuration.current = total
    onDurationResolved(track.id, total)
  }, [duration, track, onDurationResolved])

  const toggleFullscreen = useCallback(() => {
    // There is no picture to watch in audio mode, and the stage is a one-pixel
    // sink there: taking that fullscreen would fill the window with a black box.
    if (view === 'audio') return
    const el = containerRef.current
    if (!el) return
    if (maximized) {
      // Leaving fullscreen shrinks the same video back into the sheet. It used
      // to fall back to Main, which turned a clip you were two minutes into
      // into a black box: the source you picked is a property of the track, not
      // of how much of the window the picture is using.
      setMaximized(false)
      exitNativeFullscreen()
      return
    }
    // Always take over the window first: this works in every browser.
    setMaximized(true)
    void toggleNativeFullscreen(el).catch(() => undefined)
  }, [maximized, view])

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) {
        // Esc out of native fullscreen is the same gesture as the HUD's exit
        // button, and it keeps whatever source was on screen.
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

  // The queue can be hundreds of rows and this component re-renders on every
  // progress tick, so the rows are rebuilt only when the queue itself (or the
  // playing row) changes — not on every tick of the clock. Declared above the
  // empty-player return so the hooks stay unconditional.
  const queueRows = useMemo(
    () =>
      queue.map((entry, index) => (
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
      )),
    [queue, trackId, onSelectTrack],
  )

  // ------------------------------------------------------------- render

  if (!track) {
    if (variant === 'dock') {
      return (
        <div className="player dock empty">
          <span className="dock-cover dock-cover-empty" aria-hidden="true">
            <DiscIcon />
          </span>
          <p className="dock-empty-text">Nothing playing</p>
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

  /**
   * The stage: the one node the stream lives in.
   *
   * It is the first child of both shapes on purpose. React reconciles children
   * by position, so keeping it at index 0 in the dock and in the sheet is what
   * lets the two layouts trade places around a frame that never moves — and a
   * frame that never moves is a stream that never stops. Audio mode and the dock
   * give it the `sink` class: still mounted, still streaming, just a one-pixel
   * box with no picture to show.
   */
  const sink = view === 'audio' || variant === 'dock'
  const stage = (
    <div
      ref={containerRef}
      className={['surface', sink ? 'sink' : 'video', maximized ? 'maximized' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {/* The frame keeps YouTube's fixed logical size and is scaled to fit,
          because the API writes that size inline where CSS cannot reach it. A
          sink keeps the scale at 1: a zero-sized frame is a frame a browser may
          stop rendering, and the sound has to keep coming out of it. */}
      <div
        className="yt-frame-fit"
        style={{
          transform: `translate(-50%, -50%) scale(${sink ? 1 : frameScale || 0})`,
        }}
      >
        <div ref={mountRef} className="yt-mount" />
      </div>

      {/* The fullscreen bar. The transport is behind the picture while
          maximized, so the controls have to exist here too. It carries what a
          viewer watching a video needs: the two skips, play/pause, the volume
          and the way out. YouTube's own controls are never shown — the frame
          takes no pointer events, so it never even draws them. */}
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
            {/* The button toggles mute and reveals a slider, which is what the
                transport has permanently; the bar has no room for both. */}
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
  )

  // The dock: three zones, the way a hi-fi is laid out. What is playing on the
  // left, the transport and the position in the middle, and the things you set
  // once on the right. Centre is where the eye goes, so centre is where Play
  // and the seek bar are.
  if (variant === 'dock') {
    return (
      <div className="player dock">
        {stage}
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

        {/* No hairline along the bar's bottom edge any more: the seek bar is in
            the middle of the dock now, and two progress indicators 30px apart
            is one too many. */}
      </div>
    )
  }

  return (
    <div className="player full">
      {stage}
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

        {/* What the track says, as two buttons in the row rather than a switch
            of its own: they open the text below, and pressing the same one again
            puts it away. */}
        <div className="transport-panes">
          <button
            type="button"
            className="t-btn"
            onClick={() => showPane('info')}
            aria-pressed={paneOpen && pane === 'info'}
            aria-expanded={paneOpen && pane === 'info'}
            aria-controls="media-body"
            aria-label="Show track information"
            title="Info"
          >
            <InfoIcon />
          </button>
          <button
            type="button"
            className="t-btn"
            onClick={() => showPane('lyrics')}
            aria-pressed={paneOpen && pane === 'lyrics'}
            aria-expanded={paneOpen && pane === 'lyrics'}
            aria-controls="media-body"
            aria-label="Show the lyrics"
            title="Lyrics"
          >
            <LyricsIcon />
          </button>
        </div>

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
          {/* Only a picture can be watched fullscreen, so the control exists
              only while there is one. */}
          {view !== 'audio' && (
            <button
              type="button"
              className="t-btn"
              onClick={toggleFullscreen}
              aria-label="Watch fullscreen"
              title="Fullscreen (f)"
            >
              <FullscreenIcon />
            </button>
          )}
        </div>

        {/* Filing and the card sit at the right end of the row, past the modes:
            they act on the track that is playing, which is what the mode switch
            also describes — but they are actions, not settings, so they follow
            the row's reading order instead of interrupting it. */}
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
            ref={fileDialog}
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


      {paneOpen && (
        <MediaPanel
          track={track}
          pane={pane}
          onOpenCard={onOpenCard ? (edit) => onOpenCard(track, edit) : undefined}
        />
      )}

      {queueOpen && (
        <section className="queue-panel" aria-label="Queue">
          <div className="queue-head">
            <strong>Up next</strong>
            <span className="hint">
              {queue.length} {queue.length === 1 ? 'track' : 'tracks'}
              {sourceTitle ? ` from ${sourceTitle}` : ''}
            </span>
            {/* The three switches that decide what happens at the end of the
                list, next to the list they act on: Shuffle and Repeat are the
                same state the tracklist header's chips flip, and DJ is the
                station. */}
            <div className="queue-tools">
              <button
                type="button"
                className="q-tool"
                aria-pressed={shuffle}
                aria-label="Shuffle"
                title={shuffle ? 'Shuffle on' : 'Shuffle this list'}
                disabled={!onToggleShuffle}
                onClick={() => onToggleShuffle?.()}
              >
                <ShuffleIcon />
              </button>
              <button
                type="button"
                className="q-tool"
                aria-pressed={repeat}
                aria-label="Repeat"
                title={repeat ? 'Repeat on — the list starts again at the end' : 'Repeat this list'}
                disabled={!onToggleRepeat}
                onClick={() => onToggleRepeat?.()}
              >
                <RepeatIcon />
              </button>
              {onToggleDj && (
                <button
                  type="button"
                  className="q-tool"
                  aria-pressed={djOn}
                  aria-label="DJ"
                  title={
                    djOn
                      ? 'DJ on — turn the station off'
                      : 'DJ this list — keep playing similar tracks after it ends'
                  }
                  onClick={onToggleDj}
                >
                  <span className="q-dj" aria-hidden="true">
                    ✦
                  </span>
                </button>
              )}
            </div>
          </div>
          <ul className="queue-list">
            {queueRows}
            {queue.length === 0 && <li className="hint">No list is playing.</li>}
          </ul>
        </section>
      )}
    </div>
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


/** An "i" in a circle: what the track is. */
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M12 11v5.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="8.2" r="1.3" fill="currentColor" />
    </svg>
  )
}

/** Lines of words: the lyrics. */
function LyricsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        d="M4.5 6.5h15M4.5 11.5h12M4.5 16.5h8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
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
