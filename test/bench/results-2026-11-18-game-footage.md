# Video decode benchmark (2026-11-18, game footage, i7-9700K + RTX 4070; superseded: media not redistributable, see results.md)

CPU: Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz; GPU: RTX 4070 (driver 581.15); Node v24.22.1; 2026-11-18T01:36:13.631Z

Frames per second, decode only, wall clock, 10 s clips from game footage (300 frames, 30 fps). Real time needs >= 30 (>= 36 for headroom). wasm = libav.js vpe build, 1 thread, incl. demux and conversion to yuv420p. wasm dec = the same run without the conversion (the player converts 10-bit and 4:2:2 on the GPU, so this is the column that matches it). wasm prev = the wasm column of the previous build (2026-11-17, no SIMD). cpu1/cpuN = native ffmpeg 1 thread / all threads (with format=yuv420p for non-420 sources). d3d11va / cuda "gpu" = frames stay on GPU; "dl" = download to RAM + scale to <=1440p + yuv420p (d3d11va: CPU scale after download; cuda: scale_cuda then hwdownload). no hw = the hwaccel does not take this stream (get_format picked a software format). Best of the runs.

## 1080p

| file | codec / pix_fmt | Mb/s | wasm | wasm dec | wasm prev | cpu 1t | cpu Nt | d3d11va gpu | d3d11va dl | cuda gpu | cuda dl |
|---|---|---|---|---|---|---|---|---|---|---|---|
| av1_10_1080p.mp4 | av1 yuv420p10le | 1.02 | 63.7 | 111.1 | 43.3 | 255.1 | 513.7 | 1470.6 | 237 | 1357.5 | 480 |
| av1_10hb_1080p.mp4 | av1 yuv420p10le | 4.76 | 56.1 | 88.4 | 46.2 | 234.9 | 405.4 | 1260.5 | 242.9 | 1219.5 | 634.2 |
| av1_8_1080p.mp4 | av1 yuv420p | 1.01 | 149.8 | 150.2 | 95.1 | 544.5 | 1158.3 | 1507.5 | 408.2 | 1500 | 824.2 |
| dnxhr_hq_1080p.mov | dnxhd yuv422p | 220.2 | 26.5 | 75.2 | 26.9 | 175.2 | 767.3 | no hw | no hw | no hw | no hw |
| h264_10_1080p.mp4 | h264 yuv420p10le | 1.36 | 67 | 120.2 | 62 | 272.7 | 559.7 | no hw | no hw | no hw | no hw |
| h264_8_1080p.mp4 | h264 yuvj420p | 1.41 | 140.6 | 141 | 107.8 | 419.6 | 1357.5 | 833.3 | 580.3 | 882.4 | 797.9 |
| h264_8hb_1080p.mp4 | h264 yuvj420p | 10.41 | 107.3 | 108.2 | 84.6 | 228.5 | 970.9 | 787.4 | 588.2 | 838 | 763.4 |
| hevc_10_1080p.mp4 | hevc yuv420p10le | 1.02 | 52.2 | 80.6 | 47.8 | 206.3 | 519 | 1507.5 | 344.4 | 1744.2 | 1000 |
| hevc_10hb_1080p.mp4 | hevc yuv420p10le | 7.05 | 43.7 | 62.4 | 38.4 | 132.5 | 411.5 | 1442.3 | 346.8 | 1562.5 | 974 |
| hevc_8_1080p.mp4 | hevc yuvj420p | 0.99 | 101 | 101.2 | 87.8 | 296.7 | 1030.9 | 1339.3 | 579.2 | 1754.4 | 940.4 |
| mjpeg_1080p.avi | mjpeg yuvj420p | 22.9 | 123.9 | 126.3 | 111.5 | 348 | 342.1 | no hw | no hw | 567.1 | 530 |
| mpeg2_1080p.mpg | mpeg2video yuv420p | 5.6 | 284.8 | 289.6 | 240.1 | 974 | 2307.7 | 854.7 | 410.4 | 806.5 | 777.2 |
| mpeg4_1080p.avi | mpeg4 yuv420p | 3.77 | 282.4 | 284.8 | 215.9 | 831 | 2097.9 | no hw | no hw | 980.4 | 842.7 |
| prores_hq_1080p.mov | prores yuv422p10le | 152.24 | 17.3 | 36 | 17.6 | 89.1 | 420.2 | no hw | no hw | no hw | no hw |
| vp8_1080p.webm | vp8 yuv420p | 4.48 | 80.6 | 80.8 | 82.6 | 382.2 | 1863.4 | no hw | no hw | 993.4 | 898.2 |
| vp9_1080p.webm | vp9 yuv420p | 0.94 | 126.3 | 126.9 | 115.7 | 511.1 | 1612.9 | 1470.6 | 617.3 | 1507.5 | 1013.5 |
| wmv2_1080p.wmv | wmv2 yuv420p | 6.09 | 236.9 | 239.8 | 206.3 | 541.5 | 539.6 | no hw | no hw | no hw | no hw |

