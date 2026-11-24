'use strict';
// node test/host/stream_adapt_test.js: the Live transcode quality ladder (src/stream-adapt.js) alone: the settle
// window after a (re)start or seek, two bad windows to step down (skipping tiers the link cannot carry), four
// good ones to step up, and the resets, without ffmpeg or the webview.
const assert = require('assert');
const { LinkAdaptController, LinkSessionMemory, LINK_TIERS, LINK_SETTLE_MS } = require('../../src/stream-adapt');

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
  assert.deepStrictEqual(c.state(), {
    tier: 0, topKbps: 0, topPeak: 0, fastKbps: 0, slowKbps: 0,
    linkRun: 0, upRun: 4, lastUpgradeAt: -Infinity,
    lastLinkSample: 0, settleAt: Infinity, noticed: [],
  });
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

{ // Step down at linkRun >= 2: one mild bad window is not enough, the second steps to intermediate 1080p @ 5500.
  const { c, feed } = make();
  assert.deepStrictEqual(LINK_TIERS[1], { height: 1080, kbps: 5500 }, 'intermediate 1080p cap tier before 720p');
  assert.strictEqual(feed(bad(6000)).change, 'none');
  assert.strictEqual(c.state().linkRun, 1);
  const d = feed(bad(6000));
  assert.strictEqual(d.change, 'tier');
  assert.ok(d.down);
  assert.strictEqual(d.panic, false);
  assert.strictEqual(c.tier, 1);
  assert.strictEqual(c.state().linkRun, 0, 'the run restarts after a step');
}

{ // A good window in between breaks the run; a gap between samples (paused player) does too.
  const { c, feed, now } = make();
  feed(bad(6000));
  feed(good(6000)); // tier 0: neither bad nor up
  assert.strictEqual(c.state().linkRun, 0);
  feed(bad(6000));
  assert.strictEqual(c.tier, 0);
  c.onSample(bad(6000), now() + 4000, 0); // 4 s after the last: run restarts at 1
  assert.strictEqual(c.tier, 0);
}

{ // Skips the tiers the link cannot carry (with the sound counted), straight to the floor.
  const { c, feed } = make();
  feed(bad(1500), 1536);
  const d = feed(bad(1500), 1536);
  assert.strictEqual(d.change, 'tier');
  assert.strictEqual(c.tier, last);
  // Without sound 4 Mb/s fits 720p (3 Mb/s) but not 1080p (5.5 Mb/s).
  const m = make();
  m.feed(bad(4000)); m.feed(bad(4000));
  assert.strictEqual(m.c.tier, 2);
  // Without sound 2 Mb/s fits 480p (1.2 Mb/s) but not 720p (3 Mb/s).
  const b = make();
  b.feed(bad(2000)); b.feed(bad(2000));
  assert.strictEqual(b.c.tier, 3);
  // At the floor a due step down is reported as 'floor', and the tier stays.
  const f = make();
  f.feed(bad(100), 1536); f.feed(bad(100), 1536);
  assert.strictEqual(f.c.tier, last);
  f.feed(bad(100), 1536);
  assert.strictEqual(f.feed(bad(100), 1536).change, 'floor');
  assert.strictEqual(f.c.tier, last);
}

{ // 1-window panic step-down on severe starvation (buffer < 0.1 s and mediaRate < 0.5).
  const { c, feed } = make();
  const d = feed(bad(4000, { buffer: 0.05, mediaRate: 0.3 }));
  assert.strictEqual(d.panic, true);
  assert.strictEqual(d.change, 'tier');
  assert.strictEqual(c.tier, 2, '4 Mb/s skips 1080p (5.5 Mb/s) straight to 720p on panic');
  // Boundary: mediaRate === 0.5 or buffer === 0.1 is NOT a panic (waits for 2 windows).
  const b1 = make();
  const d1 = b1.feed(bad(4000, { buffer: 0.05, mediaRate: 0.5 }));
  assert.strictEqual(d1.panic, false);
  assert.strictEqual(d1.change, 'none');
  const b2 = make();
  const d2 = b2.feed(bad(4000, { buffer: 0.1, mediaRate: 0.2 }));
  assert.strictEqual(d2.panic, false);
  assert.strictEqual(d2.change, 'none');
  // Slow encoder (not link-limited) never triggers panic step-down.
  const enc = make();
  const de = enc.feed(bad(500, { buffer: 0.01, mediaRate: 0.1, readMs: 1500, hostWaitMs: 1200 }));
  assert.strictEqual(de.linkLimited, false);
  assert.strictEqual(de.panic, false);
  assert.strictEqual(de.change, 'none');
  assert.strictEqual(enc.c.tier, 0);
}

