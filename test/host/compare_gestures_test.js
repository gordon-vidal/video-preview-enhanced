'use strict';
// node test/run.js unit --grep compare_gestures: the Compare gestures of src/extension.js through VS Code's own events
// (the mock vscode with a Tab API): Open Together with a reused preview tab and its leftover tabs; a video that leaves
// holdOpen alone while it is probed never takes back a tab the burst made its viewer; Capture follows the commands in
// the page, takes videos opened in another editor and ends on an editor switch (not while a captured video's tab
// shows); Explorer "Add to Compare" prefers an open Compare; the menus' context keys follow what the active viewer
// shows; a URL viewer takes no dropped video.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.VPE_BURST_MS = '60';
const { load } = require('./mock_vscode');
const { make } = require('../media/make_cases_media');
const unifiedViewer = require('../../src/unified-viewer');
const pkg = require('../../package.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** VS Code's Tab API, one editor group: tabs open, change, close (closing a tab disposes its panel). */
function tabApi(V) {
  const listeners = [];
  let active = null;
  const group = { viewColumn: 1, tabs: [], get activeTab() { return active; } };
  const closed = [];
  const fire = (e) => { for (const fn of listeners) fn({ opened: [], closed: [], changed: [], ...e }); };
  V.window.tabGroups = {
    get all() { return [group]; },
    get activeTabGroup() { return group; },
    onDidChangeTabs: (fn) => { listeners.push(fn); return { dispose() {} }; },
    onDidChangeTabGroups: () => ({ dispose() {} }),
    close: async (tab) => {
      closed.push(tab);
      group.tabs = group.tabs.filter((t) => t !== tab);
      if (tab.panel) tab.panel.dispose();
      fire({ closed: [tab] });
      return true;
    },
  };
  return {
    group, closed, fire,
    /** A new tab in the group, made active, and its event. */
    open(uri, viewType, o = {}) {
      const tab = { input: { uri, viewType }, isPreview: false, group, ...o };
      group.tabs.push(tab);
      active = tab;
      fire({ opened: [tab] });
      return tab;
    },
    activate(tab) { active = tab; fire({ changed: [tab] }); },
  };
}

/** prepareClip (the ffprobe of a file) made slow per file and call: delays[name] = [ms of call 1, call 2, ...]. */
function slowProbe(delays) {
  const real = unifiedViewer.prepareClip;
  const calls = new Map();
  unifiedViewer.prepareClip = async (uri, deps) => {
    const name = path.basename(uri.fsPath);
    const n = calls.get(name) || 0;
    calls.set(name, n + 1);
    const ms = (delays[name] || [])[n] || 0;
    if (ms) await sleep(ms);
    return real(uri, deps);
  };
  return () => { unifiedViewer.prepareClip = real; };
}

(async () => {
  const a = make('s_h264.mp4');
  const b = make('rotated.mp4');
  assert.ok(a && b, 'ffmpeg test clips');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-gestures-'));
  const c = path.join(dir, 'third.mp4');
  const d = path.join(dir, 'fourth.mp4');
  fs.copyFileSync(a, c);
  fs.copyFileSync(b, d);
  const PLAYER = 'videoPreviewEnhanced.player';
  let tabs = null;
  const settings = { 'videoPreviewEnhanced.decoder': 'builtin', 'videoPreviewEnhanced.compare.maxVideos': 4 };
  const h = load({ settings, setup: (v) => { tabs = tabApi(v); } });
  const V = h.vscode;
  const U = (f) => V.Uri.file(f);
  const names = (x) => (x.panel.webview.html ? x.cfg().clips.map((cl) => cl.name) : []);
  const joined = (x) => x.posted.filter((m) => m.type === 'openVideo').map((m) => m.label);
  const shown = (x) => [...names(x), ...joined(x)];
  const gone = (x) => { let g = false; x.panel.onDidDispose(() => { g = true; }); return () => g; };
  const ctx = (key) => ((V.executed || []).filter((e) => e[0] === 'setContext' && e[1] === key).pop() || [])[2];
  /** A video opened in our editor: its tab first (VS Code's order), then resolveCustomEditor. */
  const openPlayer = (file, o) => {
    const tab = tabs.open(U(file), PLAYER, o);
    const x = h.open(file);
    tab.panel = x.panel;
    x.tab = tab;
    return x;
  };
  const closeAll = () => { for (const t of [...tabs.group.tabs]) t.panel && t.panel.dispose(); tabs.group.tabs = []; };
  try {
    // ---- Open Together: Enter on a selection pins the single click's preview tab and opens the others ----
    {
      const pa = openPlayer(a, { isPreview: true }); // a single click: VS Code's preview tab
      await pa.shown;
      await sleep(120); // apart from what follows: on its own
      assert.deepStrictEqual(names(pa), ['s_h264.mp4']);
      const paGone = gone(pa);
      pa.tab.isPreview = false; // Enter on the selection [a, b]: a's tab is pinned (reused), b opens
      tabs.fire({ changed: [pa.tab] });
      const pb = openPlayer(b);
      await pb.shown;
      await sleep(150);
      assert.deepStrictEqual(shown(pb), ['s_h264.mp4', 'rotated.mp4'], 'the reused tab\'s video joins the burst');
      assert.ok(tabs.closed.includes(pa.tab) && paGone(), 'the reused tab is a duplicate now: closed');
      assert.ok(!tabs.closed.includes(pb.tab), 'the viewer\'s own tab stays');
      closeAll();
    }

    // ---- a video that leaves holdOpen alone and is still being probed when the burst takes its tab ----
    for (const [label, delays] of [
      ['the burst finishes first', { 'third.mp4': [400, 0] }],
      ['the burst is still running', { 'third.mp4': [150, 300] }],
    ]) {
      const restore = slowProbe(delays);
      try {
        const p1 = openPlayer(c);
        let pages = 0;
        const html = Object.getOwnPropertyDescriptor(p1.panel.webview, 'html');
        let value = html.value;
        Object.defineProperty(p1.panel.webview, 'html', { get: () => value, set: (x) => { value = x; pages++; }, configurable: true });
        await sleep(25); // c is alone when it leaves holdOpen; d arrives within the window while c is probed
        const p2 = openPlayer(d);
        await Promise.all([p1.shown, p2.shown]);
        await sleep(100);
        assert.deepStrictEqual(shown(p1), ['third.mp4', 'fourth.mp4'], `${label}: one viewer with both, in the first tab`);
        assert.strictEqual(pages, 1, `${label}: the tab got one page, never replaced by a single-video viewer`);
        assert.ok(!p2.panel.webview.html, `${label}: the second tab closed unused`);
      } finally { restore(); }
      closeAll();
      await sleep(100);
    }

    // ---- Capture: commands reach the page; another editor's video is captured; an editor switch ends it ----
    {
      const v = openPlayer(a);
      await v.shown;
      await v.send({ type: 'ready' });
      await sleep(100);
      const captures = () => v.posted.filter((m) => m.type === 'capture').map((m) => m.on);
      await V._commands['videoPreviewEnhanced.addFromExplorer']();
      assert.deepStrictEqual(captures(), [true], 'the Command Palette turns Capture on in the page too');
      assert.strictEqual(ctx('videoPreviewEnhanced.addMode'), true);
      // A video VS Code opens in its own preview (our editor is not its default): the capturing viewer takes it.
      const other = tabs.open(U(b), 'vscode.videoPreview');
      v.panel.active = false;
      await sleep(150);
      assert.ok(tabs.closed.includes(other), 'that tab closes');
      assert.deepStrictEqual(joined(v), ['rotated.mp4'], 'its video joins the capturing viewer');
      assert.strictEqual(ctx('videoPreviewEnhanced.addMode'), true, 'a captured video\'s tab is no editor switch');
      // A video opened in our editor while capturing: its tab shows for a moment; Capture stays on.
      const pc = openPlayer(c);
      await pc.shown;
      await sleep(50);
      assert.deepStrictEqual(joined(v), ['rotated.mp4', 'third.mp4']);
      assert.strictEqual(ctx('videoPreviewEnhanced.addMode'), true, 'still capturing');
      // Back to the viewer's tab: its panel's own "active" may still say false (it lags the tab events).
      tabs.activate(v.tab);
      await sleep(10);
      assert.strictEqual(ctx('videoPreviewEnhanced.addMode'), true, 'its own tab is no editor switch');
      // Then over to Settings (no text editor): Capture ends, and the page is told.
      v.panel.active = true;
      const settingsTab = { input: { viewType: 'workbench.editor.settings2' }, isPreview: false, group: tabs.group };
      tabs.group.tabs.push(settingsTab);
      v.panel.active = false;
      tabs.activate(settingsTab);
      await sleep(10);
      assert.strictEqual(ctx('videoPreviewEnhanced.addMode'), false, 'switching editors ends Capture');
      assert.deepStrictEqual(captures(), [true, false], 'and the page hears it');
      // Esc in VS Code (keybinding: stopAddFromExplorer) after Shift+D in the page.
      v.panel.active = true;
      await v.send({ type: 'capture', on: true });
      await V._commands['videoPreviewEnhanced.stopAddFromExplorer']();
      assert.deepStrictEqual(captures(), [true, false, false], 'Esc in VS Code: off in the page too (no echo of Shift+D)');
      // Stopping Capture while another editor's video is still being probed leaves its tab open.
      await v.send({ type: 'capture', on: true });
      let releaseProbe;
      const probeGate = new Promise((r) => { releaseProbe = r; });
      const realPrep = unifiedViewer.prepareClip;
      unifiedViewer.prepareClip = async (uri, deps) => { await probeGate; return realPrep(uri, deps); };
      let cancelledTab;
      try {
        cancelledTab = tabs.open(U(d), 'vscode.videoPreview');
        await sleep(10);
        assert.ok(!tabs.closed.includes(cancelledTab), 'source tab stays open while probe is in flight');
        await V._commands['videoPreviewEnhanced.stopAddFromExplorer']();
        releaseProbe();
        await sleep(50);
      } finally { unifiedViewer.prepareClip = realPrep; }
      assert.ok(!tabs.closed.includes(cancelledTab), 'source tab stays open when Capture ended mid-probe');
      assert.ok(!joined(v).includes('fourth.mp4'), 'video does not join after Capture ended');
      closeAll();
    }

    // ---- Open Together: virtual-scheme player tabs (git:, vscode-vfs:) never enter a burst ----
    {
      const gitUri = U(a).with({ scheme: 'git' });
      tabs.open(gitUri, PLAYER);
      const pb = openPlayer(b);
      await pb.shown;
      await sleep(150);
      assert.deepStrictEqual(shown(pb), ['rotated.mp4'], 'a git: tab cannot pull the working-tree file into a burst');
      closeAll();
    }

    // ---- Open Together: tabs opened together before any resolveCustomEditor arrives still become one Compare ----
    {
      const cmpPanels = h.autoPanels();
      const t1 = tabs.open(U(a), PLAYER);
      const t2 = tabs.open(U(b), PLAYER);
      const t3 = tabs.open(U(c), PLAYER);
      const t4 = tabs.open(U(d), PLAYER);
      await sleep(200);
      assert.strictEqual(cmpPanels.length, 1, 'opens a Compare panel even when no custom editor panel resolved in time');
      assert.deepStrictEqual(shown(cmpPanels[0]), ['s_h264.mp4', 'rotated.mp4', 'third.mp4', 'fourth.mp4'], 'all four videos in one Compare');
      for (const tb of [t1, t2, t3, t4]) assert.ok(tabs.closed.includes(tb), 'the opened player tabs close');
      cmpPanels[0].panel.dispose();
      closeAll();
    }

    // ---- Explorer "Add to Compare": an open Compare comes before the active single video ----
    {
      const cmpPanels = h.autoPanels();
      await V._commands['videoPreviewEnhanced.compare'](null, [U(a), U(b)]);
      const cmp = cmpPanels[0];
      await cmp.send({ type: 'ready' });
      cmp.panel.active = false;
      cmp.setVisible(false);
      const single = openPlayer(c);
      await single.shown;
      await single.send({ type: 'ready' });
      await sleep(100);
      V.workspace.fs.stat = async () => ({ type: 1 });
      await V._commands['videoPreviewEnhanced.addToCompare'](U(d), [U(d)]);
      assert.deepStrictEqual(shown(cmp), ['s_h264.mp4', 'rotated.mp4', 'fourth.mp4'], 'appended to the open Compare');
      assert.deepStrictEqual(shown(single), ['third.mp4'], 'the active single video is left alone');
      cmp.panel.dispose();
      closeAll();
    }

    // ---- the menus' context keys: what the active viewer shows now, whatever it opened as ----
    {
      const v = openPlayer(a);
      await v.shown;
      await v.send({ type: 'ready' });
      await sleep(100);
      assert.deepStrictEqual([ctx('videoPreviewEnhanced.activeSingle'), ctx('videoPreviewEnhanced.activeCompare')], [true, false], 'one video');
      await v.send({ type: 'compareDrop', uris: [U(b).toString()] });
      assert.deepStrictEqual(joined(v), ['rotated.mp4']);
      assert.deepStrictEqual([ctx('videoPreviewEnhanced.activeSingle'), ctx('videoPreviewEnhanced.activeCompare')], [false, true], 'grown in place: a Compare');
      // F: a webview cannot go fullscreen on its own: Zen Mode, as the old player's fallback.
      await v.send({ type: 'fullscreen' });
      assert.ok((V.executed || []).some((e) => e[0] === 'workbench.action.toggleZenMode'), 'F toggles Zen Mode');
      v.panel.active = false;
      v.setVisible(true);
      assert.deepStrictEqual([ctx('videoPreviewEnhanced.activeSingle'), ctx('videoPreviewEnhanced.activeCompare')], [false, false], 'not active: neither');
      closeAll();
      const menus = Object.values(pkg.contributes.menus).flat();
      const when = (cmd) => menus.filter((m) => m.command === `videoPreviewEnhanced.${cmd}`).map((m) => m.when);
      for (const cmd of ['exportRange', 'copyFfmpegRange', 'exportVideoRange']) assert.deepStrictEqual(when(cmd), ['videoPreviewEnhanced.activeSingle'], cmd);
      assert.deepStrictEqual(when('exportCompareVideoRange'), ['videoPreviewEnhanced.activeCompare']);
      assert.ok(when('addFromExplorer').every((w) => /activeSingle/.test(w) && /activeCompare/.test(w)), 'addFromExplorer: either');
      assert.ok(when('addToCompareFromPlayer').every((w) => /activeSingle/.test(w)), 'Add to Compare: from one video only');
      for (const w of menus.map((m) => m.when || '')) {
        assert.ok(!/activeWebviewPanelId == 'videoPreviewEnhanced\.compare'|activeCustomEditorId == videoPreviewEnhanced\.player\b/.test(w), `stale: ${w}`);
      }
    }

    // ---- a URL viewer takes no dropped video ----
    {
      V.env.clipboard.text = 'https://example.invalid/clip.mp4';
      const url = h.nextPanel();
      await V._commands['videoPreviewEnhanced.openUrl']();
      assert.strictEqual(url.viewType, 'videoPreviewEnhanced.url');
      assert.strictEqual(url.cfg().sourceKind, 'url');
      await url.send({ type: 'ready' });
      await url.send({ type: 'compareDrop', uris: [U(b).toString()] });
      await sleep(50);
      assert.deepStrictEqual(joined(url), [], 'nothing joins a URL');
      url.panel.dispose();
    }
  } finally {
    h.dispose();
  }
})().then(() => { console.log('compare_gestures: ok'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
