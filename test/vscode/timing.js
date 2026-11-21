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

module.exports = { PHASES, emptyPhases, phaseClock, scenarioTiming, summarize, summaryLine };
