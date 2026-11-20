# Performance

## In the player (real VS Code)

Measured on 2026-11-19 in VS Code 1.147.0 on Windows 10 with an Intel i7-9700K (8 cores), RTX 4070 and 32 GB RAM. The [hidden-desktop runner](../test/vscode/README.md) used fresh profiles and ffmpeg 9.0.2 for native playback. It reports the upper median of the two-second playback samples after the first. Each WebAssembly decoder uses one thread in the webview. The decoder pool can spread independent groups of pictures across cores.

| File | Decoder | Frames shown per second |
|---|---|---|
| 4K H.264, 1080p H.264 + AAC (30 fps) | A: GPU (WebCodecs) | 30 |
| 1080p MPEG-2, 1080p ProRes Proxy (24 fps) | B: built-in (WebAssembly) | 24 |
| 1080p AV1 (24 fps) | B: built-in | 24 |
| 4K VP9 (30 fps) | B: built-in | 12 |
| 4K HEVC 10-bit (30 fps) | B: built-in | 7.5 |
| 4K AV1 10-bit (30 fps) | B: built-in | 7 |
| 4K HEVC 10-bit, 30 fps, output at 1080p | C: native ffmpeg (D3D11VA, VS Code messages) | 30 |
| 4K HEVC 10-bit, 30 fps, output at 3840×2160 | C: native ffmpeg (D3D11VA, frame server) | 30 |
| 4K HEVC 10-bit, 60 fps, output at 2560×1440 | C: native ffmpeg (CUDA, frame server) | 60 |
| 4K AV1 10-bit, 30 fps, output at 1080p | C: native ffmpeg (D3D11VA, VS Code messages) | 30 |
| 4K AV1 10-bit, 30 fps, output at 3840×2160 | C: native ffmpeg (D3D11VA, frame server) | 30 |

The native rows use 16–20 s clips so the measurement windows stay within the first pass. The WebCodecs and WebAssembly rows use short clips that loop during measurement. The 1080p AV1 loop check verified that playback reused all 48 decoded frames. Source rates of 29.97 fps are labelled 30 fps.

CPU for native 4K HEVC 10-bit (30 fps) in a fresh install, measured 2026-11-20 on the same machine with all VS Code processes and ffmpeg counted: 3.7 cores before (`-hwaccel auto`, 3840×2160 frames), 1.0 core now (CUDA with GPU 8-bit conversion, frames at the player's 1080p picture), at 30 fps both times ([notes](notes/cpu-4k.md)).

For native 4K HEVC, the first frame appeared 776 ms after session creation on the cold open and 581–707 ms on two warm opens. ffmpeg started 86–130 ms before ffprobe finished.

- **The decoder pool** runs several WebAssembly decoders, each on its own stretch of the video between keyframes. It helps most with intra-only codecs (ProRes, DNxHR); long-GOP 4K HEVC and AV1 gain little, because there are few keyframes to split the work at.
- **4K HEVC 10-bit and AV1 10-bit in software are slower than real time** on this machine, and 4K ProRes and DNxHR can be with fewer free cores. By default playback then slows down and shows every frame, and a notice says so once. Its button skips to keyframes instead, or install the [optional ffmpeg](ffmpeg.md) to decode on the GPU in real time.
- **Earlier laptop run (2026-11-18).** On a busy Intel Core Ultra 7 165U in VS Code 1.146, 4K H.264 showed 28–29 fps on the GPU. In WebAssembly, 4K HEVC 10-bit showed about 3 fps, 4K VP9 3–6 fps, 1080p AV1 11–17 fps, and 1080p ProRes Proxy and MPEG-2 17–24 fps. Native ffmpeg showed 5–22 fps for 4K HEVC 10-bit and AV1 10-bit during that run.
- **Memory.** The 4K HEVC WebAssembly test logged budgets of 400 MB for the player's decoded frame queue and 600 MB for the decoder pool on the 32 GB desktop. Emulating an 8 GB machine lowered those limits to 160 MB and 240 MB.

## Decoder speed by codec

Earlier desktop benchmarks (2026-11-18). These are decode-only frames per second from a single WebAssembly decoder (SIMD build) in Node, using 10 s clips. The earlier report gave a run-to-run variation of ±10–20%. The player adds GPU colour conversion and draws frames at the playback rate.

| Codec | 1080p | 4K |
|---|---|---|
| H.264 8-bit (the player uses the GPU instead) | 108–141 | 28–37 |
| HEVC 8-bit | 101 | 26 |
| HEVC 10-bit | 62–81 | 18–22 |
| AV1 8-bit | 150 | 39 |
| AV1 10-bit | 88–111 | 27–29 |
| VP9 | 127 | 32 |
| MPEG-2 | 290 | – |
| MPEG-4 Part 2 (Xvid) | 285 | – |
| WMV2 | 240 | – |
| MJPEG | 126 | – |
| DNxHR HQ | 75 | 22 |
| ProRes 422 HQ | 36 | 12 |