## 2160p

| file | codec / pix_fmt | Mb/s | wasm | wasm dec | wasm prev | cpu 1t | cpu Nt | d3d11va gpu | d3d11va dl | cuda gpu | cuda dl |
|---|---|---|---|---|---|---|---|---|---|---|---|
| av1_10_2160p.mp4 | av1 yuv420p10le | 2.26 | 16.7 | 29.4 | 12.6 | 84.5 | 110 | 494.2 | 69.2 | 448.4 | 310.2 |
| av1_10hb_2160p.mp4 | av1 yuv420p10le | 9.26 | 15.9 | 27 | 12.2 | 70.6 | 128.7 | 585.9 | 68.4 | 506.8 | 365.9 |
| av1_8_2160p.mp4 | av1 yuv420p | 2.25 | 39 | 39 | 25 | 128.5 | 334.8 | 538.6 | 131 | 501.7 | 408.2 |
| dnxhr_hq_2160p.mov | dnxhd yuv422p | 873.92 | 7 | 21.9 | 7.3 | 58.7 | 188.2 | no hw | no hw | no hw | no hw |
| h264_10_2160p.mp4 | h264 yuv420p10le | 4.17 | 17 | 29.7 | 16.2 | 66.4 | 137.6 | no hw | no hw | no hw | no hw |
| h264_8_2160p.mp4 | h264 yuvj420p | 4.34 | 37.1 | 37.1 | 30.9 | 103.2 | 331.9 | 266.9 | 164.4 | 250.2 | 246.1 |
| h264_8hb_2160p.mp4 | h264 yuvj420p | 37.86 | 28.2 | 28.4 | 24 | 58.3 | 273.2 | 245.7 | 165.9 | 233.1 | 226.6 |
| hevc_10_2160p.mp4 | hevc yuv420p10le | 2.61 | 14 | 21.9 | 12.8 | 54.4 | 126.4 | 578 | 90.9 | 539.6 | 513.7 |
| hevc_10hb_2160p.mp4 | hevc yuv420p10le | 23.36 | 12.3 | 18.1 | 10.8 | 37.8 | 120.5 | 530 | 93.2 | 506.8 | 478.5 |
| hevc_8_2160p.mp4 | hevc yuvj420p | 2.51 | 26.3 | 26.3 | 23.4 | 74.6 | 271 | 583.7 | 167 | 587.1 | 491.8 |
| prores_hq_2160p.mov | prores yuv422p10le | 355.51 | 5.5 | 12.2 | 5.8 | 34.3 | 153.4 | no hw | no hw | no hw | no hw |
| vp9_2160p.webm | vp9 yuv420p | 2.29 | 32.3 | 32.4 | 29.8 | 114.7 | 385.1 | 477.7 | 170.4 | 465.1 | 443.1 |

<!-- keep -->
# In the player (headless Edge, 2026-11-18)

Main at e3edf68: libav.js vpe-next build (wasm SIMD), decoder pool, one-copy frame transfer with reused textures,
skip-non-reference when behind. i7-9700K, RTX 4070, Windows 10, Edge (WebCodecs, ANGLE D3D11).
`node test/benchq.js node test/browser/run.js --perf --browser msedge --seconds 8`: each bench file plays looped
in a 1280x800 page for 8 s after the first frame plus 1 s. 4K rows were run a second time for 20 s (two loops).

