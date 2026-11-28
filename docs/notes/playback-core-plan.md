# Playback core and a thin layer 3: plan (2026-11-28)

Status: proposal for the maintainer (read-only analysis, no product or test code changed). Snapshot: `main` at 6f6c1dd.
Revised after an independent review (section 7 lists what changed).
Inputs: every file in `test/vscode/cases/`, `test/vscode/scenario_list.js`, the runner, 105 recorded layer-3 runs
(`test/vscode/out/scenarios-*.json`, field `tests`), `media/player-unified.js`, `media/engine.js`, `media/player-ui*.js`,
`media/player-state.js`, `media/thumbs.js`, `media/frame-player.js`, `media/stepgoal.js`, `media/autoplay.js`,
`media/abloop.js`, `media/player-engine-adapter.js`, `media/unified-contracts.d.ts`, `test/engine/harness.js`,
`src/stream.js`, `src/native.js`, and the playback fixes of the last two weeks.

## 0. In one page

**Problem.** Layer 3 has 34 scenarios and 301 checks, takes 31-42 min serially (1,850-2,500 s in the five full runs on
record), and 164 of the 338 result names on record failed at least once in 105 runs (many of those runs predate fixes
such as 08eb884, so the rates are upper bounds). The case files have 207 `sleep(` calls and about 520 hard-coded timeout
literals, and 26 of them call `waitLog` or match free log text. A scenario is one VS Code instance; `--grep` picks whole
scenarios (`test/vscode/scenarios.js:212`), so no check can be rerun alone. The real reason for the weight: the playback
decisions (seek, step, landing, end, loop, Compare sync) live in `media/player-unified.js` 795-1427, in
`media/engine.js` (`addFrame`, `tick`, `seekTime`, `play`) and in `media/player-ui.js` (`decoderFrame`, `decoderEnded`,
`restartAt`, visibility), plus a host half in `src/stream.js` / `src/native.js`. They read `performance.now()` /
`Date.now()` directly and reach into ~20 engine fields, so nothing below layer 3 can drive them. All 22 playback fixes
since 2026-11-14 were in this logic (section 3.5).

**A second finding: layer 2 does not test the production step and A-B paths.** `test/engine/harness.js:195` steps with
the engine's own `stepFrame` when it exists (it does), while the unified viewer never calls it: production steps go
`S.stepFrame` → `player-unified.js` `seekTo` / `deferred` (1121-1148) → `seekFrame`. `test/engine/journeys.js:91-121`
wraps A-B with its own driver, while production wraps in `player-ui.js:2956-2961`. Layer 2 also runs WebAssembly only,
so it says nothing about the WebCodecs path. Every inventory row that cited `test/engine/` was re-checked for this.

**Inventory result** (section 1): 293 results inventoried (the 301 of the last full run, a few listed compactly):
**96 KEEP-L3 (33 %), 104 MOVE-DOWN (35 %), 93 DUPLICATE (32 %)**; 53 of the duplicates are clean fake-DOM / host-mock UI
duplicates that can go now. The KEEP set reduces to about 30 distinct wiring concerns, which fit in 10 scenarios.

**Target.** Functional core, imperative shell:

```
 host (src/)                         webview page
 stream.js, native.js  ◀─ page↔host decoder protocol (contract) ─▶ adapters
 unified-session ──messages──▶ page shell: media/player-unified.js (~1,000 lines; subs, probes, tool hosts split out)
                                    │                                             ▲
                                    ▼ intent (commit)                             │ realised state, events
                     ui: media/player-ui*.js over media/player-state.js (USER INTENT) ┘
                                    │ Player API: play pause seek step setRate setLoop setAB setOffset setClock
                                    ▼
          ┌──────────────── media/playback/ (pure; Node-loadable; no DOM, no globals, no timers) ───────────────┐
          │ player.js ──┬── transport.js   phase, realised play state, end reason, loop/A-B, autoplay-next    │
          │  (facade,   ├── seek-planner.js one pending slot per decoder, coalesce, held seeks, landing      │
          │   per tab;  ├── sync.js        realised clock time per tile, follower time, holdLagging, sound   │
          │   REALISED  ├── timeline.js    frame <-> pts (CFR, NTSC, VFR, gaps, start offset), due picture,  │
          │   STATE)    │                  presentation lead and follower nudge as explicit parameters       │
          │             └── preview-scheduler.js  slot grid, hover/rest, background pass pacing              │
          │        ▲ Clock { now, setTimer, clearTimer, requestFrame }  + MediaClock + TimeSource (audio)   │
          └────────┼───────────────────────────┬─────────────────────────────────────────────────────────────┘
     page: rAF + performance.now               │ DecoderPort (section 2.1)
     test/sim: virtual clock                   │
                        ┌──────────────────────┼───────────────────┬──────────────────────┐
                 engine.js adapter       WebCodecs path      native frames           frame-player
                 (decoder-worker, pool,  (inside engine)     (framestream,           (image sequences,
                  caches, packets)                            frame server)           MJPEG)
                        └────── pictures ──▶ renderer (gl-renderer, compositor, HDR)   audio (WebAudio, timestretch)

 test/sim: virtual clock + FakeDecoderPort(seed) drive media/playback/ (and, first, today's page) in Node
 test/sim/host: real src/stream.js + fake ffmpeg + src/link-sim.js on the same virtual clock
```

**Plan** (section 4), each step mergeable alone, characterization tests first, in the reviewer's recommended order:
S0 runner fixes and probe fields, then retire the 53 clean UI duplicates; S1 layer-2 harness steps and wraps like
production, re-inventory the engine rows; S2 characterization harnesses (page and host half); S3 timeline; S4
seek-planner together with the engine's picture events and the Clock seam; S5 transport; S6 sync; S7 Player facade;
S8 DecoderPort for the remaining decoders; S9 preview-scheduler (independent); S10 media clock and catch-up (optional);
S11 thin layer 3 (10 scenarios, ~10 min, every check rerunnable in ~30 s).

**Reference designs** and what this plan takes from each:

| Design | What it does | Taken here |
|---|---|---|
| mpv (`player/playloop.c`, libmpv client API) | One play loop; `queue_seek` keeps a single pending seek (latest wins, relative seeks add up, exact vs keyframe flag); hr-seek decodes from the keyframe and drops until the target; end-file reasons (eof, stop, error); clients send async commands and observe properties | One pending-seek slot per decoder in `seek-planner.js`, wheel notches add up; landing = "decode from keyframe, keep the picture the frame number names"; an end reason enum (`natural`, `stopped`, `error`, `aborted`); layer 3 observes probe properties, not log lines |
| Chromium media (`PipelineImpl`, `RendererImpl`, `TimeSource`, `VideoRendererAlgorithm`) | Explicit state machine; seeks serialized as flush then start-from; `TimeSource` implemented by the audio renderer or a wall clock with an injectable tick clock; frame selection for a render interval is a pure, unit-tested algorithm; buffering state HAVE_NOTHING / HAVE_ENOUGH | Audio as a `TimeSource` behind `MediaClock`; the due-picture rule (engine `tick` 1800-1814) becomes a pure `timeline.dueIndex()` with the presentation lead as a parameter; our loading ring = buffering state, emitted by the core |
| ExoPlayer / Media3 (`Player`, `ExoPlayerImplInternal`, `Clock`, `FakeClock`, `TestPlayerRunHelper`) | A `Player` interface: commands plus listener events; `playWhenReady` (intent) apart from `playbackState` (IDLE/BUFFERING/READY/ENDED) and `isPlaying`; position discontinuity reasons; internal loop on an injectable `Clock`; tests run fake sources/renderers on `FakeClock` with `runUntilPlaybackState` | The Player API shape; **intent vs realised state** (section 2.0: intent stays in `player-state.js`); discontinuity reasons (seek, loop wrap, autoplay transition); the simulator's `runUntil(predicate)` helpers |

## 1. Inventory of every layer-3 check

Classification: **KEEP-L3** needs real VS Code (GPU/WebCodecs, WebGL/WebGPU, webview boot and CSP, VS Code tabs,
commands, URI handler, context keys, native ffmpeg transport into the webview, Remote-SSH/transcode, file icons).
**MOVE-DOWN** is logic a lower layer can own once extracted or once a lower test is extended (target named). A row that
is only partly covered below is MOVE-DOWN, not DUPLICATE. **DUPLICATE** is fully proven by a lower-layer test (cited);
rows that cited `test/engine/` for stepping or A-B were reclassified (S1 re-checks the rest). Anti-patterns:
**S** fixed sleep (count), **T** tight timeout used as a speed check, **L** waits on or asserts free log text, **C** state
carried from an earlier result or case, **P** pixel- or timing-sensitive. **Flaky** = failed runs / runs from the 105
recorded runs (blank: never failed; `*` = counted under an older result name). Flake rates include runs before recent
fixes (for example 08eb884 for `sync/offsets`), so they mark where to look, not current failure rates.

Systemic, not repeated per row: `tightFirstFrame` (`test/vscode/hidden.js:248-251`) caps every first-frame wait at 15 s,
a hidden speed check (T) in every case that opens a clip; `expectFrame` (`test/vscode/lib.js:184`) compares by NCC
against ffmpeg (P); per step the runner sleeps 500 + 300 ms (`scenarios.js:114,129`) and `closeClip` 700 ms
(`hidden.js:275`).

### 1.1 Totals

"Results (rows expanded)" expands each row's result pattern; "last full run" is the per-scenario result count of the
2026-11-28 13:42 run. They differ where a row lists results compactly (hdr, inspect, subtitles, file-icons: same class
for all) and where the run ended early (`multiview-large` reported one TIMEOUT bucket instead of its 7 results;
`wheel-step` and `native` count one skipped / extra result differently). Classes are counted on the expanded results.

| Scenario | Inventory rows | Results (rows expanded) | Results in the last full run | KEEP-L3 | MOVE-DOWN | DUPLICATE | of which clean UI duplicates (S0) |
|---|---|---|---|---|---|---|---|
| open-formats | 4 | 14 | 15 | 14 | 0 | 0 | 0 |
| playback | 15 | 21 | 22 | 11 | 8 | 2 | 0 |
| autoplay-loop | 5 | 6 | 6 | 0 | 5 | 1 | 0 |
| seeking | 11 | 11 | 11 | 6 | 5 | 0 | 0 |
| inspect | 13 | 13 | 15 | 8 | 5 | 0 | 0 |
| scopes-export | 10 | 10 | 11 | 6 | 4 | 0 | 0 |
| subtitles | 2 | 2 | 4 | 0 | 2 | 0 | 0 |
| clip-export | 4 | 4 | 5 | 0 | 3 | 1 | 0 |
| ui | 22 | 22 | 22 | 3 | 8 | 11 | 11 |
| folder-rail | 10 | 10 | 11 | 0 | 5 | 5 | 5 |
| picture-size | 12 | 12 | 12 | 0 | 3 | 9 | 9 |
| picture-size-native | 1 | 1 | 1 | 0 | 1 | 0 | 0 |
| compare | 35 | 35 | 35 | 7 | 9 | 19 | 19 |
| multiview | 19 | 19 | 19 | 2 | 9 | 8 | 8 |
| multiview-transcode | 1 | 1 | 1 | 1 | 0 | 0 | 0 |
| multiview-transcode-packets | 1 | 1 | 1 | 0 | 1 | 0 | 0 |
| multiview-native | 7 | 7 | 7 | 3 | 3 | 1 | 0 |
| multiview-large | 7 | 7 | 1 | 3 | 3 | 1 | 1 |
| multiview-large-native | 1 | 2 | 2 | 2 | 0 | 0 | 0 |
| native | 5 | 7 | 6 | 4 | 1 | 2 | 0 |
| invisible | 3 | 3 | 4 | 1 | 1 | 1 | 0 |
| restore | 2 | 2 | 2 | 1 | 0 | 1 | 0 |
| seek-preview | 13 | 13 | 13 | 1 | 3 | 9 | 0 |
| wheel-step | 1 | 5 | 4 | 0 | 5 | 0 | 0 |
| hdr | 9 | 9 | 15 | 6 | 1 | 2 | 0 |
| onboarding | 5 | 5 | 5 | 1 | 0 | 4 | 0 |
| url | 14 | 14 | 14 | 1 | 4 | 9 | 0 |
| url-native | 9 | 9 | 9 | 1 | 5 | 3 | 0 |
| remote-stream | 10 | 12 | 12 | 6 | 3 | 3 | 0 |
| remote-stream-packets | 5 | 5 | 5 | 0 | 5 | 0 | 0 |
| remote-stream-play-during-seek | 1 | 1 | 1 | 0 | 1 | 0 | 0 |
| remote-slow-link | 2 | 2 | 2 | 1 | 1 | 0 | 0 |
| remote-stream-hdr | 1 | 1 | 1 | 1 | 0 | 0 | 0 |
| file-icons | 3 | 7 | 7 | 6 | 0 | 1 | 0 |
| **Total** | **263** | **293** | **301** | **96** | **104** | **93** | **53** |

### 1.2 The flakiest checks and why

From the 105 runs (checks with at least 8 runs, infrastructure buckets left out). Most failures are timeouts on log
text or on a fixed deadline, not wrong pictures; the rest are the playback decisions the core will own. S0 replaces the
log waits of the first ten with probe fields.

