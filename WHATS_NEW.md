# What changed in this build

The short version: the app was one long horizontal strip — rail, list, player,
lyrics — that had to be squeezed until it stacked. It is now three places you can
be in, one bar you can always reach, and every action that used to hide behind a
hover is also a press.

Run it with **START_TRACKVAULT.bat** (Windows) or **start-trackvault.command**
(macOS / Linux). First start installs dependencies and builds; that takes a
minute, and only happens once. Your library stays in `data/library.json` next to
the launcher.

---

## The shape of the app

**One place, and two things you open from it.** The top bar has `Library` on the
left and `Add track` + `You` on the right; nothing else.

- `Library` — everything that is a list: all tracks, folders, playlists, and the
  tracks inside whichever one you opened. On a desktop the button is also the
  column's switch.
- The **player** — opened from the bar that is already playing (the chevron on
  the dock, or the `Player` tab on a phone). It is not a destination you navigate
  to, so it is not a tab.
- `You` — the library file itself: export, import, replace, the link health
  check, the keyboard reference, and where the data actually lives. It opens as a
  **card** with an `✕`, like `Add track`, and closes with `Escape` or a click
  outside.

Export / Import / Replace / Health check used to sit in the top bar next to
`Add track`, as if filing a track and replacing the entire library were
neighbours. They are file-level actions and they now live together, one press
away, behind a deliberate action.

**The tracklist is a level of the library, not a tab.** On a phone you walk into
a playlist and the back chevron walks you out; on a desktop the list is the
column beside the tree. A list is the content of a selection, so it behaves like
one.

## Playing

- **A bottom dock at every width.** Cover, title, previous / play / next,
  elapsed and total, volume, and a chevron to open the full player. Progress is a
  hairline along the dock's own bottom edge. On a phone the dock sits directly on
  top of the tab bar, where a thumb already is.
- **The full player is a screen.** Artwork, transport (previous / play / next,
  then shuffle, repeat and the audio / video / live switch on one row), queue, and
  `Info | Lyrics` as a two-way switch instead of two stacked panels. On a desktop
  it opens as a sheet over the window; press the backdrop, `Back`, or `Escape` to
  leave it. Nothing about the stream is rebuilt on the way in or out — the same
  player moves rather than a second one starting.
- The queue is a list you can read at a glance: `Up next`, how many tracks, and
  the current one marked.
- **Tracks load paused** when you come back to a session.

## The list

- **Pressing a row plays it.** Before, the row opened a card and only a play mark
  revealed on hover started playback — a control that does not exist on a phone.
- The **`⋯` button on each row** (and right-click) opens the row menu: `Play`,
  `Open track card`, `Add to playlist…` / `Remove from this playlist`,
  `Delete track`. Nothing about a record is edited by accident any more.
- **Two-line rows**: title, then artist · album, with the duration at the right
  and the number at the left. The number becomes an equaliser on the row that is
  playing.
- **A real list header**: cover mosaic, name, count, running time, description,
  and `Play` / `Shuffle` / `Repeat` / `DJ` / `⋯`. The old info panel that named
  the playlist, and the "Now playing …" bar that named it again, are gone; the
  header is the only place a list is named.
- **Search + Filters + Sort** in one toolbar. Filters open in a popover with
  counts on every genre chip; whatever is on is repeated as removable chips under
  the toolbar, because a filter you cannot see is a filter you cannot explain when
  the list comes back short.
- **Sorting** (`Playlist order`, `Title`, `Artist`, `Album`, `Year`, `Date
  added`, `Length`, plus a direction toggle) reorders the rows and what `Play`
  will queue, and never writes anything back: a playlist returns to its dragged
  order when you choose `Playlist order` again.
- Dragging rows still re-orders inside a playlist and files a track into a
  playlist on the tree — **desktop only**, because touch browsers do not fire
  drag events; on touch the row menu does the same job.

## Layouts

| Width | What you get |
| --- | --- |
| phone (`< 720px`) | one screen at a time, a tab bar at the bottom, no dock |
| tablet (`720–1180px`) | the phone's shell, wider: the same tab bar, the same one screen at a time |
| desktop (`> 1180px`) | library column beside the list, player docked, player as a sheet |

