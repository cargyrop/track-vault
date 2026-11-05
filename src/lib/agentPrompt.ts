/**
 * The two halves of the clipboard round trip, as pure functions.
 *
 * Somebody using an AI they cannot give file access to has to move two blobs of
 * text by hand: the library summary going out, and a batch of JSON coming back.
 * Both are easy to get slightly wrong, and both mistakes are silent:
 *
 * - Going out, a prompt written from scratch lets the model invent a genre
 *   spelling (`Gothic Metal` next to the `gothic metal` already in the library)
 *   or re-send a track that is already there. Both are things only the library
 *   itself knows, so the prompt is built *from* the library rather than typed
 *   by hand.
 * - Coming back, a model wraps its answer in a code fence and adds a sentence
 *   of explanation. That is not an error, it is what models do, and the panel
 *   should read it rather than making the person strip the fence first.
 *
 * Since the summary became a file the assistant is *given* rather than a wall of
 * text it is handed inside the prompt, going out is two artifacts rather than
 * one. `buildInstruction` is the three-line thing a person copies and can
 * actually read, and the context file travels beside it; `buildInlinePrompt`
 * is the older one-blob form, kept for an assistant that takes no attachments.
 *
 * Everything here is pure and browser-safe, so it can be tested without a
 * clipboard, a server or a component.
 */

import type { AgentContext } from './agentInbox'

// ------------------------------------------------------------------- prompts

/** The file the instruction points at, and the panel downloads. */
export const CONTEXT_FILENAME = 'agent-context.json'

export const REQUEST_PLACEHOLDER =
  "Add the rest of H.E.A.T.'s Force Majeure with the official videos, and file the metal playlists under Metal by subgenre"

/**
 * The answer rules for the inlined fallback.
 *
 * The short instruction does not repeat these, because they travel in the
 * context file's `instructions` field (`AGENT_INSTRUCTIONS` in agentInbox) —
 * the same text the file-based drop box has always followed. Only the clause
 * naming where the genre vocabulary lives changes here, since with the library
 * pasted in there is no file to point at.
 */
function answerRules(genresWhere: string): string[] {
  return [
    '- Reply with ONE JSON object and nothing else: no explanation, no markdown, no code fences. Only the text from the first { to the last } is imported.',
    '- Every track needs a YouTube link you have actually checked, as the "audio" value itself in plain text — never wrapped in an object. An unverified link is worse than a missing track, because I cannot tell which it was.',
    '- For every new track also try to find the official video clip in "video" and a live performance in "live" — checked YouTube links like "audio". Leave a slot out when you cannot verify one rather than guessing.',
    '- Give every playlist you create a short "description" (what it is for, 1-2 sentences) — a playlist without one is incomplete.',
    '- Every link is checked against YouTube when the batch is applied: a video that does not exist is left out and the track is added without a playable link, shown in red until its link is fixed by hand — read the merge report back and send a replacement link for anything it lists.',
    '- Leave out anything you are not sure about rather than guessing; the app reports back what it could not match, and a wrong track is harder to spot than a missing one.',
    `- Genres must come from the vocabulary ${genresWhere}, spelled exactly as they appear there. Do not add a new capitalisation of a genre I already use.`,
    '- Do not send a track I already own unless the task is to fill in what is missing on it.',
  ]
}

/**
 * The short instruction: what a person actually copies.
 *
 * Two things it is not. It is not the library — the file is, and it is
 * attached, so the assistant is told the file exists and what is in it rather
 * than handed every track. And it is not the answer rules either: those are the
 * file's `instructions` field, which is the same contract the merge implements
 * and the same text the file-based drop box already follows.
 *
 * What is left is the one line that is actually the person's — "what I want" —
 * and it is now the second thing on screen instead of line sixty of a wall of
 * JSON. That is the whole reason the library moved out: the part that has to be
 * read is the part that has to be edited, and everything else is attached.
 */
