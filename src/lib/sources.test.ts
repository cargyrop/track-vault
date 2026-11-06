import { describe, expect, it } from 'vitest'
import {
  coverSourceVideoId,
  hasPlayableSource,
  pickSourceForView,
  resolveRole,
  sourceForRole,
} from './sources'
import type { Source } from './types'

function source(id: string, role: Source['role']): Source {
  return {
    id: Number(id),
    trackId: 1,
    youtubeId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    kind: 'official',
    label: null,
    role,
    position: 0,
  }
}

const audio = source('audio000001', 'audio')
const video = source('video000001', 'video')

describe('source roles', () => {
  it('finds the source filling a role', () => {
    expect(sourceForRole([audio, video], 'audio')).toBe(audio)
    expect(sourceForRole([audio, video], 'video')).toBe(video)
    expect(sourceForRole([audio], 'video')).toBeNull()
  })

  it('streams the audio slot for audio and the video slot for video', () => {
    expect(pickSourceForView([audio, video], 'audio')).toBe(audio)
    expect(pickSourceForView([audio, video], 'video')).toBe(video)
  })

  it('falls back to the audio source when there is no clip', () => {
    // "Show video" must still work rather than leaving a dead player.
    expect(pickSourceForView([audio], 'video')).toBe(audio)
    expect(pickSourceForView([], 'video')).toBeNull()
  })

  it('plays the clip in audio mode when there is no Main', () => {
    // The two slots stand in for each other in both directions: a clip-only
    // track is a whole track, not a track that cannot start.
    expect(pickSourceForView([video], 'audio')).toBe(video)
    expect(pickSourceForView([video], 'video')).toBe(video)
  })

  it('calls a track playable with a Main or a clip, and not with live alone', () => {
    const live = source('live0000001', 'live')
    expect(hasPlayableSource([audio])).toBe(true)
    expect(hasPlayableSource([video])).toBe(true)
    expect(hasPlayableSource([audio, video, live])).toBe(true)
    expect(hasPlayableSource([live])).toBe(false)
    expect(hasPlayableSource([])).toBe(false)
  })

  it('prefers the slot over list order', () => {
    // A hand-edited file can list the clip first; roles still decide.
    expect(pickSourceForView([video, audio], 'audio')).toBe(audio)
  })

  it('gives the first free slot audio and never repeats a role', () => {
    expect(resolveRole(undefined, [])).toBe('audio')
    expect(resolveRole(undefined, ['audio'])).toBe('video')
    // An explicit role is honoured when free, demoted when already taken.
    expect(resolveRole('video', [])).toBe('video')
    expect(resolveRole('audio', ['audio'])).toBe('video')
  })
})

describe('coverSourceVideoId', () => {
  it('derives from the audio slot, not from whatever is on screen', () => {
    // In video view the clip is playing, but its still is the wrong picture for
    // an album listing, so the id comes from the audio source either way.
    expect(coverSourceVideoId([audio, video])).toBe('audio000001')
    expect(coverSourceVideoId([video, audio])).toBe('audio000001')
  })

  it('still has something to derive from when only a clip is attached', () => {
    expect(coverSourceVideoId([video])).toBe('video000001')
  })

  it('has nothing to derive from for a track with no sources', () => {
    expect(coverSourceVideoId([])).toBeNull()
  })
})

