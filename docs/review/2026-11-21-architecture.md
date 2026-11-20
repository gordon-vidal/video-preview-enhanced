# Architecture review: 2026-11-21

## 1. Summary

- Overall: keep the architecture; reduce the large orchestration objects before adding more features.
- Risk 1: engine timing, queues, rendering and backends share 225 referenced instance properties.
- Risk 2: page reload and cancellation rules differ between player, compare and network readers.
- Risk 3: closing a non-range HTTP download can leave a block read waiting forever (reproduced).
- Risk 4: player and compare repeat transport/UI policy, so fixes can reach only one view.
- Risk 5: worker errors and large untyped messages have uneven validation and recovery.
- Recommendations 1-2: fix cancellation/ownership first; define and validate the message contracts.
- Recommendations 3-4: extract engine services and host session services in small steps; share small UI policies.
- Recommendation 5: keep plain JS and no build for now; add checked JSDoc at the boundaries.
- A whole-extension rewrite has no demonstrated payoff; preserve the decoder, transport and test investments.

## Scope and measurement

Reviewed the source snapshot at `6b46e0e62bc5aa808562933425198b4620c4870d` on branch
`review/architecture`, on 2026-11-20. The report uses the requested next-day filename.
Read the project instructions, product/testing docs, skimmed the design notes, and inspected the
26 top-level host JS files, 22 top-level media JS files and test architecture. Generated decoder
internals were excluded. This is a source review plus one small HTTP lifecycle reproduction;
it is not a security audit or a new playback/performance benchmark.

Sizes below count physical lines, including comments and blanks, excluding trailing whitespace-only
lines. Function spans came from Acorn's AST, using Node's existing internal parser without installing
packages. Spans include nested functions. Property counts are distinct `this.name` references inside
each class, including method references, rather than counts of live fields or a complexity score.
Relative `require()` calls give 48 static edges; 24 originate in `src/extension.js`. This excludes
browser globals, callbacks, worker messages and dynamic calls. The static relative-require graph is acyclic.

| Area | Files | Physical lines |
|---|---:|---:|
| Host, `src/*.js` | 26 | 9,174 |
| Page/worker scripts, `media/*.js` | 22 | 13,711 |
| Combined, excluding prebuilt libav | 48 | 22,885 |

| Large file | Lines | Large function/method, start line | Span |
|---|---:|---|---:|
| `src/extension.js` | 2,687 | `activate`, 1030; `openUrlPage`, 1914 | 257; 113 |
| `media/engine.js` | 2,455 | `createEngine`, 23; `LibavPlayer.tick`, 1815 | 2,433; 117 |
| `media/compare.js` | 2,153 | page IIFE, 28; scan `loop`, 1815 | 2,126; 54 |
| `media/player.js` | 1,530 | page IIFE, 3; `debugProbe`, 1289 | 1,528; 181 |
| `media/decoder-worker.js` | 1,146 | `segStep`, 609 | 60 |
| `src/urlsource.js` | 927 | `parseM3u8`, 381 | 76 |
| `src/remotestream.js` | 789 | `encoderFor`, 157; `answer`, 609 | 41; 40 |
| `media/xray.js` | 752 | `createXray`, 20; `drawBase`, 369 | 733; 110 |

The four largest files contain 8,825 lines, about 39% of these sources. A closure factory's size
does not mean every operation in it is a long function: compare's largest ordinary functions are
much smaller than its IIFE. The engine is a stronger concentration: `LibavPlayer` has 119 methods
and 225 referenced properties. Host `Session` has 53 methods/100 properties; `CompareSession`
21/50; `NativeDecoder` 29/73; `RemoteStream` 35/81.

## 2. Architecture as built

```text
VS Code commands / custom editor / URI handler
  -> extension.js: settings, setup, Session, decoder decision, export
     -> compare.js: CompareSession (separate replacement panel)
     -> file/AVI/sequence readers OR urlsource HTTP/HLS virtual file
     -> ffmpeg/probe/sniffers/decide -> NativeDecoder OR RemoteStream

Session / CompareSession <-> VS Code webview messages <-> player.js / compare.js
  -> createEngine(env) -> LibavPlayer per video -> canvas + audio clock
       -> decoder-worker.js, optionally behind DecoderPool
          -> separate libav WASM instances: demux + software decode
       -> WebCodecs: H.264/VP8 picture; supported audio
       -> native worker-shaped adapter -> host ffmpeg
          -> local raw frames: token/origin-protected HTTP or WebSocket
          -> fallback raw frames/audio: webview messages
          -> remote: H.264 packets + PCM messages -> page WebCodecs
  -> controls/picture/inspect/scopes/tracks/subtitles/xray/thumb services
```

