# Export A–B as video

**Proposal for review.** QA can sync a reference and a test render in Compare, mark and loop a
discrepancy, then share one lossless clip per tile to reopen together at time zero. The single
player saves one clip. Copy original streams even during Live transcode. Scope is one range,
with timelines, multiple segments, effects and a re-encoded composite deferred.

## Controls and flow

```text
Seek bar          |------- A [==========] B ---------|
Settings          A-B loop        00:12.400 – 00:15.200
                  Tools           [Export Video (A–B)…]
Export            Pick a folder   [Export here]
Result            A_reference_A-B.mp4    B_test_A-B.mov
```

- Reuse **A** and **B**, including press again to clear and swapping reversed markers.
  Add the existing seek-bar marks, Settings **A-B loop** row and shortcut entries to Compare.
  Wrap the shared loop by seeking the clock and following the normal lockstep path.
- Put **Export Video (A–B)…** in Settings › Tools and the Command Palette as
  **Video Preview: Export Video (A–B)…** (`videoPreviewEnhanced.exportVideoRange`). The command
  targets the active editor and prompts for missing markers. Tab reaches both controls and
  Enter/Space activate them. Name the export button **Export Video (A–B)** or, in Compare,
  **Export A–B video for all Compare tiles**. Give **A-B loop** accessible text for marker
  values and announce changes and results through the status region. Keep export in the
  panel and palette. [Compare UI](compare-ui.md) · [Context menu](context-menu.md)
- Pick a folder, defaulting to the source's parent (the clock video's in Compare). Snapshot
  the range, sources, offsets and order. Save `<name>_A-B.<ext>` or `<letter>_<name>_A-B.<ext>`.
  Show cancellable progress, remove temporary files on cancel/error and avoid overwrites.
  Report the folder, omissions, failures and measured deviations per tile, e.g.
  **B starts 0.4 s early (keyframe)**. Flag when time zero differs across clips.

## Range and stream copy

Use the shown frames' source presentation timestamps (including VFR). B is inclusive through
the next presentation timestamp or the last sample's end. Store markers as
`clockTime - clockOffset` so clock changes and reordering preserve them. Add each tile's
offset to both endpoints, using seconds or frames divided by that tile's fps. Match the
lockstep frame selection, preserve the mapped time origin and report alignment deviations.
Flag out-of-bounds tiles and ask before exporting just the eligible ones. Independent
clamping would shift sync. [Compare timing](../../media/compare.js)

