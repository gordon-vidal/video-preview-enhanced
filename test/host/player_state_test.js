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

  // 3rd video -> 2x2 grid with compact addSlot in quadrant 4, Split hides
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

  // Capture pauses while another tab is active, and resumes when you switch back to tab 1
  ws = S.toggleCapture(ws, 1).state;
  const whileAway = S.openVideo(ws, 'clip-3', { label: 'shot_03_grade_b.mp4' });
  assert.strictEqual(whileAway.action, 'replaced', 'inactive capturing tab does not hijack opens from another editor');
  assert.deepStrictEqual(S.getTab(whileAway.state, 1).tiles, ['clip-0', 'clip-1']);

  ws = S.selectTab(whileAway.state, 1);
  const added = S.openVideo(ws, 'clip-3');
  assert.strictEqual(added.action, 'added', 'capture resumes automatically when returning to tab 1');
  assert.strictEqual(added.state.activeTabId, 1);
  assert.deepStrictEqual(S.getTab(added.state, 1).tiles, ['clip-0', 'clip-1', 'clip-3']);
}

// ---- 6b. moveTile: order changes, offsets / Spotlight follow the clip; bad slots are a no-op ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0', 'clip-1', 'clip-2'], layout: 'spotlight', spotlightId: 'clip-1' });
  ws = S.nudgeOffset(ws, 'clip-2', 3);
  const moved = S.moveTile(ws, 2, 0);
  assert.deepStrictEqual(S.getTab(moved).tiles, ['clip-2', 'clip-0', 'clip-1']);
  assert.deepStrictEqual(S.getTab(moved).offsets['clip-2'], { unit: 'frames', v: 3 });
  assert.strictEqual(S.getTab(moved).spotlightId, 'clip-1');
  assert.strictEqual(S.moveTile(ws, 1, 1), ws);
  assert.strictEqual(S.moveTile(ws, 0, 3), ws);
  assert.strictEqual(S.moveTile(ws, -1, 0), ws);
}

