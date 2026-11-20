# Start-up time and memory (2026-11-19)

Work item: "start-up time" and "memory on 8 GB machines". Measured in a real VS Code 1.147
(portable, hidden desktop, `test/vscode/cases/startup.js`) on the desktop (i7-9700K, RTX 4070,
32 GB, Windows 10), through `test/benchq.js`. Other processes were running VS Code tests on the same
machine, so single numbers move by ±30–50 ms; the tables give the runs as measured.

```
node test/benchq.js node test/vscode/run.js --quick --grep '^case/(startup|memory)'
VPE_MEMORY_REPEAT=1 ...   # the memory cases twice
```

## How it is measured

- **Timeline:** with `VPE_LOG` set the extension logs `[file] startup host {...}` (epoch ms: module
  load, `activate()`, the session (`resolveCustomEditor`), the page's `ready`, ffmpeg lookup,
  ffprobe, the message that starts decoding) and the page logs `webview: startup {...}` with the
  first frame (navigation start, scripts, `ready`, engine start, libav.js fetched, worker ready,
  streams, configured, first frame, and the resource timings of the decoder's files). Both clocks
  are the machine's wall clock, so the phases line up across processes. The decoder worker logs
  how long `init` (importScripts + WebAssembly compile/instantiate) took.
- **Paths:** A = H.264 1080p with AAC (`h264_aac_anim_1080p.mp4`, GPU/WebCodecs, demuxed in the
  WebAssembly worker), B = HEVC 8-bit 1080p (`hevc_8_1080p.mp4`, WebAssembly), C = HEVC 10-bit
  4K (`hevc_10_2160p.mp4`, native ffmpeg, frames over the localhost frame server).
- **Cold:** the first open in a fresh VS Code (the extension activates on it); **warm:** the same
  file closed and opened again twice. Opens go through VS Code's CLI like the rest of the suite:
  the CLI itself (a Code.exe as Node) takes 340–500 ms before VS Code sees the file. That part is
  VS Code's and is left out of "session → first frame".
- **Memory:** the private bytes (commit) of every process under the test's Code.exe
  (`Win32_Process.PrivatePageCount`), split into the extension host (its pid is logged), the
  webview's renderer (the renderer that appears when the player opens: webviews run in their own
  process) and the GPU process; sampled every second for 5 s playing and 10 s paused (paused
  decodes ahead up to the budget: the "Fully decoded" cache). "Paused" is the median of the last
  5 paused samples. 4K HEVC 10-bit in the built-in decoder (decoder pool on). `VPE_TOTALMEM`
  (tests, VPE_LOG only) makes the extension size everything as for a machine with that much memory.

## Start-up: where the time goes (before)

Session → first frame, ms (base runs 1 and 2, same code):

| Path | cold | warm |
|---|---|---|
| A GPU H.264 1080p | 503, 515 | 275, 278, 296, 317 |
| B WebAssembly HEVC 1080p | 572, 601 | 406, 411, 416, 416 |
| C native HEVC 10-bit 4K | 782, 821 | 608, 613, 663, 703 |

Phases of a warm B open (ms): webview created 25–35, page load (HTML, CSS, 12 scripts) 40–85,
host decides 1, `ready` → engine 10–20, libav.js fetch 30–40, worker init 35–45, demuxer open
20, **first picture 210–235**. Cold adds activation (17–21 ms: module load plus `activate()`),
~60 ms of webview creation (VS Code's first webview) and fetches from a cold disk cache (60–100 ms
for the 8 MB .wasm).

What each suspect turned out to be:

- **Extension activation:** 16–25 ms in total (module load and `activate()`). Not worth cutting.
- **WebAssembly compile/instantiate:** 35–50 ms per worker, cold or warm. V8 compiles lazily
  (functions on first call), so the 8 MB module is not compiled up front; there is no code cache
  (it comes from a blob URL) but there is little to cache at start. Sharing one compiled
  `WebAssembly.Module` between workers would save ~40 ms per worker, off the first-frame path
  (only the pool's extra workers would gain). Not done.
- **libav.js fetch:** 30–100 ms after the host's answer, sequential with everything else.
- **ffmpeg lookup + ffprobe (C, and A/B whenever ffmpeg is installed):** 130 ms cold
  (`ffmpeg -version` + ffprobe), 50–65 ms warm, after the page's `ready`.
- **Decoder pool spin-up (B):** the 6 extra workers started as soon as the stream was configured,
  i.e. while the primary decoded the first picture.
- **First picture (B):** the first `more` asked for 96 KB of packets, so the worker decoded ~6
  frames before it answered with the first one: ~200 of the 410 ms.
- **First block reads:** 20 ms (HEVC MKV) to 70 ms (MP4 with the index at the end: several
  host round trips). Left as is.
- **Native ffmpeg (C):** ffmpeg's own start to the first 4K frame is 320–450 ms (`-hwaccel auto`
  before the GPU test has run). The biggest single cost of path C; see "Not done".