| Check | Fails | Cause class | Fix in this plan |
|---|---|---|---|
| multiview-native/native/tile-size | 7/13 | "decisions: none": four `waitLog(...).catch(() => {})` then a regex (L) | probe field `decision` per tile (S0) |
| remote-stream/remote_stream_size/size-to-picture | 7/24 TO7 | 15 s wait on a log condition (L, T) | probe field for the frame size and pending restart (S0); stays in L3 until the host-half sim covers it (S2b) |
| invisible/perf-invisible/loop-rest | 6/15 TO6 | 4 s wait for a step while the frame loop rests (T) | drop the speed deadline (S0); rest/wake in the simulator (S2a) |
| compare/compare_link/open/split-frame | 6/16 | "not synced after open link" | landing + sync in the simulator (S4, S6); URI handler stays in L3 |
| remote-stream/remote_stream_fallback/pixel-tools | 6/24 TO6 | 15 s condition wait (T) | probe field (S0); stays in L3 (exact grab under Live transcode) |
| playback/playback/resume/position | 5/19 TO5 | two fixed 2.5 s sleeps for a 2 s host throttle (S, T) | wait for the stored position through a hook (S0); resume intent in the simulator (S2a) |
| url/url_stream/hls_quality | 5/14 TO5 | reload restores moment and play (L) | probe field `restored` (S0); restore intent in `player.js` (S7) |
| seek-preview/seek_preview_native/native | 5/23 TO4 | 15 s for neighbours while hovering (T) | `preview-scheduler` (S9) |
| remote-stream/remote_stream_fallback/slow-link | 5/24 TO5 | real-time throttle windows (S, P) | DUPLICATE of ladder + link-sim tests |
| hdr/hdr_output_forced*/pattern/{pq,hlg,dv81} (6 checks) | 4/12 TO4 each | 8 s wait for the stats overlay, not the pixels (T) | stats text to a UI test; keep the WebGPU pixel read |
| multiview-transcode/tile-streams-and-original | 4/11 | About text and clock switch (L) | keep one transcode tile check; rest DUPLICATE |
| compare/compare_ui/start/drop | 4/23 TO2 | synthetic drop, 800 ms sleep (S, L) | DUPLICATE of `player_unified_test.js` drop hint |
| compare/compare_ui/bar | 4/21 | bar ids depend on stage width (P, C) | UI test |
| autoplay-loop/playback_autoplay/end-of-sound | 3/13 | "play after the end continued at 4.985 s" (end rule) | `transport` (S5) |
| seeking/seeking/abloop/s_h264.mp4 | 3/21 | played past B: 2.825 s (production wrap in `player-ui.js` `decoderFrame`) | `transport` A-B wrap (S5) |
| ui/ui/time/formats | 3/16 | "frame 49 / 90 (frame 50)": bar vs shown picture | `timeline` + `player` (S3, S7) |
| multiview/multiview/sync/remove-clock, sync/offsets, sync/clock-while-playing | 2-3/14 | off-by-one (#20 vs #19, fixed by 08eb884), "never synced" | `sync` in the simulator (S6) |
| open-formats/play/containers/{avi,m2ts,mkv,webm} | 1-3/14 | "seek to frame 39 showed null": a seek to the frame already shown never signals landed | `seek-planner` emits `landed` for a no-op seek (S4); 6f6c1dd worked around it in the test |
| wheel-step/* | 1/10 each | rapid notches land on 60/63/56, expected 54 | `seek-planner` notch accumulation (S4) |
| folder-rail/folder-rail/compare/rail (+3 cascades) | 3/8 TO3 | one failure cascades through the shared tab chain (C) | per-check fixtures (S11) |
| compare (scenario) | 3/3 TO3 | `compare_metrics` waits ate the 255 s budget | metrics leave L3 (S0) |

### 1.3 Per scenario


### open-formats


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| open-formats | wcprobe | Real webview page and worker report WebCodecs H.264 and VP8 support | KEEP-L3 (WebCodecs allowlist exists only in real VS Code webview) | L (JSON from log line) | |
| open-formats | play/h264_8_2160p.mp4, play/h264_aac_anim_1080p.mp4 | GPU decoder chosen, plays, sound picked, two paused seeks land on frame | KEEP-L3 (WebCodecs GPU pick+play); seek landing part MOVE-DOWN→seek-planner | L (first frame/streams/decoder from log), S2 (poll 200/250 ms), T (15 s first frame) | |
| open-formats | play/containers/h264_aac.{mkv,mov,m2ts,flv,avi}, play/containers/vp8_vorbis.webm | Each container: WebCodecs path, plays, sound, two paused seeks land | KEEP-L3 (WebCodecs container sweep, thin #1: layer 2 runs WASM only; the WebCodecs path (Annex-B / avcC) is proven only here) | L, S2, T | avi 3/14, m2ts 2/14, mkv 1/14, vp8_vorbis.webm 1/14 ("seek to frame 39 showed null": no-op/unpainted seek) |
| open-formats | play/{mpeg2_1080p.mpg, hevc_10_2160p.mp4, av1_8_1080p.mp4, vp9_2160p.webm, prores_proxy_1080p.mov, hevc_8_1080p.mp4} | WebAssembly path chosen, plays, two paused seeks land | KEEP-L3 (the only 4K paused-seek check: test/engine/formats_4k.js checks the first picture only; thin #2 keeps HEVC 4K); other clips DUPLICATE→test/engine/formats_media.js | L, S2, T | mpeg2 1/14, prores 1/14 TO1 |


### playback


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| playback | open/fmt/{vp8_vorbis.webm, h264_ac3.mts, h264_ac3_51.mkv, h264_noaudio.mp4, h264_vfr.mkv} | Opens on webcodecs, canvas shown, sound decoded, frames advance when playing | KEEP-L3 (WebCodecs sweep, thin #1: layer 2 runs WASM only; the WebCodecs path (Annex-B / avcC) is proven only here) | T | |
| playback | open/fmt/{h264_high10.mp4, h264_444.mp4, odd_853x479.mkv} | Opens (any decoder / soft), canvas, sound, frames advance | KEEP-L3 (device-dependent WebCodecs High 10 / 4:4:4 and odd-size WebGL textures, thin #1; formats_cases.js runs WASM) | T | |
| playback | open/audio-only | Sound-only file: time runs forward, never jumps back, no overlay | MOVE-DOWN→clock (audio-master clock w/o picture) + transport | P (2.2 s wall sample, speed>0.2) | |
| playback | rate/speed | Media time runs at 2/0.5/1/1.5x within 35 %, audio is clock | MOVE-DOWN→clock (rate) | P (2.6 s wall samples x4) | |
| playback | neighbour/next-prev | Shift+N/P opens next/previous folder file; "First video" toast at end | KEEP-L3 (VS Code opens a new custom-editor tab); toast decision → ui test | L (waitLog "first frame shown") | |
| playback | rotation/rotated.mp4 | Portrait canvas; picture equals ffmpeg's rotated frame 0 | KEEP-L3 (WebCodecs frame + WebGL rotation); open part DUP formats_cases.js | P | 1/19 (thumb capture TypeError) |
| playback | status/fully-decoded-stable | "Fully decoded" status stable paused and while playing; no notice | MOVE-DOWN→player (status derived from cache state) | P (2.0+2.5 s samples), T (25 s) | |
| playback | resume/position | Position remembered per file across close/reopen; not near start | MOVE-DOWN→host test (DUP host/remember_pos_test.js store) + player (open-at-t) | S2 (2500 ms x2, no signal), T (30 s reopen opt-out) | 5/19 TO5 |
| playback | damaged-h264/damaged_h264.mkv | Playback continues past one damaged picture, no error overlay | KEEP-L3 (real hardware WebCodecs error behaviour) | S1 (500), L (decoder lines recorded) | |
| playback | damaged-h264/damaged_h264_b.mkv | Same, batch-read variant (regression) | DUPLICATE→test/engine/frames_webcodecs_error.js (DAMAGED=damaged_h264_b.mkv) | S1, L | 1/19 TO1 |
| playback | truncated/trunc_moov.mp4 | MP4 without index: clear "could not be opened" message, no hang | MOVE-DOWN→engine L2 (demux error path) | T (25 s) | |
| playback | truncated/trunc_faststart.mp4, truncated/trunc.mkv | Cut file: first half opens and frames advance | MOVE-DOWN→engine L2 (trunc.mkv already used by test/engine/frames_onend.js early-end) | | |
| playback | audio/truehd-51side | TrueHD 5.1: 6 channels, joined chunks, <200 sources, audio clock | MOVE-DOWN→engine L2 (extend test/engine/unit.js to assert channels, joined chunks and the audio clock); thin #2 keeps one WebAudio master-clock check | S1 (2500) | |
| playback | audio/71-centre-downmix | 7.1 FLAC mixed to 2 channels for WebAudio | DUPLICATE→test/engine/unit.js (same test, downmix) | | |
| playback | thumbs/capture-4k | Preview capture/pass on: no extra dropped/late frames, played frames become previews | MOVE-DOWN→preview-scheduler (gating while playing); numbers L4 | P (drop/late +-3), T (20 s for 3.5 s) | |
| (runner) | playback/webgl2 | Instance had no WebGL2 twice | infra (scenarios.js:184) | | 1/1 |
| (runner) | playback/playback (scenario) | Scenario did not finish within 15 min | infra | | 1/1 |


### autoplay-loop


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| playback_autoplay | autoplay-late-start/{start3600.mts, start3600_mpeg2.mts} | First PTS 3600 s: autoplay starts, media time runs 0.3-3x | MOVE-DOWN→clock (start offset) + transport (autoplay); open DUP formats_cases.js | P (1.8 s sample) | |
| playback_autoplay | end-of-sound/audio_longer.mp4 | Plays to sound end (>4.4 s), stops; play after end restarts <1.5 s | MOVE-DOWN→transport (ended→play restarts); partial DUP test/engine/unit.js #8a, #8c | P (busy poll 30 s) | 3/13 ("continued at 4.985 s") |
| playback_loop | loop-sound-only/sine_only.mkv | Sound-only loop wraps at end of sound (>4.3 s of 5) | DUPLICATE→test/engine/unit.js "#8b sound only: the loop comes at the end" | P (busy poll 30 s) | 1/13 |
| short_loop | soft | 2 s AV1 loop replays 48 cached frames (no re-decode) | MOVE-DOWN→transport (loop: replay vs re-seek) + engine L2 (block-cache replay) | L (only assertion is log line), S1 (suite sleep 4 s+2.5 s), L (fps from status lines) | |
| short_loop | webcodecs | Same on H.264 WebCodecs | MOVE-DOWN→transport (same decision); 1 wiring check optional | L, S1 | |


### seeking


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| seeking | step/s_h264.mp4 | WebCodecs: +1/-1 steps, seek, steps across GOP, ',' '.' keys exact picture | KEEP-L3 (WebCodecs frame exactness); step planning → seek-planner | P | |
| seeking | step/s_hevc.mp4 | WASM: seek and steps across a GOP exact | MOVE-DOWN→engine L2 once S1 makes test/engine/harness.js step like production (today it calls engine stepFrame, harness.js:195) | P | |
| seeking | step/s_mjpeg.avi | Frame player (MJPEG): steps/seek/keys exact picture | MOVE-DOWN→seek-planner + timeline (frame player; partial test/unit/frame_player_test.js) | P | |
| seeking | seek/s_h264.mp4 | Seeks 45,10,59,60,0 exact; seek while playing lands near 1.0; continuity | KEEP-L3 (WebCodecs); seek-while-playing landing MOVE-DOWN→seek-planner (WASM DUP frames_mpeg4_h264.js) | C (reuses P), P | |
| seeking | seek/s_mjpeg.avi | Same on the frame player | MOVE-DOWN→seek-planner | C, P | |
| seeking | edges/s_h264.mp4 | Past end shows last; step at last/first stays; Home | KEEP-L3 (WebCodecs edges, thin #1; frames_edges.js runs WASM) | S2 (500 x2), C, P | |
| seeking | abloop/s_h264.mp4 | A/B toast and marks; loop stays in A..B, 2 wraps; clear toast | MOVE-DOWN→transport (production wraps in player-ui.js:2956-2961; journeys.js:91-121 drives its own wrap, so layer 2 does not cover it); retire after S5 | C, P (overshoot <=0.25 s) | 3/21 ("played past B: max 2.825 s") |
| seeking | open-gop/h264 | Backward seek on open-GOP H.264 falls back GPU→soft, exact frame | KEEP-L3 (real WebCodecs open-GOP); WASM side DUP frames_edges.js open-gop | L (waitLog "open-GOP H.264: no IDR"), P | 1/21 (picture matched 30, ncc 0) |
| seeking | step-ms-rounded/ntsc_2997.mkv | fps exactly 30000/1001; steps across GOP; counter text | MOVE-DOWN→timeline (S3) + engine L2 after S1; WebCodecs part in thin #1 sweep | P | |
| seeking | end-key/audio_longer.mp4 | End shows last of 60 frames, paused | KEEP-L3 (WebCodecs End key, thin #1; frames_mpeg4_h264.js runs WASM) | P | |
| seeking | eof-flush/vp8_2s.webm | WebCodecs VP8: frames left in decoder shown at end, stops | KEEP-L3 (real WebCodecs flush); logic DUP engine/unit.js #8d, frames_edges.js eof/vp8_2s.webm | P | |


### inspect


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| inspect | goto | Ctrl+G box; "45", "0:02.5", "-6" land on exact frame; plain G not | MOVE-DOWN→ui test (go-to parse/keys) + seek-planner | S3 (300, 300, 500), P | |
| inspect | pixel | Pixel inspector RGB/YUV at 100 % matches ffmpeg; click does not play | KEEP-L3 (reads back the real GPU canvas) | S2 (600, 500), P, T (8 s read-out) | 1/11 TO1 |
| inspect | pixel/sd-709 | WebCodecs SD BT.709 YUV read-out vs ffmpeg; stats say 709 | KEEP-L3 (WebCodecs colour matrix) | P, T (8 s) | 1/11 TO1 |
| inspect | zoom | Ctrl+wheel keeps point under cursor; pixelated+grid; drag pans; Z fits | MOVE-DOWN→ui test (maths DUP host/picture_test.js) | S5 (120 xN, 300, 500, 400), P | 1/11 |
| inspect | stats | Shift+I overlay lists decoder/queue/shown; details closed | MOVE-DOWN→ui test (player_ui_tools) | T (8 s) | 1/11 TO1 |
| inspect | links/open-url | vscode:// link opens file at frame 59, paused | KEEP-L3 (VS Code URI handler, --open-url) | L (waitLog first frame), P | 1/11 (player says 0, picture 60) |
| inspect | hdr/pq, hdr/hlg, hdr/h264-pq | Shader tone-map vs ffmpeg zscale per patch; label; white after seek; stats | KEEP-L3 (WebGL shader output); maths DUP host/hdr_math_test.js | S2 (500, 1500 after seek), P, T (8 s stats) | 1/11 TO1 each |
| inspect | hdr/sdr-unchanged | SDR 8/10-bit keeps tf 0 and ffmpeg colours | KEEP-L3 (WebGL plain path) | S1 (300), P | |
| inspect | thumbs/seek-bar | Pass fills bar; hover thumb above tip; replaced; leave hides | MOVE-DOWN (partly covered: seek-preview wasm/pass + test/host/seek_preview_pass_test.js; placement → ui test) | S2 (100, 600) | 1/11 TO1 |
| inspect | xray/strip | Shift+X index; } and { go to next/previous keyframe | MOVE-DOWN→timeline (keyframe navigation); indexer → engine L2 | S1 (1200), T (8 s) | 1/11 TO1 |
| keyconflicts | read | VS Code default keybindings file read through test hook | KEEP-L3 (VS Code's own default keybindings) | L (JSON from log) | |
| keyconflicts | player-keys-free | No global VS Code binding for any player key | KEEP-L3 (VS Code keybindings) | L | |
| keyconflicts | avoided-keys-taken | Alt+Left/Right, Ctrl+K are bound (why player avoids them) | KEEP-L3 (VS Code keybindings) | L | |


### scopes-export


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| scopes_export | scopes/waveform-bars | Waveform luma per 75 % bar, parade RGB, W cycle order | KEEP-L3 (samples real GPU canvas); cycle → ui test | S3 (300, 500x4, 250 poll), P | 1/12 |
| scopes_export | scopes/sd-709, scopes/sd-untagged | WebCodecs SD: matrix 709/601 detected; levels vs ffmpeg; vectorscope | KEEP-L3 (WebCodecs colour tags) | S1 (poll), P | 1/12 each |
| scopes_export | scopes/vectorscope-bars | Vectorscope target shares; histogram draws without error | MOVE-DOWN→ui test (scopes.js maths on a synthetic frame) | S2, L (error lines) | 1/12 |
| scopes_export | scopes/updates-when-stepping | Scope updates after paused step; 0.4-14 updates/s playing | MOVE-DOWN→ui test (throttle) on player frame events | S3 (600, 900, 2500), P | 1/12 |
| scopes_export | scopes/frame-player | MJPEG 2D-canvas path gives full waveform sample grid | KEEP-L3 (frame-player 2D canvas sampling needs a real canvas; thin #3) | S1 (poll) | 1/12 |
| scopes_export | export/range | A-B PNG export: names, 320x180, each PNG is right frame | KEEP-L3 (VS Code command + webview capture → host write); names DUP host/rangecmd_test.js | L (waitLog "exported 10/10"), P (NCC) | 1/12 |
| scopes_export | export/vfr | Gapped video export continues, 25-40 files | MOVE-DOWN→timeline (gapped frame indices) | S2 (800, 1200 instead of landing), L | 1/12 |
| scopes_export | export/hidden | Export pauses while tab hidden, completes 280/280 when shown | KEEP-L3 (VS Code tab visibility) | S3 (1200, 3500, 1500), L | 3/13 ("279 files; exported 279/280") |
| scopes_export | export/no-range | No A-B: nothing written | MOVE-DOWN→host test (rangeProblem(null) in host/rangecmd_test.js + command branch) | S1 (2500 negative wait), L | 1/12 |
| scopes_export | saveFrame/png | S writes PNG of the shown frame, 320x180 | KEEP-L3 (VS Code save path from webview canvas) | S1 (200 poll), P | 1/12 |
| (runner) | scopes-export/webgl2 | Instance had no WebGL2 twice | infra | | 1/1 |


### subtitles


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| subtitles | bitmap/pgs, bitmap/dvd, bitmap/dvb | Panel picks picture track; boxes at time/place/colour after seeks; follow zoom; clear | MOVE-DOWN→ui test (overlay placement with picture.js); decode/cues DUP test/bitmapsubs/run.js | S3 (300, 500, 120x4), P (box +-1.5 px, colour) | pgs 2/11 TO1, dvd 2/11 TO1, dvb 1/11 (track not found in panel after 300 ms) |
| subtitles | tracks/menu-and-cues | Track lists, panels, CC toggle, SRT/ASS cues after seeks, audio switch keeps playing | MOVE-DOWN→ui test (panels/CC); DUP test/tracks/engine_smoke.js (switches) + test/subtitles/run.js (cues) | S5 (300 x4, 800), L (error lines), P | 2/11 TO1 |


### clip-export


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| clip_export | clip/single-mp4, clip/single-mov | Lossless A-B clip: frame count, audio streams, framemd5; reopened clip spans A..B | MOVE-DOWN (partly covered: test/host/clip_open_gop_test.js + clip_tracks_test.js (cut exactness); command/panel wiring → 1 thin check) | L (waitLog "A–B export to"), P | |
| clip_export | clip/compare-offset-and-ineligible | Compare +2f offset; shared clock wraps B→A; ineligible tile skipped | MOVE-DOWN→sync (offsets) + transport (A-B wrap); eligibility → host test | L (parses "compare report" log lines), T (8 s wrap, 12 s settle) | 2/8 TO1 ("clock wrapped from B to A" failed) |
| clip_export_native | clip/native-vfr | Native VFR marks are source picture times; clip exact | DUPLICATE→test/host/clip_native_test.js (0.96/1.04 source pictures) | S2 (2500 x2 after seek), L | 1/8 |
| clip_export_native | clip/native-compare | VFR clock + CFR follower: each tile clip starts/ends on its shown picture | MOVE-DOWN→sync + timeline | S3 (1500, 2500, 2500), L | 1/8 |


### ui


Case `ui` opens ONE player (h264_aac_anim_1080p.mp4, WebCodecs) outside `R.run` (ui.js:44) and runs 12 results on it in order, then closes
and opens a Compare for `compare`. Every result inherits panel/rate/volume/loop state from the previous one (C on all).

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| ui | a11y/names | Every bar control named; aria-pressed/expanded; seek valuetext; polite live region | DUPLICATE→test/host/player_ui_test.js ~L968-979 (names, valuetext, "every button has a name") + a11y_test.js (markup) | C | 1/15 |
| ui | a11y/states-and-live | R toggles loop + live text; M toggles mute aria; Play/Pause label | DUPLICATE→player_ui_test.js ~L981-988 (R loop, live region, Play/Pause); bar_panels_characterization_test.js "audio controls expose mute" | S6 C | 1/15 |
| ui | keys/focused-controls | :focus-visible outline on #mute; Space on focused button doesn't play | DUPLICATE→a11y_test.js L25-72 (ownsKey Space, focus-visible CSS rules); residual real :focus-visible heuristic only in browser | S3 C | – |
| ui | picture/click | Click on picture plays/pauses; with panel open only closes it | DUPLICATE→player_ui_test.js ~L990-1010 (click plays, panel/menu-open click only closes) | S2 T(4 s) C | 1/15 TO1 |
| ui | panels/toggle | cog/ⓘ/speed toggle pages + aria-expanded; Settings rows; A–B and Inspection pages; Scopes runs | MOVE-DOWN→ui test (bar_panels_characterization_test.js "Settings opens each subpage" covers most) | S11 P(1200 ms then scopesDump) C | 2/15 |
| ui | panels/keyboard | Focus into panel, ArrowDown/Home, Autoplay radios, Escape focus return, ? sheet modal | MOVE-DOWN→ui test (fake-dom focus; partly player_ui_test.js ~L600-645) | S9 C | – |
| ui | cc/hidden-until-loaded | CC hidden w/o tracks; C opens Subtitles page; SRT via picker loads track | KEEP-L3 (host file-picker→sidecar→page track wiring); UI part DUPLICATE→player_ui_test.js ~L1880-1907 | L(`debug subtitles picker ready`) C | 1/13 TO1 |
| ui | speed/step-and-clamp | >/< ±0.05, clamp 0.25–4, wheel presets, reset badge, speed panel presets | DUPLICATE→controls_test.js L99-120 (clamp/step/preset ladder) + player_ui_test.js ~L1027-1070 (wheel, reset badge) | S15 C | 1/15 |
| ui | speed/drag-outside | Speed slider drag off top/left edges keeps going until release | DUPLICATE→player_ui_test.js ~L1112-1125 ("off the top edge: 4×", "off the left edge: 0.25×") | P(no wait after pointer events) C | 1/13 |
| ui | drag/outside | Volume drag past ends/release 60%; wheel ±5%; seek drag above bar lands | DUPLICATE→player_ui_test.js ~L1072-1110 (volume off edges, release, seek hold/commit) | S8 P(px coords) C | 1/15 |
| ui | time/formats | Time text m:ss.mmm paused/playing; click cycles timecode, frame N / M | MOVE-DOWN→timeline.js + player.js (frame shown vs bar readout); format DUPLICATE→player_ui_test.js L83, L546-556 | S5 P(frame vs text race) C | 3/16 ("frame 49 / 90 (frame 50)") |
| ui | info/wasm-and-copy | ⓘ facts for GPU H.264 (Picture, Video, Sound, Played by); no actions; telemetry | MOVE-DOWN (partly covered: controls_test.js L170-174 (GPU H.264 facts); continuity telemetry → MOVE-DOWN→clock.js (sim)) | S1 C | – |
| ui | compare | Compare a11y: names, valuetext, cmpBtn, Play all, R live, panel focus, Esc | DUPLICATE→a11y_test.js (Compare tiles markup) + bar_panels_characterization_test.js L259 ("Compare panel controls reflect in the bar") | S5 + 40×1 s poll; L(`compare a11y {`, `[compare] opened`) T(30 s open) | 1/15 |
| ui_jumps | defaults | ←/→ 5 s, Shift+→ 1 s, Ctrl+← one frame on long_20s | MOVE-DOWN→seek-planner.js (jump target, frame step) + timeline.js; keyCommand DUPLICATE→player_ui_test.js L45 | S4 T(8 s seek) | 1/15 TO1 ("waiting for seek 4", frame 0: first seek right after open) |
| ui_jumps_settings | from-settings | jump.* settings reach page prefs and drive the keys | KEEP-L3 (VS Code settings→page prefs wiring); maths as ui_jumps; resolution DUPLICATE→settings_test.js L43-106 | S4 T(8 s) C(settings hook just applied; prefs race) | 2/15 TO1 ("→: 150 frames … expected one frame": defaults still active) |
| ui_info | wasm | ⓘ facts for HEVC 8-bit WASM file incl. bitrate, tracks, size | MOVE-DOWN (partly covered: controls_test.js L156-167 (WebAssembly facts); residual host probe→page facts) | S1 | – |
| ctxmenu | menu/items | Items/order, 4 separators, Loop checkbox, viewport clamp, panel exclusion, Escape | MOVE-DOWN→ui test (items, order and viewport clamp with fake-dom rects; ctxmenu_test.js covers items, not the clamp that flaked) | L(`webview: state {` without id/file match) P(clamp) C | 2/14 ("clamped: [542,99633,…]") |
| ctxmenu | commands/transport | Menu Play/Pause and Loop flip the player | DUPLICATE→ctxmenu_test.js L84-97 (every item wired to an action and key) | L(`modes report` kv text) C | – |
| ctxmenu | commands/help | Keyboard shortcuts → sheet; Settings… → main panel | DUPLICATE→ctxmenu_test.js L84-97 | C | – |
| ctxmenu | commands/ab-loop | Set Range Start/End/Clear via menu; Set twice keeps A | MOVE-DOWN→transport (A-B state and wrap; player_ui_test covers only the marks); retire after S5 | S1(400 ms negative window) C | 1/16 |
| ctxmenu | commands/frame | Copy timestamp shows "Timestamp copied" toast | KEEP-L3 (real clipboard write path; only check of it) | C | – |
| ctxmenu | menu/dismiss | Outside click closes menu without toggling play | DUPLICATE→ctxmenu_test.js ~L170-176 (consumeDismiss) + player_ui_test.js ~L1006-1010 | S1 L C | – |

ui_info_native/native (scenario `native`, not here): DUPLICATE→controls_test.js L137-154 (native facts); S1.

Counts (22 results): KEEP-L3 3 · MOVE-DOWN 4 · DUPLICATE 15.


### folder-rail


One player chain: `P` is reassigned by tab swaps (folder_rail.js:93,132,137); each result depends on the previous (C everywhere after
capsule/position). Clips test/media/cases/neigh/n1..n3 (generated).

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| folder-rail | capsule/position | Capsule "2/3", rail closed, edge tab armed, Autoplay Off | DUPLICATE→folder_rail_test.js L152-154, L429, L491 (neighbourOf, capsuleShown, rail closed 218) | – | – |
| folder-rail | rail/open-docked | Listing rows, active row, 218 px, stage shrinks beside rail | MOVE-DOWN→ui test (tools/mockup for px layout); listing DUPLICATE→folder_rail_test.js L100-110 | P(px widths) C | – |
| folder-rail | rail/resize | Resizer drag widens rail to 278 px | MOVE-DOWN→ui test (fake-dom pointer); clamp DUPLICATE→folder_rail_test.js L398-431 | T(5 s) P C | – |
| folder-rail | rail/browse-up-and-back | `..` to parent, crumb, folder Compare button, back marks active | DUPLICATE→folder_rail_test.js L100-110 + tiles_rail_characterization_test.js L251 | C | – |
| folder-rail | rail/column-menu | Column menu switches Size/Duration; duration of playing file | MOVE-DOWN→ui test (sanitizeRailPrefs column in folder_rail_test.js L398-400) | C | – |
| folder-rail | step-right-click/next-video | Right-click |▶ swaps tab to n3, rail state carried, old tab closed | KEEP-L3 (real VS Code tab swap + handoff; mock in folder_rail_test.js L511-518) | L(`first frame shown`, `session closed`) C | 1/8 TO1 |
| folder-rail | rail/close-and-edge-tab | Close rail; edge hover tab 20×84, tabindex; opens rail | DUPLICATE→folder_rail_test.js L432-436 (nearEdge) + tiles_rail_characterization_test.js L233 | T(5 s) P(px) C | – |
| folder-rail | autoplay/last-video-stays | Autoplay next at last video: paused, "Last video" toast, no swap | MOVE-DOWN→transport.js (ended + autoplay-next decision); DUPLICATE→folder_rail_test.js L523-526 | L(`end of file: next`, `folder: open`) C | 1/8 TO1 (cascade: "waiting for n2.mp4: state") |
| folder-rail | autoplay/next-once-from-start | Autoplay advances once n2→n3, starts at 0:00, no resume | MOVE-DOWN→transport.js (once, from start); tab-swap wiring as above | L(3 log counts) C | 1/8 TO1 (cascade) |
| folder-rail | rail/compare-folder | Folder row Compare opens Compare of 3 videos | DUPLICATE→folder_rail_test.js L527-548 (Compare folder via mock) | L(`compare: folder rail:` …) C | 1/8 TO1 (cascade) |
| folder-rail | compare/rail | Rail in Compare: edge tab, members marked, click adds/removes in place | DUPLICATE→tiles_rail_characterization_test.js L215-251 (rail adds to Compare, marks members) | S1(250 ms poll) L(`compare ui {`, `add`/`remove`) C | 3/8 TO3 |

Counts (11): KEEP-L3 1 · MOVE-DOWN 5 · DUPLICATE 5.


### picture-size


`player/*` share one player (C); `compare/*` use `R.t` (not `R.run`: `--sub` and `setFilter` do not skip them) and share one Compare.

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| picture_size | player/button | Button cycles Fit/Fill/Stretch/100%, labels, toast top-centre, canvas rects | DUPLICATE→picture_test.js L21-43 (rects) + bar_panels_characterization_test.js L166-177 (labels) | P(toast/canvas rect ±1-2 px) C | 3/18 (toast rect) |
| picture_size | player/z-cycle | Z cycles; zoomed Z back to Fit; − at Fit no-op | DUPLICATE→picture_test.js L59, L117 (zoom limits, Z rule) | S1(450 ms negative) P C | 2/18 |
| picture_size | player/ctrl-wheel-any-mode | Ctrl+wheel zooms from Fill | DUPLICATE→player_ui_input_test.js §2 L108-220 (Ctrl+wheel zoom) | S1(×3) P C | 2/18 |
| picture_size | player/drag-pans | Drag pans at 100%, no play toggle; click after 300 ms guard toggles | DUPLICATE→player_ui_input_test.js L178-195 (pan, 300 ms click guard) | S1(350 ms) T(guard timing) P C | 3/18 |
| picture_size | player/panel-page | ⚙ Picture size page: 4 radios, Fill, zoom +, Reset | MOVE-DOWN→ui test (partly bar_panels_characterization_test.js L236) | C | 2/18 |
| picture_size | player/sheet | Shortcuts sheet names picture size and zoom keys | DUPLICATE→controls_test.js L129 | C | – |
| picture_size | compare/button-and-mode | One mode for both tiles, frame factor, toast + live region | DUPLICATE→picture_test.js L93-116 + compare_factor_test.js (factor) | L(`[compare] opened`, `compare ui {`) P C | 1/14 |
| picture_size | compare/lockstep | Ctrl+wheel zooms both tiles same point; drag keeps them matched | DUPLICATE→picture_test.js L108 ("Lockstep") | S3 L P C | 1/14 |
| picture_size | compare/pan-paused | Paused pan after step/seek at 2 zoom levels, 4 start points | MOVE-DOWN→ui test (player-ui-tiles gesture over fake-dom; maths in picture_test.js L93) | S up to ~56 (250 ms/drag, 120 ms/wheel) L P C | 2/12 |
| picture_size | compare/panel-page | Compare ⚙ Picture size page "All videos follow together"; Stretch | MOVE-DOWN→ui test | L C | – |
| picture_size | compare/error | Bucket: exception before the first compare `R.t` (compare did not open) | — (bucket; Compare-With open is covered by `compare` scenario) | T(30 s) C | 4/4 TO4 ("waiting for compare opened") |
| picture_size_small | small/fit-fills | 640×360 in Fit fills width/height of larger areas | DUPLICATE→picture_test.js L23-27 | P C | 1/16 |
| picture_size_small | small/actual-and-zoom | 100% pixel-for-pixel; + zooms enlarged Fit; Z back | DUPLICATE→picture_test.js L38-43, L117 | P C | 2/16 |

Counts (12 + bucket): KEEP-L3 0 · MOVE-DOWN 3 · DUPLICATE 9 · bucket 1.


### picture-size-native


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| picture_size_native | native-frames/hevc_10_2160p.mp4 | Native frames grow for Fill/100%, shrink waits for next seek | MOVE-DOWN→host-half sim (same size restart); one grow check in thin #5 | S2(1500 ms) L(`native decode from … WxH`, `at the next seek`) T(8 s) | 2/12 |

Counts: DUPLICATE 1.


### compare


Scenario-level: `compare` 3/3 TO3 (whole scenario hit the 255 s budget inside compare_metrics).

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| modes | layout/bar | Player bar buttons visible, CC hidden without tracks, 5 tools | MOVE-DOWN→ui test (bar_panels_characterization_test.js covers most) | C | 1/24 |
| modes | layout/tool-keys | W cycles scopes to off, I toggles the info panel | MOVE-DOWN→ui test (player_ui_test.js §1 keyCommand) | C | |
| modes | layout/controls | Step ±1, seek 0.5 s, play advances, pause, on a real player | KEEP-L3 (webview boot + real decoder step/seek/play smoke) | C | |
| modes | layout/tools-grid | Cog grid runs Scopes and Details; basic controls stay | DUPLICATE→bar_panels_characterization_test.js:'Settings opens each subpage and its Back button returns to Settings' | C | 1/24 |
| modes | compare/views | Compare draws; views list; mode switch sets divider/cells; removed keys inert | MOVE-DOWN→ui test (player_state_test.js §4/§6d); first draw belongs in thin compare smoke | S(600 neg. window), C | 1/24 |
| compare_ui | start/no-plain-d | Plain D opens no quick pick and no compare | DUPLICATE→player_ui_test.js §1 keyCommand | S(1500 neg.), L | 2/20* |
| compare_ui | start/drop | Synthetic drop shows hint, opens 2-tile compare, synced | DUPLICATE→player_unified_test.js:'drop hint: a dragged file shows the page's "Drop to compare" frame…' + compare_gestures_test.js | S(800), L | 4/23 TO2 |
| compare_ui | enter/in-place | Compare With grows player tab in place, starts at player's 1.0 s | KEEP-L3 (VS Code tab grows in place, one tab); moment part DUPLICATE→player_unified_test.js:'entering Compare in place keeps the player's moment' | L | 2/21 |
| compare_ui | bar | Compare bar ids, no CC, clock letter, mute title, Shift+>, '.' steps both | MOVE-DOWN→ui test (bar_panels_characterization_test.js:'Compare panel controls reflect in the bar…'); step-both→sync.js | C, P(ids depend on stage width >840) | 4/21 |
| compare_ui | panel/shortcuts | Cog row and ? open shortcuts sheet; Escape/? close, focus returns | DUPLICATE→player_ui_test.js §7 ('? opens the shortcuts sheet') | S(250×2 click), C | |
| compare_ui | speed/drag-outside | Speed slider drag off left/top edges, cancel keeps rate | DUPLICATE→range_drag_test.js (pointercancel/lostpointercapture) | C | |
| compare_ui | panel/compare | Compare panel rows, cog rows, Inspection page, A–B page, back | DUPLICATE→compare_panels_ui_test.js:'The Compare page…' + bar_panels_characterization_test.js | S(250×7), C | 3/21 |
| compare_ui | panel/video-page | B +1 frame shows A+1; frames↔ms lossless; 10 ms nudge; reset; clock/sound | MOVE-DOWN→sync.js (pairing); UI part DUPLICATE→player_state_test.js §6g + bar_panels…:'per-video Compare panel nudges offsets…' | S(250×6), C | 3/21 |
| compare_ui | tiles/pills-and-nudge | Pills, Enlarge, Sync-mode nudge, stats cards, × focus, −/+ under pointer | DUPLICATE→player_ui_tiles_test.js:'card markup, escaping and close refocus','hover…' + player_state_test.js §6h | S(250×5), C | 3/21 |
| compare_ui | view/spotlight-and-split | Spotlight dock/splitter, Split divider drag, X swap, grid | DUPLICATE→player_state_test.js §3/§6c/§6d + compare_grid_test.js 'Spotlight layout' | S(250×3), C | 3/16 |
| compare_ui | tiles/menu | Right-click menu items, pick clock, checkmark, Offset of B opens page | DUPLICATE→player_ui_tiles_test.js:'menu items, hints and checkmarks' | S(200×3,500), C | 1/21 |
| compare_ui | grid/three | Host adds 3rd → 2x2 with Add cell; two-click remove back to 2 | MOVE-DOWN→ui test (DUPLICATE→compare_grid_test.js 'remove button' + player_state_test.js §2); one add/remove stays in thin smoke | S(200,250×2), L, C | |
| compare_ui | leave | Leave compare → same tab shrinks to player at kept moment 1.5 s | KEEP-L3 (VS Code tab/viewType swap in place) | S(200,800), C | |
| compare_link | open/split-frame | /compare deep link opens split, both tiles paused on #31 | KEEP-L3 (VS Code URI handler); landing MOVE-DOWN→seek-planner.js (parse DUPLICATE→framelink_unit_test.js parseCompareLink) | L | 6/16 TO1 |
| compare_link | reuse/grid-frame | Second link reuses panel, grid, frame 60, one tab | DUPLICATE→frame_link_test.js ('compare links open one viewer') | C | |
| compare_link | reuse/spotlight-time | t=0.5 link → spotlight, both tiles ≈#16 | DUPLICATE→framelink_unit_test.js (t / mode=spotlight) + timeline.js | C | |
| compare_addmode | toolbar-toggle-stop-and-append | Compare button toggles Add Mode; Explorer open joins; title action appends | DUPLICATE→compare_gestures_test.js 'Capture: commands reach the page…' + player_unified_test.js:'Capture: the host's changes reach the page…' | L | 1/10* |
| compare_addmode | single-file-start-and-explorer-add | Start Compare on one file; Explorer opens join; context keys flip | KEEP-L3 (real VS Code context keys/menus, custom-editor resolve) | L | 1/20 TO1 |
| compare_addmode | multi-select-mixed-and-folder | Multi-select/folder/subfolders open in natural order, Add Mode off | DUPLICATE→comparepick_test.js 'the folder walk…' + 'Add to Compare: expand folders…' | L | 1/20 TO1 |
| compare_addmode | player-title-start-and-add | Compare With… opens with Add Mode off; title action appends to background | DUPLICATE→comparepick_test.js (L167-168 'joins with Capture off') + compare_gestures_test.js 'Explorer "Add to Compare"…' | L | 2/20 TO1 |
| compare_addmode | player-shift-d-and-playback | Shift+D capture survives play/scrub; Esc command; Add still works | DUPLICATE→compare_gestures_test.js Capture + player_state_test.js §2/§6 | L | 1/20 TO1 |
| compare_addmode | add-video-and-switch-editor | Shift+D toggles; panel switch; switching to text tab ends capture | DUPLICATE→compare_gestures_test.js 'an editor switch ends it' | L | 1/20 TO1 |
| compare_addmode | preview-tab-capture-keeps-editor | Capture pins italic preview tab so next click joins | KEEP-L3 (real VS Code preview-tab semantics, keepEditor) | L | |
| compare_burst | three-at-once | openWith burst of 3 → one compare tab, Add Mode off, next open separate | KEEP-L3 (real VS Code openWith tab timing); rules DUPLICATE→burst_test.js | S(300,800), L | 2/22 TO1 |
| compare_burst | one-video-alone | One video opened alone stays a player | DUPLICATE→burst_test.js (rules: 'one video … untouched') | S(800 neg.), L | |
| compare_burst | two-apart | Two videos opened apart stay two players | DUPLICATE→burst_test.js ('videos a moment apart') | S(800 neg.), L, C | |
| compare_burst | setting-off | openTogether false → two players | DUPLICATE→burst_test.js ('the setting turns it off') | S(800 neg.), L | |
| compare_metrics | same-file | Identical files: PSNR Y/RGB Infinity at 6 frames | MOVE-DOWN→engine L2 (libav decode + media/compare-metrics.js); DUPLICATE→test/unit/compare_metrics_test.js | L | 3/20 TO3 |
| compare_metrics | lowq-vs-ffmpeg | PSNR/SSIM per frame match ffmpeg psnr/ssim filters | MOVE-DOWN→engine L2 (no UI; debug-only feature) | L, P | 1/20 TO1 |
| compare_metrics | offset-3 | Offset −3 re-pairs B#38 with A#41; scan finds #42 | MOVE-DOWN→sync.js (pairing) + test/unit/compare_metrics_test.js (scan) | L, C | 3/21 TO3 |


### multiview


Case-level errors: `multiview/multiview` 1/1 TO1 ("compare reopened with 4"); `multiview/multiview-reorder` 5/5 TO5 (waiting for 5 tiles);
`multiview/multiview-short-loop` 4/4 TO4 (waiting for "begin: A … soft" log).

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| multiview | grid/three-then-add | 3 tiles: grid, Add cell, cells=3; host adds 4th | DUPLICATE→compare_grid_test.js 'the setting and the grid' + player_state_test.js §2 | L | |
| multiview | grid/four-play | 4 real decoders (WebCodecs+WASM) 2x2 equal, non-overlapping, all draw playing | KEEP-L3 (GPU/WebCodecs + WASM concurrently, per-tile canvas layout) | P(layout rects), C | 3/14 |
| multiview | sync/lockstep | Paused seek and step ±1: every tile on expected frame | MOVE-DOWN→sync.js + timeline.js | C | |
| multiview | sync/offsets | Frames/ms/negative offsets: expected frames after steps | MOVE-DOWN→sync.js (rounding; flake was off-by-one #20 vs #19) | C | 2/14 |
| multiview | sync/clock | 24 fps clock C drives steps; seekMax 47 | MOVE-DOWN→sync.js/timeline.js (DUPLICATE part player_state_test.js 'Mixed frame rates…') | C | |
| multiview | sync/sound | One tile audible (gains), switch to B, kept while playing | MOVE-DOWN→sync.js (sound routing) ; DUPLICATE part player_state_test.js §6e | S(800), C | |
| multiview | sync/panel | Compare button opens panel, Esc closes | DUPLICATE→compare_panels_ui_test.js + player_ui_test.js §7 | C | |
| multiview | sync/clock-while-playing | Clock switch while playing keeps new clock's own position | MOVE-DOWN→sync.js (clock switch) | S(300), P, C | 2/14 |
| multiview | sync/remove-clock | Removing clock tile: next clock resumes same picture | MOVE-DOWN→sync.js (DUPLICATE part player_state_test.js §6e) | L, C | 3/14 |
| multiview | pair/views-and-offset | 2 tiles: spotlight/split/grid; B +250 ms step frames | MOVE-DOWN→sync.js (offset) ; views DUPLICATE→player_state_test.js §4 | S(500×3 instead of until) | |
| multiview | pair/short-clock-eof | Shorter clock EOF pauses follower; seek back keeps both paused | MOVE-DOWN (partly covered: player_unified_test.js:'compare: when a shorter clock ends, longer followers pause too…' → transport.js) | C | |
| multiview-reorder | reorder/arrows | Initial order, end arrows disabled | DUPLICATE→player_ui_tiles_test.js:'move arrows: target and refocus' | C | |
| multiview-reorder | reorder/arrow-result | Move-earlier arrow reorders; focus follows the video | DUPLICATE→player_ui_tiles_test.js:'move arrows: target and refocus' | C | |
| multiview-reorder | reorder/drag-preview | Pointer drag previews new order | DUPLICATE→player_ui_tiles_test.js:'drag reorders in the grid and commits on drop' | C | |
| multiview-reorder | reorder/commit | Drop commits; clock/offset/sound follow their videos | DUPLICATE→player_state_test.js §6b moveTile + compare_grid_test.js 'Reorder drag' | C | 1/7 |
| multiview-reorder | reorder/esc-cancels-drag | Esc during drag keeps committed order | DUPLICATE→player_ui_tiles_test.js:'Escape, pointercancel, lostpointercapture and cancel() revert' | C | |
| multiview-reorder | reorder/restore | Added video last; remove keeps order, clock, sound, offset | DUPLICATE→player_state_test.js §6e + compare_grid_test.js 'display order' | L, C | 1/7 |
| multiview-reorder | reorder/arrows-on-picture | 5 tiles 3x2 letterboxed: arrows inside picture's bottom-left | KEEP-L3 (real CSS layout geometry; fake-dom has none) | P, C | 1/7 |
| multiview-short-loop | follower | Loop: 3 shared wraps via clock's end; follower in sync | MOVE-DOWN→transport.js (shared wrap) + sync.js; DUPLICATE part player_unified_test.js:'compare: Loop keeps every decoder's own loop off…' | L(end-of-file count), P(sampling) | 1/11 |


### multiview-transcode


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| multiview-transcode | tile-streams-and-original | Each tile starts at half cap; About shows Live transcode; Use original | KEEP-L3 (real ffmpeg transcode → WebCodecs ×2); cap split DUPLICATE→compare_test.js, original DUPLICATE→player_unified_test.js:'originalTile…' | L | 4/11 |


### multiview-transcode-packets


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| multiview-transcode-packets | seek-back-from-packets | Seek back/steps back served from page packets in both tiles, no host seek | MOVE-DOWN→seek-planner.js (cache-hit plan) + engine L2 (test/unit/packet_cache_test.js) | S(1500,800), L | |


### multiview-native


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| multiview-native | native/tile-size | 4 native decisions logged; frame heights fit stage quarter | KEEP-L3 (native ffmpeg ×4); height math DUPLICATE→compare_grid_test.js 'native frame sizes' | L(decision regex, waitLog .catch swallowed) | 7/13 |
| multiview-native | native/frame-server | Transport stream ×4, "native frames over http" per tile | KEEP-L3 (webview fetch to localhost frame server, CSP); server DUPLICATE→frameserver_test.js | L | 3/13 |
| multiview-native | native/play | 4 native tiles draw ≥3 frames while playing | KEEP-L3 (native transport into real canvases) | C | |
| multiview-native | native/lockstep | Native tiles step +1 with frame/ms offsets on expected frames | MOVE-DOWN→sync.js | C | |
| multiview-native | native/resize-and-budget | Stage resize sizes frames; 2× rate budget 390-400 MB/s; no reopen | MOVE-DOWN→host test (DUPLICATE part compare_grid_test.js 'native: credits and host queue') | P(MB/s window), L, C | 4/13 |
| multiview-native | native/seek-through-resize | Resize during seek does not revert tiles to old position | MOVE-DOWN→seek-planner.js (deferred seek vs restart) | C | |
| multiview-native-fallback | native/frame-server-403 | Bad token → message transport ×4, synced, plays | DUPLICATE→frameserver_test.js (403 + NativeDecoder fallback to postMessage) | L | 4/13 |


### multiview-large


Case-level: 3/3 TO3 ("compare reopened with 16").

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| multiview-large | large/nine-open | 9 tiles 3x3, 5 WebGL contexts, tile pixels ≤ 4K/9 | KEEP-L3 (Chromium 16-context limit, shared WebGL renderer); DUPLICATE part tile_renderers_test.js | | |
| multiview-large | large/lockstep-offsets | 9 tiles seek/step ±1 with offsets on expected frames | MOVE-DOWN→sync.js | C | |
| multiview-large | large/clock | Clock G; seekMax 575; step frames | MOVE-DOWN→sync.js/timeline.js | C | |
| multiview-large | large/play | All 9 draw ≥5 frames; clock plays; followers within 0.2 s | KEEP-L3 (9 real decoders + shared renderer); tolerance logic→sync.js | P, C | |
| multiview-large | large/remove-add | Remove → 8 + Add slot; clock/offsets follow; add to 16 (4x4) | MOVE-DOWN→ui test (DUPLICATE→compare_grid_test.js + player_state_test.js §6e) | L, C | |
| multiview-large | large/compact-overlays | 400x240 stage: pills and sync nudges fit inside cells | KEEP-L3 (real CSS layout) | P, C | 1/4 |
| multiview-large | large/close | Close: session closed, no error lines | DUPLICATE→player_unified_test.js:'pagehide disposes the decoders…' | L | |


### multiview-large-native


Case-level: 1/1 TO1 ("compare closed").

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| multiview-large-native | large-native/{9,16} | Native cell-height frames, n WebSockets one port, offsets, play, seek-through-resize | KEEP-L3 (native ffmpeg ×16, WebSockets into webview); offsets→sync.js, height DUPLICATE→compare_grid_test.js 'native frame sizes for 9 and 16' | S(1500,5000), L(ws port regex), P(fps) | 3/8 each |


### native


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| native-transfer | hevc_10_2160p.mp4 | 4K HEVC10 native plays over http/ws; decoded size = picture step | KEEP-L3 (native ffmpeg → frame server → real webview); size DUPLICATE→size_frames_test.js | L | 1/13 |
| native-transfer-resize | hevc_10_2160p.mp4 | Grow on resize/zoom at once; shrink/Z waits for next seek | MOVE-DOWN→host-half sim (native size restart, src/native.js); grow-on-resize wiring stays in thin #5 | S(4500,1500,150×3,1000), L, T(5 s for "next seek" log) | 2/13 |
| native-transfer-fallback | hevc_10_2160p.mp4 | Transport refused → postMessage at ≤1080 rows, plays | DUPLICATE→frameserver_test.js (NativeDecoder fallback to postMessage) | L | 1/13 |


Cases `open-native` and `ui_info_native` (same scenario):

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| open-native | native/{hevc_10_2160p.mp4, av1_10_2160p.mp4, ...} | Decision "native ffmpeg", plays 2 s, paused seeks land (suite.js playClip) | KEEP-L3 (native ffmpeg transport into webview) — one clip suffices; decision DUPLICATE→decide_test.js | L (decision from log), T (15 s first frame) | 2/13 each ("decision: none logged") |
| ui_info_native | native | ⓘ facts for HEVC 10-bit through ffmpeg | DUPLICATE→controls_test.js (native facts) | S1 | |

### invisible


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| perf-invisible | hidden-native | Hidden tab stops ffmpeg (process count); shown: same frame, plays | KEEP-L3 (VS Code tab visibility + real ffmpeg process); stop logic DUP host/native_hidden_test.js | S2 (1500 x2), L (waitLog "tab hidden, ffmpeg stopped", "native decode from"), T (8/10 s) | 3/14 |
| perf-invisible | paused-readahead/native, paused-readahead/webcodecs | Paused read-ahead <=2.2/4.5 s; 3 steps past it land | DUPLICATE→test/engine/unit.js "invisible: paused read-ahead is ~1 s…" | S2 (1000, 4500), L (parses status log line), T (5 s/step) | |
| perf-invisible | loop-rest | Paused frame loop rests; step/time label follow; resumes | MOVE-DOWN→clock (rest/wake scheduling; partial DUP engine/unit.js "settled() lets the page rest") | S4 (2000, 2500, 4000, 2500), T (4 s step), P (rAF counts) | 6/15 TO6 ("4 s waiting for a step while resting") |


### restore


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| perf-invisible | audio-rest | AudioContext rests on pause, resumes as clock, drift <=0.5 s (or just pause/play) | DUPLICATE→test/engine/unit.js "invisible: the AudioContext rests when paused…" (hidden desktop: AC never runs) | S3 (3500 or 1000+1500), P (drift) | |
| startup-restore | background-probe | Window reload restores both tabs; background tab not decoding until shown | KEEP-L3 (VS Code reload / webview restore) | L (all checks on log regexes) | restore/startup-restore 1/1 TO1 (scenario level) |


### seek-preview


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| seek_preview | wasm | Idle no decode; hover+neighbours; leave stops; drag thumb follows, picture holds; release exact | MOVE-DOWN→preview-scheduler (partial DUP host/seek_preview_test.js) + seek-planner (release) | S6 (4000, 300, 2500, 250x6, 200, 2500), L (no thumbs log lines), P | 2/23 TO1 (main picture moved while dragging) |
| seek_preview | wasm/pass | Background pass fills bar without hover, worker closes, hover needs no request | DUPLICATE→test/host/seek_preview_pass_test.js | S1 (600), T (3 s worker close / hover) | |
| seek_preview | wasm/pass-hidden | Hidden tab: pass waits (paused:hidden); fills once shown | MOVE-DOWN (partly covered: test/host/seek_preview_pass_test.js ("pauses while … hidden"); visibility wiring → 1 thin L3 check) | S3 (3000 x2, 700), L | |
| seek_preview | wasm/between | 10 s GOP: fill gives floor then full bar; hover shows own frame | DUPLICATE→test/host/seek_preview_pass_test.js (fill after keyframe pass) | | |
| seek_preview | wasm/capture | Played frames become previews; hover shows played frame within X | DUPLICATE→test/host/seek_preview_test.js (offer: frames the player showed) | | |
| seek_preview | wasm/refine | Rest on bar: exact refined frame within X, differs from keyframe | DUPLICATE→test/host/seek_preview_test.js (exact picture after rest) | | |
| seek_preview | webcodecs/between | Fill decodes on the worker's hardware VideoDecoder (gpu=webcodecs) | KEEP-L3 (real WebCodecs in worker); logic DUP host/seek_preview_hw_test.js | | |
| seek_preview_native | native | As wasm, via native thumbhost ffmpeg | MOVE-DOWN→preview-scheduler (thumbhost real-ffmpeg part in host/seek_preview_test.js) | S6, L, P | 5/23 TO4 (neighbours filled while hovering, 15 s) |
| seek_preview_native | native/pass | Native keyframe-run pass fills bar | DUPLICATE→test/host/seek_preview_pass_test.js (native keyframe runs) | S1, T | |
| seek_preview_native | native/pass-hidden | Hidden native tab: no thumb ffmpeg until shown | DUPLICATE→test/host/seek_preview_pass_test.js | S3, L | |
| seek_preview_native | native/between | Native fill floor then full | DUPLICATE→test/host/seek_preview_pass_test.js | | |
| seek_preview_native | native/capture | Played frames become previews (native) | DUPLICATE→test/host/seek_preview_test.js | | |
| seek_preview_native | native/refine | Exact refine via thumbhost exact mode | DUPLICATE→test/host/seek_preview_test.js (thumbhost exact mode, 10 s GOP) | | |


### wheel-step


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| wheel_step / wheel_step_native | {wasm,native}/hevc10_4k, {wasm,native}/hevc10_4k_pq_hdr | Slow and rapid wheel notches on 4K coalesce, land on exact frame | MOVE-DOWN→seek-planner (held/deferred seeks, notch sum; partial test/unit/stepgoal_test.js); 1 native wiring optional | S (notch gaps 30 ms, deliberate), L (landed/seek lines recorded), P | 1/10 each ("rapid 10 back from 64: expected 54; player says 60/63/56") |


### hdr


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| hdr_output | probe | Webview answers HDR caps (displayHdr boolean) | KEEP-L3 (real display / WebGPU caps) | | |
| hdr_output | sdr | SDR display: tone-mapped label, tf 1, HDR output off, one log line | KEEP-L3 (display probe decision) | L (log line count ===1) | |
| hdr_output | dv/dv81, dv/dv84, dv/dv5 | DV 8.1→PQ, 8.4→HLG labels, white patch; profile 5 message | MOVE-DOWN→engine L2 (DV config decision); one white-patch check redundant with hdr/* | P | |
| hdr_output_forced | pattern/pq, pattern/hlg | Forced HDR: WebGPU extended canvas values match hdr.js maths; stats | KEEP-L3 (WebGPU HDR canvas) | S1 (500), T (8 s stats), L (error lines), P | 4/12 TO4 each (all "waiting for the stats overlay" 8 s) |
| hdr_output_forced | pattern/dv81 | Same pixels on DV 8.1 copy of PQ pattern | DUPLICATE→hdr_output_forced/pattern/pq (+ hdr_output/dv/dv81 decision) | S1, T, L, P | 4/12 TO4 |
| hdr_output_forced | play/hevc_10_pq_2160p, play/hevc_10_hlg_2160p | 3 s play: HDR canvas presents >=2 new frames, finite values | KEEP-L3 (WebGPU present loop) | S2 (3000, 300), L, P | |
| hdr_output_forced_native | pattern/pq, pattern/hlg | As forced, native ffmpeg sends 10-bit frames | KEEP-L3 (native ffmpeg 10-bit transport + WebGPU) | S1, T, L (native 10-bit log), P | 4/12 TO4 each |
| hdr_output_forced_native | pattern/dv81 | Same on DV copy | DUPLICATE→hdr_output_forced_native/pattern/pq | S1, T, L, P | 4/12 TO4 |
| hdr_output_forced_native | play/hevc_10_pq_2160p, play/hevc_10_hlg_2160p | Native 4K HDR plays, frames presented | KEEP-L3 (native + WebGPU) | S2, L, P | |


### onboarding


Raw result arrays (no recorder: `--sub` ignored). Popup counts read the whole instance log from line 0 (C across cases).

| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| onboarding-ffmpeg | decision/h264_8_1080p.mp4 | With ffmpeg, 8-bit H.264 stays on WebCodecs (decision + streams lines) | DUPLICATE→decide_test.js L42-52 | L T(8 s) | 1/10 ("decision: none logged") |
| onboarding-ffmpeg | decision/hevc_8_1080p.mp4 | With ffmpeg, HEVC goes native | DUPLICATE→decide_test.js L52 | L T(8 s) | 1/10 |
| onboarding-ffmpeg | no-popup-with-ffmpeg | No first-open popup when ffmpeg present | DUPLICATE→onboarding_test.js (never when ffmpeg found) | L(whole log) C | – |
| onboarding | popup-once | Without ffmpeg the first video asks once | KEEP-L3 (thin: real notification + real globalState once); logic DUPLICATE→onboarding_test.js | L S1(1500 ms) C | – |
| onboarding | reminder-4k-hevc10 | Dismissed popup then slow 4K WASM shows ffmpeg hint wording | DUPLICATE→decide_test.js L151+ (hint wording/throttle); trigger is machine speed | L P(machine speed) C(needs popup-once dismissed) | – |

Counts (5): KEEP-L3 1 · DUPLICATE 4.


### url


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| url_stream | mp4_direct | URL MP4: first frame, decoder, seeks 150/40 pictures vs ffmpeg, plays | KEEP-L3 (range reads through host proxy into webview decoder) | L(decoder log), P(expectFrame) | 1/14 |
| url_stream | panels | URL tab: ⚙ rows, no Compare, A–B no clip, ⓘ host·stream | MOVE-DOWN→ui test | | 3/14 |
| url_stream | hls_ts | HLS MPEG-TS plays/seeks via libav | DUPLICATE→url_stream_test.js ('HLS as one file (MPEG-TS…)') | L, P | 1/14 |
| url_stream | hls_master | Master playlist picks 640x360 variant; plays/seeks | DUPLICATE→url_stream_test.js (master playlist) | L, C(lib.lines without mark) | 1/14 |
| url_stream | hls_fmp4 | HLS fMP4 plays/seeks | DUPLICATE→url_stream_test.js (fMP4) | L, P | 1/14 |
| url_stream | hls_aes | AES-128 decrypted in host; plays/seeks | DUPLICATE→url_stream_test.js check('HLS AES-128') | L, C(lib.lines without mark) | 1/14 |
| url_stream | hls_quality | Quality page; 180p reload at same frame paused; Auto again playing | MOVE-DOWN→player.js/seek-planner.js (reload restores moment+play); page DUPLICATE→unified_viewer_test.js 'HLS quality' | L | 5/14 TO5 |
| url_stream | hls_subs | WebVTT renditions in CC menu, cue timing, no late cue, Deutsch | MOVE-DOWN→ui test (+ test/subtitles) | S(300 neg.) | 4/14 TO3 |
| url_stream | hls_drm | FairPlay refused with CDM hint, no ffmpeg offer | DUPLICATE→url_stream_test.js (fairplay.m3u8 protected) | | |
| url_stream | url_to_side | Open Video URL to the Side opens beside | MOVE-DOWN→host test (mock_vscode ViewColumn) | L | |
| url_stream | dash_needs_ffmpeg | DASH: "needs native ffmpeg" + Set up ffmpeg action | DUPLICATE→url_stream_test.js (DASH without ffmpeg says so) | | |
| url_stream | hls_live_needs_ffmpeg | Live HLS: needs ffmpeg + setup action | DUPLICATE→url_stream_test.js (live needs ffmpeg) | | |
| url_stream | not_found | 404 → "not found (HTTP 404)" | DUPLICATE→url_stream_test.js check('404') | | |
| url_stream | web_page | HTML page → "web page" message | DUPLICATE→url_stream_test.js check('web page') | | |


### url-native


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| url_stream_native | hls_native | HLS master via native ffmpeg: first frame, seeks, pictures | KEEP-L3 (native ffmpeg with network whitelist → webview) | L, P | |
| url_stream_native | hls_aes_native | AES HLS via native ffmpeg plays/seeks | DUPLICATE→url_stream_test.js (ffmpeg input args) | L, P | |
| url_stream_native | hls_quality_native | Quality switch with native decoder keeps moment | MOVE-DOWN→player.js/seek-planner.js | L | 3/11 TO3 |
| url_stream_native | hls_subs_native | WebVTT renditions with native decoder | MOVE-DOWN→ui test | S(300 neg.) | 2/11 TO2 |
| url_stream_native | dash_native | DASH via native ffmpeg plays/seeks | DUPLICATE→url_stream_test.js ('HLS with ffmpeg goes native', DASH args) | L, P | |
| url_stream_native | hevc_mp4_native | HEVC MP4 URL → native, seek frame 30 picture | MOVE-DOWN→host test (decide_test.js) | L, P | |
| url_stream_native | hls_live_native | Live: seek disabled, LIVE time, time click doesn't cycle | MOVE-DOWN→ui test (DUPLICATE part player_ui_test.js L86 timeReadout live) | S(300 neg.), L | 2/11 |
| url_stream_native | mp4_h264_stays_builtin | H.264 URL stays on built-in/GPU with ffmpeg present | DUPLICATE→decide_test.js | L, P | |
| url_stream_native_mp4 | mp4_native | decoder=ffmpeg: plain MP4 URL plays natively, seeks | MOVE-DOWN→host test | L, P | |


### remote-stream


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| remote_stream | <clip> (hevc_10_2160p.mp4, hevc_10_1080p.mp4, vp9_opus_anim_1080p.webm) | Decision "remote stream"; plays via WebCodecs; paused seeks (playClip) | KEEP-L3 (ffmpeg H.264 transcode → WebCodecs in real webview) — one clip suffices | L(decision regex) | 2/24 each |
| remote_stream | encoder | Encoder probe line logged | DUPLICATE→remotestream_test.js (GPU encoder probe, fake ffmpeg) | L, C(whole log, no mark) | |
| remote_stream | seeks | 20 seeks 40 ms apart: 0 ffmpeg starts, land; 3 steps back from memory | MOVE-DOWN→seek-planner.js (coalesce, from-memory) | S(500,40×20), L(count "remote stream from") | 1/24 |
| remote_stream_long | decision | 200 s clip decision is remote stream (soak is L4) | DUPLICATE→remotestream_test.js ('when a window streams') | L | 2/24 |
| remote_stream_long | seeks | 20 seeks ≤8 ffmpeg starts; steps back ≤1 restart | MOVE-DOWN→seek-planner.js | S(6000 read-ahead wait, 40×20), L, T(start-count tied to hook bunching ~300 ms) | 1/24 |
| remote_stream_size | size-to-picture | Shrink deferred to next seek; enlarge immediate; playhead kept | KEEP-L3 (thin #9 until the host-half sim covers size restarts; flake rate predates the latest fixes) | L | 7/24 TO7 |
| remote_stream_fallback | pixel-tools | Inspector/scopes get exact 3840x2160 frame; no full-res offer; PNG exact | KEEP-L3 (exact grab under Live transcode, thin #9) | S(200 poll), L | 6/24 TO6 |
| remote_stream_fallback | ffmpeg-exit | Killed ffmpeg → built-in decoder, playing, no retry | KEEP-L3 (real ffmpeg exit → built-in decoder restart, thin #9) | L | 1/24 TO1 |
| remote_stream_fallback | slow-link | Throttle → 720p without timeline break; steady; recover 1080p; 360p floor | DUPLICATE→remote_ladder_test.js + stream_adapt_test.js + link_sim_test.js 'ladder over the simulated link' | S(4500,5000), P, L | 5/24 TO5 |
| remote_stream_fallback | slow-link-sound | Opus: 480p with sound; 360p floor at 0.7 Mb/s; WASM Opus decodes | MOVE-DOWN→host-half sim (ladder with Opus) + engine L2 (WASM Opus decode) | S(5000), P, L, C(whole-log Opus line) | 3/24 TO2 |


### remote-stream-packets


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| remote_stream_packets | paused-sharp | Sharp paused frame is exact source frame; rapid steps ask ≤2 | MOVE-DOWN→host-half sim (S2b: src/stream.js + fake ffmpeg + src/link-sim.js) + seek-planner; host unit tests cover parts only | S(1500×3,40×6), L, P(MAD vs source) | |
| remote_stream_packets | paused-quick | Half-size quick picture before stream frame; seek lands exact | MOVE-DOWN→host-half sim (S2b: src/stream.js + fake ffmpeg + src/link-sim.js) + seek-planner; host unit tests cover parts only | S(1500,1200×6), L, P | |
| remote_stream_packets | play-cached-sound | Play after cached seek uses held picture+sound; host skips held | MOVE-DOWN→transport.js/seek-planner.js (takeHeld); host DUPLICATE→stream_fill_test.js (skipHeld) | S(1500,500,600,1000,400), L, T(sound ready <300 ms) | |
| remote_stream_packets | slow-link-seek-back | Fill behind; steps/seek back local; across key; play held GOP; spinner | MOVE-DOWN→seek-planner.js (+ engine L2 packet_cache_test.js; spinner DUPLICATE→player_unified_test.js:'loading spinner…') | S(4000,500,40×30,300), L, T(spinner ≤5 s, gone ≤3 s) | |
| remote_stream_packets | warm-decoder | Jumps land on exact drawn frame; warm decoder used after on | MOVE-DOWN→host-half sim (S2b: src/stream.js + fake ffmpeg + src/link-sim.js) + seek-planner; host unit tests cover parts only | S(1500×13), L, P(drawn bits) | |


### remote-stream-play-during-seek


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| remote_stream_play_during_seek | bar-keeps-target | Play during pending seek: bar never goes back before target | MOVE-DOWN→seek-planner.js + transport.js (held seek then play); DUPLICATE part player_unified_test.js:'a seek held back while the opening seek lands…' | S(60 poll,500), P(sampling) | |


### remote-slow-link


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| remote_slow_link | open | 4K HDR over 1 Mb/s sim link: first picture, Live transcode, tone-mapper fails once | KEEP-L3 (Remote-SSH link sim + transcode + webview); tone-map DUPLICATE→tonemap_fallback_test.js | S(4000), L | |
| remote_slow_link | seek-inputs | 16 inputs: bar/time move before next event and picture; land on bar frame | MOVE-DOWN→seek-planner.js + player.js (UI-owned bar); DUPLICATE part slow_link_ux_test.js (virtual clock) | S(1500×17,3000), T(bar ms < next event ms), P | |


### remote-stream-hdr


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| remote_stream_hdr | hdr-seek-step | PQ 4K over Live transcode: tone-mapped on host; seek/step land exact | KEEP-L3 (real HEVC PQ → host tone-map → WebCodecs; NVDEC) | L | |


### file-icons


| Case | Result | What it checks (<=15 words) | Class | Anti-patterns | Flaky |
|---|---|---|---|---|---|
| file_icons | mkv-opens-in-player | .mkv with vpe-video language still opens in the custom editor | KEEP-L3 (VS Code editor resolver vs files.associations) | L(`first frame shown`) | – |
| file_icons | associations-written | settings.json gets *.mkv/flv/m2ts→vpe-video; ts/mts/avi/mov untouched | DUPLICATE→file_icons_test.js | S1(500 ms poll ×20) | – |
| file_icons_pixels_{dark-100,light-100,dark-120,dark-m1,dark-z2} (5) | icons-equal-seti-mp4 | Explorer icon of .mkv/.flv/.m2ts matches Seti .mp4 glyph (size, pos, ink) | KEEP-L3 (real workbench render; candidate for release-only visual suite) | S4 (+ up to 15×3000 ms refresh loop) P | – |

Counts (7): KEEP-L3 6 · DUPLICATE 1.


### Not layer-3 (layer-4 benches in the case files)


| Case file | Cases | Note |
|---|---|---|
| seek_pass_perf.js | seek-pass-{play,fill}-{native,wasm,webcodecs}, seek-pass-fill-native-cpu | Only with VPE_SEEK_PASS_BENCH; S4 (3500, 15000, 1500 x2); preview-scheduler pacing could get sim numbers |
| cpu_4k.js | cpu-4k-<variant> | Only with VPE_CPU_BENCH; process CPU |
| startup.js | startup-*, memory, memory-8gb(-again) | L4 (startup-restore is the only L3 case, above) |
| perf_invisible.js | perf-invisible-bench | Only with VPE_PERF_BENCH |



### 1.4 What the inventory says

- **Delete only what is cleanly covered now.** S0 retires the 53 clean duplicates whose covering test is a fake-DOM or
  host-mock UI test (`player_state_test.js`, `player_ui*_test.js`, `bar_panels_characterization_test.js`,
  `compare_panels_ui_test.js`, `compare_grid_test.js`, `compare_gestures_test.js`, `ctxmenu_test.js`, `picture_test.js`,
  `controls_test.js`, `folder_rail_test.js`, `tiles_rail_characterization_test.js`, `range_drag_test.js`,
  `framelink_unit_test.js`, `comparepick_test.js`, `burst_test.js`, `player_unified_test.js`): compare_ui, multiview-reorder,
  picture-size, ui a11y/speed/drag, folder-rail listing, compare_addmode/burst rules. The other 40 duplicates cite host
  (`url_stream_test.js`, `seek_preview*_test.js`, `remote_ladder_test.js`, `decide_test.js`) or engine tests and are
  retired step by step after a second look (engine rows only after S1).
- **WebCodecs stays in layer 3 as a sweep.** Layer 2 runs WebAssembly only, so `open-formats play/containers/*`
  (Annex-B: AVI, M2TS/MTS/TS; avcC: MP4, MKV, MOV, FLV), `playback open/fmt/{vp8_vorbis, h264_ac3.mts, h264_ac3_51,
  h264_noaudio, h264_vfr}`, `seeking edges/s_h264` and `end-key/audio_longer` are KEEP-L3 in thin scenario 1. The 4K
  paused seeks of `open-formats` are the only ones anywhere (`test/engine/formats_4k.js` checks the first picture only).
- **MOVE-DOWN by target** (104): `sync` ~16 (multiview `sync/*`, `large/lockstep-offsets`, `large/clock`,
  `native/lockstep`, `panel/video-page`, `offset-3`, clip-export Compare); `seek-planner` ~14 (wheel-step, remote `seeks`,
  `bar-keeps-target`, `seek-inputs`, `seek-through-resize`, `ui_jumps`, frame-player step/seek); `transport` ~11
  (autoplay-loop, A-B wrap and the A-B menu, folder-rail autoplay, short loops, shared Compare wrap, shorter clock end);
  host-half simulator 8 (remote packets quick/sharp/warm, slow-link sound, native size restarts); `clock` 6; `timeline`
  ~6; `preview-scheduler` 3; `player` 4; UI tests ~25; host tests ~7; engine layer 2 ~8.
- **The case already contains the simulator's oracle**: `test/vscode/cases/multiview.js` 42-52 re-implements
  `tileFrameAt` in its `expect()` helper; `test/host/production_adapters_test.js` holds the agreement test of 08eb884.
- **Log text is the second flake source**: `short_loop`'s only assertion is a log line; `playClip` (`suite.js`) derives
  first frame, decoder and streams from the log; clip export parses "compare report" lines; startup-restore is all log
  regex; native decision checks count log lines. Each becomes a probe field (section 5.3), the top ten in S0.
- **Docs are stale**: AGENTS.md and docs/TESTING.md promise `--grep "^scenario/case$"` reruns one case; the runner keeps
  whole scenarios and runs all their steps (`scenarios.js:212`). `--sub` works only for `R.run` results.
  `docs/notes/test-inventory.md` Appendix A still describes the old `ctxmenu` and lacks `folder_rail.js` and
  `picture_size.js`. S0 fixes the runner and these docs together.

## 2. Code map

### 2.0 Intent and realised state: the split with `media/player-state.js`

`media/player-state.js` already holds the user's workspace: per tab `playing`, `frame`, offsets, clock tile, sound tile,
rate, loop mode, A-B, layout (`togglePlay` 866, `stepFrame` 876, `seekFrame` 887, offsets 670-731, `setClock` 622). That
is **intent**: what the user asked for. Today the realised half is scattered (engine fields, unified `sought` / `endedAt`
/ `corrected` / `deferred`, UI `seen`), and the two are reconciled by diffing (`emitTransport` + `quiet` + `fromClock`).

| | Owner | Contents | Written by |
|---|---|---|---|
| Intent | `player-state.js` (unchanged, pure) | playing (= playWhenReady), target frame, offsets, clock tile, sound tile, rate, onEnd mode, A-B marks, hidden | UI commits only |
| Realised | `media/playback/` (`Player.state()`) | phase, shown frame per tile, landed gen, pending target, end reason, stopped / error, out-of-range per tile, loading tiles, lagging tile | the core only, from decoder events and the Clock |

Rules: the core **reads intent, never stores a second copy** of it (it gets the tab's intent on every commit and
compares with what it last acted on, keyed by a commit counter instead of value diffs); the UI **renders realised
state, never infers it** from intent. A realised event that should change intent (natural end with onEnd = stop pauses
the tab; Autoplay next opens a file; A-B wrap) goes back as an explicit `intent` action the UI commits
(`S.pauseAtEnd`, `S.seekFrame`), not as a silent write. The bar shows realised frame while playing and the intent target
while a seek is pending (what 0fe4393 and cc26548 fixed by hand).

### 2.1 Core modules and their contracts

All in `media/playback/`, UMD like `media/stepgoal.js` (`root.VpePlayback…` in the page, `module.exports` in Node), no
DOM, no globals, no timers except through the injected `Clock`. dependency-cruiser rule: `media/playback/**` may import
only `media/playback/**`, `media/autoplay.js`, `media/abloop.js`, `media/player-state.js` (read-only helpers).

```ts
// clock.js
interface Clock {
  now(): number;                                    // monotonic ms (page: performance.now)
  setTimer(fn: () => void, ms: number): unknown;    // page: setTimeout
  clearTimer(id: unknown): void;
  requestFrame(fn: (now: number) => void): unknown; // page: requestAnimationFrame; sim: every 16.667 ms
  cancelFrame(id: unknown): void;
}
interface TimeSource { mediaTime(): number | null; running(): boolean }   // the audio adapter implements it
interface MediaClock {                              // engine now/anchor/audioMaster/updateAudioLive, 1544-1649
  anchor(mediaT: number, why: 'seek'|'play'|'wake'|'rate'|'source'): void;
  mediaNow(): number; setRate(r: number): void; hold(t: number): void; master(): 'audio' | 'timer';
  onAnchor(cb: (e: {mediaT: number, at: number, rate: number}) => void): void;  // audio reschedules WebAudio here
}

// timeline.js — pure; the two nudges of 08eb884 are explicit parameters, not folded into one rounding
interface Timing { startT: number; duration: number | null /* null: live */; fps: number; frames: number | null;
                   frameTimes?: number[]; keyframes?: number[] }
