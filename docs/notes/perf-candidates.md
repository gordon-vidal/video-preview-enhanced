# Invisible performance work: candidates (2026-11-20)

Research only, no code changed. I checked each item against the code in this repository, with line numbers as of today.
Gains are estimates unless the note says "measured". The method for each is the `cpu_4k.js` approach: Win32_Process kernel+user time of every
VS Code process over a fixed window, private bytes for memory, `VPE_LOG` stats lines for frame counts.

## Top 5

### 1. Kill native ffmpeg (and its standby) while the tab is hidden
`media/engine.js:1446-1459` `setHidden()` tells only the WebAssembly worker (`if (!this.cfg.native) ... 'hidden'`, l.1449). With native ffmpeg the
host never hears that the tab is hidden: `src/extension.js:1331-1336` only posts `visible` to the page. Once the engine stops asking (budget 0, l.1396),
ffmpeg stays alive but blocked on its pipe. It holds `maxQueued` frames in the extension host (`src/native.js:349`; up to 12 × 3 MB at 1080p,
12 × 12.4 MB at 4K) and its GPU decoder context (CUDA/D3D11 surfaces). A standby process from `prepareLoop()` (l.383) may also be alive. When the tab
is shown again, the engine re-seeks (`resyncOnShow`, l.1455-1457), and `seek()` → `startAt()` kills that process anyway. So killing it when the tab
is hidden costs nothing extra. Forward a `hidden` message to `NativeDecoder` / `RemoteStream` (`src/remotestream.js:254` already receives
`hidden` and ignores it). On hidden, `kill()` + `takeStandby(NaN)` + drop `frames`. Always set `resyncOnShow` for native, even with an empty queue.
For a remote stream this also stops the encoder on the server. **Gain:** about 100-300 MB RAM plus GPU memory (one 4K HEVC CUDA context is roughly
200-500 MB of VRAM) per hidden native tab, and up to 150 MB in the host. Measure: private bytes of ffmpeg.exe, the extension host and nvidia-smi VRAM
with 3 native tabs, 2 of them hidden. **Risk of being noticed:** very low (showing the tab already restarts ffmpeg). **Effort:** S.

### 2. Stop the always-on rAF loops while nothing changes (paused, or no tool open)
`media/player.js:369-396` runs `frameLoop` on every display refresh for the page's whole life, also when paused. Each frame it:
- writes `ui.seek.value`
- builds key strings and maps/joins `bufferedRanges()` (l.298-337)
- builds and `JSON.stringify`s the context-menu object (l.1002-1011)
- reads `stage.clientWidth/Height` in `insp.tick` (inspect.js:568), which forces layout
- sends `vscode.setState` + a `pos` message every second even when nothing changed (l.387-390)

`media/xray.js:505-531` runs a **second** rAF loop on every player page, even if X-ray is never opened. `media/compare.js:1352-1368` has the same
pattern. A rAF loop keeps the renderer and GPU process waking at 60-144 Hz, so the CPU never reaches deep idle (battery). The fix: when paused,
with no pointer, drag, toast or tool activity, stop requesting frames and restart on input, message, resize, play or seek. Skip
`setState`/`pos` when t is unchanged. Start xray's loop only while X-ray is shown. **Gain:** estimated 2-8 % of a core (renderer + GPU process) per
visible paused player, double on 120/144 Hz screens; lets the package idle. Measure: CPU of all VS Code processes over 30 s with a paused video in
front, before and after; Chrome tracing for wakeups. **Risk:** low if every wake-up path is covered. The risk is a UI element that stops updating
(time label after a host message). **Effort:** M (S for xray loop + setState only).

### 3. Cap paused read-ahead for fast decoders (native ffmpeg, WebCodecs)
`media/engine.js:1371` uses `ahead = this.playing ? 1.0 : 3600`. When paused, every backend decodes ahead until the memory budget is full
(`budget()` l.1396: 400 MB on 32 GB; about 130 frames of 1080p). Only the remote stream is capped (10 s, l.1362). For native ffmpeg this means every
pause and every paused seek restarts ffmpeg and pushes about 130 frames through host → TCP → network service → renderer. A forward step is cheap
anyway, because the running ffmpeg is positioned at the next frame. For WebCodecs it also triggers `spill()` (l.1249): `copyTo` plus a JavaScript
per-byte NV12 → I420 de-interleave (l.1297-1305) for each frame past GPU_FRAMES. Fix: when paused, read ahead about 1 s (or about 30 frames) for
`cfg.native` and `vmode === 'webcodecs'`, and keep the full cache only for software (WASM) video, where it pays off. **Gain:** about 0.5-2
core-seconds per paused seek or pause with native at 1080p (more at 4K), and about 300 MB less webview memory while paused. Measure: CPU-seconds in the
10 s after a pause, plus the paused private bytes of the webview renderer (startup-memory.md method). **Risk:** low. A long run of forward steps
on native is served by ffmpeg at more than 30 fps. **Effort:** S.

