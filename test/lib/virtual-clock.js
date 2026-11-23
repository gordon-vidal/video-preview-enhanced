'use strict';
// A clock tests can move by hand: the { now, setTimeout, clearTimeout } that src/link-sim.js takes, with no real
// waiting. Timers due at the same time fire in the order they were set.

function createVirtualClock(start = 0) {
  let time = start;
  let seq = 0;
  const timers = new Map(); // id -> { at, seq, fn }
  const next = (limit) => {
    let best = null;
    for (const [id, t] of timers) {
      if (t.at > limit) continue;
      if (!best || t.at < best.t.at || (t.at === best.t.at && t.seq < best.t.seq)) best = { id, t };
    }
    return best;
  };
  return {
    now: () => time,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: time + Math.max(0, ms), seq: id, fn });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    /** Moves time forward by ms, running every timer that falls due on the way (also ones they set). */
    advance(ms) {
      const target = time + ms;
      for (let hit = next(target); hit; hit = next(target)) {
        timers.delete(hit.id);
        time = Math.max(time, hit.t.at);
        hit.t.fn();
      }
      time = target;
    },
    /** Runs until no timer is left (a simulator with nothing pending has none). */
    runAll() {
      for (let hit = next(Infinity); hit; hit = next(Infinity)) {
        timers.delete(hit.id);
        time = Math.max(time, hit.t.at);
        hit.t.fn();
      }
    },
    pending: () => timers.size,
  };
}

module.exports = { createVirtualClock };