interface Presentation { lead: number /* fraction of a frame shown early: engine tick 1800-1814, 0.25 */;
                         followerNudge: number /* stepgoal followerTime, 0.25 */ }
frameAt(t, timing): number;                         // decoder frame numbering (engine frameAt 2037, ms slack)
timeOfFrame(i, timing): number;                     // seek aim (engine frameSeekTime 2585: (i + 0.5) / fps)
shownFrameAt(mediaT, timing, pres, {follower}): number;  // what playback actually shows: floor(v + lead [+ nudge])
landing(target, pictures, timing, {playing}): Picture | null;    // engine addFrame 1045-1095
dueIndex(queue, mediaNow, pres, {exactStep}): number;            // engine tick 1800-1814
measureRate(pts[]): {fps, frames};                               // engine trackTs/measureRate/setFrameRate 1003-1022
clockToTile(clockFrame, clockTiming, tileTiming, offset, pres): {frame, outOfRange}  // adapter tileFrameAt 138-190

// seek-planner.js — per decoder: one pending slot, latest wins
interface SeekPlanner {
  seek(target: {frame} | {t}, o: {exact: boolean, reason: 'user'|'step'|'wheel'|'goto'|'resume'|'restore'|'sync'}): void;
  step(delta: number): void;                    // notches add up while one seek is in flight (mpv-style)
  onPicture(p: PictureInfo): 'show' | 'wait' | 'drop';   // landing decision, stale gen dropped
  onSeeked(e), onError(e): void;
  state(): {target: number | null, inFlight: boolean, held: number | null, landedGen: number};
}
// Owns: unified sought/deferred/DEFER_MAX_MS (1120-1148); engine seekTarget/seekBefore/holdRun/pendingSeek and the
// landing half of addFrame; STEP_SEEK_MS/REMOTE_STEP_QUIET_MS/BACK_WAIT_MS if still used; stepgoal create();
// pendingGoto, pendingResumeSec. Emits `landed` even when the target is already shown.

