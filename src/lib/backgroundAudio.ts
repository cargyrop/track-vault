/**
 * Background playback & mobile OS media session helpers.
 *
 * Mobile and desktop browsers restrict background tabs in three ways when
 * audio comes from a cross-origin YouTube `<iframe>`:
 *
 * 1. If the top-level document has no active `<audio>` element of its own,
 *    mobile browsers (iOS Safari, Android Chrome) can suspend the tab when the
 *    user switches to another app — or during the brief buffering gap between
 *    one track ending and the next `loadVideoById` stream starting.
 * 2. Without `navigator.mediaSession` metadata and action handlers, the OS
 *    does not treat the tab as an active music player or show lock-screen /
 *    notification-shade controls.
 * 3. When the user switches apps on mobile, the embedded player or browser may
 *    emit an unsolicited `PAUSED` state on `visibilitychange` even though the
 *    listener never pressed Pause.
 *
 * This module provides pure, testable primitives and safe browser bindings for
 * all three.
 */

/** Window after `visibilitychange` during which an unsolicited pause is treated as background-induced. */
export const BACKGROUND_PAUSE_GRACE_MS = 2000

/** Maximum consecutive auto-resume attempts while hidden before yielding audio focus. */
export const MAX_BACKGROUND_RESUME_ATTEMPTS = 3

/**
 * Generates a tiny valid 16-bit mono PCM WAV buffer with a 1-LSB alternating
 * signal (-90.3 dBFS).
 *
 * Pure digital zero (`0x0000`) is detected and gated by several mobile OS
 * audio mixers as silence; alternating `+1` and `-1` out of `32767` is
 * completely inaudible to human ears while keeping the OS audio session open.
 */
export function buildSilentWavBytes(
  sampleRate = 8000,
  durationSeconds = 1,
): Uint8Array {
  const safeRate = Math.max(1000, Math.min(48000, Math.floor(sampleRate)))
  const numSamples = Math.max(1, Math.floor(safeRate * durationSeconds))
  const bytesPerSample = 2
  const dataSize = numSamples * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  // RIFF chunk descriptor
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')

  // fmt sub-chunk (16-bit mono PCM)
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true) // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true) // NumChannels (1 = mono)
  view.setUint32(24, safeRate, true) // SampleRate
  view.setUint32(28, safeRate * bytesPerSample, true) // ByteRate
  view.setUint16(32, bytesPerSample, true) // BlockAlign
  view.setUint16(34, 16, true) // BitsPerSample

  // data sub-chunk
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true)
  }

  return new Uint8Array(buffer)
}

/** Encodes a `Uint8Array` into a `data:audio/wav;base64,...` URI. */
export function createSilentWavDataUri(
  sampleRate = 8000,
  durationSeconds = 1,
): string {
  const bytes = buildSilentWavBytes(sampleRate, durationSeconds)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const encoded =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64')
  return `data:audio/wav;base64,${encoded}`
}

export interface KeepAliveAudio {
  start(): void
  stop(): void
  destroy(): void
}

/**
 * Manages a looping, near-silent `<audio>` element in the top-level document
 * so the browser tab holds onto its OS audio session across track transitions
 * and app switches.
 */
export function createKeepAliveAudio(): KeepAliveAudio {
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null

  const ensureElement = (): HTMLAudioElement | null => {
    if (audio) return audio
    if (typeof document === 'undefined' || typeof Audio === 'undefined') {
      return null
    }
    try {
      const el = new Audio()
      el.loop = true
      el.preload = 'auto'
      el.volume = 0.01
      el.setAttribute('playsinline', 'true')
      el.setAttribute('webkit-playsinline', 'true')

      const wavBytes = buildSilentWavBytes(8000, 1)
      if (
        typeof Blob !== 'undefined' &&
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        try {
          objectUrl = URL.createObjectURL(
            new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }),
          )
          el.src = objectUrl
        } catch {
          el.src = createSilentWavDataUri(8000, 1)
        }
      } else {
        el.src = createSilentWavDataUri(8000, 1)
      }
      audio = el
      return el
    } catch {
      return null
    }
  }

  return {
    start() {
      const el = ensureElement()
      if (!el) return
      try {
        if (el.paused) {
          const playPromise = el.play()
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => undefined)
          }
        }
      } catch {
        // Autoplay restriction before user gesture; next gesture will start it.
      }
    },
    stop() {
      if (!audio) return
      try {
        audio.pause()
      } catch {
        // Ignore
      }
    },
    destroy() {
      if (audio) {
        try {
          audio.pause()
          audio.removeAttribute('src')
        } catch {
          // Ignore
        }
        audio = null
      }
      if (objectUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch {
          // Ignore
        }
        objectUrl = null
      }
    },
  }
}

export interface BackgroundPauseCheck {
  /** Whether the user currently intends for music to be playing. */
  wantPlaying: boolean
  /** True when the user explicitly pressed Stop. */
  stopRequested: boolean
  /** Current `document.visibilityState` ('visible' | 'hidden'). */
  visibilityState: string
  /** Milliseconds since the document last became hidden or lost window focus. */
  msSinceBackgrounded: number
  /** How many times we have already tried to auto-resume during this hidden session. */
  resumeAttempts: number
  /** Cap on consecutive auto-resume attempts (default 3). */
  maxAttempts?: number
}

