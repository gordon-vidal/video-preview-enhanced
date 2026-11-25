# Testing strategy (2026-11-20)

Four layers, each with one job. Lower layers carry the detail; real VS Code proves what a user sees.

| Layer | What it checks | Runs in | Parallel | Target time |
|---|---|---|---|---|
| 1. Unit | Pure logic: decoder choice, playlist/manifest parsing, time and frame math, settings, caches. Logic lives in small modules (not inside `player.js` / `engine.js`) so it can be tested alone. | Node | yes (all cores) | seconds |
| 2. Engine | The WebAssembly decoders in Node, no browser: frame-exact seeking, stepping, end of file, A-B loop, every format. Engine correctness may be proven here (2026-11-20). | Node | yes (all cores) | about a minute |
| 3. VS Code | 20-30 user scenarios in real VS Code on a hidden desktop (GPU decoding, WebGL, panels, icons, native ffmpeg, URLs, compare). Each scenario checks many things in one instance. Scenarios check correctness only, never speed, so load can't fail them. | real VS Code | 2-3 instances if WebGL2 stays stable (serial for now: see below) | minutes |
| 4. Performance | CPU, memory, start-up and frame rates, compared with the previous numbers. Not a pass/fail gate; run before a release or during performance work. | real VS Code | no: shares the VS Code lock with layer 3 and also holds the benchmark lock | as long as it takes |

## When what runs

- **While working** (everyone): layers 1-2, plus the layer-3 scenarios that cover what you changed. Run only what fails until it passes.
- **Before a merge:** layers 1-2 (as CI runs them: `CI=true node test/run.js unit engine`) and **the layer-3 scenarios
  you choose** for what you changed and what depends on it, about 10 minutes at most. Name each chosen scenario with a
  one-line reason in your report or PR, so a reviewer can see what was left out. For a fast real-editor smoke pass
  (~3-4 min covering every real-VS-Code boundary: `seeking`, `multiview-native`, `picture-size`, `ui`), run
  `node test/run.js vscode --smoke` (and pair with affected scenarios or `--changed`); keep the full layer-3 run for
  releases. `--changed` is only a hint: it selects by file name, and the core player files are in nearly every
  scenario, so it usually picks the whole layer.
- **Before a release:** everything, including layer 4 against the last release's numbers. Only a release must have
  everything working (maintainer, 2026-11-21): a side effect missed between releases is acceptable, the full run before
  the release catches it.

**Known dependencies** (the minimum when you touch these; add a line when a miss is found):

| You changed | Also run |
|---|---|
| Stepping, seeking, the decoder pool, end of file (`media/engine.js` seek paths, `media/pool.js`) | `seeking`, `playback` |
| Native ffmpeg transport or frame sizes (`src/native.js`, `src/frameserver.js`, `sizeFramesToView`) | `native`, `picture-size-native` |
| Drawn picture size, zoom, pan (`media/picture.js`, `media/inspect.js` geometry) | `picture-size`, `compare`, `inspect` |
| Compare / multi-view (`media/compare.js`, `src/compare.js`) | `compare`, `multiview` |
| Remote stream (`src/remotestream.js`) | `remote-stream` |
| URLs (`src/urlsource.js`) | `url`, `url-native` |
| The bar, panels, keys (`media/controls.js`, `src/bar.js`) | `ui` |
| The shared UI seam (`media/player-ui.js`, `media/player-state.js`) | `ui`, `compare`, `folder-rail` |
| Subtitles, tracks | `subtitles` |
| Folder rail, the bar's capsule, Autoplay, folder navigation (`src/folder-rail.js`, `media/folder-rail.js`, `media/autoplay.js`) | `folder-rail`, `ui`, `compare` |
- **GitHub Actions:** layers 1-2 on every push and pull request. Layer 3 stays local for now (needs a GPU).

## UI and gesture tests without video

