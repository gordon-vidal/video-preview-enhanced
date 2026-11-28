# Seek-bar previews

Goal: a picture over the seek bar on hover and while the seek bar is dragged, in every decode path and in simple mode.
While dragging, the main picture holds; release lands on the exact frame.

This note has two parts: how previews work today (checked against the code on 2026-11-28, after phase 5 of the plan)
and the plan for pictures between keyframes, with the maintainer's decisions (see "Decisions").

## How it works today

- **Grid and box** ([thumbs.js](../../media/thumbs.js)). N slots of X seconds along the bar,
  `X = max(D / 240, min(2 s, D / 20))` and at least one frame (`ThumbService.interval`): at least 20 pictures, 2 s
  apart up to 8 min, 240 beyond. Pictures fit a 160 x 120 box (160 x 90 for 16:9). One picture per slot is enough;
  a keyframe request asks for the slot's middle.
- **Free pictures from shown frames (phase 1).** After each frame is drawn, `engine.captureThumb(t)`
  ([engine.js](../../media/engine.js), section "seek-bar thumbnails") checks `ThumbService.wants(t)`: is there no
  picture inside t's slot yet? If so, it scales the WebGL canvas (already turned and tone-mapped) to the box with
  `createImageBitmap(canvas, {resizeWidth, resizeHeight, resizeQuality: 'low'})` and hands it over with `offer()`.
  This covers playback, seeks and steps in every decode path (WebCodecs, WASM, native ffmpeg, Live transcode,
  including its sharp paused frames). At most one capture per slot and one at a time; none while playback is behind
  (`playbackBehind()`: a status warning or a recent catch-up), while hidden, or for the non-clock tiles of Compare.
  No worker, request or ffmpeg process is started for it. The service object may therefore exist before the first
  hover (implied decision A, accepted).
