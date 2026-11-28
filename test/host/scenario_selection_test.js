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
const aborted = { name: 'earlier', ok: false, abort: true, problems: ['setup broke'] };
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

// An aborting error survives a filter that excludes its section (recorder level, like picture_size).
lib.withSelection((name) => name === 'compare/panel-page', () => {
  const R = lib.recorder();
  R.t('compare/button-and-mode')(false, 'never recorded');
  R.abort('compare/error', 'setup threw');
  assert.deepEqual(R.out.map((r) => [r.name, r.ok, r.abort]), [['compare/error', false, true]]);
});

// An ordinary failure outside the selection is dropped (compare_ui continues after failed checks).
const [[bar]] = selectScenarios([{ name: 'compare', steps: [{ case: 'compare_ui' }] }], /^compare\/compare_ui\/bar$/)
  .map((s) => s.steps);
const ui = collectResults('compare/compare_ui', [
  { name: 'start/drop', ok: false, problems: ['x'] }, { name: 'bar', ok: true, problems: [] },
], bar.selected, bar.expected);
assert.deepEqual(ui.map((r) => [r.name, r.ok]), [['compare/compare_ui/bar', true]]);

// A recovered setup error does not demand the error bucket on rerun: its case is the target.
const failedReport = { tests: [{ name: 'compare/picture_size/compare/error', ok: false, abort: true }] };
assert.deepEqual(rerunTargets(failedReport), ['compare/picture_size']);
const [[again]] = selectScenarios([{ name: 'compare', steps: [{ case: 'picture_size' }] }], null, null,
  rerunTargets(failedReport)).map((s) => s.steps);
const recovered = collectResults('compare/picture_size', [{ name: 'compare/panel-page', ok: true, problems: [] }],
  again.selected, again.expected);
assert.ok(recovered.every((r) => r.ok));

// remote_stream_long: an exception reaches the runner as an abort, which a (decision|seeks) filter keeps;
// after recovery the rerun asks for the case, not for a bucket that never reappears.
const longScenarios = [{ name: 'remote-stream', steps: [{ case: 'remote_stream_long' }] }];
const [[longStep]] = selectScenarios(longScenarios, /^remote-stream\/remote_stream_long\/(decision|seeks)$/)
  .map((s) => s.steps);
const thrown = collectResults('remote-stream/remote_stream_long',
  [{ ok: false, abort: true, problems: ['no first frame'] }], longStep.selected, longStep.expected);
assert.deepEqual(thrown.map((r) => [r.name, r.ok]), [['remote-stream/remote_stream_long', false]]);
const longReport = { tests: thrown };
assert.deepEqual(rerunTargets(longReport), ['remote-stream/remote_stream_long']);
const [[longAgain]] = selectScenarios(longScenarios, null, null, rerunTargets(longReport)).map((s) => s.steps);
const longOk = collectResults('remote-stream/remote_stream_long',
  [{ name: 'decision', ok: true, problems: [] }, { name: 'seeks', ok: true, problems: [] }],
  longAgain.selected, longAgain.expected);
assert.ok(longOk.length === 2 && longOk.every((r) => r.ok));

// Reports saved before `abort` existed: their setup error buckets are recognised by name.
for (const name of ['picture-size/picture_size/compare/error', 'compare/compare_ui/error']) {
  const owner = name.split('/').slice(0, 2).join('/');
  assert.deepEqual(rerunTargets({ tests: [{ name, ok: false }] }), [owner]);
}

// An interrupted section is failed next to the abort entry, never left passing.
{
  let start;
  lib.withSelection(() => true, () => {
    const R = lib.recorder();
    const ok = R.t('compare/panel-page');
    ok(false, 'interrupted: boom');
    R.abort('compare/error', 'boom');
    start = R.out;
  });
  assert.deepEqual(start.map((r) => [r.name, r.ok]), [['compare/panel-page', false], ['compare/error', false]]);
}
const fs = require('node:fs');
const casesDir = path.join(__dirname, '../vscode/cases');
for (const f of fs.readdirSync(casesDir)) {
  const src = fs.readFileSync(path.join(casesDir, f), 'utf8');
  assert.ok(!/name: '(?:compare\/)?error', ok: false(?!, abort)/.test(src), `${f}: error bucket without abort`);
}

for (const completed of [[], [{ name: 'demo' }]]) {
  const unstarted = unstartedScenarios(scenarios, completed);
  assert.deepEqual(unstarted, completed.length ? ['later'] : ['demo', 'later']);
  const report = { tests: [], unstarted };
  assert.deepEqual(selectScenarios(scenarios, null, null, rerunTargets(report)).map((s) => s.name), unstarted);
}