Entry wiring is at `src/extension.js:1030`; sessions at `src/extension.js:1431` and
`src/compare.js:84`. Decoder selection is pure policy in `src/decide.js:174`; local/WSL eligibility
is in `src/extension.js:413`. SSH streaming is a separate backend, selected at
`src/extension.js:2257`. Compare reuses the engine, shared bar and controls, rather than maintaining
another decoder (`media/compare.js:141`, `src/bar.js:14`, `media/controls.js:204`).

### Message flow and ownership

| Boundary | Main requests | Replies/data | Correlation |
|---|---|---|---|
| Page to host | `ready`, `readBlock`, `frames`, `thumb`, `nd`, `pref`, actions | `libav`/`frames`, `block`, `frame`, `thumb`, `subs`, `prefs`, `error`, `visible` | block position; thumb/export ID; host load generation |
| Compare to host | `ready`, `readBlock`, `nd`, `tileSize`, add/replace/remove/leave | `open`, `block`, `nd`, `resize`, `visible` | page ID, tile key, host epoch |
| Engine to worker/backend | `init`, `open`, `config`, `more`, `seek`, `recycle`, track selection | `streams`, `configured`, `batch`, `seeked`, `read`, subtitles, `error` | seek `gen`; pool reader `rid` and segment `sid` |
| Native raw data | credits via `nd`/`more` | top-level `ndv`, `nda`, or 40-byte binary records | generation; channel per decoder |
| Remote stream | `more`, `seek`, `remoteLink`, `hidden` | H.264/PCM `batch`, stream facts, notices | generation and flow-control state |

This is a selected vocabulary, not a complete enum. Dispatch sites are
`src/extension.js:1711`, `src/compare.js:185`, `media/player.js:1105`,
`media/compare.js:1937`, `media/engine.js:668`, `media/decoder-worker.js:66`,
`src/native.js:121` and `src/remotestream.js:244`. The `nd` envelope lets the page use a worker-like
backend interface (`media/engine.js:529`). Pooling adds an independent scheduling protocol
(`media/pool.js:84`). The raw-frame wire layout is written in `src/frameserver.js:63` and read
again in `media/framestream.js:18` and `media/framestream.js:53`.

## 3. Findings

Severity: **high** means prioritize before extending the area; **medium** means a bounded bug or
maintenance risk; **low** means cleanup. Structural risks below are not claims of reproduced playback
failures. Confirmed behavior is identified explicitly.

### Structure, coupling and state

**A1 — High: the engine is the main refactoring target.** `createEngine` contains GL rendering,
decoder loading, file-block caching, codec negotiation, queues, audio scheduling, seek/loop state,
native transport recovery, subtitles, thumbnails, HDR and speed advice. Examples:
`media/engine.js:51`, `media/engine.js:329`, `media/engine.js:580`, `media/engine.js:718`,
`media/engine.js:977`, `media/engine.js:1145`, `media/engine.js:1815`, `media/engine.js:2295`.
`tick()` mixes presentation with slow-playback policy and audio clock correction. The 225-property
surface makes ownership hard to see even though many methods are short. Extract by ownership and
state, starting with block reads and transport, rather than cutting the file into arbitrary chunks.

**A2 — High: the host entry point is also the session/application service.** Its 24 relative imports
reach installation, hardware, decoder choice, UI markup, settings, file/network access and exports
(`src/extension.js:11`). `Session.openUrlPage` joins network inspection, variant choice and decoder
selection (`src/extension.js:1914`); activation includes extensive test-hook dispatch
(`src/extension.js:1177`). Module state includes sessions, last-active session, hardware/tools
promises, failed codecs, offers and pending URI navigation (`src/extension.js:39`). These have
different lifetimes but one module owner. Extract preferences/setup services and page-session
orchestration; keep the entry point as registration/composition. The import graph itself is not cyclic.

