/**
 * Progressive Web App (PWA) registration and install-prompt management.
 *
 * Mobile and desktop browsers require three things before offering full
 * "Install app" (standalone home-screen app without browser address bar):
 * 1. A Web App Manifest (`/manifest.webmanifest`) with `display: "standalone"`
 *    and 192x192 + 512x512 icons.
 * 2. HTTPS (or `localhost` when running locally).
 * 3. A registered Service Worker (`/sw.js`) with a fetch handler.
 *
 * When those are present, Chromium browsers (Android Chrome, Brave, Edge,
 * Samsung Internet, desktop Chrome/Edge) also fire `beforeinstallprompt`,
 * allowing the app itself to show a one-tap "Install app" button.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
let listening = false

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Whether the app is already running as an installed standalone PWA. */
export function isRunningStandalone(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches
    ) {
      return true
    }
    const nav = window.navigator as Navigator & { standalone?: boolean }
    if (nav?.standalone === true) return true
  } catch {
    // Ignore unsupported matchMedia environments.
  }
  return false
}

/** Attaches global `beforeinstallprompt` and `appinstalled` listeners once. */
export function initInstallPromptCapture(): void {
  if (listening || typeof window === 'undefined') return
  listening = true

  window.addEventListener('beforeinstallprompt', (event: Event) => {
    // Keep the event so the user can trigger it from the You screen at any
    // time, while still allowing the browser menu's "Install app" item.
    deferredPrompt = event as BeforeInstallPromptEvent
    notify()
  })

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

/** Returns whether a deferred install prompt is currently available. */
export function canTriggerInstallPrompt(): boolean {
  return deferredPrompt !== null && !isRunningStandalone()
}

/** Triggers the browser's native PWA install prompt if available. */
export async function triggerInstallPrompt(): Promise<boolean> {
  const promptEvent = deferredPrompt
  if (!promptEvent) return false
  deferredPrompt = null
  notify()
  try {
    await promptEvent.prompt()
    const choice = await promptEvent.userChoice
    return choice?.outcome !== 'dismissed'
  } catch {
    return false
  }
}

/** Subscribes to changes in install-prompt availability. */
export function subscribeInstallPrompt(listener: () => void): () => void {
  initInstallPromptCapture()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Resets module state for unit tests. */
export function resetInstallPromptForTest(): void {
  deferredPrompt = null
  listeners.clear()
  listening = false
}

/** Registers `/sw.js` once the page has loaded. */
export function registerPwaServiceWorker(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  if (!('serviceWorker' in navigator)) return

  const register = () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Service workers are unavailable in private browsing or non-secure
      // origins; the app continues to work normally without one.
    })
  }

  if (document.readyState === 'complete') {
    register()
  } else {
    window.addEventListener('load', register, { once: true })
  }
}
