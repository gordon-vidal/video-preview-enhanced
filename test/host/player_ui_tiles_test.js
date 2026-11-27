'use strict';
// Millisecond tests for the Compare tile interactions (media/player-ui-tiles.js) on the strict fake DOM
// (test/host/fake-dom.js): FLIP glide, direct tile drag (lift threshold, reorder, Spotlight swap and edge dock,
// cancel paths, the zoomed grip rule, the button ignore list, the 300 ms release guard), the tiles' right-click
// menu, the ⓘ details card and the move-arrow / hover helpers. Nothing decodes video; there is no layout, so every
// rect comes from setRect.
const assert = require('assert');
globalThis.VpeUi = require('../../media/ui-primitives');
const T = require('../../media/player-ui-tiles');
const Grid = require('../../media/compare-grid');
const { createDom } = require('./fake-dom');

const T0 = Date.now();
let count = 0;
const test = (name, fn) => {
  try { fn(); count++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};

// ---- a stage of cells laid out by hand (no layout engine in the fake DOM) ----

const W = 800, H = 600;
/** Grid 2x2 (cells by order index) or Spotlight (main on `dock` + a strip of the rest). */
function cellsFor(order, dock, mode) {
  if (mode === 'spotlight') {
    const main = { top: [0, 0, W, 400], bottom: [0, 200, W, 400], left: [0, 0, 560, H], right: [240, 0, 560, H] }[dock];
    const strip = { top: [0, 400, W, 200], bottom: [0, 0, W, 200], left: [560, 0, 240, H], right: [0, 0, 240, H] }[dock];
    const n = order.length - 1;
    const horiz = dock === 'top' || dock === 'bottom';
    const cells = [{ x: main[0], y: main[1], w: main[2], h: main[3], tiles: [order[0]] }];
    order.slice(1).forEach((v, k) => {
      const [sx, sy, sw, sh] = strip;
      cells.push(horiz ? { x: sx + (sw / n) * k, y: sy, w: sw / n, h: sh, tiles: [v] } : { x: sx, y: sy + (sh / n) * k, w: sw, h: sh / n, tiles: [v] });
    });
    return cells;
  }
  return order.map((v, k) => ({ x: (k % 2) * 400, y: Math.floor(k / 2) * 300, w: 400, h: 300, tiles: [v] }));
}

function setup({ mode = 'grid', order = [0, 1, 2, 3], dock = 'top', zoomed = false } = {}) {
  const dom = createDom(
    '<div id="stage"><div id="cells"></div><div id="splitter"></div><div id="menu" hidden></div></div><button id="other">x</button>',
  );
  const { doc, win, $, setRect } = dom;
  const stage = $('stage'), cellsEl = $('cells');
  setRect(stage, { left: 100, top: 50, width: W, height: H });
  const st = { mode, order: order.slice(), dock, zoomed };
  const els = {};
  for (const c of cellsFor(st.order, st.dock, st.mode)) {
    const v = c.tiles[0];
    cellsEl.insertAdjacentHTML('beforeend',
      `<div class="cell" data-tile="${v}"><div class="ov"><div class="pill"><span class="grip" data-zoom-drag="1">⋮⋮</span>`
      + `<button class="mute-mini" data-act="mute" data-i="${v}">s</button></div></div>`
      + `<div class="move"><button data-act="move" data-i="${v}" data-d="-1">u</button></div><div class="pic"></div></div>`);
    els[v] = cellsEl.lastElementChild;
    setRect(els[v], { left: 100 + c.x, top: 50 + c.y, width: c.w, height: c.h });
  }
  const log = [];
  let clock = 1000;
  const drag = T.bindTileDrag({
    stage, cellsEl, win, grid: Grid,
    getLayout: () => ({ mode: st.mode, dock: st.dock }),
    getOrder: () => st.order,
    getCells: (o, d) => cellsFor(o, d, st.mode),
    isZoomed: () => st.zoomed,
    onPreview: (p) => log.push(['preview', p]),
    onCommitOrder: (o, f, t) => log.push(['order', o, f, t]),
    onCommitDock: (e) => log.push(['dock', e]),
    onBusyChange: (b) => log.push(['busy', b]),
    onCancel: () => log.push(['cancel']),
    now: () => clock,
  });
  // Client coordinates: stage px + the stage's offset.
  const at = (x, y) => ({ clientX: 100 + x, clientY: 50 + y, pointerId: 7, button: 0 });
  const press = (el, x, y, init = {}) => el.fire('pointerdown', { ...at(x, y), ...init });
  const move = (x, y) => stage.fire('pointermove', at(x, y));
  const up = (x, y) => stage.fire('pointerup', at(x, y));
  const previews = () => log.filter((l) => l[0] === 'preview').map((l) => l[1]);
  return { dom, doc, win, stage, cellsEl, els, st, drag, log, press, move, up, previews, tick: (ms) => { clock += ms; } };
}

// ---- 1. FLIP glide ----

test('glide animates position and size, then settles', () => {
  const { win, setRect, $ } = createDom('<div id="a"></div><div id="b"></div>');
  win.matchMedia = () => ({ matches: false });
  const a = $('a'), b = $('b');
  Object.assign(a.style, { left: '0px', top: '0px', width: '400px', height: '300px' });
  setRect(a, { left: 0, top: 0, width: 400, height: 300 });
  setRect(b, { left: 400, top: 0, width: 400, height: 300 });
  const g = T.createGlide({ win });
  assert.strictEqual(g.duration(), 200);
  g.capture([a, b]);
  // The new layout: a moved right and shrank; b did not move.
  setRect(a, { left: 400, top: 300, width: 200, height: 150 });
  a.style.width = '200px'; a.style.height = '150px';
  assert.strictEqual(g.play([a, b]), 1, 'only the cell that moved glides');
  assert.strictEqual(a.style.transform, '', 'played to the new place');
  assert.match(a.style.transition, /^transform 200ms cubic-bezier\(0\.2, 0, 0, 1\), width 200ms/);
  assert.strictEqual(a.style.width, '200px', 'ends at the new size');
  assert.strictEqual(b.style.transition, '');
  assert.ok(g.isActive());
  const timer = win.timers[win.timers.length - 1];
  assert.strictEqual(timer.ms, 250);
  timer.fn();
  assert.strictEqual(a.style.transition, '', 'settled: no transition left behind');
  assert.ok(!g.isActive());
});

test('glide sets the start state before the transition', () => {
  const { win, setRect, $ } = createDom('<div id="a"></div>');
  win.matchMedia = () => ({ matches: false });
  const a = $('a');
  setRect(a, { left: 10, top: 20, width: 100, height: 100 });
  const g = T.createGlide({ win });
  g.capture([a]);
  setRect(a, { left: 110, top: 70, width: 100, height: 100 });
  // Record the transform as it was at the reflow (offsetWidth read).
  let atReflow = null;
  Object.defineProperty(a, 'offsetWidth', { get() { atReflow = { t: a.style.transform, tr: a.style.transition }; return 100; } });
  g.play([a]);
  assert.deepStrictEqual(atReflow, { t: 'translate(-100px, -50px)', tr: 'none' }, 'FLIP: first jump back, then play');
  assert.match(a.style.transition, /^transform 200ms/, 'no inline size: only the transform glides');
  g.cancel();
  assert.strictEqual(a.style.transform, '');
  assert.strictEqual(a.style.transition, '');
});

test('glide with prefers-reduced-motion jumps', () => {
  const { win, setRect, $ } = createDom('<div id="a"></div>');
  win.matchMedia = (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  const a = $('a');
  setRect(a, { left: 0, top: 0, width: 100, height: 100 });
  const g = T.createGlide({ win });
  assert.strictEqual(g.duration(), 0);
  g.capture([a]);
  setRect(a, { left: 300, top: 0, width: 100, height: 100 });
  assert.strictEqual(g.play([a]), 0);
  assert.strictEqual(a.style.transform, '');
  assert.strictEqual(a.style.transition, '');
  assert.strictEqual(win.timers.length, 0, 'no settle timer');
});

// ---- 2. tile drag ----

test('under 6 px does not lift', () => {
  const s = setup();
  s.press(s.els[0].querySelector('.pic'), 50, 50);
  s.move(53, 54); // 5 px
  assert.ok(!s.drag.isDragging());
  assert.ok(!s.stage.classList.contains('tile-dragging'));
  assert.deepStrictEqual(s.log, []);
  s.up(53, 54);
  assert.deepStrictEqual(s.log, [], 'a click, not a drop');
  assert.ok(!s.drag.wasRecentDrag(), 'a plain click still plays / pauses');
});

test('drag reorders in the grid and commits on drop', () => {
  const s = setup();
  s.press(s.els[0].querySelector('.pic'), 50, 50);
  s.move(60, 50);
  assert.ok(s.drag.isDragging());
  assert.strictEqual(s.drag.liftedVideo(), 0);
  assert.ok(s.stage.classList.contains('tile-dragging'));
  assert.ok(s.els[0].classList.contains('lifted'));
  assert.ok(s.stage.hasPointerCapture(7));
  assert.deepStrictEqual(s.log[0], ['busy', true]);
  // Over tile 3 (bottom right).
  s.move(600, 450);
  const p = s.previews().pop();
  assert.deepStrictEqual(p.order, [1, 2, 3, 0]);
  assert.strictEqual(p.changed, true);
  assert.strictEqual(p.skeleton.label, 'Move here');
  assert.deepStrictEqual([p.skeleton.rect.x, p.skeleton.rect.y], [400, 300], 'outline where the tile lands');
  assert.deepStrictEqual([p.dx, p.dy], [550, 400]);
  s.move(601, 451);
  assert.strictEqual(s.previews().pop().changed, false, 'same target: no relayout');
  s.up(600, 450);
  assert.deepStrictEqual(s.log.slice(-2), [['busy', false], ['order', [1, 2, 3, 0], 0, 3]]);
  assert.ok(!s.drag.isDragging());
  assert.ok(!s.stage.classList.contains('tile-dragging'));
  assert.ok(!s.els[0].classList.contains('lifted'));
  assert.ok(!s.stage.hasPointerCapture(7));
});

test('off-tile reverts the preview; a drop there changes nothing', () => {
  const s = setup({ order: [0, 1, 2] }); // the 4th grid slot is empty
  s.press(s.els[0].querySelector('.pic'), 50, 50);
  s.move(450, 50);
  assert.deepStrictEqual(s.previews().pop().order, [1, 0, 2]);
  s.move(600, 450); // the empty slot
  const p = s.previews().pop();
  assert.deepStrictEqual(p.order, [0, 1, 2]);
  assert.strictEqual(p.skeleton, null);
  assert.strictEqual(p.changed, true);
  s.up(600, 450);
  assert.deepStrictEqual(s.log.slice(-2), [['busy', false], ['cancel']]);
});

test('Spotlight: a strip tile dropped on the main tile swaps with it', () => {
  const s = setup({ mode: 'spotlight', order: [0, 1, 2, 3] });
  // Strip tiles are 266.7 px wide at y 400-600; tile 2 is the middle one.
  s.press(s.els[2].querySelector('.pic'), 400, 500);
  s.move(400, 200);
  const p = s.previews().pop();
  assert.deepStrictEqual(p.order, [2, 1, 0, 3]);
  assert.strictEqual(p.skeleton.label, 'Swap into Spotlight');
  assert.deepStrictEqual([p.skeleton.rect.w, p.skeleton.rect.h], [800, 400], 'the main tile is the outline');
  // Moving along the strip is a plain move.
  s.move(50, 500);
  const q = s.previews().pop();
  assert.deepStrictEqual(q.order, [0, 2, 1, 3]);
  assert.strictEqual(q.skeleton.label, 'Move here');
  s.move(400, 200);
  s.up(400, 200);
  assert.deepStrictEqual(s.log.pop(), ['order', [2, 1, 0, 3], 2, 0]);
});

test('Spotlight: the main tile docks to the edge it is dropped near', () => {
  const s = setup({ mode: 'spotlight', order: [0, 1, 2], dock: 'top' });
  s.press(s.els[0].querySelector('.pic'), 400, 200);
  s.move(400, 300); // the middle: no edge, stays top
  let p = s.previews().pop();
  assert.strictEqual(p.dock, 'top');
  assert.strictEqual(p.skeleton.label, 'Spotlight (top)');
  assert.deepStrictEqual(p.order, [0, 1, 2], 'the main tile never reorders');
  s.move(40, 300); // within 22% of the width from the left
  p = s.previews().pop();
  assert.strictEqual(p.dock, 'left');
  assert.strictEqual(p.changed, true);
  assert.strictEqual(p.skeleton.label, 'Dock Spotlight left');
  assert.deepStrictEqual(p.skeleton.rect, { x: 0, y: 0, w: 560, h: H, tiles: [0] });
  assert.deepStrictEqual(p.skeleton.sub, { x: 560, y: 0, w: 240, h: H }, 'the strip outline on the other side');
  s.move(400, 590); // bottom edge
  assert.strictEqual(s.previews().pop().dock, 'bottom');
  s.up(400, 590);
  assert.deepStrictEqual(s.log.slice(-2), [['busy', false], ['dock', 'bottom']]);
});

test('Spotlight: the main tile dropped back on its dock is no change', () => {
  const s = setup({ mode: 'spotlight', order: [0, 1], dock: 'top' });
  s.press(s.els[0].querySelector('.pic'), 400, 200);
  s.move(400, 30);
  s.up(400, 30);
  assert.deepStrictEqual(s.log.pop(), ['cancel']);
});

test('Escape, pointercancel, lostpointercapture and cancel() revert', () => {
  for (const how of ['escape', 'pointercancel', 'lostpointercapture', 'api']) {
    const s = setup();
    s.press(s.els[0].querySelector('.pic'), 50, 50);
    s.move(600, 450);
    if (how === 'escape') {
      const e = s.win.fire('keydown', { key: 'Escape' });
      assert.ok(e.defaultPrevented && e.propagationStopped, 'Escape is the drag\'s, not the page\'s');
    } else if (how === 'api') s.drag.cancel();
    else s.stage.fire(how, { pointerId: 7 });
    assert.ok(!s.drag.isDragging(), how);
    assert.deepStrictEqual(s.log.slice(-2), [['busy', false], ['cancel']], how);
    assert.ok(!s.stage.classList.contains('tile-dragging'), how);
    assert.ok(!s.els[0].classList.contains('lifted'), how);
    s.up(600, 450);
    assert.strictEqual(s.log.filter((l) => l[0] === 'order').length, 0, `${how}: the later release commits nothing`);
    assert.strictEqual(s.win.listenerCount('keydown'), 0, `${how}: the Escape listener is gone`);
    const e2 = s.win.fire('keydown', { key: 'Escape' });
    assert.ok(!e2.defaultPrevented, 'Escape is the page\'s again');
  }
});

test('another pointer does not move the drag', () => {
  const s = setup();
  s.press(s.els[0].querySelector('.pic'), 50, 50);
  s.stage.fire('pointermove', { clientX: 700, clientY: 500, pointerId: 9 });
  assert.ok(!s.drag.isDragging());
  s.stage.fire('pointercancel', { pointerId: 9 });
  s.move(600, 450);
  assert.ok(s.drag.isDragging(), 'the first pointer still drags');
});

test('zoomed: only the ⋮⋮ grip lifts', () => {
  const s = setup({ zoomed: true });
  s.press(s.els[0].querySelector('.pic'), 50, 50);
  s.move(600, 450);
  assert.ok(!s.drag.isDragging(), 'the picture pans when zoomed');
  s.up(600, 450);
  s.press(s.els[0].querySelector('.grip'), 50, 50);
  s.move(600, 450);
  assert.ok(s.drag.isDragging(), 'the grip lifts');
  s.up(600, 450);
  assert.deepStrictEqual(s.log.pop(), ['order', [1, 2, 3, 0], 0, 3]);
});

test('presses on buttons, the splitter or the menu never lift', () => {
  const s = setup();
  for (const el of [s.els[0].querySelector('.mute-mini'), s.els[0].querySelector('[data-act="move"]'), s.dom.$('splitter'), s.dom.$('menu')]) {
    s.press(el, 50, 50);
    s.move(600, 450);
    assert.ok(!s.drag.isDragging(), el.className || el.id);
    s.up(600, 450);
  }
  s.press(s.els[0].querySelector('.pic'), 50, 50, { button: 2 });
  s.move(600, 450);
  assert.ok(!s.drag.isDragging(), 'right button: the menu, not a drag');
  assert.deepStrictEqual(s.log, []);
});

test('no drag in Split Wipe or with one tile', () => {
  const s = setup({ mode: 'split' });
  s.press(s.els[0].querySelector('.pic'), 50, 50);
  s.move(600, 450);
  assert.ok(!s.drag.isDragging());
  const t = setup({ order: [0] });
  t.press(t.els[0].querySelector('.pic'), 50, 50);
  t.move(600, 450);
  assert.ok(!t.drag.isDragging());
});

test('the release click is guarded for 300 ms; dragstart is prevented', () => {
  const s = setup();
  s.press(s.els[0].querySelector('.pic'), 50, 50);
  s.move(600, 450);
  s.up(600, 450);
  assert.ok(s.drag.wasRecentDrag());
  s.tick(299);
  assert.ok(s.drag.wasRecentDrag());
  s.tick(1);
  assert.ok(!s.drag.wasRecentDrag());
  assert.ok(s.drag.wasRecentDrag(1100), 'an explicit time works too');
  assert.ok(s.stage.fire('dragstart').defaultPrevented);
});

test('dispose removes the listeners', () => {
  const s = setup();
  s.drag.dispose();
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'dragstart']) {
    assert.strictEqual(s.stage.listenerCount(type), 0, type);
  }
});

