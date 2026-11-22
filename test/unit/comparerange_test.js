'use strict';
// node test/run.js unit --grep comparerange: what each Compare tile showed at A and B is what its clip uses.
const assert = require('assert');
const { captureTile, captureMark, snapshotTile, tileRange, mapRange } = require('../../media/comparerange');

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

// A follower and then the clock can decode ahead of the compositor's last draw.
const player = (shownT, srcT) => ({
  shownT,
  shownFrame: { srcT },
  rel: (t) => t,
  shownMarkTime() { return this.shownFrame.srcT; },
});
const clock = player(1.0, 0.96);
const follower = player(1.04, 1.04);
const presented = [snapshotTile(clock, 25), snapshotTile(follower, 25)];
follower.shownT = 1.08;
follower.shownFrame = { srcT: 1.08, nativeTimestamp: true };
clock.shownT = 1.04;
clock.shownFrame = { srcT: 1.0 };
assert.deepStrictEqual(captureMark(presented, 0, [0, 0.04]), {
  t: 1.0, pts: 0.96, native: false, tiles: [{ rel: 0.96, native: false }, { rel: 1.04, native: false }],
}, 'A/B uses the last drawn pictures even when the new follower is within the matching tolerance');
const next = [snapshotTile(clock, 25), snapshotTile(follower, 25)];
assert.deepStrictEqual(captureMark(next, 0, [0, 0.04]).tiles[1], { rel: 1.08, native: true });
assert.strictEqual(captureMark([next[0]], 0, [0, 0.04]).tiles[1], undefined, 'an undrawn tile has no capture');
assert.strictEqual(captureMark([], 0, [0, 0.04]), null, 'a mark needs a presented clock picture');
console.log('comparerange: ok');