**A3 — Medium: compare depends on engine internals beyond its factory interface.** It wraps disposal
and renderer operations to retain frames for matching/pixel analysis (`media/compare.js:184`),
replaces follower clocks (`media/compare.js:331`), and checks engine state to settle synchronized
steps (`media/compare.js:286`, `media/compare.js:435`). This works with the present engine but makes
changes to frame retention and clock semantics cross-file changes. Provide explicit frame capture,
external-clock and settled-state interfaces before moving those internals. Avoid a broad event bus.

**A4 — Medium: globals are mostly page-scoped, but dependency lists are implicit.** Host CommonJS
modules generally expose small APIs. Page modules rely on ordered script tags and globals
(`src/compare.js:70`, `src/extension.js:1658`); the engine's injected `env` still needs browser and
helper globals (`media/engine.js:23`, `media/engine.js:329`, `media/engine.js:426`). Compare's host
module also stores its injected VS Code API and session registry at module scope
(`src/compare.js:10`). Make these dependencies explicit at service creation. A module loader is
optional; the existing dual browser/CommonJS helpers already demonstrate a no-build route
(`media/controls.js:616`, `media/inspect.js:639`).

### Duplication

**D1 — Medium: player/compare repeat policy around a shared engine.** Time formatting remains local
in compare (`media/compare.js:113`) while player uses `media/timefmt.js:8`. Both pages implement
announcements/toasts (`media/player.js:89`, `media/compare.js:84`), restful frame-loop wakeup
(`media/player.js:357`, `media/compare.js:1889`), jumps, state saves, shortcuts and preference wiring.
Host block-file open/read logic is nearly the same at `src/extension.js:2294` and `src/compare.js:362`.
Share the pure formatting and a cancellable block reader first. Extract loop scheduling only after
the two rest predicates and visibility cases are tested; the predicates legitimately differ.

**D2 — Medium: native and remote streaming duplicate lifecycle, not payload semantics.** They share
15 method names including constructor, `open`, `startAt`, `prepareLoop`, `takeStandby`, `more`,
`seek`, `kill` and `dispose` (`src/native.js:121`, `src/remotestream.js:244`). Both manage ffmpeg,
standby processes, generations and queued output. But native sends raw YUV with credits and socket
backpressure (`src/native.js:516`); remote retains compressed history, batches audio and adapts a
link ladder (`src/remotestream.js:469`, `src/remotestream.js:609`, `src/remotestream.js:677`).
A shared process/standby owner could help. One generalized streaming class would hide important
differences and likely make recovery harder. Method overlap alone is not a duplicate-line percentage.

### Lifecycle and disposal

**L1 — Medium, confirmed: non-range HTTP close does not settle waiting readers.**
`HttpFile.startWhole` wakes waiters on data/end/error, and `read` waits on that list
(`src/urlsource.js:288`, `src/urlsource.js:303`). `close` only destroys the response
(`src/urlsource.js:324`); it neither stores a cancellation error nor wakes waiters, and there is no
response-close handler there. A local fixture sent 1 of 128 declared bytes; a read for 100 bytes
waited; closing the file destroyed the response but left the read pending, one waiter retained and
no stored error. This was observed after yielding to the event loop, with a short functional deadline;
it is not a performance measurement. Reproduction used the exported `HttpFile` and a Node HTTP server,
without modifying product code. Set a closed error, wake all waiters, and reject new reads.

**L2 — Medium: network cancellation is incomplete beyond that bug.** `HttpFile` range reads do not
check `closed`; `HlsFile.close` only clears keys (`src/urlsource.js:303`, `src/urlsource.js:777`).
The request helper supports a signal (`src/urlsource.js:149`), but URL opening creates ordinary
network options (`src/extension.js:1916`, `src/extension.js:977`), and session close only calls the
file's close method (`src/extension.js:2666`). Load-generation checks prevent stale publication;
they do not cancel requests already running. Give each page-load attempt an AbortController and
pass its signal through inspection, HLS planning, segment/key reads and range reads. Remove signal
listeners after each request; `open` currently adds one without completion cleanup.

