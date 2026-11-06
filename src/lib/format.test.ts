import { describe, expect, it } from 'vitest'
import { formatClock, formatDuration } from './format'

/**
 * The rule the three copied versions of this function each got slightly
 * differently: an unknown length is a dash, never `0:00`.
 */

describe('formatDuration', () => {
  it('writes a length as minutes and zero-padded seconds', () => {
    expect(formatDuration(273)).toBe('4:33')
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(0)).toBe('0:00')
  })

  it('shows a dash when the length is not known', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('rounds to the nearest second rather than truncating', () => {
    expect(formatDuration(272.6)).toBe('4:33')
    expect(formatDuration(59.4)).toBe('0:59')
  })

  it('keeps counting past an hour instead of wrapping the minutes', () => {
    // 3600s is 60:00, not 0:00 — a wrap would silently shorten a track.
    expect(formatDuration(3600)).toBe('60:00')
  })

  it('never renders a negative length as a negative time', () => {
    expect(formatDuration(-5)).toBe('0:00')
  })
})

/**
 * The player's clock, which is the same shape as a duration but not the same
 * rule: it is never unknown, and it counts whole seconds rather than rounding.
 */

describe('formatClock', () => {
  it('writes minutes and zero-padded seconds', () => {
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(9)).toBe('0:09')
    expect(formatClock(3600)).toBe('60:00')
  })

  it('counts the second that has already played, rather than rounding ahead', () => {
    // 65.9 is the sixty-fifth second, not the sixty-sixth.
    expect(formatClock(65.9)).toBe('1:05')
    expect(formatClock(272.6)).toBe('4:32')
  })

  it('shows 0:00 where a clock has nothing yet, never a dash', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(-1)).toBe('0:00')
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})
