'use strict';
// node test/run.js unit --grep tile_renderers: the WebGL renderers of a page's video tiles (media/compare-compositor.js
// createTileRenderers). Chromium keeps 16 WebGL contexts per page and loses the oldest beyond that: at most four
// tiles own one, every further tile shares a single one and gets its picture by a 2D copy.
const assert = require('assert');
const { createTileRenderers } = require('../../media/compare-compositor');
const Grid = require('../../media/compare-grid');

let contexts = 0;
const canvas = () => {
  const cv = {
    width: 0, height: 0, kind: null, copies: [],
    getContext(kind) {
      if (cv.kind && cv.kind !== kind) return null;
      cv.kind = kind;
      if (kind === 'webgl2') contexts++;
      return kind === '2d' ? { drawImage: (src) => cv.copies.push([src.width, src.height]) } : {};
    },
  };
  return cv;
};
const doc = { createElement: () => canvas() };

/** Stands in for media/gl-renderer.js GLRenderer: a context per instance, sized pictures, held buffers. */
class FakeRenderer {
  constructor(cv) {
    cv.getContext('webgl2');
    this.cv = cv;
    this.maxPixels = 0;
    this.heldBuf = null;
    this.onUploaded = null;
    this.hdr = 0;
    this.rot = 0;
    this.disposed = false;
  }
  setRotation(deg) { this.rot = deg; }
  drawYuv(f) {
    const c = Grid.capSize(f.width, f.height, this.maxPixels);
    this.cv.width = c.w;
    this.cv.height = c.h;
    if (this.heldBuf && this.heldBuf !== f.buf && this.onUploaded) this.onUploaded(this.heldBuf);
    this.heldBuf = f.buf;
  }
  drawFrame(vf) { this.drawYuv(vf); }
  dispose(opts) {
    this.disposed = true;
    if (opts && opts.loseContext) contexts--;
  }
}

const tiles = createTileRenderers({ doc, Grid });
const cvs = Array.from({ length: 16 }, canvas);
const rs = cvs.map((cv) => tiles.create(FakeRenderer, cv));
assert.strictEqual(contexts, 5, '4 tiles with their own context, 1 shared by the other 12');
assert.strictEqual(tiles.sharedContexts, 1);
assert.ok(rs.slice(0, 4).every((r) => r instanceof FakeRenderer) && rs.slice(4).every((r) => r.gl === null && r.cv));

// A shared tile's picture lands in its own canvas, capped so 16 pictures hold one 4K picture.
const recycled = [];
rs[5].onUploaded = (b) => recycled.push(['F', b]);
rs[6].onUploaded = (b) => recycled.push(['G', b]);
rs[5].drawYuv({ width: 1920, height: 1080, buf: 'f1' });
rs[6].drawYuv({ width: 1920, height: 1080, buf: 'g1' });
rs[5].drawYuv({ width: 1920, height: 1080, buf: 'f2' });
assert.deepStrictEqual([cvs[5].width, cvs[5].height], [960, 540]);
assert.deepStrictEqual(cvs[5].copies, [[960, 540], [960, 540]], 'copied after each picture');
assert.deepStrictEqual(recycled, [['F', 'f1']], 'each tile gets back only its own buffers');
rs[0].drawYuv({ width: 1920, height: 1080, buf: 'a1' });
assert.deepStrictEqual([cvs[0].width, cvs[0].height], [960, 540], 'own renderers are capped as well in a large grid');

// Tiles going: own contexts are released at once (not left to GC), the shared one with its last tile.
for (const r of rs.slice(0, 4)) r.dispose();
assert.strictEqual(contexts, 1);
const again = tiles.create(FakeRenderer, canvas());
assert.ok(again instanceof FakeRenderer, 'a free own slot is used again');
assert.strictEqual(contexts, 2);
for (const r of rs.slice(4)) { r.dispose(); r.dispose(); }
assert.strictEqual(tiles.sharedContexts, 0);
assert.strictEqual(contexts, 1);
again.dispose();
assert.strictEqual(contexts, 0);
rs[5].drawYuv({ width: 64, height: 64, buf: 'x' });
assert.deepStrictEqual(cvs[5].copies.length, 2, 'a gone tile draws nothing');

// Few tiles: no cap.
const few = createTileRenderers({ doc, Grid });
const one = few.create(FakeRenderer, canvas());
one.drawYuv({ width: 1920, height: 1080, buf: 'b' });
assert.deepStrictEqual([one.cv.width, one.cv.height], [1920, 1080]);
console.log('tile_renderers ok');
