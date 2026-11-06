import { useEffect, useState } from 'react'

/**
 * The three shapes the app takes.
 *
 * One breakpoint at 1100px put a 900px-wide tablet and a 360px phone in the same
 * layout, which is why a tablet in landscape looked like a broken phone: one
 * pane at a time, a giant empty player, and the list hidden behind a link. There
 * are three jobs to do instead —
 *
 * - **phone**: one screen at a time, a tab bar, no mini player;
 * - **tablet**: the phone's shell, wider — the same tab bar, the same one screen
 *   at a time. A tablet is held like a phone and tapped with the same thumb, so
 *   giving it a top bar and a drawer was giving it a desktop's navigation on a
 *   device that has neither a pointer nor the width for it;
 * - **desktop**: sidebar and list side by side, the player a docked bar.
 *
 * The numbers live here and are mirrored by one `@media` block in `styles.css`;
 * keep the two in step.
 */
export const PHONE_MAX_WIDTH = 720
export const TABLET_MAX_WIDTH = 1180

export type LayoutMode = 'phone' | 'tablet' | 'desktop'

const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH - 0.02}px)`
const TABLET_QUERY = `(max-width: ${TABLET_MAX_WIDTH - 0.02}px)`

/** Which mode a viewport width means. Pure, so it is testable without a window. */
export function layoutModeFor(width: number): LayoutMode {
  if (width <= PHONE_MAX_WIDTH) return 'phone'
  if (width <= TABLET_MAX_WIDTH) return 'tablet'
  return 'desktop'
}

/**
 * The mode the window is in right now.
 *
 * Read through `matchMedia` in the initialiser as well as in the effect, so the
 * first paint is already the right shape: reading `innerWidth` and correcting a
 * frame later showed one frame of the desktop shell on every page load.
 */
function readMode(): LayoutMode {
  if (typeof window === 'undefined') return 'desktop'
  if (typeof window.matchMedia !== 'function') {
    return layoutModeFor(window.innerWidth)
  }
  if (window.matchMedia(PHONE_QUERY).matches) return 'phone'
  if (window.matchMedia(TABLET_QUERY).matches) return 'tablet'
  return 'desktop'
}

/**
 * The layout mode, following resizes and orientation changes.
 *
 * `matchMedia` is preferred over a resize listener because a rotation is not
 * always a resize, and because it does not fire on every pixel of a window
 * drag. Where `matchMedia` is missing (SSR, old test environments) the width is
 * read once and the app still renders.
 */
export function useLayout(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(readMode)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      const onResize = () => setMode(layoutModeFor(window.innerWidth))
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    const phone = window.matchMedia(PHONE_QUERY)
    const tablet = window.matchMedia(TABLET_QUERY)
    const read = () => setMode(readMode())
    read()
    phone.addEventListener('change', read)
    tablet.addEventListener('change', read)
    return () => {
      phone.removeEventListener('change', read)
      tablet.removeEventListener('change', read)
    }
  }, [])

  return mode
}