{ // Step up at linkRun <= -4: four good windows with 30% headroom and at least 0.35 s buffered.
  const { c, feed } = make();
  c.tier = 3; // 480p -> next is 720p (3000 kb/s, needs > 3900)
  for (let i = 0; i < 3; i++) assert.strictEqual(feed(good(5000)).change, 'none');
  assert.strictEqual(c.state().linkRun, -3);
  assert.strictEqual(feed(good(5000)).change, 'tier');
  assert.strictEqual(c.tier, 2);
  assert.strictEqual(c.state().linkRun, 0);
  // Not enough headroom over 1080p's 5500 kb/s (1.3 x 5500 = 7150): stays.
  for (let i = 0; i < 6; i++) feed(good(7000));
  assert.strictEqual(c.tier, 2);
  // Upgrade buffer guard (0.35 s, safely below WebCodecs' ~0.5 s live buffer): 0.3 s breaks the run.
  const r = make();
  r.c.tier = 3;
  for (let i = 0; i < 3; i++) r.feed(good(5000));
  r.feed(good(5000, { buffer: 0.3 }));
  assert.strictEqual(r.c.state().linkRun, 0, 'buffer < 0.35 s resets upgrade run');
  r.feed(good(5000, { buffer: 0.35 }));
  assert.strictEqual(r.c.state().linkRun, -1, 'buffer === 0.35 s counts toward upgrade');
  assert.strictEqual(r.c.tier, 3);
  // Never above tier 0.
  const t0 = make();
  for (let i = 0; i < 8; i++) t0.feed(good(50000));
  assert.strictEqual(t0.c.tier, 0);
}

{ // Dual-EWMA smoothing: a brief throughput burst after a slow link does not trigger premature upgrade.
  const { c, feed } = make();
  c.tier = 3; // 480p -> next is 720p (needs > 3900)
  feed(good(2000)); // seed fast=2000, slow=2000
  const burst = feed(good(7000)); // fast=4500, slow=3750 -> min(fast, slow) = 3750 <= 3900
  assert.strictEqual(burst.fastKbps, 4500);
  assert.strictEqual(burst.slowKbps, 3750);
  assert.strictEqual(c.state().linkRun, 0, 'slow EWMA blocks single-window burst from starting upgrade run');
  // Sustained high throughput lifts slow EWMA above 3900 and upgrades after 4 qualifying windows.
  for (let i = 0; i < 3; i++) assert.strictEqual(feed(good(10000)).change, 'none');
  assert.strictEqual(feed(good(10000)).change, 'tier');
  assert.strictEqual(c.tier, 2);
}

{ // Exponential oscillation backoff includes drops late in the 45 s window.
  const { c, feed } = make();
  c.tier = 3;
  for (let i = 0; i < 4; i++) feed(good(6000));
  assert.strictEqual(c.tier, 2, 'first upgrade uses UP_RUN=4');
  assert.strictEqual(c.state().upRun, 4);
  for (let i = 0; i < 20; i++) feed(good(6000));
  feed(bad(2000, { buffer: 0.05, mediaRate: 0.3 }));
  assert.strictEqual(c.tier, 3);
  assert.strictEqual(c.state().upRun, 8, 'oscillation doubles upRun to 8');
  for (let i = 0; i < 13; i++) assert.strictEqual(feed(good(8000)).change, 'none');
  assert.strictEqual(c.state().linkRun, 0, 'good windows during the cooldown do not count');
  // Needs 8 qualifying good windows after the cooldown.
  for (let i = 0; i < 7; i++) {
    assert.strictEqual(feed(good(8000)).change, 'none', `stays at tier 3 before 8 good windows (step ${i + 1})`);
  }
  assert.strictEqual(c.state().linkRun, -7, '7 qualifying windows still not enough when upRun=8');
  assert.strictEqual(c.tier, 3);
  assert.strictEqual(feed(good(8000)).change, 'tier', '8th qualifying window upgrades');
  assert.strictEqual(c.tier, 2, '8th qualifying window upgrades');
  // Drops again: upRun doubles to 16 (MAX_UP_RUN).
  feed(bad(2000, { buffer: 0.05, mediaRate: 0.3 }));
  assert.strictEqual(c.tier, 3);
  assert.strictEqual(c.state().upRun, 16, 'second oscillation doubles upRun to 16');
  // Staying stable past 45 s after an upgrade resets upRun back to 4.
  const s = make();
  s.c.tier = 3;
  for (let i = 0; i < 4; i++) s.feed(good(6000));
  s.feed(bad(2000, { buffer: 0.05, mediaRate: 0.3 }));
  assert.strictEqual(s.c.state().upRun, 8);
  for (let i = 0; i < 21; i++) s.feed(good(6000));
  assert.strictEqual(s.c.tier, 2);
  for (let i = 0; i < 23; i++) s.feed(good(6000));
  assert.strictEqual(s.c.state().upRun, 4, 'stable playback past 45 s resets upRun to 4');
}

