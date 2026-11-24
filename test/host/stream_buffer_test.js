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
  // Last sent at 39.9 s: keep HISTORY_S (8 s) behind it, from the keyframe at or before 31.9 s = 31.0 s.
  assert.equal(b.vAll[0].t, 31);
  assert.ok(b.vAll[0].key, 'history starts on a keyframe');
  assert.equal(b.vNext, b.vAll.length, 'cursor moved with the cut');

  // A seek target further back keeps more (SEEK_KEEP_S before it) but never more than HISTORY_MAX_S (20 s).
  const c = filled(40, 10, {});
  c.vNext = c.vAll.length;
  c.seekT = 30;
  c.trim();
  assert.equal(c.vAll[0].t, 27, 'seek target 30 s keeps from 27 s (SEEK_KEEP_S 3 s): the keyframe at 27 s');
  const d = filled(40, 10, {});
  d.vNext = d.vAll.length;
  d.seekT = 0;
  d.trim();
  assert.equal(d.vAll[0].t, 19, 'never more than 20 s behind the last sent (39.9 s): the keyframe at 19 s');

  // A remote link keeps REMOTE_HISTORY_S (15 s): from the keyframe at or before 24.9 s = 24.0 s.
  const r = filled(40, 10, { remote: true });
  r.vNext = r.vAll.length;
  r.seekT = 39;
  r.trim();
  assert.equal(r.vAll[0].t, 24, 'remote history: 15 s behind the last sent');

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

function addRegion(b, t, { videoEnded = false, audioEnded = !b.hasAudio, audioSeconds = 0 } = {}) {
  b.reset(t);
  feed(b, AUD_TO_AUD);
  b.split(true);
  if (audioSeconds) b.addAudio(Buffer.alloc(audioSeconds * AUDIO_RATE * 4));
  b.archive(videoEnded, audioEnded);
  b.reset(0);
}

function testRegionBounce() {
  const b = fresh();
  b.setConfiguration('cpu');
  addRegion(b, 10);
  addRegion(b, 30, { videoEnded: true });
  assert.equal(b.restore(20, false, true), null);
  assert.equal(b.restore(30.201, false, true), null, 'an archive cannot read ahead');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(b.restore(10.1, true, true), { at: 10, videoEnded: false, audioEnded: true });
    assert.equal(b.vAll[b.vNext].key, true);
    assert.equal(b.vBase + b.frameIndex / FPS, 10.3, 'unfinished picture resumes at the first missing frame');
    assert.deepEqual(b.restore(30.2, false, true), { at: 30, videoEnded: true, audioEnded: true });
  }
}

function testRegionEviction() {
  const b = fresh({ cacheBytes: 2 * AUD_TO_AUD.length });
  b.setConfiguration('cpu');
  addRegion(b, 10);
  addRegion(b, 20);
  assert.ok(b.restore(10, false, true));
  b.archive(false, true);
  addRegion(b, 30);
  assert.equal(b.restore(20, false, true), null, 'the least recently used region is evicted by bytes');
  assert.ok(b.restore(10, false, true));
  b.clear();
  assert.equal(b.restore(30, false, true), null);
  assert.equal(b.regionBytes, 0);

  const c = fresh();
  c.setConfiguration('cpu');
  for (let i = 1; i <= 5; i++) addRegion(c, i);
  assert.equal(c.restore(1, false, true), null, 'at most four regions');
  assert.ok(c.restore(2, false, true));
}

function testRegionConfiguration() {
  const b = fresh();
  const configuration = [1920, 1080, 5000, 0, 'cpu', null];
  for (const [field, changed] of [[0, 1280], [1, 720], [2, 2100], [3, 1], [4, 'gpu-full'], [5, 'libopus']]) {
    b.setConfiguration(JSON.stringify(configuration));
    addRegion(b, 10);
    const next = configuration.slice();
    next[field] = changed;
    b.setConfiguration(JSON.stringify(next));
    assert.equal(b.restore(10, false, true), null, `configuration change at field ${field}`);
    assert.equal(b.regionBytes, 0);
  }
}