// ---- 3. the tiles' right-click menu ----

function menuSetup() {
  const dom = createDom('<div id="stage"><button id="opener">o</button></div><div id="menu" hidden></div>');
  const { doc, win, $, setRect } = dom;
  const menuEl = $('menu');
  const acts = [], closes = [];
  const m = T.createTileMenu({ doc, win, menuEl, onAction: (id, ctx) => acts.push([id, ctx.tile]), onClose: (i) => closes.push(i.reason) });
  return { dom, doc, win, $, setRect, menuEl, m, acts, closes };
}
const ctx = (over = {}) => ({ tile: 1, letter: 'B', playing: false, isClock: true, isSound: false, offsetHint: '+0.20 s', timeHint: '0:01.500', dense: false, canAdd: true, ...over });
const labels = (menuEl) => [...menuEl.querySelectorAll('.mi')].map((b) => b.textContent);

test('menu items, hints and checkmarks', () => {
  const s = menuSetup();
  s.$('opener').focus();
  s.m.open(10, 10, ctx());
  assert.ok(s.m.isOpen());
  assert.strictEqual(s.menuEl.dataset.tile, '1');
  assert.strictEqual(s.menuEl.getAttribute('role'), 'menu');
  assert.deepStrictEqual(labels(s.menuEl), [
    'PlaySpace', '✓ B sets the clock', 'Sound from B', 'Offset of B…+0.20 s', 'Copy frame (B)', 'Copy timestamp (B)0:01.500',
    'Replace B…', 'Remove B', 'Add video…', 'Leave compare', 'Keyboard shortcuts?', 'Settings…',
  ]);
  const clockItem = s.menuEl.querySelector('[data-action="setClock"]');
  assert.strictEqual(clockItem.getAttribute('role'), 'menuitemcheckbox');
  assert.strictEqual(clockItem.getAttribute('aria-checked'), 'true');
  assert.strictEqual(s.menuEl.querySelector('[data-action="setSound"]').getAttribute('aria-checked'), 'false');
  assert.strictEqual(s.menuEl.querySelectorAll('.msep').length, 4);
  assert.strictEqual(s.doc.activeElement, s.menuEl.querySelector('.mi'), 'the first item has focus');
});

