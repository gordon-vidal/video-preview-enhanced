# Contributing to Video Preview Enhanced

Thanks for helping. Bug reports, format samples that play wrong, and pull requests are all welcome.
By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through
[SECURITY.md](SECURITY.md), not public issues.

## Reporting a problem

Open an [issue](https://github.com/gordon-vidal/video-preview-enhanced/issues/new/choose) with the bug
template. The most useful details: VS Code version, OS, local or remote (WSL / SSH / container), which
decoder played the file (ⓘ About this video), the ffmpeg version if you use one, the output of
**Video Preview: Show Log**, and `ffprobe -hide_banner <file>`. Attach a short clip only if you are
allowed to share it.

## Setup

You need [Node.js](https://nodejs.org) 20 or later, Git, and VS Code 1.82 or later.
For the tests: ffmpeg and ffprobe on `PATH`, and on Windows Python 3 on `PATH`.

```
git clone https://github.com/gordon-vidal/video-preview-enhanced.git
cd video-preview-enhanced
npm ci          # no runtime or build dependencies; this only checks the lock file
code .
```

Press **F5** (or run `code --extensionDevelopmentPath=<repo>`) to start an Extension Development Host
with the extension loaded from your checkout, and open a video there. There is no build step: the
extension host code is in `src/`, the webview player in `media/`, plain JavaScript (CommonJS in
`src/`, browser scripts and workers in `media/`).

The test videos in `test/media/` are stored with [Git LFS](https://git-lfs.com): install it (`git lfs install`)
before you clone, or run `git lfs pull` afterwards. Without it those files are small text pointers and the tests
that need them fail. `media/probe/` and the decoder are plain git (they ship in the package). Details in
[test/media/LICENSES.md](test/media/LICENSES.md).

`media/libav-vpe/` is a prebuilt WebAssembly FFmpeg (LGPL). Rebuilding it is only needed when the
decoder itself changes: see [build/libav/README.md](build/libav/README.md) (Linux or WSL).

## Tests

The strategy (four layers, what runs when) is in [docs/TESTING.md](docs/TESTING.md). In short:

```
npm test                                  # layer 1-2: host and engine tests in Node (Windows, macOS, Linux)
node test/subtitles/run.js                # more Node unit tests that CI runs too
node test/timestretch/run.js
node test/inspect/inspect_test.js
```

The real-VS-Code scenarios (layer 3) and performance runs (layer 4) are in `test/vscode/`; they currently
run on Windows only, on a hidden desktop, with a pinned portable VS Code that `node test/vscode/get_code.js`
downloads into `test/vscode/.code/` (git-ignored). `VPE_CODE=<path to Code executable>` points them at another
VS Code. See [test/vscode/README.md](test/vscode/README.md). They need a GPU, so GitHub Actions runs layers
1-2 only; run the scenarios that cover your change locally if you can, and say in the pull request
what you ran.

To try a branch, commit or `.vsix` by hand in a throwaway profile on Windows: `review.cmd <ref>`
([docs/REVIEW.md](docs/REVIEW.md)).

## Code style

- Plain JavaScript, no transpiler, no runtime npm dependencies. Keep it that way unless discussed first.
- `'use strict';`, 2-space indent, LF, UTF-8 (see [.editorconfig](.editorconfig)); lines up to about
  120 columns. Match the style of the file you are in.
- Comments say why, not what. Settings and UI text are short and plain.
- Put pure logic in small modules that a Node test can load without VS Code or a browser.
- New user-visible behaviour: update `README.md` (the Marketplace page) and the matching page in `docs/`,
  and add a line under **Unreleased** in `CHANGELOG.md`.
- Design notes for larger changes go in `docs/notes/`. Product decisions are in `docs/PRODUCT.md`.
- Test media must be openly licensed (CC BY or similar, no NC / ND) and credited in
  [test/media/LICENSES.md](test/media/LICENSES.md). Prefer generating clips with the scripts in
  `test/media/` over committing new binaries.

## Commits and pull requests

1. Fork (or branch, if you have write access) from `main`: `fix/<topic>` or `feat/<topic>`.
2. Small, focused commits with an imperative subject line ("Seek bar: keep the hover picture on
   release"), and a body that says why.
3. Run `npm test` and the other Node tests above; for UI or decoder changes also check a few real
   files in the Extension Development Host.
4. Open a pull request against `main` and fill in the template. CI (host tests on Linux and Windows,
   a syntax check and a `vsce package` dry run) must pass.
5. A maintainer reviews and merges. Releases are made by the maintainers (see
   [docs/RELEASING.md](docs/RELEASING.md)); do not change `version` in `package.json`, since
   a version bump on `main` publishes a release automatically.

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE) of
this project.
