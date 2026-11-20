'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ff = require('../../src/ffmpeg');
const { sniffNativeMp4 } = require('../../src/rotation');
const { sniffNativeMatroska } = require('../../src/sniff-matroska');

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  assert.ok(tools, 'ffmpeg on PATH');
  const out = path.join(__dirname, '..', 'vscode', 'out');
  fs.mkdirSync(out, { recursive: true });
  const dir = fs.mkdtempSync(path.join(out, 'native-sniff-'));
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt'];
  const hevc = ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-pix_fmt'];
  const vp9 = ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt'];
  const av1 = ['-c:v', 'libaom-av1', '-cpu-used', '8', '-pix_fmt'];
  const prores = ['-c:v', 'prores_ks', '-profile:v'];
  const vfr = ['-vf', 'select=not(eq(mod(n\\,5)\\,2))', '-fps_mode', 'vfr'];
  const audio = ['-f', 'lavfi', '-i', 'sine=duration=1', '-map', '1:a', '-map', '0:v', '-c:a', 'aac'];
  const cases = [
    ['hevc.mp4', [...hevc, 'yuv420p10le'], 'yuv420p10le'],
    ['h264.mp4', [...h264, 'yuv420p10le'], 'yuv420p10le'],
    ['h264.mov', [...h264, 'yuv422p', '-bf', '2', '-movflags', 'faststart'], 'yuv422p'],
    ['h264-422-10.mp4', [...h264, 'yuv422p10le'], 'yuv422p10le'],
    ['vp9.mp4', [...vp9, 'yuv420p10le'], 'yuv420p10le'],
    ['av1.mp4', [...av1, 'yuv420p10le'], 'yuv420p10le'],
    ['prores.mov', [...prores, '0'], 'yuv422p10le'],
    ['hevc.mkv', [...audio, ...hevc, 'yuv420p10le'], 'yuv420p10le'],
    ['vp9.webm', [...vp9, 'yuv420p'], 'yuv420p'],
    ['vp9-10.webm', [...vp9, 'yuv420p10le'], 'yuv420p10le'],
    ['av1.webm', [...av1, 'yuv420p'], 'yuv420p'],
    ['fragmented.mp4', [...hevc, 'yuv420p', '-movflags', 'frag_keyframe+empty_moov'], null],
    ['two.mp4', ['-map', '0:v', '-map', '0:v', ...h264, 'yuv420p10le'], null],
    ['two.mkv', ['-map', '0:v', '-map', '0:v', ...vp9, 'yuv420p'], null],
    ['vfr.mp4', [...vfr, ...h264, 'yuv420p10le'], null],
    ['vfr.webm', [...vfr, ...vp9, 'yuv420p'], null],
    ['late-vfr.webm', ['-vf', 'select=not(eq(n\\,24))', '-fps_mode', 'vfr', ...vp9, 'yuv420p'], null],
    ['ordinary-h264.mp4', [...h264, 'yuv420p'], null],
    ['h264-444.mp4', [...h264, 'yuv444p'], null],
    ['prores-444.mov', [...prores, '4', '-pix_fmt', 'yuv444p10le'], null],
    ['vp9-444.webm', [...vp9, 'yuv444p'], null],
    ['av1-444.mp4', [...av1, 'yuv444p'], null],
    ['live.webm', [...vp9, 'yuv420p', '-live', '1'], null],
  ];
  let checks = 0;
  try {
    for (const [name, options, pixFmt] of cases) {
      const file = path.join(dir, name);
      execFileSync(tools.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
        'testsrc2=size=160x90:rate=30000/1001:duration=1', ...options, file], { windowsHide: true, stdio: 'pipe' });
      const sniff = /\.(mkv|webm)$/.test(name) ? sniffNativeMatroska : sniffNativeMp4;
      const stat = fs.statSync(file);
      const guess = await sniff(file, stat);
      if (pixFmt) {
        const { video: { index, codec, width, height, fps, pixFmt: actual }, audio } = await ff.probe(tools, file);
        assert.equal(actual, pixFmt, name);
        assert.deepStrictEqual(guess, { video: { index, codec, width, height, fps, pixFmt }, audio: audio && { index: audio.index } }, name);
      } else assert.strictEqual(guess, null, name);
      assert.strictEqual(await sniff(file, { size: stat.size, mtimeMs: stat.mtimeMs - 1 }), null, `${name}: changed file`);
      checks += 2;
    }
    const truncated = path.join(dir, 'vp9.webm');
    fs.truncateSync(truncated, fs.statSync(truncated).size - 10);
    assert.strictEqual(await sniffNativeMatroska(truncated, fs.statSync(truncated)), null, 'truncated segment');
    fs.truncateSync(truncated, 4 * 1024 * 1024 + 1);
    assert.strictEqual(await sniffNativeMatroska(truncated, fs.statSync(truncated)), null, 'over read budget');
    checks += 2;
  } finally {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
  console.log(`native sniff: ${checks} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
