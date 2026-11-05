/**
 * Telling album art apart from everything that merely looks like a picture.
 *
 * A cover URL written by a model is one of three things, and only the first is a
 * record sleeve:
 *
 * - `coverartarchive.org` — real album art, keyless, and what this app already
 *   generates for itself from a MusicBrainz release.
 * - a YouTube thumbnail (`i.ytimg.com/vi/<id>/…`) — the video's own still frame,
 *   which is not the sleeve and which the fallback chain derives anyway, so
 *   storing it only freezes one rendition of a picture YouTube may retire.
 * - a YouTube channel picture (`yt3.googleusercontent.com`) — the band's profile
 *   photo. Ten tracks in the library ended up with one of these as their cover,
 *   which is why covers looked "changed": the art had been replaced by an avatar.
 *
 * The first is accepted, the other two are refused *and reported*. Refusing is
 * safe because the editor stays unrestricted: a person may well want a band
 * photo on a track with no sleeve, and their choice is not the thing that went
 * wrong here. What went wrong was a model filling a blank with whatever picture
 * it could see.
 *
 * `classifyCoverUrl` is pure so it can run in the browser as well as the
 * server — the panel previews a merge before it is applied, and the preview has
 * to refuse the same covers the merge will refuse or it is telling a lie.
 * Whether a URL still *answers* is a request, so that half lives in
 * `checkCoverLiveness` and is only run by the server.
 */

/** Hosts that serve record sleeves. Anything else is refused. */
export const COVER_ART_HOSTS = ['coverartarchive.org', 'upload.wikimedia.org']

export type CoverVerdict =
  | 'album-art'
  /** A thumbnail of the video itself, which the app derives without storing it. */
  | 'derivable-thumbnail'
  /** A host that serves channel pictures and video stills, not sleeves. */
  | 'not-album-art-host'
  | 'not-a-url'

/** Classifies a cover URL without a request. See the header for why each rule exists. */
export function classifyCoverUrl(url: string): CoverVerdict {
  const trimmed = String(url ?? '').trim()
  if (!trimmed) return 'not-a-url'

  let host: string
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'not-a-url'
    }
    host = parsed.hostname.toLowerCase()
  } catch {
    return 'not-a-url'
  }

  if (host === 'i.ytimg.com') return 'derivable-thumbnail'
  if (COVER_ART_HOSTS.includes(host)) return 'album-art'
  return 'not-album-art-host'
}

/** A sentence for the merge report, phrased as the reason the cover was dropped. */
export function coverRefusalReason(verdict: CoverVerdict): string {
  switch (verdict) {
    case 'derivable-thumbnail':
      return 'it is a thumbnail of the video itself, which the app derives anyway'
    case 'not-album-art-host':
      return 'it is not a Cover Art Archive address — a video still or a channel picture is not album art'
    case 'not-a-url':
      return 'it is not a URL'
    case 'album-art':
      return 'ok'
  }
}

/** True for the content types a browser will actually draw. */
export function isImageContentType(contentType: string | null): boolean {
  return /^image\//i.test(String(contentType ?? '').trim())
}

export interface CoverCheck {
  url: string
  ok: boolean
  /** A clause that completes "the cover was refused because …". */
  reason: string
}

/**
 * Asks whether an album-art URL still answers with an image.
 *
 * Server-side only: a browser cannot make this request cross-origin without
 * CORS, and a Cover Art Archive release whose artwork was never uploaded answers
 * 404 — the URL MusicBrainz handed over is a promise it cannot always keep.
 *
 * Uses HEAD and falls back to a ranged GET, because a static host is entitled to
 * answer 405 to HEAD and CAA's redirect chain is long enough that it is not
 * worth assuming.
 */
export async function checkCoverLiveness(
  url: string,
  timeoutMs = 8000,
): Promise<CoverCheck> {
  const trimmed = String(url ?? '').trim()
  if (classifyCoverUrl(trimmed) !== 'album-art') {
    return { url: trimmed, ok: true, reason: 'ok' }
  }

  const request = async (method: 'HEAD' | 'GET'): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(trimmed, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'TrackVault/0.1 (local library app)' },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    let response = await request('HEAD')
    if (response.status === 405 || response.status === 501) {
      response = await request('GET')
    }
    if (!response.ok) {
      return { url: trimmed, ok: false, reason: `it answered ${response.status}` }
    }
    const type = response.headers.get('content-type')
    if (!isImageContentType(type)) {
      return {
        url: trimmed,
        ok: false,
        reason: `it answered ${type ?? 'no content type'} rather than an image`,
      }
    }
    return { url: trimmed, ok: true, reason: 'ok' }
  } catch (e: unknown) {
    const timedOut = e instanceof Error && e.name === 'AbortError'
    return {
      url: trimmed,
      ok: false,
      reason: timedOut ? 'it did not answer in time' : 'it could not be reached',
    }
  }
}
