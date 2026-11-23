'use strict';
// node test/unit/frame_player_test.js: the MJPEG / image sequence player (media/frame-player.js) in Node, with a
// stubbed canvas, createImageBitmap and Audio: the read-ahead window, eviction, frameAt, seeking, disposal.
const assert = require('node:assert/strict');
const { createFramePlayer } = require('../../media/frame-player');

function setup({ rate = 1, loop = false, muted = true, volume = 1 } = {}) {
  const sent = [];
  const messages = [];
  const draws = [];
  const state = { rate, loop, muted, volume };
  const canvas = {
    width: 0, height: 0, hidden: true,
    getContext: () => ({ drawImage: (bmp) => draws.push(bmp.id) }),
  };
  const FramePlayer = createFramePlayer({
    canvas,
    vscode: { postMessage: (m) => sent.push(m) },
    log: (...a) => messages.push(a.join(' ')),
    showMessage: (t) => messages.push(`msg:${t}`),
    setMute: (m) => { state.muted = m; },
    getRate: () => state.rate,
    getLoop: () => state.loop,
    getMuted: () => state.muted,
    getVolume: () => state.volume,
  });
  return { FramePlayer, canvas, sent, messages, draws, state };
}
const meta = (frames, fps = 24) => ({ frames, fps, width: 640, height: 360 });
const requested = (sent) => sent.filter((m) => m.type === 'frames').flatMap((m) => m.indices);
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const tick = () => new Promise((r) => setImmediate(r));

/** Delivers frame i as a decoded bitmap (what onFrame's createImageBitmap resolves with). */
async function deliver(p, i, closed = []) {
  globalThis.createImageBitmap = async () => ({ id: i, width: 640, height: 360, close: () => closed.push(i) });
  p.onFrame(i, new Uint8Array([i]));
  await tick();
}

function testReadAheadWindow() {
  const { FramePlayer, sent, canvas } = setup();
  const p = new FramePlayer(meta(1000), null);
  assert.equal(canvas.hidden, false);
  assert.deepEqual([canvas.width, canvas.height], [640, 360]);
  // 24 fps at 1x: ahead = ceil(24 * 0.75) + 4 = 22 -> frames 0..22; nothing behind frame 0.
  assert.deepEqual(requested(sent), range(0, 23));
  // A target further on asks for its window and 4 frames behind.
  sent.length = 0;
  p.request(100);
  assert.deepEqual(requested(sent), [...range(100, 23), 99, 98, 97, 96]);
  sent.length = 0;
  p.request(100);
  assert.deepEqual(sent, [], 'everything in the window is in flight');
}

function testWindowScalesWithRate() {
  const fast = setup({ rate: 2 });
  new fast.FramePlayer(meta(1000, 30), null);
  assert.equal(requested(fast.sent).length, 1 + Math.ceil(30 * 2 * 0.75) + 4);
  const cap = setup({ rate: 16 });
  new cap.FramePlayer(meta(1000, 60), null);
  assert.equal(requested(cap.sent).length, 121, 'capped at 120 ahead (+ the target)');
  const slow = setup({ rate: 0.25 });
  new slow.FramePlayer(meta(1000, 10), null);
  assert.equal(requested(slow.sent).length, 7, 'at least 6 ahead (+ the target)');
}

function testEndOfClipAndLoop() {
  const a = setup();
  const p = new a.FramePlayer(meta(30), null);
  a.sent.length = 0;
  p.request(25);
  assert.deepEqual(requested(a.sent), [25, 26, 27, 28, 29, 24, 23, 22, 21].filter((i) => i > 22), 'no wrap without loop');
  const b = setup({ loop: true });
  const q = new b.FramePlayer(meta(30), null);
  b.sent.length = 0;
  q.inflight.clear();
  q.request(28);
  const want = requested(b.sent);
  assert.ok(want.includes(0) && want.includes(1), 'loop reads ahead across the end');
  assert.ok(want.every((i) => i >= 0 && i < 30));
}

async function testEvictionWrapAround() {
  const { FramePlayer, state } = setup({ loop: true });
  const p = new FramePlayer(meta(1000), null);
  const closed = [];
  // Past the threshold (ahead * 3 + 30 = 96 bitmaps): the start and the end of the clip.
  for (let i = 0; i < 100; i++) await deliver(p, i, closed);
  for (let i = 960; i < 1000; i++) await deliver(p, i, closed);
  assert.equal(p.bitmaps.size, 140);
  // Playing at frame 990 with loop: frames 0..44 are ahead across the wrap and stay; 60 is too far ahead.
  p.evict(990, 22);
  assert.ok(p.bitmaps.has(0) && p.bitmaps.has(10), 'the frames after the wrap are ahead of the target');
  assert.ok(p.bitmaps.has(975) && p.bitmaps.has(999));
  assert.ok(!p.bitmaps.has(60) && !p.bitmaps.has(99), 'far ahead (> 2 * window) closed');
  assert.ok(closed.includes(60));
  // Without loop the same frames count as far behind (> 20): the start of the clip goes.
  state.loop = false;
  for (let i = 200; i < 260; i++) await deliver(p, i, closed); // back over the threshold
  p.evict(990, 22);
  assert.ok(!p.bitmaps.has(0) && !p.bitmaps.has(10), 'without loop the start is behind');
  assert.ok(!p.bitmaps.has(960), 'more than 20 behind');
  assert.ok(p.bitmaps.has(975) && p.bitmaps.has(999));
  // Below the threshold nothing is evicted.
  const small = new FramePlayer(meta(1000), null);
  await deliver(small, 500, closed);
  small.evict(0, 22);
  assert.ok(small.bitmaps.has(500));
}

