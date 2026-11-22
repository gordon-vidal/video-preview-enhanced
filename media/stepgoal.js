// @ts-check
'use strict';

(function (root) {
  // checkJs: start
  /** @typedef {{frame: number, time: number}} Goal */
  /** @typedef {{frame: number, totalFrames: number, rate: number, duration: number}} Position */

  /**
   * The first step seeks immediately. While the clock is catching up, steps accumulate
   * from the requested frame. Only the latest target goes out after that seek and the burst window.
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
      if (!goal || inFlight !== null || timer !== null) return;
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
        if (goal?.frame === inFlight) goal = null;
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
  // checkJs: end

  const api = { create, followerTime };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeStepGoal = api;
}(typeof self !== 'undefined' ? self : this));
