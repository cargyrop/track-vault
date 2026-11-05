# TrackVault

A local music library that stores **which YouTube video** each track lives on, then
plays it from YouTube. Nothing is downloaded: the player streams through YouTube's
IFrame Player API, and the library holds links, title, artist, album, year, cover,
genres, notes and lyrics.

React + TypeScript, designed to run in a browser tab. The library is a plain JSON file, served and written by a small local server.

## Running

| Platform | Launcher |
| --- | --- |
| Windows | [START_TRACKVAULT.bat](START_TRACKVAULT.bat) |
| macOS / Linux | [start-trackvault.command](start-trackvault.command) |

The launcher installs dependencies on the first run, builds the app, opens
`http://localhost:1420`, and keeps a server window open until you press Ctrl+C.

```bash
npm install
npm run dev                        # app + library API on http://localhost:1420
npm run build && npm run preview   # the built bundle, same API
npm run check                      # typecheck + tests
npm test                           # 621 tests
npm run typecheck

The server window is the storage. If it is closed while a tab is still open, the
page keeps working until it needs to write; adding or editing then fails with a
message saying the server is not responding.

Working on the code? [AGENTS.md](AGENTS.md) has the commands, the file map and the
invariants.

## First run

The library starts empty — adding tracks is the point, and a demo library you did
not choose is just clutter to delete. Two optional starting points ship with the
app:

- `data/library.example.json` — a twelve-track sample. Copy it to
  `data/library.json` (with the app closed) to see a populated library, then
  delete or replace it.
- `You → Import…` merges a whole library file into an empty one.

## Where the library lives

**`data/library.json`** — one JSON document, created on first run.

- Writes are atomic (temp file + rename).
- Every browser tab reads the same file. A write that was based on an older
  revision is refused rather than applied, so two windows cannot silently
  overwrite each other.
- Edits made to the file outside the app are picked up within a few seconds. The
  app polls a content-hash revision every 4 seconds rather than re-downloading
  the document.
- Export, Import and Replace live on the **You** screen, together with the link
  health check.

`data/` also holds the files the AI workflow uses:

| File | Contents |
| --- | --- |
| `inbox.json` | A batch waiting to be merged. Written by you or an assistant. |
| `agent-context.json` | Compact summary of the library, regenerated on every change. |
| `last-merge.json` | Report of the last merge, including entries it could not place. |
| `backups/` | The library as it was before each merge; the newest five. |
| `inbox-applied/` | A copy of every inbox that was merged. |

If the library API is not available — for example the page was opened without the
server — the app falls back to a browser-local SQLite database (sql.js, persisted
to IndexedDB). The fallback is a separate store: it does not read or write
`data/library.json`, and the inbox workflow does not apply to it.

## The window

The app has one place — the **Library** — and two things you open from it: the
**player** (from the bar that is already playing) and **You** (a dialog about the
library file). The tracklist is *inside* the library rather than beside it: a list
is the content of a selection, so it is a level of the library, not a fourth tab.

- **Top bar** (desktop only): `Library`, which is also the column's switch, then
  `Add track` and `You` at the right. Export, Import,
  Replace and Health check are file-level actions and live in the `You` dialog,
  not next to playing a song.
- **Library**:
  - *Desktop*: a column beside the list, holding `All tracks` and the tree of
    folders and playlists. **Its width is dragged from its own edge** between 240
    and 560px (double-click resets it, arrow keys nudge it) and remembered, so a
    playlist whose name is a sentence can be read without opening it. Three
    buttons sit over the tree — new folder, new playlist, and one that shuts every
    folder — so a library that has outgrown its column is one press from calm.
  - *Phone and tablet*: a browser you walk through — `All tracks`, then folders,
    then playlists — with a back chevron, a search box, and `⋯` on every row for
    rename, delete and "create here". The chevron is labelled with the folder it
    goes back to (`< Metal`), and `Library` only at the top level. No drag: touch browsers never fire HTML5
    drag events, so filing uses the row menus instead.
- **The list**: a header (cover mosaic, name, count, running time, description,
  `Play`, `Shuffle`, `Repeat`, `DJ`, `⋯`), a toolbar (search, `Filters` popover,
  `Sort`) and the rows.
- **Player**: a **dock** across the bottom on a desktop, in three zones — cover
  and title on the left, previous/play/next with the seek bar under them in the
  middle, volume and the open-player chevron on the right. The transport and the
  seek bar are centred on the bar itself, not on whatever space the title leaves.
  On a phone or a tablet there is no dock: the tab bar carries a `Player` tab.
  The full player holds the artwork with album, year and genres, one transport
  row in two groups: previous/play/next with the volume, then filing and the
  track card, and after a hairline the audio/video/live switch — the first group
  acts on this track, the second chooses which version of it plays — then the
  queue, and the `Info | Lyrics` panel. On a desktop
  it opens as a sheet over the window; press the backdrop, `Back`, or `Escape`.
- **You**: the library's own administration as a dialog — where the library is
  stored, the file verbs (Export, Import, Replace), the link health check, and the
  keyboard reference.
- **Lookup status** floats above the dock: the progress of an automatic info or
  lyrics lookup, with `Stop`, then a summary with `Dismiss`.
- Two shells, three breakpoints: **phone** (< 720px) and **tablet** (720–1180px)
  both use the one-screen-at-a-time shell behind a four-entry tab bar (`Library`,
  `Tracklist`, `Player`, `You`), and **desktop** (> 1180px) puts the library column
  and the list side by side with the player docked. A tablet is held like a phone
  and tapped like one; it only gets wider. The numbers live in `hooks/useLayout.ts`
  and are mirrored by one `@media` block in `styles.css`.

### Track list

One line per row, at the same density as the player's `Up next` list (30px on a
desktop, 33px where a thumb does the tapping): number, title, artist beside it,
album when the column is wide enough, duration at the right edge. The number
becomes an equaliser on the row that is playing, which is how the list answers
"what is on, and where am I".

**Pressing a row plays it.** The track card — where a record is edited, filed or
deleted — is behind the `⋯` button or a right-click (`Play`, `Open track card`,
`Add to playlist…`, `Remove from this playlist`, `Delete track`), so the two
gestures no longer compete for the same line.

Sorting (`Sort` in the toolbar) changes the order of the rows *and* of what Play
will queue, and never writes anything back: a playlist returns to its dragged
order when `Playlist order` is chosen again. Tracks with no value in the sorted
field always sort last, in both directions.

Rows are draggable. Re-ordering works only inside a user playlist, and only when no
filter is active. Dropping a row onto a playlist in the tree files the track there.

Above every list: **shuffle**, **repeat** and — on folder and playlist lists —
**DJ**. Shuffle changes what plays next and leaves the rows where they are: every
track is drawn once per pass, a new pass is dealt when the last one runs out, and a
new pass does not open on the track that just finished. Repeat restarts the list at
the end.

DJ keeps the music going after the list ends. It drafts picks from what is playing
— same artist first, then shared genres, era and playlist neighbours, weighted by
the play history — appends them to the queue and drafts more as they run low. The
seed follows the current track. The player shows a `DJ on` badge, or `Suggested by
DJ` with the track it grew from when the playing track is a pick, and the same
badge turns the station off.

Every track that plays to its end is logged as a play. The log travels with Export
and Import, and is capped at 1000 entries.

### Track card and editor

The card shows the whole record, the three source URLs, the cover, the MusicBrainz
id, its **Info** and **Lyrics**, the playlists the track is in (remove from each),
an add-to-playlist picker, and Delete. **Edit** turns the same card into a form for
every field and all three sources. Info and lyrics are looked up and written there
and nowhere else: icon-only magnifiers auto-fill details from YouTube and
MusicBrainz and fetch words from LRCLIB and Lyrics.ovh. The player's lyrics column
reads, pastes, saves and clears words without looking anything up. Saving leaves
the card open.

## Sources and playback

A track has three source slots, each with a role:

| Slot | Role | Used by |
| --- | --- | --- |
| Main | `audio` | audio view (the default), and as the fallback for the other two |
| Official clip | `video` | video view, falling back to Main |
| Live take | `live` | live view, falling back to the clip, then Main |

Main or the clip alone is a complete track; a live take alone is not. One video
cannot fill two slots, and a fourth link is refused. Sources are edited in the
track card. The editor cannot empty the Main slot — replace it instead — while the
link check can remove any slot, Main included.

Playback:

- Selecting a track creates no player; nothing streams until Play is pressed.
- One button cycles Play → Pause → Resume. Selecting another track resets it to Play.
- **Audio view** streams in a 1×1 hidden frame and asks YouTube for its lowest
  video rendition (`vq=tiny`). Audio quality is unaffected — YouTube serves audio
  as a separate stream — and bandwidth drops sharply. **Video view** sends no
  quality hint and lets YouTube adapt, like youtube.com. **Live view** streams the
  live take.
- The view is sticky across tracks. Switching views keeps the current position and
  keeps playing if it was playing; a stopped track stays stopped.
- The queue follows the visible list. Skipping carries the playback state over: a
  playing track starts the next one playing, a paused or stopped track cues the
  next one silently. A track reaching its end continues.
- Volume: a slider beside the mute button, plus `-`/`=` in steps of 5. Muting keeps
  the level, and both survive track changes and view switches.
- Fullscreen is an overlay with its own control bar, which fades after 2.5 seconds
  without pointer or keyboard activity and stays while paused. Its sound button
  reveals a volume slider.

### YouTube's own interface

| Parameter | Effect |
| --- | --- |
| `controls=0` | No YouTube control bar |
| `disablekb=1` | No YouTube keyboard shortcuts |
| `rel=0` | No related videos |
| `iv_load_policy=3` | No annotations, cards or polls |
| `cc_load_policy=0` | Captions never forced on |

`modestbranding` and `showinfo` no longer function and are not set. The corner
wordmark is covered by a soft gradient drawn over that corner. Anything inside the
cross-origin frame — the wordmark, any channel overlay — cannot be styled or
removed, and no player parameter disables ads.

**Ads.** The embedded player shows whatever ads YouTube serves; there is no
parameter to turn them off. In a real browser tab your own ad-blocker applies to
the embedded player: Brave blocks by default, and uBlock Origin or AdGuard work on
the player too. They can block the player's ads even if a stricter filter list
silences the player, because the block list can be tuned per host. If a strict
filter list leaves the player silent, allowlist
`youtube-nocookie.com`, `googlevideo.com` and `ytimg.com`.

**What is not possible.** The video stream cannot be blocked entirely — YouTube
decides the manifest — so audio view requests the smallest rendition rather than
none. Nothing is downloaded or cached in either view.

## Lyrics

The lyrics column shows the words for the selected track. Selecting a track looks
its lyrics up in LRCLIB, with Lyrics.ovh as the fallback, and caches the answer in
memory for ten minutes. Nothing is stored until you press **Save**; the panel also
has **Look up** and **Clear**. Saved lyrics live on the track (`lyrics`,
`lyricsSource`) and are exported with the library. The panel credits the provider
the words came from.

A background lyrics lookup runs for a track that arrives without words, and stops
at the first blank-track write — words you type always win.

## Metadata

The add dialog and the card editor both auto-fill:

| Source | Provides |  Key needed |
| --- | --- | --- |
| YouTube oEmbed |  title, channel, thumbnail | no |
| YouTube watch page |  description, tags, album/year hints | no |
| MusicBrainz + Cover Art Archive |  album, year, genres, cover art, recording id | no |
| iTunes |  release year | no |

Auto-fill only fills fields you left blank and reports which ones it filled. The
watch page is scraped, so it can stop matching when YouTube changes its markup; it
then returns nothing rather than failing.

**Background fill** runs for tracks that arrive missing a bio, year or genres: a
track added whose lookup failed, a file imported, or a batch merged from an inbox.
It is sequential and rate-limited to about one request a second, makes one attempt
per track per session, fills blanks only, and unions genres. Opening the app looks
nothing up — only tracks that arrive while the window is open are swept. Progress
and the result appear in the lookup status row above the library, with `Stop`.

Genres are stored lower-cased and deduplicated.

## Link check

**Check library links** cues each stored link in a hidden player, so the verdict
comes from this machine — including whether YouTube blocks the video here. The run
shows its progress and can be stopped; a stopped run writes nothing.

When it finishes it has already written what YouTube said:

- A link that will not play here is removed from its track.
- A track left with neither a Main link nor a clip is filed under a top-level
  **Issues** playlist, created the first time it is needed. Paste a new link in its
  card to make it playable again.
- A link that could not be asked (no answer) is left in place, and a failed cut is
  reported rather than retried.

The result lists the removed links and the filed tracks, each with a button that
opens the track card, and counts what was checked, removed, already playing, filed
and left alone.

## Export, Import, Replace

- **Export** downloads `trackvault-YYYY-MM-DD.json`: the whole document, ids
  included.
- **Import** merges a file into the current library. Tracks are matched on
  MusicBrainz id, or on artist + title. Existing tracks keep every field they have;
  the file only fills blanks, unions genres and attaches missing sources. Playlists
  are matched by name and membership is additive, so importing the same file twice
  changes nothing. A track with no playable link is still imported and reported. A
  playlist entry that matches no track is reported rather than dropped.
- **Replace** makes the library mirror the file: it validates the file, saves the
  current library as a backup download, empties the library, then imports it. The
  confirm dialog counts the file first. In the JSON library the whole replace is
  one write, so a file that fails leaves the previous library untouched.

Both stores use the same import code, so a file moves between the JSON library and
the SQLite fallback intact.

## Working with an AI assistant

### The drop box

Write a batch to `data/inbox.json`. The app merges it on its next read (within a few
seconds) and reports what it did. With the server running the same batch can be
posted:

```bash
curl -X POST --data-binary @inbox.json \
  -H 'Content-Type: application/json' \
  http://localhost:1420/api/agent/inbox
