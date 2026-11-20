#!/usr/bin/env node
'use strict';
// Downloads the source frames that test/media/make_media.js cuts the clips from (about 8 GB:
// only the frames used, 16-bit TIFF masters, not the whole films). Resumable: files that are
// already complete are skipped. Sources and licences: test/media/LICENSES.md.
//
//   node test/media/fetch_sources.js <dir> [--parallel 8]
const fs = require('fs');
const path = require('path');
const https = require('https');

const dir = path.resolve(process.argv[2] || '.');
const i = process.argv.indexOf('--parallel');
const parallel = i > 0 ? Number(process.argv[i + 1]) : 8;
// Path-style S3 URL: the bucket name has dots, so the virtual-host name fails TLS checks.
const NETFLIX = 'https://s3.amazonaws.com/download.opencontent.netflix.com';
const pad = (n) => String(n).padStart(5, '0');
const range = (a, b, step = 1) => { const r = []; for (let n = a; n <= b; n += step) r.push(n); return r; };

const jobs = [
  ...range(700, 747).map((n) => [`https://media.xiph.org/tearsofsteel/tearsofsteel-4k-tiff/graded_edit_${pad(n)}.tif`, `tos/${pad(n)}.tif`]),
  ...range(15000, 15118, 2).map((n) => [`${NETFLIX}/Meridian/tiffs/Meridian_UHD4k5994p_HDR_P3PQ_${pad(n)}.tif`, `meridian/${pad(n)}.tif`]),
  ...range(5940, 6058, 2).map((n) => [`${NETFLIX}/sparks/HDR10_1000nit_PQ_2020_image_sequence/SPARKS_HDR10_4K_2020_PQ_1000nits_${pad(n)}.tif`, `sparks/${pad(n)}.tif`]),
  // A zip with the one mp4 inside: unzip it into bbb/ (bbb_sunflower_1080p_30fps_normal.mp4).
  ['https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip', 'bbb/bbb_sunflower_1080p_30fps_normal.mp4.zip'],
];

function get(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'vpe-test-media' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects) { res.resume(); resolve(get(new URL(res.headers.location, url).href, file, redirects - 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const part = `${file}.part`;
      const out = fs.createWriteStream(part);
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(part, file); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  let next = 0;
  let done = 0;
  const failed = [];
  const worker = async () => {
    while (next < jobs.length) {
      const [url, rel] = jobs[next++];
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 0) { done++; continue; }
      for (let attempt = 1; ; attempt++) {
        try { await get(url, file); break; } catch (e) { if (attempt >= 3) { failed.push(e.message); break; } }
      }
      done++;
      if (done % 10 === 0) console.log(`${done}/${jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  const zip = path.join(dir, 'bbb', 'bbb_sunflower_1080p_30fps_normal.mp4.zip');
  if (fs.existsSync(zip) && !fs.existsSync(zip.replace(/\.zip$/, ''))) {
    // tar is bsdtar on Windows 10+ and reads zip; elsewhere unzip.
    const { spawnSync } = require('child_process');
    const r = spawnSync('tar', ['-xf', zip, '-C', path.dirname(zip)], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) spawnSync('unzip', ['-o', zip, '-d', path.dirname(zip)], { stdio: 'inherit' });
  }
  console.log(`${done - failed.length}/${jobs.length} files in ${dir}${failed.length ? `; failed:\n  ${failed.join('\n  ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