The webview UI is split three ways (AGENTS.md, Rules): **pure state** (`media/player-state.js`), the **shared UI
seam** (`media/player-ui.js`), and the **engine and host** behind adapters (production: the decoders and
`vscode.postMessage`; tests and the mockup: `tools/mockup/fake-engine.js` and `tools/mockup/fake-host.js`).
`media/player.js` and `media/compare.js` call the seam's helpers for their keys, bar buttons, step buttons and
badges, A–B pins, time readout, Picture size button, Copy details, right-click menu, Folder Rail and the
Compare splitter and divider. The mockup (`tools/mockup/render.js`) mounts the same file through
`VpePlayerUi.create()`. So a UI or gesture path can be checked in Layer 1, in milliseconds, without decoding a
frame:

| What | Where it is proven | How long |
|---|---|---|
| Layout, capture, add / remove / enlarge / split / sync / offsets, tabs (pure transitions) | `test/host/player_state_test.js` | milliseconds |
| The shared key table and the player's and Compare's key parity, bar buttons, step size, A–B pin drag, time formats, Picture size, context-menu actions, Folder Rail round trip through FakeHost, Spotlight splitter and Split Wipe divider (pointer and keys), cell DOM reuse during playback ticks, double-click enlarge | `test/host/player_ui_test.js` (the real widgets on a small fake DOM, FakeEngine + FakeHost; about 0.1 s) | milliseconds |
| Script order of both pages (the seam loads before `player.js` / `compare.js`), CSP and nonces | `test/host/player_html_test.js`, `test/host/a11y_test.js` | milliseconds |
| Page code slices (`playback_prefs_test.js`, `player_ux_test.js`, `ctxmenu_test.js`) | Node `vm` over the real `player.js` source with `VpePlayerUi` in the context | milliseconds |

What stays in **Layer 3** (real VS Code on the hidden desktop): Chromium layout, focus and pointer capture,
WebGL and WebCodecs, the decoders and their clocks (frame-exact stepping, A–B playback, Compare sync across real
videos), fullscreen and Zen Mode, the real host messages over the webview boundary (file watching, the folder
listing, Remote-SSH and remote streaming), and anything a screenshot must show. Layer 3 confirms that the wiring
the Layer 1 tests prove also holds in a real webview; it does not need to repeat every key or gesture.

**New UI features from now on:**

1. Put the state transition in `media/player-state.js` and test it in `player_state_test.js`.
2. Put the wiring (key, button, menu item, gesture) in `media/player-ui.js` as a helper both pages call, or in
   `create()` for the unified page; add the key to `keyCommand` and a handler to each page's `KEY_ACTIONS` table.
3. Prove it in `test/host/player_ui_test.js`: the helper alone, then the gesture through `create()` over the
   real widgets (fire the click / key / pointer events on the fake DOM, assert the state and what FakeHost got).
4. Look at it in the mockup (`node tools/mockup/render.js`, `.claude/skills/ui-mockup/SKILL.md`).
5. Pick only the Layer 3 scenarios that cover the real-webview boundary of the change (usually `ui`, plus
   `compare` or `folder-rail` when those change), not the whole layer.

## Slow-link & remote UX invariants

When changing clocks, stepping, caching or streaming, verify the affected behavior under simulated
`slow-ssh` and `flaky-ssh` in Layer 1 or 2 with a virtual clock. A zero-latency local SSD run cannot
exercise RTT, bandwidth contention or blackouts. The Layer 1
[slow-link UX tests](../test/host/slow_link_ux_test.js) drive the production batcher and adaptation ladder over
virtual SSH links. They check tier changes over a virtual minute, the starting quality and stalls for a second
video, and seek delivery behind an outstanding batch. They also cover delayed first-frame delivery, coalesced
seeks and cancellation when a tab closes.

