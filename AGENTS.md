# Working on TrackVault

A local, ad-light browser music library: tracks are YouTube links plus metadata,
stored in `data/library.json` when the local API is available and in browser-local
SQLite (IndexedDB) as a fallback, with lyrics, artist info and an AI agent workflow.

This file is for whoever edits it next — human or agent. It is short on purpose:
commands, the map, the rules that are easy to break, and the traps that have
already cost somebody an hour.

## Commands

```bash
npm run check        # typecheck + full test suite — run this before you finish
npm run typecheck    # tsc --noEmit only
npm test             # vitest run (whole suite, ~1–2 min)
npx vitest run src/lib/genres.test.ts   # one file while iterating
npm run dev          # vite dev server on :1420, with the library API
npm run build        # typecheck + production bundle into dist/
```

`npm run dev` serves the **app** and the JSON library API, which is what a
browser (or the preview panel) needs. `npm run preview` serves the built `dist/`
instead — same API, so a rebuilt bundle is what a running preview sees.

There is no linter or formatter configured. Match the surrounding code instead;
the comments explain intent, and new code should too.

## The map

| Path | What lives there |
| --- | --- |
| `src/lib/types.ts` | Every shared type. **Start here** — `Track`, `NewTrack`, `LibraryFilter`, and the on-disk shapes `StoredTrack` / `StoredPlaylist` / `LibraryDocument`. |
| `src/lib/db.ts` | `Library`, the browser-local SQLite store. Owns migrations (`SCHEMA_VERSION`). |
| `src/lib/jsonLibrary.ts` | `JsonLibrary`, the JSON-file store (local browser launcher). Same interface, different storage. |
| `src/lib/libraryImport.ts` | `normalise()` — repairs anything read from disk — and `applyImport()`, the import merge, shared by both stores. |
| `src/lib/agentInbox.ts` | The inbox merge: what the AI workflow is allowed to add, and the report of what it did. |
| `src/lib/genres.ts`, `src/lib/format.ts`, `src/lib/shuffle.ts`, `src/lib/dj.ts`, `src/lib/treeDrag.ts`, `src/lib/sources.ts`, `src/lib/linkHealth.ts` | Small pure modules that own one rule each. **Add rules here, not in components.** |
| `src/hooks/` | State that has to outlive the component holding it. `useLibrary.ts` is the one door between React and a store — components never touch a store directly; `useFolderExpansion.ts` owns which tree folders are open, because the tree unmounts on a view switch. |
| `src/lib/navigation.ts` | Which of the three places the app is on, and the back rule, as a pure reducer. |
| `src/lib/trackSort.ts` | The order of the rows: keys, direction, and "a missing value is always last". |
| `src/hooks/useLayout.ts` | The three layout modes and the widths they start at. Mirrored by one `@media` block in `styles.css`. |
| `src/App.tsx` | The shell: navigation, playback state, and the wiring of the library, list and player. |
| `src/components/` | One file per panel or dialog. `icons.tsx` holds marks shared by more than one; `PlayButton.tsx` is the list's Play, in two sizes, so its wording is written once for every list. |
| `src/styles.css` | All styling, grouped by banner comments (`==== panel ====`, `==== card ====`). Find the banner, edit under it. |
| `vite-plugin-library.ts` | The dev/preview server's library API: read, write with a revision check, backups, inbox, generated agent context. |
| `data/` | `library.json` is the library; `agent-context.json` and the waiting `inbox.json` are generated (an inbox exists only until it is merged, then it is archived to `inbox-applied/` and the merge report lands in `last-merge.json`). Backups in `data/backups/`. |

### Where the weight is

Four files carry most of the mass, and in three of them one enormous function
holds it. Read the anchor, not the file.

| File | The anchor | What that means for you |
| --- | --- | --- |
| `src/components/Player.tsx` (~1545 lines) | `Player()` is ~1200 of them | The JSX is long, the rules inside it are not: seek maths, volume steps, quality choice and playback hand-off all live in `src/lib/` (`fit.ts`, `audio.ts`, `sources.ts`, `playback.ts`, `youtube.ts`, `format.ts`). Change the rule there and let the JSX just call it. Icons below `Player()` are local except the shared `icons.tsx`. |
| `src/lib/db.ts` (~1194 lines) | `class Library`, ~1000 of them | Migrations come first in the class (`SCHEMA_VERSION`), store methods after. Pure helpers (`clampIndex`, `normaliseDuration`, `rowDuration`) sit outside it and are where a parsing rule belongs. |
| `src/App.tsx` (~1190 lines) | `App()` is ~935 of them | State and wiring: view, selection, playback, rail heights. New behaviour almost never belongs here — put it in a rule in `src/lib` or in the component that shows it, and pass it in. |
| `src/lib/agentInbox.ts` (~1007 lines) | `mergeInbox()` at the middle | Already split by job: `indexLibrary` → `readSources` → `enrich`/`reject`, with `buildContext` and `AGENT_INSTRUCTIONS` at the bottom. Find the section, do not read the file. |

