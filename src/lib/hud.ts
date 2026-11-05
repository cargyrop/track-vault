/**
 * When the fullscreen control bar is visible.
 *
 * The bar sits over the video in fullscreen, so it must not sit there forever.
 * It appears whenever the pointer moves and fades once the pointer has been
 * still for a moment.
 *
 * One exception: a paused player keeps its controls. Fading them away while
 * nothing is playing would hide the only way back to playback with the mouse,
 * leaving the keyboard as the sole way out — which is exactly the "frozen"
 * feeling this is meant to avoid.
 *
 * Kept as a pure function so the rule is unit-tested rather than buried in a
 * timer.
 */

/** How long the pointer may rest before the fullscreen bar fades out. */
export const HUD_IDLE_MS = 2500

export interface HudVisibility {
  /** The pointer moved recently, so the bar was just revealed. */
  cursorActive: boolean
  /** Playback is running. */
  playing: boolean
}

export function shouldShowHud({ cursorActive, playing }: HudVisibility): boolean {
  // Paused: always visible, so the viewer can see how to resume.
  // Playing: visible only while the pointer is moving.
  return !playing || cursorActive
}