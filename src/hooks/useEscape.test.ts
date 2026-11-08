// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { hasOpenEscapeLayer, useEscape } from './useEscape'

/**
 * Escape closes one layer, and this is the file that keeps it that way.
 *
 * The bug these tests describe was real and reachable: the shortcuts sheet and
 * the track card could be open together, and one press of Escape closed both,
 * discarding whatever was being edited in the card underneath.
 */

let host: HTMLDivElement
let root: Root | null = null

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

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
}

function Layer({ name, log }: { name: string; log: string[] }) {
  useEscape(() => log.push(name))
  return createElement('div', null, name)
}

function Toggleable({ open, name, log }: { open: boolean; name: string; log: string[] }) {
  useEscape(() => log.push(name), open)
  return open ? createElement('div', null, name) : null
}

describe('useEscape', () => {
  it('closes only the layer that opened last', () => {
    const log: string[] = []
    mount(
      createElement(
        'div',
        null,
        createElement(Layer, { name: 'card', log }),
        createElement(Layer, { name: 'shortcuts', log }),
      ),
    )

    pressEscape()

    expect(log).toEqual(['shortcuts'])
    unmount()
  })

  it('closes the layer underneath on the next press', () => {
    const log: string[] = []
    mount(
      createElement(
        'div',
        null,
        createElement(Layer, { name: 'card', log }),
      ),
    )

    pressEscape()
    pressEscape()

    expect(log).toEqual(['card', 'card'])
    unmount()
  })

  it('leaves a layer registered as closed out of the stack', () => {
    const log: string[] = []
    const render = (open: boolean) =>
      act(() =>
        root?.render(
          createElement(
            'div',
            null,
            createElement(Layer, { name: 'card', log }),
            createElement(Toggleable, { open, name: 'shortcuts', log }),
          ),
        ),
      )

    mount(
      createElement(
        'div',
        null,
        createElement(Layer, { name: 'card', log }),
        createElement(Toggleable, { open: false, name: 'shortcuts', log }),
      ),
    )
    render(false)
    pressEscape()

    // The card is the only open layer, so it answers even though the closed
    // shortcuts layer rendered after it.
    expect(log).toEqual(['card'])
    unmount()
  })

  it('forgets a layer when it unmounts', () => {
    const log: string[] = []
    mount(createElement(Layer, { name: 'shortcuts', log }))
    unmount()

    mount(createElement(Layer, { name: 'card', log }))
    pressEscape()

    expect(log).toEqual(['card'])
    unmount()
  })

  it('reports whether anything is open, for the shell to defer to', () => {
    const log: string[] = []
    mount(createElement(Layer, { name: 'card', log }))
    expect(hasOpenEscapeLayer()).toBe(true)
    unmount()
    expect(hasOpenEscapeLayer()).toBe(false)
  })
})
