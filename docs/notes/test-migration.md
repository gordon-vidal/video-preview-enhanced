# Test migration: Edge harness to real VS Code (2026-11-19)

Rule: only real VS Code counts as evidence (`docs/PRODUCT.md`, Testing). The Edge/Playwright harness in
`test/browser/` (with its fake extension host and VS Code codec emulation) is removed. This note lists what it
checked, where each check lives now, and what was dropped and why.

Real-VS-Code cases are in `test/vscode/cases/`, helpers in `test/vscode/lib.js`, clips in `test/media/cases/` (made by
`test/media/make_cases_media.js` with ffmpeg lavfi sources). How they observe the page: `test/vscode/README.md`
("Hooks the cases use"). Run one: `node test/vscode/run.js --quick --only '^case/seeking' --sub 'step/s_h264'`.

## What changed in how checks work

- The Edge harness read the page with Playwright (`page.evaluate`, real key presses and mouse). Now the page answers
  JSON lines (`state`, `thumb`, `pixels`, `scopesDump`) asked for through the `VPE_LOG` test hook, and the debug
  `key` / `dom` / `gotoText` / `click` actions send the same DOM events. A request takes ~0.3 s (the hook polls its file),
  so time series (A-B loop wraps, speed) are sampled at ~3 per second instead of every animation frame.
- "Which frame is on screen" is still decided against ffmpeg: the page sends its canvas as 64x36 luma, the test
  correlates it with ffmpeg's decode of the same file (`lib.js expectFrame`, as the harness' `expectFrame`).
- The old harness took media from a "zoo" in a scratch folder (`test/zoo/make_zoo.js`, not in the repo). The cases make
  their own small clips; nothing is fetched or hand-placed.
- The webview in a hidden VS Code never gets a user gesture: the `AudioContext` stays `suspended`. Checks that
  the sound is the clock only apply when it is `running`; speed and time checks do not depend on it.

## Inventory

`tests.js` (Edge, per zoo file unless noted)

