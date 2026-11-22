# Video Preview Enhanced

**Play all major video formats with sound in VS Code, locally, over Remote‑SSH, or in WSL.**

- **Every common format, with sound:** MP4, MKV, MOV, AVI, WebM, WMV, MXF and more, including HEVC, AV1 and ProRes.
- **Nothing else to install, no admin rights:** plays right away. Add portable FFmpeg with one click (still no admin rights) and 4K HEVC and AV1 play in real time on your GPU.
- **Remote video streaming:** Remote‑SSH and WSL, with an efficient transcode on the SSH host for heavy footage. Video URLs and HLS / DASH streams too.
- **Seek‑bar previews:** hover or drag the seek bar and see the picture at that moment.
- **Frame‑accurate:** step one frame forward or back, jump to any frame or timecode.
- **Compare up to 16 videos** in sync: side by side, split or in a grid.
- **Pro tools:** scopes, pixel inspector, Codec X‑ray (I / P / B frames and bitrate).
- **Everyday comforts:** subtitles, audio tracks, 0.25× to 4× speed, A–B loops.
- **Free, MIT licensed, no telemetry.**

## Remote video streaming

Double-click a video in a **Remote‑SSH or WSL workspace** and it plays, with no download first. Heavy footage is no problem: with FFmpeg on the SSH host, it is transcoded there into a light H.264 stream sized to your player, which steps down on a slow connection. In a loopback SSH test, a 4K 10-bit HEVC clip went from **7.5 to 29 fps**. Run **Video Preview: Open Video URL…** to play a link or an HLS / DASH stream.

![Playing a video from a Remote-SSH workspace, stepping a frame and comparing two encodes](media/marketing/hero-remote.gif)

## Seek‑bar previews

Hover over the seek bar to see the picture at that moment, and drag to scrub through the video live. Release and you land on the exact frame. A separate decoder reads only the keyframes, starts when your pointer reaches the bar and stops when it leaves, so previews appear quickly and never slow playback down.

## Frame‑accurate

Step one frame forward or back, and backward is exact too. Jump to a frame number or timecode, loop a section, and copy a link that opens the video at that exact frame for someone else.

## Compare videos side by side

Select up to **eight videos** (16 with a setting), right-click and choose **Compare Videos**. They play on one timeline: play, pause and frame steps move every video together. Nudge a video's offset by single frames to line it up, and switch between side by side, split and grid. Made for checking an encode against its source, a render against a reference, or several camera angles of one take.

## And much more

- **Scopes:** waveform, RGB parade, vectorscope and histogram.
- **Pixel inspector:** zoom in and read the RGB and Y / U / V values under the cursor.
- **Codec X‑ray:** every frame as a bar, with its type (I, P, B), size and bitrate. Click one to go there.
- **Subtitles and audio:** SRT, WebVTT, ASS and embedded tracks; switch audio tracks.
- **Grab frames:** copy or save the current frame as PNG, or export a whole range.
- **HDR10 and HLG**, upright phone videos, image sequences, and a live reload when a render rewrites the file.

## How it compares

The three most-installed dedicated players in the Marketplace snapshot reviewed on **20 November 2026**, alongside VS Code’s built-in preview.

| Feature | **Video Preview Enhanced** | VS Code built-in | [MPEG‑4 Preview](https://marketplace.visualstudio.com/items?itemName=analytic-signal.preview-mp4) · 173k | [video player](https://marketplace.visualstudio.com/items?itemName=VMASPAD.video-player) · 30k | [BNPL](https://marketplace.visualstudio.com/items?itemName=BatchNepal.vscode-video-preview) · 23k |
|---|---|---|---|---|---|
| Major formats at 1080p with sound, no FFmpeg setup | ✅ | ❌ MP4 and WebM only | ❌ MP4 only, no sound | ➖ varies by codec | ❌ needs FFmpeg for sound |
| Optional FFmpeg, set up from the extension | ✅ | — | — | — | ➖ manual setup |
| Remote‑SSH and WSL | ✅ | — | — | — | — |
| Video URLs and streams | ✅ | — | — | — | — |
| Synchronized comparison | ✅ up to 16 videos | ❌ | — | — | — |
| Frame‑accurate stepping | ✅ forward and back | ❌ | — | — | — |
| Seek‑bar previews | ✅ | ❌ | — | — | — |
| Scopes, pixel inspector, Codec X‑ray | ✅ | ❌ | — | — | — |

*✅ yes · ❌ no · ➖ partly · — not established in the sources reviewed. Install counts are rounded.*

## Under the hood

- **Three decoders, picked per file:** VS Code's own, a built-in FFmpeg compiled to WebAssembly, and optional native FFmpeg for GPU decoding of heavy footage. **Video Preview: Set Up Optional ffmpeg** installs it from inside VS Code.
- Live or encrypted HLS and DASH streams need FFmpeg.

## Quick start

1. **Play:** Double-click a video in the VS Code Explorer.
2. **Step:** Pause and press `,` or `.`. Press `?` for all shortcuts.
3. **Compare:** Select two or more videos, right-click, and choose **Compare Videos**.
4. **Play heavier footage:** Run **Video Preview: Set Up Optional ffmpeg** from the Command Palette.

Details: [features](docs/features.md) · [formats](docs/formats.md) · [shortcuts](docs/keys.md) · [commands and settings](docs/commands-and-settings.md) · [remote](docs/remote.md) · [ffmpeg](docs/ffmpeg.md) · [FAQ](docs/faq.md) · [all docs](docs/) · [contributing](CONTRIBUTING.md) · [licences](docs/licences.md)
