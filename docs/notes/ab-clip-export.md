# Export A–B as video

QA can sync a reference and a test render in Compare, mark and loop a
discrepancy, then share one lossless clip per tile to reopen together at time zero. The single
player saves one clip. Copy original streams even during Live transcode. Scope is one range,
with timelines, multiple segments, effects and a re-encoded composite deferred.

## Controls and flow

```text
Seek bar          |------- A [==========] B ---------|
Settings          A-B loop        00:12.400 – 00:15.200
                  Tools           [Export A–B Clips…]
Export            Pick a folder   [Export here]
Result            A_reference_A-B.mp4    B_test_A-B.mov
```

- Reuse **A** and **B**, including press again to clear and swapping reversed markers.
  Add the existing seek-bar marks, Settings **A-B loop** row and shortcut entries to Compare.
  Wrap the shared loop by seeking the clock and following the normal lockstep path.
- Put **Export A–B Clip…** (`videoPreviewEnhanced.exportVideoRange`) in the single player's Details
  overlay, Settings › Tools and Command Palette. Compare has **Export A–B Clips…**
  (`videoPreviewEnhanced.exportCompareVideoRange`) in Settings › Tools and the palette. Each command
  targets the active editor and prompts for missing markers. Tab reaches both controls and
  Enter/Space activate them. Name the export button **Export A–B Clip…** or, in Compare,
  **Export A–B video for all Compare tiles**. Give **A-B loop** accessible text for marker
  values and announce changes and results through the status region.
  [Compare UI](compare-ui.md) · [Context menu](context-menu.md)
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
clamping would shift sync. [Compare timing](../../media/compare-sync.js)

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
needed by B. Shorten the movie and track edits to the presentation boundary after B, leaving
the copied packets intact. The exact path publishes only after the decoded timeline and both
boundary hashes match the source. Timed-text cues keep their original payloads and are clipped to the marked interval
before muxing. PCM tracks use their original sample format with sample-accurate trimming. Compressed
audio stays stream-copied, and output with decoded samples outside the marked interval fails exact
verification. If an H.264 open GOP fails picture verification, retry with earlier preroll and an
edit that starts at A. Advertise the earlier sync sample so readers decode its references.
The keyframe path requires confirmation of both measured boundaries.

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
  The hidden VS Code WebCodecs path honours the demuxer's discard flag for decode dependencies.
  QuickTime Player, VLC, Chrome/Edge, Safari and Firefox playback accuracy is unverified.
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

- The exact path must show A through B inclusive. Keep native-only stream copy. Exactness is
  checked using the installed native decoder with edit lists enabled.
- Prefer MP4 remux for compatible streams from other containers. Offer single-player keyframe
  cuts in supported source containers with measured deviations and explicit confirmation.
- Compare lists ineligible tiles and asks before saving the eligible clips. Report alignment
  differences when mixed frame rates or fractional offsets land between source pictures.

## Verification on Windows

FFmpeg 9.0.2 decoded the 25 fps B-frame fixture from A at 1.600 s through B at 2.760 s
with both boundaries matching and 30 visible pictures in MP4 and MOV. H.264/AAC MKV
and VP9 WebM also matched after remux to MP4. One-frame intervals, VFR and an MP4
with a 3600 s timestamp origin matched. Reopening the MP4 and MOV exports in hidden
VS Code showed A at the start and B after pressing End. AVI with MPEG-4 B-frames passed for some
ranges and failed exact verification for others. The MKV/SubRip fallback trial
reported a 0.600 s early start, a 0.120 s late end and one omitted intervening picture.
The test fixture is generated with FFmpeg's `testsrc2` and `sine` filters.

## Open questions

- For mixed-rate Compare clips, preserve the mapped time origin with an edit as specified above, or
  start at each tile's independently snapped picture and report the differences. The implementation
  currently snaps independently. The maintainer decision is pending.

Exact clip export requires the picture's source timestamp. The built-in decoders have it. Native ffmpeg
reports it per picture ([native-source-pts.md](native-source-pts.md)), so its marks are exact too, in the
single player and in Compare tiles. Live transcode re-times pictures; marks set during it are ineligible and
are refused early: the page shows a notice with **Use original video** when A or B is set on such a picture and
when the clip is asked for, and the host repeats the check (a warning with the same button, switching every
transcoded tile in Compare) before any ffmpeg work. A native ffmpeg that cannot report timestamps (older than 5.1,
or stamps that do not follow the pictures) falls back to counting slots; its marks are refused the same way with
a **Switch to built-in decoder** button.
