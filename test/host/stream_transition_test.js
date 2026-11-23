'use strict';
// node test/host/stream_transition_test.js: Live transcode size transitions (src/stream.js reSize / seek) without
// ffmpeg: a larger picture while playing restarts in-band (no page seek, so no sound or clock break), repeated
// view messages ask the page for one seek only, and a pending shrink never forces ffmpeg to restart a step back.
const assert = require('assert');
const { EncodedStream } = require('../../src/stream');

function make({ audio = false } = {}) {
  const posted = [];
  const s = new EncodedStream({
    tools: {}, file: 'x.mkv', post: (m) => posted.push(m), log: () => {}, remote: false, maxHeight: 2160,
    encoder: 'libx264', cpuEncoder: 'libx264',
    probed: { duration: 60, video: { index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 30 }, audio: audio ? { index: 1 } : null },
  });
  s.fps = 30;
  let restarts = 0;
  s.restartVideo = () => { restarts++; };
  s.spawnNow = () => {}; // no ffmpeg here
  s.sizeVideo(); // open() does this: a picture size to change from
  return { s, posted, restarts: () => restarts };
}
const refreshes = (posted) => posted.filter((m) => m.type === 'refresh').length;
const fakeProc = () => ({ exitCode: null, signalCode: null, stdout: { isPaused: () => false, destroy() {} }, kill() {} });

{ // Paused: one 'refresh' per growth, however many view messages follow for the same size.
  const { s, posted } = make();
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  assert.strictEqual(s.h, 540);
  s.setView({ w: 1920, h: 1080 });
  assert.strictEqual(refreshes(posted), 1, 'growing asks the page for one seek');
  assert.strictEqual(s.h, 540, 'the size applies with that seek');
  assert.strictEqual(s.resizePending, true);
  s.setView({ w: 1900, h: 1070 });
  s.setView({ w: 1920, h: 1080 });
  s.setFit(true);
  assert.strictEqual(refreshes(posted), 1, 'jitter and repeated views queue no second seek');
  s.sizeVideo(); // the seek applies it
  assert.strictEqual(s.h, 1080);
  s.setView({ w: 960, h: 540 });
  s.setView({ w: 1920, h: 1080 });
  assert.strictEqual(refreshes(posted), 1, 'back to the applied size needs no seek');
  s.setView({ w: 3840, h: 2160 });
  assert.strictEqual(refreshes(posted), 2, 'a further growth asks again once the first is applied');
}

{ // Playing with ffmpeg running: in-band restart at the new size, no page seek.
  const { s, posted, restarts } = make({ audio: true });
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  s.proc = fakeProc();
  s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(restarts(), 1, 'ffmpeg restarts at the first unsent frame');
  assert.strictEqual(refreshes(posted), 0, 'no page seek: the sound and the clock are not touched');
  assert.strictEqual(s.h, 1080);
  assert.strictEqual(s.resizePending, false);
  // The same size again changes nothing.
  s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(restarts(), 1);
  // Shrinking while playing waits for the next seek (no restart, no seek).
  s.setView({ w: 960, h: 540 }, true);
  assert.strictEqual(restarts(), 1);
  assert.strictEqual(refreshes(posted), 0);
  assert.strictEqual(s.resizePending, true);
  assert.strictEqual(s.h, 1080, 'the picture keeps its size until a restart');
}

{ // Playing but no ffmpeg running (deferred or hidden): falls back to the page seek.
  const { s, posted, restarts } = make();
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(restarts(), 0);
  assert.strictEqual(refreshes(posted), 1);
  const hidden = make();
  hidden.s.setView({ w: 960, h: 540 });
  hidden.s.sizeVideo();
  hidden.s.proc = fakeProc();
  hidden.s.hidden = true;
  hidden.s.setView({ w: 1920, h: 1080 }, true);
  assert.strictEqual(hidden.restarts(), 0, 'a hidden tab never starts ffmpeg');
}

{ // A pending shrink does not stop a step back being served from memory (no ffmpeg restart, no picture gap).
  const { s, posted } = make();
  s.setView({ w: 1920, h: 1080 });
  s.sizeVideo();
  s.proc = fakeProc();
  s.base = 10;
  s.vBase = 10;
  for (let i = 0; i < 60; i++) s.vAll.push({ kind: 'packet', t: 10 + i / 30, key: i % 30 === 0, idr: i % 30 === 0, data: new Uint8Array(4) });
  s.vNext = 40;
  s.gotOutput = true;
  s.setView({ w: 960, h: 540 });
  assert.strictEqual(s.resizePending, true);
  s.seek({ gen: 1, t: 10.5 });
  const seeked = posted.filter((m) => m.type === 'seeked');
  assert.strictEqual(seeked.length, 1);
  assert.strictEqual(s.vNext, 0, 'served from the packets held: cursor at the keyframe');
  assert.ok(s.proc, 'ffmpeg was not restarted');
  assert.strictEqual(s.resizePending, true, 'the smaller size still applies at the next real restart');
  // A seek outside memory restarts and applies the size.
  s.seek({ gen: 2, t: 50 });
  assert.strictEqual(s.h, 540);
  assert.strictEqual(s.resizePending, false);
  clearTimeout(s.startTimer);
  s.kill();
}

{ // A growth pending still forces the restart (the page asked for a crisper picture).
  const { s } = make();
  s.setView({ w: 960, h: 540 });
  s.sizeVideo();
  s.proc = fakeProc();
  s.base = 10;
  s.vBase = 10;
  for (let i = 0; i < 60; i++) s.vAll.push({ kind: 'packet', t: 10 + i / 30, key: i % 30 === 0, idr: i % 30 === 0, data: new Uint8Array(4) });
  s.vNext = 40;
  s.gotOutput = true;
  s.setView({ w: 1920, h: 1080 });
  s.seek({ gen: 1, t: 10.5 });
  assert.strictEqual(s.h, 1080, 'the seek applied the larger size and restarted');
  clearTimeout(s.startTimer);
  s.kill();
}

console.log('stream transition tests passed');
