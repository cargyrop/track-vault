import { describe, expect, it } from 'vitest'
import type { AgentContext } from './agentInbox'
import {
  buildInlinePrompt,
  buildInstruction,
  classifyPaste,
  CONTEXT_FILENAME,
  extractJson,
  REQUEST_PLACEHOLDER,
} from './agentPrompt'

const CONTEXT: AgentContext = {
  format: 'trackvault-agent-context',
  version: 1,
  instructions: 'Write a JSON object with "tracks" and "playlists".',
  counts: { tracks: 2, playlists: 1, genres: 3 },
  tracks: [
    {
      id: 1,
      title: 'Locust',
      artist: 'Machine Head',
      album: 'Catharsis',
      year: 2018,
      musicbrainzRecordingId: 'mb-locust',
      genres: ['thrash metal'],
      hasVideo: false,
      hasCover: true,
    },
    {
      id: 2,
      title: 'In League With Satan',
      artist: 'Venom',
      album: null,
      year: null,
      musicbrainzRecordingId: null,
      genres: ['black metal'],
      hasVideo: true,
      hasCover: false,
    },
  ],
  playlists: [{ id: 1, name: 'NWOBHM', description: null, trackCount: 1, folder: null }],
  folders: [],
  genres: ['thrash metal', 'black metal', 'nwobhm'],
}

describe('buildInstruction', () => {
  const prompt = buildInstruction("H.E.A.T.'s Force Majeure")

  it('points at the context file instead of quoting the library', () => {
    expect(prompt).toContain(CONTEXT_FILENAME)
    // The whole point of the split: the library is attached, not inlined.
    expect(prompt).not.toContain('"Locust"')
    expect(prompt).not.toContain('"counts": {')
    expect(prompt).not.toContain('Machine Head — Locust')
    expect(prompt).not.toContain('GENRES ALREADY IN MY LIBRARY')
  })

  it('leaves the app instructions in the file rather than restating them', () => {
    // The file carries `instructions`; the prompt points at that field, so the
    // two cannot drift and the short prompt cannot quietly grow.
    expect(prompt).not.toContain(CONTEXT.instructions)
    expect(prompt).toContain('"instructions" field')
  })

  it('stays short, because it does not scale with the library', () => {
    // Six lines is the contract here. If this ever needs raising, the library
    // or the answer rules have started leaking back into the prompt.
    expect(prompt.split('\n').length).toBeLessThan(10)
    expect(prompt.length).toBeLessThan(700)
  })

  it('puts what I want under the pointer rather than under boilerplate', () => {
    const lines = prompt.split('\n')
    const wanted = lines.findIndex((line) => line === 'WHAT I WANT:')
    expect(wanted).toBeGreaterThan(-1)
    // Nothing after it: the instruction is the pointer, then the one line that
    // is the person's own. A wall of rules below it is what made the line hard
    // to find in the first place.
    expect(prompt).not.toContain('HOW TO ANSWER')
    expect(lines[wanted + 1]).toContain("H.E.A.T.'s Force Majeure")
  })

  it('says what was asked for, word for word', () => {
    expect(prompt).toContain("H.E.A.T.'s Force Majeure")
  })

  it('falls back to a placeholder instead of pretending an empty request is a task', () => {
    expect(buildInstruction('   ')).toContain('(describe what you want here)')
  })

  it('offers a usable example placeholder', () => {
    expect(REQUEST_PLACEHOLDER.length).toBeGreaterThan(20)
    expect(buildInstruction(REQUEST_PLACEHOLDER)).toContain(REQUEST_PLACEHOLDER)
  })

  it('keeps the context file name in one place', () => {
    expect(CONTEXT_FILENAME).toBe('agent-context.json')
  })
})

describe('buildInlinePrompt', () => {
  const prompt = buildInlinePrompt(CONTEXT, "H.E.A.T.'s Force Majeure")

  it('quotes the library, so the model sees what is already there', () => {
    expect(prompt).toContain('"Locust"')
    expect(prompt).toContain('"In League With Satan"')
    expect(prompt).toContain('"counts": {')
  })

  it('lists the existing genre vocabulary to reuse', () => {
    expect(prompt).toContain('GENRES ALREADY IN MY LIBRARY')
    expect(prompt).toContain('thrash metal, black metal, nwobhm')
  })

  it('names every track it owns, in the form playlists refer to them', () => {
    expect(prompt).toContain('Machine Head — Locust')
    expect(prompt).toContain('Venom — In League With Satan')
  })

  it('repeats the app\'s own instructions rather than a paraphrase of them', () => {
    // The merge implements those rules; a second wording of them in the panel
    // would be free to drift away from what actually happens.
    expect(prompt).toContain(CONTEXT.instructions)
  })

  it('asks for the reply to be bare JSON, which is the whole import contract', () => {
    expect(prompt).toContain('no code fences')
  })

  it('says what was asked for', () => {
    expect(prompt).toContain("H.E.A.T.'s Force Majeure")
  })

  it('falls back to a placeholder instead of pretending an empty request is a task', () => {
    const blank = buildInlinePrompt(CONTEXT, '   ')
    expect(blank).toContain('(describe what you want here)')
  })

  it('leaves out sections the library has nothing to say about', () => {
    const bare = buildInlinePrompt(
      { ...CONTEXT, genres: [], playlists: [], tracks: [] },
      'x',
    )
    expect(bare).not.toContain('GENRES ALREADY IN MY LIBRARY')
    expect(bare).not.toContain('PLAYLISTS I HAVE')
    expect(bare).not.toContain('TRACKS I ALREADY OWN')
  })
})

