# A smooth 4K60 preview with a GPU encoder (2026-11-20)

Research only: no playback code or defaults change. Smooth playback is the owner's priority;
the proposed action is to **offer** a local H.264 preview when native playback falls behind.

## Finding

GPU encoding does not require libx264. The published Windows LGPL build recipes enable NVIDIA,
Intel QSV and AMD AMF support. That does **not** prove an encoder can open on a user's machine.
Tonight none of the four requested GPU encoders opened in the installed FFmpeg. NVIDIA failed
on a driver/API mismatch; QSV and AMF failed to create their runtime devices.

The exact managed LGPL binary could not be downloaded: the sandbox rejected the installer's
checksum request with `connect EACCES ...:443`. No alternate executable was downloaded and no
driver or system setting was changed. Its version, archive SHA-256, runtime availability,
encode speed, quality and live WebCodecs playback therefore remain **unmeasured**. Do not turn
this note into a claim that the managed build sustains 4K60.

## Why compress

[native-transfer.md](native-transfer.md) measured the raw receiving path at about 400-490 MB/s
during playback. Full 3840x2160 8-bit 4:2:0 at 60 fps needs 746.5 MB/s. The earlier lossless
research reached about 43-44 fps after GPU conversion, still waiting on the receiving path.
[cpu-4k.md](cpu-4k.md) also shows why keeping conversion on the GPU and sizing frames to the
picture saves CPU. H.264 at 24 Mb/s needs only about 3 MB/s before framing.

Read-only comparison with the old branches: `codex/4k60` used CUDA conversion, libx264 CRF 21,
a 60 Mb/s limit and WebCodecs; its note reports 59.5-60 shown fps on two fixtures, with raw
1440p recovery. `research/4k60-lossless` ruled out PBOs, packed textures, extra connections and
worker uploads as a way to close the raw transfer gap. These are historical results, not
measurements repeated here. The old implementation's automatic switch is not the requested
opt-in suggestion, and libx264 is absent from the managed LGPL build.

## Which build

`src/setup.js` reads
`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256` and selects the
highest major/minor release matching `ffmpeg-n<major>.<minor>-latest-win64-lgpl-shared-<revision>.zip`.
The archive URL uses the same `latest/` prefix. It takes the expected SHA-256 from that manifest,
hashes the download as it streams, and rejects a missing hash or mismatch before extraction.
The URL floats; reproduce with an archived filename and hash, not just the word "latest".

Published recipes inspected on 2026-11-20:

