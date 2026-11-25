'use strict';
// Millisecond unit tests for the pure unified player/compare state (media/player-state.js)
// and the reusable real-code mockup harness (tools/mockup/render.js + tools/mockup/fake-engine.js).
const assert = require('assert');
const S = require('../../media/player-state');
const { SAMPLE_CLIPS, createFakeEngine } = require('../../tools/mockup/fake-engine');
const { SCENARIOS, buildMockupHtml } = require('../../tools/mockup/render');

// ---- 1. Single video + Capture ON stays full-width (no empty black half) ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0'], capture: false });
  let ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.strictEqual(ui.n, 1);
  assert.strictEqual(ui.isMulti, false);
  assert.strictEqual(ui.showCC, true);
  assert.strictEqual(ui.showFolderCapsule, true);
  assert.strictEqual(ui.showSplitBtn, false);
  assert.strictEqual(ui.showSyncBtn, false);
  assert.strictEqual(ui.showCaptureBanner, false);
  assert.strictEqual(ui.addSlot, null);
  assert.deepStrictEqual(ui.cells, [{ clipId: 'clip-0', index: 0, letter: 'A', x: 0, y: 0, w: 800, h: 400, role: 'single' }]);

  // Turn Capture ON at N = 1: still full-width, banner appears, no empty right half
  const cap = S.toggleCapture(ws);
  ws = cap.state;
  assert.ok(cap.toast.includes('Compare ready'));
  ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.strictEqual(ui.showCaptureBanner, true);
  assert.strictEqual(ui.cells.length, 1);
  assert.strictEqual(ui.cells[0].w, 800, 'N=1 capture stays full-width');
  assert.strictEqual(ui.addSlot, null, 'N=1 never adds an empty right half');
}

// ---- 2. Opening videos while Capture ON joins into Grid; Capture stays ON ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0'], capture: true });
  const r1 = S.openVideo(ws, 'clip-1', { label: 'shot_01_raw.mov' });
  assert.strictEqual(r1.action, 'added');
  ws = r1.state;

  const tab = S.getTab(ws);
  assert.deepStrictEqual(tab.tiles, ['clip-0', 'clip-1']);
  assert.strictEqual(tab.capture, true, 'capture stays ON after adding 2nd video');

  let ui = S.deriveUi(tab, { width: 800, height: 400 });
  assert.strictEqual(ui.isMulti, true);
  assert.strictEqual(ui.showCC, false);
  assert.strictEqual(ui.showFolderCapsule, false);
  assert.strictEqual(ui.showSplitBtn, true, 'Split Wipe shows at N=2');
  assert.strictEqual(ui.showSyncBtn, true);
  assert.strictEqual(ui.showCaptureBanner, false, 'banner hides once N>=2');
  assert.strictEqual(ui.cells.length, 2);
  assert.deepStrictEqual(ui.cells.map((c) => [c.x, c.w]), [[0, 400], [400, 400]]);

  // Duplicate video is ignored cleanly
  const dup = S.openVideo(ws, 'clip-1', { label: 'shot_01_raw.mov' });
  assert.strictEqual(dup.action, 'duplicate');
  assert.strictEqual(S.getTab(dup.state).tiles.length, 2);

  // 3rd video -> 2x2 grid with spare addSlot in quadrant 4, Split hides
  ws = S.openVideo(ws, 'clip-2', { label: 'shot_02_denoise.mkv' }).state;
  ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.strictEqual(ui.showSplitBtn, false);
  assert.strictEqual(ui.cells.length, 3);
  assert.deepStrictEqual(ui.addSlot, { x: 400, y: 200, w: 400, h: 200 });
}

// ---- 3. Seamless Spotlight enlarge / collapse / swap gesture ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0', 'clip-1', 'clip-2'], capture: true });
  // Enlarge tile B
  ws = S.toggleEnlarge(ws, 'clip-1');
  let ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.strictEqual(ui.effectiveLayout, 'spotlight');
  assert.strictEqual(ui.showSplitter, true);
  assert.strictEqual(ui.cells[0].clipId, 'clip-1');
  assert.strictEqual(ui.cells[0].role, 'hero');
  assert.strictEqual(ui.cells[0].w, 800);
  assert.strictEqual(ui.cells[1].role, 'strip');
  assert.strictEqual(ui.cells[2].role, 'strip');

  // Clicking enlarge on a strip tile promotes it to hero
  ws = S.toggleEnlarge(ws, 'clip-2');
  assert.strictEqual(S.getTab(ws).spotlightId, 'clip-2');

  // Clicking enlarge/collapse on the hero returns to Equal Grid
  ws = S.toggleEnlarge(ws, 'clip-2');
  ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.strictEqual(ui.effectiveLayout, 'grid');
  assert.strictEqual(ui.showSplitter, false);
}

