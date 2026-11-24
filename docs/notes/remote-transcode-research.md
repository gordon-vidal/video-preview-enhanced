# Remote transcoding, ABR, and seamless switching: research and VPE roadmap

Research note, 2026-11-24. Surveys how leading open-source media servers, low-latency game/desktop
streamers, web ABR players, and network-capable local players handle remote transcoding, bandwidth
adaptation, and seek responsiveness — and maps the concrete gaps and top five improvements onto
Video Preview Enhanced's unified H.264-over-WebCodecs Live transcode engine
([ADR 0002](../adr/0002-live-transcode.md), [docs/PRODUCT.md](../PRODUCT.md)).

Does **not** modify `docs/PRODUCT.md` or ADR 0002 directly; product-truth impacts are called out
per proposal.

---

## 1. Comparative matrix: how leading systems solve remote streaming & ABR

| Dimension | Jellyfin / Plex / Emby | Sunshine / Moonlight / Parsec | hls.js / dash.js (Web ABR) | mpv (SSHFS / HTTP / `yt-dlp`) | VPE today (`src/stream.js`) |
|---|---|---|---|---|---|
| **Avoid unnecessary video re-encode** | **4-tier decision:** Direct Play → Remux (container repackage only) → Direct Stream (video `-c:v copy`, transcode incompatible audio only) → Full Transcode. | Not applicable (live framebuffer capture always encodes). | Client selects pre-encoded ladder renditions; codec/profile matched via `MediaCapabilities` / MSE. | Always Direct Play of original bitstream; `yt-dlp` selects best matching format/codec upfront. | **2-tier only:** Full video+audio transcode (`EncodedStream`) or skip to built-in decoder over raw block reads. No host-side video copy / audio-only remux path. |
| **Quality / bitrate switching** | Client switches HLS/fMP4 rendition at segment boundaries (2–6 s); server spawns/reuses per-rendition ffmpeg transcodes with shared segment cache. | **Zero-restart encoder reconfig:** NVENC `NvEncReconfigureEncoder`, QSV `MFXVideoENCODE_Reset`, AMF dynamic bitrate properties change bitrate mid-GOP without killing the session; IDR-on-demand only on packet loss or resolution change. | Seamless mid-playback switch at next segment boundary (MSE / WebCodecs `VideoDecoder` reconfigures cleanly on in-band SPS/PPS + IDR). | Manual/initial format pick (no mid-stream ABR); relies on deep demuxer cache to absorb jitter. | **Hard `restartVideo()`** (`SIGKILL` + cold ffmpeg respawn at `vBase`) on every tier change, bitrate cap edit, or playing grow-resize. Audio process stays alive; WebCodecs accepts in-band IDR. |
| **Bandwidth estimation & hysteresis** | Static client bitrate cap or simple client-side HLS/DASH ABR on pre-segmented streams; server throttles transcode ahead of playback. | Continuous RTT, jitter, and packet-loss telemetry (FEC/NACK); tapered bitrate step-downs with VBV/HRD bounds to avoid IDR spike stutters on congested links. | **hls.js:** Dual fast/slow EWMA (`abrEwmaFastLive`/`SlowVoD`, taking `min(fast, slow)`) + safety factor (`1.2–1.3×`). **dash.js:** **BOLA** (Lyapunov buffer-occupancy utility) + throughput hybrid + segment abandonment + oscillation guard. | Not applicable (single-rate pull); `cache-pause` pauses playback cleanly when buffer drains instead of thrashing. | Raw 2 s window `kbps` (no EWMA on link throughput). Fixed `DOWN_RUN = 2` (4 s to react), `UP_RUN = 4` (8 s), shallow `buffer >= 0.25 s` upgrade guard, no backoff against oscillation. |
| **HDR → SDR handling** | Hardware zero-copy tone-mapping (`tonemap_cuda` in `jellyfin-ffmpeg`, `vpp_qsv=tonemap=1`, `tonemap_vaapi`, Vulkan `libplacebo` with `bt.2390`); CPU `zscale`+`tonemap` fallback. | HDR10/PQ passthrough when client supports it, or GPU shader tone-mapping before encode. | Separate SDR/HDR renditions in manifest; client selects via `matchMedia` / `MediaCapabilities`. | Real-time GPU tone-mapping (`libplacebo` `bt.2390` / `spline`) on decoded frames on the client. | **HDR skipped completely** in `shouldTranscodeOnOpen` (`isHdr(video)` → `skip`). Over SSH, 4K 10-bit PQ/HLG falls back to WASM over block reads (~0.1–0.2× real time). `stream.js` hardcodes `bt709` output tags with no tone-map filter. |
| **Remote seeking & step-back** | Keyframe-aligned HLS segment lookup; disk-cached transcoded segments allow instant seek-back to any previously transcoded region; trickplay sprite sheets for scrubbing. | Live-only (no seek); IDR-on-demand for instant recovery. | HTTP byte-range fetch of target segment + init segment; client MSE buffer retains played segments up to quota. | Seekable compressed packet ring (`demuxer-max-bytes` forward + `demuxer-max-back-bytes` backward, `demuxer-seekable-cache=yes`) preserves multi-region/backward ranges; distinguishes fast keyframe seeks from exact seeks. | Single linear `SeekHistoryBuffer` (15 s remote, max 20 s) wiped on any out-of-range seek; `2.5 s` step-back lead; 60–400 ms scrub debounce; no multi-region cache; no remote scrub preview (`thumbhost.js` excludes Live transcode). |

