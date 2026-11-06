import type { Tab } from '../lib/navigation'
import { TAB_LABELS } from '../lib/navigation'
import type { LayoutMode } from '../hooks/useLayout'
import { LibraryIcon, YouIcon } from './icons'

interface Props {
  mode: LayoutMode
  tab: Tab
  /** Desktop: whether the library column is showing. */
  sidebarOpen: boolean
  onToggleSidebar: () => void
  /** Tablet: the button is a way back to the library, not a column switch. */
  onBrowse: () => void
  onAddTrack: () => void
  onOpenYou: () => void
}

/**
 * The bar at the top of a wide window.
 *
 * One place — the library — because the other two are not destinations you
 * navigate to: the player is a thing you open from the bar that is already
 * playing, and `You` is a dialog about the library file. A tab bar with one tab
 * on it is a statement that there is one place, which is the truth here.
 *
 * The Library button is also the library column's switch, because a column you
 * can hide needs a control that says whether it is showing.
 */
export function TopBar({
  mode,
  tab,
  sidebarOpen,
  onToggleSidebar,
  onBrowse,
  onAddTrack,
  onOpenYou,
}: Props) {
  const desktop = mode === 'desktop'
  const libraryOn = desktop ? sidebarOpen : tab === 'library'

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <BrandMark />
        </span>
        <span className="brand-text">
          <h1>TrackVault</h1>
          <span className="brand-sub">Local library</span>
        </span>
      </div>

      <nav className="topnav" aria-label="Sections">
        <button
          type="button"
          className={libraryOn ? 'topnav-btn on' : 'topnav-btn'}
          aria-pressed={desktop ? sidebarOpen : undefined}
          aria-current={!desktop && libraryOn ? 'page' : undefined}
          onClick={desktop ? onToggleSidebar : onBrowse}
          title={desktop ? 'Show or hide the library column' : 'Back to the library'}
        >
          <LibraryIcon size={17} />
          <span>{TAB_LABELS.library}</span>
        </button>
      </nav>

      <div className="spacer" />

      <div className="topbar-actions">
        <button
          type="button"
          className="topbar-btn primary"
          onClick={onAddTrack}
          title="Add a track by hand"
        >
          <PlusIcon />
          <span className="topbar-btn-label">Add track</span>
        </button>
        <button
          type="button"
          className="topbar-btn"
          onClick={onOpenYou}
          title="Library file, backup and maintenance"
        >
          <YouIcon size={16} />
          <span className="topbar-btn-label">{TAB_LABELS.you}</span>
        </button>
      </div>
    </header>
  )
}

/** The record mark, drawn rather than imported, so it inherits `currentColor`. */
function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M12 3a9 9 0 0 1 0 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.4"
      />
      <circle cx="12" cy="12" r="2.3" fill="currentColor" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}