**L3 — High structural risk: page identity is not a common invariant.** Compare stamps outgoing
messages with `cfg.page`, rejects old page messages before dispatch, and checks epochs after awaits
(`media/compare.js:31`, `src/compare.js:116`, `src/compare.js:185`). Single-player messages have no
page ID (`media/player.js:1105`, `src/extension.js:1711`). Host reload increments `loadGen`, and
many async reads/opens correctly check it (`src/extension.js:1583`, `src/extension.js:1798`,
`src/extension.js:2305`), but an old inbound message dispatched after reload captures the new
generation. That is a guard asymmetry, not a reproduced cross-page failure. Standardize page ID,
seek generation, request ID and tile/reader ID as different concepts. Test old `ready`, block, native
and export messages against a newly loaded page.

**L4 — Medium: explicit cleanup is uneven.** The engine closes workers, audio, frames and blobs
(`media/engine.js:2432`); compare has pagehide cleanup and explicitly releases GL contexts
(`media/compare.js:1874`). The single-player page has no equivalent pagehide disposal call;
`begin` replaces its player reference without disposing a predecessor (`media/player.js:427`).
Browser page destruction releases page resources, so this does not establish a permanent GPU leak.
There is a concrete host retention path: `lastActive` retains the last closed Session
(`src/extension.js:83`, `src/extension.js:2672`), whose native decoder disposal kills processes but
does not clear queued frames (`src/native.js:627`). Clear last-active ownership and heavy queues on
close. Add an idempotent page/session disposer, including export waiters (`src/extension.js:2464`)
and pending thumbnail work (`src/extension.js:1700`), with explicit cancellation rather than waiting
for their deadlines. Heap/VRAM growth has not been measured in this review.

### Errors and recovery

**E1 — Medium: worker failure reporting does not define a terminal state for every operation.**
The worker serializes commands and catches command failures (`media/decoder-worker.js:63`).
The engine logs all worker errors, shows specific overlays only for open/init, clears `requesting`,
then continues (`media/engine.js:702`). A failed seek/config/more therefore has no uniform outcome
contract: recover, fail pending action, or stop backend. Worker runtime errors show an overlay
(`media/engine.js:561`) but do not use a common teardown path. Return structured error codes with
operation/generation and define terminal versus recoverable cases. Keep deliberate fallbacks, such
as native transport recovery (`media/engine.js:1189`) and decoder fallback (`src/native.js:393`).

**E2 — Low: swallowed errors need ownership rules, not blanket removal.** Best-effort close errors
are reasonably ignored (`src/extension.js:2666`), and failed preference persistence is logged with a
globalState fallback (`src/extension.js:122`). In contrast, many async writes are fire-and-forget
(for example positions at `src/extension.js:1580`). Keep noncritical failures nonblocking, but funnel
them to bounded diagnostics and ensure pending requests settle. Page `unhandledrejection` logging
(`media/player.js:22`) is useful evidence, not recovery.

### Security boundaries

**S1 — Positive boundary; medium hardening priority: there are real defenses to preserve.**
Media-only resource roots and restrictive CSP limit page access (`src/extension.js:1461`,
`src/compare.js:43`). The localhost frame server binds loopback, checks a random token and exact
webview Origin, and permits one connection per channel (`src/frameserver.js:28`,
`src/frameserver.js:92`, `src/frameserver.js:141`). Native execution is trust-gated
(`src/extension.js:2124`, `src/extension.js:1155`); processes use argument arrays and hidden windows
(`src/ffmpeg.js:22`, `src/native.js:441`). These are architectural assets, not reasons to replace
the stack. I found no demonstrated command-injection exploit in this review.

Validation is distributed across handlers. Preferences use allowed values (`src/extension.js:1737`),
exports validate ranges (`src/rangecmd.js:75`), and thumbnails bound dimensions
(`src/extension.js:1705`). Local block requests cap length but do not first validate all numeric
fields (`src/extension.js:2305`, `src/compare.js:373`); malformed tile keys silently map to file A
(`src/compare.js:35`). Native handlers assume a shaped nested message (`src/native.js:121`).
Central validators should reject malformed envelopes, nonfinite times, invalid keys, oversized arrays
and excessive pending work before side effects. The browser is a separate boundary even when the
current CSP makes hostile message generation harder. This is defense in depth, not a claimed bypass.

