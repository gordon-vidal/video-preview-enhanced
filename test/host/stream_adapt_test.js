'use strict';
// node test/host/stream_adapt_test.js: the Live transcode quality ladder (src/stream-adapt.js) alone: the settle
// window after a (re)start or seek, two bad windows to step down (skipping tiers the link cannot carry), four
// good ones to step up, and the resets, without ffmpeg or the webview.
const assert = require('assert');
const { LinkAdaptController, LINK_TIERS, LINK_SETTLE_MS } = require('../../src/stream-adapt');

const last = LINK_TIERS.length - 1;
const bad = (kbps, more = {}) => ({ kbps, videoKbps: 8000, mediaRate: 0.6, buffer: 0.05, starved: true, behind: false, readMs: 1500, hostWaitMs: 0, ...more });
const good = (kbps, more = {}) => ({ kbps, videoKbps: 2000, mediaRate: 1, buffer: 1, starved: false, behind: false, readMs: 800, hostWaitMs: 0, ...more });
// A controller already past its settle window; the clock advances 2 s per sample.
const make = () => {
  const c = new LinkAdaptController();
  c.noteFirstOutput(0);
  let t = LINK_SETTLE_MS;
  return { c, now: () => t, feed: (m, pcm = 0) => c.onSample(m, (t += 2000), pcm) };
};

{ // Fresh: tier 0, and no sample counts until ffmpeg's first output.
  const c = new LinkAdaptController();
  assert.deepStrictEqual(c.state(), { tier: 0, topKbps: 0, topPeak: 0, linkRun: 0, lastLinkSample: 0, settleAt: Infinity, noticed: [] });
  assert.strictEqual(c.onSample(bad(100), 1e9, 0), null);
  assert.strictEqual(c.state().lastLinkSample, 1e9, 'the sample time is noted even while settling');
}

{ // Settle window: samples before first output + LINK_SETTLE_MS are ignored; a seek opens a new window.
  const c = new LinkAdaptController();
  c.noteFirstOutput(1000);
  assert.strictEqual(c.state().settleAt, 1000 + LINK_SETTLE_MS);
  for (let t = 1000; t < 1000 + LINK_SETTLE_MS; t += 500) assert.strictEqual(c.onSample(bad(100), t, 0), null);
  assert.strictEqual(c.state().linkRun, 0);
  assert.ok(c.onSample(bad(100), 1000 + LINK_SETTLE_MS, 0), 'counts from the end of the window');
  assert.strictEqual(c.state().linkRun, 1);
  c.resetForSeek(9000);
  assert.strictEqual(c.state().linkRun, 0, 'a seek voids the run');
  assert.strictEqual(c.onSample(bad(100), 9000 + LINK_SETTLE_MS - 1, 0), null);
  assert.ok(c.onSample(bad(100), 9000 + LINK_SETTLE_MS, 0));
  c.resetForRestart();
  assert.strictEqual(c.state().settleAt, Infinity, 'a restart waits for the next first output');
  assert.strictEqual(c.state().linkRun, 0);
  c.noteFirstOutput(20000);
  c.waitForOutput();
  assert.strictEqual(c.state().settleAt, Infinity);
}

{ // Step down at linkRun >= 2: one bad window is not enough, the second steps.
  const { c, feed } = make();
  assert.strictEqual(feed(bad(5000)).change, 'none');
  assert.strictEqual(c.state().linkRun, 1);
  const d = feed(bad(5000));
  assert.strictEqual(d.change, 'tier');
  assert.ok(d.down);
  assert.strictEqual(c.tier, 1);
  assert.strictEqual(c.state().linkRun, 0, 'the run restarts after a step');
}

{ // A good window in between breaks the run; a gap between samples (paused player) does too.
  const { c, feed, now } = make();
  feed(bad(5000));
  feed(good(5000)); // tier 0: neither bad nor up
  assert.strictEqual(c.state().linkRun, 0);
  feed(bad(5000));
  assert.strictEqual(c.tier, 0);
  c.onSample(bad(5000), now() + 4000, 0); // 4 s after the last: run restarts at 1
  assert.strictEqual(c.tier, 0);
}

