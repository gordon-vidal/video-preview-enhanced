'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { inspectSource, makeClip } = require('../../src/clipexport');

const ffmpeg = process.env.VPE_FFMPEG || 'ffmpeg';
const ffprobe = ffmpeg === 'ffmpeg' ? 'ffprobe' : path.join(path.dirname(ffmpeg), 'ffprobe' + path.extname(ffmpeg));
const tools = { ffmpeg, ffprobe };
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-xerror', ...args], { encoding: 'utf8', windowsHide: true });
const hashes = (file) => run(['-i', file, '-an', '-fps_mode', 'passthrough', '-f', 'framemd5', '-']).split(/\r?\n/).filter((s) => /^\d+,/.test(s)).map((s) => s.split(',').at(-1));

(async () => {
  if (spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status !== 0) {
    console.log('open GOP: ffmpeg unavailable, skipping generated media');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpe-clip-gop-'));
  try {
    const file = path.join(dir, 'open-gop.mp4');
    run(['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=8', '-c:v', 'libx264', '-x264-params',
      'open-gop=1:keyint=50:min-keyint=50:scenecut=0:bframes=3:b-pyramid=normal:ref=5', file]);
    const sourceHashes = hashes(file);
    for (const a of [2.36, 4.12, 6.64]) {
      const first = Math.round(a * 25);
      const output = path.join(dir, `cut-${first}.mp4`);
      const source = await inspectSource(tools, file, { a, b: a + 0.4, early: 0 });
      await makeClip(tools, file, output, source, { exact: true });
      assert.deepEqual(hashes(output), sourceHashes.slice(first, first + 11), `decoded pictures from ${a}s`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
