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

### Not proposed

- **A persistent seekable decoder on the host** (a libav helper or a Python/PyAV process) would remove the ~250 ms
  restart floor without caching, but adds a native binary or a runtime to install (PRODUCT and licensing decision).
  Revisit only if levels 1-4 leave misses that matter.
- **Sending raw or lossless frames** over SSH: 4K NV12 is 12 MB per frame; VS Code's tunnel cannot carry that quickly.
  Exact pixels stay with `grabExactFrame` for the pixel tools, as today.

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
2. Level 2 (page packet cache) + Level 1 budget from the setting. Page-only, no host change.
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
