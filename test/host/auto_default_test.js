'use strict';
// node test/host/auto_default_test.js: MP4/WebM become this player's by default on first activation
// (workbench.editorAssociations, user level), without overwriting a user's own choice, once, silently (undo: a command);
// and a failing settings write falls back to globalState with no toast.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { load } = require('./mock_vscode');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OURS = 'videoPreviewEnhanced.playerOptional';
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

/** Loads the extension with a fake workbench.editorAssociations store; state survives across reloads via `state`. */
async function start({ assoc = {}, pick, state, failKeys = [] } = {}) {
  const store = { assoc: { ...assoc }, writes: 0 };
  const shown = [];
  const errors = [];
  const setup = (m) => {
    const base = m.workspace.getConfiguration;
    m.workspace.getConfiguration = (sec) => {
      const c = base(sec);
      if (sec === 'workbench') {
        return {
          get: (k) => (k === 'editorAssociations' ? { ...store.assoc } : undefined),
          inspect: (k) => (k === 'editorAssociations' ? { globalValue: { ...store.assoc } } : {}),
          update: async (k, v) => { store.writes++; store.assoc = { ...v }; },
        };
      }
      return {
        ...c,
        update: async (k) => { if (failKeys.includes(k)) throw new Error('Unable to write to User Settings because videoPreviewEnhanced.' + k + ' is not a registered configuration.'); },
      };
    };
    m.window.showInformationMessage = async (...a2) => { shown.push(a2); return a2.includes('Undo') ? pick : undefined; };
    m.window.showErrorMessage = async (...a2) => { errors.push(a2); };
    m.window.showWarningMessage = async (...a2) => { errors.push(a2); };
  };
  const h = load({ setup, state });
  await wait(50);
  return { h, store, shown, errors };
}

(async () => {
  // package.json: everything but MP4/WebM is already the default editor.
  const eds = pkg.contributes.customEditors;
  assert.deepStrictEqual(eds.filter((e) => e.priority === 'option').map((e) => e.selector[0].filenamePattern), ['*.{mp4,MP4,webm,WEBM}']);
  assert.ok(eds.filter((e) => e.priority !== 'option').every((e) => e.priority === 'default'));

  // First activation: fills the four patterns silently (no notification).
  let x = await start();
  assert.deepStrictEqual(x.store.assoc, { '*.mp4': OURS, '*.webm': OURS, '*.MP4': OURS, '*.WEBM': OURS });
  assert.strictEqual(x.shown.length, 0, 'no popup about the default viewer');
  assert.strictEqual(x.errors.length, 0);
  const st = x.h.context.globalState.get('videoPreviewEnhanced.autoDefault');
  assert.strictEqual(st.seen.length, 4);

  // The undo command removes our entries and keeps other ones.
  x = await start({ assoc: { '*.txt': 'x' } });
  await x.h.vscode._commands['videoPreviewEnhanced.undoDefault']();
  assert.deepStrictEqual(x.store.assoc, { '*.txt': 'x' });
  assert.deepStrictEqual(x.h.context.globalState.get('videoPreviewEnhanced.autoDefault').added, []);

  // A user's own choice is never overwritten; the rest is filled.
  x = await start({ assoc: { '*.mp4': 'vscode.mediaPreview', '*.webm': 'someone.else' } });
  assert.strictEqual(x.store.assoc['*.mp4'], 'vscode.mediaPreview');
  assert.strictEqual(x.store.assoc['*.webm'], 'someone.else');
  assert.strictEqual(x.store.assoc['*.MP4'], OURS);
  // Undo removes only what points at this player.
  await x.h.vscode._commands['videoPreviewEnhanced.undoDefault']();
  assert.deepStrictEqual(x.store.assoc, { '*.mp4': 'vscode.mediaPreview', '*.webm': 'someone.else' });

  // Runs once: the same globalState, a second activation does nothing (even after Undo).
  const again = await start({ assoc: {}, state: x.h.context.globalState });
  assert.deepStrictEqual(again.store.assoc, {});
  assert.strictEqual(again.store.writes, 0);
  assert.strictEqual(again.shown.length, 0);

  // A failing write to the associations: nothing shown, extension keeps working.
  x = await start({ assoc: {} });
  assert.ok(x.h.vscode._commands['videoPreviewEnhanced.makeDefault']);

  // Settings write rejected (stale manifest): no toast, choice kept in globalState and read back.
  x = await start({ failKeys: ['jump.arrow', 'whenSlow', 'jump.shift'] });
  const s = x.h.open(path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv'));
  await s.send({ type: 'pref', key: 'jump.arrow', value: 'frame' });
  await s.send({ type: 'pref', key: 'jump.shift', value: 3 }); // not a declared value: ignored
  await s.send({ type: 'pref', key: 'loop', value: false }); // not a page preference: ignored
  await s.send({ type: 'whenSlow', value: 'skip' });
  await wait(50);
  assert.strictEqual(x.errors.length, 0, 'no raw VS Code error shown');
  assert.deepStrictEqual(x.h.context.globalState.get('videoPreviewEnhanced.settingFallback'), { 'jump.arrow': 'frame', whenSlow: 'skip' });
  const prefs = s.posted.filter((m) => m.type === 'prefs').pop();
  assert.ok(prefs && prefs.prefs.jump.arrow === 'frame' && prefs.prefs.jump.shift === 1, `the page still gets the choice: ${JSON.stringify(prefs)}`);
  // A new page reads the fallback back.
  const s2 = x.h.open(path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv'));
  await s2.shown;
  assert.match(s2.panel.webview.html, /"prefs":{"jump":{"arrow":"frame","shift":1,"ctrl":"frame"},"stepButtons":"frame","pictureSize":"fit"}/);
  console.log('auto_default_test: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
