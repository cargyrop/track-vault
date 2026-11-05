/**
 * YouTube thumbnail URLs, derived from a video id.
 *
 * This file used to also scrape the public watch page for a description, tags
 * and an album hint. That has been removed: reading `youtube.com/watch` is a
 * cross-origin request browsers block without a suitable CORS response, so it returned empty fields on
 * every single run while appearing to work — which is why album and year hints
 * were silently always blank. The fields it fed now come from MusicBrainz, and
 * the running time comes from the IFrame player in `youtubeDuration.ts`.
 *
 * What survives here needs no network request at all: a thumbnail URL is a
 * function of the video id, so it cannot be blocked by CORS or by a re-laid-out
 * YouTube page.
 */

/** Thumbnail renditions, best first. maxres is 1280x720 and often absent. */
export function thumbnailUrls(videoId: string): string[] {
  const base = `https://i.ytimg.com/vi/${videoId}`
  return [
    `${base}/maxresdefault.jpg`,
    `${base}/sddefault.jpg`,
    `${base}/hqdefault.jpg`,
  ]
}

export function bestThumbnail(videoId: string): string {
  return thumbnailUrls(videoId)[0]
}

/**
 * Ordered cover-art candidates for a track: the stored cover first, then the
 * thumbnails derived from its video id.
 *
 * A chain rather than a single URL, because two stored covers look perfectly
 * reasonable in the library file and still draw nothing in the player:
 *
 * - Cover Art Archive answers 404 for a release nobody has uploaded artwork
 *   for, so a cover URL that MusicBrainz handed over can be a promise it
 *   cannot keep.
 * - A cover picked off YouTube was stored as the signed
 *   `yt3.googleusercontent.com` URL that oEmbed used to return. YouTube stopped
 *   returning that form; the host now answers in a way Chrome refuses to draw
 *   (net::ERR_BLOCKED_BY_ORB), so a URL that is still a valid JPEG to a plain
 *   HTTP client is dead in the app.
 *
 * Both failures present the same way — nothing renders — so the caller walks
 * this list and moves on when an image errors. Today oEmbed returns the plain
 * `i.ytimg.com/vi/<id>/<rendition>.jpg` form, which is what `thumbnailUrls`
 * builds and is why deriving beats storing.
 */
export function coverCandidates(
  coverUrl: string | null | undefined,
  videoId: string | null | undefined,
): string[] {
  const out: string[] = []
  const add = (url: string | null | undefined) => {
    const trimmed = (url ?? '').trim()
    // A track whose stored cover is already a thumbnail of the same video must
    // not try the same address twice.
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  add(coverUrl)
  if (videoId) thumbnailUrls(videoId).forEach(add)
  return out
}

/**
 * True when a loaded image is YouTube's stand-in rather than real artwork.
 *
 * A missing rendition is answered with a 120x90 grey placeholder *successfully*,
 * not with a 404, so it renders fine and `onError` never fires — the chain would
 * stop on a blank rectangle and never reach the next candidate. Load events
 * have to be checked for this case too.
 *
 * Scoped to the derived thumbnails on purpose: a small Cover Art Archive image
 * is still a real picture, and discarding it would be worse than keeping it.
 */
export function isPlaceholderThumbnail(
  src: string,
  naturalWidth: number,
): boolean {
  if (!src.includes('i.ytimg.com')) return false
  // The smallest genuine rendition is mqdefault at 320 wide, so 120 is
  // unambiguously the placeholder.
  return naturalWidth > 0 && naturalWidth <= 120
}

/**
 * Thumbnail renditions for a video, best first.
 *
 * This is the only part of the watch-page work that survived: the thumbnail URLs
 * are derived from the video id, so they need no request at all and cannot be
 * blocked by CORS the way reading the page's HTML was.
 *
 * Everything that used to live below this — `fetchYouTubeExtra`,
 * `parseWatchPage`, `guessAlbum`, `guessYear` — has been removed. It scraped
 * `youtube.com/watch` for a description, which is a cross-origin request the
 * browsers block without a suitable CORS response, so it returned empty fields on every run while looking like
 * it worked. The album and year hints it produced were never populated by it in
 * practice, and the fields it fed are filled from MusicBrainz instead.
 */
