'use strict';
// node test/host/benchq_test.js: test/benchq.js passes arguments with quotes, spaces and
// cmd.exe metacharacters through unchanged, unpinned and pinned (mask = all cores), hidden.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const benchq = path.join(__dirname, '..', 'benchq.js');
const lock = path.join(os.tmpdir(), `vpe-benchq-test-${process.pid}.lock`);
const tricky = ['plain', 'with space', 'a "quoted" word', 'x & y', 'c^d', 'p|q', '<in>', '100%', '(paren)', '', 'end\\'];
const all = ((1n << BigInt(os.cpus().length)) - 1n).toString(16).toUpperCase();

for (const mask of ['', all]) {
  const r = spawnSync(process.execPath, [benchq, process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1))); process.exit(7)', ...tricky], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, BENCHQ_LOCK: lock, BENCHQ_AFFINITY: mask, BENCHQ_WAIT_S: '5' },
  });
  assert.strictEqual(r.status, 7, `exit code passes through (mask "${mask}"): ${r.status} ${r.stderr}`);
  const line = r.stdout.trim().split(/\r?\n/).pop();
  assert.deepStrictEqual(JSON.parse(line), tricky, `argv unchanged (mask "${mask}")`);
  assert.match(r.stderr, mask ? new RegExp(`pinned to core mask ${mask}`) : /not pinned/);
  assert.match(r.stderr, /CPU load before: [\d.]+ % of \d+ CPUs/);
  assert.ok(!fs.existsSync(lock), 'lock released');
}
const bad = spawnSync(process.execPath, [benchq, process.execPath, '-e', '0'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, BENCHQ_LOCK: lock, BENCHQ_AFFINITY: 'F0 & calc' } });
assert.strictEqual(bad.status, 2, 'a mask that is not hex is refused');

const lm = require('../loadmon');
assert.deepStrictEqual(lm.spread([10, 12, 11]), { n: 3, median: 11, best: 12, worst: 10, spreadPct: 18 });
assert.strictEqual(lm.verdict(10), 'quiet');
assert.strictEqual(lm.verdict(30), 'noisy');
assert.strictEqual(lm.verdict(60), 'very noisy');
console.log('benchq_test: ok');
