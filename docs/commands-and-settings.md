# Commands and settings

## Commands

All are under **Video Preview** in the Command Palette.

| Command | What it does |
|---|---|
| Set Up Optional ffmpeg (GPU decoding for 4K, AV1, ProRes) | Downloads ffmpeg, or uses one you have, and tests it ([Optional ffmpeg](ffmpeg.md)) |
| Re-test ffmpeg | Tests ffmpeg's GPU decoding on this machine (never runs on its own; also offered once when playback is slower than real time and no test has run); results in Show Log |
| Use Video Preview Enhanced for MP4/WebM | Opens MP4 and WebM in this player by default |
| Use VS Code's Preview for MP4/WebM | Undoes that |
| Open with Video Preview Enhanced | Explorer context menu on an MP4 or WebM file (not in the Command Palette) |
| Compare / Play Together | Shows the 2–4 videos selected in the Explorer together, in sync (up to 16 with the experimental `compare.maxVideos`) |
| Compare With… | Compares the open video with 1–3 more files (in the player's place) |
| Load Subtitles… | Opens a subtitle file for the current video (needs an open player) |
| Export Frames (A–B)… | (needs an open player) Saves every frame of the A-B loop as PNG into a folder you pick |
| Copy ffmpeg Command for A–B | (needs an open player) Copies an ffmpeg command that cuts the A-B loop (exact or `-c copy`) |
| (right-click menu items) | The player's context menu runs commands named `videoPreviewEnhanced.ctx.*` (play, pause, loopOn, loopOff, setA, setB, clearAB, copyFrame, saveFrame, copyTime, keys, playerSettings). They are not in the Command Palette; [see Keys and mouse](keys.md#right-click-menu) |
| Open Video URL… | Plays a video from an http(s) URL: a direct file link, an HLS (`.m3u8`) or DASH (`.mpd`) stream ([Network URLs](urls.md)). Also **Open video URL…** in the player's ⚙ panel |
| Open Video URL to the Side… / Open Video URL in New Window… | The same, in the editor group beside the current one or in a new window |
| Play Image Sequence | Plays a folder of numbered images (also in the Explorer context menu of a folder or an image) |
| Show Log | Shows the extension's log, useful for bug reports |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `videoPreviewEnhanced.decoder` | `auto` | `auto`: native ffmpeg when it is installed, for everything except 8-bit H.264 and VP8 (those stay on VS Code's GPU decoder), in local and WSL windows; otherwise, and over SSH or in containers, the built-in decoder ([details](ffmpeg.md)). `builtin`: always the built-in decoder. `ffmpeg`: always native ffmpeg when it is installed (local and WSL windows). |
| `videoPreviewEnhanced.whenSlow` | `every` | When decoding is slower than real time: `every` slows playback down and shows every frame; `skip` keeps real time by jumping to keyframes. The notice shown when decoding falls behind switches it too. |
| `videoPreviewEnhanced.overrideFileIcons` | `true` | Override file icons: give every format the player opens the same video icon in the Explorer (Seti, the default file icon theme, already does this for .avi, .mov, .mpg, .ogv, .mp4 and .webm; this adds .mkv, .flv, .mpeg, .m2ts, .wmv, .3gp, .m4v, .vob, .divx, .asf, .mxf and .y4m). It writes `"*.ext": "vpe-video"` entries to your user `files.associations` where you have none, and turning it off removes only those. Other icon themes may show their own icon instead. So the icons are there before you open a video, the extension loads when VS Code starts (about 30 ms per window). VS Code doesn't let a setting change that, so it still loads with this off, but does no file-icon work. |
| `videoPreviewEnhanced.jump.arrow` | `5` | How far ← / → jump: `"frame"` (one frame) or 1, 5, 10, 30 seconds. Also ⚙ › Jump sizes in the player. |
| `videoPreviewEnhanced.jump.shift` | `1` | The same for Shift+← / Shift+→. |
| `videoPreviewEnhanced.jump.ctrl` | `"frame"` | The same for Ctrl+← / Ctrl+→ (Cmd on macOS). |
| `videoPreviewEnhanced.stepButtons` | `"frame"` | What the two buttons beside Play do: `"frame"` steps one frame, `"jump"` jumps by the Ctrl+← / Ctrl+→ size (`jump.ctrl`). Also ⚙ › Jump sizes. |
| `videoPreviewEnhanced.pictureSize` | `"fit"` | How the picture sits in the player (and in compare) for new tabs: `"fit"` (whole picture, bars where the shape differs), `"fill"` (no bars, edges cropped), `"stretch"` (fills the player, distorted) or `"actual"` (100 %: one video pixel per screen pixel). The bar button and `Z` change the current tab only. |
| `videoPreviewEnhanced.compare.maxVideos` | `4` | Experimental: how many videos one compare takes, 2 to 16. From 5 on they sit in a plain grid (3×2, 3×3, 4×3, 4×4) and share the memory and transfer of 4 videos, so each picture gets fewer pixels. Applies to the next compare or the next video you add. |
| `videoPreviewEnhanced.advancedMode` | `false` | No longer used (deprecated): the player has one layout and its tools are always in the ⚙ panel ([details](features.md#the-player)). |
| `videoPreviewEnhanced.autoplay` | `true` | Start playing when a video opens. |
| `videoPreviewEnhanced.loop` | `true` | Loop playback. |
| `videoPreviewEnhanced.sequenceFps` | `30` | Frame rate for image sequences (1 to 240). |
| `videoPreviewEnhanced.ffmpegPath` | empty | Your own ffmpeg. Empty: the one setup downloaded, then PATH. A machine setting; a workspace can't set it. |
| `videoPreviewEnhanced.gpuDecoding` | `true` | Let native ffmpeg decode on the GPU, with the method the test found best here. `false`: CPU only. |
| `videoPreviewEnhanced.hdrOutput` | `auto` | `auto`: HDR10, HLG (and Dolby Vision 8, HDR10+) are shown in HDR when the display reports HDR and VS Code's WebGPU can draw an extended-range canvas; otherwise tone-mapped to SDR. `off`: always tone-mapped. Details: `docs/notes/hdr-output.md`. |
| `videoPreviewEnhanced.nativeMaxHeight` | `0` (automatic) | The local frame server picks an output height up to 2160p based on the source frame rate (2160p for a 4K 30 fps source, 1440p for a 4K 60 fps source), and, with `sizeFramesToView` on (default), no larger than the player's picture needs (540p, 720p, 1080p, 1440p or 2160p for its size in device pixels; a zoomed picture counts at its zoomed size; growing, e.g. to fullscreen or zooming in, applies within about a second, shrinking at the next seek or loop). The VS Code message fallback uses 1080p locally. WSL is capped at 720p. A number sets the height limit (and always sends that size). |
| `videoPreviewEnhanced.sizeFramesToView` | `true` | Performance: with ffmpeg, send frames only as large as the picture is shown (540p to 2160p), which saves a lot of CPU for 4K videos (4K HEVC 10-bit in a 1080p panel: about 1 core instead of 3.7 on the test PC). The picture grows to full resolution at once when you enlarge the panel, go fullscreen or zoom in. Off: frames always up to `nativeMaxHeight` (automatic: 2160p for 4K at 30 fps). A number in `nativeMaxHeight` wins either way. Applies at once to open videos. |
| `videoPreviewEnhanced.fastPreviewWhenBehind` | `false` | Built-in decoder, HEVC and H.264 only: while playback is behind real time, leave out deblocking for about 1.2-1.5x faster decoding. The picture is approximate while playing; paused and stepped frames are always decoded exactly. |
| `videoPreviewEnhanced.remoteStream` | `auto` | Remote windows: ffmpeg on the remote machine streams what the GPU decoder can't play as H.264 ([details](remote.md)). `off`: the built-in decoder; `on`: every window (testing). A machine setting: set it in the remote's settings. |

## Making it the default for MP4 and WebM

VS Code has its own preview for MP4 and WebM. On first start after installing (and after an update that adds formats) this extension writes `workbench.editorAssociations` in your **user** settings so MP4 and WebM open here too, without a popup. It only fills entries you haven't set: if you already chose another editor for `*.mp4`, that stays. It happens once; undoing is remembered. You can also:

- **Undo later:** run **Video Preview: Use VS Code's Preview for MP4/WebM** (it removes only the entries pointing at this player). To apply again: **Video Preview: Use Video Preview Enhanced for MP4/WebM**.
- **One file type:** right-click an `.mp4` → **Open With…** → **Configure default editor for '*.mp4'…**.
- **settings.json:**
  ```json
  "workbench.editorAssociations": {
    "*.mp4": "videoPreviewEnhanced.playerOptional",
    "*.webm": "videoPreviewEnhanced.playerOptional"
  }
  ```

All other formats open in this player by default.
