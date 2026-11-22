#!/usr/bin/env node
'use strict';
const TIME_SCALE = Number(process.env.VPE_TIME_SCALE) || (process.env.CI ? 3 : 1);
// One entry point for the four test layers (docs/TESTING.md).
//
//   node test/run.js [layer...] [--changed] [--smoke] [--grep re] [--jobs N] [--verbose] [--json file]
//
//   unit   | 1   pure logic in Node (test/layers.js), all files in parallel
//   engine | 2   the WebAssembly decoders in Node: frame-exact seeking, every format (test/layers.js)
//   vscode | 3   user scenarios in real VS Code on hidden desktops (test/vscode/scenarios.js)
//   perf   | 4   start-up, CPU, memory and frame rates against the stored numbers (test/perf/run.js)
//   (none)       layers 1-3
//
//   --changed    only what covers the files changed against main (committed or not): layers 1-2 by
//                the sources each test names, layer 3 by test/vscode/scenario_map.js; a changed file
//                no map knows runs the whole layer
//   --smoke      fast-merge layer-3 preset (~3-4 min: representative scenarios covering every real-VS-Code
//                boundary, defined in test/vscode/scenario_map.js); combines with --changed or --explain
//   --explain    like --changed (or --smoke), for layer 3 only prints which scenarios were picked and why, and runs nothing
//   --grep re    only test files / scenarios whose name matches
//   --jobs N     parallel processes for layers 1-2 (default: logical CPUs)
//
// Layers 1-2 run every file in its own process (killed with its children after its timeout) and
// print one line per file, the output of the failed ones, and one summary. Layer 3 and 4 get the
// remaining arguments (see their files). Layers 3 and 4 share a VS Code lock across worktrees.
// A layer-4 run also holds the benchmark lock (test/benchq.js); layers 2 and 3 wait for it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');
const { acquireVscodeLock } = require('./lib/vscode_lock');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const ALIAS = { 1: 'unit', 2: 'engine', 3: 'vscode', 4: 'perf', unit: 'unit', engine: 'engine', vscode: 'vscode', perf: 'perf' };

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

// ---- changed files ------------------------------------------------------------------------

/** Repo-relative paths changed against main (merge base) plus uncommitted and untracked ones; null when git can't tell. */
function changedFiles() {
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const base = git('merge-base', 'HEAD', process.env.VPE_BASE || 'main');
  if (base.status !== 0) return null;
  const out = new Set();
  for (const r of [git('diff', '--name-only', base.stdout.trim()), git('diff', '--name-only'), git('ls-files', '--others', '--exclude-standard')]) {
    if (r.status !== 0) return null;
    for (const l of r.stdout.split(/\r?\n/)) if (l.trim()) out.add(l.trim().replace(/\\/g, '/'));
  }
  return [...out];
}

