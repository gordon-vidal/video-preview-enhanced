'use strict';

const assert = require('node:assert/strict');
const {
  computeMetrics, ssim, lumaMetrics, resizeLuma, lumaOf, captureLuma, releaseLuma, createDebugMetrics,
} = require('../../media/compare-metrics');

function testRgb() {
  const black = Uint8Array.of(0, 0, 0, 255);
  const red = Uint8Array.of(255, 0, 0, 0);
  const ya = new Uint8Array(1);
  const yb = new Uint8Array(1);
  for (const [matrix, expectedY] of [[601, 81], [709, 63], [2020, 74]]) {
    const m = computeMetrics(black, red, ya, yb, 1, 1, { matrix });
    assert.deepEqual(m, {
      psnrY: 10 * Math.log10(255 ** 2 / (expectedY - 16) ** 2),
      psnrRGB: 10 * Math.log10(3),
      mseY: (expectedY - 16) ** 2,
      mseRGB: 255 ** 2 / 3,
      ssimY: NaN,
      w: 1,
      h: 1,
    });
    assert.equal(ya[0], 16);
    assert.equal(yb[0], expectedY);
  }

  const rgba = new Uint8Array(8 * 8 * 4).fill(255);
  const m = computeMetrics(rgba, rgba, new Uint8Array(64), new Uint8Array(64), 8, 8, { matrix: 709, ssim: true });
  assert.equal(m.psnrRGB, Infinity);
  assert.equal(m.psnrY, Infinity);
  assert.equal(m.ssimY, 1);
}

function testPlanes() {
  for (const [TypedArray, depth] of [[Uint8Array, 8], [Uint16Array, 10]]) {
    const peak = (1 << depth) - 1;
    const a = { data: new TypedArray(64), w: 8, h: 8, depth };
    const b = { ...a, data: new TypedArray(64).fill(peak) };
    const c = (0.01 * peak) ** 2;
    const expectedSsim = c / (peak ** 2 + c);
    assert.ok(Math.abs(ssim(a.data, b.data, 8, 8, peak) - expectedSsim) < 1e-12);
    assert.ok(Number.isNaN(ssim(a.data, b.data, 4, 8, peak)));
    assert.deepEqual(lumaMetrics(a, a, true), { mseY: 0, psnrY: Infinity, ssimY: 1 });
    assert.deepEqual(lumaMetrics(a, b, false), { mseY: peak ** 2, psnrY: 0, ssimY: NaN });
    assert.ok(Math.abs(lumaMetrics(a, b, true).ssimY - expectedSsim) < 1e-12);

    const grid = { data: TypedArray.of(0, peak, peak, 0), w: 2, h: 2, depth };
    const mid = Math.round(peak / 2);
    assert.deepEqual(resizeLuma(grid, 3, 3), {
      data: TypedArray.of(0, mid, peak, mid, mid, mid, peak, mid, 0), w: 3, h: 3, depth,
    });
  }
}

async function testLumaOf() {
  assert.equal(await lumaOf({}), null);
  for (const [TypedArray, depth] of [[Uint8Array, 8], [Uint16Array, 10]]) {
    const peak = (1 << depth) - 1;
    const storage = TypedArray.of(0, 0, peak - 3, peak - 2, 0, peak - 1, peak, 0);
    const samples = storage.subarray(1);
    const bytes = samples.BYTES_PER_ELEMENT;
    const data = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const p = { lumaSrc: { yuv: { data, width: 2, height: 2, depth, layout: [{ offset: bytes, stride: 3 * bytes }] } } };
    const luma = await lumaOf(p);
    assert.deepEqual(luma, { data: TypedArray.of(peak - 3, peak - 2, peak - 1, peak), w: 2, h: 2, depth });
    assert.equal(await lumaOf(p), luma, 'reuse the extracted plane on the same source frame');
  }
}

function testCaptureRelease() {
  const closed = [];
  const renderer = { setCapture: (g, fn) => { g.onFrame = fn; } };
  const p = { gl: { dispose() {} }, dispose() {} };
  captureLuma(p, renderer);
  assert.equal(typeof p.gl.onFrame, 'function', 'the renderer hands its frames over');
  p.gl.onFrame({ vf: { clone: () => ({ close: () => closed.push('clone') }) } });
  assert.ok(p.lumaSrc && p.lumaSrc.vf, 'a WebCodecs frame is kept as a clone');
  releaseLuma(p, renderer);
  assert.equal(p.gl.onFrame, null, 'released: no more frames');
  assert.equal(p.lumaSrc, null);
  assert.deepEqual(closed, ['clone'], 'the kept clone is closed');
}

