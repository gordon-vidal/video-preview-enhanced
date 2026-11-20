# Optimisations the user never notices (2026-11-20)

Items #1-5, #8 and #10 of [perf-candidates.md](perf-candidates.md) (#7, #11 and #13 wait for review).
One commit per item plus follow-ups from the real VS Code runs.

## Measurements

Hidden VS Code 1.147.0 (portable build, fresh profile, `test/vscode/cases/perf_invisible.js` with `VPE_PERF_BENCH=1`
through `test/benchq.js`), i7-9700K, RTX 4070, 32 GB, Windows 10, ffmpeg 9.0.2. CPU is the kernel + user time of
every process of the instance (Win32_Process) over the window, in **% of one core**; memory is private bytes
(`PrivatePageCount`). "Before" is main at dd34d31 (src/ and media/ checked out from it, same test case); "after" is this
branch. Clips: 20-30 s stream copies of `test/media` clips. One run each, so differences of a few tenths of a percent are noise.
The hidden desktop's page scale is 1.25 and its display refreshes the page at about 130 Hz.

| What | Before | After |
|---|---:|---:|
| Paused WebCodecs H.264 1080p + AAC in front, 6 s after the pause, 15 s window: CPU of the instance | 3.6 % (renderer 2.3, GPU 1.1) | **0.2 %** |
| Paused native 4K HEVC 10-bit in front, same | 3.4 % (renderer 2.5) | **1.4 %** |
| Animation frames run in 4 s paused (`state` hook; playing: ~130/s) | ~520 | **~100-120** (1 s after each probe, then none) |
| The 10 s after pausing native 4K HEVC: decoded ahead / CPU / renderer private | 4.94 s (148 frames) / 0.86 core-s / 742 MB | **1.07 s (32 frames) / 0.47 core-s / 338 MB** |
| The 10 s after pausing WebCodecs 4K H.264: decoded ahead / CPU / renderer private | 2.34 s (70 frames) / 2.69 core-s / 1207 MB | **1.7 s (51 frames) / 1.2 core-s / 989 MB** |
| A paused native 4K tab hidden behind another (paused) tab: ffmpeg processes / ffmpeg private / host private | 1 / 1332 MB / 280 MB | **0 / 0 / 267 MB** |
| Same, CPU of the instance over 10 s | 7.9 % | **3.7 %** |
| Native 4K HEVC 10-bit playing in a 1280x720 device-pixel picture: frames / CPU (ffmpeg, host, network, renderer, GPU) | 1920x1080 / 95 % (1.6, 22, 13, 32, 26) | **1280x720 / 69 %** (5, 10, 5, 19, 29) |
| Native 1080p HEVC (24 fps) in the same picture | 1920x1080 / 78 % | **1280x720 / 57 %** |
| Tool check (`ffmpeg -version`, `ffprobe -version`, `ffmpeg -filters`), node, per window | 86-270 ms, 3 processes | **4-12 ms** (stat of both binaries), 0 processes |
| ffprobe of a file opened again (node) | 50-120 ms, 1 process | **0.1-0.2 ms** |
| GPU vendor detection (PowerShell + CIM), per session | 1.2-1.7 s wall, **2.3-2.8 s CPU** of powershell.exe | none while the stored record is < 30 days old |

Bench JSON: `test/vscode/out/perf-before.json`, `perf-before-hidden.json`, `perf-after.json`, `perf-after-720.json`
(not committed). Tool, ffprobe and detection times: `node test/host/tools_cache_test.js` and a PowerShell `Process`
timing of the detection command (three runs each).

Not measured here:

