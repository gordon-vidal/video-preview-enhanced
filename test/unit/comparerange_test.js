'use strict';
// node test/run.js unit --grep comparerange: what each Compare tile showed at A and B is what its clip uses.
const assert = require('assert');
const { captureTile, tileRange, mapRange } = require('../../media/comparerange');

// A VFR clock holds its 0.96 s picture at the 1.00 s slot; a zero-offset CFR follower shows its 1.00 s picture.
const clockAt = captureTile({ shownRel: 1.0, markRel: 0.96, expectedRel: 1.0, fps: 25, native: false });
const followerAt = captureTile({ shownRel: 1.0, markRel: 1.0, expectedRel: 1.0, fps: 25, native: false });
assert.deepStrictEqual(clockAt, { rel: 0.96, native: false });
assert.deepStrictEqual(followerAt, { rel: 1.0, native: false }, 'the follower keeps its own picture time');
const clockB = captureTile({ shownRel: 1.6, markRel: 1.6, expectedRel: 1.6, fps: 25, native: false });
const followerB = captureTile({ shownRel: 1.6, markRel: 1.6, expectedRel: 1.6, fps: 25, native: false });
assert.deepStrictEqual(tileRange(followerAt, followerB, null), { a: 1.0, b: 1.6, early: 0, native: false });
assert.deepStrictEqual(tileRange(clockAt, clockB, null), { a: 0.96, b: 1.6, early: 0, native: false });

// A tile that is not at the clock's moment (still seeking, or not showing yet) falls back to the nominal mapping.
assert.strictEqual(captureTile({ shownRel: 0.5, markRel: 0.5, expectedRel: 1.0, fps: 25, native: false }), null);
assert.strictEqual(captureTile({ shownRel: NaN, markRel: 1, expectedRel: 1.0, fps: 25 }), null);
const nominal = { ...mapRange(0.96, 1.6, 0.08, 25, false), native: false };
assert.strictEqual(tileRange(null, followerB, nominal), nominal);

// A tile whose time is a slot count (native without stamps, Live transcode) stays ineligible.
const estimated = captureTile({ shownRel: 1.0, markRel: 1.0, expectedRel: 1.0, fps: 25, native: true });
assert.strictEqual(tileRange(estimated, followerB, null).native, true);
console.log('comparerange: ok');
