# Changelog

## Unreleased

- **One viewer:** every video now opens in one kind of tab that shows one video and grows to a comparison of several and back, in place: files, video URLs, image sequences, frame links (`#t=`, `vscode://` links, compare links), Start / Add to Compare, Compare With…, Open Together and the folder rail's Compare rows. With **Capture** on (Shift+D, or **Add from Explorer**), the next videos you open join that tab instead of opening their own. Subtitles, frame and A–B export, the resume position, Live transcode, native ffmpeg and reload-on-change work in it. The separate player and Compare pages are gone, and so is the preview setting `unifiedViewer`. MJPEG AVI files now play through the built-in decoder.
- **Setup guide:** a short walkthrough that opens once on the first start (again anytime: **Video Preview: Open Setup Guide**) sets up smooth 4K, HDR and phone-video playback and remote servers, one click per step, optionally shows AI coding tools how to link to a video frame, and shows where to change everything later.
- Start / Add to Compare on a folder now follows symlinked subfolders and Docker / remote-mount directory entries (loops are detected), and searches level by level so one huge empty subfolder no longer hides videos in its siblings.
- **Compare playback and stepping:** seeking forward while playing no longer freezes every video when one of them lands on a picture just after the others (it could wait forever, most often over Remote-SSH); a video that stalls holds the others for 3 s at most; and stepping back after such a seek no longer leaves a video on its old picture.
- **One viewer fixes:** a single video opened on its own no longer follows Compare's Live transcode rules (Live transcode `always` and the raw-transfer threshold now apply only when videos are compared); Autoplay **Play next in folder** starts the next video playing from 0:00 instead of paused; **Use full resolution** closes the reduced-picture notice at once (a waiting notice then shows); a video that reloads because its file changed keeps the Live transcode resolution you picked; and a URL that ffmpeg cannot open no longer shows ffmpeg's own error (which can quote the URL) in the player: the details are in the output channel.
- **One viewer, more fixes:** seek-bar previews show again with native ffmpeg (the host's thumbnails were dropped); an A–B clip from Compare exports every tile again (`A_…`, `B_…`, each cut at the pictures that tile showed at A and B), and a single native ffmpeg video cuts at the pictures on screen rather than their playback slots; native ffmpeg tiles in a Spotlight are decoded at their own tile's size.
- **Compare:** the per-tile ⓘ clip details card has a × close button in its top-right corner (it closes the card like the ⓘ button does). The host log now says per tile why Live transcode was used or skipped, so a Compare that mixes Live transcode and "your GPU (built into VS Code)" tiles can be explained.
- **Unified viewer visual & interaction polish:** fixed Split Wipe right-side canvas transparency, letterboxed tile overlay insets (`--pic-*`), missing Capture banner styling, narrow-toolbar button collapse rules, distinct Compare panel list icon, and spare `+ Add video` tile resting opacity; restored tab-swap folder rail navigation (single-video Next/Previous opens in a fresh tab with rail carry and closes the previous one cleanly).
- **One viewer, Compare and AVI fixes:** dragging a video over the player shows the dashed "Drop to compare" frame again; a video whose container header states a wrong frame rate or length (an AVI saying 600 fps for a 30 fps video) now gets the rate and frame count the decoder measures, so the seek bar, stepping and Compare count its real frames.
- **Compare:** the bar's time shows the letter of the video that sets the clock (`A 0:01.000 / 0:03.000`); Swap in Split Wipe no longer leaves the new left video drawn over the whole picture (the right side showed the wrong video); ⚙ › Inspection names only the tools Compare has (no pixel inspector, X swaps sides there).

- **Faster steps back and seeks back over Remote-SSH (Live transcode):** the player keeps the compressed video it already received (up to 64 MB), so a paused seek back to a place you have seen, or a step back across a keyframe, decodes on your machine instead of waiting for the remote host to send it again (about 0.15-0.3 s instead of seconds on a slow link). Pressing play there, or seeking while playing into what was received, no longer has the host send that stretch again. Works in Compare too (per video). The amount is a setting, `videoPreviewEnhanced.liveTranscodeCacheMB` (`0` = off). Paused steps back in the one viewer show the frames already decoded at once again, as the single player did.
- **A seek or step that takes a moment now shows it:** the position moves on the click as before, and when the frame has not shown after 0.15 s (a slow remote link, a long GOP) the video shows a small loading ring and the seek bar breathes until it lands. In Compare, the video still loading shows it. This feedback was lost when every video moved to the one viewer.
- The seek-bar preview of a video without keyframe thumbnails (a video URL, an image sequence) no longer grows on every hover on a high-DPI screen until it covers the picture; it stays thumbnail-sized.
- **Stepping back over Remote-SSH right after a jump (Live transcode):** while paused, the remote host now quietly sends the 2 s before the frame you are on, and keeps doing so as you step or scroll back, so steps back decode on your machine instead of each waiting for the link (on a 2 Mb/s link: 30 fast steps back, none sent to the host). Video encoded while paused has a keyframe every 0.5 s instead of 2 s, so a step back across a keyframe decodes at most half a second of frames.
- **Paused over Remote-SSH, fast then sharp (Live transcode):** a frame you stop on now becomes sharp: once it has been on screen for 0.15 s, the remote host sends that exact frame in near-lossless quality and it replaces the transcoded one (steps and scrolls ask for nothing until you rest). On a slow link a jump also shows its first picture sooner: when the remote host encodes on its processor, the first keyframe is about a quarter of its usual size (on a 2 Mb/s link: 1.16 s -> 0.22 s to the first picture of a 1080p jump).
- **Faster jumps while paused (Live transcode):** the host keeps one ffmpeg running for the video you are on (in Compare, the video that sets the clock) and feeds it the jump's source from its keyframe, instead of starting ffmpeg for each jump: a paused jump to a place the host has not sent yet skips ffmpeg's start-up (on a 4K HEVC clip with 50-frame GOPs: 279 -> 153 ms to the picture, host first bytes 260 -> 138 ms). Still frame-exact. It stops after 60 s unused and counts as one of the GPU encoder sessions; H.264 and HEVC sources at a constant frame rate; seeks while playing start ffmpeg as before.
- **Live transcode: no extra GOP on a jump onto a keyframe:** a jump or start that lands exactly on a keyframe (and, in MKV files with B-frames, up to about 0.13 s after one) no longer has the host decode the whole GOP before it first. On a 4K H.264 clip with 12 s GOPs: 1.4-1.8 s -> 0.3-0.4 s to the first bytes (MP4), 1.1-1.4 s -> 0.23-0.29 s (MKV). Still frame-exact; Direct Stream is unchanged.
- **GPU encoder limit for Live transcode:** new setting `videoPreviewEnhanced.gpuEncoderSessions` (default 8): how many videos the remote host's GPU encodes at once, across every tab and Compare tile. A video over the limit is transcoded on the processor instead of failing, and you are told once which one.
- **Faster HDR and software-encoded Live transcode on NVIDIA hosts:** the GPU now decodes and scales before the CPU or OpenCL tone-mapper, and before a CPU encoder (used when the NVIDIA driver is older than the ffmpeg's NVENC needs). A seek deep into a long-GOP 4K HDR clip: 6.4 s -> 1.9 s; HDR playback 34 -> 57 fps (RTX 4070).

## 0.12.0 (2026-11-25)

Compact Folder Rail in both single-video and Compare views, new Autoplay modes (Off / Play next in folder / Loop), Compare deep links (`vscode://.../compare`), per-video Live transcode resolution picker, seek-bar keyframe previews and cached seeks during Live transcode, major slow-SSH responsiveness upgrades (128 KB bounded pipe, ~3 KB JPEG host thumbnails, session link memory, deeper remote buffer, GOP step-back caching), plus recovery fixes for damaged H.264 streams, open-GOP Direct Stream seeks, long-recording timestamps, exact-frame timeouts, and Windows folder-watch cleanup.

- **Folder rail:** a `‹ 2/5 ›` capsule on the bar (previous / next video; the count shows the rail) and a tab at the picture's right edge bring up a compact list of the folder beside the picture (or over it: setting `folderRail.layout`). Natural order, `..` to go up, a filter, **Playable formats**, a Duration / Size / Modified column, a hover card, a 1-click **Compare** on any other video and **Compare all videos in folder** on a folder. The rail works in Compare too: the tab at the right edge shows it, the clips in Compare are marked, and a click on a video (or a folder's Compare) adds or removes it. Browsing never changes what plays until you pick a video. Works locally, in WSL and over Remote-SSH ([details](docs/notes/folder-rail.md)).
- **Autoplay:** Off / Play next in folder / Loop, in ⚙ › Autoplay and the rail's footer (setting `onEnd`, replacing `loop`). **Play next in folder** shows the folder's next video in the same tab from 0:00 when one plays to its end, and stops at the last one. An A–B range still repeats. **New tabs no longer loop by default**; a `loop` you set yourself still applies until you choose Autoplay.
- **Right-click ◀| / |▶** goes to the previous / next video of the folder (a left click still steps one frame).
- `Shift+N` / `Shift+P` read the folder without blocking the extension host.
- **Live transcode resolution:** ⚙ › Live transcode › Resolution fixes this video's picture at Auto, 1080p, 720p, 480p or 360p (and 1440p / 2160p for larger sources); a fixed height stays put whatever the connection does (no automatic step down or up), Auto sizes it to the view and adapts to the link as before. **Save … as default** stores it in `videoPreviewEnhanced.transcodeResolution` for new tabs. The bar chip and ⓘ say when a resolution is fixed.
- **Snappier seeks & stability over slow remote links:** the Live transcode pipe carries at most 128 KB of picture per reply on remote links (splitting oversized frames in bounded pieces), seek-bar host previews travel as JPEGs capped at 25 KiB (~3 KB typical vs ~58 KB RGBA), a seek still pending after 200 ms softly pulses the seek bar (static with reduced motion), Auto resolution remembers recent link quality across tabs and buffers further ahead, and the playback clock holds cleanly through network blackouts without jumping backward.
- **Live transcode stepping back over slow links:** after a pause, stepping back through a GOP is served from memory for the whole GOP, a step back waits briefly for those pictures instead of re-sending the GOP, and quick wheel notches during a remote seek send one seek once the wheel rests.
- **Seek-bar previews & cached seeks during Live transcode:** hovering or dragging the seek bar shows keyframe previews while Live transcode is active (local and Remote-SSH files), and seeking back into recently played regions uses cached picture and sound with no ffmpeg restart.
- **Compare deep links & AI agent guide:** `vscode://gordon-vidal.video-preview-enhanced/compare?frame=N&mode=split&file=...&file=...` opens two or more videos in a synchronized Compare view at the requested frame/timestamp and layout (`grid`, `spotlight`, or `split`), or reveals and seeks an already-open Compare panel for those files. Added `docs/agents.md` with a copy-paste prompt for `AGENTS.md` / `CLAUDE.md`.
- **Damaged H.264 / VP8 videos & reliability fixes:** when WebCodecs rejects a damaged picture, playback continues at the next keyframe instead of stopping as if the video had ended; fixed frozen playback after open-GOP H.264 Direct Stream seeks and incorrect timestamps past 3h18m50s; exact-frame tools read a bounded input window instead of decoding to EOF; opening a video no longer ticks the clock while the first picture loads; ffmpeg re-tests work while Live transcode tabs are open; and deleted folders, failed reads, and unexpected frame-loop errors are handled gracefully.
- The extension package no longer includes local Git hook scripts (`.githooks/`) from the build machine.

## 0.11.0 (2026-11-24)

Fast drag-scrubbing with keyframe previews and cached timeline ranges, plus a major Remote-SSH Live transcode upgrade: smarter adaptive bitrate with hardware decode preserved on stepped-down tiers, hardware-first remote HDR → SDR tone-mapping, zero-stall dual-overlap encoder transitions, and lossless host-side Direct Stream for compatible H.264 video.

- **Fast seek-bar scrubbing:** dragging the seek bar shows a live keyframe preview in the tooltip while holding the main picture until an exact seek on release, with per-source preview coalescing and timestamp-indexed thumbnail caching. Compare previews its clock tile.
- **Live transcode — Direct Stream:** host-side Direct Stream copies WebCodecs-compatible 8-bit SDR H.264 video without re-encoding (lossless video copy + Opus audio) when it fits the view and bitrate cap, falling back to re-encoding on ABR step-down or downscale.
- **Live transcode — zero-stall transitions:** pre-starts a replacement encoder for quality upgrades, bitrate cap changes and larger picture sizes during single-player playback and splices cleanly on a keyframe without pausing audio.
- **Live transcode — smarter remote ABR & GPU decode:** dual-EWMA bandwidth smoothing, 1-window panic step-down, 0.35 s buffer upgrade guard with oscillation backoff, an intermediate 1080p @ 5.5 Mb/s tier, and hardware GPU decoding kept active on stepped-down tiers.
- **Remote HDR plays smoothly:** HDR clips (HDR10/PQ, HLG, Dolby Vision 8.x) in a Remote-SSH or container window now go through Live transcode and are tone-mapped to SDR BT.709 on the remote machine (hardware tone-mapping when the host has it, otherwise zscale + tonemap), labelled "HDR → SDR tone-mapped" in ⓘ; local HDR keeps the exact path unless Live transcode is Always.

## 0.10.1 (2026-11-24)

Over 1.3 s faster cold native opens on Windows (registry GPU detection + parallel tool checks), fixed cumulative Opus audio drift during long Live transcode playback, exact backward frame stepping on variable-frame-rate (VFR) videos, seamless in-band Live transcode growth while playing, NVIDIA-driver-matched Remote-SSH ffmpeg downloads, and compact Compare sync pill fixes.

- Live transcode: keep Opus sound in step with the picture when the connection can carry the full-quality stream.
- **Exact backward frame stepping on variable-frame-rate (VFR) videos:** stepping backward one or more frames in dense or sparse VFR footage (e.g. OBS/phone recordings) now indexes decoded pictures directly instead of using nominal `1/fps` intervals, eliminating 1-frame skips and paused tick overshoots.
- **Faster first native open of a session:** the one-time ffmpeg check now starts its three tool runs together, and the GPU lookup starts beside it instead of after it (only when no stored result is under 30 days old). Nothing decodes earlier.
- **Faster GPU lookup on Windows:** the graphics adapters and NVIDIA driver version are now read from the registry (about 15 ms) instead of PowerShell and WMI (about 1.1 s cold); PowerShell remains the fallback.
- Maintainer tooling: capture Dark, Light and High Contrast screenshot packs with `tools/theme-screenshots.js`.
- **Remote-SSH: the ffmpeg download now matches the host's NVIDIA driver.** The one-click download on a Linux remote used to take the newest build whatever the GPU, so an older driver (below 610) could not use NVENC and ffmpeg had to be set up again. It now detects the host's GPU and driver first and picks the compatible release line, as the local setup does; the offer text describes Live transcode.
- Live transcode: making the picture larger while playing (window resize, zoom) now restarts the encoder in place instead of seeking the page, so sound and clock continue; repeated size messages ask for one refresh only.
- Compare: tighten dense-grid sync pill padding/button widths so it stays inside small tiles in 5+ video grids.

## 0.10.0 (2026-11-24)

Compare Spotlight layout with direct drag gestures and pure monochrome frosted chrome, automatic Live transcode with faster Remote-SSH startup and zoomed sharpness, recursive folder Compare, A–B frame export stride, local Open Video / Play to the Side / New Window commands, and URL cancellation with HTTPS TLS verification.
- **Compare Spotlight layout, grouped player bar capsule & direct gestures**: Compare now offers **Spotlight** (universal 4-sided docking with a 10%–90% resizable splitter), **Equal Grid**, and 2-clip **Split Wipe**, switched explicitly from a grouped Compare capsule in the bottom player bar alongside **+ Add** (Pick/Browse, Add Mode `Shift+D`, `Shift+drop` hint), on-demand **Sync** mode (revealing per-tile `− 0f +` steppers), and the Compare panel. Tile reordering and 4-sided Spotlight docking are always-on via direct drag with dashed drop-zone skeletons and full-rect FLIP gliding across both WebGL textures and overlays (while zoomed in, dragging the video pans in lockstep and the top-left pill's `⋮⋮` grip still drags tiles). Tiles use minimal monochrome hover-reveal chrome with a per-tile `ⓘ` stats HUD (highlighting mismatches against slot A in amber) and inline two-click `Remove?` confirmation.
- Maintainer tooling: the review launcher is now cross-platform Node (`tools/review.js`; `review.cmd`, `review.sh` and `tools/review.ps1` forward to it), with an interactive menu, `--link` (simulated Remote-SSH link) and `--transcode` options. See `docs/REVIEW.md`.
- **Remote-SSH: faster start, sharper zoomed Compare, quicker steps back, status chip** (design note `docs/notes/ssh-adaptive-streaming.md`). The player and Compare inline their CSS (no unstyled flash) and, in remote windows, their small scripts (fewer round trips); a transcoded Compare tile zoomed in 1.5× or more grows toward the source's size within the shared bitrate cap and refreshes once for a crisp paused frame; Live transcode keeps more history (15 s remote, 8 s local) and steps back from memory more often; and in remote windows a compact **Live** chip in the bar shows the picture size and bitrate cap (or that quality is adapting) and opens ⚙ › Live transcode.
- **Live transcode is now automatic** (`videoPreviewEnhanced.transcode` defaults to `auto`; the `ask` mode is retired and a stored `ask` behaves as `auto`). Nothing asks before it starts; the first time it does, one non-blocking notice explains it and offers **Use original video** or **Turn off**, and never appears again. `off`, the per-tab **Use original video** and ⚙ › Live transcode work as before.
- Right-clicking a folder in the Explorer and choosing **Start Compare** or **Add to Compare** now includes videos in subfolders (e.g. `recording/cam1/video.mp4`), in natural folder and file order.
- **Export Frames (A–B)…** now prompts for an optional frame stride (default `1` for every frame, or `N` for every Nth frame); the 300-frame confirmation and 2,000-frame cap apply to the exported frame count while file names keep each frame's 1-based video index.
- Pick a local video with **Open Video File…**, or open it in a separate editor group or window with **Play to the Side** and **Play in New Window**.
- Open Video URL: closing or reloading a URL tab now stops its downloads at once (page inspection, HLS playlists, segments, keys and range reads), and native ffmpeg now checks the certificate of an HTTPS URL (`-tls_verify 1`), unless `http.proxyStrictSSL` is off.

## 0.9.1 (2026-11-23)

Refined player and Compare controls (themed in-page context menu, step-size badge, folding volume slider, A/B range buttons and draggable pins, grouped Settings and Info panels, animated Compare tile reorder drag, shared playback preferences with default-muted tabs), plus Chocolatey/Scoop ffmpeg shim support and exact frames during reduced-quality native playback.

- Fixed: unmuting a video that started playing with its audio context suspended no longer freezes playback or jumps the clock backward.
- New tabs start muted by default (unmute with the mute button, **M** or the volume slider); videos without an audio track show a dimmed, disabled mute button. Volume, playback speed, the time display format (time, SMPTE timecode, frame number) and the step size are shared: every open player and Compare tab follows a change at once, and they are remembered across videos and VS Code sessions.
- The frame-step buttons have a small badge showing how far they jump; it appears when you point at them; click it to pick 1 frame, 5 frames, 1 s, 5 s or 10 s. The volume slider folds behind the mute button and opens when you point at it. In narrow panes the bar hides less-used buttons step by step (still available from ⚙, the right-click menu and keys). In Compare's Reorder mode, the **×** on a tile still removes it.
- The right-click menu is now drawn by the player itself instead of VS Code's native menu: it matches the ⚙ panel's theme, shows each shortcut in a muted monospace column on the right, marks **Loop** with a real ✓, stays inside the window, and also works in fullscreen. Arrow keys, Home / End, Enter / Space and Escape work in it; it closes on a click elsewhere (the click does not play or pause), on resize, and when you open a panel. Right-clicking a text field still gives the normal Cut / Copy / Paste. The `videoPreviewEnhanced.ctx.*` commands are removed (they were hidden from the Command Palette).
- Removed the startup warning notification about older extension folders left behind by VS Code updates.
- Windows: ffmpeg installed with Chocolatey or Scoop now works with the native decoder (audio and exact timestamps). The extension runs the real ffmpeg behind the package manager's shim, which dropped the extra pipes.
- Slow-playback notices explain the tradeoffs, label choices saved for all videos, and offer Settings and Don't show again.
- Right-clicking a video editor tab offers Start Compare or Add to Compare, like the Explorer menu. With several video tabs selected, all of them are used.
- New settings `jump.wheel` (default one frame) and `jump.wheelShift` (default 1 s) set how far the scroll wheel and Shift+wheel jump while paused, in the player and Compare. Shift+wheel also works where Windows reports it sideways.
- Picture size and zoom toasts name the size with its percent (`Fit (67%)`, `Fill (112%)`); zooming back out to the picture size shows that instead of a bare `Zoom 67%`.
- ⚙ is grouped into Playback, Tools (**A–B Range ›** with the range and all its exports, **Inspection ›** with the pixel inspector, scopes, stats and codec X-ray) and links; Jump sizes are VS Code settings only; Loop is now Repeat video. ⓘ is information only: Open in system player moved to the foot of ⚙, and the top-left "Full technical details" overlay is gone (ⓘ has **Copy link to this frame**). Keys are unchanged.
- The right-click menu shows each action's key (Space, R, A, B, S, T, Ctrl+C, Shift+D, ?), says "A–B range" like the rest of the player, and **Compare With…** is replaced by **Start Compare** / **Add to Compare**, the same as the Compare button. New keys: **T** copies the timestamp, **Backspace** clears the A–B range.
- Clicking anywhere outside an open panel (Info, Settings, Speed, Subtitles, Compare), including the control bar, closes it; clicking the picture only closes it and does not play or pause. Clicking outside a Compare tile menu closes it too.
- A–B range by mouse: **A** and **B** buttons beside the time set the range start and end (lit while set), and the A and B pins on the seek bar drag to the nearest frame, showing the time and frame as you go. Works in the player and in Compare; the buttons hide in very narrow panes.
- The seek bar and time readout hold the requested position after you release the thumb while the decoder catches up. Frame-step buttons stay visible in narrow splits.
- Escape dismisses playback notices, Pixel Inspector and Scopes. Scopes also has a close button, and playback notice buttons leave playback alone.
- Settings opens on the first click from another panel. Live transcode shows where its defaults apply and which tools fetch full-resolution frames.
- A–B marks can be set quietly for looping. Exact clip export offers a decoder switch when the marks lack source timestamps.
- Large Compare grids label tile copies as rendered-size images.
- Compare tiles have a **×** button in their hover controls to remove that video when three or more are open.
- Reorder drags lift the tile under the pointer while the other tiles glide into the order a drop would give. Esc snaps them back. Reduced motion turns the glide off.
- Frame stepping and dragging the seek bar update the position readout immediately. Compare combines rapid requests and starts seeking across the videos together.
- The player’s Compare button uses a framed split-view icon with **Compare** and **Add to Compare** tooltips.
- Fullscreen in the player and Compare uses the full editor width when it falls back to Zen Mode.
- Copy Frame, Save Frame as PNG, Pixel Inspector and Scopes now fetch full-resolution source frames during reduced-quality Native ffmpeg playback without switching decoders.
- The smooth-playback notice shows which picture 100% zoom uses and offers full resolution for this tab, Settings, and a saved dismissal.
- Seek and volume sliders keep their focus rings for keyboard navigation and clear them after pointer interaction.
- The player and Compare briefly show a centered Play or Pause icon when you toggle playback.
- The seek bar labels A and B separately and highlights the range used for looping and export.

## 0.9.0 (2026-11-22)

Lossless A–B clip export in the player and Compare (with native ffmpeg real timestamps), Compare tile reordering, unified Start/Add to Compare controls, larger action toasts, and faster multi-video drops.

- New: **Export A–B Clip…** saves a lossless video excerpt with native ffmpeg. Compare shares an **A** / **B** loop and can save one clip per tile with its offset applied. Marks set during built-in or native ffmpeg playback give exact clips (native ffmpeg now reports each picture's own timestamp, so HEVC, AV1, ProRes and variable-frame-rate files work without switching decoder). Marks set during Live transcode, whose pictures are re-timed, are refused at once with a **Use original video** button.
- Fixed: dragging selected videos from the Explorer into the editor includes any video already open in a preview tab.
- Fixed: Compare updates A–B timeline marks immediately when pressing A or B while paused, and A–B marks draw above the seek track.
- Fixed: closing or reloading the player cancels pending video opens, frame exports, and native seek-bar thumbnails.
- Fixed: the video player loads again after VS Code's **Developer: Reload Webviews** command.
- Fixed: WebCodecs keeps visible frames and hides decode preroll when MP4 edit segments share timestamps.
- Fixed: Compare and the single player agree on frame numbers for rounded timestamps and rates close to standard rates.
- Fixed: the Pixel Inspector reads the pixel under the pointer at 100% on high-DPI displays.
- Fixed: detect older installs in custom extensions directories and skip the warning in extension development sessions.
- Changed: action messages are larger, easier to read, and appear at the top centre of the picture in the player and Compare.
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