// ---- 6c. Spotlight defaults, dock and geometry (2 px gap, matches media/compare-grid.js spotlightLayout) ----
{
  const Grid = require('../../media/compare-grid');
  assert.strictEqual(S.HERO_DEFAULT, Grid.SPOTLIGHT_DEFAULT);
  assert.strictEqual(S.GAP, Grid.GAP);
  assert.strictEqual(S.createTab({ id: 1, tiles: ['a', 'b'] }).heroRatio, 0.72, 'Spotlight default is 72 % as in Compare');
  assert.strictEqual(S.createTab({ id: 1, tiles: ['a', 'b'], heroRatio: 0.7 }).heroRatio, 0.7, 'an explicit ratio is kept');

  let ws = S.createWorkspaceState({ tiles: ['a', 'b', 'c'], layout: 'spotlight', spotlightId: 'a' });
  assert.strictEqual(S.getTab(ws).dock, 'top');
  assert.strictEqual(S.setDock(ws, 'diagonal'), ws, 'invalid dock is a no-op');
  assert.strictEqual(S.setDock(ws, 'top'), ws, 'same dock is a no-op');

  // dock top, 800 x 400: main 287 px, 2 px band, strip 111 px split in two by 2 px
  let ui = S.deriveUi(S.getTab(ws), { width: 800, height: 400 });
  assert.deepStrictEqual(ui.cells.map((c) => [c.clipId, c.role, c.x, c.y, c.w, c.h]), [
    ['a', 'hero', 0, 0, 800, 287], ['b', 'strip', 0, 289, 399, 111], ['c', 'strip', 401, 289, 399, 111],
  ]);
  assert.deepStrictEqual(ui.splitter, { orientation: 'horizontal', x: 0, y: 287, w: 800, h: 2, dock: 'top', ratio: 0.72 });

  // dock left, 1000 x 600
  ws = S.setDock(ws, 'left');
  ui = S.deriveUi(S.getTab(ws), { width: 1000, height: 600 });
  assert.deepStrictEqual(ui.cells.map((c) => [c.role, c.x, c.y, c.w, c.h]), [
    ['hero', 0, 0, 719, 600], ['strip', 721, 0, 279, 299], ['strip', 721, 301, 279, 299],
  ]);
  assert.deepStrictEqual(ui.splitter, { orientation: 'vertical', x: 719, y: 0, w: 2, h: 600, dock: 'left', ratio: 0.72 });

  // Every dock: main rect and splitter agree with the production Compare geometry
  for (const dock of S.DOCKS) {
    const t = S.getTab(S.setDock(S.setHeroRatio(ws, 0.6), dock));
    const u = S.deriveUi(t, { width: 1000, height: 600 });
    const g = Grid.spotlightLayout({ order: [0, 1, 2], dock, heroRatio: 0.6, width: 1000, height: 600, gap: 2 });
    const hero = u.cells[0];
    assert.deepStrictEqual([hero.x, hero.y, hero.w, hero.h], [g.rects[0].x, g.rects[0].y, g.rects[0].w, g.rects[0].h], `${dock}: main rect`);
    const sp = /** @type {any} */ (u.splitter);
    if (g.splitter.dir === 'h') assert.strictEqual(sp.y, g.splitter.y + 4, `${dock}: splitter y`);
    else assert.strictEqual(sp.x, g.splitter.x + 4, `${dock}: splitter x`);
    assert.strictEqual(sp.orientation, g.splitter.dir === 'h' ? 'horizontal' : 'vertical');
    for (const c of u.cells.slice(1)) {
      assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 1000 && c.y + c.h <= 600, `${dock}: strip inside the stage`);
      const overlap = c.x < hero.x + hero.w && hero.x < c.x + c.w && c.y < hero.y + hero.h && hero.y < c.y + c.h;
      assert.ok(!overlap, `${dock}: strip does not overlap the main tile`);
    }
  }
  // Grid / Split have no splitter
  assert.strictEqual(S.deriveUi(S.createTab({ id: 1, tiles: ['a', 'b'] }), { width: 800, height: 400 }).splitter, null);

  // Without a stage: same flags and cell order, zero rects (backward compatible call shape)
  const noStage = S.deriveUi(S.getTab(ws));
  assert.strictEqual(noStage.effectiveLayout, 'spotlight');
  assert.deepStrictEqual(noStage.cells.map((c) => [c.clipId, c.role, c.w, c.h]), [['a', 'hero', 0, 0], ['b', 'strip', 0, 0], ['c', 'strip', 0, 0]]);
  assert.strictEqual(S.deriveUi(S.createTab({ id: 1, tiles: ['a'] })).cells[0].role, 'single');

  // Spotlight remembers its tile while promoting; removing down to N = 1 is the plain single player
  ws = S.toggleEnlarge(ws, 'c');
  assert.strictEqual(S.getTab(ws).spotlightId, 'c');
  ws = S.removeTile(ws, 'a').state;
  assert.deepStrictEqual([S.getTab(ws).layout, S.getTab(ws).spotlightId], ['spotlight', 'c'], 'removing a strip tile keeps Spotlight');
  const back = S.removeTile(ws, 'b');
  assert.strictEqual(back.toast, 'Back to single video');
  assert.deepStrictEqual([S.getTab(back.state).layout, S.getTab(back.state).spotlightId], ['grid', null]);
  assert.strictEqual(S.deriveUi(S.getTab(back.state), { width: 640, height: 360 }).cells[0].w, 640);
}

