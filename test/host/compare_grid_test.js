'use strict';
// Compare with more than 4 videos (media/compare-grid.js, compare.maxVideos):
// the grid, the per-tile memory, texture and native budgets,
// the host's native frame sizes for 9 and 16 tiles, and that 2-4 tiles keep the budgets they had.
const assert = require('assert');
const path = require('path');
const Grid = require('../../media/compare-grid');

assert.deepStrictEqual(Grid.fitRect(10, 20, 100, 100, 2), { x: 10, y: 45, w: 100, h: 50 });
assert.deepStrictEqual(Grid.fitRect(10, 20, 100, 100, 0.5), { x: 35, y: 20, w: 50, h: 100 });
{
  const pictureRect = (_, w, h) => ({ x: -w / 2, y: -h / 2, w: w * 2, h: h * 2 });
  const opts = { width: 202, height: 102, maxTiles: 4, pictureRect };
  const grid = Grid.computeCells({ ...opts, mode: 'grid', order: [2, 0, 1] });
  assert.deepStrictEqual(grid.map(({ x, y, tiles }) => [x, y, tiles]), [
    [0, 0, [2]], [102, 0, [0]], [0, 52, [1]], [102, 52, []],
  ]);
  assert.deepStrictEqual(grid[1].pic, { x: 102, y: 0, w: 100, h: 50 });
  assert.deepStrictEqual(grid[1].full, { x: 52, y: -25, w: 200, h: 100 });
  assert.strictEqual(grid[3].add, true);
  assert.strictEqual(Grid.computeCells({ ...opts, mode: 'grid', order: [2, 0, 1], maxTiles: 3 }).length, 3);
  const side = Grid.computeCells({ ...opts, mode: 'side', order: [1, 0] });
  assert.deepStrictEqual(side.map(({ x, w, tiles }) => [x, w, tiles]), [[0, 100, [1]], [102, 100, [0]]]);
  const split = Grid.computeCells({ ...opts, mode: 'split', order: [1, 0] });
  assert.deepStrictEqual(split.map(({ split, tiles }) => [split, tiles]), [[true, [1, 0]]]);
  assert.strictEqual(Grid.frameFactor(grid, (_, w, h) => ({ w, h })), 2);
  assert.strictEqual(Grid.frameFactor(grid, () => ({ w: 1, h: 1 })), 64);
  assert.strictEqual(Grid.frameFactor(grid, () => ({ w: 0, h: 0 })), 1);
}
assert.strictEqual(Grid.offText(undefined), '0');
assert.strictEqual(Grid.offText({ v: 0 }, true), 'In step');
assert.strictEqual(Grid.offText({ v: 1, unit: 'frames' }, true), '+1 frame');
assert.strictEqual(Grid.offText({ v: 2, unit: 'frames' }, true), '+2 frames');
assert.strictEqual(Grid.offText({ v: 2, unit: 'frames' }), '+2 f');
assert.strictEqual(Grid.offText({ v: -40.24, unit: 'ms' }), '−40.2 ms');
assert.strictEqual(Grid.esc('<a href="b&c">'), '&lt;a href=&quot;b&amp;c&quot;&gt;');
const { budgets } = require('../../media/membudget');

// A raw Compare grid also resumes when the document reveals after VS Code's panel event.
{
  let playing = true;
  let resumeOnShow = false;
  const syncVisibility = Grid.compareVisibility((visible) => {
    if (!visible) { resumeOnShow = resumeOnShow || playing; playing = false; }
    else if (resumeOnShow) { resumeOnShow = false; playing = true; }
  });
  syncVisibility(false, false);
  assert.strictEqual(playing, false, 'hidden panel pauses playback');
  syncVisibility(true, true);
  assert.strictEqual(playing, false, 'visible panel waits for its document');
  syncVisibility(false);
  assert.strictEqual(playing, true, 'the document event resumes playback');
}

