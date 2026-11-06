import { describe, expect, it } from 'vitest'
import {
  clampVolume,
  displayVolume,
  resolveAudio,
  stepVolume,
} from './audio'

describe('volume rules', () => {
  it('clamps anything outside 0-100', () => {
    expect(clampVolume(-5)).toBe(0)
    expect(clampVolume(140)).toBe(100)
    expect(clampVolume(Number.NaN)).toBe(100)
    expect(clampVolume(42.4)).toBe(42)
  })

  it('reports silence as muted even when the flag says otherwise', () => {
    // A slider at zero must not leave the button claiming sound is on.
    expect(resolveAudio(0, false)).toEqual({ volume: 0, muted: true })
    expect(resolveAudio(50, false)).toEqual({ volume: 50, muted: false })
  })

  it('sends zero to the player while muted, keeping the stored level', () => {
    expect(resolveAudio(80, true)).toEqual({ volume: 0, muted: true })
    // Unmuting restores 80, not 100.
    expect(resolveAudio(80, false).volume).toBe(80)
  })

  it('steps within bounds and clamps out-of-range moves', () => {
    expect(stepVolume(50, 5)).toBe(55)
    expect(stepVolume(98, 5)).toBe(100)
    expect(stepVolume(0, -5)).toBe(0)
  })

  it('shows silence on the slider while muted', () => {
    expect(displayVolume(70, true)).toBe(0)
    expect(displayVolume(70, false)).toBe(70)
  })
})