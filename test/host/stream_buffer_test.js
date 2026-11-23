'use strict';
// node test/host/stream_buffer_test.js: the live transcode stream's packet and sound memory
// (src/stream-buffer.js) without ffmpeg: AUD splitting over chunk boundaries, keyframe-aligned trimming,
// and seeking from memory (hit and miss).
const assert = require('node:assert/strict');
const { SeekHistoryBuffer, AUDIO_RATE } = require('../../src/stream-buffer');

const FPS = 10;
/** One access unit: AUD, then an IDR (nal type 5) or non-IDR (1) slice, `fill` marking it. */
const unit = (key, fill) => Buffer.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, key ? 0x65 : 0x41, fill, fill]);
const AUD_TO_AUD = Buffer.concat([unit(true, 1), unit(false, 2), unit(false, 3)]);

function fresh(opts = {}) { return new SeekHistoryBuffer({ fps: FPS, hasAudio: false, ...opts }); }
function feed(b, bytes) { b.pending = b.pending.length ? Buffer.concat([b.pending, bytes]) : bytes; b.split(false); }

function testSplitAcrossChunks() {
  // Every way of cutting the stream in two gives the same packets: units complete only once the next AUD is seen.
  for (let cut = 1; cut < AUD_TO_AUD.length; cut++) {
    const b = fresh();
    feed(b, AUD_TO_AUD.subarray(0, cut));
    feed(b, AUD_TO_AUD.subarray(cut));
    assert.equal(b.vAll.length, 2, `cut ${cut}: the last unit waits for its end`);
    b.split(true);
    assert.equal(b.vAll.length, 3, `cut ${cut}: the final split flushes it`);
    assert.equal(b.pending.length, 0);
    assert.deepEqual(b.vAll.map((p) => p.key), [true, false, false]);
    assert.deepEqual(Buffer.concat(b.vAll.map((p) => Buffer.from(p.data))), AUD_TO_AUD, `cut ${cut}: bytes preserved`);
    assert.deepEqual(b.vAll.map((p) => p.t), [0, 0.1, 0.2]);
  }
  // Bytes before the first AUD are dropped; with no AUD at all nothing is kept (and the end clears them).
  const b = fresh();
  feed(b, Buffer.concat([Buffer.from([7, 7, 7]), AUD_TO_AUD]));
  assert.equal(b.vAll[0].data[0], 0, 'starts at the first unit');
  const c = fresh();
  feed(c, Buffer.from([1, 2, 3]));
  assert.equal(c.vAll.length, 0);
  c.split(true);
  assert.equal(c.pending.length, 0);
}

function testPacketTimes() {
  const b = fresh();
  b.vBase = 2;
  feed(b, AUD_TO_AUD);
  b.split(true);
  assert.deepEqual(b.vAll.map((p) => +p.t.toFixed(3)), [2, 2.1, 2.2]);
  assert.equal(b.frameIndex, 3);
  assert.ok(b.vAll.every((p) => p.kind === 'packet' && p.idr === p.key && p.data instanceof Uint8Array));
}

/** `seconds` of video at FPS with an IDR every `gop` frames, all marked sent. */
function filled(seconds, gop, opts) {
  const b = fresh(opts);
  const bytes = [];
  for (let i = 0; i < seconds * FPS; i++) bytes.push(unit(i % gop === 0, i & 0xff));
  feed(b, Buffer.concat(bytes));
  b.split(true);
  return b;
}

function testTrim() {
  const b = filled(40, 10, {});
  b.vNext = b.vAll.length;
  b.seekT = 39;
  b.trim();
  // Last sent at 39.9 s: keep HISTORY_S (5 s) behind it, from the keyframe at or before 34.9 s = 34.0 s.
  assert.equal(b.vAll[0].t, 34);
  assert.ok(b.vAll[0].key, 'history starts on a keyframe');
  assert.equal(b.vNext, b.vAll.length, 'cursor moved with the cut');

  // A seek target further back keeps more (SEEK_KEEP_S before it) but never more than HISTORY_MAX_S (20 s).
  const c = filled(40, 10, {});
  c.vNext = c.vAll.length;
  c.seekT = 30;
  c.trim();
  assert.equal(c.vAll[0].t, 28, 'seek target 30 s keeps from 28.5 s: the keyframe at 28 s');
  const d = filled(40, 10, {});
  d.vNext = d.vAll.length;
  d.seekT = 0;
  d.trim();
  assert.equal(d.vAll[0].t, 19, 'never more than 20 s behind the last sent (39.9 s): the keyframe at 19 s');

  // Nothing sent: nothing cut.
  const e = filled(40, 10, {});
  e.trim();
  assert.equal(e.vAll.length, 400);
}

