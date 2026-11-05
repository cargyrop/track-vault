/**
 * Volume and mute rules.
 *
 * These are pure on purpose: the player component is about playback, and the
 * easy-to-get-wrong part here is what "muted" means when a level is also stored.
 * Keeping the level and the mute flag separate means unmuting restores the
 * volume you had, instead of snapping back to 100%.
 */

export const MIN_VOLUME = 0
export const MAX_VOLUME = 100

/** The player API expects an integer 0-100; anything else is coerced. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return MAX_VOLUME
  return Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(value)))
}

export interface AudioState {
  /** Level handed to the player, always 0-100. */
  volume: number
  muted: boolean
}

/**
 * Resolves what to actually hand the player.
 *
 * A level of zero *is* silence, so it is reported as muted too — otherwise the
 * button would show "unmuted" while nothing could be heard.
 */
export function resolveAudio(volume: number, muted: boolean): AudioState {
  const level = clampVolume(volume)
  return {
    volume: muted ? MIN_VOLUME : level,
    muted: muted || level === MIN_VOLUME,
  }
}

/** Steps the stored level. Muting never changes it, so unmuting restores it. */
export function stepVolume(volume: number, delta: number): number {
  return clampVolume(clampVolume(volume) + delta)
}

/** The level the slider should display: silence while muted, else the level. */
export function displayVolume(volume: number, muted: boolean): number {
  return muted ? MIN_VOLUME : clampVolume(volume)
}