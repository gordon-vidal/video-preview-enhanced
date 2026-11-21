'use strict';
// Add from the Explorer (src/addmode.js, docs/notes/compare-ui.md "Add mode"): the rules, then the host with a
// fake VS Code: Shift+D in a player, a video opened meanwhile becomes compare in the player's place; in compare
// every opened video is added until full; tabs of other editors close; Esc; Alt+D on an Explorer selection.
const assert = require('assert');
const path = require('path');
const { createAddMode } = require('../../src/addmode');
const { load } = require('./mock_vscode');
const { make } = require('../media/make_cases_media');

// ---- the rules ----
{
  const m = createAddMode({ max: 4 });
  const P = { name: 'player' };
  const C = { name: 'compare' };
  assert.strictEqual(m.claim('file:///v/b.mp4'), null, 'off: nothing is taken');
  assert.strictEqual(m.toggle(P, { uris: ['file:///v/a.mp4'] }), 'on');
  assert.deepStrictEqual(m.hint(), { type: 'addMode', on: true, multi: false, n: 1, max: 4, room: 3 });
  assert.strictEqual(m.claim('file:///v/readme.md'), null, 'not a video');
  const d = m.claim('file:///v/b.mp4');
  assert.ok(d && d.target === P && !d.dup && d.stop && d.n === 2, `one video from a player: ${JSON.stringify(d)}`);
  assert.ok(!m.active, 'a player takes one video');
  assert.strictEqual(m.toggle(C, { multi: true, uris: ['a', 'file:///v/b.mp4'] }), 'on');
  assert.ok(m.claim('file:///v/b.mp4').dup, 'shown already');
  assert.ok(m.active, 'a duplicate keeps the mode');
  let x = m.claim('file:///v/c.mkv');
  assert.ok(x && !x.stop && x.n === 3, 'compare keeps adding');
  x = m.claim('file:///v/d.MOV?x=1');
  assert.ok(x && x.stop && x.full && !m.active, 'full: the mode ends');
  assert.strictEqual(m.toggle(C, { multi: true, uris: ['1', '2', '3', '4'] }), 'full', 'a full compare does not start it');
  m.toggle(C, { multi: true, uris: ['1', '2'] });
  assert.strictEqual(m.toggle(C), 'off', 'the same control again turns it off');
  m.toggle(C, { multi: true, uris: ['1', '2'] });
  assert.strictEqual(m.toggle(P, { uris: ['1'] }), 'on', 'another target takes the mode over');
  assert.strictEqual(m.target, P);
  assert.ok(!m.gone(C) && m.gone(P) && !m.active, 'the target closing ends it');
  m.toggle(P, { uris: ['1'] });
  assert.ok(m.stop() && !m.stop(), 'stop once');
}

