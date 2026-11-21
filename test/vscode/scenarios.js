#!/usr/bin/env node
'use strict';
// Layer 3 (docs/TESTING.md): user scenarios in real VS Code on hidden desktops, correctness only.
//
//   node test/vscode/scenarios.js [--grep re] [--parallel N] [--list] [--keep] [--json file]
//                                 [--changed-files <json array>] [--explain]   (node test/run.js vscode [--changed])
//
// A scenario (test/vscode/scenario_list.js) is one VS Code instance that runs several cases from
// test/vscode/cases one after another: before each, the test hook (src/extension.js, VPE_LOG only) sets
// that case's settings and environment, clears the stored state (as a fresh profile) and closes all
// editors. Results are named <scenario>/<case>/<result>. Cases run only the results the scenario keeps
// (the others moved to layers 2 and 4: docs/notes/test-inventory.md).
//
// --parallel N   instances at once (default 1; see docs/TESTING.md for the measured result), each with
//                its own profile and hidden desktop
// --changed-files the files changed (from test/run.js --changed): scenarios by test/vscode/scenario_map.js,
//                each printed with the reason it was picked; --explain prints that and runs nothing
// A run ends with where the time went: launch / reset / exec / shutdown / retries (test/vscode/timing.js; also in the JSON).
//
// An instance whose pages get no WebGL2 is broken, not failing: it is named, its logs kept in out/nogl-*,
// and the scenario runs once more in a fresh instance (the results say so). A page error ends a wait at once.
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./hidden');
const lib = require('./lib');
const T = require('./timing');
const { BUDGETS, DEFAULT: DEFAULT_BUDGET } = require('./budgets');
const TIMEOUT_RE = /TIMEOUT after|did not finish within/;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const { sleep, fwd } = H;

/** Every case module's cases by name. */
function loadCases() {
  const dir = path.join(__dirname, 'cases');
  const all = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) for (const c of [].concat(require(path.join(dir, f)))) all[c.name] = c;
  return all;
}

let hookSeq = 0;
/** Sends a hook line with an id and waits for "debug done <id>". */
async function hook(vs, obj, timeout = 10000) { // a hook answers in well under 1 s
  const id = `h${++hookSeq}`;
  const from = vs.mark();
  vs.send({ ...obj, id });
  const line = await vs.waitLog(new RegExp(`debug done ${id} `), { from, timeout, what: `hook ${Object.keys(obj)[0]}` });
  if (/failed/.test(line)) throw new Error(line);
  return line;
}

/**
 * Runs one scenario in one instance; returns its results and timing (test/vscode/timing.js). `carry` is what a
 * failed first instance cost (start time of the whole scenario, retry time so far): the returned `ms` is the
 * scenario's total wall time, the failed attempt and the wait before the retry counted as retryMs.
 */