{ // Session estimates expire even if another video opens just before expiry.
  const memory = new LinkSessionMemory();
  const timestamp = 1000;
  const snapshot = { fastKbps: 4000, slowKbps: 4200, tier: 2, timestamp };
  memory.update(snapshot);
  assert.strictEqual(new LinkSessionMemory().read(timestamp), undefined, 'another window starts fresh');
  assert.strictEqual(memory.read(timestamp + 599999), snapshot);
  assert.strictEqual(memory.read(timestamp + 600000), undefined);
  assert.strictEqual(new LinkAdaptController(memory.read(timestamp + 600001)).tier, 0);
}

{ // Flaky SSH: a 1.5 s blackout every 8 s drains a deep buffer without starving playback.
  const { c, feed } = make();
  feed(bad(4000, { mediaRate: 0.3 }));
  assert.strictEqual(c.tier, 2);
  // Healthy bursts can look fast enough to upgrade. A buffered blackout window
  // with no completed reads carries no new throughput information.
  for (let seconds = 2; seconds <= 40; seconds += 2) {
    const sample = seconds % 8
      ? good(9000, { buffer: 3.25 })
      : good(0, { readMs: 0, mediaRate: 0, buffer: 1.75 });
    assert.strictEqual(feed(sample).change, 'none', `720p holds at +${seconds} s`);
  }
  assert.strictEqual(c.tier, 2);
  for (let i = 0; i < 3; i++) assert.strictEqual(feed(good(9000, { buffer: 3.25 })).change, 'none');
  assert.strictEqual(feed(good(9000, { buffer: 3.25 })).change, 'tier', 'sustained headroom can still upgrade');
}

{ // A filled buffer can leave a window without completed reads. It is not a zero-bandwidth estimate.
  const { feed } = make();
  feed(good(4000));
  const d = feed(good(0, { readMs: 0, mediaRate: 0, buffer: 3 }));
  assert.strictEqual(d.fastKbps, 4000);
  assert.strictEqual(d.slowKbps, 4000);
}

{ // A slow encoder (the host waited for ffmpeg most of the read) is not a slow link.
  const { c, feed } = make();
  for (let i = 0; i < 6; i++) assert.strictEqual(feed(bad(1500, { readMs: 1500, hostWaitMs: 1200 })).linkLimited, false);
  assert.strictEqual(c.tier, 0);
  assert.strictEqual(c.state().fastKbps, 0, 'encoder-limited windows do not pollute link EWMA');
  assert.strictEqual(feed(bad(0, { readMs: 0 })).linkLimited, true, 'a read that outlasts the window is the link');
}

{ // The top rate (what the next tier up would need) is tracked at tier 0 only.
  const { c, feed } = make();
  assert.strictEqual(feed(good(9000, { videoKbps: 8000 })).nextCap, 8000);
  feed(good(9000, { videoKbps: 4000 }));
  const s = c.state();
  assert.strictEqual(s.topKbps, 0.75 * 8000 + 0.25 * 4000);
  assert.strictEqual(s.topPeak, 0.9 * 8000);
  feed(bad(6000)); feed(bad(6000)); // down to tier 1 (1080p @ 5500)
  assert.strictEqual(c.tier, 1);
  const before = c.state();
  assert.strictEqual(feed(good(500, { videoKbps: 1 })).nextCap, Math.max(5500, before.topKbps, before.topPeak), 'tier 1: next is the uncapped rate');
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