/** The src/ and media/ files a test file names (require paths, strings): its default `sources`. */
function sourcesOf(entry) {
  if (entry.sources) return entry.sources;
  const text = fs.readFileSync(path.join(ROOT, entry.file), 'utf8');
  const found = new Set();
  for (const m of text.matchAll(/(?:\.\.\/)*(src|media)\/([\w.-]+?)(?:\.js)?['"`]/g)) found.add(`${m[1]}/${m[2]}${/\.\w+$/.test(m[2]) ? '' : '.js'}`);
  for (const m of text.matchAll(/['"`](src|media)['"`]\s*,\s*['"`]([\w.-]+)['"`]/g)) found.add(`${m[1]}/${m[2]}`);
  // The mock vscode loads the whole extension (src/extension.js and everything it requires).
  if (/mock_vscode/.test(text)) found.add('src');
  return [...found];
}

const under = (file, src) => file === src || file.startsWith(`${src.replace(/\/$/, '')}/`);

/**
 * Which entries cover the changed files. A changed file under src/, media/ or test/ that no test of
 * layers 1-2 names (`others`: the other layer's entries) selects the whole layer.
 */
function pickChanged(entries, changed, others = []) {
  const all = [...entries, ...others];
  const named = (f, list) => list.some((e) => e.file === f || sourcesOf(e).some((s) => under(f, s)));
  const relevant = changed.filter((f) => /^(src|media|test)\//.test(f) || f === 'package.json');
  const picked = new Set();
  let unsure = [];
  for (const f of relevant) {
    const hits = entries.filter((e) => e.file === f || sourcesOf(e).some((s) => under(f, s)));
    hits.forEach((e) => picked.add(e));
    if (!hits.length && !named(f, all)) unsure.push(f);
  }
  // Files that are only data or another layer's business don't make us unsure.
  unsure = unsure.filter((f) => !/^test\/(vscode|perf|bench|compare|review|media\/(cases|containers)|zoo)\//.test(f) && !/\.(md|json|png|svg)$/.test(f));
  return { picked: unsure.length ? entries : entries.filter((e) => picked.has(e)), unsure };
}

// ---- parallel node runner (layers 1-2) ----------------------------------------------------

let python = null;
function hasPython() {
  if (python === null) python = process.platform === 'win32' && spawnSync('python', ['-c', 'print(1)'], { windowsHide: true }).status === 0;
  return python;
}

function findFfmpeg() {
  if (process.env.VPE_FFMPEG) return process.env.VPE_FFMPEG;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
}

const running = new Set();
function killChild(child) {
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
}
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => { for (const c of running) killChild(c); process.exit(code); });

/** Runs one test file in its own process (a Windows job object kills its children with it). */
function runFile(entry) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [path.join(ROOT, entry.file), ...(entry.args || []).map((a) => (/^test\//.test(a) ? path.join(ROOT, a) : a))];
    const cmd = hasPython() ? ['python', '-I', path.join(__dirname, 'lib', 'windows_job.py'), process.execPath, ...args] : [process.execPath, ...args];
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, VPE_TEST_PARALLEL: '1' } });
    running.add(child);
    let out = '';
    let lastAt = Date.now();
    let gapMs = 0; // longest silence so far (recorded: test/tune_timeouts.js derives the stall limit from it)
    const onData = (d) => { const now = Date.now(); gapMs = Math.max(gapMs, now - lastAt); lastAt = now; out += d; };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const lastLine = () => { const l = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop(); return l ? (l.length > 140 ? `${l.slice(0, 140)}...` : l) : '(no output yet)'; };
    // Limits are measured on the maintainer's desktop; slower machines (GitHub's runners take 2-3x as long,
    // running 4 files at once) scale them: VPE_TIME_SCALE, else 3 on CI.
    const timeout = (entry.timeout || 60000) * TIME_SCALE;
    const stall = (entry.stall || 30000) * TIME_SCALE;
    let kind = null; // 'timeout' | 'stalled'
    let reason = '';
    const stop = (k, r) => { if (kind) return; kind = k; reason = r; killChild(child); };
    const timer = setTimeout(() => stop('timeout', `TIMEOUT after ${timeout / 1000} s (limit ${timeout / 1000} s); last output: ${lastLine()}`), timeout);
    const watch = setInterval(() => { if (Date.now() - lastAt > stall) stop('stalled', `STALLED: no output for ${Math.round((Date.now() - lastAt) / 1000)} s (limit ${stall / 1000} s) after: ${lastLine()}`); }, 1000);
    const done = (code, why) => {
      clearTimeout(timer);
      clearInterval(watch);
      running.delete(child);
      const ms = Date.now() - t0;
      const skipped = !kind && code === 0 && /^SKIP(PED)?\b/m.test(out) && !/^(ok|PASS)\b/m.test(out) ? (/^SKIP(?:PED)?:?\s*(.*)$/m.exec(out) || [])[1] : null;
      gapMs = Math.max(gapMs, Date.now() - lastAt);
      resolve({ file: entry.file, ok: !kind && code === 0, code, ms, out, kind, gapMs: kind ? undefined : gapMs, why: kind ? reason : why, skipped });
    };
    child.on('error', (e) => done(1, e.message));
    child.on('close', (code, signal) => done(code === null ? 1 : code, signal ? `signal ${signal}` : code ? `exit ${code}` : ''));
  });
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Makes the generated clips the entries name, once and one at a time (parallel tests would each start ffmpeg on them). */
function prepareMedia(entries) {
  if (entries.some((e) => e.trackMedia)) require('./tracks/make_media').ensure();
  const names = [...new Set(entries.flatMap((e) => e.media || []))];
  if (!names.length) return;
  const media = require('./media/make_cases_media');
  for (const n of names) { try { media.make(n); } catch (e) { console.warn(`could not make ${n}: ${e.message}`); } }
}

async function nodeLayer(name, entries, o) {
  const t0 = Date.now();
  const ff = findFfmpeg();
  const todo = [];
  const results = [];
  for (const e of entries) {
    if ((e.needs || []).includes('ffmpeg') && !ff) results.push({ file: e.file, ok: true, skipped: 'no ffmpeg (VPE_FFMPEG or PATH)', ms: 0 });
    else todo.push(e);
  }
  prepareMedia(todo);
  // Longest first (by the last run's times) so the slow ones don't start last.
  const last = lastTimes(name);
  todo.sort((a, b) => (last[b.file] || (b.timeout || 60000) / 10) - (last[a.file] || (a.timeout || 60000) / 10));
  console.log(`layer ${name}: ${todo.length} files, ${o.jobs} at a time${results.length ? `, ${results.length} skipped` : ''}`);
  const done = await pool(todo, o.jobs, async (e) => {
    const r = await runFile(e);
    const tag = r.ok ? (r.skipped ? 'skip' : 'ok  ') : r.kind === 'timeout' ? 'TIMEOUT' : r.kind === 'stalled' ? 'STALLED' : 'FAIL';
    console.log(`${tag} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.file}${r.ok ? (r.skipped ? `: ${r.skipped}` : '') : `: ${r.why}`}`);
    if (!r.ok || o.verbose) console.log(r.out.replace(/^/gm, '    | ').trimEnd());
    return r;
  });
  results.push(...done);
  const wall = Date.now() - t0;
  const failed = results.filter((r) => !r.ok);
  const hung = failed.filter((r) => r.kind);
  const stuck = `${hung.length ? ` (${hung.filter((r) => r.kind === 'timeout').length} TIMEOUT, ${hung.filter((r) => r.kind === 'stalled').length} STALLED)` : ''}`;
  console.log(`layer ${name}: ${results.length - failed.length} passed${results.some((r) => r.skipped) ? ` (${results.filter((r) => r.skipped).length} skipped)` : ''}, ${failed.length} failed${stuck}, ${(wall / 1000).toFixed(1)} s wall${failed.length ? `\n  failed: ${failed.map((r) => r.file).join(', ')}` : ''}`);
  return { layer: name, ok: !failed.length, wallMs: wall, results: results.map(({ out, ...r }) => ({ ...r, tail: r.ok ? undefined : out.slice(-4000) })) };
}

function lastTimes(layer) {
  try {
    const dir = path.join(__dirname, 'out');
    const f = fs.readdirSync(dir).filter((x) => x.startsWith(`${layer}-`) && x.endsWith('.json')).sort().pop();
    return Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).results.map((r) => [r.file, r.ms]));
  } catch { return {}; }
}