// ---- the setting and the grid ----
assert.strictEqual(Grid.TILE_KEYS, 'ABCDEFGHIJKLMNOP');
assert.strictEqual(Grid.MAX_VIDEOS, 16);
const settingInfo = require('../../package.json').contributes.configuration.properties['videoPreviewEnhanced.compare.maxVideos'];
assert.strictEqual(settingInfo.default, 8);
assert.strictEqual(settingInfo.default, Grid.DEFAULT_MAX);
assert.deepStrictEqual([settingInfo.minimum, settingInfo.maximum], [2, Grid.MAX_VIDEOS]);
assert.ok(!settingInfo.tags?.includes('experimental'));
assert.strictEqual(Grid.clampMax(undefined), 8);
assert.strictEqual(Grid.clampMax('x'), 8);
assert.strictEqual(Grid.clampMax(1), 2);
assert.strictEqual(Grid.clampMax(9.7), 9);
assert.strictEqual(Grid.clampMax(99), 16);
assert.ok(!Grid.isLarge(4) && Grid.isLarge(5));
assert.deepStrictEqual(Grid.gridFor(2, 'side'), { cols: 2, rows: 1 });
assert.deepStrictEqual(Grid.gridFor(2, 'split'), { cols: 1, rows: 1 });
for (const n of [3, 4]) assert.deepStrictEqual(Grid.gridFor(n, 'grid'), { cols: 2, rows: 2 });
const grids = ['2x1', '2x2', '2x2', '3x2', '3x2', '3x3', '3x3', '3x3', '4x3', '4x3', '4x3', '4x4', '4x4', '4x4', '4x4'];
for (let n = 2; n <= 16; n++) {
  const { cols, rows } = Grid.gridFor(n, 'grid');
  assert.strictEqual(`${cols}x${rows}`, grids[n - 2], `${n} videos`);
  for (const max of [8, 16]) {
    const hasAdd = n < max && ![2, 4, 6, 9, 12, 16].includes(n);
    assert.strictEqual(Grid.gridCellCount(n, max, cols, rows), n + Number(hasAdd), `${n} videos with limit ${max}`);
  }
}

// ---- display order: insertion, saved sessions and stable video indices ----
assert.deepStrictEqual(Grid.tileOrder(2, undefined, true), [1, 0]);
assert.deepStrictEqual(Grid.tileOrder(4, [2, 2, -1, 4, '1', 0]), [2, 0, 1, 3]);
assert.deepStrictEqual(Grid.moveTile([0, 1], 0, 1), [1, 0]);
for (let n = 2; n <= 16; n++) {
  const initial = Grid.tileOrder(n);
  const moved = Grid.moveTile(initial, 0, n - 1);
  assert.deepStrictEqual(moved, [...initial.slice(1), 0]);
  assert.deepStrictEqual(Grid.moveTile(moved, n - 1, 0), initial);
  assert.strictEqual(Grid.moveTile(moved, 0, -1), moved);
  assert.strictEqual(Grid.moveTile(moved, 0, n), moved);
  assert.strictEqual(Grid.moveTile(moved, 0, 0), moved);
  assert.deepStrictEqual(Grid.tileOrder(n + 1, moved), [...moved, n]);
  assert.deepStrictEqual(Grid.orderAfterRemoval(moved, 1), [...initial.slice(1, -1), 0]);
}

// ---- Reorder drag: live preview from the start order, commit keeps it, cancel restores it ----
{
  const start = [0, 1, 2, 3, 4];
  const drag = Grid.reorderSession(start, 1);
  assert.strictEqual(drag.preview, start, 'nothing moves before the pointer reaches another slot');
  assert.deepStrictEqual(drag.over(3), [0, 2, 3, 1, 4], 'over a later slot: the tiles in between shift up');
  assert.deepStrictEqual(drag.over(0), [1, 0, 2, 3, 4], 'reversing direction previews from the start order');
  assert.strictEqual(drag.over(1), start, 'back over its own slot: the start order');
  assert.strictEqual(drag.over(-1), start, 'off the tiles (the Add cell or a gap): the start order');
  drag.over(4);
  assert.deepStrictEqual(drag.commit(), [0, 2, 3, 4, 1], 'a drop keeps the last preview');
  assert.deepStrictEqual(start, [0, 1, 2, 3, 4], 'the start order is never mutated');
  const cancelled = Grid.reorderSession(start, 4);
  cancelled.over(0);
  assert.strictEqual(cancelled.cancel(), start, 'Esc or leaving Reorder mode: back to the start order');
  assert.strictEqual(cancelled.preview, start);
  assert.strictEqual(Grid.reorderSession(start, 2).commit(), start, 'a click without a move commits nothing');
}

