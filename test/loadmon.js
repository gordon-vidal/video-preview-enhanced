'use strict';
// System CPU load for timing runs on a machine that is also used for other work.
// No admin rights and no windows: load comes from os.cpus() tick counters (all platforms),
// the busiest other processes from CIM perf counters through a hidden PowerShell (Windows).
//
//   const lm = require('./loadmon');
//   lm.sampleSync(1)            -> { load: 37.5, cpus: 14, secs: 1 }   (% of all logical CPUs)
//   await lm.sample(1)          -> same, without blocking
//   lm.waitQuiet({ maxS: 20 })  -> waits (up to maxS) until load < QUIET, returns the last sample + waitedS
//   const m = lm.monitor();  ...  m.stop() -> { median, max, n }   (1 s samples while a job runs)
//   lm.topProcesses()           -> [{ name, pct }] (pct of one core), Windows only, ~2 s
//   lm.verdict(loadOfOthers)    -> 'quiet' | 'noisy' | 'very noisy'
//
// "Others" = load measured while our own job is idle (before the run and in the pauses
// between clips). Above NOISY % the numbers of that run are marked noisy.
const os = require('os');
const { spawnSync } = require('child_process');

const NOISY = 25;
const VERY_NOISY = 50;
const QUIET = 20;

function ticks() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, at: Date.now() };
}

function loadBetween(a, b) {
  const dt = b.total - a.total;
  return dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / dt))) : 0;
}

const round = (x) => Math.round(x * 10) / 10;
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function sampleSync(secs = 1) {
  const a = ticks();
  block(secs * 1000);
  return { load: round(loadBetween(a, ticks())), cpus: os.cpus().length, secs };
}

async function sample(secs = 1) {
  const a = ticks();
  await new Promise((r) => setTimeout(r, secs * 1000));
  return { load: round(loadBetween(a, ticks())), cpus: os.cpus().length, secs };
}

function waitQuiet({ maxS = 20, below = QUIET } = {}) {
  const t0 = Date.now();
  let s = sampleSync(1);
  while (s.load >= below && Date.now() - t0 < maxS * 1000) s = sampleSync(1);
  return { ...s, waitedS: round((Date.now() - t0) / 1000) };
}

async function waitQuietAsync({ maxS = 20, below = QUIET } = {}) {
  const t0 = Date.now();
  let s = await sample(1);
  while (s.load >= below && Date.now() - t0 < maxS * 1000) s = await sample(1);
  return { ...s, waitedS: round((Date.now() - t0) / 1000) };
}

/** 1 s load samples until stop(); for "load while running" (includes our own job). */
function monitor(periodMs = 1000) {
  const loads = [];
  let last = ticks();
  const timer = setInterval(() => { const t = ticks(); loads.push(loadBetween(last, t)); last = t; }, periodMs);
  if (timer.unref) timer.unref();
  return {
    loads,
    stop() {
      clearInterval(timer);
      return stats(loads);
    },
  };
}

function stats(xs) {
  if (!xs.length) return { n: 0, median: null, max: null, min: null };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: round(s[Math.floor(s.length / 2)]), min: round(s[0]), max: round(s[s.length - 1]) };
}

/** Busiest processes right now (% of one core), Windows only; [] elsewhere or on error. */
function topProcesses(n = 5) {
  if (process.platform !== 'win32') return [];
  const cmd = "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -notmatch '^(_Total|Idle)$' -and $_.PercentProcessorTime -gt 3 } | " +
    `Sort-Object PercentProcessorTime -Descending | Select-Object -First ${n} | ForEach-Object { $_.Name + '=' + $_.PercentProcessorTime }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split(/\r?\n/).map((l) => /^(.+)=(\d+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[1].replace(/#\d+$/, ''), pct: Number(m[2]) }));
}

function verdict(othersLoad) {
  if (othersLoad == null) return 'unknown';
  return othersLoad >= VERY_NOISY ? 'very noisy' : othersLoad >= NOISY ? 'noisy' : 'quiet';
}

function describe(s) {
  return `${s.load} % of ${s.cpus} CPUs${s.waitedS ? ` (after waiting ${s.waitedS} s for a quieter moment)` : ''}`;
}

/** Median, best and spread (max-min)/median in % of a list of numbers (higher = better, e.g. fps). */
function spread(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { n: 0, median: null, best: null, spreadPct: null };
  const s = [...v].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: v.length, median: round(median), best: round(s[s.length - 1]), worst: round(s[0]), spreadPct: median ? Math.round((100 * (s[s.length - 1] - s[0])) / median) : null };
}

module.exports = { NOISY, VERY_NOISY, QUIET, sampleSync, sample, waitQuiet, waitQuietAsync, monitor, stats, topProcesses, verdict, describe, spread };