// transport.js — realised play state per tab
type Phase = 'idle'|'loading'|'paused'|'seeking'|'scrubbing'|'waking'|'playing'|'ended'|'stopped'|'error';
interface TransportState { phase: Phase; endReason?: 'natural'|'stopped'|'error'; autoPaused: boolean;
                           catchUp: {mode: 'skip'|'every', nonRef: boolean, fast: boolean} }
// Owns: engine playbackPhase 1604, ended/stopped/shortOfEnd/loopAgain/restartLoop/decodeError stop, play-at-end,
// catch-up policy (tick 1816-1858); unified onPlayerEnded/restartAtEnd/effectiveLoop/pendingAutoPlay/endedAt;
// UI decoderFrame A-B wrap (2956-2961), decoderEnded, restartAt, showStopped retry, auto-pause/resume,
// Autoplay-next conditions; frame-player end + loop. Reuses autoplay.js and abloop.js as they are.

// sync.js — Compare (a single video is "one tile, it is the clock")
interface SyncState { lagging: string | null; outOfRange: Record<string, boolean>; followerTime(tileId): number }
// Owns: unified followerClock/followerTimeFn, holdLagging + LOCK_STALL_MS, syncFollowers, reconcile corrections,
// setup/setupKey, corrected; engine setFollowerMode/holdAt/retargetPaused/syncState.settled; adapter
// setSoundSource/applySound; stepgoal followerTime/followerSeekAction. Clock tile, offsets, sound = intent (2.0).

