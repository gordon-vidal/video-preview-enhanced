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
const { FRAME_SERVER_BPS, TRANSPORT_BPS } = require('../../src/decide');

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
  // Tile 1 was shown at x 0 and its new slot is x 100: it starts 100 px left of the slot and eases in.
  g.retarget({ 0: { x: 100, y: 0 }, 1: { x: 0, y: 0 } }, { 0: { x: 0, y: 0 }, 1: { x: 100, y: 0 } }, 1000);
  assert.deepStrictEqual(g.offset(1, 1000), { dx: -100, dy: 0 });
  assert.deepStrictEqual(g.offset(0, 1000), { dx: 100, dy: 0 });
  assert.ok(g.active(1090));
  const mid = g.offset(1, 1090).dx;
  assert.ok(mid > -100 && mid < 0, 'half way in time, part of the way in space');
  assert.deepStrictEqual(g.offset(1, 1180), { dx: 0, dy: 0 });
  assert.ok(!g.active(1180), 'done after the duration');
  // Retargeting from where a tile is shown keeps its motion continuous.
  g.retarget({ 2: { x: 0, y: 0 } }, { 2: { x: 0, y: 50 } }, 0);
  const shown = { x: 0, y: 50 + g.offset(2, 60).dy };
  g.retarget({ 2: shown }, { 2: { x: 0, y: 0 } }, 60);
  assert.strictEqual(g.offset(2, 60).dy, shown.y, 'a new target starts where the tile is shown');
  // The tile under the pointer and tiles that stay put do not glide; clear drops everything.
  g.retarget({ 3: { x: 0, y: 0 }, 4: { x: 5, y: 5 } }, { 3: { x: 40, y: 0 }, 4: { x: 5, y: 5.2 } }, 0, 3);
  assert.deepStrictEqual(g.offset(3, 0), { dx: 0, dy: 0 });
  assert.deepStrictEqual(g.offset(4, 0), { dx: 0, dy: 0 });
  g.clear();
  assert.ok(!g.active(60));
  // Reduced motion (duration 0, read on each retarget): tiles jump to their slots.
  let ms = 180;
  const r = Grid.createGlide(() => ms);
  ms = 0;
  r.retarget({ 0: { x: 0, y: 0 } }, { 0: { x: 100, y: 0 } }, 0);
  assert.deepStrictEqual(r.offset(0, 0), { dx: 0, dy: 0 });
  assert.ok(!r.active(0));
}

