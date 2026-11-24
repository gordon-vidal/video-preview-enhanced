# Seek-bar previews (YouTube-style), 2026-11-19

Goal: a picture over the seek bar on hover and while the mouse is held and dragged, in
every decode path and in simple mode; while dragging the main picture follows live; exact frame on release.

**Update 2026-11-20: lazy.** The background strip described below was removed. Nothing decodes until the
pointer is on the seek bar (hover or drag); see "Design (current)". The older strip text and numbers are kept as history.

## Findings: when the old hover thumbnail worked, and why not

Before this branch `engine.thumbnail()` (media/engine.js) made a `ThumbService` (media/thumbs.js) on the
first hover: a second, keyframe-only libav.js worker (media/thumbs-worker.js) reading the file through the
engine's block cache. After the first hover it prefetched 24 evenly spaced places while playback was not
busy, and stopped the worker a minute after the last hover.

| Situation | Before | Why |
|---|---|---|
| Simple and advanced mode | worked (same) | `#thumb` is not hidden in simple mode; nothing mode-specific |
| WebCodecs (H.264, VP8) | worked | the thumbnail worker decodes in software (libav.js), independent of playback's decoder |
| WebAssembly (HEVC, VP9, AV1, MPEG-2, ...) | worked, slow first picture | one keyframe decode in WASM per place: 4K HEVC keyframes take hundreds of ms; the first hover also pays the worker start (fetch + WASM instantiate) |
| Long-GOP 4K | worked, but only keyframe granularity | thumbnails are keyframes (worker seeks to the keyframe at or before t); a 10 s GOP gives the same picture across 10 s |
| Native ffmpeg | **none** | `thumbnail()` returned false for `cfg.native`: that path never loads libav.js (`libavBlobs` is null) |
| Live transcode / remote stream (ffmpeg on this or the remote host) | **host keyframe previews** | the same `sendThumb` path as native ffmpeg: a separate keyframe-only ffmpeg on the source file, never the running stream |
| Remote file read over SSH (no stream) | hover only, no prefetch | every thumbnail costs at least one 4 MB block over the link |
| MJPEG AVI / image sequences (FramePlayer) | none | no libav; every frame is already a picture, but no thumbnail path was written |
| While dragging | **no thumbnail** | the tip followed `mousemove` only; during a drag the slider owns the pointer and the tip was not updated from `input`. The main picture already followed the drag (player.js frameLoop applies the newest `pendingSeekFrame` once the previous seek landed: exact seeks, newest wins) |
| First hover | blank until decoded | nothing was decoded before the first hover |

## Design (current, lazy)

- **No strip, no prefill.** Nothing is started after open: no thumbnail service, worker, request or ffmpeg process
  before the first hover (`engine.thumbStripSoon`, `strip()`, `cfg.thumbStrip*` and the pace/strip timers are gone).
- **Drag and release.** The slider and time display follow the pointer. The preview tooltip shows a nearby
  keyframe while the main picture holds its last committed frame and audio scheduling pauses. Compare previews
  the clock tile and holds all tile pictures. Release cancels preview work and commits the exact frame through
  the usual seek and synchronization path. A cancelled drag returns to the committed position.
- **Preview requests.** One decode can run at a time. Pointer movement replaces its pending target. Ordinary
  hover can fill nearby missing slots when playback has room and the file is local. Active drags and remote
  files skip this work. Live transcode, URL inputs and image sequences retain the committed picture while
  dragging.
- **Preview cache.** The tooltip stores scaled images under the tab's thumbnail byte budget. It reuses covered
  time ranges from successful keyframe landings. Releasing a drag stops the preview worker or native ffmpeg
  job and retains the cached pictures. Native ffmpeg reports the decoded keyframe timestamp with its pixels.
- Tests: test/host/seek_preview_test.js, test/vscode/cases/seek_preview.js, inspect thumbs/seek-bar (asserting no
  service/log lines before the first hover, one picture after, no requests after leaving or after the drag ends).

## Design before 2026-11-20 (strip, history)

All logic in media/thumbs.js and the engine's thumbnail section; player.js only shows the tip.

