'use strict';
// media/engine.js (LibavPlayer, the player's WebAssembly path) in Node, without a browser: the real
// decoder worker and pool (worker_threads, media/libav-vpe), stub WebGL that keeps the luma plane of
// every uploaded frame as a 64x36 picture, and a silent AudioContext. Layer 2 of docs/TESTING.md.
//
//   const { open } = require('./harness');
//   const P = await open(file);               // ready, first frame shown
//   P.seekFrame(45); await P.expectFrame(45);  // the engine says 45 and the picture is ffmpeg's frame 45
//   P.close();
//
// Node has no WebCodecs: every codec takes the WebAssembly decoder here
// (H.264 and VP8 too, which VS Code decodes on the GPU; layer 3 checks those).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const frames = require('../lib/frames');
const S = require('../../media/player-state');
const AB = require('../../media/abloop');

const ROOT = path.resolve(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'media');
const { shutdownWorkers } = require('../tracks/driver'); // installs the Worker shim (worker_threads) and DecoderPool (media/pool.js)

// ---- browser stubs (once per process) --------------------------------------------------------
globalThis.self = globalThis;
const t0 = performance.now();
class SilentAudioContext {
  constructor() { this.state = 'running'; this.destination = {}; this.sampleRate = 48000; }
  get currentTime() { return (performance.now() - t0) / 1000; }
  createGain() { return { gain: { value: 1, setValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createBuffer(ch, n, sr) {
    const planes = Array.from({ length: ch }, () => new Float32Array(n));
    return { numberOfChannels: ch, length: n, sampleRate: sr, duration: n / sr, copyToChannel: (p, c) => planes[c].set(p), getChannelData: (c) => planes[c] };
  }
  createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {}, playbackRate: { value: 1 }, set onended(f) { this.f = f; } }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
globalThis.AudioContext = SilentAudioContext;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });
const libdir = path.join(MEDIA, 'libav-vpe');
const lib = fs.readdirSync(libdir);
const pick = (re) => path.join(libdir, lib.find((f) => re.test(f)));
const realInit = { loader: pick(/^libav-[\d.]+-vpe\.js$/), toImport: pick(/^libav-[\d.]+-vpe\.wasm\.js$/), wasmurl: pick(/^libav-[\d.]+-vpe\.wasm\.wasm$/), variant: 'vpe' };
const withInit = (m) => (m && m.type === 'init' ? { ...m, ...realInit } : m);
const BaseWorker = globalThis.Worker;
globalThis.Worker = class extends BaseWorker { postMessage(m, tr) { super.postMessage(withInit(m), tr); } };
const BasePool = globalThis.DecoderPool;
globalThis.DecoderPool = class extends BasePool { postMessage(m, tr) { super.postMessage(withInit(m), tr); } };

// The page's scripts the engine uses, in the page's order (src/extension.js): HDR helpers, then the engine.
for (const f of ['membudget.js', 'hdr.js']) vm.runInThisContext(fs.readFileSync(path.join(MEDIA, f), 'utf8'), { filename: path.join(MEDIA, f) });
globalThis.VpeBlockCache = require('../../media/block-cache');
globalThis.VpeGlRenderer = require('../../media/gl-renderer');
globalThis.VpeCodecUtils = require('../../media/codec-utils');
globalThis.VpeDecoderBoot = require('../../media/decoder-boot');
globalThis.VpeAutoplay = require('../../media/autoplay'); // the engine's end-of-file report (ended)
const src = fs.readFileSync(path.join(MEDIA, 'engine.js'), 'utf8');
vm.runInThisContext(`${src}\nglobalThis.createEngine = createEngine;`, { filename: path.join(MEDIA, 'engine.js') });

const GL = { TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, RED: 0x1903, R8: 0x8229, UNSIGNED_BYTE: 0x1401, UNSIGNED_SHORT: 0x1403, UNPACK_ROW_LENGTH: 0x0cf2, RGBA: 0x1908 };

/** WebGL2 stand-in: everything succeeds; texture unit 0 uploads (the luma plane) become `onLuma(thumb, w, h)`. */
function fakeGl(onLuma) {
  let unit = 0;
  let row = 0;
  const fns = {
    getExtension: (n) => (/norm16/i.test(n) ? { R16_EXT: 0x822a } : null),
    activeTexture: (u) => { unit = u - GL.TEXTURE0; },
    pixelStorei: (k, v) => { if (k === GL.UNPACK_ROW_LENGTH) row = v; },
    texSubImage2D: (target, level, x, y, w, h, format, type, data, offset) => {
      if (unit !== 0 || !data || !data.length) return;
      const stride = row || w;
      const deep = type === GL.UNSIGNED_SHORT;
      const view = offset ? data.subarray(offset) : data;
      onLuma(frames.thumbOfPlane(view, w, h, stride, deep ? 10 : 0), w, h, deep);
    },
    // A WebCodecs VideoFrame drawn as it is (a test's stand-in decoder, frames_webcodecs_error.js): a shown
    // picture without planes to compare.
    texImage2D: (...a) => {
      const src = a[a.length - 1];
      if (src && typeof src === 'object' && 'timestamp' in src) onLuma(null, src.displayWidth, src.displayHeight, false);
    },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getAttribLocation: () => 0,
    isContextLost: () => false,
    getParameter: () => 16384,
  };
  return new Proxy({}, { get: (t, k) => (k in GL ? GL[k] : k in fns ? fns[k] : typeof k === 'string' && /^[A-Z0-9_]+$/.test(k) ? 1 : () => 1) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens `file` in a fresh LibavPlayer. Resolves when the first frame is on the (stub) canvas.
 * o: { ffmpeg, pool = true, loop = false, timeout = 30000, waitRate = true, log, virtualClock = false, onRead }
 * virtualClock: after the open, performance.now(), the AudioContext clock and player.tick() follow P.clock only
 * (P.clock.advance(ms)), so playback runs on deterministic time instead of the wall clock (continuity_fuzz.js).
 */
async function open(file, o = {}) {
  file = path.resolve(file);
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const logs = [];
  const messages = [];
  const P = { file, name: path.basename(file), logs, messages, shown: null, uploads: 0, ab: AB.create() };
  const gl = fakeGl((y, w, h, deep) => { P.shown = { y, w, h, deep }; P.uploads++; });
  const canvas = { getContext: () => gl, width: 0, height: 0, hidden: false, style: {}, getBoundingClientRect: () => ({ width: 640, height: 360 }) };
  if (o.pool === false) delete globalThis.DecoderPool; // eslint-disable-line no-param-reassign
  let ready = false;
  const engine = globalThis.createEngine({
    vscode: {
      postMessage: (m) => {
        // P.stallReads: reads go unanswered from then on (a stalled feed: no data and no end of file).
        if (m.type !== 'readBlock' || !P.player || P.stallReads) return;
        setImmediate(() => {
          if (P.closed) return;
          const n = Math.max(0, Math.min(m.len, size - m.pos));
          o.onRead?.(m.pos, n);
          const buf = Buffer.alloc(n);
          if (n) fs.readSync(fd, buf, 0, n, m.pos);
          P.player.onBlock(m.pos, new Uint8Array(buf.buffer, buf.byteOffset, n));
        });
      },
    },
    canvas,
    log: (x) => { logs.push(String(x)); if (o.log) console.log(`    [${P.name}] ${x}`); },
    showMessage: (a, b) => { if (a) messages.push(`${a}${b ? ` (${b})` : ''}`); },
    toast: (x) => logs.push(`TOAST ${x}`),
    getState: () => ({}),
    setMuteUi: () => {},
    onReady: () => { ready = true; },
    onMeta: () => {},
    onTracks: () => {},
    onEnded: (p, info) => { if (P.onEnded) P.onEnded(info); },
  });
  P.player = new engine.LibavPlayer({ size }, { workerUrl: 'decoder-worker.js', loader: 'libav.js', variant: 'vpe', whenSlow: 'every', mem: o.mem });
  P.player.setLoop && P.player.setLoop(!!o.loop);
  if ('loop' in P.player) P.player.loop = !!o.loop;
  const tick = setInterval(() => {
    try { P.player.tick(performance.now() / 1000); } catch (e) { logs.push(`tick error: ${e && e.stack || e}`); }
    P.afterTick?.();
    P.onTick?.();
  }, 8);
  P.close = () => { if (P.closed) return; P.closed = true; clearInterval(tick); if (P.clock) P.clock.release(); try { P.player.dispose(); } catch { /* gone */ } fs.closeSync(fd); };

  const fail = () => {
    const m = messages.find((x) => /could not|failed|damaged|incomplete|cannot|unsupported/i.test(x));
    const e = logs.find((x) => /tick error|engine start failed|worker error/.test(x));
    return m || e || null;
  };
  /** Polls cond() every few ms; throws at once on a page error (message or engine failure), else after timeout. */
  P.until = async (cond, what, timeout = 20000) => {
    const start = Date.now();
    for (;;) {
      const v = cond();
      if (v) return v;
      const f = fail();
      if (f) throw new Error(`${P.name}: ${what}: the player failed: ${f}`);
      if (Date.now() - start > timeout) return null;
      if (P.clock) await P.clock.advance(16, 16); else await sleep(10); // virtual time: waiting = ticking
    }
  };
  const p = P.player;
  const timeout = o.timeout || 30000;
  try {
    if (!(await P.until(() => ready, 'open', timeout))) {
      throw new Error(`${P.name}: not ready in ${timeout / 1000} s`);
    }
    if (!(await P.until(() => p.shownT !== null && P.shown, 'first frame', timeout))) {
      throw new Error(`${P.name}: no first frame`);
    }
    // Files whose container states no rate get it from the first 24-40 timestamps (engine.js trackTs).
    // Wait for the stable rate before frame-index checks unless the test specifically needs a cold open.
    if (o.waitRate !== false) {
      await P.until(() => p.eof || (p.fps > 0 && (!p.tsSeen || p.tsSeen.length >= 40)), 'the frame rate', timeout);
    }
  } catch (err) {
    P.close();
    throw err;
  }
  // Live: the engine refines the rate and frame count from the timestamps it sees after the first frame.
  Object.defineProperty(P, 'fps', { get: () => p.fps || 30 });
  Object.defineProperty(P, 'n', { get: () => p.n });
  Object.defineProperty(P, 'duration', { get: () => p.meta.duration });
  Object.defineProperty(P, 'vmode', { get: () => p.vmode });

  if (o.virtualClock) P.clock = virtualClock(P, tick, logs, o.realMs);

  const seekPending = () => p.seekTarget != null;
  let stepState = S.createWorkspaceState({ frame: 0 });
  let stepTarget = null;
  let heldStep = null;
  let lastFrame = p.currentFrame();

  // Single-decoder copy of seekTo/sendDeferred in media/player-unified.js until S4.
  function seekStep(target, land) {
    if (seekPending() && !p.isPlaying()) {
      heldStep = { target, land, since: heldStep?.since ?? Date.now() };
      return;
    }
    heldStep = null;
    p.seekFrame(target, false, land);
  }

  function sendHeldStep(land = heldStep.land) {
    const { target } = heldStep;
    heldStep = null;
    p.seekFrame(target, false, land);
  }

  function clearStep() {
    heldStep = stepTarget = null;
  }

  // media/player-ui.js decoderFrame/restartAt.
  P.afterTick = () => {
    if (!seekPending() && !heldStep) {
      if (!p.shownStale && !p.catchUp && !p.skipping) stepTarget = null;
      const frame = p.currentFrame();
      if (frame !== lastFrame) {
        lastFrame = frame;
        const wrap = P.ab.wrapTarget(frame / P.fps, p.isPlaying());
        if (wrap !== null) {
          lastFrame = S.getTab(S.syncClockMeta(stepState, {
            maxFrame: P.n - 1,
            frame: Math.round(wrap * P.fps),
          })).frame;
          p.seekFrame(lastFrame);
          p.play();
          P.onWrap?.();
        }
      }
    }
    if (heldStep && (!seekPending() || p.isPlaying() || Date.now() - heldStep.since > 8000)) sendHeldStep();
  };

  P.frame = () => p.currentFrame();
  P.time = () => p.currentTime();
  P.seek = (t) => { clearStep(); p.seekTime(t); };
  P.seekFrame = (k) => { clearStep(); p.seekFrame(k); };
  P.step = (d) => {
    const frame = stepTarget ?? p.currentFrame();
    stepState = S.syncClockMeta(stepState, { maxFrame: P.n - 1, frame });
    stepState = S.stepFrame(stepState, d);
    const target = S.getTab(stepState).frame;
    if (p.isPlaying()) p.pause();
    if (target === frame) return;
    stepTarget = target;
    seekStep(target, Math.sign(target - frame));
  };
  P.home = () => P.seekFrame(0);
  P.end = () => { p.pause(); P.seekFrame(p.n - 1); };
  P.play = () => { if (heldStep) sendHeldStep(0); p.play(); };
  P.pause = () => p.pause();
  P.playing = () => p.isPlaying();
  // player.js: the mute button and the speed menu call setVolume(volume, muted) and setRate(rate).
  P.setMuted = (m) => p.setVolume(p.volume === undefined ? 1 : p.volume, !!m);
  P.setRate = (r) => p.setRate(r);
  /**
   * The decoder worker throws on every 'more' (read and decode) for which `when(m)` is true: it answers as the real
   * worker does then (decoder-worker.js: { type: 'error', where: 'more' }) instead of decoding. A fault at the
   * worker boundary that no small file reproduces on demand (a decoder that fails at one spot every time).
   */
  P.failMore = (when) => {
    const w = p.worker;
    const real = w.postMessage.bind(w);
    w.postMessage = (m, tr) => {
      if (!m || m.type !== 'more' || !when(m)) { real(m, tr); return; }
      setImmediate(() => { if (!P.closed && w.onmessage) w.onmessage({ data: { type: 'error', where: 'more', message: 'injected: the decoder failed here' } }); });
    };
  };

  /** ffmpeg's pictures of this file and their slots (frame numbers at the file's rate). */
  P.refs = async () => {
    if (!P.refList) P.refList = await frames.refFrames(file, o.ffmpeg, { raw: true }); // the luma plane before the GPU turns it
    if (!P.refList) throw new Error(`${P.name}: no reference frames (ffmpeg missing?)`);
    return P.refList;
  };
  P.slots = async () => frames.refSlots(await P.refs(), P.fps);

  /** Waits until the engine says frame k and the picture is ffmpeg's frame k (settled: no seek pending). */
  P.expectFrame = async (k, what, timeout = 20000) => {
    const refs = await P.refs();
    let last = '';
    const got = await P.until(() => {
      if (seekPending() || heldStep) return null;
      if (!P.shown) return null;
      const m = frames.match(P.shown.y, refs, k, P.fps);
      last = `engine says ${p.currentFrame()}, picture matches ${m.slot} (ncc ${m.score.toFixed(4)})`;
      return p.currentFrame() === k && m.slot === k ? m : null;
    }, what, timeout);
    if (!got) throw new Error(`${P.name}: ${what}: expected frame ${k}; ${last}`);
    return got;
  };
  /** As expectFrame, but also waits `ms` first and requires the frame to stay (nothing pending moved it). */
  P.expectStays = async (k, what, ms = 300) => { await sleep(ms); return P.expectFrame(k, what); };
  return P;
}

/**
 * Virtual time for one player: replaces performance.now (which the engine and SilentAudioContext read) with a
 * clock that only P.clock.advance() moves, and takes over from the wall-clock tick interval. Starts where the
 * real clock is, so values taken during the open stay valid. close() puts the real clock back.
 */
function virtualClock(P, wallTick, logs, realMs = 2) {
  const realNow = performance.now.bind(performance);
  let now = realNow();
  clearInterval(wallTick);
  performance.now = () => now;
  const clock = {
    now: () => now,
    /** Moves virtual time by `ms` in `stepMs` steps; each step ticks the player, then lets worker messages in. */
    async advance(ms, stepMs = 16) {
      const end = now + ms;
      while (now < end && !P.closed) {
        now = Math.min(end, now + stepMs);
        try { P.player.tick(now / 1000); } catch (e) { logs.push(`tick error: ${e && e.stack || e}`); }
        P.afterTick?.();
        if (P.onTick) P.onTick();
        await new Promise((r) => setImmediate(r));
        if (realMs) await sleep(realMs); // the decoder runs in real time: give it a slice per virtual step
      }
    },
    release() { delete performance.now; },
  };
  return clock;
}

/**
 * A tiny check recorder: `run(name, fn, known?)` catches throws; `done()` prints and exits.
 * `known` (a reason): a quarantined check (docs/TESTING.md, Known issues): a failure is printed as KNOWN and
 * doesn't fail the file; a pass says the issue is gone, so the entry can be removed.
 */
function checks(title) {
  let failed = 0; let passed = 0; let known = 0;
  console.log(title);
  const run = async (name, fn, why) => {
    const t1 = Date.now();
    try {
      await fn(); passed++;
      console.log(`ok   ${name} (${((Date.now() - t1) / 1000).toFixed(1)} s)${why ? ` -- passes now: remove the known issue "${why}"` : ''}`);
    } catch (e) {
      if (why) { known++; console.log(`KNOWN ${name}: ${why}: ${e && e.message || e}`); } else { failed++; console.log(`FAIL ${name}: ${e && e.message || e}`); }
    }
  };
  const done = async () => {
    console.log(`${passed} passed, ${failed} failed${known ? `, ${known} known issues` : ''}`);
    await shutdownWorkers(); // join the decoder threads first: exiting under a worker still tearing down has hung
    process.exit(failed ? 1 : 0);
  };
  return { run, done };
}

module.exports = { open, checks, sleep, ROOT };