// ---- the tile header's remove button: 3 videos or more ----
assert.ok(!Grid.canRemoveTile(2) && Grid.canRemoveTile(3) && Grid.canRemoveTile(16));
assert.strictEqual(Grid.removeButtonHtml(2, 1, 'b.mp4', '<svg></svg>'), '', '2 videos: no remove button (Remove leaves Compare)');
for (const n of [3, 4, 9]) {
  const html = Grid.removeButtonHtml(n, 2, 'clip &amp; co.mp4', '<svg></svg>');
  assert.match(html, /^<button class="rm" data-act="remove" data-i="2" /, `${n} videos: a remove button for the tile's video`);
  assert.match(html, /aria-label="Remove clip &amp; co\.mp4 from Compare" title="Remove from Compare"/);
}
{
  const src = require('fs').readFileSync(path.join(__dirname, '../../media/compare.js'), 'utf8');
  assert.match(src, /\(side \? '' : Grid\.removeButtonHtml\(N, i, esc\(names\[i\]\), ICONS\.close\)\)/, 'tile overlays use the remove button');
  assert.match(src, /el\.dataset\.act === 'remove'\) removeTile\(i\)/, 'the button removes through removeTile (the host\'s remove message)');
  // The tiles' click handler stops the click before the stage's play / pause handler sees it.
  assert.match(src, /cellsEl\.addEventListener\('click', \(e\) => \{\s*const el = [^\n]*\n\s*if \(el\) \{\s*e\.stopPropagation\(\);/);
  const css = require('fs').readFileSync(path.join(__dirname, '../../media/compare.css'), 'utf8');
  // Reorder mode keeps × clickable (not inert, not hidden) and the reorder drag ignores a press on it.
  assert.match(css, /#stage\.reordering \.ov > \.rm \{ pointer-events: auto;/);
  assert.doesNotMatch(css, /#stage\.reordering \.rm \{ visibility: hidden; \}/);
  assert.match(src, /x\)\.inert = reordering && !x\.classList\.contains\('rm'\)/, 'only × stays live in Reorder mode');
  assert.match(src, /e\.target\.closest\('\[data-act="move"\], \.rm'\)\) return;/, 'a press on × never starts a reorder drag');
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

// ---- the host: native frame sizes for 9 and 16 tiles in a 1920x1080 stage ----
require('./mock_vscode').load({});
const { CompareSession, fileOfKey, compareHtml, MAX_TILES } = require('../../src/compare');
assert.strictEqual(MAX_TILES, 16);
Array.from(Grid.TILE_KEYS).forEach((k, i) => assert.strictEqual(fileOfKey(k), i));
assert.strictEqual(fileOfKey('sB'), 1);
const video = { width: 1920, height: 1080, fps: 24 };
const fake = (n, tile, link = 'stream') => ({
  tile, liveTransport: link, natives: [], rotation: Array(n).fill(0),
  decisions: Array.from({ length: n }, () => ({ tools: {}, maxHeight: 2160, messageMaxHeight: 1080, probed: { video } })),
});
const heights = (n, tile, link) => CompareSession.prototype.tileHeights.call(fake(n, tile, link));
assert.deepStrictEqual(heights(9, { w: 1920, h: 1080, cols: 3, rows: 3, rate: 1 }), Array(9).fill(360));
assert.deepStrictEqual(heights(16, { w: 1920, h: 1080, cols: 4, rows: 4, rate: 1 }), Array(16).fill(270));
// 2x2 stays as it was (cols 2, rows 2: the stage halved).
assert.deepStrictEqual(heights(4, { w: 1920, h: 1080, cols: 2, rows: 2, rate: 1 }), Array(4).fill(540));
// A rotated tile fits the same cell.
{
  const s = fake(16, { w: 1920, h: 1080, cols: 4, rows: 4, rate: 1 });
  s.rotation[15] = 90;
  assert.strictEqual(CompareSession.prototype.tileHeights.call(s)[15], 150);
}
// Built-in first tile (no ffprobe): the page's aspect fits the cells.
{
  const s = fake(9, { w: 1920, h: 1080, cols: 3, rows: 3, rate: 1, aspect: 4 / 3 });
  s.decisions[0] = null;
  // The 640x360 cell holds A's 4:3 picture at 480x360; a 16:9 tile fitted to that is 480x270.
  assert.strictEqual(CompareSession.prototype.tileHeights.call(s)[1], 270);
  delete s.tile.aspect;
  assert.strictEqual(CompareSession.prototype.tileHeights.call(s)[1], 360, 'without it: the whole cell');
}
// 100 % at 2x speed: every grid stays under the link's budget, even with ffmpeg's even-width rounding.
for (const n of [9, 16]) {
  for (const link of ['stream', 'message']) {
    const hs = heights(n, { w: 1920, h: 1080, cols: Math.ceil(Math.sqrt(n)), rows: Math.ceil(Math.sqrt(n)), rate: 2, actual: true }, link);
    const bytes = hs.reduce((sum, h) => sum + 1.5 * h * (Math.ceil(h * 16 / 9 / 2) * 2) * 24 * 2, 0);
    const budget = link === 'message' ? TRANSPORT_BPS : FRAME_SERVER_BPS;
    assert.ok(bytes <= budget && bytes > budget * 0.9, `${n} tiles over ${link}: ${bytes / 1e6} MB/s of ${budget / 1e6}`);
  }
}

// ---- the page: compare-grid.js always; membudget.js (remote windows' client memory) from 5 videos ----
const uri = (...p) => `https://webview/${p.join('/')}`;
const page = (n) => compareHtml({ uri, cspSource: 'x', nonce: 'n', cfg: { names: Array(n).fill('v.mp4') }, frameSource: '' });
for (let n = 2; n <= 16; n++) {
  const html = page(n);
  const scripts = [...html.matchAll(/<script nonce="n" src="https:\/\/webview\/([^"]+)"><\/script>/g)]
    .map((match) => match[1]);
  for (const [dependency, entry] of [
    ['codec-utils.js', 'engine.js'], ['decoder-boot.js', 'engine.js'], ['compare-compositor.js', 'compare.js'],
  ]) {
    assert.ok(scripts.includes(dependency) && scripts.indexOf(dependency) < scripts.indexOf(entry),
      `${n}: ${dependency} loads with a nonce before ${entry}`);
  }
  assert.ok(html.indexOf('compare-grid.js') > 0 && html.indexOf('compare-grid.js') < html.indexOf('compare.js"'), `${n}: compare-grid.js before compare.js`);
  assert.strictEqual(html.includes('membudget.js'), n > 4, `${n}: membudget.js`);
  assert.strictEqual(html.includes('id="cells" class="dense"'), n > 4, `${n}: dense layout`);
}

// ---- the setting caps what opens and what can be added ----
(async () => {
  // Only the name matters here (nothing is read): the command keeps video files.
  const file = path.join(__dirname, '..', 'media', 'h264_8_1080p.mp4');
  for (const [setting, want] of [[undefined, 8], [4, 4], [9, 9], [16, 16], [40, 16]]) {
    const h = require('./mock_vscode').load({ settings: { 'videoPreviewEnhanced.decoder': 'builtin', ...(setting === undefined ? {} : { 'videoPreviewEnhanced.compare.maxVideos': setting }) } });
    const warnings = [];
    h.vscode.window.showWarningMessage = async (w) => { warnings.push(w); };
    const webview = { cspSource: 'x', asWebviewUri: (u) => u, postMessage() {}, onDidReceiveMessage() {} };
    h.vscode.window.createWebviewPanel = () => ({ webview, onDidDispose() {}, onDidChangeViewState() {} });
    let s;
    try {
      s = await h.vscode._commands['videoPreviewEnhanced.compare'](null, Array(20).fill(h.vscode.Uri.file(file)));
      const cfg = JSON.parse(/<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(webview.html)[1]);
      assert.strictEqual(cfg.names.length, want, `setting ${setting}: opened ${cfg.names.length}`);
      assert.strictEqual(cfg.maxVideos, want);
      assert.ok(warnings.length === 1 && warnings[0].includes(`up to ${want} videos`), `setting ${setting}: ${warnings}`);
      s.addUris([h.vscode.Uri.file(file)]);
      assert.strictEqual(s.names.length, want, 'a full view adds nothing');
      if (want > 2) {
        await s.onMessage({ type: 'remove', index: 0 });
        assert.strictEqual(s.names.length, want - 1);
        s.addUris([h.vscode.Uri.file(file), h.vscode.Uri.file(file)]);
        assert.strictEqual(s.names.length, want, 'adding fills the free slot only');
      }
    } finally {
      if (s) s.dispose();
      h.dispose();
    }
  }
})().then(() => console.log('compare_grid_test: ok'), (e) => { console.error(e); process.exitCode = 1; });