- **Strip by default.** 2 s after the first frame, `engine.thumbStripSoon()` makes the service and calls
  `strip()`: up to 100 evenly spaced places (at 160x120 RGBA: 7.7 MB), fewer when the thumbnail budget
  (`mem.thumbs` from media/membudget.js: 30 / 15 / 8 MB) is small (80 % of it at most). Order is coarse to
  fine (middle, quarters, eighths, ...), so a partial strip already covers the whole bar.
  Low priority: one picture at a time, nothing while playback is behind (`thumbsBusy()`: status warning,
  `behindUntil`, or less than 0.5 s decoded ahead while playing), and at most one picture per 250 ms while
  playing (`pace`). When the strip is complete and nobody hovers, the worker is terminated (its WASM
  memory freed); the pictures stay. Settings hooks: `cfg.thumbStrip === false` turns it off,
  `cfg.thumbStripDelay` (ms).
- **Instant picture.** `hover()` with no exact picture yet answers at once with the nearest cached
  place (`nearest()`), then the exact keyframe replaces it when decoded (latest hover wins; a running
  request for another place is cancelled in the worker).
- **Drag.** player.js: `pointerdown` on the bar marks a drag; the slider's `input` event moves the tip and
  asks for a thumbnail at the slider value (so the thumbnail follows even when the pointer leaves the
  bar); `mouseleave` during a drag does not hide it; `pointerup` off the bar hides it. The main picture keeps
  the existing behaviour: newest slider value is seeked once the previous seek has landed (exact frame
  decode, throttled by the decoder itself); `change` seeks exactly to the release frame. Frame-accurate
  seeks, A-B loop, pause and step are untouched (no engine seek code changed).
- **Native ffmpeg.** `ThumbService` takes `o.request(t, w, h)` instead of a worker. The engine posts
  `{type: 'thumb', id, t, w, h}`; the extension host (src/extension.js `sendThumb`, src/thumbhost.js) runs,
  one at a time per player:
  `ffmpeg -noautorotate -skip_frame nokey -noaccurate_seek -ss T -i FILE -map 0:v:0 -fps_mode passthrough -frames:v 1 -vf scale=W:H -f rawvideo -pix_fmt rgba -`
  and answers with the RGBA. `-noaccurate_seek` and passthrough timing are required: with only
  keyframes decoded, the keyframe before T is otherwise dropped as "before the cut" and nothing comes out
  (found by test). Legacy ffmpeg (no `-fps_mode`) gets `-vsync 0`. ffmpeg only decodes (docs/PRODUCT.md).
- **Live transcode (local or remote host):** `sendThumb` also accepts the `EncodedStream`; each thumbnail is one
  keyframe-only ffmpeg on the host (~20-60 KB over the link) with the same single-flight, abort and `kt` reply as
  native ffmpeg. URL tabs stay without. Remote files without the stream: hover works, no strip.

## Numbers

Host (node test/host/seek_preview_test.js, this machine), native ffmpeg one thumbnail incl. process start:

| Clip | ms per thumbnail |
|---|---|
| long_20s.mp4 (320x180 H.264) | 50-60 |
| h264_8_2160p.mp4 (4K H.264) | 156 |
| hevc_10_2160p.mp4 (4K HEVC 10-bit) | 233 |

