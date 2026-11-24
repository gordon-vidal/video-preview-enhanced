'use strict';
// Source -> scenario map for `node test/run.js vscode --changed` (layer 3). Each scenario names the source
// files it exercises (`sources` in test/vscode/scenario_list.js); a changed file selects every scenario that
// names it (or a folder it is in). Changes to a case file select the scenarios that run that case.
// DEPENDENCIES below adds the scenarios docs/TESTING.md ("Known dependencies") says to run with a change.
// Unsure means all: a changed file under src/ or media/ that no scenario names, or the layer-3 machinery
// itself (this folder's runner, lib.js, hidden.js, hidden_launch.py), or a case file that fails to load, runs
// the whole layer.
//
// Every pick has its reasons (`reasons`), printed by `explain` so a run can say why each scenario is in.
const fs = require('fs');
const path = require('path');

const under = (f, s) => f === s || f.startsWith(`${s.replace(/\/$/, '')}/`);
const MACHINERY = ['test/vscode/scenarios.js', 'test/vscode/scenario_list.js', 'test/vscode/scenario_map.js', 'test/vscode/timing.js',
  'test/vscode/lib.js', 'test/vscode/hidden.js', 'test/vscode/hidden_launch.py', 'test/vscode/run.js', 'test/lib/frames.js',
  'test/media/make_cases_media.js'];

// The "Known dependencies" table of docs/TESTING.md: [what changed (files or folders), why, scenarios to also run].
// A test (test/host/scenario_map_test.js) checks every scenario named here exists and the doc still names it.
const DEPENDENCIES = [
  { when: ['media/engine.js', 'media/codec-utils.js', 'media/decoder-boot.js', 'media/block-cache.js', 'media/gl-renderer.js', 'media/pool.js'], why: 'stepping, seeking, decoder pool, end of file', run: ['seeking', 'playback'] },
  { when: ['src/native.js', 'src/frameserver.js'], why: 'native ffmpeg transport and frame sizes', run: ['native', 'picture-size-native'] },
  { when: ['media/picture.js', 'media/inspect.js'], why: 'drawn picture size, zoom, pan', run: ['picture-size', 'compare', 'inspect'] },
  { when: ['media/compare.js', 'media/compare-compositor.js', 'media/compare-grid.js', 'src/compare.js'], why: 'compare / multi-view', run: ['compare', 'multiview'] },
  { when: ['src/remotestream.js', 'src/stream-adapt.js', 'src/stream-buffer.js'], why: 'remote stream', run: ['remote-stream'] },
  { when: ['src/urlsource.js'], why: 'URLs', run: ['url', 'url-native'] },
  { when: ['media/controls.js', 'media/range-drag.js', 'src/bar.js'], why: 'the bar, panels, keys', run: ['ui'] },
  { when: ['media/subtitles.js', 'media/tracks-menu.js'], why: 'subtitles, tracks', run: ['subtitles'] },
  { when: ['src/folder-rail.js', 'media/folder-rail.js', 'media/autoplay.js'], why: 'folder rail, Autoplay, tab swap', run: ['folder-rail', 'ui'] },
];

/**
 * The case file each case name comes from, and the files that failed to load.
 * -> { files: { caseName: 'test/vscode/cases/x.js' }, errors: [{ file, message }] }
 */
function caseFiles(dir = path.join(__dirname, 'cases'), prefix = 'test/vscode/cases') {
  const files = {};
  const errors = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    try { for (const c of [].concat(require(path.join(dir, f)))) files[c.name] = `${prefix}/${f}`; } catch (e) {
      errors.push({ file: `${prefix}/${f}`, message: (e && e.message || String(e)).split('\n')[0] });
    }
  }
  return { files, errors };
}

/**
 * -> { names: Set of scenario names, unsure: [files that make it all scenarios], reasons: Map name -> [string],
 *      errors: [{ file, message }] case files that did not load }
 * `opts.list` / `opts.cases` (a caseFiles() result) / `opts.dependencies` replace the real ones (for tests).
 */
