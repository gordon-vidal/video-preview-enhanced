'use strict';
// node test/host/native_loop_test.js: at the end of the file, native ffmpeg (src/native.js)
// starts the ffmpeg for a loop from the start in advance; a seek to 0 takes it (no start-up),
// its frames are the start's again; a seek elsewhere or dispose ends it. Needs ffmpeg on PATH.
const assert = require('assert');
const path = require('path');
const ff = require('../../src/ffmpeg');
const { NativeDecoder } = require('../../src/native');

(async () => {
  const tools = await ff.locateTools('', '');
  if (!tools) { console.log('native loop: skipped (no ffmpeg on PATH)'); return; }
  const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'h264_8_1080.mkv');
  const pr = await ff.probe(tools, clip);
  const logs = [];
  const frames = [];
  let eof = null;
  const nd = new NativeDecoder({
    tools, file: clip, probed: pr, method: 'none', maxHeight: 360, log: (m) => logs.push(m),
    post: (m) => { if (m.type === 'batch' && m.eof && eof) eof(); },
    postRaw: (m) => { if (m.type === 'ndv') { frames.push(m); nd.handle({ type: 'more', gen: m.gen }); } },
  });
  const ended = () => new Promise((r) => { eof = r; });
  let done = ended();
  await nd.handle({ type: 'open' });
  nd.handle({ type: 'more', gen: 0 });
  await done;
  const n = frames.length;
  assert.ok(n >= 20, `${n} frames`);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(nd.standby && nd.standby.exitCode === null, 'an ffmpeg for the start waits at the end');
  frames.length = 0;
  done = ended();
  nd.handle({ type: 'seek', gen: 1, t: 0 });
  nd.handle({ type: 'more', gen: 1 });
  await done;
  assert.ok(logs.some((l) => /from 0\.000 s.*ffmpeg prepared at the end/.test(l)), logs.join('\n'));
  assert.strictEqual(frames.length, n, 'the loop has every frame again');
  assert.strictEqual(frames[0].t, 0);
  // A seek elsewhere drops the waiting one.
  await new Promise((r) => setTimeout(r, 300));
  const sb2 = nd.standby;
  assert.ok(sb2, 'prepared again at the second end');
  nd.handle({ type: 'seek', gen: 2, t: 0.5 });
  assert.ok(!nd.standby && sb2.killed, 'a seek elsewhere kills it');
  nd.dispose();
  await new Promise((r) => setTimeout(r, 300));
  nd.prepareLoop();
  assert.ok(!nd.standby, 'nothing after dispose');
  console.log(`native loop: ok (${n} frames twice)`);
})().catch((e) => { console.error(e); process.exit(1); });
