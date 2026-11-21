'use strict';
// node test/host/remote_ladder_test.js: the remote stream's quality ladder (RemoteStream.adapt) from
// mocked webview link samples, without ffmpeg (review 7): sound (raw PCM) counts against the link,
// windows where the host mostly waited for ffmpeg don't count, the windows after a (re)start don't
// count, the lowest tier is a floor with a notice (never a fallback), and recovery needs four good windows.
const assert = require('assert');
const { RemoteStream, LINK_TIERS, PCM_KBPS } = require('../../src/remotestream');

function stream({ audio = true, audioEncoder = null } = {}) {
  const posts = [];
  const fails = [];
  const rs = new RemoteStream({
    tools: {}, audioEncoder, file: 'x.mkv', post: (m) => posts.push(m), log: () => {}, onFail: (e) => fails.push(e),
    probed: { duration: 100, video: { codec: 'hevc', width: 3840, height: 2160, fps: 30 }, audio: audio ? { codec: 'aac' } : null },
  });
  rs.restarts = 0;
  rs.restartVideo = () => { rs.restarts++; };
  rs.proc = {}; // ffmpeg "running", so adapt doesn't return early
  rs.settleAt = 0;
  rs.sizeVideo();
  return { rs, posts, fails };
}

// A 2 s window: what the link delivered, and how starved the picture buffer was.
const bad = (kbps, more = {}) => ({ type: 'remoteLink', gen: 0, kbps, videoKbps: 8000, mediaRate: 0.6, buffer: 0.05, starved: true, behind: false, readMs: 1500, hostWaitMs: 0, ...more });
const good = (kbps, more = {}) => ({ type: 'remoteLink', gen: 0, kbps, videoKbps: 2000, mediaRate: 1, buffer: 1, starved: false, behind: false, readMs: 800, hostWaitMs: 0, ...more });
const notices = (posts) => posts.filter((m) => m.type === 'remoteNotice');

const last = LINK_TIERS.length - 1;
assert.ok(PCM_KBPS === 1536, `PCM ${PCM_KBPS}`);

{ // #1: with s16 sound on a 1.5 Mb/s link no tier fits: go straight to the lowest, say so once, never fail.
  const { rs, posts, fails } = stream();
  rs.adapt(bad(1500));
  assert.strictEqual(rs.tier, 0, 'one bad window is not enough');
  rs.adapt(bad(1500));
  assert.strictEqual(rs.tier, last, 'skips tiers that cannot fit with the PCM');
  assert.strictEqual(rs.restarts, 1);
  assert.strictEqual(rs.h, 360);
  for (let i = 0; i < 10; i++) rs.adapt(bad(1500));
  assert.strictEqual(rs.tier, last);
  assert.strictEqual(rs.restarts, 1, 'no restarts at the floor');
  assert.deepStrictEqual(fails, [], 'link speed never fails over to the built-in decoder');
  const n = notices(posts);
  assert.strictEqual(n.length, 1, 'one notice');
  assert.strictEqual(n[0].kind, 'slow');
  assert.match(n[0].text, /sound/);
}

{ // Without sound, 2 Mb/s fits 480p (1.2 Mb/s) but not 720p (3 Mb/s); the notice says quality went down.
  const { rs, posts } = stream({ audio: false });
  rs.adapt(bad(2000));
  rs.adapt(bad(2000));
  assert.strictEqual(rs.tier, 2);
  assert.strictEqual(rs.h, 480);
  assert.deepStrictEqual(notices(posts).map((m) => m.kind), ['quality']);
  // Recovery: four good windows with 30% headroom over the next tier (720p, 3 Mb/s).
  for (let i = 0; i < 3; i++) rs.adapt(good(5000));
  assert.strictEqual(rs.tier, 2, 'three good windows are not enough');
  rs.adapt(good(5000));
  assert.strictEqual(rs.tier, 1);
  assert.strictEqual(rs.h, 720);
  // Not enough headroom: stays.
  for (let i = 0; i < 6; i++) rs.adapt(good(1.2 * 8000));
  assert.strictEqual(rs.tier, 1);
  // A bad window breaks a run of good ones.
  const { rs: r2 } = stream({ audio: false });
  r2.tier = 2; r2.sizeVideo();
  for (let i = 0; i < 3; i++) r2.adapt(good(5000));
  r2.adapt(bad(5000, { starved: false, mediaRate: 1, buffer: 0.1 })); // not good (buffer low), not bad
  r2.adapt(good(5000));
  assert.strictEqual(r2.tier, 2);
}

