---
name: add-format
description: Add support for a new container extension or codec to Video Preview Enhanced (file association, decoder build, tests, docs). Use when asked to support a new file type or codec.
---

# Add a container or codec

Check `docs/formats.md` first: most requests are already covered, or are a probing bug (use the
`reproduce-decode-bug` skill). Scope questions: `docs/PRODUCT.md`.

## Container extension only (the decoder already handles it)

1. `package.json` `customEditors` selectors (`filenamePattern`, with upper- and lower-case variants).
   MP4/WebM sit in the `option` editor, the rest in `default`. Never claim `.ts` (VS Code treats it
   as TypeScript).
2. `src/extension.js` `FILE_ICON_EXTS` if the Seti icon theme has no video icon for it (check the
   `file_icons` scenarios).
3. `src/sniff-*.js` / `src/probe.js` if the container needs sniffing; add a host test.
4. Generate a sample with ffmpeg in `test/media/make_containers.js` or `make_cases_media.js`
   (no committed binaries unless openly licensed and credited in `test/media/LICENSES.md`).
5. Add it to the matching scenario (`test/vscode/cases/playback.js`) and run that one hidden.

## New codec in the built-in decoder (WebAssembly)

Rare and costly: it changes a binary that ships under the LGPL.

1. Add the decoder or demuxer to the build definition (`media/libav-vpe/vpe-fragments.json`,
   `build/libav/vpe-next-fragments.json`) and rebuild with `build/libav/` (Linux or WSL; read
   `build/libav/README.md`).
2. Never enable GPL or non-free components. Update `THIRD_PARTY_NOTICES.md`,
   `media/libav-vpe/LICENSE-NOTE.md` and `docs/licences.md` with exact versions and sources.
3. Check the package size (`npx --yes @vscode/vsce@4.1.1 ls --tree`, about 4.7 MB), run
   `test/engine/unit.js` and a frame-exact seeking check on the new codec.
   `build/libav/vpe-test.js` and `subtest.js` smoke-test a build.

## Always

- Update `docs/formats.md`; touch the README format list only if the Marketplace claim changes
  (README stays short, see `update-docs`).
- Add a `CHANGELOG.md` line under **Unreleased**.
- Run layers 1-2 and the scenario you touched.
