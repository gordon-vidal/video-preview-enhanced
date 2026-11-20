#!/usr/bin/env node
'use strict';
// The ffmpeg probe (src/probe.js) on this machine with the shipped clips (media/probe),
// as the extension runs it, plus the CPU load around it.
//
//   node test/benchq.js node test/perf/probe_run.js [--ffmpeg <exe|dir>] [--runs N] [--json out.json] [--cpu]
//
// --runs N   runs the whole probe N times (default 1) and reports per class the median and
//            spread of the chosen method's fps (how stable the choice is on a busy machine).
// --cpu      software decoding only (videoPreviewEnhanced.gpuDecoding off).
// Load: sampled for 1 s before each run (= other processes) and every second during it.
const fs = require('fs');
const path = require('path');
const probe = require('../../src/probe');
const ff = require('../../src/ffmpeg');
const hardware = require('../../src/hardware');
const lm = require('../loadmon');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const repo = path.resolve(__dirname, '..', '..');

(async () => {
  const tools = await ff.locateTools(opt('--ffmpeg', process.env.VPE_FFMPEG || ''), '');
  if (!tools || !tools.ffmpeg) { console.error('no ffmpeg found (--ffmpeg <exe or dir>, VPE_FFMPEG or PATH)'); process.exit(2); }
  const hw = await hardware.detect();
  console.log(`ffmpeg ${tools.ffmpeg} (${(tools.version || '?').replace(/ Copyright.*/, '')})`);
  console.log(`GPUs: ${(hw.gpus || []).map((g) => `${g.name} ${g.driver || ''}`).join(', ') || 'none'}`);
  const runs = Math.max(1, Number(opt('--runs', 1)));
  const recs = [];
  const loads = [];
  const t0 = Date.now();
  for (let i = 0; i < runs; i++) {
    const before = await lm.sample(1);
    const mon = lm.monitor();
    const t1 = Date.now();
    // --trace: every ffmpeg run with its wall time (start-up, GPU decoder set-up and work).
    const trace = argv.includes('--trace');
    const reference = trace ? async (files, sizes) => {
      const ts = Date.now();
      const r = await probe.ffReference(tools.ffmpeg, probe.referenceArgs(files, sizes), files.length);
      console.log(`  ${((Date.now() - ts) / 1000).toFixed(2)} s  reference (${files.length} clips, exit ${r.code})`);
      return r;
    } : undefined;
    const listDir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'vpe-probe-'));
    const run = trace ? async (m, items, size) => {
      const ts = Date.now();
      const r = await probe.ffRun(tools.ffmpeg, probe.runArgs(m, items, size, listDir), items);
      console.log(`  ${((Date.now() - ts) / 1000).toFixed(2)} s  ${m.padEnd(7)} ${items.map((it, i) => `${it.file.replace('.mkv', '')} ${i === r.bad ? 'bad' : r.done[i] ? r.fps[i] : '-'}`).join(', ')}${r.code ? ` (exit ${r.code})` : ''}${r.slow ? ' (slow)' : ''}`);
      return r;
    } : undefined;
    const rec = await probe.runProbe({ tools, hw, reference, run, clipDir: path.join(repo, 'media', 'probe'), methods: argv.includes('--cpu') ? ['none'] : undefined, onProgress: () => {} });
    fs.rmSync(listDir, { recursive: true, force: true });
    const during = mon.stop();
    rec.secs = (Date.now() - t1) / 1000;
    rec.load = { before: before.load, during: during.median, duringMax: during.max, cpus: before.cpus, verdict: lm.verdict(before.load) };
    recs.push(rec);
    loads.push(before.load);
    console.log(`\nrun ${i + 1}/${runs}: ${rec.secs.toFixed(1)} s, CPU load before ${before.load} % (${rec.load.verdict}), during ${during.median} % (max ${during.max} %)`);
    console.log(probe.table(rec));
  }
  if (runs > 1) {
    console.log('\nclass            method(s)            fps median  best  spread');
    for (const cls of Object.keys(recs[0].results)) {
      const methods = [...new Set(recs.map((r) => r.results[cls] && r.results[cls].method))].join('/');
      const s = lm.spread(recs.map((r) => r.results[cls] && r.results[cls].fps));
      console.log(`${cls.padEnd(16)} ${methods.padEnd(20)} ${String(s.median).padStart(10)} ${String(s.best).padStart(5)}  ${s.spreadPct} %`);
    }
  }
  const top = lm.topProcesses(5);
  const total = (Date.now() - t0) / 1000;
  console.log(`\ntotal ${total.toFixed(1)} s for ${runs} run(s); load before runs: ${loads.join(', ')} % of ${recs[0].load.cpus} CPUs -> ${lm.verdict(Math.max(...loads))}` +
    (top.length ? `; busiest now: ${top.map((p) => `${p.name} ${p.pct} %`).join(', ')}` : ''));
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ hw, totalSecs: total, top, runs: recs }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
