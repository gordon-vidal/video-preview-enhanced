# Seek-bar previews

Goal: a picture over the seek bar on hover and while the seek bar is dragged, in every decode path and in simple mode.
While dragging, the main picture holds; release lands on the exact frame.

This note has two parts: how previews work today (checked against the code on 2026-11-27) and a plan, not yet
built, for pictures between keyframes. The plan needs maintainer decisions (see "Decisions").

## How it works today

- **Lazy** ([PRODUCT.md](../PRODUCT.md), "Nothing decodes in the background on its own", 2026-11-20). Nothing is
  started after open. The first hover or drag creates the `ThumbService` ([thumbs.js](../../media/thumbs.js)) through
  `engine.thumbService()` ([engine.js](../../media/engine.js), section "seek-bar thumbnails"). There is no worker,
  request or ffmpeg process before that.
- **Grid and box.** About 200 slots along the bar (`step = max(duration / 200, 1 / fps)`). Pictures fit a 160 x 120
  box (160 x 90 for 16:9), turned like the video when drawn.
- **Keyframes only.** Every backend returns the keyframe at or before the slot's time. A 10 s GOP shows the same
  picture across 10 s of the bar.
- **Order of work.** The slot under the pointer comes first, and the newest position wins (40 ms debounce, one
  request in flight). While the pointer stays, up to 4 neighbouring slots on each side are filled. This happens only
  when playback is not busy (`thumbsBusy()`: a status warning, a recent catch-up, or less than 0.5 s decoded ahead
  while playing) and the file is local. A drag is meant to skip neighbour filling (`hover(..., scrub = true)`). At the
  time of writing, the unified viewer's adapter (`media/player-engine-adapter.js`) passes `false`, so drags fill
  neighbours too. That is being fixed separately.
- **Leaving the bar** cancels the running request: a `cancel` to the worker, or an abort of the host job. The WASM
  worker closes 20 s after the last hover (`idleMs`). The pictures stay cached.
- **Cache.** Pictures are stored as `ImageBitmap`s keyed by the keyframe's time, in LRU order, under `mem.thumbs`
  ([membudget.js](../../media/membudget.js): 30 / 15 / 8 MB by machine size; Compare divides it by the number of tiles
  in `compare-grid.js`). Each entry is counted at w x h x 4 bytes, so 160 x 90 is 57.6 KB. Three structures let one
  decode serve many slots:
  - `slotKt` maps slot to keyframe time.
  - `coverage` records that the keyframe at `kt` is the right answer up to the requested time, set when the seek
    landed cleanly.
  - `nearest()` answers at once with the closest cached slot while the exact one decodes.
- **Backends.**
  - **WASM worker** ([thumbs-worker.js](../../media/thumbs-worker.js)) for every file played through libav.js or
    WebCodecs. It is a second, single-threaded libav.js instance with `skip_frame nokey`, reading through the engine's
    block cache as reader `thumbs`. It seeks to the keyframe at or before t, decodes that one packet, scales it with
    swscale bilinear and posts RGBA. For formats without an index it steps back 2, 6, 14 ... s.
  - **Native ffmpeg and Live transcode (local or remote host)** ([thumbhost.js](../../src/thumbhost.js) through
    `unified-viewer.js` `onThumb`). One short ffmpeg per picture, on the source file, never the running stream:
    `-skip_frame nokey -noaccurate_seek -threads 2 -ss T -i FILE ... -vf scale=W:H:flags=bilinear,showinfo -c:v mjpeg
    -q:v 6`. It runs at below-normal priority, with one job per viewer (a new request aborts the old one), an 8 s
    timeout and no job while the panel is hidden. The reply is a JPEG of at most 25 KB plus the keyframe's time `kt`
    read from `showinfo`.
  - **None** for URL inputs, MJPEG AVI and image sequences (FramePlayer), and audio-only files.
- **Drag and release.** The slider and time follow the pointer. The tooltip shows a cached or decoded keyframe. The
  main picture keeps its last committed frame and audio scheduling pauses. Compare previews the clock tile and holds
  all tile pictures. Release cancels preview work and commits the exact frame through the usual seek and sync path.
  A cancelled drag returns to the committed position. Design of the drag:
  [fast-scrubbing-architecture.md](fast-scrubbing-architecture.md).
- **Tests.** [test/host/seek_preview_test.js](../../test/host/seek_preview_test.js),
  [test/vscode/cases/seek_preview.js](../../test/vscode/cases/seek_preview.js) (`seek_preview` for WASM,
  `seek_preview_native`), `inspect` thumbs/seek-bar (no service before the first hover), and the bench
  [test/thumbs/scrub_bench.js](../../test/thumbs/scrub_bench.js).

### Limits that motivate the plan

1. Keyframe granularity: long GOPs (camera files, streaming encodes with 4-10 s GOPs) give a few distinct pictures
   per minute.
2. Blank until decoded: the first hover over a new region shows a neighbour or nothing.
3. Frames the player already decoded (every played frame, every exact seek and step) are never reused.
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
- **Hardware decoding does not help** a one-off preview. Device setup eats the gain for keyframes, exact 4K HEVC was
  no faster than software with `noref`, and it competes with playback for the GPU decoder. Jellyfin and thumbfast
  also default to software.
- **`lowres`** works only in a few old decoders (MJPEG, MPEG-1/2/4 Part 2, H.263, JPEG 2000, DV), not in H.264, HEVC,
  VP9 or AV1. A possible small extra for MPEG-2 and MJPEG; not measured.
