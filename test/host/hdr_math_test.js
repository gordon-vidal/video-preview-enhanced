'use strict';
// node test/host/hdr_math_test.js: the colour maths of HDR output (media/hdr.js) against reference
// values from the standards: PQ (SMPTE ST 2084), HLG (BT.2100, BT.2408 reference white), BT.2020 ->
// BT.709 / Display P3 primaries (derived here from the chromaticities), extended-range scaling
// (1.0 = 203 nits), the extended sRGB encode, and the output decision.
const assert = require('assert');
const H = require('../../media/hdr');

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
const nearAll = (a, b, tol, what) => a.forEach((v, i) => near(v, b[i], tol, `${what}[${i}]`));

// ---- PQ -------------------------------------------------------------------------------------
near(H.pqEotf(0), 0, 1e-9, 'PQ 0');
near(H.pqEotf(1), 10000, 1e-6, 'PQ 1');
// BT.2408 table 1 / ST 2084 code values: 100 nits ~ 0.5081, 203 nits ~ 0.5807 (58 %), 1000 nits ~ 0.7518.
near(H.pqInverse(100), 0.5081, 5e-4, 'PQ(100)');
near(H.pqInverse(203), 0.5807, 5e-4, 'PQ(203)');
near(H.pqInverse(1000), 0.7518, 5e-4, 'PQ(1000)');
near(H.pqInverse(10000), 1, 1e-9, 'PQ(10000)');
// 10-bit narrow-range codes: 203 nits is code 64 + 876 * 0.5807 = 573 (BT.2408).
near(Math.round(64 + 876 * H.pqInverse(203)), 573, 0, 'PQ 203 nits as a 10-bit code');
for (const n of [0.01, 0.1, 1, 5, 48, 100, 203, 400, 1000, 4000, 10000]) near(H.pqEotf(H.pqInverse(n)), n, n * 1e-9 + 1e-9, `PQ round trip ${n}`);

// ---- HLG ------------------------------------------------------------------------------------
near(H.hlgInverseOetf(0), 0, 1e-12, 'HLG 0');
near(H.hlgInverseOetf(0.5), 1 / 12, 1e-12, 'HLG 0.5 = 1/12');
near(H.hlgInverseOetf(1), 1, 1e-4, 'HLG 1');
near(H.hlgGamma(1000), 1.2, 1e-12, 'HLG gamma at 1000 nits');
// BT.2408: HLG reference white is 75 % signal, which a 1000-nit display shows at 203 nits.
nearAll(H.hlgToNits([0.75, 0.75, 0.75]), [203, 203, 203], 1, 'HLG 75 % grey');
nearAll(H.hlgToNits([1, 1, 1]), [1000, 1000, 1000], 0.5, 'HLG peak');
// The OOTF scales by luminance: a colour keeps its channel ratios in scene light.
{
  const sig = [0.8, 0.4, 0.2];
  const e = sig.map(H.hlgInverseOetf);
  const n = H.hlgToNits(sig);
  near(n[0] / n[1], e[0] / e[1], 1e-9, 'HLG OOTF keeps ratios');
}

