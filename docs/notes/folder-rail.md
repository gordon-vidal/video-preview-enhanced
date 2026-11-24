# Folder rail, Autoplay and folder navigation (phase 1)

## Problem

Moving through a folder of clips meant `Shift+N` / `Shift+P` only: no view of what else is in the folder, no way to
see a clip's length or size before opening it, no "play the next one" and no quick Compare with a neighbour.

## What phase 1 adds

- **Bar capsule `‹ 2/5 ›`** (`#folderCap`, src/bar.js), right before Compare, single player of a file only. `‹` / `›`
  are the previous / next video; the count opens and closes the rail. Hidden for URLs, image sequences, Compare, a
  folder with one video, and below 720 px (the first step of the narrow-bar ladder in media/player.css).
- **Fold-out tab** (`#railOpenTab`, 20×84 px, 12 px `‹`): appears when the pointer is within 48 px of the picture's
  right edge; a click opens the rail, hovering never does. Not over the scopes, while panning a zoomed picture, during
  a drag or in fullscreen with the bar hidden. Zero layout footprint while the rail is closed.
- **The rail** (`#rail`, 218 px, 176–360 px by dragging its left edge; remembered for new tabs). `"dock"` (default,
  setting `folderRail.layout`) gives it real width beside the picture, so neither the video nor the scopes are covered;
  `"overlay"` floats it over the picture (86% frosted, blur 12 px). Same DOM, one class. Below 560 px a docked rail
  overlays. A 20×84 px `›` tab on its left edge (outside the resize grip) and a dim `×` close it; so does Esc.
  - Header: the folder and its parent. Filter (`Filter…`, keys stay in the field) and **Playable formats** (a
    monochrome check button, on by default: videos and folders only).
  - Column header `NAME | DURATION ▾`: a click on `DURATION ▾` or a right-click on the header picks **Duration**,
    **Size**, **Modified** or **None** (remembered).
  - Rows, 24 px (Details): `..` first (not at a file system root), folders, then files, natural case-insensitive order
    (`clip 2` before `clip 10`), hidden dot-files left out. The playing video has a soft fill and a 2 px bar. A video
    row shows a **Compare** button on hover: no Compare open, a 2-video Compare of the playing video and that one
    takes the tab at the current moment; a Compare open, the missing ones join it (no duplicates, up to
    `compare.maxVideos`). Hovering a file shows a card left of the rail: name, `duration · size · modified`,
    resolution and codec (`—` when unknown).
  - A folder row (not `..`) shows the same hover button, **Compare all videos in folder**: the folder's videos (the
    Explorer's Start Compare walk: natural order, subfolders too) start a Compare in the player's tab, or join the open
    Compare (no duplicates, up to `compare.maxVideos`). A toast says so when the folder has fewer than two videos, or
    when Compare is full.
  - Footer: **Autoplay: Off ▾** (Off / Play next in folder / Loop) and the position `2/5`.
- **Autoplay** (setting `onEnd`, replaces `loop`): ⚙ › Playback › **Autoplay ›**, the rail's footer, `R` (Loop ↔ Off;
  from Play next in folder it goes to Loop) and the right-click menu's Loop all change the open tab; the setting is the
  default for new tabs. An A–B range always repeats. **Play next in folder** advances once when playback runs into the
  end (forward, visible, at least 0.25 s of playback since the last play or seek: not on a seek to the end, a frame
  step, End or an error), opens the next video in the tab's place at 0:00 and plays it; at the last video it stays
  paused on the last frame.
- **Right-click on ◀| / |▶** (single player of a file): previous / next video. The left click still steps frames; the
  page's right-click menu is unchanged (no Next / Previous Video entries: the menu is about the moment shown and is
  already ten items long).

## Host side (src/folder-rail.js, ADR 0001 seam)

- Async `readdir` gives names and kinds at once; sizes and dates follow from a pool of 4 `stat` calls; ffprobe runs
  (one at a time) only for hovered and visible videos, cached in an LRU keyed by authority, path, size and date; the
  playing file's own metadata comes from the page. Hovered first, then visible rows, then the rest. Patches go to the
  page in batches tagged with the listing's generation. A folder change, closing the rail, hiding the tab or closing
  it cancels queued and running work; late answers are dropped.
- The page never sends a path: rows have opaque ids valid for one listing (generation).
- Closing the rail or hiding the tab suspends it: nothing is queued or posted, and a listing still being read is
  dropped. Showing it again reads that folder again, or posts what is already known (a batch that was pending at the
  close included) and fetches the rest.
- Symbolic links count as what they point to: a link to a regular file can be a video, a link to a folder is a
  folder, a broken link (or one to anything else) is left out, in the rail and in next / previous alike.
- The end-of-duration watchdog (the clock passed the declared end with nothing left to show) still pauses, but its
  report is not "played into the end" unless the decoder or transport gave the end of file, so a stalled native or
  remote feed never makes Autoplay move on.
- The **browse** folder (what the rail lists) is not the **playback** folder (the playing file's): next / previous,
  the capsule and Autoplay use the playback folder until a video is opened from the rail.
- **Tab swap:** navigation keeps `vscode.openWith` + `dispose()`. A handoff intent (rail open / width / filter /
  browsed folder, Autoplay, "from Autoplay") is registered before `openWith` and taken by the new tab's
  `resolveCustomEditor` ahead of Compare's Add Mode and Open Together. Intents are kept per uri *and* editor group;
  each registration has a token, so a failed open drops only its own. A target already open in the same editor group
  is revealed and takes the handoff (`railHandoff`); its page keeps it until its player has begun, applies it with
  the same `adopt` as a new tab (open or closed, width, filter, browsed folder, Autoplay; Autoplay's next plays from
  0:00) and answers `railAdopted`. Only that answer closes the source; without it (20 s, or the target closed) the
  source stays.
  Navigation is serialized per tab, so Autoplay never advances twice. Uris keep the file's scheme and authority
  (local, WSL, Remote-SSH).

## Keys and names (a11y)

`#folderCap` is a group "Folder"; its buttons are "Previous video in folder" (Shift+P), "Folder rail, video 2 of 5"
(`aria-expanded`) and "Next video in folder" (Shift+N). The rail is an `aside` "Folder" with a listbox "Files" (↑ ↓
Home End PageUp PageDown move, Enter opens, Backspace goes up, Esc closes). The two menus are `menu`s of
`menuitemradio`s. The fold-out tab is "Open folder rail"; it is not in the Tab order (the capsule is).

## Later (phase 2)

Preview mode (32 px rows with thumbnails): not built yet, and no button for it in phase 1.

## Future / follow-ups

- **Recursive search in the rail's filter:** match names in subfolders too (bounded walk, cancellable like the
  metadata work), with the folder shown on the matching rows.
- **Unify Compare view and the regular player view:** merge their UI elements and interaction model so Compare and
  single-video playback aren't two completely separate worlds — including showing the Folder Rail consistently in
  Compare (adding clips to the active Compare directly from the rail), rethinking the Enter Compare gesture (the
  Compare button's confirmation, Add Mode), drag-and-drop onto the picture or tiles, and auto-adding opened videos
  while Compare is active.