The library column on a desktop is 240–560px, dragged from its own edge, and can
be hidden from the top bar when you want the width for the list.

## Fixes that are not visible, but are real

- **One meaning for `Escape`.** Four dialogs ignored it, so the key closed the
  shortcuts sheet but not the form you were filling in. One shared hook now
  closes whichever dialog is open.
- **Dialog actions stay on screen.** The footer (`Save`, `Cancel`) is pinned to
  the bottom of the dialog instead of scrolling out of reach below the fold; the
  header is pinned to the top.
- **Backup snapshots cannot overwrite each other.** Two merges inside the same
  millisecond used to write one file, so the undo list claimed a step that no
  longer existed. Names now carry a sequence.
- **Undefined CSS variables were being used for the dock and tab-bar heights**
  (`--dock-h`, `--tabbar-h`, `--topbar-h`), which is why the dock overlapped the
  last row on some widths. They are defined once, in one place.
- **A phone no longer gets a volume slider it cannot use**, nor a hidden hover
  control.
- **The empty library, list and filter states now say what to press next**,
  instead of a single grey sentence.
- Missing layout pieces were restored after the CSS rebuild: the folder tree,
  dialogs, context menus, cards and progress bars.

## Things I did not do

Honest list, not a pitch:

- **Collapsed folders do not spring open** while you drag a track over them.
  Drag onto a folder is deliberately not a drop target (a folder is a grouping,
  not a list), but hovering one while dragging a *playlist* does not expand it
  either.
- **No track re-ordering on touch.** Menu fallbacks exist for filing a track into
  a playlist, but ordering a playlist by finger is still a desktop job.
- **The single-file JSON library is a ceiling.** Every write rewrites the whole
  document, and the 4-second poll means two windows are eventually-consistent.
  It is fine at a few thousand tracks and will not be fine at fifty thousand.
- **Playback is YouTube's.** No offline, no background audio on iOS, and a dead
  video is a dead track until the health check files it under `Issues`.
- **One player at a time**, by design, but that also means no crossfade and no
  gapless.
- **`npm test` leaves one timing-sensitive test in `agentApi.test.ts`** — it is
  fixed now (see above) but the suite does depend on real filesystem timing in a
  few places.


---

# Round two

A second pass over the build above, all of it from your list.

## Top bar

- **One tab.** `Library`, and nothing else on the left.
- **`You` moved to the far right**, where the `?` button was; the `?` is gone
  (`?` on the keyboard and the button inside `You` still open the shortcuts).
- **The `+` in `Add track` is the same ink as the label** — dark on the gradient,
  not a white glyph sitting in a dark word.

## You

- Opens as a **card**, closable with `✕`, `Escape`, or a press outside it.
- `Open the library` and `Add a track` are gone from the Library section — you
  got there by using one of them, and one of them is in the bar already.
- The second `?` at the top of the section is gone.

## The library column

- **Drag its right edge** to resize it (240–560px). Double-click the edge to
  reset; the arrow keys nudge it when the edge has focus. The width is
  remembered per browser, and long playlist names now wrap instead of
  disappearing behind an ellipsis.

## The full player

- **The background is flat and stays flat.** No hover reaction on the sheet.
- **The queue button fills with the accent colour while the queue is open**, so
  "is it showing?" is a state, not a memory. The `Up next` list is about twice as
  dense: 30px rows, tighter type, no gaps.
- **A better track-card icon** — a card with a cover and two lines of text — and
  it sits **centred in the transport row**, not floating in the corner of the
  artwork.
- **The track card opens above the player.** It used to open behind the sheet
  because dialogs were below it in the stacking order; a dialog is now always the
  topmost layer.
- **The transport is one row**: previous, play, next, volume, then a grouped set
  of `Add to playlist` and `Open track card` (same size, same weight, filing to
  the left), then the audio / video / live switch — all at the same level. The
  groups wrap to a second row only when the window is too narrow to hold them,
  and `Shuffle` and `Repeat` are gone from the player (they are list controls and
  they live in the list header).

## Phone

