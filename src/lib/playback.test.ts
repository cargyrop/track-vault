import { describe, expect, it } from 'vitest'
import { shouldAutoplayNext, shouldCarryPlayback } from './playback'
import { YTState } from './ytApi'

describe('track-change playback intent', () => {
  it('continues when the current track is playing', () => {
    expect(shouldAutoplayNext(YTState.PLAYING)).toBe(true)
  })

  it('stays silent when paused', () => {
    expect(shouldAutoplayNext(YTState.PAUSED)).toBe(false)
  })

  it('stays silent when stopped or cued', () => {
    expect(shouldAutoplayNext(YTState.CUED)).toBe(false)
    expect(shouldAutoplayNext(YTState.UNSTARTED)).toBe(false)
  })

  it('stays silent while buffering, because nothing is audible yet', () => {
    expect(shouldAutoplayNext(YTState.BUFFERING)).toBe(false)
  })

  it('always continues when a track reached its end', () => {
    expect(shouldAutoplayNext(YTState.ENDED, true)).toBe(true)
  })

  it('never autoplays unless the state says it is playing or forced', () => {
    const states = [
      YTState.UNSTARTED,
      YTState.ENDED,
      YTState.PAUSED,
      YTState.BUFFERING,
      YTState.CUED,
    ]
    for (const state of states) {
      expect(shouldAutoplayNext(state)).toBe(false)
    }
  })

  it('uses YouTube-documented state values', () => {
    expect(YTState).toEqual({
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: 1,
      PAUSED: 2,
      BUFFERING: 3,
      CUED: 5,
    })
  })
})
describe('shouldCarryPlayback', () => {
  it('carries playback when the transport button says it is playing', () => {
    // The transient states right after starting are the whole reason this
    // exists: the viewer pressed Play and sees "Pause", so a skip must continue.
    for (const state of [YTState.PLAYING, YTState.BUFFERING, YTState.CUED]) {
      expect(
        shouldCarryPlayback({ playing: true, playerState: state }),
      ).toBe(true)
    }
  })

  it('does not start the next track when playback is paused or stopped', () => {
    expect(
      shouldCarryPlayback({ playing: false, playerState: YTState.PAUSED }),
    ).toBe(false)
    expect(
      shouldCarryPlayback({ playing: false, playerState: YTState.UNSTARTED }),
    ).toBe(false)
    expect(shouldCarryPlayback({ playing: false, playerState: null })).toBe(false)
  })

  it('falls back to the live state before React has caught up', () => {
    // Play has been pressed but the poll interval has not run yet, so
    // `playing` is still false while YouTube already reports playback.
    expect(
      shouldCarryPlayback({ playing: false, playerState: YTState.PLAYING }),
    ).toBe(true)
  })

  it('always continues when the track reached its end', () => {
    expect(
      shouldCarryPlayback({
        playing: false,
        playerState: YTState.ENDED,
        forced: true,
      }),
    ).toBe(true)
  })
})
