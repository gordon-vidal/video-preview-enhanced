# Testing strategy (2026-11-20)

Four layers, each with one job. Lower layers carry the detail; real VS Code proves what a user sees.

| Layer | What it checks | Runs in | Parallel | Target time |
|---|---|---|---|---|
| 1. Unit | Pure logic: decoder choice, playlist/manifest parsing, time and frame math, settings, caches. Logic lives in small modules (not inside `player-unified.js` / `engine.js`) so it can be tested alone. | Node | yes (all cores) | seconds |
| 2. Engine | The WebAssembly decoders in Node, no browser: frame-exact seeking, stepping, end of file, A-B loop, every format. Engine correctness may be proven here (2026-11-20). | Node | yes (all cores) | about a minute |
| 3. VS Code | 20-30 user scenarios in real VS Code on a hidden desktop (GPU decoding, WebGL, panels, icons, native ffmpeg, URLs, compare). Each scenario checks many things in one instance. Scenarios check correctness only, never speed, so load can't fail them. | real VS Code | 2-3 instances if WebGL2 stays stable (serial for now: see below) | minutes |
| 4. Performance | CPU, memory, start-up and frame rates, compared with the previous numbers. Not a pass/fail gate; run before a release or during performance work. | real VS Code | no: shares the VS Code lock with layer 3 and also holds the benchmark lock | as long as it takes |

## When what runs

- **While working** (everyone): layers 1-2, plus the layer-3 scenarios that cover what you changed. Run only what fails until it passes.
- **Before a merge:** layers 1-2 (as CI runs them: `CI=true node test/run.js unit engine`) and **1–3 targeted
  layer-3 scenarios** (or specific `--grep "^scenario/case$"`) covering the exact behavior you changed — aim for
  **~5 minutes** on small fixes and **10 minutes at most** on larger changes. Name each chosen scenario with a
  one-line reason in your report or PR, so a reviewer can see what was left out. When a single layer-3 case fails,
  re-run **only that case** (`--grep "^scenario/case$"`), not the whole scenario, and avoid running layer 3 while
  parallel delegates are pegging CPU. For a fast real-editor smoke pass (~3-4 min covering every real-VS-Code
  boundary: `seeking`, `multiview-native`, `picture-size`, `ui`), run `node test/run.js vscode --smoke`; keep the
  full layer-3 run for releases. `--changed` is only a hint: it selects by file name, and the core player files
  are in nearly every scenario, so it usually picks the whole layer.
- **Before a release:** everything, including layer 4 against the last release's numbers. Only a release must have
  everything working (maintainer, 2026-11-21): a side effect missed between releases is acceptable, the full run before
  the release catches it.

**Known dependencies** (guide for picking 1–3 relevant scenarios when you touch these — not a mandatory floor; add a line when a miss is found):

| You changed | Also run |
|---|---|
| Stepping, seeking, the decoder pool, end of file (`media/engine.js` seek paths, `media/pool.js`) | `seeking`, `playback` |
| Native ffmpeg transport or frame sizes (`src/native.js`, `src/frameserver.js`, `sizeFramesToView`) | `native`, `picture-size-native` |
| Drawn picture size, zoom, pan (`media/picture.js`, `media/inspect.js` geometry) | `picture-size`, `compare`, `inspect` |
| The viewer's host and Compare commands (`src/unified-viewer.js`, `src/unified-session.js`, `src/unified-sources.js`, `src/extension.js`) | `compare`, `multiview`, `ui` |
| Remote stream (`src/remotestream.js`) | `remote-stream` |
| URLs (`src/urlsource.js`) | `url`, `url-native` |
| The bar, panels, keys (`media/controls.js`, `src/bar.js`) | `ui` |
| The UI controller and state (`media/player-ui.js` and its modules, `media/player-state.js`, `media/player-unified.js`) | `ui`, `compare`, `folder-rail` |
| Subtitles, tracks | `subtitles` |
| Folder rail, the bar's capsule, Autoplay, folder navigation (`src/folder-rail.js`, `media/folder-rail.js`, `media/autoplay.js`) | `folder-rail`, `ui`, `compare` |
- **GitHub Actions:** layers 1-2 on every push and pull request. Layer 3 stays local for now (needs a GPU).

## Test design and red-green-refactor

### Red → green → refactor
- **Bug fix (red → green, required):**
  1. Write a minimal test at the lowest layer that faithfully reproduces the failure.
  2. Run it (`node test/run.js <layer> --grep <re>`) against the unfixed code and verify it fails
     for the actual bug (if you already edited code, briefly stash/revert the fix to prove it fails).
  3. Implement the fix and re-run to confirm green.
  4. Mention the red → green verification in the PR / handoff.
- **Refactor (green → refactor → green):**
  1. Lock in the current contract with public-boundary tests before moving or rewriting internals.
  2. Refactor freely without editing those tests. If a boundary test breaks during a pure refactor,
     either behavior regressed or the test was coupled to internals.