So a full native strip of 100 places is about 6 s (small) to 15-25 s (4K), sequential, one core at a time
(ffmpeg's decoder threads during a single keyframe); paused or when playback is ahead.

Memory: 100 x 160x120x4 = 7.7 MB of ImageBitmaps (cap 30 / 15 / 8 MB by machine size); the WASM
thumbnail worker (one libav.js instance, ~30-60 MB) lives only while the strip fills or someone hovers.

Real VS Code 1.147 (test/vscode/cases/seek_preview.js, 20 s 320x180 clips, keyframe every 25 frames, paused):

| Path | strip places | pictures decoded | time to full strip (from strip start) | test saw first frame -> full strip (includes the 2 s start delay, polled) | memory |
|---|---|---|---|---|---|
| WebAssembly (MPEG-2) | 100/100 | 23 (places sharing a keyframe reuse it) | 116-119 ms (worker ready in 50 ms) | 1.2-1.6 s | 1.3 MB |
| native ffmpeg (HEVC) | 100/100 | 100 (one ffmpeg per place, no keyframe sharing) | 5.5-6.0 s | 7.0-7.4 s | 5.8 MB |

CPU impact on playback: not measured in a dedicated run (out of time). By construction the strip runs one
picture at a time, never while playback is behind or less than 0.5 s ahead, and at most every 250 ms while
playing; the WASM worker is terminated when the strip is complete. A 4K long-GOP HEVC file in WebAssembly
is the expensive case (one 4K keyframe decode per place, ~0.3-1 s of one core each): left to measure with
`startup`/`playback` cases while the strip runs.

## Tests

- `test/host/seek_preview_test.js`: coarse-to-fine order; strip of 100 through the request path, one at a
  time, waits while busy; nearest picture at once then the exact one; small budget gives fewer places
  within the cap; no strip for remote files; thumbhost args and real ffmpeg decode (RGBA of the box, not
  black, null for a missing file).
- `test/vscode/cases/seek_preview.js` (`case/seek_preview/wasm`, `case/seek_preview_native/native`):
  20 s MPEG-2 (WebAssembly) and HEVC (native ffmpeg) clips with a keyframe every second, simple mode:
  the strip completes without hover; hover shows a picture within 1.5 s; a synthetic drag (pointerdown,
  slider `input` at 6 places, the `scrub` test hook) shows a thumbnail at every place and they change, and
  the main picture moves; release (change + pointerup) lands on exactly the slider frame (ffmpeg
  reference), and a later seek and step stay exact.
- `test/vscode/cases/inspect.js` thumbs/seek-bar: the "no worker before the first hover" check is gone
  (the strip starts it on purpose).

## Test results (2026-11-19, 23:10)

- `node test/host/run_all.js`: 42 passed, 0 failed, 1 skipped (avi_scan_test.js, needs input files);
  includes the new seek_preview_test.js (native thumbnail 50-60 ms on long_20s.mp4).
- Real VS Code through benchq, `--quick --grep "^case/seek_preview"`: 0 failed of 2
  (test/vscode/out/run-2026-11-19T22-09-35-971Z.json). Both paths: strip 100/100 without hover, hover
  picture at once, 6 different thumbnails at 6 drag places, the main picture followed the drag
  (frames 90, 180, 270, 359, 449, 539 of 600), release landed exactly on the slider frame (ffmpeg
  reference), seek to 5.5 s and one step after it exact.

## Left to do

- Remote files read over SSH: hover only, no strip.
- MJPEG AVI / image sequences (FramePlayer): no thumbnails (could draw the decoded JPEG frames directly).
- Live main picture while dragging is the existing exact-seek loop (newest wins after the previous seek
  lands). On long-GOP 4K in WebAssembly each exact seek can take seconds, so the picture lags; a
  keyframe-only "scrub seek" in decoder-worker.js (show the keyframe, skip the rest of the GOP until
  release) would make it fluid. Not done: it touches the seek path, which must stay frame-accurate.
- CPU impact of the strip on playback not measured in a dedicated run; worst case is 4K long-GOP HEVC in
  WebAssembly while playing (one 4K keyframe per 250 ms at most, only while >= 0.5 s is decoded ahead).
- Native strip makes one ffmpeg process per place (100 processes, ~6 s for small, ~15-25 s estimated
  for 4K). One `ffmpeg -skip_frame nokey -i FILE -vf fps/select,scale -f rawvideo` pass over the whole
  file would be cheaper for short GOPs; per-place seeks are cheaper for long files with long GOPs.
- UI: the tip/thumbnail markup is still player.js's; the redesign only needs to call
  `player.thumbnail(t, cb)` / `player.thumbnailLeave()` and draw with `ThumbService.draw()`.

## Regression runs

- Real VS Code (benchq, --quick): `case/inspect` --sub thumbs: 0 failed of 1
  (thumbs/seek-bar); `case/(modes|seeking)`: 0 failed of 30 (all seeking paths frame-exact, A-B loop,
  simple/advanced mode) (test/vscode/out/run-2026-11-19T22-24-17-741Z.json).
