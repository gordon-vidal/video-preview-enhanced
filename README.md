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


## Getting started

1. **Open a video.** Double-click a video in the Explorer. MP4 and WebM open here too, unless you already chose another
   editor ([how to change it](docs/commands-and-settings.md#making-it-the-default-for-mp4-and-webm)).
2. **Set up ffmpeg (optional).** Run **Video Preview: Set Up Optional ffmpeg** from the Command Palette. It downloads
   a build without admin rights, or uses one you already have. See [Optional ffmpeg](docs/ffmpeg.md).
3. **Open a URL.** Run **Video Preview: Open Video URL…** and paste a direct link, an HLS (`.m3u8`) or a DASH (`.mpd`)
   address. See [Network URLs](docs/urls.md).
4. **Remote.** In a Remote‑SSH or WSL window, open the video the same way. The extension reads the file where it is
   and your machine decodes it. See [Remote](docs/remote.md).

## Most-used keys

Keys work when the player has focus. Press `?` to see them all.

| Key | Action |
|---|---|
| Space / K | Play or pause |
| , / . | Previous / next frame |
| ← / → | Back / forward 5 s |
| Shift+< / Shift+> | Speed −0.05 / +0.05 |
| A / B | Set the A-B loop start / end |
| Ctrl+G | Go to a frame, time or percentage |
| S / Ctrl+C | Save the frame as PNG / copy it |
| I | About this video |
| W / X | Scopes / pixel inspector |
| Shift+X | Codec X-ray |

All keys and mouse actions: [Keys and mouse](docs/keys.md).

## Formats

Containers: MP4, MOV, MKV, WebM, AVI, WMV/ASF, FLV, MPEG‑PS, MPEG‑TS, MXF, OGG/OGV, 3GP and Y4M. Video: H.264 and VP8
on the GPU; HEVC, AV1, VP9, ProRes, DNxHR and many others built in. Sound: AAC, MP3, AC‑3, Opus, FLAC and more. The full
list is in [Formats and codecs](docs/formats.md).

## Documentation

- [Feature tour](docs/features.md)
- [Keys and mouse](docs/keys.md)
- [Commands and settings](docs/commands-and-settings.md)
- [Formats and codecs](docs/formats.md), including the three decoders
- [Performance](docs/performance.md)
- [Network URLs](docs/urls.md)
- [Remote: WSL, SSH and containers](docs/remote.md)
- [Optional ffmpeg](docs/ffmpeg.md)
- [Full comparison with other players](docs/comparison.md)
- [Privacy and security](docs/privacy-and-security.md)
- [FAQ and troubleshooting](docs/faq.md)

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in
[SECURITY.md](SECURITY.md). Tests: [docs/TESTING.md](docs/TESTING.md).

## Licence

Screenshot footage: *Big Buck Bunny* and *Tears of Steel*, (CC) Blender Foundation, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

MIT. The built-in decoder is FFmpeg under the LGPL 2.1 or later, built with libav.js, as a separate, replaceable WebAssembly file; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The optional ffmpeg download (LGPL on Windows and Linux, GPL on macOS) is never bundled. More in [Licences](docs/licences.md).
