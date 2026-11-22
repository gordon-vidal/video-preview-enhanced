'use strict';

const assert = require('node:assert/strict');
const { inspectSource } = require('../../src/clipexport');

// A native seek can label the displayed 1.040 s picture as 1.000 s when the source has a VFR gap.
assert.rejects(() => inspectSource({}, '', { a: 1, b: 1, early: 0, native: true }),
  /unavailable for ranges marked or mapped with native playback/).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
