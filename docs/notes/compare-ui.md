# Compare UI (the approved compare mock-up), 2026-11-20

Approved an interactive mock-up of compare that reuses the simple player's look (bar, ⚙-style panels,
toast). This branch builds it. The old compare toolbar, Sync panel, wipe / toggle views, metrics readout and the
Find diff button are gone from the UI.

## Where things are

| Part | File |
|---|---|
| The bar's markup, shared by the player and compare (`barHtml({ compare })`: no CC, plus `#cmpBtn`) | `src/bar.js` |
| The compare page (stage, cells layer, bar, panel, sheet, tile menu) and the host side (files, leave, replace, prefs) | `src/compare.js` |
| Engines, lockstep, compositor, cells / pills / nudges / divider, the Compare panel pages, tile menu, keys, test hook | `media/compare.js` |
| Panels: compare's ⚙ page variant (`s.compare`), extra pages (`env.views`), About tabs (`s.infoTabs`), compare key groups | `media/controls.js` |
| Styles (cells, pill, nudge, divider, add cell, menu, panel rows) on top of `player.css` | `media/compare.css` |
| More than 4 videos (static grid with `compare.maxVideos`): grid, budgets, shared renderer | `media/compare-grid.js`, docs/notes/multiview-engine.md |
| "Compare With…" in the player's right-click menu (`vpeFile`: files, not URLs or image sequences) | `src/ctxmenu.js`, `package.json`, `media/player.js` |
| Leave compare → player at the kept video's moment (`openPlayer`, through `pendingGoto`) | `src/extension.js` `registerCompare` deps |

## Decisions

