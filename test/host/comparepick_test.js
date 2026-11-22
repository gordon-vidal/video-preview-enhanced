'use strict';
// "Compare with…" quick pick (key D) and dropped videos: row order, recent list, drop parsing, and the commands.
const assert = require('assert');
const path = require('path');
const { pickRows, pushRecent, droppedVideos, folderVideos, planAddToCompare, RECENT_MAX } = require('../../src/comparepick');
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

// ---- Add to Compare: expand folders before applying capacity to the whole selection ----
assert.deepStrictEqual(folderVideos(['clip10.mkv', 'notes.txt', 'Clip2.MKV', 'a.mp4', 'a.mp4', 'sub']),
  ['a.mp4', 'Clip2.MKV', 'clip10.mkv']);
const choose = (videos, editors) => planAddToCompare({ videos, max: 3, key: String, ...editors });
assert.deepStrictEqual(choose(['a']), { target: undefined, append: false, files: ['a'], skipped: 0 });
const player = { uri: 'a' };
const compare = { uris: ['a', 'b'] };
assert.deepStrictEqual(choose(['a', 'b', 'b', 'c'], { player }), { target: player, append: false, files: ['b', 'c'], skipped: 0 });
assert.deepStrictEqual(choose(['a', 'c', 'c', 'd', 'e'], { player, compare }),
  { target: compare, append: true, files: ['c'], skipped: 2 });