async function runScenario(sc, ctx, attempt = 1, carry = { t0: Date.now(), retryMs: 0 }) {
  const { code, ff, cases } = ctx;
  const t0 = Date.now();
  const clock = T.phaseClock();
  let clockClosed = false; // a step still running after the budget ended the scenario must not charge a phase
  const phase = (p) => { if (!clockClosed) clock.to(p); };
  phase('launchMs');
  const stripped = H.pathWithoutFfmpeg();
  const vs = new H.HiddenCode({ code, keep: flag('--keep'), tag: 'vpe3', env: { PATH: stripped, ...(sc.env || {}) }, settings: sc.settings });
  const results = [];
  // The scenario's time budget (test/vscode/budgets.js): past it the scenario is ended and reported as TIMEOUT.
  const budget = Math.round((BUDGETS[sc.name] || DEFAULT_BUDGET) * Number(process.env.VPE_BUDGET_SCALE || process.env.VPE_TIME_SCALE || (process.env.CI ? 3 : 1)));
  let expired = false;
  let where = 'starting VS Code';
  let budgetTimer;
  const budgetP = new Promise((_, rej) => { budgetTimer = setTimeout(() => rej(Object.assign(new Error('budget'), { budget: true })), budget); });
  budgetP.catch(() => {}); // handled by the race below
  const add = (r) => {
    if (expired) return; // a step still running after the budget ended the scenario
    if (!r.ok && (r.problems || []).some((p) => TIMEOUT_RE.test(p))) r.timeout = true;
    results.push(r);
    console.log(`${r.ok ? (r.skipped ? 'skip' : 'ok  ') : r.timeout ? 'TIMEOUT' : 'FAIL'} ${r.name}${r.skipped ? `: ${r.skipped}` : ''}${r.problems && r.problems.length ? `: ${r.problems.join('; ')}` : ''}`);
  };
  let noGl = false;
  try {
    await Promise.race([budgetP, (async () => {
    await vs.start();
    await vs.waitLog(/activated: module load/, { timeout: 45000, what: 'the extension activating' });
    phase('resetMs');
    let applied = {}; let envApplied = {};
    for (const step of sc.steps) {
      if (expired) break;
      where = `${sc.name}/${step.case}`;
      phase('resetMs');
      const c = cases[step.case];
      const base = `${sc.name}/${step.case}`;
      if (!c) { add({ name: base, ok: false, problems: [`no case named ${step.case}`] }); continue; }
      const useFf = step.ffmpeg !== undefined ? step.ffmpeg : !!c.ffmpeg;
      if (useFf && !ff) { add({ name: base, ok: true, skipped: 'no ffmpeg', problems: [] }); continue; }
      const ts = Date.now();
      try {
        vs.send({ command: 'workbench.action.closeAllEditors' });
        await sleep(500);
        // Settings: the case's and the step's; what the last step set and this one doesn't goes back to the default.
        const want = { ...(c.settings || {}), ...(step.settings || {}), 'videoPreviewEnhanced.ffmpegPath': useFf ? fwd(ff) : null };
        const diff = {};
        for (const k of Object.keys(applied)) if (!(k in want)) diff[k] = null;
        for (const [k, v] of Object.entries(want)) if (JSON.stringify(applied[k]) !== JSON.stringify(v)) diff[k] = v;
        if (Object.keys(diff).length) await hook(vs, { settings: diff });
        applied = Object.fromEntries(Object.entries(want).filter(([, v]) => v !== null));
        const env = { PATH: useFf ? process.env.PATH : stripped, ...(c.env || {}), ...(step.env || {}) };
        const envDiff = {};
        for (const k of Object.keys(envApplied)) if (!(k in env)) envDiff[k] = null;
        for (const [k, v] of Object.entries(env)) if (envApplied[k] !== v) envDiff[k] = v;
        if (Object.keys(envDiff).length) await hook(vs, { env: envDiff });
        envApplied = env;
        if (step.keepState !== true) await hook(vs, { resetState: true });
        await sleep(300);
        const keep = step.only ? new RegExp(step.only) : null;
        const drop = step.skip ? new RegExp(step.skip) : null;
        lib.setFilter((n) => (!keep || keep.test(n)) && (!drop || !drop.test(n)));
        const h = { MEDIA: H.MEDIA, sleep, fwd, esc: lib.esc, openClip: H.openClip, closeClip: H.closeClip, playClip: ctx.playClip, seconds: ctx.perf ? 5 : 2, quick: !ctx.perf, ffmpeg: ff, scenario: ctx.perf ? undefined : sc.name };
        const gl = brokenGl(vs);
        phase('execMs');
        const rs = await withTimeout(Promise.race([c.run(vs, h), gl.promise]).finally(gl.stop), step.timeout || 15 * 60e3, `${base} did not finish`);
        for (const r of rs) {
          const name = r.name ? `${base}/${r.name}` : base;
          if ((keep || drop) && r.name && !((!keep || keep.test(r.name)) && (!drop || !drop.test(r.name)))) continue; // moved to another layer
          add({ ...r, name, ...(attempt > 1 ? { retried: 'the first instance had no WebGL2 (GPU process)' } : {}) });
        }
      } catch (e) {
        add({ name: base, ok: false, problems: [e && e.message || String(e)] });
      } finally { lib.setFilter(null); phase('resetMs'); }
      if (vs.lines.some((l) => H.NO_WEBGL.test(l))) { noGl = true; break; }
      console.log(`  ${base}: ${((Date.now() - ts) / 1000).toFixed(0)} s`);
    }
    })()]);
  } catch (e) {
    if (e && e.budget) {
      const waiting = vs.waitingFor();
      const left = sc.steps.map((s) => s.case).slice(Math.max(0, sc.steps.findIndex((s) => `${sc.name}/${s.case}` === where)));
      const r = { name: sc.name, ok: false, timeout: true, problems: [`TIMEOUT after ${Math.round((Date.now() - t0) / 1000)} s (budget ${Math.round(budget / 1000)} s) in ${where}; ${waiting ? `waiting for ${waiting}` : 'not in a wait (a step doing work or a stuck page)'}; not finished: ${left.join(', ')}`] };
      expired = true;
      results.push(r);
      console.log(`TIMEOUT ${r.name}: ${r.problems[0]}`);
    } else add({ name: sc.name, ok: false, problems: [e && e.message || String(e)] });
  } finally {
    clearTimeout(budgetTimer);
    expired = true;
    phase('shutdownMs');
    if (noGl) H.saveGpuLogs(vs, sc.name, attempt);
    await vs.stop();
    phase(null);
    clockClosed = true;
  }
  if (noGl) {
    if (attempt === 1) {
      console.log(`${sc.name}: this VS Code instance got no WebGL2 (GPU process): a broken instance, not a failed test; once more in a fresh one`);
      await sleep(10000);
      return runScenario(sc, ctx, 2, { t0: carry.t0, retryMs: carry.retryMs + (Date.now() - t0) });
    }
    results.push({ name: `${sc.name}/webgl2`, ok: false, problems: ['two instances in a row had no WebGL2 (GPU process): logs in test/vscode/out/nogl-*'] });
  }
  return { name: sc.name, attempts: attempt, noGl, results, ...T.scenarioTiming({ wallMs: Date.now() - carry.t0, phases: clock.phases, attempts: attempt, retryMs: carry.retryMs }) };
}