{ // Skips the tiers the link cannot carry (with the sound counted), straight to the floor.
  const { c, feed } = make();
  feed(bad(1500), 1536);
  const d = feed(bad(1500), 1536);
  assert.strictEqual(d.change, 'tier');
  assert.strictEqual(c.tier, last);
  // Without sound 2 Mb/s fits 480p (1.2 Mb/s) but not 720p (3 Mb/s).
  const b = make();
  b.feed(bad(2000)); b.feed(bad(2000));
  assert.strictEqual(b.c.tier, 2);
  // At the floor a due step down is reported as 'floor', and the tier stays.
  const f = make();
  f.feed(bad(100), 1536); f.feed(bad(100), 1536);
  assert.strictEqual(f.c.tier, last);
  f.feed(bad(100), 1536);
  assert.strictEqual(f.feed(bad(100), 1536).change, 'floor');
  assert.strictEqual(f.c.tier, last);
}

{ // Step up at linkRun <= -4: four good windows with 30% headroom over the next tier, not three.
  const { c, feed } = make();
  c.tier = 2;
  for (let i = 0; i < 3; i++) assert.strictEqual(feed(good(5000)).change, 'none');
  assert.strictEqual(c.state().linkRun, -3);
  assert.strictEqual(feed(good(5000)).change, 'tier');
  assert.strictEqual(c.tier, 1);
  assert.strictEqual(c.state().linkRun, 0);
  // Not enough headroom over 720p's 3000 kb/s (1.3 x 3000 = 3900): stays.
  for (let i = 0; i < 6; i++) feed(good(3800));
  assert.strictEqual(c.tier, 1);
  // A window with a low buffer is neither good nor bad and breaks the run.
  const r = make();
  r.c.tier = 2;
  for (let i = 0; i < 3; i++) r.feed(good(5000));
  r.feed(good(5000, { buffer: 0.1 }));
  r.feed(good(5000));
  assert.strictEqual(r.c.tier, 2);
  // Never above tier 0.
  const t0 = make();
  for (let i = 0; i < 8; i++) t0.feed(good(50000));
  assert.strictEqual(t0.c.tier, 0);
}

{ // A slow encoder (the host waited for ffmpeg most of the read) is not a slow link.
  const { c, feed } = make();
  for (let i = 0; i < 6; i++) assert.strictEqual(feed(bad(1500, { readMs: 1500, hostWaitMs: 1200 })).linkLimited, false);
  assert.strictEqual(c.tier, 0);
  assert.strictEqual(feed(bad(0, { readMs: 0 })).linkLimited, true, 'a read that outlasts the window is the link');
}

{ // The top rate (what the next tier up would need) is tracked at tier 0 only.
  const { c, feed } = make();
  assert.strictEqual(feed(good(9000, { videoKbps: 8000 })).nextCap, 8000);
  feed(good(9000, { videoKbps: 4000 }));
  const s = c.state();
  assert.strictEqual(s.topKbps, 0.75 * 8000 + 0.25 * 4000);
  assert.strictEqual(s.topPeak, 0.9 * 8000);
  feed(bad(5000)); feed(bad(5000)); // down to tier 1 (the link carries 720p)
  assert.strictEqual(c.tier, 1);
  const before = c.state();
  assert.strictEqual(feed(good(500, { videoKbps: 1 })).nextCap, Math.max(3000, before.topKbps, before.topPeak), 'tier 1: next is the uncapped rate');
  assert.strictEqual(c.state().topKbps, before.topKbps, 'not updated below the top tier');
}

{ // Notices once per kind.
  const { c } = make();
  assert.strictEqual(c.firstNotice('quality'), true);
  assert.strictEqual(c.firstNotice('quality'), false);
  assert.strictEqual(c.firstNotice('slow'), true);
  assert.deepStrictEqual(c.state().noticed, ['quality', 'slow']);
}

console.log('stream_adapt_test: ok');