test('menu variants: playing, dense copy, sound, no add', () => {
  const s = menuSetup();
  s.m.open(10, 10, ctx({ playing: true, dense: true, isClock: false, isSound: true, canAdd: false }));
  const l = labels(s.menuEl);
  assert.strictEqual(l[0], 'PauseSpace');
  assert.ok(l.includes('Copy tile as shown (B)'));
  assert.ok(l.includes('B sets the clock'));
  assert.ok(l.includes('✓ Sound from B'));
  assert.ok(!l.includes('Add video…'));
  assert.strictEqual(T.tileMenuItems(ctx({ canAdd: false })).filter(Boolean).length, 11);
});

test('menu position is clamped 4 px inside the viewport', () => {
  const s = menuSetup();
  s.setRect(s.menuEl, { width: 200, height: 300 });
  s.m.open(1000, 700, ctx());
  assert.strictEqual(s.menuEl.style.left, `${1024 - 200 - 4}px`);
  assert.strictEqual(s.menuEl.style.top, `${768 - 300 - 4}px`);
  s.m.open(-20, 1, ctx());
  assert.strictEqual(s.menuEl.style.left, '4px');
  assert.strictEqual(s.menuEl.style.top, '4px');
  s.m.open(50, 60, ctx());
  assert.deepStrictEqual([s.menuEl.style.left, s.menuEl.style.top], ['50px', '60px']);
});

