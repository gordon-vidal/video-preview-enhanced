'use strict';
// node test/run.js unit --grep seek_preview_hw: the seek-bar preview fill on the WebCodecs preview decoder
// (media/thumbs.js o.hw, docs/notes/seek-preview.md) with a stand-in thumbnail worker:
// - only a file with playback's WebCodecs config opens the worker with it, and only then do sweeps ask for the GPU;
// - none in workers, a decoder failure in a reply, or the debug toggle off: sweeps in software, and a failure is
//   remembered when the worker starts again;
// - the bitmaps a reply brings become pictures; ones not needed (the slot has one, or the reply is cancelled) are
//   closed;
// - hardware sweeps wait while playing (keyframe asks go on), a running one is cancelled when playback starts;
//   software sweeps keep today's rule.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'media', 'thumbs.js'), 'utf8');
const CONF = { codec: 'avc1.64001f', codedWidth: 1920, codedHeight: 1080, description: new Uint8Array([1, 100, 0, 31]) };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(5); return f(); };

let current = null; // the fake worker the service made last
const env = { workerHw: true, failNext: false, ms: 4, opens: [], thumbs: [], bitmaps: 0, closed: 0 };
class FakeBitmap {
  constructor(w, h) { this.width = w; this.height = h; this.isClosed = false; env.bitmaps++; }
  close() { if (!this.isClosed) { this.isClosed = true; env.closed++; } }
}
class FakeWorker {
  constructor() { current = this; this.pending = new Map(); this.cancelBelow = 0; }
  reply(m) { setTimeout(() => this.onmessage && this.onmessage({ data: m }), 0); }
  postMessage(m) {
    if (m.type === 'init') this.reply({ type: 'ready' });
    else if (m.type === 'open') {
      env.opens.push(m);
      this.reply({ type: 'opened', ok: true, codec: 'h264', hw: !!m.hw && env.workerHw, hwWhy: m.hw && !env.workerHw ? 'no VideoDecoder in workers' : '' });
    } else if (m.type === 'cancel') this.cancelBelow = Math.max(this.cancelBelow, m.below);
    else if (m.type === 'thumb') {
      env.thumbs.push(m);
      setTimeout(() => this.reply(this.answer(m)), m.mode === 'sweep' ? env.sweepMs ?? env.ms : env.ms);
    }
  }
  answer(m) {
    const rgba = () => new Uint8Array(160 * 90 * 4);
    if (m.mode !== 'sweep') {
      const kt = Math.floor(m.t / 10) * 10;
      return { type: 'thumb', id: m.id, kt, kp: kt, kn: kt + 10 < 60 ? kt + 10 : null, covered: true, w: 160, h: 90, data: rgba() };
    }
    const ts = [];
    for (let g = m.t; g < m.to && g < 60; g += m.step) ts.push(Math.ceil(g * 30 - 1e-6) / 30);
    const hw = m.hw && !env.failNext;
    const hwFailed = m.hw && env.failNext ? 'fake decode error' : undefined;
    env.failNext = false;
    const pic = (kt) => (hw ? { kt, bmp: new FakeBitmap(160, 90) } : { kt, data: rgba() });
    const pics = ts.map(pic);
    const cancelled = m.id < this.cancelBelow;
    // A cancelled reply may still carry bitmaps (the page closes them).
    return { type: 'thumb', id: m.id, ...(cancelled ? { cancelled: true } : {}), ...pics[0], w: 160, h: 90, more: pics.slice(1), frames: ts.length * 30,
      end: true, ...(hw ? { gpu: 'webcodecs' } : {}), ...(hwFailed ? { hwFailed } : {}) };
  }
  terminate() { this.dead = true; }
}

