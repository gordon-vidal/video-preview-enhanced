#!/usr/bin/env node
'use strict';
// Layer 4 (docs/TESTING.md): start-up, CPU, memory and frame rates, compared with the previous stored numbers.
// Not a pass/fail gate: it prints each number with its change against the last run on this machine and flags
// gross regressions (exit 1 only then). Run before a release or during performance work, on a quiet machine.
//
//   node test/perf/run.js [--grep re] [--list] [--no-save] [--against file|dir]   (node test/run.js perf)
//
// Holds the benchmark lock (test/benchq.js's, %TEMP%\vpe-benchq.lock) for the whole run: other benchmarks
// wait, and layers 2 and 3 started with test/run.js wait too. Results: test/perf/results/<bench>-<time>.json
// ({ bench, host, cpus, started, loadBefore, metrics: { name: number }, raw }); the comparison is with the
// newest earlier file of the same bench and host (or --against).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(__dirname, 'results');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gross: worse by more than this fraction (higher-is-better numbers: lower by more than 1/(1+x)).
const GROSS = 0.5;

// ---- lock ---------------------------------------------------------------------------------
const LOCK = process.env.BENCHQ_LOCK || path.join(os.tmpdir(), 'vpe-benchq.lock');
async function lock() {
  const t0 = Date.now();
  let said = false;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, cmd: `test/perf/run.js ${argv.join(' ')}`, at: new Date().toISOString() }));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(LOCK, 'owner.json'), 'utf8'));
        let alive = true;
        try { process.kill(o.pid, 0); } catch { alive = false; }
        if (!alive) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
        if (!said) { console.log(`waiting for the benchmark lock (${o.cmd}, since ${o.at})`); said = true; }
      } catch { /* being written */ }
      if (Date.now() - t0 > 6 * 3600e3) throw new Error('gave up waiting for the benchmark lock');
      await sleep(3000);
    }
  }
}
const unlock = () => fs.rmSync(LOCK, { recursive: true, force: true });

// ---- metrics ------------------------------------------------------------------------------

/** Numbers of a result object as flat "a.b.c" keys (arrays of named objects by their name; other arrays skipped). */
function flatten(o, prefix = '', out = {}, depth = 0) {
  if (depth > 5 || o === null || o === undefined) return out;
  if (typeof o === 'number') { if (Number.isFinite(o)) out[prefix] = o; return out; }
  if (Array.isArray(o)) {
    for (const x of o) {
      const id = x && typeof x === 'object' && (x.name || x.file || x.clip || x.route || x.class || x.label);
      if (id) flatten(x, `${prefix}${prefix ? '.' : ''}${String(id).replace(/\./g, '_')}`, out, depth + 1);
    }
    return out;
  }
  if (typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (['ok', 'problems', 'retried', 'skipped', 'pid', 'at', 'started', 'id', 'gen', 'seq', 'othersLoad'].includes(k)) continue;
      flatten(v, `${prefix}${prefix ? '.' : ''}${k}`, out, depth + 1);
    }
  }
  return out;
}

function memoryMb(key, bench) {
  const name = key.split('.').pop();
  return /mb$/i.test(name)
    || (name !== 'ffmpegCount' && /(?:^|\.)(?:mem|memory)\./i.test(key))
    || (/^memory(?:-|$)/.test(bench) && /\.(?:before|paused|peak)\.(?:total|extHost|webview|webviewWs|gpu|ffmpeg)$/.test(key));
}

/** +1: higher is better, -1: lower is better, 0: unknown (not judged). */
function direction(key, bench) {
  const k = key.split('.').pop();
  if (/fps|perSec|per_s|speed|mbs|mbps|pps|speedup|throughput|rate$/i.test(k)) return 1;
  if (memoryMb(key, bench)) return -1;
  if (/ms$|Ms$|^ms|mb$|MB$|bytes|cpu|load|rss|mem|secs?$|time|private|workingSet/i.test(k)) return -1;
  // Start-up phases (startup.js: milliseconds named by the phase).
  if (/^(total|activate|webviewCreate|pageLoad|hostDecide|openStreams|configure|firstFrame|workerInit|libav\w*)$|To[A-Z]\w*$|^probeTo|^spawnTo|^sendTo|^connect/.test(k)) return -1;
  return 0;
}

function noiseFloor(key, d, bench) {
  const name = key.split('.').pop();
  if (d === 1) return 1;
  if (/bytes|^rss$|^private$|^workingSet$/i.test(name)) return 20e6;
  if (memoryMb(key, bench)) return 20;
  if (/secs?$|seconds$/i.test(name)) return 0.025;
  if (/cpu|load|mem/i.test(name) || /\.cpu\./.test(key)) return 1;
  return 25; // Milliseconds, including the named startup phases.
}

function compare(now, before, bench) {
  const rows = [];
  for (const [k, v] of Object.entries(now)) {
    if (k.split('.').includes('othersLoad')) continue;
    const b = before ? before[k] : undefined;
    const d = direction(k, bench);
    let change = null; let gross = false;
    if (typeof b === 'number' && b !== 0) {
      change = (v - b) / Math.abs(b);
      if (Math.abs(v - b) > noiseFloor(k, d, bench)) {
        if (d === -1 && change > GROSS) gross = true;
        if (d === 1 && v < b / (1 + GROSS)) gross = true;
      }
    }
    rows.push({ k, v, b, change, d, gross });
  }
  return rows;
}