| Recipe | Relevant flags and conditions |
|---|---|
| [Windows LGPL shared](https://github.com/FFmpeg-Builds/FFmpeg-Builds/blob/master/variants/win64-lgpl-shared.sh) | Sources `defaults-lgpl-shared.sh`, then `defaults-lgpl.sh`; `--enable-version3`, shared libraries, no GPL flag. The recipe names `COPYING.LGPLv3`. |
| [NVIDIA headers](https://github.com/FFmpeg-Builds/FFmpeg-Builds/blob/master/scripts.d/50-ffnvcodec.sh) | `--enable-ffnvcodec --enable-cuda-llvm`; SDK 13.0 headers for FFmpeg 8.0/8.1, a newer pin above that. No GPL-only condition. |
| [Intel oneVPL](https://github.com/FFmpeg-Builds/FFmpeg-Builds/blob/master/scripts.d/50-onevpl.sh) | `--enable-libvpl`, enabled on x64 for FFmpeg 6+. |
| [AMD AMF](https://github.com/FFmpeg-Builds/FFmpeg-Builds/blob/master/scripts.d/50-amf.sh) | `--enable-amf`, no variant restriction. |

[FFmpeg's encoder documentation](https://github.com/FFmpeg/FFmpeg/blob/master/doc/encoders.texi)
explains NVENC header autodetection and the separate GPU/driver runtime requirement. These
recipes support the inference that LGPL builds include these encoders, not a runtime result
for the blocked archive. The installer currently labels the Windows build LGPL-2.1; the
published recipe's LGPLv3 licence file is a separate metadata question for follow-up.

The installed PATH tool is Gyan FFmpeg **9.0.2-full_build**, built with GCC 16.2.0. Its configure
line includes `--enable-gpl --enable-version3 --enable-amf --enable-libvpl --enable-ffnvcodec
--enable-nvenc --enable-nvdec --enable-cuda-llvm --enable-libvmaf`. It also has libx264 and
libx265. It is a diagnostic tool here, not a build to bundle or recommend as the LGPL download.

## Method and runtime results

i7-9700K (8 logical CPUs), RTX 4070, Windows, NVIDIA driver **581.15**. Other agents used the
machine. All timing jobs run through `test/benchq.js`, serial within that queue. No layer 4
runner is used. Queueing cannot stop other applications or correctness tests from using CPU/GPU.

Source: `test/media/hevc_10_2160p.mp4`, HEVC Main 10, BT.709 SDR, 3840x2160, 30000/1001 fps,
2.002 s. The script loops it and uses `fps=60`, libx265 ultrafast CRF 18, 10-bit 4:2:0 to make
12 s / 720 frames of 4K60 HEVC (about 4.91 Mb/s). These are duplicated frames and repeated
motion, not a native 60 fps camera sample. It is an easy compression test, not a quality corpus.
The source is the credited Meridian excerpt in [test media licences](../../test/media/LICENSES.md);
generated files stay in scratch storage and retain its attribution and CC BY 4.0 licence.

NVENC candidate: CUDA decode to GPU surfaces, `scale_cuda=format=nv12`, preset p4, tune ll,
VBR, no lookahead, no B frames, GOP 60; target 12 / 24 / 40 Mb/s, peak 1.5 times target,
VBV one second. QSV/AMF probes use software decode and `format=nv12`, 24 Mb/s, GOP 60,
no B frames. This tests device opening; a working QSV/AMF system still needs its own GPU
conversion and sustained-speed tests.

| Encoder in PATH FFmpeg | Attempts | Result |
|---|---:|---|
| `h264_nvenc` | 9 (3 rates x 3 repeats) | No packets. Required NVENC API 13.1, found 13.0; FFmpeg requests driver 610.00 or newer. |
| `hevc_nvenc` | 1 measured probe | Same API mismatch. An earlier source-generation attempt failed for the same reason. |
| `h264_qsv` | 1 | MFX session creation error -9; current implementation not supported. This does not establish that all i7-9700K systems lack QSV. |
| `h264_amf` | 1 | `amfrt64.dll` failed to open; no AMF hardware context. No AMD GPU was available to measure. |

All these attempts produced zero frames, so encode fps, first-packet latency, encode CPU/GPU
load and PSNR/SSIM/VMAF are **not available**, rather than a useful "0 fps" performance result.
Seeing an encoder in `ffmpeg -encoders` is insufficient. Neither a software conversion nor a
different bitrate repairs the reported NVIDIA API mismatch.

### Software and WebCodecs controls

The scripts also measure libx264 ultrafast/zerolatency, four encoder threads, software HEVC
decode and NV12 conversion at the same rates. This is a control only: it cannot be the fallback
for users with the managed LGPL build.

Three repeats per rate; each encodes all 720 frames to an Annex B pipe and saves it locally.
FPS includes startup. CPU includes software decode, conversion and encoding, in percent of
one core. The first-picture column is the arrival of the first VCL bytes, not display latency.

| Target Mb/s | Encode fps, repeats | Median fps | First picture bytes, ms | CPU, % one core |
|---|---|---:|---:|---:|
| 12 | 67.2, 80.7, 68.6 | 68.6 | 144-166 | 506-602 |
| 24 | 49.3, 66.9, 76.5 | 66.9 | 145-199 | 357-569 |
| 40 | 43.9, 68.8, 59.1 | 59.1 | 148-354 | 339-540 |

CPU load before individual control encodes ranged from 13.7% to 68.2% of the whole CPU;
the queue reported 91.2% before source generation. Peak-to-peak throughput spread divided
by median is about 20%, 41% and 42% respectively. Three runs do not support a confidence
interval or a clean bitrate ranking. NVIDIA's whole-device GPU utilization averaged 0-9.2%
across these software runs; encoder utilization was 0%, decoder 0-1.2% (other applications).
There is no measured NVENC utilization or efficiency advantage to quote.

Even this software control does not reliably sustain 60 fps at all rates under tonight's load.
It is useful for creating WebCodecs input, not evidence that a software fallback is safe.

Quality on the first encode at each rate, all 720 frames:

| Target Mb/s | Actual Mb/s | PSNR average, dB | SSIM All | VMAF default model |
|---|---:|---:|---:|---:|
| 12 | 12.15 | 49.0248 | 0.991358 | 91.7178 |
| 24 | 24.25 | 50.8745 | 0.993376 | 94.1141 |
| 40 | 40.49 | 51.7538 | 0.994161 | 95.2367 |

These scores are for the software control against the generated 8-bit reference. They do not
measure NVENC and do not include 10-to-8-bit loss or earlier source-generation loss. Repeated
frames, already compressed SDR material and a short repeating excerpt make this an optimistic
sample. Test real 60 fps motion, grain and small text before choosing a bitrate.

Saved H.264 controls in **real VS Code 1.147.0**, production player, hidden desktop, three
profiles, sequential files, 8.5 s of requested playback each:

| Mb/s | Median retained 2 s windows, by repeat | All retained windows | Whole-run presented fps |
|---|---|---|---|
| 12 | 60, 59.75, 60 | 52.5-60 | 52.4, 54.3, 52.9 |
| 24 | 59.5, 59.5, 59.5 | 48.5-60 | 55.3, 55.2, 53.6 |
| 40 | 60, 60, 59.75 | 57-60.5 | 53.3, 56.5, 55.8 |

Every valid run reported `v=webcodecs`, `fps=60` and `canvas=3840x2160`. The first status window
is discarded, but a low opening window sometimes remains: do not hide it. After that remaining
opening window the ranges were 59.5-60, 59-60 and 59.5-60.5 fps respectively. The status counter
divides frame deltas by a nominal two seconds, so 60.5 is sampling jitter, not extra source
frames. Whole-run rates use actual elapsed time and include startup and command round trips;
whole-run playhead/wall ratios ranged from 0.874 to 0.944. This supports 60 fps WebCodecs
decoding/presentation after settling, not uninterrupted full-speed delivery from the click.

Load before valid files ranged from 8% to 100% CPU (five files reported 100%); the queue reported
100% at entry. One profile in repeat 2 lost WebGL2 on the next file. It was explicitly reported,
stopped and retried once on a fresh hidden desktop. Its one partial 12 Mb/s result is excluded
above: nine valid file runs remain. No ordinary failure was silently retried.

These files were encoded beforehand with libx264. No NVENC output existed to test, and no live
encode ran beside the player. This validates the receiving half of the idea only. Combined
encoder + transport + WebCodecs + audio headroom remains an implementation experiment.

## Proposed behaviour

Offer **Use smooth 4K preview** if a visible, playing native video at 1x delivers under 95% of
source fps for three consecutive one-second windows (57 fps for 60 fps). Exclude opening,
seeks, resizing, the first 1.5 s after them, pauses, hidden tabs, end of file and other speeds.
Use actual presented frames and playhead progress together: an empty queue, decoder stalls
and presentation stalls need different diagnostics. Require a high-resolution view where
1440p would lose useful detail; do not spend GPU power making 4K for a small picture.

Suggested text: "Playback is falling behind. Use a smooth 4K preview? The picture is re-encoded
locally to H.264, 8-bit. Choose 'Don't Show Again' to stop this prompt for this file."
Actions: **Use smooth preview**, **Keep current path**, **Don't Show Again**.
Preserve the original file. Never claim lossless pixels or overwrite it.
Use the existing notice and About this video surfaces; no player rearrangement is proposed.
This is a text design proposal for review, not a UI change on this branch.
Use the visible action labels as their accessible names. Keep the existing Tab order and
Enter/Space activation, with Escape dismissing the notice; propose no new keyboard shortcut.

Show the active path in About this video and stats, for example:
`Smooth preview: NVIDIA H.264 -> WebCodecs, 3840x2160 60 fps, 8-bit, lossy`.
The accessible action name to leave it should be **Use original video**. Pixel Inspector,
scopes and exact frame export must read the original through the existing exact-pixel route;
the preview must not silently become the source for inspection. Do not offer this SDR recipe
for PQ/HLG/Dolby Vision until tone mapping and colour metadata are separately verified.

## Implementation outline and fallbacks

1. Probe an encoder by opening it and obtaining a real frame with the installed binary and
   current GPU/driver. Cache by binary identity and driver/device, invalidate on changes or
   failure. Probe WebCodecs H.264 configuration support too. Capture the failure reason.
2. Prefer NVIDIA NVDEC -> CUDA 10-to-8-bit conversion -> NVENC H.264 where available. Start
   with 24 Mb/s, peak 36 Mb/s, GOP 60, no B frames/lookahead. Quality/rate is provisional until
   measured on working NVENC and a harder native-60fps sample. HEVC NVENC is informational;
   H.264 remains the portable WebCodecs target.
3. On Intel, probe `h264_qsv` and a QSV decode/VPP NV12 path. On AMD, probe `h264_amf` and
   compatible D3D surfaces; software decode/format conversion may be needed. Measure each
   whole path: CPU conversion can erase the advantage. Do not select by GPU vendor alone.
4. Reuse the encoded packet, timestamp, sound and seek machinery in `src/remotestream.js`,
   but review encoder arguments, packet framing and backpressure for a local 4K60 source.
   Insert access-unit delimiters for its Annex B parser and derive the actual H.264 profile,
   level (4K60 commonly needs 5.2) and colour description from the output SPS, not a fixed
   1080p decoder configuration. Keep the first prototype local, progressive and SDR only.
   Use the existing localhost token/Origin protection; no unauthenticated FFmpeg HTTP listener.
   Seek restarts with a keyframe at the current playhead, cancels stale generations and retains
   source PTS/A-V offsets. Bound queued packets and surfaces. Pause/hidden/close stops work.
5. If no encoder opens, WebCodecs fails, or the selected path still stays below 95% for 2-3 s,
   return at the same playhead to raw **1440p or the smaller picture-sized height**. Keep the
   existing source-rate cap. Avoid repeated prompts/restarts; record the failed choice for
   that file/session and let the user retry explicitly. Do not fall through to libx264 in LGPL.
6. Before shipping, test audio sync, VFR timestamps, seek/step, loop boundaries, cancellation,
   lost GPU sessions, remote-window policy, multiple tabs, exact-pixel tools and HDR exclusions.
   Require sustained presented 60 fps, not just encoder throughput or `isConfigSupported()`.

## Reproduce and remaining work

From the repo root in PowerShell (use a new empty scratch folder):

```powershell
$ff = (Get-Item (Get-Command ffmpeg).Source).Target[0] # WinGet link; otherwise use its Source
$scratch = Join-Path $env:TEMP ('vpe-gpu-research-' + [guid]::NewGuid().ToString('N'))
node test/benchq.js node tools/gpu-encode-research.js $ff $scratch
node test/benchq.js node tools/gpu-webview-research.js $scratch
```

The encoder script saves source probe metadata, binary version/configuration, per-run stderr,
frames/wall fps (includes startup and output writes), first VCL bytes at the stdout pipe, CPU
time from FFmpeg's `-benchmark`, NVIDIA utilization samples every 200 ms, and quality summaries.
First VCL bytes are a proxy for first-packet arrival, not a complete-frame or first-screen
latency measurement. CPU is percent of one core (800% is this whole CPU); GPU samples are
whole-device activity and include other applications. Failed subsecond probes have too few
samples to support utilization claims. Quality compares decoded output with the generated
source converted to 8-bit yuv420p on both sides; it excludes the 10-to-8-bit conversion loss.
VMAF uses FFmpeg's installed default model, at full 4K, not a validated 4K viewing assessment.

For a future allowed LGPL download, use the installer selection and checksum check above.
Set `VPE_GPU_SOURCE` to the already generated HEVC 4K60 file before running the script with
that binary: LGPL lacks the libx265 source generator. The script omits the libx264 control
when that encoder is absent. Outputs include local paths and must stay out of tracked files.
The webview script uses the production player on hidden desktops, three fresh profiles,
8.5 s per file, drops the first status window, requires WebCodecs and a 3840x2160 canvas,
and reports/retries a broken WebGL2 instance once. It reads saved MP4 output: it does not
measure concurrent live encoding, packet transport or audio.
The separate whole-run presented-fps and playhead-rate fields include the play command,
startup/prebuffering and pause/state round trips; they are not steady-state decoder rates.

Open work: obtain and checksum the managed archive when network policy permits; repeat with
a driver/build pair whose NVENC APIs agree; run Intel and AMD machines; use real 60 fps motion
and grain/text; measure first *presented* frame and a concurrent live encoded path in VS Code.
A compatible driver/build pair remains a prerequisite, not a change made by this branch.

## Validation of this research branch

- `node test/run.js unit engine`: unit **67 passed, 1 failed** (68 files); engine **13 passed,
  0 failed**. The combined command exited 1 because of the unit failure.
- `test/host/seek_preview_test.js` failed on a missing thumbnail at 7.5 s in the parallel run.
  The explicitly reported solo rerun, `node test/host/seek_preview_test.js`, **passed**. Cause
  not established; keep this as a follow-up flake, not a clean full-suite pass. No product
  code or test was changed to hide it.
- `node test/run.js vscode --changed`: **0 scenarios selected**, successful exit (only notes
  and standalone tools changed). Separately, the research webview script completed **9 valid
  file runs**, with **1 broken WebGL2 profile retried** and **1 partial file run excluded**.
- Both scripts pass `node --check`; `git diff --check` and the personal-data check pass
  (325 tracked text files). No layer 4 run, version change, push or merge.
