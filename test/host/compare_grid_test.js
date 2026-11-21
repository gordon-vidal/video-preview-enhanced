'use strict';
// Compare with more than 4 videos (media/compare-grid.js, compare.maxVideos):
// the grid, the per-tile memory, texture and native budgets,
// the host's native frame sizes for 9 and 16 tiles, and that 2-4 tiles keep the budgets they had.
const assert = require('assert');
const path = require('path');
const Grid = require('../../media/compare-grid');
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