- **Cores:** the bench queue pins the browser to cores 4-7, but `navigator.hardwareConcurrency` still says 8, so the
  pool starts 6 workers on 4 cores. Pool-bound rows (4K ProRes, DNxHR, HEVC, AV1) are lower here than in VS Code
  with all 8 cores; read them as a floor.
- **shown** = frames drawn per second (30 = real time). **decode** = the engine's decode rate / 30 (median);
  above 1 is ahead, and it stops at about 1.23 once the queue is full. The default `whenSlow: every` slows playback
  and shows every frame when decoding is behind.
- Runs vary ±10-20 %, most on the 4K rows that are close to the limit.

| file | route | shown fps (8 s) | decode (8 s) | shown fps (20 s) | decode (20 s) | before |
|---|---|---|---|---|---|---|
| h264_8_1080p, h264_8hb_1080p | WebCodecs | 30.0 | 1.00 | | | 30 (VS Code) |
| h264_8_2160p, h264_8hb_2160p | WebCodecs | 30.0 | 1.00 | 29.9 | 1.00 | |
| h264_10_1080p | WebCodecs (Edge) | 30.0 | 20 | | | |
| h264_10_2160p | WebCodecs (Edge) | 30.0 | 1.45 | 29.1 | 3.66 | |
| vp8_1080p | WebCodecs | 30.0 | 1.79 | | | |
| hevc_8_1080p | wasm | 30.0 | 1.23 | | | 30 (VS Code) |
| hevc_10_1080p, hevc_10hb_1080p | wasm | 30.0 | 1.23 | | | 30 for 10hb (VS Code) |
| av1_8_1080p, av1_10_1080p, av1_10hb_1080p | wasm | 30.0 | 1.22-1.23 | | | |
| vp9_1080p | wasm | 30.0 | 1.23 | | | |
| mpeg2_1080p | wasm | 30.0 | 1.23 | | | |
| mpeg4_1080p (AVI) | wasm | 29.6 | 1.18 | | | |
| wmv2_1080p | wasm | 30.0 | 1.23 | | | |
| mjpeg_1080p (AVI) | JPEG frames | 30.0 | - | | | |
| prores_hq_1080p | wasm pool | 30.0 | 1.21 | | | 30 (VS Code, pool); 22-23 one decoder |
| dnxhr_hq_1080p | wasm pool | 30.1 | 1.23 | | | |
| vp9_2160p | wasm | 27.1 | 0.97 | 28.8 | 1.12 | |
| av1_8_2160p | wasm pool | 29.7 | 1.15 | 25.7 | 0.96 | |
| hevc_8_2160p | wasm pool | 26.7 | 0.89 | 25.8 | 0.89 | |
| av1_10_2160p | wasm pool | 28.8 | 1.05 | 22.2 | 0.75 | |
| av1_10hb_2160p | wasm pool | 24.1 | 0.79 | 20.4 | 0.74 | |
| dnxhr_hq_2160p | wasm pool | 25.1 | 0.93 | 21.8 | 0.82 | |
| prores_hq_2160p | wasm pool | 19.9 | 0.69 | 22.2 | 0.81 | 30 from the 2nd loop (VS Code, 8 cores); ~9.5 one decoder |
| hevc_10_2160p | wasm pool | 18.0 | 0.64 | 17.3 | 0.52 | 13-18 (VS Code) |
| hevc_10hb_2160p | wasm pool | 11.6 | 0.37 | 16.9 | 0.59 | 13-18 (VS Code); 1.5 before every-frame mode |

"before" = the README figures measured in VS Code before tonight's changes (no headless baseline exists).
First frame: 330-390 ms for WebCodecs and 8-bit 1080p, 750-780 ms for 10-bit and VP9, 0.8-1.2 s for 4K.
The two AVI files report 5.0 s in the harness, but their logs show the first frame 0.3 s after opening:
the harness's `report()` waits up to 5 s for a report line that doesn't come for them (harness.js:351).

## Pool vs one decoder (test/perf/browser_path.js, headless Edge, decode + draw, cores 4-7)

`--modes=single,pool --repeat=2`, plus `--modes=pool --workers=3`; median, frames per second (not limited to 30):

