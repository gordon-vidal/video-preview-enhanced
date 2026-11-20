# Video Preview Enhanced

Play any major video format in VS Code, including over Remote‑SSH and WSL.

<!-- HERO GIF (needed, not made yet). When media/marketing/hero-remote.gif exists, add here:
     ![Playing a 4K HEVC video from a Remote-SSH workspace](media/marketing/hero-remote.gif)
     Content: remote viewing. A Remote-SSH window (status bar shows "SSH: <host>"), a 4K HEVC file in the
     Explorer opens with one click and plays smoothly with sound; scrub the seek bar (thumbnails), step a frame.
     ~8-12 s loop, 1280 px wide, < 5 MB. Path: media/marketing/hero-remote.gif (add media/marketing/** to .vscodeignore). -->

Open MP4, MKV, MOV, AVI and WebM with sound. Play 1080p footage in major formats, including HEVC, AV1 and ProRes,
without a separate FFmpeg install. Download optional FFmpeg from VS Code for GPU decoding of heavier footage.

- **Remote‑SSH and WSL.** Open videos from your workspace without manually downloading them. Optional FFmpeg on the SSH
  host can stream heavy footage at a lower bitrate.
- **Video URLs.** Open direct video links, HLS and DASH.
- **Frame‑accurate stepping and synchronized comparison.** Step forward or back, and compare up to four clips on one
  timeline.
- **Frame export and inspection.** Save a frame or range as PNG. Inspect pixel values and scopes, or see frame types
  and bitrate in Codec X‑ray.

Live or encrypted HLS and DASH require FFmpeg.

## Three decoders, picked per file

| | Decoder | Plays | Install |
|---|---|---|---|
| A | **GPU** (VS Code's WebCodecs) | H.264 and VP8 in any container: MP4, MKV, MOV, M2TS/MTS, FLV, AVI, WebM. Not 10-bit or 4:2:2 H.264. | none |
| B | **Built-in** (FFmpeg as WebAssembly) | Everything else: HEVC, AV1, VP9, ProRes, DNxHR, MPEG-2, WMV and more. Real time up to 1080p for most; 4K HEVC, AV1 and VP9 are slow. | none |
| C | **ffmpeg** (native, optional) | Everything, on the GPU where possible. Heavy 4K formats in real time. | one click, no admin |

The container list for A was checked in real VS Code 1.147 (MP4, MKV, MOV, M2TS/MTS, FLV, AVI, WebM). `.ts` is not opened by this extension: VS Code treats it as TypeScript. Measured speeds are in [Performance](#performance).

- **Decodes, never converts.** No temporary files and no waiting for a conversion.
- **Exact frames.** The frame counter shows the frame that is actually on screen. Step forward and back, jump to a frame number, and copy a link that opens the video at that frame.
- **Works remotely.** WSL and Remote-SSH: the extension reads the file where it is, and your machine decodes it. Only compressed data crosses the connection.

## Contents

- [Feature tour](#feature-tour): Playback, Developer tools, Remote, Formats
- [Formats and codecs](#formats-and-codecs)
- [Performance](#performance)
- [How it compares](#how-it-compares)
- [Keys and mouse](#keys-and-mouse)
- [Commands](#commands) and [Settings](#settings)
- [Network URLs (http, HLS, DASH)](#network-urls-http-hls-dash)
- [Remote: WSL, SSH and containers](#remote-wsl-ssh-and-containers)
- [Optional: native ffmpeg for 4K](#optional-native-ffmpeg)
- [Privacy and security](#privacy-and-security)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [Licence](#licence)

## Feature tour

### Playback

- **Opens by double-click.** AVI, MKV, MOV, WMV, FLV, MPEG and the other formats below open in this player. MP4 and WebM open here too: on first start the extension sets itself as their default, unless you already chose another editor ([details and undo](#making-it-the-default-for-mp4-and-webm)).
- **Frame by frame.** `,` and `.` step one frame, and the mouse wheel steps while paused. Stepping backward is exact too: the player seeks to the keyframe before and decodes forward.
- **Speed from 0.25× to 4×** in steps of 0.05, with the sound at its normal pitch. The speed button on the bar opens a slider with presets; scrolling over it, or `Shift+<` / `Shift+>`, changes the speed by 0.05.
- **Loops.** Loop is on by default. `A` and `B` set an A-B loop over any section.
- **Picks up where you left off.** Reopening a video resumes at the last position.
- **Subtitles.** SRT, WebVTT and ASS/SSA files.
  - Files next to the video load by themselves: `video.srt`, `video.en.srt`, `video.eng.forced.srt`, and `Subs/` folders.
  - **Load Subtitles…** (command, or **Load subtitle file…** in the Subtitles panel) opens any other file. With no subtitles, the CC button opens that panel.
  - Delay (`G` / `H`, 50 ms steps) and size, remembered per tab. Any text encoding (UTF-8, UTF-16, Windows-1252).
  - Subtitle tracks inside the file: text (SRT, ASS, WebVTT, mov_text) and picture-based (PGS from Blu-ray, DVB, DVD). Pictures stay in place on the video, also when zoomed.
- **Subtitles and audio tracks.** CC turns subtitles on and off; ⚙ › Subtitles and ⚙ › Audio track list the sources and the file's sound tracks.
- **Seek-bar thumbnails.** Hover or drag the seek bar for a picture of that moment (built-in decoder and native ffmpeg). Pictures are decoded only while the pointer is on the bar, never in the background after a video opens; the one under the pointer first, then a few neighbours.
- **Grab a frame.** `Ctrl+C` copies the current frame to the clipboard; `S` saves it as a full-size PNG.
- **About this video (ⓘ, `I`).** The file in plain words: size and length, resolution (4K, 1080p…), frame rate, HDR and bit depth, video and sound codecs with bit rates, tracks, and what plays it (your GPU through ffmpeg, the built-in decoder, the remote stream). **Copy details** copies it; **Full technical details** shows the technical overlay.
- **Picture-in-picture** (`P`), and **fill the editor** (`F`). Fill also switches VS Code to zen mode, since VS Code doesn't allow real full screen in an editor.
- **Phone videos play upright.** Rotation metadata in MP4/MOV is applied.
- **HDR10 and HLG in HDR on HDR displays.** When Windows reports an HDR display ("Use HDR" on) and VS Code's WebGPU can draw an extended-range canvas, HDR10 (PQ), HLG, HDR10+ and Dolby Vision profile 8 are shown as HDR: 203 nits is SDR white and brighter highlights go above it, up to what the display can show (`videoPreviewEnhanced.hdrOutput`). On SDR displays they are tone-mapped to SDR in the shader (BT.2390, 203 nits as SDR white), so they don't look flat and grey. The info and stats overlays (`I`, `Shift+I`) say which: "HDR output" or "HDR tone-mapped to SDR".
- **Next and previous file.** `Shift+N` and `Shift+P` open the next or previous video in the same folder, in the same tab.
- **Image sequences.** Right-click a folder of numbered PNG, JPG, WebP, BMP, GIF or AVIF frames and choose **Play Image Sequence**.
- **Live reload.** When a render or a capture rewrites the file, the player reloads it and keeps your position.
- **Background tabs pause,** and the screen doesn't go to sleep while a video plays.

### Developer tools

These are for checking encodes, renders, captures and test output.

**Codec X-ray** (`Shift+X`, or the button in the details overlay, `I`). A strip above the seek bar with one bar per frame.
- **Height** is the frame's compressed size. **Colour** is its picture type: I red, P blue, B green, grey when unknown.
- **The line** is the bitrate over a sliding 1 s window.
- **Hover** shows the frame number, time, type, keyframe flag, size and bitrate. **Click** goes to that frame.
- **Wheel** zooms around the pointer, Shift+wheel pans, double-click zooms out. A zoomed view follows playback.
- `{` and `}` step between keyframes. **Chapters** (MKV, MP4, OGG and others) are ticked on the seek bar; PageUp and PageDown step between them.
- Picture types are read from H.264, HEVC, MPEG-1/2 and MPEG-4 Part 2 headers. Codecs without B-frames (VP8, VP9, AV1, Theora, WMV 7/8, FLV1, H.263) show I for keyframes and P for the rest. Intra-only codecs (ProRes, DNxHD, MJPEG) are all I. VC-1 shows only keyframe or not.
- A second WebAssembly demuxer builds the index without decoding, from the part you're looking at outwards. It shares the file blocks the player already read, so remote files aren't fetched twice. It slows down while playback needs the CPU and stops when the strip is off.
- For very large files a view reads at most about 2 GB (256 MB over SSH/WSL). Beyond that it indexes evenly spaced parts, and zooming in fills the gaps. In AVI files with B-frames the bars are in decode order, as AVI stores no presentation times.

**Zoom and pixel inspector.**
- `Ctrl`+wheel zooms around the cursor; drag to pan when zoomed. `Z` switches between fit and actual size.
- `Shift+Z` turns on nearest-neighbour pixels. They also turn on by themselves from 200 %, with a pixel grid from 800 %.
- `X` shows the position, RGB and the source Y/U/V values under the cursor, with an 8× loupe. Click copies the values. Press `X` again for the inspector without the loupe, and a third time to turn it off.

**Go to a frame or time.** `Ctrl+G`, or click the frame number. Type a frame (`1432`), a time (`1:23.456`, `83.5s`), a percentage (`50%`) or a step (`+10`, `-3`).

**Links to a frame.** `Shift+C` (or the line in the details overlay, `I`) copies a link like this:

```
vscode://gordon-vidal.video-preview-enhanced/open?frame=1432&t=47.7833&file=C%3A%5Cclips%5Crun.mkv
```

Opening it from a browser, a terminal, an issue or a chat opens the file in this player at that frame. `t` is the middle of the frame in seconds and `frame` is the frame number; either alone works. Remote files use `uri=` with the full VS Code URI instead of `file=`. Links in Markdown files can point into a video too: `[the glitch](clips/run.mkv#t=47.8)` or `#frame=1432`.

**Stats overlay** (`Shift+I`). Decoder, pixel format, frames shown per second, dropped frames, decode speed, queue, audio clock and cache.

**Scopes** (`W`). A panel in the corner with the scope of the frame on screen; `W` again goes to the next one, then off.
- **Luma waveform**, with lines at code values 0, 16, 235 and 255 (16 and 235 are the legal black and white of limited-range video).
- **RGB parade**: the same for red, green and blue side by side.
- **Vectorscope**, with boxes at the 75 % colour-bar targets and a skin-tone line, in the file's colour matrix (untagged: BT.709 for HD, BT.601 for SD).
- **Histogram** of R, G, B and luma.
- Scopes read the picture as shown (after colour conversion and HDR tone mapping), about 256 columns wide, so levels are 8-bit and below-black or above-white values are already clipped. They update about 10 times a second while playing and at once when you step.

**Export frames.** Set an A-B loop (`A`, `B`), then run **Export Frames (A–B)…** (Command Palette, or the button in the details overlay, `I`). Every frame from A to B is saved as a PNG, named `<video>_f000123.png` with the frame number the player shows, into a folder you pick. It shows progress and can be cancelled; at most 2000 frames, and it asks first above 300. Remote files work: the frames are written where the folder is.

**ffmpeg command for A–B.** **Copy ffmpeg Command for A–B** copies a command line for the same range: an exact cut that re-encodes, or a fast `-c copy` cut. The fast one starts at the keyframe at or before A, so it can begin a little early.

**File details** (`I`). Container, streams, codecs and which decoder plays the file.

**Compare / play together (up to 4 videos).** Check an encoder, a shader, a renderer or a model against a reference, frame by frame. For example, the expected and actual output of a failing test, or four camera angles of one take.
- **Open it:** in a player, ⚙ › Tools › **Compare**, or right-click the picture › **Compare With…**, and pick 1–3 more videos in VS Code's open dialog. Compare takes the player's tab and starts where the player was. Or select 2–4 videos in the Explorer, right-click → **Compare / Play Together** (a new tab). **Leave compare** (in the Compare panel) puts the player back in that tab, at the moment of the clock video.
- **The same bar for all videos:** play, frame steps (in lockstep), seek, speed, loop and the jump keys act on every video. The time and the seek bar follow the **clock** video (its letter shows before the time); mute and volume act on the **sound** video. CC and picture-in-picture are hidden while comparing; the bar's Compare button (two panes) opens the **Compare panel**.
- **Compare panel:** one row per video (letter, name, ⏱ clock, 🔊 sound, offset) that opens its page; **Add video…** (up to 4); with 2 videos **View** (Side by side or Split) and **Swap sides**; **Leave compare**. A video's page: its **offset** (− / + in frames of that video or in ms, with Reset; positive shows a later moment), **Clock** (the seek bar, time and frame steps follow it), **Sound from this video**, **Replace video…** and **Remove**.
- **Layout:** 2 videos side by side, or split (one picture, drag the divider); 3 videos in a 2×2 grid with an empty cell that adds a fourth; 4 in a 2×2 grid. Each video keeps its own shape in its cell. Hover a video for its name, its own frame number and a ‹ offset › nudge; click the name for its page. `−` / `+` nudge the video under the pointer. Right-click a video for its actions: clock, sound, offset, copy its frame or timestamp, replace, remove, add, leave.
- **In sync:** the others follow the clock's time, and a paused view only updates once every video shows its frame, so a step always shows matching frames. Another frame rate is matched by time.
- **Decoding:** every video is its own player. With native ffmpeg, each gets frames at its cell's size (e.g. about 960×540 per cell of a 2×2 grid in a 1080p panel), never above `nativeMaxHeight`, so four videos stay under the transfer limit between VS Code and the panel.
- PSNR / SSIM and "find the first difference" are hidden for now (kept for a later advanced mode).
- Keys: see [Keys in compare](#keys-in-compare).

### Remote

- **WSL and Remote-SSH** work. The extension runs where the files are and reads them in blocks on request. The player on your machine decodes.
- Over remote connections the player asks for several blocks ahead, so the round trip per block doesn't hold playback back.
- Native ffmpeg is used in local windows and WSL; over SSH, raw frames would be too big for the connection. Instead, with ffmpeg on the remote machine, formats VS Code's GPU decoder can't play are re-encoded there as a light H.264 stream (`remoteStream`, on by default). Details in [Remote](#remote-wsl-ssh-and-containers).

### Formats

- **Containers:** MP4, MOV, M4V, 3GP, MKV, WebM, AVI, DivX, FLV, MPEG-TS (M2TS, MTS), MPEG-PS (MPG, VOB), WMV/ASF, MXF, OGG/OGV, Y4M.
- **Video:** H.264, HEVC, AV1, VP8, VP9, MPEG-4 Part 2 (Xvid, DivX), MPEG-1/2, WMV 7/8/9, VC-1, ProRes, DNxHD/DNxHR, MJPEG, Theora, FLV1, H.263, DV and several lossless codecs.
- **Sound:** AAC, MP3, AC-3, E-AC-3, DTS, Opus, Vorbis, FLAC, ALAC, WMA, AMR and PCM.
- **Network URLs:** direct http(s) links to video files, HLS (`.m3u8`) and DASH (`.mpd`) streams: **Video Preview: Open Video URL…** ([below](#network-urls-http-hls-dash)).
- The full list is in the next section.

## Formats and codecs

Everything here plays without installing anything.

| Kind | Supported | Decoded by |
|---|---|---|
| Containers | MP4, MOV, M4V, 3GP, MKV, WebM, AVI, DivX, FLV, MPEG-TS (`.m2ts`, `.mts`), MPEG-PS (`.mpg`, `.mpeg`, `.vob`), WMV/ASF, MXF, OGG/OGV, Y4M | WebAssembly demuxer (FFmpeg) |
| Video on the GPU | H.264 (8-bit 4:2:0), VP8 | VS Code's own decoder (WebCodecs). VS Code allows no other video codecs there: HEVC, VP9 and AV1 are rejected even on GPUs that decode them |
| Video in WebAssembly | HEVC 8/10-bit, AV1 (dav1d), VP9, H.264 High 10 and 4:2:2/4:4:4, MPEG-4 Part 2 (Xvid, DivX, MS-MPEG4 v2/v3), MPEG-1/2, WMV 7/8/9, VC-1, ProRes, DNxHD/DNxHR, MJPEG, Theora, FLV1 (Sorenson), H.263, DV, QuickTime RLE, HuffYUV, FFV1, Ut Video, PNG, GIF, raw | FFmpeg 9.0.2 in WebAssembly |
| Sound | AAC, MP1/MP2/MP3, AC-3, E-AC-3, DTS, Opus, Vorbis, FLAC, ALAC, WMA v1/v2/Pro, AMR-NB/WB, ADPCM, PCM (8 to 32-bit, float, A-law, µ-law, DVD, Blu-ray) | WebCodecs (MP3, FLAC, Vorbis) or WebAssembly |
| MJPEG AVI with PCM sound | Godot Movie Maker, OBS MJPEG, webcams | Read directly, no decoder needed |
| Subtitle files | SRT, WebVTT, ASS/SSA | Built-in parser |
| Subtitle tracks in the file | SRT, ASS/SSA, WebVTT, mov_text; PGS, DVB, DVD (pictures) | Built-in parser; FFmpeg in WebAssembly |
| Image sequences | PNG, JPG, WebP, BMP, GIF, AVIF | The browser |

10-bit and 4:2:2/4:4:4 pictures are converted to RGB on the GPU, in a WebGL shader.

**Newer, less tested:** VVC (H.266), APV and Dolby TrueHD/MLP play in the player (checked on short test clips: VVC with AAC, APV 10-bit 4:2:2, H.264 with TrueHD). Long or high-resolution files are untested.

**Not supported yet:**
- Dolby Vision without an HDR10, HLG or SDR base layer (profile 5, used by streaming services): the player says so instead of showing wrong colours. Profile 8 (and 7) play their base layer as HDR10 or HLG; Dolby Vision's and HDR10+'s dynamic metadata isn't used.
- HDR output was checked on an SDR display only (forced in the tests): the values reach the extended-range canvas as expected, but how bright an HDR display shows them is up to Windows and the display.
- `.ts` files: VS Code uses that extension for TypeScript, so the player doesn't claim it. Rename to `.m2ts` or `.mts`.

## Performance

### In the player (real VS Code)

Measured on 2026-11-19 in VS Code 1.147.0 on Windows 10 with an Intel i7-9700K (8 cores), RTX 4070 and 32 GB RAM. The [hidden-desktop runner](test/vscode/README.md) used fresh profiles and ffmpeg 9.0.2 for native playback. It reports the upper median of the two-second playback samples after the first. Each WebAssembly decoder uses one thread in the webview. The decoder pool can spread independent groups of pictures across cores.

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

CPU for native 4K HEVC 10-bit (30 fps) in a fresh install, measured 2026-11-20 on the same machine with all VS Code processes and ffmpeg counted: 3.7 cores before (`-hwaccel auto`, 3840×2160 frames), 1.0 core now (CUDA with GPU 8-bit conversion, frames at the player's 1080p picture), at 30 fps both times ([notes](docs/notes/cpu-4k.md)).

For native 4K HEVC, the first frame appeared 776 ms after session creation on the cold open and 581–707 ms on two warm opens. ffmpeg started 86–130 ms before ffprobe finished.

- **The decoder pool** runs several WebAssembly decoders, each on its own stretch of the video between keyframes. It helps most with intra-only codecs (ProRes, DNxHR); long-GOP 4K HEVC and AV1 gain little, because there are few keyframes to split the work at.
- **4K HEVC 10-bit and AV1 10-bit in software are slower than real time** on this machine, and 4K ProRes and DNxHR can be with fewer free cores. By default playback then slows down and shows every frame, and a notice says so once. Its button skips to keyframes instead, or install the [optional ffmpeg](#optional-native-ffmpeg) to decode on the GPU in real time.
- **Earlier laptop run (2026-11-18).** On a busy Intel Core Ultra 7 165U in VS Code 1.146, 4K H.264 showed 28–29 fps on the GPU. In WebAssembly, 4K HEVC 10-bit showed about 3 fps, 4K VP9 3–6 fps, 1080p AV1 11–17 fps, and 1080p ProRes Proxy and MPEG-2 17–24 fps. Native ffmpeg showed 5–22 fps for 4K HEVC 10-bit and AV1 10-bit during that run.
- **Memory.** The 4K HEVC WebAssembly test logged budgets of 400 MB for the player's decoded frame queue and 600 MB for the decoder pool on the 32 GB desktop. Emulating an 8 GB machine lowered those limits to 160 MB and 240 MB.

### Decoder speed by codec

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

## How it compares

Other video players for VS Code, from their Marketplace READMEs as of November 2026, with install counts from the Marketplace on 17 November 2026. "Not listed" means their README doesn't mention it; the feature may still exist. Corrections are welcome as issues.

| | Video Preview Enhanced 0.6.1 | [MoviPlayer](https://marketplace.visualstudio.com/items?itemName=mrujjwalg.movi-player-vscode) 0.4.1 | [Modern Video Player](https://marketplace.visualstudio.com/items?itemName=Brodazz.mp4-player) 0.8.9 | [Video Preview (Player) – BNPL](https://marketplace.visualstudio.com/items?itemName=BatchNepal.vscode-video-preview) 0.2.0 | VS Code's built-in preview |
|---|---|---|---|---|---|
| Installs | new | 2.8k | 3.9k | 23k | built in |
| File types it opens | AVI, MKV, MOV, MP4, WebM, WMV, FLV, MPG, VOB, M2TS, MXF, OGV, 3GP, Y4M | MP4, MKV, WebM, MOV, TS, M2TS, AVI, FLV, WMV, MPG, 3GP, plus URLs | MP4, MOV, M4V, MKV, AVI, WebM, M2TS, MTS, FLV, F4V | MP4, WebM, MOV, MKV, AVI, M4V | MP4, WebM |
| HEVC, VP9 | Built-in WebAssembly showed 7.5 fps for 4K HEVC 10-bit and 12 fps for 4K VP9 on the desktop above. Optional ffmpeg showed 30 fps at full 4K for the HEVC clip | says it decodes in real time (WebAssembly or WebCodecs). VS Code only lets webviews use WebCodecs for H.264 and VP8, so we expect software decoding for these in VS Code; we did not measure it | converts to H.264 first (a one-time wait) | not listed | no |
| AV1 | yes | yes | no (per README) | not listed | no |
| ProRes, DNxHR, MXF, WMV2 | yes | no decoder in 0.4.1 (our test) | not listed | not listed | no |
| AAC sound with nothing installed | yes | yes | yes | needs ffmpeg | no |
| Frame stepping | yes, with frame counter | not listed | yes | not listed | no |
| Speed range | 0.25×–4× in 0.05 steps, pitch kept | adjustable (range not listed) | 0.25×–2× | 0.5×–2× | – |
| Subtitles | SRT, VTT, ASS files, in-file text and PGS/DVB/DVD tracks, delay | SRT, ASS, VTT, PGS, DVB, in-file tracks, delay, transcript | SRT, VTT files, delay | not listed | no |
| A-B loop / resume | yes / yes | not listed / yes | yes / yes | not listed | no |
| HDR | HDR10, HLG, Dolby Vision 8, HDR10+ as HDR10; HDR output on HDR displays, else tone-mapped to SDR | HDR10, HLG, Dolby Vision 8 | not listed | not listed | – |
| Streams from URLs (HLS, DASH) | HLS (quality menu, WebVTT subtitles, AES-128) and direct links with nothing installed; live HLS and DASH with ffmpeg; fetched by the extension, so no CORS or https needed | yes, in the webview (the server must allow CORS; https for streams) | no | no | no |
| Codec X-ray, pixel inspector, compare | yes | stats overlay | no | no | no |
| Remote (WSL, SSH) | yes, tested | not listed | not listed | not listed | yes |

Where MoviPlayer is ahead today: DASH, live HLS and alternate audio languages without installing anything (its README; we did not test whether its webview playback handles AAC in VS Code). We have not measured MoviPlayer's speed in VS Code, so there is no speed row for it here. Where this extension is ahead: ProRes, DNxHR, MXF, WMV and FLV1 decoding, a multi-core decoder pool, frame-exact tools and compare.

## The player

One layout (the old simple / advanced switch is gone). The bar, left to right:
previous frame, play / pause, next frame, mute, volume, the time (click it: time → SMPTE timecode → frame
number; the same detail while playing and paused), then CC (subtitles), ⓘ (about this video), the speed
(click: speed panel; scroll: ±0.05), ⚙ (settings), ⌨ (keyboard shortcuts), picture-in-picture and fullscreen.

- A click on the picture plays or pauses; with a panel open it closes the panel.
- Each bar button opens its panel and closes it when clicked again. `Esc` closes any panel.
- **⚙ Settings:** Speed ›, Loop (switch), A-B loop (start, end, off), Subtitles ›, Audio track ›, Copy frame,
  Keyboard shortcuts, Jump sizes › and a **Tools** grid: Compare, Scopes, Inspector, Stats, Codec X-ray,
  Export A-B, then **Open video URL…** ([network URLs](#network-urls-http-hls-dash)) and last **Extension settings** (VS Code's Settings, filtered to this extension). The tools'
  keys work at any time.
- **Jump sizes ›:** what ← →, Shift+← → and Ctrl+← → (Cmd on macOS) jump: 1 frame, 1 s, 5 s, 10 s or 30 s
  each (defaults 5 s, 1 s, 1 frame). Saved as settings. `,` and `.` always step one frame.
- No status pill: when decoding falls behind, a notice says so once, with its action (set up ffmpeg, or
  skip frames / show every frame).
- Colours follow the VS Code theme (light, dark and high contrast).

## Keys and mouse

The layout follows common video players (YouTube-style). Keys work when the player has focus. `?` shows
them all, with the jump sizes you chose.

### Playback

| Key | Action |
|---|---|
| Space / K | Play or pause |
| J / L | Back / forward 10 s |
| ← / → | Back / forward 5 s (setting `jump.arrow`) |
| Shift+← / Shift+→ | Back / forward 1 s (setting `jump.shift`) |
| Ctrl+← / Ctrl+→ (Cmd on macOS) | Back / forward one frame (setting `jump.ctrl`) |
| , / . | Previous / next frame |
| Shift+< / Shift+> (or [ / ]) | Speed −0.05 / +0.05 (0.25×–4×) |
| 0–9 | Jump to 0–90 % |
| Home / End | First / last frame |
| ↑ / ↓ | Volume ±5 % |
| M | Mute. Playback starts muted until you click, because VS Code blocks autoplay with sound |
| R | Loop on or off |
| A / B | Set the A-B loop start / end (press again to clear) |
| F | Fill the editor and switch to zen mode |
| P | Picture-in-picture |
| Shift+N / Shift+P | Next / previous video in the folder |
| S / Ctrl+C | Save the frame as PNG / copy it |
| ? | Keyboard shortcuts |
| Esc | Close a panel or the shortcuts |

Alt+← / Alt+→ are VS Code's Go Back / Go Forward and Ctrl+K starts VS Code's key chords: the player
leaves them alone (`docs/notes/ui-simple.md`).

### Inspection

| Key | Action |
|---|---|
| Ctrl+G | Go to a frame, time, percentage or step (or click the frame number) |
| Shift+C | Copy a link to the current frame |
| I | About this video (the ⓘ panel); its **Full technical details** shows the codec, pixel format and decoder overlay |
| Shift+I | Stats overlay |
| W | Scopes: luma waveform, RGB parade, vectorscope, histogram, off |
| Z | Fit or actual size |
| Shift+Z | Nearest-neighbour pixels |
| X | Pixel inspector: with loupe, without loupe, off |
| Shift+X | Codec X-ray strip on or off |
| { / } | Previous / next keyframe |
| PageUp / PageDown | Previous / next chapter (PageUp goes to the start of the current chapter first) |

### Subtitles and audio

| Key | Action |
|---|---|
| C | Subtitles on / off (with none: the Subtitles panel, to load a file) |
| V | Next subtitle track, then off |
| Shift+V | Subtitles off / on |
| G / H | Subtitle delay −50 ms / +50 ms |
| Shift+A or # | Next audio track |

### Mouse

| Mouse | Action |
|---|---|
| Click the picture | Play or pause (or close an open panel) |
| Double-click the picture | Fill the editor |
| Wheel, while paused | Step frames |
| Ctrl+wheel (or pinch) | Zoom around the cursor; drag to pan |
| Hover the seek bar | Thumbnail and time |
| Click the time | Time → timecode → frame number |
| Wheel over the speed button | Speed ±0.05 |
| Wheel over the volume | Volume ±5 % |
| Drag the seek bar or the volume | Keeps following the mouse while the button is held, also off the slider |
| X-ray strip | Hover for details, click to go there, wheel to zoom, Shift+wheel to pan, double-click to zoom out |

### Right-click menu

Right-clicking the player opens VS Code's own context menu (no Cut / Copy / Paste) with quick actions on this moment, like a browser's or YouTube's: **Play** / **Pause**, **Loop** (✓ when on), then **Set Loop Start (A)**, **Set Loop End (B)** and **Clear A-B Loop** (while a loop is set), then **Copy Frame**, **Save Frame as PNG…**, **Copy Timestamp**, then **Compare With…** (video files only), then **Keyboard Shortcuts** and **Settings…** (opens the ⚙ panel). The frame link is `Shift+C`. How it plays (speed, sound, subtitles, tools) is in the ⚙ panel. The entries only run on the player in focus; they are hidden from the Command Palette. Needs VS Code 1.82 or later (the extension's minimum); details in `docs/notes/context-menu.md`.

Frame numbers are the ones the player shows: `#1` is the first frame.

### Keys in compare

The player's keys, for all videos at once, plus:

| Key | Action |
|---|---|
| Space / K | Play or pause all |
| , / . | Previous / next frame of the clock video (the others follow) |
| ← / →, Shift+← / →, Ctrl+← / → | The player's jump sizes, on the clock video |
| - / + | Offset of the video under the pointer, one frame (10 ms when its offset is in ms) |
| X | Swap sides (2 videos) |
| ← / → on the focused split divider | Move it by 1 % (Shift: 10 %); Home / End |
| Ctrl+C | Copy the view (all videos) |
| I | About these videos (a tab per video) |
| Shift+< / >, ↑ / ↓, M, R, F, ?, Esc | Speed, volume, mute, loop, fullscreen, shortcuts, close (as in the player) |

## Commands

All are under **Video Preview** in the Command Palette.

| Command | What it does |
|---|---|
| Set Up Optional ffmpeg (GPU decoding for 4K, AV1, ProRes) | Downloads ffmpeg, or uses one you have, and tests it ([below](#optional-native-ffmpeg)) |
| Re-test ffmpeg | Tests ffmpeg's GPU decoding on this machine (never runs on its own; also offered once when playback is slower than real time and no test has run); results in Show Log |
| Use Video Preview Enhanced for MP4/WebM | Opens MP4 and WebM in this player by default |
| Use VS Code's Preview for MP4/WebM | Undoes that |
| Open with Video Preview Enhanced | Explorer context menu on an MP4 or WebM file (not in the Command Palette) |
| Compare / Play Together | Shows the 2–4 videos selected in the Explorer together, in sync |
| Compare With… | Compares the open video with 1–3 more files (in the player's place) |
| Load Subtitles… | Opens a subtitle file for the current video (needs an open player) |
| Export Frames (A–B)… | (needs an open player) Saves every frame of the A-B loop as PNG into a folder you pick |
| Copy ffmpeg Command for A–B | (needs an open player) Copies an ffmpeg command that cuts the A-B loop (exact or `-c copy`) |
| (right-click menu items) | The player's context menu runs commands named `videoPreviewEnhanced.ctx.*` (play, pause, loopOn, loopOff, setA, setB, clearAB, copyFrame, saveFrame, copyTime, keys, playerSettings). They are not in the Command Palette; [see above](#right-click-menu) |
| Open Video URL… | Plays a video from an http(s) URL: a direct file link, an HLS (`.m3u8`) or DASH (`.mpd`) stream ([below](#network-urls-http-hls-dash)). Also **Open video URL…** in the player's ⚙ panel |
| Open Video URL to the Side… / Open Video URL in New Window… | The same, in the editor group beside the current one or in a new window |
| Play Image Sequence | Plays a folder of numbered images (also in the Explorer context menu of a folder or an image) |
| Show Log | Shows the extension's log, useful for bug reports |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `videoPreviewEnhanced.decoder` | `auto` | `auto`: native ffmpeg when it is installed, for everything except 8-bit H.264 and VP8 (those stay on VS Code's GPU decoder), in local and WSL windows; otherwise, and over SSH or in containers, the built-in decoder ([details](#optional-native-ffmpeg)). `builtin`: always the built-in decoder. `ffmpeg`: always native ffmpeg when it is installed (local and WSL windows). |
| `videoPreviewEnhanced.whenSlow` | `every` | When decoding is slower than real time: `every` slows playback down and shows every frame; `skip` keeps real time by jumping to keyframes. The notice shown when decoding falls behind switches it too. |
| `videoPreviewEnhanced.overrideFileIcons` | `true` | Override file icons: give every format the player opens the same video icon in the Explorer (Seti, the default file icon theme, already does this for .avi, .mov, .mpg, .ogv, .mp4 and .webm; this adds .mkv, .flv, .mpeg, .m2ts, .wmv, .3gp, .m4v, .vob, .divx, .asf, .mxf and .y4m). It writes `"*.ext": "vpe-video"` entries to your user `files.associations` where you have none, and turning it off removes only those. Other icon themes may show their own icon instead. So the icons are there before you open a video, the extension loads when VS Code starts (about 30 ms per window). VS Code doesn't let a setting change that, so it still loads with this off, but does no file-icon work. |
| `videoPreviewEnhanced.jump.arrow` | `5` | How far ← / → jump: `"frame"` (one frame) or 1, 5, 10, 30 seconds. Also ⚙ › Jump sizes in the player. |
| `videoPreviewEnhanced.jump.shift` | `1` | The same for Shift+← / Shift+→. |
| `videoPreviewEnhanced.jump.ctrl` | `"frame"` | The same for Ctrl+← / Ctrl+→ (Cmd on macOS). |
| `videoPreviewEnhanced.stepButtons` | `"frame"` | What the two buttons beside Play do: `"frame"` steps one frame, `"jump"` jumps by the Ctrl+← / Ctrl+→ size (`jump.ctrl`). Also ⚙ › Jump sizes. |
| `videoPreviewEnhanced.advancedMode` | `false` | No longer used (deprecated): the player has one layout and its tools are always in the ⚙ panel ([details](#the-player)). |
| `videoPreviewEnhanced.autoplay` | `true` | Start playing when a video opens. |
| `videoPreviewEnhanced.loop` | `true` | Loop playback. |
| `videoPreviewEnhanced.sequenceFps` | `30` | Frame rate for image sequences (1 to 240). |
| `videoPreviewEnhanced.ffmpegPath` | empty | Your own ffmpeg. Empty: the one setup downloaded, then PATH. A machine setting; a workspace can't set it. |
| `videoPreviewEnhanced.gpuDecoding` | `true` | Let native ffmpeg decode on the GPU, with the method the test found best here. `false`: CPU only. |
| `videoPreviewEnhanced.hdrOutput` | `auto` | `auto`: HDR10, HLG (and Dolby Vision 8, HDR10+) are shown in HDR when the display reports HDR and VS Code's WebGPU can draw an extended-range canvas; otherwise tone-mapped to SDR. `off`: always tone-mapped. Details: `docs/notes/hdr-output.md`. |
| `videoPreviewEnhanced.nativeMaxHeight` | `0` (automatic) | The local frame server picks an output height up to 2160p based on the source frame rate (2160p for a 4K 30 fps source, 1440p for a 4K 60 fps source), and, with `sizeFramesToView` on (default), no larger than the player's picture needs (540p, 720p, 1080p, 1440p or 2160p for its size in device pixels; a zoomed picture counts at its zoomed size; growing, e.g. to fullscreen or zooming in, applies within about a second, shrinking at the next seek or loop). The VS Code message fallback uses 1080p locally. WSL is capped at 720p. A number sets the height limit (and always sends that size). |
| `videoPreviewEnhanced.sizeFramesToView` | `true` | Performance: with ffmpeg, send frames only as large as the picture is shown (540p to 2160p), which saves a lot of CPU for 4K videos (4K HEVC 10-bit in a 1080p panel: about 1 core instead of 3.7 on the test PC). The picture grows to full resolution at once when you enlarge the panel, go fullscreen or zoom in. Off: frames always up to `nativeMaxHeight` (automatic: 2160p for 4K at 30 fps). A number in `nativeMaxHeight` wins either way. Applies at once to open videos. |
| `videoPreviewEnhanced.fastPreviewWhenBehind` | `false` | Built-in decoder, HEVC and H.264 only: while playback is behind real time, leave out deblocking for about 1.2-1.5x faster decoding. The picture is approximate while playing; paused and stepped frames are always decoded exactly. |
| `videoPreviewEnhanced.remoteStream` | `auto` | Remote windows: ffmpeg on the remote machine streams what the GPU decoder can't play as H.264 ([details](#remote-wsl-ssh-and-containers)). `off`: the built-in decoder; `on`: every window (testing). A machine setting: set it in the remote's settings. |

### Making it the default for MP4 and WebM

VS Code has its own preview for MP4 and WebM. On first start after installing (and after an update that adds formats) this extension writes `workbench.editorAssociations` in your **user** settings so MP4 and WebM open here too, without a popup. It only fills entries you haven't set: if you already chose another editor for `*.mp4`, that stays. It happens once; undoing is remembered. You can also:

- **Undo later:** run **Video Preview: Use VS Code's Preview for MP4/WebM** (it removes only the entries pointing at this player). To apply again: **Video Preview: Use Video Preview Enhanced for MP4/WebM**.
- **One file type:** right-click an `.mp4` → **Open With…** → **Configure default editor for '*.mp4'…**.
- **settings.json:**
  ```json
  "workbench.editorAssociations": {
    "*.mp4": "videoPreviewEnhanced.playerOptional",
    "*.webm": "videoPreviewEnhanced.playerOptional"
  }
  ```

All other formats open in this player by default.

## Network URLs (http, HLS, DASH)

**Video Preview: Open Video URL…** (Command Palette, or **Open video URL…** near the bottom of the player's ⚙ panel) asks for a URL and plays it in a new tab; **Open Video URL to the Side…** and **Open Video URL in New Window…** do the same beside the current editor or in a new window. An http(s) URL on the clipboard is filled in for you to confirm; URLs you opened before are offered first (the last 10).

| URL | Without ffmpeg | With native ffmpeg |
|---|---|---|
| Direct link to a file (MP4, WebM, MKV, MOV, …) | Built-in decoder, read with HTTP range requests (seeking works when the server supports ranges; a server without them works for files up to 512 MB) | Same decoder rule as for files: 8-bit H.264 and VP8 on the GPU decoder, the rest with ffmpeg reading the URL |
| HLS VOD (`.m3u8`, MPEG-TS or fMP4 segments, also AES-128 encrypted) | Built-in decoder: the chosen variant (up to 1080p), its segments read as one file and decrypted by the extension; seeking works | ffmpeg (the chosen variant) |
| HLS live, DASH (`.mpd`) | Not played: the player says it needs ffmpeg and offers **Set up ffmpeg** | ffmpeg |
| DRM-protected HLS (SAMPLE-AES, FairPlay, Widevine, PlayReady) | Not played: "This stream is protected" (VS Code has no content decryption module) | Same |

- **Quality (HLS):** for a stream with several variants the ⚙ panel has **Quality ›**: **Auto** (the default) or a variant ("1080p", "720p", …). Auto picks once when the stream opens: the smallest picture that fills the player, at most 80 % of the download rate measured on the first segment. Picking a quality reopens the stream at that variant from the same moment. There is no switching while it plays.
- **Subtitles from the stream (HLS):** WebVTT subtitle renditions are listed in the CC / Subtitles panel by name and language (marked "stream"); the default one is shown automatically.
- **Live streams** play from the live edge; the seek bar is off and the time shows `LIVE` (clicking it doesn't switch to timecode or frames). The ⓘ panel shows the host and "stream" instead of a file size.
- Video pages (YouTube and similar) are not video URLs: the player says "This URL is a web page, not a video".
- Errors are plain: not found (HTTP 404), access denied or an expired link (401/403), no answer within 20 s, an untrusted TLS certificate, a refused connection.
- `http.proxy` / `HTTPS_PROXY` are honoured (as for the ffmpeg download), and VS Code's own proxy routing applies too.
- **Remote windows:** the URL is fetched by the extension host, which runs on the remote machine (SSH, WSL, containers), not on your computer. Over SSH only the built-in decoder plays URLs, so live HLS and DASH need a local window.
- Features that need a file are off for URLs: compare (not in the ⚙ Tools grid), frame links (`Shift+C` says why), the ffmpeg command for A–B, sidecar subtitles (Load Subtitles… still works), resume position, seek-bar thumbnails. Saving and exporting frames work.
- A URL only ever comes from what you type or paste into VS Code's input box: never from a file, a playlist or a link in a page. ffmpeg gets network access only for that URL; files keep the local-only rules ([Privacy and security](#privacy-and-security)). Details: [docs/notes/url-stream.md](docs/notes/url-stream.md).

## Remote: WSL, SSH and containers

The extension runs where the workspace is (a workspace extension). It reads the video file there in blocks, on request: 1 MB locally, 4 MB over remote connections, with 4 blocks requested ahead. The player in the editor, on your machine, does the decoding. Only compressed file data crosses the connection: about 1 MB/s for 1080p H.264, about 5 MB/s for 4K HEVC, 15–40 MB/s for ProRes.

| | WSL | Remote-SSH | Dev containers, Codespaces |
|---|---|---|---|
| Built-in decoder | Yes, tested at 30 fps (2026-11-18) | Yes, tested over loopback at 30 fps (2026-11-18) | Expected to work (same design), not tested |
| Native ffmpeg | Yes: the Linux ffmpeg inside WSL, shown at up to 720p | No: raw frames are too big for the link | No |
| Remote stream (`remoteStream: auto`) | Only when native ffmpeg doesn't play the file | Earlier Remote-SSH loopback run (2026-11-19): 4K HEVC 10-bit at 29 fps with the stream and 7.5 fps in WebAssembly | Expected to work, not tested |
| Live reload | Yes; for `/mnt/c` paths, change events can be unreliable | Yes | Not tested |

The current desktop run also showed 30 fps for the 4K HEVC 10-bit fixture with `remoteStream: on` and libx264 in a local window.

- **Remote stream:** in a remote window, a file VS Code's GPU decoder can't play (anything but 8-bit H.264 and VP8) is decoded by ffmpeg on the remote machine, scaled to `nativeMaxHeight` and re-encoded as low-latency H.264, which the editor decodes on the GPU. Sound is sent uncompressed (PCM, about 3 Mb/s). On a slow connection the picture steps down to 720p, 480p or 360p (about 3, 1.2 and 0.45 Mb/s plus the sound) and back up when the connection allows, with a short notice; a slow remote CPU does not count as a slow connection. Below what 360p with its sound needs (about 3.5 Mb/s for a file with sound), the stream stays at 360p and says playback may stutter; it doesn't switch to the built-in decoder, which would need the whole file over the same connection. It uses the remote's GPU encoder (NVENC, Quick Sync, AMF, VAAPI) when one works there, else x264. It needs ffmpeg on the remote machine (`ffmpegPath` in the remote's settings, or PATH). Set `videoPreviewEnhanced.remoteStream` to `off` in the remote's settings for the built-in decoder. As with native ffmpeg, the picture is 8-bit and scaled: pixel tools switch the tab to the built-in decoder.
- A real network with 50–100 ms latency will start and seek more slowly than a local file.
- vscode.dev and other browser-only VS Code setups are not supported.

## Optional: native ffmpeg

The built-in decoder uses VS Code's GPU decoder only for H.264 and VP8: VS Code's webviews accept no other video codecs, even on GPUs that decode HEVC, VP9 and AV1 ([microsoft/vscode#344372](https://github.com/microsoft/vscode/issues/344372)). Everything else is decoded in WebAssembly, one CPU thread per decoder. That plays up to about 1080p in real time on a desktop, but 4K HEVC, AV1 and VP9, HDR, ProRes and DNxHR at 4K, and VVC are slower than real time, on a laptop a few frames per second at 4K (and 1080p HEVC can already drop below real time). For those, an installed ffmpeg decodes natively, on the GPU where that is faster. It still only decodes, never converts, and shows large videos at full resolution up to 4K when the frame rate allows and the player is that large (`nativeMaxHeight`).

**Setting it up.** Run **Video Preview: Set Up Optional ffmpeg**. No admin rights are needed for any of these:

- **Download a build** (recommended): on Windows and Linux the LGPL build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (about 77 MB on Windows), on macOS from [martin-riedl.de](https://ffmpeg.martin-riedl.de). It is checked against the SHA-256 its publisher lists and unpacked into the extension's own folder; only ffmpeg, ffprobe and their DLLs are kept. The download honours `http.proxy` / `HTTPS_PROXY` (and `http.proxyStrictSSL`); if it is blocked, the extension offers the next option or copies the download link.
- **Use an ffmpeg you already have:** pick `ffmpeg.exe`, a folder with an unpacked build (its `bin/` is found), or a downloaded `.zip` / `.7z` (unpacked for you). It must run and have ffprobe next to it. Saved in `videoPreviewEnhanced.ffmpegPath`.
- **Install with your package manager** (`winget`, `brew`, `apt` and others; may need admin rights).

**When you open a video** without ffmpeg (once per VS Code session), a notification recommends it: **Set up ffmpeg** opens the setup above (download portable ffmpeg, or use one you already have); **Not now** asks again next session; **Don't remind me (use built-in player)** keeps the built-in decoder for good (H.264 and VP8 still play on the GPU) and also silences the slow-playback reminder. Not in Remote-SSH, container or Restricted Mode windows.

**When the built-in decoder falls behind** for a few seconds and no ffmpeg is installed, a small notification suggests the setup with **Set up**, **Not now** (asks again after a week at the earliest) and **Don't ask again**. It reports the current file's decoding speed and estimates the ffmpeg gain from a local ffmpeg test when available. The fallback estimates below come from an earlier decode-only run reported on 2026-11-19 (i7-9700K, RTX 4070, ffmpeg 9.0.2, clips in `test/media`). That run timed the WebAssembly decoder outside VS Code. The notification says "likely real time" when the CPU estimate reaches the clip's frame rate.

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

**Testing it on your machine (only when you ask).** Nothing is decoded in the background after installing or setting up ffmpeg: until you test, the GPU's maker picks the method (detected from Windows / `lspci`, nothing decoded): `cuda` on NVIDIA (10-bit converted to 8-bit and scaled on the GPU), `qsv` on Intel, `d3d11va` on other Windows GPUs, otherwise ffmpeg's own choice (`-hwaccel auto`). A method that fails on a file falls back to `-hwaccel auto`, then the CPU, and isn't tried again for that kind of file. When a video plays slower than real time with ffmpeg installed and no test has run for this ffmpeg and GPU, one notification offers the test (**Run test**, **Not now**, **Don't remind me**; at most once per session, not in remote or untrusted windows); it runs only if you click Run test, which pauses native playback while it measures, and the new method applies to the next video you open (or to this one with **Reopen video**). **Video Preview: Re-test ffmpeg** runs a test (a cancellable notification, about 15 to 35 seconds, no windows) that picks the best method per format: short test clips that ship with the extension (H.264, HEVC 8/10-bit, AV1, VP9 at 1080p and 4K, ProRes 1080p) are used to test the available GPU methods in a fixed order, as mpv and VLC do: on Windows `d3d11va`, `qsv` (Intel), `cuda` (NVIDIA), `dxva2`, then the CPU; on Linux `vaapi`, `cuda`, then the CPU; on macOS `videotoolbox`, then the CPU. Each method decodes all clips of a size in one ffmpeg run, one after the other, so the test starts only a handful of ffmpeg processes. A method only counts when it really decoded on the GPU (ffmpeg falls back to the CPU silently; its log shows it) and its picture matches CPU decoding (catches broken drivers). Once a method decodes a format at 4× real time, the methods after it aren't timed for that format. Per format, the first method in that order that runs at least 2× real time is used; if none does, the fastest, where a method further down must be at least 1.3× faster to replace an earlier one (so two methods of about the same speed don't swap from one test to the next). **Video Preview: Re-test ffmpeg** runs the test again; **Show Log** has the table. `videoPreviewEnhanced.gpuDecoding: false` keeps ffmpeg on the CPU.

**Estimates for your file.** The test clips are small (1-2 Mb/s); real files carry more bits per pixel, and CPU decoding slows down with them while GPU decoding hardly does. So for each file the CPU speed from the test is scaled by its pixel count and its bit rate (as ffprobe reports it): about (file bits per pixel / clip bits per pixel)^-0.4, times 0.85 as a margin. In earlier measurements (2026-11-18) on an Intel Core Ultra 7 165U laptop, this predicted the CPU speed of the test files with a median error of 14 % in one run (worst +70 %, 10-bit H.264 estimated from the 8-bit clip) and 30 % in another (estimates too low); the clip alone overestimated a 12 Mb/s 4K HEVC 10-bit file almost 3-fold. GPU speeds are scaled by pixel count only.

**When ffmpeg is used.** With `decoder` set to `auto` and ffmpeg installed, native ffmpeg plays everything except 8-bit H.264 and VP8: those stay on VS Code's GPU decoder (full resolution, no work for the extension host). The test above only picks how ffmpeg decodes (the GPU method or the CPU); until it has run, the GPU's maker picks the method (above). The built-in decoder plays instead:

- in Remote-SSH and container windows: decoded frames would have to cross the connection (WSL is fine, at up to 720p); there the remote stream takes these formats instead (above);
- for a file native ffmpeg failed on (remembered until the file changes), and in Restricted Mode;
- in a tab where you asked for full resolution (below).

**What changes with native ffmpeg.** Frames come out scaled to `nativeMaxHeight` (automatic: up to 2160p over the local connection but no larger than the player's picture needs, 1080p by VS Code messages, 720p in WSL) and as 8-bit 4:2:0. On 4:2:0 video, the CUDA path converts to 8-bit and scales before downloading frames from the GPU. Most of the player works the same; a few tools need the file's own pixels:

| Feature | With native ffmpeg |
|---|---|
| Playback, seeking, frame stepping, A-B loop, speed, rotation | Same. Frame numbers follow the nominal frame rate (variable-frame-rate files are evened out). |
| Pixel inspector, scopes, actual-size zoom, save/copy frame | Read the picture as shown. When it is scaled or deeper than 8-bit 4:2:0, a notice offers **Use full resolution**, which switches that tab to the built-in decoder. |
| A-B frame export | Asks first: switch to full resolution, or export the scaled frames. |
| HDR (PQ/HLG) | Tone-mapped as usual, but from 8-bit frames, so gradients can band. With HDR output (an HDR display) ffmpeg sends 10-bit frames instead, at 1/√2 of the height above (the same bytes per frame: 4K at 1526p over the local connection). |
| Sidecar subtitles, codec X-ray, chapters | Same. |
| Embedded subtitles, switching audio tracks, seek-bar thumbnails | Built-in decoder only (native plays the first audio track). |
| Compare | Each video uses native ffmpeg by the same rule as the player, with frames at its cell's size. |

If native ffmpeg can't start a file with the GPU method, it retries on the CPU; if that fails too, the file plays with the built-in decoder.

Native ffmpeg never runs in Restricted Mode (untrusted workspaces).

## Privacy and security

- **Nothing leaves your machine.** No telemetry, no analytics, no network requests of its own.
- **Two exceptions, both started by you:** the ffmpeg download, only when you run **Set Up Optional ffmpeg** and choose to download (GitHub for BtbN builds, martin-riedl.de for macOS); and a URL you open with **Open Video URL…**, which is fetched from its server (and, for a stream, the segments it lists). The query string of a URL is never logged.
- **Sandboxed decoding.** The built-in decoder is WebAssembly inside the editor's webview, which can only load the extension's own media folder.
- **Restricted Mode:** only the built-in decoder runs. Native ffmpeg never does, and a workspace can't set `ffmpegPath`.
- **No temporary files.** Videos are decoded in memory and never written anywhere.

## FAQ and troubleshooting

**Why is there no sound at first?**
VS Code blocks sound until you interact with the page. Click the video or press `M`.

**MP4 files open in VS Code's own preview.**
You may have undone the automatic default, or chosen another editor for them. See [Making it the default](#making-it-the-default-for-mp4-and-webm), or right-click → **Open With…** → **Video Preview Enhanced**.

**A 4K video plays in slow motion.**
The tested 4K HEVC, AV1 and VP9 clips played below their source rate in WebAssembly. See [Performance](#performance) for frame rates. VS Code lets the player use the GPU decoder only for H.264 and VP8. ⓘ (About this video) says what plays the file and the stats overlay (`Shift+I`) shows the decoding speed; when playback falls behind, a notice offers to skip to keyframes. Or or run **Set Up Optional ffmpeg** (no admin rights needed) to decode natively.

**The stats overlay says "4.5 s decoded ahead" or "Fully decoded".**
While paused, the player decodes ahead within its frame memory budget so playback resumes smoothly. "Fully decoded" means the rest of the clip is in memory. (These used to be a status pill on the bar; the bar no longer shows it.)

**The player uses a lot of memory.**
One 4K frame in 8-bit 4:2:0 takes about 12 MB. See the measured [frame memory budgets](#performance). Close other video tabs on 8 GB machines.

**HDR video looks dim or different from my TV.**
On an SDR display, HDR10 (PQ) and HLG are tone-mapped to SDR: 203 nits shows as white and highlights up to the content peak (1000 nits unless the file says otherwise) are compressed into the top of the range. On an HDR display (Windows: Settings > Display > "Use HDR") the player shows them in HDR; the stats overlay (`Shift+I`) says "HDR output" then. It decides when the video opens: reopen it after turning HDR on or moving VS Code to another display. `videoPreviewEnhanced.hdrOutput: off` always tone-maps. With HDR output, SDR white is the display's SDR brightness (Windows' "SDR content brightness"), so HDR video looks as bright as other HDR apps show it.

**A file doesn't open, or plays wrong.**
Run **Video Preview: Show Log** and include the log in an [issue](https://github.com/gordon-vidal/video-preview-enhanced/issues), with the output of `ffprobe` for the file if you have it.

**Does it work in Cursor, VSCodium or Windsurf?**
It uses only standard VS Code APIs and needs VS Code 1.82 or later. It hasn't been tested in other editors yet.

## Contributing and testing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests and the pull request flow, and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md).

The testing strategy is in [docs/TESTING.md](docs/TESTING.md); the real-VS-Code tests are described in [test/vscode/README.md](test/vscode/README.md). To try any branch, commit or `.vsix` in a fresh VS Code with a folder of sample videos on Windows, run `review.cmd <branch|commit|file.vsix>` ([docs/REVIEW.md](docs/REVIEW.md)).

## Licence

- **This extension:** MIT, see [LICENSE](LICENSE).
- **Built-in decoder:** FFmpeg 9.0.2's libraries under the LGPL 2.1 or later, built with [libav.js](https://github.com/Yahweasel/libav.js), with dav1d (BSD 2-clause) and zlib. It is a separate WebAssembly file set in `media/libav-vpe/` that you can replace with your own build. Licences, sources and the build definition: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [`media/libav-vpe/LICENSE-NOTE.md`](media/libav-vpe/LICENSE-NOTE.md).
- **Optional ffmpeg builds** downloaded by setup are LGPL on Windows and Linux (BtbN's `lgpl` builds) and GPL on macOS. They are separate programs, never bundled.
- **Test clips** in `media/probe/` are short excerpts of the film *Meridian* ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), from [Netflix Open Content](https://opencontent.netflix.com)), tone-mapped to SDR and re-encoded; details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the [LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html), and its source can be downloaded [here](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz).
