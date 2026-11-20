# Testing strategy (2026-11-20)

Four layers, each with one job. Lower layers carry the detail; real VS Code proves what a user sees.

| Layer | What it checks | Runs in | Parallel | Target time |
|---|---|---|---|---|
| 1. Unit | Pure logic: decoder choice, playlist/manifest parsing, time and frame math, settings, caches. Logic lives in small modules (not inside `player.js` / `engine.js`) so it can be tested alone. | Node | yes (all cores) | seconds |
| 2. Engine | The WebAssembly decoders in Node, no browser: frame-exact seeking, stepping, end of file, A-B loop, every format. Engine correctness may be proven here (2026-11-20). | Node | yes (all cores) | about a minute |
| 3. VS Code | 20-30 user scenarios in real VS Code on a hidden desktop (GPU decoding, WebGL, panels, icons, native ffmpeg, URLs, compare). Each scenario checks many things in one instance. Scenarios check correctness only, never speed, so load can't fail them. | real VS Code | yes (2-3 instances, if WebGL2 stays stable) | minutes |
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