test('menu keyboard: arrows wrap, Home / End, Enter activates without leaking', () => {
  const s = menuSetup();
  s.m.open(10, 10, ctx());
  const items = [...s.menuEl.querySelectorAll('.mi')];
  const key = (k) => s.doc.activeElement.fire('keydown', { key: k });
  let e = key('ArrowUp');
  assert.strictEqual(s.doc.activeElement, items[items.length - 1], '↑ from the first wraps to the last');
  assert.ok(e.defaultPrevented && e.propagationStopped);
  key('ArrowDown');
  assert.strictEqual(s.doc.activeElement, items[0], '↓ from the last wraps to the first');
  key('ArrowDown');
  assert.strictEqual(s.doc.activeElement, items[1]);
  key('End');
  assert.strictEqual(s.doc.activeElement, items[items.length - 1]);
  key('Home');
  assert.strictEqual(s.doc.activeElement, items[0]);
  e = key('x');
  assert.ok(!e.defaultPrevented && !e.propagationStopped, 'other keys are not the menu\'s');
  key('ArrowDown');
  let pageKeys = 0;
  s.doc.addEventListener('keydown', () => pageKeys++);
  e = key('Enter');
  assert.deepStrictEqual(s.acts, [['setClock', 1]]);
  assert.ok(!s.m.isOpen());
  assert.strictEqual(s.menuEl.textContent, '');
  assert.strictEqual(pageKeys, 0, 'Enter did not reach the page\'s keys');
  s.m.open(10, 10, ctx());
  s.doc.activeElement.fire('keydown', { key: ' ' });
  assert.deepStrictEqual(s.acts.pop(), ['playPause', 1]);
  assert.strictEqual(pageKeys, 0, 'nor did Space');
  assert.deepStrictEqual(s.closes, ['action', 'action']);
});

