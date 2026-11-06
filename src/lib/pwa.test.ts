// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canTriggerInstallPrompt,
  initInstallPromptCapture,
  isRunningStandalone,
  resetInstallPromptForTest,
  subscribeInstallPrompt,
  triggerInstallPrompt,
} from './pwa'
import {
  readInitialSelection,
  readStoredSelection,
} from '../hooks/useLibrary'

describe('PWA install prompt helpers', () => {
  beforeEach(() => {
    resetInstallPromptForTest()
  })

  it('captures beforeinstallprompt and triggers prompt() on demand', async () => {
    const changes: boolean[] = []
    const unsubscribe = subscribeInstallPrompt(() => {
      changes.push(canTriggerInstallPrompt())
    })

    expect(canTriggerInstallPrompt()).toBe(false)

    const promptSpy = vi.fn().mockResolvedValue(undefined)
    const fakeEvent = Object.assign(new Event('beforeinstallprompt'), {
      prompt: promptSpy,
      userChoice: Promise.resolve({
        outcome: 'accepted' as const,
        platform: 'web',
      }),
    })

    window.dispatchEvent(fakeEvent)
    expect(canTriggerInstallPrompt()).toBe(true)
    expect(changes).toEqual([true])

    const installed = await triggerInstallPrompt()
    expect(installed).toBe(true)
    expect(promptSpy).toHaveBeenCalledTimes(1)
    expect(canTriggerInstallPrompt()).toBe(false)

    unsubscribe()
  })

  it('clears the prompt when appinstalled fires', () => {
    initInstallPromptCapture()
    const fakeEvent = Object.assign(new Event('beforeinstallprompt'), {
      prompt: () => Promise.resolve(),
    })
    window.dispatchEvent(fakeEvent)
    expect(canTriggerInstallPrompt()).toBe(true)

    window.dispatchEvent(new Event('appinstalled'))
    expect(canTriggerInstallPrompt()).toBe(false)
  })

  it('detects standalone mode safely', () => {
    expect(isRunningStandalone()).toBe(false)
  })

  it('restores saved playlist and folder selections and falls back to all on invalid data', () => {
    expect(readStoredSelection(null)).toEqual({ kind: 'all' })
    expect(readStoredSelection('not-json')).toEqual({ kind: 'all' })
    expect(
      readStoredSelection(JSON.stringify({ kind: 'playlist', playlistId: 12 })),
    ).toEqual({ kind: 'playlist', playlistId: 12 })
    expect(
      readStoredSelection(JSON.stringify({ kind: 'folder', folderId: 5 })),
    ).toEqual({ kind: 'folder', folderId: 5 })
  })

  it('falls back to the active playing playlist when selection was left on all', () => {
    window.localStorage.removeItem('trackvault.selection')
    window.localStorage.setItem(
      'trackvault.activeTracklist',
      JSON.stringify({
        selection: { kind: 'playlist', playlistId: 9 },
        trackIds: [1, 2, 3],
        title: 'Night Drive',
      }),
    )
    expect(readInitialSelection()).toEqual({ kind: 'playlist', playlistId: 9 })
    window.localStorage.removeItem('trackvault.activeTracklist')
  })
})