/**
 * Decides whether a `YTState.PAUSED` event from the YouTube iframe was caused
 * by switching apps / backgrounding the browser and should be automatically
 * resumed via `player.playVideo()`.
 */
export function shouldResumeBackgroundPause({
  wantPlaying,
  stopRequested,
  visibilityState,
  msSinceBackgrounded,
  resumeAttempts,
  maxAttempts = MAX_BACKGROUND_RESUME_ATTEMPTS,
}: BackgroundPauseCheck): boolean {
  if (!wantPlaying || stopRequested) return false
  if (resumeAttempts >= maxAttempts) return false
  const isHidden = visibilityState === 'hidden'
  const justBackgrounded =
    msSinceBackgrounded >= 0 && msSinceBackgrounded <= BACKGROUND_PAUSE_GRACE_MS
  return isHidden || justBackgrounded
}

export interface MediaSessionTrackInfo {
  title: string
  artist: string
  album?: string | null
  coverUrl?: string | null
}

/**
 * Resolves the artwork array passed to `MediaMetadata`.
 *
 * Falls back to YouTube's standard thumbnail when the track has no custom
 * `coverUrl`, so the phone lock screen still displays album art.
 */
export function buildMediaArtwork(
  coverUrl?: string | null,
  coverVideoId?: string | null,
): Array<{ src: string; sizes?: string; type?: string }> {
  const url =
    (coverUrl && coverUrl.trim()) ||
    (coverVideoId ? `https://i.ytimg.com/vi/${coverVideoId}/hqdefault.jpg` : '')
  if (!url) return []
  return [
    { src: url, sizes: '96x96' },
    { src: url, sizes: '256x256' },
    { src: url, sizes: '512x512' },
  ]
}

/** Updates OS lock-screen / notification metadata via `navigator.mediaSession`. */
export function syncMediaSessionMetadata(
  track: MediaSessionTrackInfo | null,
  coverVideoId?: string | null,
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const session = navigator.mediaSession
  if (!session) return

  if (!track) {
    try {
      session.metadata = null
    } catch {
      // Ignore
    }
    return
  }

  if (typeof MediaMetadata === 'undefined') return
  try {
    session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album ?? '',
      artwork: buildMediaArtwork(track.coverUrl, coverVideoId),
    })
  } catch {
    // Some older WebViews reject artwork URLs with non-standard schemes.
  }
}

/** Updates `navigator.mediaSession.playbackState`. */
export function syncMediaSessionPlaybackState(
  playing: boolean,
  hasTrack: boolean,
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const session = navigator.mediaSession
  if (!session) return
  try {
    session.playbackState = !hasTrack
      ? 'none'
      : playing
        ? 'playing'
        : 'paused'
  } catch {
    // Ignore
  }
}

/** Updates the lock-screen scrub bar position safely. */
export function syncMediaSessionPosition(
  position: number,
  duration: number,
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const session = navigator.mediaSession
  if (!session || typeof session.setPositionState !== 'function') return
  if (!Number.isFinite(duration) || duration <= 0) return
  const safePosition = Number.isFinite(position)
    ? Math.max(0, Math.min(duration, position))
    : 0
  try {
    session.setPositionState({
      duration,
      playbackRate: 1,
      position: safePosition,
    })
  } catch {
    // Ignore unsupported or transient state errors.
  }
}

export interface MediaSessionHandlers {
  onPlay: () => void
  onPause: () => void
  onPrevious?: () => void
  onNext?: () => void
  onSeekTo?: (seconds: number) => void
  onStop?: () => void
}

/**
 * Registers OS media control handlers (lock screen, notification shade,
 * Bluetooth headset buttons, hardware media keys) and returns an cleanup fn.
 */
export function bindMediaSessionHandlers(
  handlers: MediaSessionHandlers,
): () => void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return () => undefined
  }
  const session = navigator.mediaSession
  if (!session || typeof session.setActionHandler !== 'function') {
    return () => undefined
  }

  const safeSet = (
    action: MediaSessionAction,
    fn: MediaSessionActionHandler | null,
  ) => {
    try {
      session.setActionHandler(action, fn)
    } catch {
      // Unsupported actions (e.g. 'stop' or 'seekto' on older browsers) throw.
    }
  }

  safeSet('play', () => handlers.onPlay())
  safeSet('pause', () => handlers.onPause())
  safeSet(
    'previoustrack',
    handlers.onPrevious ? () => handlers.onPrevious?.() : null,
  )
  safeSet('nexttrack', handlers.onNext ? () => handlers.onNext?.() : null)
  safeSet(
    'seekto',
    handlers.onSeekTo
      ? (details) => {
          if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime)) {
            handlers.onSeekTo?.(details.seekTime)
          }
        }
      : null,
  )
  safeSet('stop', handlers.onStop ? () => handlers.onStop?.() : null)

  return () => {
    safeSet('play', null)
    safeSet('pause', null)
    safeSet('previoustrack', null)
    safeSet('nexttrack', null)
    safeSet('seekto', null)
    safeSet('stop', null)
  }
}
