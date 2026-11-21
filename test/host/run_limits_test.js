'use strict';
// The layer 1-2 runner's limits: a silent hang is reported as STALLED with its last line, a long one as TIMEOUT.
const assert = require('assert');
const { runFile } = require('../run');

(async () => {
  const f = 'test/lib/hang_fixture.js';
  const ok = await runFile({ file: f, args: ['ok'], timeout: 20000, stall: 10000 });
  assert.ok(ok.ok && !ok.kind, 'a normal file passes');
  const st = await runFile({ file: f, args: ['hang'], timeout: 20000, stall: 2000 });
  assert.strictEqual(st.kind, 'stalled');
  assert.match(st.why, /STALLED: no output for \d+ s.*after: first line/);
  assert.ok(st.ms < 8000, `stall seen in ${st.ms} ms`);
  // Output keeps the stall timer away; the overall timeout still ends it.
  const to = await runFile({ file: f, args: ['hang'], timeout: 1500, stall: 20000 });
  assert.strictEqual(to.kind, 'timeout');
  assert.match(to.why, /TIMEOUT after 1.5 s.*last output: first line/);
  console.log('run limits: 4 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
