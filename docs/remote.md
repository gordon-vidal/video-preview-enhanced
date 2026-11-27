# Remote: WSL, SSH and containers

The extension runs where the workspace is (a workspace extension). It reads the video file there in blocks, on request: 1 MB locally, 4 MB over remote connections, with 4 blocks requested ahead. The player in the editor, on your machine, does the decoding. Only compressed file data crosses the connection: about 1 MB/s for 1080p H.264, about 5 MB/s for 4K HEVC, 15–40 MB/s for ProRes.

| | WSL | Remote-SSH | Dev containers, Codespaces |
|---|---|---|---|
| Built-in decoder | Yes, tested at 30 fps (2026-11-18) | Yes, tested over loopback at 30 fps (2026-11-18) | Expected to work (same design), not tested |
| Native ffmpeg | Yes: the Linux ffmpeg inside WSL, shown at up to 720p | No: raw frames are too big for the link | No |
| Remote stream (`remoteStream: auto`) | Only when native ffmpeg doesn't play the file | Earlier Remote-SSH loopback run (2026-11-19): 4K HEVC 10-bit at 29 fps with the stream and 7.5 fps in WebAssembly | Expected to work, not tested |
| Live reload | Yes; for `/mnt/c` paths, change events can be unreliable | Yes | Not tested |

The current desktop run also showed 30 fps for the 4K HEVC 10-bit fixture with `remoteStream: on` and libx264 in a local window.

During single-player Live transcode playback, quality upgrades, bitrate cap changes and larger picture sizes can switch to a pre-started encoder while the audio continues. If the replacement cannot start or misses the switch point, the video encoder restarts at the next frame. Quality drops on a slow link restart immediately.

If the Opus sound process fails, Live transcode retries sound in PCM. If the PCM process also fails, playback continues without sound and shows a notice.

Live transcode keeps recently played regions in host memory. Jumping back to a cached region can reuse its picture and sound without starting ffmpeg. Playback resumes transcoding as it runs past the cached data. If a Direct Stream seek lands where the video decoder cannot start, Live transcode re-encodes the picture so playback can resume.

A paused jump to a place the host does not hold yet does not start a new ffmpeg either: the host keeps one ffmpeg
running for the video (in Compare, for the video that sets the clock) and feeds it the source from the jump's keyframe,
so the jump skips ffmpeg's start-up (opening the file and the GPU), about 0.1-0.3 s per jump on a 4K HEVC source. It
lands on the same frame as before. It applies to H.264 and HEVC sources with a constant frame rate, encoded with x264
or NVENC; it stops after 60 s unused, when the video is hidden or reaches its end, and it counts as one of the
`gpuEncoderSessions` (with none free, jumps start ffmpeg as before). A seek while playing starts ffmpeg as before.

In Auto resolution, a new single-video tab can start at the quality recently used on the same remote connection. That memory expires after ten minutes and clears when the extension host restarts. Remote playback buffers further ahead when memory allows and waits for sustained recovery before raising quality after a drop.

When the link runs out of buffered picture, the playback clock holds near the last frame until picture data
arrives. Remote Live transcode sends at most 128 KiB of video payload per reply. Large encoded frames arrive
over several replies, so a seek can interrupt delivery between pieces.

- **Remote stream:** in a remote window, a file VS Code's GPU decoder can't play (anything but 8-bit H.264 and VP8) is decoded by ffmpeg on the remote machine, scaled to `nativeMaxHeight` and re-encoded as low-latency H.264, which the editor decodes on the GPU. Sound is sent uncompressed (PCM, about 3 Mb/s). On a slow connection the picture steps down to 720p, 480p or 360p (about 3, 1.2 and 0.45 Mb/s plus the sound) and back up when the connection allows, with a short notice; a slow remote CPU does not count as a slow connection. ⚙ › Live transcode › Resolution fixes this video at one height instead (the connection no longer changes it; **Save … as default** for new tabs, setting `transcodeResolution`); Auto returns to the automatic steps. Below what 360p with its sound needs (about 3.5 Mb/s for a file with sound), the stream stays at 360p and says playback may stutter; it doesn't switch to the built-in decoder, which would need the whole file over the same connection. It uses the remote's GPU encoder (NVENC, Quick Sync, AMF, VAAPI) when one works there, else x264. It needs ffmpeg on the remote machine (`ffmpegPath` in the remote's settings, or PATH). Set `videoPreviewEnhanced.remoteStream` to `off` in the remote's settings for the built-in decoder. As with native ffmpeg, the picture is 8-bit and scaled: pixel tools switch the tab to the built-in decoder.
- A real network with 50–100 ms latency will start and seek more slowly than a local file.
- vscode.dev and other browser-only VS Code setups are not supported.
