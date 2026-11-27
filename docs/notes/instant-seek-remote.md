# Near-instant seeks and steps back over SSH (and in Compare)

Design proposal, 2026-11-26. Not signed off. Builds on [fast-scrubbing-architecture.md](fast-scrubbing-architecture.md),
[remote-transcode-research.md](remote-transcode-research.md) and [ADR 0002](../adr/0002-live-transcode.md); does not
change [PRODUCT.md](../PRODUCT.md) yet (the open questions at the end need the maintainer).

**Goal.** In a Remote-SSH window on a strong GPU host, a seek or a frame step (especially back) shows the right
picture in about one network round trip plus one frame, in the single player and in Compare. Users may trade a lot of
memory (client and host) and host GPU time for it, through a setting.

## Where the time goes today (Live transcode, cache miss)

A paused step back that misses the page's back cache (`this.back` in `media/engine.js`, at most 65 % of a 400 MB frame
budget: about 130 transcoded 1080p frames, or 20 at 4K) and the host's packet history (`src/stream-buffer.js`,
15-20 s and 4 regions in 32 MB) costs, in order:

| Step | Cost | Where |
| --- | --- | --- |
| Request to the host | RTT / 2 | `seek` message |
| Seek throttles | 0-400 ms (`SEEK_QUIET_MS`, `SPAWN_GAP_MS`, `SEEK_MAX_DEFER_MS`) | `src/stream.js` |
| ffmpeg restart: spawn, open, CUDA init, NVDEC to the target | 0.3 s at a source keyframe, 0.9-1.2 s at the end of a 10 s source GOP (measured below) | host GPU |
| Restart lead: the host encodes and sends `REMOTE_STEP_BACK_LEAD_S` = 2.5 s before the target so the next steps back hit memory | 2.5 s of 2 s-GOP H.264 (~3-4 MB at 1080p) over the link: ~1.2 s at 25 Mb/s | link |
| Page decodes from the IDR to the target | up to 60 frames | WebCodecs |

So a miss is 1.5-3 s over a typical link, and the dominant costs are **the restart** and **re-sending a GOP**, not
the GPU's decode speed. A big GPU is idle most of that time.

### Measurements (indicative)

Scratch benchmark, 2026-11-26, RTX 4070 + i7-9700K, ffmpeg N-114833 (2024 master, GPL build, scratch only), source:
generated 60 s 3840×2160 HEVC Main10 at 40 Mb/s, 24 fps, keyframe every 10 s, 3 B-frames, heavy temporal noise (worst
case for inter prediction, so P-frame sizes are pessimistic). The machine ran other GPU work at the same time: treat the
numbers as orders of magnitude, and repeat them on an idle machine through Layer 4 before quoting any.

