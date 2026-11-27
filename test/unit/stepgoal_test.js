'use strict';

const assert = require('node:assert/strict');
const { create, followerTime, followerSeekAction } = require('../../media/stepgoal');
/** A Compare offset in seconds: milliseconds, or frames at the tile's rate. */
const offsetSeconds = (offset, fps) => (offset.unit === 'ms' ? offset.v / 1000 : offset.v / fps);

function harness(frame = 60, dispatch = () => {}) {
  let now = 0;
  const timers = new Map();
  const sent = [];
  const controller = create({
    now: () => now,
    schedule(fn, ms) {
      const timer = Symbol();
      timers.set(timer, { at: now + ms, fn });
      return timer;
    },
    cancel: (timer) => timers.delete(timer),
    dispatch(goal) {
      sent.push([goal.frame, now]);
      dispatch(goal.time, now);
    },
  });
  const position = { frame, totalFrames: 300, rate: 30, duration: 10 };
  return {
    controller, sent, position, timers,
    step: (delta) => controller.step(delta, position),
    scrub: (frame) => controller.set(frame, position),
    advance(ms) {
      const end = now + ms;
      for (const [timer, { at, fn }] of timers) {
        if (at > end) continue;
        timers.delete(timer);
        now = at;
        fn();
      }
      now = end;
    },
  };
}

for (const delta of [-1, 1]) {
  const h = harness();
  h.step(delta);
  assert.deepEqual(h.sent, [[60 + delta, 0]], 'the first notch dispatches synchronously');
  assert.deepEqual(h.controller.goal, { frame: 60 + delta, time: (60 + delta) / 30 });
  h.controller.settle();
  assert.equal(h.controller.goal, null, 'settling restores the shown position');
}

{
  const h = harness();
  h.step(-1);
  for (let i = 0; i < 9; i++) h.step(-1);
  h.advance(89);
  assert.equal(h.controller.goal.frame, 50);
  assert.deepEqual(h.sent, [[59, 0]], 'the first seek has the burst window');
  h.advance(1);
  assert.deepEqual(h.sent, [[59, 0], [50, 90]], 'the latest target supersedes the first unresolved seek');
  assert.equal(h.controller.goal.frame, 50, 'the new goal stays visible while the replacement seek runs');
  h.controller.settle();
  h.advance(400);
  assert.equal(h.controller.goal, null);
  assert.equal(h.sent.length, 2);
}

{
  const h = harness();
  h.step(-1);
  h.step(-4);
  h.advance(20);
  h.controller.settle();
  h.step(2);
  assert.equal(h.controller.goal.frame, 57, 'reversing during a burst uses its net step count');
  h.advance(69);
  assert.deepEqual(h.sent, [[59, 0]]);
  h.advance(1);
  assert.deepEqual(h.sent, [[59, 0], [57, 90]]);
  h.controller.settle();
  h.position.frame = 56; // The decoder can land at a different time on a VFR source.
  h.step(1);
  assert.equal(h.controller.goal.frame, 57, 'a new burst starts at the shown frame');
}

{
  const h = harness();
  h.step(1);
  h.step(3);
  h.step(-3);
  h.controller.settle();
  h.advance(90);
  assert.deepEqual(h.sent, [[61, 0]], 'returning to the in-flight target needs no follow-up');
}

{
  const start = harness(1);
  start.step(-2);
  start.step(-1);
  assert.deepEqual(start.controller.goal, { frame: 0, time: 0 });
  start.controller.settle();
  start.position.frame = 0;
  start.step(-1);
  assert.deepEqual(start.sent, [[0, 0]]);

  const end = harness(298);
  end.position.duration = 9.95;
  end.step(8);
  end.step(1);
  assert.deepEqual(end.controller.goal, { frame: 299, time: 9.95 });
  end.controller.settle();
  end.position.frame = 299;
  end.step(1);
  assert.deepEqual(end.sent, [[299, 0]]);
}

for (const action of ['play', 'manual scrub', 'clock switch', 'reorder']) {
  const h = harness();
  h.step(-1);
  h.step(-1);
  h.controller.settle();
  assert.equal(h.timers.size, 1);
  h.controller.clear();
  assert.equal(h.controller.goal, null, `${action} drops the goal`);
  assert.equal(h.timers.size, 0, `${action} cancels the follow-up`);
  h.advance(10);
  h.position.frame = 18;
  h.step(1);
  assert.deepEqual(h.sent, [[59, 0], [19, 10]], `${action} resets the burst`);
  h.controller.clear();
  h.advance(100);
  assert.equal(h.sent.length, 2);
}

