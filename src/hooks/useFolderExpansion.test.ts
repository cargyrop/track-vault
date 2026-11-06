// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useFolderExpansion } from './useFolderExpansion'
import type { PlaylistFolder } from '../lib/types'

/**
 * Which folders the tree has open, pinned away from the tree.
 *
 * The behaviour worth pinning is not the toggle — that is a Set — but *when a
 * folder opens by itself*: never on the first sight of the library (so the tree
 * opens quiet), always for one that has just been created (so the thing you just
 * made is where you are looking), and never for one the reader closed (so a
 * library refresh does not undo their click).
 */

const folder = (id: number): PlaylistFolder => ({
  id,
  name: `Folder ${id}`,
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
})

function Probe({ folders }: { folders: PlaylistFolder[] | null }) {
  const { expanded, toggleFolder, openFolder, collapseAll, expandAll } =
    useFolderExpansion(folders)
  const rows: ReactElement[] = (folders ?? []).flatMap((entry) => [
      createElement(
        'button',
        {
          key: `row-${entry.id}`,
          type: 'button',
          'data-row': String(entry.id),
          'aria-pressed': expanded.has(entry.id) ? 'true' : 'false',
          onClick: () => toggleFolder(entry.id),
        },
        entry.name,
      ),
      createElement(
        'button',
        {
          key: `open-${entry.id}`,
          type: 'button',
          'data-open-folder': String(entry.id),
          onClick: () => openFolder(entry.id),
        },
        `open ${entry.name}`,
      ),
    ])
  rows.push(
    createElement(
      'button',
      { key: 'collapse', type: 'button', 'data-collapse': 'all', onClick: collapseAll },
      'collapse',
    ),
    createElement(
      'button',
      { key: 'expand', type: 'button', 'data-expand': 'all', onClick: expandAll },
      'expand',
    ),
  )
  return createElement('div', null, ...rows)
}

/** The ids the probe is showing as open, in order. */
const openIds = (host: HTMLElement): number[] =>
  [...host.querySelectorAll<HTMLElement>('[data-row][aria-pressed="true"]')]
    .map((el) => Number(el.dataset.row))
    .sort((a, b) => a - b)

const click = (host: HTMLElement, attribute: string, id: number | null) => {
  const selector = id === null ? `[${attribute}]` : `[${attribute}="${id}"]`
  host.querySelector<HTMLButtonElement>(selector)?.click()
}

/** Lets a click's state update land before the next assertion. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

async function mount(folders: PlaylistFolder[] | null) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  // Committed synchronously, so the hook's first effect has already seen the
  // folders the test handed it by the time the first assertion runs.
  flushSync(() => {
    root.render(createElement(Probe, { folders }))
  })
  await tick()
  return {
    host,
    /** Re-renders with a new library, the way the store hands one over. */
    give: async (next: PlaylistFolder[] | null) => {
      flushSync(() => {
        root.render(createElement(Probe, { folders: next }))
      })
      await tick()
    },
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

describe('useFolderExpansion', () => {
  it('opens nothing on the first sight of the library', async () => {
    const mounted = await mount([folder(1), folder(2)])
    expect(openIds(mounted.host)).toEqual([])
    mounted.unmount()
  })

  it('opens nothing when the loaded library arrives, though the store began empty', async () => {
    // The store hands over `null` while it loads and the real folders when it
    // is done. Those were already there, so none of them is opened.
    const mounted = await mount(null)
    await mounted.give([folder(1), folder(2), folder(3)])
    expect(openIds(mounted.host)).toEqual([])
    mounted.unmount()
  })

  it('opens the first folder made in a library that had none', async () => {
    // `[]` after loading is a real state — an empty library — not an unfinished
    // one, so the next folder to appear is one somebody just made.
    const mounted = await mount(null)
    await mounted.give([])
    await mounted.give([folder(1)])
    expect(openIds(mounted.host)).toEqual([1])
    mounted.unmount()
  })

  it('opens a folder that has just been created', async () => {
    const mounted = await mount([folder(1), folder(2)])
    await mounted.give([folder(1), folder(2), folder(3)])
    expect(openIds(mounted.host)).toEqual([3])
    // And only that one: creating a folder must not open the rest.
    mounted.unmount()
  })

  it('leaves a folder the reader closed shut on the next refresh', async () => {
    const mounted = await mount([folder(1)])
    await mounted.give([folder(1), folder(2)])
    expect(openIds(mounted.host)).toEqual([2])

    click(mounted.host, 'data-row', 2)
    await tick()
    expect(openIds(mounted.host)).toEqual([])

    // A plain refresh of the same folders — an import, a rename, a new
    // playlist — must not spring the deliberately closed folder back open.
    await mounted.give([folder(1), folder(2)])
    expect(openIds(mounted.host)).toEqual([])
    mounted.unmount()
  })

  it('toggles a folder open and shut from its row', async () => {
    const mounted = await mount([folder(1), folder(2)])
    click(mounted.host, 'data-row', 1)
    await tick()
    expect(openIds(mounted.host)).toEqual([1])
    click(mounted.host, 'data-row', 1)
    await tick()
    expect(openIds(mounted.host)).toEqual([])
    mounted.unmount()
  })

  it('opens without closing when a drop lands inside a folder', async () => {
    const mounted = await mount([folder(1)])
    click(mounted.host, 'data-open-folder', 1)
    await tick()
    expect(openIds(mounted.host)).toEqual([1])
    // Opened twice is still open — a drop into an open folder must not shut it.
    click(mounted.host, 'data-open-folder', 1)
    await tick()
    expect(openIds(mounted.host)).toEqual([1])
    mounted.unmount()
  })

  it('shuts every folder at once', async () => {
    const mounted = await mount([folder(1), folder(2), folder(3)])
    click(mounted.host, 'data-row', 1)
    click(mounted.host, 'data-row', 2)
    await tick()
    expect(openIds(mounted.host)).toEqual([1, 2])

    click(mounted.host, 'data-collapse', null)
    await tick()
    expect(openIds(mounted.host)).toEqual([])
    mounted.unmount()
  })

  it('opens every folder at once', async () => {
    const mounted = await mount([folder(1), folder(2), folder(3)])
    click(mounted.host, 'data-expand', null)
    await tick()
    expect(openIds(mounted.host)).toEqual([1, 2, 3])
    mounted.unmount()
  })

  it('keeps them shut through a refresh after collapsing', async () => {
    // Collapsing is the same statement as closing each folder by hand: the
    // library may change underneath it without undoing the click.
    const mounted = await mount([folder(1), folder(2)])
    click(mounted.host, 'data-row', 1)
    await tick()
    click(mounted.host, 'data-collapse', null)
    await tick()

    await mounted.give([folder(1), folder(2)])
    expect(openIds(mounted.host)).toEqual([])
    mounted.unmount()
  })
})
