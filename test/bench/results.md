# Video decode benchmark

CPU: Intel(R) Core(TM) Ultra 7 165U; GPU: Intel(R) Graphics (31.0.101.5234); Node v22.23.5; 2026-11-18T13:40:19.106Z

Frames per second, decode only, wall clock, video stream only. Media: test/media, 1-3 s clips of real footage (Tears of Steel 1080p, Meridian 4K SDR, Sparks 4K HDR, Big Buck Bunny; test/media/LICENSES.md). Real time needs >= the frame rate of the clip (24, 29.97 or 30). wasm = libav.js vpe build, 1 thread, incl. demux and conversion to yuv420p; wasm dec = the same run without the conversion (the player converts 10-bit and 4:2:2 on the GPU, so this is the column that matches it). cpu1/cpuN = native ffmpeg 1 thread / all threads (with format=yuv420p for non-420 sources). d3d11va / cuda "gpu" = frames stay on GPU; "dl" = download to RAM + scale to <=1440p + yuv420p. no hw = the hwaccel does not take this stream. Each cell is the median of up to 2 runs (stops early when two agree within 3 %); "spread" = the largest (max-min)/median of the row; "others" = CPU load of other processes just before the row (% of all logical CPUs). Native fps uses ffmpeg's -benchmark rtime, so on short clips GPU numbers in the hundreds are bounded by fixed overhead.

Load of other processes during the run: median 33.9 %, max 50.5 % (noisy).

## 1080p

| file | codec / pix_fmt | Mb/s | wasm | wasm dec | cpu 1t | cpu Nt | d3d11va gpu | d3d11va dl | cuda gpu | cuda dl | spread | others |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| av1_10_1080p.mp4 | av1 yuv420p10le | 2.91 | 18.5 | 21.8 | - | 212 | 258.8 | 100.4 | - | - | 47 % | 26.2 % noisy |
| av1_8_1080p.mp4 | av1 yuv420p | 2.89 | 26.9 | 24.6 | - | 280 | 614.5 | 122.4 | - | - | 18 % | 48.8 % noisy |
| dnxhr_lb_1080p.mov | dnxhd yuv422p | 36.18 | 25.5 | 73.9 | - | 308.8 | no hw | no hw | - | - | 32 % | 48.6 % noisy |
| h264_10_1080p.mp4 | h264 yuv420p10le | 4.98 | 32.4 | 40.2 | - | 249.4 | no hw | no hw | - | - | 13 % | 44.3 % noisy |
| h264_8_1080p.mp4 | h264 yuv420p | 4.99 | 47.3 | 47.5 | - | 322.7 | 226.1 | 118.8 | - | - | 39 % | 17.1 % |
| h264_aac_anim_1080p.mp4 | h264 yuv420p | 5.78 | 45.5 | 38.8 | - | 427.6 | 309.7 | 115.5 | - | - | 38 % | 50.5 % very noisy |
| hevc_10_1080p.mp4 | hevc yuv420p10le | 3.22 | 12.6 | 13.2 | - | 200.9 | 436.9 | 92.8 | - | - | 54 % | 43.7 % noisy |
| hevc_8_1080p.mp4 | hevc yuv420p | 3.24 | 34.1 | 34.1 | - | 252.1 | 388.2 | 125.2 | - | - | 21 % | 25 % noisy |
| mpeg2_1080p.mpg | mpeg2video yuv420p | 10.44 | 77.7 | 63.5 | - | 1248.7 | 205.8 | 37.7 | - | - | 90 % | 35.2 % noisy |
| prores_proxy_1080p.mov | prores yuv422p10le | 39.4 | 20.3 | 45.3 | - | 142.9 | no hw | no hw | - | - | 29 % | 32.6 % noisy |
| vp9_1080p.webm | vp9 yuv420p | 3.73 | 27 | 24.9 | - | 353.1 | 527.5 | 136.1 | - | - | 23 % | 41.1 % noisy |
| vp9_opus_anim_1080p.webm | vp9 yuv420p | 3 | 55.2 | 55.3 | - | 547.1 | 672 | 177.4 | - | - | 11 % | 27.3 % noisy |

## 2160p

| file | codec / pix_fmt | Mb/s | wasm | wasm dec | cpu 1t | cpu Nt | d3d11va gpu | d3d11va dl | cuda gpu | cuda dl | spread | others |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| av1_10_2160p.mp4 | av1 yuv420p10le | 12.22 | 2.7 | 3 | - | 36.3 | 145.6 | 35 | - | - | 108 % | 46.3 % noisy |
| h264_8_2160p.mp4 | h264 yuv420p | 18.42 | 10.1 | 9.9 | - | 97.7 | 168.3 | 39.1 | - | - | 19 % | 27.3 % noisy |
| hevc_10_2160p.mp4 | hevc yuv420p10le | 12.32 | 6.1 | 7 | - | 57 | 215.9 | 44.7 | - | - | 31 % | 44.6 % noisy |
| hevc_10_hlg_2160p.mp4 | hevc yuv420p10le | 11.51 | 7.1 | 8 | - | 71 | 231.5 | 42.8 | - | - | 19 % | 27.6 % noisy |
| hevc_10_pq_2160p.mp4 | hevc yuv420p10le | 11.43 | 7.1 | 8.2 | - | 67.5 | 238.1 | 48.9 | - | - | 10 % | 19.3 % |
| vp9_2160p.webm | vp9 yuv420p | 10.36 | 8.3 | 7.7 | - | 171 | 227.1 | 56.7 | - | - | 16 % | 31.9 % noisy |