**S2 — Medium: preserve the separate file/URL trust policies.** Local probes reject text manifests
disguised as video (`src/ffmpeg.js:124`, `src/ffmpeg.js:214`). URL inputs receive a network protocol
whitelist that excludes file access (`src/ffmpeg.js:153`). Typed URLs reject credentials and unsafe
schemes; redirects reject HTTPS downgrade (`src/urlsource.js:45`, `src/urlsource.js:127`).
HLS URLs/keys are fetched by the host, outside page CSP (`src/urlsource.js:381`,
`src/urlsource.js:692`); this needs to remain explicit in any extraction. Network-only protocols
do not imply public-address-only networking. No private-IP restriction is present in that HTTP
path; do not describe it as an SSRF-isolated service. Whether internal-network URLs should be
restricted is a product decision, not an assumed defect in an explicit Open URL feature.

Downloads use checksums before extraction (`src/setup.js:189`), and remote extraction validates
member paths and resulting files (`src/remoteff.js:95`). Keep these boundaries intact. macOS setup
selects an external GPL executable (`src/setup.js:103`), which the licence docs explicitly describe
as separate and never bundled (`docs/licences.md:7`); that is not evidence of a GPL bundled decoder.

### Testability and performance-sensitive paths

**T1 — Positive: meaningful lower-layer coverage already exists.** `test/layers.js:29` discovers
host tests and names pure unit targets; `test/layers.js:47` wires engine integration tests. Current
inventory is 68 unit files, 13 engine files and 23 scenario definitions. Engine tests execute real
WASM through the product engine, with fake GL/audio and ffmpeg picture comparisons
(`test/engine/harness.js:1`, `test/engine/harness.js:60`). This checks much more than isolated math.
It cannot prove browser WebCodecs support, real rendering, sound output or remote transport behavior;
the hidden VS Code scenarios are still necessary (`test/vscode/scenario_list.js:1`).

**T2 — Medium: integration seams expose too much implementation detail.** The engine harness
loads scripts through VM globals and substitutes Worker/AudioContext/GL (`test/engine/harness.js:24`).
The page ships substantial debug introspection (`media/player.js:1289`, `media/compare.js:2062`),
while host tests use a VS Code mock. These are useful existing seams; replacing them all would be
expensive. Extract service-level tests for cancellation, stale messages, fallback and queue ownership
as refactoring proceeds. Leave real codec and frame tests in place; add narrow contracts instead of
tests that merely match rewritten source text. CI currently checks JS syntax, not a type contract
(`.github/workflows/ci.yml:84`).

**P1 — Medium change risk, no new speed claim: byte movement and clocks matter more than file size.**
The critical paths are GL plane upload (`media/engine.js:175`, `media/engine.js:209`), audio queueing
and presentation (`media/engine.js:1401`, `media/engine.js:1815`), raw-frame backpressure
(`src/native.js:516`), frame buffer reuse (`media/framestream.js:53`), pool segment ordering/budgets
(`media/pool.js:520`, `media/pool.js:573`), block-cache eviction (`media/engine.js:633`), and compare
canvas uploads/composition (`media/compare.js:526`, `media/compare.js:985`).
Existing code has budgets, credits, transfer lists, lazy thumbnails and paused-loop rest; a rewrite
could easily lose them (`media/membudget.js:12`, `media/engine.js:2295`, `media/player.js:357`).
Keep buffer ownership explicit; do not insert JSON copying, broad per-frame state broadcasts or
extra canvas readbacks during modularization. No layer-4 run or timing benchmark was made here.

### Docs/code drift

**C1 — Low, concrete drift: navigation advice and architecture comments lag implementation.**
`package.json:621`'s `whenSlow` description still says to click the status pill; product direction says
there is no status pill (`docs/PRODUCT.md:98`). The opening comments in
`src/extension.js:4` say the host only reads files and all decoding is in the page, despite native
and remote ffmpeg. `src/setup.js:101` describes an automatic post-install probe, contrary to the
current explicit-only probe policy (`docs/PRODUCT.md:75`, `src/extension.js:230`).
Historical notes also contain old commands and discarded layouts; for example
`docs/notes/ux-modes.md` proposes an advanced-mode toggle, superseded by `docs/notes/ui-simple.md`.
Mark historical notes as superseded at the top instead of treating their plans as current contracts.