// ---- 6d. setLayout aliases and swapSides ----
{
  let ws = S.createWorkspaceState({ tiles: ['a', 'b'] });
  ws = S.setLayout(ws, 'wipe');
  assert.strictEqual(S.getTab(ws).layout, 'split', "'wipe' is Split");
  ws = S.setLayout(ws, 'side');
  assert.strictEqual(S.getTab(ws).layout, 'grid', "'side' is Grid");
  assert.strictEqual(S.setLayout(ws, 'grid'), ws, 'same layout is a no-op');
  assert.strictEqual(S.setLayout(ws, 'mosaic'), ws, 'unknown layout is a no-op');
  ws = S.setClock(ws, 'b');
  ws = S.setLayout(ws, 'spotlight');
  assert.deepStrictEqual([S.getTab(ws).layout, S.getTab(ws).spotlightId], ['spotlight', 'b'], 'Spotlight enlarges the clock tile');
  assert.deepStrictEqual([S.normalizeLayout('wipe'), S.normalizeLayout('side'), S.normalizeLayout('x')], ['split', 'grid', null]);
  assert.strictEqual(S.createTab({ id: 1, tiles: ['a', 'b'], layout: /** @type {any} */ ('wipe') }).layout, 'split');

  const three = S.createWorkspaceState({ tiles: ['a', 'b', 'c'] });
  assert.strictEqual(S.setLayout(three, 'split'), three, 'Split needs exactly 2');
  const one = S.createWorkspaceState({ tiles: ['a'] });
  assert.strictEqual(S.setLayout(one, 'spotlight'), one, 'Spotlight needs 2');

  ws = S.nudgeOffset(S.setLayout(ws, 'split'), 'b', 2);
  const swapped = S.swapSides(ws);
  assert.deepStrictEqual(S.getTab(swapped).tiles, ['b', 'a']);
  assert.deepStrictEqual(S.getTab(swapped).offsets.b, { unit: 'frames', v: 2 }, 'offset follows the clip');
  assert.deepStrictEqual(S.getTab(S.swapSides(swapped)).tiles, ['a', 'b']);
  assert.strictEqual(S.swapSides(three), three, 'swap is a no-op unless N = 2');
}

// ---- 6e. Clock and sound tiles follow add / remove / replace / leave ----
{
  let ws = S.createWorkspaceState({ tiles: ['a', 'b', 'c'] });
  let t = S.getTab(ws);
  assert.deepStrictEqual([t.clockId, t.soundId], ['a', 'a'], 'default to the first tile');
  assert.strictEqual(S.setClock(ws, 'zzz'), ws, 'clock only on a tile of this tab');
  assert.strictEqual(S.setSound(ws, 'zzz'), ws, 'sound only on a tile of this tab');
  ws = S.setSound(S.setClock(ws, 'b'), 'c');
  t = S.getTab(ws);
  assert.deepStrictEqual([t.clockId, t.soundId], ['b', 'c']);
  ws = S.moveTile(ws, 2, 0);
  assert.deepStrictEqual([S.getTab(ws).clockId, S.getTab(ws).soundId], ['b', 'c'], 'they follow the clip, not the slot');
  ws = S.removeTile(ws, 'b').state;
  t = S.getTab(ws);
  assert.deepStrictEqual([t.tiles, t.clockId, t.soundId], [['c', 'a'], 'c', 'c'], 'removed clock falls back to tiles[0]');
  assert.strictEqual(S.createTab({ id: 1, tiles: [] }).clockId, null);
  assert.strictEqual(S.createTab({ id: 1, tiles: [] }).soundId, null);

  // single-tab replace (folder navigation) moves clock and sound to the new video
  const single = S.replaceVideo(S.createWorkspaceState({ tiles: ['a'] }), 'z');
  assert.deepStrictEqual([S.getTab(single).clockId, S.getTab(single).soundId], ['z', 'z']);
  const opened = S.openVideo(S.createWorkspaceState({ tiles: ['a'] }), 'z').state;
  assert.deepStrictEqual([S.getTab(opened).clockId, S.getTab(opened).offsets], ['z', { z: { unit: 'frames', v: 0 } }]);

  // leaveCompare keeps the clock tile by default, or the one named
  let lw = S.setClock(S.createWorkspaceState({ tiles: ['a', 'b', 'c'] }), 'c');
  lw = S.nudgeOffset(S.toggleSyncMode(lw), 'c', 4);
  const left = S.leaveCompare(lw);
  t = S.getTab(left.state);
  assert.strictEqual(left.toast, 'Back to single video');
  assert.deepStrictEqual([t.tiles, t.clockId, t.soundId, t.layout, t.syncMode], [['c'], 'c', 'c', 'grid', false]);
  assert.deepStrictEqual(t.offsets, { c: { unit: 'frames', v: 0 } }, 'a single player has no offset');
  assert.deepStrictEqual(S.getTab(S.leaveCompare(lw, 'b').state).tiles, ['b']);
  assert.deepStrictEqual(S.getTab(S.leaveCompare(lw, 'nope').state).tiles, ['c'], 'unknown keepId falls back to the clock');
  const solo = S.createWorkspaceState({ tiles: ['a'] });
  assert.strictEqual(S.leaveCompare(solo).state, solo, 'nothing to leave at N = 1');
}

