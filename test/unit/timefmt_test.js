'use strict';
// media/timefmt.js: the player's time, timecode, size and frame-counter labels.
const assert = require('assert');
const T = require('../../media/timefmt');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok   ${name}`); };

test('fmtTime: m:ss.mmm, h:mm:ss.mmm, rounded to ms, nonsense is 0', () => {
  assert.strictEqual(T.fmtTime(0), '0:00.000');
  assert.strictEqual(T.fmtTime(1.5), '0:01.500');
  assert.strictEqual(T.fmtTime(61.0004), '1:01.000');
  assert.strictEqual(T.fmtTime(3600 + 62.25), '1:01:02.250');
  assert.strictEqual(T.fmtTime(-1), '0:00.000');
  assert.strictEqual(T.fmtTime(NaN), '0:00.000');
  assert.strictEqual(T.fmtTime(Infinity), '0:00.000');
});

test('fmtClock: milliseconds are cut, never rounded up to the next second; optional', () => {
  assert.strictEqual(T.fmtClock(1.9999), '0:01.999');
  assert.strictEqual(T.fmtClock(59.9999, false), '0:59');
  assert.strictEqual(T.fmtClock(2 / 3), '0:00.666');
  assert.strictEqual(T.fmtClock(1.001), '0:01.001', 'float error does not drop a millisecond');
  assert.strictEqual(T.fmtClock(7322.5), '2:02:02.500');
});

test('fmtTimecode: hh:mm:ss:ff at the rounded rate (29.97 counts as 30)', () => {
  assert.strictEqual(T.fmtTimecode(0, 30), '00:00:00:00');
  assert.strictEqual(T.fmtTimecode(59, 30), '00:00:01:29');
  assert.strictEqual(T.fmtTimecode(30 * 3661 + 5, 30000 / 1001), '01:01:01:05');
  assert.strictEqual(T.fmtTimecode(25, 0), '00:00:00:25', 'unknown rate: 30');
});

test('fmtSize and the frame counter', () => {
  assert.strictEqual(T.fmtSize(1.5e6), '1.5 MB');
  assert.strictEqual(T.fmtSize(2.345e9), '2.35 GB');
  assert.strictEqual(T.frameText(58, 120), '#59/120', 'the counter is 1-based (step-ms-rounded checks "#59/")');
  assert.strictEqual(T.frameText(0, 0), '#1/?');
});

console.log(`${n} passed`);