```

An inbox batch contains only new material:

```json
{`
  "tracks": [
    {
      "title": "Live Like an Angel",
      "artist": "Venom",
      "album": "Welcome to Hell",
      "year": 1985,
      "genres": ["black metal", "speed metal", "nwobhm"],
      "audio": "g_d0L8AJmLQ",
      "video": "https://youtu.be/S7Hc4QwqZ2w",
      "live": "dQw4w9WgXcQd",
      "key": "venom-welcome"
    }
  ],
  "playlists": [
    {
      "name": "NWOBHM",
      "description": "New wave of British heavy metal",
      "folder": "Metal/NWOBHM",
      "tracks": ["Venom — In League With Satan", "venom-welcome"]
    }
  ]
}
```

- `title` and `artist` are required. `audio`/`video`/`live` take a bare 11-character
  id, a watch URL or a `youtu.be` link.  `album`, `year`, `genres`, `coverUrl`, `info`, `lyrics`, `duration` and
  `musicbrainzRecordingId` are optional.
- `key` names a track so a playlist in the same file can refer to it.
- Playlist entries are `"Artist — Title"` strings; a bare title works when it is
  unambiguous. A playlist takes an optional `folder` path, created if missing.
- A track that matches one you already own is enriched: blanks filled, genres
  unioned, a missing source attached. Nothing is overwritten.
- A track whose YouTube link does not exist is still added, without a playable
  link, and named in the report so the link can be fixed by hand. Every link is
  checked before the merge; a failed check lets the batch through unchecked.
- An entry with no title or artist is rejected and listed.
- Re-sending the same inbox is a no-op.
- The inbox is cleared only after the merged library is written, and archived to
  `data/inbox-applied/`. A file that is not valid JSON yet is left where it is.

The box only adds and enriches. It never deletes or renames anything.

`data/last-merge.json` holds the same report the banner shows, so a follow-up
prompt can be *“read `data/last-merge.json` and fix the rejected entries”*.

### Export → edit → Replace

For changes the box cannot make — retitling, deleting tracks, creating or dropping
playlists — edit an exported file and put it back with **Replace**.

- A playlist's `tracks` array holds track ids. Tracks may also be referenced as
  `"Artist — Title"` strings or `{ "title": …, "artist": … }` objects, which needs no
  id bookkeeping.
- A missing or repeated track, folder or playlist id is repaired on import: the row
  gets a fresh id above the highest in the file.
- Playlist entries naming a track the file does not contain are reported as
  *matched no track*.
- Unknown fields are ignored.

## HTTP API

The local server (`vite-plugin-library.ts`) exposes:

| Method and path | Purpose |
| --- | --- |
| `GET /api/library` | The whole document, with an `ETag` |
| `PUT /api/library` | Replace it; `If-Match` is checked, 409 when stale |
| `GET /api/library/revision` | Content-hash revision, pending inbox, last report |
| `GET /api/agent/context` | The compact library summary |
| `GET /api/agent/inbox` | The waiting inbox and the last report |
| `PUT`/`POST /api/agent/inbox` | Submit a batch; merges immediately |
| `DELETE /api/agent/inbox` | Discard the waiting batch |
| `GET /api/agent/backups` | Snapshots with their track counts |
| `POST /api/agent/restore` | Restore one: `{"name": "library-….json"}` |

## The library file

```json
{
  "format": "trackvault-library",
  "version": 1,
  "tracks": [
    {
      "id": 1,
      "title": "Paranoid Android",
      "artist": "Radiohead",
      "album": "OK Computer",
      "coverUrl": "https://coverartarchive.org/release/abc123/front-500",
      "year": 1997,
      "musicbrainzRecordingId": "abc123-def-456",
      "info": null,
      "lyrics": null,
      "lyricsSource": null,
      "duration": 383,
      "createdAt": "2026-10-02T12:00:00.000Z",
      "genres": ["prog rock", "psychedelic"],
      "sources": [
        {
          "id": 1,
          "youtubeId": "f7nonexistent1",
          "url": "https://www.youtube.com/watch?v=f7nonexistent1",
          "kind": "official",
          "label": null,
          "role": "audio"
        }
      ]
    }
  ],
  "folders": [{ "id": 1, "name": "Metal", "parentId": null, "createdAt": "…" }],
  "playlists": [
    {
      "id": 1,
      "name": "Favourites",
      "description": null,
      "createdAt": "…",
      "tracks": [1],
      "folderId": 1
    }
  ],
  "plays": [{ "trackId": 1, "playedAt": "2026-10-02T12:05:00.000Z" }]
}
```

`kind` is one of `official`, `album`, `live`, `cover`, `remix`, `video`. `role` is
`audio`, `video` or `live`, at most one of each. `duration` is whole seconds or `null` when unknown.

Reading is forgiving: `normalise()` fills a watch URL from a video id (or reads the
id out of a pasted URL), defaults `kind`, derives `role` from list order (first link
Main, second clip, third live), drops duplicate genres, gives every row a unique id,
lifts a playlist whose folder is missing to the top level, and gives a track with no
title or artist a placeholder. A file that is not valid JSON loads as an empty
library.

## Keyboard

`space`/`k` play, pause or resume · `n`/`p` next/previous · `s` stop · `m` mute ·
`-`/`=` volume · `←`/`→` seek 10 seconds · `f` fullscreen · `Esc` close fullscreen.

## Limits

- Ads come from YouTube and cannot be disabled by the player; a browser ad-blocker
  is the only in-app route.
- The video stream cannot be blocked entirely, and nothing is downloaded.
- Album and year guesses read YouTube's watch page, which can change without notice.
- MusicBrainz allows about one request a second; background lookups are sequential.
- The inbox only adds and enriches. Removing tracks and playlists is done in the app
  or with Export → edit → Replace.
- The browser-local SQLite fallback is a separate store from `data/library.json`.


