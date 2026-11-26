# Shared UI controller (`media/player-ui.js`)

Status: the helpers are in production; `create()` is a proposal. `media/player.js` and `media/compare.js` call the
shared helpers below for their UI wiring (per interaction: docs/TESTING.md, "What is shared with production"); the
mockup harness (`tools/mockup/render.js`) mounts the same file through `create()`, which previews the unified
1 → N page over `media/player-state.js`. No production page loads `player-state.js` yet. What is still
page-specific is listed under "What stays in the pages".

## Problem

The UI glue that connects the real bar (`src/bar.js`), `VpeControls`, `VpeFolderRail`, `VpeCtxMenu`, the stage
cells and the keys to the state lived twice: once in `media/player.js` / `media/compare.js` (over the decoders and
`vscode.postMessage`), and again as ~500 lines of ad-hoc wiring inside the mockup harness. The harness copy had
already drifted: its rail handler listened for a `folderRail` message the rail never posts (the real type is
`rail`), so rows, `+` compare and `‹`/`›` did nothing; `meta` was sent without `patches[]`, so the columns stayed
empty; and a stage click called `controls.isOpen()`, which does not exist.

## What it is

`VpePlayerUi.create(env)` takes adapters and owns every UI wiring step. It is plain JS with a `checkJs` region
(`tsconfig.check.json`) and never touches VS Code or a decoder:

| `env` field | Contract |
|---|---|
| `doc`, `win` | The page's `document` / `window` (tests pass a fake). |
| `stateApi` | `media/player-state.js` (pure unified tab/compare state). |
| `engine` | **EngineAdapter**: `clips`, `getClip(id)`, `draw(canvas, clipId, frame, { splitClipRatio })`, optional `facts(id)`. |
| `host` | **HostAdapter**: `post(msg)`. The host answers through the returned `onHostMessage(msg)`. |
| `widgets` | `VpeControls`, `VpeFolderRail`, `VpeCtxMenu`, `VpeAbLoop`, `VpeAutoplay`, `VpeTime` (default: page globals). |
| `initial`, `prefs`, `railCfg` | First state, bar prefs, rail config. |
| `tickMs`, `onChange` | Playback clock for engines without one (0 = off); called after each render (harness chrome). |

It returns `{ render, onHostMessage, dispatch(name, ...args), actions(), getState, setState, getPrefs, rail,
controls, ctxMenu, ab, dispose }`. The keys, the bar, the menus and the panels all run the same named actions.

### Messages

| Direction | Message |
|---|---|
| host → page | `{ type: 'rail', op, ... }` the folder-rail protocol of `src/folder-rail.js` (`list`, `meta` with `patches[]`, `pos`, `members`, `layout`, `show`) |
| host → page | `{ type: 'openVideo', clipId, label?, compare?, replace?, forceNewTab? }` (`replace`: folder navigation in a single view; `compare`: turn capture on and join) |
| host → page | `{ type: 'toast', text }` |
| page → host | `{ type: 'rail' \| 'neighbour', ... }` posted by `VpeFolderRail` itself, unchanged |
| page → host | `{ type: 'tiles', tabId, tiles, current }` after any change of the active tab's videos |
| page → host | `{ type: 'pickVideo', exclude }`, `{ type: 'copyText', text }`, and `saveFrame`, `copyFrame`, `copyLink`, `external`, `openSettings`, `loadSubs`, `openUrl`, `fullscreen` |

`tools/mockup/fake-host.js` implements the host side over a two-folder tree (root + `renders/`, a `notes.txt` for
the Playable filter), so clicking files, `+` compare, `‹`/`›`, browse/up, the filter, the column menu and the
Autoplay menu all work end to end in the mockup.

### What it wires

Bar: play/pause, ‹/› frame, step-size badges, mute/volume, the time format cycle, A/B buttons and draggable pins,
CC, the Folder capsule (hidden at N ≥ 2), the unified Compare/Capture toggle, Split Wipe (N = 2), Sync offsets
(N ≥ 2), ⓘ, Speed, ⚙, Picture size, Fullscreen. `src/bar.js` has no Split/Sync buttons yet, so the controller adds
`#splitBtn` / `#syncBtn` beside `#startCompareBtn` when they are missing.

