# Test and playback findings, November 2026

A record of what the 0.13.1 / 0.13.2 work found about the tests, the playback code and how we work, so the
leftovers can be checked later. The plan that acts on it is [playback-core-plan.md](playback-core-plan.md).
Status per item: **fixed** (with commit), **open**, or **plan** (covered by a step of the plan).

## 1. How the tests stood (2026-11-28)

| Layer | Size | Where |
|---|---|---|
| 1. Unit | ~145 files, ~1 min | local + CI |
| 2. Engine | 19 files, ~1.5 min | local + CI |
| 3. VS Code | 34 scenarios, 70 case steps, 301 checks, 42 min serial | local only, by hand |
| 4. Performance | ~1 h | local only, before releases |

Layer 3 grew from 225 checks in 21 scenarios (2026-11-20) to 301 in 34. In the 105 saved layer-3 runs, 164 of
338 result names failed at least once.

### What works

- Layer 2 runs the real WebAssembly decoders in Node and compares every frame with ffmpeg: deterministic,
  parallel, fast.
- Layer 3 checks the picture itself (normalised cross-correlation against ffmpeg's frame), not only a counter.
- docs/TESTING.md has the right rules (wait for events, deadlines from measured times, quarantine flaky tests,
  test behaviour not internals, red before green).
- Timeouts are reported apart from failures; a page error ends a wait; an instance without WebGL2 is retried;
  layer 1-2 timeouts are tuned from history.
- Pinned VS Code (1.147), hidden desktop, the mockup harness with a fake engine and host.

### What does not (and status)

| # | Finding | Evidence | Status |
|---|---|---|---|
| T1 | Breakage is found only at release time: the full layer 3 runs before releases only. | Native multi-tile cases failed from 2026-11-26, loop-rest from the evening of 2026-11-26; found 2026-11-28. | plan (nightly / background run) |
| T2 | CI runs after the push to `main` and nobody watched it: it was red for a day. | 21:38 on 2026-11-27 to 13:14 on 2026-11-28. | process: check CI after every push (no branch protection, maintainer 2026-11-28) |
| T3 | Layer 3 does layer 2's work: engine, sync and timing logic tested through real VS Code. | Plan inventory: 104 checks MOVE-DOWN, 93 DUPLICATE of 293. | plan |
| T4 | Timing in tests: ~200 fixed `sleep(` calls (median 0.7 s, up to 15 s), ~520 timeout literals, some of them speed checks ("4 s waiting for a step while resting", "30 s for metrics"). Contradicts "layer 3 never checks speed". | test/vscode/cases | plan (S0, S11) |
| T5 | Tests decide by log text: 26 case files read `vs.lines` / `waitLog`. A changed message breaks the test; a broken product with the old message passes. | e.g. multiview-native "decisions: none" (log line came 0.8 s later than read). | plan (probe state only) |
| T6 | Not hermetic: layer 3 shares the desktop with other work and agents; ffmpeg on PATH changes (9.0.2 now); clips in the temp folder. Two failures on 2026-11-28 came from parallel unit tests. | | plan (pinned LGPL ffmpeg, fixed media folder, load guard via test/loadmon.js) |
| T7 | One check cannot run alone: `--grep` selects whole scenarios and runs all steps (test/vscode/scenarios.js:212); `--sub` only hides results. docs/TESTING.md and AGENTS.md promise otherwise. | Rerunning compare/offset-3 ran 35 checks. | plan (S0) — docs stale until then |
| T8 | Flaky tests are not tracked: TESTING.md lists one quarantined test while time/formats and compare offset-3 flipped for days. The history to detect flakes exists (test/vscode/out/scenarios-*.json, field `tests`) but nothing reads it. | | plan (S0) |
| T9 | Parallel layer 3 loses WebGL2 (decided serial 2026-11-21), so runs are slow, so they are run less. | | plan (thin layer 3 meets 10 min serially) |
| T10 | High churn: 165 of 726 commits in two weeks touched layer-3 test code. | git log since 2026-11-14 | plan |
| T11 | Layer-2 step and A-B tests drive paths production does not use: the harness calls the engine's own `stepFrame` (test/engine/harness.js:195); A-B wrap is a test-local driver (test/engine/journeys.js:91-121) while production wraps in media/player-ui.js. | Second-opinion review of the plan. | plan (S1) |
| T12 | WebCodecs is invisible below layer 3 (Node has no WebCodecs); H.264 in Annex-B containers (AVI, TS, M2TS, MTS) uses a different decoder config. | media/codec-utils.js | plan (keep a container sweep in thin layer 3) |
| T13 | Layer 4's process sampler misses short ffmpeg processes; preview-pass CPU had to come from `-benchmark`. | seek-pass benches | open |

## 2. Playback code

| # | Finding | Status |
|---|---|---|
| P1 | media/player-unified.js (3,017 lines) is meant as glue but holds the playback brain on requestAnimationFrame (tick, pump, reconcile, seekTo, held seeks, follower sync, holdLagging, restartAtEnd) plus audio choice, subtitles, tracks, exact grab, metrics and the debug probe. | plan |
| P2 | media/engine.js (3,369 lines) decides seek, step and landing itself as well; 57 direct timer / clock calls; no injectable clock. | plan |
| P3 | The same rule exists several times: 4 frame-numbering rules, 3 restart-at-end sites, 3 seek coalescers (two never called), 3 definitions of "settled"; the engine's A-B branch in `tick` is dead. | plan (Q2, Q8) |
| P4 | Playback decisions leak into media/player-ui.js: auto-pause, resume, Autoplay next, A-B wrap (`decoderFrame` → `restartAt`). | plan |
| P5 | The host has a second seek planner (src/stream.js, src/native.js: warm decoder, skipHeld, fill, quick/sharp pictures, restart on size change), where several recent fixes landed. | plan (S2b) |
| P6 | media/player-state.js already holds the user's intent (playing, frame, offsets, clock, sound); a core must not copy it. | plan (section 2.0) |
| P7 | Most defects found on 2026-11-28 came from the unified viewer (849a955, 2026-11-26), which dropped behaviour of the old player and Compare page. | fixed (section 3) |

## 3. Defects found and fixed (2026-11-27 / 28)

| Defect | Kind | Fix |
|---|---|---|
| Setup-guide test stubbed `hardware.detectMachine`, which the code never calls (it calls `hardware.detect`): passed only on a PC with a recent NVIDIA driver; CI red from the FFmpeg-setup cherry-pick on. | test | a088def |
| Seek-bar previews: worker replies no request waited for (stale, or after dispose) kept their ImageBitmaps open (GPU memory); Linux CI hit it every run. | product | 2568ff0 |
| Compare, 5+ native videos: tiles past six waited 3 s and fell back to postMessage (6 HTTP streams per origin); WebSockets rule lost in 849a955. | product | 13bb1a8 |
| Compare, many videos: one WebGL context per tile; 16 tiles used the webview's whole budget, a 17th context blanks a tile. Now first 4 own contexts, the rest share one. | product | f8c3e37 |
| Paused seek in files with a timestamp jump landed one picture early, so stepping forward repeated a picture forever. | product | 491c7ed |
| Time label stayed one frame behind the picture after pausing (bar ignored decoder frames while the paused read-ahead loaded). | product | 5b21f95 |
| File watcher took its baseline mtime from its own async check: a file rewritten before that was never reloaded (the "reloaded under a new id" CI flake). | product | 2e9cb0e |
| multiview-native read decoder lines before they were logged; multiview-large added one clip 10 times (Add skips duplicates) and checked a removed canvas; large-native computed expected frames from a half-frame-off start; compare offset-3 seeked before the page hook existed; open-formats seeked to the frame already shown. | test | 92ebd9b, 7aaeddd, 1c825d7, 6f6c1dd |
| Native preview cost guess counted the sent picture's pixels, not the source's (about half the real cost). | product | 9cc78fb |
| Frame steps while a paused seek decodes restarted every repeat; a held target was undone by the opening seek landing. | product | (2026-11-27 frame-step work) |

The 0.13.2 branch (hidden export losing a frame, stepping in files with gaps of two slots or more, and a
scrub-back regression it found in its own change) is recorded in CHANGELOG 0.13.2.

## 4. How we work

| # | Finding | Status |
|---|---|---|
| W1 | 0.13.1 was merged (= published) with layer-3 failures not yet rechecked; all turned out pre-existing or load, but that was luck. Rule: no release merge with an unexplained failure. | process |
| W2 | A delegated agent finished but a leftover background monitor kept it "busy", so its result sat unnoticed for about 10 minutes. Check a quiet delegate's thread instead of only waiting. | process |
| W3 | Delegated worktrees start from the parent checkout's HEAD, not `origin/main`; briefs must say `git fetch origin && git checkout -B <branch> origin/main`. A cherry-pick of a branch that duplicated an existing command registration broke activation once; the unit mock now throws on duplicate registrations. | process / fixed |
| W4 | Layer 3 must not run while other heavy work runs on the machine; parallel unit tests caused two false failures. | plan (load guard) |
| W5 | A worktree with a junction to test/vscode/.code: remove the junction (`rmdir`) before deleting the worktree, never delete through it. | process |
| W6 | Writing files with Python on Windows in text mode produces CRLF; .gitattributes normalises commits, but rewrite the working copy afterwards. | process |

## 5. Open leftovers to check later

- Real-hardware failure of the WebCodecs preview decoder and VP8 previews in real VS Code: covered only by the
  stand-in decoder (test/thumbs/hw_sweep.js).
- Seek-preview pass-cost table: the native-software and WASM rows were measured with keyframes at a quarter of
  the time; re-run after the half-time change (docs/notes/seek-preview.md).
- GPU preview decoding on Linux (vaapi, cuda) and macOS (videotoolbox), other GPUs than one RTX 4070: unmeasured.
- Seek previews and the preview pass over a real Remote-SSH link and with Live transcode: host tests only.
- `seek_preview` `wasm/refine` timed out once; not reproduced.
- Layer 4 was not run for 0.13.1.
- Files read by the WASM worker over Remote-SSH get no background preview pass (bandwidth), by design.
- docs/TESTING.md "re-run only that case (`--grep "^scenario/case$"`)" is not true until the runner change (T7).