- **New features:** red → green is optional — use it when it helps clarify the contract.
- **Deleting or updating existing tests:** never delete or loosen a failing test just to make a
  run pass. Only update a test when the product contract itself intentionally changed; pure
  **change-detector tests** *should* be removed or replaced once their observable behavior is
  covered at the public boundary (say why in the commit / handoff).

### Test public behavior, not implementation details
- **Target public seams only:** exported module functions, `player-state.js` transitions,
  `player-ui.js` DOM/a11y interactions + host messages, `extension.js` commands/events over
  `mock_vscode.js`, or real VS Code in Layer 3.
- **No change-detector tests:** do not export private helpers solely for tests, inspect private
  fields/caches, or assert that internal helpers were called N times in a specific order. A clean
  internal rewrite should leave tests untouched.
- **Mock only external boundaries:** fake VS Code APIs, clocks/timers, filesystem, or network/links
  — not internal sibling modules of the unit under test.
- **Litmus test:** *"If I rewrite the internals of this module cleanly without changing what callers
  or users observe, does this test still pass?"* If not, test one level higher at the public seam.

## UI and gesture tests without video

The webview UI is split three ways (AGENTS.md, Rules): **pure state** (`media/player-state.js`), the **shared UI
seam** (`media/player-ui.js`), and the **engine and host** behind adapters (production: the decoders and
`vscode.postMessage`; tests and the mockup: `tools/mockup/fake-engine.js` and `tools/mockup/fake-host.js`). CI
holds the boundary: `.dependency-cruiser.cjs` (`npm run verify:fast`) forbids `player-state.js` any import and
`player-ui.js` any import of `src/`, Node built-ins or the decoder modules (`engine.js`, `frame-player.js`,
`gl-renderer.js`, `compare-compositor.js`, `decoder-*`, `libav-vpe/`), and `test/host/player_ui_test.js`
("Boundary contract") fails if either file names a DOM, VS Code or decoder global it must not use.

### Four parts

| Part | What | Where | Speed |
|---|---|---|---|
| **1A** Pure state | Layout, capture, add / remove / enlarge / split (0–100 %) / sync / offsets, tabs | `test/host/player_state_test.js` | milliseconds |
| **1B** UI controller | The shared helpers alone, then `create()` over the real widgets on a **strict** fake DOM of the real markup (`src/bar.js`, `src/folder-rail-html.js`; `test/host/fake-dom.js`: unknown ids are `null`, `closest()` and bubbling are real), FakeEngine + FakeHost; the controller modules (`media/player-ui-tiles.js`, `-input.js`, `-tools.js`, `-lifecycle.js`) on the same fake DOM | `test/host/player_ui_test.js`, `player_ui_tiles_test.js`, `player_ui_input_test.js`, `player_ui_tools_test.js`, `player_ui_lifecycle_test.js` | seconds |
| **1C** Adapter contracts | One EngineAdapter / HostAdapter contract suite run against the mockup fakes (`tools/mockup/fake-engine.js`, `fake-host.js`) and the production adapters (`media/player-engine-adapter.js`, `media/player-host-adapter.js`), plus production-only behaviour | `test/host/adapter_contract_test.js`, `test/host/production_adapters_test.js` | under a second |
| **2** Engine contract | Decoders, seeking, clocks, the frame stream, without the UI | `test/engine/` | seconds |
| **3a** Webview UI / gestures | Real Chromium DOM: layout, focus, pointer capture, letterboxed picture rects, event bubbling in the real page | `ui`, `compare`, `folder-rail` scenarios | about a minute each |
| **3b** Real-clip integration | Frame accuracy, decoder clocks, Compare sync across real videos, the decoders, real host messages (files, folder listing, Remote-SSH) | `playback`, `seeking`, `multiview`, `remote-stream`, ... | minutes |

Layer 3a still opens real clips today (there is no fake-media webview yet); it is listed apart because what it
must prove is the real-webview half of a gesture, not decoding.

### What runs in production

The viewer's page (`media/player-unified.js` in `src/unified-html.js`) mounts `create()` over the production adapters
(`media/player-engine-adapter.js`, `media/player-host-adapter.js`) for one video and for several, so a 1B test of
`create()` over the fakes tests the code that ships; 1C holds the fakes and the production adapters to the same
contract. What only a real webview shows (layout, focus, pointer capture, letterboxed picture rects, decoding) is
layer 3.

**New UI features from now on:**

1. Put the state transition in `media/player-state.js` and test it in `player_state_test.js`.
2. Put the wiring (key, button, menu item, gesture) in `media/player-ui.js` (`create()` or one of its modules);
   add a key to `keyCommand` and its action to `create()`.
3. Prove it in `test/host/player_ui_test.js`: the helper alone, then the gesture through `create()` over the
   real widgets (fire the click / key / pointer events on the fake DOM, assert the state and what FakeHost got).
   A control the fixture lacks is `null`: add it to the real markup, not to the test.
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