function testTrimSound() {
  const b = filled(40, 10, {});
  b.vNext = b.vAll.length;
  b.seekT = 39;
  // 40 s of PCM, nothing sent but the cursor at 39.9 s.
  b.addAudio(Buffer.alloc(40 * AUDIO_RATE * 4));
  b.aNext = Math.round(39.9 * AUDIO_RATE);
  b.trim();
  assert.ok(b.aStore.length === 0 || b.aStore[0].s + b.aStore[0].b.length / 4 > Math.round(34 * AUDIO_RATE), 'sound before the kept video goes');
}

function testAddAudio() {
  const b = fresh({ hasAudio: true });
  assert.equal(b.addAudio(Buffer.alloc(6)), false);
  assert.equal(b.aEnd, 1, 'whole samples only (4 bytes, 2 channels s16)');
  assert.equal(b.aRest.length, 2, 'the partial sample waits');
  b.addAudio(Buffer.alloc(2));
  assert.equal(b.aEnd, 2);
  assert.equal(b.addAudio(Buffer.alloc(4 * AUDIO_RATE * 4)), true, 'four seconds queued: pause the pipe');
  const out = b.takeAudio(AUDIO_RATE, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 's16');
  assert.equal(out[0].data.length, AUDIO_RATE * 4);
  assert.equal(b.aNext, AUDIO_RATE);
  assert.deepEqual(b.takeAudio(AUDIO_RATE, true), [], 'nothing new');
}

function testReuse() {
  const b = filled(10, 10, { hasAudio: false });
  b.vNext = 60; // sent up to 6.0 s
  const running = { hasProc: true, running: true, videoEnded: false };
  // Hit: back inside the history, from the keyframe at or before the target.
  assert.equal(b.reuse(3.4, running), 3);
  assert.equal(b.vNext, 30);
  assert.equal(b.aNext, Math.round(3.4 * AUDIO_RATE));
  // Hit: just past what was read with ffmpeg still running (REUSE_AHEAD_S).
  assert.equal(b.reuse(9.9 + 0.4, running), 9);
  // Miss: far past what was read, or past it with no process.
  assert.equal(b.reuse(9.9 + 0.6, running), null);
  assert.equal(b.reuse(12, { hasProc: true, running: false, videoEnded: false }), null);
  // Miss: no process and not ended; nothing held.
  assert.equal(b.reuse(3, { hasProc: false, running: false, videoEnded: false }), null);
  assert.equal(b.reuse(3, { hasProc: false, running: false, videoEnded: true }), 3, 'an ended stream serves from memory');
  assert.equal(fresh().reuse(0, running), null);
  // Miss: before the first kept packet (trimmed away).
  const c = filled(40, 10, {});
  c.vNext = c.vAll.length;
  c.seekT = 39;
  c.trim();
  assert.equal(c.reuse(5, running), null, 'history before the first kept keyframe is gone');
  // Miss: the sound before the target is gone.
  const d = filled(10, 10, { hasAudio: true });
  d.vNext = 60;
  d.aStore = [{ s: 3 * AUDIO_RATE, b: Buffer.alloc(4) }];
  assert.equal(d.reuse(1, running), null);
  assert.equal(d.reuse(4, running), 4);
}

function testResetAndClear() {
  const b = filled(2, 10, { audioEncoder: 'libopus', hasAudio: true });
  assert.ok(b.ogg, 'Opus: an Ogg reader');
  b.reset(5);
  assert.deepEqual([b.base, b.vBase, b.vAll.length, b.vNext, b.aNext, b.aEnd, b.frameIndex], [5, 5, 0, 0, 0, 0, 0]);
  b.clear();
  assert.equal(b.ogg, null);
  assert.equal(b.pending.length + b.aRest.length, 0);
}

for (const t of [testSplitAcrossChunks, testPacketTimes, testTrim, testTrimSound, testAddAudio, testReuse, testResetAndClear]) {
  t();
  console.log(`ok  ${t.name}`);
}