// ---- the perf lock ------------------------------------------------------------------------

/** Waits while a layer-4 run (or another benchmark in test/benchq.js's queue) holds the lock. */
async function waitPerfLock() {
  const lock = process.env.BENCHQ_LOCK || path.join(os.tmpdir(), 'vpe-benchq.lock');
  let said = false;
  for (;;) {
    let held = false;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      try { process.kill(o.pid, 0); held = Date.now() - Date.parse(o.at) < 6 * 3600e3; } catch { held = false; }
      if (held && !said) { console.log(`waiting for the benchmark lock (${o.cmd}, since ${o.at})`); said = true; }
    } catch { held = false; }
    if (!held) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function runLayerScript(script, args, lock) {
  const gate = pathToFileURL(path.join(__dirname, 'lib', 'vscode_gate.mjs')).href;
  const nodeArgs = lock ? ['--import', gate, script, ...args] : [script, ...args];
  const stdio = lock ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit';
  const child = spawn(process.execPath, nodeArgs, { cwd: ROOT, stdio, windowsHide: true });
  const done = new Promise((resolve) => {
    child.once('error', (error) => { console.error(error); resolve(); });
    child.once('exit', resolve);
  });
  try {
    if (lock && child.pid) {
      lock.track(child.pid);
      await new Promise((resolve, reject) => child.send('start', (err) => (err ? reject(err) : resolve())));
    }
  } catch (e) {
    if (child.connected) child.disconnect();
    throw e;
  } finally {
    await done;
  }
  return child.exitCode === 0;
}

// ---- main ---------------------------------------------------------------------------------

async function main() {
  const valueOpts = new Set(['--grep', '--jobs', '--json']);
  const layers = [];
  const rest = [];
  // Options of layers 3-4 that take a value: passed on with it (else "--parallel 3" would read as layer 3).
  const passValue = new Set(['--parallel', '--sub', '--against']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (passValue.has(a)) { rest.push(a, argv[i + 1]); i++; } else if (ALIAS[a]) layers.push(ALIAS[a]);
    else if (valueOpts.has(a)) i++;
    else if (!['--changed', '--verbose', '--smoke'].includes(a)) rest.push(a);
  }
  if (!layers.length) layers.push(...(flag('--explain') ? ['vscode'] : ['unit', 'engine', 'vscode']));
  const grep = opt('--grep') ? new RegExp(opt('--grep')) : null;
  const jobs = Math.max(1, Number(opt('--jobs', os.cpus().length)));
  const wantChanged = flag('--changed') || (flag('--explain') && !flag('--smoke'));
  const changed = wantChanged ? changedFiles() : null;
  if (wantChanged) console.log(changed ? `changed against ${process.env.VPE_BASE || 'main'}: ${changed.length} files` : 'git could not list the changed files: whole layers');
  const { unit, engine } = require('./layers');
  const out = { started: new Date().toISOString(), host: os.hostname(), cpus: os.cpus().length, argv, layers: [] };
  const t0 = Date.now();
  let ok = true;
  for (const layer of layers) {
    if (layer === 'unit' || layer === 'engine') {
      let entries = layer === 'unit' ? unit : engine;
      if (grep) entries = entries.filter((e) => grep.test(e.file));
      if (changed) {
        const other = layer === 'unit' ? engine : unit;
        const { picked, unsure } = pickChanged(entries, changed, other);
        if (unsure.length) console.log(`layer ${layer}: no test names ${unsure.slice(0, 5).join(', ')}${unsure.length > 5 ? ', ...' : ''}: whole layer`);
        entries = picked;
      }
      if (!entries.length) { console.log(`layer ${layer}: nothing to run`); continue; }
      if (layer === 'engine') await waitPerfLock();
      const r = await nodeLayer(layer, entries, { jobs, verbose: flag('--verbose') });
      fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
      const file = path.join(__dirname, 'out', `${layer}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...r, started: out.started, host: out.host, cpus: out.cpus }, null, 1));
      out.layers.push({ layer, ok: r.ok, wallMs: r.wallMs, file });
      ok = ok && r.ok;
    } else {
      const script = layer === 'vscode' ? path.join(__dirname, 'vscode', 'scenarios.js') : path.join(__dirname, 'perf', 'run.js');
      const a = [...rest];
      if (grep) a.push('--grep', grep.source);
      if (flag('--smoke') && layer === 'vscode') a.push('--smoke');
      if (changed && layer === 'vscode') a.push('--changed-files', JSON.stringify(changed));
      const ts = Date.now();
      const listing = flag('--list') || (layer === 'vscode' && flag('--explain') && (changed || flag('--smoke')));
      const lock = listing ? null : await acquireVscodeLock(layer);
      let lok;
      try {
        if (layer === 'vscode' && !listing) await waitPerfLock();
        lok = await runLayerScript(script, a, lock);
      } finally {
        if (lock) lock.release();
      }
      out.layers.push({ layer, ok: lok, wallMs: Date.now() - ts });
      ok = ok && lok;
    }
  }
  if (out.layers.length > 1) {
    console.log(`\n${out.layers.map((l) => `${l.layer} ${l.ok ? 'ok' : 'FAILED'} ${(l.wallMs / 1000).toFixed(0)} s`).join(' · ')} · total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
  return ok ? 0 : 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
module.exports = { runFile, changedFiles, sourcesOf, pickChanged, under };
