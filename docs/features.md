# Feature tour

## Playback

- **Opens by double-click.** AVI, MKV, MOV, WMV, FLV, MPEG and the other formats below open in this player. MP4 and WebM open here too: on first start the extension sets itself as their default, unless you already chose another editor ([details and undo](commands-and-settings.md#making-it-the-default-for-mp4-and-webm)).
- **Frame by frame.** `,` and `.` step one frame, and the mouse wheel steps while paused. Stepping backward is exact too: the player seeks to the keyframe before and decodes forward.
- **Speed from 0.25× to 4×** in steps of 0.05, with the sound at its normal pitch. The speed button on the bar opens a slider with presets; scrolling over it, or `Shift+<` / `Shift+>`, changes the speed by 0.05.
- **Autoplay.** What happens at the end: **Off** (default: stop on the last frame), **Play next in folder** (the next video of the folder plays in the same tab from the start; it stops at the last one) or **Loop**. In ⚙ › Autoplay and the folder rail's footer; `R` turns Loop on and off. `A` and `B` set an A-B loop over any section, which always repeats.
- **Picks up where you left off.** Reopening a video resumes at the last position.
- **Subtitles.** SRT, WebVTT and ASS/SSA files.
  - Files next to the video load by themselves: `video.srt`, `video.en.srt`, `video.eng.forced.srt`, and `Subs/` folders.
  - **Load Subtitles…** (command, or **Load subtitle file…** under **Settings › Subtitles**) opens any other file.
  - Delay (`G` / `H`, 50 ms steps) and size, remembered per tab. Any text encoding (UTF-8, UTF-16, Windows-1252).
  - Subtitle tracks inside the file: text (SRT, ASS, WebVTT, mov_text) and picture-based (PGS from Blu-ray, DVB, DVD). Pictures stay in place on the video, also when zoomed.
- **Subtitles and audio tracks.** CC appears when a subtitle track is available and turns subtitles on and off. **Settings › Subtitles** is always available. **Settings › Audio track** lists the file's sound tracks.
- **Seek-bar thumbnails.** Hover or drag the seek bar for a picture of that moment (built-in decoder and native ffmpeg). Pictures are decoded only while the pointer is on the bar, never in the background after a video opens; the one under the pointer first, then a few neighbours.
- **Grab a frame.** `Ctrl+C` copies the current frame to the clipboard; `S` saves it as a full-size PNG.
- **About this video (ⓘ, `I`).** The file in plain words: size and length, resolution (4K, 1080p…), frame rate, HDR and bit depth, video and sound codecs with bit rates, tracks, and what plays it (your GPU through ffmpeg, the built-in decoder, the remote stream). **Copy details** copies it; **Copy link to this frame** copies a frame link. There is no second details overlay: everything is in ⓘ.
- **Fullscreen** (`F`) uses the full editor width in VS Code Zen Mode when the webview cannot enter fullscreen. Press `F` again to restore the workbench layout.
- **Phone videos play upright.** Rotation metadata in MP4/MOV is applied.
- **HDR10 and HLG in HDR on HDR displays.** When Windows reports an HDR display ("Use HDR" on) and VS Code's WebGPU can draw an extended-range canvas, HDR10 (PQ), HLG, HDR10+ and Dolby Vision profile 8 are shown as HDR: 203 nits is SDR white and brighter highlights go above it, up to what the display can show (`videoPreviewEnhanced.hdrOutput`). On SDR displays they are tone-mapped to SDR in the shader (BT.2390, 203 nits as SDR white), so they don't look flat and grey. The info and stats overlays (`I`, `Shift+I`) say which: "HDR output" or "HDR tone-mapped to SDR".
- **Next and previous file.** `Shift+N` and `Shift+P`, the `‹` / `›` of the `2/5` capsule on the bar, or a right-click on ◀| / |▶ show the previous or next video in the same folder (natural order: `clip 2` before `clip 10`), in the same tab.
- **Folder rail.** Click the `2/5` capsule, or the small tab that appears at the picture's right edge, for a list of the folder beside the picture: `..` goes up, folders list in place, a filter, **Playable formats** (videos only), and a column for Duration, Size or Modified (click `DURATION ▾` or right-click the header). Hover a file for its length, size, date, resolution and codec; the button on a video's row compares it with the playing one (or adds both to an open Compare), and on a folder's row it compares all the videos in that folder. Drag its left edge to resize it (176–360 px). Browsing doesn't change what plays, or what `Shift+N` and Autoplay take next, until you pick a video. The setting `folderRail.layout` floats it over the picture instead (`overlay`). It keeps its state when you move to another video. In **Compare** the same rail opens from the tab at the right edge: the clips in Compare are marked, a click on a video adds it (once, up to `compare.maxVideos`), and a folder's Compare button (or `D`) adds the videos of that folder.
- **Image sequences.** Run **Video Preview: Play Image Sequence** from the Command Palette and pick a folder of numbered PNG, JPG, WebP, BMP, GIF or AVIF frames.
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
- `Ctrl`+wheel zooms around the cursor, from any picture size; drag to pan when the picture is larger than the player. `+` / `-` zoom around the middle. `Z` cycles the **picture size** (below); zoomed in, `Z` goes back to Fit first.
- `Shift+Z` turns on nearest-neighbour pixels. They also turn on by themselves from 200 %, with a pixel grid from 800 %.
- `X` shows the position, RGB and the source Y/U/V values under the cursor, with an 8× loupe. At 100 %, the inspector can distinguish individual screen pixels on high-DPI displays. Click copies the values. Press `X` again for the inspector without the loupe, and a third time to turn it off.

**Go to a frame or time.** `Ctrl+G`, or click the frame number. Type a frame (`1432`), a time (`1:23.456`, `83.5s`), a percentage (`50%`) or a step (`+10`, `-3`).

**Links to a frame.** `Shift+C` (or the line in the details overlay, `I`) copies a link like this:

```
vscode://gordon-vidal.video-preview-enhanced/open?frame=1432&t=47.7833&file=C%3A%5Cclips%5Crun.mkv
```

Opening it from a browser, a terminal, an issue or a chat opens the file in this player at that frame. `t` is the middle of the frame in seconds and `frame` is the frame number; either alone works. Remote files use `uri=` with the full VS Code URI instead of `file=`. Links in Markdown files can point into a video too: `[the glitch](clips/run.mkv#t=47.8)` or `#frame=1432`.

**Compare links & AI agents.** `/compare` links open two or more videos in a synchronized Compare view at a given frame and layout (`grid`, `spotlight`, or `split`):

```
vscode://gordon-vidal.video-preview-enhanced/compare?frame=142&mode=split&file=%2Fpath%2Fbefore.mp4&file=%2Fpath%2Fafter.mp4
```

See [Deep links for AI coding agents & scripts](agents.md) for all parameters and a copy-paste prompt for `AGENTS.md` / `CLAUDE.md`.

**Stats overlay** (`Shift+I`). Decoder, pixel format, frames shown per second, dropped frames, decode speed, queue, audio clock and cache.

**Scopes** (`W`). A panel in the corner with the scope of the frame on screen; `W` again goes to the next one, then off.
- **Luma waveform**, with lines at code values 0, 16, 235 and 255 (16 and 235 are the legal black and white of limited-range video).
- **RGB parade**: the same for red, green and blue side by side.
- **Vectorscope**, with boxes at the 75 % colour-bar targets and a skin-tone line, in the file's colour matrix (untagged: BT.709 for HD, BT.601 for SD).
- **Histogram** of R, G, B and luma.
- Scopes read the picture as shown (after colour conversion and HDR tone mapping), about 256 columns wide, so levels are 8-bit and below-black or above-white values are already clipped. They update about 10 times a second while playing and at once when you step.

**Export frames.** Set an A-B loop (`A`, `B`), then run **Export Frames (A–B)…** (Command Palette, or **⚙ › A–B Range**). Choose a frame stride (`1` for every frame, or `N` for every Nth frame) and a folder: each exported frame from A to B is saved as a PNG named `<video>_f000123.png` with the 1-based frame number the player shows. It shows progress and can be cancelled; at most 2000 exported frames, and it asks first above 300. Remote files work: the frames are written where the folder is.

**ffmpeg command for A–B.** **Copy ffmpeg Command for A–B** copies a command line for the same range: an exact cut that re-encodes, or a fast `-c copy` cut. The fast one starts at the keyframe at or before A, so it can begin a little early.

**Export an A–B clip.** Mark the first and last pictures with **A** and **B**, then choose **Export A–B Clip…**
from the Command Palette or **⚙ › A–B Range**. Pick a folder for
`<video>_A-B.<ext>`. The export copies the original video, compressed audio and embedded subtitle payloads. PCM audio is
trimmed sample by sample in its original format. The export requires native ffmpeg and ffprobe on the host
that has the video. MP4 and MOV use edit lists to show A through B, inclusive.
Other files use MP4 when their streams can be copied into it. If an exact clip cannot be made, the player can
offer a same-container keyframe cut or let you omit audio or subtitles. Review any early start or shifted end
before saving a keyframe cut. Use an edit-list-aware player to view exact clips. The file can still contain
compressed pictures outside the visible interval when decoding the selected pictures requires them.

Exact clips work with marks set under the built-in decoders and under native ffmpeg: native ffmpeg reports each
picture's own timestamp, also for variable-frame-rate video and files that start at a non-zero time. Live
transcode re-times pictures. A and B still set the playback loop. If you try to export an exact clip from those
marks, the player offers **Use original video** so you can switch and set A and B again. An ffmpeg too old to
report timestamps (before 5.1) offers the built-in decoder at export. A clip appears under its final name once
it is complete. Existing files are never replaced.

**Export Compare clips.** **A** and **B** mark a shared loop on the Compare clock. Run **Export A–B Clips…**
from the palette or **Settings → Tools** to save one clip per tile, named `<letter>_<video>_A-B.<ext>`.
Export applies each tile's offset and reports when snapping to a source frame changes alignment. If some tiles
cannot be exported exactly, Compare lists them and asks before saving the remaining clips. Both exports report
their results and preserve existing files in the chosen folder.

**File details** (`I`). Container, streams, codecs and which decoder plays the file.

**Compare / play together (up to 8 videos by default).** Check an encoder, a shader, a renderer or a model against a reference, frame by frame. For example, the expected and actual output of a failing test, or four camera angles of one take.
- **Copy a tile:** in large grids, **Copy tile as shown** copies the tile at its rendered size.
- **From the Explorer:** right-click a video, folder or selection and choose **Start Compare**. When a Compare is already open, the menu shows **Add to Compare** and adds the selection to the most recently active Compare. Folders contribute their direct video files in natural name order. Duplicate files are skipped and a message counts any videos that exceed `compare.maxVideos`. **Open Together** (`compare.openTogether`) also groups multiple videos opened at once, such as a drop from the Explorer, and opens them as one Compare within a fraction of a second. A drop includes selected videos the editor already shows in a preview tab.
- **From the player:** click the split-view **Compare** icon in the bar, then **Start comparison**: Compare opens with this video and Add Mode on (Cancel, Esc or a click elsewhere does nothing). With a Compare open the icon is labeled **Add to Compare** and adds the video to the most recently active Compare at once. The editor title shows **Start Compare** (pick more videos) or **Add to Compare** in the same way. Press **D** for a quick pick (same folder first, then workspace, with **Browse…** for the file dialog), hold **Shift** and drag a video from the Explorer onto the picture, or use **Compare With…** in the player's right-click menu. **Shift+D** or ⚙ › Tools › **Compare** waits for the next video you open. Compare takes the player's tab at its current position. **Leave compare** restores the player at the clock video's position.
- **Add Mode:** click videos in the Explorer to add them to Compare. It turns on when you ask to add more: the bar's **Start comparison**, **Shift+D**, **Add video…**, the Compare panel's switch, or a right-click **Start / Add to Compare** on a single video that starts a one-video Compare. A Compare that starts from several videos at once (a drop or Open Together, a multi-selection or folder, **Compare Videos in Folder**, the **D** quick pick) opens with Add Mode off. Add Mode stays on during playback, scrubbing and stepping, and stops when you click **Stop** in the hint, press **Esc** or **Shift+D**, reach the maximum or switch editors. The Explorer's **Add to Compare** works either way.
- **The same bar for all videos:** play, frame steps (in lockstep), seek, speed, loop and the jump keys act on every video. The time and the seek bar follow the **clock** video (its letter shows before the time); mute and volume act on the **sound** video. CC is hidden while comparing; the bar's Compare button (two panes) opens the **Compare panel**.
- Tile frame numbers use the same timestamp rounding as the player, including for formats that store timestamps in whole milliseconds.
- **Unified viewer (preview).** The setting `unifiedViewer` (off by default) opens video files in one tab that shows one video and grows to a comparison and back in place; with **Capture** on, the next video you open joins that tab instead of opening its own. It does not have frame links, subtitles, export, resume or Live transcode yet; video URLs and image sequences always open in the player.
- **Compare panel:** one row per video (letter, name, ⏱ clock, 🔊 sound, offset) that opens its page; **Add video…** (starts add mode: click the videos in the Explorer; up to 8 by default, or 16 with `compare.maxVideos`); with 2 videos **View** (Side by side or Split) and **Swap sides**; **Leave compare**. A video's page: its **offset** (− / + in frames of that video or in ms, with Reset; positive shows a later moment), **Clock** (the seek bar, time and frame steps follow it), **Sound from this video**, **Replace video…** and **Remove**.
- **Layout:** 2 videos side by side, or split (one picture, drag the divider); 3 videos in a 2×2 grid with an empty cell that adds a fourth; 4 in a 2×2 grid. From 5 on, videos fill a static grid in order (3×2, 3×3, 4×3 or 4×4). The first spare slot shows **Add video** on hover or keyboard focus while below the limit. Each video keeps its own shape in its cell. Hover a video for its name, its own frame number and a ‹ offset › nudge; click the name for its page. With three or more videos, the **×** in the top-right corner removes that video. In larger grids the nudge sits below the name pill. `−` / `+` nudge the video under the pointer. Right-click a video for its actions: clock, sound, offset, copy its frame or timestamp, replace, remove, add, leave.
- **Reorder tiles.** Click **Reorder** in the bar and drag a tile to its new position. Click **Done**, press **Esc** or switch tabs to exit. While you drag, the tile follows the pointer and the other tiles glide into the order a drop would give (no glide with reduced motion). Hover or focus a tile to use its up and down arrows at any time. The clock, sound and offsets follow their videos.
- **In sync:** the others follow the clock's time, and a paused view only updates once every video shows its frame, so a step always shows matching frames. Another frame rate is matched by time.
- **Decoding:** every video is its own player. With native ffmpeg, each gets frames at its cell's size (e.g. about 960×540 per cell of a 2×2 grid in a 1080p panel), never above `nativeMaxHeight`, so four videos stay under the transfer limit between VS Code and the panel.
- PSNR / SSIM and "find the first difference" are hidden for now (kept for a later advanced mode).
- **Picture size in compare:** the same button, `Z` and ⚙ › Picture size apply to every video at once; Ctrl+wheel and drag zoom and pan all videos together, each showing the same part of its own picture, like a magnifier over all of them.
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
previous frame, play / pause, next frame (a small badge that appears when you point at them picks how far they jump:
1 frame, 5 frames, 1 s, 5 s or 10 s), mute (new tabs start muted by default; dimmed and disabled when the video has no
audio track), volume (opens when you point at mute), the time (click it: time → SMPTE timecode → frame
number; the same detail while playing and paused), then CC (only when the video has subtitles), the folder capsule `‹ 2/5 ›` (a folder with more than one video), **Compare** (video
files), ⓘ (about this video), the speed (click: speed panel; scroll: ±0.05), ⚙ (settings), the **picture size**
button and fullscreen. Volume, playback speed, the time display format and the step size carry over across open tabs
and sessions.

- A click on the picture plays or pauses; with a panel open it closes the panel.
- ⚙, ⓘ and the speed open their panel and close it when clicked again. CC turns subtitles on and off. `Esc` closes
  any panel or the Compare confirmation.
- **⚙ Settings**, in groups. **Playback:** Autoplay › (Off, Play next in folder, Loop), Speed ›, Subtitles ›, Audio track ›, Picture size ›, Live transcode ›, Compare, Copy frame.
  **Tools:** **A–B Range ›** (set A / B / clear, Export frames A–B…, Export A–B Clip…, Copy ffmpeg command for A–B) and **Inspection ›**
  (Pixel inspector `X`, Scopes `W`, Stats `Shift+I`, Codec X-ray `Shift+X`). Then **Open video URL…** ([network URLs](urls.md)), **Open in system player**
  (local files), **Keyboard shortcuts** (also opens with `?`) and last **Extension settings** (VS Code's Settings, filtered to this extension).
  The tools' keys work at any time.
- **Picture size:** how the picture sits in the player. **Fit** (default) shows the whole picture, with bars where its shape differs; **Fill** has no bars and crops the edges (centred); **Stretch** fills the player and distorts the picture; **100 %** shows one video pixel per screen pixel, and you drag to move a picture larger than the player. The picture size button cycles Fit → Fill → Stretch → 100 % → Fit (its icon shows the current size, the tooltip names the next one) and so does `Z`; ⚙ › **Picture size ›** picks one and has a zoom row (− value + Reset). Ctrl+wheel zoom works in every size. The setting `pictureSize` chooses the size for new tabs; the button and `Z` change the current tab only. Native ffmpeg frames follow the picture (a crop or 100 % gets larger frames).
- **Jump sizes** (VS Code's Settings, `jump.arrow` / `jump.shift` / `jump.ctrl`): what ← →, Shift+← → and Ctrl+← → (Cmd on macOS) jump: 1 frame, 1 s, 5 s, 10 s or 30 s
  each (defaults 5 s, 1 s, 1 frame). `,` and `.` always step one frame.
- No status pill: when decoding falls behind, a notice says so once, with its action (set up ffmpeg, or
  skip frames / show every frame).
- Colours follow the VS Code theme (light, dark and high contrast).
