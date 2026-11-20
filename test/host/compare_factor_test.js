'use strict';
// node test/host/compare_factor_test.js: compare's native frame sizes follow the picture size (Fill, Stretch,
// 100 %, zoom): the page's `tile.factor` scales the stage-sized tile, so a larger picture gets larger frames
// (src/compare.js tileHeights), a plain Fit leaves them as they were.
const assert = require('assert');
require('./mock_vscode').load({});
const { CompareSession } = require('../../src/compare');

const fake = (tile) => ({
  tile,
  rotation: [0, 0],
  liveTransport: 'stream',
  natives: [null, null],
  decisions: [1, 2].map(() => ({ tools: {}, maxHeight: 2160, messageMaxHeight: 1080, probed: { video: { width: 3840, height: 2160, fps: 25 } } })),
});
const heights = (tile) => CompareSession.prototype.tileHeights.call(fake(tile));

// Two tiles side by side in a 1920x1080 stage: each tile 960 wide, the 16:9 picture 540 high.
const plain = heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1 });
assert.deepStrictEqual(plain, [540, 540]);
assert.deepStrictEqual(heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1, factor: 1 }), plain, 'factor 1 changes nothing');
// 100 % of a 4K file in that cell is four times the picture's height: much larger frames (then the shared transfer budget
// scales every tile down together, so not always the file's own 2160).
const actual = heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1, factor: 4 });
assert.ok(actual[0] > 1000 && actual[0] <= 2160 && actual[0] === actual[1], `100 %: ${actual}`);
// Fill (a cell of another shape crops the picture): the factor grows the frames to cover.
const fill = heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1, factor: 1.78 });
assert.ok(fill[0] > plain[0] && fill[0] < 2160, `fill frames grow: ${fill}`);
// A smaller picture (100 % of a small video in a large cell) needs fewer pixels.
assert.ok(heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1, factor: 0.5 })[0] < plain[0]);
// Nonsense from the page is ignored or clamped; the frames never exceed the file.
assert.deepStrictEqual(heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1, factor: 'x' }), plain);
assert.deepStrictEqual(heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1, factor: -3 }), plain);
assert.ok(heights({ w: 1920, h: 1080, cols: 2, rows: 1, rate: 1, factor: 1e9 })[0] <= 2160);

console.log('compare_factor_test: ok');
