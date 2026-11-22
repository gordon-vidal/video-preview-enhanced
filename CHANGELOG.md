# Changelog

## Unreleased

- Fixed: running the extension from a development checkout no longer warns about other worktrees as installed versions.

- New: a **Compare** button in the player's bar. It asks before starting Compare with the video; with a Compare open it reads **Add to Compare** and adds the video directly.
- New: a **Stop** button in Compare's Add Mode hint.
- Changed: the Explorer menu and player title show **Start Compare** or **Add to Compare** based on whether a Compare is open.
- Changed: the CC button shows only when the video has subtitles. ⚙ › **Subtitles** is always there to load a file.
- Changed: the player and Compare bar icons share one size, stroke and alignment.
- Changed: open **Keyboard shortcuts** from ⚙ Settings in the player and Compare, or press `?`.
- Fixed: speed and volume sliders in the player and Compare keep tracking when dragged off the webview.
- New: reorder Compare tiles by dragging in **Reorder** mode or using each tile's up and down arrows.
- Changed: **Add to Compare** works on videos, folders and mixed selections. Add Mode (click videos in the Explorer to add them) stays on through playback and scrubbing.
- Changed: **Add Mode** turns on only when you ask to add more: Shift+D, **Add video…**, or right-clicking one video to start a Compare. A Compare that starts from several videos at once (a drag and drop from the Explorer, Open With… on a selection, a multi-selection or folder in **Add to Compare**, **Compare Videos in Folder**, the D quick pick) now opens with Add Mode off.
- Changed: several videos dropped on the editor or opened together reach one Compare faster: the videos are taken in about a tenth of a second (was 0.4 s), their players no longer start while Compare opens, and a tile that is slower than the clock no longer decodes its first picture twice. Measured from the first open to a picture in every tile (medians of 9 runs, 1080p clips on the development machine): 1.1 s for 2 videos (was 1.4 s), 0.9 s for 5 (was 1.4 s) and 1.1 s for 8 (was 2.1 s). A single video opens as before.
- Fixed: in a Compare grid with letterboxed pictures the tile's move up/down arrows sat in the black bar at the bottom of the cell; they now sit in the corner of their own picture.

## 0.8.1 (2026-11-22)

Compare grows to 8 videos by default (up to 16), Live transcode inside Compare, and exact full-resolution frames for copy, save, inspector and scopes while Live transcode is on.

- Changed: Compare supports 8 videos by default and up to 16 through `compare.maxVideos`. Grids of 5 or more stack the name and offset controls to fit smaller tiles.
- New: with **Live transcode** active, **Copy Frame**, **Save Frame as PNG**, the **Pixel Inspector** and the **Scopes** now use one exact, full-resolution frame of the file (decoded on the host by ffmpeg, sent as a PNG: local, WSL and Remote-SSH) instead of the transcoded picture, without leaving Live transcode. The inspector and scopes fetch it once per paused frame; if it can't be fetched the tool falls back to the transcoded picture with a notice.
- New: **Live transcode in Compare** — Compare can use Live transcode at each tile's size, share a max video bitrate across tiles (`videoPreviewEnhanced.transcodeSplitBitrate`), and show each tile's active encoder + **Use original video** in About.

## 0.8.0 (2026-11-21)

Live transcode for smooth 4K60 and remote playback, faster Explorer compare workflows (Add Mode, Open Together, Compare Videos in Folder), wheel step-back fixes, and a refreshed extension icon.

