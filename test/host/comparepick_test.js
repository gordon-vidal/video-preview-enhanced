'use strict';
// "Compare with…" quick pick (key D) and dropped videos: row order, recent list, drop parsing, and the commands.
const assert = require('assert');
const path = require('path');
const { pickRows, pushRecent, droppedVideos, folderVideos, RECENT_MAX } = require('../../src/comparepick');
const { load } = require('./mock_vscode');
const { setPickHook } = require('../../src/compare');
const { make } = require('../media/make_cases_media');

// ---- order: same folder first, recent first, natural names, no duplicates, the Explorer row, Browse… last ----
const d = 'file:///v/';
const rows = pickRows({
  current: `${d}a.mp4`,
  folder: [`${d}a.mp4`, `${d}clip10.mkv`, `${d}clip2.mkv`, `${d}notes.txt`, `${d}z.webm`],
  workspace: [`${d}clip2.mkv`, 'file:///w/b.mov', 'file:///w/a.mov', 'file:///w/readme.md'],
  recent: ['file:///w/b.mov', `${d}z.webm`],
});
assert.deepStrictEqual(rows.map((r) => r.label), ['Same folder', 'z.webm', 'clip2.mkv', 'clip10.mkv', 'Workspace', 'b.mov', 'a.mov', '', 'Click videos in the Explorer…', 'Browse…']);
assert.strictEqual(rows[rows.length - 1].kind, 'browse');
assert.deepStrictEqual(pickRows({ current: `${d}a.mp4`, folder: [], workspace: [] }).map((r) => r.kind), ['sep', 'explorer', 'browse'], 'only the Explorer row and Browse… without candidates');
assert.deepStrictEqual(pushRecent(['x', 'y', 'z'], 'y'), ['y', 'x', 'z']);
assert.strictEqual(pushRecent(Array.from({ length: RECENT_MAX }, (_, i) => `u${i}`), 'new').length, RECENT_MAX);

// ---- drop data ----
assert.deepStrictEqual(droppedVideos(['file:///v/a.mp4\r\nfile:///v/readme.md\r\n# comment\r\nfile:///v/b.MKV']), ['file:///v/a.mp4', 'file:///v/b.MKV']);
assert.deepStrictEqual(droppedVideos(['["file:///v/a.mp4","file:///v/a.mp4"]', 'not json [', 5]), ['file:///v/a.mp4']);
assert.deepStrictEqual(droppedVideos([]), []);

// ---- Compare Videos in Folder: the videos among a folder's names, natural order, at most `max` ----
assert.deepStrictEqual(folderVideos(['clip10.mkv', 'notes.txt', 'Clip2.MKV', 'a.mp4', 'a.mp4', 'sub'], 4),
  { names: ['a.mp4', 'Clip2.MKV', 'clip10.mkv'], total: 3 });
assert.deepStrictEqual(folderVideos(['1.mp4', '2.mp4', '3.mp4', '10.mp4'], 2), { names: ['1.mp4', '2.mp4'], total: 4 }, 'the first max');
assert.deepStrictEqual(folderVideos(['readme.md'], 4), { names: [], total: 0 });
assert.deepStrictEqual(folderVideos(['only.mp4'], 4), { names: ['only.mp4'], total: 1 });
assert.deepStrictEqual(folderVideos(undefined, 4), { names: [], total: 0 });

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
    assert.deepStrictEqual(items.map((i) => i.label), ['Same folder', path.basename(b), 'Workspace', 'w.mp4', '', '$(list-tree) Click videos in the Explorer…', '$(folder-opened) Browse…'].map((l) => l), 'rows');
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

    // Compare Videos in Folder: the folder's videos (natural order) in one compare; fewer than 2: a message.
    const infos = [];
    V.window.showInformationMessage = async (m) => { infos.push(m); return undefined; };
    V.window.tabGroups = { all: [], close: async () => {}, onDidChangeTabs: () => ({ dispose() {} }) };
    const folderUri = V.Uri.file(folder);
    const before = panels.length;
    await V._commands['videoPreviewEnhanced.compareFolder'](folderUri);
    assert.strictEqual(panels.length, before + 1, 'the folder opens in one compare');
    assert.deepStrictEqual(infos, [], 'no message for two videos');
    V.workspace.fs.readDirectory = async () => [['one.mp4', 1], ['x.txt', 1]];
    await V._commands['videoPreviewEnhanced.compareFolder'](folderUri);
    assert.strictEqual(panels.length, before + 1, 'one video: no compare');
    assert.ok(/only 1 video/.test(infos.pop()), 'one video: said so');
    V.workspace.fs.readDirectory = async () => [];
    await V._commands['videoPreviewEnhanced.compareFolder'](folderUri);
    assert.ok(/no videos/.test(infos.pop()), 'none: said so');
    V.workspace.fs.readDirectory = async () => ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`${n}.mp4`, 1]);
    await V._commands['videoPreviewEnhanced.compareFolder'](folderUri);
    assert.strictEqual(panels.length, before + 2, 'more than max: the first max open');
    assert.ok(/6 videos.*first 4/.test(infos.pop()), 'more than max: said so');

    // A drop: videos only, not the file itself, files only.
    await V._commands['videoPreviewEnhanced.compareDrop'](uriA, ['file:///tmp/readme.md', uriA.toString(), 'http://h/a.mp4'], { t: 0 });
    assert.strictEqual(panels.length, before + 2, 'nothing usable dropped');
    await V._commands['videoPreviewEnhanced.compareDrop'](uriA, [V.Uri.file(b).toString()], { t: 0 });
    assert.strictEqual(panels.length, before + 3, 'a dropped video opens compare');
  } finally {
    setPickHook(null);
    h.dispose();
  }
})().then(() => console.log('comparepick: ok'), (e) => { console.error(e); process.exitCode = 1; });
