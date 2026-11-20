# Formats and codecs

## Three decoders, picked per file

| | Decoder | Plays | Install |
|---|---|---|---|
| A | **GPU** (VS Code's WebCodecs) | H.264 and VP8 in any container: MP4, MKV, MOV, M2TS/MTS, FLV, AVI, WebM. Not 10-bit or 4:2:2 H.264. | none |
| B | **Built-in** (FFmpeg as WebAssembly) | Everything else: HEVC, AV1, VP9, ProRes, DNxHR, MPEG-2, WMV and more. Real time up to 1080p for most; 4K HEVC, AV1 and VP9 are slow. | none |
| C | **ffmpeg** (native, optional) | Everything, on the GPU where possible. Heavy 4K formats in real time. | one click, no admin |

The container list for A was checked in real VS Code 1.147 (MP4, MKV, MOV, M2TS/MTS, FLV, AVI, WebM). `.ts` is not opened by this extension: VS Code treats it as TypeScript. Measured speeds are in [Performance](performance.md).

- **Decodes, never converts.** No temporary files and no waiting for a conversion.
- **Exact frames.** The frame counter shows the frame that is actually on screen. Step forward and back, jump to a frame number, and copy a link that opens the video at that frame.
- **Works remotely.** WSL and Remote-SSH: the extension reads the file where it is, and your machine decodes it. Only compressed data crosses the connection.

## Supported formats

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
