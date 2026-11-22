'use strict';
// node test/host/picture_test.js: picture size maths (media/picture.js): the rectangles of Fit, Fill, Stretch and
// 100 %, zoom around a point, pan and zoom limits, what Z does, and the native frame size each view needs.
const assert = require('assert');
const P = require('../../media/picture');

const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m || ''} ${a} vs ${b}`);
const rect = (r, x, y, w, h, m) => { near(r.x, x, `${m} x`); near(r.y, y, `${m} y`); near(r.w, w, `${m} w`); near(r.h, h, `${m} h`); };

const vid = { w: 1920, h: 1080 };
const view = { w: 1000, h: 800 };

// Modes: names and the cycle.
assert.deepStrictEqual(P.MODES, ['fit', 'fill', 'stretch', 'actual']);
assert.deepStrictEqual(P.MODES.map(P.name), ['Fit', 'Fill', 'Stretch', '100%']);
assert.strictEqual(P.next('fit'), 'fill');
assert.strictEqual(P.next('actual'), 'fit');
assert.strictEqual(P.parse('nonsense'), 'fit');
assert.strictEqual(P.parse('stretch'), 'stretch');

// Fit: the whole picture, bars on the short side (a 16:9 picture in a 1000x800 area: 1000x562.5).
rect(P.rectOf(P.fresh('fit'), vid, vid, view), 0, 118.75, 1000, 562.5, 'fit');
// Fit enlarges a small picture as far as the area allows (object-fit: contain), in the player and in compare.
const small = { w: 320, h: 240 };
rect(P.rectOf(P.fresh('fit'), small, small, view), 0, 25, 1000, 750, 'small fit enlarged');
rect(P.rectOf(P.fresh('fit'), { w: 640, h: 360 }, { w: 640, h: 360 }, { w: 1700, h: 1100 }), 0, 71.875, 1700, 956.25, 'a 640x360 clip fills the width of a 1700x1100 panel');
// ... a downscaled native frame of a larger file gets the same rectangle.
rect(P.rectOf(P.fresh('fit'), { w: 960, h: 540 }, { w: 3840, h: 2160 }, { w: 1700, h: 1100 }), 0, 71.875, 1700, 956.25, 'native frame in Fit');
// A portrait picture in a wide area.
rect(P.rectOf(P.fresh('fit'), { w: 1080, h: 1920 }, { w: 1080, h: 1920 }, view), 275, 0, 450, 800, 'portrait fit');

// Fill: covers the area, centred, the long side cropped.
rect(P.rectOf(P.fresh('fill'), vid, vid, view), -(1422.2222222 - 1000) / 2, 0, 1422.2222222, 800, 'fill');
const f = P.rectOf(P.fresh('fill'), vid, vid, view);
assert.ok(f.w >= view.w && f.h >= view.h - 1e-9 && Math.abs(f.w / f.h - 16 / 9) < 1e-9, 'fill keeps the shape');
// Stretch: exactly the area, shape ignored.
rect(P.rectOf(P.fresh('stretch'), vid, vid, view), 0, 0, 1000, 800, 'stretch');
// 100 %: one video pixel per device pixel (dpr 1: CSS px), half the CSS size at dpr 2.
rect(P.rectOf(P.fresh('actual'), vid, vid, view), (1000 - 1920) / 2, (800 - 1080) / 2, 1920, 1080, 'actual');
rect(P.rectOf(P.fresh('actual'), vid, vid, view, { dpr: 2 }), (1000 - 960) / 2, (800 - 540) / 2, 960, 540, 'actual dpr 2');
// ... also when the canvas holds a smaller native frame (1280x720 of a 4K file): the source decides.
rect(P.rectOf(P.fresh('actual'), { w: 1280, h: 720 }, { w: 3840, h: 2160 }, { w: 5000, h: 3000 }), 580, 420, 3840, 2160, 'actual from a downscaled frame');
// A smaller video than the area at 100 % sits centred.
rect(P.rectOf(P.fresh('actual'), small, small, view), 340, 280, 320, 240, 'actual small');
// An empty area or picture gives nothing (no divide by zero).
assert.deepStrictEqual(P.baseSize('fit', { w: 0, h: 0 }, vid, view), { w: 0, h: 0 });
assert.deepStrictEqual(P.baseSize('fill', vid, vid, { w: 0, h: 0 }), { w: 0, h: 0 });

// Zoom and pan clamp: the picture's edges never come inside the area; smaller than the area stays centred.
let v = { ...P.fresh('fit'), zoom: 3, cx: 0, cy: 0 };
const nat = vid;
let r = P.rectOf(v, nat, vid, view);
near(r.x, 0, 'left edge pinned'); near(r.w, 3000, 'zoomed width');
v = { ...v, cx: 1, cy: 1 };
r = P.rectOf(v, nat, vid, view);
near(r.x + r.w, view.w, 'right edge pinned'); near(r.y + r.h, view.h, 'bottom edge pinned');
r = P.rectOf({ ...P.fresh('fit'), cx: 0.1 }, nat, vid, view);
near(r.x, 0, 'a picture that fits cannot be panned');
// Zoom limits: not below the mode's size (except 100 %), not above 64 device pixels per video pixel.
const o = {};
assert.strictEqual(P.zoomAt(P.fresh('fit'), 0.2, 500, 400, nat, vid, view, o).zoom, 1);
near(P.zoomAt(P.fresh('actual'), 0.01, 500, 400, nat, vid, view, o).zoom, 1 / 16, 'actual min');
near(P.zoomAt(P.fresh('actual'), 1000, 500, 400, nat, vid, view, o).zoom, 64, 'actual max 64x the video');
const fitBase = P.baseSize('fit', nat, vid, view, o);
near(P.zoomAt(P.fresh('fit'), 1e6, 500, 400, nat, vid, view, o).zoom, (64 * 1920) / fitBase.w, 'fit max');
// Zoom around a point keeps that picture point under it.
const before = P.rectOf(P.fresh('fit'), nat, vid, view, o);
const px = 700, py = 300;
const u = (px - before.x) / before.w, t = (py - before.y) / before.h;
const z1 = P.zoomAt(P.fresh('fit'), 4, px, py, nat, vid, view, o);
const after = P.rectOf(z1, nat, vid, view, o);
near(after.x + u * after.w, px, 'x stays under the cursor');
// (y: the fitted picture is 562 high and the zoomed one 2250, so it can stay under the cursor)
near(after.y + t * after.h, py, 'y stays under the cursor');
// Zooming again from there keeps the point too.
const z2 = P.zoomAt(z1, 8, px, py, nat, vid, view, o);
const a2 = P.rectOf(z2, nat, vid, view, o);
near(a2.x + u * a2.w, px, 'x stays (second zoom)');
// Zooming in at a corner of the picture, the edge cannot come inside.
const corner = P.zoomAt(P.fresh('fit'), 4, 0, 0, nat, vid, view, o);
near(P.rectOf(corner, nat, vid, view, o).x, 0, 'corner zoom keeps the left edge');
// Pan by dragging: dragging right moves the picture right (the middle point moves left), clamped at the edge.
const pz = P.zoomAt(P.fresh('fit'), 4, 500, 400, nat, vid, view, o);
const r0 = P.rectOf(pz, nat, vid, view, o);
const r1 = P.rectOf(P.panBy(pz, 100, 50, nat, vid, view, o), nat, vid, view, o);
near(r1.x, r0.x + 100, 'dragged right'); near(r1.y, r0.y + 50, 'dragged down');
const far = P.rectOf(P.panBy(pz, 1e6, 1e6, nat, vid, view, o), nat, vid, view, o);
near(far.x, 0, 'drag clamped'); near(far.y, 0, 'drag clamped');
// Fill can be panned along the cropped side only.
const fp = P.panBy(P.fresh('fill'), 100, 100, nat, vid, view);
const fr = P.rectOf(fp, nat, vid, view);
near(fr.y, 0, 'fill: nothing to pan vertically'); near(fr.x, -(1422.2222222 - 1000) / 2 + 100, 'fill: panned along the crop');
// Compare: a tile that fits its cell can start a pan while another overflows; the overflowing tile sets the pace.
const fits = { w: 400, h: 300, full: { w: 400, h: 300 }, tiles: [0] };
const over = { w: 400, h: 300, full: { w: 1200, h: 900 }, tiles: [1] };
const addCell = { w: 400, h: 300, full: { w: 1200, h: 900 }, add: true, tiles: [] };
assert.ok(!P.overflows(fits) && P.overflows(over) && !P.overflows(addCell), 'overflow: only a picture larger than its cell');
assert.strictEqual(P.panCell([fits, over], fits), over, 'a fitting tile pans by the overflowing one');
assert.strictEqual(P.panCell([fits, over], over), over, 'an overflowing tile pans by itself');
assert.strictEqual(P.panCell([fits, fits], fits), null, 'nothing overflows: no pan');
assert.strictEqual(P.panCell([addCell, fits], fits), null, 'the Add cell never counts');
// 100 % of a large picture pans; the pan survives a resize through clamp().
const big = P.panBy(P.fresh('actual'), 5000, 0, nat, vid, view);
near(P.rectOf(big, nat, vid, view).x, 0, '100 %: left edge pinned');
const kept = P.clamp({ mode: 'actual', zoom: 1, cx: 0.9, cy: 0.5 }, nat, vid, { w: 2500, h: 1500 });
near(kept.cx, 0.5, 'a view that now holds the picture is centred again');

// Lockstep: the same view in two tiles of different shapes shows the same part of each picture.
const tileA = { nat: { w: 1920, h: 1080 }, view: { w: 600, h: 400 } };
const tileB = { nat: { w: 1280, h: 960 }, view: { w: 600, h: 400 } };
const shared = P.zoomAt(P.fresh('fit'), 5, 450, 120, tileA.nat, tileA.nat, tileA.view, o);
const mid = (tile) => { const rr = P.rectOf(shared, tile.nat, tile.nat, tile.view, o); return [(tile.view.w / 2 - rr.x) / rr.w, (tile.view.h / 2 - rr.y) / rr.h]; };
const ma = mid(tileA), mb = mid(tileB);
near(ma[0], mb[0], 'same relative x'); near(ma[1], mb[1], 'same relative y');
near(P.rectOf(shared, tileB.nat, tileB.nat, tileB.view, o).w / P.baseSize('fit', tileB.nat, tileB.nat, tileB.view, o).w, 5, 'same relative zoom');

// Z: plain modes cycle; a zoomed view goes back to Fit first.
let cyc = P.fresh('fit');
const seen = [];
for (let i = 0; i < 5; i++) { seen.push(cyc.mode); cyc = P.cycle(cyc); }
assert.deepStrictEqual(seen, ['fit', 'fill', 'stretch', 'actual', 'fit']);
assert.deepStrictEqual(P.cycle({ mode: 'fill', zoom: 2, cx: 0.5, cy: 0.5 }), P.fresh('fit'), 'zoomed: Z is back to Fit');
assert.deepStrictEqual(P.cycle({ mode: 'actual', zoom: 1, cx: 0.7, cy: 0.5 }), P.fresh('fit'), 'panned: back to Fit');
assert.strictEqual(P.plain(P.fresh('fill')), true);
assert.strictEqual(P.plain({ mode: 'fit', zoom: 2, cx: 0.5, cy: 0.5 }), false);

// Percent: video pixels per device pixel.
assert.strictEqual(P.percent({ w: 1920 }, vid), 100);
assert.strictEqual(P.percent({ w: 960 }, vid, 2), 100);
assert.strictEqual(P.percent({ w: 3840 }, vid), 200);

// Native frames: the plain Fit leaves it to the area; others ask for a picture covering their rectangle at the video's shape.
assert.strictEqual(P.frameNeed(P.fresh('fit'), P.rectOf(P.fresh('fit'), nat, vid, view, o), nat), null);
const fill = P.frameNeed(P.fresh('fill'), P.rectOf(P.fresh('fill'), nat, vid, view), nat);
near(fill.h, 800, 'fill needs the area height'); near(fill.w, 1422.2222222, 'fill width');
const str = P.frameNeed(P.fresh('stretch'), { x: 0, y: 0, w: 1000, h: 800 }, nat);
near(str.w / str.h, 16 / 9, 'stretch asks for the video shape'); near(str.w, 1422.2222222, 'stretch covers the width and height');
const act = P.frameNeed(P.fresh('actual'), P.rectOf(P.fresh('actual'), { w: 1280, h: 720 }, { w: 3840, h: 2160 }, { w: 5000, h: 3000 }), { w: 1280, h: 720 });
near(act.w, 3840, '100 % needs the video\'s own width'); near(act.h, 2160, '100 % needs its height');
const zoomedNeed = P.frameNeed(z1, after, nat);
near(zoomedNeed.w, after.w, 'zoomed Fit needs the zoomed width');

// Source size: the file's, turned when the canvas is the other way round (a phone video).
assert.deepStrictEqual(P.sourceSize({ w: 1280, h: 720 }, { w: 3840, h: 2160 }), { w: 3840, h: 2160 });
assert.deepStrictEqual(P.sourceSize({ w: 720, h: 1280 }, { w: 3840, h: 2160 }), { w: 2160, h: 3840 });
assert.deepStrictEqual(P.sourceSize({ w: 640, h: 360 }, null), { w: 640, h: 360 });

// Toasts: the mode with its percent at the mode's own size (also after zooming back out to it), "Zoom N%" once zoomed.
assert.strictEqual(P.pictureToast('fit', 67, false), 'Fit (67%)');
assert.strictEqual(P.pictureToast('fill', 112, false), 'Fill (112%)');
assert.strictEqual(P.pictureToast('stretch', 67, false), 'Stretch (67%)');
assert.strictEqual(P.pictureToast('actual', 100, false), '100%', 'no "100% (100%)"');
assert.strictEqual(P.pictureToast('fit', 150, true), 'Zoom 150%');
assert.strictEqual(P.pictureToast('fit', null, false), 'Fit');
assert.ok(!P.isZoomed({ mode: 'fit', zoom: 1.0005 }) && P.isZoomed({ mode: 'fit', zoom: 1.5 }), 'fit: zoomed past 1x');
assert.ok(!P.isZoomed({ mode: 'fill', zoom: 1 }) && !P.isZoomed({ mode: 'stretch', zoom: 1 }), 'floor = picture size');
assert.ok(P.isZoomed({ mode: 'actual', zoom: 0.5 }) && P.isZoomed({ mode: 'actual', zoom: 2 }) && !P.isZoomed({ mode: 'actual', zoom: 1 }), 'actual: either side');

console.log('picture_test: ok');
