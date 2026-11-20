'use strict';
// TEMPORARY (removed before merge): makes the DVD/DVB files many times with and without
// -max_interleave_delta 0, 6 at once with busy CPUs (as in CI, where 4 tests run at once),
// and prints how many came out with late subtitles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const M = require('./make_media');
const base = path.join(os.tmpdir(), 'vpe-bitmapsubs-diag');
fs.rmSync(base, { recursive: true, force: true });
const pgs = M.make(path.join(base, 'ref')).pgs;
const run = (args) => new Promise((res, rej) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { stdio: 'ignore' });
  p.on('close', (c) => (c ? rej(new Error(`ffmpeg ${c}`)) : res()));
});
const N = +process.argv[2] || 24;
const busy = [];
if (process.argv.includes('--busy')) for (let i = 0; i < os.cpus().length; i++) busy.push(new Worker('const e=Date.now()+1e9;for(;;){Math.sqrt(Math.random())}', { eval: true }));
(async () => {
  for (const [name, extra] of [['default', []], ['interleave0', ['-max_interleave_delta', '0']]]) {
    for (const [kind, enc, fmt] of [['dvd', 'dvdsub', []], ['dvb', 'dvbsub', ['-f', 'mpegts']]]) {
      const files = [];
      for (let i = 0; i < N; i += 6) {
        const batch = [];
        for (let k = i; k < Math.min(N, i + 6); k++) {
          const f = path.join(base, `${name}_${kind}_${k}.${kind === 'dvd' ? 'mkv' : 'ts'}`);
          files.push(f);
          batch.push(run(['-fix_sub_duration', '-i', pgs, '-map', '0', '-c:v', 'copy', '-c:s', enc, ...extra, ...fmt, f]));
        }
        await Promise.all(batch);
      }
      let bad = 0;
      const samples = [];
      for (const f of files) { const p = M.layoutProblems(f); if (p && p.length) { bad++; if (samples.length < 2) samples.push(p.join('; ')); } }
      console.log(`${name} ${kind}${busy.length ? ' (busy)' : ''}: ${bad}/${N} with late subtitles ${samples.join(' | ')}`);
    }
  }
  for (const w of busy) w.terminate();
})();
