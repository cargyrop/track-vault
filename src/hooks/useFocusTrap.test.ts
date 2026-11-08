// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useFocusTrap } from './useFocusTrap'

/**
 * The two halves of a dialog's keyboard behaviour that are invisible with a
 * mouse: focus goes in when it opens, and comes back where it came from when it
 * closes. Plus Tab staying inside, which is what `aria-modal="true"` promises.
 */

let host: HTMLDivElement
let root: Root | null = null

function Dialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useFocusTrap(ref, open)
  if (!open) return null
  return createElement(
    'div',
    { ref, role: 'dialog', 'aria-modal': 'true' },
    createElement('button', { id: 'first' }, 'first'),
    createElement('button', { id: 'middle' }, 'middle'),
    createElement('button', { id: 'last', onClick: onClose }, 'last'),
  )
}

function mount(children: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(children))
}

function unmount() {
  act(() => root?.unmount())
  root = null
  host.remove()
}

function pressTab(shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  })
  act(() => {
    document.dispatchEvent(event)
  })
  return event
}

describe('useFocusTrap', () => {
  it('moves focus into the dialog when it opens', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    mount(createElement(Dialog, { open: true, onClose: () => {} }))

    expect(document.activeElement?.id).toBe('first')
    unmount()
    outside.remove()
  })

  it('wraps forward from the last control to the first', () => {
    mount(createElement(Dialog, { open: true, onClose: () => {} }))
    const last = document.getElementById('last')
    act(() => last?.focus())

    const event = pressTab()

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('first')
    unmount()
  })

  it('wraps backward from the first control to the last', () => {
    mount(createElement(Dialog, { open: true, onClose: () => {} }))
    // Opening put focus on the first control, which is the case under test.
    expect(document.activeElement?.id).toBe('first')

    const event = pressTab(true)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('last')
    unmount()
  })

  it('pulls focus back in when it is somehow outside', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    mount(createElement(Dialog, { open: true, onClose: () => {} }))

    act(() => outside.focus())
    pressTab()

    expect(document.activeElement?.id).toBe('first')
    unmount()
    outside.remove()
  })

  it('gives focus back to whatever had it when the dialog closes', () => {
    const opener = document.createElement('button')
    opener.textContent = 'open'
    document.body.appendChild(opener)
    opener.focus()

    const render = (open: boolean) =>
      act(() => root?.render(createElement(Dialog, { open, onClose: () => {} })))

    mount(createElement(Dialog, { open: true, onClose: () => {} }))
    expect(document.activeElement?.id).toBe('first')

    render(false)

    expect(document.activeElement).toBe(opener)
    unmount()
    opener.remove()
  })

  it('leaves the page alone while it is closed', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    mount(createElement(Dialog, { open: false, onClose: () => {} }))
    pressTab()

    expect(document.activeElement).toBe(opener)
    unmount()
    opener.remove()
  })
})
