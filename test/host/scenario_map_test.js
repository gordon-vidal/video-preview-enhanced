'use strict';
// Layer 3 bookkeeping without VS Code: why --changed picks each scenario, a case file that fails to load, and
// the timing / retry math (test/vscode/scenario_map.js, test/vscode/timing.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const map = require('../vscode/scenario_map');
const T = require('../vscode/timing');

const list = [
  { name: 'alpha', sources: ['media/engine.js', 'media/libav-vpe'], steps: [{ case: 'a1' }] },
  { name: 'beta', sources: ['src/bar.js'], steps: [{ case: 'b1' }, { case: 'a1' }] },
  { name: 'ui', sources: [], steps: [{ case: 'u1' }] },
  { name: 'seeking', sources: [], steps: [{ case: 's1' }] },
  { name: 'playback', sources: [], steps: [{ case: 'p1' }] },
];
const cases = { files: { a1: 'test/vscode/cases/a.js', b1: 'test/vscode/cases/b.js', u1: 'test/vscode/cases/u.js' }, errors: [] };
const dependencies = [{ when: ['media/engine.js'], why: 'seek paths', run: ['seeking', 'playback', 'nope'] }];
const pick = (changed, extra = {}) => map.scenariosFor(changed, { list, cases, dependencies, ...extra });

// A source named by a scenario, plus a dependency rule: each pick carries its reasons.
let r = pick(['media/engine.js']);
assert.deepStrictEqual([...r.names].sort(), ['alpha', 'playback', 'seeking']);
assert.deepStrictEqual(r.reasons.get('alpha'), ['media/engine.js is in its sources (media/engine.js)']);
assert.match(r.reasons.get('seeking')[0], /^media\/engine\.js: docs\/TESTING\.md known dependency \(seek paths\)$/);
assert.ok(!r.reasons.has('nope'), 'a rule naming an unknown scenario picks nothing');
assert.strictEqual(r.unsure.length, 0);

// A folder in sources; a case file selects every scenario that runs one of its cases.
assert.deepStrictEqual([...pick(['media/libav-vpe/x.wasm']).names], ['alpha']);
r = pick(['test/vscode/cases/a.js']);
assert.deepStrictEqual([...r.names].sort(), ['alpha', 'beta']);
assert.strictEqual(r.reasons.get('beta')[0], 'runs changed case file test/vscode/cases/a.js');

// Unknown src file, machinery, and an unmapped case file: unsure (whole layer); docs are ignored.
assert.deepStrictEqual(pick(['src/unknown.js']).unsure, ['src/unknown.js']);
assert.deepStrictEqual(pick(['test/vscode/scenarios.js']).unsure, ['test/vscode/scenarios.js']);
assert.deepStrictEqual(pick(['test/vscode/cases/new.js']).unsure, ['test/vscode/cases/new.js']);
r = pick(['README.md']);
assert.strictEqual(r.names.size + r.unsure.length, 0);

// explain: one line per scenario with its reason; the whole layer says so; nothing picked says that.
let lines = map.explain(pick(['src/bar.js']), list);
assert.strictEqual(lines.length, 1);
assert.match(lines[0], /^ {2}beta +src\/bar\.js is in its sources \(src\/bar\.js\)$/);
lines = map.explain(pick(['src/unknown.js']), list);
assert.match(lines[0], /^all 5 scenarios: no scenario maps src\/unknown\.js$/);
assert.strictEqual(lines.length, 1 + list.length);
assert.match(lines[1], /whole layer/);
assert.deepStrictEqual(map.explain(pick(['README.md']), list), ['no scenario covers the changed files']);

// A case file that fails to load is reported, never swallowed, and makes the whole layer run.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-cases-'));
try {
  fs.writeFileSync(path.join(dir, 'good.js'), "module.exports = [{ name: 'g1' }];\n");
  fs.writeFileSync(path.join(dir, 'broken.js'), "throw new Error('boom at import');\n");
  const found = map.caseFiles(dir, 'x/cases');
  assert.deepStrictEqual(found.files, { g1: 'x/cases/good.js' });
  assert.deepStrictEqual(found.errors, [{ file: 'x/cases/broken.js', message: 'boom at import' }]);
  r = pick(['media/engine.js'], { cases: found });
  assert.deepStrictEqual(r.unsure, ['x/cases/broken.js']);
  assert.strictEqual(r.errors.length, 1);
  lines = map.explain(r, list);
  assert.match(lines[0], /^ERROR case file x\/cases\/broken\.js failed to load \(boom at import\)/);
  assert.match(lines[1], /^all 5 scenarios/);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// The real rules: every scenario they name exists and docs/TESTING.md still mentions it.
const real = require('../vscode/scenario_list').map((s) => s.name);
const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'TESTING.md'), 'utf8');
for (const d of map.DEPENDENCIES) for (const n of d.run) {
  assert.ok(real.includes(n), `dependency rule names unknown scenario ${n}`);
  assert.ok(doc.includes(`\`${n}\``), `docs/TESTING.md no longer names ${n}`);
}

// Timing: the clock charges the phase it is in; the record adds retries and what no phase claims.
let now = 1000;
const clock = T.phaseClock(() => now);
clock.to('launchMs'); now += 4000;
clock.to('resetMs'); now += 1500;
clock.to('execMs'); now += 20000;
clock.to('resetMs'); now += 500;
clock.to('shutdownMs'); now += 800;
clock.to(null); now += 9999; // after stopping nothing is charged
assert.deepStrictEqual(clock.phases, { launchMs: 4000, resetMs: 2000, execMs: 20000, shutdownMs: 800 });

// A first instance without WebGL2 took 30 s and the retry waited 10 s before the fresh one (60 s in all).
const rec = T.scenarioTiming({ wallMs: 95000, phases: clock.phases, attempts: 2, retryMs: 40000 });
assert.strictEqual(rec.ms, 95000);
assert.strictEqual(rec.retries, 1);
assert.strictEqual(rec.retryMs, 40000);
assert.strictEqual(rec.otherMs, 95000 - (4000 + 2000 + 20000 + 800) - 40000);
assert.strictEqual(T.scenarioTiming({ wallMs: 10, phases: {}, attempts: 1 }).otherMs, 10);
assert.strictEqual(T.scenarioTiming({ wallMs: 1, phases: { execMs: 5 } }).otherMs, 0, 'never negative');

const sum = T.summarize([rec, T.scenarioTiming({ wallMs: 5000, phases: { launchMs: 1000, execMs: 3000, shutdownMs: 500 } })]);
assert.strictEqual(sum.total.ms, 100000);
assert.strictEqual(sum.total.execMs, 23000);
assert.strictEqual(sum.total.retries, 1);
assert.strictEqual(sum.total.retryMs, 40000);
assert.strictEqual(sum.share.retryMs, 0.4);
assert.strictEqual(T.summarize([]).share.execMs, 0);
const line = T.summaryLine([rec], 95000);
assert.match(line, /^phases of 95 s instance time \(95 s wall\): launch 4 s \(4 %\), reset 2 s \(2 %\), exec 20 s \(21 %\), shutdown 1 s \(1 %\), retries 1 costing 40 s \(42 %\), other 28 s$/);
assert.match(T.summaryLine([], 0), /retries 0$/);

console.log('ok scenario_map_test');
