import { useRef } from 'react'
import { useEscape } from '../hooks/useEscape'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  open: boolean
  onClose: () => void
}

const SHORTCUTS: Array<[string, string]> = [
  ['space / k', 'Play, pause or resume'],
  ['n / p', 'Next or previous track'],
  ['s', 'Stop'],
  ['m', 'Mute'],
  ['- / =', 'Volume down or up'],
  ['← / →', 'Seek ten seconds'],
  ['f', 'Fullscreen (video)'],
  ['esc', 'Close fullscreen, or this list'],
]

/**
 * The keyboard reference, on demand.
 *
 * It used to be a permanent footer, which is how a music app ends up with a
 * twelve-word strip of developer documentation under every screen — always
 * visible, read once. Behind `?` it is there when somebody wants it and takes no
 * room from the list when they do not.
 */
export function ShortcutsDialog({ open, onClose }: Props) {
  // On the same one stack as every other dialog: it used to add a listener of
  // its own, so Escape closed the sheet *and* whatever was open beneath it.
  useEscape(onClose, open)
  const dialog = useRef<HTMLDivElement | null>(null)
  useFocusTrap(dialog, open)

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialog}
        className="modal shortcuts"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <header className="modal-header">
          <h2 id="shortcuts-title">Keyboard</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="shortcut-row">
              <dt>
                {keys.split(' / ').map((key, index) => (
                  <span key={key}>
                    {index > 0 && <span className="shortcut-slash"> / </span>}
                    <kbd>{key}</kbd>
                  </span>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
