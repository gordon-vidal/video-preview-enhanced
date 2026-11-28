'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('../vscode/lib');

const runner = path.join(__dirname, '../run.js');
const list = (pattern) => execFileSync(process.execPath, [runner, 'vscode', '--list', '--grep', pattern], {
  encoding: 'utf8',
});
const selected = list('^compare/compare_link/open/split-frame$');
assert.match(selected, /compare\s+compare_link\b/);
assert.doesNotMatch(selected, /compare_ui|compare_metrics/);
assert.match(list('^remote-stream/remote_stream_size/size-to-picture$'), /remote-stream\s+remote_stream_size\s*$/);
assert.match(list('^remote-stream/remote_stream_size/size.to.picture$'), /remote-stream\s+remote_stream_size\s*$/);

const sub = execFileSync(process.execPath, [runner, 'vscode', '--list', '--sub', '^compare/compare_link/'], {
  encoding: 'utf8',
});
assert.match(sub, /compare\s+compare_link\b/);
assert.doesNotMatch(sub, /compare_ui|compare_metrics/);

lib.withSelection((name) => name === 'keep', () => {
  const R = lib.recorder();
  let ran = false;
  R.run('drop', () => { ran = true; });
  R.t('drop')(false, 'filtered');
  R.skip('drop', 'filtered');
  R.t('keep')(true);
  assert.equal(ran, false);
  assert.deepEqual(R.out.map((r) => r.name), ['keep']);
});
