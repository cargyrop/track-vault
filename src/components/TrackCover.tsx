import { useCallback, useEffect, useState } from 'react'
import { coverCandidates, isPlaceholderThumbnail } from '../lib/ytMeta'

/**
 * Cover art with the fallback chain, shared by the player and the library rail.
 *
 * A stored cover is a promise the app cannot always keep, and it breaks in three
 * ways that look identical on screen — nothing, or the wrong picture:
 *
 * - Cover Art Archive answers 404 for a release nobody uploaded artwork to, so
 *   a URL MusicBrainz handed over can be dead the moment it is stored.
 * - A cover picked off YouTube was kept in the signed
 *   `yt3.googleusercontent.com` form oEmbed used to return, which the browser
 *   can refuse to draw.
 * - A missing YouTube rendition is answered *successfully* with a 120x90 grey
 *   stub rather than a 404, so `onError` never fires and nothing looks wrong to
 *   the code — only to the eye.
 *
 * The third case is why this checks the load as well as the error, and all three
 * are why one URL is not enough. `coverCandidates` builds the chain itself: the
 * stored cover first, then the thumbnails derived from the video id.
 *
 * This is one component rather than two because the rail and the card have to
 * agree. The player walked the chain while the list drew the stored URL raw, so
 * a dead cover was a working picture in the card and a grey tile in the row
 * beside it — the same track, two answers. A shared chain is the only way the
 * two cannot drift apart again.
 */
interface Props {
  /** The stored cover, which may be dead. */
  coverUrl: string | null | undefined
  /** The video id the derived thumbnails come from. See `coverSourceVideoId`. */
  videoId: string | null | undefined
  /** Class on the image. The player styles it by element, the rail by class. */
  className?: string
  /** Class on the placeholder, shown only when every candidate has failed. */
  placeholderClassName?: string
  /**
   * The placeholder element. The rail needs a `span` because it sits among the
   * inline parts of a row; the card wants a `div`.
   */
  placeholderTag?: 'div' | 'span'
  alt?: string
  loading?: 'lazy' | 'eager'
  /**
   * Called when a candidate genuinely rendered — never when YouTube's grey stub
   * did. The player uses it to write a working address back into the library;
   * the rail deliberately leaves it unset, because scrolling a list is not a
   * reason to rewrite someone's data.
   */
  onRendered?: (url: string) => void
}

export function TrackCover({
  coverUrl,
  videoId,
  className,
  placeholderClassName,
  placeholderTag = 'div',
  alt = '',
  loading,
  onRendered,
}: Props) {
  const [index, setIndex] = useState(0)
  const candidates = coverCandidates(coverUrl, videoId)
  const src = candidates[index]

  // Walks the chain forward on a failed image. Stepping past the end makes `src`
  // undefined, which swaps in the placeholder and unmounts the img, so this
  // terminates instead of looping.
  const advance = useCallback(() => setIndex((i) => i + 1), [])

  // A track change starts the chain over. Without this, a failure on one track
  // leaves the index high enough to skip the next track's stored cover
  // entirely — which is the bug the player had before this was shared.
  useEffect(() => {
    setIndex(0)
  }, [coverUrl, videoId])

  if (!src) {
    const Placeholder = placeholderTag
    return (
      <Placeholder className={placeholderClassName} aria-hidden="true">
        ♪
      </Placeholder>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={advance}
      onLoad={(event) => {
        // A missing rendition loads successfully as a 120x90 stub, so the chain
        // has to be moved on from the load side as well as the error side.
        if (isPlaceholderThumbnail(src, event.currentTarget.naturalWidth)) {
          advance()
          return
        }
        onRendered?.(src)
      }}
    />
  )
}
