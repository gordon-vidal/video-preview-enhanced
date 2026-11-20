<!--
Marketplace page source. Shorter than README.md, for people deciding whether to install.
Package with:  vsce package --readme-path LISTING.md
(README.md stays the GitHub page with every detail.)

Before publishing (see docs/RELEASING.md):
- Image links must resolve over https: vsce rewrites relative links against `repository`,
  which only works once the repo is public (or pass --baseImagesUrl). Until then the
  screenshots below are only visible in a local checkout. See docs/RELEASING.md for capture instructions.
- Re-check every competitor cell in README.md against their current README.
- Re-check the numbers against a real VS Code run (see docs/RELEASING.md).
- Search research and the reasons for the name/description/keywords: docs/notes/marketplace-seo.md.
-->

# Video Preview Enhanced

Play any major video format in VS Code, including over Remote‑SSH and WSL.

<!-- HERO GIF (needed): remote viewing. A Remote-SSH window (status bar shows "SSH: <host>"), a 4K HEVC file in the
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

## How it compares

Install counts from the Visual Studio Marketplace, 20 November 2026.

| Feature | Video Preview Enhanced | VS Code built-in | MPEG‑4 Preview · 173k | video player · 30k | BNPL · 23k |
|---|---|---|---|---|---|
| Major formats at 1080p with sound, no separate FFmpeg install | Yes | Limited | MP4 only, no audio | Codec support varies | FFmpeg required for sound in most formats |
| Optional FFmpeg download for heavier footage | Yes | — | — | — | Manual setup |
| Remote file playback | Yes · SSH and WSL | — | — | — | — |
| Video URLs | Yes | — | — | — | — |
| Synchronized comparison | Yes · up to four clips | No | — | — | — |
| Frame‑accurate stepping | Yes · both directions | No | — | — | — |
| Frame and range export | Yes · PNG | — | — | — | — |
| Scopes, pixel inspector and Codec X‑ray | Yes | — | — | — | — |

## Formats

| | |
|---|---|
| Containers | MP4, MOV, MKV, WebM, AVI, WMV/ASF, FLV, MPEG-PS (MPG, VOB), MPEG-TS (M2TS, MTS), MXF, OGG/OGV, 3GP, Y4M |
| Video | H.264 and VP8 (GPU), HEVC 8/10-bit, AV1, VP9, ProRes, DNxHD/DNxHR, MPEG-4 Part 2 (Xvid, DivX), MPEG-1/2, WMV, VC-1, MJPEG, Theora, FLV1, H.263, DV |
| Sound | AAC, MP3, AC-3, E-AC-3, DTS, Opus, Vorbis, FLAC, ALAC, WMA, AMR, PCM |
| Image sequences | Folders of numbered PNG, JPG, WebP, BMP, GIF or AVIF frames |

## Licence

Screenshot footage: *Big Buck Bunny* and *Tears of Steel*, (CC) Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

MIT. The built-in decoder is FFmpeg under the LGPL 2.1 or later, built with libav.js, as a separate, replaceable WebAssembly file; see THIRD_PARTY_NOTICES.md. The optional ffmpeg download (LGPL on Windows and Linux, GPL on macOS) is never bundled.

Full documentation, keys and settings: [README on GitHub](https://github.com/gordon-vidal/video-preview-enhanced#readme).
