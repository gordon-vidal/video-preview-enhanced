# Native frames: a localhost connection instead of postMessage (2026-11-19)

Native ffmpeg decodes in the extension host and the webview draws the raw YUV 4:2:0 frames
(1.5 bytes a pixel; a 4K frame is 12.4 MB). Until now every frame was a `webview.postMessage`.
This note says what limited that, what replaced it, and what it measured. All numbers are from a
**real VS Code 1.147** (portable, `test/vscode/run.js` on a hidden desktop) on the desktop:
i7-9700K (8 cores, no HT), RTX 4070, 32 GB, ffmpeg 9.0.2 — never Edge. Other processes were using the
machine at the same time; every run went through `test/benchq.js`, and the noise is visible in
the tables (shown as ranges where runs disagreed).

## What it does now

- **`src/frameserver.js`:** one `http` server per extension host, started on first use, bound to
  `127.0.0.1` on a random port, `unref()`'d. Each `NativeDecoder` gets a **channel**:
  `/f/<16 hex id>/<64 hex token>` (256-bit secret from `crypto.randomBytes`, compared with
  `timingSafeEqual`). Wrong token, unknown channel, closed channel, or an `Origin` that isn't
  `vscode-webview://…`: **403**. One connection per channel; a new one replaces the old.
  It speaks two ways: a streaming HTTP response (the default) and a WebSocket (handshake + unmasked
  binary frames written by hand, no dependency). Every record is a 40-byte header (magic `VPEF`,
  kind 1 frame / 2 end of stream, gen, w, h, ys, t as float64, payload length, src as int32) and the payload.
  `src` is the picture's own source timestamp, in microseconds from `t` (minimum int32: unknown); it
  was a reserved zero before ([native-source-pts.md](native-source-pts.md)).
- **CSP:** local windows add `http://127.0.0.1:* ws://127.0.0.1:*` to `connect-src` (the port is
  random; the secret path is the protection). No `portMapping` needed: in a local window the
  webview reaches 127.0.0.1 directly (VS Code's webview service worker passes localhost requests
  through when no mapping matches). Remote windows (SSH, containers, WSL) don't get it and keep
  postMessage / the remote stream: 127.0.0.1 would be the remote machine.
- **Handshake (`src/native.js` `open()`):** before the frame size is chosen the host posts
  `{type:'link', mode:'http', url}`; `media/engine.js` opens the stream (`media/framestream.js`).
  The host sees the GET arrive (4-18 ms measured) and picks the size (when `nativeMaxHeight` is 0, the new default): **over the stream, full
  resolution up to 2160p when the video's frame rate fits ~400 MB/s, else 1440p or 1080p**
  (`decide.streamHeight`: 4K up to ~32 fps in full, 4K50/60 at 1440p, 1440p120 at 1080p);
  **by postMessage 1080p**. A number fixes the height either way (720p at most in WSL, as before).
- **Fallback, automatic:** the server can't start → postMessage. The webview can't connect (fetch
  rejects, e.g. 403) → it says so (`{type:'transport', failed}`) → postMessage. No connection
  within 3 s → postMessage. The connection drops mid-play (or a write fails) → postMessage, and
  the webview re-seeks to the current frame (frames in flight are lost). The log says which
  (`native transport: http (127.0.0.1:…, connected after 5 ms)` / `native transport: message (…)`).
- **Order:** frames and the end-of-stream marker go the same way, so the end can't overtake the
  last frames. Sound stays on postMessage (small).
- **Flow control:** the existing credits (the webview asks for frames) plus socket backpressure: the
  host holds back while two frames wait in the socket. Without that the credits alone let a
  webview that reads slower than ffmpeg decodes pile up seconds of 4K in the host (found in the
  first full-resolution run: "sent 72 fps" while the webview got 34, then `write EINVAL`).