/** Rejects as soon as this instance logs "no WebGL2": a broken instance ends the step now, not after each wait's timeout. */
function brokenGl(vs) {
  let timer;
  const promise = new Promise((_, rej) => {
    timer = setInterval(() => {
      vs.mark();
      const l = vs.lines.find((x) => H.NO_WEBGL.test(x));
      if (l) rej(new Error(`no WebGL2 in this VS Code instance: ${l.replace(/^.*?webview: /, '')}`));
    }, 300);
  });
  promise.catch(() => {});
  return { promise, stop: () => clearInterval(timer) };
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p.finally(() => clearTimeout(t)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} within ${ms / 60000} min`)), ms); })]);
}

async function main() {
  if (process.platform !== 'win32') { console.error('layer 3 runs on Windows only (hidden desktops)'); return 2; }
  const list = require('./scenario_list');
  const cases = loadCases();
  const grep = opt('--grep') ? new RegExp(opt('--grep')) : null;
  let todo = list.filter((s) => !grep || grep.test(s.name) || s.steps.some((st) => grep.test(`${s.name}/${st.case}`)));
  if (opt('--changed-files')) {
    const map = require('./scenario_map');
    const pick = map.scenariosFor(JSON.parse(opt('--changed-files')));
    for (const l of map.explain(pick, list)) console.log(l); // advisory: why each scenario is in
    if (!pick.unsure.length) todo = todo.filter((s) => pick.names.has(s.name));
    if (!todo.length) { console.log('layer vscode: no scenario covers the changed files'); return 0; }
    if (flag('--explain')) return 0;
  }
  if (flag('--list')) { for (const s of todo) console.log(`${s.name.padEnd(22)} ${s.steps.map((x) => x.case).join(', ')}`); return 0; }
  const code = H.findCode();
  const ff = H.findFfmpeg();
  const parallel = Math.max(1, Number(opt('--parallel', process.env.VPE_PARALLEL || 1)));
  const { playClip } = require('./suite');
  const ctx = { code, ff, cases, playClip };
  fs.mkdirSync(H.OUT, { recursive: true });
  // Clips the cases make with ffmpeg: once, before instances run in parallel.
  try { require('../media/make_cases_media').ensure(); } catch { /* each case makes what it needs */ }
  // Longest first by the last run, so a long one doesn't start last.
  const last = lastTimes();
  todo.sort((a, b) => (last[b.name] || 120000) - (last[a.name] || 120000));
  const t0 = Date.now();
  let lm = null; try { lm = require('../loadmon'); } catch { /* none */ }
  const loadBefore = lm ? await lm.sample(2).catch(() => null) : null;
  console.log(`layer vscode: ${todo.length} scenarios, ${parallel} instance${parallel > 1 ? 's' : ''} at a time${loadBefore ? `; CPU load of other processes ${Math.round(loadBefore.load)} %` : ''}`);
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, async (_, w) => {
    if (w) await sleep(w * 4000); // staggered starts
    while (next < todo.length) {
      const sc = todo[next++];
      console.log(`--- ${sc.name} (${sc.steps.map((x) => x.case).join(', ')})`);
      const r = await runScenario(sc, ctx);
      console.log(`--- ${sc.name}: ${r.results.filter((x) => !x.ok).length} failed of ${r.results.length}, ${(r.ms / 1000).toFixed(0)} s${r.attempts > 1 ? ' (second instance: the first had no WebGL2)' : ''}`);
      out.push(r);
    }
  }));
  const all = out.flatMap((s) => s.results);
  const failed = all.filter((r) => !r.ok);
  const res = {
    started: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000), parallel, code: code.exe, host: os.hostname(), cpus: os.cpus().length,
    loadBefore: loadBefore && Math.round(loadBefore.load), noWebGl: out.filter((s) => s.attempts > 1 || s.noGl).map((s) => s.name),
    phases: T.summarize(out).total,
    scenarios: out.map((s) => ({ name: s.name, ms: s.ms, attempts: s.attempts, ...pickTiming(s), failed: s.results.filter((x) => !x.ok).length, timeouts: s.results.filter((x) => x.timeout).length, results: s.results.length })),
    tests: all,
  };
  const file = opt('--json') || path.join(H.OUT, `scenarios-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(res, null, 1));
  console.log('\nscenario               s    results  failed');
  for (const s of res.scenarios.sort((a, b) => b.ms - a.ms)) console.log(`${s.name.padEnd(22)} ${String(Math.round(s.ms / 1000)).padStart(4)}  ${String(s.results).padStart(7)}  ${s.failed || ''}${s.attempts > 1 ? '  (no WebGL2 in the first instance)' : ''}`);
  console.log(`
${T.summaryLine(out, Date.now() - t0)}`);
  for (const r of failed) console.log(`${r.timeout ? 'TIMEOUT' : 'FAIL'} ${r.name}: ${(r.problems || []).join('; ')}`);
  const hung = failed.filter((r) => r.timeout);
  console.log(`\nlayer vscode: ${all.length - failed.length} passed, ${failed.length} failed${hung.length ? ` (${hung.length} TIMEOUT)` : ''} of ${all.length} in ${out.length} scenarios, ${res.seconds} s wall, ${parallel} at a time${res.noWebGl.length ? `; instances without WebGL2: ${res.noWebGl.join(', ')}` : ''}; ${file}`);
  return failed.length ? 1 : 0;
}

/** The phase timings of a scenario record, for the JSON. */
function pickTiming(s) {
  const { launchMs, resetMs, execMs, shutdownMs, retries, retryMs, otherMs } = s;
  return { launchMs, resetMs, execMs, shutdownMs, retries, retryMs, otherMs };
}

function lastTimes() {
  try {
    const f = fs.readdirSync(H.OUT).filter((x) => /^scenarios-.*\.json$/.test(x)).sort().pop();
    return Object.fromEntries(JSON.parse(fs.readFileSync(path.join(H.OUT, f), 'utf8')).scenarios.map((s) => [s.name, s.ms]));
  } catch { return {}; }
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
module.exports = { runScenario, loadCases };
