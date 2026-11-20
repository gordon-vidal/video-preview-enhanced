# WebCodecs for HEVC, VP9 and AV1: built, measured, dropped

Status: dropped on branch `vscode-real` (Nov 2026). Kept here so it can be brought back if VS Code
ever allows these codecs in webviews.

## What it was

Branch `webcodecs-hw` (merged into main as ae31d79) routed HEVC, VP9 and AV1 to the browser's
decoder (WebCodecs, on the GPU where it has one) instead of the WebAssembly decoder, with:

- codec strings built from the stream (`hvc1`/`hev1` from the hvcC record or profile/level,
  `vp09.PP.LL.DD`, `av01.P.LLT.DD`), HEVC only with `prefer-hardware`, VP9/AV1 also on the
  browser's own software decoder;
- fallback to WebAssembly from the playhead on configure failure, a decode error before the first
  frame, a stall (8+ chunks in, nothing out for 3 s), pictures of the wrong size, or under half the
  frames out; the failed codec remembered for the webview and (via the host) the VS Code session;
- 10/12-bit and P010 frames copied out while paused; compare reading 10-bit luma from GPU frames;
  HDR opt-in drawn through a half-float texture and tone-mapped in the shader;
- the setting `videoPreviewEnhanced.webCodecs` (`auto` / `all` / `h264` / `off`);
- in the merge, a host decision "VS Code's GPU decoder first" (`browserGpu()` in `src/decide.js`,
  `gpuDecoders` in `src/extension.js`, the `gpu` field of the webview's `ready` message from a 4K
  `isConfigSupported` probe in `media/player.js`), so 4K HEVC would not go to native ffmpeg.

## Why it was dropped

VS Code's webviews only decode the codecs VS Code approves. Its list
([src/vs/base/common/media.ts](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/base/common/media.ts))
has H.264 and VP8 for video; a maintainer in
[microsoft/vscode#344372](https://github.com/microsoft/vscode/issues/344372) says other codecs
would need a legal review. See also [microsoft/vscode#137884](https://github.com/microsoft/vscode/issues/137884).

Measured inside a real VS Code webview (VS Code 1.146, Electron 43.8.6, Chromium 150) with the
debug action `wcprobe` (`media/player.js`), in the page and in a worker. Each cell is
`VideoDecoder.isConfigSupported` with hardwareAcceleration prefer-hardware / no-preference /
prefer-software at 4K (VP8 at 1080p):

| Codec | Real VS Code | Stock Electron 43.8.6, Edge 157 |
|---|---|---|
| H.264 (`avc1.640033`) | Y Y Y | Y Y Y |
| VP8 | - Y Y | - Y Y |
| HEVC 8-bit / 10-bit | - - - | Y on GPUs that decode it |
| VP9 8-bit / 10-bit | - - - | Y |
| AV1 8-bit / 10-bit | - - - | Y |

AudioDecoder in the real VS Code webview: mp3, flac, vorbis, pcm yes; **aac and opus no**
(flac/vorbis throw without a description). `<video>`/MSE: H.264, VP8, MP3 (also MSE); FLAC, Vorbis
(not MSE); HEVC, AV1, VP9, AAC, Opus no. Webviews are not cross-origin isolated: no
SharedArrayBuffer, so no WebAssembly threads.

Stock Electron 43.8.6 in a hidden window, even with VS Code's own `ffmpeg.dll`, `sandbox: true`
and VS Code's command-line switches, supports all of them: the restriction is VS Code's, not
Chromium's. Our earlier tests ran in Edge and Electron, so they overstated what VS Code can do; the
The Edge harness that once applied VS Code's rules is gone; only real VS Code counts (`test/vscode/`).

## What it gained (in Edge)

On a laptop with an Intel Core Ultra 7 165U and its iGPU (headless Edge 157, all cores, median of 3
runs of 8 s), every HEVC 8/10-bit, AV1 8/10-bit and VP9 clip of the bench set, 1080p and 4K, played
at 30 fps through WebCodecs. WebAssembly on that laptop: 4K HEVC 10-bit 2–6 fps, 4K AV1 10-bit 6–9,
4K VP9 2–15 (all roughly 2–12 fps at 4K), 1080p HEVC 10-bit high bitrate 5–16. The first frame
came after 0.35–0.9 s instead of 0.8–2.8 s.

## How to bring it back

- `git revert` the revert of b4becb9 ("WebCodecs (GPU) for HEVC, VP9 and AV1, with fallback to the
  built-in decoder") on this branch, or cherry-pick b4becb9 and resolve against the later sound
  changes (the sound part of `wcFailed` stayed, see the revert commit).
- From the merge ae31d79: `browserGpu()` and its call in `decide()` (`src/decide.js`), its tests in
  `test/host/decide_test.js`, `gpuDecoders` and the `wc:` argument to `decide()` in
  `src/extension.js`, and `WC_PROBES` / `gpuDecoders()` before the `ready` message in
  `media/player.js`.
- The docs commit 27620c3 has the README/CHANGELOG/PLAN text of the time.

## What to re-check before shipping it again

- **HDR tone mapping:** WebCodecs hands WebGL RGB that the browser converted (the PQ/HLG signal,
  not tone-mapped). Tone-mapping that in the shader was off by up to 34/255 on saturated colours
  against zscale (Edge 157, Intel); that is why HDR stayed in WebAssembly unless `webCodecs: all`.
- **Untagged 10-bit SD:** untagged SD is BT.601, browsers draw it as BT.709, and opaque 10-bit GPU
  frames can't be copied out to redraw them, so those stayed in WebAssembly. A config `colorSpace`
  didn't change Edge's conversion.
- **Pixel inspector, scopes, compare on opaque frames:** deep hardware frames can't always be read
  back (`copyTo`), so tools that read source Y/U/V need the copy-out path or fall back.
- The fallbacks (stall, wrong size, frame count) were tested with simulated broken decoders only.

## Re-testing quickly in a real VS Code

```
node test/vscode/run.js --grep wcprobe
```

starts VS Code on a hidden desktop with a temporary profile, opens one clip, and prints the
`wcprobe` matrix for the page and a worker (also in `test/vscode/out/run-*.json`). If HEVC, VP9 or
AV1 ever show `Y` there, the feature is worth bringing back; then run the full `test/vscode/run.js`
suite with the policy file updated.
