/**
 * Fitting the YouTube frame to whatever space the player has.
 *
 * The iframe cannot simply be styled to `width: 100%`. The IFrame API writes
 * the requested width and height onto the iframe as *inline* styles, which beat
 * any stylesheet rule, so the frame stays at the size it was created with and is
 * then clipped by the card's `overflow: hidden`. That is what produced both
 * symptoms: a cropped picture in the player card, and a small frame stuck in the
 * top-left corner in fullscreen.
 *
 * The fix is to keep the iframe at a fixed logical size and scale it with a CSS
 * transform, which is not an inline style and therefore does apply. The frame is
 * centred and scaled down to fit, so the whole video is always visible.
 */

/** Logical size the YouTube player is created at in video mode. */
export const VIDEO_FRAME_WIDTH = 1280
export const VIDEO_FRAME_HEIGHT = 720

/**
 * The scale factor that fits the video frame inside a container, preserving
 * aspect ratio.
 *
 * `maxScale` caps the result. Inline in the player card the frame is never
 * upscaled past 1:1: it is a small surface, and stretching a 720p frame into it
 * would cost the same bandwidth while looking softer. In fullscreen the caller
 * passes `Infinity` to lift the cap, so the frame fills the screen, which is the
 * whole point of going fullscreen.
 *
 * Returns 0 when the container has no size yet, which makes the frame collapse
 * rather than flash at full size before the first measurement lands.
 */
export function fitScale(
  containerWidth: number,
  containerHeight: number,
  frameWidth = VIDEO_FRAME_WIDTH,
  frameHeight = VIDEO_FRAME_HEIGHT,
  maxScale = 1,
): number {
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(containerHeight) ||
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    // NaN and non-positive caps are rejected; Infinity is a deliberate "no cap".
    Number.isNaN(maxScale) ||
    maxScale <= 0
  ) {
    return 0
  }
  return Math.min(
    containerWidth / frameWidth,
    containerHeight / frameHeight,
    maxScale,
  )
}