- **Background keyframe pass (phase 3).** After the first frame drawn while the tab is visible on the clock tile,
  `engine.armThumbPass()` arms one pass per file (`ThumbService.passArm`); it starts 3 s later. It walks the slots
  coarse to fine (middle, quarters, eighths ...: `coarseToFine`), skipping slots that already have a picture or whose
  keyframe is known from earlier replies, and asks for each the same `near` / `key` request as a hover, one at a
  time. **Pacing**: keyframe asks (`key`, `near`, `run`) decode about half the time (`PASS_DUTY_KEYS`), the fill's
  sweeps about a quarter (`PASS_DUTY`; at a quarter for keyframes too, the 1 h 1080p HEVC bar took 93 s instead of
  46 s, maintainer 2026-11-28). A request that took m ms of wall time and reported c ms of CPU counts max(m, c), and
  the next starts that / duty after it began, by the kind of the request that just ended.
  The CPU (native ffmpeg's `-benchmark`, plus 200 ms of GPU start-up for a GPU sweep) only counts when it is more than
  the wall time; a GPU sweep that uses little CPU is still paced by its wall time (the GPU decoder and the disk are
  shared with playback). While the pointer rests on the bar (not dragging, not playing) sweeps speed up to half the
  time (`PASS_DUTY_HOVER`): the general fill goes on, the pointer's own slot, its refine and its neighbours always come
  first. No budget: Live transcode and native ffmpeg in a remote window pace and finish like a
  local file. It pauses while `thumbsBusy()`, while the tab is hidden, while the pointer drags and while another
  Compare tile sets the clock, and looks again every 500 ms. Pointer work always wins: a hover whose slot or
  neighbours need a picture, a drag, or a refine that is due cancels a running pass request, and a pass request is
  cancelled within 100 ms when one of those pauses begins; a cancelled slot is asked for again first. A hover with
  nothing to do and leaving the bar leave it running. Each slot is tried once, so pictures evicted under `mem.thumbs`
  are not decoded again. The pass stops when every slot is answered and the fill below is done (`done:complete`);
  the worker then closes at once (the 20 s idle time counts from the last hover), and native ffmpeg has already
  exited. A short busy spell keeps the worker; a pause longer than 20 s, hidden or another clock tile lets it close
  and start again later.
  None for a remote file read by the worker (each keyframe would be a file block over the link), URLs, image
  sequences and audio-only files. `VPE_THUMB_PASS=0` (benches, with `VPE_LOG`) and the debug probe's `thumbPass`
  turn it off, the fill included.
- **Fill (phases 4 and 5).** When the keyframe pass has nothing left, the same pass state goes on for every file
  (`ThumbService.fillNext`): it gives each slot a picture of its own, that is a picture whose time lies inside the
  slot (keyframes, captures and refines all count; a slot that had one which was evicted counts too). First the
  **floor**: min(N, 20) evenly spread slots, coarse to fine, so every bar soon has 20 distinct pictures; short-GOP
  files already have them from the keyframe pass and pay nothing. A floor request (`sweep`) covers the whole GOP of
  its slot: from the GOP's first slot without a picture to its last one before the next known keyframe, so the decode
  from the keyframe is paid once per GOP (one-slot sweeps decoded the same GOP prefix once per slot: 18 sweeps and
  5.2 s of CPU on a 20 s 1080p H.264 clip with a 10 s GOP, against 2 sweeps and 0.65 s now). Then every other slot,
  coarse to fine, in stretches: from the slot's middle to the first known keyframe about 1 s of estimated decoding
  later (`FILL_CHUNK_MS`), or one whose GOP has nothing left to fill, or the end; then trimmed to its last empty slot.
  No GOP is decoded twice, a cancel loses at most one stretch, and the next starts on a keyframe; a cancelled stretch
  starts again from its first empty slot (restartable, not resumable within a stretch); each slot is swept once. Cost per frame (for the stretch length only): `frameMs` (the refines' measured cost, else
  the engine's first guess: 1 ns per source pixel native, `PER_PX_WASM` = 3.5 ns for the worker), replaced by each
  stretch's measured wall time per frame. There is no cost gate: pace and pauses are the keyframe pass's.
  A stretch keeps the first frame at or after each slot's middle. Native ffmpeg: one process per stretch, `-threads 1`,
  below-normal priority, accurate seek, a `select` filter (first frame in each step), mjpeg out, `-frames:v` = slots
  in the stretch, `-benchmark` for its CPU time; **on the GPU** when one is known (below) and the estimated software
  decode of the stretch (from its keyframe, with `frameMs`) is at least 300 ms (`GPU_WORTH_MS`: GPU start-up costs
  0.2-0.3 s of CPU, so short stretches close to a keyframe stay software), else in software with
  `skip_frame noref`, `skip_loop_filter all`, `flags2 fast` and `fast_bilinear` (with `noref` a frame or two later).
  WASM: one `sweep` job in the preview worker (software, the same cheap flags). Same pauses, cancellation, clock-tile
  rule and exclusions as the keyframe pass. `stats0().pass` reports `floorS` and `fullS` (seconds from the pass's
  arming to the floor and to a full bar) and `between` (`state`, requests, pictures, ms, `cpu`, `gpu`).
- **GPU for the fill (native ffmpeg and Live transcode, phase 5).** Sweeps decode with
  `-hwaccel <m> -hwaccel_output_format <surface>` and `select`, then `hwdownload,format=nv12|p010le` (by the source's
  depth) and `scale=160:90:flags=fast_bilinear`; with cuda and `scale_cuda` in the build,
  `scale_cuda=W:H:format=nv12,hwdownload,format=nv12`. The kept frames are selected before the download, so only
  they leave the GPU; the software skip flags do not apply. Order (`hwaccel.previewMethods`, not playback's
  `methodOrder`): Windows d3d12va, cuda with an NVIDIA GPU, then d3d11va (its copies cost several times the CPU of
  the other two, still far below software); Linux vaapi (with a render node) and cuda; macOS videotoolbox. The GPUs
  are the extension's stored detection (`hardware.detect()`); none while unknown or with `gpuDecoding` off. A method
  that gives no picture (or names a fallback in ffmpeg's log, `hwaccel.fallbackReason`) is retried in software in the
  same request; when software finds pictures, that method is not tried again for that codec and depth while this
  ffmpeg is in use (the next method in the order is tried on the next sweep). `scale_d3d11` failed with -22 in ffmpeg
  9.0.2, so D3D surfaces are scaled on the CPU after the download. Hover pictures (`key`, `near`, `exact`) and
  keyframe runs stay software: GPU start-up costs about as much as one picture or 8 keyframes (measured below).
- **Native keyframe runs.** Once three keyframe intervals are known and their median g gives at most 1.25 keyframes
  per slot (X / g <= 1.25), native ffmpeg and Live transcode get `run` requests instead of one process per slot: one
  `-skip_frame nokey` ffmpeg decodes the next 8 keyframes from the first unanswered slot of a gap (one 37 ms process
  start for 8 pictures instead of 8, and every interval between them becomes known). With more keyframes per slot a
  run would decode keyframes no slot needs, so the pass keeps asking per slot (one `near` reply also covers a whole
  GOP). A run that reached the end of the file says so (`end`), so the last keyframe covers the rest. Runs stay
  software: 8 keyframes of 4K HEVC 10-bit cost 0.33-0.39 s of CPU in software, 0.28-0.30 s with d3d12va and
  0.19-0.25 s with cuda (whole process, i7-9700K + RTX 4070), and less in software for lighter codecs.
- **Pass cost (measured 2026-11-28 after phase 5, layer 4 `seek-pass-native` / `seek-pass-native-cpu` /
  `seek-pass-wasm`, i7-9700K + RTX 4070, Windows 10, ffmpeg 9.0.2).** Paused, from the first frame (3 s of it is the
  start delay): time to the floor and to a full bar (the same here: the floor's GOPs held every empty slot), decoder
  wall time of the keyframe pass and of the fill, and the fill's CPU as ffmpeg reports it (`-benchmark`, plus 200 ms
  per GPU sweep). Clips: generated 1080p HEVC 8-bit with a keyframe every 2 s; 1080p30 H.264 (x264 veryfast,
  B-frames) with a keyframe every 10 s; 4K HEVC 10-bit 2 min with keyframes 10 and 2 s apart (a 12 s clip looped).

  | Clip (slots) | Native, GPU (d3d12va) | Native, software (`gpuDecoding` off) | WASM worker |
  |---|---|---|---|
  | HEVC 20 s (20) | 10.7 s; keys 0.45 s; fill 10 sweeps (all software: short), 1.6 s, 1.2 s CPU | 10.3 s; keys 0.43 s; fill 1.5 s, 1.0 s CPU | 11.9 s; keys 0.17 s; fill 2.2 s |
  | HEVC 5 min (150) | 14.0 s; 23 asks (20 runs), 2.7 s; no fill needed | 13.8 s; same | 17.7 s; 149 asks, 3.5 s |
  | HEVC 1 h (240) | 92.7 s; 239 asks, 22.1 s (24 % of the time) | 91.3 s; 21.6 s | 30.2 s; 239 asks, 6.5 s |
  | H.264 20 s (20) | 6.8 s; fill 2 sweeps, 18 pictures, 1.3 s, 0.65 s CPU | 6.3 s; 2 sweeps, 1.1 s, 0.99 s CPU | 17.9 s; 5 sweeps, 4.3 s |
  | H.264 60 s (30) | 17.9 s; 6 sweeps, 24 pictures, 3.9 s, 1.8 s CPU | 15.4 s; 6 sweeps, 3.1 s, 2.9 s CPU | 29.2 s; 8 sweeps, 7.0 s |
  | 4K HEVC 10-bit 2 min (60) | 42.5 s; 10 sweeps, 40 pictures, 8.5 s, 3.5 s CPU | 157 s; 10 sweeps, 39.7 s, 39.2 s CPU | not measured (over the bench's 600 s budget: about 100 s of decoding at a quarter of the time) |

  CPU of the extension and webview processes stayed at 2-7 % of a core during the native fills (the ffmpeg children
  are too short-lived for the sampler; their CPU is the `-benchmark` figure above). The 1 h clip took 48 s before
  phase 5 because pacing then allowed half the wall time.

  Playback with the pass off and on (15 s of playback from 3.5 s after the first frame, twice each, one instance):

  | Clip | Native ffmpeg, off / on | WASM (H.264 through WebCodecs), off / on |
  |---|---|---|
  | 4K HEVC 10-bit 2 min (`hevc_10_2160p.mp4` x 60, a keyframe every 2 s) | 0 dropped, 0 late both; 484-485 shown both; CPU of the instance 54-65 % / 67-70 % (other processes 25 % at the start); the pass finished meanwhile (floor 15.9-17.2 s, full 17.5-18.5 s, 1 GPU sweep) | cannot play it in real time either way: 83-84 late off, 85-88 on, 142-156 shown; 127-131 % / 133-138 %; the pass stays paused as busy |
  | 1080p H.264 20 s, 10 s GOP | 0 and 0 both; 485-490 / 486-487 shown; 45-55 % / 53-58 %; the fill finished meanwhile (2 GPU sweeps, 0.65 s CPU) | 0 and 0 both; 485-490 / 477-485 shown; 31-48 % / 33-44 % |

  So the pass adds no dropped or late frames. The instance's CPU rose by a few points of a core with the native pass
  on, within the spread between runs of the same mode.
- **Keyframes at hover.** When the pointer's slot has no picture
  of its own, the backend returns the **nearer keyframe on either side** of the slot's middle (phase 2). A request
  whose keyframes are unknown is a `near` request: the worker finds the keyframe after through the demuxer index
  (`avformat_seek_file` to the first keyframe after T, one packet read, nothing decoded) and decodes the nearer one;
  native ffmpeg decodes both (`-frames:v 2`) and returns both pictures. Each reply teaches the service the two
  keyframe times around T (`keys`, with the next keyframe, or none to the end); a later slot inside a known GOP asks
  for the nearer keyframe by its time (`key` mode, one picture) or needs no request when that picture is there.
  A 10 s GOP that was not played errs by at most 5 s, not 10 s.
- **Refine while the pointer rests (phase 2, the thumbfast pattern).** When the pointer has stayed REST_MS = 250 ms in
  a slot whose best picture is more than X from the slot's middle, one `exact` request decodes that picture cheaply
  (worker `between` mode; native `-skip_frame noref -skip_loop_filter all -flags2 fast`, accurate seek,
  `fast_bilinear`), and the frame becomes a picture of its own. Only when the estimate fits the budget:
  cost = median keyframe request + frames from the keyframe to the target x `frameMs`; budget 0.5 s while playing,
  2 s paused (estimated decoder wall time). `frameMs` starts at about 1 ns per source pixel for native ffmpeg (not
  the smaller picture it sends the page) and 3.5 ns for the worker (engine.js `PER_PX_WASM`) and follows each
  refine's measured cost. Moving to another slot cancels a running refine; none while dragging, while `thumbsBusy()`, for slots refined before, or for a remote file read by
  the worker (a GOP of blocks over the link). Skips are counted (`stats0().skipped`).
- **Order of work.** The slot under the pointer comes first (its keyframe), then its refine, then up to 4 neighbouring
  slots on each side; the newest position wins (40 ms debounce, one request in flight). Neighbours are filled only
  when playback is not busy (`thumbsBusy()`: behind as above, or less than 0.5 s decoded ahead while playing), the
  file is local, and the pointer is not dragging (`hover(..., scrub = true)`). While busy the service looks again
  every 500 ms.
- **Leaving the bar** cancels the running request: a `cancel` to the worker, or an abort of the host job. The WASM
  worker closes 20 s after the last hover (`idleMs`) unless the pass still runs. The pictures stay cached.
- **Storage.** One list of entries sorted by source time, `{t, kind: 'key' | 'frame', end, jpeg, bmp}`. Every picture
  is kept as a JPEG (`OffscreenCanvas.convertToBlob`, quality 0.75, for captures and worker replies; native and Live
  transcode replies are JPEG already). At most 32 entries near the pointer also keep a ready `ImageBitmap` (`HOT`);
  a cold entry is decoded again on show, and the two slots on each side of the pointer are warmed. The byte budget
  counts real sizes (JPEG bytes plus 160 x 90 x 4 per hot bitmap) under `mem.thumbs`
  ([membudget.js](../../media/membudget.js): 30 / 15 / 8 MB by machine size; Compare divides it by the number of
  tiles in `compare-grid.js`). Captured JPEGs measured 3.3 KB each (layer 3, synthetic clips; 3-6 KB on real
  footage), so a full bar of 240 pictures plus 32 hot bitmaps takes about 2.6-3.3 MB and the 8 MB floor holds it.
  Over budget, bitmaps go first, then whole entries, least recently shown first (captures never shown go first).
- **Capture cost (measured 2026-11-27, layer 3 `playback` thumbs/capture-4k, 4K H.264 through WebCodecs).** The
  frame loop pays 0.1-0.2 ms per capture (the `createImageBitmap` call; the scaling finishes off the loop), 15
  captures in 3.5 s of playback, and the same dropped and late frames (0 and 0) with capture off and on.
- **Lookup** for the pointer at time T in slot s, all by binary search, so a picture is drawn at once:
  1. the slot's own picture: the entry inside slot s closest to T (a captured or refined frame, or a keyframe), else
     the keyframe answer for s: the entry a request returned for s, the nearer known keyframe's picture, or a key
     entry whose `end` covers the slot (a key entry at kt answers every time in [kt, end]);
  2. if the entry just before or just after T is closer to T than that, the closer one;
  3. without an own picture, the nearest entry anywhere, as a placeholder while the request runs.
- **Backends.**
  - **WASM worker** ([thumbs-worker.js](../../media/thumbs-worker.js)) for every file played through libav.js or
    WebCodecs. It is a second, single-threaded libav.js instance (`skip_frame nokey` between requests), reading
    through the engine's block cache as reader `thumbs`. `key` / `near` decode one keyframe packet, scale it with
    swscale bilinear and post RGBA. For formats without an index (MPEG-PS/TS), where a seek can land past the
    keyframe, it steps back 2, 6, 14 ... s (a keyframe after T counts as a miss), in all modes. `between` switches
    to `skip_frame noref`, `skip_loop_filter all`, `flags2 +fast`, decodes from the keyframe and keeps the last
    frame at or before T (with `noref`, a non-reference frame at T gives the reference frame before it, within a
    frame or two).
  - **Native ffmpeg and Live transcode (local or remote host)** ([thumbhost.js](../../src/thumbhost.js) through
    `unified-viewer.js` `onThumb`). One short ffmpeg per request, on the source file, never the running stream; key
    modes: `-skip_frame nokey -noaccurate_seek -threads 2 -ss T -i FILE ... -vf scale=W:H:flags=bilinear,showinfo
    -c:v mjpeg -q:v 6` (`near`: `-frames:v 2`, `run`: `-frames:v 8`), exact mode as above, sweeps as in "Fill"; pass
    requests use `-threads 1` and `-benchmark`. It runs at below-normal priority, with one job per viewer (a new request aborts the old one), an 8 s
    timeout (20 s for a run) and no job while the panel is hidden. The reply is a JPEG of at most 25 KB with its time
    read from `showinfo`, plus the next keyframe's JPEG and time for `near` (`kn: null` when there is none), or the
    further keyframes (`more`) and `end` for a run.
  - **None** for URL inputs, MJPEG AVI and image sequences (FramePlayer), and audio-only files.
- **Drag and release.** The slider and time follow the pointer. The tooltip shows a cached picture or a decoded
  keyframe. The main picture keeps its last committed frame and audio scheduling pauses. Compare previews the clock
  tile and holds all tile pictures. Release cancels preview work and commits the exact frame through the usual seek
  and sync path. A cancelled drag returns to the committed position. Design of the drag:
  [fast-scrubbing-architecture.md](fast-scrubbing-architecture.md).
- **Refine cost (measured 2026-11-27, `node test/thumbs/scrub_bench.js between`, i7-9700K, generated 12 s clips
  with keyframes at 0 and 10 s, median of 3).** Wall time of one exact picture 1 / 5 / 9 s after a keyframe:

  | Clip | Native ffmpeg | WASM worker |
  |---|---|---|
  | H.264 1080p30 | 0.10 / 0.26 / 0.41 s | 0.15 / 0.55 / 0.93 s (3.4 ms per frame) |
  | HEVC 10-bit 2160p30 | 0.41 / 1.36 / 2.30 s | 0.94 / 4.29 / 7.56 s (27.5 ms per frame) |

  So paused, native refines 1080p everywhere and 4K HEVC up to about 7-8 s after a keyframe; the worker refines 1080p
  H.264 everywhere and 4K HEVC within about 2 s of a keyframe. While playing (0.5 s), native 1080p still fits, 4K
  HEVC only within about 1 s. Past those points the nearer keyframe stays; slots within X of the next keyframe need no
  refine anyway.
- **Tests.** [test/host/seek_preview_test.js](../../test/host/seek_preview_test.js) (grid, JPEG budget, captures,
  nearest at once, the nearer keyframe, refine after rest / cancelled by movement / not while dragging, busy or over
  budget, exact-mode ffmpeg pictures against ffmpeg's reference on a generated 10 s-GOP clip from
  [test/lib/gop_clip.js](../../test/lib/gop_clip.js)),
  [test/host/seek_preview_pass_test.js](../../test/host/seek_preview_pass_test.js) (the pass: delay, coarse to fine,
  skips answered slots, pauses and cancels while busy / hidden / dragging / another clock tile, resumes, completes and
  closes, goes on while the pointer rests and a hover with nothing to do leaves it running, pace by CPU or wall time
  and faster while resting, remote host files like local ones, none for remote worker files, the run rule, ffmpeg runs
  on a real clip; the fill: floor first and coarse to fine, every slot a picture of its own, captures count, no cost
  gate, evicted slots not swept again, pauses and cancels and restarts a stretch, never twice, one native ffmpeg per
  stretch against the reference on a generated 1080p H.264 10 s-GOP clip; the GPU: method order, arguments, software
  for hover and runs, fallback to software and a failed method not tried again),

  [test/thumbs/service.js](../../test/thumbs/service.js) (the real worker: sweep, neighbours, cache; `near` and
  `between` and `sweep` on the 10 s-GOP clip against the reference),
  [test/vscode/cases/seek_preview.js](../../test/vscode/cases/seek_preview.js) (`seek_preview` for WASM,
  `seek_preview_native`, each with pass, pass-hidden, between (the fill: floor, then a full bar), capture and refine
  cases; the hover cases turn the pass off),
  `playback` thumbs/capture-4k (same dropped and late frames with capture and pass off and on), `inspect`
  thumbs/seek-bar (a full bar before the first hover), the layer 4 benches `seek-pass-native` / `seek-pass-wasm` /
  `seek-pass-native-cpu` ([test/vscode/cases/seek_pass_perf.js](../../test/vscode/cases/seek_pass_perf.js)), and the bench
  [test/thumbs/scrub_bench.js](../../test/thumbs/scrub_bench.js) (`key` and `between`).
### Limits that motivate the plan

1. Keyframe granularity: long GOPs (camera files, streaming encodes with 4-10 s GOPs) give a few distinct pictures
   per minute. (Phase 2 shows the nearer keyframe and refines where the pointer rests, within a budget; phases 4 and 5
   give every slot its own picture after open.)
2. (Solved in phase 3 for keyframes: the background pass fills the bar after open.)
3. (Solved in phase 1: frames the player shows are kept as pictures.)
4. Native and Live transcode start one process per picture (about 37 ms of process start on Windows, measured
   below).
5. Each picture is decoded at full resolution and then scaled. For keyframes this is unavoidable in H.264, HEVC, VP9
   and AV1.

## What other players do

Sources were checked on 2026-11-27. Items marked *unverified* rest on forum posts or could not be confirmed.

| Player | Interval / count | Size | Keyframe or exact | When | Cache |
|---|---|---|---|---|---|
| YouTube storyboards | Level 0: 100 pictures per video. Higher levels: one picture every 2 s (seen on a 4 min video) or 10 s (19 min and 1 h videos); the rule is unpublished | 48x27, 80x45, 160x90, 320x180 | made on the server | made in advance | JPEG sprite sheets on a CDN (10x10, 5x5, 3x3) [^yt] |
| Jellyfin trickplay | fixed 10 s (at least 1 s) | 320 wide | exact by default; "key frame only" (`-skip_frame nokey`) is an option, off by default | scheduled task or library scan: one ffmpeg pass per file (`fps=` filter), 1 thread, BelowNormal priority, no hardware decoding by default | JPEG 10x10 tiles kept forever next to the media or in metadata [^jf] |
| Plex | 2 s (*unverified*) | 320x240 (*unverified*) | keyframes only by default (*forum*) | maintenance task, often 10+ min of heavy CPU per movie | 10-50 MB per item, in Plex's database [^plex] |
| Emby | 10 s or chapter marks | *unverified* | *unverified* | scheduled task | BIF next to the media or in metadata [^emby] |
| mpv + thumbfast (uosc) | on demand | at most 200x200 | keyframe seek first, then one exact seek (files of 30 s or longer; shorter files always exact) | at hover, one long-lived hidden mpv: `skiploopfilter=all`, `vd-lavc-fast`, 2 threads, `fast-bilinear`, no hardware decoding, off for network streams | none [^tf] |
| IINA | count-based: duration / 100 | 120 wide | nearest keyframe (seek backward, keep the first frame) | background pass over the whole file on open; serial queue; partial results shown as they come; off for remote files | disk, 500 MiB LRU, keyed by file size and mtime [^iina] |
| MPC-HC / MPC-BE | on demand | small window (setting 5-40) | whatever a seek of a second DirectShow graph gives | at hover; off for URLs and discs; off by default in MPC-HC | none [^mpc] |
| VLC 4 | thumbnailer with fast and precise seek modes; no released seek-bar preview confirmed | | | | [^vlc] |
| Kodi | no seek-bar preview; chapter and bookmark pictures taken during playback | | | | [^kodi] |
| HLS / DASH | one picture per I-frame (`EXT-X-I-FRAMES-ONLY`) or image tile tracks | defined by the content | I-frames | made in advance | CDN [^hls] |

Lessons for VPE:

- **Two families.** Servers (YouTube, Jellyfin, Plex, Emby) build everything in advance at a fixed 2-10 s interval
  and about 160-320 px. Desktop players either decode at hover with a second decoder (thumbfast, MPC) or run one
  background pass per file with a count-based interval (IINA: 100 pictures).
- **Cheap decoding is standard.** thumbfast's skip loop filter, fast flags, 2 threads and fast-bilinear scaling, and
  Jellyfin's single thread at BelowNormal priority with hardware decoding off by default, match VPE's constraints.
- **Keyframe first, then refine** (thumbfast) is the pattern for long GOPs: show something at once, improve it
  while the pointer rests.
- **Nobody reuses frames the player already decoded.** That is a cheap VPE addition, approved by the maintainer.
- **Disk caches are large or unbounded** (Plex 10-50 MB per item, IINA 500 MiB, Jellyfin forever). This is the
  growth the maintainer does not want.

## Measurements (2026-11-27)

Machine: i7-9700K (8 cores), Windows 10, ffmpeg 9.0.2 (gyan.dev full build), software decoding unless noted. Clips
were generated locally (`testsrc2`), 60 s long with a keyframe every 10 s:

- **A**: H.264 1080p24, x264 veryfast with B-frames, 37 MB.
- **B**: HEVC Main10 2160p30, x265 ultrafast, 13.4 Mb/s, 101 MB.

Rows are ffmpeg `-benchmark` wall / CPU (utime) seconds, decoding to `-f null` with `scale=160:90`. Spawn rows ran
twice and agreed within about 15 %; pass rows ran once. Synthetic content: real footage changes the absolute numbers
(the ratios are what matter).

| Command | A (1080p H.264) | B (4K HEVC 10-bit) |
|---|---|---|
| Today: one keyframe per process (`-skip_frame nokey -noaccurate_seek`, 2 threads) | 0.04 / 0.03 | 0.17 / 0.09-0.19 |
| Same with `-hwaccel d3d11va` | 0.08 | 0.21 |
| Exact frame near the end of a GOP (A: 9.9 s, B: 8 s after the keyframe), 2 threads | 0.45 / 0.86 | 3.5-4.1 / 6.3-6.9 |
| ... plus `-skip_loop_filter all -flags2 fast`, `fast_bilinear` | 0.40 / 0.80 | 3.2 / 5.8 |
| ... plus `-skip_frame noref` | 0.29 / 0.53 | 2.06 / 2.97 |
| Same cheap flags, 1 s after the keyframe | 0.06 / 0.08 | 0.36 / 0.50 |
| Exact near the end of a GOP with `-hwaccel d3d11va` | 0.34 / 0.50 (incl. system) | 3.2 / 2.9 (incl. system) |
| Whole file, keyframes only (6 pictures), one process | 0.07 / 0.14 | 0.37 / 0.28 |
| Whole file, every frame decoded, `fps=1/2` (30 pictures), 2 threads | 2.5 / 4.9 | 36.5 / 51.0 |
| ... 1 thread | 5.1 / 4.9 | 91 / 50 |
| ... 2 threads, `skip_loop_filter` + `fast` | 2.2 / 4.2 | 28.5 / 45.5 |
| ... 2 threads, plus `skip_frame noref` | 2.6 / 3.9 | 11.7 / 20.4 |
| ... `skip_frame bidir` instead | 1.8 / 2.9 | **wrong**: 25 of 30 pictures, ended at 50 s |
| 30 JPEGs at 160x90, `-q:v 6` | 79 KB (2.6 KB each) | 73 KB (2.4 KB each) |
| ffmpeg process start (`ffmpeg -version`) | 37 ms wall | |

The existing bench, `node test/thumbs/scrub_bench.js` (2 s 4K clips, 20 keyframe misses, p50 / p95):

- `hevc_10_2160p.mp4`: warm WASM worker 85 / 115 ms, native process 98 / 139 ms.
- `av1_10_2160p.mp4`: warm WASM worker 246 / 362 ms, native process 83 / 126 ms.

What the numbers say:

- **Keyframes are almost free** next to anything else: 30-190 ms of CPU each even at 4K, and a keyframe-only pass
  over a whole minute costs a fraction of a second.
- **A picture between keyframes costs the decode from the keyframe up to it.** Near the end of a 10 s GOP that is
  0.5 s of CPU at 1080p H.264 and 3-7 s at 4K HEVC.
- **Decoding a whole file to sample pictures costs about as much as playing it.** For B that is 51 s of CPU for 60 s
  of video. `skip_frame noref` with `skip_loop_filter` cuts it to 20 s here. The saving depends on the encoder: x264's
  B-pyramid leaves few non-reference frames, so A saves little.
- **`skip_frame bidir` is unsafe**: B-frames can be references (HEVC, H.264 B-pyramid). `noref` is the safe flag.
  It is valid for H.264, HEVC and MPEG-2 in libavcodec; elsewhere it is ignored or harmless (to check per codec in
  phase 2).
- **Hardware decoding does not help a one-off preview.** Device setup eats the gain for keyframes, and exact 4K HEVC
  was no faster than software with `noref`. Jellyfin and thumbfast also default to software. **A whole-file pass is
  different** (measured 2026-11-28, below): the GPU decodes it for a fraction of the CPU.
- **`lowres`** works only in a few old decoders (MJPEG, MPEG-1/2/4 Part 2, H.263, JPEG 2000, DV), not in H.264, HEVC,
  VP9 or AV1. A possible small extra for MPEG-2 and MJPEG; not measured.
- **A one-process pass** pays off only when it decodes everything anyway (short files, or keyframe-only passes with
  short GOPs). When slots are sparse relative to keyframes, one process per slot (37 ms start each) is cheaper than
  decoding every keyframe.

## GPU measurements (2026-11-28)

Machine: i7-9700K, RTX 4070, Windows 10, ffmpeg 9.0.2. A whole-file pass, one picture per slot, CPU = user + system
time. Pipeline: `-hwaccel <m> -hwaccel_output_format <m> -i FILE -an -vf "<select or fps>,hwdownload,
format=nv12|p010le,scale=160:90:flags=fast_bilinear"`; software uses the cheap flags (`noref`, no loop filter,
`fast`). Maintainer's runs:

| Clip | Software | d3d11va | d3d12va | cuda |
|---|---|---|---|---|
| 4K HEVC 10-bit, 2 min, 60 pictures | 52.8 s | 7.3 s | 1.5 s | 1.0 s |
| 4K H.264, 20 s | 5.0 s | 2.6 s | | 0.2 s |
| 1080p HEVC, 5 min, 150 pictures | 16.4 s | 3.5 s | | 1.2 s |
| 1080p H.264, 60 s | 3.2 s | 1.2 s | | 0.5 s |

All GPU runs of the 4K HEVC clip took about 6.5-7 s of wall time (the decoder's limit, about 530 frames per second).
Checked again here (`-benchmark`, which leaves out about 0.15-0.25 s of GPU start-up; whole-process CPU in brackets):

| 4K HEVC 10-bit 2 min (`hevc_10_2160p.mp4` x 60) | CPU (whole process) | Wall |
|---|---|---|
| software, cheap flags, 1 thread | 52.9 s | 52.5 s |
| d3d11va | 7.5 s | 6.7 s |
| d3d12va | 0.94 s (1.08-1.34 s) | 6.9 s |
| cuda, hwdownload then CPU scale | 0.92 s | 6.8 s |
| cuda, `scale_cuda` then hwdownload | 0.64 s | 6.7 s |

Short requests, whole process (twice each, i7-9700K + RTX 4070):

| Request | Software | d3d12va | cuda (`scale_cuda`) |
|---|---|---|---|
| One picture 1.9 s after a keyframe, 4K HEVC 10-bit (a floor sweep) | 0.98-1.05 s | 0.27-0.28 s | 0.17-0.19 s |
| 8 keyframes, 4K HEVC 10-bit (a run) | 0.33-0.39 s | 0.28-0.30 s | 0.19-0.25 s |
| 10 pictures over 20 s, 1080p H.264, 10 s GOP (`-benchmark`) | 0.98 s | 0.08 s | 0.09 s (d3d11va 0.34 s) |

So sweeps go to the GPU (even a one-slot floor sweep of 4K HEVC is cheaper there), runs and hover pictures stay
software (start-up eats the gain), and d3d11va comes last: still about 7x cheaper than software on 4K HEVC, but 5-8x
the CPU of d3d12va or cuda. `scale_d3d11` failed with -22 in this build; `-skip_frame` and friends do not apply on the
GPU. `format=nv12|p010` fails on 10-bit D3D surfaces (hwdownload needs the surface's own format), so the format
follows the source's depth.

## Plan (decided 2026-11-27; phases 1 to 5 built)

### Principles

1. Never cost playback. Preview work stays one-at-a-time, low priority, and stops while playback is behind (the
   existing `thumbsBusy()` rule).
2. Prefer pictures that cost nothing: frames already decoded for playback, seeks and steps.
3. Keyframe first, refine while the pointer rests (thumbfast). The preview stays approximate; release stays exact.
4. Small: one low-resolution picture per interval X, never per frame.
5. Each phase merges on its own and leaves the product working.

### Interval and count

```
X = max(D / 240, min(2 s, D / 20))      D = duration; X is also at least one frame
N = ceil(D / X)                          at most 240; at least 20 when D >= 20 frames
```

| Duration | X | Pictures |
|---|---|---|
| 10 s | 0.5 s | 20 |
| 20 s | 1 s | 20 |
| 1 min | 2 s | 30 |
| 5 min | 2 s | 150 |
| 10 min | 2.5 s | 240 |
| 2 h | 30 s | 240 |

This gives at least 20 pictures for short files, YouTube's 2 s for anything up to 8 min, and a fixed 240 beyond
that: about one picture per 4-5 px on a 1000 px bar, so a finer grid would not show. The slot grid of thumbs.js
(about 200 slots) becomes this grid. Keyframe pictures keep their own times. A slot's "between" picture is any
picture whose time lies inside the slot.

### Resolution and memory

- Keep the 160 px box (YouTube's middle level is 160x90; IINA uses 120 and thumbfast at most 200). Keyframe and
  between pictures use the same size, so the tooltip never changes size. 2x displays still get 160 px, as today.
- **Store pictures as JPEG, decode on show.** 240 bitmaps at 160x90 are 13.8 MB, over the 8 MB floor of
  `mem.thumbs`. As JPEGs they take 2.4-2.6 KB each (measured), so 240 pictures need about 0.6-1.5 MB. Keep a small
  hot set of `ImageBitmap`s (for example 32, 1.8 MB) for the pointer's neighbourhood. Native and Live transcode
  replies are JPEG already. The page would keep the reply instead of turning it into a bitmap at once.
  `createImageBitmap` of a 3 KB JPEG and `OffscreenCanvas.convertToBlob` for page-made pictures are estimated at
  1-3 ms each; phase 1 measures both.
- With JPEG storage, the byte budget stays `mem.thumbs` and holds far more than N pictures, so nothing new is needed
  in membudget.js. Compare keeps the per-tile split.

### Where pictures come from (in order of cost)

1. **Played, seeked and stepped frames (free, all paths).** In `engine.js`, `noteShown(show)` already sees every
   presented frame. When a frame's time falls in a slot with no between picture yet, the engine:
   - for a WebCodecs `VideoFrame`, makes `createImageBitmap(vf, {resizeWidth, resizeHeight, resizeQuality: 'low'})`
     before the frame is closed;
   - for YUV frames (WASM, native), takes the same resize from the GL canvas right after drawing, only while the view
     is unzoomed and unpanned (otherwise it skips that slot for now).

   One capture per X seconds of playback at most, none while playback is behind. This covers what the user has
   watched and every exact seek and step landing. It needs no worker and no ffmpeg. In Live transcode the frames are
   the transcoded rendition, which is fine at 160 px.
2. **Keyframe at hover (today's path).** Unchanged, plus one cheap improvement: once keyframe times are known, show
   the **nearest keyframe on either side** of the target, not only the one before. A 10 s GOP then errs by at most
   5 s instead of 10 s. Keyframe times can come from the demuxer index (MP4 `stss`, Matroska Cues, which libavformat
   already loads in the worker), from `kt` replies, or from a keyframe pass.
3. **Refine while the pointer rests (thumbfast pattern).** After the pointer has rested about 250 ms on a slot whose
   best picture is more than X away, ask for the picture at the slot's time, decoded cheaply:
   - **native**: `-skip_frame noref -skip_loop_filter all -flags2 fast -threads 2 -ss T` (accurate seek),
     `scale=...:flags=fast_bilinear`, mjpeg out;
   - **WASM worker**: a `between` request that sets `skip_frame noref`, `skip_loop_filter all` and `flags2 +fast`,
     decodes from the keyframe up to the target and keeps only the last frame at or before it.

   Do this only when the estimated cost fits a budget. Cost = frames from the keyframe to the target times the
   file's measured cost per frame: playback's decode rate, or the time the last keyframe decode took. Suggested
   budget: 0.5 s of CPU while playing and 2 s while paused. Measured: 1080p H.264 fits even at the end of a 10 s
   GOP; 4K HEVC fits only within about 3 s of a keyframe. Moving the pointer cancels the request. Not during a drag;
   a drag stays keyframe-only.
4. **Background keyframe pass (policy change, decision 1).** One pass per file, coarse to fine (middle, quarters,
   eighths ...) over the N slots, keyframes only. It pauses while `thumbsBusy()` and while the tab is hidden, and
   stops when the bar is complete. Native: per-slot processes, or one keyframe-only process over the whole file when
   the keyframes per slot are few (the index tells). Estimate: 240 slots x 40-200 ms = 10-50 s of one core,
   below-normal priority, spread over playback's idle time. A 1-min 4K HEVC file needs 0.3 s. Built as runs of 8 keyframes per ffmpeg
   (see "Native keyframe runs" above); measured: 21 s of one core for a 1 h file with 240 per-slot asks.
5. **Background between pass (policy change, decision 2).** Decode the file cheaply (`skip_frame noref` +
   `skip_loop_filter`) and keep one picture per slot. Measured for 60 s in software: 3.9 s of CPU at 1080p H.264,
   20 s at 4K HEVC. Phase 4 ran it for short or light files only (about 3 s of CPU); phase 5 runs it for every file,
   floor first, paced, and on the GPU for native ffmpeg (about 1 s of CPU for 2 min of 4K HEVC).

### Per decode path

| Path | Keyframes | Between keyframes | Notes |
|---|---|---|---|
| WebCodecs (H.264, VP8) | WASM worker (software). A WebCodecs `VideoDecoder` in the worker could decode H.264 keyframes in hardware, but it shares the GPU decoder with playback; not worth it while a 1080p keyframe is cheap in software. | (1) capture, (3) WASM refine. Later: a hardware `VideoDecoder` for a whole GOP while paused (hundreds of fps) is the cheapest between source for H.264; measure before building (phase 5). | The worker decodes in software even when playback uses the GPU. |
| WASM (HEVC, VP9, AV1, MPEG-2 ...) | WASM worker | (1) capture, (3) refine within budget (single-threaded WASM: tighter budget) | AV1 keyframes are 2-3x slower in WASM than native (bench). |
| Native ffmpeg | per-slot process; one-process keyframe pass where cheap | (1) capture, (3) `noref` + skip loop filter process, (5) the fill in stretches, on the GPU where available | hover pictures and runs software, 1-2 threads, below-normal priority |
| Live transcode (local or remote) | host process on the source file (today) | (1) capture of the transcoded frames, (3) host process | CPU runs on the host that holds the file |
| URL, image sequences, audio only | none | (1) capture only, if wanted | URLs: every preview would be HTTP range reads |

### Priority and impact on playback

- One preview job at a time per player and per Compare (`thumbJob` in unified-viewer.js), as today.
- The pointer's slot is served first, then refinement (3), then background passes (4, 5). A newer request replaces
  an older one.
- Background work runs only when `thumbsBusy()` is false, the tab is visible, and the window is not under the
  existing memory or status warnings. It checks again every 500 ms (the existing busy retry) and never runs while
  the pointer drags.
- Native processes stay at below-normal priority with `-threads 1` for passes and 2 for a single picture
  (Jellyfin: 1 thread). The pass is paced between requests (keyframes about half the time, sweeps about a quarter),
  never by throttling a running process.
- Capture (1) costs one small resize per X seconds of playback. Phase 1 verifies with layer 3 `playback` that the
  dropped-frame count does not change.

### Compare

- The tooltip previews the clock tile only (today). Capture and passes run for the clock tile only. The other tiles'
  pictures would never be shown, and Compare already divides the budget per tile.
- On release, tiles commit through the existing exact sync. Pictures from captures in non-clock tiles are not kept.

### Remote-SSH and Live transcode

- **Live transcode / native on a remote host.** Pictures travel as JPEG: about 2.5 KB at 160x90 measured, 3-6 KB on
  real footage (thumbhost.js). A full 240-picture bar is about 0.6-1.5 MB over the link. The decoding CPU is the
  remote host's: passes (4, 5) run there as on a local file (maintainer, 2026-11-28), GPU included.
- **Remote file read by the WASM worker (no stream).** Each keyframe costs at least one file block over the link
  (the worker asks for 1 MB or more). So capture (1) and hover (2, 3) only, and no passes, as today with
  `o.remote`.

### Merging with the existing cache

Replace `slotKt` + `coverage` + `nearest()` by one sorted list of entries `{t, kind: 'key' | 'frame', jpeg | bmp}`
keyed by the source time of the picture:

- **Lookup for target T**: the entry with the largest t <= T. If the next known keyframe after T is closer than that
  entry, use the keyframe after (rule 2). If the chosen entry is more than X from T, it is a placeholder and work is
  queued.
- A `key` entry at kt answers any T in [kt, next keyframe), which is what `coverage` records today. The keyframe
  index makes this explicit.
- Eviction stays LRU by bytes. Captured frames of slots the pointer never visited go first.
- The worker's `known` set and `forget` messages stay for keyframes.

### Optional: a tiny disk cache (decision 3)

The maintainer prefers no disk cache: a growing cache alarms people. If repeat opens of long files turn out to
matter, the smallest useful form would be:

- **What**: the JPEG strip and keyframe index of the last 10 videos opened, at most 240 x 3-6 KB = 0.7-1.5 MB per
  video. A hard total cap of 16 MB; the oldest entry is removed first.
- **Where**: `context.globalStorageUri` on the host that owns the file. Keyed by path, size and mtime (IINA does the
  same); a changed file misses.
- **Visible**: a command "Clear seek-bar preview cache"; the size is stated in the docs.

Recommendation: **not now.** Phases 1-3 make a re-open cheap anyway (keyframes 30-190 ms each, capture refills
during playback). Revisit only if measurements show re-opened long files are a real pain.

### Phases (each merges alone)

| Phase | What | Policy change | Tests |
|---|---|---|---|
| 0 (done) | Docs and comments match the code | no | `verify:fast` |
| 1 (built) | X/N grid, JPEG storage with a hot bitmap set, sorted entry list replacing `slotKt` / `coverage`, capture of played/seeked/stepped frames | no decoding change. Captured pictures are made before the first hover (implied decision A) | host: `ThumbService` with fake frames and a fake request (public API: `hover`, `offer`, `stats0`); layer 3 `seek_preview`: play 5 s, hover a between-keyframe time, assert the picture's time is within X; layer 3 `playback`: same dropped frames |
| 2 (built) | Nearest keyframe on either side (index from the demuxer or `kt`), plus refine while resting (native `noref` + skip loop filter args, worker `between` request, cost budget) | no (work only while the pointer is on the bar) | host: `thumbArgs` exact mode decodes the right frame of a generated 10 s-GOP clip (ffmpeg reference); worker `between` mode via `scrub_bench`'s worker shim; layer 3: rest on a slot 5 s after a keyframe, the picture differs from the keyframe |
| 3 (built) | Background keyframe pass, coarse to fine, pausing while busy or hidden | **yes** (decision 1) | host: pass order, pauses while `busy()`, stops when hidden; layer 3: full bar without hover (if approved), no work while hidden; `inspect` "no service before first hover" changes with the decision |
| 4 (built) | Between pass for short or light files | **yes** (decision 2) | as phase 3, plus a budget test with a fake cost |
| 5 (built) | Fill for every file: floor of 20, then every slot; no gate, remote like local; native sweeps on the GPU; faster while resting on the bar | **yes** (decisions of 2026-11-28) | host: floor order, no gate, pace, remote, GPU args and fallback; layer 3 between; layer 4 time to floor / full bar, GPU vs software |
| 6 (next) | A second WebCodecs hardware `VideoDecoder` for H.264 previews; disk cache only if decided | maybe | measure first |

### Bench and measurements to add

- Extend `test/thumbs/scrub_bench.js` with modes `key` (today), `between` (cheap flags, target 1 s / 5 s / 9 s after
  a keyframe), `pass` (whole-file keyframe and `fps=1/X` passes, CPU from `-benchmark` or `process.cpuUsage`) and
  `capture` (a resize of a 4K frame). Run it on generated long-GOP clips: a generator in `test/media/` (`testsrc2`,
  60 s, keyframe every 10 s, H.264 1080p and HEVC 10-bit 4K), so no new LFS media is needed.
- Layer 4 (before release only): `playback` on 4K HEVC with a pass running vs. not, compared on dropped frames and CPU.

## Decisions (maintainer, 2026-11-27; 1 and 2 revised 2026-11-28)

1. **Background keyframe pass: starts after open (c).** The 2026-11-20 lazy rule came from the old strip, which spiked
   the CPU. The new pass must stay unnoticeable: one request at a time, low priority (below-normal process priority,
   1-2 decoder threads), paused while playback is behind or the tab is hidden, coarse to fine. Phase 3 proves it with
   a layer 4 run (`playback` on 4K HEVC with and without the pass: same dropped frames, CPU stated). Since 2026-11-28
   native ffmpeg's background sweeps use the GPU; hover pictures stay software.
2. **Pictures between keyframes after open: for every file** (2026-11-28; was: short or light files under about 3 s
   of CPU). First a floor of min(N, 20) evenly spread slots with a picture of their own, then every slot up to N,
   coarse to fine, until the bar is full, on every path (native GPU, native software, WASM worker). Pace about a
   quarter of the time, half while the pointer rests on the bar (keyframe asks: about half the time, maintainer
   2026-11-28); paused while hidden; out of playback's way (layer 4: no
   extra dropped or late frames). Remote (Live transcode, native in a Remote-SSH window) the same as local.
3. **Disk cache: no,** not now.
4. **Interval rule:** `X = max(D / 240, min(2 s, D / 20))`, accepted.
5. **160 px, stored as JPEG with a hot bitmap set:** accepted.
6. **The nearer keyframe, also one after the target:** yes; release stays exact.

## History

- 2026-11-19: hover thumbnails worked in WebCodecs and WASM; none for native ffmpeg; nothing during drags. A
  background strip of 100 keyframes started 2 s after open, plus per-process native thumbnails (RGBA). Then: native
  50-60 ms per picture on a small clip, 156 ms on 4K H.264, 233 ms on 4K HEVC.
- 2026-11-20: the strip was removed (lazy policy, PRODUCT.md); native threads limited to 2 after the desktop stuttered.
- Later: native replies became JPEG with the keyframe time (`kt`); Live transcode got host thumbnails; drags hold the
  main picture and commit exactly on release (fast-scrubbing-architecture.md).

[^yt]: Storyboard spec parsing in yt-dlp (`_extract_storyboard`):
    https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py. Intervals and sizes were read
    from live watch pages on 2026-11-27. YouTube does not document them.
[^jf]: https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Configuration/TrickplayOptions.cs,
    https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.MediaEncoding/Encoder/MediaEncoder.cs,
    https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Server.Implementations/Trickplay/TrickplayManager.cs
[^plex]: https://support.plex.tv/articles/202197528-video-preview-thumbnails/. The 2 s interval and keyframe-only
    default come from third-party pages and forum threads, not from Plex's documentation.
[^emby]: https://emby.media/community/topic/85358-bif/
[^tf]: https://github.com/po5/thumbfast/blob/master/thumbfast.lua
[^iina]: https://github.com/iina/iina/blob/develop/iina/FFmpegController.m,
    https://github.com/iina/iina/blob/develop/iina/Preference.swift,
    https://github.com/iina/iina/blob/develop/iina/CacheManager.swift
[^mpc]: https://github.com/clsid2/mpc-hc/blob/develop/src/mpc-hc/MainFrm.cpp,
    https://github.com/Aleksoid1978/MPC-BE/blob/master/src/apps/mplayerc/MainFrm.cpp
[^vlc]: https://mailman.videolan.org/pipermail/vlc-commits/2024-November/070745.html
[^kodi]: https://kodi.wiki/view/Bookmarks_and_chapters
[^hls]: RFC 8216 sections 4.3.3.6 and 4.3.4.3 (https://www.rfc-editor.org/rfc/rfc8216.html);
    https://dashif.org/dash.js/pages/usage/thumbnails.html
