'use strict';
// node test/host/file_icons_test.js: the "vpe-video" file-icon language is contributed without extensions or a
// picker name, and files.associations (user level) get "*.ext": "vpe-video" only where missing, once,
// removed again (only ours) when videoPreviewEnhanced.overrideFileIcons is turned off; .ts/.mts never touched.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { load } = require('./mock_vscode');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const EXTS = ['mkv', 'flv', 'mpeg', 'm2ts', 'wmv', '3gp', 'm4v', 'vob', 'divx', 'asf', 'mxf', 'y4m'];

async function start({ assoc = {}, enabled = true, state, failWrite = false } = {}) {
  const store = { assoc: { ...assoc }, enabled, writes: 0, listener: null };
  const errors = [];
  const setup = (m) => {
    const base = m.workspace.getConfiguration;
    m.workspace.getConfiguration = (sec) => {
      if (sec === 'files') {
        return {
          get: (k) => (k === 'associations' ? { ...store.assoc } : undefined),
          inspect: (k) => (k === 'associations' ? { globalValue: { ...store.assoc } } : {}),
          update: async (k, v) => { if (failWrite) throw new Error('boom'); store.writes++; store.assoc = { ...v }; },
        };
      }
      const c = base(sec);
      if (sec === 'videoPreviewEnhanced') return { ...c, get: (k, d) => (k === 'overrideFileIcons' ? store.enabled : c.get(k, d)) };
      return c;
    };
    m.workspace.onDidChangeConfiguration = (fn) => { store.listener = fn; return { dispose() {} }; };
    m.window.showErrorMessage = async (...a) => { errors.push(a); };
    m.window.showWarningMessage = async (...a) => { errors.push(a); };
  };
  const h = load({ setup, state });
  await wait(50);
  return { h, store, errors, state: h.context.globalState, map: h.context.globalState.state };
}
const toggle = async (x, on) => {
  x.store.enabled = on;
  x.store.listener({ affectsConfiguration: (k) => k === 'videoPreviewEnhanced.overrideFileIcons' });
  await wait(50);
};

(async () => {
  // Manifest: a nameless, extension-less language with light and dark icons; the setting defaults on.
  const lang = pkg.contributes.languages.find((l) => l.id === 'vpe-video');
  assert.ok(lang);
  assert.deepStrictEqual(lang.aliases, []);
  assert.ok(!lang.extensions && !lang.filenames && !lang.filenamePatterns);
  for (const t of ['light', 'dark']) assert.ok(fs.existsSync(path.join(root, lang.icon[t])), t);
  assert.strictEqual(pkg.contributes.configuration.properties['videoPreviewEnhanced.overrideFileIcons'].default, true);
  // Every mapped extension is one the player claims; none is TypeScript's or already Seti's video icon.
  const claimed = pkg.contributes.customEditors.map((e) => e.selector[0].filenamePattern).join('');
  for (const e of EXTS) assert.ok(claimed.includes(e), e);
  for (const bad of ['ts', 'mts', 'cts', 'avi', 'mov', 'mp4', 'webm', 'mpg', 'ogv']) assert.ok(!EXTS.includes(bad));

  // First activation: every pattern added, user entries kept, no messages.
  let x = await start({ assoc: { '*.txt': 'plaintext', '*.mkv': 'someone', '*.ts': 'typescript' } });
  const want = { '*.txt': 'plaintext', '*.mkv': 'someone', '*.ts': 'typescript' };
  for (const e of EXTS) if (e !== 'mkv') want[`*.${e}`] = 'vpe-video';
  assert.deepStrictEqual(x.store.assoc, want);
  assert.ok(!('*.mts' in x.store.assoc));
  assert.strictEqual(x.errors.length, 0);
  assert.ok(!x.state.get('videoPreviewEnhanced.fileIcons').added.includes('*.mkv'));

  // Idempotent: a second activation with the same state writes nothing.
  const w = x.store.writes;
  const again = await start({ assoc: x.store.assoc, state: x.map });
  assert.strictEqual(again.store.writes, 0);
  assert.strictEqual(w, 1);

  // Off: only our entries go (also a pattern the user retargeted stays).
  x.store.assoc['*.flv'] = 'other';
  await toggle(x, false);
  assert.deepStrictEqual(x.store.assoc, { '*.txt': 'plaintext', '*.mkv': 'someone', '*.ts': 'typescript', '*.flv': 'other' });
  assert.deepStrictEqual(x.state.get('videoPreviewEnhanced.fileIcons').added, []);

  // Back on: added again (the user's *.flv and *.mkv stay).
  await toggle(x, true);
  assert.strictEqual(x.store.assoc['*.m2ts'], 'vpe-video');
  assert.strictEqual(x.store.assoc['*.flv'], 'other');
  assert.strictEqual(x.store.assoc['*.mkv'], 'someone');

  // Setting off at activation: nothing written.
  x = await start({ assoc: { '*.txt': 'plaintext' }, enabled: false });
  assert.deepStrictEqual(x.store.assoc, { '*.txt': 'plaintext' });
  assert.strictEqual(x.store.writes, 0);

  // A pattern the user removed by hand is not re-added on the next start.
  x = await start({ assoc: {} });
  delete x.store.assoc['*.m2ts'];
  const y = await start({ assoc: x.store.assoc, state: x.map });
  assert.ok(!('*.m2ts' in y.store.assoc));

  // A failing write: nothing shown, no crash.
  x = await start({ assoc: {}, failWrite: true });
  assert.strictEqual(x.errors.length, 0);

  console.log('file_icons_test: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