[Host wire and cleanup tests](../test/host/child_cleanup_test.js) exercise the 128 KiB video payload cap,
the 25 KiB JPEG thumbnail cap, and child-process teardown after tab disposal, overlapping seeks and URL
cancellation. [Engine contracts](../test/engine/unit.js) exercise fragmented packet assembly, playback phases,
clock monotonicity, A/V drift and frame ownership in Node.

## Rules

- The player lifecycle suite exercises webview-only reloads by booting two documents from the same HTML. It uses controlled promises for outstanding reads and early probes.

- A failure first runs alone; the full layer runs once when everything is believed fixed.
- A VS Code instance without WebGL2 is a broken instance, not a failed test: it is named and retried.
- A page error ends a wait at once; no test waits out a timeout after an error was reported.
- Flaky scenarios are fixed or quarantined (listed, skipped, tracked), never retried silently.
- Tests wait for the event or state they need; the deadline is a safety net sized from measured times, not a
  speed check (see "Time limits": tight enough that a hang shows in seconds to a minute, loose enough that a
  busy machine does not fail a good run).
- Generated test media must come out the same on every run and every ffmpeg version, or be checked after
  making it: ffmpeg 7+ runs its steps in threads, so how it interleaves streams can vary between runs
  (`test/bitmapsubs/make_media.js` forces time order and checks it).
- The engine runner prepares the shared track fixtures before starting parallel tests. The generator publishes
  each clip after ffmpeg succeeds and records the complete set. A missing stamp or a changed clip size causes
  regeneration.

## Time limits

A hang must show within seconds to a minute, not after minutes. Timeouts and stalls are counted apart from
failures (`TIMEOUT` / `STALLED` in the lines and the summary), and every message names the elapsed time and what
was waited for.

- **Layers 1-2** (`test/layers.js`): each file has an explicit `timeout`: max(20 s, 3 x its median time, 1.5 x
  its slowest passed run), from the history in `test/out/*.json`. A file that prints nothing for its `stall`
  limit (default 30 s) is killed and reported `STALLED: no output for N s after: <last line>`; past the timeout,
  `TIMEOUT after N s; last output: <last line>`. Both kill the process tree (Windows job object).
- **Layer 3** (`test/vscode/budgets.js`): each scenario has a time budget, about 2.5 x its typical time + 30 s
  (3.5 x for native, remote, URL, HDR and many-video scenarios; min 90 s). Past it the scenario ends and reports
  `TIMEOUT after N s in <scenario>/<case>; waiting for <thing>`. Waits: a hook answer 10 s, the extension
  activating 45 s, the first frame of an ordinary clip 15 s (4K, native, remote, URL and HDR keep their longer
  waits; the repeated-open `playback/resume/position` correctness case allows 30 s after an
  intermittent 15 s open timeout), other waits as the case sets them. A page error still ends a wait at once;
  an instance without WebGL2 is retried, not failed. `VPE_BUDGET_SCALE=2` doubles every budget on a slow machine.
- The limits are measured on the maintainer's desktop. On CI (`CI` set) every timeout, stall limit and budget is
  multiplied by 3: GitHub's Windows runners take 2-3x as long per file (4 files at once). `VPE_TIME_SCALE=<n>`
  sets the factor anywhere.
- **After a layer got slower or faster on purpose**, or a new test was added: `node test/tune_timeouts.js`
  rewrites the numbers from the recorded runs (a file with no history gets 60 s / 30 s stall until then).
  A test that fails only on a tight timeout in a normal run needs its number raised, not a retry.

## Commands

```
npm run verify:fast                  # static checks, also run by CI on Windows and Linux
node tools/arch-inputs.js            # on-demand Git history, typecheck coverage and file sizes
node test/run.js                     # layers 1-3 (npm test)
node test/run.js unit engine         # layers 1-2 (npm run test:unit, test:engine): what CI runs
node test/run.js vscode              # layer 3 (npm run test:vscode)
node test/run.js vscode --smoke      # fast-merge layer-3 preset (~3-4 min, every real-VS-Code boundary)
node test/run.js perf                # layer 4 (npm run test:perf)
node test/run.js unit engine vscode --changed     # only what covers the files changed against main
node test/run.js engine --grep frames_            # only matching files / scenarios
```