- **A one-process pass** pays off only when it decodes everything anyway (short files, or keyframe-only passes with
  short GOPs). When slots are sparse relative to keyframes, one process per slot (37 ms start each) is cheaper than
  decoding every keyframe.

## Plan (decided 2026-11-27, not built)

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
   below-normal priority, spread over playback's idle time. A 1-min 4K HEVC file needs 0.3 s.
5. **Background between pass for short files (policy change, decision 2).** If D x (cost per frame) fits a small
   budget (for example 3 s of CPU), run one process (native) or one worker job (WASM) decoding the whole file with
   `skip_frame noref` + `skip_loop_filter` and sampling with `fps=1/X`. Measured for 60 s: 3.9 s of CPU at 1080p
   H.264, 20 s at 4K HEVC. So this pass would run for short or light files only.

### Per decode path

| Path | Keyframes | Between keyframes | Notes |
|---|---|---|---|
| WebCodecs (H.264, VP8) | WASM worker (software). A WebCodecs `VideoDecoder` in the worker could decode H.264 keyframes in hardware, but it shares the GPU decoder with playback; not worth it while a 1080p keyframe is cheap in software. | (1) capture, (3) WASM refine. Later: a hardware `VideoDecoder` for a whole GOP while paused (hundreds of fps) is the cheapest between source for H.264; measure before building (phase 5). | The worker decodes in software even when playback uses the GPU. |
| WASM (HEVC, VP9, AV1, MPEG-2 ...) | WASM worker | (1) capture, (3) refine within budget (single-threaded WASM: tighter budget) | AV1 keyframes are 2-3x slower in WASM than native (bench). |
| Native ffmpeg | per-slot process; one-process keyframe pass where cheap | (1) capture, (3) `noref` + skip loop filter process, (5) one-process `fps=1/X` pass | software, 1-2 threads, below-normal priority; never `-hwaccel` for previews |
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
  (Jellyfin: 1 thread). The CPU budget per pass is enforced by stopping at a budget and resuming later, not by
  throttling a running process.
- Capture (1) costs one small resize per X seconds of playback. Phase 1 verifies with layer 3 `playback` that the
  dropped-frame count does not change.

### Compare

- The tooltip previews the clock tile only (today). Capture and passes run for the clock tile only. The other tiles'
  pictures would never be shown, and Compare already divides the budget per tile.
- On release, tiles commit through the existing exact sync. Pictures from captures in non-clock tiles are not kept.

### Remote-SSH and Live transcode

- **Live transcode / native on a remote host.** Pictures travel as JPEG: about 2.5 KB at 160x90 measured, 3-6 KB on
  real footage (thumbhost.js). A full 240-picture bar is about 0.6-1.5 MB over the link. The decoding CPU is the
  remote host's, which may be shared: passes (4, 5) there should follow the same decisions, with a lower budget.
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
| 0 (this branch) | Docs and comments match the code | no | `verify:fast` |
| 1 | X/N grid, JPEG storage with a hot bitmap set, sorted entry list replacing `slotKt` / `coverage`, capture of played/seeked/stepped frames | no decoding change. Captured pictures are made before the first hover (implied decision A) | host: `ThumbService` with fake frames and a fake request (public API: `hover`, `offer`, `stats0`); layer 3 `seek_preview`: play 5 s, hover a between-keyframe time, assert the picture's time is within X; layer 3 `playback`: same dropped frames |
| 2 | Nearest keyframe on either side (index from the demuxer or `kt`), plus refine while resting (native `noref` + skip loop filter args, worker `between` request, cost budget) | no (work only while the pointer is on the bar) | host: `thumbArgs` exact mode decodes the right frame of a generated 10 s-GOP clip (ffmpeg reference); worker `between` mode via `scrub_bench`'s worker shim; layer 3: rest on a slot 5 s after a keyframe, the picture differs from the keyframe |
| 3 | Background keyframe pass, coarse to fine, pausing while busy or hidden | **yes** (decision 1) | host: pass order, pauses while `busy()`, stops when hidden; layer 3: full bar without hover (if approved), no work while hidden; `inspect` "no service before first hover" changes with the decision |
| 4 | Between pass for short or light files | **yes** (decision 2) | as phase 3, plus a budget test with a fake cost |
| 5 (optional) | WebCodecs GOP decode for H.264 between pictures while paused; disk cache only if decided | maybe | measure first |

### Bench and measurements to add

- Extend `test/thumbs/scrub_bench.js` with modes `key` (today), `between` (cheap flags, target 1 s / 5 s / 9 s after
  a keyframe), `pass` (whole-file keyframe and `fps=1/X` passes, CPU from `-benchmark` or `process.cpuUsage`) and
  `capture` (a resize of a 4K frame). Run it on generated long-GOP clips: a generator in `test/media/` (`testsrc2`,
  60 s, keyframe every 10 s, H.264 1080p and HEVC 10-bit 4K), so no new LFS media is needed.
- Layer 4 (before release only): `playback` on 4K HEVC with a pass running vs. not, compared on dropped frames and CPU.

## Decisions (maintainer, 2026-11-27)

1. **Background keyframe pass: starts after open (c).** The 2026-11-20 lazy rule came from the old strip, which spiked
   the CPU. The new pass must stay unnoticeable: one picture at a time, low priority (below-normal process priority,
   1-2 decoder threads, software only), paused while playback is behind or the tab is hidden, coarse to fine. Phase 3
   proves it with a layer 4 run (`playback` on 4K HEVC with and without the pass: same dropped frames, CPU stated).
2. **Between pass for short or light files: yes,** after open too, under a budget of about 3 s of CPU per file.
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
