'use strict';
// Where the time of a layer-3 run goes (docs/TESTING.md): pure bookkeeping, no VS Code, so a Node test can check it.
//
// A scenario's wall time is split into launch (VS Code start to extension activated), reset (between cases:
// close editors, settings, state, sleeps), exec (the case itself), shutdown (teardown), and retry (everything a
// first instance without WebGL2 cost: its whole run plus the wait before the fresh one). `otherMs` is what no
// phase claims. Instances run side by side with --parallel, so phase sums can exceed the run's wall time.

const PHASES = ['launchMs', 'resetMs', 'execMs', 'shutdownMs'];

const emptyPhases = () => ({ launchMs: 0, resetMs: 0, execMs: 0, shutdownMs: 0 });

/** A stopwatch that charges elapsed time to the current phase; `to(next)` switches (null stops). */
function phaseClock(now = Date.now) {
  const phases = emptyPhases();
  let cur = null;
  let mark = now();
  return {
    phases,
    to(next) {
      const t = now();
      if (cur && cur in phases) phases[cur] += t - mark;
      mark = t;
      cur = next;
    },
  };
}

/** One scenario's record: this (final) attempt's phases plus what the failed attempts before it cost. */
function scenarioTiming({ wallMs, phases, attempts = 1, retryMs = 0 }) {
  const p = { ...emptyPhases(), ...phases };
  const claimed = PHASES.reduce((n, k) => n + p[k], 0) + retryMs;
  return { ms: wallMs, ...p, retries: Math.max(0, attempts - 1), retryMs, otherMs: Math.max(0, wallMs - claimed) };
}

/** Totals over scenarios (summed instance time) and each phase's share of it. */
function summarize(scenarios) {
  const keys = [...PHASES, 'retryMs', 'otherMs'];
  const total = { ms: 0, retries: 0 };
  for (const k of keys) total[k] = 0;
  for (const s of scenarios) {
    total.ms += s.ms || 0;
    total.retries += s.retries || 0;
    for (const k of keys) total[k] += s[k] || 0;
  }
  const share = {};
  for (const k of keys) share[k] = total.ms ? total[k] / total.ms : 0;
  return { total, share };
}

/** One line for the end of a run: instance time by phase (seconds and percent), then the run's wall time. */
function summaryLine(scenarios, wallMs) {
  const { total, share } = summarize(scenarios);
  const part = (label, k) => `${label} ${(total[k] / 1000).toFixed(0)} s (${Math.round(share[k] * 100)} %)`;
  const retry = `retries ${total.retries}${total.retries ? ` costing ${(total.retryMs / 1000).toFixed(0)} s (${Math.round(share.retryMs * 100)} %)` : ''}`;
  const other = total.otherMs >= 1000 ? `, other ${(total.otherMs / 1000).toFixed(0)} s` : '';
  return `phases of ${(total.ms / 1000).toFixed(0)} s instance time (${(wallMs / 1000).toFixed(0)} s wall): ${part('launch', 'launchMs')}, ` +
    `${part('reset', 'resetMs')}, ${part('exec', 'execMs')}, ${part('shutdown', 'shutdownMs')}, ${retry}${other}`;
}

/**
 * What one case's time went to: harness waits (log waits and state polls), sleeps, and per clip the time from the open
 * to its first picture. Bookkeeping only; the harness calls `wait`/`sleep`/`clipStart`/`clipOpened`/`clipEnd`.
 * Waits that overlap are added up, so waitMs can exceed ms for a case that waits on several players at once.
 */
function caseMeter(now = Date.now) {
  const t0 = now();
  let waitMs = 0;
  let sleepMs = 0;
  const clips = [];
  let cur = null;
  const baseName = (f) => String(f).split(/[\\/]/).pop();
  const clipEnd = () => {
    if (!cur) return;
    clips.push({ file: cur.file, ms: now() - cur.t0, openMs: cur.openMs });
    cur = null;
  };
  return {
    wait(ms) { waitMs += Math.max(0, ms); },
    sleep(ms) { sleepMs += Math.max(0, ms); },
    clipStart(file) { clipEnd(); cur = { file: baseName(file), t0: now(), openMs: 0 }; },
    /** The picture (or an error) of the clip opened last is up. */
    clipOpened() { if (cur && !cur.openMs) cur.openMs = now() - cur.t0; },
    clipEnd,
    /** The case's record: `name` is scenario/case; retries are the failed instances before the final one. */
    finish(name, { attempts = 1 } = {}) {
      clipEnd();
      return {
        name, ms: now() - t0, openMs: clips.reduce((n, c) => n + c.openMs, 0), waitMs: waitMs + sleepMs, sleepMs,
        retries: Math.max(0, attempts - 1), clips,
      };
    },
  };
}

/** Clips over all cases by file name: how often opened, summed open-to-picture and open-to-close time. */
function clipTotals(cases) {
  const by = new Map();
  for (const c of cases) {
    for (const k of c.clips || []) {
      const t = by.get(k.file) || { file: k.file, opens: 0, ms: 0, openMs: 0 };
      t.opens += 1; t.ms += k.ms || 0; t.openMs += k.openMs || 0;
      by.set(k.file, t);
    }
  }
  return [...by.values()].sort((a, b) => b.ms - a.ms);
}

/** The n slowest cases (by accumulated time), summed over retries' records when a name repeats. */
function topCases(cases, n = 10) {
  const by = new Map();
  for (const c of cases) {
    const t = by.get(c.name) || { name: c.name, ms: 0, openMs: 0, waitMs: 0, retries: 0 };
    t.ms += c.ms || 0; t.openMs += c.openMs || 0; t.waitMs += c.waitMs || 0; t.retries += c.retries || 0;
    by.set(c.name, t);
  }
  return [...by.values()].sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name)).slice(0, n);
}

/** Lines for the end of a run: the slowest cases with their open and wait seconds. Empty when nothing was timed. */
function topLines(cases, n = 10) {
  const top = topCases(cases, n);
  if (!top.length) return [];
  const s = (ms) => (ms / 1000).toFixed(1).padStart(6);
  const w = Math.max(...top.map((c) => c.name.length));
  return [`Top ${top.length} slowest case${top.length === 1 ? '' : 's'} (s: total, open to first picture, harness waits):`,
    ...top.map((c, i) => `${String(i + 1).padStart(3)}. ${c.name.padEnd(w)} ${s(c.ms)} total ${s(c.openMs)} open ${s(c.waitMs)} wait${c.retries ? `  (${c.retries} retr${c.retries === 1 ? 'y' : 'ies'})` : ''}`)];
}

module.exports = { PHASES, emptyPhases, phaseClock, scenarioTiming, summarize, summaryLine, caseMeter, clipTotals, topCases, topLines };
