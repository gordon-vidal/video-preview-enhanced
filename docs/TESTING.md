# Testing strategy (2026-11-20)

Four layers, each with one job. Lower layers carry the detail; real VS Code proves what a user sees.

| Layer | What it checks | Runs in | Parallel | Target time |
|---|---|---|---|---|
| 1. Unit | Pure logic: decoder choice, playlist/manifest parsing, time and frame math, settings, caches. Logic lives in small modules (not inside `player.js` / `engine.js`) so it can be tested alone. | Node | yes (all cores) | seconds |
| 2. Engine | The WebAssembly decoders in Node, no browser: frame-exact seeking, stepping, end of file, A-B loop, every format. Engine correctness may be proven here (2026-11-20). | Node | yes (all cores) | about a minute |
| 3. VS Code | 20-30 user scenarios in real VS Code on a hidden desktop (GPU decoding, WebGL, panels, icons, native ffmpeg, URLs, compare). Each scenario checks many things in one instance. Scenarios check correctness only, never speed, so load can't fail them. | real VS Code | 2-3 instances if WebGL2 stays stable (serial for now: see below) | minutes |
| 4. Performance | CPU, memory, start-up and frame rates, compared with the previous numbers. Not a pass/fail gate; run before a release or during performance work. | real VS Code | **no: the only layer with a lock** | as long as it takes |

## When what runs

- **While working** (everyone): layers 1-2, plus the layer-3 scenarios that cover the changed files. Run only what fails until it passes.
- **Before a merge:** layers 1-3, **at most about 10 minutes**.
- **Before a release:** everything, including layer 4 against the last release's numbers.
- **GitHub Actions:** layers 1-2 on every push and pull request. Layer 3 stays local for now (needs a GPU).

## Rules

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
  waits), other waits as the case sets them. A page error still ends a wait at once; an instance without WebGL2 is
  retried, not failed. `VPE_BUDGET_SCALE=2` doubles every budget on a slow machine.
- **After a layer got slower or faster on purpose**, or a new test was added: `node test/tune_timeouts.js`
  rewrites the numbers from the recorded runs (a file with no history gets 60 s / 30 s stall until then).
  A test that fails only on a tight timeout in a normal run needs its number raised, not a retry.

## Commands

```
node test/run.js                     # layers 1-3 (npm test)
node test/run.js unit engine         # layers 1-2 (npm run test:unit, test:engine): what CI runs
node test/run.js vscode              # layer 3 (npm run test:vscode)
node test/run.js perf                # layer 4 (npm run test:perf)
node test/run.js unit engine vscode --changed     # only what covers the files changed against main
node test/run.js engine --grep frames_            # only matching files / scenarios
```

- **Layers 1-2** (`test/layers.js`): every file in its own process (a Windows job object kills its children
  on timeout), as many at once as there are logical CPUs, one line per file, the output of failed files, one
  summary; JSON in `test/out/<layer>-<time>.json`. `--changed` picks the files whose sources (named in
  `test/layers.js`, else read from the test file) contain a changed file; a changed `src/` or `media/` file
  that no test names runs the whole layer.
- **Layer 3** (`test/vscode/scenarios.js`, `test/vscode/README.md`): the scenarios of
  `test/vscode/scenario_list.js`; `--changed` picks them by `test/vscode/scenario_map.js`.
- **Layer 4** (`test/perf/run.js`): benches of `test/perf/benches.js`, compared with `test/perf/results/`.
- CI (`.github/workflows/ci.yml`) and the Publish workflow run `node test/run.js unit engine`.
- Change base for `--changed`: `VPE_BASE` (default `main`). VS Code: `VPE_CODE` or the portable build of
  `node test/vscode/get_code.js`.

## The layers as built

Measured 2026-11-20 on the i7-9700K / RTX 4070 desktop **while a game was running** (other processes at
20-40 % CPU, the GPU busy): the times are upper bounds, and the parallel question is still open (below).

| Layer | What runs | Result | Wall time |
|---|---|---|---|
| 1. Unit | 65 files (`test/host`, `test/unit`, engine / inspect / subtitles / timestretch / AVI logic), 8 at a time | 65 passed | 28 s |
| 2. Engine | 13 files: `test/engine` frame and format tests (the seeking checks of the WebAssembly path, every format of the test media), tracks, engine smoke, picture subtitles, X-ray index, pool, thumbnails | 13 passed | 74 s |
| 3. VS Code | 21 scenarios, 225 results, 3 instances at once | 223 passed; the 2 failures (sampling speed, fixed) passed when run again; 2 instances without WebGL2, both passed in a fresh one | 12.7 min (33 min of scenarios) |
| 4. Performance | 29 benches (26 VS Code, 3 Node; 4 more with `VPE_TRANSFER_CLIPS`; `--list`) | built and tried (2 benches, not saved); no stored numbers yet | as long as it takes |

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

None at the moment.

Inventory of every test before the layers and where it lives now: [docs/notes/test-inventory.md](notes/test-inventory.md).