test('menu Escape / Tab close and refocus the opener', () => {
  for (const k of ['Escape', 'Tab']) {
    const s = menuSetup();
    s.$('opener').focus();
    s.m.open(10, 10, ctx());
    s.doc.activeElement.fire('keydown', { key: k });
    assert.ok(!s.m.isOpen(), k);
    assert.strictEqual(s.doc.activeElement, s.$('opener'), k);
    assert.deepStrictEqual(s.closes, [k === 'Tab' ? 'tab' : 'escape']);
  }
});

test('menu click on an item runs it; a click inside does not reach the page', () => {
  const s = menuSetup();
  let pageClicks = 0;
  s.doc.addEventListener('click', () => pageClicks++);
  s.m.open(10, 10, ctx());
  s.menuEl.querySelector('[data-action="remove"]').click();
  assert.deepStrictEqual(s.acts, [['remove', 1]]);
  s.m.open(10, 10, ctx());
  s.menuEl.querySelector('.msep').click();
  assert.ok(s.m.isOpen(), 'a separator is not an item');
  assert.strictEqual(pageClicks, 0);
});

test('menu outside pointerdown and window blur close it', () => {
  const s = menuSetup();
  s.m.open(10, 10, ctx());
  s.menuEl.querySelector('.mi').fire('pointerdown', {});
  assert.ok(s.m.isOpen(), 'a press inside keeps it');
  s.$('stage').fire('pointerdown', {});
  assert.ok(!s.m.isOpen());
  s.m.open(10, 10, ctx());
  s.win.fire('blur', { bubbles: false });
  assert.ok(!s.m.isOpen());
  assert.deepStrictEqual(s.closes, ['outside', 'blur']);
  s.m.close();
  assert.deepStrictEqual(s.closes, ['outside', 'blur'], 'closing a closed menu reports nothing');
  s.m.dispose();
  assert.strictEqual(s.doc.listenerCount('pointerdown'), 0);
  assert.strictEqual(s.win.listenerCount('blur'), 0);
});