assert.deepStrictEqual(choose(['c'], { compare: { uris: ['a', 'a', 'b'] } }).files, [], 'duplicate tiles still take space');

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
    V.window.createWebviewPanel = (_type, _title, viewColumn) => {
      const p = {
        viewColumn,
        webview: { cspSource: 'x:', asWebviewUri: (u) => u, postMessage() {}, onDidReceiveMessage() {} },
        onDidDispose(fn) { (this.closeListeners ||= []).push(fn); },
        onDidChangeViewState(fn) { (this.viewListeners ||= []).push(fn); },
        activate() { for (const fn of this.viewListeners) fn(); },
        dispose() { for (const fn of this.closeListeners) fn(); },
      };
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
    // Add Mode as the page-context key last had it (src/addmode.js startsInAddMode decides at creation).
    const ctxOn = () => ((V.executed || []).filter((c) => c[0] === 'setContext' && c[1] === 'videoPreviewEnhanced.addMode').pop() || [])[2] === true;

    let items = null;
    setPickHook(async (it) => { items = it; return it.find((i) => i.uri && i.label === path.basename(b)); });
    await pick(uriA, { t: 1 });
    assert.deepStrictEqual(items.map((i) => i.label), ['Same folder', path.basename(b), 'Workspace', 'w.mp4', '', '$(list-tree) Click videos in the Explorer…', '$(folder-opened) Browse…'].map((l) => l), 'rows');
    assert.strictEqual(items[0].kind, -1, 'sections are separators');
    assert.strictEqual(panels.length, 1, 'picking a video opens compare');
    assert.deepStrictEqual((V.executed || []).map(([id]) => id), [], 'a picked pair opens with Add Mode off (no explicit add-more intent)');
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

    // Folder, file and mixed Explorer selections all route through the same command.
    const infos = [];
    V.window.showInformationMessage = async (m) => { infos.push(m); return undefined; };
    V.window.tabGroups = { all: [], close: async () => {}, onDidChangeTabs: () => ({ dispose() {} }) };
    const folderUri = V.Uri.file(folder);
    V.FileType = { Directory: 2 };
    V.workspace.fs.stat = async (uri) => ({ type: uri.toString() === folderUri.toString() ? 2 : 1 });
    const add = V._commands['videoPreviewEnhanced.addToCompare'];
    const [old] = panels;
    old.dispose();
    await V._commands['videoPreviewEnhanced.compareFolder'](folderUri);
    let current = panels.at(-1);
    assert.strictEqual(panels.length, 2, 'the folder opens in one compare');
    assert.ok(!ctxOn(), 'a folder (several files at once) opens with Add Mode off');
    assert.deepStrictEqual(infos, [], 'no message for two videos');
    await V._commands['videoPreviewEnhanced.stopAddFromExplorer']();
    V.workspace.fs.readDirectory = async () => [[path.basename(a), 1], ['nested.mp4', 2], ['one.mp4', 1], ['x.txt', 1]];
    const one = V.Uri.file(path.join(folder, 'one.mp4'));
    await add(one, [one, folderUri]);
    assert.strictEqual(panels.length, 2, 'the mixed selection appends to the existing compare');
    assert.ok(/"names":\["rotated\.mp4","s_h264\.mp4","one\.mp4"\]/.test(current.webview.html), 'folder overlap is skipped');
    assert.ok(!ctxOn(), 'append keeps Add Mode off');
    const other = await V._commands['videoPreviewEnhanced.compare'](uriA, [uriA, V.Uri.file(b)]);
    current.active = true;
    current.activate();
    current.active = false;
    await add(V.Uri.file(path.join(folder, 'recent.mp4')));
    assert.ok(current.webview.html.includes('recent.mp4') && !other.webview.html.includes('recent.mp4'),
      'the most recently active compare receives the selection');
    other.panel.dispose();
    V.workspace.fs.readDirectory = async () => [];
    await add(folderUri);
    assert.ok(/no videos/.test(infos.pop()), 'none: said so');
    V.workspace.fs.readDirectory = async () => Array.from({ length: 10 }, (_, i) => [`clip${i + 1}.mp4`, 1]);
    await add(folderUri);
    assert.ok(/skipped 6 videos/.test(infos.pop()), 'reports unique videos beyond the available space');
    assert.ok(current.webview.html.includes('clip4.mp4') && !current.webview.html.includes('clip5.mp4'), 'adds what fits');
    current.dispose();
    await add(uriA);
    current = panels.at(-1);
    assert.ok(/"names":\["s_h264\.mp4"\]/.test(current.webview.html), 'one file starts a one-tile compare');
    assert.ok(ctxOn(), 'a single video started from the context menu turns Add Mode on');
    await V._commands['videoPreviewEnhanced.stopAddFromExplorer']();
    assert.ok(!ctxOn(), 'Esc: off');
    const multi = await add(V.Uri.file(a), [V.Uri.file(a), V.Uri.file(b)]);
    assert.ok(multi && !ctxOn(), 'several files chosen at once open with Add Mode off');
    multi.panel.dispose();

    // A drop: videos only, not the file itself, files only.
    const before = panels.length;
    await V._commands['videoPreviewEnhanced.compareDrop'](uriA, ['file:///tmp/readme.md', uriA.toString(), 'http://h/a.mp4'], { t: 0 });
    assert.strictEqual(panels.length, before, 'nothing usable dropped');
    const dropped = await V._commands['videoPreviewEnhanced.compareDrop'](uriA, [V.Uri.file(b).toString()], { t: 0 });
    assert.strictEqual(panels.length, before + 1, 'a dropped video opens compare');
    dropped.panel.dispose();
    current.dispose();
    const player = h.open(a);
    player.panel.active = true;
    const promoted = await add(uriA);
    assert.deepStrictEqual(promoted.uris.map(String), [uriA.toString()], 'selecting the active player file promotes it once');
    assert.strictEqual(promoted.panel.viewColumn, player.panel.viewColumn, 'Compare takes the player tab’s group');
    assert.ok(ctxOn(), 'a one-video compare started from a player file starts Add Mode');
    await V._commands['videoPreviewEnhanced.stopAddFromExplorer']();
    promoted.panel.dispose();
    // One file chosen while a player of another video is open makes a two-video compare: no one asked for more.
    const player2 = h.open(b);
    player2.panel.active = true;
    const pair = await add(uriA);
    assert.strictEqual(pair.uris.length, 2, 'the player and the chosen video');
    assert.ok(!ctxOn(), 'a two-video compare from a single right-click opens with Add Mode off');
  } finally {
    setPickHook(null);
    h.dispose();
  }
})().then(() => console.log('comparepick: ok'), (e) => { console.error(e); process.exitCode = 1; });
