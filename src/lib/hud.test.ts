import { describe, expect, it } from 'vitest'
import { shouldShowHud, HUD_IDLE_MS } from './hud'

describe('shouldShowHud', () => {
  it('shows while the pointer is moving during playback', () => {
    expect(shouldShowHud({ cursorActive: true, playing: true })).toBe(true)
  })

  it('fades once the pointer has been still during playback', () => {
    // This is the whole point of the bar: it must not sit over the video.
    expect(shouldShowHud({ cursorActive: false, playing: true })).toBe(false)
  })

  it('stays visible while paused, so there is always a way to resume', () => {
    // Fading the controls when nothing is playing would hide the only
    // pointer-driven way back to playback.
    expect(shouldShowHud({ cursorActive: false, playing: false })).toBe(true)
    expect(shouldShowHud({ cursorActive: true, playing: false })).toBe(true)
  })

  it('only hides in the one combination that is both playing and idle', () => {
    const combinations = [
      { cursorActive: true, playing: true },
      { cursorActive: true, playing: false },
      { cursorActive: false, playing: true },
      { cursorActive: false, playing: false },
    ]
    const hidden = combinations.filter((c) => !shouldShowHud(c))
    expect(hidden).toEqual([{ cursorActive: false, playing: true }])
  })
})

describe('HUD_IDLE_MS', () => {
  it('is long enough to be usable but short enough to fade away', () => {
    expect(HUD_IDLE_MS).toBeGreaterThan(1000)
    expect(HUD_IDLE_MS).toBeLessThan(5000)
  })
})