/** Two stub tiles and the page state createDebugMetrics reads; `measured` collects pairMetrics calls. */
function debugFixture({ psnrAt = () => Infinity, maxFrame = 59 } = {}) {
  const state = { paused: true, settled: true, out: false, offsets: '0,0', frame: 0, offsetB: 0 };
  const pa = { shownCount: 1, currentFrame: () => state.frame };
  const pb = { shownCount: 1, currentFrame: () => state.frame + state.offsetB };
  const lines = [];
  const measured = [];
  const timers = [];
  const dm = createDebugMetrics({
    pairMetrics: async (a, b, o) => {
      measured.push({ frame: a.currentFrame(), o });
      const v = psnrAt(a.currentFrame());
      return { psnrY: v, psnrRGB: v, ssimY: 1, exactY: true, w: 4, h: 4 };
    },
    log: (s) => lines.push(s),
    pair: () => [pa, pb],
    paused: () => state.paused,
    settled: () => state.settled,
    outOfRange: () => state.out,
    offsetKey: () => state.offsets,
    frameOf: (p) => p.currentFrame(),
    seekFrame: (f) => { state.frame = f; pa.shownCount++; pb.shownCount++; },
    maxFrame: () => maxFrame,
    now: () => 0,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  /** Runs the waiting timers and microtasks until nothing is left (or `n` rounds). */
  const drain = async (n = 200) => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setImmediate(r));
      if (!timers.length) break;
      timers.shift()();
    }
    await new Promise((r) => setImmediate(r));
  };
  return { dm, state, pa, pb, lines, measured, drain };
}

async function testDebugMetricsCheck() {
  const f = debugFixture({ psnrAt: () => 31.25 });
  f.dm.check();
  f.dm.check(); // the same pictures: measured once
  await f.drain();
  const logged = f.lines.filter((l) => l.startsWith('metrics '));
  assert.equal(logged.length, 1, `one metrics line per pair of pictures: ${f.lines}`);
  assert.match(logged[0], /^metrics frameA=1 frameB=1 psnrY=31\.250 psnrRGB=31\.250 ssimY=1\.00000 exactY=true 4x4 \d+ms$/);
  assert.deepEqual(f.measured[0].o, { ssim: true, rgb: true });
  // A new picture on one tile, an offset change: measured again.
  f.pb.shownCount++;
  f.state.offsetB = -3;
  f.state.offsets = '0,-3';
  f.dm.check();
  await f.drain();
  assert.match(f.lines.filter((l) => l.startsWith('metrics ')).pop(), /^metrics frameA=1 frameB=-2 /);
  // Playing, unsettled or out of range: nothing measured.
  const n = f.measured.length;
  f.pa.shownCount++;
  f.state.paused = false;
  f.dm.check();
  f.state.paused = true;
  f.state.settled = false;
  f.dm.check();
  f.state.settled = true;
  f.state.out = true;
  f.dm.check();
  await f.drain();
  assert.equal(f.measured.length, n, 'nothing measured while playing, seeking or out of range');
  assert.deepEqual(f.dm.metrics(), { out: true });
}

async function testScanner() {
  // B differs from frame 41 (0-based) on: the scan from #41 stops at #42.
  const f = debugFixture({ psnrAt: (k) => (k >= 41 ? 20 : Infinity) });
  f.state.frame = 40;
  f.dm.scanner.thresh = 35;
  f.dm.scanner.start();
  assert.equal(f.dm.scanner.running, true);
  f.dm.check(); // no per-pause metrics while the scan steps the tiles
  await f.drain();
  assert.equal(f.dm.scanner.running, false);
  assert.deepEqual(f.dm.scanner.found, { frame: 41, psnrY: 20 });
  assert.match(f.lines.find((l) => l.startsWith('scan: ')), /^scan: #42: PSNR Y 20\.00 dB \(< 35 dB\) \(1 frames in 0\.0 s\)$/);
  assert.ok(f.measured.every((m) => m.o.ssim === false && m.o.rgb === false), 'the scan measures luma PSNR only');
  assert.ok(!f.lines.some((l) => l.startsWith('metrics ')), 'no metrics line during the scan');
  // Nothing below the threshold: the scan ends at the last frame and says so.
  const g = debugFixture({ maxFrame: 5 });
  g.state.frame = 2;
  g.dm.scanner.start(35);
  await g.drain();
  assert.match(g.lines.find((l) => l.startsWith('scan: ')), /^scan: No frame below 35 dB after #3 \(3 frames checked\)/);
  // A tile that never settles: the scan gives up instead of waiting for ever.
  const h = debugFixture();
  h.state.settled = false;
  h.dm.scanner.start(35);
  await h.drain(700);
  assert.equal(h.dm.scanner.running, true, 'still waiting while within the settle time (the clock stands still here)');
  h.dm.dispose();
  assert.equal(h.dm.scanner.running, false, 'dispose stops a running scan');
}

async function main() {
  testRgb();
  testPlanes();
  await testLumaOf();
  testCaptureRelease();
  await testDebugMetricsCheck();
  await testScanner();
  console.log('compare metrics: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
