'use strict';
// Phase 1 migration contracts at the webview boundary (ADR 0004).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDom, Element } = require('./fake-dom');
const { unifiedHtml } = require('../../src/unified-html');
const ContextMenu = require('../../media/ctxmenu');
const TileUi = require('../../media/player-ui-tiles');
const Ui = require('../../media/ui-primitives');
const FolderRail = require('../../media/folder-rail');
const Controls = require('../../media/controls');
const RangeDrag = require('../../media/range-drag');

function viewer(t) {
  const html = unifiedHtml({
    cspSource: 'csp:', uri: (file) => 'u/' + file, base: 'b', loader: 'l.js', nonce: 'N',
    cfg: {}, sequence: true, folder: true,
  });
  const dom = createDom(/<body[^>]*>([^]*)<\/body>/.exec(html)[1]);
  const { doc, win } = dom;
  const globals = { document: doc, window: win, Element, VpeRangeDrag: RangeDrag };
  const previous = Object.fromEntries(Object.keys(globals).map((name) => [
    name, Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return dom;
}

function key(doc, value) {
  return doc.activeElement.fire('keydown', { key: value });
}

function checkItem(item, checked) {
  assert.equal(item.getAttribute('role'), checked === undefined ? 'menuitem' : 'menuitemcheckbox');
  assert.equal(item.getAttribute('aria-checked'), checked === undefined ? null : String(checked));
}

function checkKeyboardNavigation(doc, menu) {
  const items = menu.querySelectorAll('[role^="menuitem"]');
  assert.equal(doc.activeElement, items[0]);
  for (const [value, expected] of [
    ['ArrowUp', items.at(-1)], ['ArrowDown', items[0]], ['ArrowDown', items[1]],
    ['End', items.at(-1)], ['Home', items[0]],
  ]) {
    const event = key(doc, value);
    assert.equal(doc.activeElement, expected, value);
    assert.ok(event.defaultPrevented && event.propagationStopped, value);
  }
}

function checkClamping({ win, setRect }, menu, open) {
  const width = 200, height = 160;
  setRect(menu, { width, height });
  for (const [x, y, left, top] of [
    [win.innerWidth, win.innerHeight, win.innerWidth - width - 4, win.innerHeight - height - 4],
    [-5, -10, 4, 4],
    [40, 50, 40, 50],
  ]) {
    open(x, y);
    assert.equal(menu.hidden, false);
    assert.equal(menu.style.left, `${left}px`);
    assert.equal(menu.style.top, `${top}px`);
  }
}

test('player menu exposes roles, checked state, pointer focus and viewport positioning', (t) => {
  const dom = viewer(t);
  const { doc, $ } = dom;
  const menu = $('ctxmenu');
  const state = { loop: true };
  const player = ContextMenu.create({ menu, getState: () => state, run: assert.fail });
  assert.equal(player.isOpen(), false);
  checkClamping(dom, menu, player.open);
  assert.equal(player.isOpen(), true);
  assert.equal(doc.activeElement, menu);
  assert.equal(menu.getAttribute('role'), 'menu');
  checkItem(menu.querySelector('[data-id="play"]'));
  checkItem(menu.querySelector('[data-id="loop"]'), true);

  player.close();
  assert.equal(menu.hidden, true);
  assert.equal(player.isOpen(), false);
  state.loop = false;
  const event = $('stage').fire('contextmenu', { pointerType: 'mouse', clientX: 40, clientY: 50 });
  assert.ok(event.defaultPrevented);
  assert.equal(menu.hidden, false);
  checkItem(menu.querySelector('[data-id="loop"]'), false);
});

test('player menu handles keyboard navigation, activation, focus return and shortcut pass-through', (t) => {
  const { doc, $ } = viewer(t);
  const menu = $('ctxmenu'), opener = $('play');
  const actions = [];
  const player = ContextMenu.create({ menu, getState: () => ({}), run: (action) => actions.push(action) });
  const open = () => {
    opener.focus();
    player.open(30, 40, true);
  };

  open();
  checkKeyboardNavigation(doc, menu);
  const pageKeys = [];
  doc.addEventListener('keydown', (event) => pageKeys.push(event.key));
  key(doc, 'ArrowDown');
  assert.ok(key(doc, 'Enter').defaultPrevented);
  assert.equal(menu.hidden, true);
  open();
  assert.ok(key(doc, ' ').defaultPrevented);
  assert.equal(menu.hidden, true);
  assert.deepEqual(actions, ['loop', 'playPause']);
  for (const value of ['Escape', 'Tab']) {
    open();
    assert.ok(key(doc, value).defaultPrevented);
    assert.equal(menu.hidden, true, value);
    assert.equal(doc.activeElement, opener, value);
  }

  open();
  assert.equal(key(doc, 'r').defaultPrevented, false);
  assert.equal(menu.hidden, true);
  assert.deepEqual(pageKeys, ['r']);
});

test('player menu reports picture dismissal once and closes on bar press, blur and resize', (t) => {
  const { win, $ } = viewer(t);
  const menu = $('ctxmenu');
  const player = ContextMenu.create({ menu, getState: () => ({}), run: assert.fail });
  player.open(20, 30);
  menu.querySelector('[role="menuitem"]').fire('pointerdown');
  assert.equal(menu.hidden, false);
  assert.equal(player.consumeDismiss(), false);

  $('stage').fire('pointerdown');
  assert.equal(menu.hidden, true);
  assert.equal(player.consumeDismiss(), true);
  assert.equal(player.consumeDismiss(), false);
  player.open(20, 30);
  $('play').fire('pointerdown');
  assert.equal(menu.hidden, true);
  assert.equal(player.consumeDismiss(), false);
  for (const event of ['blur', 'resize']) {
    player.open(20, 30);
    win.fire(event);
    assert.equal(menu.hidden, true, event);
    assert.equal(player.consumeDismiss(), false, event);
  }
});

test('tile menu positions within the viewport and exposes both clock and sound check states', (t) => {
  const dom = viewer(t);
  const { doc, win, $ } = dom;
  const menu = $('menu');
  const tile = TileUi.createTileMenu({ doc, win, menuEl: menu, ui: Ui, onAction: assert.fail });
  const ctx = { tile: 1, letter: 'B', isClock: true, isSound: false };
  assert.equal(tile.isOpen(), false);
  checkClamping(dom, menu, (x, y) => tile.open(x, y, ctx));
  assert.equal(tile.isOpen(), true);
  assert.equal(menu.getAttribute('role'), 'menu');
  checkItem(menu.querySelector('[data-action="playPause"]'));
  checkItem(menu.querySelector('[data-action="setClock"]'), true);
  checkItem(menu.querySelector('[data-action="setSound"]'), false);

  tile.close();
  assert.equal(menu.hidden, true);
  assert.equal(tile.isOpen(), false);
  tile.open(40, 50, { ...ctx, isClock: false, isSound: true });
  checkItem(menu.querySelector('[data-action="setClock"]'), false);
  checkItem(menu.querySelector('[data-action="setSound"]'), true);
  tile.dispose();
});

test('tile menu handles navigation, activation, focus return and dismissal', (t) => {
  const { doc, win, $ } = viewer(t);
  const menu = $('menu'), opener = $('play');
  const actions = [];
  const tile = TileUi.createTileMenu({
    doc, win, menuEl: menu, ui: Ui, onAction: (id, ctx) => actions.push([id, ctx.tile]),
  });
  const open = () => {
    opener.focus();
    tile.open(30, 40, { tile: 1, letter: 'B' });
  };
  open();
  checkKeyboardNavigation(doc, menu);
  const pageKeys = [];
  doc.addEventListener('keydown', (event) => pageKeys.push(event.key));
  assert.equal(key(doc, 'x').defaultPrevented, false);
  assert.equal(menu.hidden, false);
  key(doc, 'ArrowDown');
  assert.ok(key(doc, 'Enter').defaultPrevented);
  assert.equal(menu.hidden, true);
  open();
  assert.ok(key(doc, ' ').defaultPrevented);
  assert.equal(menu.hidden, true);
  assert.deepEqual(actions, [['setClock', 1], ['playPause', 1]]);
  for (const value of ['Escape', 'Tab']) {
    open();
    assert.ok(key(doc, value).defaultPrevented);
    assert.equal(menu.hidden, true, value);
    assert.equal(doc.activeElement, opener, value);
  }
  assert.deepEqual(pageKeys, ['x']);

  open();
  doc.activeElement.fire('pointerdown');
  assert.equal(menu.hidden, false);
  $('stage').fire('pointerdown');
  assert.equal(menu.hidden, true);
  open();
  win.fire('blur');
  assert.equal(menu.hidden, true);
  tile.dispose();
});

test('disposing the tile menu closes it and releases its event subscriptions', (t) => {
  const { doc, win, $ } = viewer(t);
  const menu = $('menu');
  const subscriptions = [[doc, 'pointerdown'], [win, 'blur'], [menu, 'keydown'], [menu, 'click']];
  const counts = () => subscriptions.map(([target, type]) => target.listenerCount(type));
  const before = counts();
  const tile = TileUi.createTileMenu({ doc, win, menuEl: menu, ui: Ui, onAction: assert.fail });
  tile.open(30, 40, { tile: 1, letter: 'B' });
  tile.dispose();
  assert.equal(menu.hidden, true);
  assert.deepEqual(counts(), before);
});

function expanded(button, value) {
  assert.equal(button.getAttribute('aria-expanded'), String(value), button.id);
}

test('folder rail column and autoplay menus toggle, update choices and dismiss', (t) => {
  const { doc, $ } = viewer(t);
  const posted = [];
  let onEnd = 'off';
  const rail = FolderRail.create({
    doc, post: (message) => posted.push(message), toast: assert.fail,
    label: (value) => ({ off: 'Off', next: 'Play next in folder' })[value],
    getOnEnd: () => onEnd,
    setOnEnd: (value) => { onEnd = value; rail.refreshOnEnd(); },
  });
  rail.show();
  const col = $('railColBtn'), end = $('railEndBtn');
  const colMenu = $('railColMenu'), endMenu = $('railEndMenu');
  const expect = (column, autoplay) => {
    assert.equal(colMenu.hidden, !column);
    assert.equal(endMenu.hidden, !autoplay);
    expanded(col, column);
    expanded(end, autoplay);
  };
  expect(false, false);

  col.click();
  expect(true, false);
  assert.equal(doc.activeElement, colMenu.querySelector('[data-col="duration"][aria-checked="true"]'));
  col.click();
  expect(false, false);
  const event = $('railColHead').fire('contextmenu', { clientX: 30, clientY: 40 });
  assert.ok(event.defaultPrevented && event.propagationStopped);
  expect(true, false);
  colMenu.querySelector('[data-col="size"]').click();
  expect(false, false);
  assert.match(col.textContent, /^Size/);
  assert.equal(doc.activeElement, col);
  assert.ok(posted.some(({ type, op, column }) => type === 'rail' && op === 'prefs' && column === 'size'));

  col.click();
  assert.equal(doc.activeElement, colMenu.querySelector('[data-col="size"][aria-checked="true"]'));
  end.click();
  expect(false, true);
  assert.equal(doc.activeElement, endMenu.querySelector('[data-end="off"][aria-checked="true"]'));
  endMenu.querySelector('[data-end="next"]').click();
  expect(false, false);
  assert.equal($('railEndVal').textContent, 'Next');
  assert.equal(doc.activeElement, end);
  end.click();
  assert.equal(doc.activeElement, endMenu.querySelector('[data-end="next"][aria-checked="true"]'));
  end.click();
  expect(false, false);

  for (const [button, menu] of [[col, colMenu], [end, endMenu]]) {
    button.click();
    assert.ok(key(doc, 'Escape').defaultPrevented);
    expect(false, false);
    assert.equal(doc.activeElement, button);
    button.click();
    menu.fire('pointerdown');
    assert.equal(menu.hidden, false);
    $('stage').fire('pointerdown');
    expect(false, false);
  }
});

function controlsViewer(t) {
  const dom = viewer(t);
  const { $ } = dom;
  const panel = $('panel');
  const buttons = { cog: $('cog'), rate: $('rate'), stepPrev: $('prevSize'), stepNext: $('nextSize') };
  const state = { rate: 1, stepSize: 1 };
  const controls = Controls.create({
    panel, buttons, sheet: $('sheet'), bar: $('bar'), get: () => state,
    act: { stepSize: (value) => { state.stepSize = value; } },
  });
  function expect(label, opener) {
    assert.equal(panel.hidden, !label);
    if (label) {
      assert.equal(panel.getAttribute('role'), 'dialog');
      assert.equal(panel.getAttribute('aria-label'), label);
    }
    for (const button of Object.values(buttons)) expanded(button, button === opener);
  }
  return { ...dom, buttons, panel, controls, expect };
}

test('controls toggle speed and both step-size popovers, with one expanded opener at a time', (t) => {
  const { doc, buttons: { cog, rate, stepPrev, stepNext }, panel, controls, expect } = controlsViewer(t);
  expect(null);
  controls.toggle('speed', rate);
  expect('Speed', rate);
  assert.equal(doc.activeElement, panel.querySelector('input[aria-label="Speed"]'));
  controls.toggle('speed', rate);
  expect(null);
  assert.equal(doc.activeElement, rate);

  controls.toggle('speed', rate);
  controls.toggle('step', stepPrev);
  expect('Step size', stepPrev);
  const picked = panel.querySelector('[role="radio"][aria-checked="true"]');
  assert.equal(doc.activeElement, picked);
  const option = panel.querySelector('[role="radio"][aria-checked="false"]');
  const optionText = option.textContent;
  option.click();
  expect(null);
  assert.equal(doc.activeElement, stepPrev);

  controls.toggle('step', stepNext);
  expect('Step size', stepNext);
  assert.ok(panel.querySelector('[role="radio"][aria-checked="true"]').textContent.endsWith(optionText));
  assert.ok(key(doc, 'Escape').defaultPrevented);
  expect(null);
  assert.equal(doc.activeElement, stepNext);

  controls.toggle('step', stepNext);
  controls.toggle('step', stepNext);
  expect(null);
  assert.equal(doc.activeElement, stepNext);
  controls.toggle('step', stepPrev);
  controls.toggle('main', cog);
  expect('Player settings', cog);
  controls.toggle('speed', rate);
  expect('Speed', rate);
  assert.ok(key(doc, 'Escape').defaultPrevented);
  expect(null);
  assert.equal(doc.activeElement, rate);
});

test('Settings navigates to a sub-page and Escape returns to Settings then the opener', (t) => {
  const { doc, buttons: { cog }, panel, controls, expect } = controlsViewer(t);
  controls.toggle('main', cog);
  expect('Player settings', cog);
  assert.equal(doc.activeElement.getAttribute('role'), 'switch');
  const speed = [...panel.querySelectorAll('button')].find((button) => button.textContent.startsWith('Speed'));
  speed.click();
  expect('Speed', cog);
  assert.equal(doc.activeElement.getAttribute('aria-label'), 'Back from Speed');
  assert.ok(key(doc, 'Escape').defaultPrevented);
  expect('Player settings', cog);
  assert.equal(doc.activeElement.getAttribute('role'), 'switch');
  assert.equal(doc.activeElement.textContent, 'Repeat video');
  assert.ok(key(doc, 'Escape').defaultPrevented);
  expect(null);
  assert.equal(doc.activeElement, cog);

  controls.toggle('main', cog);
  controls.toggle('main', cog);
  expect(null);
  assert.equal(doc.activeElement, cog);
});

test('controls consume a picture dismissal once, while panel openers and bar presses still work', (t) => {
  const { $, buttons: { cog, rate, stepPrev }, panel, controls, expect } = controlsViewer(t);
  for (const [view, button, label] of [
    ['speed', rate, 'Speed'], ['step', stepPrev, 'Step size'], ['main', cog, 'Player settings'],
  ]) {
    controls.toggle(view, button);
    panel.fire('pointerdown');
    expect(label, button);
    assert.equal(controls.consumeDismiss(), false);
    $('stage').fire('pointerdown');
    expect(null);
    assert.equal(controls.consumeDismiss(), true);
    assert.equal(controls.consumeDismiss(), false);
  }

  controls.toggle('speed', rate);
  cog.fire('pointerdown');
  expect('Speed', rate);
  assert.equal(controls.consumeDismiss(), false);
  controls.toggle('main', cog);
  expect('Player settings', cog);
  $('play').fire('pointerdown');
  expect(null);
  assert.equal(controls.consumeDismiss(), false);
});
