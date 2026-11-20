---
name: run-tests
description: Choose and run the right test layer for a change in Video Preview Enhanced (host/engine Node tests, hidden-desktop real VS Code scenarios, performance). Use when verifying a change, before a PR or merge, or when a test fails.
---

# Run the right tests

Source of truth: `docs/TESTING.md` (layers, timing) and `test/vscode/README.md` (scenario runner).
Read them if a command below fails; if they disagree with this file, they win and this file needs fixing.

## 1. Pick by what changed

| Changed | Run |
|---|---|
| `src/*.js` pure logic (decide, probe, sequence, urlsource ...) | the matching `node test/host/<name>_test.js`, then `node test/run.js unit engine` |
| `media/*.js` logic (engine, subtitles, timestretch, inspect, hdr ...) | `node test/run.js unit engine --changed` |
| Decoder behaviour, seeking, formats | `node test/run.js engine` plus scenario `seeking` / `playback` |
| Player UI, panels, compare, scopes | the scenario(s) that cover the file, see the table in `test/vscode/README.md` |
| Anything user-visible before a merge | layers 1-3 (about 10 minutes) |

## 2. Commands

```
node test/run.js unit engine                     # layers 1-2 (what CI runs), all cores
node test/run.js unit engine --changed           # only what the changed files need
node test/host/<name>_test.js                    # one failing host test
node test/vscode/get_code.js                     # once: pinned portable VS Code into test/vscode/.code
node test/run.js vscode --changed                # layer 3 scenarios for the changed files
node test/run.js vscode --grep seeking           # one scenario; see test/vscode/README.md
npm test                                         # layers 1-3, before a merge
node test/run.js perf                            # layer 4 only: holds the lock, run alone
```

## 3. Workflow

1. Run the one failing test until it passes. Run the full layer **once**, at the end.
2. Layer 3 is Windows only and runs on a hidden desktop. Never start VS Code or a browser visibly.
   Where there is no GPU or desktop (CI, Linux), do not run it: say so in the PR instead.
3. Test videos are Git LFS: if a test fails on a tiny "pointer" file, run `git lfs pull`.
4. A "WebGL2 is not available" instance is broken, not a failed test: the runner retries it and marks
   `retried`. Do not paper over real failures with retries; report flaky scenarios.
5. Report what ran and what did not (layer, counts, failures) in the PR.

## Pitfalls

- `avi_scan_test.js` is skipped by the runner (needs input files); that is expected.
- Layer 4 numbers are only comparable through `test/benchq.js`; never run it alongside layer 3.
- New scenario: add `test/vscode/cases/<name>.js` (shape in `test/vscode/README.md`); keep it
  correctness-only, never speed.
