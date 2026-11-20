'use strict';
// Unit tests for the pure helpers in media/inspect.js: node test/inspect/inspect_test.js
const assert = require('assert');
const I = require('../../media/inspect.js');

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('parseGoto', () => {
  assert.deepStrictEqual(I.parseGoto('1432'), { frame: 1432 });
  assert.deepStrictEqual(I.parseGoto(' #12 '), { frame: 12 });
  assert.deepStrictEqual(I.parseGoto('1:23.456'), { time: 83.456 });
  assert.deepStrictEqual(I.parseGoto('1:02:03'), { time: 3723 });
  assert.deepStrictEqual(I.parseGoto('0:05'), { time: 5 });
  assert.deepStrictEqual(I.parseGoto('83.5s'), { time: 83.5 });
  assert.deepStrictEqual(I.parseGoto('2.5'), { time: 2.5 });
  assert.deepStrictEqual(I.parseGoto('50%'), { fraction: 0.5 });
  assert.deepStrictEqual(I.parseGoto('150%'), { fraction: 1 });
  assert.deepStrictEqual(I.parseGoto('+10'), { delta: 10 });
  assert.deepStrictEqual(I.parseGoto('-3'), { delta: -3 });
  for (const bad of ['', 'abc', '1:2:3:4', '%', '1.2.3']) assert.strictEqual(I.parseGoto(bad), null, bad);
});

t('resolveGoto', () => {
  assert.deepStrictEqual(I.resolveGoto({ frame: 1 }, 50, 300, 10), { frame: 0 });
  assert.deepStrictEqual(I.resolveGoto({ frame: 9999 }, 50, 300, 10), { frame: 299 });
  assert.deepStrictEqual(I.resolveGoto({ delta: -100 }, 50, 300, 10), { frame: 0 });
  assert.deepStrictEqual(I.resolveGoto({ delta: 5 }, 50, 300, 10), { frame: 55 });
  assert.deepStrictEqual(I.resolveGoto({ fraction: 0.5 }, 0, 300, 10), { time: 5 });
  assert.deepStrictEqual(I.resolveGoto({ time: 99 }, 0, 300, 10), { time: 10 });
});

t('parseFragment', () => {
  assert.deepStrictEqual(I.parseFragment('#t=12.3'), { t: 12.3 });
  assert.deepStrictEqual(I.parseFragment('frame=42'), { frame: 42 });
  assert.deepStrictEqual(I.parseFragment('t=1:02.5&frame=7'), { t: 62.5, frame: 7 });
  assert.deepStrictEqual(I.parseFragment('L10'), {});
  assert.deepStrictEqual(I.parseFragment('#t=50%25'), {}, 'a stray % does not throw');
  assert.deepStrictEqual(I.parseFragment('t=%E0%A4%A&frame=3'), { frame: 3 });
});

t('zoom and pan', () => {
  // The picture point under the cursor stays put.
  const [tx, ty] = I.zoomAround(0.5, 100, 50, 4, 300, 250);
  const u0 = (300 - 100) / 0.5;
  const u1 = (300 - tx) / 4;
  assert.ok(Math.abs(u0 - u1) < 1e-9);
  assert.ok(Math.abs((250 - 50) / 0.5 - (250 - ty) / 4) < 1e-9);
  // Smaller than the view: centred. Larger: edges stay outside.
  assert.deepStrictEqual(I.clampPan(999, 999, 400, 300, 800, 600), [200, 150]);
  assert.deepStrictEqual(I.clampPan(50, -5000, 1600, 1200, 800, 600), [0, -600]);
});

t('displayToSource matches the shader rotation', () => {
  // 4x2 source shown turned 90 degrees clockwise is 2x4. Display top-left shows source bottom-left.
  assert.deepStrictEqual(I.displayToSource(0, 0, 2, 4, 90, 4, 2), [0, 1]);
  assert.deepStrictEqual(I.displayToSource(1, 0, 2, 4, 90, 4, 2), [0, 0]);
  assert.deepStrictEqual(I.displayToSource(0, 3, 2, 4, 90, 4, 2), [3, 1]);
  assert.deepStrictEqual(I.displayToSource(0, 0, 4, 2, 180, 4, 2), [3, 1]);
  assert.deepStrictEqual(I.displayToSource(0, 0, 2, 4, 270, 4, 2), [3, 0]);
  assert.deepStrictEqual(I.displayToSource(3, 1, 4, 2, 0, 4, 2), [3, 1]);
});

t('yuvAt 8-bit 4:2:0 and 10-bit 4:2:2', () => {
  // 4x2 yuv420p: Y stride 4, U/V 2x1.
  const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 100, 101, 200, 201]);
  const f = { width: 4, height: 2, data, layout: [{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 10, stride: 2 }] };
  assert.deepStrictEqual(I.yuvAt(f, 3, 1), { y: 7, u: 101, v: 201, depth: 8 });
  assert.deepStrictEqual(I.yuvAt(f, 0, 0), { y: 0, u: 100, v: 200, depth: 8 });
  assert.strictEqual(I.softFormat(f), 'yuv420p');
  // 2x2 yuv422p10 at a byte offset inside a bigger buffer.
  const words = new Uint16Array([999, 940, 64, 100, 512, 513, 300, 301]);
  const buf = new Uint8Array(4 + words.byteLength);
  buf.set(new Uint8Array(words.buffer), 4);
  const g = { width: 2, height: 2, depth: 10, cw: 1, ch: 0, data: buf.subarray(4), layout: [{ offset: 0, stride: 4 }, { offset: 8, stride: 2 }, { offset: 12, stride: 2 }] };
  assert.deepStrictEqual(I.yuvAt(g, 1, 1), { y: 100, u: 513, v: 301, depth: 10 });
  assert.strictEqual(I.softFormat(g), 'yuv422p10');
  // Detached data: no values.
  assert.strictEqual(I.yuvAt({ ...f, data: new Uint8Array(0) }, 0, 0), null);
});

t('vfSample', () => {
  // NV12 2x2 rect: Y plane 2x2 (stride 2), UV interleaved one pair.
  const nv = new Uint8Array([10, 11, 12, 13, 128, 129]);
  assert.deepStrictEqual(I.vfSample('NV12', nv, [{ offset: 0, stride: 2 }, { offset: 4, stride: 2 }], 1, 1), { y: 13, u: 128, v: 129, depth: 8 });
  const i420 = new Uint8Array([10, 11, 12, 13, 90, 240]);
  assert.deepStrictEqual(I.vfSample('I420', i420, [{ offset: 0, stride: 2 }, { offset: 4, stride: 1 }, { offset: 5, stride: 1 }], 0, 1), { y: 12, u: 90, v: 240, depth: 8 });
  assert.strictEqual(I.vfSample('RGBA', i420, [{ offset: 0, stride: 8 }], 0, 0), null);
});

console.log(`inspect: ${n} groups passed`);