Panels: every `VpeControls` page, plus `cmp` (videos with offsets, Add video, Open new videos here, Layout,
Sync, Leave compare) and `cmpVid` (offset −/+/Reset, Enlarge, Remove) over the unified state; About shows one tab
per video in Compare. Context menu: the real `VpeCtxMenu` on the stage.

Stage: cells from `deriveUi`, hover pills, enlarge/remove/offset buttons, double-click to enlarge, Spotlight
splitter drag, Split Wipe divider drag, the `+ Add video` slot.

Keys (`keyCommand`, the same table the pages use): `Space`/`K`, `J`/`L`, arrows (with Shift), `,` `.`, `[` `]`
`<` `>`, `↑` `↓`, `Home`/`End`, `0`-`9`, `M`, `R`, `A` `B` `Backspace`, `T`, `S`, `Z`, `I`, `?`, `Esc` (panels,
then menu, then collapse Spotlight), `D` (pick: proposal, see below), `Shift+D` (capture), `Shift+N`/`Shift+P` (folder ‹ / ›), `F`.
Keys a focused control owns (`VpeModes.ownsKey`: the rail filter, a list box) are ignored. The splitter and the
divider take Compare's keys (arrows, Shift / PageUp / PageDown, Home / End); the divider is Compare's own binding
(`bindSplitDivider`, 0–100 %).

**Production parity vs. proposal.** `PAGE_KEY_ACTIONS` lists the actions each shipped page handles; the test pins
each page's `KEY_ACTIONS` to it. `pickVideoMessage(surface)` is the one mapping for `D`: the single player posts
`{ type: 'comparePick', t }`, production Compare has no plain-`D` key, and `create()` (proposal) posts
`{ type: 'pickVideo', exclude }` in any N. The tests keep the two kinds of assertions apart.

## The shared helpers (production and mockup)

Both production pages load `player-ui.js` right before their own script (`src/player-html.js` `SCRIPTS`,
`src/compare.js` `compareScripts`; `player-state.js` stays out until a page calls it) and call these helpers instead of keeping
their own copies. `create()` uses the same helpers, so the mockup runs the production wiring:

| Helper | What it replaces | `player.js` | `compare.js` | `create()` |
|---|---|---|---|---|
| `keyCommand(e, { altGr })`, `runKey(e, KEY_ACTIONS)` | the two `switch (e.key)` blocks; each page keeps a `KEY_ACTIONS` table of its own handlers | yes | yes | yes |
| `bindButtons([[el, run, stop]], on?)` | the bar's `onclick =` lines (stop flag per button, as before) | yes | yes | yes (`on` = listener) |
| `stepBy`, `bindStepBadges` | the step buttons' size logic and the badge popover click | yes | yes | yes |
| `bindAbPins`, `pinPercent` | the A–B pin drag (pin position, tip text and placement) | yes | yes | yes |
| `timeReadout`, `nextTimeMode`, `TIME_MODE_NAMES` | the time / timecode / frame readout and its click cycle | yes | yes | yes |
| `pictureButton` | the Picture size button's mode, title and label | yes | yes (`all videos`) | yes |
| `copyInfoText` | ⓘ › Copy details | yes | yes | yes |
| `createContextMenu` | the `VpeCtxMenu.create` + action lookup | yes | (Compare has its own tile menu) | yes |
| `createFolderRail`, `goNeighbour` | the `#rail` guard and Shift+N / Shift+P fallback | yes | yes (rail) | yes |
| `spotlightRatioAt`, `spotlightKeyRatio` | the Spotlight splitter math | | yes | yes |
| `bindSplitDivider` (`splitRatioAt`, `splitKeyRatio`) | the whole Split Wipe divider: drag over the displayed (letterboxed) picture with pointer capture, keys, Home 0 % / End 100 %, no click through | | yes | yes |
| `PAGE_KEY_ACTIONS`, `pickVideoMessage` | each page's key set; the `D` message per surface | yes | yes (no `D`) | yes (proposal) |

The helpers take the widget modules as arguments (never a page global) and touch no decoder, so
`test/host/player_ui_test.js` loads them in Node. `media/player-ui.js` stays in `tsconfig.check.json` and under the
webview boundary rules of `.dependency-cruiser.cjs`, which also lock the 3-way split: `player-state.js` imports
nothing, `player-ui.js` imports no `src/`, Node built-in or decoder module.

