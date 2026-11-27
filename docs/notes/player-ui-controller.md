# Shared UI controller (`media/player-ui.js`)

Status: the **single-lane unified viewer** is the signed-off design and the extension's only viewer: one page, one
tab that grows from one video to N (Compare), over one pure state, one UI controller and two adapters. Everything in
"Architecture" is built and tested in Node, the contracts between the modules are type-checked across files
("Contracts"), and `src/extension.js` opens every video in it ("Production wiring"). The old pages
(`media/player.js`, `media/compare.js`) and their hosts (`src/player-html.js`, `src/compare.js`) are deleted.

`VpePlayerUi.create()`, the controller modules, `media/player-state.js` and the production adapters run in the
viewer's page (`src/unified-html.js` + `media/player-unified.js`), in the mockup harness (`tools/mockup/render.js`)
and in the Node tests.

## Architecture

| Layer | Module | Proved by |
|---|---|---|
| Pure state | `media/player-state.js`: unified tab / Compare state, no DOM, VS Code or decoder names | `test/host/player_state_test.js`, including seeded randomized action sequences that check every tab invariant after every step |
| UI controller | `media/player-ui.js` (`VpePlayerUi.create()` plus the shared helpers), composed with the four modules below through `env.widgets` | `test/host/player_ui_test.js` |
| | `media/player-ui-tiles.js`: Compare tile glide, drag / dock, tile menu, details card, ▲ / ▼, hover | `test/host/player_ui_tiles_test.js` |
| | `media/player-ui-input.js`: seek tip and thumbnail, wheel step / zoom / pan, idle bar, Zen Esc Esc, auto-pause, live region, go-to box | `test/host/player_ui_input_test.js` |
| | `media/player-ui-tools.js`: notice banner, inspection tools (scopes, inspector, stats, X-ray), subtitles, frame export | `test/host/player_ui_tools_test.js` |
| | `media/player-ui-lifecycle.js`: prefs sync, frame links and resume, rail handoffs, centre overlay, ready / pagehide bridge | `test/host/player_ui_lifecycle_test.js` |
| Host session | `src/unified-session.js` (pure coordinator: clips, order, capture, the registry), `src/unified-viewer.js` (its effects: page, blocks, native ffmpeg, rail), `src/unified-html.js` | `test/host/unified_session_test.js`, `test/host/unified_viewer_test.js`, `test/host/unified_html_test.js` |
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
`#splitBtn` / `#syncBtn` beside `#startCompareBtn` when they are missing. In Compare the time readout leads with the clock video's
letter (`A 0:01.000 / 0:03.000`, then `B …` when B sets the clock): the controller adds `#timeLetter` in front of `#now`
(aria-hidden: the button's `aria-label` and the seek bar's `aria-valuetext` already say the letter); with one video it is
empty.

Panels: every `VpeControls` page, plus `cmp` (videos with offsets, Add video, Open new videos here, Layout,
Sync, Leave compare) and `cmpVid` (offset −/+/Reset, Enlarge, Remove) over the unified state; About shows one tab
per video in Compare. Context menu: the real `VpeCtxMenu` on the stage.

Stage: cells from `deriveUi`, hover pills, enlarge/remove/offset buttons, double-click to enlarge, Spotlight
splitter drag, Split Wipe divider drag, the `+ Add video` slot.

Keys (`keyCommand`, the same table the pages use): `Space`/`K`, `J`/`L`, arrows (with Shift), `,` `.`, `[` `]`
`<` `>`, `↑` `↓`, `Home`/`End`, `0`-`9`, `M`, `R`, `A` `B` `Backspace`, `T`, `S`, `Z`, `I`, `?`, `Esc` (panels,
then menu, then collapse Spotlight, last Capture), `Shift+D` (capture; plain `D` is no key since 2026-11-27), `Shift+N`/`Shift+P` (folder ‹ / ›), `F`.
Keys a focused control owns (`VpeModes.ownsKey`: the rail filter, a list box) are ignored. The splitter and the
divider take Compare's keys (arrows, Shift / PageUp / PageDown, Home / End); the divider is Compare's own binding
(`bindSplitDivider`, 0–100 %).