function scenariosFor(changed, opts = {}) {
  const list = opts.list || require('./scenario_list');
  const deps = opts.dependencies || DEPENDENCIES;
  const { files, errors } = opts.cases || caseFiles();
  const names = new Set();
  const unsure = errors.map((e) => e.file); // a case file we cannot read: we cannot know which scenarios run it
  const reasons = new Map();
  const pick = (name, why) => {
    names.add(name);
    if (!reasons.has(name)) reasons.set(name, []);
    if (!reasons.get(name).includes(why)) reasons.get(name).push(why);
  };
  for (const f of changed) {
    if (MACHINERY.includes(f)) { unsure.push(f); continue; }
    let hit = false;
    for (const s of list) {
      if (s.steps.some((st) => files[st.case] === f)) { pick(s.name, `runs changed case file ${f}`); hit = true; }
      const src = s.sources.find((x) => under(f, x));
      if (src) { pick(s.name, `${f} is in its sources (${src})`); hit = true; }
    }
    for (const d of deps) {
      if (!d.when.some((w) => under(f, w))) continue;
      for (const n of d.run) {
        if (list.some((s) => s.name === n)) { pick(n, `${f}: docs/TESTING.md known dependency (${d.why})`); hit = true; }
      }
    }
    if (!hit && (/^(src|media)\//.test(f) || /^test\/vscode\/cases\//.test(f))) unsure.push(f);
  }
  return { names, unsure, reasons, errors };
}

/** Advisory report lines: one per selected scenario with its reasons, or why the whole layer runs. */
function explain(pick, all) {
  const lines = [];
  for (const e of pick.errors) lines.push(`ERROR case file ${e.file} failed to load (${e.message}): which scenarios run it is unknown`);
  const wholeLayer = pick.unsure.length > 0;
  if (wholeLayer) lines.push(`all ${all.length} scenarios: no scenario maps ${pick.unsure.slice(0, 5).join(', ')}${pick.unsure.length > 5 ? ', ...' : ''}`);
  for (const s of all) {
    const why = pick.reasons.get(s.name);
    if (wholeLayer) lines.push(`  ${s.name.padEnd(22)} ${why ? why.join('; ') : 'whole layer (see above)'}`);
    else if (why) lines.push(`  ${s.name.padEnd(22)} ${why.join('; ')}`);
  }
  if (!wholeLayer && !pick.names.size) lines.push('no scenario covers the changed files');
  return lines;
}

// Fast-merge layer-3 smoke preset (`node test/run.js vscode --smoke`): a tight ~3-4 min set covering
// every real-VS-Code boundary (WebCodecs/WASM/WebGL/frame player, native ffmpeg/frame server/fallback/
// multi-view, drawn picture size/zoom/pan/compare-follows, and UI bar/panels/keys/a11y/context menu).
// A test (test/host/scenario_map_test.js) checks every scenario named here exists and docs/TESTING.md names it.
const SMOKE = [
  { name: 'seeking', why: 'WebCodecs (H.264/VP8), WASM (HEVC on WebGL), MJPEG frame player, open-GOP fallback, A-B loop' },
  { name: 'multiview-native', why: 'native ffmpeg decoding, frame server, tile sizing, resize, message fallback, multi-view' },
  { name: 'picture-size', why: 'drawn picture size (Fit/Fill/Stretch/100%), zoom, pan, settings, compare-follows' },
  { name: 'ui', why: 'player bar, accessibility, keys, panels, jump sizes, About, context menu' },
];

/** -> { names: Set of scenario names, reasons: Map name -> [string] } for the --smoke preset. */
function smokeScenarios(opts = {}) {
  const list = opts.list || require('./scenario_list');
  const smoke = opts.smoke || SMOKE;
  const names = new Set();
  const reasons = new Map();
  for (const entry of smoke) {
    if (!list.some((s) => s.name === entry.name)) continue;
    names.add(entry.name);
    reasons.set(entry.name, [`smoke preset: ${entry.why}`]);
  }
  return { names, reasons };
}

/** Advisory report lines for --smoke. */
function explainSmoke(pick, all) {
  const lines = [`smoke preset (${pick.names.size} of ${all.length} scenarios):`];
  for (const s of all) {
    const why = pick.reasons.get(s.name);
    if (why) lines.push(`  ${s.name.padEnd(22)} ${why.join('; ')}`);
  }
  return lines;
}

module.exports = { scenariosFor, caseFiles, explain, smokeScenarios, explainSmoke, MACHINERY, DEPENDENCIES, SMOKE };
