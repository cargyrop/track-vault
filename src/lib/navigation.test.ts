// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  backTarget,
  INITIAL_NAV,
  readNav,
  reduceNav,
  type NavState,
} from './navigation'

/**
 * The navigation reducer is the one place the back gesture, the tab bar and the
 * "open this playlist" press agree, so the rules are asserted here rather than
 * discovered by pressing things in a browser.
 */

const at = (patch: Partial<NavState>): NavState => ({ ...INITIAL_NAV, ...patch })

describe('reduceNav', () => {
  it('switches tabs and leaves everything else alone', () => {
    const next = reduceNav(at({ tab: 'library', listOpen: true }), {
      type: 'tab',
      tab: 'you',
    })
    expect(next).toEqual({ tab: 'you', listOpen: true, sidebarOpen: true })
  })

  it('returns the same object when the tab is already showing', () => {
    const state = at({ tab: 'playing' })
    expect(reduceNav(state, { type: 'tab', tab: 'playing' })).toBe(state)
  })

  it('opens a list inside the library, never as a fourth tab', () => {
    const next = reduceNav(at({ tab: 'you' }), { type: 'openList' })
    expect(next.tab).toBe('library')
    expect(next.listOpen).toBe(true)
  })

  it('closes a list and keeps the same object when nothing was open', () => {
    expect(reduceNav(at({ listOpen: true }), { type: 'closeList' }).listOpen).toBe(
      false,
    )
    const closed = at({ listOpen: false })
    expect(reduceNav(closed, { type: 'closeList' })).toBe(closed)
  })

  it('toggles the sidebar', () => {
    expect(reduceNav(at({}), { type: 'toggleSidebar' }).sidebarOpen).toBe(false)
    expect(
      reduceNav(at({ sidebarOpen: false }), { type: 'toggleSidebar' }).sidebarOpen,
    ).toBe(true)
  })
})

describe('backTarget', () => {
  it('leaves another tab for the library', () => {
    expect(backTarget(at({ tab: 'you', listOpen: true }))).toMatchObject({
      tab: 'library',
      listOpen: true,
    })
  })

  it('closes the open list before it leaves the library', () => {
    expect(backTarget(at({ tab: 'library', listOpen: true }))).toMatchObject({
      tab: 'library',
      listOpen: false,
    })
  })

  it('has nowhere to go at the library root, so the browser may leave', () => {
    expect(backTarget(at({ tab: 'library', listOpen: false }))).toBeNull()
  })
})

describe('the phone tab bar', () => {
  it('opens the list when Tracklist is pressed, without being a place of its own', () => {
    expect(reduceNav(INITIAL_NAV, { type: 'tab', tab: 'tracklist' })).toMatchObject({
      tab: 'library',
      listOpen: true,
    })
  })

  it('goes back to the browser when Library is pressed', () => {
    expect(
      reduceNav(at({ tab: 'library', listOpen: true }), { type: 'browse' }),
    ).toMatchObject({ tab: 'library', listOpen: false })
  })

  it('is not remembered as a tab, because it is the library', () => {
    expect(readNav(JSON.stringify({ tab: 'tracklist' }))).toMatchObject({
      tab: 'library',
      listOpen: true,
    })
  })
})

describe('readNav', () => {
  it('never restores into the You dialog', () => {
    expect(readNav(JSON.stringify({ tab: 'you' })).tab).toBe('library')
  })

  it('never restores into the player either', () => {
    // The player is a sheet opened from the dock, so a launch that restored it
    // opened on an empty player with the library behind it.
    expect(readNav(JSON.stringify({ tab: 'playing' })).tab).toBe('library')
  })

  it('starts at the library when there is nothing stored', () => {
    expect(readNav(null)).toEqual(INITIAL_NAV)
  })

  it('repairs a tab it does not know', () => {
    expect(readNav(JSON.stringify({ tab: 'queue', listOpen: true }))).toMatchObject({
      tab: 'library',
      listOpen: true,
    })
  })

  it('survives garbage rather than throwing on boot', () => {
    expect(readNav('{ not json')).toEqual(INITIAL_NAV)
  })

  it('opens the library column on every launch', () => {
    expect(readNav(JSON.stringify({ tab: 'you' })).sidebarOpen).toBe(true)
    // Even a session that ended with the column shut comes back with it open:
    // the library on the left is the shape the app starts in.
    expect(
      readNav(JSON.stringify({ tab: 'you', sidebarOpen: false })).sidebarOpen,
    ).toBe(true)
  })
})