// ---- 4. the ⓘ details card ----

const factsA = { title: 'a.mp4', sub: '12 MB', rows: [['Picture', '1920×1080 · 25 fps'], ['Video', 'H.264'], ['Quality', '8-bit 4:2:0'], ['Length', '0:10']] };
const clipA = { w: 1920, h: 1080, fps: 25, frames: 250, codec: 'h264' };

test('card rows: Frames second, diffs against slot A', () => {
  const factsB = { title: 'b.mkv', rows: [['Picture', '1280×720 · 25 fps'], ['Video', 'H.264'], ['Quality', '10-bit 4:2:0'], ['Length', '0:10']] };
  const clipB = { w: 1280, h: 720, fps: 25, frames: 251, codec: 'h264' };
  const rows = T.tileStatsCardRows({ clip: clipB, facts: factsB, baseClip: clipA, baseFacts: factsA, grid: Grid });
  assert.deepStrictEqual(rows.map((r) => r.label), ['Picture', 'Frames', 'Video', 'Quality', 'Length']);
  assert.deepStrictEqual(rows.map((r) => r.diff), [true, true, false, true, false]);
  // Slot A itself never differs.
  const self = T.tileStatsCardRows({ clip: clipA, facts: factsA, baseFacts: null, grid: Grid });
  assert.ok(self.every((r) => !r.diff));
  assert.strictEqual(self[1].value, '250 f');
  // No frame count: no Frames row.
  assert.ok(!T.tileStatsCardRows({ clip: { ...clipA, frames: 0 }, facts: factsA, grid: Grid }).some((r) => r.label === 'Frames'));
  // A different codec marks Video.
  const v = T.tileStatsCardRows({ clip: { ...clipA, codec: 'hevc' }, facts: factsA, baseClip: clipA, baseFacts: factsA, grid: Grid });
  assert.deepStrictEqual(v.filter((r) => r.diff).map((r) => r.label), ['Video']);
});

