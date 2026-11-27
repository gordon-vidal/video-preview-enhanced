# Responsive requests: one owner for "where am I, has it arrived", and a pipeline known before the first open

Status: design, 2026-11-27. Not built. Two root causes the maintainer approved fixing; each half can ship alone.

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
device failed 3 times (≈0.9-2.3 s on the first HDR open; `9e0c56d` cut it to once, remembered per tools check);
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

| Event | Fields | Emitted by |
| --- | --- | --- |
| `accepted` | `id, gen, t` | `seekAbs`, `seekTime` served from the queue, `stepBack`, `play` — synchronously, in the input's task |
| `source` | `id, from: 'decoded'\|'queue'\|'packets'\|'host-history'\|'host-history-held'\|'host-warm'\|'host-spawn'` | page paths at once; host paths on `'seeked'` (new `src` field from `seek()` in stream.js) |
| `picture` | `id, quality: 'quick'\|'full', t` | `showQuick`, first `present()` of the request's gen |
| `landed` | `id, frame, t, ms` | paused: the frame equal to the target is shown (`seekTarget` cleared at it); playing: `playbackPhase()` leaves `loading`/`seeking` |
| `sharp` | `id, frame` | `onSharpFrame` drawn |
| `sound` | `id, from: 'page'\|'host', t, ms` | `takeHeld` / first queued audio covering the play position (`notePlayStart`) |
| `superseded` | `id, by` | a newer request on the same decoder before `landed` |
| `failed` | `id, why` | decode error, host `fail`, request dropped on hide/dispose |

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
- *Coalescing* (steps, wheel, key repeat): each input gets its id and the pure state moves `frame` at once; the engine's
  existing coalescing (`stepTo`, `STEP_SEEK_MS`, `REMOTE_STEP_QUIET_MS`, host `SEEK_QUIET_MS`) stays, and reports
  `superseded {id, by}` for the ids it folds. Only the newest id can land; consumers only ever look at `t.req.id`.
- *Compare*: one tab request fans out to N decoders. A tile outside its clip has status `none` (counts as landed). The
  ring is per tile (as today); the seek-bar pulse and lockstep "tab landed" = every visible tile landed. The clock tile's
  `landed` releases the bar for a play request; followers follow its clock (`setFollowerMode`, unchanged). `reconcile`
  reads each tile's last request target from its log instead of `sought`; a paused tile that `landed` on another frame
  than its target gets the same id re-issued (one retry, then `failed`).
- *Remote*: the wire keeps `gen` (host needs nothing new except `src` on `'seeked'` and the existing `have`); the engine
  maps `gen → id`. A playing seek is a `seek` request with `playing: true`, landed when its first frame shows and the
  clock re-anchors.
- *Other decoders* (`media/frame-player.js`, native): a shim (`requestShim(p)` in player-unified.js) emits the same events
  from today's fields until each is migrated; consumers do not branch.

## 3. Ownership and migration

| Layer | Owns | Stops doing |
| --- | --- | --- |
| player-state.js | `t.req` (id, kind, frame, playing, at); `seekFrame` / `stepFrame` / `togglePlay` allocate ids | — |
| player-ui.js | renders `t.req.frame`; `setLoading(ids)` unchanged | reading decoder time during a drag |
| player-unified.js | fan-out (`request()` per tile), status map from events, ring, pulse, reconcile | `seekPending`, `owesFrame`, `waitingTiles` heuristics, `sought`, the `busy()` guard in `pump` |
| engine.js | decode internals (`seekTarget`, `pauseT`, `shownT` stay private) + `RequestLog` | `localGen` as play's start rule; `syncState()` as a public readiness API |
| stream.js | `'seeked'.src` | — |

`settled()` stays, for the frame loop's rest only. `endedAt` stays (end-of-clip, not a request).

## 4. Pipeline capability probe

New `src/pipeline_probe.js` (pure selection + an injected `run`), beside `src/transcode_probe.js`, same storage pattern
(`globalState` record, in-memory promise, last 20 keys).

- **When.** In the background after `ff.locateTools` succeeds (`src/extension.js`), at low priority (`ffmpeg.js`
  `lowerPriority`), one ffmpeg at a time, holding a GPU session (`src/gpu-sessions.js`); on a remote host it runs in the
  remote extension host where ffmpeg runs. Never on the open's critical path (see open question 2).
