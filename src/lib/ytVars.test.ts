import { describe, expect, it } from 'vitest'
import { buildPlayerVars } from './ytApi'

/**
 * These assertions pin YouTube's embed parameters. They matter because most of
 * the "remove YouTube's chrome" parameters that old guides recommend are
 * deprecated and silently do nothing, so a regression here would look fine and
 * hide the real UI again.
 */
describe('buildPlayerVars', () => {
  const vars = buildPlayerVars({ videoId: 'abc', quality: 'tiny' })

  it('removes the player controls so only our HUD shows', () => {
    expect(vars.controls).toBe(0)
  })

  it('disables YouTube keyboard shortcuts so they do not fight our HUD', () => {
    expect(vars.disablekb).toBe(1)
  })

  it('removes related-video suggestions', () => {
    expect(vars.rel).toBe(0)
  })

  it('suppresses interactive annotations burned into the video', () => {
    expect(vars.iv_load_policy).toBe(3)
  })

  it('never forces captions on', () => {
    expect(vars.cc_load_policy).toBe(0)
  })

  it('passes the requested quality through as vq', () => {
    expect(vars.vq).toBe('tiny')
    expect(buildPlayerVars({ videoId: 'a', quality: 'high' }).vq).toBe('high')
  })

  it('omits vq for auto so YouTube picks the rendition itself', () => {
    // Video mode must not force a tier: vq is only a request, and leaving it out
    // is what lets YouTube adapt the way it does on youtube.com.
    const auto = buildPlayerVars({ videoId: 'a', quality: 'auto', width: 640 })
    expect(auto).not.toHaveProperty('vq')
    // Frame size still drives YouTube's own heuristic.
    expect(auto.width).toBe('640')
  })

  it('sizes the frame, which is what drives the quality heuristic', () => {
    const audio = buildPlayerVars({ videoId: 'a', quality: 'tiny' })
    expect(audio.width).toBe('1')
    expect(audio.height).toBe('1')

    const video = buildPlayerVars({
      videoId: 'a',
      quality: 'tiny',
      width: 640,
      height: 360,
    })
    expect(video.width).toBe('640')
    expect(video.height).toBe('360')
  })

  it('does not autoplay, since playback is driven by the user', () => {
    expect(vars.autoplay).toBe(0)
  })

  it('excludes deprecated parameters that no longer do anything', () => {
    // Google deprecated these; re-adding them would imply the branding or
    // title overlay can be hidden, which it cannot.
    expect(vars).not.toHaveProperty('modestbranding')
    expect(vars).not.toHaveProperty('showinfo')
    expect(vars).not.toHaveProperty('autohide')
    expect(vars).not.toHaveProperty('theme')
  })
})
