// @ts-check
'use strict';

(function () {
  const stepGoal = typeof module === 'object' && module.exports ? require('./stepgoal') : globalThis.VpeStepGoal;

  // checkJs: start
  /** @typedef {Readonly<{
   *   startT: number | null, shownT: number | null, pauseT: number, seekTarget: number | null,
   *   nextQueuedT: number | null, eof: boolean, gen: number, fps: number, shownCount: number,
   *   firstFrameReady: boolean, settled: boolean, current?: boolean,
   * }>} SyncState */
  /** @typedef {{
   *   key: string, playing: boolean, meta: {duration: number}, syncState: () => SyncState,
   *   rel: (time: number) => number, now: () => number, setLoop: (loop: boolean) => void,
   *   setFollowerMode: (clock: (() => number) | null) => void, hasQueuedTime: (time: number, lead: number) => boolean,
   *   holdAt: (time: number) => void, retargetPaused: (time: number) => void,
   *   play: () => void, pause: () => void, seekTime: (time: number) => void,
   * }} Tile */

  /** @param {Tile} tile @param {number} rel @param {number} [fps] */
  function outOfRange(tile, rel, fps = tile.syncState().fps) {
    const halfFrame = 0.5 / fps;
    return rel < -halfFrame || (tile.meta.duration > 0 && rel > tile.meta.duration + halfFrame);
  }

  /** @param {Tile} tile */
  function settled(tile) { return tile.syncState().settled; }

  // A follower that makes no progress for this long stops holding the group (a seek or stream that never delivers).
  const STALL_MS = 3000;

  /** @param {Tile} tile */
  function atFirstFrame(tile) { return tile.syncState().firstFrameReady; }

  class CompareSyncController {
    /** @param {{tiles: () => Tile[], offset: (i: number) => number, sound: () => number, now?: () => number}} deps */
    constructor(deps) {
      this.deps = deps;
      this.now = deps.now ?? (() => performance.now());
      /** @type {Map<Tile, {mark: string, since: number}>} */
      this.stalls = new Map();
      /** @type {Tile | null} */
      this.clock = null;
      this.clockIndex = 0;
      this.lastGen = -1;
      this.waiting = false;
      /** @type {Map<string, number>} */
      this.syncedFps = new Map();
      /** @type {string[]} */
      this.reqs = [];
      /** @type {Map<Tile, number>} */
      this.stepSeeks = new Map();
    }

    /** Tile position at a clock timestamp, with offsets and the early-frame nudge.
     * @param {number} i @param {number} clockRel @param {number} [fps]
     */
    relFor(i, clockRel, fps = this.deps.tiles()[i].syncState().fps) {
      return stepGoal.followerTime(clockRel, this.deps.offset(this.clockIndex), this.deps.offset(i), fps);
    }

    /** The picture's time drives followers once the clock finishes seeking. @param {Tile} clock */
    clockPosition(clock) {
      const { shownT, seekTarget } = clock.syncState();
      return clock.rel(shownT !== null && seekTarget === null ? shownT : clock.now());
    }

    /** @param {Tile} tile @param {number} index */
    followClock(tile, index) {
      tile.setFollowerMode(() => {
        const { startT, pauseT, fps } = tile.syncState();
        const clock = this.clock;
        if (startT === null || !clock || clock.syncState().startT === null) return pauseT;
        return startT + this.relFor(index, this.clockPosition(clock), fps);
      });
    }

    /** Assign clock roles after the page pauses the old group. @param {number} index @param {boolean} loop */
    setClock(index, loop) {
      const tiles = this.deps.tiles();
      this.clockIndex = index;
      const clock = this.clock = tiles[index] ?? null;
      this.lastGen = -1;
      this.waiting = false;
      this.invalidate();
      if (clock) {
        clock.setFollowerMode(null);
        clock.setLoop(loop);
        tiles.forEach((tile, i) => { if (i !== index) this.followClock(tile, i); });
      }
      return clock;
    }

    /** @param {number} index @param {Tile} previous @param {boolean} loop */
    replaceTile(index, previous, loop) {
      const tile = this.deps.tiles()[index];
      if (previous === this.clock) {
        this.clock = tile;
        tile.setLoop(loop);
        this.lastGen = -1;
      } else {
        this.followClock(tile, index);
      }
      this.resetRequests();
      this.stepSeeks.delete(previous);
      return this.clock;
    }

    clearStep() { this.stepSeeks.clear(); }
    resetRequests() { this.reqs = []; }
    invalidate() { this.resetRequests(); this.clearStep(); this.stalls.clear(); }

    /** True once a lagging follower has shown no progress for STALL_MS. @param {Tile} tile @param {string} mark */
    stalled(tile, mark) {
      const now = this.now();
      const seen = this.stalls.get(tile);
      if (!seen || seen.mark !== mark) {
        this.stalls.set(tile, { mark, since: now });
        return false;
      }
      return now - seen.since > STALL_MS;
    }

    /** Redo frame offsets once the real rate replaces the default.
     * @param {string} key @param {boolean} begun @param {boolean} hasFrameOffsets
     */
    updateFps(key, begun, hasFrameOffsets) {
      const tile = this.deps.tiles().find((tile) => tile.key === key);
      if (!tile) return false;
      const { fps } = tile.syncState();
      const previous = this.syncedFps.get(key) ?? 30;
      this.syncedFps.set(key, fps);
      if (fps === previous || !begun || !hasFrameOffsets) return false;
      this.invalidate();
      this.syncPlaying(true);
      return true;
    }

    /** @param {(position: number, clock: Tile) => void} resize */
    resyncAfterResize(resize) {
      const clock = this.clock;
      if (!clock) return;
      const synced = this.lastGen === clock.syncState().gen;
      resize(this.clockPosition(clock), clock);
      if (synced) this.lastGen = clock.syncState().gen; // resizing did not move the clock
    }

    syncPlaying(force = false) {
      const clock = this.clock;
      if (!clock || !clock.playing) return;
      const { startT, gen, shownT, seekTarget, current } = clock.syncState();
      if (startT === null) return;
      const moved = force || gen !== this.lastGen;
      this.lastGen = gen;
      if (moved) this.stalls.clear();
      const clockRel = moved ? clock.rel(clock.now()) : this.clockPosition(clock);
      let hold = false;
      const tiles = this.deps.tiles();
      tiles.forEach((tile, i) => {
        if (tile === clock) return;
        const { startT, fps } = tile.syncState();
        if (startT === null) return;
        const rel = this.relFor(i, clockRel, fps);
        if (outOfRange(tile, rel, fps)) {
          if (tile.playing) tile.pause();
          return;
        }
        if (moved || !tile.playing) {
          if (moved || !tile.hasQueuedTime(startT + rel, 0.1)) tile.seekTime(Math.max(0, rel));
          tile.play();
        }
        const { eof, nextQueuedT, seekTarget, shownT, shownCount, gen: tileGen } = tile.syncState();
        const done = eof && nextQueuedT === null;
        const due = startT + rel;
        // Its next picture is not due yet (after a seek, a gap or a frame grid that differs from the clock's): it shows
        // what is due. Holding would freeze its time (the clock's picture) before that picture for good.
        const waitsForClock = seekTarget === null && nextQueuedT !== null && nextQueuedT > due + 0.25 / fps;
        const lag = seekTarget !== null || shownT === null ? Infinity : due - shownT;
        if (done || waitsForClock || !(lag > Math.max(0.12, 2 / fps))) {
          this.stalls.delete(tile);
          return;
        }
        if (!this.stalled(tile, `${tileGen}|${shownCount}|${nextQueuedT}|${seekTarget}`)) hold = true;
      });
      // Hold the picture and sound together while a follower catches up. Not while the clock's own picture is about to
      // jump (a seek within its decoded frames): holding at the old picture would take its time back there.
      if (hold && shownT !== null && seekTarget === null && current !== false) {
        clock.holdAt(shownT);
        const sound = tiles[this.deps.sound()];
        if (sound && sound !== clock && sound.playing) sound.holdAt(sound.now());
      }
      this.waiting = hold;
    }

    get clockStepReady() {
      if (!this.clock) return false;
      const { seekTarget, nextQueuedT, pauseT, fps } = this.clock.syncState();
      return seekTarget === null && (nextQueuedT === null || nextQueuedT > pauseT + 0.25 / fps);
    }

    syncPaused() {
      const clock = this.clock;
      if (!clock || clock.playing) return;
      const { startT, shownT, seekTarget } = clock.syncState();
      if (startT === null || shownT === null || seekTarget !== null) return;
      this.seekFollowers(clock.rel(shownT), true);
    }

    /** All ready followers start together. Reconcile once the clock's picture time is known.
     * @param {number} clockRel
     */
    seekFollowers(clockRel, reconcile = false) {
      this.deps.tiles().forEach((tile, i) => {
        if (tile === this.clock) return;
        let state = tile.syncState();
        if (state.startT === null) return;
        if (tile.playing) {
          tile.pause();
          state = tile.syncState();
        }
        const { startT, fps, gen, seekTarget, shownT } = state;
        if (startT === null) return;
        const rel = this.relFor(i, clockRel, fps);
        const key = rel.toFixed(6);
        const outside = outOfRange(tile, rel, fps);
        if (key === this.reqs[i]) {
          if (!reconcile && seekTarget !== null && !outside) this.stepSeeks.set(tile, gen);
          return;
        }
        if (outside) { this.reqs[i] = key; this.stepSeeks.delete(tile); return; }
        const target = startT + Math.max(0, rel);
        const action = stepGoal.followerSeekAction(state, target, 0.25 / fps,
          reconcile ? this.stepSeeks.get(tile) : undefined);
        if (action === 'wait') return;
        this.reqs[i] = key;
        this.stepSeeks.delete(tile);
        // A tile still decoding its first picture can finish that work without seeking.
        const first = seekTarget === null && (shownT === null || shownT === startT) && rel <= 0.5 / fps;
        if (action === 'keep' || first) {
          tile.retargetPaused(target);
          return;
        }
        tile.seekTime(Math.max(0, rel));
        const after = tile.syncState();
        if (!reconcile && after.seekTarget !== null) this.stepSeeks.set(tile, after.gen);
      });
    }
  }
  // checkJs: end

  const api = { CompareSyncController, settled, atFirstFrame, outOfRange };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.VpeCompareSync = api;
}());