**C2 — Low: test authority is stated too broadly in PRODUCT.** `docs/PRODUCT.md:151` says only real
VS Code counts, whereas `docs/TESTING.md` explicitly allows engine correctness in Node and
`test/engine/harness.js:1` implements that. Clarify that browser/GPU/UI claims require VS Code;
pure logic/WASM correctness can be proven below it. The 65/13/21 table in TESTING is a dated measured
run, not today's inventory (68/13/23); keep that distinction when quoting counts.

## 4. Rewrite candidates

Effort is relative engineering scope, not a calendar estimate: S = a focused module/fix;
M = several modules and focused integration; L = a subsystem; XL = a broad behavioral migration.

| Candidate | What it fixes | Effort / migration risk | Recommendation and incremental alternative |
|---|---|---|---|
| Split `extension.js` | Mixed settings/setup/registration/session lifetimes (A2) | L / medium | Refactor incrementally. Move settings and offers first, then Session and export services behind injected VS Code/file APIs. Preserve command IDs and behavior. |
| Split `engine.js` | Shared state across caching, decoding, clock and renderer (A1) | L / high | Refactor incrementally: BlockReader, backend adapter, renderer ownership, then audio clock/scheduler. Keep the facade's seek/frame API stable and move state with its owner. Extracting only source text is insufficient. |
| Split `player.js` | Page wiring and shipped debug probes are mixed | M / medium | Move debug probes behind one explicit installer and move small pure policies. Keep DOM bindings at the page root. Do not redesign the UI as part of this. |
| Split `compare.js` | Layout/compositing, sync, menus and hidden scanning coexist | L / high | Extract sync coordinator and compositor contracts separately. Hidden metrics/scanner can become a debug-only service before changing synchronization. Preserve frame-matched paused stepping. |
| Shared message protocol | Untyped shapes, identity asymmetry, duplicate binary headers (L3/S1) | M / medium | Start with plain JS constants, JSDoc discriminated unions and validators. Load a small dual-target module in host/page/workers. Add page IDs before replacing dispatch switches. Keep hot binary payloads out of generic serialization. |
| Unify player and compare completely | Repeated page/UI policy (D1) | XL / high | Reject a full merger now. Shared engine/bar/controls already capture the costly common parts. Share formatting, jump policy, read ownership and lifecycle helpers; retain separate single-video and synchronized-view orchestration. |
| Unify native and remote stream | Process/standby lifecycle repetition (D2) | L / high | Reject one backend implementation. A small process-owner helper (M) may pay after cancellation tests. Raw frames and compressed history need different queues/flow control. |
| TypeScript migration | Incomplete static contracts (T2/S1) | L / medium-high | Start with checked JSDoc on messages, metadata and service APIs (M). Existing `@ts-check` comments alone are not a CI gate. Evaluate TypeScript after those seams stabilize; types do not replace runtime input validation. |
| Add a build/bundler | Implicit script order and shipped test instrumentation (A4/T2) | M / medium | No build required for the proposed extractions. Add a build only for a measured packaging/loading problem or an agreed TS/debug stripping need. Preserve replaceable libav files, CSP and worker URL behavior. |
| Replace decoder/render stack or rewrite extension | Would replace hard-earned codec and frame handling | XL / very high | Reject without a specific failing requirement and a comparable prototype. Present evidence identifies ownership/contract issues, not a fundamentally wrong codec stack. |

The only clear replacement-sized work is a small cancellable read/session ownership abstraction,
not a replacement player. It can be introduced behind the existing engine and host interfaces.

## 5. Suggested order

1. Fix L1 with a close-during-download regression. Specify what closing a reader does to every
   pending read; extend this to range/HLS cancellation (L2). Keep normal playback unchanged.
2. Give both panels the same page identity rules (L3). Add stale-request tests before routing messages
   through shared validators. Cover null/invalid envelopes and late native/export replies.
