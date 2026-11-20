# Product direction (2026-11-19)

The source of truth for what we build and why.

## The pitch

Play any video in VS Code. No install for the common formats; one click sets up ffmpeg for the
rest, and then it plays at full speed. Frame-exact tools for people who make video.

Selling points, in this order:

1. **No install needed** — H.264 and VP8 play on the GPU right away, in any container; most other
   formats play in the built-in decoder.
2. **Full install, fastest speed** — with ffmpeg set up (one click, no admin), heavy formats play in
   real time: 4K HEVC, AV1, VP9, ProRes, 10-bit.
3. **Smart detection** — the extension picks the right decoder per file; the user never has to.
4. **Features** — a clean player; frame stepping, multi-view sync and the inspection tools one click
   away in its settings panel (⚙).

## Default viewer (2026-11-19)

The player is the default viewer for every format it supports, automatically. Formats VS Code can't play are
priority `default` in `package.json`. MP4 and WebM (which VS Code's own preview also claims) get
`workbench.editorAssociations` entries in user settings on first activation (and after an update that adds
patterns), without asking and without any notification (2026-11-20: installing it is the request for a better
preview). Never overwrite an association the user already set; the run is recorded in globalState
(`videoPreviewEnhanced.autoDefault`) so it happens once and an undo (the command) sticks. It runs in untrusted workspaces too: it only touches user settings. Settings the page writes
(jump sizes, whenSlow) never show VS Code's raw error: a failed write is logged and kept in globalState.

## The three decoders (how we present them)

| | Decoder | Plays | Install |
|---|---|---|---|
| A | **GPU (WebCodecs)** | H.264 and VP8 in any container we detect: MP4, MKV, MOV, M2TS/MTS, FLV, AVI, WebM. Not 10-bit or 4:2:2 H.264. | none |
| B | **Built-in (WebAssembly)** | everything else: HEVC, AV1, VP9, ProRes, DNxHR, MPEG-2, WMV, … Full speed up to 1080p for most formats; 4K heavy formats are slow. | none |
| C | **ffmpeg (native)** | everything, on the GPU where possible; heavy 4K formats in real time | one click, no admin |

The container claim for A must be verified in real VS Code before it goes in the listing.

## Decoder rule

ffmpeg installed is the best setup in general, but not strictly better everywhere. The rule:

- **ffmpeg installed, local window (or WSL):** ffmpeg plays everything **except 8-bit H.264 and
  VP8**, which stay on A (full resolution, no extension-host cost).
- **No ffmpeg, remote over SSH, or Restricted Mode:** A for H.264/VP8, B for the rest.
- **Pixel tools** (inspector, scopes, exact export) need exact frames: they switch the tab to the
  built-in decoder. In a local window, the frame server (127.0.0.1) picks the output size from the
  source rate: 2160p for a 4K 30 fps source and 1440p for a 4K 60 fps source. The local VS Code
  message fallback uses 1080p. On 2026-11-19, VS Code 1.147.0 on Windows 10 (i7-9700K, RTX 4070,
  32 GB RAM) showed 30 fps at 2160p for 10-bit HEVC and AV1, and 60 fps at 1440p for 10-bit HEVC
  over the frame server. See [Performance](performance.md) for the measured playback rates.
- **Frames sized to the picture** (2026-11-20; performance setting `sizeFramesToView`, on by default): with
  ffmpeg and the automatic `nativeMaxHeight`, frames are only as large as the picture is shown (540p, 720p, 1080p, 1440p or 2160p,
  the smallest that covers it in device pixels), capped by the source-rate rule above. Enlarging the panel, fullscreen
  and zooming in grow the frames at once; shrinking waits for the next seek. Users should not notice it; turning the
  setting off restores the cap above. The last non-zoomed picture size (device pixels) is also remembered across sessions
  (globalState), as the first guess for the early-started ffmpeg, so the first 4K video of a session doesn't restart
  ffmpeg at the picture size (~300 ms). Invisible: zoomed sizes are never remembered, `sizeFramesToView` off ignores it,
  and a number in `nativeMaxHeight` wins. Built-in decoding, compare tiles and pixel tools are unaffected.
  (4K HEVC 10-bit in a ~1080 px panel: about 3.7 cores before, 1 core with this and the vendor default; docs/notes/cpu-4k.md.)
- **Invisible optimisations** (2026-11-20: work a user never notices; measurements in docs/notes/perf-invisible.md):
  - A hidden tab stops its native ffmpeg, the loop standby and the host's frame queue (remote stream: its encoder); showing it re-seeks.
  - The page's frame loop rests while paused and nothing changes (input, messages and decoder output wake it); no unchanged state saves.
  - Paused, native ffmpeg and WebCodecs decode about 1 s ahead; the built-in decoder still fills its memory budget.
  - The AudioContext is suspended 3 s after a pause or when hidden; play resumes it with picture and sound starting together.
  - Native frames also come at 720p and 540p when the picture is that small (same rules as the steps above).
  - The ffmpeg tool check and ffprobe results are cached (keyed by path, size and time; a changed binary checks again).
  - The GPU vendor is detected again only when the stored result is over 30 days old or a method guessed from it failed.
- The GPU test only picks the method ffmpeg uses (d3d11va, qsv, cuda, …). It no longer decides
  between native and built-in. Untested, the method comes from the GPU vendor (NVIDIA cuda with GPU 8-bit/scaling,
  Intel qsv, AMD/other Windows d3d11va, else auto), with fallback to auto and then the CPU when it fails on a file
  (remembered per ffmpeg and stream class). No decoding is needed to choose.
- **Nothing decodes in the background on its own** (2026-11-20: a CPU/GPU spike right after installing looks like
  malware). No automatic GPU test after install, after setup or after an ffmpeg/driver change. The test is only
  offered (a popup with "Run test" / "Not now" / "Don't remind me") when a video plays slower than real time and this
  ffmpeg/GPU has no test result, and runs from "Video Preview: Re-test ffmpeg". ffmpeg stays the recommended setup: the
  first video recommends setting it up, and it is used whenever it plays a file better than the built-in decoder.
  Seek-bar thumbnails follow the same rule: they decode only while the pointer hovers or drags on the seek bar (picture under the
  pointer first, a few neighbours), never as a strip after open; no ffmpeg thumbnail process or thumbnail worker exists before the first hover.

## Onboarding

- **The first video of each session while no ffmpeg is found** (2026-11-20): "Video Preview works best with
  ffmpeg …" with **Set up ffmpeg** / **Not now** / **Don't remind me (use built-in player)**. Say "set up" (download
  portable ffmpeg or use a local copy), and "download portable ffmpeg" when the download is meant. "Not now" asks
  again next session; "Don't remind me" is final and also silences the slow-playback reminder. Not in remote or
  restricted windows.
