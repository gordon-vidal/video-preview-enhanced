// @ts-check
'use strict';

(function (root) {
  // checkJs: start
  /** @typedef {{frame: number, time: number}} Goal */
  /** @typedef {{frame: number, totalFrames: number, rate: number, duration: number}} Position */

  /**
   * The first step seeks immediately. While the clock is catching up, steps accumulate
   * from the requested frame. After the burst window, the latest target supersedes an obsolete seek.
   * @template Timer
   * @param {{dispatch: (goal: Goal) => void, now: () => number,
   *   schedule: (fn: () => void, ms: number) => Timer, cancel: (timer: Timer) => void}} deps
   */
  function create({ dispatch, now, schedule, cancel }) {
    const coalesceMs = 90;
    /** @type {Goal | null} */
    let goal = null;
    /** @type {number | null} */
    let inFlight = null;
    /** @type {Timer | null} */
    let timer = null;
    let sentAt = -Infinity;

    function flush() {
      if (!goal || goal.frame === inFlight || timer !== null) return;
      const delay = sentAt + coalesceMs - now();
      if (delay > 0) {
        timer = schedule(() => { timer = null; flush(); }, delay);
      } else {
        inFlight = goal.frame;
        sentAt = now();
        dispatch(goal);
      }
    }

    return {
      get goal() { return goal; },
      /** @param {number} delta @param {Position} position */
      step(delta, { frame, totalFrames, rate, duration }) {
        const base = goal?.frame ?? frame;
        const target = Math.max(0, Math.min(totalFrames > 0 ? totalFrames - 1 : Infinity, base + delta));
        if (target === base) return;
        goal = { frame: target, time: Math.min(duration > 0 ? duration : Infinity, target / rate) };
        flush();
      },
      /** Called after the clock has presented the picture for the dispatched seek. */
      settle() {
        if (inFlight === null) return;
        if (goal?.frame === inFlight) {
          goal = null;
          if (timer !== null) cancel(timer);
          timer = null;
        }
        inFlight = null;
        flush();
      },
      clear() {
        if (timer !== null) cancel(timer);
        timer = goal = inFlight = null;
        sentAt = -Infinity;
      },
    };
  }

  /** @param {number} clockTime @param {number} clockOffset @param {number} tileOffset @param {number} tileRate */
  function followerTime(clockTime, clockOffset, tileOffset, tileRate) {
    return clockTime - clockOffset + tileOffset + 0.25 / tileRate;
  }

  /**
   * A follower already decoding for this step gets to show its picture before a correction.
   * @param {{gen: number, seekTarget: number | null, pauseT: number, shownT: number | null,
   *   queue: {t: number}[], eof: boolean}} tile
   * @param {number} target @param {number} early @param {number} [stepGen]
   */
  function followerSeekAction(tile, target, early, stepGen) {
    const next = tile.queue[0];
    const shownFits = tile.shownT !== null && tile.shownT <= target + early + 1e-6;
    if (tile.gen === stepGen && (tile.seekTarget !== null
      || (next ? next.t <= tile.pauseT + early : shownFits && !tile.eof))) return 'wait';
    if (tile.seekTarget === null && shownFits && (next ? next.t > target + early : tile.eof)) return 'keep';
    return 'seek';
  }
  // checkJs: end

  const api = { create, followerTime, followerSeekAction };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeStepGoal = api;
}(typeof self !== 'undefined' ? self : this));
