'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('node:assert/strict');
const { open, checks } = require('./harness');
const { captureLuma, lumaOf, lumaMetrics } = require('../../media/compare-metrics');
const { make } = require('../media/make_cases_media');

/** ffmpeg per-frame luma PSNR and SSIM of b against a (stats files). */
function ffmpegStats(ffmpeg, a, b, dir) {
  const esc = (f) => f.replace(/\\/g, '/').replace(/:/g, '\\\\:');
  const out = {};
  for (const [filter, re] of [['psnr', /psnr_y:(\S+)/], ['ssim', /Y:(\S+)/]]) {
    const file = path.join(dir, `${path.basename(b)}.${filter}`);
    const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-i', a, '-i', b, '-lavfi', `[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]${filter}=stats_file=${esc(file)}`, '-f', 'null', '-'], { windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg ${filter}: ${r.stderr}`);
    out[filter] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((l) => Number((l.match(re) || [])[1]));
  }
  return out;
}

async function planeAt(P, k) {
  P.player.lumaSrc = null;
  P.seekFrame(k);
  const shown = await P.until(() => P.frame() === k && P.player.lumaSrc && P.player.seekTarget == null,
    `decoded frame ${k}`);
  assert.ok(shown, `${P.name}: frame ${k} did not land`);
  const plane = await lumaOf(P.player);
  assert.ok(plane, `${P.name}: no decoded luma for frame ${k}`);
  return plane;
}

(async () => {
  const { run, done } = checks('engine compare metrics');
  await run('lowq-vs-ffmpeg', async () => {
    const ffmpeg = process.env.VPE_FFMPEG || 'ffmpeg';
    const ref = make('cmp/ref.mp4');
    const low = make('cmp/lowq.mp4');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-cmp-'));
    let a;
    let b;
    try {
      const expected = ffmpegStats(ffmpeg, ref, low, dir);
      a = await open(ref, { ffmpeg });
      b = await open(low, { ffmpeg });
      captureLuma(a.player);
      captureLuma(b.player);
      for (const k of [1, 2, 30, 59, 44, 0]) {
        const [pa, pb] = await Promise.all([planeAt(a, k), planeAt(b, k)]);
        const actual = lumaMetrics(pa, pb, true);
        // ffmpeg rounds PSNR to 2 decimals and SSIM to 6, including partial edge windows differently.
        assert.ok(Math.abs(actual.psnrY - expected.psnr[k]) < 0.006 &&
          Math.abs(actual.ssimY - expected.ssim[k]) < 1e-5,
        `frame ${k + 1}: ${actual.psnrY} dB, SSIM ${actual.ssimY}; ffmpeg ${expected.psnr[k]}, ${expected.ssim[k]}`);
      }
    } finally {
      a?.close();
      b?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  done();
})().catch((error) => { console.error(error); process.exitCode = 1; });
