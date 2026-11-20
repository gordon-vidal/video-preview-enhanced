#!/usr/bin/env node
'use strict';
// One entry point for the four test layers (docs/TESTING.md).
//
//   node test/run.js [layer...] [--changed] [--grep re] [--jobs N] [--verbose] [--json file]
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
//   --grep re    only test files / scenarios whose name matches
//   --jobs N     parallel processes for layers 1-2 (default: logical CPUs)
//
// Layers 1-2 run every file in its own process (killed with its children after its timeout) and
// print one line per file, the output of the failed ones, and one summary. Layer 3 and 4 get the
// remaining arguments (see their files). A layer-4 run holds the benchmark lock (test/benchq.js);
// layers 2 and 3 wait for it, so no benchmark runs against them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timeout = entry.timeout || 60000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killChild(child); }, timeout);
    const done = (code, why) => {
      clearTimeout(timer);
      running.delete(child);
      const ms = Date.now() - t0;
      const skipped = code === 0 && /^SKIP(PED)?\b/m.test(out) && !/^(ok|PASS)\b/m.test(out) ? (/^SKIP(?:PED)?:?\s*(.*)$/m.exec(out) || [])[1] : null;
      resolve({ file: entry.file, ok: !timedOut && code === 0, code, ms, out, why: timedOut ? `timed out after ${timeout / 1000} s` : why, skipped });
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
    const tag = r.ok ? (r.skipped ? 'skip' : 'ok  ') : 'FAIL';
    console.log(`${tag} ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.file}${r.ok ? (r.skipped ? `: ${r.skipped}` : '') : `: ${r.why}`}`);
    if (!r.ok || o.verbose) console.log(r.out.replace(/^/gm, '    | ').trimEnd());
    return r;
  });
  results.push(...done);
  const wall = Date.now() - t0;
  const failed = results.filter((r) => !r.ok);
  console.log(`layer ${name}: ${results.length - failed.length} passed${results.some((r) => r.skipped) ? ` (${results.filter((r) => r.skipped).length} skipped)` : ''}, ${failed.length} failed, ${(wall / 1000).toFixed(1)} s wall${failed.length ? `\n  failed: ${failed.map((r) => r.file).join(', ')}` : ''}`);
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
    else if (!['--changed', '--verbose'].includes(a)) rest.push(a);
  }
  if (!layers.length) layers.push('unit', 'engine', 'vscode');
  const grep = opt('--grep') ? new RegExp(opt('--grep')) : null;
  const jobs = Math.max(1, Number(opt('--jobs', os.cpus().length)));
  const changed = flag('--changed') ? changedFiles() : null;
  if (flag('--changed')) console.log(changed ? `changed against ${process.env.VPE_BASE || 'main'}: ${changed.length} files` : 'git could not list the changed files: whole layers');
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
      if (layer === 'vscode') await waitPerfLock();
      const a = [...rest];
      if (grep) a.push('--grep', grep.source);
      if (changed && layer === 'vscode') a.push('--changed-files', JSON.stringify(changed));
      const ts = Date.now();
      const r = spawnSync(process.execPath, [script, ...a], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      const lok = r.status === 0;
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
module.exports = { changedFiles, sourcesOf, pickChanged, under };
