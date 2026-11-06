import type { Tab } from '../lib/navigation'
import { TAB_LABELS } from '../lib/navigation'
import { LibraryIcon, ListIcon, PlayingIcon, YouIcon } from './icons'

interface Props {
  tab: Tab
  /** The library is showing a list rather than the browser. */
  listOpen: boolean
  onTab: (tab: Tab) => void
  onBrowse: () => void
}

const ITEMS: Array<{ tab: Tab; icon: (props: { size?: number }) => JSX.Element }> = [
  { tab: 'library', icon: LibraryIcon },
  { tab: 'tracklist', icon: ListIcon },
  { tab: 'playing', icon: PlayingIcon },
  { tab: 'you', icon: YouIcon },
]

/**
 * The four places, at the bottom, where a thumb can reach them.
 *
 * The mini player used to sit on top of this bar. It was the third copy of the
 * same transport — dock, full screen, and a bar with no room — so a phone now
 * has the tab bar and *one* player, one press away, and the bar stops stealing
 * the bottom 80px of every list.
 *
 * `Tracklist` is not a place of its own: it is the list you were last looking
 * at, which is exactly what you want after a detour into the player.
 */
export function MobileNav({ tab, listOpen, onTab, onBrowse }: Props) {
  const active = (item: Tab): boolean => {
    if (item === 'tracklist') return tab === 'library' && listOpen
    if (item === 'library') return tab === 'library' && !listOpen
    return tab === item
  }

  return (
    <nav className="tabbar" aria-label="Sections">
      {ITEMS.map(({ tab: item, icon: Icon }) => {
        const on = active(item)
        return (
          <button
            key={item}
            type="button"
            className={on ? 'tabbar-btn on' : 'tabbar-btn'}
            aria-current={on ? 'page' : undefined}
            onClick={() => (item === 'library' ? onBrowse() : onTab(item))}
          >
            <Icon size={22} />
            <span className="tabbar-label">{TAB_LABELS[item]}</span>
          </button>
        )
      })}
    </nav>
  )
}
