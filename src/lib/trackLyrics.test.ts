import { describe, expect, it } from 'vitest'
import { Library } from './db'
import { createMemoryDriver } from './drivers'
import { createMemoryTransport, JsonLibrary, normalise } from './jsonLibrary'
import type { NewTrack } from './types'

/**
 * Lyrics pasted by hand are the one kind that is *stored*. The automatic lookup
 * never writes to the library, so this file is what pins down the promise the
 * lyrics panel makes: what you paste comes back when you open the track again.
 * Implemented twice — SQLite and the JSON file — and asserted against both.
 */

function track(overrides: Partial<NewTrack> = {}): NewTrack {
  return {
    title: 'Paranoid Android',
    artist: 'Radiohead',
    genres: ['prog rock'],
    sources: [
      {
        youtubeId: 'f7nonexistent1',
        url: 'https://www.youtube.com/watch?v=f7nonexistent1',
        kind: 'official',
      },
    ],
    ...overrides,
  }
}

const WORDS = 'Please could you stop the noise\nI’m trying to get some rest'

describe('stored track lyrics (SQL)', () => {
  it('writes lyrics onto the track and reads them back through a new store', async () => {
    const driver = await createMemoryDriver()
    const lib = new Library(driver)
    await lib.migrate()
    const id = await lib.addTrack(track())

    // A new track starts without any.
    expect((await lib.getTrack(id))?.lyrics).toBeNull()

    await lib.updateTrack(id, { lyrics: WORDS })

    // A fresh Library over the same database sees the words: they are a column,
    // not something held in memory by the writing instance.
    const reopened = new Library(driver)
    await reopened.migrate()
    expect((await reopened.getTrack(id))?.lyrics).toBe(WORDS)
  })

  it('clears lyrics again, and ignores a blank paste', async () => {
    const lib = new Library(await createMemoryDriver())
    await lib.migrate()
    const id = await lib.addTrack(track())
    await lib.updateTrack(id, { lyrics: WORDS })

    await lib.updateTrack(id, { lyrics: '   ' })
    expect((await lib.getTrack(id))?.lyrics).toBeNull()

    await lib.updateTrack(id, { lyrics: WORDS })
    await lib.updateTrack(id, { lyrics: null })
    expect((await lib.getTrack(id))?.lyrics).toBeNull()
  })

  it('keeps lyrics on a track while its other fields are edited', async () => {
    const lib = new Library(await createMemoryDriver())
    await lib.migrate()
    const id = await lib.addTrack(track())
    await lib.updateTrack(id, { lyrics: WORDS })

    await lib.updateTrack(id, { album: 'OK Computer', genres: ['art rock'] })
    expect((await lib.getTrack(id))?.lyrics).toBe(WORDS)
  })
})

describe('stored track lyrics (JSON)', () => {
  it('persists lyrics to the document and reads them after a reload', async () => {
    const transport = createMemoryTransport('')
    const lib = new JsonLibrary(transport)
    await lib.migrate()
    const id = await lib.addTrack(track())

    expect((await lib.getTrack(id))?.lyrics).toBeNull()

    await lib.updateTrack(id, { lyrics: WORDS })
    // The reload discards the in-memory document and re-reads the written one.
    await lib.reload()
    expect((await lib.getTrack(id))?.lyrics).toBe(WORDS)
  })

  it('reads a file written before the field existed as "no lyrics"', () => {
    const old = JSON.stringify({
      tracks: [{ id: 1, title: 'Old', artist: 'Hand', sources: [] }],
    })
    expect(normalise(old).tracks[0].lyrics).toBeNull()
    // And a hand-written entry with words keeps them.
    const withWords = JSON.stringify({
      tracks: [{ id: 1, title: 'Old', artist: 'Hand', lyrics: WORDS, sources: [] }],
    })
    expect(normalise(withWords).tracks[0].lyrics).toBe(WORDS)
  })
})
