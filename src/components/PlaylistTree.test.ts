// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { PlaylistTree } from './PlaylistTree'
import { TRACK_DROP_TYPE } from '../lib/treeDrag'
import type { Playlist, PlaylistFolder } from '../lib/types'

/**
 * The tree's rows, which is all the tree is now.
 *
 * Which folders are open arrives as a prop and a click asks the app to change
 * it — the panel, its header and the state above it belong to the app, so that
 * looking at the Library does not shut everything the reader had opened. The
 * rule that opens a folder by itself lives in `hooks/useFolderExpansion` and is
 * tested there; what is pinned here is that the rows obey the prop, report the
 * click, and render what belongs inside an open folder.
 *
 * No `react-dom/server` import in this file, deliberately: rendering statically
 * and then mounting in one file leaves the mounted tree's events unwired, which
 * silently turns these clicks into no-ops.
 */

const folders: PlaylistFolder[] = [
  { id: 1, name: 'Greek', parentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
]

const playlists: Playlist[] = [
  {
    id: 2,
    name: 'Olive & Overdrive',
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    trackCount: 10,
    folderId: 1,
  },
]

type Props = Parameters<typeof PlaylistTree>[0]

const base: Props = {
  folders,
  playlists,
  selection: { kind: 'all' },
  totalCount: 12,
  expanded: new Set<number>(),
  onToggleFolder: () => undefined,
  onOpenFolder: () => undefined,
  onCollapseAll: () => undefined,
  onSelect: () => undefined,
  onCreateFolder: () => undefined,
  onCreatePlaylist: () => undefined,
  onDeleteFolder: () => undefined,
  onDeletePlaylist: () => undefined,
  onRenameFolder: () => undefined,
  onRenamePlaylist: () => undefined,
  onMovePlaylist: () => undefined,
  onMoveFolder: () => undefined,
  onAddTrackToPlaylist: () => undefined,
}

/** Waits for the DOM to catch up with a click, rather than guessing a delay. */
async function waitFor<T>(read: () => T | null, timeout = 1500): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = read()
    if (value !== null && value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the tree to update')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function mount(overrides: Partial<Props> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  // Committed synchronously, on purpose: a concurrent initial render can still
  // be in flight when the first click arrives, and a click landing mid-pass can
  // be committed over.
  flushSync(() => {
    root.render(createElement(PlaylistTree, { ...base, ...overrides }))
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return {
    host,
    /** The row a name sits on, whichever kind of row it is. */
    row: (name: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('.tree-label')].find((button) =>
        button.textContent?.startsWith(name),
      ),
    tool: (label: string) =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

describe('PlaylistTree', () => {
  it('draws every folder closed when nothing is open', async () => {
    const mounted = await mount()
    const greek = mounted.row('Greek')
    expect(greek?.getAttribute('aria-expanded')).toBe('false')
    expect(greek?.title).toBe('Greek — click to open')
    // What is inside a closed folder is not rendered at all.
    expect(mounted.row('Olive & Overdrive')).toBeUndefined()
    // The library view is always there, open or closed.
    expect(mounted.row('All tracks')?.textContent).toContain('12')
    mounted.unmount()
  })

  it('offers one button that shuts every folder', async () => {
    // Nothing is open, so there is nothing to shut: the button says so by being
    // disabled rather than by disappearing, which would move the two buttons
    // either side of it.
    const idle = await mount()
    const shut = idle.tool('Collapse all folders')
    expect(shut).toBeTruthy()
    expect(shut?.disabled).toBe(true)
    idle.unmount()

    // Open a folder and it is clickable, and one press is all it takes.
    let asked = 0
    const mounted = await mount({ expanded: new Set([1]), onCollapseAll: () => (asked += 1) })
    const button = mounted.tool('Collapse all folders')
    expect(button?.disabled).toBe(false)
    button?.click()
    await waitFor(() => (asked === 1 ? true : null))
    mounted.unmount()
  })

  it('draws what is inside an open folder', async () => {
    const mounted = await mount({ expanded: new Set([1]) })
    const greek = mounted.row('Greek')
    expect(greek?.getAttribute('aria-expanded')).toBe('true')
    expect(greek?.title).toBe('Greek — click to close')
    expect(mounted.row('Olive & Overdrive')?.textContent).toContain('10')
    mounted.unmount()
  })

  it('marks an open folder without highlighting it unless it is the selection', async () => {
    // Exactly one row reads as selected at a time: with All tracks selected,
    // the open folder carries `open` (the blue icon) but not `selected`.
    const mounted = await mount({
      expanded: new Set([1]),
      selection: { kind: 'all' },
    })
    const greekRow = mounted.row('Greek')?.parentElement
    expect(greekRow?.className).toContain('open')
    expect(greekRow?.className).not.toContain('selected')
    // And the selection itself still highlights: a playlist selected inside
    // an open folder is the one highlighted row.
    const picked = await mount({
      expanded: new Set([1]),
      selection: { kind: 'playlist', playlistId: 2 },
    })
    expect(picked.row('Olive & Overdrive')?.parentElement?.className).toContain(
      'selected',
    )
    expect(picked.row('Greek')?.parentElement?.className).not.toContain('selected')
    mounted.unmount()
    picked.unmount()
  })

  it('selects the folder it was clicked on, and asks for it to open', async () => {
    const opened: number[] = []
    const selected: unknown[] = []
    const mounted = await mount({
      onToggleFolder: (id) => opened.push(id),
      onSelect: (selection) => selected.push(selection),
    })

    mounted.row('Greek')?.click()
    await waitFor(() => (opened.length ? opened : null))

    expect(opened).toEqual([1])
    expect(selected).toEqual([{ kind: 'folder', folderId: 1 }])
    mounted.unmount()
  })

  it('selects a playlist without disturbing the folders', async () => {
    const opened: number[] = []
    const selected: unknown[] = []
    const mounted = await mount({
      expanded: new Set([1]),
      onToggleFolder: (id) => opened.push(id),
      onSelect: (selection) => selected.push(selection),
    })

    mounted.row('Olive & Overdrive')?.click()
    await waitFor(() => (selected.length ? selected : null))

    expect(selected).toEqual([{ kind: 'playlist', playlistId: 2 }])
    expect(opened).toEqual([])
    mounted.unmount()
  })

  it('names a folder or a playlist from its own controls', async () => {
    const folder = await mount()
    folder.tool('Create folder')?.click()
    const box = await waitFor(() => folder.host.querySelector('.tree-new input'))
    expect(box.getAttribute('placeholder')).toBe('Folder name')
    folder.unmount()

    const playlist = await mount()
    playlist.tool('Create playlist')?.click()
    const named = await waitFor(() => playlist.host.querySelector('.tree-new input'))
    expect(named.getAttribute('placeholder')).toBe('Playlist name')
    playlist.unmount()
  })

  it('accepts a dragged track on a playlist, and on nothing else', async () => {
    const added: Array<[number, number]> = []
    const mounted = await mount({
      expanded: new Set([1]),
      onAddTrackToPlaylist: (playlistId, trackId) => {
        added.push([playlistId, trackId])
      },
    })
    const rowDiv = (name: string) =>
      [...mounted.host.querySelectorAll<HTMLDivElement>('.tree-row')].find((div) =>
        div.textContent?.includes(name),
      )!
    // A track drag carries its id under the shared type.
    const transfer = () => ({
      types: [TRACK_DROP_TYPE],
      dropEffect: '',
      getData: (type: string) => (type === TRACK_DROP_TYPE ? '42' : ''),
      setData: () => undefined,
    })
    const fire = (target: EventTarget, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      ;(event as unknown as { dataTransfer: unknown }).dataTransfer = transfer()
      target.dispatchEvent(event)
    }

    // The playlist lights up and takes the drop.
    const playlist = rowDiv('Olive & Overdrive')
    fire(playlist, 'dragover')
    await waitFor(() =>
      playlist.className.includes('drop') ? playlist : null,
    )
    fire(playlist, 'drop')
    await waitFor(() => (added.length ? added : null))
    expect(added).toEqual([[2, 42]])

    // A folder is a grouping, not a list of tracks: no highlight, no drop.
    const folder = rowDiv('Greek')
    fire(folder, 'dragover')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(folder.className).not.toContain('drop')

    // All tracks is a view, not a destination either.
    const all = rowDiv('All tracks')
    fire(all, 'dragover')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(all.className).not.toContain('drop')
    expect(added).toEqual([[2, 42]])
    mounted.unmount()
  })

  it('says so when an open folder holds nothing', async () => {
    const metal: PlaylistFolder = {
      id: 3,
      name: 'Metal',
      parentId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const mounted = await mount({
      folders: [...folders, metal],
      expanded: new Set([3]),
    })
    expect(mounted.host.textContent).toContain('Empty folder')
    mounted.unmount()
  })
})
