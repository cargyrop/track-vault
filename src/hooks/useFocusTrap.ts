import { useEffect, type RefObject } from 'react'

/**
 * Keeps the keyboard inside an open dialog, and gives it back when the dialog
 * closes.
 *
 * Two things were missing from every dialog in the app, and neither is visible
 * if you use a mouse:
 *
 * - **The way in.** Opening a dialog left the focus wherever it was, in the page
 *   behind the backdrop, so the first Tab press walked into content the reader
 *   could not see properly. The trap moves focus to the dialog's first control
 *   on open — its own close button when there is nothing to type in.
 * - **The way out.** Closing a dialog dropped focus to `<body>`, so the reader
 *   landed back at the top of the page instead of on the row they had opened.
 *   Whatever had focus before the dialog opened gets it back.
 *
 * Tab and Shift+Tab wrap around inside the dialog, which is what `aria-modal`
 * promises a screen reader and what a sighted keyboard user expects. A press
 * that would step outside is redirected to the other end of the dialog.
 *
 * `enabled` is the dialog's own open flag rather than a mount, because several
 * dialogs stay mounted and render `null` until they open: waiting for the ref to
 * exist is what makes the effect re-run at the right moment.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',')

/**
 * Whether this environment lays anything out.
 *
 * jsdom reports no client rects for anything at all, so an empty rect list
 * cannot be read as "hidden" there or a dialog rendered in a test would look
 * empty and the trap would refuse to move at all.
 */
function hasLayout(): boolean {
  return (
    typeof document !== 'undefined' &&
    (document.body?.getClientRects().length ?? 0) > 0
  )
}

/** The dialog's tabbable controls, in document order, skipping hidden ones. */
function tabbables(root: HTMLElement): HTMLElement[] {
  const laidOut = hasLayout()
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.closest('[hidden]') &&
      element.getAttribute('aria-hidden') !== 'true' &&
      // Empty rects mean `display: none`, or the closed half of a collapsible.
      (!laidOut || element.getClientRects().length > 0),
  )
}

/**
 * The dialogs that are open, innermost last.
 *
 * Two dialogs do stack in this app — the link-health list opens a track card on
 * top of itself — and two traps both watching Tab would each pull focus towards
 * their own first control. Only the top one moves focus; the ones beneath wait.
 */
const traps: HTMLElement[] = []

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return
    const root = ref.current
    if (!root) return
    traps.push(root)

    // What to give focus back to. Captured before anything below moves it.
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null

    if (!root.contains(document.activeElement)) {
      // A dialog that already focuses a field of its own (`autoFocus` on the
      // Add track form) keeps it; everything else starts at the first control.
      const first = tabbables(root)[0]
      if (first) first.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      // Only the innermost dialog answers while two are open.
      if (traps[traps.length - 1] !== root) return
      const items = tabbables(root)
      if (items.length === 0) {
        // Nothing to move to: keep the focus where it is rather than let the
        // browser wander out of a dialog that cannot be tabbed through.
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null

      // Focus already outside (a click on the backdrop, a control removed by a
      // re-render): the next Tab starts again from the top of the dialog.
      if (!active || !root.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
        return
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // On the document rather than the dialog: a press made while focus has
    // escaped still comes back in, which is the point of a trap.
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const at = traps.indexOf(root)
      if (at !== -1) traps.splice(at, 1)
      // Only hand focus back if the element is still on the page — closing a
      // dialog because its row was deleted must not focus a row that is gone.
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true })
      }
    }
  }, [ref, enabled])
}
