import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  key: string
  label: string
  onSelect: () => void
  /**
   * Heading rendered above this item. The first item of each run carries it, so
   * a long menu reads as a few short lists rather than one wall of verbs.
   */
  group?: string
  /** A destructive item, marked in red. */
  danger?: boolean
  /** An item that exists to explain itself rather than to be chosen. */
  disabled?: boolean
  /** A count on the right, for playlist names. */
  meta?: string
  /**
   * Keeps the menu open after choosing this item.
   *
   * For an item that is a step rather than an action — "Add to playlist…"
   * swapping the menu's contents for the list of playlists — closing on the way
   * would take the second menu away with the first.
   */
  keepOpen?: boolean
}

/** Where a menu was opened from, and what it is about. */
export interface ContextMenuState {
  x: number
  y: number
}

interface Props extends ContextMenuState {
  /** Announced to screen readers, e.g. "Actions for Awaken". */
  label: string
  items: ContextMenuItem[]
  onClose: () => void
}

const EDGE = 8

/**
 * A menu at the pointer, for the actions a row has beyond its one click.
 *
 * Right-clicking used to offer nothing, so the only way to delete a folder was
 * a ✕ that had to be hunted for on hover, and a track could only be filed into a
 * playlist through its card. One menu, opened the same way everywhere, replaces
 * both without adding a permanent control to every row.
 *
 * Dismissed by the same gestures a native menu is — a click anywhere else,
 * Escape, a scroll, the window resizing — because a menu that survives a scroll
 * ends up pointing at the wrong row.
 */
export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Measured after the first paint and pulled back inside the window, so a row
  // near the bottom edge does not open a menu that runs off it.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const next = {
      x: Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE)),
      y: Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE)),
    }
    if (next.x !== pos.x || next.y !== pos.y) setPos(next)
  }, [x, y, pos.x, pos.y, items])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Escape has to beat whatever else is listening, and the menu is the most
    // recent thing the user opened.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // The first real item takes focus, so the menu can be driven from the keyboard
  // as soon as it opens.
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLButtonElement>('button.menu-item:not(:disabled)')
      ?.focus()
  }, [])

  let lastGroup: string | undefined
  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label={label}
    >
      {items.map((item) => {
        const heading = item.group !== lastGroup ? item.group : undefined
        lastGroup = item.group
        // One block per item so a hairline can be drawn exactly where a run of
        // items ends — at a new group, or above a destructive item — instead of
        // between every pair, which would read as a striped list rather than as
        // a menu with three parts.
        const blockClass = [
          'menu-block',
          heading ? 'new-group' : '',
          item.danger ? 'danger-block' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div className={blockClass} key={item.key}>
            {heading && <p className="menu-group">{heading}</p>}
            <button
              type="button"
              role="menuitem"
              className={
                item.danger ? 'menu-item danger' : 'menu-item'
              }
              disabled={item.disabled}
              onClick={() => {
                if (item.keepOpen) {
                  item.onSelect()
                  return
                }
                onClose()
                item.onSelect()
              }}
            >
              <span className="menu-label">{item.label}</span>
              {item.meta && <span className="menu-meta">{item.meta}</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}
