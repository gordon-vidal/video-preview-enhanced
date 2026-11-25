# Shared UI controller (`media/player-ui.js`)

Status: the **single-lane unified viewer** is the signed-off design: one page, one tab that grows from one video
to N (Compare), over one pure state, one UI controller and two adapters. Everything in "Architecture" is built and
tested in Node; the production cutover (Phase 5, at the end) is not done yet:

- `media/player.js` and `media/compare.js` call the shared helpers of `media/player-ui.js` for their UI wiring
  (per interaction: docs/TESTING.md, "What is shared with production"). Production pages load `player-ui.js` only.
- `VpePlayerUi.create()`, the controller modules, `media/player-state.js` and the production adapters run in the
  mockup harness (`tools/mockup/render.js`) and the Node tests; no production page loads them yet.

What is still page-specific is listed under "What stays in the pages".

## Architecture

| Layer | Module | Proved by |
|---|---|---|
| Pure state | `media/player-state.js`: unified tab / Compare state, no DOM, VS Code or decoder names | `test/host/player_state_test.js`, including seeded randomized action sequences that check every tab invariant after every step |
| UI controller | `media/player-ui.js` (`VpePlayerUi.create()` plus the shared helpers), composed with the four modules below through `env.widgets` | `test/host/player_ui_test.js` |
| | `media/player-ui-tiles.js`: Compare tile glide, drag / dock, tile menu, details card, ▲ / ▼, hover | `test/host/player_ui_tiles_test.js` |
| | `media/player-ui-input.js`: seek tip and thumbnail, wheel step / zoom / pan, idle bar, Zen Esc Esc, auto-pause, live region, go-to box | `test/host/player_ui_input_test.js` |
| | `media/player-ui-tools.js`: notice banner, inspection tools (scopes, inspector, stats, X-ray), subtitles, frame export | `test/host/player_ui_tools_test.js` |
| | `media/player-ui-lifecycle.js`: prefs sync, frame links and resume, rail handoffs, centre overlay, ready / pagehide bridge | `test/host/player_ui_lifecycle_test.js` |
| Engine and host | `media/player-engine-adapter.js` (`VpeEngineAdapter`, over the page's decoders and compositor), `media/player-host-adapter.js` (`VpeHostAdapter`, over `vscode.postMessage` with a per-surface name table) | `test/host/adapter_contract_test.js` (shared contract) and `test/host/production_adapters_test.js` |
| Mockup fakes | `tools/mockup/fake-engine.js`, `tools/mockup/fake-host.js` | the same shared contract suite, so they are verified fakes |

`test/host/adapter_contract_test.js` holds the EngineAdapter and HostAdapter contracts once
(`runEngineAdapterContract`, `runHostAdapterContract`); run directly it checks the two fakes, and
`production_adapters_test.js` runs the same functions against the production adapters plus what only they do
(player metadata, sound routing over N players, the page / boot envelope, per-surface message names, webview state).
So a UI test that passes over the fakes makes a claim the production adapters are held to as well.

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

**Production parity vs. proposal.** Each shipped page keeps its own `KEY_ACTIONS` table of handlers.
`test/host/player_ui_test.js` reads both tables from the page source and compares their handler names with expected
sets the test keeps itself (`EXPECTED_PLAYER_KEYS`, `EXPECTED_COMPARE_KEYS`; deliberately not shipped in
`player-ui.js`), checks a `PARITY` list of keys one page handles and the other does not, and checks that every
handler name is an action `keyCommand` produces. `pickVideoMessage(surface)` is the one mapping for `D`: the single player posts
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
| `pickVideoMessage` | the `D` message per surface | yes | (no `D` key) | yes (proposal) |

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

- production parity, apart from the proposal: each page's `KEY_ACTIONS` handler names equal the test's
  `EXPECTED_PLAYER_KEYS` / `EXPECTED_COMPARE_KEYS`, `D` posts
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

The controller modules and adapters have their own suites (see "Architecture"): `player_ui_tiles_test.js`,
`player_ui_input_test.js`, `player_ui_tools_test.js`, `player_ui_lifecycle_test.js` on the same strict fake DOM,
and `adapter_contract_test.js` / `production_adapters_test.js` for the adapters.

`test/host/player_html_test.js` checks the script order of both pages. See docs/TESTING.md, "UI and gesture tests
without video", for what stays in layer 3.

## Next step: one unified page (Phase 5 production cutover)

The adapters exist and pass the shared contract (`media/player-engine-adapter.js`, `media/player-host-adapter.js`;
see "Architecture"). What is left is the cutover itself:

1. **Drive the controller from the decoder clock**: `tickMs: 0`, and the page calls `ui.dispatch('seek', f)` from
   the decoder clock instead of the controller's timer.
2. **Host adapter surface**: start with the `player` / `compare` translation tables of `VpeHostAdapter` (for
   example `pickVideo` → `comparePick`), then switch to `unified` once the host speaks the controller's protocol.
3. **Host side**: `src/extension.js` answers `tiles` with `rail members` / `pos` (it already sends both) and
   sends `openVideo` where it now opens another webview for "add to Compare" (needs the single and Compare pages
   to share one webview; see `docs/notes/compare-ui.md` for the current Compare design).
4. **Switch the production webview** in `src/extension.js` to the unified shell: load `player-state.js`, the
   `player-ui-*` modules and the adapters, mount `create()`, and retire the duplicated UI code in `media/player.js`
   / `media/compare.js` (bar and stage wiring, their `KEY_ACTIONS` tables, the copies the modules replace). Run the
   layer-3 scenarios that cover the bar, the rail, Compare and the keys (pick them per AGENTS.md, Tests).