describe('extractJson', () => {
  it('reads a fenced block', () => {
    const found = extractJson('```json\n{"tracks":[]}\n```')
    expect(found.json).toBe('{"tracks":[]}')
    expect(found.reason).toBeNull()
  })

  it('reads a fence with no language tag', () => {
    expect(extractJson('```\n{"tracks":[]}\n```').json).toBe('{"tracks":[]}')
  })

  it('keeps the block and not the chat around it', () => {
    const found = extractJson(
      'Here is the batch you asked for:\n\n```json\n{"tracks":[{"title":"X"}]}\n```\n\nLet me know if you want more.',
    )
    expect(found.json).toBe('{"tracks":[{"title":"X"}]}')
    expect(found.surrounded).toBe(true)
  })

  it('reads bare JSON with a sentence in front of it', () => {
    const found = extractJson('Sure! {"tracks":[]} hope that helps')
    expect(found.json).toBe('{"tracks":[]}')
    expect(found.surrounded).toBe(true)
  })

  it('reads a bare list', () => {
    expect(extractJson('[{"title":"X","artist":"Y"}]').json).toBe(
      '[{"title":"X","artist":"Y"}]',
    )
  })

  it('does not report surrounding text when there was none', () => {
    expect(extractJson('{"tracks":[]}').surrounded).toBe(false)
  })

  it('explains itself when there is no JSON at all', () => {
    const found = extractJson('I would be happy to help, which songs?')
    expect(found.json).toBeNull()
    expect(found.reason).toMatch(/No JSON found/)
  })

  it('treats an empty box as empty rather than broken', () => {
    expect(extractJson('   ').json).toBeNull()
  })
})

describe('classifyPaste', () => {
  it('accepts a batch', () => {
    const result = classifyPaste('{"tracks":[{"title":"X","artist":"Y","audio":"abc"}]}')
    expect(result.kind).toBe('batch')
    expect(result.note).toBeNull()
  })

  it('says so when the model wrapped its answer', () => {
    const result = classifyPaste(
      '```json\n{"tracks":[{"title":"X","artist":"Y","audio":"abc"}]}\n```',
    )
    expect(result.kind).toBe('batch')
    expect(result.note).toMatch(/code fence/)
  })

  it('says so when the model found nothing to send', () => {
    const result = classifyPaste('```json\n{"tracks":[]}\n```')
    expect(result.kind).toBe('unknown')
    expect(result.note).toMatch(/empty/i)
  })

  it('wraps a bare list of tracks rather than refusing it', () => {
    const result = classifyPaste('[{"title":"X","artist":"Y","audio":"abc"}]')
    expect(result.kind).toBe('batch-array')
    expect(JSON.parse(result.json!)).toEqual({
      tracks: [{ title: 'X', artist: 'Y', audio: 'abc' }],
    })
    expect(result.note).toMatch(/bare list/)
  })

  it('refuses the library summary, which goes out and not in', () => {
    const result = classifyPaste(JSON.stringify(CONTEXT))
    expect(result.kind).toBe('context')
    expect(result.note).toMatch(/nothing to import/i)
  })

  it('points a full library export at the ordinary import', () => {
    const result = classifyPaste(
      JSON.stringify({
        format: 'trackvault-library',
        tracks: [
          {
            id: 1,
            title: 'Locust',
            artist: 'Machine Head',
            sources: [{ youtubeId: 'jxjeqCd6Zm0', role: 'audio' }],
          },
        ],
        playlists: [],
      }),
    )
    expect(result.kind).toBe('library')
    expect(result.note).toMatch(/Import button/)
  })

  it('accepts a playlists-only batch', () => {
    expect(classifyPaste('{"playlists":[{"name":"Gym","tracks":[]}]}').kind).toBe('batch')
  })

  it('explains broken JSON instead of failing quietly', () => {
    const result = classifyPaste('{"tracks": [')
    expect(result.kind).toBe('unknown')
    expect(result.note).toMatch(/valid JSON/i)
  })

  it('explains JSON that is simply the wrong shape', () => {
    const result = classifyPaste('{"songs": []}')
    expect(result.kind).toBe('unknown')
    expect(result.note).toMatch(/"tracks" or "playlists"/)
  })

  it('says nothing about an empty box', () => {
    expect(classifyPaste('')).toEqual({
      kind: 'empty',
      json: null,
      surrounded: false,
      note: null,
    })
  })
})