export function buildInstruction(request: string): string {
  const asked = request.trim()
  return [
    `Read the attached ${CONTEXT_FILENAME} and follow its "instructions" field`,
    'exactly — it says what to send, in what shape, and where the genre spellings',
    'come from. Do not ask me for the library: that file is the library.',
    '',
    'WHAT I WANT:',
    asked || '(describe what you want here)',
  ].join('\n')
}

/**
 * A prompt built from the library as it stands, quoted in full.
 *
 * This is the fallback for an assistant that takes no attachment — a chat box
 * and nothing else. It is strictly worse than the short instruction plus the
 * file: it costs tokens in proportion to the library rather than to the task,
 * and it puts the one line worth reading at the bottom of everything the model
 * already knows. The panel no longer offers it: the short prompt plus the
 * attached file is the only path.
 *
 * The app's own `instructions` are quoted verbatim rather than restated here:
 * they are the contract the merge implements, so the prompt and the code cannot
 * drift apart. Everything added around them is the part no generic prompt can
 * know — this library's genre vocabulary, the tracks it already owns, and the
 * shape of the answer.
 */
export function buildInlinePrompt(
  context: AgentContext,
  request: string,
): string {
  const asked = request.trim()
  const lines: string[] = [
    'You are adding music to my personal TrackVault library.',
    '',
    'THE LIBRARY AS IT STANDS:',
    JSON.stringify(context, null, 2),
    '',
    'WHAT I WANT:',
    asked || '(describe what you want here)',
    '',
    'HOW TO ANSWER:',
    context.instructions,
    ...answerRules('below'),
  ]

  if (context.genres.length) {
    lines.push(
      '',
      'GENRES ALREADY IN MY LIBRARY (reuse these spellings):',
      context.genres.join(', '),
    )
  }

  const owned = context.tracks.map((track) => `${track.artist} — ${track.title}`)
  if (owned.length) {
    lines.push(
      '',
      `TRACKS I ALREADY OWN (${owned.length}) — do not send these as new:`,
      owned.join('\n'),
    )
  }

  if (context.playlists.length) {
    lines.push(
      '',
      'PLAYLISTS I HAVE:',
      context.playlists.map((p) => `${p.name} (${p.trackCount})`).join('\n'),
    )
  }

  lines.push('', 'ANSWER:')
  return lines.join('\n')
}

// ------------------------------------------------------------ pasted answers

export interface ExtractedJson {
  /** The JSON text on its own, or null when nothing usable was found. */
  json: string | null
  /** Whether anything was cut off around it — a fence, or a sentence. */
  surrounded: boolean
  /** Why it failed, when it did. */
  reason: string | null
}

/**
 * Pulls the JSON out of whatever the model actually replied with.
 *
 * A fenced block wins over a brace scan: a model that writes
 * ```json … ``` has decided what the answer is, and searching the whole
 * message for braces can pick up a nested example from its explanation
 * instead. Only when there is no fence does it fall back to the outermost
 * brace or bracket in the text — the bracket first when the answer is a list,
 * since scanning for braces inside `[{"title": …}]` would return one object
 * from the list rather than the list.
 *
 * A candidate is returned even when it does not parse. Extraction and parsing
 * are separate jobs, and a truncated paste should be reported with the parser's
 * own complaint — which names the position — rather than as "no JSON found".
 */
export function extractJson(raw: string): ExtractedJson {
  const text = String(raw ?? '').trim()
  if (!text) return { json: null, surrounded: false, reason: 'Nothing pasted yet.' }

  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text)
  if (fenced) {
    const inner = fenced[1].trim()
    if (inner) return { json: inner, surrounded: text !== inner, reason: null }
  }

  const pairs: Array<[string, string]> =
    text[0] === '['
      ? [
          ['[', ']'],
          ['{', '}'],
        ]
      : [
          ['{', '}'],
          ['[', ']'],
        ]

  for (const [open, close] of pairs) {
    const first = text.indexOf(open)
    const last = text.lastIndexOf(close)
    if (first >= 0 && last > first) {
      const slice = text.slice(first, last + 1).trim()
      return { json: slice, surrounded: text !== slice, reason: null }
    }
  }

  // Truncated JSON has no closing bracket to find. Handing the remainder back
  // anyway lets the parser name the position it choked on, which is a far more
  // useful thing to show than "no JSON found".
  if (text[0] === '{' || text[0] === '[') {
    return { json: text, surrounded: false, reason: null }
  }

  return {
    json: null,
    surrounded: false,
    reason:
      'No JSON found in what you pasted. Copy the whole answer, including the { }.',
  }
}