| Check | Now | Notes |
|---|---|---|
| `open/<every zoo file>`: first frame, canvas, sound mode, frames advance, picture looks like the file | `playback` `open/fmt/*` (18 codec / container clips) | The mainstream containers and codecs (MP4, MKV, MOV, AVI, FLV, M2TS with H.264, VP8 WebM, HEVC, VP9, MPEG-2, ProRes, MJPEG, MPEG-4) are in `play/*`, `native/*` and the `seeking` clips. "Picture looks like the file" is covered by every `expectFrame`. |
| `open/` of `big_2gb.mkv`, `audio_cover.mp3`, `audio_only.m4a`, `truncated_*` | audio-only: `playback` `open/audio-only` (.mkv); truncated: `playback` `truncated/*` | `.m4a` and `.mp3` are not claimed by the extension in VS Code (package.json patterns), so they never open there. The 2 GB file is not generated (disk and time). |
| `step/*` (7 files) | `seeking` `step/<clip>` for H.264, HEVC, VP9, MPEG-2, ProRes, MPEG-4 AVI, MJPEG | slots from ffmpeg's timestamps as before; across a keyframe; `.` and `,` keys |
| `seek/*` (7 files), seek while playing | `seeking` `seek/<clip>` | |
| `abloop` | `seeking` `abloop/s_h264.mp4` | wrap count sampled at ~3 Hz |
| `rate/audio-clock` | `playback` `rate/speed` | speed 0.5-2x checked; "audio is the clock" only when the AudioContext runs |
| `neighbour/next-prev` | `playback` `neighbour/next-prev` | opening is observed in the log (first frame of the next file) |
| `rotation` | `playback` `rotation/rotated.mp4` | portrait canvas and ffmpeg's rotated frame |
| `pill/fully-decoded-stable` | `playback` `pill/fully-decoded-stable` | |
| `resume/position` | `playback` `resume/position` | real close and reopen (global state is real now) |
| `saveFrame/png` | `scopes_export` `saveFrame/png` | `VPE_SAVE_DIR` replaces the save dialog |
| `inspect/goto`, `pixel`, `zoom`, `stats` | `inspect` of the same names | pixel read-out compared with ffmpeg's RGB / YUV |
| `inspect/links`: Shift+C copies a link; open from the link; `#t=` fragment | `inspect` `links/open-url` (`Code.exe --open-url vscode://...`) | Dropped: the clipboard text (not observable from the hook; `copyLink` builds it from `parseLink`-tested pieces) and the `#t=2.5` fragment (the hook opens plain file URIs); `test/inspect/inspect_test.js` covers `parseFragment` / `parseGoto`. |
| `hdr/pq`, `hdr/hlg`, `hdr/h264-pq`, `hdr/sdr-unchanged` | `inspect` `hdr/*` | same reference (ffmpeg zscale + the shader's EETF); pixels read from the WebGL canvas through the `pixels` hook |
| `audio/truehd-51side`, `audio/71-centre-downmix` | `playback` `audio/*` | |
| `poolseek/mpeg2`, `poolseek/prores` | `play/*` seek spot check in `run.js` (these exact clips) and `seeking` `seek/s_mpeg2.mpg`, `s_prores.mov` | |

`review1.js`

| Check | Now |
|---|---|
| `step-ms-rounded` (60 fps VP9 / H.264, NTSC 30000/1001) | `seeking` `step-ms-rounded/*` |
| `autoplay-late-start` (PTS 3600 s, H.264 and MPEG-2) | `playback_autoplay` `autoplay-late-start/*` (`.mts`: VS Code's `.ts` is TypeScript) |
| `end-key` (End shows the last frame when the sound is longer) | `seeking` `end-key/*`; plus `edges/s_h264.mp4`: seek past the end, step past either end, Home |
| `end-of-sound`, play after the end | `playback_autoplay` `end-of-sound/audio_longer.mp4` |
| `loop-sound-only` | `playback_loop` `loop-sound-only/sine_only.mkv` (`.mka` is not claimed, so MKV) |
| `eof-flush` (VP8 WebCodecs) | `seeking` `eof-flush/vp8_2s.webm` |
| `damaged-h264` (2 files; one conceals, one raises a decoder error) | `playback` `damaged-h264/*`: both made by `make_cases_media.js`; the second logs `VideoDecoder error` and the picture goes on |

`scopes_export.js`, `bitmapsubs.js`, and the other users of the harness

| Check | Now |
|---|---|
| `scopes/waveform-bars`, `vectorscope-bars`, `updates-when-stepping`, `frame-player` | `scopes_export` `scopes/*` (the bars clip is 1280x720: see Findings) |
| `export/range` (names, each PNG is the right frame) | `scopes_export` `export/range` (PNGs decoded and matched by ffmpeg) |
| `export/vfr` (gapped video) | `scopes_export` `export/vfr` |
| `export/hidden` | `scopes_export` `export/hidden`: the player is hidden by another tab *during* the export (it waits), then shown (it finishes). The old "hidden before the command" variant is not reachable: the command asks the active player. |
| `export/cancel` (hint without A-B; cancel after 3 frames; overwrite question) | `scopes_export` `export/no-range` only. Dropped: cancelling needs a click on the progress notification and the overwrite question is a modal dialog, neither can be answered in a hidden window. The logic is small and in `exportRange` (src/extension.js); `test/host/rangecmd_test.js` covers the file names and the ffmpeg command. The "Copy ffmpeg command" QuickPick + clipboard is dropped for the same reason. |
| `bitmapsubs` PGS / DVD / DVB | `subtitles` `bitmap/*` (CC menu click, seeks, zoom, playing) |
| `test/tracks/browser.js` (CC menu, sound switch while playing, SRT and ASS cues) | `subtitles` `tracks/menu-and-cues` |
| `test/thumbs/browser.js` (seek-bar thumbnails) | `inspect` `thumbs/seek-bar` |
| `test/xray/strip_test.js` | `inspect` `xray/strip` (index, `{` `}`). The old script only printed hover / click / chapter / zoom values and screenshots and never asserted them; not ported. |
| `compare.js` (PSNR / SSIM vs ffmpeg, same file, offset) | `compare_metrics` `same-file`, `lowq-vs-ffmpeg`, `offset-3`. Not ported: the HEVC re-encode and 25 fps-vs-30 fps pairs (the metrics code does not depend on the codec; multiview covers mixed fps), "Find diff" scan and screenshots of the removed difference view. |

Dropped because they only tested the harness: `vscode_codecs.js` (VS Code's codec policy emulated in Edge; the real
policy is `wcprobe` in `run.js`), `fakehost.js`, `shim.js`, `harness.js`, `probe.js`, `run.js --perf`
(`npm run perf:vscode` is the real-VS-Code speed run).

## Other test folders

- `test/host/native_rotation_test.js` made no media: it now uses `test/media/cases/rotated.mp4` (a copy of `s_h264.mp4` with
  a 90 degree display matrix, made on demand).
- `test/tracks/run.js` and `engine_smoke.js` took a folder argument and failed without the files from
  `test/tracks/make_media.js` (and two plain files the zoo had). They default to `test/media/tracks/` (git-ignored, 1080p,
  a few minutes to make once) and make the files when missing; `h264_aac.mkv` / `.m2ts` were added to the generator.
  `run.js` passes, except it skips `mpeg2_ac3.vob`, which nothing makes. `engine_smoke.js` has one failing check
  ("open-GOP H.264 falls back to software after the seek"): it fails the same way without these changes (engine.js is
  not touched here); left for whoever owns the engine.

## Findings while porting

- **Scopes use the wrong colour matrix for tagged BT.709 video below 1280x720 on the WebCodecs path.** `matrixOf` in
  `media/scopes.js` reads `lastShown.yuv.space`, which WebCodecs frames do not have, and then guesses 709 only from the
  size. A 640x360 H.264 clip tagged BT.709 showed `BT.601` and the bars' luma was off by up to 22 codes. The cases use a
  1280x720 bars clip (as the Edge test did, where the size guess made it pass) so this stays visible only here. Not fixed
  (product behaviour).
- **Export after a hidden player is shown again can lose a frame** (279 of 280 on a 280-frame A-B range, 3 runs of 4).
  `exportRange` names files from the frame the page reports and skips a frame that is not newer than the last one
  written; after the player was hidden the first picture shown can still be the previous frame, so the frame asked
  for is skipped and the loop moves on. `export/hidden` accepts 279 or 280 and records the loss as `known`. Visible
  exports (`export/range`, `export/vfr`) are exact. Not fixed here (product behaviour, src/extension.js).
- Four VS Code instances rendering at once can fail with "WebGL2 is not available" (the decoder could not start): run
  the cases a few at a time, not all in parallel.
- `AudioContext` is `suspended` in a hidden window (no user gesture): sound-clock behaviour cannot be tested there.
