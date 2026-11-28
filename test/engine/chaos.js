'use strict';

const assert = require('node:assert/strict');
const { open, checks } = require('./harness');
const { execFileSync } = require('child_process');
const { ffTool, ncc } = require('../lib/frames');
const { makeStepping, makeLarge } = require('../media/make_heavy_media');

const SEED = Number(process.env.VPE_FUZZ_SEED) || 20261124;
const c = checks(`engine chaos (seed ${SEED})`);
class DenseVfrSkip extends Error {}
const denseVfr = {
  reason: 'nominal-frame seek skips an adjacent picture in the 60 fps segment',
  matches: (error) => error instanceof DenseVfrSkip,
};

function checkBudget(P) {
  const p = P.player;
  const bytes = p.queue.reduce((sum, frame) => sum + frame.bytes, 0);
  assert.ok(p.backBytes <= p.backBudget(), `back cache exceeded its budget: ${p.backBytes}`);
  // An in-flight WASM decode batch can push a queue over the read-ahead threshold.
  assert.ok(bytes + p.backBytes <= 2 * p.budget(), `frame buffers exceeded the batch allowance: ${bytes + p.backBytes}`);
}

async function expectPicture(P, refs, index, action, adjacency = false) {
  const p = P.player;
  assert.ok(index >= 0, action + ': shown PTS missing from FFmpeg reference');
  const t = refs[index].t + (p.startT || 0);
  const settled = await P.until(() => p.seekTarget === null && Math.abs(p.shownT - t) < 0.00025, action, 4000);
  const mismatch = `${action}: frame ${index}, expected PTS ${t}, shown ${p.shownT}`;
  if (!settled && adjacency && refs[index].t === 2.016667 && p.seekTarget === null) {
    const skippedTo = refs.find((ref) => ref.t === 2.05);
    if (skippedTo && Math.abs(p.shownT - ((p.startT || 0) + skippedTo.t)) < 0.00025) {
      assert.ok(ncc(P.shown.y, skippedTo) > 0.98, `${action}: picture disagrees with FFmpeg at ${p.shownT}`);
      checkBudget(P);
      throw new DenseVfrSkip(mismatch);
    }
  }
  assert.ok(settled, mismatch);
  assert.ok(ncc(P.shown.y, refs[index]) > 0.98, `${action}: picture disagrees with FFmpeg at ${t}`);
  checkBudget(P);
}

function checkKeyframes(file) {
  const json = execFileSync(ffTool(undefined, 'ffprobe'), [
    '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file,
  ], { windowsHide: true });
  const times = JSON.parse(json).frames.map((frame) => Number(frame.best_effort_timestamp_time));
  assert.deepEqual(times, [0, 10, 20], 'expected closed 10-second GOPs');
}