| What | Result |
| --- | --- |
| Process spawn alone (`ffmpeg -version`) | 23 ms |
| Open + CUDA init + first NVDEC frame | 251 ms (CPU decode instead: 503 ms) |
| Cold seek to first H.264 packet, 1080p out, 0 / 120 / 238 frames after a source keyframe | 309 / 835 / 950 ms |
| Same, 2160p out | 458 / 872 / 1227 ms |
| 1080p NVENC cq 22, GOP 48 (today) / 8 / 1 | IDR 245 / 184 / 75 KiB, P 57 / 52 KiB; 12.0 / 13.4 / 14.8 Mb/s |
| 2160p, same | IDR 1886 / 995 / 398 KiB, P 315 / 264 KiB; 68 / 70 / 78 Mb/s |
| Whole-file re-encode, NVDEC 4K HEVC → `scale_cuda` → NVENC, 1080p all-intra / 1080p GOP 8 / 2160p all-intra | 307 / 316 / 169 fps (12.8× / 13.2× / 7× real time at 24 fps) |
| Same, 1080p all-intra as 4 parallel 15 s segments | 269 fps (this card's NVDEC is the limit; GPUs with several NVDEC engines should scale) |

Takeaways:

- The fixed floor of any restart is ~250 ms (CUDA init and open); a long source GOP adds up to ~1 s. Neither shrinks
  with a bigger GPU much. **Only caching removes them.**
- An all-intra or short-GOP rendition costs little extra bandwidth at the same quality setting (here +10-25 %) and makes
  **any cached frame decodable alone**. (On real footage intra frames are larger relative to P-frames than with this
  noise; measure on the real-clip set.)
- Building a full random-access copy of a file on the host GPU runs at 7-13× real time on a mid-range card: a 10-minute
  4K clip is fully covered in about 45-90 s.

## What other tools do

| Tool | Mechanism | Lesson for VPE |
| --- | --- | --- |
| mrv2 | One RAM cache with a **Gigabytes** setting (default half the available RAM); 0 switches to Read Ahead / Read Behind in seconds. [mrv2 settings](https://mrv2.sourceforge.io/docs/en/user_docs/settings.html) | A plain GB setting with read-behind is what review users expect. |
| OpenRV / RV | Cache off, Region cache (fills the in/out range) or Look-ahead cache, each with its own size; the manual says to raise it in 1 GB steps and recommends 16 GB RAM. [RV manual, ch. 14](https://aswf-openrv.readthedocs.io/en/latest/rv-manuals/rv-user-manual/rv-user-manual-chapter-fourteen.html) | Separate "around the playhead" from "a whole range"; sizes in GB. |
| DaVinci Resolve, Premiere, Avid | Long-GOP H.264/H.265 is the known scrubbing problem; editors make intra-frame proxies or optimized media (ProRes, DNxHR) and a render cache. [Frame.io: Resolve proxies](https://workflow.frame.io/guide/resolve-proxies) · [Resolve playback guide](https://elements.tv/blog/davinci-resolve-5-ways-to-achieve-better-playback-performance/) | A random-access rendition, built in the background, is the standard answer. Here it is H.264 intra / short GOP, because that is what WebCodecs in VS Code decodes. |
| HLS trick play | `EXT-X-I-FRAMES-ONLY` playlists: a track of only I-frames (often byte ranges into the normal encode) for scrubbing, fast forward and rewind. [AWS MediaLive](https://docs.aws.amazon.com/medialive/latest/ug/trick-play-i-frames.html) · [AWS MediaPackage](https://docs.aws.amazon.com/mediapackage/latest/ug/trick-play.html) | Keep the playback stream efficient and add a separate random-access track for seeking. |
| Blender VSE | Proxies at chosen sizes plus a frame cache with prefetch. (cited in fast-scrubbing-architecture.md) | Same pattern. |
| mpv | Seekable demuxer cache with separate forward and back byte limits. (cited in fast-scrubbing-architecture.md) | Back limit matters as much as forward. |
| Parsec, Moonlight/Sunshine, NICE DCV, HP Anyware | The player runs on the GPU host; only the screen is encoded, so a seek costs RTT + one low-latency frame. | The ceiling to aim for. VPE gets there by caching instead of running a second player on the host. |
| NVENC limits | GeForce: 8 concurrent encode sessions per system (all GeForce cards together); professional cards: limited by resources. [NVENC Application Note 13.0](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-application-note/index.html) | Background builds go through one per-host GPU job queue with a session cap, below playback and exact seeks. |

## Proposal: a four-level seek cache

Each level is checked in order; each hit skips everything below it. Levels 1-2 live in the page (local machine RAM),
levels 3-4 on the SSH host.

### Level 1: decoded frames around the playhead (page, existing, made bigger)

Today `this.back` and the read-ahead hold decoded pictures within the 400 MB frame budget (`media/membudget.js`; on a
remote window the page only sees `navigator.deviceMemory`, capped at 8 GB). Make the budget follow the setting
(e.g. 2 / 4 / 8 GB), keep it **two-sided** (read-behind as well as read-ahead, like mrv2), and keep frames at the
transcoded size (1080p ≈ 3 MB: 2 GB ≈ 680 frames ≈ 28 s at 24 fps). Spilled YUV, as today, so WebCodecs' decoder pool
never stalls. Hit = next display frame.

### Level 2: encoded packets in the page (new)

The page throws away the H.264 packets it decoded; only the host keeps history. Keep them in the page instead (cheap:
12 Mb/s ≈ 1.5 MB/s, so 1 GB ≈ 11 minutes of 1080p), indexed by time with keyframe flags, per configuration (size,
bitrate, tier) like the host's regions. A step back that misses level 1 decodes locally from the nearest IDR: no round
trip, no restart. With today's 2 s GOP that is up to 48 decodes (tens of ms with hardware H.264); with the level-3
rendition it is one decode. **Single biggest win per line of code**: it removes the network from every step back into
anything already watched or prefetched.

### Level 3: a random-access rendition around the playhead (host GPU, proactive)

While paused (and while stepping), the host encodes a window around the playhead with a short GOP (all-intra or
GOP 4-8, setting-dependent), **backwards first** (forward is covered by normal playback), and pushes it to level 2
within a share of the measured link rate (the link-adapt controller already measures it). Work order: the window
behind the playhead, then ahead, then widening. Every new seek or step reprioritises; work that would arrive after the
user has moved on is cancelled (generation checks as today).

Also change the miss path itself: for a paused seek, start one ffmpeg **exactly at the target** (its first frame is an
IDR at the target: picture after RTT + ~0.3-1 s) and fill the 2.5 s step-back lead with a second, parallel process,
instead of one process that starts 2.5 s early and makes the user wait for the lead to transfer and decode. Discrete
steps skip the scrub throttles (`SEEK_QUIET_MS` etc.); only bursts keep them.

### Level 4: a whole-file seek proxy on the host (opt-in "maximum")

In the background, the host builds the level-3 rendition for the whole file: 1080p (or view-size) all-intra / short-GOP
H.264, from the playhead outward, at 7-13× real time on a mid-range card. Stored on the host in RAM up to a limit, then
in a temp folder on disk (LRU across files, keyed by path, size, mtime, output size and encoder settings; never in the
workspace). Any seek is then: RTT + one frame (75-250 KiB at 1080p, ~0.4-1.9 MiB at 4K) + one decode. Scrubbing the
seek bar can show real frames from it instead of keyframe thumbnails. The build pauses during playback if the GPU or
link is needed, stops when the tab closes, and is shown in ⓘ ("Seek cache: 64 % of the file").

### Compare

Each tile is its own `EncodedStream`, so all four levels apply per tile; the point for Compare is that lockstep waits for
the slowest tile, and levels 1-2 make every tile's step local, so lockstep completes on the next frame. Budgets split
across tiles (as `transcodeSplitBitrate` already does for bitrate). Level-3/4 work runs through one host-wide GPU queue
(NVENC session cap on GeForce, playback encoders first), the clock tile first, and Compare's tile sizes (cell size,
zoom ≥ 1.5 upgrade) decide the rendition size.

### Display mode: the remote-desktop model for paused review (added 2026-11-26)

How game and desktop streamers get their latency, and what carries over:

| Streamer technique | Why it is fast | VPE |
| --- | --- | --- |
| Zero-copy capture (NvFBC, DXGI desktop duplication); the frame never leaves GPU memory before NVENC | ~1-2 ms | Not needed: the host decodes the file itself |
| Low-latency encode: no B-frames, no lookahead, CBR with a VBV of about one frame, slices | 2-8 ms, and every frame fits the link in about one frame time | Same NVENC options through stock ffmpeg (`-tune ull`, `-delay 0`, `-bf 0`) |
| Endless GOP: one IDR at the start, then only P-frames; on loss, reference frame invalidation or intra refresh instead of a new IDR | No IDR spikes | **The key idea: encode what is shown, as a delta from what was shown last.** A step back is then as cheap as a step forward |
| UDP with FEC (Moonlight) or a custom reliable UDP protocol with its own bitrate control (Parsec BUD, DTLS) | No TCP head-of-line blocking | Not available: everything goes through VS Code's SSH tunnel (TCP). It is reliable, so encoder and decoder stay in step with no FEC, but a big transfer in flight delays a step reply: interactive frames need priority over prefetch on the host send queue |
| No jitter buffer: present on arrival | Lowest latency, occasional stutter | For paused steps only; playback keeps its buffered media stream (A/V sync, jitter) |
| Progressive refinement on static content (PCoIP "build to lossless") | A still image looks good even on <1 Mb/s | A random seek sends a small coarse frame first, then refinement P-frames, then (only for pixel tools) the exact PNG |

A player inside Parsec does not seek faster: the player seeks locally next to the file with a warm decoder; Parsec
only makes the network cost about one frame. VPE needs both halves: (a) a warm frame source next to the file and
(b) a display-style encoder.

**Display mode** (paused, stepping, scrubbing; playback stays as today): the host keeps one persistent encoder process
(stock ffmpeg reading raw frames on stdin, endless GOP, low-latency NVENC). The page asks for "show source frame N"; the
host takes frame N from its frame source, feeds it to the encoder and sends the packet (a P-frame relative to what the
page shows). The page's decoder runs in a "display" mode: packets tagged with their source time, shown on arrival, no
clock. Frame sources, in order of effort:

1. **Host decoded-frame RAM cache** filled by ffmpeg CLI decode windows at view size (1080p NV12 ≈ 3 MB: 32 GB host RAM
   ≈ 7 minutes at 24 fps), background-filled at ~300 fps around the playhead. No new binaries. A miss outside it still
   pays the CLI restart (0.3-1.2 s), shown as a coarse keyframe first.
2. **Level-4 proxy** decoded on the host as the source.
3. **A native persistent decoder** (libavcodec seek + flush, NVDEC) would remove the ~250 ms restart floor on misses. It
   is a fourth component: binaries per host platform, LGPL notices, PRODUCT decision. Only if 1-2 leave misses that
   matter. Even then a long source GOP must be decoded from its keyframe; only caches remove that.

Expected step cost with a host RAM hit: RTT + 3-8 ms encode + frame bytes / link rate + 2-5 ms decode. A 1080p P-frame of
20-60 KB is ~6-20 ms at 25 Mb/s, 80-240 ms at 2 Mb/s. Levels 1-2 (page caches) stay faster still for revisits (no
network at all), so the cache and display mode combine: caches for anything seen, display mode for first visits.

### Feasibility in a VS Code extension, and on any GPU vendor (checked 2026-11-26)

Measured with a scratch script (persistent ffmpeg reading raw 1080p NV12 on stdin, endless GOP, frames fed forward,
backward and in random jumps; RTX 4070, ffmpeg 2024 master; indicative, machine not idle):

| Encoder | Vendor scope | First frame (incl. encoder start) | Per frame after that | Step back vs forward |
| --- | --- | --- | --- | --- |
| `h264_nvenc` | NVIDIA | 150 ms | 3-4 ms | same size |
| `h264_mf` (`-scenario display_remoting`) | any Windows GPU (Media Foundation picks the vendor's encoder) | 335 ms | 4-5 ms | same size |
| `libx264` ultrafast zerolatency | any CPU | 35 ms | 3-4 ms | same size |
| `libopenh264` | any CPU | 40-50 ms | 9-20 ms | same size |

Findings:

- **ffmpeg CLI holds one frame back** when reading raw frames from a pipe (6.1, 2024 master and 9.0 alike, every
  encoder, even with `-fps_mode passthrough`, `-analyzeduration 0`, `-fflags nobuffer`, `-avioflags direct`). Writing
  each frame twice pushes it out immediately; the duplicate encodes as a small refinement of the same picture. Works with
  stock ffmpeg; no build change.
- **NVENC's H.264 has no VUI `bitstream_restriction`** (`max_num_reorder_frames`); libx264 and OpenH264 write it (0
  reorder, 1 frame buffering). Without it a hardware decoder may assume reordering and hold several frames before output:
  reported for Chromium's hardware path even with `optimizeForLatency` ([w3c/webcodecs#732](https://github.com/w3c/webcodecs/issues/732),
  [trycua/cua#8710](https://github.com/trycua/cua/issues/8710), [w3c/webcodecs#900](https://github.com/w3c/webcodecs/issues/900)).
  `h264_metadata` cannot add it, so the host should rewrite the SPS (a small pure module beside `parseSpsProfileLevel`)
  for every encoder: vendor-neutral. This may also cost today's Live transcode a few frames of latency after each paused
  seek (compare the comment at `media/engine.js:1158`); worth checking on its own.
- **`flush()` is not a way out**: after a flush WebCodecs requires a key chunk ([w3c/webcodecs#698](https://github.com/w3c/webcodecs/issues/698)),
  which would turn every step into an IDR. Display mode must get its latency from the bitstream (VUI), `optimizeForLatency`,
  and, if a client's hardware decoder still holds frames, `hardwareAcceleration: 'prefer-software'` for display mode only
  (one 1080p frame at a time is cheap in software; that VS Code's Electron has a software H.264 path for WebCodecs needs checking).
- **Transport**: `postMessage` with binary payloads already carries Live transcode over SSH. No UDP is reachable from a
  webview through the SSH tunnel, and `portMapping` is http(s) only, not WebSocket, so the tunnel's TCP stays. Reliable
  delivery means no FEC or reference-frame invalidation is needed (vendor-specific features avoided); the cost is
  head-of-line blocking, handled by keeping bytes in flight small (today's 128 KB batches) and a priority send queue.
- **Host memory**: a large decoded-frame cache should live in a child process (`child_process.fork`), not in the
  extension host shared with every other extension, so a crash or GC pause stays contained.

Vendor-neutral by construction:

- **Encode**: display mode encodes only the frames shown, so even `libx264` on the CPU keeps up (3-4 ms/frame at 1080p).
  The existing encoder ladder (`encoderArgs`: NVENC, QSV, AMF, Media Foundation, VideoToolbox, VA-API, x264, OpenH264)
  applies, each with its low-latency options (QSV and VA-API `async_depth 1`, AMF `-usage ultralowlatency`, VideoToolbox
  `-realtime`). A start-up check (two frames in, the first must come out) catches any encoder that still buffers and
  falls back to libx264.
- **Decode on the host** (the part a GPU really speeds up: filling caches from long-GOP 4K sources): today's decode
  methods (CUDA, QSV, VA-API on AMD/Intel Linux, D3D11VA, VideoToolbox, CPU). FFmpeg's Vulkan Video encoders (7.1+) are
  vendor-neutral on paper but reported unreliable ([Intel/Mesa encode failures](https://ffmpeg.org/pipermail/ffmpeg-user/2024-December/058927.html),
  [race conditions on NVIDIA](https://ffmpeg.org/pipermail/ffmpeg-trac/2025-January/072511.html)): not a default.
- **Not testable on this machine**: QSV (iGPU disabled), AMF, VA-API, VideoToolbox. Their per-frame latency and VUI
  output need a check on real hardware (or the start-up check above at runtime).

Spike to run on an idle machine before any implementation (existing harnesses, no new tooling):

1. In real VS Code (hidden desktop, `wcprobe`-style probe): feed a recorded display-mode stream (NVENC without VUI, NVENC
   with rewritten VUI, x264) to the webview's `VideoDecoder`; count chunks in before the first frame out, hardware and
   prefer-software. Decides whether display mode works with hardware decode on the client.
2. Through `test/vscode/remote_ssh.js` (real Remote-SSH to sshd in WSL): round trip of a small message and of a 50 KB and
   150 KB binary reply, host to webview. That is the floor of every display-mode step.
3. Page memory: how many GB of spilled YUV a webview holds before the renderer fails (caps for level 1).

### Not proposed

- **A persistent seekable decoder as a new binary** (a libav helper or a Python/PyAV process) adds a native binary or
  a runtime to install (PRODUCT and licensing decision). Not needed: stock ffmpeg kept running behind a pipe does the
  same (see "Prototypes" below).
- **Sending raw or lossless frames** over SSH: 4K NV12 is 12 MB per frame; VS Code's tunnel cannot carry that quickly.
  Exact pixels stay with `grabExactFrame` for the pixel tools, as today.

## Prototypes (2026-11-27, on the unified viewer)

Indicative numbers: one Windows machine (RTX 4070, i7-9700K), other work running at times.

### Level 2 wired end to end: the page keeps the packets it received

`media/packet-cache.js` (pure, Node-tested in `test/unit/packet_cache_test.js`) keeps the H.264 packets of a remote
Live transcode by GOP: from each IDR on, in decode order, per read; a GOP read on into the next keyframe covers the
time up to it. `media/engine.js` `seekFromPackets`: a **paused** seek whose target lies in a kept GOP decodes from
those packets (keyframe to target, plus the rest of the GOP for steps forward, then a flush so a hardware decoder
gives up the frames it holds). The host is not told; play, or a target outside the kept packets, seeks the host as
before. Default 64 MB (about a minute of 1080p at 8 Mb/s, compressed). Frames are found by the host's frame times, so
it is frame-exact like a host seek.

Found on the way: the unified viewer steps its decoders with frame seeks (`player-unified.js` `seekTo`), never
`engine.stepFrame`, so the decoded frames kept for steps back (`this.back`, level 1) were no longer used: every paused
step back decoded its GOP again (over SSH: the host sent it again). `seekTime` now serves a paused seek onto a kept
frame from them (no seek), like the forward case next to it.

Layer 3 `remote-stream-packets` (1080p, 25 fps, link throttled to 2 Mb/s with the test hook, page-measured time from
the seek to its frame decoded; every landing checked frame-exact):

| | before (host over the link) | now |
| --- | --- | --- |
| Seek back to a place already received | 2651 ms | 158 ms (from packets, 0 bytes sent) |
| Then 3 steps back | a GOP re-sent per step | no seek (decoded frames kept) |
| Step back across a keyframe | ~3.7 s | 269 ms (from packets: a 50-frame GOP decoded) |

A miss (a place never received) is unchanged: today's host seek. Paused read-ahead fetches only about a second, so
level 3 (pushing the GOPs around the playhead while paused, within a share of the link) is what makes the first step
back after a jump hit.

**Compare:** every tile has its own engine and so its own cache (64 MB each). Layer 3 `multiview-transcode-packets`
(two tiles, one H.264, one VP9, both on Live transcode): a paused seek back landed on the same frame in both tiles from
their own packets, and three steps back after it came from the decoded frames kept, with no seek sent to the host.

**Edge cases, by what reaches the page.** The page only ever sees H.264 from the host, so the source format matters
only through what the host sends:

- *Transcoded* (HEVC, VP9, AV1, ProRes, 10-bit, HDR, rotated, resized ...): our own encode, constant frame rate,
  no B-frames (`-bf 0`), an IDR with SPS/PPS on every keyframe. The safe case.
- *Direct Stream* (an 8-bit 4:2:0 H.264 source at its own size, copied): the source's own GOPs. With B-frames the decode
  order is not the frame order, so "the packets up to t" are not the frames up to t (it could show frame 0 for frame
  2). A GOP whose packets go back in time is dropped whole, and the host is asked, as the host's own cache does for
  Direct Stream. Open-GOP I-frames are no entry point (as before: the engine goes to software). Packets without a
  time (H.264 in AVI) are not kept.
- *The stream changed mid-session* (the view grew, a lower tier for a slow link, an encoder fallback): a keyframe with
  other SPS/PPS bytes drops the GOPs of the old stream, and the page's re-fetch after a resize (`refreshNativeFrame`)
  empties the cache first (it would otherwise answer its own re-fetch with the old, smaller picture). A bitrate-only
  change keeps older GOPs: a seek back can show the older, softer copy of a frame.
- Variable frame rate keeps the frame times of the source (Direct Stream) or the host's constant rate (transcode):
  frames are found by those times either way.

### A decoder kept running behind a pipe (stock ffmpeg, host)

Scratch prototype (not in the extension): one ffmpeg reads MPEG-TS on stdin (`-hwaccel cuda`, `-copyts`); a jump
writes the TS bytes from the target's keyframe on (offsets from the container index) and identifies the target by its
source PTS (`showinfo`). 4K HEVC, 15 fps, keyframe every 50 frames, B-frames:

- Frame-exact on all 16 random jumps (forward and back), every one with the right source PTS.
- ffmpeg holds about 8-12 frames (the TS demuxer completes a PES only when the next begins, decoder reordering, the
  CLI's pipeline): feeding only up to the target misses. **Pumping** one more packet every ~2 ms until the target
  comes out fixes it.
- Jump = (frames from keyframe to target + the ~12 held) x 3.3 ms (NVDEC decodes this clip at ~300 fps; scaling and
  download do not matter): **median 134 ms (47-200)** vs 340-470 ms for a fresh `ffmpeg -ss` each time (spawn, probe,
  CUDA init). The ~250 ms start-up is paid once per file (first frame 450 ms).
- Marking the frames before the target (PTS shifted, dropped by `select` right after the decoder) saves nothing: the
  cost is the decode itself.

So the miss path of Live transcode can lose its restart floor without new binaries; the GOP decode remains (level 3/4
remove it).

### Display mode encoder (measured 2026-11-26, see above)

A persistent encoder fed raw frames: 3-5 ms per frame on NVENC / Media Foundation / x264, back steps the same size as
forward ones; needs the duplicate-frame trick (ffmpeg holds one frame) and an SPS with `bitstream_restriction`.

## Bottlenecks measured (2026-11-27, RTX 4070, driver 581)

Host side, 4K HEVC 10-bit HDR (PQ) at 100 Mb/s with a keyframe every 250 frames, tone-mapped to 1080p:

| | CPU decode (before) | NVDEC, every frame copied to RAM | NVDEC + scale_cuda, small frames copied |
| --- | --- | --- | --- |
| Seek to the frame 248 into its GOP (first frame out) | 6.4 s | 3.3 s | 1.9 s |
| Seek onto a keyframe | | 0.5 s | |
| Playback (CPU tone-mapping + x264) | 34 fps | 42 fps | 57 fps |
| 4K PQ, OpenCL tone-mapping + NVENC | 51 fps | | 70 fps |

Pure NVDEC decode of that stream is about 140 fps, so a seek deep into a long source GOP costs ~2 s on the host
whatever else is done; only a cache (levels 2-4) or a host-side seek proxy hides it. At 1080p the CPU tone-mapper
(zscale + tonemap, float RGB) is the next limit (~57 fps). The 2.5 Mb/s link then adds the size of the first
keyframe (~100-300 KB at the view size: 0.3-1 s) plus a round trip, and a GOP sent again costs its whole size (a
50-frame 1080p GOP, ~500 KB: ~2 s).

Two environment findings: ffmpeg 9.x needs NVIDIA driver 610+ for NVENC (API 13.1). With an older driver the
extension encodes with libx264 and shows its driver notice; "Set up ffmpeg" picks a build line matching the driver
(src/setup.js nvidiaLineMax), and the downloaded ffmpeg is preferred over PATH. NVDEC works with either. libplacebo
needs a Vulkan device the pipeline does not create (`-init_hw_device vulkan`); it fails once and drops to OpenCL.

Done (cheap): NVDEC + scale_cuda in front of the CPU and OpenCL tone-mappers and of a CPU encoder
(`transcode_args.js` cudaDecodeDownload; on failure the GPU decode is dropped as for the full-GPU path); a seek while
playing offers the host the packets the page holds of the target's GOP (`seek.have`), and the host's history skips
them (`stream.js` skipHeld), so play after a page-served seek does not send the GOP again;
`videoPreviewEnhanced.liveTranscodeCacheMB` (default 64, 0 = off).

## Paused stepping (2026-11-27)

- **Fill behind the paused frame** (level 3, pull-based): once a paused frame shows (a landed seek, a step from
  memory), at most every 250 ms the page checks whether 1.5 s behind it is held in its packets; if not it asks the
  host for the 2 s ending where the held packets begin (`media/engine.js` fillBehind, `src/stream.js` fill). The host
  runs a second short encode with the stream's own pipeline and sends it in whole-packet pieces of at most 96 KiB, one
  per page request, so a seek sent meanwhile waits behind little; a seek, play or hide stops it. At most 2 fills run
  per host (each holds a GPU encoder session); a Direct Stream copy is never filled (its GOPs are not cached). The
  packet cache keeps a run per read, so the fill and the read-ahead arriving in turns do not cut each other's GOPs,
  and `close()` marks the fill as reaching the held packets.
- **Paused encodes use 0.5 s GOPs** (2 s while playing): a step back across a keyframe decodes at most 13 frames at
  25 fps on the page instead of 50.
- Layer 3 `remote-stream-packets` (1080p25, link throttled to 2 Mb/s after the fill): fill of 50 frames in ~170 ms
  on the full-speed link; the first step back after a jump 47-60 ms page time (was a host seek, seconds); 30 steps
  back 40 ms apart: 0 host seeks, settled 1.9 s after the first (1.2 s of input).

## Paused frame: fast, then sharp (built 2026-11-27)

Maintainer decisions of 2026-11-27, built on the remote Live transcode path (paused, WebCodecs):

- **Fast first picture** (`src/stream.js` fastFirstBits, `transcode_args.js` encoderArgs `firstKeyBits`): an encode
  started paused begins with its rate buffer nearly empty (`-rc_init_occupancy`), so its first keyframe is about a
  quarter of a full one; the frames after it refill the buffer within a few frames. Same size, encoder and SPS/PPS
  (checked: the page's packet cache keeps both). Skipped while playing, in a local window, and when the link estimate
  (`stream-adapt.js` fastKbps / slowKbps) would carry a full keyframe (the largest measured at this size, else 0.1 byte
  per pixel) within 100 ms. **Only libx264 honours it.** Measured on an RTX 4070 (driver 581): NVENC in its
  `-rc vbr -cq` low-latency mode ignores the initial buffer fullness, a small `-bufsize`, `-init_qpI` and ROI side data
  (`addroi`) for the first IDR; only `-multipass` makes it respect the buffer, and that changes every frame's rate
  control. So on NVENC hosts the first picture is unchanged; the sharp frame below still applies. The other GPU
  encoders keep their arguments (not measured here).
- **Then sharp** (`media/engine.js` scheduleSharp / requestSharp / onSharpFrame, `src/stream.js` sharp / sharpMore):
  once a paused frame has stayed shown 150 ms (a landed seek, a step from the queue, the packets or decoded memory),
  the page asks the host for that frame (`-ss` on the stream's frame grid, `-frames:v 1`) visually lossless
  (`transcode_args.js` sharpArgs: x264 CRF 11, NVENC CQ 13, no rate cap) as one IDR, built by `args()` with the
  stream's size, pipeline and tone-mapping; the stream's recorded pipeline state is saved and restored as for a fill.
  It goes out in pieces of at most 96 KiB the page pulls one at a time (each in its own ArrayBuffer: a view on a larger
  one crosses to the webview as the whole buffer), so a seek meanwhile waits behind one piece. The page decodes it with
  a second VideoDecoder (an IDR fed to the main one would break the following P-frames' references) and draws it only
  while still paused on that frame (same generation, nothing shown, sought or stepped since). It never enters the
  packet cache, the frames kept for steps back or the queue. A step, seek, play or hide drops a pending one and the
  host kills its ffmpeg. Steps and scrolls faster than 150 ms ask for nothing. Direct Stream (the source's own H.264)
  is not sharpened. Pixel tools and Exact Frame are unchanged.
- **GPU encoder sessions** (`src/gpu-sessions.js`, setting `videoPreviewEnhanced.gpuEncoderSessions`, machine-scoped,
  default 8, minimum 1): one host-wide budget counts every GPU encode (NVENC, QSV, AMF, VA-API, VideoToolbox, Media
  Foundation): live streams (held while the encoder runs, given back when the tab is hidden or the stream ends), fills
  (on top of `MAX_FILLS`) and sharp frames. A live stream that would go over it encodes with the CPU encoder (the
  existing fallback path) and the user gets one toast per session naming the video; a fill or a sharp frame over it is
  skipped (the soft picture stays). The loop standby process is not counted (it lives at most 20 s at the end of a
  file). The kept-running decoder (below) takes a session the same way.

Layer 3 `remote-stream-packets` › `paused-sharp` (1080p25 noisy test clip, link throttled to 2 Mb/s with the test
hook, libx264 because this machine's NVENC needs a newer driver; page times from the seek):

| | before (both off) | after |
| --- | --- | --- |
| First picture of a paused seek the host serves | 1144-1180 ms | 197-235 ms (first keyframe 21-63 KiB) |
| Sharp frame replaces it | never | 4.9 s after the seek (1.0-1.1 MB over 2 Mb/s; 87-311 ms to encode) |
| Sharp frame is the frame shown | | yes: same frame number, and its pixels match the source's frame n, not n-1 or n+1 |
| 6 steps 40 ms apart | | at most 2 requests, the last for the frame it rests on |

The clip is temporal noise on testsrc2, the worst case for size: a visually lossless 1080p frame of it is ~1 MB, so on
a 2 Mb/s link "sharp" takes seconds; ordinary footage is several times smaller.

## Quick first picture, any encoder (built 2026-11-27)

Maintainer decision of 2026-11-27. The fast first picture above (`fastFirstBits`, a small first keyframe) works only with
libx264: NVENC ignores the rate buffer's start, and the kept-running decoder's encoder is already running. So:

```
page seek (paused) ─► host spawnVideo ─► stream ffmpeg / warm segment ──► frames ─┐ held (answer) until the quick
                          │ slow link, no small first keyframe                     │ picture is out, at most 3/4 of a
                          └─► startQuick: same args() at w/2 x h/2, -frames:v 1 ───┴► 'quickFrame' first, then batches
page: onQuickFrame ─► sharp frames' VideoDecoder ─► drawn as VideoFrame{displayWidth/Height = stream size}
      only while that seek has shown nothing (same gen, seekTarget set); the seek's own frame replaces it
```

- **When** (`src/stream.js` spawnVideo / startQuick): the same rule as the small first keyframe (paused, remote, the
  link estimate would not carry a full keyframe within 100 ms, test hook `fastFirst`), and the start did not get a
  small first keyframe (any encoder but x264, or a warm segment). Not for Direct Stream.
- **What**: the target frame alone, built by `args(t, false, { quick: true })` with the stream's encoder, pipeline and
  tone-mapping at half the width and height (a quarter of the pixels, so about a quarter of a full keyframe's bytes),
  one IDR (`-frames:v 1`). A GPU encoder holds a GPU encoder session for it (`quick`); none free: skipped.
- **Ahead of the stream**: `answer()` holds the stream's batches until it is posted, at most 3/4 of the time a full
  keyframe would take on the link estimate (beyond that the full one would show sooner), 100 ms to 1 s; 1 s with no
  estimate or with the test hook. Not ready by then: killed, the stream goes first.
- **Page** (`media/engine.js` onQuickFrame / showQuick): decoded by the sharp frames' second VideoDecoder (outputs are
  routed by decode order: each is one IDR), drawn scaled up by giving the VideoFrame the stream's display size (the
  renderer sizes its canvas by it). Never in the packet cache, the frames kept for steps back, the queue or the main
  decoder. A seek, play or hide drops it (the host kills its ffmpeg on the seek).

Layer 3 `remote-stream-packets` › `paused-quick` (1080p25 noisy clip, link throttled to 250 000 B/s with the test hook,
NVENC through an ffmpeg 2024 master build passed to the runner with `--ffmpeg`, since ffmpeg 9 on PATH needs a newer
driver for NVENC; 3 fresh paused seeks each, medians, page time from the seek):

| | before (neither) | after |
| --- | --- | --- |
| First picture | 1842 ms (the stream's full keyframe) | 531 ms (the quick picture: 31-32 KiB, encoded in 290-709 ms) |
| The stream's own frame | 1842 ms | 1966 ms (it waited for the quick picture) |
| Landing | exact frame | exact frame, full size after the quick picture |

With libx264 (ffmpeg 9 on PATH; the quick picture forced through the test hook instead of the small first keyframe,
which is what x264 hosts get): first picture 1162 -> 320 ms (44 KiB, encoded in 117 ms), the stream's frame 1216 ms.
On a loaded machine an x264 quick encode can miss its wait (the stream encoder competes for the CPU): it is then
dropped and the stream goes first.

The quick encode is a cold ffmpeg (open, decode to the target, NVENC init: ~300 ms on an idle machine); the test
machine was loaded, hence the 709 ms one. The test hook's link throttle delays each message by its own size, so the
real link adds the quick picture's ~0.13 s at 2 Mb/s to the stream's frame as well.

## Play from the page's packets with sound (built 2026-11-27)

Maintainer decision of 2026-11-27 (item 6 of "With more resources"). Play after a paused seek served from the page's
packets already offered the host the target's GOP (`seek.have`, host `skipHeld`), so the picture moved at once; the
sound still came from the host, so on a slow link the clock ran on the timer and the sound joined late.

- **Kept** (`media/packet-cache.js` addSound / soundFrom): every sound item as received (`receiveRemoteBatch`, before
  decoding): Opus batches (packets with their 80 ms preroll, `skip` / `samples` trims) or 16-bit PCM, by time, in the
  same budget as the packets (`liveTranscodeCacheMB`; the least recently used GOP or sound chunk goes first). The same
  sound read again replaces the old copy.
- **Offered** (`media/engine.js` seekAbs): with the GOP, the sound held without a gap from the play position on, at
  most a second past the held packets, cut to start exactly there (Opus: `skip` grows; PCM: samples cut). The seek
  carries `have.audioUntil`.
- **Host** (`src/stream.js` skipHeld): when it skips the page's packets, it also sends sound from `audioUntil` (or from
  as far as its history has it; never back).
- **Page** (takeHeld): PCM goes in with the held packets; Opus is decoded first (the WebAssembly decoder), and the
  host's next batches wait for it (`soundGate`), so sound stays in time order. Sound the host sends again anyway is cut
  where the page's ends (`audioKeepUntil`, now for PCM too). Video-only files: nothing changes.
- **A/V sync**: the held sound starts at the play position on the same timeline as the host's (its own times); the
  clock anchors on it when the seek lands, as with the host's sound.
- **Limits**: only plays that take the page path (the seek served from the page's packets and the host still holding
  that GOP). A seek served from the decoded frames kept, or a host that restarts there, sends everything as before.

Layer 3 `remote-stream-packets` › `play-cached-sound` (1080p25 clip with Opus sound, link throttled to 250 000 B/s with
the test hook; page time from play): the picture moves after ~45 ms either way. The hidden desktop gives the page no
user gesture, so its AudioContext stays suspended and nothing is heard; measured instead is when decoded sound covering
the play position is in the page's queue (what a running AudioContext would start from):

| | before (held sound not used) | after |
| --- | --- | --- |
| Sound ready from the play position | 555-567 ms (3 plays) | 13 ms (1 of 3 plays took the page path; see Limits) |
| Picture moving | 45-48 ms | 45 ms |

`play from X s: picture moving after N ms, sound ready after M ms, heard after K ms from S s past the start` is now
logged on every play (`media/engine.js` notePlayStart) for measuring with a real AudioContext.

## Kept-running decoder (built 2026-11-27)

Maintainer decisions of 2026-11-27: a single video gets one; in Compare only the video that sets the clock (the others
start ffmpeg per seek as before); it ends after 60 s without use; it counts against the GPU encoder session budget (none
free: no warm process, the stream behaves as before); remote and local Live transcode both qualify, Direct Stream does not.

**How it works** (`src/warm-decoder.js`, used by `src/stream.js` warmSegment):

- One ffmpeg per stream runs the stream's own pipeline (decode, scale, tone-map, encode; `args(..., { warm: true })`)
  with MPEG-TS on stdin and stdout. A paused start (the open, a paused jump, a restored region continuing) is a
  *segment*: a copy remux (`-ss t+¼ frame -copyts -c copy -f mpegts`, no decoder, ~25 ms to its first bytes) from the
  keyframe at or before the target, fed in by the host. Seeking a quarter frame past the target makes a target on a
  keyframe start there (`-ss t-0.0005`, as the per-seek path did, decodes the whole previous GOP: on a 4K H.264 clip
  with 12 s GOPs, 1.8-2.5 s instead of 0.34-0.62 s; the per-seek path is fixed too, see "Seek onto a keyframe" below).
- **Times decide everything.** The remux's `setts` moves each packet onto a "warm clock": the target at S (past
  everything fed so far), the frames after it at their exact offset from S, the frames before it (decoded only as
  references) to whole frames half a frame off the grid. A `select` right after the decoder keeps on-grid frames only,
  `force_key_frames` makes the first frame after a jump of the clock an IDR (`-forced-idr 1` on NVENC), and the
  output's MPEG-TS times say which segment and which frame each packet is; packets of an older segment are dropped. A
  frame off its slot (VFR, a lost frame) or a first frame that is not an IDR with SPS/PPS fails the segment.
- **End of sequence before each jump.** The host puts a one-NAL PES (H.264 type 10, HEVC type 36) before a segment's
  first frame. Without it an open-GOP CRA after the previous segment is decoded as if its leading pictures' references
  existed, and the frames up to the next keyframe were lost (seen on an open-GOP HEVC MKV); with it the CRA starts like
  after a real seek and the old segment's held pictures come out (and are dropped by time).
- **Whole frames in.** The host forwards a video PES only once the next one begins, rewrites the continuity counters
  across segments, and cuts a segment only at a PES boundary, so no half frame is left in the pipe.
- **Flow.** ffmpeg holds ~8-12 frames (demuxer, decoder reordering, CLI queues); the remux keeps feeding, so the target
  comes out after ~12 more frames are decoded. When the stream holds 2 s ahead it pauses the remux (not the process's
  output), so a paused jump leaves only those held frames to flush (decoded and encoded, then dropped) at the next one.
- **Ends:** 60 s without a segment (`WARM_IDLE_MS`), hidden tab, dispose, a changed configuration (size, bitrate, encoder,
  tone-mapper: the argv is its key), the source's end (its last frames come out only when stdin closes; the next jump
  starts a new process), a clock about to wrap (33-bit MPEG-TS times: a new process, practically never). A failure (a
  segment's checks, the process or a remux exiting, no picture 5 s after the target was fed) logs why, turns it off for
  that video and restarts from the first frame not sent, as ffmpeg per seek.
- **Not used for:** a seek while playing (keeps the per-seek path's 2 s keyframes; the warm process encodes with the
  paused 0.5 s spacing), the fast first picture (an x264 encode with a small first keyframe needs a fresh encoder: on a
  slow link that wins), sources other than H.264 / HEVC, a variable frame rate (`r_frame_rate` ≠ `avg_frame_rate`),
  interlaced, containers without packet times (AVI), frames off the file's start grid, encoders other than libx264 and
  NVENC (QSV, AMF, Media Foundation, VideoToolbox, VA-API, OpenH264: not checkable here; they keep ffmpeg per seek).
- Compare: the page sends `warm` with each seek (`media/engine.js`, from `player-unified.js` isClock): true for a
  single video and the clock tile. A tile that stops being the clock gives its idle process back at once.

**Measured** (RTX 4070, NVDEC decode, libx264 encode since this machine's NVENC needs a newer driver for ffmpeg 9):

| | ffmpeg per jump | kept-running |
| --- | --- | --- |
| Layer 3 `remote-stream-packets` › `warm-decoder`: generated 4K HEVC, 15 fps, 50-frame GOPs, B-frames, open GOP; 6 paused jumps each to places not held; page time from the seek to its frame decoded (median) | 279 ms | 153 ms (first jump, starting the process: 329 ms) |
| Same, host "first bytes N ms after start" (median) | 260 ms | 138 ms (first: 309 ms) |
| Same, every landing the exact frame (its number drawn in the picture) | 6/6 | 6/6 |
| Scratch, 4K HEVC 60 fps 120 Mb/s, 2 s GOPs, NVDEC → x264 / NVDEC → NVENC (2024 ffmpeg), 10 jumps, first bytes (median) | 535 / 536 ms | 422 / 425 ms, 10/10 exact each |
| Scratch, 4K H.264 25 fps, B-frames, 12 s GOPs, 8 jumps | 1112 ms | 1007 ms, 8/8 exact |
| Scratch, 1080p HEVC open GOP MKV, CPU decode | 465 ms | 462 ms, 8/8 exact |

The saving is ffmpeg's start-up (open, probe, CUDA init: ~100-250 ms); the decode from the keyframe to the target stays
and dominates long GOPs (levels 3-4 remove it). CPU-decoded sources gain little. A new process costs ~50-100 ms more
than one ffmpeg per jump once (remux plus probing its input), paid at the first paused start of a video.

## Seek onto a keyframe (fixed 2026-11-27)

Every re-encoding ffmpeg start (a seek, a fill, a sharp frame, the restart after a fallback) used `-ss t-0.0005` so a
rounded page time could not drop the target frame. ffmpeg's input seek goes to the keyframe at or before that point, so
a target exactly on a keyframe started one GOP earlier and decoded it for nothing. And for formats that do not seek by
PTS, ffmpeg moves the seek point back another 3/23 s whenever a stream has B-frames (fftools `ffmpeg_demux.c`,
"dts_heuristic"); Matroska's cues are PTS, so in MKV every target up to 0.13 s after a keyframe paid the same.

Now (`src/transcode_args.js` seekArgs): ffmpeg seeks to `t + 0.0005` (plus 3/23 s for Matroska with B-frames, from the
probe's `has_b_frames`) with `-noaccurate_seek`, and a `select` right after the decoder drops the frames before
`t - 0.0005`, with `setpts` putting time zero where it was: the same frames come out on the same output grid, from the
right keyframe. MP4 seeks by PTS and needs no margin; other containers keep ffmpeg's. Direct Stream (a copy, no
decoder) and native ffmpeg keep their own `-ss`. If a future ffmpeg dropped the Matroska margin, the test
`test/host/seek_keyframe_test.js` (targets just before a keyframe, MKV) would fail rather than the player landing late.

Measured (scratch, CPU decode, the stream's own command to its first bytes, median of 3; 4K H.264 25 fps, 3 B-frames,
12 s GOPs):

| Target | MP4 before | MP4 after | MKV before | MKV after |
| --- | --- | --- | --- | --- |
| On a keyframe (frames 300, 600) | 1844 / 1446 ms | 403 / 293 ms | 1347 / 1139 ms | 226 / 245 ms |
| 1 and 3 frames after one | 314 / 368 ms | 318 / 388 ms | 1418 / 1369 ms | 276 / 293 ms |
| Mid-GOP (frame 450) | 654 ms | 665 ms | 654 ms | 632 ms |

The test reads what ffmpeg itself reports (`-debug_ts`, video packets demuxed before the first frame): 274 before, 25
after for a keyframe target in a 250-frame GOP, every landing the frame whose number is drawn in it (MP4, MKV, and a
variable-frame-rate MP4 checked against ffmpeg's own accurate seek).

## How others do it (research, 2026-11-27)

- **Jellyfin / Plex** restart ffmpeg on a seek outside what was transcoded, force keyframes on segment boundaries,
  and throttle the encoder ahead of the client; Plex restarts even on a 10 s seek back
  (github.com/jellyfin/jellyfin DynamicHlsController.cs, TranscodingThrottler.cs). Our host history already does
  better than that for seeks back.
- **mpv** keeps a seekable demuxer cache (150 MiB ahead, 50 MiB back), and a precise seek decodes from the keyframe
  with frames before the target dropped; frame-back-step is a precise seek (mpv.io/manual). Level 2 here is that
  back buffer on the page.
- **Pro review tools** (Frame.io, Resolve, Premiere, OpenRV) make scrubbing fast with all-intra or short-GOP proxies
  and a RAM frame cache over the in/out range; Frame.io serves 4K at ~14 Mb/s H.264 proxies.
- **Remote desktops** (PCoIP, Amazon DCV, Citrix): a changed screen goes out at a capped quality first, then a still
  picture is refined up to lossless: the model for a paused frame on a slow link.
- **HLS** (Apple authoring spec): keyframes every 2 s and a 1-fps I-frame playlist for scrubbing; hls.js starts with
  the lowest level to measure the link.

## With more resources (proposed, not built)

1. **A seek proxy on the host** (level 4): an all-intra or 1-s-GOP copy at view size made in the background on the
   GPU, kept on the host's disk. A seek or step anywhere then costs one small keyframe instead of ~2 s of source
   decode. Disk: ~2-4 GB per hour at 1080p. The pro-tool approach.
2. **Paused frame: fast then sharp** (display mode): after a paused seek, send the target as a small low-QP-capped
   keyframe at once and a sharper one after; the remote-desktop model. **Built 2026-11-27** (section above): first
   picture 1.16 s -> 0.22 s on a 2 Mb/s link with x264; NVENC has no per-frame lever in stock ffmpeg, so it gets a
   separate quick picture at half size instead (1.84 s -> 0.53 s; "Quick first picture, any encoder").
3. **Host pushes the GOPs around the playhead while paused** (level 3), within a share of the link, so the first step
   back after a jump hits the page's packets.
4. **A kept-running decoder on the host** (prototype above): ~134 ms instead of 340-470 ms per jump, no ffmpeg start.
   **Built 2026-11-27** (section below).
5. **GPU tone-mapping on NVIDIA** (libplacebo with a Vulkan device and CUDA interop, or a CUDA tone-mapper): removes
   the ~57 fps CPU tone-mapping limit for 4K60 HDR.
6. **Play from the page's packets with sound**: keep audio packets too, so play after a page-served seek starts at once
   while the host catches up. **Built 2026-11-27** (section above).
7. **Scrub stream**: while dragging, show keyframes only (I-frame trick play) and seek exactly on release.

## Setting (draft)

`videoPreviewEnhanced.seekCache`: `off | balanced | maximum`, default `balanced`.

| | Page RAM (levels 1+2) | Host | Background GPU work |
| --- | --- | --- | --- |
| `off` | today's budgets | today (32 MB history) | none |
| `balanced` | frame budget per today's table, + 512 MB packets | 512 MB packets | level 3 while paused (±10 s window) |
| `maximum` | `seekCacheMemoryGB` (default 4, up to what the machine has) | RAM + disk up to `seekCacheHostGB` (default 8) | level 3 + level 4 whole-file build |

Host parts are machine-scoped (they live in the remote's settings), like `transcode`.

Maintainer direction (2026-11-26): defaults conservative (never make the machine unusable), with full user control and
support for very limited links. So: the preset only sets defaults for individual settings the user can override (page
RAM GB, host RAM GB, host disk GB (default 0), background work `off | whenPaused | always`, share of the measured link
for prefetch (default 25 %, none on slow links), background GPU processes (default 1, lowest priority)). Note that in a
remote window the page cannot see the local machine's real RAM (`navigator.deviceMemory` stops at 8 GB), so going
beyond today's budget must come from the user's setting.

## Order of work

1. **Measure first**: a Layer 4 case "remote step back / seek latency" under `VPE_SIMULATE_LINK` presets (fast-ssh,
   typical-ssh) on a 4K HEVC long-GOP clip: p50/p95 of step-back and random seek to the right picture, single and 2×2
   Compare. This is the before/after yardstick (run on an idle machine).
2. Level 2 (page packet cache) + Level 1 budget from the setting. Page-only, no host change. **Prototype done**
   (fixed 64 MB, no setting yet; see "Prototypes").
3. Miss path: exact-target start + parallel lead; no throttle for discrete steps.
4. Level 3 rendition around the playhead with link-share push.
5. Level 4 whole-file proxy, host GPU queue, ⓘ status.

Each step ships on its own and is measured against step 1.

## Open questions for the maintainer

1. **Your links.** Typical bandwidth and RTT to the GPU hosts (LAN 1 Gb/s, VPN 50-100 Mb/s, ...)? It decides whether
   level 3 pushes ahead aggressively or only on request.
2. **Background GPU work.** Is a whole-file background build (level 4) acceptable by default in `maximum`, or only
   per file on request (e.g. ⚙ › "Build seek cache for this file")? PRODUCT currently rules out automatic proxy builds.
3. **Host disk.** May level 4 write to a temp folder on the remote (bounded, LRU, cleaned up), or RAM only?
4. **Rendition size.** View size (sharp at Fit, re-encode on zoom) or source size capped at 4K (larger, but zoom-ready)?
5. **Local windows.** Should the same levels apply to Live transcode locally (heavy 4K60 HEVC) or SSH/remote only?