- **What.** Whole chains, each `ffmpeg -frames:v 3` on tiny bundled inputs (new `src/probe-media/`: 320x180 H.264 8-bit and
  HEVC Main10 PQ, 3 frames, a few KB, generated, MIT): decode {NVDEC (`cudaDecodeDownload` / full CUDA), QSV, CPU} ×
  tone-map {libplacebo with `-init_hw_device vulkan`, OpenCL, QSV/VA-API, CPU zscale} × encode {NVENC, QSV, AMF, MF,
  libx264/OpenH264}, pruned by `gpuFilters` and the encoder listing, tried in today's preference order, stopping at the
  first working chain per class (`sdr`, `hdr`) plus the next two as fallbacks. Args come from
  `buildVideoPipeline` / `buildHdrPipeline` (no second copy of the argv logic). One run also tries the kept-running
  form (MPEG-TS on stdin, `args(..., { warm: true })`) for the chosen chain. Each result records start-up ms and fps.
- **Record.** `{ ver, key, at, chains: { sdr: [chain...], hdr: [chain...] }, warm: bool, failures: {chain: stderr tail} }`;
  a chain is `{ decode, tonemap, encoder, device, startMs, fps }`.
- **Key / invalidation.** `hostname | ffmpeg path | ffmpeg version + size + mtime | GPU adapters (name) | driver versions
  (NVIDIA from `machine()`, others from the OS adapter list) | PROBE_VER`. Any change → re-probe in the background; the
  old record is not used. A "Re-check GPU pipeline" command clears it.
- **Use.** `transcodeOptions` passes the first chain of the class; `EncodedStream` builds from it (`decodeMethod`,
  `badTonemap` preset to the skipped kinds, `encoder`). No probe yet → today's ladder.
- **Runtime failure of a probed chain.** The stream moves to the record's next chain at once (no blind ladder), the
  chain is marked bad *in memory* for this key, and a background re-probe of it decides whether the record changes
  (transient: a busy GPU, out of sessions, does not demote it). Kept-running decoder: a failure before its first frame
  is the chain's (as `9e0c56d`); a protocol failure (segment checks) retries once, then off for that video.

## 5. Reuses vs. Introduces

| Reuses | Introduces |
| --- | --- |
| `gen` on the wire, `'seeked'`, `have` / `skipHeld` | `media/request-log.js` (pure, ~150 lines): events, status, ring buffer |
| `targetOf`, offsets, `setFollowerMode`, `reconcile`'s structure | `t.req` in player-state.js |
| `setLoading` / `loadingAfter`, the ring and pulse CSS | `request()` per tile + `requestShim()` in player-unified.js |
| engine coalescing (`stepTo`, quiet timers) | `src` on `'seeked'`; `engine.play({ id, fromT })` |
| `transcode_probe.js` cache pattern, `probeEncoder`, `machine()`, `gpuFilters`, `buildVideoPipeline` | `src/pipeline_probe.js`, `src/probe-media/` (2 tiny clips) |
| `gpu-sessions.js`, `lowerPriority`, debug-probe `trace` | debug-probe `requests` (event log with page times); test helper `vs.waitRequest` |

Pushback checked: no second copy of the pipeline argv; no new DOM syncing (ring and readout stay controller-rendered);
nothing works around an AGENTS.md limit.

## 6. Risks

- **Two truths during migration.** Events and old fields can disagree. Mitigation: debug builds assert in `tick()` that
  the shim's status and the engine's events agree; consumers move one at a time.
- **A missing `landed`** leaves the ring up forever. Every request ends in `landed`, `superseded` or `failed`; hide,
  dispose and a new gen supersede; a debug watchdog logs requests open > 10 s.
- **Probe false positives**: 320x180 passes where 4K fails (VRAM, NVENC level limits). Runtime fallback stays; the
  record notes the size probed.
- **Probe cost** on first run ≈ 3-8 s of background GPU/CPU, more with Vulkan; on a laptop on battery it is visible.
- **Remote globalState** lives with the remote extension host; the hostname in the key keeps machines apart.

## 7. Test plan (events at public boundaries)

- *Layer 1-2* (`node test/run.js unit engine`): `test/unit/request_log_test.js` (ordering, supersede, status);
  player-state: every input sets `t.req` and moves `frame` synchronously; player-ui: fake events → ring after 150 ms,
  readout = `t.req.frame` until `landed`; engine with the fake worker: `seekFromPackets` emits `accepted, source packets,
  picture full, landed`; play during a pending seek starts from the request's `fromT`; read-ahead after `landed` emits
  nothing; coalesced steps emit `superseded` for all but the last. `test/host/pipeline_probe_test.js`: chain order,
  key invalidation, runtime failure → next chain, transient failure not persisted (fake `run`).
