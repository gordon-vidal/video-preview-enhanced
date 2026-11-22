# Optional: native ffmpeg

The built-in decoder uses VS Code's GPU decoder only for H.264 and VP8: VS Code's webviews accept no other video codecs, even on GPUs that decode HEVC, VP9 and AV1 ([microsoft/vscode#344372](https://github.com/microsoft/vscode/issues/344372)). Everything else is decoded in WebAssembly, one CPU thread per decoder. That plays up to about 1080p in real time on a desktop, but 4K HEVC, AV1 and VP9, HDR, ProRes and DNxHR at 4K, and VVC are slower than real time, on a laptop a few frames per second at 4K (and 1080p HEVC can already drop below real time). For those, an installed ffmpeg decodes natively, on the GPU where that is faster. It still only decodes, never converts, and shows large videos at full resolution up to 4K when the frame rate allows and the player is that large (`nativeMaxHeight`).

**Setting it up.** Run **Video Preview: Set Up Optional ffmpeg**. No admin rights are needed for any of these:

- **Download a build** (recommended): on Windows and Linux the LGPL build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (about 77 MB on Windows), on macOS from [martin-riedl.de](https://ffmpeg.martin-riedl.de). It is checked against the SHA-256 its publisher lists and unpacked into the extension's own folder; only ffmpeg, ffprobe and their DLLs are kept. The download honours `http.proxy` / `HTTPS_PROXY` (and `http.proxyStrictSSL`); if it is blocked, the extension offers the next option or copies the download link.
- **Use an ffmpeg you already have:** pick `ffmpeg.exe`, a folder with an unpacked build (its `bin/` is found), or a downloaded `.zip` / `.7z` (unpacked for you). It must run and have ffprobe next to it. Saved in `videoPreviewEnhanced.ffmpegPath`.
- **Install with your package manager** (`winget`, `brew`, `apt` and others; may need admin rights).

**When you open a video** without ffmpeg (once per VS Code session), a notification recommends it: **Set up ffmpeg** opens the setup above (download portable ffmpeg, or use one you already have); **Not now** asks again next session; **Don't Show Again** keeps the built-in decoder for good (H.264 and VP8 still play on the GPU) and also silences the slow-playback reminder. Not in Remote-SSH, container or Restricted Mode windows.

**When the built-in decoder falls behind** for a few seconds and no ffmpeg is installed, a small notification suggests the setup with **Set up**, **Not now** (asks again after a week at the earliest) and **Don't Show Again**. It reports the current file's decoding speed and estimates the ffmpeg gain from a local ffmpeg test when available. The fallback estimates below come from an earlier decode-only run reported on 2026-11-19 (i7-9700K, RTX 4070, ffmpeg 9.0.2, clips in `test/media`). That run timed the WebAssembly decoder outside VS Code. The notification says "likely real time" when the CPU estimate reaches the clip's frame rate.

| Measured gain of ffmpeg over the built-in decoder | CPU (8 cores) | GPU (d3d11va or cuda, frames downloaded) |
|---|---|---|
| HEVC 8-bit 1080p | 9.3× | 11× |
| HEVC 10-bit 1080p | 9.4× | 15× |
| HEVC 10-bit 4K | 7.5× | 27× |
| AV1 8-bit 1080p | 16× | 14× |
| AV1 10-bit 1080p | 8.9× | 7.3× |
| AV1 10-bit 4K | 10× | 36× |
| VP9 1080p | 14× | 12× |
| VP9 4K | 14× | 20× |
| ProRes 422 Proxy 1080p | 6.6× | – |
| MPEG-2 1080p | 8.6× | 2.4× |

The 60 fps HEVC fixture also showed about 60 fps over VS Code messages at 1080p on the desktop above. The setup hint uses a message throughput estimate of 150 MB/s from an earlier busy Core Ultra 7 165U laptop run (2026-11-18), equivalent to about 48 fps at 1080p.

**Testing it on your machine (only when you ask).** Nothing is decoded in the background after installing or setting up ffmpeg: until you test, the GPU's maker picks the method (detected from Windows / `lspci`, nothing decoded): `cuda` on NVIDIA (10-bit converted to 8-bit and scaled on the GPU), `qsv` on Intel, `d3d11va` on other Windows GPUs, otherwise ffmpeg's own choice (`-hwaccel auto`). A method that fails on a file falls back to `-hwaccel auto`, then the CPU, and isn't tried again for that kind of file. When a video plays slower than real time with ffmpeg installed and no test has run for this ffmpeg and GPU, one notification offers the test (**Run test**, **Not now**, **Don't Show Again**; at most once per session, not in remote or untrusted windows); it runs only if you click Run test, which pauses native playback while it measures, and the new method applies to the next video you open (or to this one with **Reopen video**). **Video Preview: Re-test ffmpeg** runs a test (a cancellable notification, about 15 to 35 seconds, no windows) that picks the best method per format: short test clips that ship with the extension (H.264, HEVC 8/10-bit, AV1, VP9 at 1080p and 4K, ProRes 1080p) are used to test the available GPU methods in a fixed order, as mpv and VLC do: on Windows `d3d11va`, `qsv` (Intel), `cuda` (NVIDIA), `dxva2`, then the CPU; on Linux `vaapi`, `cuda`, then the CPU; on macOS `videotoolbox`, then the CPU. Each method decodes all clips of a size in one ffmpeg run, one after the other, so the test starts only a handful of ffmpeg processes. A method only counts when it really decoded on the GPU (ffmpeg falls back to the CPU silently; its log shows it) and its picture matches CPU decoding (catches broken drivers). Once a method decodes a format at 4× real time, the methods after it aren't timed for that format. Per format, the first method in that order that runs at least 2× real time is used; if none does, the fastest, where a method further down must be at least 1.3× faster to replace an earlier one (so two methods of about the same speed don't swap from one test to the next). **Video Preview: Re-test ffmpeg** runs the test again; **Show Log** has the table. `videoPreviewEnhanced.gpuDecoding: false` keeps ffmpeg on the CPU.

**Estimates for your file.** The test clips are small (1-2 Mb/s); real files carry more bits per pixel, and CPU decoding slows down with them while GPU decoding hardly does. So for each file the CPU speed from the test is scaled by its pixel count and its bit rate (as ffprobe reports it): about (file bits per pixel / clip bits per pixel)^-0.4, times 0.85 as a margin. In earlier measurements (2026-11-18) on an Intel Core Ultra 7 165U laptop, this predicted the CPU speed of the test files with a median error of 14 % in one run (worst +70 %, 10-bit H.264 estimated from the 8-bit clip) and 30 % in another (estimates too low); the clip alone overestimated a 12 Mb/s 4K HEVC 10-bit file almost 3-fold. GPU speeds are scaled by pixel count only.

**When ffmpeg is used.** With `decoder` set to `auto` and ffmpeg installed, native ffmpeg plays everything except 8-bit H.264 and VP8: those stay on VS Code's GPU decoder (full resolution, no work for the extension host). The test above only picks how ffmpeg decodes (the GPU method or the CPU); until it has run, the GPU's maker picks the method (above). The built-in decoder plays instead:

- in Remote-SSH and container windows: decoded frames would have to cross the connection (WSL is fine, at up to 720p); there the remote stream takes these formats instead (above);
- for a file native ffmpeg failed on (remembered until the file changes), and in Restricted Mode;
- in a tab where you asked for full resolution (below).

**What changes with native ffmpeg.** Frames come out scaled to `nativeMaxHeight` (automatic: up to 2160p over the local connection but no larger than the player's picture needs, 1080p by VS Code messages, 720p in WSL) and as 8-bit 4:2:0. On 4:2:0 video, the CUDA path converts to 8-bit and scales before downloading frames from the GPU. Most of the player works the same; a few tools need the file's own pixels:

| Feature | With native ffmpeg |
|---|---|
| Playback, seeking, frame stepping, A-B loop, speed, rotation | Same. Frame numbers follow the nominal frame rate (variable-frame-rate files are evened out). |
| Pixel inspector, scopes, actual-size zoom, save/copy frame | Read the picture as shown. When native ffmpeg reduces the picture, **Use full resolution (this tab)** switches to the built-in decoder. |
| A-B frame export | Choose **Switch to Full Resolution (This Tab)** or **Export Anyway** to save the playback picture. |

The smooth-playback notice also appears at 100% zoom during Live transcode. **Settings** opens the native frame height or Live transcode setting. **Don't show again** saves the dismissal for future tabs. **×** dismisses the notice for the current tab.
| HDR (PQ/HLG) | Tone-mapped as usual, but from 8-bit frames, so gradients can band. With HDR output (an HDR display) ffmpeg sends 10-bit frames instead, at 1/√2 of the height above (the same bytes per frame: 4K at 1526p over the local connection). |
| Sidecar subtitles, codec X-ray, chapters | Same. |
| Embedded subtitles, switching audio tracks, seek-bar thumbnails | Built-in decoder only (native plays the first audio track). |
| Compare | Each video uses native ffmpeg by the same rule as the player, with frames at its cell's size. |

If native ffmpeg can't start a file with the GPU method, it retries on the CPU; if that fails too, the file plays with the built-in decoder.

Native ffmpeg never runs in Restricted Mode (untrusted workspaces).