// ---- Primaries --------------------------------------------------------------------------------
function npm([xr, yr, xg, yg, xb, yb, xw, yw]) {
  const X = (x, y) => [x / y, 1, (1 - x - y) / y];
  const [R, G, B, W] = [X(xr, yr), X(xg, yg), X(xb, yb), X(xw, yw)];
  const M = [[R[0], G[0], B[0]], [R[1], G[1], B[1]], [R[2], G[2], B[2]]];
  const S = H.mul(inv(M), W);
  return M.map((r) => r.map((v, i) => v * S[i]));
}
function inv(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A, -(b * i - c * h), b * f - c * e], [B, a * i - c * g, -(a * f - c * d)], [C, -(a * h - b * g), a * e - b * d]].map((r) => r.map((v) => v / det));
}
const mm = (a, b) => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const D65 = [0.3127, 0.3290];
const P2020 = npm([0.708, 0.292, 0.170, 0.797, 0.131, 0.046, ...D65]);
const P709 = npm([0.64, 0.33, 0.30, 0.60, 0.15, 0.06, ...D65]);
const PP3 = npm([0.680, 0.320, 0.265, 0.690, 0.150, 0.060, ...D65]);
nearAll(mm(inv(P709), P2020).flat(), H.BT2020_TO_709.flat(), 2e-7, 'BT.2020 -> BT.709');
nearAll(mm(inv(PP3), P2020).flat(), H.BT2020_TO_P3.flat(), 2e-7, 'BT.2020 -> P3');
nearAll(mm(inv(PP3), P709).flat(), H.BT709_TO_P3.flat(), 2e-7, 'BT.709 -> P3');
for (const m of [H.BT2020_TO_709, H.BT2020_TO_P3, H.BT709_TO_P3]) m.forEach((r, i) => near(r[0] + r[1] + r[2], 1, 1e-6, `white stays white, row ${i}`));
// Column-major layout for WebGL.
assert.deepStrictEqual(H.colMajor([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [1, 4, 7, 2, 5, 8, 3, 6, 9]);

// ---- Extended range ---------------------------------------------------------------------------
near(H.srgbEncodeExt(0), 0, 0, 'sRGB 0');
near(H.srgbEncodeExt(1), 1, 1e-12, 'sRGB 1');
near(H.srgbEncodeExt(0.0031308), 0.04045, 1e-5, 'sRGB knee');
near(H.srgbEncodeExt(-0.5), -H.srgbEncodeExt(0.5), 0, 'sRGB keeps the sign');
// Reference white (203 nits) is 1.0, the SDR white of the display.
nearAll(H.nitsToCanvas([203, 203, 203]), [1, 1, 1], 1e-6, '203 nits grey');
nearAll(H.nitsToCanvas([203, 203, 203], 'srgb'), [1, 1, 1], 1e-6, '203 nits grey, sRGB');
// 1000 nits: 4.926x SDR white in linear light, sRGB-encoded 1.055 * 4.926^(1/2.4) - 0.055.
const k1000 = 1.055 * (1000 / 203) ** (1 / 2.4) - 0.055;
nearAll(H.nitsToCanvas([1000, 1000, 1000]), [k1000, k1000, k1000], 1e-6, '1000 nits grey');
near(k1000, 1.9952, 1e-3, '1000 nits value');
// PQ signal of 203 nits -> 1.0; HLG 75 % -> ~1.0.
nearAll(H.signalToCanvas([0.5807, 0.5807, 0.5807].map(() => H.pqInverse(203)), 16), [1, 1, 1], 1e-6, 'PQ white');
nearAll(H.signalToCanvas([0.75, 0.75, 0.75], 18), [1, 1, 1], 0.003, 'HLG reference white');
// Pure BT.2020 red is outside P3: negative green, kept (extended range).
{
  const red = H.signalToCanvas([H.pqInverse(203), 0, 0], 16);
  assert.ok(red[0] > 1 && red[1] < 0, `BT.2020 red in P3: ${red}`);
  const lin = H.mul(H.BT2020_TO_P3, [203, 0, 0]).map((v) => v / 203);
  nearAll(red, lin.map(H.srgbEncodeExt), 1e-9, 'BT.2020 red');
}

// ---- Decision ---------------------------------------------------------------------------------
const hdrDisplay = { displayHdr: true, api: 'webgpu' };
assert.deepStrictEqual(H.decide('auto', hdrDisplay), { on: true, why: 'HDR display' });
assert.strictEqual(H.decide('off', hdrDisplay).on, false);
assert.strictEqual(H.decide('auto', { displayHdr: false, api: 'webgpu' }).on, false);
assert.strictEqual(H.decide('auto', { displayHdr: true, api: '' }).on, false);
assert.strictEqual(H.decide('auto', null).on, false);
assert.strictEqual(H.decide('off', { displayHdr: false, api: 'webgpu' }, true).on, true, 'the test override forces HDR');
assert.strictEqual(H.decide('auto', { displayHdr: false, api: '' }, true).on, false, 'no HDR canvas: never on');
assert.strictEqual(H.outputLabel(true), 'HDR output');
assert.strictEqual(H.outputLabel(false), 'HDR tone-mapped to SDR');

// ---- YUV -> R'G'B' for the WebGPU output (yuvParams, as GLRenderer.drawYuv) -----------------------
{
  // 10-bit narrow-range BT.2020 codes of PQ grey at 203 nits: Y 64 + 876 * PQ(203), Cb = Cr = 512.
  const f = { width: 1920, height: 1080, depth: 10, fullRange: false, space: 2020, trc: 16 };
  const p = H.yuvParams(f);
  const rgbOf = (codes) => {
    const yuv = codes.map((c, i) => c * p.scale - p.off[i]);
    return [0, 1, 2].map((r) => p.m[r] * yuv[0] + p.m[3 + r] * yuv[1] + p.m[6 + r] * yuv[2]);
  };
  const y203 = 64 + 876 * H.pqInverse(203);
  nearAll(rgbOf([y203, 512, 512]), [H.pqInverse(203), H.pqInverse(203), H.pqInverse(203)], 1e-9, '10-bit PQ grey');
  nearAll(H.signalToCanvas(rgbOf([y203, 512, 512]), 16), [1, 1, 1], 1e-6, '10-bit PQ grey on the canvas');
  nearAll(rgbOf([64, 512, 512]), [0, 0, 0], 1e-9, '10-bit black');
  nearAll(rgbOf([940, 512, 512]), [1, 1, 1], 1e-9, '10-bit white');
  // Pure red (R' = 1): Cb, Cr from the BT.2020 NCL equations at 10 bits.
  const yR = 0.2627; const cb = (0 - yR) / 1.8814; const cr = (1 - yR) / 1.4746;
  nearAll(rgbOf([64 + 876 * yR, 512 + 896 * cb, 512 + 896 * cr]), [1, 0, 0], 1e-9, '10-bit red');
  // 8-bit HDR (rare) keeps 8-bit levels; full range has no offset on Y.
  const p8 = H.yuvParams({ width: 640, height: 360, depth: 8, fullRange: true, space: 709, trc: 18 });
  assert.deepStrictEqual(p8.off, [0, 128 / 255, 128 / 255]);
  near(p8.scale, 1 / 255, 1e-12, '8-bit scale');
  assert.ok(/fn fs\(/.test(H.WGSL) && /toneMapping/.test(String(H.start)), 'WGSL and start present');
}

// ---- Dolby Vision ------------------------------------------------------------------------------
assert.deepStrictEqual(H.dolbyVision({ profile: 8, compat: 1 }), { profile: 8, compat: 1, base: 'HDR10', supported: true, label: 'Dolby Vision 8.1' });
assert.strictEqual(H.dolbyVision({ profile: 8, compat: 4 }).base, 'HLG');
assert.strictEqual(H.dolbyVision({ profile: 8, compat: 2 }).base, 'SDR');
assert.strictEqual(H.dolbyVision({ profile: 7, compat: 6 }).base, 'HDR10');
assert.deepStrictEqual(H.dolbyVision({ profile: 5, compat: 0 }), { profile: 5, compat: 0, base: '', supported: false, label: 'Dolby Vision 5' });
assert.strictEqual(H.dolbyVision({ profile: 10, compat: 0 }).supported, false);
assert.strictEqual(H.dolbyVision(null), null);

console.log('hdr_math_test: ok');