**Production parity vs. proposal.** Each shipped page keeps its own `KEY_ACTIONS` table of handlers.
`test/host/player_ui_test.js` reads both tables from the page source and compares their handler names with expected
sets the test keeps itself (`EXPECTED_PLAYER_KEYS`, `EXPECTED_COMPARE_KEYS`; deliberately not shipped in
`player-ui.js`), checks a `PARITY` list of keys one page handles and the other does not, and checks that every
handler name is an action `keyCommand` produces. `pickVideoMessage(surface)` is the one mapping for "pick another video" (+ Add video): the single player posted
`{ type: 'comparePick', t }`, production Compare has no plain-`D` key, and `create()` (proposal) posts
`{ type: 'pickVideo', exclude }` in any N. The tests keep the two kinds of assertions apart.

## The shared helpers

`create()` is built from small helpers that take the widget modules as arguments (never a page global) and touch no
decoder, so `test/host/player_ui_test.js` loads them in Node: `keyCommand` / `runKey` (the one key table),
`bindButtons`, `stepBy` / `bindStepBadges`, `bindAbPins` / `pinPercent`, `timeReadout` / `nextTimeMode` /
`TIME_MODE_NAMES`, `pictureButton`, `copyInfoText`, `createContextMenu`, `createFolderRail` / `goNeighbour`,
`spotlightRatioAt` / `spotlightKeyRatio`, `bindSplitDivider` (`splitRatioAt`, `splitKeyRatio`) and
`pickVideoMessage`. They were first shared by the two old pages, which is why some still take a surface name.

`media/player-ui.js` stays in `tsconfig.check.json` and under the webview boundary rules of
`.dependency-cruiser.cjs`, which also lock the 3-way split: `player-state.js` imports nothing, `player-ui.js` imports
no `src/`, Node built-in or decoder module.

## What the page does itself, and why

- **Decoder lifetimes and clocks**: `media/player-unified.js` makes one decoder per clip (`engine.js`'s
  LibavPlayer, or `frame-player.js` for an image sequence), starts and stops them as the tab's tiles change, and
  routes the host's decoder messages by clip id. What a key or button *does* is the controller's action.
- **Host traffic**: the page never learns a path; blocks, native ffmpeg, thumbnails and exact frames go by clip id.

## Tests

`test/host/player_ui_test.js` (layer 1B, about 2 s, no video decoded) checks:

- the key table and `runKey`, and + Add video's message (`pickVideo` with `exclude`, in any N);
- the pure helpers (time readout, Picture size, Copy details, step size, pin position and tip, splitter and
  divider math by dock and key, `bindButtons` stop policy, context-menu and rail creation);
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

`test/host/unified_html_test.js` and `player_html_test.js` check the page (CSP, script order, inlined assets, config).
See docs/TESTING.md, "UI and gesture tests without video", for what stays in layer 3.

## Contracts (`media/unified-contracts.d.ts`)

The interfaces the modules share are declared once, in a declaration file that holds no runtime code and is never
loaded (no build step; `.vscodeignore` keeps it out of the package):

| Contract | Implemented or used by |
|---|---|
| `EngineAdapter` (`clips`, `getClip`, `naturalSize`, `hasAudio`, `facts`, `shownFrame`, `showFrame`, `pictureRect`, `draw`, `thumbnail`, `thumbnailLeave`, `snapshot`, `setSoundSource`, `setVolume`, `registerClip`, `unregisterClip`, `pixelAt`, optional inspection and subtitle hooks) | `media/player-engine-adapter.js`, `tools/mockup/fake-engine.js`; `media/player-ui.js` needs `clips`, `getClip`, `draw` and uses the rest when present |
| `HostAdapter` (`post`, `connect`, `dispose`, `storage?`) | `media/player-host-adapter.js`, `tools/mockup/fake-host.js` |
| `UnifiedControllerApi` (`render`, `onHostMessage`, `onDecoderFrame`, `onDecoderEnded`, `syncClockMeta`, `dispatch`, `actions`, `getState`, `setState`, `getPrefs`, `dispose`, `parts`) | what `VpePlayerUi.create()` returns; `media/player-unified.js` drives it |
| `PageToHostMessage`, `HostToPageMessage` (unions on `type`) | `src/unified-session.js` reads the first and posts the second; the page does the reverse |
| `ClipSpec`, `ClipMeta`, `ClipDescriptor`, `OffsetSpec`, `PictureRect`, `PixelSample`, `TileSizePayload`, `TransportCommand` | the payloads of the above |

