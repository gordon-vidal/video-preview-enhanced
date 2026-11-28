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
const { selectScenarios, collectResults, rerunTargets, unstartedScenarios } = require('../vscode/selection');
const scenarios = [{ name: 'demo', steps: [{ case: 'raw' }] }, { name: 'later', steps: [{ case: 'other' }] }];

const [[broad]] = selectScenarios(scenarios, /requested/).map((s) => s.steps);
const aborted = { name: 'earlier', ok: false, problems: ['setup broke'] };
assert.deepEqual(collectResults('demo/raw', [aborted], broad.selected, broad.expected),
  [{ ...aborted, name: 'demo/raw/earlier' }]);

const targets = ['demo/raw/one', 'demo/raw/two', 'demo/raw/three'];
const [rerun] = selectScenarios(scenarios, null, null, targets);
const step = rerun.steps[0];
const results = collectResults('demo/raw', [
  { name: 'one', ok: true }, { name: 'two', ok: true, skipped: 'unavailable' },
  { name: 'unrelated', ok: true, skipped: 'unavailable' },
], step.selected, step.expected);
assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.name), targets.slice(1));
assert.ok(results.filter((r) => !r.ok).every((r) => /did not run/.test(r.problems[0])));

for (const completed of [[], [{ name: 'demo' }]]) {
  const unstarted = unstartedScenarios(scenarios, completed);
  assert.deepEqual(unstarted, completed.length ? ['later'] : ['demo', 'later']);
  const report = { tests: [], unstarted };
  assert.deepEqual(selectScenarios(scenarios, null, null, rerunTargets(report)).map((s) => s.name), unstarted);
}