---

## 2. Concrete gap analysis against VPE's codebase

Ground truth inspected: [`src/stream.js`](../../src/stream.js), [`src/stream-adapt.js`](../../src/stream-adapt.js),
[`src/stream-buffer.js`](../../src/stream-buffer.js), [`src/transcode_policy.js`](../../src/transcode_policy.js),
[`src/transcode_args.js`](../../src/transcode_args.js), [`src/transcode_probe.js`](../../src/transcode_probe.js),
and [`media/engine.js`](../../media/engine.js) (`sampleRemoteLink`, `pump`).

### Gap A — No Direct Stream / Remux mode for WebCodecs-ready H.264 (video copy + Opus audio)
- **Current code:** [`shouldTranscodeOnOpen()`](../../src/transcode_policy.js#L142-L167) and [`remoteQualifies()`](../../src/transcode_policy.js#L58-L68) offer only two paths on remote links:
  1. **Skip (`builtin`):** the webview's `decoder-worker.js` pulls raw container blocks over VS Code's SSH RPC channel. Even if the video is 8-bit 4:2:0 H.264 at 4 Mb/s, an MKV/MOV with 4.6 Mb/s TrueHD, 1.5 Mb/s PCM, or 5 alternate audio tracks forces all interleaved container bytes across SSH.
  2. **Stream (`EncodedStream`):** always runs a full decode → scale → H.264 re-encode pipeline ([`buildVideoPipeline`](../../src/transcode_args.js#L103-L154)), even when `mode === 'always'` or when the file is already 8-bit 4:2:0 H.264 at native display size (`w === v.width && h === v.height`) and within the bitrate cap.
- **Technical constraint in `stream.js`:** [`SeekHistoryBuffer.pushPacket()`](../../src/stream-buffer.js#L95-L103) synthesizes timestamps as `t = this.vBase + this.frameIndex / this.fps`, which only holds because VPE forces `-fps_mode cfr -bf 0` (no B-frames, decode order = presentation order). Original H.264 files almost always contain B-frames (DTS ≠ PTS) and may be VFR. Passing `-c:v copy` directly into raw Annex B (`-f h264`) loses PTS and would play B-frames out of order.
- **How to bridge it cleanly:** Pipe a minimal timestamped container from ffmpeg (e.g. fragmented MP4 or Matroska/Nut, or a tiny PTS-prefixed frame stream) when `-c:v copy -bsf:v h264_mp4toannexb` is active, so `SeekHistoryBuffer` records real packet PTS + keyframe flags while still feeding WebCodecs `EncodedVideoChunk` in decode order with accurate timestamps. Audio still runs in its separate Opus 96 kb/s process.

### Gap B — Hard `restartVideo()` causes visible stalls on every quality/size change
- **Current code:** [`EncodedStream.restartVideo()`](../../src/stream.js#L496-L510) immediately `SIGKILL`s `this.proc`, truncates `vAll` at `vNext`, and cold-spawns a new ffmpeg at `vBase`.
- **Measured impact:** Every link tier change (`adapt`), manual bitrate cap change (`setMaxBitrateMbps`), Compare resize (`setCompareOutput`), or playing grow-resize (`reSize`) pays a full cold startup: process spawn + demuxer seek to preceding source keyframe + decode preroll to `vBase` + encoder init + first IDR (~250–700 ms locally, plus SSH RTT). Meanwhile the webview's buffer is only ~1.0 s (`ahead = 1.0` in [`media/engine.js`](../../media/engine.js#L1070)) and during an upgrade `adapt()` fires with as little as `0.25 s` buffered — guaranteeing a visible freeze.
- **Why Sunshine's SDK approach doesn't map 1:1:** Standard CLI `ffmpeg` does not expose `NvEncReconfigureEncoder` or `MFXVideoENCODE_Reset` over stdin/IPC; adding a native C/C++ encoder daemon would contradict VPE's plain-JS, zero-build-dependency architecture ([AGENTS.md](../../AGENTS.md)).
- **What maps directly to VPE:** **Dual-overlap splice (pre-warmed handoff)** using CLI ffmpeg. Keep the current `proc` streaming up to `spliceT = next + overlapS` (e.g., 1.0–1.5 s) while spawning the replacement `proc2` at `spliceT` in parallel. Because WebCodecs already switches resolution/bitrate seamlessly on any in-band SPS/PPS + IDR packet, splicing `proc2`'s IDR right after `proc`'s last frame before `spliceT` eliminates the stall entirely without leaving CLI ffmpeg. (Must guard against consumer NVIDIA concurrent NVENC session limits by falling back to hard restart if `proc2` fails to open.)

### Gap C — HDR is completely excluded from Live transcode over SSH
- **Current code:** [`shouldTranscodeOnOpen()`](../../src/transcode_policy.js#L145) hard-skips `isHdr(video)` (`PQ`, `HLG`, or `Dolby Vision`). And [`args()`](../../src/stream.js#L361) unconditionally stamps `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv` without any tone-mapping filter.
- **User-visible pain:** On a Remote-SSH connection, opening any 4K 10-bit PQ/HLG HEVC or AV1 clip forces the built-in WebAssembly decoder over raw block reads, which decodes at 0.05–0.2× real time — effectively unplayable.
- **FFmpeg filter nuance (critical for BtbN LGPL builds):**
  - `tonemap_cuda` is a `jellyfin-ffmpeg` patch and is **not** present in stock upstream/BtbN LGPL ffmpeg builds.
  - Stock LGPL ffmpeg builds support (subject to probing via `tools.gpuFilters`, which VPE already probes):
    - **Vulkan / `libplacebo`:** `libplacebo=tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:format=yuv420p` (best quality, GPU-accelerated, supports BT.2390 and Dolby Vision 8.x/5).
    - **Intel QSV:** `vpp_qsv=w=W:h=H:format=nv12:tonemap=1` (zero-copy on Intel GPU).
    - **Linux VA-API:** `tonemap_vaapi=format=nv12:matrix=bt709:primaries=bt709:transfer=bt709` (zero-copy on Intel/AMD Linux).
    - **OpenCL:** `hwupload,tonemap_opencl=tonemap=hable:t=bt709:m=bt709:p=bt709:format=nv12` (cross-vendor GPU).
    - **CPU fallback (`zscale` + `tonemap`):** `scale` down to output size *first* (4K → 1080p cuts pixel work 4×), then `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` (or `mobius`; `hable` preserves highlights well and is fast).
  - **Dolby Vision:** Profiles 8.1 (HDR10 base) and 8.4 (HLG base) can tone-map identically to HDR10/HLG (matching [docs/notes/hdr-output.md](hdr-output.md)); Profile 5 stays skipped unless `libplacebo` is available.

### Gap D — Fragile ABR, slow reaction to stalls, oscillation risk, and a hidden GPU-decode bug
Inspecting [`src/stream-adapt.js`](../../src/stream-adapt.js) and [`src/stream.js`](../../src/stream.js) reveals five concrete weaknesses:
1. **Stepped-down tiers accidentally disable GPU decoding ([`src/stream.js:341`](../../src/stream.js#L341)):**
   `decodeMethod: this.tier ? 'none' : this.decodeMethod` forces CPU decoding on the remote host whenever `this.tier > 0`! On a 4K HEVC/AV1 source over a slow SSH link, stepping down to 720p suddenly spikes remote CPU usage and can turn a network bottleneck into a CPU decode bottleneck.
2. **No EWMA on link bandwidth:** `LinkAdaptController` smooths `topKbps` (`0.75 / 0.25`) but feeds raw single-window `m.kbps` into both the tier-skip loop (`line 119`) and the upgrade check (`line 107`). SSH TCP congestion bursts or brief Wi-Fi stalls can either plunge straight to 360p on one bad sample or prematurely step up on a single burst.
3. **4-second blind spot on sudden link drops:** `DOWN_RUN = 2` on 2 s windows means a completely stalled link (`buffer ≈ 0`, `mediaRate < 0.3`) waits 4 full seconds + restart latency before stepping down.
4. **Shallow upgrade buffer (`m.buffer >= 0.25`) & no oscillation backoff:** Stepping up with only 250 ms buffered while `restartVideo()` takes 400–700 ms causes an immediate rebuffer, which can trigger a step-down right back into a 720p ↔ 1080p loop.
5. **Coarse quality ladder:** `LINK_TIERS = [null, {720, 3000}, {480, 1200}, {360, 450}]` has no intermediate **1080p bitrate-capped tier** (e.g. `1080p @ 5000–6000 kb/s`) before cutting spatial resolution in half from 1080p/4K to 720p.

### Gap E — Single-region seek history and cold remote scrubs
- **Current code:** [`SeekHistoryBuffer`](../../src/stream-buffer.js) keeps 15 s of compressed packets (`REMOTE_HISTORY_S = 15`, `HISTORY_MAX_S = 20`) in a single contiguous array `vAll`. Any seek outside `[vAll[0].t, last + 0.5]` calls `this.buf.reset(start)` and **destroys the entire 15 s cache**.
- **Consequence:** Jumping back to check a scene 30 s earlier and returning to the playhead (or toggling between A and B markers) forces a full remote ffmpeg respawn + SSH round-trip both ways, even though 15 s of 5 Mb/s H.264 is only ~9 MB of RAM on the host.
- **Scrubbing:** As noted in [docs/notes/fast-scrubbing-architecture.md](fast-scrubbing-architecture.md), `thumbhost.js` currently excludes Live transcode, and `EncodedStream.seek()` runs accurate seeks during drag bursts (throttled to 200–400 ms), so dragging the seek bar over a 100 ms RTT SSH link feels sluggish.

---

## 3. Top 5 ranked improvements for VPE

Ranked by **user-visible impact per unit of effort and risk** for Remote-SSH and WAN workflows.

### Rank 1 — Smarter ABR + dual-EWMA + fix GPU decode on stepped-down tiers
- **What:**
  1. Fix [`src/stream.js:341`](../../src/stream.js#L341) so `decodeMethod` stays GPU-accelerated across all link tiers (do not force `'none'` when `this.tier > 0`).
  2. In [`src/stream-adapt.js`](../../src/stream-adapt.js), add dual fast/slow EWMA bandwidth estimators (hls.js style: e.g. fast α = 0.5, slow α = 0.2; use `min(fastKbps, slowKbps)` for upgrades and `fastKbps` for tier selection on step-down).
  3. Add a BOLA-inspired **panic step-down** (1 window when `buffer < 0.1 s` and `mediaRate < 0.5`) while keeping `DOWN_RUN = 2` for mild dips.
  4. Raise upgrade buffer guard from `0.25 s` to `0.8 s` (or coordinate with Rank 3 overlap splice) and add **exponential cooldown backoff** (`UP_RUN` doubles up to 16 windows if a newly upgraded tier re-starves within 10 s) to eliminate oscillation.
  5. Insert an intermediate **1080p @ 5500 kb/s** tier in `LINK_TIERS` before dropping resolution to 720p (skipped automatically if source/view is already ≤ 720p).
- **Effort:** **Small** (pure logic in `src/stream-adapt.js` + 1-line fix in `src/stream.js`; fully unit-testable in Node via `test/host/`).
- **User-visible impact:** **High** — faster recovery from real SSH stalls, sharper 1080p picture on 8–15 Mb/s links, no 720p↔1080p ping-ponging, and much lower remote CPU usage when stepped down on 4K sources.
- **Risk:** **Low** — self-contained pure state machine; easy to validate with `docs/notes/link-simulator.md` and existing `stream-adapt` / remote-stream tests.
- **`docs/PRODUCT.md` impact:** **None** — purely internal quality-ladder tuning; no UI or setting changes.

### Rank 2 — Hardware-first HDR → SDR tone-mapping for Live transcode
- **What:**
  1. Probe available tone-mapping filters during ffmpeg/tool inspection (`libplacebo`, `vpp_qsv` tonemap, `tonemap_vaapi`, `tonemap_opencl`, `zscale`+`tonemap`).
  2. In [`src/transcode_args.js`](../../src/transcode_args.js), add a tone-mapping filter builder when `isHdr(video)` is true: prefer zero-copy GPU (`vpp_qsv=tonemap=1`, `tonemap_vaapi`, or Vulkan `libplacebo=tonemapping=bt.2390`), fall back to `tonemap_opencl`, and finally CPU `scale` (to target size first) + `zscale` + `tonemap=hable` (or `mobius`). Keep Dolby Vision Profile 5 excluded unless `libplacebo` is confirmed.
  3. In [`src/transcode_policy.js`](../../src/transcode_policy.js), allow HDR (PQ, HLG, DoVi 8.1/8.4) into Live transcode on **remote links** (and locally only when `mode === 'always'` or local transfer stalls on an SDR display, keeping local HDR-capable displays on the exact WebGPU HDR path per [docs/notes/hdr-output.md](hdr-output.md)).
  4. Surface `HDR → SDR tone-mapped` in `pipelineLabel()` (ⓘ and stats) so users know why colors are SDR and can click **Use original video**.
- **Effort:** **Medium** (filter probing, per-backend filter chains, unit tests + real-ffmpeg host tests on the PQ/HLG test clips).
- **User-visible impact:** **Very High** — turns 4K 10-bit HDR clips over Remote-SSH from unwatchable (~0.1× WASM) into smooth, color-accurate real-time playback.
- **Risk:** **Medium** — GPU filter availability varies widely across ffmpeg builds and drivers (e.g., BtbN LGPL builds vs distro ffmpeg, OpenCL/Vulkan availability on headless Linux). Mitigate with open-probing and automatic fallback to `scale` + `zscale`/`tonemap` CPU, then existing `onFail` fallback.
- **`docs/PRODUCT.md` impact:** **Update needed** — `docs/PRODUCT.md` and `src/transcode_policy.js` currently treat HDR as staying on the exact/raw path in v1; enabling remote HDR→SDR Live transcode (and noting it in ⓘ) requires maintainer sign-off and a line in `docs/PRODUCT.md` + `CHANGELOG.md`.

### Rank 3 — Zero-stall quality & resize transitions via dual-overlap splice
- **What:**
  1. Replace immediate `SIGKILL` in [`EncodedStream.restartVideo()`](../../src/stream.js#L496-L510) for planned transitions (tier step-up, `setMaxBitrateMbps`, playing `reSize`, `setCompareOutput` non-deferred) with a **dual-overlap handoff**:
     - Pick `spliceT = Math.ceil((lastQueuedT + overlapS) * fps) / fps` (where `overlapS ≈ 1.0–1.5 s`, or `0` on urgent panic step-down).
     - Spawn `nextProc` at `spliceT` while `proc` continues delivering frames up to `spliceT - 1/fps`.
     - Buffer `nextProc`'s initial IDR + packets separately; once `proc` emits the frame before `spliceT` (or hits EOF) and `nextProc` has its first IDR, atomically swap `this.proc = nextProc`, kill the old `proc`, and append `nextProc`'s packets to `vAll`.
  2. Guard against GPU session limits: if `nextProc` fails to start while `proc` is active (e.g. consumer NVENC concurrent-session limit or Compare multi-tile), immediately fall back to the existing stop-then-start `restartVideo()`.
  3. On urgent panic step-down, skip overlap (kill old immediately) so the old high-bitrate stream doesn't compete for the congested SSH link.
- **Effort:** **Medium** (process lifecycle & packet-queue splicing in `src/stream.js` + `src/stream-buffer.js`; zero webview changes because WebCodecs already accepts mid-stream SPS/PPS + IDR resolution changes).
- **User-visible impact:** **High** — eliminates the 300–700 ms visual freeze during ABR step-ups, panel/fullscreen resizes, and bitrate cap tweaks; makes adaptation feel as seamless as HLS/DASH or Moonlight.
- **Risk:** **Medium** — careful lifecycle cleanup is required so an interleaved `seek()`, `setHidden(true)`, or `dispose()` always kills *both* `proc` and `nextProc` with zero orphan ffmpeg processes.
- **`docs/PRODUCT.md` impact:** **None** (invisible optimization; aligns with existing "Users should not notice it" resizing rule).

### Rank 4 — Host-side Direct Stream / Remux for WebCodecs-compatible H.264 (video copy + Opus audio)
- **What:**
  1. Add a **remux / video-copy mode** to `EncodedStream` when the source is already 8-bit 4:2:0 H.264, no downscaling is needed (`w === v.width && h === v.height`), `tier === 0`, and video bitrate is within the cap — *especially* when the container has heavy/multi-track audio (PCM, TrueHD, FLAC, DTS, >1 audio track) or when `transcode === 'always'`.
  2. Run ffmpeg with `-c:v copy -bsf:v h264_mp4toannexb` into a lightweight timestamped pipe (e.g., Matroska/fMP4 or minimal PTS-tagged framing) so real PTS/DTS are preserved for B-frame H.264 streams, while the existing separate audio process transcodes only the selected audio track to 96 kb/s Opus.
  3. Report `Direct stream (video copy) → WebCodecs` in `pipelineLabel()` and set `lossy()` to `false` (pixel tools don't even need `grabExactFrame` when video pixels are untouched!).
  4. If the link later degrades (`adapt()` steps to `tier > 0`), seamlessly transition from video-copy mode to full transcode mode at the next IDR (or via Rank 3 overlap splice).
- **Effort:** **Medium–Large** (requires PTS-preserving framing/demuxer in `src/stream-buffer.js` to handle B-frames and VFR instead of `vBase + frameIndex / fps`, plus careful handling of SPS/PPS extradata vs Annex B and keyframe-aligned seeks).
- **User-visible impact:** **High for H.264 workflows** — zero host GPU/CPU video encode load, zero generation loss, instant startup, and massive SSH bandwidth savings on MKV/MOV files with uncompressed or multi-track audio.
- **Risk:** **Medium–High** — real-world H.264 files have quirks (open-GOP CRA/recovery points, negative CTS/edit lists, missing AUDs, VFR timestamps, mid-stream SPS changes). Needs thorough testing against `test/media/` and automatic fallback to re-encode on copy errors.
- **`docs/PRODUCT.md` impact:** **Minor update** — document Direct Stream (lossless video copy + Opus audio) alongside Live transcode in `docs/PRODUCT.md` and ⓘ pipeline label.

### Rank 5 — Multi-region GOP cache & fast remote scrub preview
- **What:**
  1. **Multi-region `SeekHistoryBuffer` (mpv-style):** Instead of wiping the entire 15 s `vAll` array on an out-of-range seek, keep a bounded byte-budgeted LRU (e.g., 24–32 MB on remote hosts ≈ 30–50 s at 5 Mb/s) of 2–4 recently transcoded GOP regions keyed by `[startT, endT, w, h, cap]`. Jumping back to a recently inspected timestamp or toggling between A and B markers becomes an instant memory hit with zero ffmpeg respawn.
  2. **Key-frame scrub preview over SSH:** Align with [docs/notes/fast-scrubbing-architecture.md](fast-scrubbing-architecture.md) by allowing `thumbhost.js` (or a low-res 360p/480p single-JPEG/keyframe fast path on the host) to serve drag-preview frames while Live transcode is active, committing the full `EncodedStream` seek once on pointer release.
- **Effort:** **Medium** (LRU segment map in `src/stream-buffer.js` is small and pure; scrub preview integrates with the broader fast-scrubbing work).
- **User-visible impact:** **Medium–High** — dramatically improves A–B review, repeated scene comparison, and seek-bar responsiveness on high-RTT SSH links.
- **Risk:** **Low–Medium** — bounded byte eviction prevents host RAM bloat; invalidate cached regions on tier/size/bitrate change.
- **`docs/PRODUCT.md` impact:** **None** for the host-side LRU cache (invisible optimization); scrub preview on the main canvas would follow the UI review noted in [docs/notes/fast-scrubbing-architecture.md](fast-scrubbing-architecture.md).

---

## 4. Summary table of ranked proposals

| Rank | Improvement | Effort | User impact | Risk | `docs/PRODUCT.md` impact |
|---:|---|---|---|---|---|
| 1 | Smarter ABR (dual-EWMA, panic drop, backoff, 1080p cap tier) + keep GPU decode when `tier > 0` | Small | High | Low | None |
| 2 | Hardware-first HDR → SDR tone-mapping in Live transcode | Medium | Very High | Medium | Update (remote HDR policy + ⓘ label) |
| 3 | Dual-overlap splice for zero-stall quality/resize transitions | Medium | High | Medium | None (invisible) |
| 4 | Host-side Direct Stream / Remux (`-c:v copy` + Opus audio) | Medium–Large | High (H.264) | Medium–High | Minor (describe lossless video copy in ⓘ) |
| 5 | Multi-region GOP LRU cache + remote scrub preview | Medium | Medium–High | Low–Medium | None (LRU) / shared with fast-scrubbing |

## 5. Implied decisions for maintainer sign-off

1. **Remote HDR policy (Rank 2):** Should Live transcode automatically tone-map HDR (PQ, HLG, Dolby Vision 8.1/8.4) to 8-bit SDR over Remote-SSH when `transcode` is `auto`, or require explicit opt-in? (Recommendation: automatic on remote links with a clear `HDR → SDR tone-mapped` label in ⓘ and the existing one-time Live transcode notice; local HDR stays on the exact WebGPU HDR path.)
2. **Direct Stream visibility (Rank 4):** When host-side video copy + Opus audio is active, should it still be grouped under Live transcode in ⚙ / ⓘ (showing `Direct stream (video copy)`), and skip the lossy-video notice since video pixels are untouched? (Recommendation: yes — no lossy notice when video is copied losslessly.)
3. **Overlap session budget (Rank 3):** Should dual-overlap splice be enabled only for single-player (or when active GPU encodes < 2) to stay safely under consumer NVIDIA NVENC concurrent-session limits? (Recommendation: yes — single-player by default, with automatic hard-restart fallback on open failure.)