function previous(bench, host, against) {
  try {
    if (against && fs.statSync(against).isFile()) return JSON.parse(fs.readFileSync(against, 'utf8'));
    const dir = against || RESULTS;
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${bench}-`) && f.endsWith('.json')).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, files[i]), 'utf8'));
      if (j.bench === bench && j.host === host) return j;
    }
  } catch { /* none */ }
  return null;
}

const fmt = (x) => (x === undefined || x === null ? '-' : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3));

// ---- benches ------------------------------------------------------------------------------

async function runVscode(b) {
  const S = require('../vscode/scenarios');
  const H = require('../vscode/hidden');
  const cases = S.loadCases();
  const { playClip } = require('../vscode/suite');
  const r = await S.runScenario({ ...b, sources: [] }, { code: H.findCode(), ff: H.findFfmpeg(), cases, playClip, perf: true });
  const metrics = {};
  for (const t of r.results) Object.assign(metrics, flatten(t, t.name.replace(/^[^/]+\//, '')));
  const failed = r.results.filter((t) => !t.ok).map((t) => `${t.name}: ${(t.problems || []).join('; ')}`);
  return { metrics, raw: r.results, failed };
}

function runNode(b) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `vpe-perf-${b.name}-`));
    const json = path.join(tmp, 'out.json');
    const sub = (s) => s.replace('{json}', json).replace('{dir}', tmp);
    const args = b.cmd.map((a) => (/^test\//.test(a) ? path.join(ROOT, a) : sub(a)));
    const env = { ...process.env, ...Object.fromEntries(Object.entries(b.env || {}).map(([k, v]) => [k, sub(v)])) };
    const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), b.timeout || 20 * 60e3);
    child.on('close', (code) => {
      clearTimeout(timer);
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(b.out ? path.join(tmp, b.out) : json, 'utf8')); } catch { /* none */ }
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve({ metrics: raw ? flatten(raw) : {}, raw, failed: code === 0 && raw ? [] : [`exit ${code}${raw ? '' : ', no JSON'}: ${out.slice(-600)}`] });
    });
  });
}

async function main() {
  const { vscode, node } = require('./benches');
  // The opt-in benches' case modules export their cases only when these are set at load time.
  for (const b of vscode) Object.assign(process.env, b.env || {});
  const grep = opt('--grep') ? new RegExp(opt('--grep')) : null;
  const all = [...vscode.map((b) => ({ ...b, kind: 'vscode' })), ...node.map((b) => ({ ...b, kind: 'node' }))].filter((b) => !grep || grep.test(b.name));
  if (flag('--list')) { for (const b of all) console.log(`${b.kind.padEnd(7)} ${b.name}`); return 0; }
  if (process.platform !== 'win32' && all.some((b) => b.kind === 'vscode')) console.log('VS Code benches need Windows (hidden desktops): skipped');
  await lock();
  let gross = 0;
  const summary = [];
  try {
    let lm = null; try { lm = require('../loadmon'); } catch { /* none */ }
    for (const b of all) {
      if (b.kind === 'vscode' && process.platform !== 'win32') continue;
      const load = lm ? await lm.sample(2).catch(() => null) : null;
      const loadBefore = load ? Math.round(load.load) : null;
      console.log(`\n=== ${b.name}${loadBefore !== null ? ` (CPU load of other processes ${loadBefore} %${loadBefore > 25 ? ': UNDER LOAD, numbers not comparable' : ''})` : ''}`);
      const t0 = Date.now();
      let r;
      try { r = b.kind === 'vscode' ? await runVscode(b) : await runNode(b); } catch (e) { r = { metrics: {}, raw: null, failed: [e.message] }; }
      const host = os.hostname();
      const rec = { bench: b.name, host, cpus: os.cpus().length, cpu: os.cpus()[0] && os.cpus()[0].model, started: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000), loadBefore, underLoad: loadBefore !== null && loadBefore > 25, failed: r.failed, metrics: r.metrics, raw: r.raw };
      const prev = previous(b.name, host, opt('--against'));
      const rows = compare(r.metrics, prev && prev.metrics, b.name);
      for (const x of rows.filter((y) => y.d !== 0 || y.b !== undefined).slice(0, 400)) {
        console.log(`${x.gross ? 'GROSS' : '     '} ${x.k.padEnd(70).slice(0, 70)} ${fmt(x.v).padStart(9)}  ${x.b === undefined ? '' : `was ${fmt(x.b).padStart(9)}  ${x.change === null ? '' : `${x.change >= 0 ? '+' : ''}${(x.change * 100).toFixed(1)} %`}`}`);
      }
      for (const f of r.failed) console.log(`note: ${f}`);
      const g = rows.filter((x) => x.gross);
      gross += rec.underLoad ? 0 : g.length;
      summary.push(`${b.name}: ${Object.keys(r.metrics).length} numbers${prev ? ` vs ${prev.started}` : flag('--no-save') ? ' (no earlier result)' : ' (first run: stored as the baseline)'}${g.length ? `, ${g.length} gross regressions${rec.underLoad ? ' (under load: not counted)' : ''}` : ''}${r.failed.length ? `, ${r.failed.length} problems` : ''}`);
      if (!flag('--no-save')) {
        fs.mkdirSync(RESULTS, { recursive: true });
        const file = path.join(RESULTS, `${b.name}-${rec.started.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
      }
    }
  } finally { unlock(); }
  console.log(`\n${summary.join('\n')}\nlayer perf: ${gross ? `${gross} gross regressions (worse by more than ${GROSS * 100} %)` : 'no gross regressions'}${flag('--no-save') ? ' (not saved)' : `; results in ${RESULTS}`}`);
  return gross ? 1 : 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); try { unlock(); } catch { /* none */ } process.exit(1); });
module.exports = { flatten, compare, direction };
