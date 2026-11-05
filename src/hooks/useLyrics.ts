import type { TrackWithSources } from '../lib/types'

export type LyricsState = 'idle' | 'loading' | 'none'

export interface LyricsResult {
  text: string | null
  state: LyricsState
}

/** Playback reads the saved lyrics field and never performs network lookups. */
export function useLyrics(track: TrackWithSources | null): LyricsResult {
  const text = track?.lyrics?.trim() || null
  return { text, state: text ? 'idle' : 'none' }
}
