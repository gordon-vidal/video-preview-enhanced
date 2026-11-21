# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Copilot, Cursor, ...). Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md). Nearest-file rules win; the user's prompt wins over this file.

## Project

Video Preview Enhanced is a VS Code extension that plays video in the editor (MP4, MKV, MOV, AVI,
WebM, WMV, MXF ...) with frame-exact stepping, compare views, scopes and inspection tools. Three
decoders, picked per file: VS Code's WebCodecs (H.264/VP8), a built-in FFmpeg-as-WebAssembly
(libav.js, LGPL) and an optional native ffmpeg the user installs. Plain JavaScript, no runtime or
build dependencies, no build step. Works locally, in WSL and over Remote-SSH.

## Repo map

| Path | What |
|---|---|
| `src/` | Extension host (Node, CommonJS): activation, custom editor, ffmpeg setup, remote streaming, settings |
| `media/` | Webview player (browser scripts, workers): `player.js`, `engine.js`, `compare.js`, scopes, thumbs; `media/libav-vpe/` is the prebuilt WebAssembly decoder (do not hand-edit) |
| `test/host/`, `test/engine/` | Layers 1-2: Node tests. `node test/run.js unit engine` runs them |
| `test/vscode/` | Layers 3-4: real VS Code on a hidden desktop (Windows). `cases/` are the scenarios |
| `test/subtitles`, `test/timestretch`, `test/inspect` | More Node unit tests that CI runs |
| `test/media/` | Test clips (Git LFS) and generators; licences in `test/media/LICENSES.md` |
| `docs/` | User docs, `PRODUCT.md` (product truth), `TESTING.md` (test truth), `RELEASING.md`, `REVIEW.md`, `adr/` (signed-off decisions), `notes/` (design notes) |
| `tools/`, `review.cmd` | Maintainer helpers (`review.cmd` = visible review profile; humans only) |
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

- `.claude/settings.json` (shared Claude Code settings) denies `git add` of `.private-context` and
  `git add -f`, and runs the hook `tools/hooks/block-visible-launch.js`, which blocks shell commands that
  open a visible VS Code or a browser (`code`, `Code.exe`, `msedge`, `chrome`, `start`/`Start-Process` on
  URLs or HTML ...). `node test/vscode/...` (hidden desktop) is unaffected. Other agents: obey the same rule.
- CI runs gitleaks (secret scan of the full history) and the personal-data check. Optional local hook:
  `git config core.hooksPath .githooks` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Rules

- **Never open a visible VS Code window or a browser** in automated runs. Real-VS-Code tests go only
  through the hidden-desktop runner (`test/vscode/`). `review.cmd` is for a human.
- **Fix with the smallest run**: while fixing, run only the failing test; run the full layer once at
  the end. Do not retry flaky tests silently; report them.
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
- **UI changes**: do not restyle or rearrange the player on your own. Describe the change in a design
  note in `docs/notes/` (problem, mock-up or screenshot via the hidden-desktop `test/vscode/screenshot.js`,
  keys and a11y names) and open it as a PR for review, or ask first.
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
adding a format, releasing, or updating docs): `run-tests`, `reproduce-decode-bug`, `add-format`,
`release-checklist`, `update-docs`.
