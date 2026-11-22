# Test inventory (2026-11-20)

Where every test that existed before the four layers of [docs/TESTING.md](../TESTING.md) lives now, and what
it proves. Nothing was dropped silently: the few checks that were removed or changed are listed under
[Dropped or changed on purpose](#dropped-or-changed-on-purpose) with the reason.

Reference: the last full run of the old runner (`test/vscode/run.js --quick`, 2026-11-20 14:04, 236 results,
47 min, one fresh VS Code per case). A full (non-quick) run also has 12 more `play/*` clips and one more
`native/*`. The opt-in benchmarks (environment switches) are listed too.

## Summary

| Layer | Before | Now | Command |
|---|---|---|---|
| 1. Unit | 56 host tests (`test/host/run_all.js`, one at a time, ~90 s) + `test/engine/unit.js`; `test/inspect`, `test/subtitles` (2), `test/timestretch`, `test/avi_test.js` run by hand | 65 files, all in parallel: the same tests (the two AVI tests now get the generated AVI clips as arguments) plus `test/unit/abloop_test.js` and `test/unit/timefmt_test.js` for logic moved out of `media/player.js` | `node test/run.js unit` |
| 2. Engine | `test/tracks/run.js`, `test/bitmapsubs/run.js` (passing); `test/tracks/engine_smoke.js`, `test/thumbs/service.js` (failing); `test/xray/index_test.js`, `test/pool/harness.js` (printed, never failed) | 13 files in parallel: those six (fixed, with exit codes) plus `test/engine/frames_*.js` (4) and `test/engine/formats_*.js` (3): the WebAssembly frame checks of the seeking case and every format of the test media, through `media/engine.js` in Node | `node test/run.js engine` |
| 3. VS Code | the suite (wcprobe, play/*, native/*) and 59 cases, ~250 results, 61 fresh instances per run | 21 scenarios (one instance each, several cases per instance), correctness only | `node test/run.js vscode` |
| 4. Performance | startup / memory / cpu_4k / perf-invisible bench / transfer bench cases mixed into the functional run; the fps of `play/*`; Node benchmarks run by hand through `test/benchq.js` | `test/perf/run.js`: 27 VS Code benches (each in a fresh instance; 4 more with `VPE_TRANSFER_CLIPS`) and 3 Node benches, compared with the previous stored numbers, under the benchmark lock | `node test/run.js perf` |

Result counts of the table below (275 rows: the 236 of the reference run, 14 full-run-only clips, 25 opt-in
benchmark results): layer 2 is the home of 11 of them, layer 3 of 226 (several also checked again in layer 2),
layer 4 of 38. In layer 3, 12 results of the seeking case left for layer 2 (the WebAssembly clips) and the
numbers of 14 cases left for layer 4.

### Layers 1 and 2, file by file

| File | Layer | Proves | Notes |
|---|---|---|---|
| `test/host/*_test.js` (56) | 1 | the extension host's logic against a mock `vscode` (decoder choice, probe, ffmpeg tools and setup, native transport, URLs and HLS, remote stream, compare, context menu, icons, onboarding, security) | 20 of them run real ffmpeg and print "skipped" without it; `avi_scan_test` and `wav_parts_test` checked nothing without arguments: they get `s_mjpeg.avi` / `s_xvid.avi` / `h264_aac.avi` now |
| `test/engine/unit.js` | 1 | engine / pool / timestretch / membudget logic with stubs, no WebAssembly | |
| `test/inspect/inspect_test.js` | 1 | pixel inspector helpers | |
| `test/subtitles/run.js`, `sidecars.js` | 1 | subtitle parsers; sidecar discovery (partly the same as `host/sidecars_test`) | |
| `test/timestretch/run.js` | 1 | the time stretcher (speed 0.25-4x) | |
| `test/avi_test.js` | 1 | the AVI index and the standard DHT table, MJPEG frames against ffmpeg | needs an MJPEG AVI: gets `s_mjpeg.avi` |
| `test/unit/abloop_test.js`, `timefmt_test.js` | 1 | new: `media/abloop.js` (A-B loop) and `media/timefmt.js` (time labels, frame counter), moved out of `media/player.js` unchanged | before: only the VS Code cases `seeking/abloop`, `ui/time/formats`, `seeking/step-ms-rounded` (counter) |
| `test/engine/frames_hevc_vp9.js`, `frames_mpeg2_prores.js`, `frames_mpeg4_h264.js`, `frames_edges.js` | 2 | new: step, seek (also while playing), ms-rounded 60 fps and NTSC, End with longer sound, edges, end of file, A-B loop, open-GOP: the engine says frame k and the picture is ffmpeg's frame k | `test/engine/harness.js` runs `media/engine.js` with the real decoder worker / pool and a stub WebGL that keeps the luma plane |
| `test/engine/formats_cases.js`, `formats_media.js`, `formats_4k.js` | 2 | new: every clip of the open-and-play set (`test/media/cases/fmt`), the start-at-3600 / multichannel / rotated / gapped clips, the 1080p clips and the container set of `test/media`: first picture = ffmpeg's, a seek = ffmpeg's frame, sound decodes; 4K: first picture | |
| `test/tracks/run.js` | 2 | track lists, stream discard, audio switching, embedded subtitles, open-GOP seeks in the decoder worker | ~60 s, the longest file of the layer |
| `test/tracks/engine_smoke.js` | 2 | the engine switching sound and subtitle tracks; open-GOP fallback with a WebCodecs stand-in | fixed: its fake AudioContext had no `suspend()` (the engine rests the AudioContext while paused since f97fd39), so it crashed after 11 checks |
| `test/bitmapsubs/run.js` | 2 | PGS / DVD / DVB picture subtitles: cue index and palette | |
| `test/xray/index_test.js` | 2 | the X-ray packet index against ffprobe, sequential and shuffled reads | `--check`: exit 1 on any difference (it only printed before) |
| `test/pool/harness.js` | 2 | the decoder pool gives the same frames and seeks as one worker | `--check`: exit 1 on a difference; its fps / memory figures are not judged |
| `test/thumbs/service.js` | 2 | seek-bar thumbnails: a sweep ends on the last place with few decodes, neighbours of a resting pointer, not while busy, not remote, cache, nothing after leaving | rewritten for hover-only thumbnails (see below) |

Tools, not tests (unchanged): `test/benchq.js`, `test/loadmon.js`, `test/urlserver.js`, `test/media/make_*.js`,
`test/media/fetch_sources.js`, `test/tracks/make_media.js`, `test/bitmapsubs/make_media.js`, `test/zoo/*`,
`test/compare/*` (competitor research), `test/tracks/driver.js`, `test/pool/worker-shim.js`,
`test/host/mock_vscode.js`. Benchmarks run by hand (layer 4 tools, not in the default set because they print
tables, not JSON): `test/perf/frame_path.js`, `test/perf/browser_path.js` (needs Edge), `test/perf/bitrate_model.js`,
`test/tracks/measure.js`.

## Dropped or changed on purpose

1. **Idle prefetch of seek-bar thumbnails** (`test/thumbs/service.js`: "idle prefetch ran", "no prefetch while busy"):
   the behaviour was removed in bff54bc (nothing decodes in the background on its own, docs/PRODUCT.md). Replaced by
   checks of today's behaviour: neighbours filled only while the pointer rests, none while busy or remote, nothing
   after the pointer leaves.
2. **"Fewer requests than pointer moves"** (same file): each move sends a newer request that supersedes the running
   one by design, so requests can outnumber moves. The cost the check meant is decoding: it now checks
   "few decodes" (3 for 60 positions).
3. **4K seeks in layer 2**: WebAssembly 4K in Node takes minutes per seek, so layer 2 checks only the first 4K
   picture; the paused 4K seek spot checks stay in layer 3 (`open-formats`, `play/*_2160p*`).
4. **Speed thresholds in layer-3 cases** (see the Notes column): frame-count floors, "within 4 s", 15 % rate
   tolerance and fixed sampling windows became correctness checks with generous waits that end as soon as the
   condition holds; the numbers are layer 4 now. Under load a correct player is no longer a failed test.
5. **The old runner's levels** (`--quick` / full in `test/vscode/run.js`): replaced by layer 3 (correctness) and
   layer 4 (numbers); `--activation` (how a file on the first command line opens) is kept as a tool,
   `test/vscode/activation.js`.
6. **`test/host/run_all.js`**: replaced by `node test/run.js unit` (parallel, same job objects and timeouts).

## Known issues found while porting

Both fixed (branch `fix/engine-frame-count`): the engine takes the frame rate / count the container states
(`avg_frame_rate`, MP4 sample table) at open, and a short file without a rate gets it from its timestamps at the
end of the file. Checks: `test/engine/frames_edges.js` `end-at-open/` and `short-no-rate/`.

## Every VS Code result

`Lives now`: `L2 file (result)` = the check runs in Node; `L3 scenario/case/result` = a layer-3 result name;
`L4 bench` = a layer-4 bench in `test/perf/benches.js`. "relaxed" = a speed threshold taken out (item 4 above).
| Old result (run 2026-11-20T14-04) | Lives now | Notes |
|---|---|---|
| `wcprobe` | L3 `open-formats/open-formats/wcprobe` |  |
| `play/h264_aac_anim_1080p.mp4` | L3 `open-formats/open-formats/play/h264_aac_anim_1080p.mp4` | fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/hevc_8_1080p.mp4` | L3 `open-formats/open-formats/play/hevc_8_1080p.mp4` | fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `native/hevc_10_1080p.mp4` | L3 `native/open-native/native/hevc_10_1080p.mp4` | fps: L4 play-fps |
| `case/compare_metrics/same-file` | L3 `compare/compare_metrics/same-file` |  |
| `case/compare_metrics/lowq-vs-ffmpeg` | L3 `compare/compare_metrics/lowq-vs-ffmpeg` |  |
| `case/compare_metrics/offset-3` | L3 `compare/compare_metrics/offset-3` |  |
| `case/compare_ui/enter/in-place` | L3 `compare/compare_ui/enter/in-place` |  |
| `case/compare_ui/bar` | L3 `compare/compare_ui/bar` |  |
| `case/compare_ui/panel/compare` | L3 `compare/compare_ui/panel/compare` |  |
| `case/compare_ui/panel/video-page` | L3 `compare/compare_ui/panel/video-page` |  |
| `case/compare_ui/tiles/pills-and-nudge` | L3 `compare/compare_ui/tiles/pills-and-nudge` |  |
| `case/compare_ui/view/split` | L3 `compare/compare_ui/view/split` |  |
| `case/compare_ui/tiles/menu` | L3 `compare/compare_ui/tiles/menu` |  |
| `case/compare_ui/grid/three` | L3 `compare/compare_ui/grid/three` |  |
| `case/compare_ui/leave` | L3 `compare/compare_ui/leave` |  |
| `case/ctxmenu/context/attribute` | L3 `ui/ctxmenu/context/attribute` |  |
| `case/ctxmenu/commands/transport` | L3 `ui/ctxmenu/commands/transport` |  |
| `case/ctxmenu/commands/help` | L3 `ui/ctxmenu/commands/help` |  |
| `case/ctxmenu/commands/ab-loop` | L3 `ui/ctxmenu/commands/ab-loop` |  |
| `case/ctxmenu/commands/frame` | L3 `ui/ctxmenu/commands/frame` |  |
| `case/file_icons/mkv-opens-in-player` | L3 `file-icons/file_icons/mkv-opens-in-player` |  |
| `case/file_icons/associations-written` | L3 `file-icons/file_icons/associations-written` |  |
| `case/file_icons_pixels_dark-100/icons-equal-seti-mp4` | L3 `file-icons/file_icons_pixels_dark-100/icons-equal-seti-mp4` |  |
| `case/file_icons_pixels_light-100/icons-equal-seti-mp4` | L3 `file-icons/file_icons_pixels_light-100/icons-equal-seti-mp4` |  |
| `case/file_icons_pixels_dark-120/icons-equal-seti-mp4` | L3 `file-icons/file_icons_pixels_dark-120/icons-equal-seti-mp4` |  |
| `case/file_icons_pixels_dark-m1/icons-equal-seti-mp4` | L3 `file-icons/file_icons_pixels_dark-m1/icons-equal-seti-mp4` |  |
| `case/file_icons_pixels_dark-z2/icons-equal-seti-mp4` | L3 `file-icons/file_icons_pixels_dark-z2/icons-equal-seti-mp4` |  |
| `case/hdr_output/probe` | L3 `hdr/hdr_output/probe` |  |
| `case/hdr_output/sdr` | L3 `hdr/hdr_output/sdr` |  |
| `case/hdr_output/dv/dv81` | L3 `hdr/hdr_output/dv/dv81` |  |
| `case/hdr_output/dv/dv84` | L3 `hdr/hdr_output/dv/dv84` |  |
| `case/hdr_output/dv/dv5` | L3 `hdr/hdr_output/dv/dv5` |  |
| `case/hdr_output_forced/pattern/pq` | L3 `hdr/hdr_output_forced/pattern/pq` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced/pattern/hlg` | L3 `hdr/hdr_output_forced/pattern/hlg` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced/pattern/dv81` | L3 `hdr/hdr_output_forced/pattern/dv81` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced/play/hevc_10_pq_2160p` | L3 `hdr/hdr_output_forced/play/hevc_10_pq_2160p` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced/play/hevc_10_hlg_2160p` | L3 `hdr/hdr_output_forced/play/hevc_10_hlg_2160p` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced_native/pattern/pq` | L3 `hdr/hdr_output_forced_native/pattern/pq` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced_native/pattern/hlg` | L3 `hdr/hdr_output_forced_native/pattern/hlg` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced_native/pattern/dv81` | L3 `hdr/hdr_output_forced_native/pattern/dv81` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced_native/play/hevc_10_pq_2160p` | L3 `hdr/hdr_output_forced_native/play/hevc_10_pq_2160p` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/hdr_output_forced_native/play/hevc_10_hlg_2160p` | L3 `hdr/hdr_output_forced_native/play/hevc_10_hlg_2160p` | relaxed: >= 10 frames in 3 s -> >= 2 (frames presented) |
| `case/inspect/goto` | L3 `inspect/inspect/goto` |  |
| `case/inspect/pixel` | L3 `inspect/inspect/pixel` |  |
| `case/inspect/pixel/sd-709` | L3 `inspect/inspect/pixel/sd-709` |  |
| `case/inspect/zoom` | L3 `inspect/inspect/zoom` |  |
| `case/inspect/stats` | L3 `inspect/inspect/stats` |  |
| `case/inspect/links/open-url` | L3 `inspect/inspect/links/open-url` |  |
| `case/inspect/hdr/pq` | L3 `inspect/inspect/hdr/pq` |  |
| `case/inspect/hdr/hlg` | L3 `inspect/inspect/hdr/hlg` |  |
| `case/inspect/hdr/h264-pq` | L3 `inspect/inspect/hdr/h264-pq` |  |
| `case/inspect/hdr/sdr-unchanged` | L3 `inspect/inspect/hdr/sdr-unchanged` |  |
| `case/inspect/thumbs/seek-bar` | L3 `inspect/inspect/thumbs/seek-bar` |  |
| `case/inspect/xray/strip` | L3 `inspect/inspect/xray/strip` |  |
| `case/keyconflicts/read` | L3 `inspect/keyconflicts/read` |  |
| `case/keyconflicts/player-keys-free` | L3 `inspect/keyconflicts/player-keys-free` |  |
| `case/keyconflicts/avoided-keys-taken` | L3 `inspect/keyconflicts/avoided-keys-taken` |  |
| `case/modes/layout/bar` | L3 `compare/modes/layout/bar` |  |
| `case/modes/layout/tool-keys` | L3 `compare/modes/layout/tool-keys` |  |
| `case/modes/layout/controls` | L3 `compare/modes/layout/controls` |  |
| `case/modes/layout/tools-grid` | L3 `compare/modes/layout/tools-grid` |  |
| `case/modes/compare/views` | L3 `compare/modes/compare/views` |  |
| `case/multiview-short-loop/follower` | L3 `multiview/multiview-short-loop/follower` | relaxed: 3 loops within 25 s -> within 60 s |
| `case/multiview/grid/three-then-add` | L3 `multiview/multiview/grid/three-then-add` |  |
| `case/multiview/grid/four-play` | L3 `multiview/multiview/grid/four-play` | relaxed: >= 10 frames per tile in 1.3 s -> >= 3 per tile within 20 s |
| `case/multiview/sync/lockstep` | L3 `multiview/multiview/sync/lockstep` |  |
| `case/multiview/sync/offsets` | L3 `multiview/multiview/sync/offsets` |  |
| `case/multiview/sync/clock` | L3 `multiview/multiview/sync/clock` |  |
| `case/multiview/sync/sound` | L3 `multiview/multiview/sync/sound` |  |
| `case/multiview/sync/panel` | L3 `multiview/multiview/sync/panel` |  |
| `case/multiview/sync/clock-while-playing` | L3 `multiview/multiview/sync/clock-while-playing` |  |
| `case/multiview/sync/remove-clock` | L3 `multiview/multiview/sync/remove-clock` |  |
| `case/multiview/pair/views-and-offset` | L3 `multiview/multiview/pair/views-and-offset` |  |
| `case/multiview-native/native/tile-size` | L3 `multiview-native/multiview-native/native/tile-size` |  |
| `case/multiview-native/native/frame-server` | L3 `multiview-native/multiview-native/native/frame-server` |  |
| `case/multiview-native/native/play` | L3 `multiview-native/multiview-native/native/play` | relaxed: >= 10 frames per tile in 1.3 s -> >= 3 per tile within 20 s |
| `case/multiview-native/native/lockstep` | L3 `multiview-native/multiview-native/native/lockstep` |  |
| `case/multiview-native/native/resize-and-budget` | L3 `multiview-native/multiview-native/native/resize-and-budget` |  |
| `case/multiview-native/native/seek-through-resize` | L3 `multiview-native/multiview-native/native/seek-through-resize` |  |
| `case/multiview-native-fallback/native/frame-server-403` | L3 `multiview-native/multiview-native-fallback/native/frame-server-403` |  |
| `case/native-transfer/hevc_10_2160p.mp4` | L3 `native/native-transfer/hevc_10_2160p.mp4` | numbers: L4 native-transfer |
| `case/native-transfer-resize` | L3 `native/native-transfer-resize` | numbers: L4 native-transfer; relaxed: grow / zoom within 4 s -> within 30 s (growMs, zoomMs recorded for layer 4) |
| `case/native-transfer-fallback/hevc_10_2160p.mp4` | L3 `native/native-transfer-fallback/hevc_10_2160p.mp4` |  |
| `case/onboarding-ffmpeg/decision/h264_8_1080p.mp4` | L3 `onboarding/onboarding-ffmpeg/decision/h264_8_1080p.mp4` |  |
| `case/onboarding-ffmpeg/decision/hevc_8_1080p.mp4` | L3 `onboarding/onboarding-ffmpeg/decision/hevc_8_1080p.mp4` |  |
| `case/onboarding-ffmpeg/no-popup-with-ffmpeg` | L3 `onboarding/onboarding-ffmpeg/no-popup-with-ffmpeg` |  |
| `case/onboarding/popup-once` | L3 `onboarding/onboarding/popup-once` |  |
| `case/onboarding/reminder-4k-hevc10` | L3 `onboarding/onboarding/reminder-4k-hevc10` | relaxed: depends on WebAssembly 4K being slower than real time (always on these machines) |
| `case/perf-invisible/hidden-native` | L3 `invisible/perf-invisible/hidden-native` | numbers: L4 perf-invisible |
| `case/perf-invisible/audio-rest` | L3 `restore/perf-invisible/audio-rest` | numbers: L4 perf-invisible; relaxed: drift <= 100 ms -> <= 500 ms in layer 3; 100 ms judged in layer 4 (perf-invisible) |
| `case/perf-invisible/paused-readahead/native` | L3 `invisible/perf-invisible/paused-readahead/native` | numbers: L4 perf-invisible |
| `case/perf-invisible/paused-readahead/webcodecs` | L3 `invisible/perf-invisible/paused-readahead/webcodecs` | numbers: L4 perf-invisible |
| `case/perf-invisible/loop-rest` | L3 `invisible/perf-invisible/loop-rest` | numbers: L4 perf-invisible |
| `case/playback/open/fmt/h264_high10.mp4` | L3 `playback/playback/open/fmt/h264_high10.mp4` | also L2 formats_cases.js |
| `case/playback/open/fmt/h264_444.mp4` | L3 `playback/playback/open/fmt/h264_444.mp4` | also L2 formats_cases.js |
| `case/playback/open/fmt/hevc10.mp4` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/hevc10_opus.mkv` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/vp8_vorbis.webm` | L3 `playback/playback/open/fmt/vp8_vorbis.webm` | also L2 formats_cases.js |
| `case/playback/open/fmt/av1_opus.mkv` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/h264_ac3.mts` | L3 `playback/playback/open/fmt/h264_ac3.mts` | also L2 formats_cases.js |
| `case/playback/open/fmt/mpeg2_ac3.vob` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/mpeg2_interlaced.mpg` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/wmv2_wma.wmv` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/wmv2_wma.asf` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/dnxhr_pcm.mxf` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/theora_vorbis.ogv` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/flv1_mp3.flv` | L2 `test/engine/formats_cases.js` | First, advancing and sought pictures; decoded audio |
| `case/playback/open/fmt/odd_853x479.mkv` | L3 `playback/playback/open/fmt/odd_853x479.mkv` | also L2 formats_cases.js |
| `case/playback/open/fmt/h264_ac3_51.mkv` | L3 `playback/playback/open/fmt/h264_ac3_51.mkv` | also L2 formats_cases.js |
| `case/playback/open/fmt/h264_noaudio.mp4` | L3 `playback/playback/open/fmt/h264_noaudio.mp4` | also L2 formats_cases.js |
| `case/playback/open/fmt/h264_vfr.mkv` | L3 `playback/playback/open/fmt/h264_vfr.mkv` | also L2 formats_cases.js |
| `case/playback/open/audio-only` | L3 `playback/playback/open/audio-only` | relaxed: time advances at > 0.5x -> > 0.2x |
| `case/playback/rate/speed` | L3 `playback/playback/rate/speed` | relaxed: rate within 15 % -> within 35 % |
| `case/playback/neighbour/next-prev` | L3 `playback/playback/neighbour/next-prev` |  |
| `case/playback/rotation/rotated.mp4` | L3 `playback/playback/rotation/rotated.mp4` |  |
| `case/playback/status/fully-decoded-stable` | L3 `playback/playback/status/fully-decoded-stable` |  |
| `case/playback/resume/position` | L3 `playback/playback/resume/position` |  |
| `case/playback/damaged-h264/damaged_h264.mkv` | L3 `playback/playback/damaged-h264/damaged_h264.mkv` |  |
| `case/playback/damaged-h264/damaged_h264_b.mkv` | L3 `playback/playback/damaged-h264/damaged_h264_b.mkv` |  |
| `case/playback/truncated/trunc_moov.mp4` | L3 `playback/playback/truncated/trunc_moov.mp4` |  |
| `case/playback/truncated/trunc_faststart.mp4` | L3 `playback/playback/truncated/trunc_faststart.mp4` |  |
| `case/playback/truncated/trunc.mkv` | L3 `playback/playback/truncated/trunc.mkv` |  |
| `case/playback/audio/truehd-51side` | L3 `playback/playback/audio/truehd-51side` | also L2 formats_cases.js (sound decodes) |
| `case/playback/audio/71-centre-downmix` | L3 `playback/playback/audio/71-centre-downmix` | also L2 formats_cases.js (sound decodes) |
| `case/playback_autoplay/autoplay-late-start/start3600.mts` | L3 `autoplay-loop/playback_autoplay/autoplay-late-start/start3600.mts` | also L2 formats_cases.js; relaxed: rate 0.6-1.6x -> 0.3-3x (the bug was a stuck clock) |
| `case/playback_autoplay/autoplay-late-start/start3600_mpeg2.mts` | L3 `autoplay-loop/playback_autoplay/autoplay-late-start/start3600_mpeg2.mts` | also L2 formats_cases.js; relaxed: rate 0.6-1.6x -> 0.3-3x (the bug was a stuck clock) |
| `case/playback_autoplay/end-of-sound/audio_longer.mp4` | L3 `autoplay-loop/playback_autoplay/end-of-sound/audio_longer.mp4` | relaxed: 7.5 s sample -> until it stops, 30 s |
| `case/playback_loop/loop-sound-only/sine_only.mkv` | L3 `autoplay-loop/playback_loop/loop-sound-only/sine_only.mkv` | relaxed: 8 s sample -> until the wrap, 30 s |
| `case/remote_stream/hevc_10_2160p.mp4` | L3 `remote-stream/remote_stream/hevc_10_2160p.mp4` |  |
| `case/remote_stream/hevc_10_1080p.mp4` | L3 `remote-stream/remote_stream/hevc_10_1080p.mp4` |  |
| `case/remote_stream/vp9_opus_anim_1080p.webm` | L3 `remote-stream/remote_stream/vp9_opus_anim_1080p.webm` |  |
| `case/remote_stream/encoder` | L3 `remote-stream/remote_stream/encoder` |  |
| `case/remote_stream/seeks` | L3 `remote-stream/remote_stream/seeks` |  |
| `case/remote_stream_long/rs_sync_200s.mkv` | L3 `remote-stream/remote_stream_long/decision` | 150 s soak (lag, sound lead): L4 remote-stream-soak |
| `case/remote_stream_long/seeks` | L3 `remote-stream/remote_stream_long/seeks` | numbers: L4 remote-stream-soak |
| `case/remote_stream_fallback/pixel-tools` | L3 `remote-stream/remote_stream_fallback/pixel-tools` |  |
| `case/remote_stream_fallback/ffmpeg-exit` | L3 `remote-stream/remote_stream_fallback/ffmpeg-exit` |  |
| `case/remote_stream_fallback/slow-link` | L3 `remote-stream/remote_stream_fallback/slow-link` | relaxed: keeps time (>= 3.5-4 x fps frames) -> keeps playing (>= 1 x fps) at the same quality |
| `case/remote_stream_fallback/slow-link-sound` | L3 `remote-stream/remote_stream_fallback/slow-link-sound` | relaxed: keeps time (>= 3.5-4 x fps frames) -> keeps playing (>= 1 x fps) at the same quality |
| `case/scopes_export/scopes/waveform-bars` | L3 `scopes-export/scopes_export/scopes/waveform-bars` |  |
| `case/scopes_export/scopes/sd-709` | L3 `scopes-export/scopes_export/scopes/sd-709` |  |
| `case/scopes_export/scopes/sd-untagged` | L3 `scopes-export/scopes_export/scopes/sd-untagged` |  |
| `case/scopes_export/scopes/vectorscope-bars` | L3 `scopes-export/scopes_export/scopes/vectorscope-bars` |  |
| `case/scopes_export/scopes/updates-when-stepping` | L3 `scopes-export/scopes_export/scopes/updates-when-stepping` | relaxed: 5-14 updates/s while playing -> 0.4-14 (the throttle still capped) |
| `case/scopes_export/scopes/frame-player` | L3 `scopes-export/scopes_export/scopes/frame-player` |  |
| `case/scopes_export/export/range` | L3 `scopes-export/scopes_export/export/range` |  |
| `case/scopes_export/export/vfr` | L3 `scopes-export/scopes_export/export/vfr` |  |
| `case/scopes_export/export/hidden` | L3 `scopes-export/scopes_export/export/hidden` |  |
| `case/scopes_export/export/no-range` | L3 `scopes-export/scopes_export/export/no-range` |  |
| `case/scopes_export/saveFrame/png` | L3 `scopes-export/scopes_export/saveFrame/png` |  |
| `case/seek_preview/wasm` | L3 `seek-preview/seek_preview/wasm` |  |
| `case/seek_preview_native/native` | L3 `seek-preview/seek_preview_native/native` |  |
| `case/seeking/step/s_h264.mp4` | L3 `seeking/seeking/step/s_h264.mp4` | also L2 frames_mpeg4_h264.js (H.264 on the WebAssembly path) |
| `case/seeking/step/s_hevc.mp4` | L3 `seeking/seeking/step/s_hevc.mp4` across a GOP; full sweep in L2 `test/engine/frames_hevc_vp9.js` | |
| `case/seeking/step/s_vp9.webm` | L2 `test/engine/frames_hevc_vp9.js (step/s_vp9.webm)` |  |
| `case/seeking/step/s_mpeg2.mpg` | L2 `test/engine/frames_mpeg2_prores.js (step/s_mpeg2.mpg)` |  |
| `case/seeking/step/s_prores.mov` | L2 `test/engine/frames_mpeg2_prores.js (step/s_prores.mov)` |  |
| `case/seeking/step/s_xvid.avi` | L2 `test/engine/frames_mpeg4_h264.js (step/s_xvid.avi)` |  |
| `case/seeking/step/s_mjpeg.avi` | L3 `seeking/seeking/step/s_mjpeg.avi` |  |
| `case/seeking/seek/s_h264.mp4` | L3 `seeking/seeking/seek/s_h264.mp4` | also L2 frames_mpeg4_h264.js (H.264 on the WebAssembly path); relaxed: seek while playing: "t < 1.9 s" -> within the wall time since the seek |
| `case/seeking/seek/s_hevc.mp4` | L2 `test/engine/frames_hevc_vp9.js (seek/s_hevc.mp4)` | relaxed: seek while playing: "t < 1.9 s" -> within the wall time since the seek |
| `case/seeking/seek/s_vp9.webm` | L2 `test/engine/frames_hevc_vp9.js (seek/s_vp9.webm)` | relaxed: seek while playing: "t < 1.9 s" -> within the wall time since the seek |
| `case/seeking/seek/s_mpeg2.mpg` | L2 `test/engine/frames_mpeg2_prores.js (seek/s_mpeg2.mpg)` | relaxed: seek while playing: "t < 1.9 s" -> within the wall time since the seek |
| `case/seeking/seek/s_prores.mov` | L2 `test/engine/frames_mpeg2_prores.js (seek/s_prores.mov)` | relaxed: seek while playing: "t < 1.9 s" -> within the wall time since the seek |
| `case/seeking/seek/s_xvid.avi` | L2 `test/engine/frames_mpeg4_h264.js (seek/s_xvid.avi)` | relaxed: seek while playing: "t < 1.9 s" -> within the wall time since the seek |
| `case/seeking/seek/s_mjpeg.avi` | L3 `seeking/seeking/seek/s_mjpeg.avi` | relaxed: seek while playing: "t < 1.9 s" -> within the wall time since the seek |
| `case/seeking/open-gop/h264` | L3 `seeking/seeking/open-gop/h264` | also L2 frames_edges.js + tracks/engine_smoke.js |
| `case/seeking/step-ms-rounded/vp9_60fps.mkv` | L2 `test/engine/frames_hevc_vp9.js (step-ms-rounded/vp9_60fps.mkv)` |  |
| `case/seeking/step-ms-rounded/h264_60fps.mkv` | L3 `seeking/seeking/step-ms-rounded/h264_60fps.mkv` | also L2 frames_edges.js |
| `case/seeking/step-ms-rounded/ntsc_2997.mkv` | L3 `seeking/seeking/step-ms-rounded/ntsc_2997.mkv` | also L2 frames_edges.js |
| `case/seeking/end-key/audio_longer.mp4` | L3 `seeking/seeking/end-key/audio_longer.mp4` | also L2 frames_mpeg4_h264.js |
| `case/seeking/end-key/audio_longer_soft.mkv` | L2 `test/engine/frames_mpeg4_h264.js (end-key/audio_longer_soft.mkv)` |  |
| `case/seeking/edges/s_h264.mp4` | L3 `seeking/seeking/edges/s_h264.mp4` | also L2 frames_edges.js |
| `case/seeking/eof-flush/vp8_2s.webm` | L3 `seeking/seeking/eof-flush/vp8_2s.webm` | also L2 frames_edges.js (VP8 in WebAssembly) |
| `case/seeking/abloop/s_h264.mp4` | L3 `seeking/seeking/abloop/s_h264.mp4` | also L2 frames_edges.js; relaxed: ">= 2 wraps in 4.5 s" -> 2 wraps within 30 s; overshoot past B 0.15 -> 0.25 s |
| `case/short_loop/soft` | L3 `autoplay-loop/short_loop/soft` | numbers: L4 short-loop-fps; relaxed: shownFps 24 +- 1 -> layer 4 (short-loop-fps); layer 3 keeps the loop-cache check |
| `case/short_loop/webcodecs` | L3 `autoplay-loop/short_loop/webcodecs` | numbers: L4 short-loop-fps; relaxed: shownFps 24 +- 1 -> layer 4 (short-loop-fps); layer 3 keeps the loop-cache check |
| `case/startup-gpu/h264_aac_anim_1080p.mp4` | L4 `startup-gpu` |  |
| `case/startup-wasm/hevc_8_1080p.mp4` | L4 `startup-wasm` |  |
| `case/startup-native/hevc_10_2160p.mp4` | L4 `startup-native` |  |
| `case/startup-av1-mp4/av1_10_2160p.mp4` | L4 `startup-av1-mp4` |  |
| `case/startup-h264-mp4/h264_10_1080p.mp4` | L4 `startup-h264-mp4` |  |
| `case/startup-prores-mov/prores_proxy_1080p.mov` | L4 `startup-prores-mov` |  |
| `case/startup-vp9-webm/vp9_2160p.webm` | L4 `startup-vp9-webm` |  |
| `case/startup-vp9-mp4/cases/startup_vp9_cfr.mp4` | L4 `startup-vp9-mp4` |  |
| `case/startup-h264-mov/cases/startup_h264_422.mov` | L4 `startup-h264-mov` |  |
| `case/startup-hevc-mkv/cases/startup_hevc.mkv` | L4 `startup-hevc-mkv` |  |
| `case/startup-av1-mkv/cases/startup_av1.mkv` | L4 `startup-av1-mkv` |  |
| `case/startup-restore/background-probe` | L3 `restore/startup-restore/background-probe` |  |
| `case/memory/hevc_10_2160p.mp4` | L4 `memory` |  |
| `case/memory-8gb/hevc_10_2160p.mp4` | L4 `memory-8gb` |  |
| `case/subtitles/bitmap/pgs` | L3 `subtitles/subtitles/bitmap/pgs` |  |
| `case/subtitles/bitmap/dvd` | L3 `subtitles/subtitles/bitmap/dvd` |  |
| `case/subtitles/bitmap/dvb` | L3 `subtitles/subtitles/bitmap/dvb` |  |
| `case/subtitles/tracks/menu-and-cues` | L3 `subtitles/subtitles/tracks/menu-and-cues` | relaxed: > 20 frames in 1.5 s after the switch -> within 20 s |
| `case/ui/a11y/names` | L3 `ui/ui/a11y/names` |  |
| `case/ui/a11y/states-and-live` | L3 `ui/ui/a11y/states-and-live` |  |
| `case/ui/keys/focused-controls` | L3 `ui/ui/keys/focused-controls` |  |
| `case/ui/picture/click` | L3 `ui/ui/picture/click` |  |
| `case/ui/panels/toggle` | L3 `ui/ui/panels/toggle` |  |
| `case/ui/panels/keyboard` | L3 `ui/ui/panels/keyboard` |  |
| `case/ui/cc/no-subtitles` | L3 `ui/ui/cc/no-subtitles` |  |
| `case/ui/speed/step-and-clamp` | L3 `ui/ui/speed/step-and-clamp` |  |
| `case/ui/drag/outside` | L3 `ui/ui/drag/outside` |  |
| `case/ui/time/formats` | L3 `ui/ui/time/formats` |  |
| `case/ui/info/wasm-and-copy` | L3 `ui/ui/info/wasm-and-copy` |  |
| `case/ui/compare` | L3 `ui/ui/compare` |  |
| `case/ui_jumps/defaults` | L3 `ui/ui_jumps/defaults` |  |
| `case/ui_jumps/panel-saves-setting` | L3 `ui/ui_jumps/panel-saves-setting` |  |
| `case/ui_jumps_settings/from-settings` | L3 `ui/ui_jumps_settings/from-settings` |  |
| `case/ui_info/wasm` | L3 `ui/ui_info/wasm` |  |
| `case/ui_info_native/native` | L3 `native/ui_info_native/native` |  |
| `case/url_stream/mp4_direct` | L3 `url/url_stream/mp4_direct` |  |
| `case/url_stream/panels` | L3 `url/url_stream/panels` |  |
| `case/url_stream/hls_ts` | L3 `url/url_stream/hls_ts` |  |
| `case/url_stream/hls_master` | L3 `url/url_stream/hls_master` |  |
| `case/url_stream/hls_fmp4` | L3 `url/url_stream/hls_fmp4` |  |
| `case/url_stream/hls_aes` | L3 `url/url_stream/hls_aes` |  |
| `case/url_stream/hls_quality` | L3 `url/url_stream/hls_quality` |  |
| `case/url_stream/hls_subs` | L3 `url/url_stream/hls_subs` |  |
| `case/url_stream/hls_drm` | L3 `url/url_stream/hls_drm` |  |
| `case/url_stream/url_to_side` | L3 `url/url_stream/url_to_side` |  |
| `case/url_stream/dash_needs_ffmpeg` | L3 `url/url_stream/dash_needs_ffmpeg` |  |
| `case/url_stream/hls_live_needs_ffmpeg` | L3 `url/url_stream/hls_live_needs_ffmpeg` |  |
| `case/url_stream/not_found` | L3 `url/url_stream/not_found` |  |
| `case/url_stream/web_page` | L3 `url/url_stream/web_page` |  |
| `case/url_stream_native/hls_native` | L3 `url-native/url_stream_native/hls_native` |  |
| `case/url_stream_native/hls_aes_native` | L3 `url-native/url_stream_native/hls_aes_native` |  |
| `case/url_stream_native/hls_quality_native` | L3 `url-native/url_stream_native/hls_quality_native` |  |
| `case/url_stream_native/hls_subs_native` | L3 `url-native/url_stream_native/hls_subs_native` |  |
| `case/url_stream_native/dash_native` | L3 `url-native/url_stream_native/dash_native` |  |
| `case/url_stream_native/hevc_mp4_native` | L3 `url-native/url_stream_native/hevc_mp4_native` |  |
| `case/url_stream_native/hls_live_native` | L3 `url-native/url_stream_native/hls_live_native` |  |
| `case/url_stream_native/mp4_h264_stays_builtin` | L3 `url-native/url_stream_native/mp4_h264_stays_builtin` |  |
| `case/url_stream_native_mp4/mp4_native` | L3 `url-native/url_stream_native_mp4/mp4_native` |  |
| `play/mpeg2_1080p.mpg` | L3 `open-formats/open-formats/play/mpeg2_1080p.mpg` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/h264_8_2160p.mp4` | L3 `open-formats/open-formats/play/h264_8_2160p.mp4` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/hevc_10_2160p.mp4` | L3 `open-formats/open-formats/play/hevc_10_2160p.mp4` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/av1_8_1080p.mp4` | L3 `open-formats/open-formats/play/av1_8_1080p.mp4` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/vp9_2160p.webm` | L3 `open-formats/open-formats/play/vp9_2160p.webm` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/prores_proxy_1080p.mov` | L3 `open-formats/open-formats/play/prores_proxy_1080p.mov` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/containers/h264_aac.mkv` | L3 `open-formats/open-formats/play/containers/h264_aac.mkv` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/containers/h264_aac.mov` | L3 `open-formats/open-formats/play/containers/h264_aac.mov` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/containers/h264_aac.m2ts` | L3 `open-formats/open-formats/play/containers/h264_aac.m2ts` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/containers/h264_aac.flv` | L3 `open-formats/open-formats/play/containers/h264_aac.flv` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/containers/h264_aac.avi` | L3 `open-formats/open-formats/play/containers/h264_aac.avi` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `play/containers/vp8_vorbis.webm` | L3 `open-formats/open-formats/play/containers/vp8_vorbis.webm` | full runs only (the reference run was --quick); fps / open ms: L4 play-fps; also L2 formats_media.js / formats_4k.js |
| `native/hevc_10_2160p.mp4` | L3 `native/open-native/native/hevc_10_2160p.mp4` | full runs only (the reference run was --quick); fps: L4 play-fps |
| `native/av1_10_2160p.mp4` | L3 `native/open-native/native/av1_10_2160p.mp4` | full runs only (the reference run was --quick); fps: L4 play-fps |
| `case/perf-invisible-bench/idle-empty` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/perf-invisible-bench/paused-webcodecs-sound` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/perf-invisible-bench/paused-native-4k` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/perf-invisible-bench/after-pause-native-4k` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/perf-invisible-bench/after-pause-webcodecs-4k` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/perf-invisible-bench/hidden-native` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/perf-invisible-bench/native-720-picture-4k` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/perf-invisible-bench/native-720-picture-1080p` | L4 `perf-invisible-bench` | opt-in benchmark (env) |
| `case/cpu-4k-default/hevc_10_2160p_20s.mp4` | L4 `cpu-4k-default` | opt-in benchmark (env) |
| `case/cpu-4k-default/hevc_10_pq_2160p_20s.mp4` | L4 `cpu-4k-default` | opt-in benchmark (env) |
| `case/cpu-4k-cuda/hevc_10_2160p_20s.mp4` | L4 `cpu-4k-cuda` | opt-in benchmark (env) |
| `case/cpu-4k-cuda/hevc_10_pq_2160p_20s.mp4` | L4 `cpu-4k-cuda` | opt-in benchmark (env) |
| `case/cpu-4k-d3d11va/hevc_10_2160p_20s.mp4` | L4 `cpu-4k-d3d11va` | opt-in benchmark (env) |
| `case/cpu-4k-d3d11va/hevc_10_pq_2160p_20s.mp4` | L4 `cpu-4k-d3d11va` | opt-in benchmark (env) |
| `case/cpu-4k-auto/hevc_10_2160p_20s.mp4` | L4 `cpu-4k-auto` | opt-in benchmark (env) |
| `case/cpu-4k-auto/hevc_10_pq_2160p_20s.mp4` | L4 `cpu-4k-auto` | opt-in benchmark (env) |
| `case/transfer-bench/1080p/message` | L4 `transfer-bench` | opt-in benchmark (env) |
| `case/transfer-bench/1080p/ws` | L4 `transfer-bench` | opt-in benchmark (env) |
| `case/transfer-bench/1080p/http` | L4 `transfer-bench` | opt-in benchmark (env) |
| `case/transfer-bench/2160p/message` | L4 `transfer-bench` | opt-in benchmark (env) |
| `case/transfer-bench/2160p/ws` | L4 `transfer-bench` | opt-in benchmark (env) |
| `case/transfer-bench/2160p/http` | L4 `transfer-bench` | opt-in benchmark (env) |
| `case/native-bench-<h>-<mode>/<clip> (VPE_TRANSFER_CLIPS)` | L4 `native-bench-<h>-<mode>` (only with VPE_TRANSFER_CLIPS) | opt-in benchmark (env) |
| `case/memory-again/hevc_10_2160p.mp4` | L4 `memory-again` | opt-in benchmark (env) |
| `case/memory-8gb-again/hevc_10_2160p.mp4` | L4 `memory-8gb-again` | opt-in benchmark (env) |

## Appendix A: what each result asserts (cases, part 1)

Written during the inventory, before the move: the "Layer" columns there are the proposals; the table above is where each result lives now.

Common runner facts (run.js): each case gets a fresh `HiddenCode` (fresh user-data dir, profile, globalState), base
settings (telemetry off, `workbench.editorAssociations` `*.mp4`/`*.webm` -> `playerOptional`, ...), `VPE_LOG` env,
PATH **without** ffmpeg unless `ffmpeg: true` (then `videoPreviewEnhanced.ffmpegPath` is also set). `ffmpeg: true` + no
ffmpeg -> whole case skipped. A failing case whose log shows no WebGL2 is retried once in a fresh instance. The
runner sleeps 3 s after start. `h.ffmpeg` (path to ffmpeg for *reference* numbers) is available to every case
regardless of the `ffmpeg` flag (the flag only controls the extension's native path).

Legend for "needs": FF-ref = ffmpeg run by the test for reference data; NATIVE = extension's native ffmpeg path
(`ffmpeg: true`); WebGL = WebGL2 in webview; WC = WebCodecs; HDRF = `VPE_HDR_FORCE=1`; CAP = window capture
(PrintWindow via hidden_launch.py/capture_window.py, python); ENV = env var gates.

Layer key: 1 unit (pure Node), 2 engine (libav.js WASM in Node, frame exactness), 3 VS Code scenario
(correctness, no time/fps thresholds), 4 perf.

---

### compare_metrics.js

#### Case `compare_metrics`
- settings: `videoPreviewEnhanced.autoplay: false`; env: none; ffmpeg flag: no (uses FF-ref via `h.ffmpeg`; skips all if missing -> `case/compare_metrics/all` skipped).
- Instance sharing: opens/closes `s_h264.mp4` to activate; each sub-result closes all editors (`h.closeClip`). Uses mkdtemp dir (removed). No settings/globalState changes. Relies on **debug-build** log line `webview: metrics ...` (media/compare.js, debug only) and the `compare` test hook. Safe to share an instance.
- Runtime: ~3 compare opens x 6 seeks; budget timeouts 40 s open, 30 s per seek; realistic ~30-60 s.
- Exercises: src/compare.js (session, compareFiles hook in src/extension.js:1191), media/compare.js (`Metrics.measure`, `lumaMetrics`, `ssim`, `pairMetrics`, offset, `scan` first-difference search), media/engine.js (builtin decode), test media `cmp/ref.mp4`, `cmp/lowq.mp4`, `cmp/offset3.mp4`.

| Result | Proves | Assertions | Time/fps thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/compare_metrics/same-file` | Identical A/B give infinite PSNR | for frames k in [0,1,2,30,59,45]: psnrY===Infinity && psnrRGB===Infinity | none (timeouts 30/40 s only) | FF-ref (gate only), WebGL/engine, debug build | **2** (+thin 3): pure math of media/compare.js `measure`/`lumaMetrics` on decoded frames; could run in Node on libav.js frames. Keep one VS Code smoke that the metrics line appears. |
| `case/compare_metrics/lowq-vs-ffmpeg` | Our PSNR-Y/SSIM-Y match ffmpeg psnr/ssim filters per frame | for k in [0,1,2,30,59,44]: abs(psnrY-ffmpeg)<0.006 && abs(ssimY-ffmpeg)<1e-5; records r.worst | none | FF-ref (psnr, ssim filters), engine | **2**: frame-exact metric parity; `lumaMetrics`/`ssim` in media/compare.js are pure functions over planes -> test in Node with libav.js-decoded YUV vs ffmpeg stats. |
| `case/compare_metrics/offset-3` | Offset -3 lines B up with A; first-difference scan finds #42 at offset 0 | m1.psnrY<30 (offset 0) && psnrY>40 at A#41/B#38 (offset -3); scan log matches `scan: #42: PSNR Y` | none | FF-ref gate, engine, compare hook | **3** for offset UI path (sync of tiles) + **2** for scan logic (media/compare.js scanner with sA/sB engines). |

---

### compare_ui.js

#### Case `compare_ui`
- settings: `videoPreviewEnhanced.decoder: 'builtin'`, `autoplay: false`; env: none; ffmpeg: no.
- Instance sharing: single linear script; ends with `h.closeClip` (all editors closed). Webview state persisted per panel (clock etc.) but within the compare session. Uses `compareWith`, `compareAdd`, `tabs`, `state` hooks. Asserts **exactly one tab** open (`tabs after entering` / `after leaving`): would FAIL if a previous case left editors open (e.g. ctxmenu). decoder=builtin is a setting -> must be applied per case (or via settings.json write) when sharing.
- Runtime: many 200-300 ms sleeps + polls; ~40-70 s.
- Exercises: src/compare.js (compareWith in place / tab replacement, addUris, remove, leave -> player), src/extension.js test hooks, media/compare.js (bar, panels cmp/cmpVid, offsets frames/ms, clock, sound, pills/nudges, split/divider/swap, tile menu, 2x2 grid with add cell), media/controls.js / media/player.js (bar ids, cog panel, Tools grid), media/compare.css.

All results: no time/fps thresholds (only `until` poll timeouts 5-30 s). Needs: engine (WebGL/WC builtin decode), test hooks. Proposed layer for all: **3** (UI correctness in real webview). Frame-number expectations could additionally be layer-2 logic (relFor), noted below.

| Result | Proves | Assertions |
|---|---|---|
| `case/compare_ui/enter/in-place` | Compare from the player replaces its tab and starts at player's position | A frame within 1 of #31 (player at 1.0 s); exactly 1 tab, viewType matches /compare/ |
| `case/compare_ui/bar` | Compare's bar = player's bar minus CC plus Compare | bar has ids prev,play,next,mute,volume,time,cmpBtn,infoBtn,rate,cog,keysBtn,full; no tracks; time starts with "A"; mute title "sound from A"; Shift+> -> rate 1.05; "." steps both to #32 |
| `case/compare_ui/panel/compare` | Compare panel content and toggling; cog panel rows; Tools > Compare | panel view cmp & cmpExpanded; text includes Videos, both clip names, "Add video…", "2 of 4", View, Side by side, Split, Swap sides, Leave compare, keep A; excludes PSNR, SSIM, Find first difference, A vs B; A row label regex; button closes panel; cog panel main with Sound/from A/Copy view/Compare, without Subtitles/Audio track/A-B loop; Tools Compare opens cmp |
| `case/compare_ui/panel/video-page` | B's page: offset in frames/ms, Reset, clock, sound | view cmpVid; text has Offset, In step, Frames, Time (ms), Clock, Sound from this video, Replace video…, Remove (back to one video); "B later" -> offsets 0f,1f; B shows A+1; frames->ms gives 0f,33.33Xms; +10 ms -> 43.33Xms; page shows "+43.3 ms"; Reset+Frames -> 0f,0f; clock=1 sound=1; bar time "B…" & "sound from B"; seekMax 89; Back -> cmp |
| `case/compare_ui/tiles/pills-and-nudge` | Hover pills, ‹ › nudges, − / + under pointer | 2 cells each 1 pill 1 nudge; A pill "A…<clip>…#n"; B nudge "‹0›"; A's picture aspect 16:9 ±0.05; › nudge -> 0f,1f; − on B -> 0f,0f; + on A -> 1f,0f |
| `case/compare_ui/view/split` | Split view, divider drag, swap | mode split, divider true, cells 1; one cell with 2 pills; drag -> split 0.25 ±0.01; divider aria 25; X -> swap true and left pill B; back to side: cells 2 |
| `case/compare_ui/tiles/menu` | Tile right-click menu | menu for tile 1; items include Play, B sets the clock, Sound from B, Offset of B…, Copy frame (B), Copy timestamp (B), Replace B…, Remove B, Add video…, Leave compare, Keyboard shortcuts, Settings…; pick -> clock 1 menu closed; ✓ shown; Offset of B… opens B page with its name |
| `case/compare_ui/grid/three` | 3 videos -> 2x2 with Add cell; Remove back to 2 | mode grid, cells 3, add true; 4 cells, 4th 'add'; panel "3 of 4" without Side by side/PSNR; after Remove: n 2, mode side |
| `case/compare_ui/leave` | Leave compare -> player in the same tab at kept video's moment | clock 0; exactly 1 tab with viewType videoPreviewEnhanced.player; player state t within 0.1 of 1.5 s |
| `case/compare_ui/error` | (only if an exception happens before the first t()) | exception message |

---

### cpu_4k.js

#### Cases `cpu-4k-<variant>` (only when `VPE_CPU_BENCH` is set in the runner's env; otherwise module exports `[]`)
- Loop values: variants = `VPE_CPU_VARIANTS` or `default,cuda,d3d11va,auto` -> cases `cpu-4k-default`, `cpu-4k-cuda`, `cpu-4k-d3d11va`, `cpu-4k-auto`.
- settings: `videoPreviewEnhanced.nativeMaxHeight: VPE_CPU_HEIGHT||0`; env: `VPE_THUMB_STRIP: '0'` + (non-default) `VPE_NATIVE_METHOD: <variant>`; ffmpeg: **true**.
- Instance sharing: **must not share** — measures CPU of every process of the instance (Win32_Process via PowerShell, keyed by profile dir), needs a fresh profile with no GPU test record (globalState) for `default`, and process env differs per variant. Closes clip after each. Creates 20 s stream copies in `%TEMP%\vpe-cpu-4k-clips` with bare `ffmpeg` on PATH.
- Runtime: per clip 45 s max open + 2 s + VPE_CPU_SECONDS (12) + 1.5 s -> ~20-30 s/clip, ~1 min/variant, ~4 min total.
- Exercises: src/native.js, src/hwaccel.js (method), src/decide.js, src/frameserver.js, src/extension.js (thumb strip env), media/player.js status lines.

| Result (per variant) | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/cpu-4k-<v>/hevc_10_2160p_20s.mp4` | CPU per process role while native 4K HEVC10 plays | ffmpeg CPU >0 unless software decode; some status lines; first frame within 45 s. Records cpu{ffmpeg,exthost,renderer,gpu,main,other,total}, shownFps median, decision, decode, retries, stats | CPU % of a core and shownFps recorded (no pass threshold); sampling window `VPE_CPU_SECONDS` (12 s) | NATIVE, GPU (cuda/d3d11va), Windows PowerShell CIM, ENV `VPE_CPU_BENCH` | **4** |
| `case/cpu-4k-<v>/hevc_10_pq_2160p_20s.mp4` | same for 4K PQ HEVC10 | same | same | same | **4** |

8 results when enabled (4 variants x 2 clips); 0 by default.

---

### ctxmenu.js

#### Case `ctxmenu`
- settings: none; env: none; ffmpeg: no.
- Instance sharing: **does NOT close the player at the end** (no closeClip) -> leaves `h264_aac_anim_1080p.mp4` open, paused, with a toast, AB marks cleared. Loop setting flipped then flipped back (`loopOn/loopOff` ctx commands — check whether that writes the user setting `videoPreviewEnhanced.loop`; it restores it either way). `copyTime` writes the **system clipboard**. Next case in same instance asserting tab count (compare_ui) would break.
- Runtime: ~45 s max open + ~12 s of sleeps -> ~20 s.
- Exercises: src/ctxmenu.js (commands `videoPreviewEnhanced.ctx.*`, PREFIX), src/extension.js (ctxCommand hook), media/player.js (data-vscode-context, modesReport, state: sheet/panel/abMarks/toast), media/controls.js.

All: no time/fps thresholds (fixed sleeps 400-900 ms; could be flaky but not thresholds). Needs: engine (builtin decode), hooks. Layer **3**; the context-object building (what keys/values from player state) is pure logic in media/player.js (around line 1092-1104) -> a **1** unit test candidate if extracted.

| Result | Proves | Assertions |
|---|---|---|
| `case/ctxmenu/context/attribute` | data-vscode-context carries menu state | preventDefaultContextMenuItems true; vpe & vpeReady true; vpePlaying false, vpeAdvanced undefined, vpeLoop boolean |
| `case/ctxmenu/commands/transport` | ctx.play/pause/loopOn/loopOff change the player | playing true after play; vpePlaying true; playing false after pause; vpeLoop flipped |
| `case/ctxmenu/commands/help` | ctx.keys opens shortcuts sheet; ctx.playerSettings opens main panel | sheet matches /Keyboard shortcuts/; then no sheet and panel.view==='main' |
| `case/ctxmenu/commands/ab-loop` | Set A / Set B / Clear A-B | vpeABSet false before; after setA: ABSet true, AB false; setA twice stays set; after setB: vpeAB true & marks visible; after clear: ABSet false & marks hidden |
| `case/ctxmenu/commands/frame` | Copy timestamp | toast matches /Timestamp copied/ |

---

### file_icons.js

#### Case `file_icons`
- settings: none (default `overrideFileIcons` on); env: none; ffmpeg: no.
- Instance sharing: the extension writes `files.associations` (`*.mkv|*.flv|*.m2ts -> vpe-video`) to the **user settings.json** and globalState key `videoPreviewEnhanced.fileIcons` (src/extension.js:844-875) on activation — a persistent global change. Test asserts `*.ts, *.mts, *.avi, *.mov` are untouched: a prior case that set those would break it. Closes the mkv player. Benign for later cases except anything asserting settings.json contents.
- Runtime: ~5-15 s.
- Exercises: src/extension.js `fileIcons()` + FILE_ICON_EXTS/FILE_ICON_LANG, package.json (language `vpe-video`, custom editor selectors for .mkv), test/media/containers/h264_aac.mkv.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/file_icons/mkv-opens-in-player` | The language association doesn't change which editor opens .mkv | first frame shown within 45 s | none | builtin decode | **3** |
| `case/file_icons/associations-written` | Extension adds exactly its patterns | `*.mkv,*.flv,*.m2ts === 'vpe-video'`; `*.ts,*.mts,*.avi,*.mov` undefined (polls 20 x 500 ms) | none | none beyond VS Code | **1** for the merge logic of `fileIcons()` (pure given cfg/globalState mocks; extract) + **3** smoke that it lands in settings.json |

---

### file_icons_pixels.js

#### Cases `file_icons_pixels_<tag>` (5 cases)
- Loop values (tag, theme, colour, zoom): `dark-100` (Default Dark Modern, #f55385, 0), `light-100` (Default Light Modern, #dd4b78, 0), `dark-120` (Dark, 1), `dark-m1` (Dark, -1), `dark-z2` (Dark, 2).
- settings: `workbench.colorTheme`, `window.zoomLevel`, `workbench.iconTheme: vs-seti`, `workbench.activityBar.location: hidden`, `workbench.statusBar.visible: false`; env: `VPE_ICON_OUT` optional (output dir); ffmpeg: **true** (only used for writePng crops via bare `ffmpeg`; flag means the case skips without ffmpeg).
- Instance sharing: **must not share** in practice — window-level theme/zoom/layout settings per variant, needs Explorer visible on the left with no other sidebar layout changes, writes 9 empty files into the workspace (`vs.work`), waits for the extension to write `files.associations` (global settings). Could share only if the harness rewrites settings.json live and waits for repaint. Captures the window (python + PrintWindow on the hidden desktop).
- Runtime: up to 20 s wait for associations + 5 s + up to 15 x 3 s retries: ~10-60 s per variant.
- Exercises: package.json (language `vpe-video` icon contribution), media/icons/* (the SVG icon), src/extension.js `fileIcons()`; compares against VS Code's Seti `_video` glyph.

| Result (per tag) | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/file_icons_pixels_<tag>/icons-equal-seti-mp4` (tags: dark-100, light-100, dark-120, dark-m1, dark-z2) | Our .mkv/.flv/.m2ts Explorer icon matches Seti's .mp4/.avi | 5 icon clusters found; size within 1 px; position within 1 px (x and row-pitch-aligned y); ink mass ratio within 8 %, centroid within 1.2 px; at zoom 0 mean abs pixel diff <= 3 (`MEAN_TOLERANCE`) | pixel tolerances only, no time/fps | CAP (python, hidden desktop), ffmpeg (PNG crops), GPU-rendered workbench | **3** (visual correctness; not perf). Could be marked optional/"visual" sub-suite. |

---

### hdr_output.js

Imports `media/hdr.js` in Node (`H.nitsToCanvas`, `H.mul`) for expected values, `test/zoo/make_dv.js` (`makeDv`) to make Dolby Vision clips, `lib.media.hdr()` (HDR pattern media from test/zoo/make_hdr.js; needs ffmpeg/x265 to build).

#### Case `hdr_output`
- settings: `autoplay: false`, `advancedMode: true`; env: none; ffmpeg: no (DV clip creation and HDR media need ffmpeg on the test side; skipped as `dv` if media missing).
- Instance sharing: each result opens and closes its own player (`P0.close()` = closeAllEditors). Writes dv81/dv84/dv5 mp4 next to the HDR pattern media (cached on disk). No settings/globalState change. `advancedMode` setting needed.
- Runtime: 4K PQ open up to 60 s; ~1-2 min.
- Exercises: media/hdr.js (decide, start, dolbyVision, webglHdr, caps probe), media/engine.js (shader tf, tone mapping), media/player.js (label, state, hdrcaps/hdrpixels/pixels hooks), src/probe.js / src/extension.js (DV config detection), test/media/hevc_10_pq_2160p.mp4.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/hdr_output/probe` | Webview answers the HDR capability probe | `typeof caps.displayHdr === 'boolean'` (logs caps) | none | WebGL/WebGPU | **3** (informational) |
| `case/hdr_output/sdr` | On an SDR display HDR is tone-mapped, no HDR canvas | label "(HDR tone-mapped to SDR)"; s.tf===1; hdrpixels state off with why /SDR/; exactly one log line "HDR tone-mapped to SDR (the display is SDR)" | none | WebGL, HEVC10 decode (builtin) | **3**; `H.decide(setting, caps, force)` is pure -> **1** too |
| `case/hdr_output/dv/dv81` | DV 8.1 plays as HDR10 base layer | label matches `HDR PQ (HDR tone-mapped to SDR) · Dolby Vision 8.1 (HDR10 base layer)`; tf 1 or 2; white patch min >= 215 | none | FF-ref/media build, WebGL | **3**; DV config parse (`H.dolbyVision`, src probe) -> **1** |
| `case/hdr_output/dv/dv84` | DV 8.4 plays as HLG | label `HDR HLG (...) · Dolby Vision 8.4 (HLG base layer)`; tf; white >= 215 | none | same | **3** |
| `case/hdr_output/dv/dv5` | DV profile 5 shows a message, not a picture | message /Dolby Vision profile 5 isn.t supported/ and hint /HDR10/ | none | same | **3** (message logic **1**) |
| `case/hdr_output/dv` (skip) | only when HDR media can't be made | skipped | | | |

#### Cases `hdr_output_forced` (ffmpeg: false) and `hdr_output_forced_native` (ffmpeg: true)
- settings: `autoplay: false`, `advancedMode: true`; env: **`VPE_HDR_FORCE: '1'`** (process env -> must be its own instance or the harness must flip it); ffmpeg: false / true.
- Instance sharing: VPE_HDR_FORCE changes behaviour of every later player in the instance (HDR output canvas path). Each result closes its player. Without ffmpeg (native variant) -> `pattern` skip. Without HDR media -> `pattern` skip, the `play/*` results still run.
- Runtime: 3 pattern opens + 2 x (3 s play) on 4K: ~1.5-3 min each.
- Exercises: media/hdr.js (nitsToCanvas, signalToCanvas, extended-range WebGPU canvas, gpuConfig, yuvParams), media/engine.js, src/native.js (10-bit HDR output frames, "native decode from ... 10-bit (HDR output)"), media/player.js stats overlay.

| Result (each of the two cases) | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/hdr_output_forced[_native]/pattern/pq` | PQ pattern reaches the HDR canvas with the right linear light | label "(HDR output)"; decoder: native ffmpeg (native case) or vmode soft; hdr state on, frames>0, not hidden; canvas size matches; worst rel. linear error <= 2 %; grey ramp encoded err <= 0.01; g1000 channels > 1.9; page canvas tone-mapped white in [215,255]; (native) log "native decode from .* 10-bit (HDR output)"; stats overlay /HDR output/; no ERRORS lines | none | HDRF, WebGPU/WebGL, HDR media (ffmpeg build), NATIVE for _native | **3**; the expected-value math (media/hdr.js `nitsToCanvas`, `srgbEncodeExt`, `signalToCanvas`) is pure -> **1** (and decode of 10-bit pattern -> **2**) |
| `.../pattern/hlg` | same for HLG (patches >1000 nits excluded) | same (hlgClips skipped) | none | same | **3** (+1 for `hlgToNits`) |
| `.../pattern/dv81` | DV 8.1 clip also reaches HDR output | same as pq | none | same + make_dv | **3** |
| `.../play/hevc_10_pq_2160p` | 4K PQ plays 3 s on the HDR canvas without errors | hdr state on; frames presented in 3 s >= 10; 9 values finite in (-1,6); no ERRORS | **`b.state.frames - a.state.frames >= 10` in 3 s of play** (a frame-rate floor ~3.3 fps) | HDRF, WebGPU, 4K HEVC10 decode (builtin or native) | **3** if threshold relaxed to "frames advance" (>0); the >=10/3 s is a mild perf floor -> move numeric to **4** |
| `.../play/hevc_10_hlg_2160p` | same for 4K HLG | same | same `>= 10` frames in 3 s | same | same |
| `.../pattern` (skip) | no ffmpeg (native) or no HDR media | skipped | | | |

---

### inspect.js

#### Case `inspect`
- settings: `autoplay: false`, `advancedMode: true`, `extensions.confirmedUriHandlerExtensionIds: ['video-preview-enhanced.video-preview-enhanced']`; env: none; ffmpeg: no (FF-ref used; ffmpeg-dependent results set `r.skipped`).
- Instance sharing: each result closes its player. `links/open-url` launches a **second Code.exe --open-url** process against the same user-data dir (needs `vs.desktop`, `vs.envMain`, `vs.code.exe`); the confirmedUriHandler setting must be in that instance's settings. Zoom/inspector state is per player. Safe otherwise.
- Runtime: ~12 opens; X-ray index up to 60 s; ~2-3 min.
- Exercises: media/player.js (go-to box, keys, stats overlay, state), media/inspect.js (pixel read-out, zoom around cursor, pan, nearest/grid), media/engine.js (shader tf, BT.709 matrix, tone mapping EETF), media/thumbs.js + media/thumbs-worker.js + src/thumbhost.js (seek-bar thumbnails, lazy), media/xray.js + media/xray-worker.js (X-ray strip, keyframe keys), src/extension.js (URI handler `/open?frame=&t=&file=`), clips s_h264.mp4, s_hevc.mp4, bars75_sd_709.mp4, fmt/hevc10.mp4, long_20s.mp4, HDR pattern.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/inspect/goto` | Ctrl+G go-to box; frame / time / negative targets | Ctrl+G opens goto; goto 45 -> frame 44; 0:02.5 -> 75; -6 -> 69; plain G doesn't open goto | none | engine | **3**; the go-to parser (frame/time/negative -> index) is pure -> **1** |
| `case/inspect/pixel` | Pixel inspector reads the right position and ffmpeg's RGB/YUV | flat pixel found; read-out x,y exact; RGB within 3 of ffmpeg rgb24; YUV within 1 of ffmpeg yuv420p; click doesn't play | none | FF-ref | **2** for colour exactness (decoded YUV + RGB conversion vs ffmpeg; media/engine.js / media/inspect.js conversion) + **3** for position mapping & click |
| `case/inspect/pixel/sd-709` | SD clip tagged BT.709 uses 709 matrix (WebCodecs path) | vmode==='webcodecs'; position within 1; RGB within 3, YUV within 1 of ffmpeg; stats shows "pixels … 709" | none | FF-ref, **WebCodecs** | **3** (WebCodecs only exists in the webview); matrix choice logic **1** |
| `case/inspect/zoom` | Ctrl+wheel zoom keeps point under cursor; pixelated + grid; drag pans; Z fits | scale grows and point drift < 0.6 px; imageRendering pixelated & pxgrid; drag keeps frameText & not playing; Z -> stageClass fit | none | engine | **3** (zoom maths could be **1** if extracted from media/inspect.js) |
| `case/inspect/stats` | Shift+I stats overlay | stats has decoder, queue, shown, not "stats:"; details not opened | none | engine | **3** |
| `case/inspect/links/open-url` | vscode:// frame link opens the file at frame, paused | first frame shown after `--open-url`; frame 59; not playing | none | FF-ref gate (only skip), second Code.exe launch | **3** |
| `case/inspect/hdr/pq` | PQ tone-mapped in shader matches ffmpeg zscale + same EETF | worst channel diff <= 6 (tol) ignoring both <=16; white203 min>=215 & g1000 min>=250; black max<=2; grey steps rising; red patch; label HDR PQ & vmode soft; white after seek(2) >= 215; stats /HDR (PQ|HLG)/ | none | FF-ref with zscale, HDR media, WebGL | **2** candidate: decode (libav.js) + shader-equivalent tone map in Node vs ffmpeg — but the real thing is the GLSL shader in media/engine.js, so keep **3** for shader output; the JS `toneMap` reference is test-side only |
| `case/inspect/hdr/hlg` | same for HLG (blue1000 excluded) | same | none | same | same |
| `case/inspect/hdr/h264-pq` | same for H.264 PQ | same | none | same | same |
| `case/inspect/hdr` (skip) | HDR media can't be made | skipped | | | |
| `case/inspect/hdr/sdr-unchanged` | SDR keeps tf 0 and ffmpeg colours, 8 and 10 bit | for s_h264.mp4 and fmt/hevc10.mp4: tf===0; flat pixel RGB within 3 of ffmpeg | none | FF-ref | **2** (colour exactness of 8/10-bit decode+convert) + tf check **3** |
| `case/inspect/thumbs/seek-bar` | Lazy seek-bar thumbnails; above tip; replaced; hidden on leave | nothing decoded/no `thumbs:` log before first hover (after 3 s); thumb above tip; second position different sig; leave hides thumb & tip | none (3 s settle sleep) | engine, thumbs worker | **3** |
| `case/inspect/xray/strip` | Codec X-ray strip index + keyframe keys | strip shown with bitrate legend (index done, up to 60 s); `}` -> 0.5<t<1.6; `{` -> t<0.3 | none | engine, xray worker | **3**; the index/keyframe parse in media/xray-worker.js is pure -> **1/2** candidate |

---

### keyconflicts.js

#### Case `keyconflicts`
- settings: none; env: none; ffmpeg: no.
- Instance sharing: opens/closes one player to activate the hook; the hook opens VS Code's default keybindings file then closes the active editor (src/extension.js:1223). Writes `test/vscode/out/keyconflicts.json` (repo out dir). No settings change. Safe to share (needs the extension active).
- Runtime: ~10-20 s.
- Exercises: src/extension.js (`defaultKeybindings` debug hook), the player key list mirrored from media/player.js / media/controls.js (docs/notes/ui-simple.md). The pass/fail logic (`canRunHere`, `global`) is in the test itself.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/keyconflicts/read` | The default keybindings file was read | `r.size > 10000` chars | none | VS Code | **3** (data collection); see below |
| `case/keyconflicts/player-keys-free` | None of the player's keys (left,right,shift/ctrl+arrows,up,down,space,`,`,`.`,shift+/,shift+,,shift+.,k,j,l,home,end,escape; ctrl+c exempt) has a focus-independent default VS Code binding | per key: no matching binding with `canRunHere(when)` | none | VS Code default keybindings | **1** if the default-keybindings JSON is snapshotted per VS Code version (pure filter); otherwise **3**. Could share an instance freely. |
| `case/keyconflicts/avoided-keys-taken` | Keys the player avoids (alt+left, alt+right, ctrl+k; ctrl+shift+c report-only) are indeed taken | g.length>0 for alt+left/alt+right/ctrl+k; attaches `found` report incl. INFO keys ctrl+g, shift+c, ctrl+shift+n | none | same | same |

---

### modes.js

#### Case `modes`
- settings: none; env: none; ffmpeg: no.
- Instance sharing: closes player after the player part and compare at the end. The `compare/views` part assumes default decoder (auto) and `modes === 'side,split'`. Scopes/panel state is per webview. Safe to share if nothing else left open (compare report takes any compare session: a leftover compare tab would confuse `compare report`).
- Runtime: ~30-60 s (compare draw poll up to 60 x 1 s).
- Exercises: media/player.js (modes report, bar flags, tools grid of 6, scopes W cycle, info I, step/seek/play/pause), media/scopes.js, media/modes.js, media/controls.js, media/compare.js (mode side/split, legacy toggle/wipe mapping, removed view keys), src/compare.js.

All: no time/fps thresholds except the implicit "play advances t within 600 ms" (`t > tSeek` after 600 ms play — a weak timing assumption, not a numeric threshold). Needs engine. Layer **3**.

| Result | Proves | Assertions |
|---|---|---|
| `case/modes/layout/bar` | One layout: all bar buttons visible at start | panel none, sheet false; bar flags play,prev,next,seek,mute,volume,time,tracks,infoBtn,rate,cog,keysBtn,full === 1; tools === 6 |
| `case/modes/layout/tool-keys` | W cycles scopes; I toggles the info panel | W: scopes != off and visible; cycles back to off within 4 more presses; I: panel info; I again: none |
| `case/modes/layout/controls` | step ±1, seek, play, pause | step +1 -> f0+1; -1 -> f0; seek 0.5 -> 0.3<t<0.8; play: playing && t > tSeek (after 600 ms); pause: playing false |
| `case/modes/layout/tools-grid` | Tools from the cog grid; Details overlay | panel main; Scopes visible; info true; play/full still visible |
| `case/modes/compare/views` | Compare draws; views side/split only; toggle/wipe map to split; removed keys inert | canvas not 0x within 60 tries; modes side,split; for side, split, toggle, wipe: mode===want and divider/cells consistent; keys 4,g,y,h,1,2,3,t leave split |

---

### multiview.js

#### Case `multiview-short-loop`
- settings: `decoder: 'builtin'`, `loop: true`; env: none; ffmpeg: no.
- Instance sharing: **does not close compare at the end** (returns with the compare tab open and playing). `loop: true` is a user setting. Generates s_hevc.mp4/s_vp9.webm via `make_cases_media.ensure` (ffmpeg on test side).
- Runtime: up to 25 s loop sampling + opens: ~40 s.
- Exercises: media/compare.js (clock/follower sync, loop wrap), media/engine.js (`loop: replaying N cached frames`, line 1493).

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/multiview-short-loop/follower` | With loop on, the follower stays in sync across 3 clock wraps and the clock replays cached frames | >=3 wraps seen within 25 s; log "loop: replaying N cached frames"; per wrap: early (clock<=39) and later (>= early+15) samples exist, follower advances, abs(clock-follower) <= 4 frames | **25 s wall-clock window** to see 3 wraps of a short clip (implicitly needs ~real-time playback); sync tolerance 4 frames during play; report every ~20 ms | engine (HEVC, VP9 builtin) | **3** with sync tolerance; the 25 s window is a soft perf dependency (slow machine -> fail). Cache replay logic could be **2**. |

#### Case `multiview`
- settings: none (decoder auto); env: none; ffmpeg: no.
- Instance sharing: activates via a player, closes compare between parts and at end (`h.closeClip`). Changes compare clock/sound/offsets within session only. Safe to share if no other compare session is open (the `compare report` hook addresses all compare sessions).
- Runtime: many polls (until 5-45 s); ~1.5-2.5 min.
- Exercises: src/compare.js (compareFiles/compareAdd/remove, reopen with N tiles), media/compare.js (grid layout, canvas = stage, play all, lockstep stepping, `relFor` / quarter-frame rule, ms/frame offsets, clock choice, seek bar max, sound gains, panel, clock switch while playing, remove clock), media/engine.js, media/timestretch.js (rate not used here).

| Result | Proves | Assertions | Thresholds | Layer |
|---|---|---|---|---|
| `case/multiview/grid/three-then-add` | 3 videos -> grid with "Add video" cell | all 3 tiles show a frame; n 3, mode grid, modes grid; add true; cells 3 | none | **3** |
| `case/multiview/grid/four-play` | 4 videos 2x2; canvas = stage; all play | all shown; n 4 grid add false cells 4; canvas within 1 px of stage; canvas size unchanged after first tile drew; all playing; **each tile drew >= 10 frames in 1.3 s of play** | **`s1[i]-s0[i] >= 10` frames in 1300 ms sleep** (~7.7 fps floor per tile) | **3** (relax to ">0 frames advanced") + numeric -> **4** |
| `case/multiview/sync/lockstep` | Paused seek and ±1 steps show the expected frame on every tile | synced; each tile frame === expect() or its half-frame alt, after seek 0.5, step +1, step -1 | none | **3**; `expect()` mirrors media/compare.js `relFor` + engine quarter-frame rule -> that mapping is pure -> **1**; frame exactness per decoder -> **2** |
| `case/multiview/sync/offsets` | Frame and ms offsets per tile | offsets string `0f,3f,200ms,-2f`; checkFrames; B === A+3; C moved >= 4 frames for one step; second step checkFrames | none | **3** (+1 for offset maths) |
| `case/multiview/sync/clock` | C (24 fps) as clock drives steps and seek bar | clock 2; seekMax 47; step moves C by 1; checkFrames x2 | none | **3** |
| `case/multiview/sync/sound` | One video's sound at a time | unmuted; sound 0 default; audio A,B = 1,1; gains A>0,B=0; after sound B: A=0,B>0; while playing: playing starts 1,1 and B gains | none | **3** |
| `case/multiview/sync/panel` | Compare button opens panel; Esc closes | panel cmp; Esc -> panel '-' | none | **3** |
| `case/multiview/sync/clock-while-playing` | Switching clock while playing keeps new clock's own position | B frame >= 46 (B 1.5 s ahead); checkFrames with B +1500 ms | implicit: 300 ms of play before switch (no numeric threshold) | **3** |
| `case/multiview/sync/remove-clock` | Removing the clock tile: next clock resumes at same picture | A ~#31 (±1) before; after remove: n 3, clock 0; A frame within 1 of before | none | **3** |
| `case/multiview/pair/views-and-offset` | 2 videos: side/split; B +250 ms | n 2 modes side,split; mode split/side with divider consistency; checkFrames after step with B +250 ms | none | **3** |

#### Case `multiview-native`
- settings: `decoder: 'ffmpeg'`; env: none; ffmpeg: **true**.
- Instance sharing: activates then opens compare of 4 NATIVE_CLIPS; changes stage size via hook (`stageSize`) and rate 2; closes at end. Native GPU probe state lands in globalState (first native use) — later cases' decisions may differ from a fresh profile. decoder=ffmpeg setting.
- Runtime: ~1.5-2 min.
- Exercises: src/compare.js (native tile sizing: `FRAME_SERVER_BPS`/`TRANSPORT_BPS` scale at line 278), src/decide.js (FRAME_SERVER_BPS = 400e6, FRAME_SERVER_HEIGHT), src/native.js (fitView, setView, VIEW_HEIGHTS), src/frameserver.js (HTTP stream per tile), media/framestream.js, media/compare.js, clips hevc_8_1080p.mp4, vp9_1080p.webm, h264_8_1080p.mp4, av1_8_1080p.mp4.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/multiview-native/native/tile-size` | All 4 tiles decided native; frame height fits the tile | 4 "tile X: native ffmpeg" decisions; all shown; native 1,1,1,1; heights within 2 of min(1080, sh/2, sw/2*9/16) | none | NATIVE | **3**; the height formula -> **1** (src/compare.js / src/native.js) |
| `case/multiview-native/native/frame-server` | Tiles use the HTTP frame server | transport stream x4; each tile logs "native frames over http" | none | NATIVE | **3** |
| `case/multiview-native/native/play` | All 4 native tiles play | all playing; **each tile >= 10 frames in 1.3 s** | **>= 10 frames / 1300 ms** | NATIVE | **3** relaxed / **4** numeric |
| `case/multiview-native/native/lockstep` | Native tiles step in lockstep incl. offsets (B +2 f, D +125 ms) | checkFrames after step +1 and after step with offsets | none | NATIVE | **3** (frame mapping **1**) |
| `case/multiview-native/native/resize-and-budget` | Small/large stage resizes frames; 2x rate keeps grid within the frame-server byte budget; no channel reopen | heights <= 360 at 640x360; 1080 x4 at 3840x2160; paused frames unchanged by resize; at rate 2 heights < 1080 and **bytes/s in [390e6, 400e6]**; transport stream x4; exactly 4 "native transport: http" lines; checkFrames | byte-rate budget 390-400 MB/s (a computed budget, not a measured speed) | NATIVE | **3**; the budget scaling (src/compare.js:278 with src/decide.js FRAME_SERVER_BPS) is pure -> **1** |
| `case/multiview-native/native/seek-through-resize` | Resize during a seek doesn't revert position | heights smaller than before; clock frame === floor(fps)+1 (1 s); checkFrames | none | NATIVE | **3** |

#### Case `multiview-native-fallback`
- settings: `decoder: 'ffmpeg'`; env: **`VPE_NATIVE_TRANSPORT: 'fail'`**; ffmpeg: **true**.
- Instance sharing: env is process-wide (frame server refuses all tokens -> 403) -> must not share with cases expecting the frame server. Closes at end.
- Runtime: ~40-80 s.
- Exercises: src/frameserver.js (token check 403), src/native.js / src/compare.js (fallback to postMessage), media/framestream.js, media/compare.js.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/multiview-native-fallback/native/frame-server-403` | Tiles fall back to postMessage when the frame server rejects them, and play | transport message x4, synced, all frames shown; each tile logs "native transport: message (webview:"; after play each tile shown > before+2 within 20 s | 20 s poll window, >2 frames (no rate threshold) | NATIVE, ENV | **3** |

---

### native_transfer.js

#### Case `native-transfer`
- settings: none (plus runner's ffmpegPath); env: none; ffmpeg: **true**.
- Instance sharing: `h.playClip` closes the clip. First native use triggers background GPU probe (globalState record) — affects later decisions. Safe-ish.
- Runtime: open + `h.seconds` (default 5, `--quick` 2) + 2.5 s: ~15-20 s.
- Exercises: src/frameserver.js, src/native.js (fitView / VIEW_HEIGHTS, "native: picture WxH: frames at"), src/decide.js (streamHeight, FRAME_SERVER_HEIGHT), media/framestream.js, media/player.js status (ndv=), run.js `playClip`.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/native-transfer/hevc_10_2160p.mp4` | 4K HEVC10 frames arrive over the localhost frame server at the picture's size step | playClip: first frame within 45 s, status shows playing, some shownFps > 0 after first window, no error lines; transport matches ^(ws|http); decoded size === 16:9 of smallest of [540,720,1080,1440,2160] >= needed rows | records shownFps / ndvMBs (no threshold); `shownFps>0` liveness only; play window `h.seconds` | NATIVE | **3** (size-step formula = src/native.js `fitView`/VIEW_HEIGHTS -> **1**); shownFps/MB/s numbers -> **4** |

#### Case `native-transfer-resize`
- settings: none; env: none; ffmpeg: **true**.
- Instance sharing: closes clip at end. Uses `stageSize`, `wheel`, `key z`, `seek` hooks.
- Runtime: 45 s max open + 4.5 + 1.5 + 1 s sleeps + up to 4 x 10 s waits: ~20-40 s.
- Exercises: src/native.js (`setView`, grow immediately vs shrink at next seek, `reSize`), media/inspect.js (Ctrl+wheel zoom, Z fit), src/frameserver.js.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/native-transfer-resize/hevc_10_2160p.mp4` | Growing the picture re-sizes frames at once; shrinking waits for next seek; zoom behaves the same | frames grow to 3840x2160 (within 10 s); **grow within 4000 ms**; playing after resize (some shownFps>0); shrink noted "frames 3840x2160 -> <first> at the next seek"; seek returns to first size; zoom grows to 3840x2160 **within 4000 ms**; Z noted for next seek; no error lines | **`growMs > 4000` fails; `zoomMs > 4000` fails** | NATIVE | **3** with the "grows / waits for seek" logic; the 4000 ms latencies -> **4**. Decision logic (grow-now vs lazy shrink in src/native.js setView) -> **1** |

#### Case `native-transfer-fallback`
- settings: none; env: **`VPE_NATIVE_TRANSPORT: 'fail'`**; ffmpeg: **true**.
- Instance sharing: process env -> own instance.
- Runtime: ~15-20 s.
- Exercises: src/frameserver.js (refusal), src/native.js (postMessage fallback, messageMaxHeight 1080 cap), src/decide.js (TRANSPORT_BPS).

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/native-transfer-fallback/hevc_10_2160p.mp4` | Refused frame server -> postMessage fallback, capped at 1080p, plays | playClip liveness (as above); transport ^message; decoded size === min(1080, step) 16:9 | shownFps > 0 liveness only | NATIVE, ENV | **3** (cap formula **1**) |

#### Bench cases (only with `VPE_TRANSFER_BENCH` set)
##### `transfer-bench` (settings none, env none, ffmpeg no)
- Exercises: src/extension.js `benchFrameServer` (benchFs ws/http), media/player.js bench (postMessage), src/frameserver.js.
- Instance sharing: must run alone on the machine (throughput); leaves `h264_8_1080p.mp4` **open** (no closeClip).
- Runtime: 6 x 2 reps x up to 60 s; typically ~1-2 min.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/transfer-bench/1080p/message` | postMessage throughput, 1080p frames (3110400 B x 240) | a result line with "= N MB/s" | MB/s and fps recorded | ENV | **4** |
| `case/transfer-bench/1080p/ws` | WebSocket throughput | same | same | ENV | **4** |
| `case/transfer-bench/1080p/http` | streaming fetch throughput | same | same | ENV | **4** |
| `case/transfer-bench/2160p/message` | 2160p (12441600 B x 90) | same | same | ENV | **4** |
| `case/transfer-bench/2160p/ws` | | same | same | ENV | **4** |
| `case/transfer-bench/2160p/http` | | same | same | ENV | **4** |

##### `native-bench-<h>-<mode>` (only with `VPE_TRANSFER_BENCH` **and** `VPE_TRANSFER_CLIPS`)
- Loop values: heights `VPE_TRANSFER_HEIGHTS` (default `0,1080`) x modes `VPE_TRANSFER_MODES` (default `auto,message`) -> `native-bench-0-auto`, `native-bench-0-message`, `native-bench-1080-auto`, `native-bench-1080-message`. Seconds `VPE_TRANSFER_SECONDS` (8).
- settings: `nativeMaxHeight: <h>`; env: `{}` for auto else `VPE_NATIVE_TRANSPORT: <mode>`; ffmpeg: **true**.
- Instance sharing: fresh profile required (waits for the first-run ffmpeg GPU probe, up to 120 s, so it doesn't compete); must run alone.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/native-bench-<h>-<mode>/probe` | (only on failure) GPU probe finished | probe log within **120 s** | 120 s | NATIVE, ENV | **4** |
| `case/native-bench-<h>-<mode>/<clip basename>` (one per file in VPE_TRANSFER_CLIPS) | shown fps, ndv fps, MB/s, host stats per clip and transport | playClip liveness; records shownFps, windows, ndvFps, ndvMBs, transport, size, method, hostStats, othersLoad | numbers recorded only | NATIVE, ENV | **4** |

---

### Totals

Default run (no bench env): 23 cases, **80 results** (+ skip/error placeholder names possible):
compare_metrics 3, compare_ui 9, cpu_4k 0, ctxmenu 5, file_icons 2, file_icons_pixels 5, hdr_output 15 (5 + 5 + 5),
inspect 12, keyconflicts 3, modes 5, multiview 18 (1 + 10 + 6 + 1), native_transfer 3.

With `VPE_CPU_BENCH`: +4 cases / +8 results. With `VPE_TRANSFER_BENCH`: +1 case / +6 results; with
`VPE_TRANSFER_CLIPS` too: +4 cases / +4 x (N clips [+1 probe on failure]) results.

### Explicit time/fps/ms thresholds found
- hdr_output_forced[_native]/play/*: `frames >= 10` in 3 s play.
- multiview/grid/four-play and multiview-native/native/play: `>= 10` frames per tile in 1.3 s.
- native-transfer-resize: grow and zoom latency `<= 4000 ms`.
- multiview-short-loop/follower: 3 wraps within a 25 s window; sync within 4 frames while playing.
- modes/layout/controls: t advances within 600 ms of play (implicit).
- multiview-native/native/resize-and-budget: byte budget 390-400 MB/s (computed from heights x fps, not measured — correctness of budget logic, not perf).
- cpu_4k, transfer-bench, native-bench-*: pure measurement (layer 4).
- file_icons_pixels: pixel tolerances (not time).

### Instance-sharing hazards (summary)
- Leaves editors open: **ctxmenu** (player), **multiview-short-loop** (compare playing), **transfer-bench** (player).
- Asserts exact tab set: **compare_ui** (enter/in-place, leave: exactly 1 tab).
- `compare report` hook is broadcast to all compare sessions: modes, multiview*, compare_ui, compare_metrics break if a stray compare tab exists.
- Process env (needs own instance or env-switchable hook): hdr_output_forced* (`VPE_HDR_FORCE`), multiview-native-fallback & native-transfer-fallback (`VPE_NATIVE_TRANSPORT=fail`), cpu-4k-* (`VPE_THUMB_STRIP`, `VPE_NATIVE_METHOD`), native-bench-* (`VPE_NATIVE_TRANSPORT`).
- Settings differing per case: compare_ui & multiview-short-loop `decoder: builtin`; multiview-native* `decoder: ffmpeg`; multiview-short-loop `loop: true`; hdr_output*/inspect `advancedMode: true`; inspect `confirmedUriHandlerExtensionIds`; autoplay false in several; file_icons_pixels theme/zoom/iconTheme/activityBar/statusBar; cpu-4k/native-bench `nativeMaxHeight`; ffmpeg cases `ffmpegPath` + PATH with ffmpeg (others strip ffmpeg from PATH).
- Global state written: file_icons/file_icons_pixels (extension writes `files.associations` to user settings + globalState `videoPreviewEnhanced.fileIcons`; actually every case activating the extension does this); first native use writes the ffmpeg GPU probe record (cpu-4k-default and native-bench need a fresh one).
- Fresh profile needed: cpu-4k-default, native-bench-* (GPU probe), file_icons/associations-written (expects defaults), file_icons_pixels (layout).
- Side effects outside instance: ctxmenu copyTime (system clipboard); keyconflicts writes test/vscode/out/keyconflicts.json; inspect/links launches a 2nd Code.exe; cpu_4k/hdr_output write media to temp/HDR media dirs.

### Source -> scenario map
- src/compare.js: compare_metrics, compare_ui, modes(compare/views), multiview*, (budget) multiview-native
- src/ctxmenu.js: ctxmenu
- src/decide.js: multiview-native (FRAME_SERVER_BPS), native-transfer*, cpu-4k-*
- src/extension.js (test hooks, fileIcons, URI handler, benchFrameServer, defaultKeybindings): all; esp. file_icons*, inspect/links, keyconflicts, transfer-bench
- src/frameserver.js: native-transfer*, multiview-native*, transfer-bench, cpu-4k-*
- src/native.js: native-transfer*, multiview-native*, hdr_output_forced_native, cpu-4k-*
- src/hwaccel.js: cpu-4k-* (VPE_NATIVE_METHOD), native-bench-*
- src/probe.js: hdr_output dv/*, multiview-native decisions
- src/thumbhost.js: inspect/thumbs
- media/compare.js: compare_metrics, compare_ui, modes, multiview*
- media/engine.js: everything decoding builtin; inspect/hdr/*, hdr_output (shader tf), multiview-short-loop (loop cache)
- media/hdr.js: hdr_output* (also imported in Node by the test for expected values)
- media/inspect.js: inspect/pixel*, inspect/zoom, native-transfer-resize (zoom)
- media/player.js, media/controls.js: ctxmenu, modes, inspect, compare_ui (bar), all `state` hooks
- media/scopes.js, media/modes.js: modes
- media/thumbs.js, media/thumbs-worker.js: inspect/thumbs/seek-bar
- media/xray.js, media/xray-worker.js: inspect/xray/strip
- media/framestream.js: native-transfer*, multiview-native*
- media/membudget.js: compare (memScale) indirectly
- package.json (languages/icons/customEditors): file_icons, file_icons_pixels; media/icons/*: file_icons_pixels

## Appendix B: what each result asserts (suite and cases, part 2)

Layers: **1** unit (pure Node) · **2** engine (libav.js WASM in Node, frame-exact) · **3** VS Code scenario (correctness, no fps/time thresholds) · **4** performance (numbers vs previous runs).

### Common mechanics (apply to every row below)

- **Runner** (`test/vscode/run.js`): one fresh hidden VS Code per case (temp profile, `--extensionDevelopmentPath`, `VPE_LOG`). Start = launch + `sleep(3000)`; stop = taskkill + profile delete (~10-15 s overhead per case). Instance `PATH` has ffmpeg folders stripped unless the case has `ffmpeg: true`; `ffmpeg: true` also sets `videoPreviewEnhanced.ffmpegPath`. A case with `ffmpeg: true` and no ffmpeg is a single `skipped` row. A case whose instance had no WebGL2 (`NO_WEBGL` log line) and any failure is re-run once in a fresh instance after 20 s.
- **`h.ffmpeg`** (the runner's ffmpeg: `--ffmpeg`, `VPE_FFMPEG`, or `where ffmpeg`) is passed to every case even when the instance's PATH has none: used for reference frames and clip making in the runner process.
- **Clips**: `lib.clip(name)` makes `test/media/cases/<name>` with ffmpeg on demand (`test/media/make_cases_media.js`, needs libx264/libx265/libvpx/libvpx-vp9/libopus/libmp3lame/prores_ks/libsvtav1/libtheora…). So *every* case using `lib.clip` needs ffmpeg in the runner unless the media already exists.
- **`P.expectFrame(k)`** (lib.js): polls `thumb` (webview's 64x36 luma of the canvas + the frame number the player says it shows, 0-based) every 120 ms until `th.frame === k` AND (with ffmpeg) the argmax of normalised cross-correlation (NCC) against ffmpeg's decode of the same file (`-vf scale=64:36:flags=area,format=gray`, all frames, `-fps_mode passthrough`) over reference pictures `k-15..k+15` maps to slot `k` (slot = round((pts-pts0)*fps) from ffprobe `best_effort_timestamp_time`). No NCC minimum, only argmax. Default timeout 12 s (some 15/20 s). Without ffmpeg only the counter is checked.
- **`P.close()`** = `workbench.action.closeAllEditors` + 700 ms. Every `lib.open`-based result closes its editors in `finally`, so editors don't leak between results (exceptions noted).
- **Timeouts** (waitLog/waitState 4-90 s) are liveness limits, listed only when they double as a speed judgement.

#### Global state the extension persists (instance-sharing hazards)
Keys in `globalState` (src/extension.js, src/decide.js) that survive between cases if cases share one instance:
- `videoPreviewEnhanced.positions` (resume, extension.js:1512-1548): per file path+size+mtime; resumes when `t > 5 && d - t > 5`. Only clips longer than 10 s can be affected: `long_20s.mp4`, perf_invisible `_x10` clips, `sp_*_20s`, `rs_sync_200s.mkv`, `rs_link_1080p*.mkv`, bitmap-sub files, `tracks_multi.mkv`, test/media 4K clips if played > 5 s.
- `videoPreviewEnhanced.onboarding` (first-open popup; asked only once per profile, and only without ffmpeg).
- `videoPreviewEnhanced.builtinSpeed` (measured WASM speed per class, flushed every 15 s; drives the "falling behind / suggest ffmpeg" hint), `…hint` key, `videoPreviewEnhanced.nativeFailed`, tool cache (`TOOLS_KEY`), `lastView`, `settingFallback`.
- User `settings.json`: written by `ui_jumps` (jump.arrow=10, stepButtons=jump); extension may also add `workbench.editorAssociations` (auto-default) globally.
- Process env (cannot change in a running instance): `PATH` with/without ffmpeg, `VPE_EXPORT_DIR`, `VPE_SAVE_DIR`, `VPE_THUMB_STRIP`, `VPE_RS_ENCODER`, `VPE_TOTALMEM`.

---

### 1. Built-in suite — test/vscode/run.js

Instances: (a) `play` instance: default settings + `workbench.editorAssociations` *.mp4/*.webm → `playerOptional`, env PATH without ffmpeg. (b) `native` instance: `videoPreviewEnhanced.ffmpegPath` = ffmpeg (skipped → row `native` ok/skipped when no ffmpeg). `--seconds` default 5 (quick: 2). `--grep/--only` filter on names. `--quick`: only `h264_aac_anim_1080p.mp4`, `hevc_8_1080p.mp4`, native `hevc_10_1080p.mp4`.

`playClip(vs, clip, {seconds, native, onShown})` assertions (shared by `play/*`, `native/*`, `remote_stream`, `short_loop`):
1. first frame log `[name] webview: first frame shown` within 45 s (open via `code --reuse-window file`);
2. `webview: streams: -> video X, audio Y`: X must equal `clip.expect` (webcodecs/soft; native forces 'native');
3. `status` lines over `seconds*1000+2500` ms: some `playing=true` (else "not playing"); some shownFps > 0 after the first 2 s window (else "no frames shown");
4. `clip.sound`: audio stream picked (`audio !== 'none'`);
5. non-native & fps logged: pause, then seek to middle of frame `k1 = min(round(fps*1.2)+3, frames-2)` and `k=7`, poll `report` (counter only, NO picture compare) until frame == k within 12 s;
6. no `error:` / `webview: error:` / `unhandled rejection` lines for that file.
Recorded, not judged: `openMs` (command→first frame), `fps`, `shownFps` (median of windows after the first), `shownFpsWindows`, `seeks[].ms`, `othersLoad` + `noisy` (test/loadmon.js), `sound {ac, clock, sources}`, `decision`.

| Result | Proves | Assertions | Time/perf thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `wcprobe` | The real webview (page + worker) has WebCodecs H.264 and VP8 (and logs AudioDecoder / `<video>` support) | page & worker objects present; `h264` and `vp8` contain `Y` | none (15 s timeout) | WebCodecs, real VS Code webview; runs inside the first play clip | 3 (environment precondition; could be a startup self-check for every scenario run) |
| `play/mpeg2_1080p.mpg` | MPEG-2 1080p opens, WASM path, plays, counter-seek | playClip 1-6, expect `soft` | shownFps>0 only; fps logged; seek ≤12 s | WebGL2, WASM | 3 (path+play+seek) / 4 (openMs, shownFps) |
| `play/h264_8_2160p.mp4` | 4K H.264 → WebCodecs | expect `webcodecs` | same | WebCodecs, GPU | 3/4 |
| `play/hevc_10_2160p.mp4` | 4K HEVC 10-bit in WASM | expect `soft` | same (4K WASM seek can take seconds, 12 s cap) | WASM | 3/4 |
| `play/av1_8_1080p.mp4` | AV1 → WASM | expect `soft` | same | WASM | 3/4 |
| `play/vp9_2160p.webm` | 4K VP9 → WASM | expect `soft` | same | WASM | 3/4 |
| `play/prores_proxy_1080p.mov` | ProRes → WASM (24 frames; seek k clamped to frames-2) | expect `soft` | same | WASM | 3/4 |
| `play/h264_aac_anim_1080p.mp4` | H.264+AAC → WebCodecs with sound; also hosts `wcprobe` | expect `webcodecs`, sound picked | same | WebCodecs | 3/4 |
| `play/hevc_8_1080p.mp4` | HEVC 8-bit → WASM | expect `soft` | same | WASM | 3/4 |
| `play/h264_aac.mkv` | H.264 in MKV on WebCodecs + sound | expect `webcodecs`, sound | same | WebCodecs | 3/4 |
| `play/h264_aac.mov` | … MOV | same | same | WebCodecs | 3/4 |
| `play/h264_aac.m2ts` | … M2TS | same | same | WebCodecs | 3/4 |
| `play/h264_aac.flv` | … FLV | same | same | WebCodecs | 3/4 |
| `play/h264_aac.avi` | … AVI (src/avi.js header read) | same | same | WebCodecs | 3/4 |
| `play/vp8_vorbis.webm` | VP8+Vorbis → WebCodecs + sound | same | same | WebCodecs | 3/4 |
| `native/hevc_10_2160p.mp4` | ffmpegPath set → decision `native ffmpeg…`, picture plays | decision `^native ffmpeg`; playing; frames shown; no errors (no seek check) | shownFps>0 only; decision wait 8 s | native ffmpeg | 3 (decision+play) / 4 (fps) |
| `native/av1_10_2160p.mp4` | same for AV1 10-bit 4K | same | same | native ffmpeg | 3/4 |
| (`native/hevc_10_1080p.mp4`) | quick only | same | same | native ffmpeg | 3/4 |
| (`native`) | skip row when no ffmpeg | — | — | — | — |

Loop values: `CLIPS` (14, full) = mpeg2_1080p.mpg, h264_8_2160p.mp4, hevc_10_2160p.mp4, av1_8_1080p.mp4, vp9_2160p.webm, prores_proxy_1080p.mov, h264_aac_anim_1080p.mp4, hevc_8_1080p.mp4, containers/h264_aac.{mkv,mov,m2ts,flv,avi}, containers/vp8_vorbis.webm (result name uses the full `clip.file`, e.g. `play/containers/h264_aac.mkv`). `NATIVE_CLIPS` = hevc_10_2160p.mp4, av1_10_2160p.mp4.

`--activation` (no results rows, prints JSON): 4 instances checking whether `mpeg2_1080p.mpg` given on the first command line / forwarded / installed-copy / restarted profile / fresh profile with `*.mpg` association opens in the extension (25 s waits). Diagnostic of VS Code behaviour → keep as a manual layer-3 tool, not in CI.

Run time: README says suite 2-4 min (full), `--quick` ~1 min total.
Source exercised: src/extension.js (editor provider, test hook `.cmd`, log), src/decide.js (path choice), src/sniff-*.js, src/avi.js, src/ffmpeg.js + src/native.js + src/frameserver.js + media/framestream.js (native), media/player.js, media/engine.js, media/decoder-worker.js, media/pool.js, media/libav-vpe, media/membudget.js.

Proposed split: keep `wcprobe` + one `play/` per decode path (WebCodecs, WASM, native) as layer-3 smoke with path/play/seek asserts; container claim (`containers/*`) → the decision part is layer 1 (src/decide.js `webcodecsPlays` + sniffers on the files) and one container in layer 3; all `openMs/fps/shownFps` → layer 4 (benchq only).

---

### 2. Cases

#### 2.1 onboarding.js

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/onboarding-ffmpeg/decision/h264_8_1080p.mp4` | With ffmpeg, 8-bit H.264 stays on WebCodecs | first frame ≤45 s; decision line matches `built-in: 8-bit H.264: the editor's GPU decoder (WebCodecs)`; streams `-> video webcodecs` | none | native ffmpeg present, WebCodecs | 1 for the rule (src/decide.js) + 3 for the logged/streams path |
| `case/onboarding-ffmpeg/decision/hevc_8_1080p.mp4` | With ffmpeg, HEVC goes to native | decision matches `native ffmpeg (` | none | native ffmpeg | 1 (rule) + 3 |
| `case/onboarding-ffmpeg/no-popup-with-ffmpeg` | No first-open popup when ffmpeg exists | no `onboarding: first video` line in the whole instance log | none | ffmpeg | 3 (state machine `decide.afterOnboard` → 1) |
| `case/onboarding/popup-once` | Without ffmpeg the first video asks once | `onboarding: first video, asking about ffmpeg` ≤30 s; first frame; after 2nd clip (hevc_8_1080p) exactly 1 such line | none | no ffmpeg on PATH, fresh globalState | 3 (+1 for decide logic) |
| `case/onboarding/reminder-4k-hevc10` | After dismissing, 4K HEVC 10-bit built-in falls behind → hint | `notifications.clearAll` → `onboarding: answer dismissed`; `built-in decoding at … suggesting ffmpeg:` ≤30 s; wording regex `HEVC 10-bit 4K decodes at N× here … Set up ffmpeg (≈N MB, no admin needed): … faster` | implicit: relies on WASM decoding *falling behind* real time on this machine (a fast machine may never trigger it); 30 s wait | no ffmpeg, slow-enough CPU | 3 for wording/flow with a forced speed (e.g. seed `builtinSpeed`), the threshold logic → 1 (decide.js hint) |

Case table: `onboarding-ffmpeg` {settings: none; env: none; ffmpeg: true}; `onboarding` {settings none; env none; ffmpeg false}.
Hazards: both depend on a *fresh* `globalState` onboarding key and on the whole-instance log (`vs.lines` from 0). `no-popup-with-ffmpeg` fails if any earlier case in the instance ran without ffmpeg (popup is shown on the first video of any no-ffmpeg case). `popup-once` fails if the popup was already answered. `reminder` depends on `builtinSpeed`/hint keys and on no other popup pending. Must run in a fresh profile (or reset those globalState keys).
Runtime (est.): onboarding-ffmpeg ~30 s; onboarding ~60-90 s (4K WASM).
Source: src/extension.js 331-368 (onboarding + hint), src/decide.js (ONBOARD_KEY, afterOnboard, hint, builtinSpeed, webcodecsPlays), src/ffmpeg.js, src/native.js, media/engine.js (speed samples).

#### 2.2 perf_invisible.js

Clips: `longClip` stream-copies test/media clips looped 10x into `%TEMP%/vpe-perf-invisible-clips/` (uses `ffmpeg` on PATH of the runner): `h264_aac_anim_1080p_x10.mp4` (WebCodecs+AAC, ~30 s), `hevc_10_2160p_x10.mp4` (native, ~20 s), `h264_8_2160p_x10.mp4` (WebCodecs 4K), bench also `hevc_8_1080p_x10.mp4`.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/perf-invisible/hidden-native` | Hidden native tab stops ffmpeg; shown again at same frame and plays | ≥1 ffmpeg.exe in instance process tree while shown; log `native: tab hidden, ffmpeg stopped` ≤8 s; 0 ffmpeg while hidden; `native decode from` on re-show ≤10 s; same frame ≤8 s; playing & frame > f0+5 ≤8 s | process count (Win32_Process), timeouts | native ffmpeg, PowerShell CIM | 3 |
| `case/perf-invisible/audio-rest` | AudioContext suspends after pause and resumes as clock with low drift | if AC never runs (hidden desktop, autoplay policy): pause 3.5 s, play, frame > q+10 ≤6 s (and note). Else: `ac==='suspended'` after pause ≤8 s; `running && audioMaster` after play ≤5 s; drift samples over 1.5 s exist and `max|drift| ≤ 0.1 s` | **drift ≤ 100 ms**; recorded `resumeMs` | WebCodecs, AudioContext (usually suspended on hidden desktop → degraded path) | 3 (rest/resume); drift number → 4 |
| `case/perf-invisible/paused-readahead/native` | Paused native player reads ~1 s ahead, not to budget; steps still land | paused at 8 s (±0.2) ≤10 s; status line present; `ahead ≤ 2.2 s`; queued ≥1; 3 single steps reach f0+i ≤5 s each | **ahead ≤ 2.2 s** (media seconds, after 4.5 s wall) | native ffmpeg | 3 (bounded read-ahead is correctness of the budget; could be 1 with a fake clock) |
| `case/perf-invisible/paused-readahead/webcodecs` | same for WebCodecs 4K | same with `ahead ≤ 4.5 s` | **ahead ≤ 4.5 s** | WebCodecs, GPU | 3 |
| `case/perf-invisible/loop-rest` | Frame loop rests while paused; step/time label/context still update | rests counter grew or >0; `framesIn4sPaused ≤ 0.5*rate*4` (rate = animation frames/s while playing over 2 s); `vscodeContext` has `"vpePlaying":false`; step moves frame+1 ≤4 s and timeText changes; play → context `vpePlaying:true` ≤4 s; frames advance >10 ≤4 s | **rAF count paused ≤ half the playing rate**; sleeps 2/2.5/4 s | WebCodecs | 3 (counter-based, robust) |
| `case/perf-invisible/skipped` | no ffmpeg | — | — | — | — |
| `case/perf-invisible-bench/idle-empty` (VPE_PERF_BENCH=1) | Baseline CPU/mem of an instance | none (records cpu%/role, private MB) | measured over `VPE_PERF_SECONDS` (15 s) | PowerShell CIM | 4 |
| `…-bench/paused-webcodecs-sound` | CPU/mem of a settled paused WebCodecs+sound player | first picture shown (else throws) | measurement only | WebCodecs | 4 |
| `…-bench/paused-native-4k` | same for native 4K | same | measurement | native | 4 |
| `…-bench/after-pause-native-4k` | CPU in 10 s after pause + queue | same | measurement | native | 4 |
| `…-bench/after-pause-webcodecs-4k` | same WebCodecs 4K | same | measurement | WebCodecs | 4 |
| `…-bench/hidden-native` | mem shown vs hidden, CPU hidden | first pictures | measurement | native | 4 |
| `…-bench/native-720-picture-4k` | native frames sized to a 1280x720 device-px stage (stageSize hook) | first picture | CPU, shownFps, frame size recorded | native | 4 (frame-size choice part → 3 assert "frames 1280x720") |
| `…-bench/native-720-picture-1080p` | same 1080p | same | same | native | 4 |

Case table: `perf-invisible` {settings: none; env: none; ffmpeg: true}; `perf-invisible-bench` {settings none; env `VPE_THUMB_STRIP=0`; ffmpeg: true; only exported when `VPE_PERF_BENCH` set; also reads `VPE_PERF_SECONDS`, `VPE_PERF_ONLY`, `VPE_PERF_DPR`}.
Hazards: CPU/mem sampling counts *every* Code.exe/ffmpeg whose command line names the profile dir → in a shared instance other cases' leftover tabs/ffmpeg skew numbers (bench must stay alone, ideally its own instance). `paused-readahead` seeks to 8 s and closes → `positions` stores 8 s for `_x10` clips (≥20 s) → a later open of the same file resumes at 8 s (audio-rest/loop-rest reopen `sound` clip: they'd start mid-file; harmless for their asserts, but changes state). `hidden-native` uses `closeActiveEditor`; fine. bench `stageSize` modifies one page only. `audio-rest` depends on AudioContext policy of the desktop.
Runtime (est.): functional ~1.5-2.5 min; bench ~4-6 min (8 × (15 s + opens)).
Source: src/native.js (tab hidden stop/restart, `native decode from`), src/frameserver.js, media/framestream.js, media/player.js (frame loop rest, AudioContext rest, `vscodeContext` → src/ctxmenu.js), media/engine.js (paused read-ahead, audio clock/drift), media/membudget.js, media/pool.js.

#### 2.3 playback.js

Decode paths of the clips (from make_cases_media.js + decide.webcodecsPlays): WebCodecs = 8-bit 4:2:0 H.264 and VP8; everything else in the built-in decoder = WASM libav.js; no ffmpeg in these instances.

`FORMATS` loop (18): h264_high10.mp4 (WASM, 10-bit), h264_444.mp4 (WASM), hevc10.mp4 (WASM), hevc10_opus.mkv (WASM), vp8_vorbis.webm (WebCodecs), av1_opus.mkv (WASM), h264_ac3.mts (WebCodecs + AC-3 WASM audio), mpeg2_ac3.vob (WASM), mpeg2_interlaced.mpg (WASM), wmv2_wma.wmv (WASM), wmv2_wma.asf (WASM), dnxhr_pcm.mxf (WASM), theora_vorbis.ogv (WASM), flv1_mp3.flv (WASM), odd_853x479.mkv (MPEG-4 Pt2 WASM), h264_ac3_51.mkv (WebCodecs), h264_noaudio.mp4 (WebCodecs, sound=0), h264_vfr.mkv (WebCodecs, sound=0). All `fmt/` prefixed in names.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/playback/open/fmt/<each of 18>` | Format opens, picture, sound decoded, plays | waitFirstFrame (no error message); no overlay message; canvas w,h>0 and not hidden; engine→firstShown; sound files: `amode` not none; play → shownCount +3 (or frame change for non-engine) ≤8 s; t or frame changed | 8 s liveness only | WASM / WebCodecs per clip; ffmpeg to make clips | 2 for demux+decode of WASM formats (first frame, audio decoded) + 3 one-per-path smoke |
| `case/playback/open/audio-only` | Audio-only file plays without restarting | state `amode` set, no could-not/failed; sample 2.2 s: no backward jumps (except loop wrap), `speed > 0.5`, no overlay message | **media speed > 0.5× wall** over 2.2 s | WASM AAC audio | 3 (speed check is a loose liveness; replace with "time advances") |
| `case/playback/rate/speed` | Rates 2/0.5/1/1.5 change media speed (and audio is clock when AC runs) | per rate: engine `rate === r`; `|speed/rate - 1| < 0.15` over 2.6 s; if ac running every sample `audioMaster` | **±15 % media-vs-wall speed** | long_20s.mp4 (WebCodecs H.264+AAC), timestretch | 3 (rate wiring) + rate accuracy → 2/1 (timestretch, clock maths) or 4 |
| `case/playback/neighbour/next-prev` | Shift+N/Shift+P open next/prev file in folder; toast at the first | Shift+N → `[n3.mp4] first frame shown` ≤30 s; Shift+P from n2 → n1; Shift+P on n1 → toast `First video` | none | WebCodecs (160x90 H.264) | 3 (folder listing/sort → 1) |
| `case/playback/rotation/rotated.mp4` | Display-rotation 90° gives a portrait canvas and ffmpeg's rotated frame 0 | canvas h > w; expectFrame(0) (NCC vs ffmpeg, which applies rotation) | none | WebCodecs, ffmpeg refs | 1 (src/rotation.js matrix) + 3 (picture) |
| `case/playback/status/fully-decoded-stable` | "Fully decoded" status while paused is stable and stays while playing without seek; no notice | status reaches `Fully decoded` ≤25 s; 2 s paused sample one value; 2.5 s playing sample one value `Fully decoded`; no `notice` | 25 s to fully decode a 3 s clip | s_hevc.mp4 → WASM | 3 (cache state; could be 2 at engine level) |
| `case/playback/resume/position` | Position remembered per file; not within first seconds | seek 12.25 (±0.1) ≤15 s, wait 2.5 s, close; reopen → firstShown at 12.25±0.15 ≤20 s; expectFrame(367) (NCC); seek 3, close, reopen → t<1 | none | long_20s.mp4 WebCodecs; ffmpeg refs; **globalState positions** | 3 (resumeAt rule → 1) |
| `case/playback/damaged-h264/damaged_h264.mkv` | One garbage picture at 2.5 s; playback continues | play to t>4 (or stopped at >3) ≤20 s; `shownCount > 60`; no error overlay (ERR regex); records vmode + decoder lines | shownCount>60 by t≈4 (frames, not time) | H.264 (starts WebCodecs; may fall to WASM) | 3 (WebCodecs error handling) |
| `case/playback/damaged-h264/damaged_h264_b.mkv` | same, damaged header variant | same | same | same | 3 |
| `case/playback/truncated/trunc_moov.mp4` | MP4 cut before moov: clear error, no hang | message not Opening/Loading ≤25 s and matches `could not be opened|damaged|incomplete` | none | — | 2 (demux error in Node) + 3 (message shown) |
| `case/playback/truncated/trunc_faststart.mp4` | Cut mid-data: first half plays | first frame, no message, canvas>0; play → shownCount +6 ≤10 s | none | WebCodecs | 2 (demux of truncated) + 3 |
| `case/playback/truncated/trunc.mkv` | same MKV | same | none | WebCodecs | 2 + 3 |
| `case/playback/audio/truehd-51side` | TrueHD 5.1(side): 6 ch, few buffers, bounded sources | after 2.5 s playing: `audioChannels === 6`; `audioChunks ≤ audioSeconds*30`; `sources < 200`; if ac running `audioMaster` | chunk-rate and source counts (not time) | WASM TrueHD decode, WebAudio | 2 (decode+chunk joining) + 3 (WebAudio sources) |
| `case/playback/audio/71-centre-downmix` | 7.1 with centre-only → mixed to stereo for WebAudio | audioChunks ≥3 ≤15 s; `audioChannels === 2` | none | WASM FLAC | 2/1 (downmix maths) |
| `case/playback_autoplay/autoplay-late-start/start3600.mts` | First PTS 3600 s: autoplay starts at once | sample 1.8 s: `0.6 < speed < 1.6` | **media speed 0.6-1.6× wall** | H.264 TS → WebCodecs | 3 (replace with "t advances" or clock origin unit test → 1/2) |
| `case/playback_autoplay/autoplay-late-start/start3600_mpeg2.mts` | same MPEG-2 | same | same | WASM | 2/3 |
| `case/playback_autoplay/end-of-sound/audio_longer.mp4` | Sound outlasting picture plays to its end (loop off); play after end restarts | sample 7.5 s: not playing at end; max played t > 4.4; play → playing and t<1.5 after 0.9 s | 7.5 s window; t thresholds (media) | WebCodecs + AAC | 3 |
| `case/playback_loop/loop-sound-only/sine_only.mkv` | Audio-only loop wraps at end of sound, not early | sample 8 s; wrap found; wrap point > 4.3 s | 8 s window | WASM AAC | 3 (end-time computation → 2) |

Case table: `playback` {settings advancedMode=true, autoplay=false; env none; ffmpeg false}; `playback_autoplay` {advancedMode, autoplay=true, loop=false}; `playback_loop` {advancedMode, autoplay=true, loop=true}.
Hazards: resume/position writes `positions` for long_20s.mp4 (ends at 3 s → no resume afterwards, but rate/speed played long_20s for ~13 s media time and closed → stores a resume point (likely >5 s) that **resume/position itself then sees on its first open** only if the seek didn't override — it seeks first, ok); other cases opening long_20s.mp4 (ui_jumps, ui_jumps_settings, scopes export/hidden) would resume mid-file if run after it in the same instance and vice versa. resume/position also fails if a previous case left long_20s at a position (first open waitFirstFrame fine, then seek; ok) — but last check `z.t < 1` depends on its own store. Settings autoplay/loop differ between the three cases. neighbour opens n3/n1 via the page (closed by closeAllEditors).
Runtime (est.): playback ~3-4 min (31 results); autoplay ~30 s; loop ~15 s.
Source: media/engine.js, media/decoder-worker.js, media/pool.js, media/libav-vpe, media/timestretch.js (rates), media/player.js (status, toast, autoplay/loop, audio graph), src/extension.js (neighbour files 1500-1508, resume 1512-1548, failed files), src/rotation.js, src/sniff-codecs.js / src/sniff-matroska.js, src/decide.js.

#### 2.4 remote_stream.js

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/remote_stream/hevc_10_2160p.mp4` | remoteStream=on: HEVC 10-bit 4K streamed as H.264 by ffmpeg, decoded by WebCodecs | playClip 1-6 with expect `webcodecs`; decision `^remote stream`; streamStats recorded | playClip (shownFps>0; seeks counter ≤12 s) | ffmpeg (encoder), WebCodecs | 3 / fps → 4 |
| `case/remote_stream/hevc_10_1080p.mp4` | same 1080p | same | same | same | 3/4 |
| `case/remote_stream/vp9_opus_anim_1080p.webm` | same VP9+Opus | same | same | same | 3/4 |
| `case/remote_stream/encoder` | Encoder probe logged | a `remote stream encoder on` line exists | none | ffmpeg | 3 (choice logic → 1) |
| `case/remote_stream/seeks` | 20 scrub seeks (40 ms apart) + 3 steps back on a 2 s clip: all from memory | landed frame == floor(last*24); ffmpegStarts ≤0 for scrub; 3 steps back each land (≤6 s); step ffmpeg starts ≤0 | waitFrame 12 s/6 s | ffmpeg, WebCodecs | 3 (the restart-count policy could be 1 with a fake ffmpeg) |
| `case/remote_stream_long/rs_sync_200s.mkv` | 150 s (60 s quick) of streamed playback keeps real time, sound sent in step, no restarts | never stopped; `wall - position ≤ 1.5 s`; stats lines exist; sound lead in **-0.5..2.1 s**; 0 ffmpeg restarts; decision `^remote stream` | **lag ≤ 1.5 s over 150 s; sound lead −0.5…2.1 s** | ffmpeg (makes 200 s MPEG-4+PCM clip in %TEMP%/vpe-rs-case), WebCodecs | 4 (long soak/timing) ; decision → 3 |
| `case/remote_stream_long/seeks` | 20 seeks across 200 s: ≤8 ffmpeg starts, lands on last target; 3 steps back ≤1 restart (6 s sleep after first) | as seekChecks with maxStarts 8, maxStepStarts 1 | counts; 6 s read-ahead wait | same | 3 |
| `case/remote_stream_fallback/pixel-tools` | Pixel inspector ('x') on a streamed 1080p view offers "Use full resolution" → built-in WASM 3840x2160 | webcodecs & canvas h 1080; click notice action found; then vmode soft, canvas 3840x2160 | 15 s default waits | ffmpeg (libx264 encoder forced), WebCodecs + WASM | 3 |
| `case/remote_stream_fallback/ffmpeg-exit` | Killing the stream's ffmpeg falls back to built-in decoder without retry | log `remote stream failed (signal SIGTERM…); using the built-in decoder`; soft & playing, canvas h 360; 0 stream starts after | none | ffmpeg | 3 |
| `case/remote_stream_fallback/slow-link` | Throttled link (550 kB/s) steps to 720p without timeline break, recovers to 1080p, floor at 360p at 12 kB/s without failover | 720p ≤18 s, same `gen`, t advanced; after 4.5 s still 720p playing and `frames ≥ 3.5*fps`; unthrottle → 1080p ≤35 s same gen; 12 kB/s → log "can't carry the lowest quality … staying at 360p" ≤45 s; still webcodecs; no `remote stream failed` | **≥3.5×fps frames in ~4.5 s at 720p** (real-time throughput); 18/35/45 s windows | ffmpeg (makes rs_link_1080p.mkv in test/vscode/out), WebCodecs, `remoteStreamRate` hook | 3 for ladder decisions (could be 1 with a simulated link) ; keeping-time → 4 |
| `case/remote_stream_fallback/slow-link-sound` | With PCM sound, 700 kB/s goes straight to 480p; 250 kB/s → 360p floor + notice, no failover | first lower step is 480p ≤20 s, same gen; after 5 s `frames ≥ 4*fps` and webcodecs; log "can't carry the lowest quality with its sound" ≤30 s; 360p & webcodecs; no failure | **≥4×fps frames in 5 s** | same (rs_link_1080p_sound.mkv) | 3 / 4 |

Loop values: `CLIPS` = hevc_10_2160p.mp4, hevc_10_1080p.mp4, vp9_opus_anim_1080p.webm.
Case table: `remote_stream` {settings remoteStream='on', editorAssociations *.mp4/*.webm/*.mkv → playerOptional; env none; ffmpeg true}; `remote_stream_long` {+ loop=false; ffmpeg true; 150 s / 60 s quick}; `remote_stream_fallback` {remoteStream on, loop false, advancedMode true, assoc; env `VPE_RS_ENCODER=libx264`; ffmpeg true}.
Hazards: `rs_sync_200s.mkv` is used by both `remote_stream_long` (plays 150 s then seeks around → stores a resume point in `positions`) and `remote_stream_fallback/ffmpeg-exit` → in a shared instance the fallback would open mid-file (and the stream would start there). `VPE_RS_ENCODER` is process env (needs its own instance). `remoteStreamRate` throttle is per page (reset to 0 only in slow-link, not slow-link-sound: page closed, fine). Generated link clips are cached in `test/vscode/out`.
Runtime (est.): remote_stream ~1 min; remote_stream_long ~3.5 min (1.5 quick); fallback ~2-3 min.
Source: src/remotestream.js (ladder, stats, memory seeks, failover), src/remoteff.js, src/ffmpeg.js, src/decide.js, src/extension.js (hooks remoteStreamKill/Rate), media/player.js + media/engine.js (WebCodecs of the stream, gen/timeline), media/inspect.js (pixel inspector notice), media/decoder-worker.js (soft fallback). `seekChecks/longChecks/makeLongClip/LONG_TARGETS` are exported for test/vscode/remote_ssh.js.

#### 2.5 scopes_export.js

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/scopes_export/scopes/waveform-bars` | Waveform/parade levels of 75 % BT.709 bars; W cycles modes | W opens waveform, visible; grid 256x144, matrix 709; each bar one luma level within ±5 of nominal (16+219·Y'); W→parade: each R/G/B level 16 or 180 (235 for white) ±6; W cycle = `vector,histogram,off(hidden),waveform` | none (10 s waits) | WebCodecs H.264 (bars75_709.mp4 1280x720), WebGL readback | 1 for the analysis maths (media/scopes.js on a synthetic frame) + 3 (W cycle, real pixels) |
| `case/scopes_export/scopes/sd-709` | 640x360 tagged 709: matrix 709, waveform matches ffmpeg Y per bar, vectorscope targets | vmode webcodecs; matrix===709; per bar level ±5 vs ffmpeg raw Y at (row 180, col i*80+40); vector targets share >10 %, centre >20 %, sum >90 % | none | WebCodecs; ffmpeg ref (skips without) | 3 (matrix choice → 1) |
| `case/scopes_export/scopes/sd-untagged` | untagged SD → BT.601 | same with matrix 601 | none | same | 3 / 1 |
| `case/scopes_export/scopes/vectorscope-bars` | Vectorscope on 709 bars; histogram draws without errors | matrix 709; checkVector; no page error lines | none | WebCodecs | 1 + 3 |
| `case/scopes_export/scopes/updates-when-stepping` | Scopes update on a paused step and ~10/s while playing | perf.updates grows after step; **5 ≤ updates/s ≤ 14** over 2.5 s playing | **update rate 5-14/s** | s_h264.mp4 WebCodecs | 3 (step update) / 4 (rate) |
| `case/scopes_export/scopes/frame-player` | Scopes sample the MJPEG 2D-canvas frame player | waveform `waveN === w*h`, w>0 | none | s_mjpeg.avi (MJPEG frame player) | 3 |
| `case/scopes_export/export/range` | A-B (go-to 13..22) exports 10 PNGs named `<base>_f000013.png…`, 320x180, each the right frame | goto+expectFrame for A and B; `exportRange` → `exported 10/10 frames` ≤60 s; exact file list; PNG size 320x180; each PNG (ffmpeg→64x36 gray) NCC-argmax slot == A+i | none | WebCodecs s_h264.mp4; ffmpeg refs; env VPE_EXPORT_DIR | 3 (names → 1 src/rangecmd.js) |
| `case/scopes_export/export/vfr` | Gapped video export continues and names from shown frame | goto 1 / 40 (sleeps), exportRange → `exported N/40` ≤90 s; 25 ≤ files ≤ 40 | none | gapped_30fps.mkv (H.264 → WebCodecs) | 3 |
| `case/scopes_export/export/hidden` | Export pauses while player hidden behind another tab and resumes | A=1, B=280 on long_20s; after export starts, open s_hevc.mp4 in front; no `exported` line and file count stable over 1.5 s and <280; `closeActiveEditor` → `exported 280/280` ≤90 s; 280 files | 3.5 s/1.5 s observation windows | WebCodecs long_20s + WASM s_hevc; VPE_EXPORT_DIR | 3 |
| `case/scopes_export/export/no-range` | Without A-B nothing is written | after 2.5 s no `exported` line and empty dir | 2.5 s window | VPE_EXPORT_DIR | 3 |
| `case/scopes_export/saveFrame/png` | S saves a PNG of shown frame named `s_h264_frame00011.png`, 320x180 | seek+expectFrame(10); file >500 B ≤10 s; PNG 320x180 | none | WebCodecs; VPE_SAVE_DIR; ffmpeg refs | 3 |

Case table: `scopes_export` {settings autoplay=false, advancedMode=true; env `VPE_EXPORT_DIR`, `VPE_SAVE_DIR` (temp dirs made at module load); ffmpeg false}.
Hazards: env dirs must be set at VS Code start (own instance or hook change). `export/hidden` leaves long_20s.mp4 at ~9 s → `positions` resume for later cases opening long_20s (ui_jumps etc.). `export/hidden` closes only the front editor then all at the end. A-B marks are per page.
Runtime (est.): ~2-3 min (export/hidden 280 frames).
Source: media/scopes.js, media/inspect.js (go-to), media/player.js (A-B keys, `s`, scopes dump), src/extension.js (exportRange command, VPE_EXPORT_DIR/VPE_SAVE_DIR dialogs, hidden-panel export wait), src/rangecmd.js (PNG names), src/avi.js + extension.startMjpeg (frame player).

#### 2.6 seek_preview.js

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/seek_preview/wasm` | Seek-bar thumbnails lazy (nothing before hover), hover/neighbourhood ≤9 slots, stop after leave/drag, drag moves picture, release exact frame (WASM MPEG-2 built-in) | after 4 s idle: no `strip`, thumb hidden, no `thumbs:`/`thumb ffmpeg` log; hover → thumb shown ≤15 s, tip shown; slots ≥9 & hovering then slots ≤9; mouseleave hides; requests unchanged over 2.5 s; drag 6 positions: ≥4 distinct thumb sigs, ≥2 main frames and not the start frame; release off-bar: thumb hidden, no more requests in 2.5 s; expectFrame(end.value) (NCC); seek 5.5 → expectFrame(floor(5.5·fps)); step → +1 | `firstPictureMs` recorded only; 4 s idle window, 2.5 s quiet windows | ffmpeg (refs + makes sp_mpeg2_20s.mpg from long_20s), WASM, thumbs-worker | 3 (lazy/stop behaviour) ; release/seek/step exactness for WASM → 2 |
| `case/seek_preview_native/native` | same through native ffmpeg (src/thumbhost.js keyframe ffmpeg per thumb), HEVC | same (no-ffmpeg-thumb before hover) | same | native ffmpeg, libx265 to make sp_hevc_20s.mp4 | 3 |
| (`…/skipped`) | no ffmpeg | — | — | — | — |

Case table: `seek_preview` {settings autoplay=false; env none; ffmpeg false (but needs h.ffmpeg, skips otherwise)}; `seek_preview_native` {autoplay=false; ffmpeg true}.
Hazards: idle check "no thumbs log since P.fromMark" is per open, fine. Ends at ~5.5 s of a 20 s clip and closes → `positions` resume at 5.53 s for that file (only these cases use it; rerun in same instance would open at 5.5 s — expectFrame after drag unaffected, but idle check unaffected). Clips written into test/media/cases.
Runtime (est.): ~40-60 s each.
Source: media/thumbs.js, media/thumbs-worker.js, src/thumbhost.js, src/native.js, src/bar.js / media/player.js (seek bar drag, tip), media/engine.js.

#### 2.7 seeking.js (detailed)

Settings autoplay=false, loop=false, advancedMode=true; no ffmpeg in the instance (built-in decoders only); `h.ffmpeg` required for reference frames (else one `case/seeking/all` skipped row). All clips 320x180, `testsrc2`, 30 fps unless noted, keyframes every 30 frames (`-g 30`), H.264 with `-bf 2`.

**Decode path per clip** (src/decide.js `webcodecsPlays`: only 8-bit 4:2:0 H.264 and VP8 go to WebCodecs; src/extension.js `playsMjpeg`: MJPEG AVI with PCM goes to the frame player):

| Clip | Codec / container | Path | Movable to Node engine (layer 2)? |
|---|---|---|---|
| s_h264.mp4 | H.264 8-bit 4:2:0 + AAC, 90 frames | **WebCodecs** | no (WebCodecs) |
| s_hevc.mp4 | HEVC (x265 keyint 30) + AAC | **WASM libav.js** | yes |
| s_vp9.webm | VP9 (g 30) + Opus | **WASM libav.js** | yes |
| s_mpeg2.mpg | MPEG-2 (g 15) + MP2, MPEG-PS | **WASM libav.js** | yes |
| s_prores.mov | ProRes proxy (all-intra) + PCM | **WASM libav.js** | yes |
| s_xvid.avi | MPEG-4 Part 2 (XVID, g 30) + MP3, AVI | **WASM libav.js** | yes |
| s_mjpeg.avi | MJPEG + PCM, AVI | **MJPEG frame player** (src/avi.js chunk index, browser JPEG decode, 2D canvas; no engine) | index/frame-time logic → layer 1 (src/avi.js); picture → 3 |
| s_h264_opengop.mkv | H.264 open-GOP (4 s, 120 frames) | **WebCodecs**, then **WASM** after backward seek to a no-IDR point | soft half yes; switch no |
| vp9_60fps.mkv | VP9 60 fps (2 s, g 60) | **WASM** | yes |
| h264_60fps.mkv | H.264 60 fps (g 60) | **WebCodecs** | no |
| ntsc_2997.mkv | H.264 30000/1001 (3 s) | **WebCodecs** | no (fps-exactness maths → layer 1) |
| audio_longer.mp4 | H.264 2 s (60 frames) + 5 s AAC | **WebCodecs** | no |
| audio_longer_soft.mkv | MPEG-4 Pt2 2 s + 5 s Opus | **WASM** | yes |
| vp8_2s.webm | VP8 2 s, no sound | **WebCodecs** | no |

**What is compared**: every frame check is `P.expectFrame(k)` = (a) the player's own frame number for the shown picture (`thumb` probe `frame`, 0-based slot) equals k AND (b) the shown canvas downscaled to 64x36 luma, NCC-argmax over ffmpeg reference pictures k±15, maps to slot k. So both the counter and the actual picture must be frame k (ffmpeg luma thumbnail NCC, argmax only, no score floor). Additional assertions are state fields (`vmode`, `playing`, `t`, `frameText`, `toast`, `abMarks`, `n`, `fps`).

| Result | Path | Proves | Assertions | Thresholds | Layer |
|---|---|---|---|---|---|
| `case/seeking/step/s_h264.mp4` | WebCodecs | step ±1 / `.` `,` keys go picture to picture, also across a GOP boundary | first frame; expectFrame(0); ffmpeg slots >70; step +1 ×6 → slot[1..6]; step −1 ×4 → slot[5..2]; seek to (slot[i]+0.5)/fps with i = last slot ≤28 → slot[i]; step +1 ×5 → slot[i+1..i+5]; step −1 → slot[i+4]; key `.` → slot[i+5]; key `,` → slot[i+4] (all expectFrame: counter + NCC) | 12 s per expectFrame | 3 |
| `case/seeking/step/s_hevc.mp4` | WASM | same | same | same | **2** (step/seek logic of engine with libav.js) + keys `.`/`,` → 3 (one clip) |
| `case/seeking/step/s_vp9.webm` | WASM | same | same | same | **2** |
| `case/seeking/step/s_mpeg2.mpg` | WASM | same (GOP 15) | same | same | **2** |
| `case/seeking/step/s_prores.mov` | WASM (intra) | same | same | same | **2** |
| `case/seeking/step/s_xvid.avi` | WASM | same | same | same | **2** |
| `case/seeking/step/s_mjpeg.avi` | MJPEG frame player | same | same | same | 3 (+1 avi index) |
| `case/seeking/seek/s_h264.mp4` | WebCodecs | paused seeks land exactly fwd/back; seek while playing keeps playing | seeks to frames 45,70,10,85,59,60,0 (t=(k+0.5)/fps) each expectFrame ≤15 s; play → playing; seek(1.0) → playing && t≥1.0 ≤10 s; `t < 1.9` | **seek-while-playing must reach t≥1.0 and be <1.9 s** (depends on poll latency ~0.3-0.5 s at 1×) | 3 |
| `case/seeking/seek/s_hevc.mp4` | WASM | same | same | same | **2** for the 7 paused seeks; play-seek part → 3 |
| `case/seeking/seek/s_vp9.webm` | WASM | same | same | same | **2** + 3 |
| `case/seeking/seek/s_mpeg2.mpg` | WASM | same | same | same | **2** + 3 |
| `case/seeking/seek/s_prores.mov` | WASM | same | same | same | **2** + 3 |
| `case/seeking/seek/s_xvid.avi` | WASM | same | same | same | **2** + 3 |
| `case/seeking/seek/s_mjpeg.avi` | MJPEG frame player | same | same | same | 3 |
| `case/seeking/open-gop/h264` | WebCodecs → WASM | backward seek into open-GOP region restarts decoder (no IDR → software) and shows exact frame 45 | first vmode webcodecs; ffmpeg slots include 45; play until frame ≥60 in webcodecs; pause; seek 45.5/fps → log `open-GOP H.264: no IDR` ≤10 s; expectFrame(45) (NCC); vmode `soft` after | 10 s log wait | 3 (path switch); the soft decode of open-GOP from the preceding non-IDR keyframe → 2 |
| `case/seeking/step-ms-rounded/vp9_60fps.mkv` | WASM | ms-rounded MKV timestamps: every step moves exactly 1 frame; counter matches | expectFrame(0); step +1 ×12 → 1..12; −1 ×6 → 11..6; seek (58.5)/fps → 58; +1 ×4 → 59..62; −1 ×4 → 61..58; `frameText` starts `#59/` | 12 s per check | **2** (+ frameText → 3/1) |
| `case/seeking/step-ms-rounded/h264_60fps.mkv` | WebCodecs | same | same | same | 3 (timestamp→frame rounding → 1) |
| `case/seeking/step-ms-rounded/ntsc_2997.mkv` | WebCodecs | same + fps exactly 30000/1001 | `|fps − 30000/1001| < 1e-9`; then g=30: seek 28, steps to 32 and back to 28; frameText `#29/` | same | 3 (fps detection → 1 sniff-matroska / engine) |
| `case/seeking/end-key/audio_longer.mp4` | WebCodecs | End shows the last picture (59 of 60) though sound is 5 s; stays paused | key End → expectFrame(59); not playing | 12 s | 3 |
| `case/seeking/end-key/audio_longer_soft.mkv` | WASM | same in software | same | same | **2** (last-frame seek) + key → 3 |
| `case/seeking/edges/s_h264.mp4` | WebCodecs | seek past end → last frame; step at ends stays; Home → 0 | n−1 ≥85; seek duration+5 → last; step +1 + 1 s → still last; seek last−1; step +1 → last; Home → 0; step −1 + 1 s → 0 | 1 s sleeps | 3 (could duplicate as 2 on a WASM clip) |
| `case/seeking/eof-flush/vp8_2s.webm` | WebCodecs (VP8) | frames left in the WebCodecs decoder at EOF are flushed and shown; play to end stops (loop off) | vmode webcodecs; play → !playing && t>1 ≤15 s; expectFrame(59) | 15 s | 3 |
| `case/seeking/abloop/s_h264.mp4` | WebCodecs | A/B keys mark, toast, loop plays only A..B, clearing both ends it | seek 30 → A (key a), seek 60 → B (key b); toast `Loop 0:01.xxx – 0:02.xxx`; abMarks visible; seek 1.5, play; sample 4.5 s: ≥2 wraps (drop >0.3 s), max t < 2.15, min t > 0.9; keys a,b → toast `A-B loop off` | **≥2 wraps in 4.5 s wall** (needs ~1× playback); bounds 2.0+0.15 / 1.0−0.1 | 3 (wrap-count is wall-time dependent; loop bound logic → 1/2) |

Totals: 23 results (7 step + 7 seek + open-gop + 3 step-ms-rounded + 2 end-key + edges + eof-flush + abloop). WASM-path results: step ×5, seek ×5 (paused part), step-ms-rounded/vp9_60fps, end-key/audio_longer_soft = **12** movable to layer 2 (plus the soft half of open-gop). Caveat: the step/seek logic under test lives in media/engine.js + media/decoder-worker.js + media/pool.js (webview code using Workers); a Node layer-2 harness must run that engine with libav.js (media/libav-vpe) in Node and expose the same "shown frame" output, otherwise it would test libav.js instead of the product. Reference = ffmpeg 64x36 luma NCC is reusable there unchanged (or compare full-resolution planes / frame pts exactly in Node).

Case table: `seeking` {settings autoplay=false, loop=false, advancedMode=true; env none; ffmpeg false; needs runner ffmpeg for references and clip making}.
Hazards: all clips ≤4 s → no resume; each result closes all editors; no global writes except builtinSpeed samples. Safe to share an instance (settings must match).
Runtime (est.): ~3-5 min (≈ 23 opens, ~200 expectFrame polls).
Source: media/engine.js, media/decoder-worker.js, media/pool.js, media/libav-vpe, media/player.js (step/keys/End/Home/A-B/toast), media/inspect.js (frame text), src/extension.js (startMjpeg, playsMjpeg), src/avi.js, src/sniff-matroska.js (60 fps / NTSC timing), src/decide.js.

#### 2.8 short_loop.js

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/short_loop/soft` | av1_8_1080p.mp4 (2 s, 48 frames, WASM) loops by replaying the cache at 24 fps | playClip (expect soft, 8 s window); ≥4 shownFps windows and `|shownFps − 24| ≤ 1`; log `loop: replaying 48 cached frames` | **shownFps 24±1** over 8 s | WASM, WebGL | 3 (cache reuse log) / 4 (fps) |
| `case/short_loop/webcodecs` | h264_8_1080p.mp4 (WebCodecs) same | same, expect webcodecs | same | WebCodecs | 3/4 |

Case table: `short_loop` {settings autoplay=true, loop=true; env none; ffmpeg false}. Hazards: none (2 s clips, closes). Runtime ~30 s.
Source: media/engine.js (loop cache replay), media/player.js, media/membudget.js.

#### 2.9 startup.js

Result name = the clip path string (includes `cases/` for generated ones).

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/startup-gpu/h264_aac_anim_1080p.mp4` | Cold + 2 warm open timelines, WebCodecs | first frame ≤60 s each (3 opens); phases recorded (total, activate, webviewCreate, pageLoad, hostDecide, libav fetch/init, openStreams, configure, firstFrame, workerInit, trace) | none judged; numbers only | WebCodecs | 4 |
| `case/startup-wasm/hevc_8_1080p.mp4` | same WASM | same | none | WASM | 4 |
| `case/startup-native/hevc_10_2160p.mp4` | same native; asserts host.path native and webview nativeDraw | + native phases (probeToSpawn, spawnToDecoded, connect, sendToReceived…) | none | native ffmpeg | 4 (native-first-frame assert → 3) |
| `case/startup-av1-mp4/av1_10_2160p.mp4` | native AV1 | same (expectNative) | none | native | 4 |
| `case/startup-h264-mp4/h264_10_1080p.mp4` | native 10-bit H.264 | same | none | native | 4 |
| `case/startup-prores-mov/prores_proxy_1080p.mov` | native ProRes | same | none | native | 4 |
| `case/startup-vp9-webm/vp9_2160p.webm` | native VP9 WebM | same | none | native | 4 |
| `case/startup-vp9-mp4/cases/startup_vp9_cfr.mp4` | native VP9 MP4 (generated) | generated ok + same | none | native, ffmpeg | 4 |
| `case/startup-h264-mov/cases/startup_h264_422.mov` | native H.264 4:2:2 MOV | same | none | native | 4 |
| `case/startup-hevc-mkv/cases/startup_hevc.mkv` | native HEVC MKV | same | none | native | 4 |
| `case/startup-av1-mkv/cases/startup_av1.mkv` | native AV1 MKV | same | none | native | 4 |
| `case/startup-restore/background-probe` | After window reload, the restored background tab doesn't decode/probe until shown | reload → foreground first frame ≤60 s; `debug tabs` shows background tab restored, not active; no `early ffprobe started` / `startup host` for background before reveal; on reveal `early ffprobe started` and first frame | none | native ffmpeg | 3 |
| `case/memory/hevc_10_2160p.mp4` | Private memory of ext host / webview renderer / total, before, playing (5 s), paused (10 s) | first frames ≤60 s; numbers only | none judged | WASM (no ffmpeg on PATH), PowerShell CIM | 4 |
| `case/memory-8gb/hevc_10_2160p.mp4` | same with budgets of an 8 GB machine | same | none | env VPE_TOTALMEM=8 GiB | 4 (budget formula → 1 media/membudget.js) |
| (`case/memory-again/…`, `case/memory-8gb-again/…`) | with VPE_MEMORY_REPEAT | same | — | — | 4 |

Case table: startupCase entries {settings none; env none; ffmpeg false for gpu/wasm, true for the 9 native ones}; `startup-restore` {ffmpeg true}; `memory` {ffmpeg false}; `memory-8gb` {env `VPE_TOTALMEM=8589934592`}.
Hazards: by design need a cold instance (cold = extension activation + first compile; warm runs are in the same instance) — sharing destroys the "cold" measurement. `startup-restore` issues `workbench.action.reloadWindow` (restarts the extension host, rewrites the `.cmd` file from line one) → any case after it in the same instance loses hook state; must be alone/last. Memory samples whole process tree → needs a quiet, own instance.
Runtime (est.): each startupCase ~25-45 s + instance; restore ~40 s; memory ~35 s each. Total ~8-10 min for 14 instances.
Source: src/extension.js (T_LOAD timeline, `startup host`, early ffprobe, webview restore/serializer, `debug tabs` hook, activation log with pid), src/decide.js, src/ffmpeg.js, src/probe.js, src/native.js, src/frameserver.js, media/framestream.js, media/player.js (`webview: startup` timeline), media/engine.js + libav init, media/pool.js, media/membudget.js (VPE_TOTALMEM).

#### 2.10 subtitles.js

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/subtitles/bitmap/pgs` | PGS picture subs chosen in Subtitles panel, drawn at right time/place/colour, cleared at end, follow zoom, cleared while playing | panel radio `hdmv_pgs_subtitle` found & enabled; track selected ≤8 s; per event (M.EVENTS red/green/blue): seek start+0.5 → exactly 1 bitmap, box within 1.5 px of expected, colour mid >180/<70, alpha 255, size w x h; seek end+0.3 → none; at 10 s none; 13 s blue; ctrl+wheel zoom ×4 → video wider ×1.3 and box still matches; `z` back to fit; seek 15.2, play → past 16.25 s no bitmap | 10 s settles | test/bitmapsubs/make_media.js (ffmpeg), engine WASM sub decode | 2 (bitmap decode + timing) + 3 (placement/zoom) |
| `case/subtitles/bitmap/dvd` | same `dvd_subtitle` | same | same | same | 2 + 3 |
| `case/subtitles/bitmap/dvb` | same `dvb_subtitle` | same | same | same | 2 + 3 |
| (`case/subtitles/bitmap`) | skip row when media can't be made | — | — | — | — |
| `case/subtitles/tracks/menu-and-cues` | Track list (3 audio, 2 subs, defaults), audio/subs panels, CC toggle, SRT cue, audio switch to 5.1 while playing, ASS cues after seeks, no errors | firstShown; tracks audio=3 sub=2 audioId 1 subId 4; Audio panel items include `*English stereo` and `Deutsch 5.1`; Subtitles panel has `Signs` and a selected item; CC click → subId null, no panel, bar `Subtitles off`; CC → subId 4, `Subtitles on`; seek 4.6 → `EN cue 4`; play, switch to Deutsch 5.1 → audioId 2, chunks>0 ≤12 s, 6 channels; after 1.5 s shownCount +>20 and t +>1; Signs track; seeks 4.6/13.5/7.2 → DE cues; t≈7.2 ±0.15; no error log lines (except `Error submitting`) | **>20 frames and >1 s media in ~1.5 s+** after switch (real-time playback) | tracks_multi.mkv (ffmpeg-made), WASM/WebCodecs, audio | 3 (parsers/cue index → 1 media/subtitles.js) |

Case table: `subtitles` {settings autoplay=false, advancedMode=true; env none; ffmpeg false}.
Hazards: tracks_multi / bitmap clips seek to 7-16 s → `positions` stored if clip >10 s (resume on later reopen in same instance). Otherwise closes editors.
Runtime (est.): ~1.5-2 min.
Source: media/subtitles.js, media/tracks-menu.js, media/controls.js (panels), media/inspect.js (zoom, `z`), media/engine.js (subtitle packets, audio track switch, downmix), media/player.js, src/sidecars.js (not exercised: embedded only).

#### 2.11 ui.js

`ui` shares ONE player (h264_aac_anim_1080p.mp4, WebCodecs, default settings → autoplay on, paused immediately) across 11 results, then `compare`.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/ui/a11y/names` | Every bar control has an accessible name/role/state; seek valuetext; polite live region; status pill gone | no unnamed buttons; aria-labels for play, prev, next, full, infoBtn, cog, keysBtn, seek, volume, canvas; mute/rate/tracks/time label patterns; mute aria-pressed; tracks/infoBtn/rate/cog/keysBtn aria-expanded false; modeBtn/toolsBtn/loop absent; seek valuetext `m:ss.mmm of …, frame N`; live role=status polite; no `pill` in state | none | WebCodecs | 3 (DOM-only; could be 1 with jsdom over src/bar.js html) |
| `case/ui/a11y/states-and-live` | R toggles loop + live text; M toggles mute with aria; play/pause label | as described | settle sleeps 400-600 ms | — | 3 |
| `case/ui/keys/focused-controls` | Focus-visible outline on #mute; Space on focused button doesn't play; Space on page plays | active=mute & focusVisible; outline not none/0px; Space on #mute → not playing; Space → playing | sleeps | — | 3 |
| `case/ui/picture/click` | Click on picture plays/pauses; with panel open only closes panel | click → playing ≤4 s; click → paused; cog → panel main; click → no panel, not playing | — | — | 3 |
| `case/ui/panels/toggle` | cog/info/rate toggle panels and aria-expanded; switching; main page rows; Scopes from grid | each button opens view main/info/speed and expanded true, again closes; info→rate switches; cog closes; 16 row labels present; jump summary `5 s · 1 s · 1 frame`; Scopes tool → scopes mode not off and panel closed; W×4 | — | — | 3 |
| `case/ui/panels/keyboard` | Focus moves into panel; ArrowDown moves focus; loop is a switch; Escape closes and refocuses cog; `?` sheet modal with groups; keysBtn opens sheet | as described | — | — | 3 |
| `case/ui/cc/no-subtitles` | CC label without subs; CC opens subs panel with `Load subtitle file…`; C closes | — | — | — | 3 |
| `case/ui/speed/step-and-clamp` | `>`/`<` ±0.05, clamp 0.25..4, wheel +0.05, speed panel slider range and presets, preset 2×, − button | report rate values exact (1e-6) | — | — | 3 (rate step/clamp maths → 1) |
| `case/ui/drag/outside` | Volume drag outside clamps 0..1, release at 60 %, no change after release, wheel ±5 %; seek drag above bar lands on 75 % frame | values as listed; frame within ±1 of round(0.75·seekMax) ≤8 s | — | — | 3 |
| `case/ui/time/formats` | Time label `m:ss.mmm / …` paused and playing; click cycles to timecode `hh:mm:ss:ff` and `frame N / M` | regexes | — | — | 3 |
| `case/ui/info/wasm-and-copy` | "About this video" facts for the H.264 (GPU) file: Picture, Video H.264, Sound AAC, Played by GPU; Copy details; Full technical details overlay | regexes; infoShown | — | WebCodecs (name says wasm, file is GPU) | 3 |
| `case/ui/compare` | Compare view (2 files) a11y: names, seek valuetext, mute pressed, cmpBtn, play-all label, R loop + live, Compare panel focus, Esc returns focus | via `compareFiles` hook + `compare a11y` log; polls up to 40 s for valuetext | — | WebCodecs + WASM (hevc_8_1080p) | 3 |
| `case/ui_jumps/defaults` | ←/→ 5 s, Shift+→ 1 s, Ctrl+← 1 frame on long_20s | jumpChecks: from t=4 / 16: Δt within `1.5/fps + 0.02` s of size, or Δframe = ±1 | tolerance in media time (deterministic-ish) | WebCodecs long_20s.mp4 | 3 (jump maths → 1) |
| `case/ui_jumps/panel-saves-setting` | Jump sizes panel: 17 radio rows; choosing 10 s writes `videoPreviewEnhanced.jump.arrow: 10` to user settings.json; stepButtons default frame → `jump` saved; then → jumps 10 s | as described, polls settings.json ≤6 s | — | — | 3 |
| `case/ui_jumps_settings/from-settings` | Settings jump.arrow=frame, shift=5, ctrl=1 reach the page and act | prefs match; jumpChecks | — | — | 3 (prefsOf → 1) |
| `case/ui_info/wasm` | Info facts for HEVC 8-bit 1080p in WASM: Picture, Quality SDR 8-bit, Video HEVC + bitrate, Played by built-in (WebAssembly), Tracks, name+size+duration | regexes | — | WASM, no ffmpeg | 3 (fact formatting → 1 media/controls.js) |
| `case/ui_info_native/native` | Info facts for hevc_10_1080p via native ffmpeg: 10-bit, Played by ffmpeg | regexes | — | native ffmpeg | 3 |
| (`case/ui_info_native/skipped`) | — | — | — | — | — |

Case table: `ui` {settings none (autoplay default); env none; ffmpeg false}; `ui_jumps` {autoplay=false}; `ui_jumps_settings` {autoplay=false, jump.arrow='frame', jump.shift=5, jump.ctrl=1}; `ui_info` {autoplay=false}; `ui_info_native` {autoplay=false; ffmpeg true}.
Hazards: `ui` results are order-dependent within the case (one shared page; a failure mid-way can leave a panel/rate/volume state for the next result; the page is opened outside `R.run` so an open failure throws the whole case). `ui_jumps/panel-saves-setting` **writes user settings** (`jump.arrow: 10`, `stepButtons: "jump"`) → breaks `ui_jumps/defaults` on rerun and any later case relying on default arrow jumps / step buttons in the same profile. `ui_jumps*` leave long_20s.mp4 at ~11-16 s → `positions` resume (ui_jumps_settings in the same instance would open at ~11 s: jumpChecks seek first, so mostly ok). `compare` closes via closeAllEditors.
Runtime (est.): ui ~1.5-2 min; ui_jumps ~40 s; ui_jumps_settings ~25 s; ui_info ~15 s; ui_info_native ~15 s.
Source: src/bar.js, media/controls.js, media/player.js (a11y/state probes, keys, drag, time modes), media/modes.js (key ownership), media/scopes.js, media/inspect.js (details overlay), src/compare.js + media/compare.js, src/extension.js (prefsOf, setSetting → user settings, PREFS), src/decide.js (Played by).

#### 2.12 url_stream.js

Server: `test/urlserver.js` on 127.0.0.1, streams made by the runner's ffmpeg into `%TEMP%/vpe_url_streams` from one 10 s 30 fps clip (`src.mp4`) + copy of `hevc_8_1080p.mp4`. URL tabs are opened with the `openUrl` hook (skips the input box). Picture checks compare to `src.mp4` with expectFrame (counter + NCC). URL tabs have no resume.

`playsAndSeeks` assertions: firstShown; decoder log matches; expectFrame(0) ≤15 s; seek → expectFrame(150) ≤20 s; seek → expectFrame(40) ≤20 s; play → t>2.0 ≤15 s; no error lines.

| Result | Proves | Assertions | Thresholds | Needs | Layer |
|---|---|---|---|---|---|
| `case/url_stream/mp4_direct` | Direct MP4 over HTTP range requests, built-in (WebCodecs H.264), exact seeks | playsAndSeeks, decoder `/libav|built-in/` | none | url server, WebCodecs, ffmpeg refs | 3 (range reader → 1/2) |
| `case/url_stream/panels` | URL tab UI: ⚙ has Open video URL…, no Compare, has Scopes/Export A-B; ⓘ shows `host · stream`, no MB | labels/text | — | url server | 3 |
| `case/url_stream/hls_ts` | HLS VOD MPEG-TS segments read as one file by built-in decoder | playsAndSeeks, decoder /libav/ | — | url server | 2 (HLS concat + demux in Node) + 3 |
| `case/url_stream/hls_master` | Master playlist → 640x360 variant | playsAndSeeks + log `HLS for the built-in decoder: … variant 640x360` | — | url server | 1 (playlist parse, src/urlsource.js) + 3 |
| `case/url_stream/hls_fmp4` | HLS fMP4 segments | playsAndSeeks | — | url server | 2 + 3 |
| `case/url_stream/hls_aes` | AES-128 HLS decrypted in host | playsAndSeeks + log `5 MPEG-TS segments (AES-128, decrypted here)` | — | url server | 1 (decrypt) + 3 |
| `case/url_stream/hls_quality` | Quality page: Auto(360p), variants, switching to 180p reloads at same frame paused, Auto again keeps playing | auto 360p; log master with 3 renditions, 1 I-frame playlist; ⚙ row `Auto (360p)`; Quality items `*Auto,360p,180p`; at frame 120 click 180p → log reload; 180p page, pick==current; frame 120±1 not playing; canvas 320x180; log built-in reads 180p variant; play t>4.3; Auto → reload, playing t>4.3, canvas w 640; no errors | 40 s reload waits | url server | 3 |
| `case/url_stream/hls_subs` | WebVTT renditions: default English cue at 3.5, none at 3.95, menu `*Off, English, Deutsch, Load subtitle file…`, labels `German · stream`, Deutsch cue at 7.5 | as described | — | url server | 3 (WebVTT parse → 1) |
| `case/url_stream/hls_drm` | FairPlay playlist refused clearly, no ffmpeg offer | message `protected (FairPlay)`; hint mentions content decryption module; no action | — | url server | 1 (detection) + 3 (message) |
| `case/url_stream/url_to_side` | Open Video URL to the Side opens a tab in the side group and plays | log `[src.mp4] URL tab opened (side)` ≤15 s; firstShown ≤40 s | — | url server | 3 |
| `case/url_stream/dash_needs_ffmpeg` | DASH without ffmpeg: message + Set up ffmpeg action | message `needs native ffmpeg`; action `Set up ffmpeg` | — | url server, no ffmpeg | 3 (rule → 1) |
| `case/url_stream/hls_live_needs_ffmpeg` | live HLS without ffmpeg: same | same | — | same | 3 / 1 |
| `case/url_stream/not_found` | 404 → `not found (HTTP 404)` | regex | — | url server | 1/3 |
| `case/url_stream/web_page` | HTML page → `web page` message | regex | — | url server | 1/3 |
| `case/url_stream_native/hls_native` | Master HLS via native ffmpeg | playsAndSeeks decoder `native ffmpeg` | — | native ffmpeg, url server | 3 |
| `case/url_stream_native/hls_aes_native` | AES HLS via native | same | — | same | 3 |
| `case/url_stream_native/hls_quality_native` | Quality page with native (log `decoder: native ffmpeg` after switch) | quality(native) | — | same | 3 |
| `case/url_stream_native/hls_subs_native` | WebVTT with native | hlsSubs | — | same | 3 |
| `case/url_stream_native/dash_native` | DASH via native | playsAndSeeks | — | same | 3 |
| `case/url_stream_native/hevc_mp4_native` | HEVC MP4 URL → native, seek frame 30 exact (vs hevc_8_1080p.mp4 refs) | firstShown; log native; expectFrame(30) ≤20 s | — | same | 3 |
| `case/url_stream_native/hls_live_native` | Live HLS: starts at live edge, seek disabled, `LIVE` time, time click doesn't cycle, detected live | as described | — | same | 3 |
| `case/url_stream_native/mp4_h264_stays_builtin` | With ffmpeg, an H.264 MP4 URL still uses the built-in decoder | playsAndSeeks decoder /built-in/ | — | same | 3 (rule → 1) |
| `case/url_stream_native_mp4/mp4_native` | decoder='ffmpeg' forces native on a plain MP4 URL | playsAndSeeks decoder native | — | same + setting | 3 |
| (`…/all` skip rows) | no ffmpeg to make streams | — | — | — | — |

Case table: `url_stream` {settings autoplay=false, loop=false; env none; ffmpeg false (instance) but needs runner ffmpeg to make streams}; `url_stream_native` {same; ffmpeg true}; `url_stream_native_mp4` {+ decoder='ffmpeg'; ffmpeg true}.
Hazards: none persistent (URL tabs skip resume; server per case). Each result closes editors. `url_to_side` opens in a side group — closeAllEditors handles it. Shareable if settings/PATH match.
Runtime (est.): url_stream ~2.5-3 min; native ~2-3 min; native_mp4 ~30 s.
Source: src/urlsource.js (HLS/DASH/AES/master/live/DRM/404/web page, quality reload), src/native.js (URL to ffmpeg with whitelist), src/decide.js, src/extension.js (openUrl command, side), media/controls.js (Quality page, ⚙/ⓘ), media/subtitles.js + media/tracks-menu.js (WebVTT renditions), media/engine.js (concatenated segment reading), test/urlserver.js.

---

### 3. Per-case summary

| Case | Settings | Env | ffmpeg | Results | Est. runtime | Shared-instance hazards |
|---|---|---|---|---|---|---|
| (suite) play | assoc mp4/webm | PATH −ffmpeg | no | 15 (wcprobe+14) | 2-3 min | — |
| (suite) native | ffmpegPath | — | yes | 2 | 30 s | — |
| onboarding-ffmpeg | — | — | yes | 3 | 30 s | needs fresh onboarding globalState; checks whole log for popup |
| onboarding | — | — | no | 2 | 60-90 s | needs fresh onboarding/hint/builtinSpeed state; machine-speed-dependent hint |
| perf-invisible | — | — | yes | 5 | 2 min | positions for _x10 clips; process sampling of whole instance |
| perf-invisible-bench | — | VPE_THUMB_STRIP=0 (+VPE_PERF_*) | yes | 8 (opt-in) | 5 min | must be alone (CPU/mem of whole instance) |
| playback | advancedMode, autoplay off | — | no | 31 | 3-4 min | positions (long_20s) |
| playback_autoplay | advancedMode, autoplay on, loop off | — | no | 3 | 30 s | — |
| playback_loop | advancedMode, autoplay on, loop on | — | no | 1 | 15 s | — |
| remote_stream | remoteStream on, assoc +mkv | — | yes | 5 | 1 min | — |
| remote_stream_long | + loop off | — | yes | 2 | 3.5 min (1.5 quick) | positions for rs_sync_200s.mkv (also used by fallback) |
| remote_stream_fallback | remoteStream on, loop off, advanced, assoc | VPE_RS_ENCODER=libx264 | yes | 4 | 2-3 min | env needs own instance |
| scopes_export | autoplay off, advanced | VPE_EXPORT_DIR, VPE_SAVE_DIR | no | 11 | 2-3 min | env; positions long_20s |
| seek_preview | autoplay off | — | no (needs runner ffmpeg) | 1 | 1 min | positions of its own clip |
| seek_preview_native | autoplay off | — | yes | 1 | 1 min | same |
| seeking | autoplay off, loop off, advanced | — | no (needs runner ffmpeg) | 23 | 3-5 min | none |
| short_loop | autoplay on, loop on | — | no | 2 | 30 s | none |
| startup-gpu / -wasm | — | — | no | 1 each | 30-45 s | needs cold instance by design |
| startup-native, -av1-mp4, -h264-mp4, -prores-mov, -vp9-webm, -vp9-mp4, -h264-mov, -hevc-mkv, -av1-mkv | — | — | yes | 1 each (9) | 30-45 s each | cold instance |
| startup-restore | — | — | yes | 1 | 40 s | reloadWindow: restarts ext host; must be alone/last |
| memory | — | — | no | 1 | 35 s | quiet own instance |
| memory-8gb | — | VPE_TOTALMEM=8 GiB | no | 1 | 35 s | env |
| subtitles | autoplay off, advanced | — | no | 4 | 1.5-2 min | positions (long sub clips) |
| ui | — | — | no | 12 | 1.5-2 min | intra-case ordering |
| ui_jumps | autoplay off | — | no | 2 | 40 s | **writes user settings** jump.arrow=10, stepButtons=jump; positions long_20s |
| ui_jumps_settings | autoplay off, jump.* | — | no | 1 | 25 s | affected by ui_jumps' settings writes |
| ui_info | autoplay off | — | no | 1 | 15 s | — |
| ui_info_native | autoplay off | — | yes | 1 | 15 s | — |
| url_stream | autoplay off, loop off | — | no (runner ffmpeg for streams) | 14 | 3 min | none |
| url_stream_native | same | — | yes | 8 | 2-3 min | none |
| url_stream_native_mp4 | + decoder=ffmpeg | — | yes | 1 | 30 s | none |

Result counts (full default run, these files): suite 17 (wcprobe 1 + play 14 + native 2); onboarding 5; perf_invisible 5 (+8 bench opt-in); playback 35; remote_stream 11; scopes_export 11; seek_preview 2; seeking 23; short_loop 2; startup 14 (+2 opt-in); subtitles 4; ui 17; url_stream 23. **Cases total 152; with suite 169** (179 with both opt-ins).

## Appendix C: Node tests as found (2026-11-20, commit 1ef5cd1)

Runs: each file once, sequential, `node <file> [args]` from the repo root, 120 s timeout, ffmpeg/ffprobe on PATH
(gyan-style build with libx264/libx265/d3d11va), Windows 10, Node 24.22.1. Times are wall seconds of that one run.
"Checks" = rough count of assert/check/eq call sites in the source (loops multiply them at runtime; the run's own
count is given where it prints one).

Legend for Needs: **ff** = real ffmpeg/ffprobe on PATH (or VPE_FFMPEG); the native-path host tests print
"skipped (no ffmpeg)" and exit 0 without it, so they pass silently on a machine without ffmpeg.
**wasm** = decodes with libav.js (media/libav-vpe) under worker_threads.

### test/host/*_test.js (driven by test/host/run_all.js)

run_all.js: runs every `test/host/*_test.js` except `avi_scan_test.js` (needs files), then `test/engine/unit.js`;
60 s per test; on Windows each test runs inside `python -I test/host/windows_job.py` (a Job Object so the whole
process tree dies on timeout) -> **needs Python on Windows**. Exit code non-zero if any test fails.
Helpers (not tests): `mock_vscode.js` (fake `vscode` module installed into require cache), `windows_job.py`.

All host tests signal failure by exit code (assert throws -> non-zero, or `process.exit(1)`/`process.exitCode`).
None decodes with WASM (no libav-vpe / worker_threads; "libav" hits are the 'libav' webview message name).

| file | proves | checks | needs | layer | run: exit / s / result | exercises |
|---|---|---|---|---|---|---|
| a11y_test | keyboard ownership (ownsKey) and accessible names/states/live region in player + compare HTML | 38 | - | 1 | 0 / 0.1 / pass | media/modes.js, src/extension.js html(), src/compare.js, src/bar.js |
| auto_default_test | MP4/WebM become default editor once, never overwrite user choice; failing write falls back to globalState | 20 | mock vscode | 1 | 0 / 0.5 / pass | src/extension.js (activation, editorAssociations) |
| avi_scan_test | parseAvi read counts / bytes / digest; fails if scan reads too much | 0 asserts, per-file ok/FAIL | **args: AVI files** (passes vacuously with none; run_all skips it) | 1 (tool-ish; also timing) | no args: 0 / 0.1 / vacuous; with s_mjpeg.avi + containers/h264_aac.avi: 0 / 0.1 / pass | src/avi.js |
| avi_synth_test | src/avi.js on hand-built AVIs: MJPEG+PCM, OpenDML, rec lists, truncation, hostile sizes, DHT fix, WAV readers | 60 | tmpdir | 1 | 0 / 0.1 / pass | src/avi.js |
| benchq_test | test/benchq.js passes quoted/metachar args unchanged, pinned and unpinned | 10 | tmpdir; Windows cmd semantics | 1 | 0 / 2.5 / pass | test/benchq.js (test tooling, not product) |
| build_choice_test | setup chooseBuild picks LGPL newest-branch build, proxy agent passed; prune() keeps ffmpeg/ffprobe/DLLs | 21 | https stubbed | 1 | 0 / 0.1 / pass | src/setup.js |
| compare_test | compare view: WSL host memory for native queue, rotation read, page-id stamping, stale reads, overflow warning | 20 | **ff** (make_cases_media makes rotated.mp4, s_h264.mp4 in test/media/cases) | 1 (ffmpeg only to make media) | 0 / 2.7 / pass | src/compare.js, src/rotation.js, media/membudget.js |
| controls_test | speed clamp/step, jump names, shortcuts sheet, "About this video" facts | 44 | - | 1 | 0 / 0.1 / pass | media/controls.js, src/native.js |
| ctxmenu_test | package.json context-menu contributions consistent; command routing | 29 | tmpdir | 1 | 0 / 0.2 / pass | src/ctxmenu.js, package.json, media/player.js |
| debug_hook_test | VPE_LOG command hook runs only allowlisted commands; messages typed 'debug' | 2 | mock vscode | 1 | 0 / 0.2 / pass | src/extension.js |
| decide_test | native vs built-in decision per file, remote/restricted, method from probe results, speed records | 104 | - | 1 | 0 / 0.1 / pass | src/decide.js, src/hwaccel.js |
| ffmpeg_fake_test | src/ffmpeg.js run/locateTools/probe vs scripted fake spawn: hangs, versions, hostile JSON | 66 | - | 1 | 0 / 0.2 / pass | src/ffmpeg.js |
| file_icons_test | vpe-video icon language; files.associations added/removed only where ours | 22 | mock vscode | 1 | 0 / 0.6 / pass | src/extension.js, package.json |
| frame_link_test | frame links name remote host, open only in matching window | 18 | mock vscode | 1 | 0 / 1.0 / pass | src/extension.js (URI handler) |
| frameserver_test | localhost frame server over HTTP stream + WebSocket, 403 on bad token/origin, onLost, postMessage fallback | 39 | local http 127.0.0.1 | 1 | 0 / 1.9 / pass | src/frameserver.js, src/native.js |
| gpu_offer_test | GPU-test offer notification once per session, buttons, records | 24 | **ff** (skips w/o) | 1 (+ff) | 0 / 5.7 / pass | src/extension.js maybeOfferProbe, src/decide.js, src/ffmpeg.js |
| hardware_test | GPU detection parsing (CIM JSON, lspci, system_profiler), NVIDIA versions, encoder candidates | 50 | - | 1 | 0 / 0.1 / pass | src/hardware.js |
| hdr_math_test | PQ/HLG/BT.2020->709/P3 maths vs standard reference values, output decision | 21 | - | 1 | 0 / 0.1 / pass | media/hdr.js |
| last_view_test | last non-zoomed picture size stored and used for early native start | 9 | **ff** (skips w/o) | 1 (+ff) | 0 / 0.4 / pass | src/extension.js, src/ffmpeg.js |
| localff_test | "use my ffmpeg": exe, folder, zip; errors for missing ffprobe / not ffmpeg | 21 | tmpdir (ffmpeg faked) | 1 | 0 / 0.2 / pass | src/localff.js, src/ffmpeg.js |
| membudget_test | memory budgets from machine memory; page gets cfg.engine.mem; ffprobe starts with session | 24 | tmpdir | 1 | 0 / 1.4 / pass | media/membudget.js, src/extension.js |
| mkv_synth_test | sniff-matroska on hand-built EBML, every refusal, truncation at every byte | 19 | tmpdir | 1 | 0 / 0.4 / pass | src/sniff-matroska.js |
| mp4_synth_test | rotationOf / sniffNativeMp4 / sniff-codecs on hand-built MP4s | 109 | tmpdir | 1 | 0 / 0.2 / pass | src/rotation.js, src/sniff-codecs.js |
| native_choice_test | Session.open decoder choice end-to-end (probe results, WSL/SSH/containers) | 6 | **ff** (skips w/o) | 1 (+ff) | 0 / 0.9 / pass | src/extension.js, src/ffmpeg.js, src/remotestream.js |
| native_early_test | native ffmpeg starts before page ready, kept/restarted correctly | 43 | **ff** (skips w/o) | 1 (+ff, real native decode) | 0 / 6.8 / pass | src/extension.js, src/native.js, src/frameserver.js, src/ffmpeg.js |
| native_fallback_test | GPU method producing nothing retried in software, then built-in; real GPU method makes frames | 66 | **ff** (skips real part w/o); fake ffmpeg scripts | 1 (+ff) | 0 / 0.6 / pass (d3d11va) | src/native.js, src/hwaccel.js, src/ffmpeg.js |
| native_hdr_test | native sends yuv420p10le for HDR output, same samples as ffmpeg; SDR stays 8-bit; DV probe | 23 | **ff**; test/media/cases/hdr (make_cases_media) and test/zoo/make_dv.js as a module | 1 (+ff) | 0 / 1.2 / pass | src/native.js, src/hwaccel.js, src/ffmpeg.js |
| native_hidden_test | hidden tab stops native ffmpeg and remote stream; re-seek resumes | 11 | **ff** (skips w/o) | 1 (+ff) | 0 / 1.0 / pass | src/native.js, src/remotestream.js |
| native_loop_test | loop standby ffmpeg started at EOF, taken by seek-0, dropped otherwise | 8 | **ff** (skips w/o) | 1 (+ff) | 0 / 1.3 / pass | src/native.js |
| native_rotation_test | native emits stored (non-autorotated) frames, equal to ffmpeg -noautorotate | 6 | **ff**; optional arg (default test/media/cases/rotated.mp4, made by make_cases_media) | 1 (+ff) | 0 / 0.4 / pass | src/native.js, src/rotation.js |
| native_sniff_test | early MP4/MKV sniff agrees with ffprobe on ffmpeg-made files | 10 (48 at runtime) | **ff** (makes files in tmp) | 1 (+ff) | 0 / 4.1 / pass | src/rotation.js sniffNativeMp4, src/sniff-matroska.js, src/ffmpeg.js |
| native_transport_test | native recovery handshake with dropped HTTP reader, fake ffmpeg pipes | 23 | - | 1 | 0 / 0.1 / pass | src/native.js, src/frameserver.js, media/engine.js |
| onboarding_test | first-open popup rules, buttons, never in SSH/untrusted | 24 | mock vscode; ff optional (part skipped) | 1 | 0 / 3.3 / pass | src/extension.js maybeOnboard, src/decide.js |
| probe_run_test | probe.js process side with node standing in for ffmpeg: spawn, abort, time limit, frame tags | 110 | tmpdir | 1 (slowest unit: has real time-limit waits) | 0 / 13.4 / pass | src/probe.js |
| probe_test | probe logic with fake ffmpeg: method order, fallback detection, stored results invalidation | 90 | tmpdir | 1 | 0 / 0.1 / pass | src/probe.js, src/hwaccel.js |
| proxy_test | downloads through local CONNECT proxy: choice, tunnel, auth, refusal, strictSSL | 22 | local http; openssl optional (HTTPS part skipped w/o) | 1 | 0 / 0.2 / pass | src/proxy.js |
| rangecmd_test | A-B export names, checks, ffmpeg command line + shell quoting | 16 | - | 1 | 0 / 0.1 / pass | src/rangecmd.js |
| readblock_test | concurrent readBlock share a handle, short reads trimmed, failed reads answer | 7 | tmpdir | 1 | 0 / 0.2 / pass | src/extension.js readBlock |
| reload_open_test | file change during open() does not send second 'libav' | 2 | mock vscode | 1 | 0 / 2.1 / pass | src/extension.js |
| remember_pos_test | resume positions stored on pause/seek/close only | 7 | mock vscode | 1 | 0 / 0.2 / pass | src/extension.js |
| remote_ffmpeg_test | ffmpeg download on remote: fake BtbN release on 127.0.0.1, x64/arm64, checksum failure | 41 | local http | 1 | 0 / 1.2 / pass | src/remoteff.js, src/setup.js, src/extension.js |
| remote_ladder_test | remote stream quality ladder adapt() from mocked link samples | 28 | - | 1 | 0 / 0.1 / pass | src/remotestream.js |
| remote_uri_test | URI schemes: git: not played, vscode-remote: opens | 6 | mock vscode | 1 | 0 / 1.1 / pass | src/extension.js |
| remotestream_test | remote stream: when to stream, GPU encoder probe+cache; with ffmpeg: A/V sync over 200 s clips, scrub, splice | 94 | **ff** (unit-only w/o) | 1 (+ff, heavier: real encode) | 0 / 9.3 / pass | src/remotestream.js, src/remoteff.js, src/ffmpeg.js |
| review_test | tools/review.ps1 -DryRun prints right commands, launches nothing | 19 | **Windows PowerShell** (skips elsewhere) | 1 (tooling) | 0 / 6.1 / pass | tools/review.ps1 |
| security_test | manifests refused as media, moov walk capped, A-B range and shell quoting | 17 | tmpdir | 1 | 0 / 0.1 / pass | src/ffmpeg.js, src/rangecmd.js, src/rotation.js |
| seek_preview_test | lazy seek-bar previews (hover order, cancel, idle close) + native ffmpeg thumbnail | 32 | **ff** + test/media/cases/long_20s.mp4 for native part (skips w/o) | 1 (+ff) | 0 / 1.8 / pass | media/thumbs.js (stub worker), src/thumbhost.js |
| send_frames_test | every requested frame answered even unreadable | 3 | mock vscode | 1 | 0 / 0.2 / pass | src/extension.js FramePlayer |
| setup_install_test | managed ffmpeg install never touches build in use; failed/stalled/cancelled leave nothing | 8 | https stubbed | 1 | 0 / 0.2 / pass | src/setup.js |
| sidecars_test | tagsOf/matchSidecars/findSidecars vs fake workspace.fs | 36 | - | 1 | 0 / 0.1 / pass | src/sidecars.js |
| size_frames_test | sizeFramesToView: 4K in 1600x900 gets 1080p frames; off -> cap; nativeMaxHeight wins | 6 | **ff** (skips w/o) | 1 (+ff) | 0 / 0.8 / pass | src/extension.js, src/ffmpeg.js |
| speed_hint_test | built-in speed samples stored, "set up ffmpeg" hint rules | 14 | mock vscode | 1 | 0 / 0.8 / pass | src/extension.js |
| step_buttons_test | stepButtons setting reaches page, declared values only, package.json | 7 | mock vscode | 1 | 0 / 0.1 / pass | src/extension.js, package.json |
| tools_cache_test | tool check + ffprobe results cached; invalidated on change | 17 | ff optional (real part skipped w/o) | 1 | 0 / 0.3 / pass | src/ffmpeg.js |
| url_stream_test | Open Video URL: URL checks, ffmpeg input args, range reads, redirects, stalls, HLS/DASH/AES against test/urlserver.js | 152 | **ff** (server part skipped w/o); local http | 1 (+ff) | 0 / 8.3 / pass | src/urlsource.js, src/ffmpeg.js, test/urlserver.js |
| vendor_detect_test | GPU vendor detection only when record missing/old/failed guess | 8 | **ff** (skips w/o) | 1 (+ff) | 0 / 3.0 / pass | src/hardware.js, src/native.js, src/ffmpeg.js |
| wav_parts_test | pcmWavParts joins to readPcmAsWav's WAV; host sends wavPart before frames | 6 | **args: MJPEG+PCM AVI** (passes vacuously with none; run_all runs it with none) | 1 | no args: 0 / 0.1 / vacuous; with s_mjpeg.avi: 0 / 0.2 / pass | src/avi.js |

Whole host suite: 56 tests (+ engine/unit) all exit 0; sum of wall times about 89 s (incl. engine/unit 0.5), dominated by
probe_run (13.4), remotestream (9.3), url_stream (8.3), native_early (6.8), review (6.1), gpu_offer (5.7), native_sniff (4.1).

### Other node tests

| file | proves | checks | needs | WASM? | layer | failure signal | run: exit / s / result | exercises |
|---|---|---|---|---|---|---|---|---|
| test/engine/unit.js | LibavPlayer/pool logic on stub decoders/clocks/workers (32 tests: budgets, A/V clock, invisible rest, etc.) | 144 (32 tests) | - | no (engine.js + decoder-worker.js source in vm with stubs) | 1 | exit code | 0 / 0.5 / pass (32/32) | media/engine.js, media/pool.js, media/timestretch.js, media/membudget.js, media/decoder-worker.js |
| test/inspect/inspect_test.js | pure helpers of media/inspect.js: parseGoto/resolveGoto, formats, yuvAt, vfSample | ~50 asserts, 7 groups | - | no | 1 | exit code (assert throws) | 0 / 0.1 / pass | media/inspect.js |
| test/subtitles/run.js | SRT/VTT/ASS parsers, text decoding (BOM/UTF-16/1252/CRLF), embedded cues, overlap-safe index | 56 sites, 75 at runtime | fixtures in test/subtitles/fixtures | no | 1 | exit code | 0 / 0.1 / pass | media/subtitles.js |
| test/subtitles/sidecars.js | matchSidecars/tagsOf | 12 | - | no | 1 (overlaps host/sidecars_test) | exit code | 0 / 0.1 / pass | src/sidecars.js |
| test/timestretch/run.js | time stretch: length, pitch, chunk continuity, rate-1 passthrough, channel alignment, odd rates, speed | 11 sites, 67 at runtime | optional arg/TS_WAV_DIR writes WAVs | no | 1 (has a speed check; 4 s) | exit code | 0 / 4.0 / pass | media/timestretch.js |
| test/avi_test.js | standard DHT table == ffmpeg's; per AVI: frames == ffprobe count, first frame SOI, DHT | 0 asserts, per-file OK/FAIL | **ff + ffprobe**; **args: MJPEG AVI files** (no args = only DHT check) | no | 1 (+ff) | exit code | no args: 0 / 0.1 / pass (DHT only); with s_mjpeg.avi: pass; **with a non-MJPEG AVI (containers/h264_aac.avi): exit 1, TypeError at avi_test.js:56 (info.frames[0] undefined)** | src/avi.js |
| test/bitmapsubs/run.js | PGS/DVD/DVB picture subs: palette/boxes/cue index (pure) + decoder-worker decoding real files: pictures, positions, colours, clearing, seeks | 22 sites, 100 at runtime | **ff with libx264** to make media (test/bitmapsubs/make_media.js) in %TEMP%/vpe-bitmapsubs (or arg / VPE_BITMAPSUBS); existed already | **yes** (decoder-worker via test/tracks/driver.js) | 2 | exit code | 0 / 0.6 / pass (media pre-existing) | media/subtitles.js, media/decoder-worker.js, libav-vpe |
| test/tracks/run.js | track list, stream discard, audio switching, embedded subs, open-GOP seeks, skip_frame | 31 sites, ~56 ok lines | **ff with libx264, libx265, libvpx-vp9, libopus, ac3**; media made on demand into test/media/tracks (gitignored, ~160 MB) by test/tracks/make_media.js | **yes** (driver.js -> decoder-worker / pool) | 2 | exit code | 0 / 68.9 / pass (first run, made test/media/tracks in ~20 s); rerun with media present 0 / 73.9 / pass. Prints `skip hevc8_aac.mp4 / mpeg2_mp2.mpg / mpeg2_ac3.vob (missing)` - nothing generates those | media/decoder-worker.js, media/pool.js, libav-vpe |
| test/tracks/engine_smoke.js | LibavPlayer (engine.js) in Node with stub WebGL/WebAudio: switch sound+subs in multi-track file, open-GOP fallback with WebCodecs stand-in | 19 | same media as tracks/run.js | **yes** | 2 | exit code | **1 / 13.3 / FAIL**: 11 checks ok, then crash `TypeError: this.ac.suspend is not a function` at engine.js:991 restAudio (timer). The test's FakeAudioContext (engine_smoke.js:26-37) lacks `suspend()`, added to engine by commit f97fd39 "Suspend the AudioContext while paused or hidden". Stale stub, not an engine bug. Reproduced on a rerun (1 / 13.3). docs/notes/test-migration.md also records a pre-existing failing check ("open-GOP H.264 falls back to software after the seek") that now is not even reached. | media/engine.js, media/decoder-worker.js, media/pool.js |
| test/tracks/measure.js | timings for stream discard and skip_frame=noref | 0 | args `discard|nonref <file>`; run via benchq | yes | 4 | prints; exit 2 on bad usage | not run (benchmark) | media/decoder-worker.js, media/pool.js |
| test/thumbs/service.js | ThumbService + real thumbs worker: fast sweep ends on last position, cache, idle prefetch pauses while busy, cache cap, no prefetch remote | 8 | **arg: a video file** (exit 2 without) | **yes** (thumbs-worker.js + libav-vpe) | 2 | exit code | **1 / 50.1 / FAIL** (with test/media/cases/long_20s.mp4): 5 PASS, 2 FAIL ("sweep: fewer requests than pointer moves": 118 requests for 60 positions; "idle prefetch ran": 0 requests in 46 s), then crash `TypeError: rsvc.nextPrefetch is not a function` (service.js:111). Stale: media/thumbs.js no longer idle-prefetches (commit bff54bc "Seek-bar thumbnails decode only while hovering or dragging"); host/seek_preview_test.js covers the current lazy behaviour. Candidate for deletion or rewrite. | media/thumbs.js, media/thumbs-worker.js, libav-vpe |
| test/xray/index_test.js | Codec X-ray packet index vs ffprobe (count, sizes, pts, key flags), monotonicity, shuffle==seq; --frames pict_type | 0 asserts; prints per-file comparison | **args: files/dirs**; **ffprobe** | **yes** (xray-worker.js + libav-vpe) | 2 (but report-only) | **always exit 0** (mismatch / ERROR only printed) | 0 / 1.0 / pass by eye (`--order=both` s_h264.mp4, s_hevc.mp4, s_vp9.webm: 90 pkts each, ffprobe missing 0, size diff 0, key diff 0, shuffle same) - exit code would be 0 regardless | media/xray-worker.js, libav-vpe |
| test/pool/harness.js | DecoderPool vs single worker: same frames/timestamps/pixel hash/sound items, accurate+fast seek; also fps and RSS | 0 asserts; compare() strings | **args: files/dirs**; flags --seek --soft-all --mode | **yes** (decoder-worker + pool) | 2 (correctness) / 4 (fps, RSS) - mixed | **always exit 0** (mismatch only printed as "frames <reason>") | 0 / 1.4 / pass by eye (`--seek` s_hevc.mp4, s_vp9.webm: frames ok, seek ok / fast ok) - exit code would be 0 regardless | media/pool.js, media/decoder-worker.js, libav-vpe |
| test/thumbs/bench.js | thumbnail worker start / cold / warm times, RSS | 0 | args files; benchq | yes | 4 | prints | not run | media/thumbs-worker.js |

### Benchmarks / perf (layer 4, not run)

| file | what | needs |
|---|---|---|
| test/perf/bitrate_model.js | probe clip speeds vs real files; derives decide.js BPP_EXPONENT | ff, test/media clips, media/probe, benchq |
| test/perf/browser_path.js (+browser_path.html) | decoder -> postMessage -> GLRenderer in headless Edge/Chromium | **Edge/Chrome**, local http, args |
| test/perf/frame_path.js | decoder -> copy -> postMessage -> renderer CPU side, fps | wasm, args (e.g. test/media) |
| test/perf/probe_run.js | the ffmpeg probe with shipped clips + CPU load | ff, media/probe, benchq |
| test/bench/run_bench.js | decode throughput per route (wasm, cpu1, cpuN, d3d, cuda); results.json/results.md, compares runs | ff + ffprobe, test/media real footage, benchq, loadmon |
| test/tracks/measure.js, test/thumbs/bench.js | see above | |

### Tools / helpers, not tests

| file | what |
|---|---|
| test/host/run_all.js | runner for layer-1 host tests + engine/unit (needs python on Windows) |
| test/host/mock_vscode.js, test/host/windows_job.py | helpers |
| test/tracks/driver.js, test/pool/worker-shim.js | worker_threads drivers used by tracks/bitmapsubs/thumbs/harness tests |
| test/benchq.js | benchmark queue / CPU pinning (has its own host test) |
| test/loadmon.js | CPU load sampler library for timing runs |
| test/urlserver.js | local 127.0.0.1 HTTP/HLS/DASH server used by url_stream_test and test/vscode url case; needs ff to make streams |
| test/media/make_cases_media.js | generator: small lavfi clips into test/media/cases (used on demand by compare/native_rotation tests and test/vscode) |
| test/media/make_containers.js | generator: test/media/containers remuxes from h264_aac_anim_1080p.mp4 |
| test/media/make_media.js | generator: benchmark clips from real footage (needs --src from fetch_sources) |
| test/media/fetch_sources.js | downloads ~8 GB source frames (network) |
| test/tracks/make_media.js, test/bitmapsubs/make_media.js | generators for layer-2 tests (called on demand) |
| test/zoo/make_zoo.js | generator: codec/container zoo + manifest.json (ff lavfi) |
| test/zoo/make_hdr.js | generator: HDR patch pattern for test/vscode/cases/inspect.js (ff libx265/libx264) |
| test/zoo/make_dv.js | Dolby Vision box injector; CLI tool, also required as a module by native_hdr_test |
| test/compare/sweep.js, fetch_readmes.js | competitor research (Marketplace / Open VSX, network) |
| test/compare/movi_bench.js, render.js, extract_movi_wasm.js, wasm_strings.js | competitor (Movi) wasm extraction / benchmark / report rendering |

### Run summary and findings

- Layer 1 (all host tests + engine/unit + inspect + subtitles x2 + timestretch + avi_test): all exit 0. Host suite ~89 s
  sequential (run_all uses 60 s per-test timeout); everything except the ffmpeg-backed host tests runs in < 3 s each.
- Host tests that really start ffmpeg (native_*, gpu_offer, last_view, size_frames, vendor_detect, remotestream,
  url_stream, seek_preview native part, compare + native_rotation media, tools_cache real part, native_sniff) **skip and exit 0
  without ffmpeg** - a green run on a machine without ffmpeg proves much less. They are host logic + real native ffmpeg,
  not WASM; candidates for a "layer 1 + ffmpeg" tag or for layer 2 (native engine).
- Vacuous passes: `wav_parts_test.js` and `avi_scan_test.js` iterate over argv files and pass with none; run_all runs
  wav_parts with no args (0 checks) and skips avi_scan. `avi_test.js` without args only checks the DHT table.
- Exit code 0 regardless of result: `test/xray/index_test.js`, `test/pool/harness.js` (report-only; need asserting
  before they can gate layer 2). `test/thumbs/service.js` needs a file arg (exit 2 without).
- Layer 2 (WASM): tracks/run (pass, ~70 s alone), bitmapsubs/run (pass, 0.6 s with cached media in %TEMP%),
  xray/index_test (ok by eye, 1 s), pool/harness (ok by eye, 1.4 s), **tracks/engine_smoke FAIL**, **thumbs/service FAIL**.
- Side effects of running: test/tracks/run.js created test/media/tracks/ (~160 MB, git-ignored); bitmapsubs used
  %TEMP%/vpe-bitmapsubs; git status stays clean.