{ // #2: a slow remote encoder (the host waited for ffmpeg most of the read) is not a slow link.
  const { rs, posts } = stream({ audio: false });
  for (let i = 0; i < 6; i++) rs.adapt(bad(1500, { readMs: 1500, hostWaitMs: 1200 }));
  assert.strictEqual(rs.tier, 0);
  assert.strictEqual(rs.restarts, 0);
  assert.deepStrictEqual(notices(posts), []);
}

{ // #4: windows right after ffmpeg (re)started or a seek don't count.
  const { rs } = stream({ audio: false });
  rs.settleAt = Date.now() + 60000;
  for (let i = 0; i < 6; i++) rs.adapt(bad(500));
  assert.strictEqual(rs.tier, 0);
  // After a step, restartVideo() clears settleAt until ffmpeg's first output (checked in the source).
  const src = require('fs').readFileSync(require.resolve('../../src/stream'), 'utf8');
  const restart = src.slice(src.indexOf('  restartVideo() {'), src.indexOf('  restartVideo() {') + 1200);
  assert.match(restart, /this\.settleAt = Infinity/);
  assert.match(src, /this\.settleAt = Date\.now\(\) \+ LINK_SETTLE_MS; \/\/ the buffer refills after any seek/);
}

{ // A read that outlasts the window (nothing delivered, kbps 0) is a link that slow: straight to the floor.
  const { rs, fails } = stream({ audio: false });
  rs.adapt(bad(0, { readMs: 0 }));
  rs.adapt(bad(0, { readMs: 0 }));
  assert.strictEqual(rs.tier, last);
  assert.deepStrictEqual(fails, []);
}

{ // Stale samples (an older seek generation) are ignored.
  const { rs } = stream({ audio: false });
  rs.gen = 3;
  for (let i = 0; i < 4; i++) rs.adapt(bad(500, { gen: 2 }));
  assert.strictEqual(rs.tier, 0);
}


{ // Opus makes 360p with sound fit below 0.6 Mb/s; s16 would require nearly 2 Mb/s.
  const { rs, posts } = stream({ audioEncoder: 'libopus' });
  rs.adapt(bad(650)); rs.adapt(bad(650));
  assert.strictEqual(rs.tier, last);
  assert.deepStrictEqual(notices(posts).map((m) => m.kind), ['quality']);
  const { rs: fit, posts: fitPosts } = stream();
  fit.fps = 30;
  fit.setView({ w: 960, h: 540 });
  fit.sizeVideo();
  assert.strictEqual(fit.h, 540);
  let standbyKilled = false;
  fit.standby = { kill: () => { standbyKilled = true; } };
  fit.setView({ w: 1920, h: 1080 });
  assert.strictEqual(standbyKilled, true, 'a loop standby at the old size cannot be adopted');
  assert.strictEqual(fitPosts.at(-1).type, 'refresh', 'enlargement asks the page to refresh immediately');
  fit.sizeVideo();
  assert.strictEqual(fit.h, 1080);
  fit.setView({ w: 640, h: 360 });
  assert.strictEqual(fit.h, 1080, 'shrinks only at next seek');
  fit.sizeVideo();
  assert.strictEqual(fit.h, 540);
  fit.setFit(false);
  fit.sizeVideo();
  assert.strictEqual(fit.h, 1080);
}

console.log('remote ladder: ok');
