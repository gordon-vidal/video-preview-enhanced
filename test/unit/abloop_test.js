'use strict';
// media/abloop.js: the A-B loop of the player (keys A / B, context menu, settings panel, export range).
const assert = require('assert');
const AB = require('../../media/abloop');
const T = require('../../media/timefmt');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok   ${name}`); };

test('A then B: a range, the toast and the panel label', () => {
  const ab = AB.create();
  assert.strictEqual(ab.label(T.fmtClock), 'Off · press A');
  ab.set('a', 1.0, 30);
  assert.strictEqual(ab.toast(T.fmtTime), 'Range start 0:01.000 (B sets the end)');
  assert.strictEqual(ab.label(T.fmtClock), 'Start 0:01 · press B');
  assert.ok(ab.isSet() && !ab.isRange());
  ab.set('b', 2.0, 60);
  assert.strictEqual(ab.toast(T.fmtTime), 'A–B range 0:01.000 – 0:02.000 (loop and export)');
  assert.strictEqual(ab.label(T.fmtClock), '0:01 – 0:02');
  assert.deepStrictEqual(ab.exportRange(30, 90), { fa: 30, fb: 60, fps: 30, n: 90, a: 1.0, b: 2.0 });
});

test('the same key again clears that end', () => {
  const ab = AB.create();
  ab.set('a', 1, 30); ab.set('b', 2, 60);
  ab.set('a', 5, 150);
  assert.strictEqual(ab.a, null); assert.strictEqual(ab.af, null); assert.strictEqual(ab.b, 2);
  assert.strictEqual(ab.toast(T.fmtTime), 'Range end 0:02.000 (A sets the start)');
  assert.strictEqual(ab.label(T.fmtClock), 'End 0:02 · press A');
  ab.set('b', 9, 9);
  assert.ok(!ab.isSet());
  assert.strictEqual(ab.toast(T.fmtTime), 'A–B range cleared');
  assert.strictEqual(ab.exportRange(30, 90), null);
});

test('B before A swaps the ends (times and frames)', () => {
  const ab = AB.create();
  ab.set('a', 3, 90); ab.set('b', 1, 30);
  assert.deepStrictEqual([ab.a, ab.b, ab.af, ab.bf], [1, 3, 30, 90]);
  assert.deepStrictEqual(ab.exportRange(30, 120), { fa: 30, fb: 90, fps: 30, n: 120, a: 1, b: 3 });
});

test('clip export records the shown PTS independently of the playback clock', () => {
  const ab = AB.create();
  ab.set('a', 2.1, 50, 2.02);
  ab.set('b', 1.4, 34, 1.37);
  assert.deepStrictEqual(ab.presentationRange(), { a: 1.37, b: 2.02, early: 0 });
  assert.strictEqual(ab.wrapTarget(2.11, true), 1.4);
  ab.reset('b', 1.4, 34, 1.37);
  assert.deepStrictEqual(ab.presentationRange(), { a: 1.37, b: 1.37, early: 0 });
  ab.clear();
  assert.strictEqual(ab.presentationRange(), null);
});

test('native frame labels survive swapped markers and clear when replaced', () => {
  const ab = AB.create();
  ab.set('a', 2, 50, 2, true);
  ab.set('b', 1, 25, 1);
  assert.strictEqual(ab.aNative, false);
  assert.strictEqual(ab.bNative, true);
  assert.deepStrictEqual(ab.presentationRange(), { a: 1, b: 2, early: 0, native: true });
  ab.reset('b', 2, 50, 2);
  assert.deepStrictEqual(ab.presentationRange(), { a: 1, b: 2, early: 0 });
});

test('wrap: only while playing, at or after B, to A (or the start without A)', () => {
  const ab = AB.create();
  assert.strictEqual(ab.wrapTarget(10, true), null);
  ab.set('b', 2, 60);
  assert.strictEqual(ab.wrapTarget(1.99, true), null);
  assert.strictEqual(ab.wrapTarget(2, false), null);
  assert.strictEqual(ab.wrapTarget(2, true), 0);
  ab.set('a', 1, 30);
  assert.strictEqual(ab.wrapTarget(2.01, true), 1);
});

test('context menu "Set" always sets; the panel row cycles start, end, off', () => {
  const ab = AB.create();
  ab.reset('a', 1, 30); ab.reset('a', 1.5, 45);
  assert.deepStrictEqual([ab.a, ab.af], [1.5, 45], 'Set Loop Start twice moves A, never clears it');
  ab.reset('b', 2, 60); ab.reset('b', 2.5, 75);
  assert.deepStrictEqual([ab.b, ab.bf], [2.5, 75]);
  const c = AB.create();
  c.cycle(1, 30); assert.ok(c.a === 1 && c.b === null);
  c.cycle(2, 60); assert.ok(c.b === 2);
  c.cycle(3, 90); assert.ok(!c.isSet());
});

test('seek-bar marks', () => {
  const ab = AB.create();
  const hidden = { hidden: true, left: 0, width: 0, aPct: null, bPct: null };
  assert.deepStrictEqual(ab.marks(10), hidden);
  ab.set('a', 2, 60);
  assert.deepStrictEqual(ab.marks(10), { hidden: false, left: 20, width: 80, aPct: 20, bPct: null });
  assert.deepStrictEqual(ab.marks(0), hidden);
  ab.set('b', 7, 210);
  assert.deepStrictEqual(ab.marks(10, 1), { hidden: false, left: 30, width: 50, aPct: 30, bPct: 80 });
  assert.deepStrictEqual(ab.marks(5, -2), { hidden: false, left: 0, width: 100, aPct: 0, bPct: 100 });
  assert.strictEqual(ab.marks(5, -3).aPct, 0);
  assert.strictEqual(ab.marks(5, 1).bPct, 100);
  ab.set('a', 2, 60);
  assert.deepStrictEqual(ab.marks(10, -2), { hidden: false, left: 0, width: 50, aPct: null, bPct: 50 });
  ab.clear();
  ab.set('a', 2, 60);
  ab.set('b', 2.01, 61);
  assert.strictEqual(ab.marks(10).width, 0.3, 'a minimum width stays visible');
});

console.log(`${n} passed`);