// ---- 4. Split Wipe (N=2 only) + adding 3rd exits Split ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0', 'clip-1'], capture: true });
  ws = S.toggleSplit(ws);
  let ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.strictEqual(ui.effectiveLayout, 'split');
  assert.strictEqual(ui.showDivider, true);
  assert.deepStrictEqual(ui.cells.map((c) => c.role), ['split-a', 'split-b']);
  // The divider spans 0–100 % as in production Compare (media/compare.js setSplit; Home / End).
  assert.strictEqual(S.getTab(S.setSplitRatio(ws, 0)).split, 0);
  assert.strictEqual(S.getTab(S.setSplitRatio(ws, 1)).split, 1);
  assert.strictEqual(S.getTab(S.setSplitRatio(ws, -0.2)).split, 0);
  assert.strictEqual(S.getTab(S.setSplitRatio(ws, 1.7)).split, 1);
  assert.deepStrictEqual([0, 1, 1.5].map((split) => S.createTab({ id: 9, tiles: ['clip-0', 'clip-1'], split }).split), [0, 1, 1]);

  // Adding a 3rd video drops back to Grid
  ws = S.openVideo(ws, 'clip-2').state;
  ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.strictEqual(ui.effectiveLayout, 'grid');
  assert.strictEqual(ui.showDivider, false);
}

// ---- 5. Removing back to N=1 seamlessly restores single-player state ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0', 'clip-1'], capture: true });
  ws = S.toggleSyncMode(ws);
  ws = S.toggleEnlarge(ws, 'clip-0');
  const rem = S.removeTile(ws, 'clip-1');
  ws = rem.state;
  assert.strictEqual(rem.toast, 'Back to single video');
  const tab = S.getTab(ws);
  assert.deepStrictEqual(tab.tiles, ['clip-0']);
  assert.strictEqual(tab.layout, 'grid');
  assert.strictEqual(tab.syncMode, false);
  const ui = S.deriveUi(tab, { width: 800, height: 400 });
  assert.strictEqual(ui.showCC, true);
  assert.strictEqual(ui.showFolderCapsule, true);
  assert.strictEqual(ui.showCaptureBanner, true, 'capture still ON at N=1 shows subtle banner');
}

// ---- 6. Pausing capture sends newly opened videos to a separate tab ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0', 'clip-1'], capture: true });
  ws = S.toggleCapture(ws).state;
  assert.strictEqual(S.getTab(ws).capture, false);

  const opened = S.openVideo(ws, 'clip-2', { label: 'shot_02_denoise.mkv' });
  assert.strictEqual(opened.action, 'opened');
  ws = opened.state;
  assert.strictEqual(ws.tabs.length, 2);
  assert.deepStrictEqual(S.getTab(ws).tiles, ['clip-2']);

  // Turning capture back on in tab 1 captures from tab 2 as well
  ws = S.toggleCapture(ws, 1).state;
  const added = S.openVideo(ws, 'clip-3');
  assert.strictEqual(added.action, 'added');
  assert.strictEqual(added.state.activeTabId, 1);
  assert.deepStrictEqual(S.getTab(added.state, 1).tiles, ['clip-0', 'clip-1', 'clip-3']);
}

// ---- 7. FakeEngine & Mockup Harness smoke tests (all scenarios) ----
{
  const engine = createFakeEngine();
  assert.strictEqual(engine.clips.length, SAMPLE_CLIPS.length);
  assert.strictEqual(engine.getClip('clip-1').name, SAMPLE_CLIPS[1].name);

  for (const key of Object.keys(SCENARIOS)) {
    const html = buildMockupHtml({ scenario: key });
    assert.ok(html.includes('<!DOCTYPE html>'), `${key}: valid HTML doctype`);
    assert.ok(html.includes('VpePlayerState'), `${key}: inlines real media/player-state.js`);
    assert.ok(html.includes('CompareGrid'), `${key}: inlines real media/compare-grid.js`);
    assert.ok(html.includes('VpeControls'), `${key}: inlines real media/controls.js`);
    assert.ok(html.includes('VpeFolderRail'), `${key}: inlines real media/folder-rail.js`);
    assert.ok(html.includes('VpeCtxMenu'), `${key}: inlines real media/ctxmenu.js`);
    assert.ok(html.includes('id="rail"'), `${key}: includes real Folder Rail markup`);
    assert.ok(html.includes('id="panel"'), `${key}: includes real Controls panel markup`);
    assert.ok(html.includes('id="ctxmenu"'), `${key}: includes real Context Menu markup`);
    assert.ok(html.includes('#bar'), `${key}: inlines real player.css + bar.js`);
    assert.ok(html.includes('#cells'), `${key}: inlines real compare.css`);
    assert.ok(html.includes('id="startCompareBtn"'), `${key}: uses real src/bar.js Compare button`);
    const markupOnly = html.slice(0, html.indexOf('<script'));
    assert.ok(!markupOnly.includes('undefined'), `${key}: no stray undefined in generated markup`);
    assert.ok(!/\b\d+(?:\.\d+)?vh\b/i.test(markupOnly), `${key}: no vh units (safe for inline html_render)`);
  }
}

console.log('player_state_test: all assertions passed');
