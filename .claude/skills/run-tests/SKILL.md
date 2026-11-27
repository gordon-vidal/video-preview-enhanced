---
name: run-tests
description: Choose and run the right test layer for a change in Video Preview Enhanced (host/engine Node tests, hidden-desktop real VS Code scenarios, performance). Use when verifying a change, before a PR or merge, or when a test fails.
metadata:
  internal: true
---

# Run the right tests

Source of truth: `docs/TESTING.md` (layers, timing) and `test/vscode/README.md` (scenario runner).
Read them if a command below fails; if they disagree with this file, they win and this file needs fixing.

## 1. Pick by what changed

| Changed | Run |
|---|---|
| `src/*.js` pure logic (decide, probe, sequence, urlsource ...) | `node test/run.js unit --grep <name>`, then `node test/run.js unit engine` |
| `media/*.js` logic (engine, subtitles, timestretch, inspect, hdr ...) | `node test/run.js unit engine --changed` |
| Decoder behaviour, seeking, formats | `node test/run.js engine` plus scenario `seeking` / `playback` |
| Player UI, panels, compare, scopes | the scenario(s) that cover the file, see the table in `test/vscode/README.md` |
| `test/host/*_test.js` (test-only) | `node test/run.js unit --grep <name>` + `npm run verify:fast` |
| Anything user-visible before a merge | layers 1-3 (about 10 minutes) |

## 2. Commands

```
node test/run.js unit engine                     # layers 1-2 (what CI runs), all cores
node test/run.js unit engine --changed           # only what the changed files need
node test/run.js unit --grep <name>              # one failing host test (guarded with timeout + stall kill; never run bare `node test/host/...`)
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

## 4. Test design & red → green → refactor

Source of truth: `docs/TESTING.md#test-design-and-red-green-refactor`.

- **Fix with the smallest run:** While fixing, run only the failing test through `node test/run.js <layer> --grep <re>` (never bare `node test/host/<file>.js`, which bypasses the runner's timeout and stall kill); run the full layer once at the end. Do not retry flaky tests silently; report them.
- **Red → green → refactor:**
  - *Bug fixes & regressions:* Write a minimal test reproducing the bug, run it via `node test/run.js <layer> --grep <re>`, and confirm it **fails for the right reason** on pre-fix code (if you already edited code, briefly revert/stash the fix to prove it fails); then apply the fix, confirm green, and report the red → green check in your handoff/PR.
  - *Refactors:* Lock in observable behavior at the public boundary first (adding characterization tests if missing), then refactor while keeping those tests green untouched.
  - *New features:* Red → green is optional — use it when it helps clarify the contract.
- **Test public behavior, not internals:** Drive tests through exported public APIs, host↔webview messages, or user-visible state/a11y — never export private helpers just for tests, inspect internal fields, or assert internal call order. Mock only external boundaries (VS Code API, timers, I/O), never internal collaborators.
- **Updating or deleting tests:** Never weaken or delete a failing test just to make a run pass. Pure **change-detector tests** (tests that only mirror internals and break on clean refactors) *should* be deleted or replaced once their observable behavior is covered at the public boundary — note why in the commit/handoff.

## Pitfalls

- `avi_scan_test.js` is skipped by the runner (needs input files); that is expected.
- Layer 4 numbers are only comparable through `test/benchq.js`; never run it alongside layer 3.
- New scenario: add `test/vscode/cases/<name>.js` (shape in `test/vscode/README.md`); keep it
  correctness-only, never speed.