// ---- the tiles' glide: standard easing, FLIP offsets that ease to 0, retargeting mid-flight ----
{
  assert.strictEqual(Grid.easeStandard(0), 0);
  assert.strictEqual(Grid.easeStandard(1), 1);
  assert.strictEqual(Grid.easeStandard(-1), 0);
  assert.strictEqual(Grid.easeStandard(2), 1);
  let prev = 0;
  for (let p = 0.05; p < 1; p += 0.05) {
    const y = Grid.easeStandard(p);
    assert.ok(y >= prev && y <= 1, `monotonic at ${p}`);
    prev = y;
  }
  assert.ok(Grid.easeStandard(0.5) > 0.8, 'decelerating: most of the way by half time');

  const g = Grid.createGlide(180);
  // Full rect FLIP: tile 1 was shown at (0, 0, 200, 100) and moves to (100, 20, 400, 200).
  g.retarget(
    { 0: { x: 100, y: 0, w: 400, h: 200 }, 1: { x: 0, y: 0, w: 200, h: 100 } },
    { 0: { x: 0, y: 0, w: 200, h: 100 }, 1: { x: 100, y: 20, w: 400, h: 200 } },
    1000
  );
  assert.deepStrictEqual(g.offset(1, 1000), { dx: -100, dy: -20, dw: -200, dh: -100 });
  assert.deepStrictEqual(g.offset(0, 1000), { dx: 100, dy: 0, dw: 200, dh: 100 });
  assert.ok(g.active(1090));
  const mid = g.offset(1, 1090);
  assert.ok(mid.dx > -100 && mid.dx < 0 && mid.dw > -200 && mid.dw < 0, 'half way in time, part of the way in rect');
  assert.deepStrictEqual(g.offset(1, 1180), { dx: 0, dy: 0, dw: 0, dh: 0 });
  assert.ok(!g.active(1180), 'done after the duration');
  // Retargeting from where a tile is shown keeps its motion continuous.
  g.retarget({ 2: { x: 0, y: 0 } }, { 2: { x: 0, y: 50 } }, 0);
  const shown = { x: 0, y: 50 + g.offset(2, 60).dy };
  g.retarget({ 2: shown }, { 2: { x: 0, y: 0 } }, 60);
  assert.strictEqual(g.offset(2, 60).dy, shown.y, 'a new target starts where the tile is shown');
  // The tile under the pointer and tiles that stay put do not glide; clear drops everything.
  g.retarget({ 3: { x: 0, y: 0 }, 4: { x: 5, y: 5 } }, { 3: { x: 40, y: 0 }, 4: { x: 5, y: 5.2 } }, 0, 3);
  assert.deepStrictEqual(g.offset(3, 0), { dx: 0, dy: 0, dw: 0, dh: 0 });
  assert.deepStrictEqual(g.offset(4, 0), { dx: 0, dy: 0, dw: 0, dh: 0 });
  g.clear();
  assert.ok(!g.active(60));
  // Reduced motion (duration 0, read on each retarget): tiles jump to their slots.
  let ms = 180;
  const r = Grid.createGlide(() => ms);
  ms = 0;
  r.retarget({ 0: { x: 0, y: 0, w: 100, h: 100 } }, { 0: { x: 100, y: 0, w: 300, h: 200 } }, 0);
  assert.deepStrictEqual(r.offset(0, 0), { dx: 0, dy: 0, dw: 0, dh: 0 });
  assert.ok(!r.active(0));
}

