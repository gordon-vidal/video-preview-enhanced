#!/usr/bin/env node
// Regression checks for engine.js / pool.js logic that runs without a browser:
// LibavPlayer methods are called on plain objects with stub decoders, clocks and
// workers. Playback in a real page is covered by test/vscode.
//
//   node test/host/run_all.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { budgets } = require('../../media/membudget');

const media = path.join(__dirname, '..', '..', 'media');
const ctx = { performance: { now: () => ctx.perfNow }, perfNow: 0, console, setTimeout, clearTimeout, queueMicrotask, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(`${fs.readFileSync(path.join(media, 'engine.js'), 'utf8')}\n;globalThis.createEngine = createEngine;`, ctx);
vm.runInContext(fs.readFileSync(path.join(media, 'timestretch.js'), 'utf8'), ctx);
const noop = () => {};
const posted = [];
const { LibavPlayer } = ctx.createEngine({
  vscode: { postMessage: (m) => posted.push(m) }, canvas: {}, log: noop, showMessage: noop, getState: noop, setMuteUi: noop, toast: noop,
  onMeta: noop, onReady: noop,
});
const P = LibavPlayer.prototype;
ctx.Worker = class { constructor() { this.msgs = []; } postMessage(m) { this.msgs.push(m); } terminate() { this.dead = true; } };
vm.runInContext(fs.readFileSync(path.join(media, 'pool.js'), 'utf8'), ctx);

/** A LibavPlayer without its constructor (no WebGL): the fields the constructor sets. */
function player(extra) {
  const p = Object.create(P);
  Object.assign(p, {
    meta: { duration: 10, size: 1e6 }, cfg: {}, mem: budgets(), fps: 30, n: 300, gen: 0, startT: 0, queue: [], audio: [], sources: new Set(),
    requesting: false, eof: false, playing: false, pauseT: 0, shownT: null, seekTarget: null, hold: null, tsSeen: [],
    vdec: null, adec: null, outCount: 0, ac: null, rate: 1, loop: true, whenSlow: 'every', volume: 1, muted: false,
    gl: { drawFrame: noop, drawYuv: noop }, vmode: 'soft', amode: 'soft', worker: { msgs: [], postMessage(m) { this.msgs.push(m); } },
  });
  // Getters on the prototype (decodeRate, mediaRate) can't be assigned: stub them as own values.
  for (const [k, val] of Object.entries(extra || {})) {
    const d = Object.getOwnPropertyDescriptor(P, k);
    if (d && d.get && !d.set) Object.defineProperty(p, k, { value: val, writable: true, configurable: true, enumerable: true });
    else p[k] = val;
  }
  return p;
}
const fakeAc = () => ({
  currentTime: 0, state: 'running',
  createBuffer: (ch, n, sr) => ({ numberOfChannels: ch, length: n, sampleRate: sr, duration: n / sr, data: [], copyToChannel() {}, getChannelData: () => new Float32Array(n) }),
});
const frame = (t) => ({ t, yuv: {}, bytes: 1 });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('shown frame numbers tolerate rounded PTS without advancing for snapped rates', () => {
  const rounded = player({ startT: 0.007, shownT: 0.073, fps: 30, info: { video: { fps: 30 } } });
  assert.strictEqual(rounded.currentFrame(), 2);
  const fractional = player({ meta: { duration: 11 }, info: { video: { fps: 29.9 } }, shownT: 300 / 29.9 });
  fractional.setFrameRate(29.9);
  assert.strictEqual(fractional.fps, 30000 / 1001);
  assert.strictEqual(fractional.currentFrame(), 300);
  assert.strictEqual(player({ shownT: 300.7 / 30, n: 400 }).currentFrame(), 300);
  assert.strictEqual(player({ shownT: 12 / 30, info: { video: { fps: 600 } } }).currentFrame(), 12);
});

test('#5 ms-rounded audio chunks are placed back to back', () => {
  const p = player({ ac: fakeAc() });
  const n = 1024;
  const sr = 44100;
  const plane = [new Float32Array(n)];
  // MKV: 1024-sample AAC frames at 23.2 ms, stored rounded to whole ms.
  for (let i = 0; i < 50; i++) P.addAudio.call(p, Math.round((i * n) / sr * 1000) / 1000, sr, plane);
  for (let i = 1; i < p.audio.length; i++) assert.strictEqual(p.audio[i].t, p.audio[i - 1].t + p.audio[i - 1].dur, `chunk ${i} not contiguous`);
  // A real gap (100 ms) is kept.
  const last = p.audio[p.audio.length - 1];
  P.addAudio.call(p, last.t + last.dur + 0.1, sr, plane);
  assert.ok(Math.abs(p.audio[p.audio.length - 1].t - (last.t + last.dur + 0.1)) < 1e-9);
});

test('#6 the clock waits for an accurate seek and starts at its target', () => {
  ctx.perfNow = 0;
  const p = player({ playing: true });
  P.anchor.call(p, 0);
  P.seekAbs.call(p, 5);
  ctx.perfNow = 2000; // a slow seek: 2 s until its frame
  assert.strictEqual(P.now.call(p), 5);
  P.addFrame.call(p, frame(4.99));
  P.addFrame.call(p, frame(5.02));
  assert.strictEqual(p.seekTarget, null);
  assert.strictEqual(P.now.call(p), 5);
  P.tick.call(p);
  assert.ok(!p.behindUntil, 'a slow seek counted as decoding behind');
  ctx.perfNow = 2500;
  assert.ok(Math.abs(P.now.call(p) - 5.5) < 1e-9);
});

test('#6 every-frame mode keeps up when frames are decoded past the clock', () => {
  ctx.perfNow = 0;
  const p = player({ playing: true, fps: 120, amode: 'none', eof: true });
  P.anchor.call(p, 0);
  for (let i = 0; i <= 240; i++) p.queue.push(frame(i / 120));
  p.behindUntil = 1e9;
  ctx.perfNow = 1000;
  P.tick.call(p);
  assert.ok(Math.abs(p.shownT - 1) < 1 / 120 + 1e-9, `showed ${p.shownT}, expected the newest due frame near 1 s`);
  assert.ok(Math.abs(P.now.call(p) - 1) < 1e-9, 'the clock was pulled back');
  // Decoding behind (nothing decoded past the clock): the oldest due frame, the clock waits.
  const q = player({ playing: true, fps: 30, amode: 'none' });
  ctx.perfNow = 0;
  P.anchor.call(q, 0);
  for (let i = 0; i < 6; i++) q.queue.push(frame(i / 30));
  q.behindUntil = 1e9;
  ctx.perfNow = 1000;
  P.tick.call(q);
  assert.strictEqual(q.shownT, 0);
  assert.strictEqual(P.now.call(q), 0);
});

/** Playing at media time t on the timer clock. */
function playingAt(p, t) { ctx.perfNow = 0; p.playing = true; P.anchor.call(p, t); }
const audioItem = (t, dur) => ({ t, dur, buf: null, src: null });

test('#8a sound that outlasts the picture is not cut', () => {
  const p = player({ eof: true, lastT: 2, loop: false, shownCount: 60 });
  p.audio.push(audioItem(4.5, 0.5));
  playingAt(p, 2.5);
  P.tick.call(p);
  assert.ok(p.playing, 'stopped at the last frame although sound runs to 5 s');
  playingAt(p, 5.01);
  P.tick.call(p);
  assert.ok(!p.playing);
});

test('#8b sound only: the loop comes at the end of the sound', () => {
  const p = player({ vmode: 'none', eof: true, startT: null });
  p.audio.push(audioItem(4.5, 0.5));
  playingAt(p, 3.5); // eof arrives ~1.5 s before the sound is played
  P.tick.call(p);
  assert.strictEqual(p.gen, 0, 'looped 1.5 s early');
  playingAt(p, 5.01);
  P.tick.call(p);
  assert.strictEqual(p.gen, 1);
});

test('#8c play after the end starts over (loop off)', () => {
  const p = player({ eof: true, lastT: 2, loop: false, startT: 0, shownCount: 60, shownT: 2 });
  playingAt(p, 2.1);
  P.tick.call(p);
  assert.ok(!p.playing);
  P.play.call(p);
  assert.ok(p.playing);
  assert.strictEqual(p.gen, 1);
  assert.strictEqual(p.seekTarget, 0);
  P.tick.call(p);
  assert.ok(p.playing, 'play after the end re-paused at once');
});

test('#8d WebCodecs: eof waits for the decoder flush', async () => {
  let done;
  const vdec = { state: 'configured', decodeQueueSize: 0, flush: () => new Promise((r) => { done = r; }) };
  const p = player({ vmode: 'webcodecs', vdec });
  P.onBatch.call(p, { gen: 0, eof: true, video: [], audio: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!p.eof, 'eof set before the flush finished');
  done();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(p.eof);
});

test('open-GOP fallback preserves the seek target when the key arrives with EOF', async () => {
  const target = 9.5;
  const p = player({ vmode: 'webcodecs', needKey: true, shownT: 1, seekTarget: target, pauseT: target,
    vdec: { state: 'configured', close: noop } });
  p.onBatch({ gen: p.gen, eof: true, video: [{ kind: 'packet', key: true, idr: false, t: 9 }], audio: [] });
  await Promise.resolve(); // let the old batch's EOF handling run before the worker replies
  p.pump();
  assert.deepStrictEqual(p.worker.msgs.map((m) => m.type), ['videoMode']);
  assert.strictEqual(p.seekTarget, target);
  p.onVideoMode({ video: 'soft' });
  assert.strictEqual(p.worker.msgs.at(-1).type, 'seek');
  assert.strictEqual(p.worker.msgs.at(-1).t, target);
});

test('a track switch that rewinds during the end flush reads on (no eof)', async () => {
  let done;
  const vdec = { state: 'configured', decodeQueueSize: 0, flush: () => new Promise((r) => { done = r; }) };
  const p = player({ vmode: 'webcodecs', vdec });
  P.onBatch.call(p, { gen: 0, eof: true, video: [], audio: [] });
  // selectSub's reply (rewound) arrives while the decoder flushes.
  p.eof = false; p.catchUp = true; p.rewinds = 1;
  p.worker.msgs.length = 0;
  done();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!p.eof, 'eof after the rewind');
  assert.ok(p.worker.msgs.some((m) => m.type === 'more'), 'no read after the rewind');
});

test('#8e no endless loop when nothing ever decodes', () => {
  const p = player({ eof: true, loop: true });
  playingAt(p, 0);
  P.tick.call(p);
  assert.ok(!p.playing, 'looped although nothing was shown or heard');
  assert.strictEqual(p.gen, 0);
});

test('#7 a seek past the last frame shows the last frame', async () => {
  const p = player();
  P.seekAbs.call(p, 9.9);
  P.onBatch.call(p, { gen: 1, eof: false, video: [{ kind: 'yuv', t: 9.5, data: new Uint8Array(1) }, { kind: 'yuv', t: 9.6, data: new Uint8Array(1) }], audio: [] });
  P.onBatch.call(p, { gen: 1, eof: true, video: [], audio: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(p.seekTarget, null);
  assert.strictEqual(p.queue.length, 1);
  assert.strictEqual(p.queue[0].t, 9.6);
  P.tick.call(p);
  assert.strictEqual(p.shownT, 9.6);
});

test('#10 a WebCodecs error restarts the decoder at a keyframe, then falls back to software', () => {
  const made = [];
  ctx.VideoDecoder = class { constructor(cb) { this.cb = cb; this.state = 'configured'; this.decodeQueueSize = 0; made.push(this); } configure() {} decode() {} close() { this.state = 'closed'; } };
  const p = player({ vmode: 'webcodecs', vconf: {}, gl: { norm16: null } });
  P.makeVideoDecoder.call(p);
  p.needKey = false;
  made[0].state = 'closed';
  made[0].cb.error(new Error('damaged packet'));
  assert.strictEqual(made.length, 2, 'no new decoder after the error');
  assert.strictEqual(p.vdec, made[1]);
  assert.ok(p.needKey);
  made[1].cb.error(new Error('again'));
  made[2].cb.error(new Error('and again'));
  assert.strictEqual(p.vdec, null);
  assert.strictEqual(p.vmode, 'soft');
  const cfg = p.worker.msgs.find((m) => m.type === 'config');
  assert.ok(cfg && cfg.video === 'soft', 'worker not switched to software video');
  P.onConfigured.call(p, { video: 'soft', audio: 'soft' });
  assert.strictEqual(p.gen, 1, 'no re-seek after the switch');
  assert.ok(p.worker.msgs.some((m) => m.type === 'seek'));
});

test('decode speed: bursts of frames read sanely, a stalled decoder decays, the pill never says Infinity', () => {
  ctx.perfNow = 1000;
  const p = player({ playing: false });
  P.resetRate.call(p);
  // A software batch: 5 frames in the same millisecond, then nothing for 6 s (VVC 4K at 0.16 fps).
  for (let i = 0; i < 5; i++) P.addFrame.call(p, frame(i / 30));
  assert.strictEqual(p.decodeRate, null, 'a rate from 0 ms of data');
  ctx.perfNow = 1600;
  assert.ok(p.decodeRate < 10, `burst read as ${p.decodeRate} fps`);
  ctx.perfNow = 7000;
  for (let i = 5; i < 10; i++) P.addFrame.call(p, frame(i / 30));
  const r = p.decodeRate;
  assert.ok(Number.isFinite(r) && r > 0.5 && r < 3, `rate ${r}`);
  p.playing = true;
  p.behindUntil = 1e9;
  assert.match(P.status.call(p).text, /^Decoding 0\.0\d× · every frame$/);
  ctx.perfNow = 20000;
  assert.strictEqual(p.decodeRate, 0, 'a decoder that stopped still reads as decoding');
  assert.match(P.status.call(p).text, /^Decoding <0\.01× · every frame$/);
});

test('the sound is the clock only while it plays; without it the clock waits for the picture', () => {
  ctx.perfNow = 0;
  // TrueHD 5.1 that never produced sound: the AudioContext runs, nothing is scheduled.
  const p = player({ ac: fakeAc(), amode: 'soft', playing: true, shownT: 1, queue: [] });
  P.anchor.call(p, 1);
  P.tick.call(p);
  assert.ok(!P.audioMaster.call(p), 'silent sound is the clock');
  ctx.perfNow = 6000; // 6 s of a frozen picture
  P.tick.call(p);
  assert.ok(P.now.call(p) < 1.1, `clock ran on to ${P.now.call(p)} past the frozen picture`);
  ctx.perfNow = 9000;
  P.tick.call(p);
  assert.ok(P.now.call(p) < 1.1, 'clock ran on while waiting');
  // The next frame comes: shown at once, and the clock runs from there (no jump back).
  p.queue.push(frame(1 + 1 / 30));
  P.tick.call(p);
  assert.ok(Math.abs(p.shownT - (1 + 1 / 30)) < 1e-9, `shown ${p.shownT}`);
  const t0 = P.now.call(p);
  ctx.perfNow = 9100;
  assert.ok(P.now.call(p) > t0, 'clock stopped after the frame came');
  // Sound that covers the playhead makes it the clock again.
  const q = player({ ac: fakeAc(), amode: 'soft' });
  P.addAudio.call(q, 0, 48000, [new Float32Array(48000)]);
  P.updateAudioLive.call(q, 0.2);
  assert.ok(P.audioMaster.call(q));
});

test('WebCodecs sound: no file-long backlog, and the built-in decoder takes over when it lags at 2x', async () => {
  ctx.perfNow = 0;
  const adec = { state: 'configured', decodeQueueSize: 400, close() { this.state = 'closed'; } };
  const p = player({ vmode: 'none', amode: 'webcodecs', adec, ac: fakeAc(), playing: true, rate: 2, info: { audio: { codec: 'aac' } }, audioId: 1 });
  P.anchor.call(p, 0);
  p.aSubmitT = 8; // 8 s of sound sent to the decoder, 2 s out
  P.addAudio.call(p, 0, 48000, [new Float32Array(96000)]);
  P.pump.call(p);
  assert.ok(!p.worker.msgs.some((m) => m.type === 'more'), 'read more sound while seconds of it wait in the decoder');
  // It comes out at 1x while playing at 2x.
  for (let t = 0; t <= 1200; t += 100) {
    ctx.perfNow = t;
    if (t && t % 200 === 0) { const l = p.audio[p.audio.length - 1]; P.addAudio.call(p, l.t + l.dur, 48000, [new Float32Array(9600)]); }
    P.checkAudioLag.call(p);
  }
  assert.ok(p.aToSoft, 'lag not detected');
  await new Promise((r) => setTimeout(r, 0)); // the switch runs in the track-change queue
  const sel = p.worker.msgs.find((m) => m.type === 'selectAudio');
  assert.ok(sel && sel.mode === 'soft' && sel.id === 1, JSON.stringify(sel));
  // Sound already decoded keeps playing: the re-read continues at its end.
  assert.ok(p.audio.length > 1, 'decoded sound dropped');
  const end = p.audio[p.audio.length - 1].t + p.audio[p.audio.length - 1].dur;
  assert.ok(Math.abs(sel.t - end) < 1e-9, `re-read from ${sel.t}, sound ends at ${end}`);
  P.settleWait.call(p, { type: 'audioSelected', audio: 'soft', rewound: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(p.amode, 'soft');
  const n = p.audio.length;
  // The re-read repeats sound before the end: only what follows is kept, trimmed to the sample.
  P.onBatch.call(p, { gen: 0, eof: false, video: [], audio: [{ kind: 'pcm', t: end - 0.5, sampleRate: 48000, planes: [new Float32Array(24000 + 4800)] }] });
  assert.strictEqual(p.audio.length, n + 1);
  assert.ok(Math.abs(p.audio[n].t - end) < 1e-9 && Math.abs(p.audio[n].dur - 0.1) < 1e-6, `kept ${p.audio[n].t}+${p.audio[n].dur}`);
});


test('#11 every stopAudio is paired with an anchor', () => {
  // a) forward seek within the decoded queue stops the scheduled sound
  const p = player();
  playingAt(p, 1);
  for (let i = 30; i < 90; i++) p.queue.push(frame(i / 30));
  let stopped = 0;
  p.sources.add({ stop: () => { stopped++; } });
  P.seekTime.call(p, 2);
  assert.strictEqual(p.gen, 0, 'expected the in-queue path');
  assert.strictEqual(stopped, 1, 'sound scheduled for the old position kept playing');
  // b) skipTo resets the stretcher (anchor) without moving the clock
  const q = player({ meta: { duration: 100 } });
  playingAt(q, 10);
  q.ts = { reset() { this.n = (this.n || 0) + 1; } };
  q.tsWhen = 123;
  ctx.perfNow = 500;
  P.skipTo.call(q, 12);
  assert.strictEqual(q.ts.n, 1, 'stretcher not reset');
  assert.strictEqual(q.tsWhen, null);
  assert.ok(Math.abs(P.now.call(q) - 10.5) < 1e-9, 'the clock moved');
});

/** A pool in parallel mode with two extra workers, as after trySwitch. */
function parallelPool() {
  const pool = new ctx.DecoderPool('w.js', { multiRead: true, workers: 2, log: false });
  pool.config = { video: 'soft' };
  pool.info = { video: { width: 1920, height: 1080 } };
  pool.vmode = 'soft';
  pool.amode = 'soft';
  pool.startExtras();
  for (const x of pool.extras) x.state = 'ready';
  pool.extrasSettled = true;
  pool.mode = 'parallel';
  pool.lastSeek = { t: 0, fast: false };
  pool.seekPending = false;
  return pool;
}
const tick0 = () => new Promise((r) => setTimeout(r, 0));

test('#12 pool fallback keeps the sound that was read but not handed out', async () => {
  const pool = parallelPool();
  const out = [];
  pool.onmessage = (e) => out.push(e.data);
  pool.lastVT = 2;
  // Handed out up to 1.0 s; read (not handed out) up to 1.5 s; no engine request waiting.
  pool.delivered([{ t: 1 }]);
  pool.audioItems = [{ t: 1.25 }, { t: 1.5 }];
  pool.lastAT = 1.5;
  pool.primaryBusy = true; // a 'more' to the primary is in flight
  pool.fallback('test');
  assert.strictEqual(pool.dropAUpTo, 1, 'sound read but not handed out is lost');
  const seek = pool.primary.msgs.find((m) => m.type === 'seek');
  assert.ok(seek && seek.iid !== undefined, 'internal seek without an id');
  // The in-flight batch was read before the re-seek: dropped (it is read again).
  pool.fromPrimary({ type: 'batch', gen: 0, eof: false, video: [], audio: [{ t: 1.75 }] });
  await tick0();
  assert.ok(!out.some((m) => m.type === 'batch'), 'pre-seek batch handed out (sound twice)');
  // An engine seek's reply is not taken for the internal seek's.
  pool.onSeek({ type: 'seek', gen: 1, t: 5 });
  pool.fromPrimary({ type: 'seeked', gen: 1 });
  await tick0();
  assert.ok(out.some((m) => m.type === 'seeked' && m.gen === 1), 'engine seek reply swallowed');
  assert.strictEqual(pool.internalSeek, 1);
  pool.fromPrimary({ type: 'seeked', gen: 1, iid: seek.iid });
  assert.strictEqual(pool.internalSeek, 0);
});

test('#12 a fallback right after a fast seek stays fast', () => {
  const pool = parallelPool();
  pool.lastSeek = { t: 3, fast: true };
  pool.lastVT = null;
  pool.fallback('test');
  const seek = pool.primary.msgs.find((m) => m.type === 'seek');
  assert.ok(seek.fast, 'fallback seek after a skip is accurate');
});

test('#14 a hidden tab frees its frames and pool workers', () => {
  const p = player({ shownT: 2 });
  for (let i = 61; i < 200; i++) p.queue.push(frame(i / 30));
  P.setHidden.call(p, true);
  assert.strictEqual(p.queue.length, 0);
  assert.ok(p.worker.msgs.some((m) => m.type === 'hidden' && m.on));
  P.pump.call(p);
  assert.ok(!p.worker.msgs.some((m) => m.type === 'more'), 'decodes on while hidden');
  P.setHidden.call(p, false);
  const seek = p.worker.msgs.find((m) => m.type === 'seek');
  assert.ok(seek && seek.t === 2, 'no re-seek to the shown frame');
  const pool = parallelPool();
  const extras = pool.extras.map((x) => x.w);
  pool.postMessage({ type: 'hidden', on: true });
  assert.strictEqual(pool.mode, 'single');
  assert.ok(extras.every((w) => w.dead), 'extra workers kept while hidden');
  pool.postMessage({ type: 'hidden', on: false });
  assert.strictEqual(pool.extras.length, 2, 'extra workers not restarted');
});

test('#18 a block the host fails to read does not hang the reader', () => {
  ctx.perfNow = 0;
  const p = player();
  const q = player({ meta: { duration: 10, size: 50e6 } });
  try {
    P.onWorkerRead.call(p, 100, 1 << 20, 0);
    assert.ok(p.inflight.has(0));
    // The host answers with an error: the waiting read fails at once.
    P.onBlock.call(p, 0, null, 'EIO');
    const fail = p.worker.msgs.find((m) => m.type === 'block');
    assert.ok(fail && fail.data.byteLength === 0 && fail.pos === 100, 'reader still waiting after a read error');
    assert.ok(!p.inflight.has(0));
    // No answer at all: asked again after 15 s, failed after another 15 s.
    P.onWorkerRead.call(q, (5 << 20) + 7, 1 << 20, 0);
    clearTimeout(q.readTimer);
    const asks = () => posted.filter((m) => m.type === 'readBlock' && m.pos === 5 << 20).length;
    const before = asks();
    ctx.perfNow = 16000;
    P.retryReads.call(q);
    clearTimeout(q.readTimer);
    assert.strictEqual(asks(), before + 1, 'not asked again');
    ctx.perfNow = 32000;
    P.retryReads.call(q);
    assert.ok(q.worker.msgs.some((m) => m.type === 'block' && m.data.byteLength === 0), 'read never failed');
  } finally {
    // These timers run on wall time while the test advances the read clock by hand.
    clearTimeout(p.readTimer);
    clearTimeout(q.readTimer);
  }
});

test('#18 keys before the decoder is ready do not throw', () => {
  const p = player({ vmode: undefined, worker: undefined });
  P.seekTime.call(p, 3);
  P.seekFrame.call(p, 10);
  P.stepFrame.call(p, 1);
  P.stepFrame.call(p, -1);
  P.play.call(p);
  P.pause.call(p);
  assert.strictEqual(P.currentFrame.call(p), 0);
});

test('#18 dispose closes the decoders and the held frame', () => {
  const closed = [];
  const dec = (name) => ({ state: 'configured', close() { this.state = 'closed'; closed.push(name); } });
  const p = player({ vdec: dec('vdec'), adec: dec('adec'), worker: { terminate() {}, postMessage() {} } });
  p.hold = { t: 1, vf: { close: () => closed.push('hold') } };
  p.queue.push({ t: 2, vf: { close: () => closed.push('queued') } });
  P.dispose.call(p);
  assert.deepStrictEqual(closed.sort(), ['adec', 'hold', 'queued', 'vdec']);
  return P.onWorker.call(p, { type: 'error', where: 'open', message: 'late' }); // ignored, no throw
});

test('#18 readers of stopped pool workers are forgotten', async () => {
  const pool = parallelPool();
  const p = player({ meta: { duration: 10, size: 50e6 }, worker: pool });
  pool.onmessage = (e) => P.onWorker.call(p, e.data);
  for (const rid of [0, 1, 2]) P.onWorkerRead.call(p, rid * (8 << 20), 1 << 20, rid);
  clearTimeout(p.readTimer);
  assert.strictEqual(p.readerPos.size, 3);
  pool.fallback('test');
  await tick0();
  assert.deepStrictEqual([...p.readerPos.keys()], [0], 'stale readers kept');
  assert.ok(![...p.wantReads.keys()].some((r) => r !== 0));
});

test('#18 the worker runs only the newest of queued seeks', async () => {
  const out = [];
  const w = { TextDecoder, postMessage: (m) => out.push(m), MessageChannel: class { constructor() { this.port1 = {}; this.port2 = { postMessage() {} }; } } };
  w.self = w;
  vm.createContext(w);
  vm.runInContext(`${fs.readFileSync(path.join(media, 'decoder-worker.js'), 'utf8')}
;self.setLibav = (l) => { libav = l; };`, w);
  let seeks = 0;
  w.setLibav({
    f64toi64: () => [0, 0],
    avformat_seek_file_max: async () => { seeks++; await new Promise((r) => setTimeout(r, 5)); return 0; },
    avformat_seek_file_min: async () => { seeks++; return 0; },
    avcodec_flush_buffers: async () => {},
  });
  for (let g = 1; g <= 20; g++) w.onmessage({ data: { type: 'seek', gen: g, t: g } });
  await new Promise((r) => setTimeout(r, 200));
  const replies = out.filter((m) => m.type === 'seeked');
  assert.strictEqual(replies.length, 20, 'every seek is answered');
  assert.ok(seeks <= 2, `${seeks} seeks ran for 20 queued`);
});

test('sound: tiny TrueHD chunks are joined, layouts WebAudio cannot downmix are mixed to stereo', () => {
  /** An AudioContext whose buffers keep their samples. */
  const realAc = () => ({
    currentTime: 0, state: 'running',
    createBuffer: (ch, n, sr) => {
      const data = Array.from({ length: ch }, () => new Float32Array(n));
      return { numberOfChannels: ch, length: n, sampleRate: sr, duration: n / sr, copyToChannel: (p, c) => data[c].set(p), getChannelData: (c) => data[c] };
    },
  });
  // TrueHD: 40-sample frames, 5.1(side) (mask 0x60f) stays 6 channels for WebAudio's own downmix.
  const p = player({ ac: realAc() });
  for (let i = 0; i < 1200; i++) P.addAudio.call(p, (i * 40) / 48000, 48000, Array.from({ length: 6 }, () => new Float32Array(40).fill(0.1)), 0x60f);
  const secs = (1200 * 40) / 48000;
  assert.ok(p.audio.length <= Math.ceil(secs / 0.05), `${p.audio.length} chunks for ${secs} s of sound`);
  assert.strictEqual(p.audio[0].buf.numberOfChannels, 6);
  const total = p.audio.reduce((n, a) => n + a.buf.length, 0);
  assert.strictEqual(total, 1200 * 40, 'samples lost or doubled while joining');
  for (let i = 1; i < p.audio.length; i++) assert.ok(Math.abs(p.audio[i].t - (p.audio[i - 1].t + p.audio[i - 1].dur)) < 1e-9, 'joined chunks not back to back');
  // 7.1 (FL FR FC LFE BL BR SL SR, mask 0x63f): stereo, with the centre in both sides at -3 dB, LFE dropped.
  const q = player({ ac: realAc() });
  const ch = (v) => new Float32Array(480).fill(v);
  P.addAudio.call(q, 0, 48000, [ch(0), ch(0), ch(0.5), ch(1), ch(0), ch(0), ch(0.2), ch(0)], 0x63f);
  const b = q.audio[0].buf;
  assert.strictEqual(b.numberOfChannels, 2);
  const l = b.getChannelData(0)[0];
  const r = b.getChannelData(1)[0];
  assert.ok(Math.abs(l - (0.5 + 0.2) * Math.SQRT1_2) < 1e-6 && Math.abs(r - 0.5 * Math.SQRT1_2) < 1e-6, `L ${l} R ${r}`);
  // Unknown layout with 3 channels: FL FR FC.
  P.addAudio.call(q, 1, 48000, [ch(0), ch(0), ch(1)], 0);
  assert.strictEqual(q.audio[1].buf.numberOfChannels, 2);
  assert.ok(q.audio[1].buf.getChannelData(0)[0] > 0.7);
});

test('#1 frame rate from millisecond-rounded times', () => {
  for (const [fps, want] of [[60, 60], [30000 / 1001, 30000 / 1001], [60000 / 1001, 60000 / 1001], [25, 25], [24000 / 1001, 24000 / 1001]]) {
    const p = player({ fps: 0, n: 0, meta: { duration: 10 } });
    for (let i = 0; i < 40; i++) P.trackTs.call(p, Math.round((i / fps) * 1000) / 1000);
    assert.strictEqual(p.fps, want, `${fps.toFixed(3)} fps measured as ${p.fps}`);
  }
  // Frame numbers from rounded times: frame i is i, also just before i/fps.
  const p = player({ fps: 60, n: 600 });
  for (let i = 0; i < 300; i++) {
    p.shownT = Math.round((i / 60) * 1000) / 1000;
    assert.strictEqual(P.currentFrame.call(p), i, `frame ${i} at ${p.shownT}`);
  }
});

test('fast preview: only opted in, HEVC/H.264, while playing behind; pausing decodes exactly again', () => {
  const fastMsgs = (p) => p.worker.msgs.filter((m) => m.type === 'fastDecode').map((m) => m.on);
  const behind = (p) => {
    playingAt(p, 0);
    for (let i = 0; i < 3; i++) p.queue.push(frame(i / 30));
    ctx.perfNow = 1000; // the clock is at 1 s, the frames at 0: behind
    P.tick.call(p);
  };
  // Not opted in, or a codec that ignores skip_loop_filter: nothing.
  for (const [cfg, codec] of [[{}, 'hevc'], [{ fastWhenBehind: true }, 'av1']]) {
    const p = player({ cfg, amode: 'none', info: { video: { codec } } });
    behind(p);
    assert.deepStrictEqual(fastMsgs(p), [], JSON.stringify([cfg, codec]));
  }
  const p = player({ cfg: { fastWhenBehind: true }, amode: 'none', info: { video: { codec: 'hevc' } } });
  behind(p);
  assert.deepStrictEqual(fastMsgs(p), [true], 'on while behind');
  assert.match(P.status.call(p).text, /fast preview/);
  // Pause: exact decoding again, re-decoded from the shown frame.
  const shown = p.shownT;
  P.pause.call(p);
  assert.deepStrictEqual(fastMsgs(p), [true, false]);
  const seek = p.worker.msgs.filter((m) => m.type === 'seek').pop();
  assert.ok(seek && Math.abs(seek.t - shown) < 1e-9, 'paused on an exact re-decode of the shown frame');
  assert.strictEqual(p.fastUsed, false);
  // Caught up for a while while playing: off again (no re-seek needed while playing).
  const q = player({ cfg: { fastWhenBehind: true }, amode: 'none', info: { video: { codec: 'h264' } } });
  behind(q);
  q.behindUntil = 0;
  ctx.perfNow = 10000;
  q.queue = [frame(P.now.call(q) + 0.5)]; // decoded ahead of the clock: caught up
  P.tick.call(q);
  assert.deepStrictEqual(fastMsgs(q), [true, false]);
  assert.strictEqual(q.fastUsed, true, 'frames since then may still be approximate until a seek or pause');
});

test('decode speed samples: sustained slow, real time, native marked; seeks and mixed windows say nothing', () => {
  const samples = () => posted.filter((m) => m.type === 'decodeSpeed').splice(0);
  const run = (p, from, to, behind) => {
    const out = [];
    for (let t = from; t <= to; t += 50) {
      if (behind(t)) p.behindUntil = t + 3000; else if (p.behindUntil && p.behindUntil > t) p.behindUntil = t - 1;
      const s = p.sampleSpeed(t);
      if (s) out.push(s);
    }
    return out;
  };
  const video = { codec: 'hevc', width: 3840, height: 2160, depth: 10 };
  // 4K HEVC 10-bit at 12 decoded fps of 30: behind the whole time -> 0.4x samples every ~3 s after a 1.5 s warm-up.
  let p = player({ info: { video }, playing: true, decodeRate: 12 });
  let got = run(p, 1000, 1000 + 1500 + 6100, () => true);
  assert.strictEqual(got.length, 2, 'two samples in ~7.5 s');
  assert.deepStrictEqual({ ...got[0], type: undefined }, { type: undefined, codec: 'hevc', depth: 10, width: 3840, height: 2160, fps: 30, vmode: 'soft', playing: true, rate: 1, hidden: false, sinceEventMs: 4500, realtime: false, ratio: 0.4 });
  // Keeping up: real-time samples.
  p = player({ info: { video }, playing: true, decodeRate: 30 });
  got = run(p, 1000, 1000 + 1500 + 3100, () => false);
  assert.deepStrictEqual(got.map((s) => s.realtime), [true]);
  // A blip (behind for a moment after a seek-like stall): mixed window, no sample.
  p = player({ info: { video }, playing: true, decodeRate: 20 });
  got = run(p, 1000, 1000 + 1500 + 3100, (t) => t > 3000 && t < 3500);
  assert.strictEqual(got.length, 0, 'mixed window ignored');
  // A seek in progress restarts the warm-up.
  p = player({ info: { video }, playing: true, decodeRate: 12 });
  run(p, 1000, 3500, () => true);
  p.seekTarget = 5;
  assert.strictEqual(p.sampleSpeed(3550), null);
  p.seekTarget = null;
  got = run(p, 3600, 3600 + 1400 + 3000, () => true);
  assert.strictEqual(got.length, 0, 'no sample before warm-up + a full window after the seek');
  // Native ffmpeg behind: samples too, marked native (the GPU test offer, src/extension.js maybeOfferProbe).
  p = player({ info: { video }, playing: true, decodeRate: 12, cfg: { native: true } });
  got = run(p, 1000, 9000, () => true);
  assert.ok(got.length >= 2 && got.every((s) => s.native === true && s.realtime === false && s.ratio === 0.4), JSON.stringify(got));
  // Paused, other rates, no picture: nothing.
  for (const extra of [{ playing: false }, { rate: 2 }, { vmode: 'none' }]) {
    p = player({ info: { video }, playing: true, decodeRate: 12, ...extra });
    assert.strictEqual(run(p, 1000, 9000, () => true).length, 0, JSON.stringify(extra));
  }
  samples();
});

test('invisible: paused read-ahead is ~1 s for native ffmpeg and WebCodecs, the budget for the built-in decoder', () => {
  const ahead = (extra, until) => {
    const p = player({ firstShown: true, shownT: 0, amode: 'none', ...extra }); // (sound reads ~1.5 s ahead on its own)
    for (let t = 1 / 30; t <= until; t += 1 / 30) p.queue.push(frame(t));
    P.pump.call(p);
    return p.worker.msgs.some((m) => m.type === 'more');
  };
  for (const [what, extra] of [['native', { cfg: { native: true } }], ['webcodecs', { vmode: 'webcodecs' }]]) {
    assert.ok(ahead(extra, 0.5), `${what}: reads on at 0.5 s ahead`);
    assert.ok(!ahead(extra, 1.1), `${what}: reads on past 1 s ahead while paused`);
  }
  assert.ok(ahead({ vmode: 'webcodecs', readVT: 3, vdec: { decodeQueueSize: 3 } }, 0.3), 'webcodecs: packets held in the decoder are not read ahead (it may need more to output them)');
  assert.ok(ahead({}, 1.1), 'built-in decoder: paused read-ahead fills the budget');
  assert.ok(ahead({}, 5), 'built-in decoder: paused read-ahead fills the budget (5 s)');
});

// Mouse-wheel steps back on heavy 4K (2026-11-21): a step back decodes from the keyframe before; notches that came
// meanwhile counted from the frame still shown, so 10 quick notches moved one frame.
const yuvFrame = (t) => ({ t, yuv: { data: { buffer: new ArrayBuffer(8) } }, bytes: 8 });
const seeksOf = (p) => p.worker.msgs.filter((m) => m.type === 'seek');
const shown = (p) => { const fr = p.queue.shift(); p.shownT = fr.t; p.shownFrame = fr; p.shownCount = (p.shownCount || 0) + 1; return fr; };

test('steps back while a step is decoding add up to one target, in few seeks', () => {
  const p = player({ firstShown: true, shownT: 60 / 30, shownCount: 1, pauseT: 2, keptBufs: new WeakSet() });
  P.stepFrame.call(p, -1);
  assert.strictEqual(seeksOf(p).length, 1, 'the first notch seeks at once');
  assert.ok(Math.abs(seeksOf(p)[0].t - 59.5 / 30) < 1e-6, `first target ${seeksOf(p)[0].t * 30}`);
  for (let i = 0; i < 9; i++) P.stepFrame.call(p, -1);
  assert.strictEqual(seeksOf(p).length, 1, 'notches within STEP_SEEK_MS wait for one seek');
  const st = p.stepTo;
  assert.ok(st.timer && Math.abs(st.t - 50 / 30) < 1e-6, `the waiting step is at frame ${st.t * 30}`);
  clearTimeout(st.timer);
  P.flushStep.call(p, st);
  const last = seeksOf(p).pop();
  assert.ok(Math.abs(last.t - 50.5 / 30) < 1e-6, `10 notches back from 60: seek to ${last.t * 30} (frame 50)`);
  // Forward from there while it decodes: from frame 50, not from the 60 still shown.
  ctx.perfNow += 1000;
  P.stepFrame.call(p, 1);
  assert.ok(Math.abs(seeksOf(p).pop().t - 51 / 30) < 1e-6, 'a step forward counts from the pending frame');
  // Once a new frame is shown, steps count from it again.
  p.seekTarget = null;
  p.queue = [yuvFrame(51 / 30)];
  shown(p);
  ctx.perfNow += 1000;
  P.stepFrame.call(p, -1);
  assert.ok(Math.abs(seeksOf(p).pop().t - 50.5 / 30) < 1e-6, 'from the shown frame');
});

test('steps back are served from the frames decoded on the way to the target', () => {
  const p = player({ firstShown: true, shownT: 61 / 30, shownCount: 1, pauseT: 61 / 30, keptBufs: new WeakSet(), amode: 'none' });
  P.stepFrame.call(p, -1); // to frame 60 ... decoded from the keyframe at 50
  const n0 = seeksOf(p).length;
  for (let k = 50; k <= 62; k++) P.addFrame.call(p, yuvFrame(k / 30));
  assert.strictEqual(p.seekTarget, null, 'landed');
  assert.ok(Math.abs(p.queue[0].t - 60 / 30) < 1e-6, `landed on ${p.queue[0].t * 30}`);
  assert.strictEqual(p.back.map((x) => Math.round(x.t * 30)).join(), '50,51,52,53,54,55,56,57,58,59', 'frames before the target kept');
  shown(p);
  for (let k = 59; k >= 55; k--) {
    P.stepFrame.call(p, -1);
    assert.strictEqual(seeksOf(p).length, n0, `step back to ${k} without a seek`);
    assert.ok(Math.abs(p.queue[0].t - k / 30) < 1e-6 && Math.abs(p.pauseT - k / 30) < 1e-6, `frame ${k} next: ${p.queue[0].t * 30}`);
    shown(p);
  }
  // Forward again: the frames stepped back over are in the queue, in order.
  for (let k = 56; k <= 62; k++) {
    P.stepFrame.call(p, 1);
    assert.strictEqual(seeksOf(p).length, n0, `step forward to ${k} without a seek`);
    assert.ok(Math.abs(p.queue[0].t - k / 30) < 1e-6, `frame ${k} next: ${p.queue[0].t * 30}`);
    shown(p);
  }
  // ...and back over them again, from memory (the frames passed forward are kept).
  for (let k = 61; k >= 57; k--) {
    P.stepFrame.call(p, -1);
    assert.strictEqual(seeksOf(p).length, n0, `again back to ${k} without a seek`);
    assert.ok(Math.abs(p.queue[0].t - k / 30) < 1e-6, `again frame ${k} next: ${p.queue[0].t * 30}`);
    shown(p);
  }
  // Rapid notches before the frame is drawn: they add up in memory too.
  P.stepFrame.call(p, -1);
  P.stepFrame.call(p, -1);
  assert.ok(Math.abs(p.queue[0].t - 55 / 30) < 1e-6, `two quick notches from 57: ${p.queue[0].t * 30}`);
  // Playing drops them.
  P.play.call(p);
  assert.strictEqual(p.back.length, 0, 'play drops the kept frames');
});

test('invisible: settled() lets the page rest only when nothing is under way', () => {
  const p = player({ firstShown: true, shownT: 0, pauseT: 0 });
  p.queue.push(frame(0.5));
  assert.ok(P.settled.call(p), 'paused, nothing due');
  for (const [k, v] of [['playing', true], ['seekTarget', 3], ['requesting', true], ['catchUp', true], ['firstShown', false]]) {
    const q = player({ firstShown: true, shownT: 0, pauseT: 0, [k]: v });
    assert.ok(!P.settled.call(q), `settled with ${k}=${v}`);
  }
  const due = player({ firstShown: true, shownT: 0, pauseT: 1 });
  due.queue.push(frame(1));
  assert.ok(!P.settled.call(due), 'a frame due to be shown');
  const dec = player({ firstShown: true, vdec: { decodeQueueSize: 39 } });
  assert.ok(P.settled.call(dec), 'packets held by a paused hardware decoder keep the page awake (its outputs wake it)');
  const hid = player({ hidden: true, playing: true, requesting: true });
  assert.ok(P.settled.call(hid), 'hidden: nothing to draw');
  // The page is woken by the engine's async inputs.
  let woke = 0;
  const { LibavPlayer: L2 } = ctx.createEngine({
    vscode: { postMessage: noop }, canvas: {}, log: noop, showMessage: noop, getState: noop, setMuteUi: noop, toast: noop,
    onMeta: noop, onReady: noop, wake: () => woke++,
  });
  const w = Object.assign(Object.create(L2.prototype), player());
  L2.prototype.onBatch.call(w, { gen: 99, video: [], audio: [] });
  L2.prototype.seekAbs.call(w, 1);
  assert.ok(woke >= 2, `wake() called ${woke} times`);
});

test('invisible: a hidden tab tells native ffmpeg and re-seeks when shown', () => {
  const p = player({ cfg: { native: true }, shownT: 2, firstShown: true });
  P.setHidden.call(p, true);
  assert.ok(p.worker.msgs.some((m) => m.type === 'hidden' && m.on), 'native not told');
  p.queue.push(frame(2.1)); // in flight when hidden
  P.setHidden.call(p, false);
  const seek = p.worker.msgs.find((m) => m.type === 'seek');
  assert.ok(seek && seek.t === 2, `no re-seek to the shown frame (${JSON.stringify(p.worker.msgs)})`);
  // A live stream can't seek back: its ffmpeg keeps running.
  const live = player({ cfg: { native: true }, meta: { duration: 0, live: true }, shownT: 2 });
  P.setHidden.call(live, true);
  assert.ok(!live.worker.msgs.some((m) => m.type === 'hidden'), 'live stream stopped');
});

test('invisible: the AudioContext rests when paused and the clock waits for it on play', async () => {
  ctx.perfNow = 0;
  const calls = [];
  let resolveResume;
  const ac = Object.assign(fakeAc(), {
    suspend() { calls.push('suspend'); this.state = 'suspended'; return Promise.resolve(); },
    resume() { calls.push('resume'); return new Promise((r) => { resolveResume = () => { this.state = 'running'; r(); }; }); },
  });
  const p = player({ ac, amode: 'soft', playing: true, firstShown: true, shownT: 1 });
  P.anchor.call(p, 1);
  P.pause.call(p);
  assert.ok(p.acTimer, 'no rest scheduled on pause');
  clearTimeout(p.acTimer);
  P.restAudio.call(p);
  assert.deepStrictEqual(calls, ['suspend']);
  assert.ok(p.acRest);
  const t0 = p.pauseT;
  P.play.call(p);
  assert.deepStrictEqual(calls, ['suspend', 'resume']);
  ctx.perfNow = 200; // the context takes 200 ms to run again: the clock holds the paused frame
  assert.strictEqual(P.now.call(p), t0, 'the clock ran before the sound');
  assert.ok(!P.audioMaster.call(p), 'sound is the clock before it runs');
  ac.currentTime = 5;
  resolveResume();
  await new Promise((r) => setTimeout(r, 0));
  clearTimeout(p.acWakeTimer);
  assert.ok(!p.acWaking, 'still waiting for the sound');
  P.addAudio.call(p, t0, 48000, [new Float32Array(48000)]);
  P.updateAudioLive.call(p, t0);
  assert.ok(P.audioMaster.call(p), 'the sound drives the clock again');
  ac.currentTime = 5.1;
  assert.ok(Math.abs(P.now.call(p) - (t0 + 0.1)) < 1e-6, `clock ${P.now.call(p)} not from the paused frame`);
  // Hidden while paused: at once. An AudioContext that autoplay left suspended is not ours to manage.
  P.pause.call(p);
  clearTimeout(p.acTimer);
  P.setHidden.call(p, true);
  assert.ok(p.acTimer, 'hidden: no rest');
  clearTimeout(p.acTimer);
  const q = player({ ac: Object.assign(fakeAc(), { state: 'suspended', suspend() { throw new Error('suspend'); } }) });
  P.restAudio.call(q);
  assert.ok(!q.acRest);
});

(async () => {
  // A pending promise alone doesn't keep Node alive. Require the suite to finish.
  process.exitCode = 1;
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e && e.stack || e}`); }
  }
  console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
