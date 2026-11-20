# CPU while playing 4K HEVC 10-bit with native ffmpeg (2026-11-20)

Report: in a fresh install, opening `test/media/hevc_10_2160p.mp4` (4K HEVC Main 10,
29.97 fps) uses a lot of CPU although it "plays on the GPU".

## Root cause

Two things, about equally large.

1. **No GPU test, so `-hwaccel auto`.** Since 7b2683e nothing tests ffmpeg in the background, and
   without a stored test record `decide.nativeMethod` returned `auto`. On this machine
   `-hwaccel auto` picks **DXVA2** (`Using auto hwaccel type dxva2`), downloads every 4K frame as
   **P010** (`pixfmt:p010le` into the filter graph) and swscale converts it to 8-bit `yuv420p` on the
   CPU at full size. The CUDA path the GPU test used to choose on NVIDIA (`scale_cuda` converts to
   8-bit and scales before `hwdownload`, docs/notes/gpu-8bit.md) was never taken. DXVA2 also fell to
   9-14 fps on the PQ clip in one run (ffmpeg read 9 fps), where D3D11VA and CUDA kept 30.
2. **Full 4K frames for a smaller picture.** The automatic `nativeMaxHeight` sends 3840×2160 over the
   frame server for 4K30 whatever the panel size. Moving 12.4 MB frames at 30 fps (~370 MB/s) costs
   far more than ffmpeg: the extension host ~80 % of a core (socket writes; its JS thread is only
   0-3 % busy), VS Code's network service ~50 % (the webview's `fetch` of 127.0.0.1 goes through it),
   the webview renderer ~70 % (read + `texSubImage2D`) and the GPU process ~40-50 %.

Software-decoded 4K is not scaled twice: every path has one swscale pass
(`scale=W:H:flags=bilinear,format=yuv420p`, a no-op when size and format already match), or none
with `scale_cuda` / `vpp_qsv`.

## Measurements

Hidden VS Code 1.147.0 (`test/vscode/cases/cpu_4k.js`, `VPE_CPU_BENCH=1`, through `test/benchq.js`),
ffmpeg 9.0.2, i7-9700K (8 cores, no HT), RTX 4070 driver 581.15, Windows 10. Fresh profile per
variant (no GPU test record), seek-bar strip off (`VPE_THUMB_STRIP=0`), 20 s stream copies of the two
clips. CPU time of every process of the instance (Win32_Process kernel + user time, 12 s window from
2 s after the first frame), **% of one core** (800 % = the whole machine). The hidden window's
player area is about 1080 device pixels high, so the new automatic size is 1920×1080.
"Forced" rows hold the method with the test hook `VPE_NATIVE_METHOD` (what a stored GPU test result
choosing it does).

### hevc_10_2160p (SDR)

| Build | Method | Frames | ffmpeg | ext. host | network svc | renderer | GPU proc. | **Total** | Shown fps |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| before (fresh install) | auto (dxva2) | 3840×2160 | 114 | 81 | 50 | 72 | 50 | **367** | 30 |
| before, test record cuda | cuda + scale_cuda | 3840×2160 | 42 | 77 | 53 | 73 | 36 | **280** | 30 |
| before, forced | d3d11va | 3840×2160 | 136 | 86 | 58 | 72 | 50 | **403** | 30 |
| **after (fresh install)** | **cuda + scale_cuda** | **1920×1080** | **9** | **19** | **10** | **28** | **30** | **96** | **30** |
| after, forced | d3d11va | 1920×1080 | 81 | 22 | 12 | 32 | 43 | 190 | 30 |
| after, forced | auto (dxva2) | 1920×1080 | 59 | 20 | 11 | 27 | 42 | 159 | 30 |

### hevc_10_pq_2160p (PQ, tone-mapped on the SDR display)

| Build | Method | Frames | ffmpeg | ext. host | network svc | renderer | GPU proc. | **Total** | Shown fps |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| before (fresh install) | auto (dxva2) | 3840×2160 | 48 | 43 | 32 | 59 | 37 | 219 | **14.5** (ffmpeg read 9 fps) |
| before, test record cuda | cuda + scale_cuda | 3840×2160 | 38 | 76 | 56 | 77 | 38 | **285** | 30 |
| before, forced | d3d11va | 3840×2160 | 124 | 84 | 52 | 81 | 48 | **390** | 30 |
| **after (fresh install)** | **cuda + scale_cuda** | **1920×1080** | **10** | **20** | **12** | **32** | **32** | **106** | **30** |
| after, forced | d3d11va | 1920×1080 | 77 | 22 | 12 | 35 | 39 | 185 | 30 |
| after, forced | auto (dxva2) | 1920×1080 | 55 | 21 | 14 | 31 | 40 | 161 | 30 |

So a fresh install goes from ~3.7 cores to ~1 core (−74 %) for the SDR clip at the same 30 fps;
the method alone (cuda against auto, both at 4K) saves ~0.9 core, the picture-sized frames another
~1.8. Playback stayed at the source rate in every "after" row (fps windows 29.5-30.5; native stats:
read 30 fps, sent 30 fps, webview never waited for ffmpeg).

### ffmpeg alone (no VS Code)

`ffmpeg -re -benchmark … -t 10 -f rawvideo NUL`, 4K HEVC 10-bit at real-time pace, output 3840×2160
`yuv420p`; CPU = (utime + stime) / rtime:

| method | CPU (% of a core) |
|---|---:|
| `-hwaccel auto` (dxva2, P010 download + swscale) | 64 |
| `-hwaccel d3d11va` (P010 download + swscale) | 94 |
| `-hwaccel cuda` (P010 download + swscale) | 73 |
| `-hwaccel cuda -hwaccel_output_format cuda` + `scale_cuda=…:format=yuv420p,hwdownload` | 30 |
| software | 152 |

4K VP9 **8-bit** with CUDA: CPU swscale (NV12 → yuv420p) 58 %, `scale_cuda` 30 %, output
byte-identical at full size. So `scale_cuda` now also takes 8-bit 4:2:0 HEVC, AV1, VP9 and H.264
(limited range; `yuvj420p` keeps the CPU path).

## What changed

- **`decide.vendorMethod`:** without a GPU test record the method comes from the GPU vendor
  `hardware.detect()` already reports (WMI on Windows, `lspci` on Linux; nothing is decoded):
  NVIDIA → `cuda` (scale_cuda), Intel → `qsv` (vpp_qsv, Windows), other Windows GPUs (AMD) →
  `d3d11va` (DXVA2, which `auto` picks, fell behind on the PQ clip), otherwise `auto`. The vendors
  are stored in globalState (`videoPreviewEnhanced.gpus`) and detected again once per session in
  the background; the first video ever waits for the detection alongside ffprobe (at most 2.5 s,
  then `auto`). A stored GPU test result still wins. The decision log says
  `GPU test not run yet: cuda for this GPU`.
- **Fallback for a guessed method (`src/native.js`):** a method that produces no picture now goes
  to `-hwaccel auto` first, then software (a test's choice goes straight to software, as before). The
  failure is remembered per ffmpeg installation and stream class (`failedMethods`, like the GPU
  filter failures of review 6 #3): later files of that class start with `auto`. The GPU filter retry
  (`scale_cuda` / `vpp_qsv` → CPU scaling with the same method) still comes first.
- **Picture-sized frames (`fitView`):** with the automatic `nativeMaxHeight` (0), the page sends its
  picture area (`#stage`, device pixels) with `open` and again after a resize or fullscreen (400 ms
  debounce); the frame height is the smallest of 1080 / 1440 / 2160 (540 / 720 too since docs/notes/perf-invisible.md) that holds it (either
  orientation, so turned phone videos are covered), still capped by the frame server's rate rule.
  Larger frames apply at once with a seek to the same moment (`refresh` → seek → `size`), so
  fullscreen gets sharper frames within a moment; smaller ones wait for the next seek or loop (no
  restart each time a picture is dragged back and forth across a step). The ffmpeg started before the page uses the last player's size.
  Pixel tools already offer the built-in decoder when frames are scaled (`lossy()`). A number in
  `nativeMaxHeight` disables this. Compare tiles are sized by compare as before.
- Test hooks (VPE_LOG only): `VPE_NATIVE_METHOD` holds the method, `VPE_THUMB_STRIP=0` leaves out the
  background thumbnail strip. `test/vscode/cases/cpu_4k.js` (only with `VPE_CPU_BENCH=1`) measures.

## Not done / ideas

- The frame transport is still the main cost after the fix (~0.8 core at 1080p30 across host,
  network service, renderer and GPU process; ~2.4 cores at 4K30). Each frame crosses the
  extension host → TCP → network service → renderer → GPU process. A compressed intra format, or
  only sending frames that are shown (paused / hidden tabs already stop), would be the next step.
- Intel QSV and AMD D3D11VA as no-test defaults are unmeasured here (no such GPU); the fallback chain
  covers a method that fails outright, not one that is merely slow.
- HDR output (10-bit frames to an HDR display) still converts and scales on the CPU (the GPU filters
  only produce 8-bit).
- The seek-bar thumbnail strip (a parallel branch makes it hover-only) was left out of these numbers.

## Follow-up: `case/native-transfer-resize` (2026-11-20)

The first real run failed ("frames did not grow to 3840x2160 (sizes [3840x2160, 1920x1080, 3840x2160 ...])").
The product did what it should: the prestart guessed 4K (no picture size known yet in a fresh profile), the page's
`open` restarted it at 1080p, the resize grew it to 2160p. The test's patterns were built with
``new RegExp(`… [\d.]+ …`)``: a template literal turns `\d` into `d`, so none of the three waits could ever match.
Fixed in the case (`\d`), which now also fails when growing takes more than 4 s. Two product gaps found on the way:
`lastView` (the size a prestarted ffmpeg uses) only followed resizes, not the size sent with `open`, so a later
video's prestart kept guessing and restarting; and a move to a screen with another scale (same CSS size) did
not re-send the picture size. Both fixed (`src/extension.js`, `media/player.js`).

Zoom (2026-11-20): the zoom/pan tool (Ctrl+wheel, `media/inspect.js`) now counts as a bigger picture.
The page sends the zoomed picture's size (canvas size × zoom, marked `zoomed`, not kept as the next prestart's
guess), so 330 % on a 1080p-fitted 4K video asks for 2160p frames at once; Z back to fit shrinks at the next
seek. When the frames change size while zoomed, the zoom factor is rescaled so the picture keeps its size and
position on screen. `case/native-transfer-resize` checks both (test hook: the `wheel` debug action).