// ---- Spotlight layout (4-sided docking, 10%-90% ratio clamping, edge detection) & stats HUD ----
{
  assert.strictEqual(Grid.clampHeroRatio(0.01), 0.10);
  assert.strictEqual(Grid.clampHeroRatio(0.99), 0.90);
  assert.strictEqual(Grid.clampHeroRatio('bad'), 0.72);
  assert.strictEqual(Grid.clampDock('left'), 'left');
  assert.strictEqual(Grid.clampDock('invalid'), 'top');
  assert.strictEqual(Grid.detectEdgeDock(500, 20, 1000, 500), 'top');
  assert.strictEqual(Grid.detectEdgeDock(500, 480, 1000, 500), 'bottom');
  assert.strictEqual(Grid.detectEdgeDock(40, 250, 1000, 500), 'left');
  assert.strictEqual(Grid.detectEdgeDock(960, 250, 1000, 500), 'right');
  assert.strictEqual(Grid.detectEdgeDock(500, 250, 1000, 500), null);

  for (const dock of ['top', 'bottom', 'left', 'right']) {
    const s = Grid.spotlightLayout({ order: [2, 0, 1], dock, heroRatio: 0.7, width: 1000, height: 600, gap: 2 });
    assert.strictEqual(s.rects[2].hero, true, `${dock}: first in order is Main`);
    assert.strictEqual(s.rects[0].hero, false);
    assert.strictEqual(s.splitter.dir, dock === 'top' || dock === 'bottom' ? 'h' : 'v');
    assert.ok(s.stripBounds && s.stripBounds.w > 0 && s.stripBounds.h > 0, `${dock}: stripBounds`);
    if (dock === 'top') assert.ok(s.rects[2].y < s.stripBounds.y);
    if (dock === 'bottom') assert.ok(s.rects[2].y > s.stripBounds.y);
    if (dock === 'left') assert.ok(s.rects[2].x < s.stripBounds.x);
    if (dock === 'right') assert.ok(s.rects[2].x > s.stripBounds.x);
  }
  const pictureRect = (_, w, h) => ({ x: 0, y: 0, w, h });
  const spotCells = Grid.computeCells({ order: [1, 0, 2], mode: 'spotlight', dock: 'left', heroRatio: 0.6, width: 1000, height: 500, maxTiles: 8, pictureRect });
  assert.strictEqual(spotCells.length, 3, 'spotlight has no empty add cell');
  assert.strictEqual(spotCells[0].hero, true);
  assert.deepStrictEqual(spotCells[0].tiles, [1]);
  assert.ok(spotCells[0].w > spotCells[1].w, 'Main tile is wider at 60% ratio');

  const ref = { w: 1920, h: 1080, fps: 30, frames: 90, codec: 'H264 8b' };
  const diff = Grid.tileStatsRows({ w: 1280, h: 720, fps: 30, frames: 60, codec: 'VP9 8b' }, ref);
  assert.deepStrictEqual(diff.map((r) => [r.key, r.diff]), [['Size', true], ['FPS', false], ['Frames', true], ['Codec', true]]);
}

