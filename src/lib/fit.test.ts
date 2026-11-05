import { describe, expect, it } from 'vitest'
import {
  fitScale,
  VIDEO_FRAME_HEIGHT,
  VIDEO_FRAME_WIDTH,
} from './fit'

describe('fitScale', () => {
  it('never exceeds 1:1 in the player card', () => {
    // A surface far larger than the frame would otherwise stretch a 720p
    // frame, which costs the same bandwidth and looks softer.
    expect(fitScale(2560, 1440)).toBe(1)
  })

  it('scales down to fit a narrower surface', () => {
    // 640x360 is exactly half of the frame's logical size.
    expect(fitScale(640, 360)).toBeCloseTo(0.5, 5)
  })

  it('uses the tighter of the two axes so nothing overflows', () => {
    // Height is the limit here, so width alone must not drive the scale.
    const scale = fitScale(5000, 720)
    expect(scale).toBeCloseTo(1, 5)

    const widthLimited = fitScale(1280, 200)
    expect(widthLimited).toBeCloseTo(200 / 720, 5)
    expect(widthLimited).toBeLessThan(1)
  })

  it('preserves aspect ratio at every scale', () => {
    // Uniform scaling, so the rendered frame keeps 16:9 and the video is never
    // stretched. The frame is 1280x720, so the rendered size is scale * that.
    for (const scale of [fitScale(800, 600), fitScale(320, 900), 1]) {
      expect(scale * VIDEO_FRAME_WIDTH / scale / VIDEO_FRAME_HEIGHT).toBeCloseTo(
        VIDEO_FRAME_WIDTH / VIDEO_FRAME_HEIGHT,
        10,
      )
      expect(scale).toBeGreaterThan(0)
    }
  })

  it('fills the screen when the upscale cap is lifted for fullscreen', () => {
    expect(fitScale(1920, 1080, VIDEO_FRAME_WIDTH, VIDEO_FRAME_HEIGHT, Infinity))
      .toBeCloseTo(1.5, 5)
    // Letterboxed by the tighter axis on an unusual window shape.
    expect(fitScale(2560, 1080, VIDEO_FRAME_WIDTH, VIDEO_FRAME_HEIGHT, Infinity))
      .toBeCloseTo(1.5, 5)
    expect(fitScale(1920, 2000, VIDEO_FRAME_WIDTH, VIDEO_FRAME_HEIGHT, Infinity))
      .toBeCloseTo(1920 / 1280, 5)
  })

  it('rejects an invalid upscale cap but allows a deliberately uncapped one', () => {
    // Fullscreen passes Infinity to lift the cap; a NaN or zero cap is a bug.
    expect(
      fitScale(640, 360, VIDEO_FRAME_WIDTH, VIDEO_FRAME_HEIGHT, Number.NaN),
    ).toBe(0)
    expect(
      fitScale(640, 360, VIDEO_FRAME_WIDTH, VIDEO_FRAME_HEIGHT, 0),
    ).toBe(0)
    expect(
      fitScale(640, 360, VIDEO_FRAME_WIDTH, VIDEO_FRAME_HEIGHT, -1),
    ).toBe(0)
  })

  it('returns 0 for a container with no size yet', () => {
    // Guards the first paint: a non-zero fallback would flash the frame at full
    // size before the first measurement lands.
    expect(fitScale(0, 0)).toBe(0)
    expect(fitScale(640, 360, 0, 360)).toBe(0)
    expect(fitScale(Number.NaN, 360)).toBe(0)
    expect(fitScale(-100, 360)).toBe(0)
  })
})