`verify:fast` runs typecheck, dependency rules (including the webview boundary), Knip, source syntax checks, and the personal-data
and Markdown link checks. The development tools require Node 20.19+ on the Node 20 line.
Dependency rules cover statically resolvable imports. Knip reports on `src/` and reads test imports
so test-only consumers count. Its CommonJS analysis can miss unused members in shorthand
`module.exports` objects when it ignores exports referenced in their own file. Review reported
exports against namespace and lazy consumers before removing them.

- **Layers 1-2** (`test/layers.js`): every file in its own process (a Windows job object kills its children
  on timeout), as many at once as there are logical CPUs, one line per file, the output of failed files, one
  summary; JSON in `test/out/<layer>-<time>.json`. `--changed` picks the files whose sources (named in
  `test/layers.js`, else read from the test file) contain a changed file; a changed `src/` or `media/` file
  that no test names runs the whole layer.
- **Layer 3** (`test/vscode/scenarios.js`, `test/vscode/README.md`): the scenarios of
  `test/vscode/scenario_list.js`; `--changed` picks them by `test/vscode/scenario_map.js`, and `--smoke` runs
  the fast-merge preset (`SMOKE` in `test/vscode/scenario_map.js`; `--smoke --explain` prints what it picks
  without starting VS Code).
- **Layer 4** (`test/perf/run.js`): benches of `test/perf/benches.js`, compared with `test/perf/results/`.
- Run layers 3 and 4 through `test/run.js`. They share `vpe-vscode-lock` in the system temp directory
  across worktrees. A waiting runner prints the holder and starts after it releases the lock.
- CI (`.github/workflows/ci.yml`) and the Publish workflow run `node test/run.js unit engine`.
- Slow or flaky SSH link in a local window: `VPE_SIMULATE_LINK=slow-ssh` (and `VPE_SIMULATE_REMOTE`), see
  [docs/notes/link-simulator.md](notes/link-simulator.md). Layers 1-2 use `src/link-sim.js` with `test/lib/virtual-clock.js`.
- Change base for `--changed`: `VPE_BASE` (default `main`). VS Code: `VPE_CODE` or the portable build of
  `node test/vscode/get_code.js`.

## Synthetic reliability fixtures

Run `node test/media/make_heavy_media.js --quick` to make a roughly 100 MiB, ten-minute MP4
alongside small VFR, ten-second GOP, multi-track MKV and malformed MP4 fixtures. Omit
`--quick` for the default 3072 MiB target or choose a target with `--size-mb <MiB>`.
The generator uses FFmpeg with libx264. It builds missing files in the ignored
`test/media/.heavy/` cache or in the directory supplied with `--out <dir>`.
Files are published after generation succeeds and reused on later runs. Delete a
cached file to regenerate it.

Layers 1 and 2 include the deterministic chaos tests. Use
`node test/run.js unit engine --grep chaos --verbose` to run them alone. Set
`VPE_FUZZ_SEED` to change or reproduce the action sequence. The host checks kill real
FFmpeg children after native decode, Live transcode or clip export has started, then
check recovery and resource cleanup. The engine tests drive the WASM player with
FFmpeg presentation timestamps and reference pictures.

Set `VPE_HEAVY_MEDIA=1` for the engine run to add multi-GiB seeks. This creates the
default large fixture if missing, requires several GiB of free disk space, and checks
that seeks reach file offsets above 2 GiB while keeping decoded frames and input
reads bounded. CI uses only the small fixtures.

## Playback and seeking coverage

