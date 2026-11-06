/**
 * Which screen the app is on.
 *
 * The app has three top-level places — the library, the player, and the
 * account — and the tracklist is *inside* the library rather than beside it: a
 * list is the content of a selection made in the library, so making it a fourth
 * tab only ever produced a tab with no answer to "what will I see here?".
 *
 * On a phone the library is a stack: the browser, then the list you opened. The
 * shell renders one of those at a time; a wide window shows the sidebar and the
 * list side by side and ignores `listOpen`.
 *
 * The whole thing is a pure reducer so the back gesture, the tab bar and the
 * "open this playlist" path all move through one rule that can be tested
 * without a window.
 */

export type Tab = 'library' | 'tracklist' | 'playing' | 'you'

export interface NavState {
  tab: Tab
  /** A list (folder, playlist or All tracks) is open in the library stack. */
  listOpen: boolean
  /** Wide windows only: the library column is showing. */
  sidebarOpen: boolean
}

export type NavAction =
  | { type: 'tab'; tab: Tab }
  /** Back to the top of the library: the browser, not the list. */
  | { type: 'browse' }
  /** Opening a list always lands in the library, at its second level. */
  | { type: 'openList' }
  | { type: 'closeList' }
  | { type: 'toggleSidebar' }
  /** The back gesture. Returns whether there was anywhere to go. */
  | { type: 'back' }

export const INITIAL_NAV: NavState = {
  tab: 'library',
  listOpen: false,
  sidebarOpen: true,
}

/**
 * Where `back` should land, or null when the app is already at its root.
 *
 * Pushing a browser-history entry per level is what makes the Android back
 * gesture and the browser's own back button behave like the app's chevrons
 * instead of closing the tab.
 */
export function backTarget(state: NavState): NavState | null {
  if (state.tab !== 'library') return { ...state, tab: 'library' }
  if (state.listOpen) return { ...state, listOpen: false }
  return null
}

export function reduceNav(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'tab':
      // `tracklist` is not a place of its own: it is the library with a list
      // open, which is what a tab bar entry for it has to mean.
      if (action.tab === 'tracklist') {
        return { ...state, tab: 'library', listOpen: true }
      }
      return state.tab === action.tab ? state : { ...state, tab: action.tab }
    case 'browse':
      return { ...state, tab: 'library', listOpen: false }
    case 'openList':
      return { ...state, tab: 'library', listOpen: true }
    case 'closeList':
      return state.listOpen ? { ...state, listOpen: false } : state
    case 'toggleSidebar':
      return { ...state, sidebarOpen: !state.sidebarOpen }
    case 'back':
      return backTarget(state) ?? state
    default:
      return state
  }
}

/** Reads a stored nav state, repairing anything a previous version left behind. */
export function readNav(raw: string | null): NavState {
  if (!raw) return INITIAL_NAV
  try {
    const parsed = JSON.parse(raw) as Partial<NavState>
    // A launch always lands in the library, with its column open on the left and
    // the list beside it. `you` is a dialog and the player is a sheet over the
    // library, so starting inside either is starting behind something nobody
    // asked for today — and restoring them meant the app could open on an empty
    // player with the library nowhere in sight, or with its column shut because
    // that is how the last session was left.
    return {
      tab: 'library',
      listOpen: parsed.tab === 'tracklist' || parsed.listOpen === true,
      sidebarOpen: true,
    }
  } catch {
    return INITIAL_NAV
  }
}

/** The label the tab bar and the top bar both use, so they cannot drift. */
export const TAB_LABELS: Record<Tab, string> = {
  library: 'Library',
  tracklist: 'Tracklist',
  playing: 'Player',
  you: 'You',
}