const ctx = {
  performance, setTimeout, clearTimeout, console, Uint8ClampedArray, Uint8Array, Map, Set, Promise, Math, AbortController, Blob,
  ImageData: class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } },
  createImageBitmap: async (img) => new FakeBitmap(img.width || 160, img.height || 90),
  OffscreenCanvas: class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob(o) { return new Blob([new Uint8Array(2500)], { type: o.type }); }
  },
  fetch: async () => ({ ok: true, status: 200, text: async () => '' }),
  URL: { createObjectURL: () => 'blob:thumbs', revokeObjectURL() {} },
  Worker: FakeWorker,
};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.ThumbService = ThumbService;`, ctx);
const { ThumbService } = ctx;

function mk(o = {}) {
  const st = { playing: false, hwOn: true, hidden: false };
  const s = new ThumbService({
    workerSrcUrl: 'thumbs-worker.js', libav: {}, size: 1e8, duration: 60, startT: 0, fps: 30, onRead() {}, log: () => {},
    busy: () => false, hidden: () => st.hidden, passOn: () => true, playing: () => st.playing, idleMs: o.idleMs ?? 50,
    pass: { delayMs: 10 }, ...(o.hw === null ? {} : { hw: o.hw || CONF, hwOn: () => st.hwOn }),
  });
  return { s, st };
}
const reset = () => { env.opens.length = 0; env.thumbs.length = 0; env.workerHw = true; env.failNext = false; env.sweepMs = undefined; };
const sweeps = () => env.thumbs.filter((m) => m.mode === 'sweep');
const done = (s) => /^done/.test(s.stats0().pass.state);

(async () => {
  // 1. A file playback decodes with WebCodecs: the worker opens with its config, every sweep asks for the GPU, and
  //    the bitmaps fill the bar.
  {
    reset();
    const { s } = mk();
    s.passArm();
    assert.ok(await until(() => done(s)), `the pass finishes (${JSON.stringify(s.stats0().pass)})`);
    assert.ok(env.opens.length >= 1 && env.opens.every((m) => m.hw && m.hw.codec === CONF.codec), 'the worker opens with playback\'s config');
    assert.ok(sweeps().length > 0 && sweeps().every((m) => m.hw === true), `every sweep on the preview decoder (${sweeps().map((m) => m.hw)})`);
    const st = s.stats0();
    assert.strictEqual(st.bar, 30, 'the bar is complete');
    assert.strictEqual(st.pass.between.gpu, 'webcodecs', 'the fill says where it decoded');
    assert.ok(st.frames >= 20, `the sweeps' bitmaps became pictures (${st.frames} frames)`);
    s.dispose();
  }

  // 2. Any other file (no config): the worker opens without one, sweeps stay software.
  {
    reset();
    const { s } = mk({ hw: null });
    s.passArm();
    assert.ok(await until(() => done(s)));
    assert.ok(env.opens.every((m) => !m.hw), 'no config sent');
    assert.ok(sweeps().length > 0 && sweeps().every((m) => !m.hw), 'software sweeps');
    assert.strictEqual(s.stats0().previewDecoder, 'none');
    s.dispose();
  }

  // 3. No VideoDecoder in workers: software, and the stats say why.
  {
    reset();
    env.workerHw = false;
    const { s } = mk();
    s.passArm();
    assert.ok(await until(() => done(s)));
    assert.ok(sweeps().length > 0 && sweeps().every((m) => !m.hw), 'software sweeps');
    assert.strictEqual(s.stats0().previewDecoder, 'failed: no VideoDecoder in workers');
    s.dispose();
  }

  // 4. A decoder failure in a reply: its software pictures count, later sweeps are software, and a new worker opens
  //    without the config.
  {
    reset();
    env.failNext = true;
    env.sweepMs = 30;
    const { s, st } = mk();
    s.passArm();
    assert.ok(await until(() => /^failed/.test(s.stats0().previewDecoder)), 'the failure is seen');
    st.hidden = true; // the worker closes
    assert.ok(await until(() => !s.stats0().worker), 'the worker closed while hidden');
    const opens = env.opens.length;
    st.hidden = false;
    assert.ok(await until(() => env.opens.length > opens), 'the worker starts again');
    assert.ok(!env.opens[opens].hw, 'without the config: the failure is remembered');
    assert.ok(await until(() => done(s)));
    const sw = sweeps();
    assert.ok(sw.length > 1, `several sweeps (${sw.length})`);
    assert.strictEqual(sw[0].hw, true, 'the first sweep asked for the GPU');
    assert.ok(sw.slice(1).every((m) => !m.hw), `none after the failure (${sw.map((m) => m.hw)})`);
    assert.strictEqual(s.stats0().previewDecoder, 'failed: fake decode error');
    assert.strictEqual(s.stats0().bar, 30, 'the bar is complete');
    s.dispose();
  }

  // 5. The debug toggle off: software sweeps (a bench compares the two).
  {
    reset();
    const { s, st } = mk();
    st.hwOn = false;
    s.passArm();
    assert.ok(await until(() => done(s)));
    assert.ok(sweeps().length > 0 && sweeps().every((m) => !m.hw), 'software sweeps');
    s.dispose();
  }

  // 6. Playing: hardware sweeps wait (keyframe asks go on), and start once paused; a running one is cancelled when
  //    playback starts. Software sweeps keep going while playing.
  {
    reset();
    const { s, st } = mk();
    st.playing = true;
    s.passArm();
    assert.ok(await until(() => s.stats0().pass.state === 'paused:playing', 3000), `waits while playing (${s.stats0().pass.state})`);
    assert.ok(env.thumbs.some((m) => m.mode !== 'sweep'), 'the keyframe asks ran');
    await tick(600);
    assert.strictEqual(sweeps().length, 0, 'no sweep while playing');
    env.sweepMs = 400;
    st.playing = false;
    assert.ok(await until(() => sweeps().length > 0, 1500), 'sweeps once paused');
    assert.ok(await until(() => s.inflight && s.inflight.mode === 'sweep', 3000), 'a sweep runs');
    const req = s.inflight;
    st.playing = true;
    assert.ok(await until(() => req.cancelSent, 300), 'a running hardware sweep is cancelled when playback starts');
    s.dispose();

    reset();
    const soft = mk({ hw: null });
    soft.st.playing = true;
    soft.s.passArm();
    assert.ok(await until(() => sweeps().length > 0, 3000), 'software sweeps run while playing');
    soft.s.dispose();
  }

  // 7. Bitmaps not used are closed: a cancelled reply's, and ones for slots that have a picture.
  {
    reset();
    const before = env.bitmaps - env.closed;
    const { s } = mk();
    for (let i = 0; i < 30; i += 2) s.offer(i * 2 + 1, new FakeBitmap(160, 90)); // every other slot has a picture
    env.sweepMs = 60;
    s.passArm();
    await until(() => s.inflight && s.inflight.mode === 'sweep', 3000);
    s.cancel(s.inflight); // its reply comes back cancelled, with bitmaps
    assert.ok(await until(() => done(s), 5000), `the pass finishes (${JSON.stringify(s.stats0().pass)})`);
    s.dispose();
    await tick(20);
    assert.strictEqual(env.bitmaps - env.closed, before, `every bitmap closed after dispose (${env.bitmaps - env.closed - before} open)`);
  }

  console.log('seek_preview_hw: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
