'use strict';
// node test/run.js unit --grep compare_factor: a comparing viewer's native frame sizes follow the picture size (Fill,
// Stretch, 100 %, zoom; src/unified-viewer.js nativeHeightFor): the page's `factor` scales the tile, so a larger picture
// gets larger frames, a plain Fit leaves them as they were, and the frames never exceed the file or the decision's cap.
const assert = require('assert');
const { nativeHeightFor } = require('../../src/unified-viewer');

const clip = (rotation = 0) => ({
  rotation, decision: { tools: {}, maxHeight: 2160, messageMaxHeight: 1080, probed: { video: { width: 3840, height: 2160, fps: 25 } } },
});
/** Both tiles of two side by side (the stage split by the grid), or a tile's own size (perTile). */
const heights = (tile, perTile = false) => [clip(), clip()].map((c) => nativeHeightFor(c, tile, perTile));

// Two tiles side by side in a 1920x1080 stage: each tile 960 wide, the 16:9 picture 540 high.
const plain = heights({ w: 1920, h: 1080, cols: 2, rows: 1 });
assert.deepStrictEqual(plain, [540, 540]);
assert.deepStrictEqual(heights({ w: 1920, h: 1080, cols: 2, rows: 1, factor: 1 }), plain, 'factor 1 changes nothing');
// 100 % of a 4K file in that cell is four times the picture's height: the file's own 2160 at most.
const actual = heights({ w: 1920, h: 1080, cols: 2, rows: 1, factor: 4 });
assert.ok(actual[0] > 1000 && actual[0] <= 2160 && actual[0] === actual[1], `100 %: ${actual}`);
// Fill (a cell of another shape crops the picture): the factor grows the frames to cover.
const fill = heights({ w: 1920, h: 1080, cols: 2, rows: 1, factor: 1.78 });
assert.ok(fill[0] > plain[0] && fill[0] < 2160, `fill frames grow: ${fill}`);
// A smaller picture (100 % of a small video in a large cell) needs fewer pixels.
assert.ok(heights({ w: 1920, h: 1080, cols: 2, rows: 1, factor: 0.5 })[0] < plain[0]);
// Nonsense from the page is ignored or clamped; the frames never exceed the file.
assert.deepStrictEqual(heights({ w: 1920, h: 1080, cols: 2, rows: 1, factor: 'x' }), plain);
assert.deepStrictEqual(heights({ w: 1920, h: 1080, cols: 2, rows: 1, factor: -3 }), plain);
assert.ok(heights({ w: 1920, h: 1080, cols: 2, rows: 1, factor: 1e9 })[0] <= 2160);
// A tile's own size (a per-tile report) is not split again; 100 % ('actual') takes the file's size up to the cap.
assert.deepStrictEqual(heights({ w: 960, h: 1080 }, true), [540, 540]);
assert.deepStrictEqual(heights({ w: 960, h: 1080, actual: true }, true), [2160, 2160]);
// A turned video (90°) stands upright in the tile: 540 high on screen is 304 wide, the source's own height.
assert.strictEqual(nativeHeightFor(clip(90), { w: 960, h: 540 }, true), 304);
// No probe: the decision's cap.
assert.strictEqual(nativeHeightFor({ rotation: 0, decision: { maxHeight: 720 } }, { w: 100, h: 100 }, true), 720);

console.log('compare_factor_test: ok');