### 4. Suspend the AudioContext while paused or hidden
`media/engine.js:956` creates the AudioContext, and it is never suspended: `pause()` (l.1902-1914) only stops sources, and the code only calls
`resume()` (l.1892, 2022). A running AudioContext keeps Chrome's audio render thread and the OS output stream open at ~100 callbacks/s. On Windows
an open render stream shows in `powercfg /requests` and can keep the machine from sleeping on idle. Fix: `ac.suspend()` about 2-5 s after
pause and at once when hidden. `play()` already resumes it (l.1891). The page has sticky user activation, so resume works without a new gesture.
**Gain:** estimated 0.5-2 % of a core (renderer audio thread + audiodg.exe), and the machine can sleep with a paused video open. Measure:
`powercfg /requests` with a paused video in front; CPU of audiodg.exe + VS Code's audio utility process. **Risk:** low (tens of ms more until the
sound starts on play; the picture is unaffected). **Effort:** S.

### 5. Smaller native frame steps for small pictures (add 720, maybe 540)
`src/native.js:20` sets `VIEW_HEIGHTS = [1080, 1440, 2160]`. The smallest frame is 1080p even when the picture is 600-720 device px high (a split
editor; a laptop at 100 % scale). Per cpu-4k.md, at 1080p30 the transport still costs about 0.8 core across the host, network service, renderer
and GPU process. 720p frames are 44 % of those bytes. The rest of the mechanism already exists: grow at once, shrink at the next seek
(`reSize()` l.212-224), and pixel tools switch to built-in (`lossy()`). Caveat: a 1080p source decoded on the CPU would now also go through swscale;
with scale_cuda/vpp_qsv it is free. **Gain:** estimated 0.3-0.4 core at 30 fps (0.6-0.8 at 60 fps) whenever the picture is ≤ 720 device px.
Measure: `cpu_4k.js` with the hidden window sized to about 1280×720. **Risk:** low (frames still cover every device pixel; enlarging grows them at
once). **Effort:** S.

## Full ranked list

| # | Optimisation | Where (file:line) | Expected gain / how to measure | Risk user notices | Effort |
|---|---|---|---|---|---|
| 1 | Kill native ffmpeg + standby + host queue when tab hidden (also remote stream) | engine.js:1449 (native not told), extension.js:1331-1336, native.js:349/383/595, remotestream.js:254 | 100-300 MB RAM + GPU context/VRAM per hidden native tab, ≤150 MB host; private bytes / nvidia-smi with hidden tabs | very low (show already re-seeks) | S |
| 2 | Stop idle rAF loops; skip unchanged setState/pos; xray loop only when shown | player.js:369-396, 298-337, 1002-1011; xray.js:505-531; compare.js:1352-1368; inspect.js:568 | ~2-8 % core per visible paused player (more at 144 Hz), deeper CPU idle; 30 s CPU paused, Chrome trace | low | M (S for xray+setState) |
| 3 | Paused read-ahead ~1 s for native and WebCodecs (keep full cache for WASM) | engine.js:1371, 1396; spill 1249, NV12 loop 1297-1305 | 0.5-2 core-s per paused seek or pause (native), ~300 MB webview while paused; CPU in 10 s after pause, paused private bytes | low | S |
| 4 | Suspend AudioContext when paused (after 2-5 s) / hidden | engine.js:956, 1902-1914 (never suspends) | 0.5-2 % core; machine can sleep; `powercfg /requests`, audiodg CPU | low (+tens of ms audio start) | S |
| 5 | Add 720 (540) native frame-height steps | native.js:20, viewCap 187-195 | ~0.3-0.4 core at 30 fps for pictures ≤720 px; cpu_4k.js in a 720p window | low | S |
| 6 | Share one compiled WebAssembly.Module across pool workers and the thumbs worker | pool.js:167 (spawn), decoder-worker.js:114 (LibAV init per worker); startup-memory.md "Not done" | ~40 ms CPU per worker start (×up to 6 per open, again after every unhide), less compiled-code memory; worker init logs | very low | M |
| 7 | Release idle memory: terminate pool extras after ~30-60 s paused; on hidden also drop engine block cache and worker FREE buffers | pool.js:101-104/262 (only on hidden), engine.js:572-635 (64 MB blocks kept), decoder-worker.js:248 (64 MB FREE kept) | 4K soft paused: 300-900 MB (100-150 MB WASM heap per extra worker, never shrinks); hidden: up to 128 MB/tab; paused private bytes | medium (first ~0.3 s of play after a long pause on 1 worker); none for the hidden part | S-M |
| 8 | Cache ffmpeg tool check per (path, size, mtime) in globalState; per-file ffprobe LRU keyed (path, size, mtime) | ffmpeg.js:42-66 (3 spawns per window), ffmpeg.js:142; callers extension.js:1063, 1738, 1820, 1946, 2058 | 50-150 ms of child-process CPU and latency per open/reload/compare; 3 spawns per window; more over SSH; host timeline logs | very low (stat-keyed) | S-M |
| 9 | Remote stream: s16 PCM instead of f32; size the encode to the picture like native | remotestream.js:44-49, 270, 293 (f32le, 3.07 Mb/s); 277 (h = min(source, 1080, tier)) | sound 3.07 → 1.54 Mb/s (at the 360p tier the total need drops ~3.5 → 2.0 Mb/s); remote x264 CPU ∝ pixels; remote stats lines, remote `top` | very low (16-bit is inaudible here) | M |
| 10 | Re-detect GPU vendor only if the stored record is old (e.g. 30 d) or a guessed method failed | extension.js:180-189, 204-209; hardware.js:30 (PowerShell + CIM every session) | one PowerShell start avoided per session: ~0.3-1 s CPU, ~60 MB transient; Process Monitor / CPU of powershell.exe | very low (failure fallback exists, native.js:398-410) | S |
| 11 | `preserveDrawingBuffer: false`; readers redraw the last frame before reading | engine.js:50; readers inspect.js:340, scopes.js:163/199, player.js:527/548/1272 | one full-canvas GPU copy per presented frame + a buffer (4K: 33 MB); matters on iGPU/battery; GPU process CPU, GPU-Z | medium (copy frame, inspector, scopes, PiP must redraw first) | M |
| 12 | No standby ffmpeg at EOF unless loop is on (or the clip is short) | native.js:383 (prepareLoop on every clean end), 456-470; remotestream.js:522 | one ffmpeg start (0.4-1.4 s CPU + GPU init) + a 20 s idle process per file end; host log + CPU | low-medium (Play after the end waits ~0.4 s) | S |
| 13 | Render WASM/WebCodecs pictures at device-pixel size when no pixel tool/zoom is on | engine.js:160-164 (canvas = frame size), 288-293 | 4K in a 1080 panel: canvas 33 → 8 MB per buffer, 4× less fragment work; GPU process CPU/memory | medium (scaling quality; tools need full size) | M |
| 14 | Leaner activation: lazy `require` of remotestream/urlsource/compare/probe/setup/avi…; skip unchanged `globalState.update` in fileIcons; async readdir in warnOldInstalls | extension.js:6-33, 836, 846 | ~10 ms per window start of the measured 16-25 ms, a few MB ext-host heap; `activated:` log line | none | S-M |
| 15 | Lazy-load tool scripts (xray, scopes, inspect, tracks-menu, subtitles ~130 KB) | extension.js:1566-1580; startup-memory.md "Not done" | ~10-20 ms page parse + a few MB per webview; page startup marks | low | M |
| 16 | Skip the WASM preload when the early probe already chose native | engine.preload (startup-memory.md change 1); extension.js:1357-1364 | 8 MB fetch + ~40 ms compile per native open; worker init log | none | S-M |
| 17 | Native sound: no per-sample `readFloatLE` de-interleave on the host thread; ask for the AudioContext's own rate instead of fixed 48 kHz | native.js:551-563, 13; remotestream.js same rate | ~1-2 ms host CPU per second of sound; one resample less at 44.1 kHz | none | S |

