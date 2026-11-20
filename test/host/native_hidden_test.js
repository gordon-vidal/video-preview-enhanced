'use strict';
// node test/host/native_hidden_test.js: a hidden tab stops native ffmpeg (src/native.js) and the remote
// stream (src/remotestream.js): the decoding process, the standby for a loop and the frames waiting in
// the host go; the page's re-seek on show starts ffmpeg again and frames flow. Needs ffmpeg on PATH.
const assert = require('assert');
const path = require('path');
const ff = require('../../src/ffmpeg');
const { NativeDecoder } = require('../../src/native');
const { RemoteStream } = require('../../src/remotestream');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(ready, why, ms = 10000) {
  const end = Date.now() + ms;
  while (!ready()) {
    assert.ok(Date.now() < end, why);
    await sleep(20);
  }
}

async function native(tools, clip, pr) {
  const logs = [];
  const frames = [];
  const nd = new NativeDecoder({
    tools, file: clip, probed: pr, method: 'none', maxHeight: 360, maxQueued: 6, log: (m) => logs.push(m),
    post: () => {}, postRaw: (m) => { if (m.type === 'ndv') frames.push(m); },
  });
  await nd.handle({ type: 'open' });
  nd.handle({ type: 'more', gen: 0 });
  await until(() => frames.length >= 8, 'frames while shown');
  // Paused: the page stops asking; ffmpeg fills the host queue and blocks.
  await until(() => nd.frames.length >= 6, 'the host queue fills while paused');
  const proc = nd.proc;
  assert.ok(proc && proc.exitCode === null, 'ffmpeg runs while shown');
  nd.handle({ type: 'hidden', on: true });
  assert.strictEqual(nd.proc, null, 'no ffmpeg while hidden');
  assert.strictEqual(nd.frames.length, 0, 'no frames kept in the host while hidden');
  assert.strictEqual(nd.standby, null, 'no standby while hidden');
  await until(() => proc.exitCode !== null || proc.signalCode, 'the killed ffmpeg exits');
  assert.ok(logs.some((l) => /tab hidden, ffmpeg stopped/.test(l)), logs.join('\n'));
  // Requests while hidden start nothing.
  nd.handle({ type: 'more', gen: 0 });
  await sleep(200);
  assert.strictEqual(nd.proc, null, 'a request while hidden starts no ffmpeg');
  // Shown: the page re-seeks to the frame it showed.
  nd.handle({ type: 'hidden', on: false });
  const n = frames.length;
  nd.handle({ type: 'seek', gen: 1, t: 0.5 });
  nd.handle({ type: 'more', gen: 1 });
  await until(() => frames.length > n + 3, 'frames again after the re-seek');
  const first = frames.slice(n).find((f) => f.gen === 1);
  assert.ok(first && Math.abs(first.t - 0.5) < 0.05, `the re-seek starts at 0.5 s (${first && first.t})`);
  nd.dispose();
}

async function remote(tools, clip, pr) {
  const logs = [];
  const st = { gen: 0, video: 0 };
  const rs = new RemoteStream({
    tools, file: clip, probed: pr, maxHeight: 180, log: (m) => logs.push(m), onFail: (e) => { throw new Error(e); },
    post: (m) => {
      if (m.type === 'seeked' && m.gen === st.gen) setImmediate(() => rs.handle({ type: 'more', gen: st.gen, limit: 1 << 20 }));
      if (m.type === 'batch' && m.gen === st.gen) st.video += m.video.length;
    },
  });
  await rs.handle({ type: 'open' });
  rs.handle({ type: 'more', gen: 0, limit: 1 << 20 });
  await until(() => st.video > 0, 'remote packets while shown');
  const procs = [rs.proc, rs.audioProc].filter(Boolean);
  assert.ok(procs.length, 'remote ffmpeg runs while shown');
  rs.handle({ type: 'hidden', on: true });
  assert.ok(!rs.proc && !rs.audioProc && !rs.standby, 'no remote ffmpeg while hidden');
  assert.strictEqual(rs.vAll.length, 0, 'nothing kept while hidden');
  await until(() => procs.every((p) => p.exitCode !== null || p.signalCode), 'the remote processes exit');
  st.gen = 1;
  const n = st.video;
  rs.handle({ type: 'seek', gen: 1, t: 0.5 });
  await until(() => st.video > n, 'remote packets again after the re-seek');
  rs.dispose();
}

(async () => {
  const tools = await ff.locateTools('', '');
  if (!tools) { console.log('native hidden: skipped (no ffmpeg on PATH)'); return; }
  const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'h264_8_1080.mkv');
  const pr = await ff.probe(tools, clip);
  await native(tools, clip, pr);
  await remote(tools, clip, pr);
  console.log('native hidden: ok (native and remote stream stop while hidden, resume on the re-seek)');
})().catch((e) => { console.error(e); process.exit(1); });
