'use strict';

const assert = require('node:assert/strict');
const { compare, flatten } = require('../perf/run');

const before = { firstFrame: 10, decodeMs: 20, rssMB: 10, privateBytes: 10e6, cpuSeconds: 0.02,
  quietFps: 2, playbackFps: 60, 'opening.othersLoad': 1 };
const after = { firstFrame: 35, decodeMs: 46, rssMB: 30, privateBytes: 31e6, cpuSeconds: 0.05,
  quietFps: 1, playbackFps: 30, 'opening.othersLoad': 100 };
const rows = compare(after, before);
assert.deepEqual(rows.filter((row) => row.gross).map((row) => row.k),
  ['decodeMs', 'privateBytes', 'cpuSeconds', 'playbackFps']);
assert.ok(rows.every((row) => !row.k.includes('othersLoad')));
assert.deepEqual(flatten({ opening: { firstFrame: 46, othersLoad: 100 } }), { 'opening.firstFrame': 46 });
assert.equal(compare({ decodeMs: 130 }, { decodeMs: 100 })[0].gross, false, 'absolute delta alone is insufficient');
assert.equal(compare({ 'clip.peak.webview': 31 }, { 'clip.peak.webview': 10 }, 'memory')[0].gross, true);
console.log('performance comparison: ok');