3. Make close idempotent and complete (L4): clear host ownership, heavy queues, thumbnail jobs and
   export waiters. Test repeated open/hide/show/reload/close without relying on a speed threshold.
4. Extract the duplicated host block reader, shared time formatting and preferences. These are small
   seams with existing unit-test patterns. Correct C1/C2 docs alongside the relevant follow-up changes.
5. Extract engine block cache and backend adapters, preserving buffer transfer and current facade.
   Define error outcomes (E1), then separate renderer and audio/clock state. One ownership boundary
   per change; keep the existing engine frame tests and matching hidden scenarios as gates.
6. Give compare explicit external-clock and retained-frame APIs. Extract synchronization/compositing
   only after those APIs reproduce lockstep behavior; leave full page unification deferred.
7. Add a scoped checked-JSDoc CI gate for the new contracts. Reconsider a TS/build migration only
   when measured benefits exceed the added workflow and packaging costs.

Performance-sensitive refactors should later be compared through `node test/benchq.js <cmd>` or
the dedicated performance layer in an authorized performance session. This review does not supply
numbers for proposed designs.

## Validation and remaining decisions

Final validation on this snapshot:

- `node test/run.js unit engine`: **68 unit files passed, 13 engine files passed, 0 failed, 0 skipped**.
- `node test/run.js vscode --changed`: **0 scenarios selected**, because the only change against
  main is this report. This is not a new browser/GPU correctness claim.
- The HTTP close fixture reproduced L1. Static checks confirmed an acyclic relative-require graph
  and 151 file:line references within existing files.
- Repository personal-data and Markdown-link checks passed; the report was checked again after staging.

The first sandboxed suite attempt had 62 executed unit passes, 5 failures and 1 skip; all 13 engine
files were skipped. Installed ffmpeg execution was denied, and the review helper's read-only Git
query failed an ownership check. Each failing test passed alone with tool access, then the full
unit/engine run above passed. The sandboxed `vscode --changed` attempt could not enumerate changed
files through Git/LFS, selected all scenarios and was interrupted before any scenario result; the
corrected run above selected none. These were explicit environment retries, not hidden flaky retries.
No performance layer ran. No product code, settings, versions, decoder assets or changelog entries
are changed by this report.

Open decisions for the owner: whether to prioritize ownership work ahead of new features; whether
to keep the hidden comparison metrics/scanner; whether internal-network URL access needs a policy;
and whether checked JSDoc is enough for the preferred maintenance workflow. None blocks this report.

## Appendix: complete top-level JS size inventory

This includes helpers and workers as well as the large files above. Sizes use the same physical-line
method; they are not executable-line counts. The table pairs independent lists for compactness.

| Host file (`src/`) | Lines | Page/worker file (`media/`) | Lines |
|---|---:|---|---:|
| extension.js | 2,687 | engine.js | 2,455 |
| urlsource.js | 927 | compare.js | 2,153 |
| remotestream.js | 789 | player.js | 1,530 |
| native.js | 658 | decoder-worker.js | 1,146 |
| compare.js | 520 | xray.js | 752 |
| probe.js | 494 | subtitles.js | 689 |
| decide.js | 423 | pool.js | 660 |
| avi.js | 314 | inspect.js | 639 |
| ffmpeg.js | 280 | controls.js | 616 |
| setup.js | 255 | hdr.js | 537 |
| rotation.js | 230 | scopes.js | 438 |
| frameserver.js | 229 | timestretch.js | 394 |
| hwaccel.js | 182 | tracks-menu.js | 389 |
| sniff-matroska.js | 179 | xray-worker.js | 336 |
| remoteff.js | 141 | thumbs.js | 334 |
| localff.js | 136 | thumbs-worker.js | 178 |
| proxy.js | 107 | picture.js | 155 |
| sidecars.js | 107 | framestream.js | 92 |
| hardware.js | 103 | abloop.js | 64 |
| rangecmd.js | 84 | membudget.js | 62 |
| ctxmenu.js | 77 | modes.js | 54 |
| thumbhost.js | 64 | timefmt.js | 38 |
| sniff-codecs.js | 51 | — | — |
| comparepick.js | 48 | — | — |
| sequence.js | 48 | — | — |
| bar.js | 41 | — | — |
