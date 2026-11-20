'use strict';
// "Compare with…" quick pick (key D) and dropped videos: row order, recent list, drop parsing, and the commands.
const assert = require('assert');
const path = require('path');
const { pickRows, pushRecent, droppedVideos, RECENT_MAX } = require('../../src/comparepick');
const { load } = require('./mock_vscode');
const { setPickHook } = require('../../src/compare');
const { make } = require('../media/make_cases_media');

// ---- order: same folder first, recent first, natural names, no duplicates, Browse… last ----
const d = 'file:///v/';
const rows = pickRows({
  current: `${d}a.mp4`,
  folder: [`${d}a.mp4`, `${d}clip10.mkv`, `${d}clip2.mkv`, `${d}notes.txt`, `${d}z.webm`],
  workspace: [`${d}clip2.mkv`, 'file:///w/b.mov', 'file:///w/a.mov', 'file:///w/readme.md'],
  recent: ['file:///w/b.mov', `${d}z.webm`],
});
assert.deepStrictEqual(rows.map((r) => r.label), ['Same folder', 'z.webm', 'clip2.mkv', 'clip10.mkv', 'Workspace', 'b.mov', 'a.mov', '', 'Browse…']);
assert.strictEqual(rows[rows.length - 1].kind, 'browse');
assert.deepStrictEqual(pickRows({ current: `${d}a.mp4`, folder: [], workspace: [] }).map((r) => r.kind), ['sep', 'browse'], 'only Browse… without candidates');
assert.deepStrictEqual(pushRecent(['x', 'y', 'z'], 'y'), ['y', 'x', 'z']);
assert.strictEqual(pushRecent(Array.from({ length: RECENT_MAX }, (_, i) => `u${i}`), 'new').length, RECENT_MAX);

// ---- drop data ----
assert.deepStrictEqual(droppedVideos(['file:///v/a.mp4\r\nfile:///v/readme.md\r\n# comment\r\nfile:///v/b.MKV']), ['file:///v/a.mp4', 'file:///v/b.MKV']);
assert.deepStrictEqual(droppedVideos(['["file:///v/a.mp4","file:///v/a.mp4"]', 'not json [', 5]), ['file:///v/a.mp4']);
assert.deepStrictEqual(droppedVideos([]), []);

// ---- the commands ----
(async () => {
  const a = make('s_h264.mp4');
  const b = make('rotated.mp4');
  assert.ok(a && b, 'ffmpeg test clips');
  const folder = path.dirname(a);
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'ffmpeg' } });
  try {
    const V = h.vscode;
    const panels = [];
    V.window.createWebviewPanel = () => {
      const p = { webview: { cspSource: 'x:', asWebviewUri: (u) => u, postMessage() {}, onDidReceiveMessage() {} }, onDidDispose() {}, onDidChangeViewState() {}, dispose() {} };
      panels.push(p);
      return p;
    };
    V.window.showWarningMessage = async () => undefined;
    V.workspace.fs = { readDirectory: async () => [[path.basename(a), 1], [path.basename(b), 1], ['sub', 2], ['x.txt', 1]], writeFile: async () => {} };
    V.workspace.findFiles = async () => [V.Uri.file(path.join(folder, 'other', 'w.mp4'))];
    V.QuickPickItemKind = { Separator: -1 };
    const pick = V._commands['videoPreviewEnhanced.comparePick'];
    assert.ok(pick && V._commands['videoPreviewEnhanced.compareDrop'], 'commands are registered');
    const uriA = V.Uri.file(a);

    let items = null;
    setPickHook(async (it) => { items = it; return it.find((i) => i.uri && i.label === path.basename(b)); });
    await pick(uriA, { t: 1 });
    assert.deepStrictEqual(items.map((i) => i.label), ['Same folder', path.basename(b), 'Workspace', 'w.mp4', '', '$(folder-opened) Browse…'].map((l) => l), 'rows');
    assert.strictEqual(items[0].kind, -1, 'sections are separators');
    assert.strictEqual(panels.length, 1, 'picking a video opens compare');
    assert.deepStrictEqual(V.executed || [], [], 'no dialog command');
    const recent = h.context.globalState.get('videoPreviewEnhanced.compareRecent');
    assert.ok(recent[0] === uriA.toString() && recent[1].includes(path.basename(b)) || recent.length === 2, `recent: ${recent}`);

    // Browse… hands over to Compare With… (the open dialog, several files).
    setPickHook(async (it) => it.find((i) => i.browse));
    await pick(uriA, { t: 2 });
    assert.deepStrictEqual(V.executed.pop().slice(0, 2), ['videoPreviewEnhanced.compareWith', uriA]);
    // Escape: nothing happens.
    setPickHook(async () => undefined);
    await pick(uriA);
    assert.strictEqual(panels.length, 1);

    // A drop: videos only, not the file itself, files only.
    await V._commands['videoPreviewEnhanced.compareDrop'](uriA, ['file:///tmp/readme.md', uriA.toString(), 'http://h/a.mp4'], { t: 0 });
    assert.strictEqual(panels.length, 1, 'nothing usable dropped');
    await V._commands['videoPreviewEnhanced.compareDrop'](uriA, [V.Uri.file(b).toString()], { t: 0 });
    assert.strictEqual(panels.length, 2, 'a dropped video opens compare');
  } finally {
    setPickHook(null);
    h.dispose();
  }
})().then(() => console.log('comparepick: ok'), (e) => { console.error(e); process.exitCode = 1; });