// ---- 6f. replaceTile keeps the slot, resets that offset, remaps references ----
{
  let ws = S.createWorkspaceState({ tiles: ['a', 'b', 'c'], layout: 'spotlight', spotlightId: 'b' });
  ws = S.setSound(S.setClock(ws, 'b'), 'b');
  ws = S.nudgeOffset(S.nudgeOffset(ws, 'b', 5), 'c', -2);
  ws = S.setRemoveConfirm(S.toggleTileStats(ws, 'b'), 'b');
  const r = S.replaceTile(ws, 'b', 'x');
  const t = S.getTab(r);
  assert.deepStrictEqual(t.tiles, ['a', 'x', 'c'], 'same slot');
  assert.deepStrictEqual(t.offsets, { a: { unit: 'frames', v: 0 }, x: { unit: 'frames', v: 0 }, c: { unit: 'frames', v: -2 } });
  assert.deepStrictEqual([t.spotlightId, t.clockId, t.soundId, t.layout], ['x', 'x', 'x', 'spotlight']);
  assert.deepStrictEqual([t.statsOpen, t.removeConfirmId], [[], null]);
  assert.strictEqual(S.replaceTile(ws, 'b', 'c'), ws, 'a video already in the view is a no-op');
  assert.strictEqual(S.replaceTile(ws, 'nope', 'x'), ws, 'unknown tile is a no-op');
  assert.strictEqual(S.replaceTile(ws, 'b', 'b'), ws, 'same video is a no-op');
  // Unrelated references stay put
  const other = S.getTab(S.replaceTile(ws, 'a', 'y'));
  assert.deepStrictEqual([other.tiles, other.spotlightId, other.clockId], [['y', 'b', 'c'], 'b', 'b']);
}

