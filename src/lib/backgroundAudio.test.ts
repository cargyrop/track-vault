// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_PAUSE_GRACE_MS,
  buildMediaArtwork,
  buildSilentWavBytes,
  createSilentWavDataUri,
  MAX_BACKGROUND_RESUME_ATTEMPTS,
  shouldResumeBackgroundPause,
} from './backgroundAudio'

describe('buildSilentWavBytes', () => {
  it('writes a valid 44-byte RIFF/WAVE header followed by non-zero 1-LSB PCM frames', () => {
    const bytes = buildSilentWavBytes(1000, 0.01) // 10 samples => 20 data bytes
    expect(bytes.byteLength).toBe(44 + 20)

    const ascii = (start: number, len: number) =>
      String.fromCharCode(...bytes.slice(start, start + len))

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(ascii(36, 4)).toBe('data')

    const view = new DataView(bytes.buffer)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(1000) // sample rate
    expect(view.getUint16(34, true)).toBe(16) // 16-bit

    // Alternating +1 / -1 samples so mobile OS mixers do not gate as digital zero.
    expect(view.getInt16(44, true)).toBe(1)
    expect(view.getInt16(46, true)).toBe(-1)
  })

  it('produces a valid base64 data URI', () => {
    const uri = createSilentWavDataUri(1000, 0.01)
    expect(uri.startsWith('data:audio/wav;base64,')).toBe(true)
    expect(uri.length).toBeGreaterThan(40)
  })
})

describe('shouldResumeBackgroundPause', () => {
  it('resumes when the user wants playback and the page is hidden', () => {
    expect(
      shouldResumeBackgroundPause({
        wantPlaying: true,
        stopRequested: false,
        visibilityState: 'hidden',
        msSinceBackgrounded: 5000,
        resumeAttempts: 0,
      }),
    ).toBe(true)
  })

  it('resumes when an unsolicited pause arrives within the grace window of switching apps', () => {
    expect(
      shouldResumeBackgroundPause({
        wantPlaying: true,
        stopRequested: false,
        visibilityState: 'visible',
        msSinceBackgrounded: BACKGROUND_PAUSE_GRACE_MS - 100,
        resumeAttempts: 0,
      }),
    ).toBe(true)
  })

  it('does not resume when the user explicitly paused or stopped playback', () => {
    expect(
      shouldResumeBackgroundPause({
        wantPlaying: false,
        stopRequested: false,
        visibilityState: 'hidden',
        msSinceBackgrounded: 100,
        resumeAttempts: 0,
      }),
    ).toBe(false)

    expect(
      shouldResumeBackgroundPause({
        wantPlaying: true,
        stopRequested: true,
        visibilityState: 'hidden',
        msSinceBackgrounded: 100,
        resumeAttempts: 0,
      }),
    ).toBe(false)
  })

  it('does not resume when visible and not recently backgrounded', () => {
    expect(
      shouldResumeBackgroundPause({
        wantPlaying: true,
        stopRequested: false,
        visibilityState: 'visible',
        msSinceBackgrounded: BACKGROUND_PAUSE_GRACE_MS + 1000,
        resumeAttempts: 0,
      }),
    ).toBe(false)
  })

  it('stops retrying after MAX_BACKGROUND_RESUME_ATTEMPTS so another app can hold audio focus', () => {
    expect(
      shouldResumeBackgroundPause({
        wantPlaying: true,
        stopRequested: false,
        visibilityState: 'hidden',
        msSinceBackgrounded: 200,
        resumeAttempts: MAX_BACKGROUND_RESUME_ATTEMPTS,
      }),
    ).toBe(false)
  })
})

describe('buildMediaArtwork', () => {
  it('prefers the track coverUrl when present', () => {
    const art = buildMediaArtwork('https://example.com/cover.jpg', 'abc12345678')
    expect(art).toHaveLength(3)
    expect(art[0].src).toBe('https://example.com/cover.jpg')
  })

  it('falls back to the YouTube hqdefault thumbnail when coverUrl is empty', () => {
    const art = buildMediaArtwork(null, 'abc12345678')
    expect(art).toHaveLength(3)
    expect(art[0].src).toBe('https://i.ytimg.com/vi/abc12345678/hqdefault.jpg')
  })

  it('returns an empty list when neither coverUrl nor videoId is available', () => {
    expect(buildMediaArtwork(null, null)).toEqual([])
  })
})

describe('createPlayer background event forwarding', () => {
  it('forwards onStateChange events and post-ready onError events without tearing down the mount', async () => {
    const { createPlayer, YTState } = await import('./ytApi')

    let capturedEvents: Record<string, (event: unknown) => void> = {}
    const loadVideoByIdCalls: string[] = []
    const iframe = document.createElement('iframe')

    const fakePlayer = {
      playVideo: () => undefined,
      pauseVideo: () => undefined,
      stopVideo: () => undefined,
      cueVideoById: () => undefined,
      loadVideoById: (id: string) => {
        loadVideoByIdCalls.push(id)
      },
      setSize: () => undefined,
      seekTo: () => undefined,
      getCurrentTime: () => 0,
      getDuration: () => 180,
      getPlayerState: () => YTState.PLAYING,
      getVideoData: () => ({ title: 'Test', author: 'Artist' }),
      setPlaybackQuality: () => undefined,
      getPlaybackQuality: () => 'tiny',
      getAvailableQualityLevels: () => ['tiny'],
      mute: () => undefined,
      unMute: () => undefined,
      isMuted: () => false,
      setVolume: () => undefined,
      getVolume: () => 100,
      destroy: () => undefined,
      getIframe: () => iframe,
    }

    const previousYT = window.YT
    window.YT = {
      PlayerState: YTState,
      Player: class {
        constructor(_el: HTMLElement | string, options: Record<string, unknown>) {
          capturedEvents = (options.events ?? {}) as Record<
            string,
            (event: unknown) => void
          >
          queueMicrotask(() => {
            capturedEvents.onReady?.({ target: fakePlayer })
          })
          return fakePlayer
        }
      } as unknown as NonNullable<Window['YT']>['Player'],
    }

    const host = document.createElement('div')
    const states: number[] = []
    const errors: Array<{ message: string; code: number }> = []

    try {
      const player = await createPlayer(host, {
        videoId: 'track1_id00',
        quality: 'tiny',
        onStateChange: (state) => states.push(state),
        onError: (message, code) => errors.push({ message, code }),
      })

      expect(iframe.getAttribute('allow')).toContain('autoplay')

      // Simulate Track 1 ending in a background tab and loading Track 2 in place.
      capturedEvents.onStateChange?.({
        data: YTState.ENDED,
        target: player,
      })
      expect(states).toEqual([YTState.ENDED])

      player.loadVideoById('track2_id00', 0, 'tiny')
      expect(loadVideoByIdCalls).toEqual(['track2_id00'])

      // Post-ready error on a later track reports via onError and keeps the mount.
      capturedEvents.onError?.({ data: 150 })
      expect(errors).toEqual([
        {
          message: 'The owner has disabled embedding for this video.',
          code: 150,
        },
      ])
      expect(host.children.length).toBe(1)
    } finally {
      window.YT = previousYT
    }
  })
})

