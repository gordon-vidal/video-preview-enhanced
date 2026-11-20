# WebAssembly decode speed in VS Code

## Matched decoder measurements

The reported 2× slowdown did not reproduce when both environments decoded the same packets and
timed the same calls. Warm HEVC 4K was 8.6 fps in VS Code and 8.6–8.7 fps in Node. Warm VP9 4K and
AV1 1080p were also within 5% in either direction across the paired passes. The historical
comparison paired Node's uncapped `wasm dec` throughput with VS Code's paced `shownFps`.
Those measurements answer different questions and should be tracked separately.
[Node benchmark](../../test/bench/run_bench.js) · [test runner](../../test/run.js)

Measured 2026-11-19 on Windows 10, i7-9700K (8 logical cores), RTX 4070, portable VS Code
1.147.0 (Electron 43.8.9, Chromium 150.0.7871.250), and Node 24.22.1 (V8 13.6.233.17).
The harness launched VS Code on its hidden Windows desktop with a fresh profile. The editor's
webview still reported `document.visibilityState = visible`.

The temporary test hook ran the same loop in a dedicated webview worker and a Node
`worker_threads` worker. It used the checked-in `mixS` libav.js build, the same decoder calls,
an in-memory reader over the original fixture bytes, and 512 KiB packet batches. The normal
player stopped requesting frames during the probe. Each round reopened the demuxer and decoder
and drained at EOF. Rounds reused the Wasm instance to measure warm code. The decode timer
covered `ff_decode_multi(..., { copyoutFrame: 'ptr' })`, including packet copy-in and frame
references. It excluded the demuxer, heap copy-out, rendering and playback clock.

| Fixture | Frames | First decode pass, VS Code / Node fps | Two warm pointer-only passes, VS Code / Node fps |
| --- | ---: | ---: | ---: |
| `hevc_10_2160p.mp4` | 60 | 7.96 / 8.51 | 8.60 / 8.72 and 8.58 / 8.63 |
| `vp9_2160p.webm` | 60 | 12.29 / 12.08 | 12.36 / 12.36 and 12.41 / 11.83 |
| `av1_8_1080p.mp4` | 48 | 31.81 / 33.93 | 33.54 / 35.13 and 34.84 / 35.09 |

Both workers passed a Wasm SIMD validation probe and selected the same SIMD-enabled
`wasm` target in `direct` mode with `noworker: true` and `nothreads: true`.
The VS Code page and worker reported `crossOriginIsolated = false` and
`typeof SharedArrayBuffer = 'undefined'`. Node exposed `SharedArrayBuffer`. Both tests
used the same single-thread build, so this difference did not affect the selected decoder.
The extension can parallelize independent GOPs by opening more workers, each with its own
Wasm heap.

## Frame copies and messages

Three more rounds kept the original decoded bit depth and layout. The copy round used
the worker's normal `toYuv420` path into recyclable JS buffers. The transfer round also posted
those buffers to the page and received them back for recycling. The clone round omitted
the transfer list as a control. Times are for the whole clip.

| Fixture | Decoded MB | Heap copy-out only, VS Code / Node ms | Transfer calls, VS Code / Node ms | Clone calls, VS Code / Node ms | VS Code wall fps, copy / transfer / clone |
| --- | ---: | ---: | ---: | ---: | ---: |
| HEVC 10-bit 4K | 1,493 | 418 / 283 | 0.9 / 0.6 | 1,002 / 886 | 8.06 / 7.95 / 7.01 |
| VP9 4K | 746 | 201 / 135 | 0.7 / 0.4 | 572 / 344 | 11.53 / 11.99 / 10.37 |
| AV1 1080p | 149 | 37 / 29 | 0.5 / 0.2 | 104 / 75 | 32.96 / 33.92 / 31.56 |

Transferred batches reached the VS Code page in 0.3–0.8 ms. The clone control took
63–324 ms from send to receipt, including serialization. The normal decoder already uses
transfer lists, and the pool passes the received objects on in the same page. The remaining
copy from the Wasm heap cost about 7.0 ms per HEVC frame, 3.4 ms per VP9 frame and 0.8 ms per
AV1 frame in VS Code. This probe excludes the host block-read path and the WebGL upload.