## Already done (verified)

- **Hidden tab:** playback pauses, decoded frames are freed, the pool's extra workers stop, and the page re-seeks when shown: player.js:816-829,
  engine.js:1445-1460, pool.js:101-104. (Native ffmpeg is the gap; see #1.)
- **Draws only when a new frame is due;** nothing is redrawn while paused: engine.js:1785-1805.
- **YUV 4:2:0 transport, not RGBA; 8-bit except HDR output:** native.js:324, 438-440. Texture storage is allocated once and `texSubImage2D` is
  used per frame: engine.js:166-225.
- **Buffer reuse:** framestream.js `MAX_POOL` 4 + `recycle`; native frames are kept as chunk lists with no copy (native.js:328-345); worker
  free list (decoder-worker.js:248); the previous frame's buffer is returned after upload (engine.js:233).
- **Back-pressure:** ffmpeg stdout pause (native.js:349); socket ≤ 2 frames buffered (native.js:516); remote 2 s queue (remotestream.js:375).
- **Memory budgets** are scaled from the machine's RAM (membudget.js; startup-memory.md).
- **Thumbnails:** hover only, the worker idles out after 20 s, native thumbnails use `-threads 2` at below-normal priority (thumbs.js, thumbhost.js:26-29).
- **Scopes:** about 10 Hz while playing, and only on a frame change when paused (scopes.js:412-424).
- **AudioContext:** `latencyHint: 'playback'` (engine.js:956).
- **Remote stream:** paused read-ahead capped at 10 s (engine.js:1362).
- **HDR WebGPU device:** created only for PQ/HLG video on an HDR display (hdr.js:246-250, engine.js:2286).
- **File watching:** event-based `fs.watch`, not polling (extension.js:1372).
- **Activation:** already cheap (16-25 ms measured); it does no ffmpeg or GPU work at startup (extension.js:958-1150).
- **Not worth it:** WASM threads are impossible (no SharedArrayBuffer in webviews), and the pool covers that. 10-bit software-decoded video is
  uploaded as R16 and converted on the GPU, which is cheaper than converting in WASM.

## Bigger idea, not ranked (L)

Frame transport is still the largest cost after `sizeFramesToView` (cpu-4k.md "Not done"). A further step would be for ffmpeg to serve the token-guarded HTTP
stream itself (or to write a compressed intra format), so frames skip the extension host's socket copy. That copy is ~19 % of a core at 1080p30.