Only `src/styles.css` has banner comments; the TypeScript files are navigated by
their doc comments, so `grep -n "^export function\|^function\|^export class" file`
gets you the outline of anything here in one line.

## The one architectural rule

**Two store implementations must agree.** `Library` (SQLite) and `JsonLibrary`
(JSON) are separate code with the same method names, so a rule that lives in
both will drift — it already did once: the JSON store merged tracks only by
MusicBrainz id, the SQL store also matched artist + title, so importing a backup
into the browser build duplicated songs in one store but not the other.

Therefore:

- A rule that both stores must follow belongs in a shared pure module
  (`libraryImport.ts`, `genres.ts`, `format.ts`, `sources.ts`, `shuffle.ts`) and
  is called from both. Do not re-implement it in one store.
- When a rule can only live in a store, **prove it with a shared-contract
  test**: one list of assertions run against both stores. `libraryTransfer.test.ts`
  and `playlistFolders.test.ts` are the pattern to copy — a
  `stores: Array<[string, () => Promise<Store>]>` list that the whole file loops
  over, so a new assertion lands on SQLite and the JSON file in the same edit.
  `trackLyrics.test.ts` and `duration.test.ts` cover the same promise in
  separate per-store blocks instead; either way, a rule that only one store is
  tested against is how the drift above happened.
- Migrations are SQL-store only (`db.ts`, `SCHEMA_VERSION`); the JSON store's
  equivalent is `normalise()`, which repairs whatever the file happens to hold.

## Invariants that must not regress

Each of these was a bug once, and each has a test — keep it passing rather than
working around it:

- **Folders and playlists have separate id sequences**, so folder 3 and playlist
  3 can coexist. Never compare the bare numbers across kinds (`treeDrag.ts`).
- **A list is named exactly once**: in its own header. The tree only highlights
  the selection; nothing else repeats the title. (The old info panel and
  "Now playing …" bar are gone; `ListHeader` replaced both.)
- **One player component, two shapes.** `Player` renders as the dock or as the
  full screen from the same state (`variant`), because unmounting it would stop
  the stream and two players would fight over one iframe. Nothing else may own
  transport state.
- **Pressing a row plays it; the card is behind `⋯`.** The row used to play only
  from a hover-revealed mark in the number cell, which does not exist on touch
  (`TrackList.test.ts`).
- **Sorting never writes.** `sortTracks` returns a copy; the playlist keeps the
  order it was dragged into, and Play queues the rows in the order on screen.
- **Opening a list never changes what plays.** Only Play, Play-all or a row press
  takes the audible snapshot; the dock is what tells the truth about it.
- **Every screen is a history entry on a single pane**, so the Android back
  gesture pops the library stack instead of leaving the app (`navigation.ts`).
- **One place, on purpose.** `Library` is the only destination; the player is
  opened from the dock and `You` is a dialog, because neither is somewhere you
  "go". A tab that has no answer to *what will I see here* is not a tab.
  `tracklist` therefore reduces to `library` + `listOpen`, and `you` is never
  restored from storage (`navigation.test.ts`).
- **The library column's width belongs to the user.** Dragged from its own edge,
  clamped in `App.tsx`, remembered in `localStorage`; never a fixed number.
- **A phone gets no hover-only control and no HTML5 drag.** Touch browsers never
  fire drag events, so filing and reordering have menu paths.
- **A tablet is a wide phone, not a small desktop.** `singlePane` in `App.tsx`
  (`layout !== 'desktop'`) is the one switch: no top bar, no dock, the tab bar and
  one screen at a time. Every `.layout-phone` rule is mirrored for
  `.layout-tablet` in `styles.css` — add both selectors or neither.
- **Density is a shared token, not a per-list decision.** The tracklist and the
  player's `Up next` list are the same one-line row: number, title, artist beside
  it, duration at the right. Change one, change the other.
- **The tree is one rail: All tracks, then folders.** There
  are no Library/Playlists tabs. `unfiledOnly` and `hasLiveSource` are store
  filters (`LibraryFilter`), asserted against both stores in
  `libraryFilters.test.ts`. Track rows are always draggable; only user
  playlist rows accept the drop (`TRACK_DROP_TYPE` in `treeDrag.ts`).
- **Import never overwrites and never duplicates**: it matches on MusicBrainz id
  or artist + title, fills blanks only, is idempotent, and reports what it could
  not place instead of dropping it (`libraryImport.test` coverage in
  `libraryTransfer.test.ts`). Replace (`replaceJson` on both stores,
  `libraryReplace.test.ts`) is the deliberate opposite: it validates the file
  first, empties the store, then imports, so the library mirrors the file
  exactly. The topbar keeps both; the replace dialog confirms first.
- **An import loses nothing the file holds, including tracks it cannot play.**
  A row with no Main link and no clip is the library's own state (the link-health
  run leaves them), so `applyImport` stores it via `addTrack(…,
  { allowUnplayable: true })` and names it in `result.unplayable` rather than
  refusing it. Refusing them is how a real 1765-track export came back with 16
  tracks missing and the 29 playlist entries naming them unresolved.
