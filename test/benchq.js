#!/usr/bin/env node
'use strict';
// Benchmark queue: runs one timing job at a time, so parallel agents and builds
// don't run two benchmarks against each other. Optionally pins the job to CPU cores.
//
//   node test/benchq.js <command> [args...]
//
// Env: BENCHQ_LOCK     lock directory (default %TEMP%\vpe-benchq.lock)
//      BENCHQ_AFFINITY hex core mask, e.g. F0 = logical CPUs 4-7; empty / "none" (default) = no pinning
//      BENCHQ_WAIT_S   how long to wait for the queue (default 3600)
//      BENCHQ_QUIET_S  wait up to this long for a quieter machine before starting (default 0;
//                      see test/loadmon.js: waits while other processes use > 50 % CPU)
//
// Pinning. The default is no pinning: on hybrid CPUs (Intel 12th gen and later, Core Ultra)
// a fixed mask lands on whichever core type happens to sit there. On the Core Ultra 7 165U
// laptop (14 logical CPUs) a per-CPU spin test (pinned single thread) measured logical 0-1 and
// 10-11 as the fastest (P-cores), 2-9 as E-cores (2-3x slower under load) and 12-13 as the
// low-power E-cores (5x slower): the old default F0 (4-7) put every timing job on four E-cores.
// To pin there anyway, BENCHQ_AFFINITY=C03 (the P-cores) or 3FF (P + E, no LP-E). On the
// 8-core i7-9700K desktop (no hybrid cores) the old F0 kept jobs away from builds on 0-3.
//
// How the pin works (Windows): `start /affinity` pins the process and everything it spawns.
// The command line handed to cmd.exe holds only fixed, quote-free paths (node.exe, the
// runner script below, a temp JSON file with the real argv), so arguments with quotes,
// spaces, & | ^ < > never reach cmd.exe's parser. Everything runs hidden (windowsHide).
// Prints how long it waited for the queue and the CPU load before the run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** Runner mode: node benchq.js --run <json>: spawns the argv stored in the JSON, exits with its code. */
if (process.argv[2] === '--run') {
  const { argv, cwd } = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', windowsHide: true, cwd, shell: false });
  if (r.error) console.error(`benchq: ${r.error.message}`);
  const code = r.status !== null ? r.status : 1;
  // cmd.exe's start /wait doesn't hand the exit code back: the parent reads it from this file.
  fs.writeFileSync(`${process.argv[3]}.exit`, String(code));
  process.exit(code);
}

const args = process.argv.slice(2);
if (!args.length) { console.error('usage: node test/benchq.js <command> [args...]'); process.exit(2); }
const lock = process.env.BENCHQ_LOCK || path.join(os.tmpdir(), 'vpe-benchq.lock');
const mask = /^(none|0|)$/i.test(process.env.BENCHQ_AFFINITY || '') ? '' : process.env.BENCHQ_AFFINITY;
if (mask && !/^[0-9a-f]+$/i.test(mask)) { console.error(`benchq: BENCHQ_AFFINITY must be a hex mask, got "${mask}"`); process.exit(2); }
const maxWait = Number(process.env.BENCHQ_WAIT_S || 3600) * 1000;
const quietS = Number(process.env.BENCHQ_QUIET_S || 0);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const t0 = Date.now();
for (;;) {
  try {
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, cmd: args.join(' '), at: new Date().toISOString() }));
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Break stale locks (owner gone or older than 30 min).
    try {
      const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      let alive = true;
      try { process.kill(o.pid, 0); } catch { alive = false; }
      if (!alive || Date.now() - Date.parse(o.at) > 30 * 60e3) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
    } catch { /* being written; retry */ }
    if (Date.now() - t0 > maxWait) { console.error('benchq: gave up waiting for the queue'); process.exit(3); }
    sleep(2000);
  }
}
let r;
let argFile = null;
try {
  const waited = ((Date.now() - t0) / 1000).toFixed(0);
  let loadText = '';
  try {
    const lm = require('./loadmon');
    const l = quietS > 0 ? lm.waitQuiet({ maxS: quietS }) : lm.sampleSync(1);
    if (l) loadText = `; CPU load before: ${lm.describe(l)}`;
  } catch { /* no load info */ }
  console.error(`benchq: waited ${waited} s${loadText}; ${mask ? `pinned to core mask ${mask}` : 'not pinned'}: ${args.join(' ')}`);
  if (mask && process.platform === 'win32') {
    argFile = path.join(os.tmpdir(), `vpe-benchq-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(argFile, JSON.stringify({ argv: args, cwd: process.cwd() }));
    const fixed = [process.execPath, __filename, '--run', argFile];
    if (fixed.some((p) => /["%^&|<>]/.test(p))) throw new Error(`benchq: a path has cmd.exe metacharacters: ${fixed.join(' ')}`);
    const line = `start "" /b /wait /affinity ${mask} ${fixed.map((p) => `"${p}"`).join(' ')}`;
    r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { stdio: 'inherit', windowsVerbatimArguments: true, windowsHide: true });
    try { r = { status: Number(fs.readFileSync(`${argFile}.exit`, 'utf8')) }; } catch { r = { status: 1 }; console.error('benchq: the pinned job reported no exit code'); }
  } else if (mask) {
    const cpus = [];
    for (let i = 0; i < 64; i++) if ((BigInt(`0x${mask}`) >> BigInt(i)) & 1n) cpus.push(i);
    r = spawnSync('taskset', ['-c', cpus.join(','), ...args], { stdio: 'inherit' });
  } else {
    r = spawnSync(args[0], args.slice(1), { stdio: 'inherit', windowsHide: true, shell: false });
    if (r.error) console.error(`benchq: ${r.error.message}`);
  }
} finally {
  fs.rmSync(lock, { recursive: true, force: true });
  if (argFile) { fs.rmSync(argFile, { force: true }); fs.rmSync(`${argFile}.exit`, { force: true }); }
}
process.exit(r && r.status !== null ? r.status : 1);
