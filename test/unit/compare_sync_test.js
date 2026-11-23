'use strict';

const assert = require('node:assert/strict');
const { CompareSyncController } = require('../../media/compare-sync');

function tile(key, startT) {
  const state = {
    startT, shownT: startT, pauseT: startT, seekTarget: null, nextQueuedT: null,
    eof: false, gen: 0, fps: 30, shownCount: 1, firstFrameReady: true, settled: true,
  };
  return {
    key, state, meta: { duration: 10 }, playing: false, seeks: [], holds: [],
    syncState: () => ({ ...state }),
    rel: (t) => t - startT,
    now() { return this.playing && this.follower ? this.follower() : state.pauseT; },
    setFollowerMode(fn) { this.follower = fn; },
    setLoop(loop) { this.loop = loop; },
    play() { this.playing = true; },
    pause() { this.playing = false; },
    holdAt(t) { this.holds.push(t); },
    retargetPaused(t) { state.pauseT = t; },
    hasQueuedTime: () => false,
    seekTime(t) {
      this.seeks.push(t);
      state.gen++;
      state.seekTarget = state.pauseT = startT + t;
    },
  };
}

function setup() {
  const a = tile('A', 10);
  const b = tile('B', 20);
  const offsets = [0, 0];
  const tiles = [a, b];
  const sync = new CompareSyncController({ tiles: () => tiles, offset: (i) => offsets[i], sound: () => 1 });
  sync.setClock(0, true);
  return { a, b, sync, offsets };
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

{
  const { a, b, sync } = setup();
  b.state.fps = 25;
  sync.seekFollowers(1);
  near(b.seeks[0], 1.01);
  a.state.shownT = 11.015;
  sync.syncPaused();
  assert.equal(b.seeks.length, 1, 'VFR reconciliation leaves the step seek in flight');
  Object.assign(b.state, { seekTarget: null, nextQueuedT: 21.02 });
  sync.syncPaused();
  near(b.state.pauseT, 21.01);
  Object.assign(b.state, { shownT: 21.02, nextQueuedT: 21.06 });
  sync.syncPaused();
  near(b.state.pauseT, 21.025);
  assert.equal(b.seeks.length, 1, 'reuse the decoded frame that covers the corrected timestamp');
  a.state.shownT = 10.95;
  sync.syncPaused();
  near(b.seeks[1], 0.96);
}

{
  const { a, b, sync } = setup();
  a.play();
  Object.assign(a.state, { pauseT: 11, shownT: 11 });
  sync.syncPlaying();
  assert.equal(sync.waiting, true);
  assert.deepEqual(a.holds, [11]);
  near(b.holds[0], 21 + 0.25 / 30);
  Object.assign(b.state, { shownT: 21, seekTarget: null });
  sync.syncPlaying();
  assert.equal(sync.waiting, false);
  assert.deepEqual(a.holds, [11]);
}

{
  const { a, b, sync, offsets } = setup();
  a.play();
  b.play();
  offsets[1] = -1;
  sync.syncPlaying();
  assert.equal(b.playing, false);
  assert.equal(b.seeks.length, 0);
  assert.equal(sync.waiting, false);
}

{
  const { a, b, sync, offsets } = setup();
  offsets[1] = 3 / 30;
  a.play();
  sync.syncPlaying();
  near(b.seeks[0], 3.25 / 30);
  b.state.fps = 25;
  offsets[1] = 3 / 25;
  assert.equal(sync.updateFps('B', true, true), true);
  near(b.seeks[1], 3.25 / 25);
  assert.equal(sync.updateFps('B', true, true), false);
  assert.equal(b.seeks.length, 2);
}

{
  const { a, b, sync, offsets } = setup();
  offsets[1] = 0.5;
  a.state.shownT = 11;
  b.state.shownT = 22;
  b.play();
  near(b.now(), 21.5 + 0.25 / 30);
  b.pause();
  assert.equal(sync.setClock(1, false), b);
  assert.equal(b.follower, null);
  assert.equal(b.loop, false);
  a.play();
  near(a.now(), 11.5 + 0.25 / 30);
  a.pause();
  assert.equal(sync.setClock(0, true), a);
  assert.equal(a.follower, null);
  assert.equal(a.loop, true);
}

console.log('compare sync: VFR, lag hold, range bounds, FPS discovery, clock switching');
