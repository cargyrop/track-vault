import { describe, expect, it } from 'vitest'
import {
  classifyCoverUrl,
  coverRefusalReason,
  isImageContentType,
} from './covers'

describe('classifyCoverUrl', () => {
  it('accepts real album art', () => {
    expect(
      classifyCoverUrl('https://coverartarchive.org/release/abc123/front-500'),
    ).toBe('album-art')
    expect(
      classifyCoverUrl('https://upload.wikimedia.org/wikipedia/en/a/a1/Sleeve.jpg'),
    ).toBe('album-art')
  })

  it('refuses a thumbnail of the video itself', () => {
    // Storing it freezes one rendition of a picture the chain derives anyway.
    expect(
      classifyCoverUrl('https://i.ytimg.com/vi/jxjeqCd6Zm0/maxresdefault.jpg'),
    ).toBe('derivable-thumbnail')
  })

  it('refuses a channel picture, which is what filled ten tracks', () => {
    expect(
      classifyCoverUrl('https://yt3.googleusercontent.com/abc=w512'),
    ).toBe('not-album-art-host')
  })

  it('refuses anything that is not a URL at all', () => {
    expect(classifyCoverUrl('')).toBe('not-a-url')
    expect(classifyCoverUrl('   ')).toBe('not-a-url')
    expect(classifyCoverUrl('not a url')).toBe('not-a-url')
    expect(classifyCoverUrl('file:///c:/cover.jpg')).toBe('not-a-url')
  })

  it('is case-insensitive about the host', () => {
    expect(
      classifyCoverUrl('https://CoverArtArchive.ORG/release/abc/front-500'),
    ).toBe('album-art')
    expect(classifyCoverUrl('https://YT3.googleusercontent.com/abc')).toBe(
      'not-album-art-host',
    )
  })

  it('does not accept a lookalike host', () => {
    // The rule is the host, not the string containing it.
    expect(
      classifyCoverUrl('https://coverartarchive.org.evil.example/x.jpg'),
    ).toBe('not-album-art-host')
  })
})

describe('coverRefusalReason', () => {
  it('explains each refusal in terms of what the app does instead', () => {
    expect(coverRefusalReason('derivable-thumbnail')).toContain('derives')
    expect(coverRefusalReason('not-album-art-host')).toContain('not album art')
    expect(coverRefusalReason('not-a-url')).toContain('not a URL')
  })
})

describe('isImageContentType', () => {
  it('accepts the types a browser draws and nothing else', () => {
    expect(isImageContentType('image/jpeg')).toBe(true)
    expect(isImageContentType('image/webp; charset=binary')).toBe(true)
    expect(isImageContentType('text/html')).toBe(false)
    expect(isImageContentType(null)).toBe(false)
    expect(isImageContentType('')).toBe(false)
  })
})