function testRegionAudioCoverage() {
  const b = fresh({ hasAudio: true });
  b.setConfiguration('cpu');
  addRegion(b, 10, { audioSeconds: 0.2 });
  assert.equal(b.restore(10.2, false, false), null, 'audio must cover the target sample');
  assert.deepEqual(b.restore(10.1, false, false), { at: 10, videoEnded: false, audioEnded: false });
  assert.equal(b.aNext, AUDIO_RATE / 10);
  const [audio] = b.takeAudio(b.aEnd, true);
  assert.equal(audio.t, 10.1);
  assert.equal(audio.data.length, AUDIO_RATE * 4 / 10);
  b.resetAudio(b.aNext);
  b.addAudio(Buffer.alloc(4));
  assert.equal(b.takeAudio(b.aEnd, false)[0].t, 10.2);
  const small = fresh({ hasAudio: true, cacheBytes: AUD_TO_AUD.length });
  small.setConfiguration('cpu');
  addRegion(small, 10, { audioSeconds: 0.2 });
  assert.equal(small.restore(10, false, false), null, 'audio counts toward the byte budget');

  const trimmed = fresh({ hasAudio: true });
  trimmed.setConfiguration('cpu');
  trimmed.reset(10);
  feed(trimmed, AUD_TO_AUD);
  trimmed.split(true);
  trimmed.resetAudio(AUDIO_RATE / 10);
  trimmed.addAudio(Buffer.alloc(AUDIO_RATE * 4));
  trimmed.archive(false, false);
  trimmed.reset(0);
  assert.equal(trimmed.restore(10, false, false), null, 'trimmed audio cannot cover an earlier target');
  assert.ok(trimmed.restore(10.1, false, false));
}

function testResumeAudioPreservesHistory() {
  const b = fresh({ hasAudio: true });
  b.setConfiguration('cpu');
  addRegion(b, 10, { audioSeconds: 0.2 });
  assert.deepEqual(b.restore(10.1, false, false), { at: 10, videoEnded: false, audioEnded: false });
  const [first] = b.takeAudio(b.aEnd, true);
  assert.equal(first.t, 10.1);
  // Resuming audio appends at aEnd while keeping earlier audio chunks for backward seeks.
  b.resumeAudio(b.aNext);
  b.addAudio(Buffer.alloc(AUDIO_RATE * 4 / 10));
  const [continued] = b.takeAudio(b.aEnd, false);
  assert.equal(continued.t, 10.2);
  assert.equal(b.reuse(10.05, { hasProc: true, running: true, videoEnded: false }), 10, 'backward seek after audio resume still hits memory');
  assert.equal(b.takeAudio(AUDIO_RATE / 10, false)[0].t, 10.05);
}

function testSplitMpegTs() {
  // Build minimal 188-byte TS packets carrying two H.264 PES units with B-frame PTS (0.12 s then 0.04 s).
  const tsPkt = (pid, pusi, payload) => {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47;
    p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    p[2] = pid & 0xff;
    p[3] = 0x10; // payload only
    payload.copy(p, 4);
    return p;
  };
  const encodePts = (sec) => {
    const v = Math.round(sec * 90000);
    return Buffer.from([
      0x21 | (((v / 4294967296) & 7) << 1),
      (v >>> 22) & 0xff,
      (((v >>> 15) & 0x7f) << 1) | 1,
      (v >>> 7) & 0xff,
      ((v & 0x7f) << 1) | 1,
    ]);
  };
  const pes = (ptsSec, data) => Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]), encodePts(ptsSec), data]);
  const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x99]);
  const bframe = Buffer.from([0, 0, 0, 1, 0x41, 0xaa, 0xbb]);
  const stream = Buffer.concat([tsPkt(0x100, true, pes(0.12, idr)), tsPkt(0x100, true, pes(0.04, bframe))]);
  const b = fresh();
  // Feed in odd-sized chunks to test TS framing across chunk boundaries.
  for (let i = 0; i < stream.length; i += 73) {
    b.pending = b.pending.length ? Buffer.concat([b.pending, stream.subarray(i, i + 73)]) : stream.subarray(i, i + 73);
    b.splitMpegTs(false);
  }
  b.splitMpegTs(true);
  assert.equal(b.vAll.length, 2);
  assert.equal(b.vAll[0].key, true);
  assert.ok(Math.abs(b.vAll[0].t - 0.12) < 1e-4);
  assert.equal(b.vAll[1].key, false);
  assert.ok(Math.abs(b.vAll[1].t - 0.04) < 1e-4);
}

for (const t of [testSplitAcrossChunks, testPacketTimes, testSplitMpegTs, testTrim, testTrimSound, testAddAudio,
  testReuse, testResetAndClear, testRegionBounce, testRegionEviction, testRegionConfiguration, testRegionAudioCoverage,
  testResumeAudioPreservesHistory]) {
  t();
  console.log(`ok  ${t.name}`);
}
