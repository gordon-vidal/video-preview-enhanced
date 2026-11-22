'use strict';

const assert = require('node:assert/strict');
const { create, followerTime } = require('../../media/stepgoal');
const { offsetSeconds } = require('../../media/comparerange');

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
  h.advance(400);
  assert.equal(h.controller.goal.frame, 50);
  assert.deepEqual(h.sent, [[59, 0]], 'a slow clock seek is allowed to finish');
  h.controller.settle();
  assert.deepEqual(h.sent, [[59, 0], [50, 400]], 'only the latest target is sent');
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

console.log('step goals: immediate dispatch, coalescing, reversal, bounds, cancellation and follower offsets');
