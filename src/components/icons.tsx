/**
 * Marks that more than one component draws.
 *
 * Icons are the classic thing to copy: a glyph is three lines, so it gets
 * pasted into whichever component needs it and then exists in triplicate, each
 * copy drifting a little. The ones that are genuinely the same drawing live
 * here and take their size as a prop — the same triangle is 13px next to a
 * track row and 12px in the info panel, and that difference is the caller's
 * business, not a reason for a second copy.
 *
 * Icons that *look* similar but answer to different states stay in their own
 * components: the player's play/pause pair, for instance, is one control whose
 * path changes with playback, not the same mark used twice.
 */

/** A triangle, drawn rather than typed, so it matches the transport's marks. */
export function PlayIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 5.5v13l11-6.5Z" fill="currentColor" />
    </svg>
  )
}

/**
 * The shell's marks: the tab bar, the sidebar toggle, and the small chevrons
 * a stack of screens needs.
 *
 * Drawn here rather than typed so the four tabs and the transport sit on the
 * same 24px grid at the same stroke weight — a mixture of Unicode glyphs and
 * SVGs is what makes a bottom bar look assembled from spare parts.
 */

/** A stack of records: the library. */
export function LibraryIcon({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="4" y="3.5" width="4" height="17" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="10" y="3.5" width="4" height="17" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16.6 5.2l4 15.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** A play mark in a frame: the player screen. Filled, so it reads at 22px. */
export function PlayingIcon({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="3" y="3.5" width="18" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.2 8.6 15.6 12l-5.4 3.4Z" fill="currentColor" />
    </svg>
  )
}

/** A head and shoulders: the account, its data and the maintenance in it. */
export function YouIcon({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="8.6" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.8 20.2a7.4 7.4 0 0 1 14.4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** A left-pointing chevron for a screen that has somewhere to go back to. */
export function ChevronLeftIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A right-pointing chevron: this row opens something. */
export function ChevronRightIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Funnel: the filters popover. */
export function FilterIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M4 5.5h16l-6.2 7.4v5.6l-3.6 1.9v-7.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

/** Three lines of decreasing length: sort order. */
export function SortIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M4 6.5h11M4 12h8M4 17.5h5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M17.5 6v12m0 0 3-3.2m-3 3.2-3-3.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A list with an arrow: what plays after this. */
export function QueueIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M4 7h10M4 12h10M4 17h6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M17.5 10.5v7m0 0 2.8-2.8m-2.8 2.8-2.8-2.8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Lines with no arrow: the list itself, where the queue icon means "what next". */
export function ListIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M4.5 6h15M4.5 12h15M4.5 18h9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

/** A smaller chevron, for "expand the dock". */
export function ChevronUpIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M5.5 15 12 8.5 18.5 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A downward chevron, for "put the player back in the dock". */
export function ChevronDownIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M5.5 9 12 15.5 18.5 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A folder, for a library row that holds other lists. */
export function FolderIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7.5A1.5 1.5 0 0 1 20 8.5v7A1.5 1.5 0 0 1 18.5 17h-13A1.5 1.5 0 0 1 4 15.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Lines of tracks with a play mark: a playlist, everywhere it is drawn. */
export function PlaylistIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M4 6.5h10M4 12h10M4 17.5h6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M17 13.5v6l4.4-3Z" fill="currentColor" />
    </svg>
  )
}
