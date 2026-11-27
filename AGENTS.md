# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Copilot, Cursor, ...). Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md). Nearest-file rules win; the user's prompt wins over this file.

## Project

Video Preview Enhanced is a VS Code extension that plays video in the editor (MP4, MKV, MOV, AVI,
WebM, WMV, MXF ...) with frame-exact stepping, compare views, scopes and inspection tools. Three
decoders, picked per file: VS Code's WebCodecs (H.264/VP8), a built-in FFmpeg-as-WebAssembly
(libav.js, LGPL) and an optional native ffmpeg the user installs. Plain JavaScript, no runtime or
build dependencies, no build step. Works locally, in WSL and over Remote-SSH.

### Known VS Code platform limits (do not re-propose)

- **WebCodecs video is H.264 (8-bit 4:2:0) and VP8 only:** VS Code explicitly allowlists only H.264
  and VP8 in webviews (`src/vs/base/common/media.ts`, `microsoft/vscode#344372`). Even though stock
  Electron supports HEVC, VP9, and AV1, real VS Code webviews return unsupported for all three.
  Already built, measured, and dropped — see [docs/notes/webcodecs-hevc-vp9-av1.md](docs/notes/webcodecs-hevc-vp9-av1.md).
- **WebCodecs audio & WASM threads:** Real VS Code webviews do **not** support `AudioDecoder` for
  AAC or Opus, and webviews are not cross-origin isolated (no `SharedArrayBuffer`, so no pthreads
  in WebAssembly).

## Repo map