// preview-scheduler.js — thumbs.js scheduling half (slot grid, hover/rest/kick priority, pass pacing, fill plan)

// player.js — facade per tab
interface Player {
  setIntent(tab: TabIntent, commit: number): void;   // from player-state.js on every commit
  addTile(spec, port: DecoderPort): void; removeTile(id): void; restartTile(id, port): void;  // restore intent
  state(): PlayerState;                  // realised: shown frame per tile, phase, endReason, landedGen, target,
                                         // loading[], outOfRange, lagging
  on(event: 'state'|'discontinuity'|'ended'|'landed'|'intent'|'error', cb): () => void;
  tick(now: number): {busy: boolean};    // from Clock.requestFrame; busy=false lets the page rest
}
```

The UI keeps its command vocabulary (`play`, `seek`, `step`, …) as `player-state.js` actions; `Player` does not
duplicate them, it consumes the committed intent.

**DecoderPort** (engine adapter, frame-player, native frames; `FakeDecoderPort` in `test/sim/`):

```ts
type Gen = number;                      // core generation; each adapter maps it (engine: worker gen / seekGen,
                                        // decoder-worker.js 54-56; remote: encode id; native: native request id)
interface PictureInfo {                 // the core sees descriptors only; the adapter owns VideoFrame / YUV buffers
  pts: number; srcPts?: number; gen: Gen; key?: boolean;
  quality: 'quick' | 'sharp' | 'full'; replaces?: number /* pts of a quick picture this sharp one replaces */;
  width: number; height: number; colour: {matrix, transfer, primaries, range}; hdr?: {kind: 'pq'|'hlg'|'dv', profile?};
  handle: number;                       // opaque id; show(handle) / release(handle) on the port
}
interface DecoderPort {
  open(meta, cfg): Promise<void>;
  requestPicture(target: {pts} | {frame}, o: {exact: boolean; purpose: 'seek'|'step'|'scrub'|'preview';
                 gen: Gen; before?: {count: number}}): void;     // decode from the keyframe; core picks the landing
  startRun(fromPts: number, o: {rate: number; gen: Gen; fast?: boolean}): void;
  readAhead(o: {playheadPts: number; playing: boolean; rate: number}): void;  // pacing stays in the adapter
  setSkipMode(o: {nonRef: boolean; fast: boolean}): void;
  setOutputSize(w: number, h: number, o: {when: 'now' | 'next-seek'}): void;  // native / transcode size restarts
  canServe(target: {pts}): {cost: 'cached' | 'packets' | 'decode' | 'restart', ms?: number};  // replaces cache peeking
  show(handle: number): void; release(handle: number): void;
  cancel(gen?: Gen): void; setHidden(h: boolean): void; close(): void;
  exactGrab?(pts: number): Promise<{png} | {error}>;  // side channel (exactframe.js / src/exact_frame.js), not playback
  onInfo(cb: (i: {startT, duration: number | null /* live */, fpsHint?, frameTimes?, keyframes?, width, height,
                  hasAudio, vmode, amode, remote?: {lossy, encId}, native?: {id}}) => void): void;
  onPicture(cb: (p: PictureInfo) => void): void;   // decoded, not yet shown
  onSeeked(cb: (e: {gen, pts?}) => void): void;    // remote CFR exact landing (engine onWorker 'seeked' 277-291)
  onEnd(cb: (e: {gen, terminal: boolean, lastPts: number}) => void): void;  // facts; core decides natural/stopped
  onError(cb: (e: {gen, where, message, fatal: boolean, spot?: number}) => void): void;  // core counts per spot
  onStats(cb: (s: {decodeRate, mediaRate, behind?}) => void): void;
}
```

Stale replies (72d442f, 22dabd1, 2568ff0) are dropped once, by `gen`, in the core.

**Page↔host decoder protocol** (the other contract): the `DECODER_TYPES` messages (`block`, `resize`, `nd`, `ndv`, `nda`,
`thumb`, `exactFrame`, `stream`; `player-unified.js` 45-69) plus the page requests (`read`, seek/fill/sharp/quick asks in
`media/engine.js` and `src/stream.js`), already typed in `media/unified-contracts.d.ts` (`HostToPageMessage`,
`PageToHostMessage`). S2b gives it a contract test run from both sides: the page adapter against a scripted host, and
`src/stream.js` / `src/native.js` against a scripted page.

### 2.2 `media/player-unified.js` (3,017 lines) → homes

**Tick order** (970-1029, one rAF): `visiblePlayers(tab)` (876) ticks only the active tab's tiles, **hidden tiles do not
tick**, in tile order; the clock decoder is not ticked first, so a follower reads the clock's live `now()` (via
`followerClock` 1164) that may be up to one tick ahead or behind its own presentation; then pending intents (resume,
goto, restore, autoplay), `pump` (clock frame → UI), `sendDeferred`, `reconcile`, `ui.render`, and the tool hosts
(`pixelHost`, `bitmapSubs`, `xrayHost`, `scopesHost`, `exactHost`) and `ui.setLoading`. The core keeps this order
explicit: `Player.tick(now)` = (1) sample the MediaClock once, (2) every visible tile computes its due picture from that
one sample (followers via `sync.followerTime`), (3) planner/transport decisions, (4) emit state; the shell then runs
render and the tool hosts. Sampling once removes the tile-order dependency.

| Lines | Function / block | Home |
|---|---|---|
| 45-69, 133, 146-213 | `DECODER_ROUTES`, `DECODER_TYPES`, `isSequence`, `defaultCreatePlayer` (decoder factory, tile renderers) | adapter (factory) + renderer |
| 78-129, 216-261, 2972-3016 | `clipsOf`, `descriptorOf`, `readCfg`, `sessionIds`, `applySessionState`, auto-boot | page shell |
| 266-274 | `transportOf` | goes (intent comes from player-state) |
| 337-366, 1889-1942 | `grabExact`, `exactHost` (150 ms settle) | exact-grab side channel; settle timer via Clock |
| 367-454 | `makeAdapter`, `engine` Proxy, `pageEngine` | page shell |
| 471-502 | `currentRate`/`currentLoop`, `applyRateAndLoop`, `effectiveLoop` | transport (reads intent) |
| 504-567, 635-636 | `ensurePlayer` hooks, `isReady`/`presented` | page shell wiring; `presented` → realised state |
| 569-662 | overlay, toast, `decoderLog`, `notePresented` | page shell / probe |
| 664-707 | `resumeSecOf`, `reportPos` (Date.now throttle), `tryApplyResume` | seek-planner intent; `reportPos` shell on Clock |
| 713-751 | `onPlayerMeta` (measured fps beats header) | timeline |
| 772-831 | `fromClock`, `setupKey`, `sought`, `endedAt`, `corrected`, `clockIdOf`, `sharedFrameOf`, `onPlayerFrame` | player / sync / timeline; `fromClock` goes |
| 836-874 | `onPlayerEnded` (stopped ≠ ended, pause followers) | transport + sync |
| 876-911, 1036-1061 | `visiblePlayers`, `pump`, `seekPending`, `busy`, `owesFrame`, `waitingTiles` | player over realised state |
| 918-964 | metrics capture, `tilesSettled` | probe |
| 970-1084 | `tick`, `frame`, `scheduleTick` | Clock.requestFrame + `Player.tick`; tool-host tail stays in shell |
| 1092-1115 | `targetOf`, `decoderTarget`, `playingOf`, `frameOf`, `atEnd` | timeline / realised state |
| 1121-1148 | `seekTo`, `deferred`, `sendDeferred` (Date.now, 8 s) | seek-planner |
| 1151-1256 | `followerOf`, `offsetSecOf`, `followerClock`, `holdLagging`, `syncFollowers` | sync |
| 1273-1358 | `reconcile`, `setup`, `driveDecoders` | player (intent vs realised) + sync |
| 1367-1427 | `restartAtEnd`, `onTransport` | transport; `onTransport` goes |
| 1436-1467 | `onChange` | page shell → `Player.setIntent` |
| 1500-1675, 1755-1820 | subtitles, tracks, audio track menu (~330) | `media/player-subs.js` (new file, not core) |
| 1681-1749, 1822-1887 | `bitmapSubs`, `readBlock`/`yuvOf` | renderer |
| 1943-2208 | pixel, X-ray, chapters, scopes hosts (~380) | `media/player-tool-hosts.js` (new file) |
| 2100-2122 | `pendingGoto`, `tryApplyGoto` | seek-planner intent |
| 2212-2431 | controller construction, `onHostMessage`, `routeDecoder`, `restartPlayer`, `onLifecycle`, `onOpen`, `onSessionState` | page shell; `restartPlayer` → `Player.restartTile` |
| 2437-2924 | test hooks, `debugApi`, `compareApi`, `installDebugProbe`, metrics, compare-debug (~620) | `media/player-probe.js` (new file) |
| 2927-2968 | `dispose`, visibility, resize, ready | page shell |

Honest size: ~640 lines of decisions move into the core; subtitles (~330), probes (~620) and tool hosts (~380) move to
their own page files. What remains as the shell is **~1,000 lines** (factory and routing ~250, boot / lifecycle /
session ~400, overlay, geometry, wiring); the 3,017 lines are redistributed, not removed.

### 2.3 `media/engine.js` (3,369 lines) → homes

| Lines | Method | Home |
|---|---|---|
| 176-307 | `start`, block reader, `onWorker` (`'seeked'` 277-291 → `onSeeked`) | adapter |
| 309-651 | streams, configs, WebCodecs/soft lifecycle, open-GOP fallback, audio switching, AudioContext | adapter / audio |
| 653-693 | `restAudio`, `wakeAudio` (timers) | audio on Clock; waking hold → MediaClock |
| 696-1022 | batches, EOF flush, native frames, `trackTs`/`measureRate`/`setFrameRate` | adapter; rate → timeline |
| 1024-1106 | `addFrame`: telemetry + startT discovery + **landing rule 1045-1095** + loop cache | landing → timeline/seek-planner (S4); rest adapter |
| 1107-1326 | caches, `pump` (read-ahead), budget, `syncState`, loop cache | adapter (`readAhead` hint) |
| 1328-1356 | `restartLoop` (wrap time) | transport (when) + adapter (replay from cache) |
| 1358-1381 | `setHidden` (re-seek on show 1379) | adapter + seek-planner |
| 1389-1404 | `settled` | player |
| 1544-1649 | `canStretch`, `audioMaster`, `updateAudioLive`, `setFollowerMode`, `holdAt`, `playbackPhase`, `now`, `anchor` | MediaClock, sync, transport |
| 1651-1743 | audio scheduling, stretch (reschedules on anchor) | audio, subscribed to `MediaClock.onAnchor` |
| 1744-1918 | `tick`: A-B wrap 1751-1760 (**dead in the unified viewer**: its only caller, unified 976, passes no range), end 1761-1772, starve 1773-1787, due picture 1800-1814, behind policy 1816-1858, draw 1859-1876, first frame 1892-1902 | transport / MediaClock / timeline / renderer |
| 1932-1993 | `ended`, `shortOfEnd`, `stopped`, `decodeError` (stop after 3 per spot), `endT`, `loopAgain` | transport (adapter reports facts) |
| 1995-2043 | `setNonRef`, `setFast`, `rel`, `currentTime`, `frameAt`, `currentFrame` | knobs adapter; hysteresis transport; mapping timeline |
| 2045-2114 | `play` (restart at end 2072), `pause`, scrub | transport, seek-planner |
| 2116-2206 | `seekAbs` (state reset → planner; worker/decoder reset → adapter), `seekFromPackets` | split in S4 |
| 2208-2527 | fill-behind, sharp/quick stills, held packets | adapter (quality/replaces on PictureInfo) |
| 2528-2724 | `skipTo`, `seekTime`, `frameSeekTime`, `seekFrame`, `stepFrame` + `flushStep`/`runBackRetry` | seek-planner; `stepFrame` unreached in the unified viewer but **called by the layer-2 harness** (`harness.js:195`) |
| 2726-2903 | step-back cache, `stepBack` | adapter (cache; `canServe`) |
| 2904-2916 | `deferSeek`, `setRate`, `loop`/`setLoop` | seek-planner, transport |
| 2917-3366 | volume, tracks, subtitles, thumbnail wiring, HDR, dispose | audio, adapter, preview-scheduler (when), renderer |

Clock use in engine.js: 52 `performance.now` / `setTimeout` / `ac.currentTime` sites; it ignores the `now` the page
passes to `tick(now)`. Policy timers (to the core via Clock): AC wake hold 691, pending-seek replay 1040, audio-live
hysteresis 1561, media clock 1631-1643, behind/every/skip windows 1782-1854, 1909-1910, 1997, step coalescing and back
wait 2636-2697, 2839. Pacing (adapter, may take the Clock): fill 2210-2269, sharp rest 2291, host thumb timeout 3181.
The rest is telemetry. `test/engine/harness.js` 250-270 monkey-patches `performance.now` to get virtual time.

### 2.4 Other page modules

| File | Lines | Role | Home |
|---|---|---|---|
| `media/decoder-worker.js` | 1,222 | libav demux/decode in a Worker; `gen` / `seekGen` (54-56, 74, 386) drop stale reads | adapter (maps core `Gen` onto `gen`/`seekGen`) |
| `media/pool.js` | | segment scheduling of wasm workers behind one Worker interface | adapter |
| `media/framestream.js` | 100 | native frames from the localhost frame server (http / WebSocket) | adapter (native frames) |
| `media/player-host-adapter.js` | 95 | production HostAdapter (`post` to the host, tagged page/boot) | page shell; the page side of the protocol contract |
| `media/membudget.js` | 62 | memory budgets from machine memory | adapter config (pure; unchanged) |
| `media/exactframe.js` | 124 | exact frames for pixel tools under Live transcode / lossy native (host half `src/exact_frame.js`) | `exactGrab` side channel, not playback |
| `media/player-engine-adapter.js` | 820 | EngineAdapter: mapping 138-190 (pure), `showFrame` polling 521-567 | mapping → timeline/sync; `showFrame` awaits `landed` |
| `media/stepgoal.js` | 117 | `followerTime` (used), `create` coalescer and `followerSeekAction` (no caller outside the file) | sync; fold `create` into seek-planner or delete |
| `media/autoplay.js`, `media/abloop.js` | | pure end / A-B decisions | transport (as is) |
| `media/frame-player.js` | | own `frameAt` 62, restart at end 67, perf clock and loop 120-135 | DecoderPort; decisions → timeline/transport |
| `media/thumbs.js` | 1,157 | ~30 perf.now/setTimeout; scheduling half vs worker/host/bitmap half | preview-scheduler / adapter |

### 2.5 Leaks in the UI

| Where | Decision | Home |
|---|---|---|
| `player-ui.js` 851-862 `emitTransport` + `quiet` 848 (mirrored by unified `fromClock` 772) | rebuilds commands by diffing state, suppresses echoes | `Player.setIntent(tab, commit)` (S7) |
| `player-ui.js` 1423-1466 `act.*`, 251-260 `stepBy` | frame target maths; `end` pauses then seeks | intent actions stay; target maths → timeline |
| `player-ui.js` 1678-1684 seek drag, 1739-1762 thumbnails | hold picture while dragging, seek on release | seek-planner scrub + preview-scheduler |
| `player-ui.js` 2956-2961 `decoderFrame` | **the production A-B wrap** | transport |
| `player-ui.js` 2966-3012 `restartAt`, `decoderEnded`, `showStopped` | loop, stop notice, pause at max, Autoplay next, retry | transport (UI keeps notice, rail) |
| `player-ui-input.js` 295-324 visibility controller (wired 1952-1957) | auto-pause hidden tab, resume only if it paused it | transport `autoPaused` |
| `player-ui-lifecycle.js` 194-196, 285-301, 337-341; `player-ui.js` 2219-2222 | open target; Autoplay-next conditions; play from 0 after handoff | seek-planner intents, transport |
| `player-ui.js` 3015-3023 | `tickMs` interval clock (mockup) | Clock |

### 2.6 Duplicated decisions (one owner each after the move)

| Rule | Places today | Owner |
|---|---|---|
| Play at the end restarts from 0 | unified `restartAtEnd` 1367; engine `play` 2072; frame-player `play` 67 | transport |
| End: natural vs stopped vs error | engine `tick` 1761-1772, `ended` 1932, `stopped` 1955, `decodeError` 1968; unified `onPlayerEnded` 836; UI `decoderEnded` 2980 | transport |
| Loop | engine `tick` 1765 (single video); UI `decoderEnded` 2990 (Compare); unified `effectiveLoop` 501; frame-player `tick` | transport |
| A-B wrap | UI `decoderFrame` 2956-2961 (production); engine `tick` 1751 (dead); `journeys.js` 91-121 (test copy) | transport |
| Frame numbering vs what is shown | engine `frameAt` 2037 (ms slack) and `tick` lead 1800-1814; frame-player 62; adapter `tileFrameAt` 160 (round = floor(v + lead + nudge), 08eb884); unified `clockTimeFrame` 2445, `tryApplyGoto` 2112 | timeline (two functions: `frameAt`, `shownFrameAt`) |
| Coalesced / held seeks | unified `deferred` 1138 (8 s, production); engine `stepFrame`/`flushStep` (harness only); `stepgoal.create` (unused) | seek-planner |
| "Settled / busy / owes a frame" | unified `busy` 902, `owesFrame` 1057, `tilesSettled` 953; engine `settled` 1389, `syncState().settled` 1301; adapter `showFrame` 543 | player |
| Follower time, offsets | unified `followerTimeFn` 1182, `offsetSecOf` 1152, `sharedFrameOf` 808; stepgoal `followerTime` 91; adapter `offsetSeconds` 146 | sync / timeline |
| Who is heard | unified `soundIdNow` 1756 + `holdLagging` 1235; adapter `applySound` 630; UI 2933 | intent (player-state) + sync (holding) |

## 3. Simulator

`test/sim/` runs in layer 1 (`test/layers.js` picks it up like any unit file).

### 3.1 Virtual clock

Extend `test/lib/virtual-clock.js` (47 lines, `{now, setTimeout, clearTimeout, advance, runAll}`) with `requestFrame`
(vsync grid 16.667 ms, optional seeded jitter and dropped vsyncs) and a `FakeTimeSource` (audio clock with drift in ppm,
suspend/resume latency like `wakeAudio`). `advance(ms)` runs timers and frames in time order; `runUntil(pred, maxMs)`
fails with the trace when `maxMs` virtual ms pass.

### 3.2 Fake decoders

`FakeDecoderPort(model, rng)` implements DecoderPort and, for S2a, the legacy engine surface the unified page reads
today (`seekTarget`, `shownStale`, `catchUp`, `skipping`, `eof`, `syncState()`, `setFollowerMode`, `holdAt`,
`currentFrame()`, `settled()`, `playbackPhase()`), extending `stubPlayer` in `test/host/production_adapters_test.js`
21-50. It models:

- **Timing**: CFR, NTSC 30000/1001, ms-rounded timestamps, VFR segments, **timestamp gaps at the landing point**, a
  start offset (PTS 3600), GOP layout (keyframe interval, open GOP), audio longer than video.
- **Paused read-ahead**: after a paused seek lands, it keeps decoding about 1 s ahead (`PAUSED_AHEAD_S`) and reports
  "busy" while the shown picture is final (the 5b21f95 / ca2876a confusion).
- **Early EOF**: data ends before the declared duration (`trunc_faststart`), and an EOF before the last declared frame.
- **Errors**: a damaged picture at a pts; repeated errors at one spot; **the error count per spot** the core must keep
  (stop after three, 9f79ff9).
- **Latency**: seek = base + decode cost × pictures from the keyframe + jitter; playing decode rate below real time
  (catch-up policy); back-cache and packet hits answer at once (`canServe`).
- **Remote quality**: a quick picture (`quality: 'quick'`) then the sharp one with `replaces`.
- **Adversary knobs** (seeded): stale reply after a newer request, duplicate reply, dropped `seeked`, stall for N ms.

### 3.3 Seeded runs and replay

- Scripted scenarios (one per behaviour and per fixed bug) plus a random walk: a seeded generator of intent changes
  (play, pause, seek anywhere, step bursts, wheel notches 30 ms apart, rate, A-B, loop mode, offsets, clock switch,
  remove tile, hide/show, decoder restart) interleaved with clock advances. PRNG mulberry32; seed from `VPE_SIM_SEED`.
  S2a extends the existing Compare transport fuzzer (`test/host/player_unified_test.js` 1915) instead of starting new.
- **Invariants**, checked after every event:
  1. paused and settled: the bar frame equals the frame of the picture on screen;
  2. a settled paused seek shows the picture `timeline.frameAt` names (also across gaps and VFR);
  3. while a seek is pending the bar never shows a frame before the target (also when Play is pressed meanwhile);
  4. at most one seek in flight per decoder; the newest target wins; every seek ends in `landed` (also a no-op seek);
  5. `ended` only on a natural end; a stop or decode error is never treated as an end (no loop, no Autoplay);
  6. Compare: paused and settled, every tile shows `clockToTile(clockFrame)` (with lead and nudge as 08eb884);
     out-of-range tiles never play; when the clock ends, followers pause; a clock switch keeps the new clock's position;
  7. loop wraps once per end; A-B never shows a picture outside [A, B] for more than one frame;
  8. paused and settled: the page rests; after dispose no timer is pending;
  9. a stale reply (older `gen`) never changes state.
- A failure prints the seed, scenario and the last 200 trace events (JSONL: intent, decoder event, realised-state diff)
  to `test/out/sim-<name>-<seed>.jsonl`. Replay: `VPE_SIM_SEED=<seed> node test/run.js unit --grep sim_`. A shrinker
  drops commands while the failure persists and the result becomes a scripted regression test.
- CI runs a fixed seed set; a nightly job runs fresh seeds. 1,000 walks of 30 virtual seconds should take seconds once
  the core is pure; S2a (the whole page on fake-dom) is slower, so it runs ~100 walks in CI.

### 3.4 What it does not prove: contract tests

`runDecoderPortContract(makePort)` (pattern of `test/host/adapter_contract_test.js`) runs against `FakeDecoderPort`
(layer 1), the engine adapter on real wasm through `test/engine/harness.js` (layer 2), and once per adapter kind in
layer 3 (WebCodecs, native frames, frame-player). The page↔host protocol contract (2.1) is run from both sides in S2b.

### 3.5 The fixes of the last two weeks, as simulator cases

"From S2" = the characterization harness on today's page catches it; "after S4/S5" = needs the extracted planner or
transport (today the decision is inside engine.js, which S2a fakes away), or the host-half simulator.

| Commit | Bug class | Invariant / model | Caught |
|---|---|---|---|
| 5b21f95 Pause: the bar takes the frame on screen | bar one frame behind during paused read-ahead | 1, paused read-ahead | from S2 |
| 0fe4393 held-back target keeps the bar | landed opening seek pulled the bar to 0 | 3 | from S2 |
| 4603d16 one seek on its way per paused decoder | every step restarted decoding | 4 | from S2 (unified `deferred`) |
| cc26548 Play during a pending seek | play restarted at the old picture | 3 | from S2 (pump guard); engine half after S4 |
| 6f6c1dd (test workaround) seek to the frame shown | no `landed` for a no-op seek | 4 | from S2 |
| 114efe4, 5eefe0b Compare end rules | stopped follower restarted; longer followers kept playing | 5, 6 | from S2 |
| 12a9c1a resume mid-clip | eof flag made play restart from 0 | 5 | from S2 (fake `eof`) |
| 254d656, 706a4b4, 5e6149e, 08eb884 Compare mapping / reconcile | mixed-rate drift, stale caches, rounding | 6 | from S2 |
| aeaf107 restore after decoder restart | lost frame and play state on HLS switch | restart + 1, 3 | from S2 |
| ca2876a, 07c7b73 loading ring | wrong "waiting" predicate | paused read-ahead | from S2 |
| 491c7ed Paused seeks land on the named picture | landing on timestamp gaps | 2, gaps at landing | after S4 (landing is in engine `addFrame`) |
| c78156c, a29e2d4 stop before end | stop treated as natural end | 5, early EOF | after S5 (decided in engine `ended`/`stopped`) |
| 9f79ff9 stop after repeated decoder errors | retry storm | 5, error count per spot | after S5 |
| 72d442f quick picture only of the seek target | stale quick picture | 9, quality/replaces | after S2b + S4 |
| 79bb39a, 207ce7b, a2d9dd0, 3d31573, ba2fdb6 host half (Live transcode, sound cache, packets, keyframe seek, frame grid) | host decisions in `src/stream.js` / warm decoder | host-half sim (3.6) | after S2b |
| 22dabd1, 2568ff0 stale host / preview replies | reply for an old request | 9 | after S2b / S9 |
| L3 flakes: wheel-step notches, loop-rest, `end-of-sound` resume at 4.985 s | | 4, 8, 5 | S2 (wheel, rest); after S5 (end) |

### 3.6 The host half

Remote and native seeking is half on the host: `src/stream.js` (warm decoder `src/warm-decoder.js`, `skipHeld`, fill
behind, quick and sharp pictures, size restarts, keyframe seeks 3d31573, frame grid ba2fdb6), `src/native.js` (size
restarts, frame server), `src/stream-adapt.js` / `stream-buffer.js` (ladder). Six of the recent fixes were there. S2b
runs the **real** `src/stream.js` / `src/native.js` with the scripted ffmpeg of `test/host/ffmpeg_fake_test.js` (faked
`child_process.spawn`: hangs, exits, scripted output) and `src/link-sim.js` on the same virtual clock, connected to the
page side through the protocol contract (2.1): a `FakeHostPage` replays the page's requests (seek, step, fill, play
during seek, hide) and checks the host's decisions (how many ffmpeg starts, held packets skipped, quick before sharp,
size restart only at the next seek). `slow_link_ux_test.js`, `stream_fill_test.js`, `paused_quick_test.js`,
`paused_sharp_test.js`, `remote_ladder_test.js` already cover single functions this way; S2b strings them into journeys.

## 4. Migration plan

Rules for every step: characterization tests at a boundary that survives the step are written first and pass against
the current code; the move does not edit them; each step is mergeable alone, lands on `main` with CI (layers 1-2) plus
the named layer-3 scenarios, and is reverted as a whole if a regression shows. No feature flags. The characterization
boundary is **intent in (`player-state.js` commits) + realised state out (`getState()`, the probe) + calls/events at the
decoder edge**: all three exist today and after the move.

| Step | Characterization first | Move | New fast tests | L3 retired / shrunk | Risk, rollback | Size |
|---|---|---|---|---|---|---|
| **S0 Runner, probe, clean dedupe** | none (no product code except probe fields) | `scenarios.js` `--grep` filters steps and results (`scenario/case/result`); `--sub` full names; `R.t` and raw-array cases through the filter; `--rerun-failed`; drop `tightFirstFrame`; probe fields (`decision`, `transport`, frame size / pending restart, `restored`, stored position, `exported`) replace `waitLog` in the top-10 flaky checks; `ensure()` only the clips used; record `ffmpeg -version`; fix AGENTS.md, TESTING.md, run-tests skill, test-inventory.md | host test of the step/result filter; probe-field test in `debug_probe_test.js` | retire the 53 clean UI duplicates (1.4); `compare_metrics` → layer 2 | low; spot-check per batch; revert per batch | runner ~300, probe ~100, deletions ~1,500 test lines; 3 sessions |
| **S1 Layer-2 harness like production** | run the current engine suites, record results | `test/engine/harness.js`: `P.step` = pause + `seekFrame` with the unified hold-back rule (one seek in flight, newest held; until S4 a small test-side copy of `seekTo`/`deferred`, replaced by `seek-planner` in S4); A-B through the same `ab.wrapTarget(frame / fps)` on presented frames and `restartAt` as `player-ui.js` 2956-2961 (replaced by `transport` in S5); remove the `p.stepFrame` branch (195) | the existing `frames_*.js`, `journeys.js`, `scrub.js`, `continuity_fuzz.js` now exercise the production path; differences found are bugs or quarantined KNOWN | re-inventory every row citing `test/engine/` (marked "re-verify after S1"); only then retire them | medium: suites may go red on the real path → that is the finding; quarantine per TESTING.md | ~150 harness lines; 1-2 sessions (+ fixes found) |
| **S2a Page characterization** | this step is characterization | `test/sim/page.js`: unified + controller on fake-dom, `FakeDecoderPort` (legacy surface), virtual clock; extends `player_unified_test.js` 1915 fuzzer and `production_adapters_test.js` `stubPlayer`; scenarios for every "from S2" row of 3.5, the Compare oracle (`multiview.js` 42-52 + 08eb884 agreement), end/stop/loop/A-B matrix, held seeks, play during seek, resume/goto/restore, hide/show | ~40 scenarios + walks with invariants 1-9 (known failures quarantined) | none yet | medium: coupling to internals → assert only on the three boundary sides | ~1,500 test lines; 3-4 sessions |
| **S2b Host-half characterization** | this step is characterization | `test/sim/host.js`: real `src/stream.js`, `src/native.js`, warm decoder with the fake ffmpeg and link-sim; `FakeHostPage`; protocol contract run from both sides | journeys for 79bb39a, 72d442f, 207ce7b, a2d9dd0, 3d31573, ba2fdb6 | none yet | medium (the fake ffmpeg must imitate ffmpeg output timing) | ~1,000 test lines; 3 sessions |
| **S3 timeline** | table tests of today's frame rules on CFR, NTSC, ms-rounded, VFR, gaps, start offset; reproduce 08eb884's agreement test (playing follower shows floor(v + lead + nudge) = round(v); paused steps agree) | `timeline.js` with `Presentation {lead, followerNudge}`; engine `frameAt`/`frameSeekTime`/`measureRate`, frame-player `frameAt`, adapter mapping, unified `clockTimeFrame`/`tryApplyGoto` call it | property tests | multiview numeric `sync/*`, `large/clock`, `native/lockstep` → one wiring check; `export/vfr`, `xray/strip`, `time/formats`, `step-ms-rounded` | low-medium (any rule change needs sign-off, Q2) | ~350 lines + tests; 2 sessions |
| **S4 seek-planner + engine picture events + Clock seam** | S2a seek scenarios; S1 engine suites on the production path | `clock.js` (inject into unified, engine, adapter `showFrame`); `seek-planner.js` (one slot, notch accumulation, held seeks, play during seek, goto/resume intents, `landed` for no-op seeks); the engine's landing half of `addFrame` and the state reset half of `seekAbs` move behind `onPicture` / `requestPicture` (the engine part of DecoderPort); harness switches from its copy to `seek-planner`; delete engine `stepFrame` path and `stepgoal.create` once nothing calls them (knip + tests) | planner unit tests; walks with gaps/latency/reorder; engine suites on real wasm | wheel-step (→ 1 native check), `bar-keeps-target` scenario, remote `seeks` counts, `ui_jumps`, `seek-inputs`, seek-preview release | **high** (landing + engine internals) → land single decoder, then Compare; engine layer-2 suites must stay green | ~1,000 lines moved/changed in engine.js, unified, adapter; 6-8 sessions |
| **S5 transport** | S2a end/loop/stop/A-B/autoplay/auto-pause scenarios; `frames_onend.js`, `frames_edges.js`, S1 A-B on the production wrap | `transport.js` (reuses `autoplay.js`, `abloop.js`); engine `onEnd` facts and error spots; unified `onPlayerEnded`/`restartAtEnd`/`effectiveLoop`/`pendingAutoPlay`, UI `decoderFrame` wrap / `decoderEnded` / `restartAt` / visibility, frame-player end/loop; delete the dead engine A-B branch | transport unit tests; invariants 5, 7 | autoplay-loop (whole), `abloop`, ctxmenu `commands/ab-loop`, folder-rail `autoplay/*` (→ tab-swap wiring), `pair/short-clock-eof`, `multiview-short-loop`, clip-export Compare wrap | **high** (6 of 22 recent fixes) → single video first, Compare second | ~500 lines, 5 files; 3-4 sessions |
| **S6 sync** | S2a Compare scenarios | `sync.js`: follower time (one MediaClock sample per tick), offsets → tile frame, `holdLagging`, reconcile corrections, clock switch/remove, holding the heard tile | invariant 6 on 2-16 tiles | multiview `sync/*`, `large/lockstep-offsets`, `panel/video-page`, `offset-3` | medium-high → `compare-wiring` play checks stay | ~450 lines; 3 sessions |
| **S7 Player facade** | S2a unchanged; `player_ui_test.js`; mockup harness | `player.js`; `Player.setIntent(tab, commit)`; `emitTransport`, `quiet`, `fromClock`, `onTransport`, `transportOf` go; subs, probe, tool hosts to their own files; unified → ~1,000-line shell | Player contract (fake engine and production) | `hls_quality*` restore → sim | medium (UI wiring) | ~600 lines; 3 sessions |
| **S8 DecoderPort for the rest** | `runDecoderPortContract` on the engine adapter (from S4), then frame-player and native frames | frame-player and native frames implement DecoderPort (quality/replaces, `setOutputSize`, metadata, `exactGrab`); engine fields become adapter-private | contract in layers 1-2 | per-adapter checks fold into thin L3 | medium | ~600 lines; 3-4 sessions |
| **S9 preview-scheduler** (independent; any time after S0) | `seek_preview_test.js`, `seek_preview_pass_test.js` | scheduling half of `thumbs.js` on Clock | rest speed-up, pass pause while playing/hidden, pacing on the virtual clock | seek-preview → one wiring check | low | ~500 lines; 2 sessions |
| **S10 MediaClock + catch-up** (optional) | S2a rate / audio-only / late-start / rest; `test/engine/unit.js` invisible and sound tests | engine `now`/`anchor`/`audioMaster`/`updateAudioLive`/`playbackPhase`/`settled` → MediaClock; audio as TimeSource with `onAnchor`; catch-up policy → transport | MediaClock with `FakeTimeSource` drift | `rate/speed`, `audio-only`, `loop-rest`, `autoplay-late-start/*` | **high** for A/V sync → layer 4 before/after; worth doing only if S2a/S4 show clock bugs | ~500 lines; 3-4 sessions |
| **S11 Thin layer 3** | — | section 5 | — | remaining MOVE-DOWN rows retire as their step lands; KEEP set rewritten into 10 scenarios | medium (runner) → old scenarios kept until the new set passes 10 nightly runs | runner ~400, cases ~2,000 lines; 4-5 sessions |

Order rationale: S0 removes the worst flake causes and the clean duplicates with no product risk; S1 makes layer 2
test what ships (without it, later retirements rest on a path users never run); S2a/S2b are the safety net; S3 is small
and pins the rounding rules; S4 holds the landing and coalescing bugs and needs the engine's picture events, so they
move together; S5-S8 finish the separation; S9 can be pulled forward; S10 only if needed. Expected layer-3 size: after
S0 ~240 checks / ~33 min; after S5 ~150 / ~22 min; after S11 ~65 checks in 10 scenarios / ~10 min. Total **~45-55
sessions** (S4 and S1's fix-ups are the uncertain ones).

### 4.1 Parity checklist (run at every step; each line names its proving test after the step)

- Play / pause / step ±1 exact on WebCodecs (Annex-B and avcC containers), WebAssembly, native, frame-player; seek
  paused exact incl. gaps, VFR, NTSC, start offset, 4K; seek while playing; Home / End; go-to box and frame links.
- Wheel steps coalesce and land exactly; seek-bar drag holds the picture and lands on release; slow link: bar and time
  move at once, held seeks, quick then sharp picture.
- End: natural stop at the last picture; loop; Autoplay next (once, from 0, not at the last video); stop before the end
  shows Retry; decode errors stop after three at one spot; play after the end restarts from 0, after a stop at the stop.
- A-B: marks, loop inside [A, B] (production wrap), PNG and lossless export ranges.
- Rate 0.25-4 with audio stretch; audio as master clock; audio-only files; sound longer than picture.
- Hidden tab: auto-pause and resume only if it paused; hidden tiles do not tick; native ffmpeg stops; previews pause;
  export waits.
- Resume position; window reload restores tabs; decoder restart (HLS quality, original tile) keeps frame and play state.
- Compare: clock tile, offsets in frames and ms, mixed rates (08eb884 rounding), shorter clock ends, shared loop wrap,
  clock switch while playing, remove the clock tile, sound source, holding a lagging follower, 5-16 tiles, native and
  transcoded tiles.
- Remote / native: frame size grows at once, shrinks at the next seek; ffmpeg exit falls back; exact grab under Live
  transcode.
- Loading ring only while a tile owes its frame; the page rests when paused and settled.
- Seek-bar previews: hover, rest refine, background pass pauses while playing on the GPU or hidden.

## 5. Thin layer 3

### 5.1 The 10 scenarios

| # | Scenario | What it proves (only what Node cannot) | Checks (each rerunnable alone) |
|---|---|---|---|
| 1 | `webcodecs` | webview boot under CSP, VS Code's WebCodecs allowlist, decoder worker, WebGL draw, every container the WebCodecs path reads | wcprobe; **container sweep**: Annex-B (AVI, TS, M2TS, MTS) and avcC (MP4, MKV, MOV, FLV) open, play, two paused seeks exact; `h264_vfr`, `h264_noaudio`, `h264_ac3*`, `vp8_vorbis`; step and seek exact (`s_h264`), edges and End; VP8 end flush; open-GOP fallback; damaged picture continues |
| 2 | `wasm-audio-previews` | wasm worker / pool in the webview, frame-player, WebAudio, the preview worker | HEVC 4K and VP9 4K paused seek exact; MJPEG frame-player step; audio-only plays; **WebAudio is the master clock** (media time follows the AudioContext, drift < 0.5 s); truncated MP4 message; **seek-bar preview**: WASM thumbs worker and preview decoder fill the bar, hover shows the frame |
| 3 | `gpu-pixels` | canvas readback paths | pixel inspector BT.709 / 601; waveform on GPU canvas; frame-player 2D canvas scopes; HDR tone-map shader vs zscale; rotation |
| 4 | `hdr-output` | display probe, WebGPU extended canvas | probe; forced PQ and HLG pattern pixels; present loop while playing (built-in and native) |
| 5 | `native-ffmpeg` | native ffmpeg transport into the webview | decision (probe); frame server over http and WebSocket; 403 → message fallback; frames grow on resize; hidden tab stops ffmpeg; 10-bit frames; wheel notches land (one) |
| 6 | `compare-wiring` | VS Code tab lifecycle, URI handler, context keys, many decoders and one shared renderer, real CSS layout | Compare With grows the tab and leaves; `/compare` link opens synced; Explorer capture + preview tab + openWith burst; 4 mixed decoders play; 9 tiles share WebGL; overlays fit cells |
| 7 | `vscode-platform` | VS Code itself | keybinding conflicts; `vscode://` frame link; next/previous file tab; folder-rail tab swap; settings reach page prefs; subtitle file picker; clipboard copy; first-open popup once; window reload restores tabs; `.mkv` resolver |
| 8 | `export-commands` | commands that write files from the webview | A-B PNG export; Save Frame; one lossless clip export; export waits while hidden |
| 9 | `remote-transcode` | Live transcode → WebCodecs, host tone-mapping, link simulator, real ffmpeg processes | one transcoded clip plays and seeks; size to picture; HDR tone-mapped on host; slow-link first picture; Compare transcoded tile; **ffmpeg exit → built-in decoder**; **exact grab under Live transcode** (pixel tools get the exact frame) |
| 10 | `url` | host proxy and native network input | MP4 URL via proxy; HLS through native ffmpeg |

`file-icons` pixel comparisons move to a release-only run (`--release`).

### 5.2 Per-check rerun (runner changes)

- `--grep` selects scenario, step and result (`^webcodecs/step-exact$` runs one check); target ~30 s: launch +
  activation ~5 s, reset ~1 s, open + first frame, the check.
- **Serve mode**: `node test/run.js vscode --serve` keeps one instance (`HiddenCode.attach` from a state file); a rerun
  pays reset + open (~5-15 s). Reuse requires `resetState` (`src/debug-cmd.js` 153-157) to clear **workspaceState and
  the settings keys the extension writes** (for example `files.associations`), not only globalState as today.
- **Fixtures**: every check is `open → reach its precondition through hooks → act → assert`; no state from an earlier
  check (`lib.fixture(vs, h, {clip, settings, stage})`).
- Per-check budget 60 s (× the existing scale factors); a timeout records that check and moves on.
- `--rerun-failed` reads the newest `out/scenarios-*.json`; WebGL2 loss reruns only the affected check.

### 5.3 Rules (enforced by a host test that scans `test/vscode/cases/`)

- No `sleep(` outside the polling helpers; no `waitLog` / log regexes; assertions read probe state only.
- Probe fields replace the log: `decision` and `transport` per tile, `landedGen`, frame size and pending restart,
  `exported {done, total}`, `ffmpegProcesses`, `loopWraps`, `restoredTabs`, `popupShown`, `audioClock`.
- One generous deadline (default 60 s) as a safety net, never a speed check; speed belongs to layer 4.
- Pixel tolerances only where the check is about pixels, measured over 10 runs.

### 5.4 Hermetic runs

- **Pinned ffmpeg for native and transcode checks**: the BtbN LGPL build `src/setup.js` installs for users
  (`lgpl-shared` on Windows, 128), at a fixed release and SHA-256, fetched by `test/vscode/get_ffmpeg.js` (like
  `get_code.js`) into the test cache: tests then run what users get. Clip and reference generation may use a GPL build
  (filters such as zscale) kept only in the local test cache: never committed, never in CI artifacts, never in the VSIX.
  The JSON records both `ffmpeg -version` lines.
- **Fixed media folder**: Git LFS clips + generated clips with their stamp (`make_cases_media.js`); a missing or changed
  clip is regenerated before the run, only for the selected checks.
- **Load guard**: `test/loadmon.js` (`sample()`) before every scenario; above a threshold (other processes > 25 % CPU)
  the runner waits up to 5 min, then refuses with the top processes named (`--force` overrides). Today it only records
  `loadBefore`.
- **Nightly / background**: a Windows scheduled task on the maintainer's machine runs `node test/run.js vscode
  --nightly` (10 scenarios, serial); `tools/l3-flakes.js` prints per-check fail rates over `out/` (the script behind
  section 1.2); a check failing twice in 10 nights is fixed or quarantined, never retried silently.

**Time targets**: CI fast net (layers 1-2 + simulator) ~3 min on GitHub's runners (today layer 1 ~30 s and layer 2
~75 s locally; S2a adds about a minute, the pure-core walks seconds); layer 3 ~10 min serial in the background.

## 6. Open questions and risks

| # | Question | Recommendation |
|---|---|---|
| Q1 | Where do the core modules live? | `media/playback/`, UMD like `stepgoal.js`, loaded through `src/unified-html.js`, with a dependency-cruiser rule that they import nothing from the page |
| Q2 | Which frame rule is canonical? | two functions, not one: `frameAt` (decoder numbering, engine's ms slack, 491c7ed) and `shownFrameAt` = floor(v + lead + nudge), which with lead = nudge = 1/4 frame equals `tileFrameAt`'s rounding that 08eb884 kept; S3 reproduces 08eb884's agreement test and lists every case where the frame-player or unified floor differs, for sign-off |
| Q3 | Due-picture selection per animation frame for 16 tiles: core or adapter? | core computes the due pts from one MediaClock sample, adapter keeps the queue; measure the 16-tile layer-4 bench before and after S4/S6 |
| Q4 | Audio as the master clock: keep it in the adapter? | yes, behind `TimeSource`; `MediaClock.onAnchor` tells the audio adapter to reschedule WebAudio |
| Q5 | Retire duplicates before the core work? | only the 53 clean UI duplicates in S0; host-test duplicates after a second look; engine-cited rows only after S1 |
| Q6 | Fix the layer-2 harness to step and wrap like production (S1), accepting that suites may go red? | yes, before any retirement that cites `test/engine/`; red results are findings, quarantined as KNOWN per TESTING.md until fixed |
| Q7 | Pinned ffmpeg for tests? | BtbN LGPL at a fixed release for every native and transcode check (what `src/setup.js` gives users); a GPL build only for generating clips and references, kept in the local test cache, never in the repo, CI artifacts or VSIX |
| Q8 | Delete dead code (engine A-B branch in `tick`, engine `stepFrame`/`flushStep` path, `stepgoal.create`)? | yes, but `stepFrame` only after S1 removes the harness fallback (`harness.js:195`) and S4 moves stepping to the planner; knip + tests confirm no caller |
| Q9 | Real CSS layout checks need a browser | keep 2 checks in `compare-wiring`; a headless browser for the mockup harness is a dependency decision, defer |
| Q10 | Is S10 (MediaClock + catch-up) needed? | optional; do it only if S2a/S4 show clock-side bugs or catch-up policy changes are planned |
| Q11 | Change the core while other work touches `player-unified.js` / `engine.js`? | announce a short freeze for S4, S5, S7, S8 |
| Q12 | Run thin layer 3 in parallel? | no; serial (WebGL2 losses with 3 instances, TESTING.md 2026-11-21); 10 min serial meets the target |
| Q13 | Where does subtitle / probe / tool-host code go when the shell shrinks? | three page files (`player-subs.js`, `player-probe.js`, `player-tool-hosts.js`) in S7, no behaviour change |

**Top risks.**

1. *S1 turns layer 2 red* on the production step / A-B path: expected and useful; budget fix-up time, quarantine with
   KNOWN, do not retire engine-cited L3 rows until green.
2. *Characterization at the wrong boundary*: characterize only on intent in, realised state out, and decoder-edge
   events; the fake decoder adapts, scripts do not.
3. *S4 is the big one* (landing + coalescing + engine picture events together, 6-8 sessions): single decoder first,
   then Compare; engine layer-2 suites on real wasm must stay green.
4. *Host half drifts from the fake ffmpeg* (S2b): keep the real-ffmpeg host tests (`warm_decoder_test.js`) and the
   `remote-transcode` L3 scenario.
5. *A/V sync and per-frame cost on 16 tiles* are invisible to the simulator: layer-4 benches before and after S4/S6
   (and S10 if done); one WebAudio and one 9-tile play check stay in layer 3.
6. *Parallel feature work* on the same files: per-step freeze (Q11).

## 7. Revision after review (2026-11-28)

- Layer-2 harness steps with engine `stepFrame` (`harness.js:195`) and wraps A-B with a test copy (`journeys.js:91-121`):
  new step S1 makes it production-like; rows citing engine stepping or A-B reclassified; Q6, Q8 updated.
- A-B rows (`seeking abloop`, `ctxmenu commands/ab-loop`) are MOVE-DOWN→transport, retired after S5.
- WebCodecs claims re-judged against a WASM-only layer 2: container sweep (Annex-B and avcC), `playback open/fmt/{5}`,
  `edges`, `end-key` and the 4K paused seeks are KEEP-L3 in thin scenarios 1-2.
- New 2.0: intent (`player-state.js`) vs realised state (core); the core never stores a second copy of intent.
- New 3.6 and S2b: host half simulated with the real `src/stream.js` / `src/native.js`, fake ffmpeg and link-sim; the
  page↔host decoder protocol named as a contract.
- `timeline.js` models presentation lead and follower nudge explicitly; S3 reproduces 08eb884's agreement test; Q2
  rewritten.
- 3.5 marks each bug "from S2" or "after S4/S5/S2b"; 3.2 lists what the fake decoder models.
- DecoderPort: picture quality / `replaces`, `setOutputSize(w, h, {when})`, per-picture size / colour / HDR metadata,
  live (null duration), `exactGrab` side channel, `Gen` mapping onto worker `gen`/`seekGen` and remote / native ids,
  `canServe` instead of cache peeking, `MediaClock.onAnchor`, descriptors only (adapter owns VideoFrames).
- Code map: tick order and hidden tiles (2.2); decoder-worker, framestream, player-host-adapter, membudget, exactframe
  mapped (2.4).
- Steps reordered (S0 runner + probe + clean dedupe; S1 harness; S2a/S2b; S3 timeline; S4 seek-planner with the
  engine's picture events and the Clock; S10 optional); estimates raised to ~45-55 sessions; shell ~1,000 lines
  without subtitles, probes and tool hosts.
- S0 retires only the 53 clean UI duplicates; rows "DUPLICATE→X; part …" became MOVE-DOWN; `size-to-picture`,
  `pixel-tools`, `ffmpeg-exit`, `scopes/frame-player` are KEEP-L3; the weak duplicates were reclassified; flake rates
  are flagged as predating recent fixes.
- Q7: BtbN LGPL pinned for native / transcode checks; GPL only for clip and reference generation, never shipped.
- Thin L3 adds a seek-preview wiring check, a WebAudio master-clock check, ffmpeg-exit restart and exact grab under
  Live transcode; the load guard uses `test/loadmon.js`; serve mode needs `resetState` to clear workspaceState and
  settings.
- Totals reconciled per scenario (1.1): rows, expanded results and the last run's counts side by side.