- **No mini player.** The bottom bar is navigation; the player is a tab.
- **Four tabs**: `Library`, `Tracklist`, `Player`, `You`. `Tracklist` opens the
  list you were last reading — it used to be unreachable except by walking back
  through the browser. `Playing` is `Player` now, and it opens the full player.
- **One line per track**, 46px instead of 68px: number (or equaliser), title,
  artist, duration. The album is hidden in the list — it is on the player, where
  there is room for it.
- **The player shows album, year and genres** beside the cover.
- Everything above that applies to a phone applies there too: one tab in the top
  bar, `You` as a card, the one-row transport.

# Round three

Nine things, and two of them changed a rule rather than a pixel.

## The dock is laid out like a music app

- **Three zones**: what is playing on the left, the transport in the middle,
  volume and the open-player chevron on the right. It is one equal-weight grid,
  so the play button lands on the same pixel of the bar whether the title beside
  it is two characters or forty.
- **The seek bar sits under the transport, in that same middle column**, with
  the elapsed and remaining times either side. Before this the bar was a hairline
  across the whole bottom of the bar and the transport was wherever the title
  pushed it.
- Times and the fader step out of the way below 1000px, where four digits of
  clock either side of a 120px bar is just noise.

## The open player no longer reacts to the pointer

- Reported twice, so it is now a rule with a comment: the sheet's background,
  filter, opacity, box-shadow and transform are pinned, and the sheet carries no
  transition at all — a transition is only how a change becomes *visible*. A
  hover-stability probe walks the pointer over the artwork, the title, the seek
  bar, the transport, the panel and the empty space and diffs the computed style
  of every element in the sheet: the only thing that moves is the equaliser.

## Two groups in the sheet's transport

- **`Add to playlist` and `Open track card`** stay together on the left of the
  divider; **audio / video / live** sit on the other side of a hairline. The first
  two act on this track, the last three choose which version of it plays. They
  were one row of five identical buttons pretending to be one control.

## The sound bar survives the phone

- Two rules used to remove the fader at touch widths (one for every coarse
  pointer, one for `.layout-phone`). Both are gone: the sheet's transport shows
  the slider on a phone and a tablet, and the **mute button comes back with it** —
  a fader with no mute is a fader you have to drag to zero.

## Density: one number, two lists

- **`Up next` shows the artist beside the title**, not in a column of its own
  next to the duration. Title and artist read as one line, which is how the row
  is read aloud and how every other list in the app works.
- **The tracklist is as condensed as `Up next`**: 30px rows on a desktop, 33px
  where a thumb does the tapping, one line per track — number, title, artist,
  album when the column is wide enough, duration at the right. It used to be a
  two-line block with 6px of padding, which turned forty tracks into two screens
  of mostly air.

## A button that shuts every folder

- Third button in the library column's row of tools, next to **new folder** and
  **new playlist**, same size and shape, and disabled when nothing is open (so it
  never moves the two beside it). `collapseAll` lives in `useFolderExpansion`,
  next to the rule that decides which folders open by themselves, and it is
  tested there: a collapsed tree stays collapsed through a library refresh.

## A tablet is a wide phone

- **The tablet now wears the mobile shell**: no top bar, no dock, the tab bar and
  one screen at a time. `singlePane` (`layout !== 'desktop'`) is the one switch in
  `App.tsx`, and every `.layout-phone` rule in `styles.css` now carries a
  `.layout-tablet` twin.
- The custom properties were the trap: `.app.layout-tablet` set `--dock-h` with
  more weight than a bare `.layout-tablet` could beat, so a tablet reserved 120px
  under every list for a dock it does not have. Fixed at `.app.layout-tablet`.

## Two smaller ones, found while checking

- **The list header's meta line is one line** on a phone and a tablet, and the
  running time steps out below 820px — the kind of list, the count and the
  "playing now" tag are what that line is for. It used to wrap and leave a lone
  blue tag on a second line.
- **The mute button is back next to the returned fader**, and the sheet's
  mode switch keeps its divider only while it is on the same row as the actions.

## The back button names the folder it goes back to

- Three folders deep, `< Library` was a lie. It now reads `< Metal` — the folder
  above — and says `Library` only at the top level, with a matching `aria-label`
  and tooltip.