- **When the built-in decoder falls behind** and ffmpeg isn't set up: a reminder with measured
  numbers for this kind of file (no guessed gain table).
- **When playback falls behind with ffmpeg installed** and no GPU test has run for this ffmpeg and GPU: the GPU
  test offer (Decoder rule above), once per session, "Don't remind me" kept.

## The player (2026-11-19: one layout, the approved mock-up)

- **One player, no modes.** The separate advanced layout is dropped; `advancedMode` is deprecated and ignored.
- **Bar:** previous frame, play/pause, next frame, mute, volume, time (click: time / timecode / frame number),
  then CC, ⓘ (about this video), speed, ⚙, keyboard shortcuts, picture-in-picture, fullscreen. No status pill:
  only real problems show (a notice, once).
- **⚙ panel:** speed, loop, A-B loop, subtitles, audio track, copy frame, keyboard shortcuts, jump sizes and a
  Tools grid (compare, scopes, inspector, stats, codec X-ray, export A-B).
- **Speed:** 0.25×–4× in steps of 0.05 (the range where the sound keeps its pitch).
- **Jumps:** ← →, Shift+← →, Ctrl+← → each 1 frame / 1 s / 5 s / 10 s / 30 s (defaults 5 s, 1 s, 1 frame);
  `,` `.` always one frame. Keys VS Code uses are avoided (Alt+← →, Ctrl+K, Ctrl+Shift+C).
- **Buttons beside Play** (2026-11-20): by default step one frame back / forward; setting `stepButtons`
  (`frame` | `jump`, also ⚙ › Jump sizes) makes them jump by the Ctrl+arrow size. Tooltips say which.
- **Right-click:** quick actions on this moment only (play/pause, loop, copy/save frame, copy timestamp, frame
  link, shortcuts, settings).

## Multi-view (compare)

One feature: compare becomes multi-view. The difference view is dropped.

- **Now:** up to 4 videos in a sensible layout (2 side by side or split with a draggable divider, 3–4 in a 2×2 grid;
  3 leave an "Add video" cell). The toggle (flip) view is dropped.
- **Later, low priority:** a flexible layout system, up to 16 videos.
- **The player's UI (2026-11-20: the approved compare mock-up).** Compare is the player with more videos:
  the same bar drives all tiles (play, lockstep frame steps, seek, speed, loop, jumps); time and seek follow the
  clock video with its letter; mute / volume act on the sound video; CC and picture-in-picture are hidden. One new
  bar button opens the **Compare panel** (⚙-panel style): a row per video (letter, name, clock / sound, offset)
  with its own page (offset − / + in frames or ms, Reset, Clock and Sound switches, Replace video…, Remove), Add
  video (n of 4), View (2 videos: Side by side | Split), Swap, Leave compare. Tiles are clean; hover shows the name
  pill with the tile's own frame number and a ‹ offset › nudge; − / + nudge the tile under the pointer;
  right-click a tile for its actions. The old compare toolbar and sync panel are gone.
- **Entering:** ⚙ › Tools › Compare and "Compare with…" in the player's right-click menu, both with VS Code's open
  dialog; compare takes the player's tab and starts at its position; Leave compare puts the player back there.
  (It is a separate webview panel that replaces the player's tab, not the same webview: docs/notes/compare-ui.md.)
- Each video has its own offset, by **time or frame number** (hover nudge and the panel only).
- One video sets the clock; **sound comes from one chosen video** (the first by default).
- Lockstep frame stepping: a step always shows matching frames in every tile.
- Each tile is decoded on its own: native frames come at the tile's size (e.g. 960×540 in 2×2),
  not full size, to stay under the transfer limit (each native tile has its own local connection
  channel and a share of one budget).
- PSNR/SSIM and find-first-difference are hidden for now; kept in code for a future advanced mode (2026-11-20).

## Remote (research, high interest)

- SSH: done (`remoteStream`, on by default): ffmpeg on the remote machine sends a compressed,
  low-latency H.264 stream that the panel decodes with A — instead of raw frames, or WebAssembly only.

## Testing

- **Only real VS Code counts** (`test/vscode/run.js`, a hidden desktop and a fresh profile).
  The Edge/Chromium harness is not evidence for anything.

## Releases

- Draft GitHub Releases with the VSIX attached, for pre-release checks.
- **1.0 is public only when the maintainer decides.** Until then nothing goes to the Marketplace or
  Open VSX; the listing, icon, keywords and packages are prepared so a release is one step.