// ---- the tile header's remove button: 3 videos or more, with inline two-click confirm ----
assert.ok(!Grid.canRemoveTile(2) && Grid.canRemoveTile(3) && Grid.canRemoveTile(16));
assert.strictEqual(Grid.removeButtonHtml(2, 1, 'b.mp4', '×'), '', '2 videos: no remove button (Remove leaves Compare)');
for (const n of [3, 4, 9]) {
  const html = Grid.removeButtonHtml(n, 2, 'clip &amp; co.mp4', '×');
  assert.match(html, /^<button class="tbtn rm" data-act="remove" data-i="2" /, `${n} videos: a remove button for the tile's video`);
  assert.match(html, /aria-label="Remove clip &amp; co\.mp4 from Compare" title="Remove from Compare"/);
  const conf = Grid.removeButtonHtml(n, 2, 'clip &amp; co.mp4', '×', true);
  assert.match(conf, /^<button class="tbtn rm confirm" data-act="remove" data-i="2" /);
  assert.match(conf, />Remove\?<\/button>$/);
}
{
  // The viewer's tiles (media/player-ui.js): a two-click remove from 3 videos on; tile buttons stop before play / pause.
  const src = require('fs').readFileSync(path.join(__dirname, '../../media/player-ui.js'), 'utf8');
  assert.match(src, /if \(n > 2 && confirming\) rm = `<button type="button" class="tbtn rm confirm" data-act="remove"/, 'tile overlays use the two-click remove button');
  assert.match(src, /case 'remove': act\.removeClick\(id\); break;/, 'a tile\'s remove goes through removeClick');
  assert.match(src, /listen\(cellsEl, 'click', [\s\S]{0,400}e\.stopPropagation\(\);/, 'tile button clicks stop before stage play/pause');
  const css = require('fs').readFileSync(path.join(__dirname, '../../media/compare.css'), 'utf8');
  assert.match(css, /#stage\.sync-mode \.sync-pill/, 'sync steppers reveal in sync-mode');
  assert.match(css, /#cmpGroup\.cmp-group/, 'the declarative Compare capsule (src/bar.js #cmpGroup) is styled');
}

// ---- memory: 2-4 tiles exactly as before; 5-16 share fixed budgets ----
for (const gb of [null, 8, 16, 32]) {
  const mem = gb === null ? null : budgets(gb);
  const scale = mem ? Math.min(1, mem.frames / 400e6) : 1;
  for (const n of [2, 3, 4]) {
    const m = Grid.tileMemory(mem, n);
    // The formulas media/compare.js had (tileMem, memScale) until the large grid.
    assert.strictEqual(m.frames, (n <= 2 ? 250e6 : 120e6) * scale, `${gb} GB, ${n} tiles: frames`);
    if (!mem) { assert.strictEqual(m.engine, undefined); continue; }
    assert.deepStrictEqual(m.engine, { ...mem, frames: mem.frames / n, pool: mem.pool / n, workers: Math.max(1, Math.floor(mem.workers / n)), blocks: Math.max(16e6, mem.blocks / n), thumbs: mem.thumbs / n });
  }
  for (const n of [5, 6, 9, 12, 16]) {
    const m = Grid.tileMemory(mem, n);
    // Decoded frames kept by all tiles: what 4 tiles kept (480 MB at 32 GB), never more.
    assert.ok(Math.abs(m.frames * n - 480e6 * scale) < 1, `${gb} GB, ${n} tiles: ${m.frames * n} frame bytes`);
    if (!mem) continue;
    for (const k of ['frames', 'pool', 'batch', 'blocks', 'freeBufs', 'thumbs', 'workers']) {
      assert.ok(m.engine[k] * n <= mem[k] + 1e-6, `${gb} GB, ${n} tiles: ${k} ${m.engine[k]} x ${n} > ${mem[k]}`);
    }
    assert.strictEqual(m.engine.workers, Math.floor(mem.workers / n), 'no extra pool worker each');
  }
}
// 16 tiles at 32 GB: 30 MB of frames each (12 MB at 8 GB).
assert.strictEqual(Grid.tileMemory(budgets(32), 16).frames, 30e6);
assert.strictEqual(Grid.tileMemory(budgets(8), 16).frames, 12e6);

// ---- textures: all tiles together hold at most one 4K picture ----
assert.strictEqual(Grid.texturePixels(4), 0, 'no cap up to 4 tiles');
for (const n of [5, 9, 16]) {
  const max = Grid.texturePixels(n);
  const c = Grid.capSize(3840, 2160, max);
  assert.ok(c.w * c.h <= max && c.w * c.h * n <= 3840 * 2160, `${n} tiles: ${c.w}x${c.h}`);
  assert.ok(Math.abs(c.w / c.h - 16 / 9) < 0.01, 'aspect kept');
}
assert.deepStrictEqual(Grid.capSize(640, 360, Grid.texturePixels(16)), { w: 640, h: 360 }, 'small frames stay');
assert.deepStrictEqual(Grid.capSize(3840, 2160, 0), { w: 3840, h: 2160 });

// ---- native: credits and host queue per tile ----
assert.deepStrictEqual(Grid.nativeCredits(false), { batch: 8, cap: 16 }, 'as before');
assert.deepStrictEqual(Grid.nativeCredits(true), { batch: 2, cap: 4 });
assert.strictEqual(Grid.nativeQueuePerTile(12, 4), 3);
assert.strictEqual(Grid.nativeQueuePerTile(12, 16), 1, 'one frame each at least');
assert.strictEqual(Grid.nativeQueuePerTile(4, 9), 1);
{
  const { NativeDecoder } = require('../../src/native');
  for (const large of [false, true]) {
    const d = { credit: Grid.nativeCredits(large), credits: 0, gen: 3, flushWaiting() {} };
    for (let i = 0; i < 5; i++) NativeDecoder.prototype.more.call(d, { gen: 3 });
    assert.strictEqual(d.credits, large ? 4 : 16, `credits held, large=${large}`);
  }
}

// ---- the host: native frame sizes for 9 and 16 tiles in a 1920x1080 stage (src/unified-viewer.js nativeHeightFor) ----
const { fileOfKey, MAX_TILES } = require('../../src/comparepick');
const { nativeHeightFor } = require('../../src/unified-viewer');
assert.strictEqual(MAX_TILES, 16);
Array.from(Grid.TILE_KEYS).forEach((k, i) => assert.strictEqual(fileOfKey(k), i));
assert.strictEqual(fileOfKey('sB'), 1);
const video = { width: 1920, height: 1080, fps: 24 };
const tileClip = (rotation = 0) => ({ rotation, decision: { tools: {}, maxHeight: 2160, messageMaxHeight: 1080, probed: { video } } });
const heights = (n, tile) => Array.from({ length: n }, () => nativeHeightFor(tileClip(), tile, false));
assert.deepStrictEqual(heights(9, { w: 1920, h: 1080, cols: 3, rows: 3 }), Array(9).fill(360));
assert.deepStrictEqual(heights(16, { w: 1920, h: 1080, cols: 4, rows: 4 }), Array(16).fill(270));
// 2x2 stays as it was (cols 2, rows 2: the stage halved).
assert.deepStrictEqual(heights(4, { w: 1920, h: 1080, cols: 2, rows: 2 }), Array(4).fill(540));
// A turned tile fits the same cell (upright: 270 high on screen is 152 wide, the source's height).
assert.strictEqual(nativeHeightFor(tileClip(90), { w: 1920, h: 1080, cols: 4, rows: 4 }, false), 152);
// 100 % ('actual'): the source's own size, whatever the cell.
assert.deepStrictEqual(heights(16, { w: 1920, h: 1080, cols: 4, rows: 4, actual: true }), Array(16).fill(1080));

// ---- the page: compare-grid.js and membudget.js always (one page for 1 to 16 videos) ----
{
  const { unifiedHtml } = require('../../src/unified-html');
  const html = unifiedHtml({ uri: (...p) => `https://webview/${p.join('/')}`, cspSource: 'x', nonce: 'n', cfg: {}, base: 'b', loader: 'l.js', transport: 'message' });
  const scripts = [...html.matchAll(/<script nonce="n" src="https:\/\/webview\/([^"]+)"><\/script>/g)].map((match) => match[1]);
  for (const [dependency, entry] of [
    ['codec-utils.js', 'engine.js'], ['decoder-boot.js', 'engine.js'], ['compare-compositor.js', 'player-engine-adapter.js'],
    ['compare-grid.js', 'player-ui-tiles.js'],
  ]) {
    assert.ok(scripts.includes(dependency) && scripts.indexOf(dependency) < scripts.indexOf(entry), `${dependency} loads with a nonce before ${entry}`);
  }
  assert.ok(scripts.includes('membudget.js'), 'membudget.js (remote windows size from the client\'s memory)');
}

// ---- the setting caps what opens and what can be added ----
(async () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-grid-'));
  // Distinct files (a video already shown is not added twice); their bytes are never decoded here.
  const files = Array.from({ length: 20 }, (_, i) => { const f = path.join(dir, `v${i + 1}.mp4`); fs.writeFileSync(f, 'x'); return f; });
  try {
    for (const [setting, want] of [[undefined, 8], [4, 4], [9, 9], [16, 16], [40, 16]]) {
      const h = require('./mock_vscode').load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin', ...(setting === undefined ? {} : { 'videoPreviewEnhanced.compare.maxVideos': setting }) } });
      const warnings = [];
      h.vscode.window.showWarningMessage = async (w) => { warnings.push(w); };
      const p = h.nextPanel();
      let v;
      try {
        v = await h.vscode._commands['videoPreviewEnhanced.compare'](null, files.map((f) => h.vscode.Uri.file(f)));
        assert.strictEqual(p.cfg().clips.length, want, `setting ${setting}: opened ${p.cfg().clips.length}`);
        assert.strictEqual(v.session.maxVideos, want);
        assert.ok(warnings.length === 1 && warnings[0].includes(`up to ${want} videos`), `setting ${setting}: ${warnings}`);
        await p.send({ type: 'ready' });
        assert.strictEqual(p.posted.find((m) => m.type === 'sessionState').maxVideos, want, 'the page knows the limit');
        assert.strictEqual(await v.addUri(h.vscode.Uri.file(files[19])), false, 'a full view adds nothing');
        assert.strictEqual(v.session.clips.length, want);
        if (want > 2) {
          // The page closed the first tile; then adding fills the free slot only.
          await p.send({ type: 'tiles', tiles: v.session.order.slice(1) });
          assert.strictEqual(v.session.clips.length, want - 1);
          await v.addUri(h.vscode.Uri.file(files[18]));
          await v.addUri(h.vscode.Uri.file(files[19]));
          assert.strictEqual(v.session.clips.length, want, 'adding fills the free slot only');
        }
      } finally {
        p.panel.dispose();
        h.dispose();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().then(() => console.log('compare_grid_test: ok'), (e) => { console.error(e); process.exitCode = 1; });