## Compiler and scheduling controls

Default Wasm initialization in the probe took 35–36 ms in VS Code and 39–41 ms in Node.
The control cases used fresh instances with `--js-flags=--liftoff-only` or
`--js-flags=--no-liftoff` in Code and the equivalent V8 flags in Node. The measured region
was the pointer-only decode loop. Both environments slowed with Liftoff-only and normally
reached rates close to the optimizing-only control.

| Fixture | Liftoff-only, VS Code / Node fps | Optimizing-only, VS Code / Node fps |
| --- | ---: | ---: |
| HEVC 10-bit 4K | 5.02–5.13 / 4.95–5.07 | 8.09–8.29 / 8.01–8.61 |
| VP9 4K | 7.68–8.06 / 6.70–7.69 | 12.41–12.51 / 12.29–12.61 |

With timer throttling, renderer backgrounding and occluded-window backgrounding disabled,
VS Code decoded HEVC at 8.12 and 8.24 fps, compared with the default 7.96 and 8.60 fps for
the first and second passes. The 100 ms page interval ran at 93–106 ms in that control and
typically 92–108 ms in the other pointer-only controls. The nested zero-delay worker timer
settled at about 4–6 ms in both settings. The sample that included deliberate frame cloning
had occasional larger delays. During normal playback, the recurring 2 s status interval
stayed close to its nominal period. A genuinely hidden editor is a different state. The
player stops requesting decode work and releases the pool until the editor is shown again.

The pointer-only batch control repeated the 512 KiB pass after testing one packet and
96 KiB. VS Code wall rates for one packet, 96 KiB and the warm 512 KiB repeat were
8.67, 8.54 and 8.60 fps for HEVC and 71.66, 71.41 and 71.26 fps for ProRes.
The smaller batches did not materially change throughput.

## Normal playback and worker count

The test used the usual playback and paused-seek checks. The runner counts frames actually
shown in 2 s windows and takes the median after discarding the first window. Playback loops
by default, so these windows can span multiple starts of the 1–2 s files.

| Fixture | Media fps | Default pool, shown fps | One worker, shown fps |
| --- | ---: | ---: | ---: |
| HEVC 10-bit 4K | 29.97 | 7.5 | 8.0 |
| VP9 4K | 29.97 | 11.5 | 12.5 |
| AV1 1080p | 24 | 18.5 | 18.0 |
| ProRes 1080p | 24 | 23.5 | 23.5 |

All six extra workers started in the default pool. The HEVC, VP9 and AV1 fixtures each
contained a single key packet, so each had one GOP's worth of work for the pool to assign.
The slower 4K clips usually had an empty presentation queue and showed frames at close to
their arrival rate. Measured WebGL upload and draw submission took about 4 ms per HEVC
frame, 1.1 ms per VP9 frame and 0.3 ms per AV1 frame. This CPU timing does not measure
GPU completion.

ProRes decoded at roughly 72 fps inside the webview worker, and the same file showed
23.5 fps at normal speed and 12 fps at half speed. The display statistic follows
the playback clock. The one-worker run achieved the same display rate at normal speed,
so this test cannot show how much the pool helps uncapped intra-frame throughput.

## AV1 loop control

To explain the nearly 2× difference between AV1's uncapped decode and its displayed rate,
one worker played the original 2 s fixture, a 20 s remux of ten copies of its compressed video
packets, and the original again. FFmpeg made the remux with `-stream_loop 9 -map 0:v:0 -c copy`.
During every measured window of the remux, the player stayed short of EOF.

| One-worker playback | `shownFps` windows | Median after first window |
| --- | --- | ---: |
| Original, first run | 13.5, 16.5, 19, 21.5, 16.5 | 19 |
| Stream-copy remux | 14.5, 24, 24, 24, 24 | 24 |
| Original, repeat | 14.5, 16.5, 18, 22.5, 16.5 | 18 |

