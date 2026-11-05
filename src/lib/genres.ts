/**
 * Genres, in the one spelling this app stores.
 *
 * Lower-case is the stored form, not a display choice: the facets, the filter
 * chips, the metadata lookups and the AI prompt all compare genres
 * case-insensitively, so a single spelling is what keeps the same word from
 * showing up twice in a chip row. Every path that turns typed text, a
 * MusicBrainz list or an imported file into genres goes through here.
 *
 * This module exists because that rule used to be written out three times — in
 * each edit dialog and in the importer — which is a trap: fixing it in one
 * place left the others quietly disagreeing. One home, one rule.
 */

/**
 * Case-insensitive, order-preserving dedupe.
 *
 * Case is preserved in the output on purpose: this is also the pass that reads
 * a hand-edited file or an agent's reply, where the capitalisation may be the
 * only part worth keeping.
 */
export function dedupeGenres(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const name = String(value ?? '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * Reads the comma-separated field a dialog holds — `"Prog Rock, PSYCHEDELIC"`
 * — into stored genres: split, trimmed, lower-cased, deduped.
 */
export function parseGenres(value: string): string[] {
  return dedupeGenres(
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  )
}

/**
 * Merges incoming genres into that same comma-separated field, returning the
 * shape it was given so it can go straight back into a text input.
 */
export function mergeGenres(current: string, incoming: string[]): string {
  return parseGenres(`${current}, ${incoming.join(', ')}`).join(', ')
}