- **An import writes once, not once per track.** `applyImport` runs inside
  `sink.transact`, so the JSON store defers its file write to the end: without
  it every add re-serialised the whole growing document (quadratic — minutes for
  a real library). It also makes replace atomic, so a failed import leaves the
  library it was replacing intact. Do not call `persist` yourself in a loop.
- **A poll-triggered `reload()` must never run during a transaction**, and must
  discard its read if an edit landed while it was in flight (`jsonBulkImport.test.ts`).
  Both races lost tracks and produced "Playlist not found." mid-import.
- **Genres are stored lower-cased and deduped** (`genres.ts`), in both the
  dialogs and every parse path.
- **An unknown length is `null`, never 0**, and displays as a dash (`format.ts`,
  `youtubeDuration.ts`). A running clock is the other way round: `formatClock`
  shows `0:00`, never a dash, because a player always has a position.
- **Playing a list respects the shuffle**: with shuffle on it opens on a drawn
  track, not the first row (`shuffle.ts` → `openingTrack`).
- **Filters are a popover, not a panel**, and whatever is on is named in a line
  of removable chips under the toolbar (`filterTokens`). A filter you cannot see
  is a filter you cannot explain when the list comes back short.
- **The tree opens with every folder closed**, and which folders are open lives
  above the tree (`useFolderExpansion`), not inside it: the tree unmounts when
  the reader switches to the Library, and coming back must find it as they left
  it. The one folder that opens itself is one that has just been created.
- **Lyrics are filled automatically but never overwritten**: a background sweep
  (`lyricsBackfill.ts` + `useLyricsBackfill`, same shape as the info backfill)
  looks tracks with no words up, and writes only to blank tracks — a paste that
  lands mid-run is re-checked before each write, so typed words always beat
  fetched ones. The panel's lookup button still saves only on an explicit press.
- **Automatic lookups fire for tracks that arrive, never for a launch.** `App`
  records the ids present at the first load (`arrivedAt`) and hands both sweeps
  only the ids that show up afterwards — added, imported, merged from an inbox,
  or picked up by the poll. Sweeping the library on startup re-asked the same
  questions on every launch, one request a second. Their report line lives in
  `.lookup-status`, under the top bar and above `.layout`, not in the list.
  `arrivedAt` starts as `null`, because an empty library is not the same thing as
  "nothing was here yet".
- **A link YouTube says will not play here is cut, not flagged.** The link-health
  run (`linkProbe.ts` asks, `linkHealth.ts` decides, `LinkHealthDialog` writes)
  removes the dead slot from the track — `removeSource`, which is deliberately
  the one door that may empty the Main, unlike `setSource(…, null)`. A track
  left with neither an `audio` nor a `video` slot is filed under a top-level
  **Issues** playlist, created on first need and matched by name (case and
  spacing aside). It never measures lengths; lengths belong to the player and
  the add dialog.
- **A track has three source slots: `audio` (Main), `video` (the clip) and `live`**
  (`MAX_SOURCES = 3`, `SourceRole` in `types.ts`). Main and the clip are
  interchangeable playbacks and either one alone is a complete track
  (`hasPlayableSource` in `sources.ts` is the one rule); a live take is not, so
  `live`-only is still refused. Views fall back to each other
  (`pickSourceForView`): audio → Main then clip, video → clip then Main, live →
  live take, then clip, then Main. Only emptying the *last* of the Main/clip pair
  is refused, one video id may never fill two slots, and a fourth link is
  refused — the editor, the add dialog, both stores, the import and the inbox
  merge all ask `hasPlayableSource` rather than spelling the rule out again.

## Traps worth knowing

- **Tests run in a jsdom-ish environment per file.** Two rules learned the hard
  way: a file that calls `renderToStaticMarkup` *and* mounts a real root will
  have the mounted tree's events silently swallowed — keep static-render tests
  and interaction tests in separate files (see `PlaylistInfo.test.ts` vs
  `PlaylistInfo.interaction.test.ts`); and mount inside `flushSync` when a test
  clicks immediately, or a concurrent initial render can commit over the update.
- **No `react-dom/server` import in an interaction test file.** Same cause.
- **The preview browser can freeze its own compositing** when a YouTube embed
  plays. That is the environment, not the app: verify playback logic through
  the DOM (which row is `playing`, transport state) rather than screenshots
  while a track streams.
- **Do not edit `data/library.json` by hand while the app is running.** Each
  client holds the document in memory and writes the whole thing back; use the
  UI or the `PUT /api/library` route with the current revision.
- Component tests use `// @vitest-environment jsdom` at the top of the file;
  everything else runs in node.

## Adding a feature

1. Find the rule: if it is not about pixels, it belongs in `src/lib`.
2. Write the rule as a pure function with a test next to it.
3. Wire it through `src/hooks/useLibrary.ts` (store) and the component that
   needs it.
4. If it touches a store, add the assertion to the shared-contract test so both
   stores are checked.
5. `npm run check`. Then, for anything visual, look at it in the running app.
