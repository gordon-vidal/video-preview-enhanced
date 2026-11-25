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
vm.runInContext(fs.readFileSync(path.join(media, 'block-cache.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(media, 'gl-renderer.js'), 'utf8'), ctx);
for (const file of ['codec-utils.js', 'decoder-boot.js']) {
  vm.runInContext(fs.readFileSync(path.join(media, file), 'utf8'), ctx, { filename: file });
}
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
    gl: { drawFrame: noop, drawYuv: noop }, vmode: 'soft', amode: 'soft', worker: { msgs: [], postMessage(m) { this.msgs.push(m); }, terminate: noop },
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

test('remote playback holds through loading and seeking and never rewinds during a blackout', () => {
  ctx.perfNow = 0;
  const p = player({ remoteStream: true, amode: 'none', pump: noop, sampleRemoteLink: noop });
  p.play();
  for (; ctx.perfNow < 3000; ctx.perfNow += 10) {
    p.tick();
    assert.strictEqual(p.playbackPhase(), 'loading');
    assert.strictEqual(p.now(), 0);
  }
  p.addFrame(frame(0));
  p.tick();
  assert.strictEqual(p.playbackPhase(), 'playing');
  for (let i = 1; i <= 30; i++) {
    p.addFrame(frame(i / 30));
    ctx.perfNow = 3000 + i * 1000 / 30;
    p.tick();
  }
  let previous = p.now();
  for (let t = 4010; t <= 5500; t += 10) {
    ctx.perfNow = t;
    assert.ok(p.now() >= previous, 'reading the clock between render ticks must be monotonic');
    previous = p.now();
    p.tick();
    assert.ok(p.now() >= previous, 'starvation must not rewind the clock');
    previous = p.now();
  }
  assert.ok(p.waitPic, 'the blackout reached the starvation path');
  assert.ok(previous <= p.shownT + 0.15 + 1e-6, 'playhead stayed near the frozen picture');
  p.addFrame(frame(1.133));
  p.tick();
  assert.ok(p.shownT > 1 && p.now() >= previous, 'picture and clock resume together');

  p.seekAbs(5);
  for (let i = 0; i < 20; i++) {
    ctx.perfNow += 10;
    p.tick();
    assert.strictEqual(p.playbackPhase(), 'seeking');
    assert.strictEqual(p.now(), 5);
  }
  p.addFrame(frame(5));
  p.tick();
  p.pause();
  ctx.perfNow += 1000;
  assert.strictEqual(p.playbackPhase(), 'paused');
  assert.strictEqual(p.now(), 5);
});

test('shown frame numbers tolerate rounded PTS without advancing for snapped rates', () => {
  const rounded = player({ startT: 0.007, shownT: 0.073, fps: 30, info: { video: { fps: 30 } } });
  assert.strictEqual(rounded.currentFrame(), 2);
  const fractional = player({ meta: { duration: 11 }, info: { video: { fps: 29.9 } }, shownT: 300 / 29.9 });
  fractional.setFrameRate(29.9);
  assert.strictEqual(fractional.fps, 30000 / 1001);
  assert.strictEqual(fractional.currentFrame(), 300);
  // After the rates have drifted by multiple pictures, a step by label still advances.
  fractional.meta.duration = 31;
  fractional.setFrameRate(29.9);
  fractional.shownT = 900 / 29.9;
  let target;
  fractional.seekTime = (t) => { target = t; };
  fractional.seekFrame(fractional.currentFrame() + 1);
  assert.strictEqual(target, 901.5 / 29.9);
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
  const p = player({ playing: true, fps: 120, amode: 'none', eof: true, shownT: 0 });
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

/** Playing at media time t on the timer clock (a picture already shown: before the first one the clock holds). */
function playingAt(p, t) { ctx.perfNow = 0; p.playing = true; if (p.shownT === null) p.shownT = t; P.anchor.call(p, t); }
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

test('a WebCodecs error reads the picture again from the failure; the end of the file waits for the answer', async () => {
  const { VideoDecoder, EncodedVideoChunk } = ctx;
  const made = [];
  ctx.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
  ctx.VideoDecoder = class {
    constructor(cb) { this.cb = cb; this.state = 'configured'; this.decodeQueueSize = 0; this.chunks = []; made.push(this); }
    configure() {}
    decode(chunk) { this.chunks.push(chunk.timestamp / 2e6); }
    flush() { return new Promise((res, rej) => { this.flushed = { res, rej }; }); }
    close() { this.state = 'closed'; }
    /** As Chromium: closed, the pending flush rejected, the packets it held gone, then the error callback. */
    fail() { this.state = 'closed'; if (this.flushed) this.flushed.rej(new Error('EncodingError')); this.cb.error(new Error('damaged packet')); }
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const pk = (t, key = false) => ({ kind: 'packet', t, key, idr: key ? true : undefined, data: new Uint8Array(1) });
  const file = () => [pk(0, true), pk(0.5), pk(1, true), pk(1.5), pk(2, true), pk(2.5)];
  const vf = (t) => ({ timestamp: Math.round(t * 1e6) * 2, displayWidth: 2, displayHeight: 2, close: noop });
  const start = () => {
    const p = player({ vmode: 'webcodecs', amode: 'none', vconf: {}, noSpill: true, gl: { norm16: null }, addFrame: noop });
    made.length = 0;
    p.makeVideoDecoder();
    return p;
  };
  const sent = (p, type) => p.worker.msgs.filter((m) => m.type === type);
  try {
    // A short file: every packet and the end of the file are in the decoder's hands when it fails after 0.5 s.
    let p = start();
    p.onBatch({ gen: 0, eof: true, video: file(), audio: [] });
    assert.deepStrictEqual(made[0].chunks, [0, 0.5, 1, 1.5, 2, 2.5]);
    made[0].cb.output(vf(0));
    made[0].cb.output(vf(0.5));
    made[0].fail();
    assert.strictEqual(made.length, 2, 'no new decoder after the error');
    assert.deepStrictEqual(sent(p, 'rereadVideo').map((m) => [m.gen, m.t]), [[0, 0.5]], 'the picture is not asked for again from the last one that came out');
    await tick();
    assert.strictEqual(p.eof, false, 'the failed flush counts as the end of the file');
    p.pump();
    assert.strictEqual(sent(p, 'more').length, 0, 'reads go on before the worker has rewound');
    // A batch read before the rewind arrives late: its picture comes again, it must not reach the new decoder twice.
    p.onBatch({ gen: 0, eof: false, video: [pk(2, true)], audio: [] });
    assert.deepStrictEqual(made[1].chunks, []);
    p.worker.msgs.length = 0;
    await p.onWorker({ type: 'videoReread', gen: 0, rewound: true });
    assert.strictEqual(sent(p, 'more').length, 1, 'no read after the rewind');
    // The worker starts again at the keyframe before the failure: the new decoder takes the first one after it.
    p.onBatch({ gen: 0, eof: true, video: file(), audio: [] });
    assert.deepStrictEqual(made[1].chunks, [1, 1.5, 2, 2.5]);
    assert.strictEqual(p.eof, false);
    made[1].flushed.res();
    await tick();
    assert.strictEqual(p.eof, true, 'no end of the file after the re-read');

    // The worker can't rewind (no timestamps to find the place): the end that was held back is reached after all.
    p = start();
    p.onBatch({ gen: 0, eof: true, video: file(), audio: [] });
    made[0].cb.output(vf(0));
    made[0].fail();
    await tick();
    assert.strictEqual(p.eof, false);
    await p.onWorker({ type: 'videoReread', gen: 0, rewound: false });
    made[1].flushed.res();
    await tick();
    assert.strictEqual(p.eof, true, 'the end of the file is lost when the picture can not be read again');
    assert.strictEqual(sent(p, 'more').length, 0);

    // A damaged keyframe (nothing comes out of the decoder started on it): on at the next one, not the same again.
    p = start();
    p.onBatch({ gen: 0, eof: false, video: file().slice(2), audio: [] });
    made[0].fail();
    assert.deepStrictEqual(sent(p, 'rereadVideo').map((m) => m.t), [1]);
    await p.onWorker({ type: 'videoReread', gen: 0, rewound: true });
    p.onBatch({ gen: 0, eof: false, video: file(), audio: [] });
    assert.deepStrictEqual(made[1].chunks, [2, 2.5]);

    // A seek meanwhile: the answer to the old read is ignored, and the new read is not held up.
    p = start();
    p.onBatch({ gen: 0, eof: false, video: file(), audio: [] });
    made[0].cb.output(vf(0));
    made[0].fail();
    p.worker.msgs.length = 0;
    p.seekAbs(2);
    await p.onWorker({ type: 'videoReread', gen: 0, rewound: true });
    await p.onWorker({ type: 'seeked', gen: 1 });
    assert.strictEqual(sent(p, 'more').length, 1, 'the read after the seek is held up');
    p.onBatch({ gen: 1, eof: false, video: file().slice(4), audio: [] });
    assert.deepStrictEqual(made[made.length - 1].chunks, [2, 2.5], 'the seek does not start at its own keyframe');
  } finally {
    Object.assign(ctx, { VideoDecoder, EncodedVideoChunk });
  }
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
  const p = player();
  const before = posted.length;
  p.onWorkerRead(100, 1 << 20);
  assert.deepStrictEqual({ ...posted[before] }, { type: 'readBlock', page: undefined, pos: 0, len: 1 << 20 });
  p.onBlock(0, null, 'EIO');
  const fail = p.worker.msgs.find((m) => m.type === 'block');
  assert.ok(fail && fail.data.byteLength === 0 && fail.pos === 100, 'reader still waiting after a read error');
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
  const sent = [];
  p.sendBlock = (rid) => sent.push(rid);
  for (const rid of [0, 1, 2]) p.onWorkerRead(rid * (8 << 20), 1 << 20, rid);
  pool.fallback('test');
  await tick0();
  for (const rid of [0, 1, 2]) p.onBlock(rid * (8 << 20), new Uint8Array(1));
  assert.deepStrictEqual(sent, [0], 'stale readers kept');
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
  assert.strictEqual(p.frameAt(p.pendingStep().t), 50, 'the bar can read the pending frame');
  assert.strictEqual(p.currentFrame(), 60, 'the shown frame stays available for marks and exports');
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
  assert.strictEqual(p.pendingStep(), null, 'the step readout clears once the picture is shown');
  ctx.perfNow += 1000;
  P.stepFrame.call(p, -1);
  assert.ok(Math.abs(seeksOf(p).pop().t - 50.5 / 30) < 1e-6, 'from the shown frame');
});

test('a buffered seek clears a pending step even without a generation change', () => {
  const p = player({ shownT: 1, shownCount: 1, queue: [frame(2), frame(3)] });
  p.stepTo = { t: 2, gen: p.gen, shown: p.shownCount, at: 0 };
  assert.ok(p.pendingStep());
  p.seekTime(2.5);
  assert.strictEqual(p.gen, 0);
  assert.strictEqual(p.pendingStep(), null);
});

test('a paused live step uses retained pictures and rejects a step that needs a seek', () => {
  const p = player({ meta: { live: true }, shownT: 1, pauseT: 1, shownCount: 1 });
  p.stepFrame(-1);
  p.stepFrame(-1);
  assert.strictEqual(p.pendingStep(), null, 'an unreachable goal never appears on the bar');
  assert.strictEqual(p.currentTime(), 1, 'the picture stays frozen');
  assert.strictEqual(seeksOf(p).length, 0);

  p.queue.push(yuvFrame(1 + 1 / 30));
  p.stepFrame(1);
  assert.strictEqual(p.pendingStep().t, 1 + 1 / 30, 'a buffered live step still works');
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

test('unmuting after playing on a suspended AudioContext hands the clock to audio without jumping back', async () => {
  ctx.perfNow = 0;
  let resolveResume;
  const ac = Object.assign(fakeAc(), {
    state: 'suspended',
    currentTime: 0,
    resume() { return new Promise((r) => { resolveResume = () => { this.state = 'running'; r(); }; }); },
    createBufferSource() {
      return {
        buffer: null, onended: null, connect() {},
        start(when, offset = 0) { this.started = { when, offset }; },
        stop() {},
      };
    },
  });
  const muteUiCalls = [];
  const { LibavPlayer: L } = ctx.createEngine({
    vscode: { postMessage: noop }, canvas: {}, log: noop, showMessage: noop, getState: noop,
    setMuteUi: (m) => muteUiCalls.push(m), toast: noop, onMeta: noop, onReady: noop,
  });
  const p = Object.assign(Object.create(L.prototype), player({
    ac, gain: { gain: { value: 1 } }, amode: 'soft', firstShown: true, shownT: 0,
    queue: [frame(5.0), frame(5.033)],
  }));
  // Decoded sound covering 0..6 s while AudioContext is suspended by autoplay policy.
  for (let i = 0; i < 6; i++) L.prototype.addAudio.call(p, i, 48000, [new Float32Array(48000)]);
  L.prototype.play.call(p);
  assert.deepStrictEqual(muteUiCalls, [true], 'autoplay on a suspended AudioContext mutes the UI');
  assert.strictEqual(p.anchoredOnAudio, false, 'anchored on the timer clock while suspended');

  // Play for 5 seconds on the timer clock while audio is decoded ahead.
  ctx.perfNow = 5000;
  L.prototype.tick.call(p);
  assert.strictEqual(p.shownT, 5.0);
  assert.strictEqual(p.audioLive, true, 'decoded sound covers the playhead even while suspended');
  assert.strictEqual(p.anchoredOnAudio, false);

  // User clicks Unmute: setVolume resumes the AudioContext, which flips state to running with currentTime still near 0.
  L.prototype.setVolume.call(p, 0.8, false);
  ac.currentTime = 0.02;
  resolveResume();
  await new Promise((r) => setTimeout(r, 0));

  // Before the next tick, now() must still read from the outgoing timer clock (5.0 s), never the stale anchorMedia (0 s).
  assert.strictEqual(L.prototype.audioMaster.call(p), true);
  assert.strictEqual(p.anchoredOnAudio, false);
  assert.ok(Math.abs(L.prototype.now.call(p) - 5.0) < 1e-6, `now() jumped to ${L.prototype.now.call(p)} instead of staying at 5.0`);

  // The next tick hands the clock cleanly to audio at 5.033 s and schedules audio from there.
  ctx.perfNow = 5033;
  L.prototype.tick.call(p);
  assert.strictEqual(p.anchoredOnAudio, true, 'clock handed off to audio');
  assert.strictEqual(p.shownT, 5.033, 'video picture continues advancing without freezing');
  assert.ok(Math.abs(p.anchorMedia - 5.033) < 1e-6 && Math.abs(p.anchorAc - 0.02) < 1e-6);
  assert.strictEqual(p.sources.size, 1, 'current audio chunk scheduled immediately at playhead');
  const [src] = p.sources;
  assert.ok(Math.abs(src.started.offset - 0.033) < 1e-6, `audio started at offset ${src.started.offset} within chunk [5, 6]`);

  // Audio clock advances from the handoff point.
  ac.currentTime = 0.52;
  assert.ok(Math.abs(L.prototype.now.call(p) - 5.533) < 1e-6, `audio clock at ${L.prototype.now.call(p)}`);
  assert.deepStrictEqual(muteUiCalls, [true, false], 'resuming the AudioContext clears the transient autoplay mute UI');

  // Compare the timestamp actually issued to Web Audio with the picture actually drawn.
  const picture = (t) => { p.addFrame(frame(t)); p.tick(); };
  const drift = (chunk, label) => {
    const { when, offset } = chunk.src.started;
    const audioClock = chunk.t + offset + ac.currentTime - when;
    assert.ok(Math.abs(audioClock - p.shownT) <= 1 / 30, `${label}: audio ${audioClock}, video ${p.shownT}`);
  };
  for (let i = 0; i <= 12; i++) {
    ac.currentTime = 0.52 + i / 30;
    ctx.perfNow = 5533 + i * 1000 / 30;
    picture(5.533 + i / 30);
    drift(p.audio.at(-1), 'steady playback after unmute');
  }
  src.onended();
  ac.currentTime += 1.5;
  ctx.perfNow += 1500;
  const beforeDry = p.now();
  picture(beforeDry);
  assert.strictEqual(p.anchoredOnAudio, false, 'dry audio hands off to the timer');
  assert.ok(Math.abs(p.shownT - beforeDry) <= 1 / 30, 'picture follows the handoff');
  ctx.perfNow += 100;
  ac.currentTime += 0.1;
  const recoveredAt = p.now();
  p.addAudio(recoveredAt - 0.02, 48000, [new Float32Array(48000)]);
  picture(recoveredAt);
  assert.strictEqual(p.anchoredOnAudio, true, 'recovered audio becomes master again');
  drift(p.audio.at(-1), 'recovery');
});

test('pausing while wakeAudio is still resuming keeps acRest so the next play does not self-mute', async () => {
  let resolveResume;
  const ac = Object.assign(fakeAc(), {
    state: 'running',
    suspend() { this.state = 'suspended'; return Promise.resolve(); },
    resume() { return new Promise((r) => { resolveResume = () => { this.state = 'running'; r(); }; }); },
  });
  const muteUiCalls = [];
  const { LibavPlayer: L } = ctx.createEngine({
    vscode: { postMessage: noop }, canvas: {}, log: noop, showMessage: noop, getState: noop,
    setMuteUi: (m) => muteUiCalls.push(m), toast: noop, onMeta: noop, onReady: noop,
  });
  const p = Object.assign(Object.create(L.prototype), player({
    ac, gain: { gain: { value: 1 } }, amode: 'soft', firstShown: true, shownT: 1, acUnlocked: true,
  }));
  // Pause rests the running AudioContext.
  L.prototype.restAudio.call(p);
  assert.strictEqual(ac.state, 'suspended');
  assert.strictEqual(p.acRest, true);

  // Play begins waking the rested AudioContext, then pause/restAudio happens before resume() resolves.
  L.prototype.play.call(p);
  assert.strictEqual(p.acWaking, true);
  L.prototype.pause.call(p);
  clearTimeout(p.acTimer);
  L.prototype.restAudio.call(p);
  assert.strictEqual(p.acRest, true, 'restAudio while still waking remembers that we own the suspension');

  // Playing again must wake the AudioContext without treating it as autoplay-blocked (never calling setMuteUi(true)).
  L.prototype.play.call(p);
  assert.deepStrictEqual(muteUiCalls, [], 'unlocked rested AudioContext must never self-mute on play');
  resolveResume();
  await new Promise((r) => setTimeout(r, 0));
  clearTimeout(p.acWakeTimer);
});

test('Compare A-B wraps before EOF can pause playback', () => {
  const p = player({ eof: true, shownT: 3, lastT: 3, loop: false });
  playingAt(p, 3.2);
  p.tick(0, { start: 1, end: 3 });
  assert.ok(p.playing, 'a delayed tick at the end stopped the clock');
  assert.strictEqual(p.seekTarget, 1);
});

test('Compare A-B shows B but never shows the following close VFR picture', () => {
  const p = player({ shownT: 1.96, queue: [frame(2), frame(2.004), frame(2.04)], loop: false });
  playingAt(p, 2.002);
  const range = { start: 1, end: 2 };
  p.tick(0, range);
  assert.strictEqual(p.shownT, 2, 'early presentation must stop at B');
  assert.strictEqual(p.seekTarget, null, 'the next picture time has not arrived');
  playingAt(p, 2.005);
  p.tick(0, range);
  assert.strictEqual(p.seekTarget, 1, 'wrapped at the actual next picture');
  assert.strictEqual(p.shownT, 2);
});

test('WebCodecs keeps only visible packets in a generated two-edit MP4', async () => {
  const os = require('os');
  const { spawnSync, execFileSync } = require('child_process');
  const { Session, shutdownWorkers } = require('../tracks/driver');
  const ffmpeg = process.env.VPE_FFMPEG || 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status !== 0) {
    console.log('    ffmpeg unavailable, skipping generated two-edit media');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-two-edits-'));
  let session;
  const { VideoDecoder, EncodedVideoChunk } = ctx;
  try {
    const file = path.join(dir, 'two-edits.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=25:d=4',
      '-c:v', 'libx264', '-g', '25', '-bf', '0', '-sc_threshold', '0', '-movie_timescale', '1000', file],
    { windowsHide: true });
    // The default muxer writes moov last. Growing its edit list keeps media offsets intact.
    const movie = fs.readFileSync(file);
    const typeAt = (type) => {
      const at = movie.indexOf(type, movie.lastIndexOf('moov'));
      assert(at > 0, `missing ${type} box`);
      return at;
    };
    const elst = typeAt('elst');
    const count = elst + 8;
    assert.equal(movie.readUInt32BE(count), 1);
    assert.equal(movie[elst + 4], 0, 'expected 32-bit edit entries');
    const entries = Buffer.alloc(28);
    entries.writeUInt32BE(2, 0);
    entries.writeUInt32BE(1000, 4);
    entries.writeUInt32BE(0x00010000, 12);
    entries.writeUInt32BE(1000, 16);
    const timescale = movie.readUInt32BE(typeAt('mdhd') + 16);
    entries.writeUInt32BE(Math.round(2.6 * timescale), 20);
    entries.writeUInt32BE(0x00010000, 24);
    for (const name of ['moov', 'trak', 'edts', 'elst']) {
      const size = typeAt(name) - 4;
      movie.writeUInt32BE(movie.readUInt32BE(size) + 12, size);
    }
    fs.writeFileSync(file, Buffer.concat([movie.subarray(0, count), entries, movie.subarray(count + 16)]));

    session = await new Session(file, { video: 'webcodecs' }).open();
    const packets = [];
    let eof;
    do {
      const batch = await session.more();
      packets.push(...batch.video);
      eof = batch.eof;
    } while (!eof);
    const visible = packets.filter((p) => !p.discard);
    assert.equal(visible.length, 50, 'two seconds of visible video');
    const discardedTimes = new Set(packets.filter((p) => p.discard).map((p) => p.t));
    assert(visible.some((p) => discardedTimes.has(p.t)), 'fixture must contain a visible and a discard packet with the same PTS');

    const decoded = [];
    ctx.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
    ctx.VideoDecoder = class {
      constructor({ output }) { this.output = output; }
      configure() { this.state = 'configured'; }
      decode(chunk) { decoded.push(chunk); }
    };
    const shown = [];
    const p = player({ vmode: 'webcodecs', noSpill: true, addFrame: (f) => shown.push([f.t, f.vf.data]), pump: noop });
    p.makeVideoDecoder();
    p.onBatch({ gen: 0, audio: [], video: packets });
    for (const chunk of decoded) p.vdec.output({ ...chunk, close: noop });
    assert.equal(shown.length, visible.length);
    visible.forEach((it, i) => {
      assert.equal(shown[i][1], it.data, `wrong packet at visible picture ${i}`);
      assert.equal(shown[i][0], Math.round(it.t * 1e6) / 1e6, 'original presentation time');
    });
  } finally {
    Object.assign(ctx, { VideoDecoder, EncodedVideoChunk });
    session?.close();
    await shutdownWorkers();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose settles pending track waits, cancels queued track ops, guards audioConfig, and drops step-back/lastShown', async () => {
  // Case A: disposed while waiting on worker reply, with a second track op queued behind it.
  let terminated = 0;
  let vfClosed = 0;
  const p = player({
    audioId: 0,
    subId: null,
    info: { tracks: { audio: [{ id: 0, codec: 'aac' }, { id: 1, codec: 'opus' }], sub: [{ id: 2, codec: 'subrip', kind: 'text' }] } },
    back: [{ yuv: new Uint8Array(16), bytes: 16 }],
    backBytes: 16,
    lastShown: { vf: { close() { vfClosed++; } }, yuv: new Uint8Array(16) },
    worker: { msgs: [], postMessage(m) { this.msgs.push(m); }, terminate() { terminated++; } },
  });
  const subP = P.selectSub.call(p, 2);
  const audioP = P.selectAudio.call(p, 1);
  await tick0();
  assert.strictEqual(p.worker.msgs.length, 1);
  assert.strictEqual(p.worker.msgs[0].type, 'selectSub');
  P.dispose.call(p);
  P.dispose.call(p); // idempotent
  const [r1, r2] = await Promise.allSettled([subP, audioP]);
  assert.strictEqual(r1.status, 'rejected');
  assert.strictEqual(r1.reason && r1.reason.disposed, true);
  assert.strictEqual(r2.status, 'rejected');
  assert.strictEqual(r2.reason && r2.reason.disposed, true);
  assert.strictEqual(p.worker.msgs.length, 1, 'queued selectAudio must not post after dispose');
  assert.strictEqual(terminated, 1);
  assert.strictEqual(p.waits.length, 0);
  assert.strictEqual(p.back.length, 0);
  assert.strictEqual(p.backBytes, 0);
  assert.strictEqual(vfClosed, 1);
  assert.strictEqual(p.lastShown, null);

  // Case B: disposed while selectAudio is awaiting audioConfig().
  let resolveConf;
  const q = player({
    audioId: 0,
    info: { tracks: { audio: [{ id: 0, codec: 'aac' }, { id: 1, codec: 'opus' }], sub: [] } },
    audioConfig: () => new Promise((r) => { resolveConf = r; }),
    worker: { msgs: [], postMessage(m) { this.msgs.push(m); }, terminate() {} },
  });
  const aP = P.selectAudio.call(q, 1);
  await tick0();
  assert.ok(resolveConf, 'audioConfig should be in flight');
  P.dispose.call(q);
  resolveConf({ mode: 'soft', conf: null });
  const [ra] = await Promise.allSettled([aP]);
  assert.strictEqual(ra.status, 'rejected');
  assert.strictEqual(ra.reason && ra.reason.disposed, true);
  assert.strictEqual(q.worker.msgs.length, 0, 'no worker message after dispose during audioConfig');
  assert.strictEqual((q.waits || []).length, 0, 'no waiter registered after dispose');
});

test('stepBack from a GPU VideoFrame preserves frame N so step-back then step-forward shows N -> N-1 -> N', () => {
  const f = 1 / 30;
  const tPrev = 1 - f;
  const tCur = 1;
  const tNext = 1 + f;
  let closed = 0;
  function makeVf(id) {
    return {
      id, format: 'NV12', codedWidth: 64, codedHeight: 64,
      clone() { return makeVf(id); },
      close() { closed++; },
    };
  }
  const p = player({
    playing: false, fps: 30, startT: 0, meta: { duration: 10 },
    shownT: tCur, pauseT: tCur, seekTarget: null, keptBufs: new Set(),
    back: [{ t: tPrev, yuv: { data: new Uint8Array(16) }, bytes: 16 }],
    backBytes: 16,
    queue: [{ t: tNext, vf: makeVf('N+1') }],
  });
  P.noteShown.call(p, { t: tCur, vf: makeVf('N') });
  assert.strictEqual(p.shownFrame, null, 'GPU frame clears shownFrame');
  assert.ok(p.lastShown && p.lastShown.vf, 'lastShown holds GPU clone');

  // Step back: N -> N-1 (served from spilled back cache; N cloned into forward queue).
  P.stepFrame.call(p, -1);
  P.tick.call(p);
  assert.ok(Math.abs(p.shownT - tPrev) < 1e-6, `expected N-1 (${tPrev}), got ${p.shownT}`);
  assert.ok(p.queue.some((x) => Math.abs(x.t - tCur) < 1e-6), 'frame N restored into forward queue');

  // Step forward: N-1 -> N (must NOT skip to N+1).
  P.stepFrame.call(p, 1);
  P.tick.call(p);
  assert.ok(Math.abs(p.shownT - tCur) < 1e-6, `expected N (${tCur}), got ${p.shownT}`);
  assert.strictEqual(p.lastShown.vf.id, 'N', 'displayed frame N, not N+1');
  assert.ok(closed >= 1, 'released VideoFrame clones are closed');

  // When N cannot be restored (no shownFrame and no lastShown.vf), stepBack returns null so stepFrame seeks.
  const q = player({
    playing: false, fps: 30, startT: 0, meta: { duration: 10 },
    shownT: tCur, pauseT: tCur, seekTarget: null, shownFrame: null, lastShown: null,
    back: [{ t: tPrev, yuv: { data: new Uint8Array(16) }, bytes: 16 }],
    backBytes: 16,
    queue: [{ t: tNext, vf: makeVf('N+1') }],
  });
  assert.strictEqual(P.stepBack.call(q, 1, tCur), null, 'falls back to seek when N cannot be restored');
  assert.strictEqual(q.back.length, 1, 'back cache untouched on fallback');
});

test('VFR backward stepping lands on the exact adjacent picture in dense and sparse cadences', () => {
  // Dense 60 fps section inside a 30 fps-nominal VFR stream (cache hit).
  const dense = player({
    firstShown: true, fps: 30, startT: 0, meta: { duration: 10 },
    shownT: 2 + 5 / 60, pauseT: 2 + 5 / 60, shownCount: 1, keptBufs: new WeakSet(), amode: 'none',
  });
  dense.shownFrame = yuvFrame(2 + 5 / 60);
  for (let i = 0; i < 5; i++) P.keepBack.call(dense, yuvFrame(2 + i / 60));
  const seeks0 = seeksOf(dense).length;
  P.stepFrame.call(dense, -1);
  assert.strictEqual(seeksOf(dense).length, seeks0, 'dense VFR step back uses cache');
  assert.ok(Math.abs(dense.queue[0].t - (2 + 4 / 60)) < 1e-6, `landed on ${dense.queue[0].t}, expected ${2 + 4 / 60}`);
  // Rapid second step back before tick() counts from the actual previous picture, not nominal 1/fps.
  P.stepFrame.call(dense, -1);
  assert.strictEqual(seeksOf(dense).length, seeks0, 'rapid dense VFR step back uses cache');
  assert.ok(Math.abs(dense.queue[0].t - (2 + 3 / 60)) < 1e-6, `landed on ${dense.queue[0].t}, expected ${2 + 3 / 60}`);

  // Sparse 15 fps section inside a 30 fps-nominal VFR stream (66.7 ms > 1.5/30): cache stays intact.
  const sparse = player({
    firstShown: true, fps: 30, startT: 0, meta: { duration: 10 },
    shownT: 3 / 15, pauseT: 3 / 15, shownCount: 1, keptBufs: new WeakSet(), amode: 'none',
  });
  sparse.shownFrame = yuvFrame(3 / 15);
  for (let i = 0; i < 3; i++) P.keepBack.call(sparse, yuvFrame(i / 15));
  assert.strictEqual(sparse.back.length, 3, 'sparse VFR frames are not dropped from back cache');
  P.stepFrame.call(sparse, -1);
  assert.strictEqual(seeksOf(sparse).length, 0, 'sparse VFR step back uses cache');
  assert.ok(Math.abs(sparse.queue[0].t - 2 / 15) < 1e-6, `landed on ${sparse.queue[0].t}, expected ${2 / 15}`);

  // Cache-miss seek in dense 60 fps VFR (e.g. stepping back from a keyframe): lands on N-1, not N-2.
  const miss = player({
    firstShown: true, fps: 30, startT: 0, meta: { duration: 10 },
    shownT: 3.0, pauseT: 3.0, shownCount: 1, keptBufs: new WeakSet(), amode: 'none',
  });
  P.stepFrame.call(miss, -1);
  assert.strictEqual(seeksOf(miss).length, 1, 'cache miss triggers seek');
  for (let i = 55; i <= 60; i++) P.addFrame.call(miss, yuvFrame(2 + i / 60));
  assert.strictEqual(miss.seekTarget, null, 'seek landed');
  assert.ok(Math.abs(miss.queue[0].t - (2 + 59 / 60)) < 1e-6, `landed on ${miss.queue[0].t}, expected ${2 + 59 / 60}`);
  assert.ok(Math.abs(miss.pauseT - (2 + 59 / 60)) < 1e-6, 'pauseT matches exact previous picture');
  assert.strictEqual(miss.back.length, 4, 'prior pictures kept in back cache');

  // Forward in-queue seekTime drops stale back frames so a later step back does not jump to an old run.
  const jump = player({
    firstShown: true, fps: 30, startT: 0, meta: { duration: 10 },
    shownT: 1 / 30, pauseT: 1 / 30, shownCount: 1, keptBufs: new WeakSet(), amode: 'none',
    back: [yuvFrame(0)], backBytes: 8,
    queue: [yuvFrame(2 / 30), yuvFrame(3 / 30), yuvFrame(4 / 30)],
  });
  P.seekTime.call(jump, 4 / 30);
  assert.strictEqual(jump.back.length, 0, 'in-queue jump drops stale back cache');
});

test('Astra review: an in-flight remote copy forces a back-cache miss; rapid VFR notches count pictures; paused tick takes only its step', () => {
  // 1. N-2 copied, N-1 still copying: the finished copy alone cannot prove adjacency.
  const p = player({
    firstShown: true, fps: 30, startT: 0, shownT: 3.0, pauseT: 3.0, shownCount: 1, keptBufs: new WeakSet(), amode: 'none',
    shownFrame: yuvFrame(3.0), back: [yuvFrame(2 + 53 / 60)], backBytes: 8, backSpilling: 1,
  });
  P.stepFrame.call(p, -1);
  assert.strictEqual(p.queue.length, 0, 'no stale N-2 shown while N-1 is copying');
  assert.strictEqual(seeksOf(p).length, 0, 'the step waits for the copy');
  P.runBackRetry.call(p, p.backRetry); // BACK_WAIT_MS passed, the copy still busy
  assert.strictEqual(p.queue.length, 0, 'no stale N-2 shown');
  assert.strictEqual(seeksOf(p).length, 1, 'treated as a cache miss: seeks instead');
  p.backSpilling = 0;
  const q = player({
    firstShown: true, fps: 30, startT: 0, shownT: 3.0, pauseT: 3.0, shownCount: 1, keptBufs: new WeakSet(), amode: 'none',
    shownFrame: yuvFrame(3.0), back: [yuvFrame(2 + 58 / 60)], backBytes: 8,
  });
  assert.notStrictEqual(P.stepBack.call(q, 1, 3.0), null, 'with no copy pending the cache hits');

  // 2. Two rapid notches before the first decode lands: N-2 in a 60 fps section of a 30 fps-nominal stream.
  const m = player({ firstShown: true, fps: 30, startT: 0, meta: { duration: 10 }, shownT: 3.0, pauseT: 3.0, shownCount: 1,
    keptBufs: new WeakSet(), amode: 'none' });
  P.stepFrame.call(m, -1);
  ctx.perfNow += 1; // inside STEP_SEEK_MS: the second notch waits and takes the target over
  P.stepFrame.call(m, -1);
  clearTimeout(m.stepTo.timer);
  P.flushStep.call(m, m.stepTo);
  assert.strictEqual(m.seekBefore, 3.0, 'counts from the picture stepped from');
  assert.strictEqual(m.seekBackCount, 2);
  for (let i = 52; i <= 60; i++) P.addFrame.call(m, yuvFrame(2 + i / 60));
  assert.strictEqual(m.seekTarget, null, 'seek landed');
  assert.ok(Math.abs(m.pauseT - (2 + 58 / 60)) < 1e-6, `landed on ${m.pauseT}, expected N-2 ${2 + 58 / 60}`);
  assert.ok(Math.abs(m.queue[0].t - (2 + 58 / 60)) < 1e-6 && Math.abs(m.queue[1].t - (2 + 59 / 60)) < 1e-6, 'N-1 stays queued');
  assert.strictEqual(m.hold, null);

  // 3. Paused at N-1 in 120 fps VFR (nominal 24 fps, rounded-ms stamps): tick() does not move on to N.
  const ms = (i) => Math.round(i * 1000 / 120) / 1000;
  const t = player({ firstShown: true, fps: 24, startT: 0, shownT: ms(100), pauseT: ms(100), shownCount: 1, amode: 'none',
    queue: [yuvFrame(ms(101)), yuvFrame(ms(102))] });
  t.stepTo = { t: ms(101), gen: t.gen, shown: 1, at: 0 };
  t.pauseT = ms(101);
  P.tick.call(t);
  assert.strictEqual(t.shownT, ms(101), `shown ${t.shownT}, expected ${ms(101)}`);
});

test('opening: the clock holds until the first picture, then runs from there (no count-up and snap back)', () => {
  ctx.perfNow = 0;
  const p = player({ playing: true, amode: 'none' });
  P.anchor.call(p, 0);
  ctx.perfNow = 3000; // the first frame takes 3 s over a slow link
  assert.strictEqual(P.now.call(p), 0, 'the timer ran before a picture was shown');
  assert.strictEqual(P.currentTime.call(p), 0);
  P.tick.call(p); // nothing decoded yet
  assert.strictEqual(P.now.call(p), 0);
  p.queue.push(frame(0), frame(1 / 30));
  P.tick.call(p);
  assert.strictEqual(p.shownT, 0, 'the first frame shows at once');
  assert.ok(!p.behindUntil, 'the wait for the first picture counted as decoding behind');
  assert.strictEqual(P.now.call(p), 0, 'the clock starts at the first picture');
  ctx.perfNow = 3500;
  assert.ok(Math.abs(P.now.call(p) - 0.5) < 1e-9, `then runs normally (${P.now.call(p)})`);
  // A file that starts later (TS at 1.4 s): the clock holds at the start time once it is known.
  ctx.perfNow = 0;
  const ts = player({ playing: true, amode: 'none', startT: null });
  P.anchor.call(ts, 0);
  P.addFrame.call(ts, frame(1.4));
  ctx.perfNow = 2000;
  assert.strictEqual(P.now.call(ts), 1.4);
  P.tick.call(ts);
  assert.strictEqual(ts.shownT, 1.4);
  // Sound only: no picture to wait for, the clock runs.
  ctx.perfNow = 0;
  const a = player({ playing: true, vmode: 'none' });
  P.anchor.call(a, 0);
  ctx.perfNow = 1000;
  assert.ok(Math.abs(P.now.call(a) - 1) < 1e-9, 'a sound-only file waited for a picture');
});

/** A WebCodecs frame stub whose copyTo() finishes when the test says so (copies.shift()()). */
function gpuFrame(t, copies, closed) {
  const vf = {
    format: 'I420', codedWidth: 4, codedHeight: 4, displayWidth: 4, displayHeight: 4, visibleRect: { width: 4, height: 4 },
    colorSpace: {}, allocationSize: () => 24,
    copyTo: () => new Promise((res) => copies.push(() => res([{ offset: 0, stride: 4 }, { offset: 16, stride: 2 }, { offset: 20, stride: 2 }]))),
    close() { if (this.format !== null) closed.push(t); this.format = null; },
  };
  return { t, vf, bytes: 0 };
}
const settle = () => new Promise((r) => setImmediate(r));
async function finishCopies(copies) { while (copies.length) { copies.shift()(); await settle(); } }

test('decoder burst, seek, hide and dispose close every created VideoFrame', async () => {
  const copies = [];
  const closed = [];
  const created = [];
  const oldDecoder = ctx.VideoDecoder;
  ctx.VideoDecoder = class {
    constructor({ output }) { this.output = output; }
    configure() {}
    close() { this.state = 'closed'; }
  };
  const p = player({ remoteStream: true, vmode: 'webcodecs', amode: 'none', noSpill: true, pump: noop });
  function output(decoder, timestamp) {
    const { vf } = gpuFrame(timestamp, copies, closed);
    vf.timestamp = timestamp;
    const close = vf.close.bind(vf);
    vf.close = () => {
      assert.notStrictEqual(vf.format, null, 'each frame closes exactly once');
      close();
    };
    created.push(timestamp);
    decoder.output(vf);
  }
  try {
    p.makeVideoDecoder();
    const first = p.vdec;
    for (let i = 0; i < 40; i++) output(first, i * 80_000);
    p.seekAbs(4);
    output(first, 7_999_998); // A decode callback already queued before the seek.
    assert.strictEqual(closed.length, created.length, 'seek drains old frames and late callbacks');

    const second = p.vdec;
    for (let i = 0; i < 5; i++) output(second, 8_000_000 + i * 80_000);
    p.setHidden(true);
    await finishCopies(copies);
    assert.strictEqual(closed.length, created.length, 'hide drains the queued frames');

    p.setHidden(false);
    const last = p.vdec;
    for (let i = 0; i < 5; i++) output(last, 8_000_002 + i * 80_000);
    p.dispose();
    output(last, 9_000_000);
    await finishCopies(copies);
    assert.deepStrictEqual(closed.sort(), created.sort(), 'disposal leaves no live frames');
  } finally {
    ctx.VideoDecoder = oldDecoder;
  }
});

test('remote batch reassembles one large access unit across reads and drops stale fragments', async () => {
  let pulls = 0;
  const batches = [];
  const p = player({ pump() { pulls++; }, onBatch(batch) { batches.push(batch); } });
  const part = (gen, offset, data) => ({
    gen, video: [{ t: 4, data: Uint8Array.from(data) }], audio: [], fragment: { offset, total: 4 },
  });
  await p.receiveRemoteBatch(part(0, 0, [1, 2]));
  assert.strictEqual(pulls, 1);
  assert.strictEqual(batches.length, 0, 'partial access units never reach the decoder');
  p.seekAbs(4);
  await p.receiveRemoteBatch(part(0, 2, [3, 4]));
  assert.strictEqual(batches.length, 0);
  await p.receiveRemoteBatch(part(1, 0, [5, 6]));
  await p.receiveRemoteBatch(part(1, 2, [7, 8]));
  assert.deepStrictEqual(Array.from(batches[0].video[0].data), [5, 6, 7, 8]);
});

test('remote Live transcode reads further ahead within the existing frame budget', () => {
  const p = player({
    remoteStream: true, info: { remoteStream: { linkAdaptive: true } },
    vmode: 'webcodecs', amode: 'none', playing: true, now: () => 0,
    queue: Array.from({ length: 60 }, (_, i) => ({ t: (i + 1) / 30, bytes: 1000 })),
    frameBudget: 62000, backBytes: 2000,
  });
  p.pump();
  assert.strictEqual(p.worker.msgs.length, 0, 'frames kept for stepping count against the budget');
  p.backBytes = 0;
  p.pump();
  assert.strictEqual(p.worker.msgs.at(-1).type, 'more', 'keeps reading at two seconds buffered');
  p.frameBudget = 120000;
  p.requesting = false;
  p.queue.at(-1).t = 3.25;
  p.pump();
  assert.strictEqual(p.worker.msgs.length, 1, 'stops at the remote playback target');
});

test('remote Live transcode: a whole GOP decoded faster than it copies is kept for steps back, no frame leaks', async () => {
  const copies = [];
  const closed = [];
  const p = player({ remoteStream: true, vmode: 'webcodecs', seekTarget: 3, pump: noop, keptBufs: new WeakSet() });
  const gop = Array.from({ length: 60 }, (_, i) => gpuFrame(1 + i / 30, copies, closed));
  for (const fr of gop) P.keepBack.call(p, fr);
  assert.ok(copies.length <= 3, `${copies.length} copies at once`);
  assert.strictEqual(p.backSpilling, 60, 'every frame is waiting or copying: none dropped');
  await finishCopies(copies);
  assert.strictEqual(p.back.length, 60, `kept ${p.back.length} of 60 (the 5th frame used to drop the run)`);
  assert.strictEqual(p.backSpilling, 0);
  assert.strictEqual(closed.length, 60, 'each GPU frame closed once copied');
  for (let i = 1; i < 60; i++) assert.ok(p.back[i].t > p.back[i - 1].t, 'in time order');

  // Another seek (or play, hide, dispose) while frames wait or copy: all of them are closed, none kept.
  const closed2 = [];
  const q = player({ remoteStream: true, vmode: 'webcodecs', seekTarget: 3, pump: noop });
  for (let i = 0; i < 20; i++) P.keepBack.call(q, gpuFrame(1 + i / 30, copies, closed2));
  P.endSteps.call(q);
  assert.strictEqual(closed2.length, 17, 'waiting frames closed at once');
  await finishCopies(copies);
  assert.strictEqual(closed2.length, 20, 'frames that were copying closed when done');
  assert.strictEqual(q.back.length, 0, 'nothing of the old run kept');
  assert.strictEqual(q.backSpilling, 0);

  // Over the budget: the oldest go, so what stays is contiguous up to the newest.
  const closed3 = [];
  const b = player({ remoteStream: true, vmode: 'webcodecs', seekTarget: 3, pump: noop, frameBudget: 24 * 10 / 0.65 });
  for (let i = 0; i < 30; i++) P.keepBack.call(b, gpuFrame(1 + i / 30, copies, closed3));
  await finishCopies(copies);
  assert.ok(b.back.length >= 8 && b.back.length <= 10, `kept ${b.back.length}`);
  assert.strictEqual(b.back[b.back.length - 1].t, 1 + 29 / 30, 'the newest kept');
  for (let i = 1; i < b.back.length; i++) assert.ok(Math.abs(b.back[i].t - b.back[i - 1].t - 1 / 30) < 1e-6, 'no gap');
  assert.strictEqual(closed3.length, 30, 'frames over the budget closed too');
});

test('remote Live transcode: a step back while the GOP is still copying waits for it instead of seeking', async () => {
  const copies = [];
  const closed = [];
  const p = player({ remoteStream: true, vmode: 'webcodecs', seekTarget: 2, pump: noop, keptBufs: new WeakSet(),
    firstShown: true, shownCount: 1 });
  for (let i = 0; i < 30; i++) P.keepBack.call(p, gpuFrame(1 + i / 30, copies, closed));
  // The seek landed on 2 s while the copies run on.
  p.seekTarget = null;
  p.shownT = p.pauseT = 2;
  p.shownFrame = yuvFrame(2);
  copies.shift()(); await settle(); // one copy done: this.back is not empty, the rest still busy
  P.stepFrame.call(p, -1);
  P.stepFrame.call(p, -1);
  assert.strictEqual(seeksOf(p).length, 0, 'no seek while the copies run');
  assert.ok(p.backRetry && p.backRetry.d === -2, 'the notches wait together');
  await finishCopies(copies);
  assert.strictEqual(p.backRetry, null);
  assert.strictEqual(seeksOf(p).length, 0, 'served from memory');
  assert.ok(Math.abs(p.pauseT - (1 + 28 / 30)) < 1e-6, `two pictures back: ${p.pauseT}`);
});

test('remote Live transcode: quick step notches during a seek coalesce into one seek once they rest', () => {
  const notches = (extra) => {
    ctx.perfNow = 10000;
    const p = player({ firstShown: true, shownT: 4, shownCount: 1, pauseT: 4, keptBufs: new WeakSet(), ...extra });
    P.stepFrame.call(p, -1);
    for (let i = 0; i < 9; i++) { ctx.perfNow += 90; P.stepFrame.call(p, -1); } // notches 90 ms apart (> STEP_SEEK_MS)
    return p;
  };
  const local = notches({});
  assert.ok(seeksOf(local).length >= 9, `local stepping stays snappy (${seeksOf(local).length} seeks)`);
  clearTimeout(local.stepTo && local.stepTo.timer);
  const remote = notches({ remoteStream: true, vmode: 'webcodecs' });
  assert.strictEqual(seeksOf(remote).length, 1, `remote: ${seeksOf(remote).length} seeks for 10 notches over 810 ms`);
  const st = remote.stepTo;
  assert.ok(st.timer, 'the next seek waits for the notches to rest');
  assert.ok(Math.abs(st.t - (4 - 10 / 30)) < 1e-6, `the readout follows every notch (${st.t * 30})`);
  assert.strictEqual(P.quietWait.call(remote, st, ctx.perfNow), 200, 'each notch restarts the quiet wait');
  assert.strictEqual(P.quietWait.call(remote, st, st.quietFrom + 900), 100, 'capped at 1 s after the first waiting notch');
  clearTimeout(st.timer);
  P.flushStep.call(remote, st);
  assert.strictEqual(seeksOf(remote).length, 2);
  assert.ok(Math.abs(seeksOf(remote).pop().t - (4 - 9.5 / 30)) < 1e-6, 'one seek to the final target');
  assert.strictEqual(remote.seekBackCount, 10);
});

test('playbackPhase(): one source of truth for a held or running clock', () => {
  ctx.perfNow = 0;
  const phase = (extra) => { const p = player({ playing: true, shownT: 0, ...extra }); return [p, P.playbackPhase.call(p)]; };
  assert.strictEqual(P.playbackPhase.call(player({ scrubHeldT: 3, playing: true })), 'scrubbing', 'scrub beats everything');
  assert.strictEqual(P.playbackPhase.call(player({ playing: false })), 'paused');
  assert.strictEqual(phase({ shownT: null })[1], 'loading', 'playing, no picture yet');
  assert.strictEqual(phase({ shownT: null, vmode: 'none' })[1], 'playing', 'sound-only files never load a picture');
  assert.strictEqual(phase({ seekTarget: 5 })[1], 'seeking');
  assert.strictEqual(phase({ seekTarget: 5, vmode: 'none' })[1], 'playing', 'sound-only files never wait for a frame');
  assert.strictEqual(phase({ acWaking: true })[1], 'waking');
  assert.strictEqual(phase({ shownT: null, seekTarget: 5, acWaking: true })[1], 'loading', 'loading wins over seeking and waking');
  assert.strictEqual(phase({ seekTarget: 5, acWaking: true })[1], 'seeking');
  assert.strictEqual(phase({ followerClock: () => 7, seekTarget: 5, shownT: null })[1], 'playing', 'a follower runs on its leader');
  // clockRunning() and now() agree: only 'playing' advances.
  const [run] = phase({});
  P.anchor.call(run, 1);
  ctx.perfNow = 500;
  assert.strictEqual(P.clockRunning.call(run), true);
  assert.ok(Math.abs(P.now.call(run) - 1.5) < 1e-9, 'running clock advances');
  for (const extra of [{ seekTarget: 5, pauseT: 2 }, { acWaking: true, pauseT: 2 }, { shownT: null, pauseT: 2 }]) {
    const [held] = phase(extra);
    P.anchor.call(held, 1);
    assert.strictEqual(P.clockRunning.call(held), false);
    assert.strictEqual(P.now.call(held), 2, 'a held clock stays at pauseT');
  }
  assert.strictEqual(P.now.call(player({ scrubHeldT: 3 })), 3);
  assert.strictEqual(P.now.call(player({ pauseT: 4 })), 4);
  assert.strictEqual(P.now.call(player({ playing: true, shownT: 0, followerClock: () => 7, seekTarget: 5 })), 7);
  // Sound may be queued while running or while only the audio context wakes; never while loading or seeking.
  assert.strictEqual(P.audioMayRun.call(phase({})[0]), true);
  assert.strictEqual(P.audioMayRun.call(phase({ acWaking: true })[0]), true);
  assert.strictEqual(P.audioMayRun.call(phase({ seekTarget: 5 })[0]), false);
  assert.strictEqual(P.audioMayRun.call(phase({ shownT: null })[0]), false);
  assert.strictEqual(P.audioMayRun.call(player({ playing: false })), false);
  assert.strictEqual(P.audioMayRun.call(player({ scrubHeldT: 1, playing: true, shownT: 0 })), false);
});

// ---- compare lockstep (media/compare-sync.js) on real engine ticks ----------------------------------------------
const { CompareSyncController } = require('../../media/compare-sync');
/** Frames on a 30 fps grid from `from` to `to` seconds. */
const grid30 = (from, to) => {
  const out = [];
  for (let k = Math.round(from * 30); k <= Math.round(to * 30); k++) out.push(frame(k / 30));
  return out;
};
const compareTile = (key, extra) => player({ key, amode: 'none', pump: noop, cfg: { noStepBack: true }, ...extra });
/** Two compare tiles (clock A, follower B) without offsets, ticked in compare.js's frame-loop order. */
function lockstep(extra) {
  const clock = compareTile('A', extra);
  const follower = compareTile('B', extra);
  const tiles = [clock, follower];
  const sync = new CompareSyncController({ tiles: () => tiles, offset: () => 0, sound: () => 0, now: () => ctx.perfNow });
  sync.setClock(0, false);
  const run = (ms) => {
    for (const end = ctx.perfNow + ms; ctx.perfNow < end;) {
      ctx.perfNow += 1000 / 60;
      clock.tick(ctx.perfNow);
      sync.syncPlaying();
      follower.tick(ctx.perfNow);
    }
  };
  return { clock, follower, sync, run };
}

test('compare: a forward seek while playing does not freeze the lockstep hold', () => {
  ctx.perfNow = 0;
  const { clock, follower, sync, run } = lockstep();
  clock.queue = grid30(0, 1);
  follower.queue = grid30(0, 1);
  clock.play();
  sync.syncPlaying();
  run(300);
  assert.ok(follower.playing && clock.shownT > 0.2, `playing before the seek (clock at ${clock.shownT})`);
  // compare.js seekClock(): the clock seeks, the followers follow at once.
  clock.seekTime(5.02);
  sync.syncPlaying(true);
  assert.notStrictEqual(follower.seekTarget, null, 'the follower seeks with the clock');
  // The decoders land. The clock shows 5.0 (its frame covering 5.02); the follower's target carries the early-frame
  // nudge (5.028), so its landing picture is 5.033: not due while the clock's picture is 5.0.
  for (const fr of grid30(4.9, 7)) clock.addFrame(fr);
  for (const fr of grid30(4.9, 7)) follower.addFrame(fr);
  assert.ok(Math.abs(follower.queue[0].t - 151 / 30) < 1e-9, `follower lands on ${follower.queue[0].t}`);
  // A display tick right after the landing (they arrive between ticks): the clock shows 5.0, its time is 5.022.
  ctx.perfNow += 2;
  clock.tick(ctx.perfNow);
  assert.strictEqual(clock.shownT, 5);
  sync.syncPlaying();
  follower.tick(ctx.perfNow);
  run(500); // well inside the stall limit: the hold itself must not deadlock
  assert.ok(clock.shownT > 5.3, `the clock plays on after the seek (shows ${clock.shownT})`);
  assert.ok(Math.abs(follower.shownT - clock.shownT) <= 2 / 30 + 1e-9, `in step: clock ${clock.shownT}, follower ${follower.shownT}`);
  assert.strictEqual(sync.waiting, false);
});

test('compare: a seek within the decoded frames while playing never takes the clock back', () => {
  ctx.perfNow = 0;
  const { clock, follower, sync, run } = lockstep();
  clock.queue = grid30(0, 3);
  follower.queue = grid30(0, 3);
  clock.play();
  sync.syncPlaying();
  run(200);
  const before = clock.shownT;
  clock.seekTime(2); // decoded already: no seek, the queue skips ahead and the old picture is still on screen
  assert.strictEqual(clock.seekTarget, null);
  assert.strictEqual(clock.syncState().current, false, 'the shown picture predates the jump');
  sync.syncPlaying(true);
  assert.ok(clock.now() >= 2 - 1e-9, `held back to its old picture ${before}: now ${clock.now()}`);
  run(200);
  assert.ok(clock.shownT > 2.1, `the clock plays from 2 s (shows ${clock.shownT})`);
  assert.ok(Math.abs(follower.shownT - clock.shownT) <= 2 / 30 + 1e-9, `in step: clock ${clock.shownT}, follower ${follower.shownT}`);
});

test('compare: a step back seeks a follower whose picture predates its last seek', () => {
  ctx.perfNow = 0;
  const { clock, follower, sync } = lockstep();
  // Paused at 5.0 after a forward seek while playing: pause() took the follower's time from the clock's picture
  // (5.008), before its landing picture (5.033), so it still shows the picture from before the seek.
  Object.assign(clock, { shownT: 5, pauseT: 5, queue: grid30(5 + 1 / 30, 6) });
  Object.assign(follower, { shownT: 1, shownCount: 30 });
  follower.seekAbs(5.02 + 0.25 / 30);
  for (const fr of grid30(4.9, 6)) follower.addFrame(fr);
  follower.pauseT = 5 + 0.25 / 30;
  follower.tick(ctx.perfNow);
  assert.strictEqual(follower.shownT, 1, 'nothing due: the old picture stays');
  assert.strictEqual(follower.syncState().current, false);
  const gen = follower.gen;
  sync.seekFollowers(149 / 30); // a step back on the clock
  assert.strictEqual(follower.gen, gen + 1, 'the follower seeks instead of keeping its stale picture');
  assert.ok(Math.abs(follower.seekTarget - (149.25 / 30)) < 1e-9, `seek target ${follower.seekTarget}`);
  for (const fr of grid30(4.8, 5.5)) follower.addFrame(fr);
  follower.tick(ctx.perfNow);
  assert.ok(Math.abs(follower.shownT - 149 / 30) < 1e-9, `shows the clock's frame: ${follower.shownT}`);
  assert.strictEqual(follower.syncState().current, true);
  assert.strictEqual(follower.syncState().settled, true);
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
