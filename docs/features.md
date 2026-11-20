# Feature tour

## Playback

- **Opens by double-click.** AVI, MKV, MOV, WMV, FLV, MPEG and the other formats below open in this player. MP4 and WebM open here too: on first start the extension sets itself as their default, unless you already chose another editor ([details and undo](commands-and-settings.md#making-it-the-default-for-mp4-and-webm)).
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

## Developer tools

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
- **Open it:** in a player, press **D** (quick pick: videos of this folder first, then the workspace, recently compared first, **Browse…** for the open dialog), or hold **Shift** and drag a video from the Explorer onto the picture; or ⚙ › Tools › **Compare**, ⚙ › Tools › **Compare**, or right-click the picture › **Compare With…**, and pick 1–3 more videos in VS Code's open dialog. Compare takes the player's tab and starts where the player was. Or select 2–4 videos in the Explorer, right-click → **Compare / Play Together** (a new tab). **Leave compare** (in the Compare panel) puts the player back in that tab, at the moment of the clock video.
- **The same bar for all videos:** play, frame steps (in lockstep), seek, speed, loop and the jump keys act on every video. The time and the seek bar follow the **clock** video (its letter shows before the time); mute and volume act on the **sound** video. CC and picture-in-picture are hidden while comparing; the bar's Compare button (two panes) opens the **Compare panel**.
- **Compare panel:** one row per video (letter, name, ⏱ clock, 🔊 sound, offset) that opens its page; **Add video…** (up to 4); with 2 videos **View** (Side by side or Split) and **Swap sides**; **Leave compare**. A video's page: its **offset** (− / + in frames of that video or in ms, with Reset; positive shows a later moment), **Clock** (the seek bar, time and frame steps follow it), **Sound from this video**, **Replace video…** and **Remove**.
- **Layout:** 2 videos side by side, or split (one picture, drag the divider); 3 videos in a 2×2 grid with an empty cell that adds a fourth; 4 in a 2×2 grid. Each video keeps its own shape in its cell. Hover a video for its name, its own frame number and a ‹ offset › nudge; click the name for its page. `−` / `+` nudge the video under the pointer. Right-click a video for its actions: clock, sound, offset, copy its frame or timestamp, replace, remove, add, leave.
- **In sync:** the others follow the clock's time, and a paused view only updates once every video shows its frame, so a step always shows matching frames. Another frame rate is matched by time.
- **Decoding:** every video is its own player. With native ffmpeg, each gets frames at its cell's size (e.g. about 960×540 per cell of a 2×2 grid in a 1080p panel), never above `nativeMaxHeight`, so four videos stay under the transfer limit between VS Code and the panel.
- PSNR / SSIM and "find the first difference" are hidden for now (kept for a later advanced mode).
- Keys: see [Keys in compare](keys.md#keys-in-compare).

## Remote

- **WSL and Remote-SSH** work. The extension runs where the files are and reads them in blocks on request. The player on your machine decodes.
- Over remote connections the player asks for several blocks ahead, so the round trip per block doesn't hold playback back.
- Native ffmpeg is used in local windows and WSL; over SSH, raw frames would be too big for the connection. Instead, with ffmpeg on the remote machine, formats VS Code's GPU decoder can't play are re-encoded there as a light H.264 stream (`remoteStream`, on by default). Details in [Remote](remote.md).

## Formats

- **Containers:** MP4, MOV, M4V, 3GP, MKV, WebM, AVI, DivX, FLV, MPEG-TS (M2TS, MTS), MPEG-PS (MPG, VOB), WMV/ASF, MXF, OGG/OGV, Y4M.
- **Video:** H.264, HEVC, AV1, VP8, VP9, MPEG-4 Part 2 (Xvid, DivX), MPEG-1/2, WMV 7/8/9, VC-1, ProRes, DNxHD/DNxHR, MJPEG, Theora, FLV1, H.263, DV and several lossless codecs.
- **Sound:** AAC, MP3, AC-3, E-AC-3, DTS, Opus, Vorbis, FLAC, ALAC, WMA, AMR and PCM.
- **Network URLs:** direct http(s) links to video files, HLS (`.m3u8`) and DASH (`.mpd`) streams: **Video Preview: Open Video URL…** ([Network URLs](urls.md)).
- The full list is in [Formats and codecs](formats.md).

## The player

One layout (the old simple / advanced switch is gone). The bar, left to right:
previous frame, play / pause, next frame, mute, volume, the time (click it: time → SMPTE timecode → frame
number; the same detail while playing and paused), then CC (subtitles), ⓘ (about this video), the speed
(click: speed panel; scroll: ±0.05), ⚙ (settings), ⌨ (keyboard shortcuts), picture-in-picture and fullscreen.

- A click on the picture plays or pauses; with a panel open it closes the panel.
- Each bar button opens its panel and closes it when clicked again. `Esc` closes any panel.
- **⚙ Settings:** Speed ›, Loop (switch), A-B loop (start, end, off), Subtitles ›, Audio track ›, Copy frame,
  Keyboard shortcuts, Jump sizes › and a **Tools** grid: Compare, Scopes, Inspector, Stats, Codec X-ray,
  Export A-B, then **Open video URL…** ([network URLs](urls.md)) and last **Extension settings** (VS Code's Settings, filtered to this extension). The tools'
  keys work at any time.
- **Jump sizes ›:** what ← →, Shift+← → and Ctrl+← → (Cmd on macOS) jump: 1 frame, 1 s, 5 s, 10 s or 30 s
  each (defaults 5 s, 1 s, 1 frame). Saved as settings. `,` and `.` always step one frame.
- No status pill: when decoding falls behind, a notice says so once, with its action (set up ffmpeg, or
  skip frames / show every frame).
- Colours follow the VS Code theme (light, dark and high contrast).
