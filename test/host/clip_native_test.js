'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { inspectSource } = require('../../src/clipexport');

const ffmpeg = process.env.VPE_FFMPEG || 'ffmpeg';
const ffprobe = ffmpeg === 'ffmpeg' ? 'ffprobe' : path.join(path.dirname(ffmpeg), 'ffprobe' + path.extname(ffmpeg));

(async () => {
  const range = { a: 1, b: 1, early: 0 };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpe-clip-native-'));
  const file = path.join(dir, 'vfr.mp4');
  try {
    if (spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0) {
      execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2',
        '-vf', String.raw`select=not(eq(n\,25))`, '-fps_mode', 'passthrough', '-c:v', 'libx264', file],
      { windowsHide: true });
      const source = await inspectSource({ ffmpeg, ffprobe }, file, range);
      assert.equal(source.start, 0.96, 'a nominal 1.000 s mark would select the earlier source picture');
      assert.equal(source.end, 1.04, 'an accurate native seek to 1.000 s displays this following picture');
    }
    await assert.rejects(() => inspectSource({ ffmpeg, ffprobe }, file, { ...range, native: true }),
      /unavailable for ranges marked or mapped with native playback/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