| Path | What |
|---|---|
| `src/` | Extension host (Node, CommonJS): activation, custom editor, the viewer's host (`unified-viewer.js`, `unified-session.js`, `unified-sources.js`), ffmpeg setup, remote streaming, settings |
| `media/` | Webview viewer (browser scripts, workers): `player-unified.js` (the page's boot), `player-state.js` (pure unified player/compare state), `player-ui.js` (UI controller over Engine/Host adapters), `engine.js`, scopes, thumbs; `media/libav-vpe/` is the prebuilt WebAssembly decoder (do not hand-edit) |
| `test/host/`, `test/engine/` | Layers 1-2: Node tests. `node test/run.js unit engine` runs them |
| `test/vscode/` | Layers 3-4: real VS Code on a hidden desktop (Windows). `cases/` are the scenarios |
| `test/subtitles`, `test/timestretch`, `test/inspect` | More Node unit tests that CI runs |
| `test/media/` | Test clips (Git LFS) and generators; licences in `test/media/LICENSES.md` |
| `docs/` | User docs, `PRODUCT.md` (product truth), `TESTING.md` (test truth), `RELEASING.md`, `REVIEW.md`, `adr/` (signed-off decisions), `notes/` (design notes) |
| `tools/`, `review.cmd`, `review.sh` | Maintainer helpers (`tools/mockup/` = reusable interactive UI mockup harness: real CSS/bar/state and the shared `media/player-ui.js` controller over a fake engine and host; `review.cmd` / `review.sh` = visible review profile; humans only) |
| `build/libav/` | Scripts that rebuild the WebAssembly decoder (Linux/WSL only; rarely needed) |
| `.private-context/` | Git-ignored maintainer notes, local only (see below) |

## Setup

Node 20+, Git, Git LFS (`git lfs pull` for test videos), ffmpeg and ffprobe on `PATH`, Python 3 on
Windows. `npm ci` (only verifies the lock file). Run from the repo root.

## Tests

Strategy, layers and rules: [docs/TESTING.md](docs/TESTING.md). It is the source of truth; commands
live there and in [test/vscode/README.md](test/vscode/README.md), not here. If they disagree, fix
the docs. Quick reference:

```
node test/run.js unit engine            # layers 1-2 (what CI runs), all cores
node test/run.js vscode                 # layer 3, Windows only, hidden desktop
node test/run.js vscode --grep <re>     # only matching scenarios / cases
node test/run.js unit engine vscode --changed   # a hint only: by file name, usually picks everything
npm test                                # layers 1-3 (before a release, not before every merge)
```

**Choose your layer-3 scenarios yourself** (maintainer, 2026-11-21): before a merge run layers 1-2 as CI does
(`CI=true node test/run.js unit engine`) plus the scenarios that cover what you changed and what depends on it
(at least those in "Known dependencies" in docs/TESTING.md), about 10 minutes at most, and list each with a
one-line reason in your report or PR. Do not run the whole layer just to be safe: only a release has to have
everything working, and the full run before a release catches what a merge missed.

Layer 4 (performance) runs only through `node test/run.js perf` (it holds the lock) and only
before releases or in performance work.

## Guard rails

- `.claude/settings.json` denies `git add` of `.private-context` and `git add -f`, and runs
  `tools/hooks/block-visible-launch.js` to block commands that open a visible VS Code or browser.
  Other agents: obey the same rule (`review.cmd` / `review.sh` is for humans; automated VS Code
  runs go only through the hidden-desktop runner in `test/vscode/`).
- CI runs gitleaks (secret scan of full history) and the personal-data check. Optional local hook:
  `git config core.hooksPath .githooks` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Rules

- **Fix with the smallest run**: while fixing, run only the failing test **through
  `node test/run.js <layer> --grep <re>`** (never bare `node test/host/<file>.js`, which bypasses
  the runner's timeout and stall kill); run the full layer once at the end. Do not retry flaky
  tests silently; report them.
- **Red → green → refactor**:
  - *Bug fixes & regressions:* write a minimal test reproducing the bug, run it via
    `node test/run.js <layer> --grep <re>`, and confirm it **fails for the right reason** on the
    pre-fix code (if you already edited code, briefly revert/stash the fix to prove it fails); then
    apply the fix, confirm green, and report the red → green check in your handoff/PR.
  - *Refactors:* lock in observable behavior at the public boundary first (adding characterization
    tests if missing), then refactor while keeping those tests green untouched.
  - *New features:* red → green is optional — use it when it helps clarify the contract.
- **Test public behavior, not internals**: drive tests through exported public APIs, host↔webview
  messages, or user-visible state/a11y — never export private helpers just for tests, inspect
  internal fields, or assert internal call order. Mock only external boundaries (VS Code API,
  timers, I/O), never internal collaborators. Details: [docs/TESTING.md](docs/TESTING.md#test-design-and-red-green-refactor).
- **Updating or deleting tests**: never weaken or delete a failing test just to make a run pass.
  Pure **change-detector tests** (tests that only mirror internals and break on clean refactors)
  *should* be deleted or replaced once their observable behavior is covered at the public boundary
  — note why in the commit/handoff.
- Do not run layer 4 or several VS Code instances while another run is active.
- **No personal data in tracked files, commits, PRs or issues**: no e-mail addresses, home-directory
  paths (`C:\Users\<name>`, `/home/<name>`), machine names, tokens, private notes. CI scans for it.
- Commit as the preconfigured identity (the GitHub noreply address); do not change `git config`.
  Do not push, merge or force-push unless asked.
- `README.md` is the only Marketplace and GitHub landing page: keep it short and user-facing; put
  detail in `docs/`. User-visible change = README/docs update plus a line under **Unreleased** in
  `CHANGELOG.md`. README claims and numbers must match a measured run.
- `docs/PRODUCT.md` is the product source of truth. A change that contradicts it needs the
  maintainer's decision first.
- **UI changes & 3-way separation**: keep **UI shell** (`src/bar.js`, `media/player.css`,
  `media/compare.css`), **pure state** (`media/player-state.js`), and **decoder/host engine**
  cleanly separated (see [docs/TESTING.md](docs/TESTING.md)). Do not restyle or rearrange the
  player on your own. Always contribute UI/UX work to the reusable mockup harness
  (`tools/mockup/render.js`, UI wiring in `media/player-ui.js`, following
  `.claude/skills/ui-mockup/SKILL.md`), document changes in `docs/notes/` with visuals, keys and
  a11y names, and open a PR or ask first.
- Code: `'use strict'`, 2 spaces, LF, about 120 columns; comments say why. No new runtime
  dependencies. Put logic in small modules a Node test can load without VS Code or a browser.
- Test media must be openly licensed (no NC/ND) and credited in `test/media/LICENSES.md`;
  prefer generating clips.
- **Licences**: the extension is MIT; the bundled decoder is FFmpeg under LGPL 2.1+ (plus dav1d, zlib).
  Never bundle GPL or non-free ffmpeg builds or codecs; the decoder stays a replaceable, separate
  file set with its build definition (`media/libav-vpe/vpe-fragments.json`, `THIRD_PARTY_NOTICES.md`,
  [docs/licences.md](docs/licences.md)). Changing the decoder build needs the notices updated.
- Releases and publishing are the maintainers' decision ([docs/RELEASING.md](docs/RELEASING.md));
  merging a version bump in `package.json` to `main` publishes automatically (Publish workflow), so
  **version bumps happen only when the maintainer explicitly says so**: never change `version` in
  `package.json` / `package-lock.json` on your own, not even on a branch, and never run the workflow or tag.

## Commits and PRs

Branch `fix/<topic>` or `feat/<topic>` from `main`. Small commits, imperative subject ("Seek bar:
keep the hover picture on release"), body says why. Fill in `.github/pull_request_template.md`:
what and why, which tests you ran, checklist. CI (host tests on Linux and Windows, syntax check,
`vsce package` dry run, personal-data and link checks) must pass. Say in the PR what you did not run
(layer 3 needs a GPU and runs locally).

- **Clean up after merge**: once a branch is merged into `main` and pushed (so the work is safely
  online with no open issues), remove its local worktree (`git worktree remove`) and delete the
  merged local branch (`git branch -d`). Never force-delete (`-D`) unmerged work.

## Private context

If `.private-context/` exists at the repo root, read its `README.md` and `AGENTS.md` (if present) first: it holds the
maintainer's local notes (personal workflow rules, handover, roadmap, decisions, environment, marketing drafts). It is
private: never copy, quote or summarise it into tracked files, commits, PRs, issues, logs or
chat shared outside this machine. If it is absent, work from the public docs only. Layout:
[docs/private-context.md](docs/private-context.md).

## Skills

Project skills live in `.claude/skills/<name>/SKILL.md` (auto-discovered by Claude Code; other
agents should read the relevant `SKILL.md` directly before running tests, debugging decode issues,
adding a format, releasing, updating docs, writing user-facing notices, or building UI mockups): `run-tests`,
`reproduce-decode-bug`, `add-format`, `release-checklist`, `update-docs`, `ui-notices`, `ui-mockup`.
