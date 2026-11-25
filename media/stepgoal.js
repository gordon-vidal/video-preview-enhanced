// @ts-check
'use strict';

(function (root) {
  // checkJs: start
  /** @typedef {{frame: number, time: number, exact?: boolean}} Goal */
  /** @typedef {{totalFrames: number, rate: number, duration: number}} Bounds */
  /** @typedef {Bounds & {frame: number}} Position */

  /**
   * The first request seeks immediately. After the burst window, the latest step
   * target supersedes an obsolete seek.
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

    function dispatchPending() {
      if (!goal || goal.frame === inFlight || timer !== null) return;
      const delay = sentAt + coalesceMs - now();
      if (delay > 0) {
        timer = schedule(() => { timer = null; dispatchPending(); }, delay);
      } else {
        flush();
      }
    }

    function flush() {
      if (timer !== null) cancel(timer);
      timer = null;
      if (!goal || goal.frame === inFlight) return;
      inFlight = goal.frame;
      sentAt = now();
      dispatch(goal);
    }

    /** @param {number} frame @param {number} totalFrames */
    function clampFrame(frame, totalFrames) {
      return Math.max(0, Math.min(totalFrames > 0 ? totalFrames - 1 : Infinity, frame));
    }

    /** @param {number} frame @param {Bounds} bounds */
    function aim(frame, { rate, duration }, exact = false) {
      goal = { frame, time: Math.min(duration > 0 ? duration : Infinity, frame / rate), ...(exact ? { exact } : {}) };
      dispatchPending();
    }

    return {
      get goal() { return goal; },
      /** @param {number} frame @param {Bounds} bounds @param {boolean} [exact] */
      set(frame, bounds, exact) {
        aim(clampFrame(frame, bounds.totalFrames), bounds, exact);
      },
      /** @param {number} delta @param {Position} position */
      step(delta, position) {
        const base = goal?.frame ?? position.frame;
        const target = clampFrame(base + delta, position.totalFrames);
        if (target !== base) aim(target, position);
      },
      /** Dispatch the latest queued target immediately. */
      flush,
      /** Called after the clock has presented the picture for the dispatched seek. */
      settle() {
        if (inFlight === null) return;
        if (goal?.frame === inFlight) {
          goal = null;
          if (timer !== null) cancel(timer);
          timer = null;
        }
        inFlight = null;
        dispatchPending();
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
   * A picture shown before the tile's last seek or jump (current false) does not continue into its queue: it is
   * never kept, whatever its time.
   * @param {{gen: number, seekTarget: number | null, pauseT: number, shownT: number | null, eof: boolean,
   *   current?: boolean} & ({nextQueuedT: number | null} | {queue: {t: number}[]})} tile
   * @param {number} target @param {number} early @param {number} [stepGen]
   */
  function followerSeekAction(tile, target, early, stepGen) {
    const next = 'nextQueuedT' in tile ? tile.nextQueuedT : tile.queue[0]?.t ?? null;
    const shownFits = tile.shownT !== null && tile.shownT <= target + early + 1e-6;
    if (tile.gen === stepGen && (tile.seekTarget !== null
      || (next !== null ? next <= tile.pauseT + early : shownFits && !tile.eof))) return 'wait';
    if (tile.seekTarget === null && shownFits && tile.current !== false
      && (next !== null ? next > target + early : tile.eof)) return 'keep';
    return 'seek';
  }
  // checkJs: end

  const api = { create, followerTime, followerSeekAction };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VpeStepGoal = api;
}(typeof self !== 'undefined' ? self : this));
