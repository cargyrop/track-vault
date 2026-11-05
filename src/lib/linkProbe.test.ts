import { describe, expect, it } from 'vitest'
import { verdictFromPlayerError } from './linkProbe'
import { readOEmbedStatus } from './oembed'

describe('readOEmbedStatus', () => {
  it('reads 200 as embeddable, and 400/404 as gone', () => {
    expect(readOEmbedStatus(200)).toBe('embeddable')
    // A well-formed id with nothing behind it answers 400, not 404.
    expect(readOEmbedStatus(400)).toBe('gone')
    expect(readOEmbedStatus(404)).toBe('gone')
  })

  it('reads a refusal as embedding being off', () => {
    expect(readOEmbedStatus(401)).toBe('no-embed')
    expect(readOEmbedStatus(403)).toBe('no-embed')
  })

  it('fails open on anything else', () => {
    expect(readOEmbedStatus(429)).toBe('unknown')
    expect(readOEmbedStatus(500)).toBe('unknown')
    expect(readOEmbedStatus(0)).toBe('unknown')
  })
})

describe('verdictFromPlayerError', () => {
  it('calls 101 and 150 embedding being off', () => {
    for (const code of [101, 150]) {
      const verdict = verdictFromPlayerError(code)
      expect(verdict.status).toBe('broken')
      if (verdict.status === 'broken') {
        expect(verdict.problem).toBe('no-embed')
        expect(verdict.detail).toContain('embedded players')
      }
    }
  })

  it('calls 100 a region block, and the rest unplayable', () => {
    // YouTube reports a country block as 100, the same code it uses for
    // "not found" — and oEmbed has already established the video exists.
    const blocked = verdictFromPlayerError(100)
    expect(blocked.status === 'broken' && blocked.problem).toBe('geo-blocked')

    for (const code of [2, 5, 77]) {
      const verdict = verdictFromPlayerError(code)
      expect(verdict.status === 'broken' && verdict.problem).toBe('unplayable')
    }
  })
})