test('card markup, escaping and close refocus', () => {
  const { doc, $ } = createDom('<div id="cell"><div class="ov"></div><div class="tile-stats"></div></div>');
  const el = $('cell').querySelector('.tile-stats');
  const closed = [];
  const card = T.renderTileStatsCard({
    doc, el, index: 2, letter: 'C', grid: Grid, clip: { ...clipA, frames: 99 },
    facts: { ...factsA, title: '<b>&.mp4' }, baseClip: clipA, baseFacts: factsA, focusRoot: $('cell'),
    onClose: (i) => {
      closed.push(i);
      // The caller rebuilds the overlay: the pill's ⓘ is a new element.
      $('cell').querySelector('.ov').innerHTML = '<button class="mute-mini" data-act="info" data-i="2">i</button>';
    },
  });
  assert.strictEqual(card.el, el);
  const close = el.querySelector('.tile-stats-close');
  assert.strictEqual(close.getAttribute('aria-label'), 'Close details for C');
  assert.strictEqual(close.textContent, '×');
  assert.strictEqual(el.querySelector('.iname').textContent, '<b>&.mp4', 'the name is text, not markup');
  assert.strictEqual(el.querySelector('.isub').textContent, '12 MB');
  const dts = [...el.querySelectorAll('dt')].map((d) => d.textContent);
  assert.deepStrictEqual(dts.slice(0, 2), ['Picture', 'Frames']);
  assert.deepStrictEqual([...el.querySelectorAll('dd.diff')].map((d) => d.textContent), ['99 f']);
  let bubbled = 0;
  $('cell').addEventListener('click', () => bubbled++);
  close.click();
  assert.deepStrictEqual(closed, [2]);
  assert.strictEqual(bubbled, 0, 'the × is not also the cell\'s info toggle');
  assert.strictEqual(doc.activeElement, $('cell').querySelector('.mute-mini'), 'focus goes back to the pill\'s ⓘ');
  // Without an element: a new card, no sub line.
  const fresh = T.renderTileStatsCard({ doc, letter: 'A', grid: Grid, clip: clipA, facts: { title: 'x', rows: [] } });
  assert.ok(fresh.el.classList.contains('tile-stats'));
  assert.strictEqual(fresh.el.querySelector('.isub'), null);
});

