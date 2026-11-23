'use strict';

const assert = require('node:assert/strict');
const { computeMetrics, ssim, lumaMetrics, resizeLuma, lumaOf } = require('../../media/compare-metrics');

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

async function main() {
  testRgb();
  testPlanes();
  await testLumaOf();
  console.log('compare metrics: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
