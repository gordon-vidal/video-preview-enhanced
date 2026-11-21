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
| More than 4 videos (experimental `compare.maxVideos`): grid, budgets, shared renderer | `media/compare-grid.js`, docs/notes/multiview-engine.md |
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
- **About (ⓘ / I):** "About these videos" with a tab per video (the player's facts for that tile).
- **Keys:** the player's (Space/K, , ., arrows with the jump sizes, J/L, Home/End, Shift+< >, ↑↓, M, R, F, I, ?,
  Esc, Ctrl+C copies the view) plus − / + (the video under the pointer, else the last chosen) and X (swap, 2
  videos). Gone: S (sync panel), 1–3 and T (views), N (find), I as metrics. Z is back as the picture size for all videos (docs/notes/ui-simple.md "Picture size").
- **Hidden for now (2026-11-20):** the "A vs B" section (PSNR / SSIM switch, Find first difference), the
  seek-bar amber band, the paused metrics readout and the 3–4 video note. The code stays: `pairMetrics`,
  `computeMetrics`, `ssim`, the scanner (hidden engine pair). Debug builds (`VPE_LOG`) still compute and log the
  paused pair's metrics (`metrics frameA=… psnrY=…`, used by `case/compare_metrics`); the scanner runs only from
  `window.vpeCompare.scanner` or the test hook (`scan`).

## Starting a compare (2026-11-20)

Added without changing the player's look except a drop hint (a dashed frame with "Drop to compare").

- **Key D** in the player (not in compare) posts `comparePick`; the host (`src/compare.js` `comparePick`, rows in
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
- **Left out:** Explorer "Select for Compare" / "Compare with Selected" (a stateful two-step; multi-select
  Compare / Play Together and "Compare With…" already cover it); `DocumentDropEditProvider` (text editors only);
  dropping onto the compare page to add a video (Add video… exists).

## Deviations from the mock-up

- The tab is swapped rather than the same webview turning into compare (above).
- ⚙ panel: no A-B loop row, Tools has only Compare (above).
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