// ---- 6g. Offsets: frames or ms, nudge, set, reset, lossless unit change, formatting ----
{
  // Legacy numeric offsets are coerced to frames
  let ws = S.createWorkspaceState({ tiles: ['a', 'b'], offsets: { a: 3, b: { unit: 'ms', v: -40 }, gone: 9 } });
  let t = S.getTab(ws);
  assert.deepStrictEqual(t.offsets, { a: { unit: 'frames', v: 3 }, b: { unit: 'ms', v: -40 } }, 'numbers become frames; unknown clips drop');
  assert.deepStrictEqual(S.toOffset(2.6), { unit: 'frames', v: 3 });
  assert.deepStrictEqual(S.toOffset(null), { unit: 'frames', v: 0 });
  assert.deepStrictEqual(S.toOffset({ unit: 'ms', v: 1.23456 }), { unit: 'ms', v: 1.235 });

  ws = S.nudgeOffset(ws, 'a', 1);
  ws = S.nudgeOffset(ws, 'b', -1);
  t = S.getTab(ws);
  assert.deepStrictEqual([t.offsets.a, t.offsets.b], [{ unit: 'frames', v: 4 }, { unit: 'ms', v: -50 }], 'frame step / 10 ms step');
  assert.strictEqual(S.nudgeOffset(ws, 'zzz', 1), ws, 'unknown clip is a no-op');
  assert.strictEqual(S.nudgeOffset(ws, 'a', NaN), ws, 'NaN step is a no-op');

  ws = S.setOffset(ws, 'a', 7.4);
  assert.deepStrictEqual(S.getTab(ws).offsets.a, { unit: 'frames', v: 7 }, 'frames are whole');
  ws = S.setOffset(ws, 'b', 12.34567);
  assert.deepStrictEqual(S.getTab(ws).offsets.b, { unit: 'ms', v: 12.346 }, 'ms to 1/1000');
  assert.strictEqual(S.setOffset(ws, 'b', Infinity), ws);
  ws = S.resetOffset(ws, 'b');
  assert.deepStrictEqual(S.getTab(ws).offsets.b, { unit: 'ms', v: 0 }, 'reset keeps the unit');
  assert.strictEqual(S.resetOffset(ws, 'b'), ws, 'already in step');

  // Unit change keeps the moment (the hidden-desktop case: 1 f at 30 fps = 33.333 ms, +10 ms = 43.333 ms)
  let u = S.createWorkspaceState({ tiles: ['a', 'b'] });
  u = S.setOffsetUnit(S.nudgeOffset(u, 'b', 1), 'b', 'ms', 30);
  assert.deepStrictEqual(S.getTab(u).offsets.b, { unit: 'ms', v: 33.333 });
  u = S.nudgeOffset(u, 'b', 1, 30);
  assert.deepStrictEqual(S.getTab(u).offsets.b, { unit: 'ms', v: 43.333 });
  assert.strictEqual(S.setOffsetUnit(u, 'b', 'ms', 30), u, 'same unit is a no-op');
  assert.strictEqual(S.setOffsetUnit(u, 'b', /** @type {any} */ ('s'), 30), u, 'bad unit is a no-op');
  // frames -> ms -> frames is lossless at NTSC rates
  for (const fps of [23.976, 24, 25, 29.97, 30, 59.94, 60]) {
    for (const v of [-37, -1, 0, 1, 2, 5, 120, 1001]) {
      let w = S.setOffset(S.createWorkspaceState({ tiles: ['a', 'b'] }), 'b', v);
      w = S.setOffsetUnit(S.setOffsetUnit(w, 'b', 'ms', fps), 'b', 'frames', fps);
      assert.deepStrictEqual(S.getTab(w).offsets.b, { unit: 'frames', v }, `lossless ${v} f at ${fps}`);
    }
  }
  // Without fps the tab's rate is used
  const tabFps = S.setOffsetUnit(S.nudgeOffset(S.createWorkspaceState({ tiles: ['a', 'b'] }), 'b', 1), 'b', 'ms');
  assert.deepStrictEqual(S.getTab(tabFps).offsets.b, { unit: 'ms', v: 41.667 }, '24 fps default');

  // Formatting matches media/compare-grid.js offText
  const Grid = require('../../media/compare-grid');
  const cases = [
    [{ unit: 'frames', v: 0 }, '0', 'In step'],
    [{ unit: 'frames', v: 1 }, '+1 f', '+1 frame'],
    [{ unit: 'frames', v: 3 }, '+3 f', '+3 frames'],
    [{ unit: 'frames', v: -2 }, '−2 f', '−2 frames'],
    [{ unit: 'ms', v: -40 }, '−40 ms', '−40 ms'],
    [{ unit: 'ms', v: 33.333 }, '+33.3 ms', '+33.3 ms'],
    [{ unit: 'ms', v: 0 }, '0', 'In step'],
  ];
  for (const [o, short, long] of cases) {
    assert.deepStrictEqual(S.formatOffset(/** @type {any} */ (o)), { short, long }, JSON.stringify(o));
    assert.strictEqual(Grid.offText(o), short);
    assert.strictEqual(Grid.offText(o, true), long);
  }
  assert.deepStrictEqual(S.formatOffset(5), { short: '+5 f', long: '+5 frames' }, 'legacy number');
  assert.deepStrictEqual(S.formatOffset(undefined), { short: '0', long: 'In step' });
}

