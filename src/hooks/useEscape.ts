import { useEffect } from 'react'

/**
 * Escape closes one thing: the thing that was opened last.
 *
 * The dialogs each had their own idea of what Escape meant — one had a handler,
 * four had none, so the same key closed the shortcuts sheet but not the form you
 * were filling in. One hook, one meaning: while this component is mounted,
 * Escape calls `onEscape` — but only if no dialog opened after it is still
 * waiting for the key.
 *
 * ## Why a stack, and not `stopPropagation`
 *
 * Every consumer used to add its own `window` listener and call
 * `event.stopPropagation()`, which does **not** stop the other listeners on the
 * same target: `window` is one target, and the keydown event is dispatched to
 * all of its listeners in registration order. So one press closed two layers —
 * open a track card, press `?` for the shortcuts, press Escape, and the card
 * closed underneath the sheet as well, taking the edits with it.
 *
 * Keeping the open layers in one module-level list makes "the top one" a fact
 * rather than a hope, and it stays correct however many are stacked. Escape from
 * anything that is not the top layer is ignored.
 */
const layers: Array<() => void> = []

/** True while any layer registered through `useEscape` is open. */
export function hasOpenEscapeLayer(): boolean {
  return layers.length > 0
}

export function useEscape(onEscape: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    // The callback is the layer's identity: two dialogs never share a function,
    // and a re-render that hands in a new closure replaces its own entry rather
    // than stacking a second one.
    const layer = onEscape
    layers.push(layer)

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Only the last layer to open answers. A layer underneath stays open.
      if (layers[layers.length - 1] !== layer) return
      event.stopPropagation()
      onEscape()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('keydown', onKey)
      const index = layers.indexOf(layer)
      if (index !== -1) layers.splice(index, 1)
    }
  }, [onEscape, enabled])
}