- **Fewer copies:** a frame is kept as the pipe's ~64 KB chunks; the stream writes them as they
  are (corked, one writev). Before, each frame was `Buffer.alloc` (zero-filled) and copied together
  from the chunks with an O(n²) `shift()`: the "reading" share of the host thread at 4K dropped
  from 23-34 % to ~0 %. postMessage joins the chunks once (`Buffer.concat`).
- **Webview:** `fetch` + `getReader({mode:'byob'})` reads each record straight into one
  ArrayBuffer; the renderer gives the buffers back after upload (`recycle: true` frames, the same
  path the WebAssembly decoder uses), so steady 4K playback allocates no new 12 MB buffers.

## Measurements

### Raw transfer into the webview (no decoding)

`transfer-bench` case (`VPE_TRANSFER_BENCH=1`): host → webview, 240 × 1080p (3.1 MB) or 90 × 4K
(12.4 MB) records, second of two runs. MB/s, the range of four runs over two hours:

| | 1080p records | 4K records |
|---|---|---|
| postMessage (`bench`) | 385–467 | 417–459 |
| WebSocket | 467–754 | 572–770 |
| streaming fetch (BYOB) | 423–827 | 627–892 |
| streaming fetch read in a worker (frames transferred) | 423 | 540 |

postMessage on this desktop is ~3× what the laptop measured (140-180 MB/s), but it is not the
whole cost: in playback the host thread spends 50-73 % of its time posting 4K frames.

### Playback (native ffmpeg, 20 s clips, shown fps)

Clips (made from `test/media/hevc_10_2160p.mp4`, kept out of the repo): HEVC 10-bit 3840×2160,
29.97 fps (stream copy ×10) and 60 fps (x265 ultrafast). GPU method picked by the probe (it ran
to the end first in each fresh profile: d3d11va for the 30 fps clip, cuda for the 60 fps one).

Shown fps (median of 2 s windows over 8 s) / MB/s received by the webview / share of the host
thread spent sending. "Before" is the code before this change (its run had the GPU test running
in the background, and `-hwaccel auto`); the other rows are this build, with the transport forced
by `VPE_NATIVE_TRANSPORT` where it says postMessage.

| Build, frame size | transport | 4K 29.97 fps clip | 4K 60 fps clip |
|---|---|---|---|
| before, 1080p (old default) | postMessage | 30 / 93 MB/s / 12 % | 51 / 160 / 22 % |
| before, 2160p (`nativeMaxHeight` 2160) | postMessage | 28 / 348 / 52 % (+23 % reading) | 26.5 / 323 / 48 % (+22 %) |
| 1080p | postMessage | 30 / 100 / 19–23 % | 57–60 / 188 / 64–70 % |
| 2160p | postMessage | 21 / 255 / 70–77 % | 21.5 / 267 / 69–70 % |
| 1080p | frame server | 30 / 95–100 / 2 % | 60 / 185–188 / 3–5 % |
| 1440p | frame server | 30 / 166 / 3 % | 60 / 337 / 4 % |
| 2160p | frame server | 30 / 367–411 / 0–4 % | 30.5–37 / 392–467 / 0–1 % |
| **automatic (new default)** | frame server | **30 at 3840×2160** / 379 / 4 % | **60 at 2560×1440** / 346 / 4 % |

So the default goes from 1080p to full 4K for 4K up to ~30 fps, and to 1440p for 4K at 50-60 fps,
both at the full frame rate, with the extension host nearly idle. 4K60 in full would need 746 MB/s
and reached 30-37 fps, which is why the automatic height steps down (`decide.streamHeight`,
counting 400 MB/s).

Host thread share (the `native stats` lines): postMessage 4K 50-73 % sending; the frame server
0-3 % sending, ~0 % reading.

### ffmpeg alone (no VS Code)

`ffmpeg -hwaccel <m> -i clip -vf scale=…,format=yuv420p -f rawvideo pipe:1` into Node, 4K60 clip:

| method | 3840×2160 | 1920×1080 |
|---|---|---|
| cuda | 98 fps (1224 MB/s) | 124 |
| d3d11va | 78 (970 MB/s) | 85 |
| auto | 73-78 | |
| none (CPU) | 97 | 127 |