- **GPU probe:** not on the start-up path (it waits while native playback runs).

## Start-up: changes

1. **The decoder's files are fetched by the page's head** (`self.vpeEarly`, an inline script before
   the 12 player scripts) and the **WebAssembly decoder starts while the host decides**
   (`engine.preload()` after `ready`; the player takes it over with the messages it sent so far).
   Native ffmpeg and the MJPEG frame player drop it. libav.js fetch 30–100 → 0–30 ms.
2. **ffmpeg lookup and ffprobe start with the session** (`Session.probeEarly`), in parallel with
   the webview's creation and page load; `open()` takes the result for the first page (a reload
   probes again). Host decision on path C: 48–137 → 1–24 ms (up to 75–150 ms when ffprobe is slow
   on a loaded machine: then it outlasts the page load).
3. **One packet per batch until the first picture** (WebAssembly video): the first frame comes back
   when it is decoded. B's first-picture phase 210–235 → 120–140 ms.
4. Tried and dropped: **lazy pool growth** (the extra workers started after the first picture
   instead of when the stream is configured). It saved ~25 ms on B's first frame but held 300–400 MB
   more at 4K (webview paused 1730–1745 MB against 1330–1360 MB with the same budgets and the old
   start, two runs each): the primary decoded more 4K pictures alone, and WebAssembly heaps never
   shrink. The pool starts its workers as before.

Session → first frame after (ms):

| Path | cold | warm |
|---|---|---|
| A GPU H.264 1080p | 564–608 | 272–338 (one 445 with the machine 99 % busy) |
| B WebAssembly HEVC 1080p | 542–556 | **323, 325** (final run); 392, 465 with the machine 47 % busy |
| C native HEVC 10-bit 4K | 722–735 | 527–826 (ffmpeg's own start varies 320–620) |

The changes move whole phases (the numbers above per phase are stable across runs), but at this
size the run-to-run spread of the open itself (other VS Code test runs, ±50 ms) is as large as
the gain: A ±0 (the host answers in 1 ms there, so preloading has nothing to overlap with unless
ffmpeg is installed: then it hides the ffprobe), B −85 ms warm (410 → 325) and −20 to −45 ms cold,
C −50 to −130 ms of host time (but ffmpeg's start dominates). Start-up is already well under a second after VS Code has the
file; the user-visible wait from double-click is mostly VS Code's (CLI/explorer, editor and
webview creation: 400–500 ms).

### Native ffmpeg starts before the page (path C, 2026-11-19)

Before, ffmpeg was spawned only after the page's `ready`, the host's decision, the page's `open`
and the frame server negotiation (the transport decides the frame size): 31–52 ms after the
decision, and its own start (spawn, demux, first 4K frame) took 340–400 ms after that.

Now (`Session.startNativeEarly`, `NativeDecoder.prestart` / `attach`):

- As soon as the early ffprobe is back, the host makes the same decision `open()` will make
  (`decideNative`) and, when it is native ffmpeg, spawns it at the frame server's size (the
  message size when frames go by message anyway). Its frames wait in the host (no credits; at most
  the native queue, then ffmpeg blocks) and nothing is posted until the page is there.
