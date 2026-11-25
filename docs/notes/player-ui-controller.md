# Shared UI controller (`media/player-ui.js`)

Status: in use by the mockup harness (`tools/mockup/render.js`); production `media/player.js` and
`media/compare.js` are **not** migrated yet (see "Production migration" below).

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

Keys (`keyAction`): `Space`/`K`, `,` `.`, `M`, `R`, `A` `B` `Backspace`, `Z`, `I`, `?`, `Esc` (panels, then
menu, then collapse Spotlight), `Shift+D` (capture), `Shift+N`/`Shift+P` (folder ‹ / ›), `F`. Keys typed into an
input (the rail filter) are ignored.

## Tests

`test/host/player_ui_test.js` (layer 1, ~0.2 s) checks the pure helpers, the FakeHost protocol, and runs
`create()` with the real widgets on a small permissive fake DOM: bar clicks, keys, the rail round trip through
the host, Compare N = 1 → 2 → 3 → 1, Split/Spotlight, panels, `dispose()`. It also asserts the harness script
mounts `VpePlayerUi.create(` and contains none of the old wiring.

## Production migration (next step, not done here)

Kept out of this change on purpose: `player.js` and `compare.js` carry decoder lifetimes, remote streaming and
layer-3 coverage, and the two pages still differ (separate webviews for single and Compare). The seam is ready:

1. **EngineAdapter over the decoders**: `draw` becomes "present this tile's frame" over `frame-player.js` /
   `compare-compositor.js`; `tickMs: 0`, and the page calls `ui.dispatch('seek', f)` from the decoder clock
   instead of the controller's timer. `facts(id)` maps to `VpeControls.facts(meta)`.
2. **HostAdapter = `vscode.postMessage`** with a small translation table: `pickVideo` → `comparePick`,
   `fullscreen` / `copyFrame` stay page-side (they need the canvas), the rest already match production names
   (`rail`, `neighbour`, `copyText`, `saveFrame`, `external`, `openSettings`, `openUrl`).
3. **Host side**: `src/extension.js` answers `tiles` with `rail members` / `pos` (it already sends both) and
   sends `openVideo` where it now opens another webview for "add to Compare" (needs the single and Compare pages
   to share one webview; see `docs/notes/compare-ui.md` for the current Compare design).
4. Move `player.js`'s keydown and bar `onclick` blocks onto `ui.dispatch`, then delete them; run the layer-3
   scenarios that cover the bar, the rail, Compare and the keys (pick them per AGENTS.md, Tests).