- **AudioContext (#4):** the hidden desktop gives the page no user gesture, so Chromium's autoplay policy keeps the
  AudioContext suspended in every test instance, before and after. The rest / resume logic is covered by
  `test/engine/unit.js` with a fake context. The gain (a closed output stream and audio thread while paused; the machine
  may sleep) is the research's estimate: 0.5-2 % of a core.
- **VRAM** of the ffmpeg killed for a hidden tab (#1): the CUDA context of a 4K HEVC decode, estimated 200-500 MB; the
  1.3 GB is its committed private memory.
- The 720p numbers include the hidden window's GPU composition; the GPU process share barely moves, the host, network
  service and renderer shares fall with the frame bytes (44 % of 1080p).

## What changed

1. **Hidden tab stops native ffmpeg** (`media/engine.js` setHidden, `src/native.js` / `src/remotestream.js` setHidden): the
   page tells the host; the decoding ffmpeg, the standby for a loop and the frames queued in the host go (the remote
   stream stops its encoder and sound processes). Showing the tab always re-seeks for native (frames in flight are dropped
   first), which starts ffmpeg as any seek does. A live URL stream keeps running (it can't seek back). If the frame
   server connection drops while hidden, the next seek takes the message size.
2. **Frame loops rest** (`media/player.js`, `media/compare.js`, `media/xray.js`): paused, `engine.settled()` (no seek, read
   or spill under way, no frame due; packets held by a paused hardware decoder don't count), nothing dragged, no stats
   overlay / scopes / X-ray, and nothing changed for 1 s: no more `requestAnimationFrame`. Every message (host, workers),
   input event, resize, decoder output and `dequeue` event, seek and play/pause from code wake it (`env.wake`); the
   right-click context is refreshed on `contextmenu`. X-ray's own loop runs only while the strip is shown (chapter ticks
   follow the player's loop). `setState` and `pos` are sent only when the state changed. Test hook: `state.loop`
   (`frames`, `rests`, `busy`: what keeps it awake).
3. **Paused read-ahead ~1 s** (`PAUSED_AHEAD_S`) for native ffmpeg (also the remote stream) and WebCodecs; the WebAssembly
   decoder still fills its budget. Paused WebCodecs reads in 64 KB batches (one 384 KB batch of small 4K packets covered
   seconds). Only decoded frames count: counting packets a hardware decoder still holds stalled a paused step forward in a
   trial, because such a decoder may output a frame only after more input. So WebCodecs after a paused seek still decodes
   ~1.5-3 s ahead (the decoder's output lag), not 1 s.
4. **AudioContext rests** 3 s after a pause, at once when hidden, and after opening paused. `play()` resumes it and holds the
   clock at the paused frame until it runs (400 ms at most), so picture and sound start together; only an autoplay
   suspension touches the mute button, as before.
5. **720p and 540p native frame steps** (`VIEW_HEIGHTS` = 540, 720, 1080, 1440, 2160), with `sizeFramesToView` and the
   automatic `nativeMaxHeight` only; zoom counts as a bigger picture; pixel tools still switch to the built-in decoder.
8. **Tool check and ffprobe cached** (`src/ffmpeg.js`): the tool check is stored in globalState
   (`videoPreviewEnhanced.toolsCheck`) keyed by both binaries' resolved path, size and modification time and their folders'
   times; a native failure drops it. ffprobe results are kept in memory per file (path, size, time) and ffprobe build, 32
   files, handed out as copies.
10. **GPU vendor detection** only when the stored record (`videoPreviewEnhanced.gpus`, now with `at`) is missing, older than
    30 days or has no time, or a method guessed from it produced no picture (`src/native.js` onGuessFailed). Setup and
    Re-test still detect at once.

## Tests

- Host: `test/host/native_hidden_test.js` (native and remote stream stop while hidden, restart on the re-seek),
  `tools_cache_test.js` (cache keys, a replaced or rebuilt binary, ffprobe cache, timings), `vendor_detect_test.js`
  (recent / missing / old / timeless record, a failed guess), `native_fallback_test.js` (720 / 540 steps).
- Engine: `test/engine/unit.js` "invisible:" tests (read-ahead per decoder, `settled()`, `wake()`, hidden native,
  AudioContext rest and resume with the clock held).
- VS Code: `case/perf-invisible` (hidden native tab, pause/play with sound, paused read-ahead native / WebCodecs,
  loop rest with stepping, the time label and the right-click context); `case/native-transfer` expects the new steps.

## Not done

- #7, #11, #13 (review first). Compare tiles don't hear about a hidden tab (compare only pauses), so their
  native ffmpeg keeps running while hidden, as before.
- The ffprobe cache is per window (memory); a reload probes again.