function testFrameAtMath() {
  const { FramePlayer } = setup();
  const p = new FramePlayer(meta(100, 25), null);
  assert.equal(p.duration, 4);
  assert.equal(p.frameAt(0), 0);
  assert.equal(p.frameAt(0.04), 1, 'the frame boundary belongs to the next frame');
  assert.equal(p.frameAt(0.0799999), 1);
  assert.equal(p.frameAt(1 / 3), 8);
  assert.equal(p.frameAt(-5), 0);
  assert.equal(p.frameAt(1e6), 99, 'clamped to the last frame');
  // 29.97 fps: the epsilon keeps a computed frame start on its own frame.
  const q = new FramePlayer(meta(1000, 30000 / 1001), null);
  for (const k of [1, 29, 30, 299, 999]) assert.equal(q.frameAt(k / q.fps), k, `frame ${k}`);
}

function testSeekAndPlayback() {
  const { FramePlayer, sent } = setup();
  const p = new FramePlayer(meta(100, 25), null);
  p.seekFrame(10);
  assert.equal(p.currentFrame(), 10);
  assert.equal(p.currentTime(), 10.5 / 25, 'the middle of the frame');
  assert.equal(p.gen, 1, 'a seek starts a new generation');
  p.seekFrame(-3);
  assert.equal(p.currentFrame(), 0);
  p.seekFrame(500);
  assert.equal(p.currentFrame(), 99);
  p.seekTime(2);
  assert.equal(p.currentFrame(), 50);
  sent.length = 0;
  p.tick(0);
  assert.ok(requested(sent).includes(50) && requested(sent).includes(49), 'a tick asks for the frames around the position');
  // Playing from the last frame starts over.
  p.seekFrame(99);
  const gen = p.gen;
  p.play();
  assert.equal(p.currentFrame(), 0);
  assert.equal(p.gen, gen + 1);
  assert.ok(p.isPlaying());
  p.pause();
  assert.ok(!p.isPlaying());
}

async function testTickShowsFrameAndEnds() {
  const { FramePlayer, draws, state } = setup();
  const p = new FramePlayer(meta(10, 10), null);
  await deliver(p, 0);
  p.tick(0);
  assert.deepEqual(draws, [0]);
  assert.equal(p.shown, 0);
  p.tick(10);
  assert.equal(p.shownCount, 1, 'the same frame is not drawn twice');
  // Playing 1.25 s at 1x runs off the end of a 1 s clip: stops on the last frame (no loop).
  p.playing = true;
  p.last = 0;
  for (const now of [250, 500, 750, 1000, 1250]) p.tick(now);
  assert.ok(!p.isPlaying());
  assert.equal(p.currentFrame(), 9);
  // With loop it wraps to the start and begins a new generation.
  state.loop = true;
  const q = new FramePlayer(meta(10, 10), null);
  q.playing = true;
  q.t = 0.95;
  q.last = 0;
  q.tick(200);
  assert.ok(q.isPlaying());
  assert.ok(q.t < 0.2, 'wrapped');
  assert.equal(q.gen, 1);
}

async function testDecodeFailureAndDispose() {
  const { FramePlayer, messages } = setup();
  const p = new FramePlayer(meta(10, 10), null);
  globalThis.createImageBitmap = () => Promise.reject(new Error('bad jpeg'));
  p.inflight.add(3);
  p.onFrame(3, new Uint8Array(1));
  await tick();
  assert.ok(!p.inflight.has(3));
  assert.ok(messages.includes('msg:Frame 4 could not be decoded.'));
  const closed = [];
  await deliver(p, 5, closed);
  assert.ok(p.bitmaps.has(5));
  globalThis.createImageBitmap = async () => ({ id: 6, width: 1, height: 1, close: () => closed.push(6) });
  p.onFrame(6, new Uint8Array(1));
  p.dispose();
  await tick();
  assert.ok(closed.includes(5), 'held bitmaps closed on dispose');
  assert.ok(closed.includes(6), 'a bitmap arriving after dispose is closed');
  assert.equal(p.bitmaps.size, 0);
  assert.equal(p.inflight.size, 0);
  assert.ok(!p.isPlaying());
  p.dispose(); // twice is fine
}

function testWavAndDispose() {
  const urls = [];
  globalThis.URL.createObjectURL = () => { const u = `blob:${urls.length}`; urls.push(u); return u; };
  globalThis.URL.revokeObjectURL = (u) => urls.splice(urls.indexOf(u), 1);
  globalThis.Audio = class {
    constructor(src) { this.src = src; this.paused = true; }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
  };
  const { FramePlayer } = setup();
  assert.equal(new FramePlayer(meta(10), null).audio, null);
  assert.equal(new FramePlayer(meta(10), [new Uint8Array(0)]).audio, null, 'empty parts: no sound');
  const p = new FramePlayer(meta(10), [new Uint8Array(4), new Uint8Array(4)]);
  assert.ok(p.audio && p.audio.preload === 'auto');
  assert.equal(urls.length, 1);
  p.dispose();
  assert.equal(p.audio, null);
  assert.equal(urls.length, 0, 'the object URL is released');
}

(async () => {
  testReadAheadWindow();
  testWindowScalesWithRate();
  testEndOfClipAndLoop();
  await testEvictionWrapAround();
  testFrameAtMath();
  testSeekAndPlayback();
  await testTickShowsFrameAndEnds();
  await testDecodeFailureAndDispose();
  testWavAndDispose();
  console.log('ok  frame player');
})().catch((e) => { console.error(e); process.exit(1); });