// ---- 6h. Per-tile ephemeral UI: ⓘ details and the remove confirmation ----
{
  let ws = S.createWorkspaceState({ tiles: ['a', 'b', 'c'] });
  ws = S.toggleTileStats(S.toggleTileStats(ws, 'a'), 'c');
  assert.deepStrictEqual(S.getTab(ws).statsOpen, ['a', 'c']);
  assert.deepStrictEqual(S.getTab(S.toggleTileStats(ws, 'a')).statsOpen, ['c'], 'toggle closes');
  assert.strictEqual(S.toggleTileStats(ws, 'zzz'), ws);
  ws = S.removeTile(ws, 'a').state;
  assert.deepStrictEqual(S.getTab(ws).statsOpen, ['c'], 'removed tile drops out');

  ws = S.setRemoveConfirm(ws, 'b');
  assert.strictEqual(S.getTab(ws).removeConfirmId, 'b');
  assert.strictEqual(S.getTab(S.setRemoveConfirm(ws, null)).removeConfirmId, null, 'explicit null');
  assert.strictEqual(S.getTab(S.setRemoveConfirm(ws, 'zzz')).removeConfirmId, null, 'unknown clip disarms');
  assert.strictEqual(S.getTab(S.setLayout(ws, 'spotlight')).removeConfirmId, null, 'layout change disarms');
  assert.strictEqual(S.getTab(S.toggleSplit(ws)).removeConfirmId, null, 'Split toggle disarms');
  const added = S.openVideo(S.toggleCapture(ws).state, 'd').state;
  assert.strictEqual(S.getTab(added).removeConfirmId, 'b', 'adding a tile keeps it');
  assert.strictEqual(S.getTab(S.removeTile(added, 'd').state).removeConfirmId, null, 'any removal disarms');
}

// ---- 6i. Zoom, pan and picture mode ----
{
  let ws = S.createWorkspaceState({ tiles: ['a', 'b'] });
  let t = S.getTab(ws);
  assert.deepStrictEqual([t.zoom, t.panX, t.panY, t.picMode], [1, 0, 0, 'fit']);
  ws = S.setZoom(ws, 2.5, 40, -10);
  ws = S.panBy(ws, 5, 5);
  t = S.getTab(ws);
  assert.deepStrictEqual([t.zoom, t.panX, t.panY], [2.5, 45, -5]);
  assert.strictEqual(S.getTab(S.setZoom(ws, 3)).panX, 45, 'pan kept when omitted');
  assert.strictEqual(S.getTab(S.setZoom(ws, 1000)).zoom, S.ZOOM_MAX);
  assert.strictEqual(S.getTab(S.setZoom(ws, 0)).zoom, S.ZOOM_MIN);
  assert.strictEqual(S.setZoom(ws, NaN), ws);
  assert.strictEqual(S.panBy(ws, 0, NaN), ws);
  ws = S.setPicMode(ws, 'fill');
  t = S.getTab(ws);
  assert.deepStrictEqual([t.picMode, t.zoom, t.panX, t.panY], ['fill', 1, 0, 0], 'a new mode starts at its own size');
  assert.strictEqual(S.setPicMode(ws, 'zoom'), ws, 'unknown mode is a no-op');
  ws = S.resetView(S.setZoom(S.setPicMode(ws, 'actual'), 0.5, 3, 4));
  t = S.getTab(ws);
  assert.deepStrictEqual([t.picMode, t.zoom, t.panX, t.panY], ['actual', 1, 0, 0], 'reset keeps the mode');
}