export type PasteKind =
  | 'empty'
  | 'batch'
  | 'batch-array'
  | 'context'
  | 'library'
  | 'unknown'

export interface ClassifiedPaste {
  kind: PasteKind
  /** The JSON to import, normalised to something `parseInbox` accepts. */
  json: string | null
  /** Whether text had to be stripped from around it. */
  surrounded: boolean
  /** A sentence for the panel, or null when there is nothing to say. */
  note: string | null
}

/**
 * Works out what was pasted, so the panel can explain itself instead of
 * guessing and failing.
 *
 * The two documents that look alike and mean opposite things are the library
 * context (goes *out* to a model) and a full library export (goes *in*, but
 * through the ordinary import button, not as a batch). Mistaking either for a
 * batch would either re-add everything or reject everything, and both would be
 * silent — so each is named for what it is and the import is refused with a
 * reason.
 */
export function classifyPaste(raw: string): ClassifiedPaste {
  const found = extractJson(raw)
  if (!found.json) {
    const blank = !String(raw ?? '').trim()
    return {
      kind: blank ? 'empty' : 'unknown',
      json: null,
      surrounded: false,
      note: blank
        ? null
        : (found.reason ??
          'No JSON found in what you pasted. Copy the whole answer, including the { }.'),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(found.json)
  } catch (e: unknown) {
    return {
      kind: 'unknown',
      json: found.json,
      surrounded: found.surrounded,
      note:
        'That is not valid JSON: ' +
        (e instanceof Error ? e.message : 'it could not be parsed') +
        '. Copy the answer again, including the { and }.',
    }
  }

  const note = found.surrounded
    ? 'The answer had text or a code fence around the JSON. Only the JSON will be imported.'
    : null

  // A bare array of tracks is a common shape: the model skipped the envelope.
  // Wrapping it is unambiguous, so it is repaired rather than refused.
  if (Array.isArray(parsed)) {
    return {
      kind: 'batch-array',
      json: JSON.stringify({ tracks: parsed }, null, 2),
      surrounded: found.surrounded,
      note: `${note ? `${note} ` : ''}A bare list of tracks was wrapped as a batch.`.trim(),
    }
  }

  const object = (parsed ?? {}) as {
    format?: string
    instructions?: unknown
    sources?: unknown
    tracks?: unknown
    playlists?: unknown
  }

  if (
    object.format === 'trackvault-agent-context' ||
    typeof object.instructions === 'string'
  ) {
    return {
      kind: 'context',
      json: found.json,
      surrounded: found.surrounded,
      note: 'That is a library summary — it goes out to the model, not in. Nothing to import.',
    }
  }

  const tracks = Array.isArray(object.tracks) ? object.tracks : []
  if (tracks.length && Array.isArray((tracks[0] as { sources?: unknown })?.sources)) {
    return {
      kind: 'library',
      json: found.json,
      surrounded: found.surrounded,
      note:
        'That is a whole library export, not a batch. Import it with the Import button in the top bar instead.',
    }
  }

  if (tracks.length || Array.isArray(object.playlists)) {
    return { kind: 'batch', json: found.json, surrounded: found.surrounded, note }
  }

  // An empty batch is a real answer — the model found nothing to add — and it
  // is worth saying so, because otherwise the panel looks like it is about to
  // import something and then does nothing.
  if (Array.isArray(object.tracks) && !tracks.length) {
    return {
      kind: 'unknown',
      json: found.json,
      surrounded: found.surrounded,
      note: 'The batch is empty — there is nothing to import.',
    }
  }

  return {
    kind: 'unknown',
    json: found.json,
    surrounded: found.surrounded,
    note:
      'No tracks or playlists in there. The answer needs a "tracks" or "playlists" list.',
  }
}