Layer 2's `formats_cases.js` covers the playback format matrix. For the WASM formats covered only there,
it checks the first picture, an advancing playback picture and a seek against ffmpeg, and requires decoded
audio. The `frames_*.js` suites cover WASM seek and step sequences, rounded timestamps and the last picture
when audio outlasts video. `frames_webcodecs_error.js` drives the WebCodecs path of the engine and the real
decoder worker with a stand-in `VideoDecoder` (Node has none) that fails as Chromium's does on a damaged
picture: playback goes on at the next keyframe, the sound stays whole, and the third error falls back to the
built-in decoder.

Layer 3's `playback` exercises H.264 and VP8 WebCodecs, device-dependent High 10 and 4:4:4 H.264 decoding,
odd-sized WebGL textures, WebCodecs video with AC-3 sound, video without audio and variable frame rates.
It also checks audio-only playback, rate changes, neighbour navigation, rotation, the fully decoded status, saved positions,
damaged and truncated files, and multichannel WebAudio. The separate `open-formats` scenario checks host
routing and playback across containers in the webview.

Layer 3's `seeking` keeps the exact-picture checks for H.264 WebCodecs and the MJPEG frame player, plus
HEVC seeking and stepping across a GOP on the real WebGL canvas. It also checks open-GOP fallback,
rounded H.264 timestamps, the End and Home keys, VP8 decoder flush and A-B loop controls.

## The layers as built

Measured 2026-11-20 on the i7-9700K / RTX 4070 desktop **while a game was running** (other processes at
20-40 % CPU, the GPU busy): the times are upper bounds, and the parallel question is still open (below).

| Layer | What runs | Result | Wall time |
|---|---|---|---|
| 1. Unit | 65 files (`test/host`, `test/unit`, engine / inspect / subtitles / timestretch / AVI logic), 8 at a time | 65 passed | 28 s |
| 2. Engine | 13 files: `test/engine` frame and format tests (the seeking checks of the WebAssembly path, every format of the test media), tracks, engine smoke, picture subtitles, X-ray index, pool, thumbnails | 13 passed | 74 s |
| 3. VS Code | 21 scenarios, 225 results, 3 instances at once | 223 passed; the 2 failures (sampling speed, fixed) passed when run again; 2 instances without WebGL2, both passed in a fresh one | 12.7 min (33 min of scenarios) |
| 4. Performance | 30 benches (27 VS Code, 3 Node; 4 more with `VPE_TRANSFER_CLIPS`; `--list`) | built and tried (2 benches, not saved); no stored numbers yet | as long as it takes |

Layers 1-3 together took about 14.5 minutes, over the 10-minute target. With layer 3 serial (the default
until the parallel question is settled) layer 3 alone is about 33 minutes. The longest scenarios are seeking,
playback and open-formats (2.5-3 min each, the slowest instance sets the pace with 3 at once).

**Parallel instances (layer 3):** in the full run with 3 instances, 2 of 21 scenarios started in an instance
whose pages got no WebGL2; a single instance lost WebGL2 the same day too, and the game was using the GPU, so
the cause is not settled. Following the rule above (parallel only after a full run without WebGL2 losses), the
default is serial; `--parallel 3` (or `VPE_PARALLEL=3`) runs three.
**Settled 2026-11-21: serial stays the default.** A full `--parallel 3` run (25 scenarios) lost WebGL2 in 3
instances (`playback` and `scopes-export` twice in a row, `file-icons` once); run serially, those scenarios passed
42/42, and a full serial run passed 246/246 in about 33 minutes. `--parallel 3` remains available but is not trusted.

## Known issues (quarantined)

Listed here, reported as KNOWN by the test (not failing it), and removed when the test reports that it passes.

- `test/engine/chaos.js` checks exact backward adjacency after stepping forward into
  the dense VFR segment. The nominal-rate back cache lookup can skip a 60 fps picture.
  The fuzz test still checks monotonic direction and picture identity against FFmpeg.

Inventory of every test before the layers and where it lives now: [docs/notes/test-inventory.md](notes/test-inventory.md).
