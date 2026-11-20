---
name: reproduce-decode-bug
description: Reproduce and isolate a playback or decode problem for a given video file (wrong picture, no sound, stalls, wrong frame, plays in one decoder only). Use when a bug report or the user names a file that plays badly.
---

# Reproduce a decode bug

Never open a visible VS Code window or a browser. Do not commit the reporter's file; use a short
generated or openly licensed clip, and never put personal paths in tracked files.

## 1. Facts about the file

```
ffprobe -hide_banner -show_streams -show_format <file>
```

Note container, video codec/profile/pix_fmt/size/fps, audio codecs, subtitles, rotation, HDR tags,
start time. Decoder choice lives in `src/decide.js`: A = WebCodecs (8-bit 4:2:0 H.264, VP8),
B = built-in WebAssembly, C = native ffmpeg (the user's install). Each is a separate suspect; find
which one the bug needs by forcing it (see `docs/commands-and-settings.md` for the decoder setting).

## 2. Cheapest reproduction first

1. **Engine in Node** (no VS Code): the WebAssembly decoder runs in Node. `test/engine/unit.js` and
   `test/bench/run_bench.js` show how a file is opened, seeked and stepped. Compare a frame with
   `ffmpeg -i <file> -vf "select=eq(n\,120)" -frames:v 1 out.png`. Covers decoder B for most bugs.
2. **Host logic** (decoder choice, probe, remux, ffmpeg arguments): a `test/host/*_test.js`, with a
   synthetic or tiny file (many tests generate media, see the `*_synth_test.js` files).
3. **Real VS Code, hidden desktop**: a scenario in `test/vscode/cases/` (copy `seeking.js` for
   frame-exactness), or a picture with `node test/vscode/screenshot.js out.png <file> --wait 25`.
   Logs: run with `VPE_LOG=<file>`; the extension's "Show Log" shows the same text.

## 3. Failing test before the fix

Use the smallest layer that shows it. Generate a minimal clip with ffmpeg (see
`test/media/make_cases_media.js`) instead of committing the original; any new media must be openly
licensed and credited in `test/media/LICENSES.md`.

## Pitfalls

- "Plays in VLC" says nothing about which decoder failed here; compare with ffmpeg's output for the
  same frame number, not with another player.
- Frame numbers: the first frame is index 0 in presentation order. A non-zero start PTS or NTSC
  rates (29.97) are the usual off-by-one.
- Heavy 4K software decode is slow by design (`docs/performance.md`); slow is not a decode bug.
- Remote (SSH/WSL) bugs differ from local ones: read `docs/remote.md` before blaming the decoder.
