'use strict';
// Source -> scenario map for `node test/run.js vscode --changed` (layer 3). Each scenario names the source
// files it exercises (`sources` in test/vscode/scenario_list.js); a changed file selects every scenario that
// names it (or a folder it is in). Changes to a case file select the scenarios that run that case.
// Unsure means all: a changed file under src/ or media/ that no scenario names, or the layer-3 machinery
// itself (this folder's runner, lib.js, hidden.js, hidden_launch.py), runs the whole layer.
const path = require('path');
const list = require('./scenario_list');

const under = (f, s) => f === s || f.startsWith(`${s.replace(/\/$/, '')}/`);
const MACHINERY = ['test/vscode/scenarios.js', 'test/vscode/scenario_list.js', 'test/vscode/scenario_map.js', 'test/vscode/lib.js', 'test/vscode/hidden.js',
  'test/vscode/hidden_launch.py', 'test/vscode/run.js', 'test/lib/frames.js', 'test/media/make_cases_media.js'];

/** The case file each case name comes from. */
function caseFiles() {
  const out = {};
  const fs = require('fs');
  const dir = path.join(__dirname, 'cases');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    try { for (const c of [].concat(require(path.join(dir, f)))) out[c.name] = `test/vscode/cases/${f}`; } catch { /* a broken case file: whole layer */ }
  }
  return out;
}

/** -> { names: Set of scenario names, unsure: [files no scenario maps] } */
function scenariosFor(changed) {
  const names = new Set();
  const unsure = [];
  const files = caseFiles();
  for (const f of changed) {
    if (MACHINERY.includes(f)) { unsure.push(f); continue; }
    let hit = false;
    for (const s of list) {
      const caseHit = s.steps.some((st) => files[st.case] === f);
      if (caseHit || s.sources.some((src) => under(f, src))) { names.add(s.name); hit = true; }
    }
    if (!hit && (/^(src|media)\//.test(f) || /^test\/vscode\/cases\//.test(f))) unsure.push(f);
  }
  return { names, unsure };
}

module.exports = { scenariosFor, MACHINERY };
