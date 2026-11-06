// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { layoutModeFor, PHONE_MAX_WIDTH, TABLET_MAX_WIDTH, useLayout } from './useLayout'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  vi.unstubAllGlobals()
})

type Listener = () => void

/** A controllable matchMedia: one list per query, fired on demand. */
function stubMatchMedia(widths: { phone: boolean; tablet: boolean }) {
  const listeners = new Map<string, Set<Listener>>()
  const matchMedia = vi.fn().mockImplementation(function (query: string) {
    const isPhone = query.includes('719')
    const isTablet = query.includes('1179')
    return {
      get matches() {
        if (isPhone) return widths.phone
        if (isTablet) return widths.tablet
        return false
      },
      media: query,
      addEventListener: (_: string, fn: Listener) => {
        if (!listeners.has(query)) listeners.set(query, new Set())
        listeners.get(query)!.add(fn)
      },
      removeEventListener: (_: string, fn: Listener) => {
        listeners.get(query)?.delete(fn)
      },
      addListener: (fn: Listener) => {
        if (!listeners.has(query)) listeners.set(query, new Set())
        listeners.get(query)!.add(fn)
      },
      removeListener: (fn: Listener) => listeners.get(query)?.delete(fn),
      dispatchEvent: () => false,
    }
  }) as unknown as typeof window.matchMedia
  vi.stubGlobal('matchMedia', matchMedia)
  Object.defineProperty(window, 'matchMedia', {
    value: matchMedia,
    configurable: true,
    writable: true,
  })
  return {
    set(next: { phone: boolean; tablet: boolean }) {
      const changed = next.phone !== widths.phone || next.tablet !== widths.tablet
      widths = { ...next }
      if (!changed) return
      for (const [query, fns] of listeners) {
        const isPhone = query.includes('719')
        const isTablet = query.includes('1179')
        const matches = isPhone ? widths.phone : isTablet ? widths.tablet : false
        for (const fn of [...fns]) fn.call({ matches })
      }
    },
  }
}

function Probe({ onValue }: { onValue: (mode: string) => void }) {
  onValue(useLayout())
  return null
}

describe('layoutModeFor', () => {
  it('uses three bands, not one', () => {
    expect(layoutModeFor(390)).toBe('phone')
    expect(layoutModeFor(PHONE_MAX_WIDTH)).toBe('phone')
    expect(layoutModeFor(PHONE_MAX_WIDTH + 1)).toBe('tablet')
    expect(layoutModeFor(900)).toBe('tablet')
    expect(layoutModeFor(TABLET_MAX_WIDTH)).toBe('tablet')
    expect(layoutModeFor(TABLET_MAX_WIDTH + 1)).toBe('desktop')
    expect(layoutModeFor(1920)).toBe('desktop')
  })
})

describe('useLayout', () => {
  it('reads the width it starts at', () => {
    stubMatchMedia({ phone: true, tablet: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    const seen: string[] = []
    root = createRoot(container)
    flushSync(() => {
      root!.render(createElement(Probe, { onValue: (m: string) => seen.push(m) }))
    })
    expect(seen[seen.length - 1]).toBe('phone')
  })

  it('follows the window from tablet to desktop', () => {
    const api = stubMatchMedia({ phone: false, tablet: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    const seen: string[] = []
    root = createRoot(container)
    flushSync(() => {
      root!.render(createElement(Probe, { onValue: (m: string) => seen.push(m) }))
    })
    expect(seen[seen.length - 1]).toBe('tablet')
    act(() => api.set({ phone: false, tablet: false }))
    expect(seen[seen.length - 1]).toBe('desktop')
  })
})
