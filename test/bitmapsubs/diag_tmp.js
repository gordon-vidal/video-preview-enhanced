'use strict';
// TEMPORARY (removed before merge): makes the DVD/DVB files many times with and without
// -max_interleave_delta 0 and prints how many came out with late subtitles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('./make_media');
const base = path.join(os.tmpdir(), 'vpe-bitmapsubs-diag');
fs.rmSync(base, { recursive: true, force: true });
const pgs = M.make(path.join(base, 'ref')).pgs;
const run = (args) => { const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
const N = +process.argv[2] || 20;
for (const [name, extra] of [['default', []], ['interleave0', ['-max_interleave_delta', '0']]]) {
  for (const [kind, enc, fmt] of [['dvd', 'dvdsub', []], ['dvb', 'dvbsub', ['-f', 'mpegts']]]) {
    let bad = 0;
    const samples = [];
    for (let i = 0; i < N; i++) {
      const f = path.join(base, `${name}_${kind}_${i}.${kind === 'dvd' ? 'mkv' : 'ts'}`);
      run(['-fix_sub_duration', '-i', pgs, '-map', '0', '-c:v', 'copy', '-c:s', enc, ...extra, ...fmt, f]);
      const p = M.layoutProblems(f);
      if (p && p.length) { bad++; if (samples.length < 2) samples.push(p.join('; ')); }
    }
    console.log(`${name} ${kind}: ${bad}/${N} with late subtitles ${samples.join(' | ')}`);
  }
}
