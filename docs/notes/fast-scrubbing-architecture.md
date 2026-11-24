# Fast scrubbing on heavy source media

Design proposal, 2026-11-24. Give pointer drags a responsive, approximate picture and commit the
latest target through the existing accurate seek on release. Keep preview pictures out of the
playback clock, stepping history and pixel tools. Start with the existing seek-bar preview and
measure how much exact work it can replace before adding a native binary or a disk cache.

## What other tools do

| Tool | Mechanism and lesson for VPE |
| --- | --- |
| mpv | The seek command distinguishes keyframe jumps from exact seeks. Precise seeks start early enough to decode through to the target, with optional decoder frame dropping before it and a demuxer offset for unreliable indexes. The seekable demuxer cache retains compressed packet ranges, and the index can be built on demand if missing. Hardware decoding and video filters are separate controls. Borrow explicit seek intent and range reuse. Keyframe seeking restarts playback at a keyframe and does not imply continuous keyframe-only decoding. [mpv manual](https://mpv.io/manual/stable/) |
| Kdenlive / MLT | Kdenlive can substitute low-resolution source proxies while editing and use originals for final output. Timeline preview rendering separately bakes composed or effect-heavy regions. MLT's avformat producer owns FFmpeg demux/codec state, seeks and flushes it on discontinuities, and can reuse cached images. Borrow reader lifetime and input substitution where justified. [Kdenlive proxies](https://docs.kdenlive.org/en/user_interface/menu/media_menu.html) · [Timeline preview](https://docs.kdenlive.org/en/cutting_and_assembling/timeline_preview_rendering.html) · [MLT avformat producer](https://github.com/mltframework/mlt/blob/master/src/modules/avformat/producer_avformat.c) |
| Shotcut / MLT | Preview Scaling reduces processing dimensions. Proxy Editing queues replacement media at the selected preview scale (540p with scaling off) to reduce source decode and scaling work too. The guide exposes Scrub Audio separately. MLT keyframe-aligned demux seeks underpin inter-frame decoding. The documented proxy and scaling controls provide no evidence of a drag-only `skip_frame=nokey` mode. [Proxy implementation](https://github.com/mltframework/shotcut/blob/master/src/proxymanager.cpp) · [Proxy Editing](https://forum.shotcut.org/t/settings-proxy-editing/18517) · [Shotcut guide](https://www.shotcut.org/stockmedia/Shotcut%20User%20Guide.pdf) |
| Blender VSE | Selected strips can use generated or external proxies at selectable sizes and build persistent timecode indices for problematic source timing. The cache can prefetch frames ahead of the cursor when enabled. Borrow explicit index generation and source-position mapping. Automatic cache filling would conflict with VPE's thumbnail policy. [Proxy and Timecode](https://docs.blender.org/manual/en/latest/editors/video_sequencer/sequencer/sidebar/proxy.html) · [Cache](https://docs.blender.org/manual/en/latest/editors/video_sequencer/sequencer/sidebar/cache.html) |
| Olive 0.2.x | The viewer can reuse rendered sequence frames stored as small images on disk. Olive pre-renders a region or the whole sequence and supports project-specific cache paths. This avoids recomputing unchanged composition and motivates retaining VPE pictures already requested during a gesture. [Olive Quickstart](https://github.com/olive-editor/olive/wiki/Olive-0.2.x-Quickstart) |
| OpenShot | Its in-process FFmpegReader checks completed frames before reading, retains a working cache during decode, and clears that working state on a discontinuous seek. OpenShot exposes memory or disk preview caching and preroll controls. Borrow the distinction between completed reusable frames and disposable seek state. [FFmpegReader](https://github.com/OpenShot/libopenshot/blob/develop/src/FFmpegReader.cpp) · [OpenShot guide](https://www.openshot.org/static/files/user-guide/OpenShotVideoEditor.pdf) |
| DJV | The documented FFmpeg path uses linked libraries for supported formats and an external FFmpeg stream when the packaged decoder cannot read the file. OTIO media references can select a supplied proxy or full-resolution render. This is a precedent for a fast in-process path with subprocess fallback and explicit proxy selection. [DJV formats](https://grizzlypeak3d.github.io/DJV/formats.html) |
| OpenRV | Region caching keeps images for repeated review, while lookahead smooths playback of compressed movies without loading the whole source. Borrow the distinction between reuse of a recently reviewed region and forward buffering. [OpenRV caching](https://github.com/AcademySoftwareFoundation/OpenRV/blob/main/docs/rv-manuals/rv-user-manual/rv-user-manual-chapter-one.md) |
| LosslessCut | Queries ffprobe for packets around the requested time and filters for keyframes, widening the search in some callers. Its alternate MediaSource preview debounces restarts, aborts obsolete work, holds the previous image and can request reduced dimensions and frame rate. Keyframe cut and Smart Cut are export strategies. Borrow bounded packet queries and cancellable preview requests. [Packet and keyframe queries](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/ffmpeg.ts) · [MediaSource player](https://github.com/mifi/lossless-cut/blob/master/src/renderer/src/MediaSourcePlayer.tsx) |

## VPE today

- **GPU (WebCodecs) and built-in WASM.** [decoder-worker.js](../../media/decoder-worker.js) demuxes
  both paths and seeks to a preceding random-access point for accurate seeks, with bounded retry
  logic for late demux landings. [engine.js](../../media/engine.js) holds/drops preroll pictures,
  tracks generations and already reuses forward queue frames and backward-step history.
  Playback catch-up's `fast` seek and WASM non-reference skipping address different problems
  from pointer preview. WebCodecs preview must feed a valid random-access chunk after reset.
- **Native.** [native.js](../../src/native.js) restarts its CLI decode pipeline on an out-of-buffer
  seek. It already scales frames to device-pixel view tiers, with grow now and shrink at next seek.
  A separate [thumbhost.js](../../src/thumbhost.js) process per thumbnail uses input-side
  `-ss`, `-noaccurate_seek`, `-skip_frame nokey`, no audio and one scaled RGBA picture.
  The native thumbnail reply carries pixels and dimensions, so VPE currently lacks the actual
  source keyframe timestamp needed to deduplicate its results reliably across requested slots.
- **Live transcode.** [stream.js](../../src/stream.js) serves some seeks from encoded H.264 packet
  history and otherwise restarts the host pipeline. It already has a 60 ms quiet window, 200 ms
  spawn gap and 400 ms maximum deferral for misses. Transcode output keyframes describe that
  rendition's seekability. Source random-access points remain a separate index. The current
  thumbnail service excludes Live transcode and URL input.
- **Gesture and thumbnails.** [player.js](../../media/player.js) coalesces pending slider input
  in its display loop but still calls `seekFrame` mid-drag while the tooltip independently asks
  for a thumbnail. [compare.js](../../media/compare.js) uses [stepgoal.js](../../media/stepgoal.js)
  to dispatch the first goal immediately, coalesce over 90 ms and flush on release. Its goal is
  still an accurate multi-tile seek. [thumbs.js](../../media/thumbs.js) holds a byte-limited bitmap
  cache and a slot-to-keyframe map. [thumbs-worker.js](../../media/thumbs-worker.js) already keeps
  a lazy WASM demux/decode context, skips non-keyframes and shares block reads with the main
  engine. This is the natural first preview backend for both WebCodecs and WASM playback.

### Existing latency evidence

Layer 4 records from 2026-11-24 on an i7-9700K, identified by result basename under
`test/perf/results/` in the maintainer checkout. These are historical runs and measure different
endpoints. No new performance run was made for this note. The [bench registry](../../test/perf/benches.js)
and [test inventory](test-inventory.md) describe the cases.

| Case | Observed | What the measurement covers |
| --- | --- | --- |
| `startup-native`, 00:49:11 UTC | 251 / 273 / 247 ms cold / warm1 / warm2 | `spawnToDecoded` includes launch, input/demux and first decode. It is neither pure OS spawn overhead nor a random-seek result. |
| `native-transfer`, 00:27:36 UTC | 674 ms grow, 611 ms zoom | `native-transfer-resize` changes output size and shows the resulting frame, including restart and delivery. |
| `remote-stream-soak`, 00:49:32 UTC | 679 ms after final target, six starts for 20 seeks, correct final frame | `remote_stream_long/seeks.scrub` measures settling after a synthetic seek burst. The earlier 00:35:07 run took 728 ms with four starts. This does not measure the first approximate picture or isolate SSH round-trip time. |

The separate November 20 [invisible optimisations run](perf-invisible.md) reduced native 4K HEVC
playback CPU from 95% to 69% of one core by transferring 720p instead of 1080p for its 720p view.
It also reduced paused native decode-ahead from 148 to 32 frames. Those measurements support
keeping transfer and idle work small. They do not predict scrub latency on a 10-second GOP.

## Ranked implementation proposals

Effort is relative. Latency wins are mechanisms or proposed targets to validate, with the table
above as context for baselines.

1. **Separate drag preview from exact commit. Medium effort, medium risk.** Route pointer
   movement through the existing tooltip service first. Keep the last committed picture as
   fallback, advance the slider independently and send one exact request at release even if an
   approximation was shown at that target. A 10 s GOP at 24 fps has about 240 pictures. A usable
   random-access picture can be previewed with one decoded picture plus demux work, avoiding
   repeated decode through the GOP during the drag. Pointer clicks, keyboard seeks and steps
   retain accurate behavior. Start with the single player, then use latest shared time plus tile
   offsets in Compare, with the clock tile first and a shared work cap. A preview never counts
   toward lockstep completion. **PRODUCT** stays compatible with the existing tooltip. Putting
   an approximate picture on the main canvas or adding a Compare preview needs maintainer UI
   review and documentation of the behavior.
2. **Coalesce, cancel and reuse the transport. Small–medium effort, low–medium risk.** Reuse the
   latest-target scheduling pattern from `stepgoal.js`, with distinct preview and commit IDs.
   Keep one active preview request and one replaceable target per eligible source, with a shared
   Compare limit. Validate source identity, gesture ID and generation on publish. Cancel queued
   work immediately on release, hide or dispose. Cooperatively stop scans between packet batches
   and abort native jobs on teardown; during movement replace work only if its replacement will
   arrive sooner, so continuous motion cannot starve rendering. Promote the exact release above
   preview work and let Live transcode try its existing history before restarting. Measure the
   residual delay on a history miss before adjusting its spawn throttle. Suspend audio scheduling
   during a preview, preserving mute, selected track and play intent. Resume audio from the
   committed picture's clock and preroll, with the existing selected Compare audio tile. Expected
   win: fewer aborted restarts and overlapping jobs, ideally one exact dispatch per drag.
   **PRODUCT** stays compatible with current audio controls. Audible scrub grains are a separate
   feature decision and carry extra remote audio and A/V sync cost.
3. **Reuse random-access anchors and small pictures. Medium effort, medium risk.** Extend
   the slot cache into known time intervals, keyed by actual random-access timestamp and output
   size. Begin in memory with entries observed during normal demux or active preview. Use
   libavformat's existing indexes first. For MP4/MOV, `stss` identifies sync samples, `stts` and
   `ctts` map decode and composition timing, and sample/chunk tables map offsets. Fragmented MP4
   uses fragment metadata. In Matroska, use track-specific Cues and validate cluster positions.
   Keep sparse timestamp/byte-position hints for poorly indexed inputs such as TS only where the
   demuxer can resume from those positions. Record the stream, PTS, DTS or demux time, time base
   and verified restart kind. Avoid assuming every intra picture, CRA or AV1 packet flag is a safe
   independent presentation point. Fall back to existing seek/retry on missing or invalid hints.
   A cache hit should paint on the next display frame and issue zero reads or starts. Persist
   observed hints only if repeat-open misses justify it. Store versioned, bounded data on the
   file-owning host keyed by source identity, stream, size and modification time, invalidated
   on change, with no automatic full-file scan. **PRODUCT** stays compatible with passive
   metadata reuse. Persistent storage should be documented before introduction.
4. **Use small preview output and retain useful decoded ranges. Medium effort, medium risk.**
   Keep current tooltip dimensions, or trial 360p/540p for a reviewed larger preview. Scale
   before readback or transport wherever the hardware path supports it. 540p is one-sixteenth
   the pixel area of 2160p at equal aspect ratio. A scaler still needs decoded input and cannot
   eliminate inter-frame dependencies in HEVC or AV1. Start with keyframes and recently used
   short runs from work already done by `engine.js` and `stream-buffer.js`. Evict by bytes under
   the existing tab and Compare budgets. A 2160p 8-bit 4:2:0 frame is about 12 MiB, so a 240-frame
   full GOP would need roughly 2.8 GiB before decoder surfaces. Use a GOP-keyed LRU of partial
   runs, compact previews or encoded packets. Record PTS coverage and use original-quality
   frames for exact hits only when timestamps, format and source identity match. Restore
   applicable view tier and existing exact-source pixel tool paths on settle. **PRODUCT** stays
   compatible under the preview-only contract and existing memory and idle rules.
5. **Prototype a seekable native worker only if misses dominate. High effort, high risk.**
   First benchmark the existing warm WASM thumbnail context against native one-shots on local
   4K HEVC and AV1 and retain the winner per supported path. Stock FFmpeg CLI takes `-ss` at
   launch and offers no supported stdin command for arbitrary input reseeks. Pooling idle CLI
   processes cannot reuse that input state. A separately packaged libav helper could open a
   source once, call the seek and flush APIs, decode with `AVDISCARD_NONKEY` where supported and
   return a small timestamped picture over existing host plumbing. Limit to one active context
   per visible source with a window-wide cap, and tear it down on hide or idle. Keep CLI
   fallback and benchmark hardware-specific discard behavior. Measure launch/open/setup avoided
   separately from seek, decode and delivery. **PRODUCT** would need a maintainer decision if
   this changes installation, packaging, supported hosts or the three-decoder setup.

### Proxy and filmstrip boundary

For a sparse 10 s GOP, repeated keyframe hits are quick but can show the same image for a long
stretch. A bounded cache of already requested pictures, including existing nearby thumbnail
work while hovering, preserves the [product policy](../PRODUCT.md). A later opt-in, cancellable
short-GOP proxy or filmstrip build could improve repeated review of such a source, with source
PTS mapping for VFR, disk limits and originals used for exact operations. Reusing a supplied
proxy also needs identity and timing validation. Evaluate those only if coverage remains poor
after the ranked changes. Automatic strip builds, proxy generation on open and decoded
prefetch after the pointer leaves would require a product decision.

## Validation before implementation ships

- Instrument input-to-first-preview, input-to-relevant-preview (record source time error), and
  release-to-exact-presented p50/p95 separately. Count exact dispatches, ffmpeg starts, cache
  hits, discarded results, bytes read/transferred and memory. A cached preview should land on
  the next paint with zero starts. A miss should leave the previous picture visible and the
  newest request eligible to complete. Hidden or idle tabs should show no ongoing decode.
- Use real hidden VS Code and the [Layer 4 runner](../TESTING.md) for latency. Repeat cold and warm
  sweeps, reversals and release while work is pending. Cover indexed MP4, MKV with and without
  usable Cues, a weakly indexed transport stream, 4K 10-bit HEVC and AV1, open and 10 s GOPs,
  multi-GB sources, and VFR with B-frames. Exercise all three decoders, Live transcode history
  hits and misses, and a constrained remote link. With no usable preview backend, keep the
  last picture and still commit accurately.
- Check known source PTS/frame identity on release, including nonzero starts, reordered
  timestamps and end of file. Compare must apply offsets and finish lockstep across tiles.
  Verify click, pointer cancel, keyboard, zoom, audio resume, hiding/reopening and stale
  replies. Include inspection, copy/export and rapid reverse steps after landing. Judge
  VFR against decoded presentation timestamps, never against nominal FPS multiplication.

## Implementation and benchmark

The single player and Compare hold their committed pictures during a seek-bar drag and use the existing
tooltip dimensions for keyframe previews. Compare previews the clock tile and applies the tile offsets
through its existing exact synchronization path on release. The tooltip needs one small canvas in
Compare and uses the same position above the time tip, with the existing seek bar keys and accessible name.
Cached preview coverage is limited to observed anchors and requested targets. Preview cancellation leaves
Live transcode exact seeking on its existing history and restart path.

Run `node test/thumbs/scrub_bench.js` with ffmpeg on PATH and both Git LFS clips present. This measures
20 decode misses per clip with the same targets on each backend. The WASM worker has already opened its
demuxer and decoder. Each native request starts a new process. Times include local reads and return of
scaled RGBA. Webview presentation, native hardware decode and shared block-cache behavior are outside
this benchmark.
