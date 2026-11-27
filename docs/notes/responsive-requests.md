# Responsive requests: one owner for "where am I, has it arrived", and a pipeline known before the first open

Status: approved plan, 2026-11-27 (maintainer accepted every recommendation, section 8). Not built; execution order in
section 7. Two root causes; each half ships alone.

**Goal.** Every input (seek click, drag, keys, steps, wheel, play/pause) moves what the UI owns within a frame; what
the decoders still owe shows as pending (docs/notes/seek-pending-feedback.md); the picture follows, over Remote-SSH
Live transcode too.

## 1. Problem

**Cause A: no single owner of "where am I, and has it arrived?".** Each layer infers *pending vs landed* by polling
different fields every animation frame:

| Layer | What it reads today |
| --- | --- |
| `media/engine.js` | `shownT`, `seekTarget`, `pauseT`, `gen`, `localGen`, `playbackPhase()`, `settled()`, `syncState()`, `pendingHave`, `stepTo`, `fill` / `sharp` / quick state |
| `media/player-unified.js` | `busy()`, `seekPending()`, `owesFrame()`, `waitingTiles()`, `pump()`, `tilesSettled()`, `reconcile()` / `seekTo()`, the `sought` / `endedAt` maps |
| `media/player-ui.js` | `t.frame`, `setLoading()`, the seek-bar drag |
| `src/stream.js` | `gen`, `'seeked'` (with or without `have`), `skipHeld()` |

Bugs of 2026-11-27, each a different inference going wrong:

| Bug | Wrong inference |
| --- | --- |
| Bar jumped back to the old position on play during a loading seek | `pump()` let the decoder's `currentFrame()` (still the old frame) overwrite `t.frame` once `busy()` turned false on play |
| Play after a cached seek restarted from the old frame | `engine.play()` chose its start from `localGen === gen` and `seekTarget ?? shownT ?? pauseT` |
| Ring stayed up for seconds after the frame showed | `waitingTiles()` used `busy()`, which counts the read-ahead (`requesting`) as owing a frame |
| Cached-sound play path broke when the ring fix changed `waitingTiles` | the sound handoff and the ring shared one heuristic with different meanings |
| Time readout froze during a seek-bar drag | the readout followed the decoder, not the target the user holds |

**Cause B: the host finds its pipeline by failing at runtime while the user waits.** `src/stream.js`'s exit handler is
a ladder (tone-mapper → GPU decode → GPU encoder → CPU encoder), walked on real opens: libplacebo without a Vulkan
device failed 3 times (≈0.9-2.3 s on the first HDR open; `9e0c56d` cut it to once per tools check, `badTonemapFor`);
working libplacebo needs `-init_hw_device vulkan` (≈0.8 s per ffmpeg start); NVENC is found unusable only after a failed
start (driver API); one kept-running-decoder failure (`warmFailed`) turns it off for the video, whatever the cause.

## 2. The request model

Every user input that moves the playhead or the play state is a **request** with an id. The pure state owns its
target the moment the input happens; each decoder reports progress *against that id* as events. Nobody else infers.

```mermaid
sequenceDiagram
  participant UI as player-ui.js (input)
  participant S as player-state.js (pure)
  participant P as player-unified.js
  participant E as engine.js + RequestLog (per decoder)
  participant H as src/stream.js (host)
  UI->>S: seekFrame / stepFrame / togglePlay
  S-->>UI: t.req = {id, kind, frame, playing}; bar + readout render from it (same frame)
  P->>E: request(id, kind, targetT, playing) per tile (targetOf + offsets)
  E-->>P: accepted {id, gen}
  alt served on the page
    E-->>P: source {id, from: decoded | queue | packets}
  else host
    E->>H: seek {gen, t, have?}
    H-->>E: seeked {gen, t, src: history | history-held | warm | spawn}
    E-->>P: source {id, from: host-*}
  end
  E-->>P: picture {id, quality: quick | full}
  E-->>P: landed {id, frame}  (paused: exact frame shown; playing: first frame shown and clock running)
  E-->>P: sharp {id} / sound {id, from: page | host}
  Note over P: ring = a visible tile whose status for t.req.id is not landed, 150 ms after t.req.at
```

