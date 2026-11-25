'use strict';
// node test/host/native_rotation_test.js [rotated.mp4]   (default: test/media/cases/rotated.mp4, made with ffmpeg when missing)
// The native decoder must emit frames as stored (not autorotated then squashed
// back into the stored size); the webview rotates them like the built-in path.
// Compares NativeDecoder's first frame with ffmpeg's plain -noautorotate decode.
const assert = require('assert');
const { execFileSync } = require('child_process');
const ff = require('../../src/ffmpeg');
const { NativeDecoder } = require('../../src/native');
const { rotationOf } = require('../../src/rotation');

(async () => {
  const file = process.argv[2] || require('../media/make_cases_media').make('rotated.mp4');
  assert.ok(file, 'a rotated test clip (ffmpeg on PATH makes one)');
  const tools = await ff.locateTools('', '');
  assert.ok(tools, 'ffmpeg on PATH');
  const rot = await rotationOf(file);
  assert.ok(rot === 90 || rot === 270, `test file is rotated (got ${rot})`);
  const frame = await new Promise((resolve, reject) => {
    const nd = new NativeDecoder({
      tools, file, maxHeight: 4320, method: 'none', log: () => {},
      post: (m) => { if (m.type === 'streams') nd.handle({ type: 'more', gen: 0 }); },
      postRaw: (m) => { if (m.type === 'ndv') { nd.dispose(); resolve(m); } },
    });
    nd.handle({ type: 'open' }).catch(reject);
  });
  const pr = await ff.probe(tools, file);
  assert.strictEqual(frame.w, pr.video.width);
  assert.strictEqual(frame.h, pr.video.height);
  const ref = execFileSync(tools.ffmpeg, ['-v', 'error', '-noautorotate', '-i', file, '-frames:v', '1',
    '-vf', `scale=${frame.w}:${frame.h}:flags=bilinear,format=yuv420p`, '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 28 });
  let diff = 0;
  for (let i = 0; i < ref.length; i++) diff += Math.abs(ref[i] - frame.data[i]);
  const mad = diff / ref.length;
  console.log(`native ${frame.w}x${frame.h}, stored ${pr.video.width}x${pr.video.height}, rotation ${rot}, mean abs diff vs unrotated decode ${mad.toFixed(3)}`);
  assert.ok(mad < 1, 'frame matches the unrotated picture');
  console.log('native rotation: ok');
})().catch((e) => { console.error(e); process.exit(1); });