A stdout pipe and a TCP socket from ffmpeg to Node measured the same (65-71 fps, idle or with a
busy event loop), so the pipe is not a limit.

## What limits 4K above ~40 fps now

Not the host: it is nearly idle. With backpressure the stats show "webview waited for ffmpeg 0 %,
frames waited for the webview 0 %": the socket drains at the webview's pace, 400-490 MB/s during
4K playback (vs 650-890 in the raw bench, where the page does nothing else). Each 4K frame is read
into the renderer, uploaded with `texSubImage2D` (2 ms on the page, then Chromium copies it again
into the GPU process) and composited. Ideas, not done:

- **Less data:** 10-bit sources are converted to 8-bit 4:2:0 already; NV12 would not be smaller.
  A real reduction needs compression (a fast intra codec the webview can decode cheaply) or
  sending only every other frame at 2× speed playback.
- **GPU-side conversion in ffmpeg:** `scale_cuda=format=yuv420p` before `hwdownload` decoded
  the 4K60 clip at ~360 fps with `-f null` (vs 98 with the CPU `scale`): when ffmpeg becomes the
  limit again (laptops), that is the next step (`src/hwaccel.js` `videoFilter`).
- **Reading in a worker** (BYOB in a dedicated worker, ArrayBuffers transferred to the page and
  back): tried, no faster in the raw bench (540 vs 653-892 MB/s at 4K), and in one playback run
  its fetch didn't connect within 3 s. Removed.
- **WebSocket vs fetch:** within the noise of each other in playback (ws 30-40 fps, fetch 33-37 at
  4K60). fetch is the default (BYOB into reusable buffers; one fewer hand-written protocol);
  `VPE_NATIVE_TRANSPORT=ws` (tests only) switches.

## Not changed

- **Compare tiles** still get frames by postMessage: they are tile-sized (`nativeFor`), and the
  compare webview's CSP and engine wiring would need the same `link` step. Easy to add later.
- **Remote windows:** unchanged (WSL: postMessage at 720p; SSH/containers: built-in decoder or the
  remote stream, `src/remotestream.js`).
- **Pixel tools** still offer the built-in decoder for exact pixels; native frames of an 8-bit
  4:2:0 source at full size are now the file's pixels (`lossy()` is false), so it isn't offered there.
- `decide.js`: `transportFps(v, h, 'stream')` counts 400 MB/s (what a 4K player took, not the raw
  bench) for the decision's log line and `streamHeight`; the hint's estimates keep the
  conservative postMessage number.
- The GPU test (`src/probe.js`) still times ffmpeg's output at 1080p (with the automatic setting):
  it only picks the method, and 4K references would make it slower. At full 4K the download per
  frame is 4× larger, so a method that won at 1080p may not be the fastest at 4K (cuda 98 fps,
  d3d11va 78 here); both are far above 30 fps on this machine.
- `docs/PRODUCT.md` still says "native frames are scaled to 1080p".

## Tests

- `test/host/frameserver_test.js`: records over HTTP and WebSocket, 403 for a wrong token, a
  foreign origin and a closed channel, onLost, NativeDecoder waiting for the connection and
  falling back to postMessage.
- `test/vscode/cases/native_transfer.js` (in every `--quick` run): `native-transfer` (4K HEVC 10-bit
  with default settings plays at 3840×2160 over http) and `native-transfer-fallback`
  (`VPE_NATIVE_TRANSPORT=fail`: a wrong token, the player falls back to postMessage at 1080p and
  plays). With `VPE_TRANSFER_BENCH=1`: `transfer-bench`; with `VPE_TRANSFER_CLIPS=<folder>` also
  `native-bench-<height>-<mode>` (`VPE_TRANSFER_HEIGHTS`, `VPE_TRANSFER_MODES`,
  `VPE_TRANSFER_SECONDS`), each waiting for the fresh profile's GPU test to finish first.
