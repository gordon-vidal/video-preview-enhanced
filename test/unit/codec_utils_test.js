'use strict';

const assert = require('node:assert/strict');
const { toWebAudio, h264Config, hdrLabel, speedText, measureRate, snapRate, nv12ToI420 } =
  require('../../media/codec-utils');
const hdr = require('../../media/hdr');

const plane = (...samples) => Float32Array.of(...samples);
const stereo = [plane(1), plane(2)];
assert.strictEqual(toWebAudio(stereo, 0x3), stereo);
const surround = [plane(1), plane(2), plane(3), plane(4), plane(5), plane(6)];
assert.strictEqual(toWebAudio(surround, 0x3f), surround);
const extended = [plane(1, 0), plane(2, 0), plane(0, 1), plane(99, 99), plane(1, 0), plane(1, 0), plane(1, 0), plane(1, 0)];
const [left, right] = toWebAudio(extended, 0x63f);
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} should be near ${b}`);
near(left[0], 1 + 2 * Math.SQRT1_2);
near(right[0], 2 + 2 * Math.SQRT1_2);
near(left[1], Math.SQRT1_2);
near(right[1], Math.SQRT1_2);

const extradata = Uint8Array.of(1, 100, 0, 40, 255);
const dims = { width: 1920, height: 1080 };
assert.deepStrictEqual(h264Config({ ...dims, extradata }), {
  codec: 'avc1.640028', description: extradata, codedWidth: 1920, codedHeight: 1080,
});
assert.deepStrictEqual(h264Config(dims), { codec: 'avc1.640033', codedWidth: 1920, codedHeight: 1080 });
assert.equal(h264Config({ ...dims, profile: 66, level: 31 }).codec, 'avc1.42001f');

assert.equal(hdrLabel(null), '');
assert.equal(hdrLabel({ colorTrc: 16 }), ' · HDR PQ');
assert.equal(hdrLabel({ colorTrc: 18 }, { on: false }, hdr), ' · HDR HLG (HDR tone-mapped to SDR)');
assert.equal(hdrLabel({ colorTrc: 16 }, { on: true }, hdr), ' · HDR PQ (HDR output)');

assert.deepStrictEqual(
  [0, 0.01, 0.314, 0.995, 10.6, 99, 100, Infinity].map(speedText),
  ['<0.01×', '0.01×', '0.31×', '1.0×', '11×', '99×', '>99×', '>99×'],
);

const timestamps = [0.134, 0, 0.033, 0.067, 0.067, 0.167];
const original = timestamps.slice();
near(measureRate(timestamps), 5 / 0.167);
assert.equal(snapRate(measureRate(timestamps)), 30000 / 1001);
assert.equal(snapRate(27.1234), 27.123);
assert.deepStrictEqual(timestamps, original);
assert.equal(measureRate([1, 1]), undefined);

// Odd dimensions exercise both rounded-up chroma axes. Ignore row padding and plane offsets.
const src = Uint8Array.of(
  255, 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255,
  255, 10, 20, 11, 21, 255, 255, 12, 22, 13, 23,
);
const { data, layout } = nv12ToI420(src, [{ offset: 1, stride: 4 }, { offset: 14, stride: 6 }], 3, 3);
assert.deepStrictEqual([...data], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21, 22, 23]);
assert.deepStrictEqual(layout, [{ offset: 0, stride: 3 }, { offset: 9, stride: 2 }, { offset: 13, stride: 2 }]);

console.log('codec_utils_test: ok');
