'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { open, checks, sleep, ROOT } = require('./harness');

const { run, done } = checks();
(async () => {
  await run('scrubbing holds presentation and audio, then seeks exactly once', async () => {
    const P = await open(path.join(ROOT, 'test/media/cases/s_h264.mp4'));
    try {
      const p = P.player;
      p.play();
      p.beginScrub();
      const before = { gen: p.gen, frame: p.currentFrame(), shown: P.uploads, t: p.now(), aid: p.audioId };
      const original = p.seekTime.bind(p);
      let exact = 0;
      p.seekTime = (...args) => { exact++; return original(...args); };
      await sleep(120);
      assert.equal(p.now(), before.t);
      assert.equal(p.currentFrame(), before.frame);
      assert.equal(P.uploads, before.shown);
      assert.equal(p.gen, before.gen);
      assert.equal(p.sources.size, 0);
      assert.equal(exact, 0);
      const target = Math.floor(p.n / 2);
      // The exact target lands while paused so it can be compared to the reference picture.
      p.pause();
      p.endScrub();
      p.commitScrubFrame(target);
      assert.equal(exact, 1);
      assert.equal(p.audioId, before.aid);
      await P.expectFrame(target);
      p.play();
      p.beginScrub();
      p.endScrub();
      assert.equal(p.playing, true, 'scrubbing preserves play intent');
    } finally { P.close(); }
  });
  await done();
})();