The original regularly waited for a picture around 0.00 and 0.04 s after rewinding. The
waits at 0.00 s recurred about every 2.62 s. At 48 frames per loop, that cadence corresponds
to 18.3 shown fps. The remux waited during the first GOP, then showed 24 fps at every
steady sample with 20 frames queued and zero reported drops. For this clip the apparent
2× gap combines a 24 fps presentation clock with repeated decoder refill at the loop
boundary. The underlying uncapped webview worker decoded at 34–35 fps once warm.

## Short-loop playback

The built-in player previously treated every wrap as a seek. It cleared the presentation
queue, reset the demuxer and decoders, and held the clock until the first picture was ready
again. For clips up to 5 s, the player now keeps a complete decode when the video and selected
audio fit the existing `media/membudget.js` frame allowance. WebAssembly frames share the
queue's buffers. Copyable WebCodecs frames are stored in system memory so the decoder can
release its output surfaces. At drained EOF the player reuses the frames and audio buffers
and carries the display clock's sub-frame overshoot into the next pass.

Clips that exceed the budget or use picture subtitles or non-copyable WebCodecs surfaces
use the existing rewind path. A hidden player drops its loop cache.

Measured in portable VS Code 1.147.0 on the same desktop, with the default worker pool.
Each clip is 2 s at 24 fps. The median excludes the first 2 s status window.

| Fixture and decoder | Before, shown fps windows | After, shown fps windows | Before → after median |
| --- | --- | --- | ---: |
| AV1 1080p, WebAssembly | 17, 18.5, 19, 18.5, 19.5 | 16.5, 24, 24, 24, 24 | 19 → 24 |
| H.264 1080p, WebCodecs | 22, 24, 24, 23.5, 24 | 20.5, 24, 24, 24, 24 | 24 → 24 |

The runner flagged other-process load during the AV1 baseline (31%). Its 19 fps median
also matches the earlier original-clip control. The regression case checks steady shown
fps within 1 fps of source, reuse of all 48 frames, and two paused seeks per decoder.

```text
node test/benchq.js node test/vscode/run.js --quick --grep '^case/short_loop$' --seconds 8
node test/benchq.js node test/vscode/run.js --quick --grep 'play/|case/(startup|multiview)'
```

The baseline passed 1/2 cases before the reuse assertion was added. AV1 failed the
frame-rate check. The post-change focused run passed 2/2 and the playback, startup and
multiview run passed 20/20. A repeat with `--grep '^case/(short_loop|playback_loop|subtitles)$'
--seconds 8` passed 7/7, with both clips again at a median of 24 fps. All 28 host test files
passed with `avi_scan_test.js` skipped.

## Recommendation

Use matched, uncapped worker decode to compare runtimes. Report actual display fps,
media fps, and the elapsed time of each display sample alongside it. Measure sustained
playback before the first EOF with a longer fixture and known GOP spacing. Record
short-loop restart separately. Retain transfer lists.

## Runs

Each run used the pinned portable executable via `VPE_CODE`. The case names below refer to the
temporary probes used for this investigation. The result JSON files are in the runner's
ignored `test/vscode/out/` directory.

```text
node test/benchq.js node test/vscode/run.js --quick --grep '^case/wasm_speed_default$' --json test/vscode/out/wasm-speed-default.json
node test/benchq.js node test/vscode/run.js --quick --grep '^case/wasm_speed_(liftoff|turbofan|scheduler|batch|play_default|play_one)$' --json test/vscode/out/wasm-speed-controls.json
node test/benchq.js node test/vscode/run.js --quick --grep '^case/wasm_speed_av1_loop$' --json test/vscode/out/wasm-speed-av1-loop.json
```

The hidden VS Code runs passed 3/3 matched checks, 16/16 compiler, scheduling, batch and
playback controls, and 3/3 AV1 loop checks. An initial sandboxed attempt stalled before
the renderer opened any fixture. The 3/3 rerun used the same hidden runner outside that sandbox.
