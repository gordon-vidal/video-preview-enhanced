# FAQ and troubleshooting

## Can VS Code play MKV, MOV, AVI, or HEVC videos?

VS Code's built-in preview only plays MP4 and WebM with limited codec support. **Video Preview Enhanced** plays all major formats with sound—including MP4, MKV, MOV, AVI, WebM, WMV, FLV, MPEG, M2TS, and MXF, with H.264, HEVC (H.265), AV1, VP9, and ProRes—using a built-in WebAssembly decoder with no extra install or admin rights. For 4K HEVC/AV1 in real time on your GPU, run **Video Preview: Set Up Optional ffmpeg**. See [Supported formats](formats.md).

## How do I watch videos in VS Code over Remote-SSH or WSL?

Double-click a video in a Remote-SSH or WSL workspace and **Video Preview Enhanced** plays it directly without downloading the file first. If FFmpeg is available on the remote host, heavy 4K or high-bitrate footage is transcoded on the fly into a lightweight H.264 stream sized to your player for smooth playback and fast seeking. See [Remote workspaces](remote.md).

## How do I compare videos frame by frame in VS Code?

Select up to 8 videos (or up to 16 with `videoPreviewEnhanced.compare.maxVideos`), right-click in the Explorer, and choose **Video Preview Enhanced: Start Compare** (or click **Compare** in the player bar). All videos play on one synchronized timeline with frame-accurate stepping, linked zoom/pan, per-video frame offsets, and side-by-side, split, or grid layouts.

## How do I step through a video frame by frame in VS Code?

Pause the video and press `,` (previous frame) or `.` (next frame), or scroll the mouse wheel while paused. You can also jump to an exact frame number or timecode, copy a link to that frame, or export frames as PNG. See [Keyboard shortcuts](keys.md).

## Why is there no sound at first?

VS Code blocks sound until you interact with the page. Click the video or press `M`.

## MP4 files open in VS Code's own preview

You may have undone the automatic default, or chosen another editor for them. See [Making it the default](commands-and-settings.md#making-it-the-default-for-mp4-and-webm), or right-click → **Open With…** → **Video Preview Enhanced**.

## The extension says another version is installed

Check the versioned Video Preview Enhanced folders in your active extensions directory, including a custom
directory set with `--extensions-dir`. Extension development sessions skip this warning.

## A 4K video plays in slow motion

The tested 4K HEVC, AV1 and VP9 clips played below their source rate in WebAssembly. See [Performance](performance.md) for frame rates. VS Code lets the player use the GPU decoder only for H.264 and VP8. ⓘ (About this video) says what plays the file and the stats overlay (`Shift+I`) shows the decoding speed; when playback falls behind, a notice offers to skip to keyframes. Or run **Set Up Optional ffmpeg** (no admin rights needed) to decode natively.

## The stats overlay says "4.5 s decoded ahead" or "Fully decoded"

While paused, the player decodes ahead within its frame memory budget so playback resumes smoothly. "Fully decoded" means the rest of the clip is in memory. (These used to be a status pill on the bar; the bar no longer shows it.)

## The player uses a lot of memory

One 4K frame in 8-bit 4:2:0 takes about 12 MB. See the measured [frame memory budgets](performance.md). Close other video tabs on 8 GB machines.

## HDR video looks dim or different from my TV

On an SDR display, HDR10 (PQ) and HLG are tone-mapped to SDR: 203 nits shows as white and highlights up to the content peak (1000 nits unless the file says otherwise) are compressed into the top of the range. On an HDR display (Windows: Settings > Display > "Use HDR") the player shows them in HDR; the stats overlay (`Shift+I`) says "HDR output" then. It decides when the video opens: reopen it after turning HDR on or moving VS Code to another display. `videoPreviewEnhanced.hdrOutput: off` always tone-maps. With HDR output, SDR white is the display's SDR brightness (Windows' "SDR content brightness"), so HDR video looks as bright as other HDR apps show it.

## A file doesn't open, or plays wrong

Run **Video Preview: Show Log** and include the log in an [issue](https://github.com/gordon-vidal/video-preview-enhanced/issues), with the output of `ffprobe` for the file if you have it.

## Does it work in Cursor, VSCodium or Windsurf?

It uses only standard VS Code APIs and needs VS Code 1.82 or later. It hasn't been tested in other editors yet.
