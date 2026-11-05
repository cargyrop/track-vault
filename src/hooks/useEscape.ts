import { useEffect } from 'react'

/**
 * Escape closes one thing: the thing that registered last.
 *
 * The dialogs each had their own idea of what Escape meant — one had a handler,
 * four had none, so the same key closed the shortcuts sheet but not the form you
 * were filling in. One hook, one meaning: while this component is mounted,
 * Escape calls `onEscape`. The player screen deliberately does not register
 * while a dialog is open, so one press never closes two layers.
 */
export function useEscape(onEscape: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape, enabled])
}