**Request** (in pure state, `t.req`): `{ id, kind: 'seek'|'step'|'play'|'pause'|'scrub', frame, playing, at }`. `id`
is a per-tab counter; `frame` is the tab frame (each tile's own target comes from `targetOf(t, id)`, offsets included).

**Events** (one `RequestLog` per decoder, new pure module `media/request-log.js`; engine calls `log.emit(type, data)`):

| Event | Fields | Emitted by (`media/engine.js` unless noted) |
| --- | --- | --- |
| `accepted` | `id, gen, t` | `seekAbs`, `seekFromPackets`, `seekTime` / `stepFrame` served from the queue, `stepBack`, `play`, `pause` — synchronously, in the input's task |
| `source` | `id, from: 'decoded'\|'queue'\|'packets'\|'host-history'\|'host-history-held'\|'host-warm'\|'host-spawn'` | page paths at once; host paths on `'seeked'` (new `src` field from `seek()` in `src/stream.js`) |
| `picture` | `id, quality: 'quick'\|'full', t` | `showQuick`; the first full frame of the request's gen drawn (`showQueued` paused, the frame loop playing) |
| `landed` | `id, frame, t, ms` | paused: the frame equal to the target is shown (`seekTarget` cleared at it); playing: `playbackPhase()` leaves `loading`/`seeking` |
| `sharp` | `id, frame` | `onSharpFrame` drawn |
| `sound` | `id, from: 'page'\|'host', t, ms` | `takeHeld` / first queued audio covering the play position (`notePlayStart`) |
| `superseded` | `id, by` | a newer request on the same decoder before `landed` (incl. ids folded by step coalescing) |
| `failed` | `id, why` | decode error, host `fail`, end-of-file before the target, request dropped on hide/dispose |

Status per decoder = last event of the newest id. Read-ahead, fills, sharp, prefetch are **not** requests, so they can
never hold the ring (bug 3 by construction).

**Rules that fix the bug class:**

- *Readout and bar* render `t.req.frame` while the clock tile's status for `t.req.id` is not `landed`; `pump()` copies the
  clock decoder's frame into `t.frame` only when it is (playing on). Drag: each `input` event is a `scrub` request
  whose frame is the slider's; the seek goes at release as today, but the readout never waits (bugs 1, 5).
- *Play during a seek*: `togglePlay` creates a `play` request with `from = t.req.frame`; the page calls
  `engine.play({ id, fromT })` and the engine starts **from `fromT`**, never from `seekTarget ?? shownT ?? pauseT` or
  `localGen` (bug 2). If the pending seek's source was `packets`, play is a host seek with `have` as today.
- *Cached sound*: the handoff keys on the play request's `source` (`packets` → page sound offered) and reports `sound`;
  the ring keys on `landed`. Separate events, separate meanings (bug 4).
- *Coalescing* (steps, wheel, key repeat): each input gets its id and the pure state moves `frame` at once; whatever
  coalescing the engine and page do (`stepTo`, `flushStep`, `STEP_SEEK_MS`, `REMOTE_STEP_QUIET_MS`, host
  `SEEK_QUIET_MS`, and `seekTo` in player-unified.js as `fix/frame-step-coalesce` leaves it) stays, and reports
  `superseded {id, by}` for the ids it folds. Only the newest id can land; consumers only ever look at `t.req.id`.
  At most one host seek is in flight per id (debug check, step P1).
- *Compare*: one tab request fans out to N decoders. A tile outside its clip has status `none` (counts as landed). The
  ring is per tile (as today); the seek-bar pulse and lockstep "tab landed" wait for **every visible tile**. The clock
  tile's `landed` releases the bar for a play request; followers follow its clock (`setFollowerMode`, unchanged).
  `reconcile` reads each tile's last request target from its log instead of `sought`; a paused tile that `landed` on
  another frame than its target gets the same id re-issued (one retry, then `failed`).
- *Remote*: the wire keeps `gen` (host needs nothing new except `src` on `'seeked'` and the existing `have`); the engine
  maps `gen → id`. A playing seek is a `seek` request with `playing: true`, landed when its first frame shows and the
  clock re-anchors.
- *Other decoders* (`media/frame-player.js`, native): a shim (`requestShim(p)`) emits the same events from today's
  fields until each is migrated; consumers do not branch.

## 3. Ownership and migration

| Layer | Owns | Stops doing |
| --- | --- | --- |
| player-state.js | `t.req` (id, kind, frame, playing, at); `seekFrame` / `stepFrame` / `togglePlay` allocate ids | — |
| player-ui.js | renders `t.req.frame`; `setLoading(ids)` unchanged | reading decoder time during a drag |
| player-unified.js (+ the module split off in P4) | fan-out (`request()` per tile), status map from events, ring, pulse, reconcile | `seekPending`, `owesFrame`, `waitingTiles` heuristics, `sought`, the `busy()` guard in `pump` |
| engine.js | decode internals (`seekTarget`, `pauseT`, `shownT` stay private) + `RequestLog` | `localGen` as play's start rule; `syncState()` as a public readiness API |
| stream.js | `'seeked'.src` | — |

`settled()` stays, for the frame loop's rest only. `endedAt` stays (end-of-clip, not a request).

## 4. Pipeline capability probe

New `src/pipeline_probe.js` (pure selection + an injected `run`), beside `src/transcode_probe.js`, same storage pattern
(`globalState` record, in-memory promise, last 20 keys).

- **When.** In the background right after `ff.locateTools` succeeds (`src/extension.js` tools check), on every machine
  including remote hosts (it runs in the remote extension host where ffmpeg runs), unless `videoPreviewEnhanced.transcode`
  is `off`. Low priority (`lowerPriority`, src/ffmpeg.js), one ffmpeg at a time, holding a GPU session
  (`src/gpu-sessions.js`). Never on the open's critical path: an open before the record exists uses today's ladder, and
  the failures it meets are handed to the probe (skip known-bad chains).
- **What.** Whole chains, each `ffmpeg -frames:v 3` on tiny bundled inputs (new `src/probe-media/`: 320x180 H.264 8-bit and
  HEVC Main10 PQ, 3 frames, a few KB, generated, MIT): decode {NVDEC (`cudaDecodeDownload` / full CUDA), QSV, CPU} ×
  tone-map {OpenCL, QSV/VA-API, CPU zscale; libplacebo with `-init_hw_device vulkan` **only in the kept-running form**} ×
  encode {NVENC, QSV, AMF, MF, libx264/OpenH264}, pruned by `gpuFilters` and the encoder listing, tried in today's
  preference order, stopping at the first working chain per class (`sdr`, `hdr`) plus the next two as fallbacks. Args
  come from `buildVideoPipeline` / `buildHdrPipeline` (src/transcode_args.js; no second copy of the argv logic). One run
  also tries the kept-running form (MPEG-TS on stdin, `{ warm: true }`) for the chosen chain; for `hdr` it renders one
  frame with libplacebo (kept-running) and one with the per-seek tone-mapper and records their difference, so a seek
  that leaves the kept-running decoder does not visibly change the picture unnoticed. Each result records start-up ms
  and fps.
- **Record.** `{ ver, key, at, size, chains: { sdr: [chain...], hdr: [chain...] }, warm: { chain, tonemapDelta },
  failures: {chain: stderr tail} }`; a chain is `{ decode, tonemap, encoder, device, startMs, fps }`.
- **Key / invalidation.** `hostname | ffmpeg path | ffmpeg version + size + mtime | GPU adapters (name) | driver versions
  (NVIDIA from `machine()` in src/extension.js, others from the OS adapter list) | PROBE_VER`. Any change → re-probe in the
  background; the old record is not used. A "Re-check GPU pipeline" command clears it.
- **Use.** `transcodeOptions` (src/extension.js) passes the first chain of the class; `EncodedStream` builds from it
  (`decodeMethod`, `badTonemap` preset to the skipped kinds, `encoder`).
- **Runtime failure of a probed chain.** The stream moves to the record's next chain at once (no blind ladder), the
  chain is marked bad *in memory* for this key, and a background re-probe of it runs; the record demotes it only on a
  repeated failure (a busy GPU or no free session is transient). Kept-running decoder: a failure before its first
  frame is the chain's (as `9e0c56d`); any other failure gets one retry, then off for that video.

## 5. Reuses vs. Introduces

| Reuses | Introduces |
| --- | --- |
| `gen` on the wire, `'seeked'`, `have` / `skipHeld` | `media/request-log.js` (pure, ~150 lines): events, status, ring buffer |
| `targetOf`, offsets, `setFollowerMode`, `reconcile`'s structure | `t.req` in player-state.js |
| `setLoading` / `loadingAfter`, the ring and pulse CSS | `request()` per tile + `requestShim()`; a request module split off player-unified.js (P4) |
| engine coalescing (`stepTo`, quiet timers) | `src` on `'seeked'`; `engine.play({ id, fromT })` |
| `transcode_probe.js` cache pattern, `probeEncoder`, `machine()`, `gpuFilters`, `buildVideoPipeline` | `src/pipeline_probe.js`, `src/probe-media/` (2 tiny clips) |
| `gpu-sessions.js`, `lowerPriority`, debug-probe `trace`, `vs.mark()` / `waitState` | debug-probe `requests` (event log with page times); layer-3 helpers `P.after` (S0), `P.waitRequest` (P5) |

Pushback checked: no second copy of the pipeline argv; no new DOM syncing (ring and readout stay controller-rendered);
nothing works around an AGENTS.md limit. player-ui.js (3171 lines) and player-unified.js (2975) do not grow: P3/P4 move
code out in the same PR as they change it.

## 6. Risks

- **Two truths during migration.** Events and old fields can disagree. Mitigation: debug builds assert in `tick()` that
  the shim's status and the engine's events agree; consumers move one at a time.
- **A missing `landed`** leaves the ring up forever. Every request ends in `landed`, `superseded` or `failed`; hide,
  dispose and a new gen supersede; a debug watchdog logs requests open > 10 s.
- **Probe false positives**: 320x180 passes where 4K fails (VRAM, NVENC level limits). Runtime fallback stays; the
  record notes the size probed.
- **Probe cost** on first run ≈ 3-8 s of background GPU/CPU, more with Vulkan; on a laptop on battery it is visible.
- **Remote globalState** lives with the remote extension host; the hostname in the key keeps machines apart.

## 7. Execution plan

Every step is its own branch and PR from `main` (worktree each). Tests listed are written first and shown red (bug
fixes) or lock today's contract (refactors), at public boundaries (docs/TESTING.md). Layer 1-2 = `CI=true node test/run.js
unit engine` for every step; layer 3 lists the scenarios to run (`node test/run.js vscode --grep <name>`), not the layer.

| Step | What | Size | Depends on |
| --- | --- | --- | --- |
| S0 | Review-confirmed flaky-test fixes; AGENTS.md rule; `P.after` helper | S | — |
| C | Packet cache 64 → 128 MB per video, ~512 MB total across Compare tiles | S | — (any time) |
| P1 | `request-log.js`, engine emits events, shim, debug-probe `requests`, one-host-seek check | M (~450) | M0 |
| P2 | Ring and pulse from request status | S (~150) | P1 |
| P5 | Host `'seeked'.src`; layer-3 cases on events; `P.waitRequest` | S (~200) | P1 |
| P3 | `t.req` in pure state; readout/bar/drag/`pump` from it; `engine.play({id, fromT})`; split player-ui.js | M (~400) | P2, P5 |
| P4 | Compare fan-out, reconcile from logs, `sought` goes, sound on `source`; split player-unified.js | M (~350) | P3 |
| P6 | `pipeline_probe.js`, probe media, background run, record (unused) | M (~400) | — (merges after P4) |
| P7 | Opens use the record; next-known-chain fallback; warm retry; re-check command | S-M (~250) | P6 |
| B1 | Scroll back, option 1: keep the link busy in the scroll direction | M (~300) | P4, P7 |
| B3 | Scroll back, option 3: never a wall (nearest held frame, exact landing) | S-M (~200) | B1 |
| N | Design note: synchronized Compare playback over SSH | S (doc) | P4 |

**Merge points.** M0: `fix/frame-step-coalesce` (changes `seekTo` coalescing in player-unified.js) and
`fix/engine-failure-states` (end-of-file / failure handling in engine.js and src/native.js) are merged; P1 starts from
that `main`, because its `superseded` and `failed` events sit exactly on those paths. M1: P1 merged → P2 and P5 run in
parallel worktrees (P2: player-unified.js; P5: src/stream.js + test/vscode). M2: both merged → P3 → P4 strictly
sequential (same files). P6 can be built in a parallel worktree any time (new files plus one hook in extension.js) but
merges after P4 in the agreed order; P7 after P6. B1/B3 after P7 (fills use the kept-running decoder). C and N have no
code conflicts with the track. Option 2 (scrub tier at quarter size) is planned only if measurements after B3 still show
a wall.

### S0. Flaky-test fix batch + rule (S)

- Each test the review confirmed as flaky: reproduce the race deterministically first (virtual clock
  `test/lib/virtual-clock.js`, or forcing the losing order), then fix the test or the product, whichever is wrong.
- AGENTS.md, Rules → Testing: layer-3 waits are *mark → act → wait for that act's result*; no fixed sleeps, no counters
  or "anything since start" conditions. Same rule in docs/TESTING.md, with a check where possible.
- `test/vscode/lib.js`: `P.after(act, pred)` on `vs.mark()` + `waitState` (only log lines and state after the mark count).
- Layer 3: only the fixed scenarios, each run a few times.

### C. Packet cache 128 MB, Compare total (S)

- `package.json` (`liveTranscodeCacheMB` default and text: about two minutes of 1080p), `src/settings.js` `cacheMB`
  default (both 64s), `src/extension.js` `packetCacheMB` (per tile: `min(setting, 512 / tiles)`, recomputed when tiles
  change), `media/packet-cache.js` trims when its budget shrinks. Sound shares the video's budget (no own budget).
- Tests first: settings default 128; a pure share helper (1, 4, 9 tiles); `test/unit/packet_cache_test.js` lowering
  the budget evicts oldest GOPs first, never the shown one.
- Docs: docs/commands-and-settings.md, CHANGELOG. Layer 3: `remote_stream_packets`, `compare_link`.

### P1. Request log + engine events (M)

- New `media/request-log.js` (page script order in `src/unified-html.js` and `test/engine/harness.js`). Engine emits
  next to today's fields from `seekAbs`, `seekFromPackets`, `seekTime`, `stepFrame`, `flushStep`, `stepBack`, `play`,
  `pause`, `showQuick`, `showQueued`, `onSharpFrame`, `takeHeld`, `notePlayStart`, and the worker `'seek'` posts.
  `requestShim(p)` in player-unified.js for frame-player.js and native. `media/debug-probe.js`: `requests` action.
  Debug check: at most one host seek pending per request id (logs and counts in the debug build). Nothing consumes the
  events yet.
- Tests first: `test/unit/request_log_test.js` (ordering, supersede, status, ring buffer); `test/engine/requests.js` on
  the real engine harness: a paused seek emits `accepted → source → picture → landed`; coalesced steps emit `superseded`
  for all but the last; read-ahead after `landed` emits nothing; a decode error / end before the target emits `failed`;
  `test/host/debug_probe_test.js` for `requests`.
- Layer 3: `seeking`, `playback`, `wheel_step`, `remote_stream_packets` (unchanged behaviour).

### P2. Ring and pulse from status (S)

- player-unified.js: `waitingTiles`, `owesFrame` go; the ring reads status; the pulse (`tilesSettled`) = every visible
  tile landed. `setLoading` / `loadingAfter` in player-ui.js unchanged.
- Tests first (`test/host/player_unified_test.js`): read-ahead after `landed` never holds the ring (bug 3); Compare
  pulse waits for the slowest visible tile, ignores a tile outside its clip; the cached-sound play path still offers
  page sound (bug 4 lock).
- Layer 3: `ui`, `compare_ui`, `seeking`, `remote_stream_play_during_seek`.

### P5. Host `src` + layer-3 on events (S)

- `src/stream.js` `seek()`: `'seeked'` gets `src: history | history-held | warm | spawn`; engine maps it to `source`.
  `test/vscode/lib.js`: `P.waitRequest(id, status)` over `requests`. `remote_stream_packets`,
  `remote_stream_play_during_seek` and `remote_slow_link` assert on event sequences and `landed.ms` / `sound.ms`
  instead of log regexes and trace sampling; `trace` stays for DOM latency only.
- Tests first: `test/host/stream_transition_test.js`, one `'seeked'` per source kind.
- Layer 3: `remote_stream`, `remote_stream_packets`, `remote_stream_play_during_seek`, `remote_slow_link`.

### P3. `t.req` and the single-tile rules (M)

- player-state.js: `seekFrame`, `stepFrame`, `togglePlay` (+ `scrub`) allocate ids and set `t.req`. player-ui.js:
  readout and bar render `t.req.frame`; drag sends `scrub`. player-unified.js: `pump` gated on `landed`; `busy()` guard
  goes. engine.js: `play({ id, fromT })`; the `localGen === gen` start rule in `play()` goes. Split: the readout / seek
  bar / drag code moves out of player-ui.js into a `player-ui-*.js` module (Layer 1B pattern) in the same PR.
- Tests first: `test/host/player_state_test.js` every input sets `t.req` and moves `frame` synchronously;
  `player_ui_test.js` readout = `t.req.frame` until `landed`, and follows the slider during a drag (bug 5);
  `player_unified_test.js` play during a loading seek never moves the bar back (bug 1); `test/engine/requests.js` play
  during a pending cached seek starts from `fromT` (bug 2).
- Layer 3: `seeking`, `playback`, `wheel_step`, `seek_preview`, `ui`, `folder-rail`, `remote_stream_play_during_seek`.

### P4. Compare on requests (M)

- player-unified.js: `request()` fan-out per tile via `targetOf`; `reconcile` from each tile's log; `sought` goes; one
  re-issue for a tile landed on the wrong frame; cached-sound handoff keyed on `source: packets`. Split: fan-out, status
  map, ring/pulse and reconcile move to a Node-loadable module (`media/player-requests.js`) with its own test file.
- Tests first: tile outside its clip counts as landed; wrong-frame landing → one re-issue, then `failed`; sound
  handoff only on a `packets` source; followers follow the clock tile (`setFollowerMode` unchanged).
- Layer 3: `compare_ui`, `compare_link`, `compare_burst`, `multiview`, `ui`, `remote_stream_play_during_seek`.

### P6. Pipeline probe (M)

- New `src/pipeline_probe.js`, `src/probe-media/` (+ generator and licence line), hook after `ff.locateTools` in
  src/extension.js (skipped when `transcode` is `off`), `lowerPriority`, `gpu-sessions.js`; argv from
  src/transcode_args.js. Record written, not yet used.
- Tests first (`test/host/pipeline_probe_test.js`, fake `run`): chain order and pruning by `gpuFilters` / encoder list;
  libplacebo only in the kept-running form; key invalidation per field; no run when `transcode` is `off`; failures
  passed in from an earlier ladder skip those chains.
- Layer 3: new `pipeline_probe` case (fresh key → record written in the background); `startup` (first open not slowed).

### P7. Opens use the record (S-M)

- `transcodeOptions` passes the class's first chain; `src/stream.js` exit handler: next known chain at once, in-memory
  bad mark, background re-probe, persist on a repeated failure; `warmFailed`: chain failure before the first frame vs
  one retry otherwise. "Re-check GPU pipeline" command (package.json, docs/commands-and-settings.md, CHANGELOG).
- Tests first (`test/host/pipeline_probe_test.js`, `stream_transition_test.js`): runtime failure → next chain with no
  extra start; transient failure not persisted, repeated one is; kept-running decoder: one retry, then off.
- Layer 3: `hdr_output`, `remote_stream_hdr`, `remote_stream_fallback`, `remote_stream`, `pipeline_probe`.

### B1. Scroll back keeps the link busy (M)

- The fill behind the paused frame runs dry on a long scroll back (on a 1 Mb/s link full-quality 1080p carries about
  0.25-0.5 s of video per second; the user scrolls about 1 s per second). engine.js fill: ask for the next fill before
  the current one ends, hold the forward read-ahead while scrolling back, keep filling further back when idle (budget in
  seconds, within the packet cache); src/stream.js: fills through the kept-running decoder (no ffmpeg start each).
- Tests first: `test/host/stream_fill_test.js` (fills reuse the kept-running decoder; next fill asked before the
  current ends); a link-simulator rig (`slow-ssh`) measuring seconds of video ready per second of scrolling, before and
  after.
- Layer 3: `remote_slow_link`, `remote_stream_packets`, `wheel_step`.

### B3. Never a wall (S-M)

- While the fill is behind, superseded steps show the nearest held frame (or skip), bar and frame number stay exact,
  the last request lands exactly when the scroll stops (engine `stepBack` / `stepTo`).
- Tests first: link-simulator rig: a continuous step-back on `slow-ssh` never shows a frozen picture longer than the
  budget and lands on the exact last frame.
- Layer 3: `remote_slow_link`, `wheel_step`, `seeking`.

### N. Compare over SSH, synchronized playback (design note)

docs/notes/: a shared clock that holds all tiles until each has the next frame, per-tile buffering targets so the
slowest link sets the pace, how the link budget is split among tiles. Written after P4, from its measurements.

## 8. Decisions (maintainer, 2026-11-27)

1. libplacebo only in the kept-running decoder; per-seek ffmpeg starts use OpenCL/CPU tone-mapping. P6 compares one
   frame from both.
2. An open before the probe has finished uses today's ladder; its failures feed the probe.
3. Probe in the background right after ffmpeg is found, on every machine including remote hosts, unless `transcode` is
   `off`.
4. A probed chain failing at runtime: next known chain at once, background re-probe, persist only a repeated failure.
   Kept-running decoder: one retry before off for the video.
5. Compare: the seek-bar pulse and "landed" wait for every visible tile.
6. Scroll back: option 1 first, then option 3; option 2 (scrub tier) only if measurements still show a wall.
7. Packet cache default 64 → 128 MB (any time), plus a total cap across Compare tiles (~512 MB); no separate sound
   budget.
8. Synchronized Compare over SSH gets its own design note after P4.
9. Order: S0 → P1, P2, P5 → P3, P4 (splitting player-ui.js / player-unified.js) → P6, P7 → B1 → B3 → N.
10. A fix batch with failing tests first (S0).
11. AGENTS.md rule + layer-3 helper: mark → act → wait for that result; no sleeps or overall counters as starting
    conditions (S0, `P.waitRequest` in P5).
12. Engine debug check that each seek has at most one pending request to the host (P1).