// ---- 5. move arrows and hover ----

test('move arrows: target and refocus', () => {
  const M = T.moveArrowHandlers;
  assert.deepStrictEqual(M.target([3, 1, 2], 1, -1), { from: 1, to: 0 });
  assert.strictEqual(M.target([3, 1, 2], 3, -1), null);
  assert.strictEqual(M.target([3, 1, 2], 2, 1), null);
  assert.strictEqual(M.target([3, 1, 2], 9, 1), null);
  const { doc, $ } = createDom('<div id="r"><button data-act="move" data-i="1" data-d="-1" disabled>u</button>'
    + '<button data-act="move" data-i="1" data-d="1">d</button><button data-act="move" data-i="2" data-d="-1">u</button></div>');
  const later = $('r').querySelectorAll('button')[1];
  assert.strictEqual(M.refocus($('r'), 1, 1), later);
  assert.strictEqual(doc.activeElement, later);
  assert.ok(M.wasFocused(doc, later));
  assert.strictEqual(M.refocus($('r'), 1, -1), later, 'at the top: the other arrow');
  assert.strictEqual(M.refocus($('r'), 7, -1), null);
});

test('hover: the tile under the pointer, Split Wipe by the divider', () => {
  const { $, setRect } = createDom('<div id="stage"><div id="cells"><div class="cell" data-tile="2"><i id="in2"></i></div>'
    + '<div class="cell" data-tile="split"><i id="inS"></i></div><div class="cell addcell"><i id="inAdd"></i></div></div></div>');
  setRect($('stage'), { left: 100, top: 0, width: 800, height: 600 });
  const split = { tiles: [4, 5], picX: 0, picW: 800, ratio: 0.25 };
  assert.strictEqual(T.tileAt($('in2'), 0), 2);
  assert.strictEqual(T.tileAt($('inS'), 100 + 199, { stageLeft: 100, split }), 4);
  assert.strictEqual(T.tileAt($('inS'), 100 + 201, { stageLeft: 100, split }), 5);
  assert.strictEqual(T.tileAt($('inS'), 0), null, 'split without geometry');
  assert.strictEqual(T.tileAt($('inAdd'), 0), null);
  assert.strictEqual(T.tileAt($('stage'), 0), null);
  const changes = [];
  const h = T.hoverTracker({ cellsEl: $('cells'), stage: $('stage'), getSplit: () => split, onChange: (n, p) => changes.push([n, p]) });
  $('in2').fire('pointermove', { clientX: 0 });
  $('in2').fire('pointermove', { clientX: 5 });
  $('inS').fire('pointermove', { clientX: 700 });
  assert.strictEqual(h.current(), 5);
  $('cells').fire('pointerleave', { bubbles: false });
  assert.strictEqual(h.current(), null);
  assert.deepStrictEqual(changes, [[2, null], [5, 2], [null, 5]]);
  h.dispose();
  assert.strictEqual($('cells').listenerCount('pointermove'), 0);
});

// ---- 6. boundary: no VS Code, no decoder, no Node built-ins ----

test('boundary', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'media', 'player-ui-tiles.js'), 'utf8');
  assert.ok(!/acquireVsCodeApi|require\(|\bimport\b|engine\.js|frame-player|compare-compositor|\bdocument\.|\bwindow\./.test(src),
    'DOM only through the injected doc / win; nothing required');
  assert.ok(/\/\/ @ts-check/.test(src));
});

console.log(`player_ui_tiles_test: ${count} tests ok (${Date.now() - T0} ms)`);