**MP4/MOV.** Input `-ss` retains the preceding random-access point and preroll under stream copy.
Convert A to the demuxer's seek origin using the format and video start times.
`-avoid_negative_ts disabled` preserves timestamps for `-use_editlist 1` to map movie time
zero to A. `+faststart` moves metadata to the front of the non-fragmented file. Below, stream
0 is the viewed video, A is 1.600 s and the boundary after B is 2.800 s. The first line is for
MP4/MOV (use the matching extension), the second for MKV/WebM/AVI or another verified
same-container muxer. Output `-t` is a candidate duration cap.
[FFmpeg seeking and stream mapping](https://ffmpeg.org/ffmpeg.html) ·
[FFmpeg muxer options](https://ffmpeg.org/ffmpeg-formats.html)

```sh
ffmpeg -nostdin -n -ss 1.600 -protocol_whitelist file -i source.mp4 -map 0:0 -map '0:a?' -map '0:s?' -map_chapters -1 -c copy -t 1.200 -avoid_negative_ts disabled -use_editlist 1 -movflags +faststart clip.mp4
ffmpeg -nostdin -n -ss 1.600 -protocol_whitelist file -i source.mkv -map 0:0 -map '0:a?' -map '0:s?' -map_chapters -1 -c copy -t 1.200 -avoid_negative_ts make_zero clip.mkv
```

**Measured 2026-11-22 on Windows with FFmpeg 9.0.2.** On a generated 25 fps H.264/AAC fixture with B-frames,
the first decoded frame of both MP4 and MOV matched A by frame hash, and MP4 had video and audio
`elst` entries. Ignoring the MP4 edit list exposed the earlier keyframe. Using `make_zero` in MP4
also exposed it. The MP4/MOV video ended two frames late (1.280 s vs 1.200 s), and the audio track
ran to 1.216 s. The same start worked when remuxing the fixture from MKV to MP4. Same-container
copies of the MKV, a VP9 WebM and an MPEG-4 AVI began at the keyframe, 0.600 s before A.

**B is a presentation boundary.** Packet-order `-t` can retain later pictures or lose references
needed by B. Keep those dependencies and verify the visible interval. If ffmpeg's mux cannot
express the end, prototype bounding each MP4/MOV track's edit duration, including audio and
subtitle cues across B. Require confirmation before publishing a copy with a measured end
deviation, including on the keyframe path.

**Container choice.** Prefer verified MP4 remux for compatible non-MP4/MOV sources. Otherwise offer
a warned, same-container keyframe cut if the muxer supports the tracks. Copy the displayed video and
all embedded audio and subtitles by default. Offer **Drop audio** and **Drop subtitles** (omit the
respective maps) and name incompatible tracks before asking to drop them. External sidecars are
out of scope. Verify dependencies such as embedded Matroska subtitle fonts.

## Host and verification

Run native ffmpeg/ffprobe on the workspace extension host (local, WSL or SSH) and write directly
to the chosen folder on that host. Reuse `tools()` (configured path, host-managed build, PATH),
file/manifest checks and hidden argv-based spawning. If tools are missing, explain the native
requirement and offer **Set Up Optional ffmpeg** on that host. Restricted Mode, URLs and image
sequences are ineligible. [Tool discovery](../../src/ffmpeg.js) ·
[Setup](../ffmpeg.md) · [Remote](../remote.md)

- **Probe.** Use `ffprobe -v error -show_format -show_streams -of json clip.mp4` for duration
  and stream counts/codecs. Use `ffprobe -v trace -show_streams clip.mp4` for `elst` media time
  and segment duration. Compare `-show_packets` / `-show_frames` with and without
  `-ignore_editlist 1` for MP4/MOV. Hash the first and last displayed frames against the source,
  and check audio alignment, subtitle timing and duration. Cover on/off-keyframe, one-frame,
  nonzero start, VFR, B-frames, multiple tracks and incompatible subtitles.
  [ffprobe options](https://ffmpeg.org/ffprobe.html)
- **Players.** An edit-aware player with codec support should start on A. QuickTime specifies
  the mapping and VLC enables edit lists by default. Chromium has had preroll discard issues.
  Test first visible frames in QuickTime Player, VLC, Chrome/Edge, Safari, Firefox and hidden
  VS Code (GPU, built-in and native). Playback accuracy is unverified for these versions.
  Readers that ignore the edit may show the earlier keyframe.
  [QuickTime edit list](https://developer.apple.com/documentation/quicktime-file-format/edit_list_atom) ·
  [VLC MP4 demuxer](https://github.com/videolan/vlc/blob/master/modules/demux/mp4/mp4.c) ·
  [Chromium preroll issue](https://issues.chromium.org/issues/41322791)
- **Automation.** Unit-test a Node-loadable command and offset module for argv, maps, signed
  offsets, mixed rates, clock changes and bounds. Add hidden VS Code single export cases
  (palette/button, missing tools, fallback, cancel) and Compare cases (markers, looping,
  reorder, offsets, output and report). Check write location in WSL and SSH. Run
  `compare`/`multiview` for lockstep, `ui` for a11y and `scopes-export` for PNG regression.
  [Testing strategy](../TESTING.md)

## Product fit and decisions

No conflict found in [PRODUCT.md](../PRODUCT.md). The no-install pitch covers playback, and its
pixel-tool and Live transcode export rules cover still frames. The earlier Compare mock-up
omitted A–B, which this proposal adds to the shared transport. Clarify clip versus
[PNG export and command copy](../features.md) if approved. The existing
[`rangecmd.js`](../../src/rangecmd.js) commands retain their behavior.

1. May an exact-start clip ship with a confirmed, reported end deviation, or must B be exact
   before the feature ships?
2. Is MP4 remux the preferred default for compatible non-MP4/MOV sources, with same-container
   keyframe cuts opt-in? Which playback versions must pass before we call the start exact?
3. Should Compare allow explicitly skipping ineligible tiles as proposed, or require a complete
   aligned set before writing any clips?