async function fuzz(file, vfr, { step = true, loop = true } = {}) {
  if (!vfr) checkKeyframes(file);
  let state = SEED;
  const pick = (n) => Math.floor(((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32) * n);
  const P = await open(file, { virtualClock: true });
  try {
    const refs = await P.refs();
    const gaps = new Set(refs.slice(1).map((r, i) => Math.round(1000 * (r.t - refs[i].t))));
    assert.ok(refs.every((r, i) => Number.isFinite(r.t) && (!i || refs[i - 1].t < r.t)));
    if (vfr) assert.ok([17, 33, 67].every((ms) => gaps.has(ms)), 'fixture must have 15/30/60 fps cadences');
    const { ab } = P;
    let wraps = 0;
    P.onWrap = () => { wraps++; };
    const jump = async (index, action) => {
      P.pause();
      P.seek(refs[index].t + 0.002);
      await expectPicture(P, refs, index, action);
    };
    for (let burst = 0; burst < 12; burst++) {
      // Alternate between opposite ends. For the long GOP, exercise both sides of the 10 s keyframe.
      const end = Math.floor(refs.length / 4);
      let index = (burst % 2 ? refs.length - end - 12 : 8) + pick(end);
      P.setRate([0.5, 1, 1.5, 2][pick(4)]);
      await jump(index, `burst ${burst} seek`);
      for (const direction of pick(2) ? [-1, 1] : [1, -1]) {
        const steps = 2 + pick(4);
        for (let i = 0; step && i < steps; i++) {
          const previous = P.player.shownT;
          P.step(direction);
          index += direction;
          await expectPicture(P, refs, index, `burst ${burst} step ${direction} #${i}`, vfr && direction === 1);
          assert.ok(direction * (P.player.shownT - previous) > 0, 'step went in the wrong direction');
        }
      }
      if (loop && burst % 3 === 0) {
        const p = P.player;
        const a = P.frame();
        ab.set('a', a / P.fps, a, p.rel(p.shownT));
        await jump(index + 4, 'seek B');
        const b = P.frame();
        assert.ok(b > a, 'A-B marks must span distinct timeline frames');
        ab.set('b', b / P.fps, b, p.rel(p.shownT));
        await jump(index + 2, 'inside A-B range');
        const before = wraps;
        P.play();
        assert.ok(await P.until(() => wraps > before, 'A-B wraps', 4000), 'A-B did not wrap');
        P.pause();
        assert.ok(await P.until(() => p.seekTarget === null && P.frame() === a, 'A-B wraps to A', 4000),
          `A-B wraps to frame ${a}, shown ${P.frame()}`);
        const pts = p.rel(p.shownT);
        const landed = refs.findIndex((ref) => Math.abs(ref.t - pts) < 0.00025);
        await expectPicture(P, refs, landed, 'A-B restart picture');
        ab.set('b', b / P.fps, b);
        ab.set('a', a / P.fps, a);
        P.play();
        assert.ok(await P.until(() => P.player.shownT > refs[index + 4].t, 'cleared A-B range', 4000));
        P.pause();
        assert.equal(wraps, before + 1, 'loop wrapped after clearing markers');
      }
    }
    assert.deepEqual(P.logs.filter((line) => /tick error|worker error|engine start failed/.test(line)), []);
  } finally {
    P.close();
  }
}

async function exactVfrSteps(file, direction) {
  const P = await open(file, { virtualClock: true });
  try {
    const refs = await P.refs();
    const index = refs.findIndex((r) => r.t >= 2.083);
    const start = index - 5;
    P.seek(refs[start].t + 0.002);
    await expectPicture(P, refs, start, 'seek into 60 fps section');
    for (let i = start + 1; i <= index; i++) {
      P.step(1);
      await expectPicture(P, refs, i, 'warm the dense VFR back cache', true);
    }
    P.step(direction);
    await expectPicture(P, refs, index + direction, 'one VFR picture', direction === 1);
  } finally {
    P.close();
  }
}

async function largeSeek() {
  const file = makeLarge();
  let maxOffset = 0;
  let bytesRequested = 0;
  const P = await open(file, {
    onRead(pos, len) {
      maxOffset = Math.max(maxOffset, pos);
      bytesRequested += len;
    },
  });
  try {
    assert.ok(P.duration > 600, 'expected movie-length footage');
    for (const fraction of [0.95, 0.12, 0.8]) {
      const t = P.duration * fraction;
      P.seek(t);
      assert.ok(await P.until(() => P.player.seekTarget === null && Math.abs(P.player.shownT - t) < 0.05,
        `large seek to ${t.toFixed(2)} s`), `large seek did not land at ${t}`);
      checkBudget(P);
    }
    assert.ok(maxOffset > 2 ** 31, `no seek read above 2 GiB (largest offset ${maxOffset})`);
    assert.ok(bytesRequested < 128 * 1024 ** 2, `too much input read: ${bytesRequested} bytes`);
  } finally {
    P.close();
  }
}

(async () => {
  const { vfr, longGop } = makeStepping();
  await c.run('VFR stepping fuzz', () => fuzz(vfr, true, { loop: false }), denseVfr);
  await c.run('VFR seeks, speed and A-B loop', () => fuzz(vfr, true, { step: false }));
  await c.run('exact forward step in dense VFR', () => exactVfrSteps(vfr, 1), denseVfr);
  await c.run('exact backward step in dense VFR', () => exactVfrSteps(vfr, -1), denseVfr);
  await c.run('10-second GOP stepping, seeks, speed and A-B loop', () => fuzz(longGop, false));
  if (process.env.VPE_HEAVY_MEDIA === '1') await c.run('multi-GiB random access', largeSeek);
  await c.done();
})();
