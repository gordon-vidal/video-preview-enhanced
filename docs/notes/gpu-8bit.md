# Native GPU output for 10-bit video

The native player takes planar 8-bit 4:2:0 (`yuv420p`). CUDA and D3D11VA used to download
10-bit 4:2:0 surfaces and run the depth reduction and resize in swscale. That moved twice
as many bytes from the GPU at full resolution and downloaded the original size even when
the transport or tile only needed a smaller frame.

ffmpeg's filter list is checked once when the extension locates and caches the executable.
When the existing GPU probe selects CUDA for 10-bit 4:2:0 HEVC, AV1 or VP9,
`scale_cuda` resizes the surfaces and produces planar 8-bit output before `hwdownload`.
The existing QSV path uses `vpp_qsv` to produce NV12 and separates its planes after
download. Both paths send raw `yuv420p` to the webview.

If the filter is absent, the decoder uses the CPU scaling path. If a listed filter fails
before producing a picture, the decoder retries from the same position with CPU scaling
and keeps the outstanding frame requests. The hardware decoder is retried before the
existing software-decode fallback. The existing probe still chooses the decoding method
and times CUDA with its baseline filter chain.

D3D11VA uses CPU scaling. See the D3D11VA follow-up below. QSV's missing-filter path
is covered by a host test. QSV hardware playback was unmeasured.

## Hidden VS Code measurements

VS Code 1.147.0, ffmpeg 9.0.2, i7-9700K and RTX 4070. A temporary benchmark case
looped the 3840×2160 HEVC Main 10 fixture with stream copy, held the decode method at CUDA,
and disabled the background GPU benchmark. It sampled the active ffmpeg process's CPU
time over about 8 seconds of playback after the first picture. CPU is a percentage of
one logical core. FPS is the median of the webview's `shownFps` windows.

| Output size | ffmpeg CPU before → after | Shown fps before → after |
|---|---:|---:|
| 3840×2160 | 53.4% → 38.1% | 17 → 30 |
| 1920×1080 | 66.9% → 13.9% | 29.75 → 30 |

Full-resolution frame rates were variable under other work on the machine (9.5–30 fps
before and 23–30 fps after). At 1080p output, playback held source rate while ffmpeg CPU use
fell 79%. The webview rendered the same two paused frames (13 and 42) at each size.
Luma thumbnail correlation was 0.99969–0.99978. At 128 sampled RGB positions per frame,
average absolute channel difference was 0.94–1.26 codes, with a maximum of 4 out of 255.

The CUDA comparison passed 2/2 cases in each run through
`node test/benchq.js node test/vscode/run.js --quick --grep '^case/gpu8-bench-'`.
The temporary case and decoder override were removed after collecting the measurements.

Regression checks passed 17/17 with
`node test/benchq.js node test/vscode/run.js --quick --grep "case/(startup|native-transfer)|play/|native/"`.
The host test loop passed 29/29 files, with `avi_scan_test.js` skipped.

## D3D11VA follow-up

FFmpeg 9.0.2's `scale_d3d11` requires D3D11 hardware frames and accepts NV12 or P010
output. The direct chain keeps the decoded P010 surface on the GPU with
`-hwaccel d3d11va -hwaccel_output_format d3d11`, then uses
`scale_d3d11=width=W:height=H:format=nv12,hwdownload,format=nv12,format=yuv420p`.
The final conversion separates the two chroma planes for the webview.

The filter initializes a separate output pool of ten surfaces. FFmpeg's D3D11
allocator puts that pool in a texture array with the filter's hard-coded
`D3D11_BIND_RENDER_TARGET | D3D11_BIND_VIDEO_ENCODER` flags. The input option
`-extra_hw_frames` changes the decoder pool. The filter's own `extra_hw_frames`
can only add to its ten output surfaces. The filter exposes no option to replace
the output texture descriptor.
[FFmpeg 9.0.2 scaler](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavfilter/vf_scale_d3d11.c#L289-L402),
[D3D11 allocator](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavutil/hwcontext_d3d11va.c#L253-L306)

On Windows 10 with the RTX 4070 (driver 581.15), the direct chain failed during
`CreateTexture2D` with `0x80070057` (`E_INVALIDARG`) at both 3840×2160 and 1920×1080.
It failed at the same point with `-extra_hw_frames 16` before the input,
`:extra_hw_frames=16` on the filter, one named device for both decoder and filter
(`-init_hw_device d3d11va=dx:0 -filter_hw_device dx -hwaccel_device dx`), P010 output,
and a P010 `hwupload` before the scaler. That locates the failure at the scaler's
output allocation, before the first video processor blit. The driver error alone
does not identify which field of the texture descriptor it rejected.
The separate `hwmap=derive_device=opencl:mode=read+direct` trial with a shareable
D3D11 device (`SHARED=1`) failed because OpenCL found no matching device.

The hidden VS Code 1.147.0 benchmark forced D3D11VA and disabled the background GPU
benchmark. It played a roughly 20 s stream copy of the 3840×2160 HEVC Main 10 fixture.
The baseline confirmed a P010 hardware download. CPU is the active ffmpeg process's
CPU time over about 8.5 s as a percentage of one logical core. Playback FPS is the
median of the webview's `shownFps` windows after the first window.

| Output size | FFmpeg CPU with CPU scaling | Shown FPS | GPU scaling |
|---|---:|---:|---|
| 3840×2160 | 133.7% | 30 | No frames |
| 1920×1080 | 72.9% | 30 | No frames |

The corrected run through
`node test/benchq.js node test/vscode/run.js --quick --grep '^case/d3d11-trial-'`
passed both baselines. All 14 candidate runs reached the first picture through the
D3D11VA retry with CPU scaling. At frames 13 and 42, every retry matched the baseline
in the 64×36 luma thumbnails (correlation 1.0) and at all 128 sampled RGB positions
(zero channel difference). The GPU attempts produced no pictures to compare or time.
AMD and Intel adapters were unavailable on this host.

The regression filter `case/(startup|native-transfer)|play/|native/` passed 17/17
in the hidden VS Code runner through `benchq`. `node test/host/run_all.js` passed
30 suites with `avi_scan_test.js` skipped.
