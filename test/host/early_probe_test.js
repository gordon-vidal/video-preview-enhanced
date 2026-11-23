'use strict';
// node test/host/early_probe_test.js: the speculative start of a page (src/early-probe.js) with fake ffprobe, header
// sniffer, decoder and timer: a header guess ffprobe confirms is reused; one it contradicts is stopped at once;
// abort() and the EARLY_NATIVE_MS timeout stop an unclaimed decoder. No ffmpeg, no VS Code.
const assert = require('node:assert/strict');
const { EarlyProbeController, EARLY_NATIVE_MS } = require('../../src/early-probe');

const STAT = { size: 10, mtimeMs: 5 };
const T = { ffmpeg: 'ffmpeg' };
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const prOf = (codec, pixFmt = 'yuv420p') => ({ video: { codec, pixFmt } });

function rig(o = {}) {
  const r = { logs: [], made: [], timers: [], aborts: 0, probe: deferred(), sniff: deferred(), marks: [] };
  const deps = {
    name: 't', log: (m) => r.logs.push(m), verbose: false,
    stat: async () => STAT, isAvi: () => false, scanAvi: async () => null,
    tools: async () => T, gpus: async () => [], failedBefore: () => false, eligible: () => true,
    sniff: () => r.sniff.promise, probe: () => r.probe.promise,
    decide: (t, pr) => ({
      native: true, allowed: true, method: 'none', key: `k:${pr.video.codec}`,
      make: () => {
        const nd = { pr, method: 'none', decided: `k:${pr.video.codec}`, disposed: false, failed: false, dispose() { this.disposed = true; } };
        r.made.push(nd);
        return nd;
      },
    }),
    mark: (w) => r.marks.push(w),
    onAbort: () => { r.aborts++; },
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; r.timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
    ...o,
  };
  r.c = new EarlyProbeController(deps);
  return r;
}

async function testGuessMatchesProbe() {
  const r = rig();
  r.c.start('/a.mp4');
  assert.equal(r.c.state, 'probing');
  r.sniff.resolve(prOf('h264'));
  await settle();
  assert.equal(r.c.state, 'guessed_running');
  assert.equal(r.made.length, 1, 'the guess started an ffmpeg');
  assert.equal(r.timers.at(-1).ms, EARLY_NATIVE_MS);
  const pr = prOf('h264'); // open() gets the very object the early probe returned
  r.probe.resolve(pr);
  await settle();
  assert.equal(r.made.length, 1, 'the probe agreed: no second ffmpeg');
  assert.ok(!r.made[0].disposed);
  assert.deepEqual(r.marks, ['probeStart', 'probeDone']);
  const signal = new AbortController().signal;
  const claim = r.c.claim(signal);
  assert.equal(r.c.state, 'claimed');
  assert.ok(r.timers[0].cleared, 'claimed: the 15 s timer is gone');
  assert.equal(claim.claimNative('k:h264', { pr, method: 'none', stat: STAT }), r.made[0], 'the early process is reused');
  assert.equal(r.made[0].pr, pr);
  claim.release();
  assert.ok(!r.made[0].disposed, 'a claimed decoder belongs to the page');
}

async function testGuessContradicted() {
  const r = rig();
  r.c.start('/a.mp4');
  r.sniff.resolve(prOf('h264'));
  await settle();
  const guess = r.made[0];
  r.probe.resolve(prOf('hevc'));
  await settle();
  assert.ok(guess.disposed, 'the wrong guess is stopped at once');
  assert.ok(r.logs.some((l) => /probe disagrees/.test(l)));
  assert.equal(r.made.length, 2, 'replaced by one for what ffprobe found');
  assert.equal(r.made[1].decided, 'k:hevc');
  assert.equal(r.c.state, 'probed_running');
  // A claim for another decision stops it and gets nothing.
  const claim = r.c.claim(new AbortController().signal);
  assert.equal(claim.claimNative('k:other', { pr: r.made[1].pr, method: 'none', stat: STAT }), null);
  assert.ok(r.made[1].disposed);
}

async function testAbortBeforeReady() {
  const r = rig();
  let probeSignal;
  r.c.d.probe = (t, f, s) => { probeSignal = s; return r.probe.promise; };
  r.c.start('/a.mp4');
  r.sniff.resolve(prOf('h264'));
  await settle();
  const nd = r.made[0];
  r.c.abort('tab closed');
  assert.equal(r.c.state, 'aborted');
  assert.ok(probeSignal.aborted, 'the pending ffprobe is cancelled');
  assert.ok(nd.disposed, 'the unclaimed decoder is stopped');
  assert.ok(r.timers[0].cleared);
  assert.equal(r.aborts, 1);
  r.probe.resolve(prOf('h264'));
  await settle();
  assert.equal(r.made.length, 1, 'a late probe starts nothing');
}

async function testTimeout() {
  const r = rig();
  r.c.start('/a.mp4', { timeoutMs: 3000 });
  r.sniff.resolve(prOf('h264'));
  await settle();
  assert.equal(r.timers.at(-1).ms, 3000);
  r.timers.at(-1).fn();
  assert.ok(r.made[0].disposed, 'no page in time: the decoder is stopped');
  assert.equal(r.c.state, 'aborted');
  assert.ok(r.logs.some((l) => /no page within 3 s/.test(l)));
  assert.equal(r.aborts, 1, 'the session is told to forget it');
}

async function testReleaseAndPageClose() {
  const r = rig();
  r.c.start('/a.mp4');
  r.sniff.resolve(prOf('h264'));
  await settle();
  const page = new AbortController();
  const claim = r.c.claim(page.signal);
  page.abort(); // the page closes before open() took the decoder
  assert.ok(r.made[0].disposed);
  claim.release();
  const r2 = rig();
  r2.c.start('/a.mp4');
  r2.sniff.resolve(prOf('h264'));
  await settle();
  r2.c.claim(new AbortController().signal).release();
  assert.ok(r2.made[0].disposed, 'open() ended without claiming it');
}

(async () => {
  await testGuessMatchesProbe();
  await testGuessContradicted();
  await testAbortBeforeReady();
  await testTimeout();
  await testReleaseAndPageClose();
  console.log('early probe: ok');
})().catch((e) => { console.error(e); process.exit(1); });
