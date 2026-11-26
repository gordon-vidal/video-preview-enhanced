'use strict';
// Add from the Explorer (src/addmode.js, docs/notes/compare-ui.md "Add mode"): the rules, then the host with a
// fake VS Code, where it is the viewer's Capture: Shift+D in a viewer, every video opened meanwhile joins it until it
// is full; duplicates toast; the palette command and Esc toggle it; closing the viewer ends it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAddMode, startsInAddMode, addToCompareOrigin } = require('../../src/addmode');
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
  assert.ok(d && d.target === P && !d.dup && !d.stop && d.n === 2, 'first open promotes the player');
  assert.strictEqual(m.start(C, { multi: true, uris: ['a', 'file:///v/b.mp4'] }), 'on');
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
  m.start(C, { multi: true, uris: ['a', 'b'] });
  assert.ok(!m.editorChanged({ isTarget: true }), 'Compare stays active');
  assert.ok(!m.editorChanged({ openingVideo: true }), 'a newly opened video is taken even if its tab becomes active');
  assert.ok(m.editorChanged({}), 'switching to an existing editor ends Add Mode');
  m.start(C, { multi: true, uris: ['a', 'b'] });
  assert.ok(m.sync(C, ['a', 'b', 'c', 'c']) && !m.active, 'capacity also applies to files added by other paths');
}

// ---- which compares start in Add Mode (maintainer decision 2026-11-22: only on explicit add-more intent) ----
{
  const on = (origin, count) => startsInAddMode({ origin, count });
  assert.strictEqual(on('start-single', 1), true, 'right-click Start / Add to Compare on one video: a one-video compare');
  assert.strictEqual(on('start-single', 2), false, 'start-single means a one-video compare');
  assert.strictEqual(on('toolbar-start', 1), true, 'the toolbar Compare button, Start comparison');
  assert.strictEqual(on('armed', 2), true, 'a player armed with Shift+D took its next video: the mode carries on');
  for (const origin of ['burst', 'selection', 'drop', 'pick', 'with', undefined, 'anything-else']) {
    for (const count of [1, 2, 5, 8]) assert.strictEqual(on(origin, count), false, `${origin} (${count} videos) opens with Add Mode off`);
  }
  assert.strictEqual(startsInAddMode(), false, 'nothing known: off');
  assert.strictEqual(on('armed', 0), false, 'nothing to add to');
  // Add to Compare: one file starts a one-video compare; several files, a folder, or a file joining a player do not.
  assert.strictEqual(addToCompareOrigin({ selected: 1, videos: 1, isFile: true, count: 1 }), 'start-single');
  assert.strictEqual(addToCompareOrigin({ selected: 1, videos: 1, isFile: true, count: 2 }), 'selection', 'a file added to a player: two videos');
  assert.strictEqual(addToCompareOrigin({ selected: 2, videos: 2, isFile: false, count: 2 }), 'selection', 'multi-select');
  assert.strictEqual(addToCompareOrigin({ selected: 1, videos: 1, isFile: false, count: 1 }), 'selection', 'a folder with one video');
  assert.strictEqual(addToCompareOrigin({ selected: 1, videos: 6, isFile: false, count: 6 }), 'selection', 'a folder');
}

// ---- the host: Add from the Explorer is the viewer's Capture (src/unified-session.js, src/extension.js) ----
(async () => {
  const a = make('s_h264.mp4');
  const b = make('rotated.mp4');
  assert.ok(a && b, 'ffmpeg test clips');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-addmode-'));
  // More videos to open (any bytes: the built-in decoder reads them only once a page plays them).
  for (const name of ['c.mkv', 'd.webm', 'video-5.mp4']) fs.copyFileSync(a, path.join(dir, name));
  const h2 = load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.compare.maxVideos': 4 } });
  const W = h2.vscode;
  const ctx = () => (W.executed || [])
    .filter(([id, key]) => id === 'setContext' && key === 'videoPreviewEnhanced.addMode').map((c) => c[2]);
  const until = async (ready, label) => {
    const deadline = Date.now() + 5000;
    while (!ready()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const opened = (v) => v.posted.filter((m) => m.type === 'openVideo').map((m) => m.label);
  try {
    // Shift+D in a viewer (its page posts 'capture'), then an Explorer click on another video: it joins that viewer.
    const pl = h2.open(a);
    await pl.send({ type: 'ready' });
    await pl.send({ type: 'capture', on: true });
    assert.strictEqual(ctx().pop(), true, 'context key on');
    const other = h2.open(b);
    await other.shown;
    await until(() => opened(pl).includes('rotated.mp4'), 'b joined');
    assert.strictEqual(other.panel.webview.html, '', 'no viewer for the captured video');
    await new Promise((r) => setTimeout(r, 10));
    // Captured: the new tab closes (its panel's dispose ran).
    assert.ok(!other.panel.webview.html);
    // A duplicate only toasts in the capturing viewer.
    const dup = h2.open(b);
    await dup.shown;
    await until(() => pl.posted.some((m) => m.type === 'toast' && /in compare already/.test(m.text)), 'duplicate shown');
    // Until full (compare.maxVideos): then videos open as usual and capture stops taking them.
    for (const name of ['c.mkv', 'd.webm']) {
      const v = h2.open(path.join(dir, name));
      await v.shown;
      await until(() => opened(pl).includes(name), `${name} joined`);
    }
    const fifth = h2.open(path.join(dir, 'video-5.mp4'));
    await fifth.shown;
    const logText = () => h2.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines.join('\n');
    assert.ok(fifth.panel.webview.html, `a full viewer captures no more: the video gets its own tab\n${logText()}`);
    fifth.panel.dispose();

    // A comparison started from several files at once has Capture off; the palette command and Esc toggle it.
    const cmp = h2.nextPanel();
    await W._commands['videoPreviewEnhanced.compare'](W.Uri.file(a), [W.Uri.file(a), W.Uri.file(b)]);
    assert.deepStrictEqual(cmp.cfg().clips.map((c) => c.name), ['s_h264.mp4', 'rotated.mp4']);
    pl.panel.active = false;
    pl.panel.dispose();
    assert.strictEqual(ctx().pop(), false, 'closing the capturing viewer: off');
    await W._commands['videoPreviewEnhanced.addFromExplorer']();
    assert.strictEqual(ctx().pop(), true, 'the command turns it on in the active viewer');
    await W._commands['videoPreviewEnhanced.stopAddFromExplorer']();
    assert.strictEqual(ctx().pop(), false, 'Esc: off');
    cmp.panel.dispose();
    const later = h2.open(path.join(dir, 'c.mkv'));
    await later.shown;
    assert.ok(later.panel.webview.html, 'then videos open as usual');
    assert.strictEqual(W._commands['videoPreviewEnhanced.compareSelected'], undefined, 'Alt+D command is gone');
  } finally { h2.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
// The viewers opened here keep file watchers: end the process.
})().then(() => { console.log('addmode: ok'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