- **In place, as a tab swap (not the same webview).** The player is a custom editor whose webview belongs to
  its `Session` (messages, native decoder, file watcher, position memory); compare is its own webview panel with
  N engines. Making one webview host both would mean a second message router inside `Session` and a page that
  switches between two scripts: a large restructure. Instead, compare opens in the player's editor group and the
  player's tab is closed right after (as Shift+N "next video" already does), starting at the player's position;
  **Leave compare** opens the player for the kept video (the clock by default) in the same group, at that video's
  moment (its own time: clock time minus the clock's offset plus its offset), and closes compare. To the user it is
  the same tab place; the tab title changes to the compared names.
- **Rendering:** one WebGL2 canvas covers the stage at device pixels; each tile's engine canvas is a mipmapped
  texture drawn into its cell's fitted rectangle (each video keeps its own aspect; before, every tile was scaled
  to A's size). Split draws A in the picture and B clipped right of the divider (scissor). Tiles with no frame at
  this moment (offset or length) stay black with a note.
- **Cells layer (DOM):** a `div.cell` per tile over the canvas; its `.ov` covers the tile's picture and shows on
  hover / focus: the name pill (letter, name, clock and sound icons, the tile's own frame number) and the
  ‹ offset › nudge (in split: both pills, left and right, nudges under them). 3 videos: the fourth cell is a
  button "Add video" that shows on hover.
- **Offsets:** − / + step one frame of that video, or 10 ms when the unit is ms (the mock-up; before: one frame's
  length in ms). Frames ↔ ms keep the moment (ms stays fractional, shown to 0.1 ms).
- **Tile menu:** an HTML menu in VS Code's menu colours (the webview's `contextmenu` is prevented, so VS Code's own
  menu doesn't open). A native menu can't show the tile's letter or its offset / timestamp.
- **⚙ panel in compare:** Speed, Loop, Sound › (opens the Compare panel), Copy view, Keyboard shortcuts, Jump
  sizes, Tools with Compare only (n videos), Extension settings. The mock-up's A-B loop and the other tools
  (Scopes, Inspector, Stats, X-ray, Export A-B) are left out: compare has no A-B loop and those tools are the
  single player's.
- **Shortcuts:** open **Settings › Keyboard shortcuts** or press **?**. Closing the sheet after opening it
  from Settings returns focus to the Settings button.
- **About (ⓘ / I):** "About these videos" with a tab per video (the player's facts for that tile).
- **Keys:** the player's (Space/K, , ., arrows with the jump sizes, J/L, Home/End, Shift+< >, ↑↓, M, R, F, I, ?,
  Esc, Ctrl+C copies the view) plus − / + (the video under the pointer, else the last chosen) and X (swap, 2
  videos). Gone: S (sync panel), 1–3 and T (views), N (find), I as metrics. Z is back as the picture size for all videos (docs/notes/ui-simple.md "Picture size").
- **Hidden for now (2026-11-20):** the "A vs B" section (PSNR / SSIM switch, Find first difference), the
  seek-bar amber band, the paused metrics readout and the 3–4 video note. The code stays: `pairMetrics`,
  `computeMetrics`, `ssim`, the scanner (hidden engine pair). Debug builds (`VPE_LOG`) still compute and log the
  paused pair's metrics (`metrics frameA=… psnrY=…`, used by `case/compare_metrics`); the scanner runs only from
  `window.vpeCompare.scanner` or the test hook (`scan`).

## Tile order

Put matching camera angles or references next to each other while the videos keep playing. The bar shows
**Reorder** beside the Compare button. In Reorder mode it shows **Done**, and the stage shows this cue.

```text
            Drag tiles to reorder · Esc or Done to finish
       ┌╌╌ A clip.mp4 ╌╌┐ ┌╌╌ B clip.webm ╌┐ ┌╌╌ C clip.mov ╌╌┐
       │                 │ │                 │ │                 │
       │           [↑ ↓] │ │                 │ │                 │
       └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
```

Drag over another tile to preview insertion into its slot. Release on a tile to keep the change.

**Live drag (2026-11-22).** Past 4 px the tile lifts: its cell gets `.lifted` (shadow, above the other cells) and
follows the pointer at `scale(1.02)`. Over another slot, the others glide to the order a drop would give
(`Grid.reorderSession`, always from the start order). The glide is a FLIP tween in `Grid.createGlide`: 180 ms,
`cubic-bezier(0.2, 0, 0, 1)`, and 0 ms with `prefers-reduced-motion: reduce`. It runs in JavaScript, not as a CSS
transition, because the pictures are drawn on the WebGL canvas under the cells. Each frame, `draw()` shifts each
tile's rectangle by the offset its cell has (`tileShift`) and draws the lifted tile last. A drop glides the lifted
tile into its slot and commits through `commitOrder` (no reload, playback goes on). Esc, Done, a lost pointer or
leaving the mode glide everything back. The arrows use the same glide. Split has one cell, so only the labels change.

**Remove button (2026-11-22).** With 3 or more videos, each tile's hover / focus layer has a 26 px **×** in its
top-right corner (22 px in dense grids). The single-tile offset nudge moves 34 px left to make room, and dense
grids pad the layer's right edge. Its name is `Remove <name> from Compare` and its title `Remove from Compare`. It
posts the host's `remove` (via `removeTile`), and the tiles' click handler stops the click before play / pause. With 2
videos there is no ×: removing one leaves Compare, which stays in the tile menu and the video's page. Hidden in Reorder mode.

```text
  ┌───────────────────────────────────────┐
  │ [A clip.mp4 #120]      [‹ 0 ›] [×]     │
  │                                       │
  │                               [↑ ↓]   │
  └───────────────────────────────────────┘
``` **Done**,
**Esc** or switching editor tabs ends the mode and cancels an unfinished drag. While in the mode, the tiles
pause their pan, zoom, wheel stepping, divider and offset gestures.

Hover or focus a tile to reveal its arrows in either mode. They sit in the bottom corner of the tile's own picture
(bottom-right; in Split, the left picture's arrows bottom-left), not in the cell: a letterboxed picture leaves black
bars above and below, and arrows in the cell's corner floated in those bars, away from the picture and its name pill.
`layoutCells` sets `--pic-l`, `--pic-r` and `--pic-b` (how far the picture's edges lie inside the cell) on each cell and
`.move` uses them; the layer-3 check `reorder/arrows-on-picture` (a 5-tile 3x2 grid) asserts the arrows' box lies inside
the picture, within 8 px of its corner. **Tab** reaches the enabled arrows and
**Enter** or **Space** activates them. Their accessible names are `Move <name> earlier` and
`Move <name> later`. An arrow at an end of the order is disabled. Focus follows the moved tile.

The letters, Compare panel, About tabs and editor title follow the new order. Decoders, clock, sound
and offsets stay with their videos. The Add cell stays in the first spare slot, and a newly added video
goes last when the page reloads. For two videos, **X** and **Swap sides** apply the same order change as the
arrows or drag, in Side by side and Split.

## Starting a compare (2026-11-20)

Added without changing the player's look except a drop hint (a dashed frame with "Drop to compare").

- **Key D: removed (maintainer, 2026-11-27).** Plain D no longer does anything; Shift+D (Capture) stays. "+ Add video"
  and Compare › Add video… pick through the host (`pickVideo`). What follows is the history of the old key.
  Key D in the player (not in compare) posted `comparePick`; the host (`src/compare.js` `comparePick`, rows in
  `src/comparepick.js`) shows a quick pick: "Same folder" (`workspace.fs.readDirectory`), "Workspace"
  (`workspace.findFiles`, 300 at most), then **Browse…** which runs Compare With… (the open dialog, several files).
  Recently compared videos (globalState `videoPreviewEnhanced.compareRecent`, 20) come first in each part, then natural
  name order. Picking one opens compare in the player's tab, at its position. Why D: a free plain letter, like the
  player's other keys; Ctrl+Alt+C is AltGr on many layouts and the player ignores Ctrl/Alt chords on purpose
  (`docs/keys.md`, `case/keyconflicts`). No default `keybindings` entry: the page already gets the key, and VS Code
  forwards every webview key to the workbench, so a second binding would fire twice. Users can still bind
  `videoPreviewEnhanced.compareWith` themselves.
- **Drop:** `dragenter` / `dragover` / `drop` on the player page read `text/uri-list`, `application/vnd.code.uri-list`
  and `resourceurls`; the host keeps video files (`droppedVideos`), at most 3, and opens compare. VS Code shows its own
  "open in editor" drop overlay over webviews and passes a drop to the page only with Shift held (docs say nothing about
  it; this is observed VS Code behaviour). So the hint only appears when the page does get the drag, which is when Shift
  is down. Not verified with a real Explorer drag (the hidden-desktop runner can't drag): the layer-3 case sends a
  synthetic drop with the same data types. If a VS Code version omits the URI lists, the player toasts "Drag a video
  from the Explorer".
- **Left out:** Explorer "Select for Compare" / "Compare with Selected" (a stateful two-step covered by
  Add to Compare and "Compare With…"); `DocumentDropEditProvider` (text editors only);
  dropping onto the compare page to add a video (Add video… exists).

## A plain drag from the Explorer (investigated 2026-11-20)

Gordon's first wish: a drag without Shift from the Explorer onto the player starts compare. **Not possible with
the VS Code API.** Read in VS Code 1.147.0's own code (the portable build in `test/vscode/.code`,
`workbench.desktop.main.js` and `contrib/webview/browser/pre/index.html`):

- **The page never sees the drag.** The workbench's webview drag monitor listens on the window for `dragstart`,
  `drag` and `dragover`: without Shift it calls `windowDidDragStart()` on every webview, which sets the webview's
  `<iframe>` to `pointer-events: none`; with Shift it calls `windowDidDragEnd()` (pointer events back on). An
  Explorer drag starts inside the workbench window, so the iframe is blocked before the pointer reaches it.
  (For drags from outside VS Code, `pre/index.html` posts `drag-start` unless the page called `preventDefault()`
  on `dragenter` first, "Extension code has already handled this event": that escape hatch does not help for
  Explorer drags, which never reach the page.)
- **The editor group's drop overlay** (`EditorDropTarget`) lets a drop through to the editor only when
  `editor.dropIntoEditor.enabled` is on, the active editor has the "can drop into editor" capability (webviews and
  custom editors have it) and Shift is held. The overlay itself says "Hold Shift to drop into editor". There is no
  option on `registerCustomEditorProvider`, `createWebviewPanel` or `WebviewOptions` that changes this, and no
  setting that turns the overlay off (`editor.dropIntoEditor.enabled: false` only turns Shift off too).
- **`DocumentDropEditProvider`** is for text editors only; `TreeDragAndDropController` only for the extension's own
  tree views, not the Explorer.
- **Detecting VS Code's own "drop opens the file in this group"**: a drop on the player's group opens the video as
  a new, pinned editor in that group. The host sees that open (our `resolveCustomEditor`, or a tab event) but
  cannot tell it from a double-click in the Explorer or Quick Open: there is no drag or drop event for extensions,
  and focus and pinning look the same. Turning every such open into "add to compare" would break plain opening.
  So it is used only while the user asked for it: add mode, below (with add mode on, a plain drop on the editor
  works too, since it is just another open).
- Not read: the discussion of microsoft/vscode#339036 (no web access in this run). Worth a look for a planned API.

## Add to Compare and sticky Add Mode (approved 2026-11-22)

Two Explorer commands required users to choose the workflow before selecting a file or folder. **Add to Compare**
accepts both in one selection. Expand folders in natural name order without descending into subfolders, skip files
already included and report how many unique videos were beyond the configured limit. Use the most recently active
Compare, or the active or most recently used file player if no Compare is open. With neither, start a new Compare.
A single selected file starts a one-tile Compare with the existing Add cell alongside it.

Add Mode turns on only on an explicit "add more" intent (maintainer decision 2026-11-22; `startsInAddMode` in
`src/addmode.js`, unit-tested, until the unified viewer replaced the old Compare page and that module was removed):

| Starts the Compare in Add Mode | Opens with Add Mode off |
|---|---|
| the toolbar Compare button's **Start comparison** confirm (`origin: 'toolbar-start'`, built on another branch) | a drag and drop of several videos, **Open With…** on a selection (`'burst'`) |
| a player armed by **Shift+D** or the D pick's Explorer row that took its next video (`'armed'`: the mode carries on) | **Add to Compare** on several files, a folder or a mix (`'selection'`), **Compare Videos in Folder** |
| right-click **Start / Add to Compare** on one video that makes a one-video Compare (`'start-single'`) | Shift+drop on a player, **Compare With…**; one file added to an open player (two videos) |

Videos chosen at once are the whole set the user wanted, so nothing waits for more. Later, **Shift+D**, **Add video…**,
the Compare panel's **Add from the Explorer** switch or the palette command toggle the mode. **Add video…** starts it. **Shift+D** in a file player and the **Click videos in the
Explorer…** row in the D quick pick arm the player. The next video opens Compare at the player's position and the
mode carries on. Pin the player while waiting so a preview open can leave the original tab in place until the
transition.

The hint uses the existing dashed border and `role="status"` above the pictures:

    Click videos in Explorer to add · Esc to stop
    ┌──────────────────┬──────────────────┐
    │ Video A          │ Add video…       │
    └──────────────────┴──────────────────┘

Playback, scrubbing and stepping leave the mode on. Esc in the webview or the Explorer keybinding
(`videoPreviewEnhanced.stopAddFromExplorer`), Shift+D, hitting `compare.maxVideos`, or switching to another editor
ends it. **Add to Compare** can append while the mode is off. Leaving Compare returns to the player and ends the mode.

## Toolbar entry point and Add Mode hint (maintainer-approved, 2026-11-22)

The single-video player's **Compare** button asks before it starts a one-video Compare with Add Mode on; with a
Compare open it reads **Add to Compare** and adds the video to the most recently active Compare at once
([player design note](ui-simple.md#compare-cc-and-toolbar-icons-maintainer-approved-2026-11-22)).

The Add Mode hint ("Click videos in Explorer to add · Esc to stop") ends with a small **Stop** button. A click, or
Enter / Space after Tab, ends Add Mode like Esc; focus then moves to the bar's Compare button. The hint stays
click-through apart from the button. The hint text is the live status (`role="status"`).

![The Add Mode hint with Stop](img/compare-addhint-stop.png)

Compare's bar uses the same icon set as the player (`src/bar.js`); **Reorder**, speed and time stay text. Compare
does not render subtitles, so its bar has no CC.

[Compare bar before](img/toolbar-compare-before.png) · [after](img/toolbar-compare-after.png)

`src/addmode.js` (since removed with the old Compare page) tracked the active target, video identities, capacity and
editor-switch rule. `src/comparepick.js`
plans a selection against the open editors. The host intercepts player opens in `resolveCustomEditor` and closes the
temporary tab. It uses tab events for files opened through a different editor and distinguishes those new video tabs
from switching to an existing editor. Only file and VS Code remote video URIs join.

### Contextual Compare commands (maintainer approved)

Both the Explorer menu and the file player's editor title show **Video Preview Enhanced: Start Compare** until
a Compare session opens, then **Video Preview Enhanced: Add to Compare**. The editor title keeps its diff icon.
The Explorer variants run the same selection handler for videos, folders and mixed selections. In the player,
Start Compare opens the file picker and Add to Compare sends the player's video to the most recently active
Compare. The Command Palette shows the matching player command with the same name. The player's right-click
**Compare With…** still opens the picker. Existing bindings to `videoPreviewEnhanced.compareWith` and
`videoPreviewEnhanced.addToCompare` keep working.

`videoPreviewEnhanced.compareOpen` is initialized from the window's live sessions and follows their lifecycle.
A background Compare still counts. The last Compare closing switches the label back to Start Compare.
`compare_addmode` runs the Explorer and player commands in the hidden desktop (the old `src/comparemenu.js` and its
unit test went with the old Compare page).

- **Open together.** A multi-selection opened through Open With…, Enter, a double-click or a drop is one editor per
  file in quick succession. `src/burst.js` (pure, timers injected) groups videos that arrive within 120 ms of the one
  before (`BURST_WINDOW_MS`; `VPE_BURST_MS` overrides it for tests) and, once it is quiet, `src/compare.js` opens
  them as one compare (the first tab's group, or in the first video's player's place) and closes the burst's tabs and
  panels. The opens of one gesture arrive within about 10 ms of each other (measured with 2 to 8 videos), so 120 ms
  leaves a wide margin and was chosen over 400 ms to cut about 280 ms from every open together. A Compare opened by
  a burst has Add Mode off (above).
- **Speed (2026-11-22).** Time from the first player resolve to a picture in every tile (debug log, `compare-burst-startup`
  bench): the burst window, the players, and two waits inside Compare were the cost. (1) The window 400 → 120 ms.
  (2) A video that arrives while another is pending is **held**: the player's `show()` (page, decoder download, ffprobe,
  native start) waits for the burst's verdict (`burst.wait`; `holdOpen` in `src/compare.js`, 10 s at most) and never
  runs if compare takes it, so 2 to 8 players no longer compete with Compare's own start-up. A video opened alone
  starts after one macrotask (setImmediate, sub-millisecond), so a single open is unchanged. (3) `syncPaused` no
  longer re-seeks a follower that is still on its first frame and wanted there (a soft tile slower than the clock
  decoded its first picture twice). (4) The first picture of every tile no longer waits for each tile's second frame
  to be decoded (`atFirstFrame`). Reports come from two
  places so a lazily resolved editor still counts: `resolveCustomEditor` (`noteOpen`) and `tabGroups.onDidChangeTabs`
  for our view types (the same file from both is one entry). More than `compare.maxVideos`: the first ones are
  compared and the rest stay as their own tabs (warning). Not started: one video, the same file twice, add mode on,
  setting `compare.openTogether` off. Known limits: the first video's player has already started (it is closed
  after compare opens: a short flash); a user who opens two videos within 400 ms by hand gets a compare; session
  restore at start-up does not report tab events after activation, but the resolves of restored editors that land
  within the window would (not seen, not tested: a real restart is not driven). Fallback if it misfires for someone:
  the setting, and the Explorer's **Add to Compare**.

`test/host/comparepick_test.js` (and, before the old Compare page was removed, `test/host/addmode_test.js`) cover mode transitions, capacity, duplicate files,
routing and which starts turn the mode on. The hidden VS Code `compare_addmode` case checks the context-menu
arguments, tab switching and the hint through single-file, multi-file, folder and playback flows. `compare_burst`
checks Open Together (one compare, Add Mode off, the next open a player of its own). `test/host/burst_test.js` covers
the window, holding and releasing players. The layer-4 bench `compare-burst-startup` times 1, 2, 5 and 8 opened
together.

## Deviations from the mock-up

- The tab is swapped rather than the same webview turning into compare (above).
- ⚙ panel: the shared A-B loop and **Export A–B Clips…** follow the
  [clip export design](ab-clip-export.md).
- The bar stays under the picture in the editor (as in the player), not over it.
- Colours come from the VS Code theme (as the player), not the mock-up's Dark+ values.

## Tests

- Host: `test/host/a11y_test.js` (compare markup: the player's bar without CC, `#cmpBtn`, scripts),
  `ctxmenu_test.js` (Compare With… in the menu, `vpeFile`), `compare_test.js` (session lifecycle).
- Real VS Code: `comparepick_test.js` (quick pick rows, recent list, drop parsing, commands), `case/compare_ui` (key D and a drop start compare; enter in place from the player at its position, tabs; the bar; the Compare
  panel and ⚙ › Tools › Compare; a video's page: offset frames / ms / Reset, clock and sound switches; pills,
  nudges, − / + under the pointer; split, divider drag, X; tile menu; 3 videos with the Add cell; Remove; Leave
  compare back to the player at the kept moment), `case/multiview` (grid, lockstep, offsets, clock, sound, remove,
  native tile sizes), `case/compare_metrics` (metric accuracy against ffmpeg, debug log), `case/modes`
  (side / split, removed view keys), `case/ui` (compare names and states, the Compare panel's focus and Esc).