- New: **Live transcode** (`videoPreviewEnhanced.transcode` and `videoPreviewEnhanced.transcodeMaxBitrate`, replacing `remoteStream`) unifies local high-rate playback (such as 4K60) and remote streaming (SSH, WSL, containers, tunnels) into one H.264 → WebCodecs stream engine with hardware-first, software-last GPU decode and encode, a strict max bitrate cap, ⚙ › Live transcode controls, pipeline details + **Use original video** in ⓘ, and driver-aware managed ffmpeg line selection for NVIDIA GPUs (ADR 0002).
- New: **add videos to a compare by clicking them in the Explorer.** Press **Shift+D** in the player (or ⚙ › Tools › **Compare**, or **Add video…** in compare), then click a video in the Explorer. From a player one click opens compare in the player's tab and ends the mode; in compare it stays on until Esc, Shift+D again or the maximum (4; `compare.maxVideos`). The D quick pick has the same as a row. The file dialog stays under **Compare With…** and **Browse…**.
- New: **several videos selected in the Explorer and opened together** (right-click › Open With… › Video Preview Enhanced, Enter, double-click) open in **one compare** instead of separate tabs, and a preview tab of one of those videos is closed instead of left beside it. A short notice explains it the first time. Videos opened apart are not affected. Turn it off with `compare.openTogether`.
- New: right-click a folder › **Compare Videos in Folder** compares the videos directly in it (natural name order, up to `compare.maxVideos`).
- Changed: Explorer menu cleaned up. **Compare / Play Together** is now **Compare Videos**; the single-video **Compare With…** is no longer in the Explorer menu (it stays in the player's right-click menu and editor title); **Play Image Sequence** is in the Command Palette only.
- Changed: refreshed extension icon.
- Remote streams use compressed Opus sound when available, with s16 PCM as a fallback, so slow connections can keep the picture and sound playing. Remote pictures also follow the player size.
- New (experimental): setting `videoPreviewEnhanced.compare.maxVideos` (default 4, up to 16) lets compare play more videos at once, in a plain grid (3×2, 3×3, 4×3, 4×4). From 5 videos on, all tiles share one renderer and the memory and transfer budgets of 4, and native ffmpeg tiles use WebSocket channels. 2–4 videos are unchanged. With ffmpeg on the test PC, 9 and 16 1080p HEVC videos each play at about 24 fps (measured 23.5-24.0). How more than 4 videos get into compare, and free placement of tiles, come later.
- Fixed: Fit now enlarges a small video as far as the panel allows, keeping its shape (like mpv or VLC), also in the player; before, a 640x360 clip stayed small in a large panel. 100 % is unchanged (pixel for pixel).
- Fixed: in compare, a drag to pan a zoomed picture did nothing when it started on a video's name pill or offset buttons; it now pans (a click on them still opens them).
- Fixed: in compare, a zoomed picture could not be dragged from a video that fits its cell (for example a smaller or differently shaped one) while another video was zoomed past its own; every tile can start the drag now.
- Fixed: notification buttons that stop future prompts now all say "Don't Show Again".
- Fixed: stale texts in settings (`whenSlow`, `advancedMode`) and the FAQ.
- Fixed: closing a web video that is still downloading (server without range support) left pending reads hanging; closing now cancels the requests and settles them.
- Fixed: when the decoder cannot start (for example no WebGL2), the message no longer sits on an empty black or white box; it shows on the plain stage in the theme colours, readable in the high-contrast themes.
- Fixed: stepping back with the mouse wheel (or the arrow keys) while paused on heavy video such as 4K HEVC 10-bit or HDR lost steps: notches that came while the previous step back was still decoding started again from the frame on screen, so ten quick notches moved one or two frames. Every notch now counts and lands on exactly the frame it should, with the built-in decoder and with ffmpeg. Steps back are also much faster with the built-in decoder: the frames decoded on the way to a step (and those a step forward passes) stay in memory, so the next steps back show at once instead of decoding from the keyframe again (4K HEVC 10-bit: about 5-6 s per step back near the end of a 2 s keyframe interval before).

## 0.7.2 (2026-11-20)

Picture size and zoom, a faster way to start a compare, and frame-count fixes.

- New: **picture size.** A button beside the keyboard shortcuts (and the **Z** key) cycles Fit, Fill (no bars, edges cropped), Stretch and 100 % (one video pixel per screen pixel, drag to move); ⚙ › Picture size picks one and zooms; Ctrl+wheel zoom works in every size. In compare every video follows together, with zoom and pan in lockstep. Setting `videoPreviewEnhanced.pictureSize` for new tabs. Z used to jump straight to 100 %: it now cycles, and goes back to Fit first when zoomed in.
- New: start a compare faster. Press **D** in the player for a quick pick of other videos (same folder first, then the workspace, recently compared first, **Browse…** for the open dialog), or hold **Shift** and drop a video from the Explorer onto the player.
- Fixed: the frame count is known right after opening an MP4/MOV (from the container), so End works at once; short files without a frame rate in the container (10-frame MXF) now get one from their timestamps, so the frame counter and stepping work.
- Removed picture-in-picture for now (it was not working): the bar button and the `P` key are gone. `Shift+P` still opens the previous video in the folder.

## 0.7.1 (2026-11-20)

First release on the VS Code Marketplace (publisher `gordon-vidal`).

- Fixed: in Compare, the tile labels show each video's frame number while paused.
- Fixed (Linux): ffmpeg processes stop reliably when a video pauses, its tab is hidden or a loop restarts; no leftover ffmpeg keeps running.
- New Marketplace and GitHub page with a short tour GIF; the full reference (keys, settings, formats, remote, ffmpeg, FAQ) moved to the `docs/` folder on GitHub.

## 0.7.0 (2026-11-20)

The UI overhaul release: a new player, panels for everything, previews on the seek bar, less CPU on 4K, and a smoother first start.

### New player
- **One clean player.** Previous frame, play/pause, next frame, mute and volume, the time (click for SMPTE timecode or the frame number), CC, ⓘ, speed, ⚙, keyboard shortcuts, picture-in-picture and fullscreen, drawn with icons in your theme's colours (light, dark, high contrast). The simple / advanced switch is gone: the tools and their keys always work (`advancedMode` is deprecated and ignored).
- **⚙ panel:** Speed, Loop, A-B loop, Subtitles, Audio track, Copy frame, Keyboard shortcuts, Jump sizes, a Tools grid (Compare, Scopes, Inspector, Stats, Codec X-ray, Export A-B), Open video URL…, and Extension settings.
- **ⓘ About this video (`I`):** size, length, resolution with a 4K / 1080p label, frame rate, HDR and bit depth, codecs in plain words with bit rates, sound, tracks, and what plays the file; Copy details; technical overlay under Full technical details.
- **Speed 0.25×-4×** in steps of 0.05 with the pitch kept; a compact speed panel; Shift+< / Shift+> and the wheel change it by 0.05.
- **Jump sizes:** ← →, Shift+← → and Ctrl+← → (Cmd on macOS) each jump 1 frame, 1 s, 5 s, 10 s or 30 s (defaults 5 s, 1 s, 1 frame); settings `jump.arrow` / `jump.shift` / `jump.ctrl`. **New:** setting `videoPreviewEnhanced.stepButtons` (`frame` by default, or `jump`) makes the two buttons beside Play jump by the Ctrl+arrow size instead of one frame; also a choice in ⚙ › Jump sizes. The tooltips say what they do.
- **Keyboard shortcuts sheet (`?`),** CC that turns subtitles on and off (`C`; copy frame is `Ctrl+C`), a streamlined right-click menu with A-B loop items, dragging that continues outside the seek bar and volume, no status pill (a notice appears once when decoding falls behind).
- Keys VS Code itself uses while a video has focus are avoided.

### Compare looks and works like the player
- **The approved compare mock-up.** One bar drives all videos (play, lockstep frame steps, seek, speed, loop, jumps); the time and seek bar follow the clock video, shown with its letter; mute and volume act on the sound video; CC and picture-in-picture are hidden. The bar's new Compare button opens the **Compare panel**: a row per video with its page (offset − / + in frames or ms with Reset, Clock and Sound switches, Replace video…, Remove), Add video… (up to 4), View Side by side | Split and Swap sides for 2 videos, Leave compare.
- **Clean tiles:** each video keeps its own shape in its cell; hover shows the name, the video's own frame number and a ‹ offset › nudge; `−` / `+` nudge the video under the pointer; right-click a video for its actions. 2 videos: side by side or split with a draggable divider (the toggle view is gone); 3 in a 2×2 grid with an "Add video" cell; 4 in 2×2.
- **Entering and leaving:** ⚙ › Tools › Compare, or the player's right-click **Compare With…** (new), pick 1–3 videos in VS Code's open dialog: compare takes the player's tab and starts at its position. **Leave compare** puts the player back in the tab at the kept video's moment. Explorer's Compare / Play Together is unchanged.
- The old compare toolbar, Sync panel and keys (`S`, `1`–`3`, `T`, `N`, `I` for metrics, `Z`) are gone; `I` is About these videos (a tab per video), Ctrl+C copies the view.
- PSNR / SSIM and find-first-difference are hidden for now (kept in the code for a later advanced mode).

### Seek-bar previews on hover
- Hover or drag the seek bar for a picture of that moment (built-in decoder and native ffmpeg). Pictures are decoded only while the pointer is on the bar, never in the background after a video opens, at below-normal priority and 2 threads.

### Opening videos
- **Default viewer is automatic:** on first start MP4 and WebM open in this player without a popup (unless you chose another editor); undo is a command.
- **File icons:** .mkv, .flv, .mpeg, .m2ts, .wmv, .3gp, .m4v, .vob, .divx, .asf, .mxf, .y4m get the video icon of Seti, VS Code's default icon theme (setting `overrideFileIcons`, on by default). The extension now loads at startup (`onStartupFinished`) for this.
- **Open video URL…** (Command Palette or the ⚙ panel): http(s) links, HLS and DASH. Direct files and HLS VOD play without ffmpeg; live or encrypted HLS and DASH need ffmpeg. ffmpeg gets network protocols only for a URL you typed.
- **More from video URLs:** **Open Video URL to the Side…** and **…in New Window…**; a **Quality** page in ⚙ for HLS streams (Auto picks the smallest picture that fills the player within the measured download rate; a pick reopens the stream at the same moment); HLS **WebVTT subtitles** in the CC menu; **AES-128 HLS** plays without ffmpeg (decrypted in the extension; the key never reaches the page or the log). DRM streams say "This stream is protected".

### HDR
- **HDR output on HDR displays:** HDR10, HLG, HDR10+ and Dolby Vision profile 8 are drawn in HDR through WebGPU when the display and VS Code allow it; otherwise tone-mapped to SDR as before. Setting `hdrOutput` (`auto`, `off`). Dolby Vision profile 5 shows a message instead of wrong colours. Not yet seen on a real HDR screen.

### ffmpeg and speed
- **ffmpeg setup flow:** the first video of a session recommends ffmpeg ("works best with ffmpeg": Set up ffmpeg / Not now / Don't remind me). Setup looks for an installed ffmpeg first (PATH, winget, Chocolatey, Scoop, Homebrew, ...) and only then offers a checksum-verified portable download. Remote (SSH, containers; Linux x64/arm64) windows can download ffmpeg on the remote.
- **GPU method from the GPU's maker** (NVIDIA CUDA, Intel Quick Sync, other D3D11VA), with fallback to auto and then the CPU, and **frames sized to the picture** (setting `sizeFramesToView`, on by default; the size is also remembered across sessions, so the first 4K video of a session needs no restart of ffmpeg). 4K HEVC 10-bit: about 3.7 cores down to 1 at 30 fps on an i7-9700K + RTX 4070.
- **GPU test offer:** nothing decodes on its own after install or setup. When a video plays slower than real time and no test has run, one notification offers the 20-second test (Run test / Not now / Don't remind me, once per session).
- **Priority:** background ffmpeg (thumbnails, probes) runs at below-normal priority.
- Native ffmpeg starts earlier for more formats; seeks and the first frame are right when sound starts before the picture (HLS, DASH, MPEG-TS).

### Remote and security
- Slow remote links: the quality steps count the sound, ignore start-up waits, floor at 360p with a notice.
- Security review fixes (text manifests refused before ffprobe, safer command quoting, Restricted Mode, message checks); accessibility pass (names, states, live region, focus, contrast).

### Docs
- README top rewritten (new listing copy); README, settings and commands tables brought up to date; new screenshots.

## 0.6.1 (internal, 2026-11-19)

- Short clips (up to 5 s) loop smoothly at full frame rate with the built-in decoders.
- Native ffmpeg starts sooner for simple HEVC MP4/MOV files (first 4K frame ~50-80 ms earlier).
- The WebAssembly decoder no longer downloads and starts when native ffmpeg or the remote stream plays the file.
- ffprobe no longer runs for background tabs or files it can't help with, and stops when the tab closes.
- Multi-view: tiles share the native frame queue, resize to the same moment, and honour actual-size zoom.
- Fixed: stepping back in a paused remote stream restarted ffmpeg after a long pause.
- Compare: switching or removing the clock tile keeps the other tiles in sync; a resize no longer cancels a seek; closing or reloading a compare view releases its players and ignores late reads.

## 0.6.0 (internal, 2026-11-19)

### Start-up time and memory on smaller machines

- **Memory budgets follow the machine:** the decoded-picture cache (what the player decodes ahead, and the "Fully decoded" cache when paused), the decoder pool's picture budget, batch size and number of extra WebAssembly workers, the file-block cache, each worker's reusable frame buffers, the seek-bar thumbnails and the native frames queued in the extension host are sized from `os.totalmem()` (less when little of it is free). A 32 GB machine keeps the old sizes; 8 GB gets 160 MB of pictures ahead (was 400), a 240 MB pool (was 600) and 3 extra workers (was 6). Remote windows size from the local `navigator.deviceMemory`. Measured in a real VS Code, 4K HEVC 10-bit in the built-in decoder as an 8 GB machine: the player's webview peaks at ~0.99 GB instead of ~1.56–1.65 GB. Details: `docs/notes/startup-memory.md`.
- **Faster start:** the decoder's files start downloading from the page's head and the WebAssembly decoder starts while the extension decides how to play the file; ffmpeg's lookup and ffprobe run while the webview loads instead of after it; the first picture is decoded on its own instead of in a batch of ~6. Measured (session to first frame, warm): WebAssembly HEVC 1080p ~410 → ~325 ms, the native path's host decision 50–140 → 1–25 ms. Start-up is now mostly VS Code's own (opening the editor and webview) and, for native 4K, ffmpeg's start (320–450 ms).
- **Native ffmpeg starts while the editor's page loads:** as soon as ffprobe has chosen native ffmpeg, it is started at the local connection's frame size and its first frames wait in the extension host until the page is ready; restarted at the message size only when the connection falls back, and stopped when the page ends on another decoder, the tab closes, the file changes or nothing asks for it within 15 s. Measured (4K HEVC 10-bit, session to first frame): cold 724 → 664 ms, warm 668 → 630 ms (medians of three runs). Fix with it: a file rewritten between page loads (e.g. an MJPEG AVI rewritten as MPEG-4) was decided from the old file's ffprobe (review 2026-11-19-3 M1); the early probe is now used only for the same file size and date and dropped on reloads. Test: `test/host/native_early_test.js`.
- Tests: `test/host/membudget_test.js`; `test/vscode/cases/startup.js` (start-up phases per decoder path, cold and warm, and memory with `VPE_TOTALMEM`, a test-only override); with `VPE_LOG` the extension and the page log a `startup` timeline.

### Remote stream (Remote-SSH, containers, tunnels)

- **On by default:** new setting `videoPreviewEnhanced.remoteStream` (`auto` | `off` | `on`, machine-scoped, so a workspace's settings can't switch it). `auto`: in a remote window, a file VS Code's GPU decoder can't play (anything but 8-bit H.264 and VP8) is re-encoded by ffmpeg on the remote machine as a low-latency H.264 stream and decoded by WebCodecs in the editor, when native ffmpeg can't play it there directly (WSL keeps native ffmpeg). Needs ffmpeg on the remote (`ffmpegPath` in the remote's settings, or PATH); without it, the built-in decoder as before. `decoder: builtin`, files native ffmpeg failed on and pixel tools still use the built-in decoder. `off`: the built-in decoder in remote windows; `on`: every window (tests).
- **The remote's GPU encoder:** NVENC, Quick Sync, AMF or VAAPI (each render node) when ffmpeg has it and it encodes a few test frames with the stream's own settings; else libx264 (ultrafast, zerolatency). Tested once per host and ffmpeg build, remembered; a GPU encoder that fails mid-stream switches that host to libx264 and the clip goes on from the next frame. The log says what was tried and why it failed (e.g. "Driver does not support the required nvenc API version").
- **Seeking:** a seek inside what was already read (the last 5 s sent, and from 1.5 s before the last seek target, since a paused player reads ahead; up to 0.5 s ahead) is served from memory, from the keyframe before it, without restarting ffmpeg; a short seek back starts the new stream 1 s early, so further frame steps back come from memory too. A burst of seeks (dragging the seek bar, held keys) starts ffmpeg once, then at most every 200 ms (25 seeks in 0.6 s: 3 starts). The seek bar waits for each seek's frame (up to 1.5 s, by how long the last one took) before the next, so frames show while dragging instead of every restart being cut off.
- **Sound and picture in sync from the stream's timestamps:** sound is resampled to its timestamps (`aresample=async=1:first_pts=0`), so a sound track that starts after the picture, or has gaps, no longer plays early: before, a track starting 0.3 s late played 300 ms early for the whole file, and a 0.5 s gap shifted everything after it. Measured on 200 s clips with a flash and a beep every 10 s (late sound, late picture, a gap, 25 and 29.97 fps, from the start and after a seek): within one frame everywhere, no drift. Sound is sent at most 2 s ahead of the picture (before, ffmpeg's sound could run tens of seconds ahead into the editor's memory).
- Fixes: a `seek`, `more` or start after the stream was closed no longer starts ffmpeg (review 2026-11-19 #5); old ffmpeg builds (before 5.1, e.g. Ubuntu 22.04's 4.4) get `-vsync` instead of `-fps_mode`.
- Tests: `test/host/remotestream_test.js` (sync, seeks from memory, scrubbing, dispose, encoder probe and fallback, with a real ffmpeg); `test/host/native_choice_test.js` (WSL native, SSH and containers stream, `off` stays built-in); `test/vscode/cases/remote_stream.js` (scrubbing, steps back, a long-playback case); `test/vscode/remote_ssh.js --mode default|off|auto|on --seeks --long N` (the setting now goes into the remote's Machine settings).

### Faster native frames: a local connection instead of messages

- **Native ffmpeg frames no longer go through VS Code's messages in local windows.** The extension host serves them on `127.0.0.1` (a random port, a secret 256-bit path per video, only VS Code webview origins accepted) and the player reads them with a streaming `fetch` straight into frame buffers that it reuses. Measured in a real VS Code 1.147 (i7-9700K, RTX 4070, busy machine): 430–890 MB/s into the webview against 385–467 MB/s for messages, and the extension host spends ~0–4 % of its time sending frames instead of ~50–75 % at 4K (65 % at 1080p60). Details and numbers: `docs/notes/native-transfer.md`.
- **4K at full resolution by default:** `videoPreviewEnhanced.nativeMaxHeight` is now `0` (automatic): over the local connection, full resolution up to 2160p when the frame rate fits what it carries (~400 MB/s while playing: 4K up to ~30 fps in full, 4K at 50/60 fps at 1440p), 1080p by messages (720p in WSL). A number still fixes the height. 4K HEVC 10-bit 30 fps plays at 30 fps at 3840×2160 (was scaled to 1080p; by messages 4K reached 21–28 fps).
- **Automatic fallback:** when the server can't start, the player can't connect within 3 s, or the connection drops, frames go by messages again (at 1080p when automatic); a drop mid-play re-seeks to the current frame. Remote windows (SSH, containers, WSL) keep the existing paths.
- Host side: frames are kept as the pipe's chunks and written to the socket as they are (no per-frame copy or zero-fill); messages join them once.
- Host side: socket backpressure on top of the player's credits (a player reading slower than ffmpeg decodes no longer queues frames in the extension host).
- **Multi-view tiles use the local connection too:** each native tile has its own channel and gets frames at its real on-screen size, re-sized when the panel grows (fullscreen, resize), within one shared budget (the message link's when any tile falls back).
- Not yet: 4K at 60 fps in full is limited by the webview taking ~400–470 MB/s while it also uploads and draws (30–37 fps measured), so it plays at 1440p.
- Tests: `test/host/frameserver_test.js`; `test/vscode/cases/native_transfer.js` in a real VS Code (4K over the local connection; the fallback when it is refused); with `VPE_TRANSFER_BENCH=1` the raw transfer bench and long-clip playback per transport.

### Fixes

- **Multi-view:** a reload while tiles were still being probed could start a second ffmpeg per tile that never stopped; the PSNR/SSIM readout on scaled ffmpeg tiles now says "approximate" and a click switches to full resolution; offsets in ms keep their fractions (frames ↔ ms is lossless at 23.976/29.97) and frame offsets are redone when the real frame rate is known; the grid could stay unlaid-out (300×150) in a long session; tiles share the machine's memory budget.
- **Scopes and pixel tools** use the video's own colour matrix tag (HD video below 1280×720 was read as BT.601, up to 22 luma codes off); untagged video still guesses from the size.
- **Export** after the player was hidden and shown again no longer loses a frame.
- **Simple/advanced mode** follows the setting, also in tabs VS Code restores; the button writes where the setting lives.
- **"Use built-in decoder"** in the first-open question: no slow-decoding reminder for 30 days.
- **Native ffmpeg:** a dropped local connection resumes at the pending seek and at the message size; an ffmpeg that can't start falls back instead of failing the extension host; channels accept only their own editor page and one reader.
- **Remote stream:** sound is decoded by its own ffmpeg (bounded memory; a GPU→CPU encoder switch keeps the sound); a failed encode no longer disables the GPU encoder for good; an ffmpeg killed by the system is a failure, not the end of the file; host and player agree on the frame a seek lands on.
- **macOS:** memory budgets come from the total memory (macOS doesn't count its file cache as free).

### Tests

- The Edge/Playwright harness (`test/browser/`) is gone: its checks run as real-VS-Code cases in `test/vscode/cases/` (seeking, playback, subtitles, scopes and export, inspector and HDR, compare metrics), with self-made media (`test/media/make_cases_media.js`). Playwright is no longer a dependency.

## 0.5.0 (internal, 2026-11-19)

### Simple and advanced mode

- **Simple mode is the default:** the bar has play/pause, seek (with thumbnails), volume, speed, subtitles and tracks, frame step and fullscreen. Nothing else.
- **Advanced mode:** the **Advanced** button on the bar (setting `videoPreviewEnhanced.advancedMode`, command **Toggle Advanced Mode**) adds a **⋯ Tools** menu: compare, scopes, pixel inspector, zoom, X-ray, stats, details, go to frame, chapters, A-B loop and export, ffmpeg command, frame save/copy/link, picture-in-picture, loop. Each row shows its key.
- **Tool keys are ignored in simple mode** (`X`, `Z`, `W`, `I`, `S`, `C`, `A`, `B`, `{`, `}`, PageUp/PageDown, `Ctrl+G`, and their Shift forms); transport, volume, speed, subtitle and fullscreen keys work in both modes. Switching back to simple closes open scopes, inspector, X-ray, stats, details and zoom.
- **Compare: the difference view is removed** (view `4`, gain, luma-only and heatmap, keys `G`, `Y`, `H`). Side by side, wipe and toggle remain; PSNR/SSIM and **Find diff** do not depend on it and stay.
- Loop, save frame, zoom, details, picture-in-picture and open-in-system-player moved from the bar into the Tools menu.

### Multi-view (compare)

- **Up to 4 videos:** select 2–4 videos in the Explorer → **Compare / Play Together** (was "Compare Videos", 2 only), or **＋ Add video…** in the open panel. 2 videos keep side by side, wipe and toggle; 3–4 show in a 2×2 grid (an empty fourth tile adds a video).
- **Sync panel** (`S` or **Sync** on the bar): per video an offset in frames (of that video) or in milliseconds, which video is the clock (frame steps and the seek bar follow it; the first by default) and which one plays the sound (one at a time; the first by default). Replaces the bar's B offset; `-` / `+` change the selected row.
- **Lockstep for every tile:** a paused step moves the clock one frame and shows the view only once every tile shows its frame for that moment plus its offset. Play, pause, seek and speed apply to all.
- **Native ffmpeg in compare:** each tile follows the player's decoder rule; native tiles get frames at the tile's size (capped by `nativeMaxHeight`), so 4 tiles stay under the host → panel transfer limit. Before, compare always used the built-in decoder.
- PSNR/SSIM and **Find diff** stay, for 2 videos.
- Tests: `test/vscode/cases/multiview.js` in a real VS Code (3 then 4 clips in the grid, all playing; frame and ms offsets after paused steps; clock and sound; 2 clips' views; a native-ffmpeg grid at tile size).

### Decoders and onboarding

- **New decoder rule:** with ffmpeg installed, native ffmpeg plays everything except 8-bit H.264 and VP8, which stay on VS Code's GPU decoder (WebCodecs). WSL windows now use native ffmpeg with `decoder: auto` too (at up to 720p); SSH and containers stay on the built-in decoder.
- **The GPU test only picks ffmpeg's method** (d3d11va, qsv, cuda, …). The "not tested yet" guesses and the native-versus-built-in speed comparison are gone; before the test has run, ffmpeg picks its own method (`-hwaccel auto`).
- **First-open popup:** the first time a video opens without ffmpeg, a notification offers **Set up ffmpeg (recommended)** or **Use built-in decoder**. Asked once; never in SSH, container or Restricted Mode windows.
- **"Falling behind" reminder with measured numbers:** the guessed gain table is replaced by measurements of ffmpeg (CPU and GPU) against the built-in decoder per codec and size, on an i7-9700K / RTX 4070 desktop. Real time is only promised when the CPU number alone gets there; formats that weren't measured get no number.
- Tests: `test/host/onboarding_test.js`, and `test/vscode/cases/onboarding.js` in a real VS Code (the decision lines with ffmpeg, the popup once, the reminder for 4K HEVC 10-bit). A case module may export several cases.

### Listing and release prep

- **Display name** is now `Video Preview Enhanced` (the format list moved to the description and keywords; reasons and search research in `docs/notes/marketplace-seo.md`). New description, 29 keywords, `qna` off.
- **Icon:** `media/icon.png` (256 px, from `media/icon.svg`; a 128 px copy is kept next to it).
- **Marketplace page** (`LISTING.md`) and the README intro rewritten around the three decoders: GPU for H.264 and VP8 in any container (checked in real VS Code 1.147 for MP4, MKV, MOV, M2TS/MTS, FLV, AVI, WebM), built-in WebAssembly for the rest, optional ffmpeg for heavy 4K.
- **Numbers** in the README and the listing now come only from real VS Code runs; the "How it compares" table no longer claims real-time 4K HEVC/AV1/VP9 without ffmpeg.
- **Screenshots** from a real VS Code window on the hidden desktop: `test/vscode/screenshot.js` (PrintWindow, no visible window).
- `docs/RELEASING.md`: internal draft release and the later public steps (Marketplace, Open VSX).

### Remote SSH stream (preview, off by default)

- **`videoPreviewEnhanced.remoteStream`** (`off` by default; `auto` for SSH/container windows): ffmpeg on the remote machine decodes the file and sends a low-latency H.264 stream (libx264 `ultrafast`/`zerolatency`) that the panel decodes on the GPU; sound arrives as PCM. Measured in real VS Code over Remote-SSH (WSL target): 4K HEVC 10-bit **7.5 → 29 fps** at about 5 Mb/s. Notes and what is left: `docs/notes/remote-stream.md`.
- Tests: `test/vscode/cases/remote_stream.js`, `test/vscode/remote_ssh.js`.

## 0.4.0 (not released yet)


### Playback

- **Decoder pool:** several WebAssembly decoders, each on its own stretch of the video between keyframes, so software decoding uses more than one CPU core. On an 8-core CPU, ProRes 422 HQ now plays at 30 fps in 1080p (was 22–23) and in 4K (was about 9.5).
- **Faster WebAssembly decoder:** a new build with WebAssembly SIMD decodes about 16 % faster on average (AV1 30–58 %, H.264 and MPEG-4 18–31 %, HEVC 9–15 %). Decoded frames are copied once into reused GPU textures, and when decoding falls behind, frames nothing refers to are skipped first.
- **10-bit and 4:2:2/4:4:4 colour conversion on the GPU,** in the WebGL shader instead of in WebAssembly. 1080p 10-bit HEVC at high bitrates now plays in real time.
- **When decoding is behind, every frame is shown** and playback slows down. 4K HEVC 10-bit went from 1.5 to 13–18 fps. A status pill shows the decode speed, how much is decoded ahead, and "Fully decoded"; click it to skip to keyframes instead.
- **Sound at other speeds:** pitch-preserving time-stretch from 0.25× to 4×.
- **Subtitles:** SRT, WebVTT and ASS/SSA files. Sidecar files load by themselves (`video.srt`, `video.en.srt`, `video.eng.forced.srt`, `Subs/` folders); **Load Subtitles…** opens any other. A CC menu, delay (`G` / `H`), size, and any text encoding. Subtitle tracks inside the file: text, and picture-based PGS, DVB and DVD, placed on the video (also when zoomed) and cleared at their end, also after seeks.
- **Seek-bar thumbnails** from a separate, keyframe-only decoder that doesn't slow playback.
- **A-B loop** (`A` / `B`), **resume** at the last position, **picture-in-picture** (`P`).
- **Next / previous video in the folder** (`Shift+N` / `Shift+P`), in the same tab.
- **Fill the editor** (`F`) also switches VS Code to zen mode. The screen stays awake while playing.
- **Phone videos play upright:** MP4/MOV rotation metadata is applied, also with native ffmpeg.
- **HDR10 and HLG tone-mapped to SDR** on the GPU: PQ/HLG to linear light, BT.2020 to BT.709 primaries, BT.2390 tone curve (203 nits = SDR white). HDR badge in the info and stats overlays.
- **Default viewer offer:** after the first video, the extension asks once whether to open MP4 and WebM too. Two commands switch this on and off.

### Developer tools

- **Codec X-ray** (`Shift+X`): a strip with one bar per frame (compressed size, I/P/B type) and a bitrate line, from a demux-only index that doesn't decode. Chapter ticks on the seek bar. Keyframe steps (`{` / `}`) and chapter steps (PageUp / PageDown).
- **Zoom and pan** (Ctrl+wheel), nearest-neighbour pixels and a pixel grid (`Shift+Z`).
- **Pixel inspector** (`X`): RGB and the source Y/U/V values under the cursor, with a loupe; also on paused GPU-decoded frames.
- **Go to a frame or time** (`Ctrl+G`, or click the frame number): frame numbers, times, percentages and relative steps.
- **Frame links:** `Shift+C` copies a `vscode://` link that opens the file paused on that frame. Markdown links can use `#t=` and `#frame=`.
- **Stats overlay** (`Shift+I`): decoder, pixel format, shown fps, dropped and late frames, decode speed, queue, audio clock, cache.
- **Scopes** (`W`): luma waveform, RGB parade, vectorscope with 75 % targets, and histogram of the frame on screen, sampled on the GPU at 256 columns; ~10 updates/s while playing, at once when stepping.
- **Frame-range export:** **Export Frames (A–B)…** saves every frame of the A-B loop as PNG (`<video>_f000123.png`) into a chosen folder, remote folders included, with progress and cancel. **Copy ffmpeg Command for A–B** copies an exact (re-encode) or fast (`-c copy`) cut.
- **Compare two videos:** side by side, wipe, toggle and difference views on one transport; PSNR (Y and RGB) and SSIM (Y) that match ffmpeg's filters; a background search for the first frame below a PSNR threshold; a frame offset for B. Works with remote files.

### Optional ffmpeg

- **Used whenever it helps:** with `decoder: auto`, native ffmpeg plays every video it decodes in real time on this machine, in local windows. Remote windows (SSH, WSL, containers), files native ffmpeg failed on, and formats the built-in decoder was measured faster for stay on the built-in decoder.
- **Tested on your machine:** after setup, and when the ffmpeg build or GPU driver changes, short bundled clips (H.264, HEVC 8/10-bit, AV1, VP9 at 1080p and 4K, ProRes) run through the playback pipeline with each GPU method in a fixed order (Windows: d3d11va, qsv, cuda, dxva2; Linux: vaapi, cuda; macOS: videotoolbox; then CPU). Silent CPU fallback and wrong pictures (broken drivers) are detected; playback then uses the method found best per format instead of `-hwaccel auto`. The test takes about 15–35 s (was 1.5–2 min): each method decodes all clips of a size in one ffmpeg run, and clips repeat without seeking (qsv measured at a third of its real speed when looped). Estimates for a file scale CPU speeds by its bit rate (the clips are light; a 12 Mb/s 4K file decodes about 3× slower in software), and a later method must be 1.3× faster to replace an earlier one, so the choice doesn't flip between tests. New command **Re-test ffmpeg**.
- **Per-machine speeds:** the built-in decoder's speed is recorded per codec, bit depth and size while you watch, and used in that choice. When it stays below real time and there's no ffmpeg, a notification suggests the setup once (Set up / Not now / Don't ask again).
- **Setup without admin rights:** the recommended download is now BtbN's LGPL build (about 77 MB on Windows; decodes the same as the GPL one), with only ffmpeg, ffprobe and their DLLs kept. NVIDIA driver versions no longer pick an older build. **Use an ffmpeg I already have** takes `ffmpeg.exe`, a build folder or a downloaded `.zip`/`.7z`. Downloads honour `http.proxy`, `HTTPS_PROXY` and `http.proxyStrictSSL`; a blocked download offers the local option.
- **4K plays in real time natively in VS Code:** frames now go to the editor at 1080p (`nativeMaxHeight`, was 1440p). Measured in a real VS Code 1.146 on an Intel Core Ultra 7 165U laptop with other programs using 85 % of the CPU: 4K HEVC and AV1 10-bit went from 5.5–16 to 29–30 fps. Every frame is a VS Code message, and posting one costs the extension host about 5 ms per MB: 1440p frames (5.5 MB) topped out near 20 fps. The ffmpeg test now waits while a video plays natively (both ran at once on the first use, playback dropped to 6 fps, and the test's timings were too low), and the choice counts what sending the frames costs.
- **Exact pixels on demand:** native frames are scaled to 1080p and 8-bit; the pixel inspector, scopes, 1:1 zoom, frame save and A-B export offer **Use full resolution**, which switches the tab to the built-in decoder.
- **Fallback:** a GPU method that can't start a file is retried on the CPU; if ffmpeg can't play it at all, the built-in decoder takes over.

### Remote

- **Read-ahead over remote connections:** 4 MB blocks, 4 requested ahead, from a cache that several readers share.
- Files on `vscode-remote` are watched for changes. `git:` and other virtual documents are refused with a message, and the "open in system player" button is hidden on remote.

### Fixes and hardening

- **Security:** the webview can only load the extension's media folder. ffprobe and native ffmpeg only read local files (`-protocol_whitelist file`). The debug hook is environment-only and runs only allowlisted commands; the `debugLogFile` setting is gone, because a workspace could set it.
- **File reading:** one shared file handle, short reads trimmed, and every block or frame request answered, also when it can't be read.
- **AVI:** the index scan reads headers through 1 MB windows and skips the movie data unless it's MJPEG. MJPEG AVI sound is sent in 8 MB parts instead of one message of up to 512 MB.
- **Reloads** during opening no longer answer the new page with the old file.
- **Resume position** is stored on pause, seek, close and every 30 s, not every second.
- **ffmpeg setup:** installs beside the build in use, has timeouts, and can be cancelled.
- A paused seek past the last frame shows the last frame.
- Video packets without a timestamp no longer get a wrong one on the GPU path.
- **Clock without sound:** when the sound runs dry (or a track decodes to nothing) the clock no longer runs on past a frozen picture and jumps back 10+ s; it follows the timer and waits for the next frame. This was why 4K VVC with TrueHD 5.1 played silently.
- **2× with WebCodecs sound:** a browser's AAC decoder (Edge; VS Code itself decodes AAC in WebAssembly) can release sound only at about real time. The reader no longer pushes the whole file into it, and when it lags the built-in decoder takes over the sound without a gap.
- **Multichannel sound:** layouts WebAudio can't downmix (7.1, 6.1, 5.0, 3.0) are mixed to stereo, keeping the centre channel. TrueHD's 40-sample frames are joined into larger buffers instead of ~1200 sound sources a second.
- **Status pill** no longer shows decode speeds like "8666.7×" or "Infinity×" when frames arrive in bursts or stop coming.

### Packaging and docs

- **In VS Code the GPU decoder is H.264 (and VP8) only.** VS Code's webviews reject HEVC, VP9 and AV1 in WebCodecs, so those decode in WebAssembly (single-threaded per decoder: no SharedArrayBuffer in webviews), a few fps at 4K on a laptop. The optional ffmpeg (no admin rights, about 77 MB) plays them in real time. An attempt to route them to WebCodecs was dropped; see `docs/notes/webcodecs-hevc-vp9-av1.md`.
- Tests: `test/vscode/run.js` runs the extension in a real VS Code on a hidden desktop; the Edge harness applies VS Code's codec rules by default (`--codecs=browser` lifts them).
- Tests: the Edge/Playwright harness (`test/browser/`) is removed; its checks run in real VS Code (`test/vscode/cases/`: seeking, playback, subtitles, scopes_export, inspect, compare_metrics), see `docs/notes/test-migration.md`. The package has no npm dependencies any more.

- README rewritten: feature tour, codec table, measured performance, comparison with other VS Code video extensions, one keys table.
- New THIRD_PARTY_NOTICES.md with the LGPL notes for the bundled FFmpeg build. The build definition (`vpe-fragments.json`) now ships in the package.
- Licence holder renamed to "Video Preview Enhanced contributors" (still MIT).

## 0.3.0

- **Decode only, never convert.** All re-encoding is gone: no conversion, no cache files.
  - H.264 and VP8 decode on the GPU through VS Code's built-in decoder (WebCodecs).
  - Everything else is decoded by a bundled WebAssembly decoder: a custom decode-only libav.js build with FFmpeg 9.0.2 and dav1d, LGPL, 6.4 MB.
  - Frames are drawn with WebGL. Sound goes through WebAudio, which also drives the clock.
- **Formats with nothing installed:**
  - Containers: MP4, MOV, MKV, WebM, AVI, FLV, MPEG-TS, MPEG-PS/VOB, WMV/ASF, MXF, OGG.
  - Video: H.264, HEVC, AV1, VP8, VP9, MPEG-4/Xvid, WMV, VC-1, MPEG-1/2, ProRes, DNxHD, Theora and more.
  - Sound: AAC, MP3, AC-3/E-AC-3, DTS, Opus, Vorbis, FLAC, WMA, PCM and more.
- **Optional native ffmpeg** for what one WebAssembly thread can't play in real time: 4K, 10-bit 4:2:2, ProRes.
  - ffmpeg decodes on the GPU and sends raw frames, scaled to at most 1440p.
  - Setup downloads a build matched to the GPU driver, or uses the package manager or an existing ffmpeg.
  - Native decoding is used locally and in WSL only; never over SSH.
- **Exact frames:** accurate seeking (keyframe plus decode-forward) and stepping in both directions.
- **When decoding falls behind real time,** playback slows down instead of skipping.
- **Remote:** works over WSL and Remote-SSH. The host reads the file; the webview decodes.


## 0.2.0

- **Setup:** one command to set up conversion. It detects the GPU and driver and downloads an ffmpeg build whose NVENC works with that driver (or a QSV/AMF/VideoToolbox build), or the built-in decoder, or opens a terminal with the package-manager command.
- **Built-in decoder:** ffmpeg.wasm, downloaded on request and hash-checked. It runs sandboxed in a worker thread, reads the file straight from disk (no size limit), and streams its output.
- **GPU encoder self-test:** each encoder is tested once per ffmpeg version and driver, so playback only uses encoders that work. Windows Media Foundation was added as a GPU encoder that works independently of ffmpeg's NVENC version.
- **Seeking during conversion:** jump anywhere while a conversion runs; a second conversion starts at that point.
- **Direct playback:** MP4/MOV/WebM files VS Code can decode play as they are. With no converter set up, the player tries the file directly and explains a missing sound track.
- **Player:**
  - YouTube-style keys
  - frame numbers taken from the decoded frame (requestVideoFrameCallback)
  - volume control
  - picture-in-picture
  - full screen, or filling the editor where full screen is blocked
  - save or copy the current frame
  - frame stepping with the mouse wheel
  - converted range shown on the seek bar
  - time and frame tooltip on the seek bar
- **Image sequences:** right-click a folder or a numbered image and choose Play Image Sequence.
- **Live reload:** the player reloads when the file changes on disk and keeps its position.
- **Fixes:**
  - H.264 in AVI is re-encoded, because a rewrap showed B-frames in the wrong order.
  - Interlaced sources are deinterlaced.
  - Large-file and small-chunk fixes in the built-in decoder.
  - Background tabs pause.

## 0.1.0

- First version. MJPEG AVI plays directly, with PCM audio. Other formats are rewrapped or converted with ffmpeg (GPU first) and streamed while the conversion runs. Frame stepping, speed, loop, zoom and a conversion cache.