- `open()` keeps that ffmpeg only for the same decision: same ffmpeg, the same probe object (so the
  same file: the probe carries the file's size and date, and `open()` compares them), method, size
  caps and transport. Otherwise, and for a failed early ffmpeg, it is killed and a new one starts.
  When the page is ready before the probe, `open()` spawns ffmpeg right after its decision, still
  before the transport negotiation (the same `prestart`).
- When the negotiation ends on messages (no origin, the page can't connect, `fail` in tests) and
  the size differs, `NativeDecoder.open()` drops the standby and restarts at the message size. The
  standby is now only adopted at the same size.
- Killed when: the page decides another decoder (or returns early: MJPEG AVI, remote stream on),
  the tab closes, the file changes before the page is ready (watcher), a reload, or no page within
  15 s. A failure before the page is there is not reported early: `open()` starts a fresh ffmpeg,
  whose failure takes the existing path (software retry, then `nativeFailed` → built-in).
- Review 2026-11-19-3 M1 (fixed with this): the session's early probe was taken late in `open()`,
  after the MJPEG / remote-stream-on / stat returns, and `reload()` never cleared it, so a file
  rewritten between pages (MJPEG AVI rewritten as MPEG-4) was decided from the old file's ffprobe.
  `open()` now takes the probe and the early ffmpeg at its top, `reload()` and a change before the
  page drop them, the probe carries the file's stat and is used only for the same size and date,
  and no ffprobe runs once the tab is closed or the probe was dropped.

Session → first frame, 4K HEVC 10-bit, native over the frame server, three fresh VS Code instances
each (cold + 2 warm), same machine and queue (`test/benchq.js`), ms:

| | cold | warm |
|---|---|---|
| before (main @cb1a907) | 825, 712, 724 | 654, 734, 599, 682, 622, 705 |
| after | 658, 706, 664 | 616, 623, 619, 661, 654, 641 |
| median | 724 → 664 (−60) | 668 → 630 (−38) |

- How far ahead ffmpeg starts (the "keeping the ffmpeg started … ms ago" line at the negotiation):
  cold 94–145 ms, warm 44–70 ms, and 27–42 ms when the page was ready before the probe (the first
  warm open in all three runs; then only the decision → negotiation part is hidden). Before, it
  started 31–52 ms *after* the decision.
- ffmpeg's own start to the first 4K frame went from 339–397 to 366–425 ms: it now shares the CPU
  with the page load. So the saving is smaller than the lead.
- From the host having the first frame to the page showing it: 107–166 ms before, 107–150 after
  (12.4 MB through the socket and `fetch`, the first WebGL upload and draw). Unchanged and now the
  largest piece after ffmpeg's start; not investigated.

### Native first frame: overlap ffprobe and prepare WebGL (2026-11-19)

In the hidden VS Code 1.147 runner with ffmpeg 9.0.2, the 4K HEVC clip spent 57–186 ms
waiting for ffprobe before spawning ffmpeg. The host sent the first complete frame immediately.
After transfer, the first WebGL draw paid for canvas sizing, texture allocation and initial draw
setup on the critical path.

- For a simple, non-fragmented HEVC MP4/MOV, a bounded `moov` read supplies the tentative
  stream indices, dimensions, bit depth and constant frame rate. ffmpeg starts alongside ffprobe.
  The session adopts the process only after the regular decision confirms the file, tools, launch
  parameters and transport. ffprobe still supplies the playback metadata. A disagreement or
  failed start discards the tentative process. Trust, prior native failures, and requests for
  exact pixels still control eligibility.
- Once the native streams report their output size, the webview sizes the canvas and prepares
  the three YUV textures with a masked draw while ffmpeg decodes. The first frame uses the same
  raw YUV transport and shader as the later frames.

Each run used a fresh VS Code and opened the clip three times. Times are in ms from the custom
editor session to the first frame draw. Bold values are medians.

| Change | Cold | Warm |
|---|---|---|
| Before (`6ccd364` plus timing marks) | 669, 638, 835 (**669**) | 622, 566, 650, 598, 576, 573 (**587**) |
| WebGL preparation alone | 647, 616 (**632**) | 585, 533, 543, 592 (**564**) |
| Both changes | 605, 575 (**590**) | 537, 546, 504, 533 (**535**) |

The combined medians fell by 79 ms cold and 52 ms warm. With the command-line handoff included,
the medians were 1224 → 1023 ms cold and 1035 → 967 ms warm. The single trial with MP4
launch alone started earlier, but ffmpeg took 408–493 ms to produce the first frame under
higher load. That trial measured 636 ms cold and 646/576 ms warm.
The broader regression run measured 573 ms cold and 575/498 ms warm.

| Phase (ms) | Before | Both changes |
|---|---:|---:|
| Session → ffmpeg launch, cold | 155–403 | 111–121 |
| Session → ffmpeg launch, warm | 94–129 | 10–36 |
| Start ffprobe → launch ffmpeg | 57–186 | Same millisecond |
| Launch ffmpeg → ffprobe confirmed | ffprobe finished before launch | 59–123 |
| ffmpeg launch → first complete frame in host | 334–383 | 393–470 |
| Frame server connect | 5–15 | 6–16 |
| Canvas and texture preparation while decoding | Part of first draw | 43–59 |
| First complete frame → send | 0–1 | 0–1 |
| Send → complete frame in webview | 34–63 | 45–65 |
| Frame received → start drawing | 0–7 | 3–6 |
| Draw → first-frame mark | 56–76 | 6–8 |

### Earlier native starts for more containers (2026-11-19)

Native playback of these files used to wait for ffprobe before spawning ffmpeg. The asynchronous
MP4/MOV `moov` sniff now recognizes VP9, AV1, H.264 High 10/4:2:2, and ProRes 422 in addition to
HEVC. It checks for a single video track, a non-fragmented sample table, and constant decode and
presentation timing. Matroska/WebM can also start HEVC, VP9, and AV1 from the EBML metadata.
Matroska's `DefaultDuration` alone cannot establish a constant rate, so the sniffer walks all video
block timestamps within a 4 MiB file budget and allows one timestamp tick of rounding. Larger
segments, unknown lengths, VFR, and unsupported chroma or layouts wait for ffprobe.
[Matroska DefaultDuration](https://www.rfc-editor.org/rfc/rfc9559.html#name-defaultduration-element)

The ffprobe decision still controls playback. The host checks the guessed pixel format as well as
the decoder method, stream indices, output size, and frame rate before handing off the early
process. In the timed runs below, ffprobe confirmed the guessed launches 36–175 ms after spawn.

Measured in hidden VS Code 1.147 with ffmpeg 9.0.2 on the i7-9700K / RTX 4070 through
`node test/benchq.js node test/vscode/run.js --quick --grep 'case/startup-'` (selected cases).
Times are milliseconds from the open command to the first frame, including the CLI handoff.
Each sample set has one cold and two warm opens per variant. The 4:2:2 MOV row pools the initial
run and two alternating baseline/candidate pairs because the first set had a slower warm median.

| Clip | Cold before → after | Warm median before → after | All opens median before → after |
|---|---:|---:|---:|
| VP9 4K MP4 (25 fps remux) | 1091 → 1056 | 1088.5 → 1012.5 | 1091 → 1019 |
| AV1 10-bit 4K MP4 | 1209 → 923 | 941.5 → 927.5 | 957 → 923 |
| H.264 10-bit 1080p MP4 | 1581 → 1006 | 917.5 → 866.5 | 978 → 918 |
| H.264 4:2:2 1080p MOV | 1058 → 967 | 867 → 836 | 917 → 872 |
| ProRes Proxy 1080p MOV | 1535 → 951 | 1655.5 → 942 | 1535 → 948 |
| HEVC 10-bit 4K MKV | 1076 → 1013 | 1078.5 → 990.5 | 1076 → 991 |
| AV1 10-bit 4K MKV | 1097 → 956 | 940.5 → 912 | 977 → 956 |
| VP9 4K WebM | 1580 → 1018 | 1593.5 → 1025 | 1580 → 1025 |

The pre-spawn wait is visible in every trace, but individual first-frame measurements also vary
with CLI handoff, webview setup, and decoder startup. The AV1 MP4 session-to-first-frame median
was 473 → 485 ms even though the measured end-to-end median fell. ProRes MOV and VP9 WebM had
especially slow baseline opens, so their end-to-end differences include that run-to-run spread.
The broader startup/native-transfer/playback run reproduced lower end-to-end medians for all eight
clips and passed 17/17 cases. All 29 host test files passed, with the argument-driven AVI test excluded.

The split transfer and draw ranges use the two baseline runs with the added marks. The connect
time comes from the host's channel log. The first-frame mark follows WebGL draw submission in
the webview. The measured connect and batching times left little room to shorten either on this clip.

```
node test/benchq.js node test/vscode/run.js --quick --grep '^case/startup-native'
node test/benchq.js node test/vscode/run.js --quick --grep "case/(startup|native-transfer)|play/|native/"
```

### Not done (start-up)

- **Starting ffmpeg before ffprobe for other containers or more complex MP4/MOV files.**
- **First-frame transfer:** the 4K payload took 45–65 ms after both changes.
- **`-hwaccel auto` before the GPU test:** a fixed method (after the test) may initialise faster;
  not measured separately.
- **One compiled WebAssembly module for all workers** (`instantiateWasm` with a module posted from
  the page): ~40 ms CPU per extra worker, not on the first-frame path.
- **Deferring scripts the simple mode doesn't need** (inspect, scopes, X-ray, subtitles): page load
  is 40–85 ms in total; player.js uses them synchronously.

## Memory: the fixed budgets

| Budget | Where | Before (any machine) |
|---|---|---|
| Decoded pictures held ahead (the "Fully decoded" cache when paused) | `engine.js budget()` | 400 MB |
| Decoder pool: pictures across segments | `pool.js` `budget` | 600 MB |
| Decoder pool: bytes per answer | `pool.js` `batchBytes` | 100 MB |
| Decoder pool: extra workers (one WebAssembly heap each) | `pool.js` `maxWorkers` | min(cores − 2, 6) |
| File blocks cached for the readers | `engine.js onBlock` | 64 MB |
| Frame buffers kept for reuse, per decoder worker | `decoder-worker.js FREE_BYTES` | 64 MB |
| Seek-bar thumbnails | `thumbs.js cap` | 30 MB |
| Native frames queued in the extension host | `native.js MAX_QUEUED_FRAMES` | 12 frames |

(X-ray's 2 GB "budget" is how much of the file it scans, not memory.)

## Memory: changes

`media/membudget.js` (used by the extension host and, in remote windows, by the page) sizes all of
them from the machine: the old values are a 32 GB machine's (and the cap above it), 8 GB gets the
second column, linear in between, proportional below 8 GB down to a floor.

| Budget | 32 GB+ | 16 GB | 8 GB | floor |
|---|---|---|---|---|
| pictures ahead | 400 MB | 240 MB | 160 MB | 96 MB |
| pool pictures | 600 MB | 360 MB | 240 MB | 128 MB |
| pool batch | 100 MB | 67 MB | 50 MB | 32 MB |
| pool extra workers | 6 | 4 | 3 | 1 |
| file blocks | 64 MB | 43 MB | 32 MB | 16 MB |
| reuse buffers per worker | 64 MB | 43 MB | 32 MB | 16 MB |
| thumbnails | 30 MB | 20 MB | 15 MB | 8 MB |
| native queue | 12 | 8 | 6 | 4 |

- **The basis:** `os.totalmem()`, in whole GB (a "32 GB" machine reports 31.9 GiB); when little is
  free (`os.freemem()`), four times what is free, not below a quarter of the total (a 32 GB machine
  with 3 GB free sizes like 12 GB). Read when each player page is made.
- **Remote windows:** the extension host is the remote machine, so the host sends nothing and the
  page uses `navigator.deviceMemory` (local; browsers report at most 8, so only machines under
  8 GB get less there).
- **Tests:** `VPE_TOTALMEM=<bytes>` (with VPE_LOG only) emulates a machine; the page logs
  `memory budgets: ...`.
- Compare tiles keep their own per-tile budget (`media/compare.js`), unchanged.

Measured, 4K HEVC 10-bit in the built-in decoder, MB private (webview renderer / whole VS Code tree):

| | webview peak | webview paused | tree peak | tree paused |
|---|---|---|---|---|
| before, 32 GB (any machine) | 1558 | – | 2747 | – |
| before, `VPE_TOTALMEM` 8 GB (no effect yet) | 1583 | – | 2692 | – |
| after, 32 GB (final) | 1275, 1651 | 1253, 1516 | 2425, 2821 | 2346, 2631 |
| after, 8 GB (final) | 992, 989 | 970, 886 | 2225, 2182 | 2068, 1943 |
| with lazy pool growth (dropped), 32 GB | 1759, 1764, 1756 | 1743, 1732 | 2843, 2952, 2828 | 2872, 2773 |
| with lazy pool growth (dropped), 8 GB | 1272, 1244, 1220 | 1137, 1196 | 2626, 2574, 2500 | 2230, 2247 |

The webview starts at 320–490 MB with the clip's page loaded; the extension host stays at
140–190 MB (it reads blocks; frames are in the webview) and the GPU process at 460–650 MB. Runs of
the same code differ by up to ~300 MB (which pictures and worker heaps are alive when sampled), so
compare ranges: as an 8 GB machine the webview peaks at ~0.99 GB instead of ~1.56–1.65 GB (−570 MB
against the old code, −290 to −660 MB against the 32 GB budgets in the same run), and the whole
VS Code tree at ~2.2 GB instead of ~2.4–2.8 GB.

The rest of the webview's memory at 4K is the WebAssembly heaps (primary + extra workers, ~100–150
MB each at 4K 10-bit: they grow to the decoder's need and never shrink) and the 400/160 MB of
pictures ahead; three fewer workers are most of the 8 GB saving.

## Tests

- `test/host/membudget_test.js`: the table, the basis (free memory, whole GB), `VPE_TOTALMEM` only
  with VPE_LOG, remote windows (no host numbers), and the ffmpeg lookup starting with the session.
- `test/vscode/cases/startup.js`: the numbers above; judges only that the clips open.
- `test/host/native_sniff_test.js` generates clips to compare header guesses with ffprobe and check
  that unsupported, variable-rate, and truncated files fall back. `test/host/native_early_test.js`
  checks that both container parsers can overlap ffprobe and that a disagreement discards the guess.
- The quick suite in real VS Code passes except `case/multiview/grid/four-play` (the known flaky
  grid).