// ---- the host ----
(async () => {
  const a = make('s_h264.mp4');
  const b = make('rotated.mp4');
  assert.ok(a && b, 'ffmpeg test clips');
  const dir = path.dirname(a);
  const panels = [];
  const fakePanel = () => {
      const p = {
        active: true, visible: true, viewColumn: 1, title: '', disposed: false, fns: [], posted: [],
        webview: { cspSource: 'x:', html: '', asWebviewUri: (u) => u, postMessage(m) { p.posted.push(m); }, onDidReceiveMessage(fn) { p.msg = fn; } },
        onDidDispose(fn) { p.fns.push(fn); }, onDidChangeViewState() {},
        dispose() { p.disposed = true; for (const fn of p.fns) fn(); },
      };
      panels.push(p);
      return p;
    };
  let tabListener = null;
  const closedTabs = [];
  const tabGroups = { onDidChangeTabs: (fn) => { tabListener = fn; return { dispose() {} }; }, close: async (t) => { closedTabs.push(t); }, all: [] };
  const h2 = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin' }, setup: (v) => { v.window.createWebviewPanel = fakePanel; v.window.tabGroups = tabGroups; } });
    const W = h2.vscode;
    const ctx = () => (W.executed || []).filter((c) => c[0] === 'setContext').map((c) => c[2]);
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const resolve = (file) => {
      const p = { webview: { html: '', options: null, onDidReceiveMessage() {}, postMessage: async () => true, cspSource: 'x:', asWebviewUri: (u) => u }, fns: [], onDidDispose(fn) { p.fns.push(fn); }, onDidChangeViewState() {}, dispose() { p.disposed = true; for (const fn of p.fns) fn(); } };
      const r = W._providers['videoPreviewEnhanced.player'].resolveCustomEditor({ uri: W.Uri.file(file) }, p);
      return { p, r };
    };
    try {
      // Shift+D in a player, then an Explorer click on another video.
      const pl = h2.open(a);
      pl.panel.active = true;
      await pl.send({ type: 'addMode', t: 1.5 });
      assert.ok(pl.posted.some((m) => m.type === 'addMode' && m.on && !m.multi), 'the player shows the hint');
      assert.deepStrictEqual(ctx(), [true], 'context key on');
      assert.ok(W.executed.some((c) => c[0] === 'workbench.action.keepEditor'), 'the player tab is kept (not a preview)');
      const opened = resolve(b);
      assert.strictEqual(opened.r, undefined, 'no player for the claimed video');
      await tick();
      assert.ok(opened.p.disposed, 'its tab closes');
      assert.strictEqual(panels.length, 1, 'compare opened');
      assert.ok(pl.panel.webview && pl.posted && W.executed, 'sanity');
      const cmp = panels[0];
      assert.ok(/"names":\["s_h264\.mp4","rotated\.mp4"\]/.test(cmp.webview.html), 'A is the player, B the clicked video');
      assert.ok(/"start":1\.5/.test(cmp.webview.html), 'compare starts at the player position');
      assert.deepStrictEqual(ctx(), [true, false], 'context key off after one');
      // Not on: the next video opens as usual.
      assert.notStrictEqual(resolve(b).r, undefined, 'mode off: a player opens');

      // In compare: Shift+D adds until full.
      const page = () => Number(/"page":(\d+)/.exec(cmp.webview.html)[1]);
      await cmp.msg({ type: 'addMode', page: page() });
      const hint = cmp.posted.filter((m) => m.type === 'addMode').pop();
      assert.ok(hint && hint.on && hint.multi && hint.n === 2 && hint.max === 4, `compare hint: ${JSON.stringify(hint)}`);
      const c = path.join(dir, 'c.mkv');
      const d = path.join(dir, 'd.webm');
      assert.strictEqual(resolve(c).r, undefined, 'c claimed');
      await tick();
      assert.ok(/"names":\["s_h264\.mp4","rotated\.mp4","c\.mkv"\]/.test(cmp.webview.html), 'c added');
      resolve(b);
      await tick();
      assert.ok(cmp.posted.some((m) => m.type === 'toast' && /in compare already/.test(m.text)), 'a duplicate toasts');
      // Another editor's tab (VS Code's own preview, say) for a video: closed and added.
      tabListener({ opened: [{ input: { uri: W.Uri.file(d), viewType: 'vscode.videoPreview' } }], closed: [], changed: [] });
      await tick();
      assert.strictEqual(closedTabs.length, 1, 'the other editor tab closes');
      assert.ok(/"names":\[[^\]]*"d\.webm"\]/.test(cmp.webview.html), 'd added');
      assert.strictEqual(ctx().pop(), false, 'full: off');
      assert.ok(cmp.posted.some((m) => m.type === 'toast' && /full/.test(m.text)), 'full toast');

      // Esc (the keybinding's command) and the compare closing.
      const two = panels.length;
      await W._commands['videoPreviewEnhanced.compare'](W.Uri.file(a), [W.Uri.file(a), W.Uri.file(b)]);
      const cmp2 = panels[two];
      await cmp2.msg({ type: 'addMode', page: Number(/"page":(\d+)/.exec(cmp2.webview.html)[1]) });
      assert.strictEqual(ctx().pop(), true);
      await W._commands['videoPreviewEnhanced.stopAddFromExplorer']();
      assert.strictEqual(ctx().pop(), false, 'Esc: off');
      assert.ok(cmp2.posted.filter((m) => m.type === 'addMode').pop().on === false, 'Esc hides the hint');
      await cmp2.msg({ type: 'addMode', page: Number(/"page":(\d+)/.exec(cmp2.webview.html)[1]) });
      cmp2.dispose();
      assert.strictEqual(ctx().pop(), false, 'closing compare: off');
      assert.notStrictEqual(resolve(c).r, undefined, 'then videos open as usual');

      // Alt+D: the Explorer selection through Copy Path; the clipboard comes back.
      W.env.clipboard.text = 'kept';
      const exec = W.commands.executeCommand;
      const calls = [];
      W.commands.executeCommand = async (id, ...args) => {
        if (id === 'copyFilePath') { W.env.clipboard.text = [a, path.join(dir, 'notes.txt'), b].join('\r\n'); return undefined; }
        calls.push([id, ...args]);
        return exec(id, ...args);
      };
      await W._commands['videoPreviewEnhanced.compareSelected']();
      W.commands.executeCommand = exec;
      const cmd = calls.find((x) => x[0] === 'videoPreviewEnhanced.compare');
      assert.ok(cmd && cmd[2].length === 2 && cmd[2][1].fsPath === W.Uri.file(b).fsPath, `compare of the selection: ${JSON.stringify(calls.map((x) => x[0]))}`);
      assert.strictEqual(W.env.clipboard.text, 'kept', 'clipboard restored');
    } finally { h2.dispose(); }
// The players opened here keep file watchers: end the process.
})().then(() => { console.log('addmode: ok'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