The modules name these types through JSDoc (`import('./unified-contracts').EngineAdapter`) instead of local
copies, and return their API through `@satisfies`, so a method that drifts fails in the module itself.
`npm run typecheck` (`tools/check-js.js`) runs two programs:

1. `tsconfig.check.json`: every listed file's `checkJs` regions, as before (the declaration file is in the list, so
   the import types resolve although the program does not follow imports).
2. `tsconfig.contracts.json`: `tools/unified-contracts-check.js` with module resolution on. It `require`s the seven
   modules, so each one's real exported type is held to its contract in one place: both engines are an
   `EngineAdapter` and a valid `env.engine`, both hosts a `HostAdapter`, `create()` returns a
   `UnifiedControllerApi`, the session takes every `PageToHostMessage` and posts only `HostToPageMessage`, and the
   page takes every `HostToPageMessage`. Only the contract files' own errors count there.

A message is added in the declaration file first; the side that posts it then compiles only with the right fields.
The page-side handlers read a host message loosely after that (each field is checked at run time), so the unions
are strict where messages are built and posted, not where they are parsed.

## Production wiring

`src/unified-viewer.js` is the page's host around `src/unified-session.js`, with the vscode API injected
(`test/host/unified_viewer_test.js` drives it over a fake panel and real temp files); `src/extension.js` gives it
its effects (`unifiedDeps`) and routes every video to it:

- **Opening a file.** The custom editor (`resolveCustomEditor`) prepares the clip (`prepareClip`: size, rotation,
  the native ffmpeg or Live transcode decision), then `createUnifiedRegistry().routeOpen(clip)` decides: a viewer
  whose **Capture** is on takes the video into its panel and the tab VS Code just made closes; else that tab
  becomes a viewer. A frame link's moment (`#t=` / `#frame=`, a pending `vscode://` link) or the resume position
  rides along as the open target. Videos VS Code opens together (an Explorer multi-selection) become one viewer
  (Open Together, `src/burst.js`). A tab closed while its file is still being probed gets no viewer.
- **URLs and image sequences** open in a webview panel of their own as clips without a file
  (`src/unified-sources.js`): a URL is inspected when the page's player first asks; native ffmpeg plays streams
  and what the decoder rule gives it, else the page's built-in decoder reads blocks over HTTP by clip id (the
  `libav` message restarts the page's player for the decoder chosen); an HLS quality pick restarts the clip in the
  same page. A sequence's frame player asks for pictures (`frames`) and gets them as `frame` messages.
- **Compare's commands** (Start / Add to Compare, Compare folder, Compare With…, compare links,
  Add from Explorer = Capture, page drops, the folder rail's Compare rows) add videos to the active viewer or open
  a viewer with them (`videoPreviewEnhanced.compare` panels).
- **1 → N → 1 in place.** The page is rendered once; `openVideo`, `replaceTile` and the page's `tiles` /
  `leaveCompare` change what it shows without a new page. A file rewritten on disk reloads in its tile.
- **Per clip, by id.** File blocks, native ffmpeg (`nd`, a `NativeDecoder` per clip started on its first message,
  at the tile size the page reported unless `sizeFramesToView` is off), Live transcode (`EncodedStream`, sharing
  the bitrate cap across the tiles shown), seek-bar thumbnails and exact frames. A native decoder that fails is
  replaced in place by the same file decoded in the page (a file ffmpeg rejected is remembered); a failed stream
  likewise.
- **Host features**: sidecar and loaded subtitles, Save frame, Copy link, A–B frame / clip export and the ffmpeg
  command, the resume position, the system player, the ffmpeg setup and GPU-test offers, decode-speed samples,
  slow-playback and reduced-resolution notices, the folder rail (in place: a row plays in the single video's place
  or joins a comparison), live prefs, playback prefs across tabs, Zen Mode, the `VPE_LOG` test hook
  (`src/debug-cmd.js`) and `VPE_SIMULATE_LINK`.

### Not carried over

- The old player's early start of native ffmpeg before its page was ready, and its remembered picture size for that
  guess (`src/early-probe.js` is no longer called).
- MJPEG AVI's own frame path: the built-in decoder plays MJPEG.
- Live transcode's automatic switch when native frames stall (`evaluateLocalStall`).
- The layer-3 scenarios (`test/vscode/`) still read the pages through `VpeDebugProbe` / `VpeCompareDebug`, which
  the viewer's page installs; they have not been run against the viewer yet.
