#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..', '..');
// Per test. remotestream_test takes ~40 s on a fast hosted runner and longer on a slow one; a hang is still caught.
const timeoutMs = Number(process.env.VPE_TEST_TIMEOUT_MS) || 180000;
const windows = process.platform === 'win32';
const hostTests = fs.readdirSync(__dirname).filter((name) => name.endsWith('_test.js')).sort();
const skipped = hostTests.filter((name) => name === 'avi_scan_test.js'); // Needs input files.
const tests = hostTests.filter((name) => !skipped.includes(name)).map((name) => `test/host/${name}`);
tests.push('test/engine/unit.js');

let active;
function killTest(signal) {
  if (!active?.pid) return;
  // The Windows wrapper owns the job handle. On POSIX the child leads a process group.
  try { process.kill(windows ? active.pid : -active.pid, signal); }
  catch (e) { if (e.code !== 'ESRCH') throw e; }
}

// A detached POSIX test does not receive the runner's terminal signals directly.
let interrupted;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    interrupted = code;
    killTest(windows ? 'SIGKILL' : signal);
  });
}

function run(file) {
  console.log(`\n--- ${file}`);
  return new Promise((resolve) => {
    const cmd = windows ? ['python', '-I', path.join(__dirname, 'windows_job.py'), process.execPath, file] : [process.execPath, file];
    const child = active = spawn(cmd[0], cmd.slice(1), {
      cwd: root, stdio: 'inherit', windowsHide: true, detached: !windows,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`FAIL ${file}: timed out after ${timeoutMs / 1000} s`);
      killTest('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      active = null;
      clearTimeout(timer);
      console.error(`FAIL ${file}: ${error.message}`);
      resolve(false);
    });
    child.once('exit', (code, signal) => {
      active = null;
      clearTimeout(timer);
      if (!timedOut && code !== 0) console.error(`FAIL ${file}: ${signal || `exit ${code}`}`);
      resolve(!timedOut && code === 0);
    });
  });
}

(async () => {
  let passed = 0;
  for (const file of tests) {
    if (interrupted) break;
    if (await run(file)) passed++;
  }
  if (interrupted) { process.exitCode = interrupted; return; }
  const reason = skipped.length ? ` (${skipped.join(', ')} needs input files)` : '';
  console.log(`\n${passed} passed, ${tests.length - passed} failed, ${skipped.length} skipped${reason}`);
  process.exitCode = passed === tests.length ? 0 : 1;
})();
