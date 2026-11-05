/**
 * TrackVault on Sites: serves the prebuilt SPA from `dist/`.
 *
 * The local JSON library API (`/api/library`, backups, inbox) only exists in
 * the dev/preview server next to `data/library.json`, so it answers 404 here
 * and the app falls back to its browser-local IndexedDB library (see
 * `createDefaultDriver` in `src/lib/drivers.ts`). The library therefore works
 * fully, but per visitor browser rather than from one shared file.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/library' || url.pathname.startsWith('/api/')) {
      return Response.json(
        { error: 'The TrackVault file API is not available on this host.' },
        { status: 404 },
      )
    }
    return env.ASSETS.fetch(request)
  },
}