// ---- 6j. Seeded randomized action sequences: every invariant holds after every step ----
{
  /** mulberry32: a small deterministic PRNG, so a failure names a reproducible seed and step. */
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const CLIPS = Array.from({ length: 12 }, (_, i) => `clip-${i}`);
  const OPS = ['openVideo', 'removeTile', 'moveTile', 'swapSides', 'replaceTile', 'setLayout', 'setDock', 'enlarge',
    'setClock', 'setSound', 'nudgeOffset', 'setOffsetUnit', 'toggleCapture', 'leaveCompare'];
  const LAYOUTS = ['grid', 'spotlight', 'split', 'wipe', 'side', 'bogus'];

  const checkWorkspace = (ws, where) => {
    assert.ok(ws.tabs.some((t) => t.id === ws.activeTabId), `${where}: active tab exists`);
    assert.ok(ws.tabs.filter((t) => t.capture).length <= 1, `${where}: at most one capturing tab`);
    assert.strictEqual(new Set(ws.tabs.map((t) => t.id)).size, ws.tabs.length, `${where}: unique tab ids`);
    for (const t of ws.tabs) {
      assert.deepStrictEqual(S.tabInvariantErrors(t), [], `${where}: tab ${t.id} invariants`);
      assert.ok(t.tiles.length >= 1, `${where}: a tab never empties`);
      const ui = S.deriveUi(t, { width: 960, height: 540 });
      assert.strictEqual(ui.cells.length, t.tiles.length, `${where}: one cell per tile`);
      assert.deepStrictEqual(ui.cells.map((c) => c.clipId).sort(), t.tiles.slice().sort(), `${where}: cells cover the tiles`);
      for (const c of ui.cells) {
        assert.ok(c.x >= 0 && c.y >= 0 && c.w >= 1 && c.h >= 1 && c.x + c.w <= 960 && c.y + c.h <= 540, `${where}: cell inside stage`);
        assert.strictEqual(c.letter, S.TILE_KEYS[t.tiles.indexOf(c.clipId)], `${where}: letter follows the slot`);
      }
      assert.strictEqual(ui.showSplitter, ui.splitter !== null, `${where}: splitter iff Spotlight`);
      if (t.tiles.length === 1) assert.deepStrictEqual([ui.cells[0].role, ui.cells[0].w, ui.cells[0].h], ['single', 960, 540]);
    }
  };

  for (const seed of [1, 2, 3, 0xc0ffee, 20261126]) {
    const rand = rng(seed);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    let ws = S.createWorkspaceState({ tiles: ['clip-0'], capture: true, maxVideos: seed % 2 ? 4 : 8 });
    const counts = {};
    for (let step = 0; step < 500; step++) {
      const t = S.getTab(ws);
      const tile = () => (rand() < 0.9 ? pick(t.tiles) : 'not-a-tile');
      const op = pick(OPS);
      counts[op] = (counts[op] || 0) + 1;
      const before = JSON.stringify(ws);
      let next;
      switch (op) {
        case 'openVideo': next = S.openVideo(ws, pick(CLIPS), { forceNewTab: rand() < 0.05 }).state; break;
        case 'removeTile': next = S.removeTile(ws, tile()).state; break;
        case 'moveTile': next = S.moveTile(ws, Math.floor(rand() * 6) - 1, Math.floor(rand() * 6) - 1); break;
        case 'swapSides': next = S.swapSides(ws); break;
        case 'replaceTile': next = S.replaceTile(ws, tile(), pick(CLIPS)); break;
        case 'setLayout': next = S.setLayout(ws, pick(LAYOUTS)); break;
        case 'setDock': next = S.setDock(ws, pick([...S.DOCKS, 'middle'])); break;
        case 'enlarge': next = S.toggleEnlarge(ws, tile()); break;
        case 'setClock': next = S.setClock(ws, tile()); break;
        case 'setSound': next = S.setSound(ws, tile()); break;
        case 'nudgeOffset': next = S.nudgeOffset(ws, tile(), pick([-3, -1, 1, 2])); break;
        case 'setOffsetUnit': next = S.setOffsetUnit(ws, tile(), pick(['frames', 'ms']), pick([23.976, 25, 29.97, 60])); break;
        case 'toggleCapture': next = S.toggleCapture(ws, rand() < 0.2 ? pick(ws.tabs).id : undefined).state; break;
        case 'leaveCompare': next = rand() < 0.3 ? S.leaveCompare(ws, tile()).state : ws; break;
        default: throw new Error(op);
      }
      assert.strictEqual(JSON.stringify(ws), before, `seed ${seed} step ${step} ${op}: input state not mutated`);
      ws = next;
      // Now and then switch tabs, so capture pausing on an inactive tab is exercised too.
      if (rand() < 0.03) ws = S.selectTab(ws, pick(ws.tabs).id);
      checkWorkspace(ws, `seed ${seed} step ${step} ${op}`);
    }
    for (const op of OPS) assert.ok(counts[op] > 0, `seed ${seed}: ${op} exercised`);
  }
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

// ---- Mixed frame rates: the clock's fps and length follow the clock tile, the moment is kept ----
{
  // A: 24 fps, 2 s (48 frames, maxFrame 47). B: 60 fps, 10 s (600 frames, maxFrame 599).
  const meta = { a: { fps: 24, maxFrame: 47 }, b: { fps: 60, maxFrame: 599 } };
  let ws = S.createWorkspaceState({ tiles: ['a', 'b'], frame: 24 });
  ws = S.syncClockMeta(ws, meta.a);
  let t = S.getTab(ws);
  assert.deepStrictEqual([t.clockId, t.fps, t.maxFrame, t.frame], ['a', 24, 47, 24], 'A sets the clock: 24 fps, 48 frames');
  assert.strictEqual(S.syncClockMeta(ws, meta.a), ws, 'nothing new: the same state');

  ws = S.syncClockMeta(S.setClock(ws, 'b'), meta.b);
  t = S.getTab(ws);
  assert.deepStrictEqual([t.clockId, t.fps, t.maxFrame, t.frame], ['b', 60, 599, 60], 'B sets the clock: 1 s is frame 60 at 60 fps');
  assert.deepStrictEqual(S.tabInvariantErrors(t), []);

  // Past A's end: back on A the clock clamps to A's last frame.
  ws = S.seekFrame(ws, 300); // 5 s
  ws = S.syncClockMeta(S.removeTile(ws, 'b').state, meta.a);
  t = S.getTab(ws);
  assert.deepStrictEqual([t.tiles, t.clockId, t.fps, t.maxFrame, t.frame], [['a'], 'a', 24, 47, 47],
    'back to one tile (A): 5 s is past A\'s 2 s, so its last frame');

  // leaveCompare keeping B, and replaceTile, remap the same way; an explicit frame wins; bad fields are ignored.
  ws = S.openVideo(S.toggleCapture(ws).state, 'b').state;
  ws = S.seekFrame(ws, 12); // 0.5 s on A
  ws = S.syncClockMeta(S.leaveCompare(ws, 'b').state, meta.b);
  t = S.getTab(ws);
  assert.deepStrictEqual([t.tiles, t.fps, t.maxFrame, t.frame], [['b'], 60, 599, 30], 'leave Compare on B: 0.5 s is frame 30');
  ws = S.syncClockMeta(ws, { fps: 30, maxFrame: 99, frame: 7 });
  assert.strictEqual(S.getTab(ws).frame, 7, 'an explicit frame wins');
  ws = S.syncClockMeta(ws, { fps: -1, maxFrame: NaN });
  assert.deepStrictEqual([S.getTab(ws).fps, S.getTab(ws).maxFrame], [30, 99], 'invalid fields keep the tab\'s own');
}

console.log('player_state_test: all assertions passed');
