'use strict';
// The "Add video" quick pick rows and dropped videos: row order, recent list, drop parsing, and the commands
// that put videos side by side in a viewer (src/extension.js).
const assert = require('assert');
const path = require('path');
const { pickRows, pushRecent, droppedVideos, folderVideos, collectFolderVideos, planAddToCompare, compareTargets, RECENT_MAX } = require('../../src/comparepick');
const { load } = require('./mock_vscode');
const { setPickHook } = require('../../src/comparepick');
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

// ---- editor tab context menu: (uri, { groupId, editorIndex }) and selected tabs ----
{
  const isVideo = (u) => /\.(mp4|mkv|webm)$/i.test(u);
  const tab = (uri, isSelected) => ({ isSelected, input: { uri } });
  const info = { groupId: 0, editorIndex: 1 };
  assert.deepStrictEqual(compareTargets('a.mp4', info, [{ tabs: [tab('a.mp4', false)] }], isVideo), ['a.mp4'], 'single tab');
  assert.deepStrictEqual(compareTargets('a.mp4', info, undefined, isVideo), ['a.mp4'], 'no tab groups API');
  const group = { tabs: [tab('a.mp4', true), tab('n.txt', true), tab('b.mkv', true), tab('x.mp4', false), tab('c.webm', true)] };
  assert.deepStrictEqual(compareTargets('b.mkv', info, [{ tabs: [tab('z.mp4', true)] }, group], isVideo),
    ['a.mp4', 'b.mkv', 'c.webm'], 'selected video tabs in tab order, non-video skipped');
  assert.deepStrictEqual(compareTargets('x.mp4', info, [group], isVideo), ['x.mp4'], 'clicked tab outside the selection');
  assert.deepStrictEqual(compareTargets('a.mp4', ['p.mp4', 'q.mp4'], [group], isVideo), ['p.mp4', 'q.mp4'], 'Explorer array wins');
}

// ---- the folder walk of Compare folder / Add to Compare (src/comparepick.js collectFolderVideos) ----
const walks = (async () => {
  // Recursive subfolder walk: recording/cam1/video.mp4, recording/cam2/video.mp4, recording/cam10/video.mp4.
  {
    const tree = {
      '/rec': [['intro.mp4', 1], ['cam10', 2], ['cam2', 2], ['cam1', 2], ['link-loop', 2 | 64], ['unreadable', 2]],
      '/rec/cam1': [['video.mp4', 1], ['sub', 2]],
      '/rec/cam1/sub': [['deep.mkv', 1]],
      '/rec/cam2': [['video.mp4', 1 | 64], ['notes.txt', 1]],
      '/rec/cam10': [['video.mp4', 1]],
      '/rec/link-loop': [['bad.mp4', 1]],
    };
    const readDir = async (p) => {
      if (p === '/rec/unreadable') throw new Error('EACCES');
      return tree[p] || [];
    };
    const join = (p, name) => `${p}/${name}`;
    assert.deepStrictEqual(
      await collectFolderVideos('/rec', readDir, join),
      ['/rec/intro.mp4', '/rec/cam1/video.mp4', '/rec/cam2/video.mp4', '/rec/cam10/video.mp4',
        '/rec/link-loop/bad.mp4', '/rec/cam1/sub/deep.mkv'],
      'collectFolderVideos walks level by level in natural order, follows symlinked dirs, skips unreadable ones',
    );
    assert.deepStrictEqual(
      await collectFolderVideos('/rec', readDir, join, { maxDepth: 1 }),
      ['/rec/intro.mp4', '/rec/cam1/video.mp4', '/rec/cam2/video.mp4', '/rec/cam10/video.mp4', '/rec/link-loop/bad.mp4'],
      'maxDepth stops deeper recursion',
    );
    assert.deepStrictEqual(
      await collectFolderVideos('/rec', readDir, join, { maxDirs: 2 }),
      ['/rec/intro.mp4', '/rec/cam1/video.mp4'],
      'maxDirs bounds total directories visited',
    );
    // Symlinked subfolder with videos; bare symlink / unknown entries resolved by stat (Docker, FUSE, remote).
    {
      const t = {
        '/r': [['lnk', 2 | 64], ['mnt', 64], ['unk', 0], ['f', 0], ['a.mp4', 1]],
        '/r/lnk': [['x.mp4', 1]], '/r/mnt': [['y.mkv', 1]], '/r/unk': [['z.mov', 1]],
      };
      const rd = async (p) => t[p] || [];
      const st = async (p) => ({ type: p === '/r/f' ? 1 : 2 });
      assert.deepStrictEqual(await collectFolderVideos('/r', rd, join, { stat: st }),
        ['/r/a.mp4', '/r/lnk/x.mp4', '/r/mnt/y.mkv', '/r/unk/z.mov'], 'symlink and unknown dirs are followed');
      assert.deepStrictEqual(await collectFolderVideos('/r', rd, join), ['/r/a.mp4', '/r/lnk/x.mp4'],
        'without stat only flagged directories are followed');
      const logs = [];
      await collectFolderVideos('/r', rd, join, { stat: async () => { throw new Error('boom'); }, log: (m) => logs.push(m) });
      assert.ok(logs.some((m) => /boom/.test(m)), 'stat errors are logged');
    }
    // Cycles: root/loop -> root, a/b -> a, via a realPath that resolves links.
    {
      const real = { '/c/loop': '/c', '/c/a/b': '/c/a', '/c/a/b/b': '/c/a' };
      const t = {
        '/c': [['loop', 2 | 64], ['a', 2], ['top.mp4', 1]],
        '/c/a': [['b', 2 | 64], ['in.mp4', 1]],
      };
      const rd = async (p) => t[real[p] || p] || [];
      const rp = async (p) => real[p] || p;
      assert.deepStrictEqual(await collectFolderVideos('/c', rd, join, { realPath: rp }),
        ['/c/top.mp4', '/c/a/in.mp4'], 'circular symlinks end, no duplicates');
      // No realPath: maxDepth still ends the loop, and no URI is listed twice.
      const seen = await collectFolderVideos('/c', rd, join, { maxDepth: 3 });
      assert.strictEqual(new Set(seen).size, seen.length, 'no duplicate URIs');
    }
    // A deep empty subtree must not starve siblings.
    {
      const rd = async (p) => {
        if (p === '/d') return [['aaa', 2], ['zzz', 2]];
        if (p === '/d/zzz') return [['v.mp4', 1]];
        return p.split('/').length < 14 ? [['n', 2], ['m', 2]] : [];
      };
      assert.deepStrictEqual(await collectFolderVideos('/d', rd, join, { maxDirs: 50 }), ['/d/zzz/v.mp4'],
        'breadth-first: sibling video found before the budget runs out');
    }
  }
})();

