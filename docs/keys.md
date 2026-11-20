# Keys and mouse

The layout follows common video players (YouTube-style). Keys work when the player has focus. `?` shows
them all, with the jump sizes you chose.

## Playback

| Key | Action |
|---|---|
| Space / K | Play or pause |
| J / L | Back / forward 10 s |
| ← / → | Back / forward 5 s (setting `jump.arrow`) |
| Shift+← / Shift+→ | Back / forward 1 s (setting `jump.shift`) |
| Ctrl+← / Ctrl+→ (Cmd on macOS) | Back / forward one frame (setting `jump.ctrl`) |
| , / . | Previous / next frame |
| Shift+< / Shift+> (or [ / ]) | Speed −0.05 / +0.05 (0.25×–4×) |
| 0–9 | Jump to 0–90 % |
| Home / End | First / last frame |
| ↑ / ↓ | Volume ±5 % |
| M | Mute. Playback starts muted until you click, because VS Code blocks autoplay with sound |
| R | Loop on or off |
| A / B | Set the A-B loop start / end (press again to clear) |
| F | Fill the editor and switch to zen mode |
| Shift+N / Shift+P | Next / previous video in the folder |
| D | Compare with another video: a quick pick of the videos in this folder, then the workspace (**Browse…** opens the file dialog) |
| S / Ctrl+C | Save the frame as PNG / copy it |
| ? | Keyboard shortcuts |
| Esc | Close a panel or the shortcuts |

Alt+← / Alt+→ are VS Code's Go Back / Go Forward and Ctrl+K starts VS Code's key chords: the player
leaves them alone (`docs/notes/ui-simple.md`).

## Inspection

| Key | Action |
|---|---|
| Ctrl+G | Go to a frame, time, percentage or step (or click the frame number) |
| Shift+C | Copy a link to the current frame |
| I | About this video (the ⓘ panel); its **Full technical details** shows the codec, pixel format and decoder overlay |
| Shift+I | Stats overlay |
| W | Scopes: luma waveform, RGB parade, vectorscope, histogram, off |
| Z | Picture size: Fit, Fill, Stretch, 100 %, then Fit again. Zoomed in (Ctrl+wheel, `+`), Z goes back to Fit first |
| + / - | Zoom in / out around the middle of the picture (not in compare: there they nudge offsets) |
| Shift+Z | Nearest-neighbour pixels |
| X | Pixel inspector: with loupe, without loupe, off |
| Shift+X | Codec X-ray strip on or off |
| { / } | Previous / next keyframe |
| PageUp / PageDown | Previous / next chapter (PageUp goes to the start of the current chapter first) |

## Subtitles and audio

| Key | Action |
|---|---|
| C | Subtitles on / off (with none: the Subtitles panel, to load a file) |
| V | Next subtitle track, then off |
| Shift+V | Subtitles off / on |
| G / H | Subtitle delay −50 ms / +50 ms |
| Shift+A or # | Next audio track |

## Mouse

| Mouse | Action |
|---|---|
| Click the picture | Play or pause (or close an open panel) |
| Shift+drag a video from the Explorer onto the picture | Compare with it (VS Code only hands drops to the player while Shift is held) |
| Double-click the picture | Fill the editor |
| Wheel, while paused | Step frames |
| Ctrl+wheel (or pinch) | Zoom around the cursor, in any picture size; drag to pan when the picture is larger than the player (a click without moving still plays or pauses) |
| Hover the seek bar | Thumbnail and time |
| Click the time | Time → timecode → frame number |
| Wheel over the speed button | Speed ±0.05 |
| Wheel over the volume | Volume ±5 % |
| Drag the seek bar or the volume | Keeps following the mouse while the button is held, also off the slider |
| X-ray strip | Hover for details, click to go there, wheel to zoom, Shift+wheel to pan, double-click to zoom out |

## Right-click menu

Right-clicking the player opens VS Code's own context menu (no Cut / Copy / Paste) with quick actions on this moment, like a browser's or YouTube's: **Play** / **Pause**, **Loop** (✓ when on), then **Set Loop Start (A)**, **Set Loop End (B)** and **Clear A-B Loop** (while a loop is set), then **Copy Frame**, **Save Frame as PNG…**, **Copy Timestamp**, then **Compare With…** (video files only), then **Keyboard Shortcuts** and **Settings…** (opens the ⚙ panel). The frame link is `Shift+C`. How it plays (speed, sound, subtitles, tools) is in the ⚙ panel. The entries only run on the player in focus; they are hidden from the Command Palette. Needs VS Code 1.82 or later (the extension's minimum); details in `docs/notes/context-menu.md`.

Frame numbers are the ones the player shows: `#1` is the first frame.

## Keys in compare

The player's keys, for all videos at once, plus:

| Key | Action |
|---|---|
| Space / K | Play or pause all |
| , / . | Previous / next frame of the clock video (the others follow) |
| ← / →, Shift+← / →, Ctrl+← / → | The player's jump sizes, on the clock video |
| - / + | Offset of the video under the pointer, one frame (10 ms when its offset is in ms) |
| X | Swap sides (2 videos) |
| ← / → on the focused split divider | Move it by 1 % (Shift: 10 %); Home / End |
| Z | Picture size for all videos: Fit, Fill, Stretch, 100 %, then Fit; zoomed in, back to Fit first |
| Ctrl+wheel, drag | Zoom and pan all videos together (the same part of every picture) |
| Ctrl+C | Copy the view (all videos) |
| I | About these videos (a tab per video) |
| Shift+< / >, ↑ / ↓, M, R, F, ?, Esc | Speed, volume, mute, loop, fullscreen, shortcuts, close (as in the player) |
