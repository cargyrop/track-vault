/**
 * TrackVault Service Worker.
 *
 * - Hashed build assets under `/assets/*` (including the 685 KB SQLite WASM
 *   binary, JS, and CSS bundles) and app icons are served **cache-first** so
 *   re-opening the app on mobile is instantaneous.
 * - HTML navigation (`/`, `/index.html`) and the manifest use **network-first**
 *   with cache fallback so newly deployed updates take effect immediately.
 */

const CACHE_NAME = 'trackvault-shell-v2'
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
]

function isImmutableAsset(pathname) {
  return (
    pathname.startsWith('/assets/') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.wasm')
  )
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Never intercept cross-origin requests (YouTube, MusicBrainz, LRCLIB) or
  // local library API calls (/api/*).
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // Cache-first for hashed `/assets/*` bundles, WASM, and icons so mobile
  // launches do not re-download ~1 MB of assets on every open.
  if (isImmutableAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const clone = response.clone()
            void caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(request, clone))
              .catch(() => undefined)
          }
          return response
        })
      }),
    )
    return
  }

  // Network-first for HTML shell and manifest so updates land immediately.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const clone = response.clone()
          void caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => undefined)
        }
        return response
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached
          if (request.mode === 'navigate') {
            return caches.match('/index.html')
          }
          return Response.error()
        }),
      ),
  )
})