// ---- the commands (src/extension.js over the viewer) ----
(async () => {
  await walks;
  const a = make('s_h264.mp4');
  const b = make('rotated.mp4');
  assert.ok(a && b, 'ffmpeg test clips');
  const folder = path.dirname(a);
  const h = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.compare.maxVideos': 4 } });
  try {
    const V = h.vscode;
    const panels = h.autoPanels();
    const names = (p) => p.cfg().clips.map((c) => c.name);
    const joined = (p) => p.posted.filter((m) => m.type === 'openVideo').map((m) => m.label);
    const shown = (p) => [...names(p), ...joined(p)];
    V.window.showWarningMessage = async () => undefined;
    V.workspace.fs.readDirectory = async (u) => (u.toString() === V.Uri.file(folder).toString()
      ? [[path.basename(a), 1], [path.basename(b), 1], ['sub', 2], ['x.txt', 1]]
      : []);
    V.workspace.findFiles = async () => [V.Uri.file(path.join(folder, 'other', 'w.mp4'))];
    V.workspace.asRelativePath = (u) => path.basename(u.fsPath);
    const uriA = V.Uri.file(a);
    const ctx = (key) => ((V.executed || []).filter((c) => c[0] === 'setContext' && c[1] === key).pop() || [])[2] === true;
    // Plain D and its command are gone (maintainer, 2026-11-27); the page's "+ Add video" asks the same rows.
    assert.ok(!V._commands['videoPreviewEnhanced.comparePick'], 'no comparePick command');

    // "+ Add video" in a viewer (pickVideo): the test hook answers from the quick pick's rows; the video joins.
    const viewerA = h.open(a);
    await viewerA.send({ type: 'ready' });
    let items = null;
    setPickHook(async (it) => { items = it; return it.find((i) => i.uri && i.label === path.basename(b)); });
    await viewerA.send({ type: 'pickVideo', exclude: [] });
    assert.deepStrictEqual(items.map((i) => i.label), ['Same folder', path.basename(b), 'Workspace', 'w.mp4', '', '$(list-tree) Click videos in the Explorer…', '$(folder-opened) Browse…'], 'rows');
    assert.strictEqual(items[0].kind, -1, 'sections are separators');
    assert.deepStrictEqual(joined(viewerA), [path.basename(b)], 'the picked video joins the viewer');
    assert.ok(ctx('videoPreviewEnhanced.compareOpen'), 'the compare-open context key is on');
    assert.ok(!ctx('videoPreviewEnhanced.addMode'), 'a picked video joins with Capture off');

    // Browse… goes to the open dialog; cancelled there: nothing. Escape: nothing either.
    let dialogs = 0;
    V.window.showOpenDialog = async () => { dialogs++; return undefined; };
    setPickHook(async (it) => it.find((i) => i.browse));
    await viewerA.send({ type: 'pickVideo', exclude: [] });
    assert.strictEqual(dialogs, 1, 'Browse… opens the dialog');
    setPickHook(async () => undefined);
    await viewerA.send({ type: 'pickVideo', exclude: [] });
    assert.deepStrictEqual(joined(viewerA), [path.basename(b)]);
    setPickHook(null);
    viewerA.panel.dispose();

    // Folder, file and mixed Explorer selections all route through the same command.
    const infos = [];
    V.window.showInformationMessage = async (m) => { infos.push(m); return undefined; };
    const folderUri = V.Uri.file(folder);
    V.workspace.fs.stat = async (uri) => ({ type: uri.toString() === folderUri.toString() ? 2 : 1 });
    const add = V._commands['videoPreviewEnhanced.addToCompare'];
    await V._commands['videoPreviewEnhanced.compareFolder'](folderUri);
    let current = panels.at(-1);
    assert.strictEqual(panels.length, 1, 'the folder opens in one viewer');
    assert.deepStrictEqual(names(current), [path.basename(b), path.basename(a)], 'in natural order');
    assert.deepStrictEqual(infos, [], 'no message for two videos');
    await current.send({ type: 'ready' });
    current.panel.active = true;
    current.setVisible(true); // the viewer becomes the active one
    V.workspace.fs.readDirectory = async (u) => (u.toString() === folderUri.toString()
      ? [[path.basename(a), 1], ['nested.mp4', 2], ['one.mp4', 1], ['x.txt', 1]]
      : []);
    const one = V.Uri.file(path.join(folder, 'one.mp4'));
    require('fs').copyFileSync(a, one.fsPath);
    await add(one, [one, folderUri]);
    assert.strictEqual(panels.length, 1, 'the mixed selection joins the active viewer');
    assert.deepStrictEqual(shown(current), [path.basename(b), path.basename(a), 'one.mp4'], 'folder overlap is skipped');

    // None: said so. Beyond the space: says how many were skipped and adds what fits.
    V.workspace.fs.readDirectory = async () => [];
    await add(folderUri);
    assert.ok(/no videos/.test(infos.pop()), 'none: said so');
    V.workspace.fs.readDirectory = async () => Array.from({ length: 10 }, (_, i) => [`clip${i + 1}.mp4`, 1]);
    for (let i = 1; i <= 10; i++) require('fs').copyFileSync(a, path.join(folder, `clip${i}.mp4`));
    await add(folderUri);
    assert.ok(/skipped 9 videos/.test(infos.pop()), 'reports unique videos beyond the available space');
    assert.ok(shown(current).includes('clip1.mp4') && !shown(current).includes('clip2.mp4'), 'adds what fits');
    current.panel.dispose();

    // A drop on a viewer's page: videos only, files only, not the file itself.
    const dropTo = h.open(a);
    await dropTo.send({ type: 'ready' });
    await dropTo.send({ type: 'compareDrop', uris: ['file:///tmp/readme.md', uriA.toString(), 'http://h/a.mp4',
      'file://share.invalid/videos/a.mp4', 'vscode-remote://ssh-remote+other/a.mp4'] });
    assert.deepStrictEqual(joined(dropTo), [], 'nothing usable dropped');
    await dropTo.send({ type: 'compareDrop', uris: [V.Uri.file(b).toString()] });
    assert.deepStrictEqual(joined(dropTo), [path.basename(b)], 'a dropped video joins the viewer');
    dropTo.panel.dispose();

    // End-to-end compareFolder on a folder whose videos live only in subfolders.
    const recUri = V.Uri.file(path.join(folder, 'recording'));
    const cam1Uri = V.Uri.joinPath(recUri, 'cam1');
    const cam2Uri = V.Uri.joinPath(recUri, 'cam2');
    for (const [dirUri, file] of [[cam1Uri, a], [cam2Uri, b]]) {
      require('fs').mkdirSync(dirUri.fsPath, { recursive: true });
      require('fs').copyFileSync(file, path.join(dirUri.fsPath, path.basename(file)));
    }
    V.workspace.fs.stat = async (u) => ({ type: u.toString() === recUri.toString() ? 2 : 1 });
    V.workspace.fs.readDirectory = async (u) => {
      if (u.toString() === recUri.toString()) return [['cam2', 2], ['cam1', 2]];
      if (u.toString() === cam1Uri.toString()) return [[path.basename(a), 1]];
      if (u.toString() === cam2Uri.toString()) return [[path.basename(b), 1]];
      return [];
    };
    const nested = await V._commands['videoPreviewEnhanced.compareFolder'](recUri);
    assert.deepStrictEqual(nested.session.clips.map((c) => c.uri.toString()),
      [V.Uri.joinPath(cam1Uri, path.basename(a)).toString(), V.Uri.joinPath(cam2Uri, path.basename(b)).toString()],
      'compareFolder opens subfolder videos in natural subfolder order');
    nested.panel.dispose();
  } finally {
    setPickHook(null);
    h.dispose();
    const fs = require('fs');
    fs.rmSync(path.join(folder, 'recording'), { recursive: true, force: true });
    for (const n of ['one.mp4', ...Array.from({ length: 10 }, (_, i) => `clip${i + 1}.mp4`)]) fs.rmSync(path.join(folder, n), { force: true });
  }
})().then(() => { console.log('comparepick: ok'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
