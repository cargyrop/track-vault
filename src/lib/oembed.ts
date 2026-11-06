import { watchUrl } from './youtube'

/**
 * YouTube's keyless oEmbed endpoint and the only thing it can be trusted to
 * answer: does this video exist, and will the owner let it be embedded.
 *
 * It is deliberately dependency-free — no player, no document, no fetch — so
 * both the browser app and the dev server's inbox check can ask the same
 * question and read the answer the same way. Whether the video plays *here* is
 * a different question, and it is not one oEmbed can answer (`linkProbe.ts`
 * asks the player for that).
 */

/** What a status code from the oEmbed endpoint established. */
export type OEmbedAnswer = 'embeddable' | 'gone' | 'no-embed' | 'unknown'

/** The endpoint for one video, built in the one place that builds it. */
export function oembedUrl(youtubeId: string): string {
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(
    watchUrl(youtubeId),
  )}&format=json`
}

/**
 * Reads the status code of YouTube's oEmbed request.
 *
 * Pure, so the mapping is tested without a network. 200 means the video exists
 * and YouTube will hand out an embed for it; 400 and 404 are what it answers for
 * an id with no playable video behind it — in practice a well-formed but unknown
 * id comes back 400, and a removal or privacy change 404; 401 and 403 are how it
 * refuses a video whose uploader disabled embedding. Everything else — a rate
 * limit, a bad-gateway day, a timeout — is "could not tell".
 */
export function readOEmbedStatus(status: number): OEmbedAnswer {
  if (status >= 200 && status < 300) return 'embeddable'
  if (status === 400 || status === 404) return 'gone'
  if (status === 401 || status === 403) return 'no-embed'
  return 'unknown'
}