| file | one decoder | pool, 6 workers | pool, 3 workers | before: pool, 3 workers (de8d5d6) |
|---|---|---|---|---|
| prores_hq_2160p | 11.5 | 18.1 | 20.0 | |
| hevc_10hb_2160p | 15.5 | 13.6 (10.2-13.6) | 17.4 | 17.7 |
| mpeg2_1080p | 259 | 217 | 310 | 286 |
| dnxhr_hq_1080p | 50.7 | 77.7 | | |

On 4 cores the pool gains 1.5-1.7x on intra-only ProRes and DNxHR. With its default of 6 workers it loses on
long-GOP HEVC and on MPEG-2 (which one decoder already does at 8x real time); with 3 workers it doesn't, so the
loss is six workers contending for four cores. Against the frame-transfer branch's numbers (same 3 workers, before
the SIMD build), MPEG-2 is 8 % faster and 4K HEVC 10-bit is flat. The "about 3x" for DNxHR in the pool test used
all 8 cores.
<!-- /keep -->


## Notes (wasm run of 2026-11-18)

- Build: libav.js vpe-next (wasm SIMD128, -O3, Asyncify trim, --enable-small), commit e3edf68. Wasm only
  (`--routes=wasm --repeat=2`, best of 2, through test/benchq.js on cores 4-7); the native columns are unchanged.
- Geomean over the 29 files: +16 % with conversion, larger without it. Biggest gains: AV1 (+30-58 %), H.264 8-bit
  (+18-30 %), MPEG-4 (+31 %), MPEG-2 (+19 %). HEVC +9-15 %, VP9 +8-9 %.
- ProRes and DNxHR are 1-5 % slower in the "wasm" column, but their decode alone got 11-14 % faster (wasm dec):
  the format=yuv420p conversion got slower in this build. The player converts these on the GPU and doesn't run
  that filter. VP8 is flat (-2 %, within noise); the player decodes it with WebCodecs.

## Notes (run of 2026-11-17)

- Media: 10 s of out/foam_hybrid.avi (MJPEG 1600x900) from 12 s, lanczos-upscaled. The footage is clean, so CRF
  encodes are low bitrate (~1-1.4 Mb/s at 1080p); the `hb` rows use fixed delivery bitrates (H.264 12/45 Mb/s,
  HEVC 8/30, AV1 6/20 requested; SVT capped AV1 4K at ~9). Upscaled 4K has less detail than native 4K, so real
  4K files at the same bitrate decode a little slower. x264/x265 kept the source's full range, hence yuvj420p.
- wasm: Node v24.22.1 (V8, same engine family as the VS Code webview), 1 thread, wall time over the whole
  loop including demux and the format=yuv420p filter. The filter is expensive: about 6 ms/frame at 1080p 10-bit
  and 23-25 ms/frame at 4K (decode-only fps for hevc_10_2160p is 18, with conversion 12.8; prores_hq_1080p
  32 vs 17.6). Doing 10-bit / 4:2:2 to RGB in the WebGL shader instead would remove most of that.
- Native fps uses ffmpeg's -benchmark rtime (excludes process start and probe, includes hwaccel init), so on-GPU
  1080p numbers above ~800 fps are bounded by fixed overhead on a 300-frame clip; read them as "far above real time".
- GPU support seen on the RTX 4070 (get_format check): d3d11va (gyan 9.0.2) does H.264 8-bit, HEVC 8/10, VP9, AV1
  8/10, MPEG-2; cuda (BtbN 8.1) also does VP8, MPEG-4 ASP and MJPEG. Neither does H.264 High 10, ProRes, DNxHR,
  WMV2. d3d11va decode works with driver 581.15 even though the gyan build's NVENC does not.
- "dl" routes differ: d3d11va downloads full-size NV12/P010 and scales on the CPU (69-93 fps for 10-bit 4K);
  cuda scales on the GPU (scale_cuda) before hwdownload (310-510 fps). Scale before download.
- Background load: a VS Code instance used about one core at the start of the run, then went idle. Best of 2 runs;
  spreads above 20 % were only in sub-second GPU runs (one earlier cuda_dl outlier at 44 fps did not reproduce).