## What stays in the pages, and why

- **Decoder lifetimes and clocks**: `player.js` drives one `engine.js` player; `compare.js` drives N players, the
  compositor (`compare-compositor.js`), offsets and sync. What a key or button *does* (seek, step, rate, volume)
  is the page's handler; only the dispatch is shared.
- **Compare's stage**: tiles drawn by the compositor in one canvas, tile drag-to-reorder, the tile menu, sync
  mode, add mode. `create()` has its own simple stage over `deriveUi` cells for the mockup; moving Compare onto it
  needs the EngineAdapter below.
- **Page-only features**: scopes, the pixel inspector, subtitles, X-ray, exports, remote streaming, the Start
  Compare dialog, the notice banner, Zen Mode's Esc Esc.
- **Separate webviews**: single and Compare are still two pages with their own host messages, so `create()` (one
  unified state for both) is not mounted in production yet.

## Tests

`test/host/player_ui_test.js` (layer 1B, about 2 s, no video decoded) checks:

- production parity, apart from the proposal: each page's `KEY_ACTIONS` equals `PAGE_KEY_ACTIONS`, `D` posts
  `comparePick` with the time in the player and is not a Compare key; then, separately, `create()`'s `pickVideo`;
- the key table, `runKey`, and the parity of the player's and Compare's `KEY_ACTIONS` tables (which page handles which
  key; every handler name is a `keyCommand` action; no second key switch left in either page);
- the pure helpers (time readout, Picture size, Copy details, step size, pin position and tip, splitter and
  divider math by dock and key, `bindButtons` stop policy, context-menu and rail creation) and that both pages
  call them instead of local copies;
- the FakeHost protocol;
- `bindSplitDivider` alone over a letterboxed picture (stage 800 × 400, picture inset x = 100, w = 600): 0 % and
  100 % by drag and by Home / End, pointer capture, right button ignored, no click through to the stage;
- `create()` over the real widgets on a strict fake DOM of the real markup (`test/host/fake-dom.js`: unknown ids
  are `null`, real `closest()` and parent-chain bubbling; `create()` refuses a page missing a required control):
  tile Enlarge / Remove / Sync buttons (and their icons) run their action without bubbling into play / pause; bar clicks, every key including AltGr and Ctrl rules, the
  real `abloop.js` pin drag, context-menu items, the rail round trip, Compare N = 1 → 2 → 3 → 1, cell DOM reuse
  across playback ticks, click to pause and double-click to enlarge mid-playback, Split Wipe divider and
  Spotlight splitter by keys and drag, panels, `dispose()`;
- that the harness mounts `VpePlayerUi.create(` and carries none of the old wiring;
- the boundary contract: no DOM / VS Code / decoder names in `player-state.js`, no VS Code / decoder names in
  `player-ui.js`, and the dependency-cruiser rules are present.

`test/host/player_html_test.js` checks the script order of both pages. See docs/TESTING.md, "UI and gesture tests
without video", for what stays in layer 3.

## Next step: one unified page

1. **EngineAdapter over the decoders**: `draw` becomes "present this tile's frame" over `frame-player.js` /
   `compare-compositor.js`; `tickMs: 0`, and the page calls `ui.dispatch('seek', f)` from the decoder clock
   instead of the controller's timer. `facts(id)` maps to `VpeControls.facts(meta)`.
2. **HostAdapter = `vscode.postMessage`** with a small translation table: `pickVideo` → `comparePick`,
   `fullscreen` / `copyFrame` stay page-side (they need the canvas), the rest already match production names
   (`rail`, `neighbour`, `copyText`, `saveFrame`, `external`, `openSettings`, `openUrl`).
3. **Host side**: `src/extension.js` answers `tiles` with `rail members` / `pos` (it already sends both) and
   sends `openVideo` where it now opens another webview for "add to Compare" (needs the single and Compare pages
   to share one webview; see `docs/notes/compare-ui.md` for the current Compare design).
4. Mount `create()` in that page and delete the remaining page-side bar and stage wiring; run the layer-3
   scenarios that cover the bar, the rail, Compare and the keys (pick them per AGENTS.md, Tests).