- *Layer 3*: `remote-stream-packets` and `remote_slow_link` read `p.ask('requests')` and assert on sequences and page-timed
  deltas (`landed.ms`, `sound.ms`) instead of log-line regexes and trace sampling; `trace` stays only for DOM latency
  (bar/readout move in the input's frame). New `pipeline-probe` case: fresh key → record written in the background,
  first HDR open with zero failed starts in the host log.

## 8. Phases (each merges alone)

| # | Phase | Size |
| --- | --- | --- |
| 1 | `request-log.js` + engine emits events next to today's fields; shim; debug-probe `requests`; engine-layer tests | M (~400) |
| 2 | Ring and pulse from status (`waitingTiles`, `owesFrame` go) | S (~150) |
| 3 | `t.req` in pure state; readout/bar/drag from it; `pump` gated on `landed`; `engine.play({id, fromT})`, `localGen` rule goes | M (~350) |
| 4 | Compare: fan-out, reconcile from the logs, `sought` goes; cached-sound handoff keyed on `source` | M (~300) |
| 5 | Host `'seeked'.src`; layer-3 cases migrate to events | S (~200) |
| 6 | `pipeline_probe.js` + probe media + background run + record (selection not yet used) | M (~400) |
| 7 | Opens use the record; ladder becomes "next known chain"; warm retry rule; re-check command | S (~200) |

Phases 1-5 and 6-7 are independent tracks.

## 9. Open questions for the maintainer

1. libplacebo works only with `-init_hw_device vulkan`, about +0.8 s on every ffmpeg start (each seek without the
   kept-running decoder). Prefer OpenCL/CPU tone-mapping for per-seek starts and use libplacebo only in the
   kept-running decoder (recommended), or always prefer libplacebo's quality?
2. First open before the probe has finished: use today's try-and-fall-back ladder (recommended), or wait up to ~1 s
   for the probe of the needed class?
3. When to probe: in the background right after ffmpeg is found, on every machine including remote hosts (recommended,
   unless `transcode` is `never`), or only once the first file that needs Live transcode is opened?
4. A probed chain failing at runtime: move to the next known chain and re-probe in the background, persisting only a
   repeated failure (recommended), or persist it as bad at once? And the kept-running decoder: one retry before off
   for the video (recommended), or off at the first failure as today?
5. Compare: the seek-bar pulse and "Compare landed" wait for every visible tile (recommended), or only the clock tile?

## 10. Queued with this plan (maintainer, 2026-11-27)

Agreed in discussion and queued behind phases 1-7, so the work merged now stays as it is:

- **Scroll back keeps up** (the fill behind the paused frame runs dry on a long, continuous scroll back; on a 1 Mb/s link
  full-quality 1080p carries about 0.25-0.5 s of video per second, the user scrolls about 1 s per second):
  1. Keep the link busy and follow the direction: ask for the next fill before the current one ends, run fills through
     the kept-running decoder (no ffmpeg start each), hold the forward read-ahead while scrolling back, and when idle go
     on filling further back (a budget of seconds, within the packet cache).
  2. A scrub tier on slow links: while scrolling fast, fill at a quarter size and lower quality (about 4x the video per
     byte); the frame the user stops on comes sharp (existing sharp frame). Needs the packet cache and the page to hold
     two sizes side by side (today a GOP of another size drops the others).
  3. Never a wall: when the fill still falls behind, show the nearest held frame (or skip frames) while the scroll goes
     on, and land exactly when it stops. Bar and frame number stay exact. Fits the request model: `superseded` steps
     need no picture, only the last one `lands`.
- **Bigger, more configurable packet cache:** default 64 MB -> 128 MB per video, and say in the setting how much
  that holds (about two minutes of 1080p); consider a total budget across Compare tiles and a separate budget for
  the cached sound.
- **Synchronized playback in Compare over SSH:** every tile's frame on screen in step with the others while playing
  on a remote link (today each tile's stream buffers and stalls on its own). Needs its own design note: a shared
  clock that holds all tiles until each has the next frame, per-tile buffering targets so the slowest link sets the
  pace, and how the link budget is split among tiles.