{
  const targets = [];
  const clockOffset = offsetSeconds({ unit: 'frames', v: 3 }, 30);
  const followers = [
    { offset: { unit: 'ms', v: 300 }, rate: 25 },
    { offset: { unit: 'frames', v: -12 }, rate: 24 },
  ];
  const h = harness(61, (time, at) => {
    for (const { offset, rate } of followers) targets.push([followerTime(time, clockOffset, offsetSeconds(offset, rate), rate), at]);
  });
  h.step(-1);
  assert.deepEqual(h.sent, [[60, 0]]);
  assert.deepEqual(targets.map(([, at]) => at), [0, 0], 'both targets are available at clock dispatch');
  assert.ok(Math.abs(targets[0][0] - 2.21) < 1e-9);
  assert.ok(Math.abs(targets[1][0] - (1.4 + 0.25 / 24)) < 1e-9);
}

{
  const targets = [];
  const h = harness(120, (time, at) => {
    targets.push([at, followerTime(time, 0, 0.25, 25), followerTime(time, 0, -0.5, 25)]);
  });
  h.scrub(90);
  assert.deepEqual(h.sent, [[90, 0]], 'dragging seeks immediately on the first input');
  h.advance(30);
  h.scrub(75);
  assert.deepEqual(h.controller.goal, { frame: 75, time: 2.5 });
  h.scrub(60);
  assert.deepEqual(h.controller.goal, { frame: 60, time: 2 }, 'the readout follows each absolute target');
  h.advance(59);
  assert.deepEqual(h.sent, [[90, 0]], 'drag inputs share the burst window');
  h.advance(1);
  assert.deepEqual(h.sent, [[90, 0], [60, 90]], 'the last input replaces the unresolved seek');
  assert.deepEqual(targets, [[0, 3.26, 2.51], [90, 2.26, 1.51]], 'followers receive the same dispatch times');

  h.advance(15);
  h.scrub(32);
  h.scrub(30);
  assert.equal(h.controller.goal.frame, 30);
  h.controller.flush();
  assert.deepEqual(h.sent, [[90, 0], [60, 90], [30, 105]], 'release seeks to the final slider value');
  h.controller.flush();
  h.advance(100);
  assert.equal(h.sent.length, 3, 'release cancels the timer and sends the final target once');
  h.controller.settle();
  assert.equal(h.controller.goal, null);
}

{
  const h = harness();
  h.scrub(500);
  assert.equal(h.controller.goal.frame, 299);
  h.scrub(-1);
  assert.deepEqual(h.controller.goal, { frame: 0, time: 0 });
  h.controller.flush();
  assert.deepEqual(h.sent, [[299, 0], [0, 0]]);
}

{
  const early = 0.25 / 25;
  const predicted = 1.01;
  const actual = 1.025; // A VFR correction of 15 ms still selects the same 25 fps follower picture.
  const tile = { gen: 7, seekTarget: predicted, pauseT: predicted, shownT: 0.96, queue: [], eof: false };
  assert.equal(followerSeekAction(tile, actual, early, 7), 'wait', 'keep the current step seek in flight');
  assert.equal(followerSeekAction(tile, actual, early, 6), 'seek', 'an unrelated seek can be replaced');
  tile.seekTarget = null;
  tile.queue = [{ t: 1 }, { t: 1.04 }];
  assert.equal(followerSeekAction(tile, actual, early, 7), 'wait', 'let the due frame present first');
  tile.shownT = tile.queue.shift().t;
  assert.equal(followerSeekAction(tile, actual, early, 7), 'keep', 'the decoded picture covers the corrected goal');
  assert.equal(followerSeekAction(tile, 0.98, early, 7), 'seek', 'a correction outside that picture still seeks');
  // A picture from before the tile's last seek does not continue into its queue (frames between were never shown).
  const stale = { gen: 8, seekTarget: null, pauseT: 5.008, shownT: 0.3, queue: [{ t: 5.033 }], eof: false, current: false };
  assert.equal(followerSeekAction(stale, 4.975, early), 'seek', 'a step back never keeps a stale picture');
  assert.equal(followerSeekAction({ ...stale, current: true }, 4.975, early), 'keep');
}

console.log('step goals: immediate step and scrub, coalescing, release, bounds, cancellation and follower offsets');
