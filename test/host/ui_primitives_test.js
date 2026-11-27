// @ts-check
'use strict';
const assert = require('assert');
const VpeUi = require('../../media/ui-primitives');
const { createDom } = require('./fake-dom');

// 1. SVG helper and shared icon set
{
  const s = VpeUi.svg('<path d="M0 0h24"/>', 16, 2);
  assert.ok(s.includes('width="16" height="16"'));
  assert.ok(s.includes('stroke-width="2"'));
  assert.ok(s.includes('aria-hidden="true"'));
  for (const name of ['split', 'sync', 'spotlight', 'grid', 'swap', 'compare', 'cmpPanel', 'close', 'plus', 'info']) {
    assert.ok(typeof VpeUi.ICONS[name] === 'string' && VpeUi.ICONS[name].startsWith('<svg '), `icon ${name}`);
  }
}

// 2. Pure viewport clamping
{
  assert.deepStrictEqual(VpeUi.clampToViewport(100, 80, 200, 150, 800, 600), { left: 100, top: 80 });
  assert.deepStrictEqual(VpeUi.clampToViewport(750, 580, 200, 150, 800, 600), { left: 596, top: 446 });
  assert.deepStrictEqual(VpeUi.clampToViewport(-10, -5, 200, 150, 800, 600), { left: 4, top: 4 });
  assert.deepStrictEqual(VpeUi.clampToViewport(790, 590, 200, 150, 800, 600, 8), { left: 592, top: 442 });
}

// 3. Shared floating menu: open, clamp, keyboard nav, Esc focus restore, outside dismiss, dispose
{
  const dom = createDom('<button id="opener">Open</button><div id="menu" role="menu" hidden></div><div id="outside"></div>');
  const { doc, win, setRect } = dom;
  const opener = doc.getElementById('opener');
  const menuEl = doc.getElementById('menu');
  const outside = doc.getElementById('outside');
  win.innerWidth = 400;
  win.innerHeight = 300;
  setRect(menuEl, { left: 0, top: 0, width: 180, height: 120 });

  const reasons = [];
  const fm = VpeUi.createFloatingMenu({
    doc, win, menuEl, itemSelector: '.mi',
    onClose: (info) => reasons.push(info.reason),
  });

  const populate = () => {
    menuEl.textContent = '';
    for (const id of ['a', 'b', 'c']) {
      const b = doc.createElement('button');
      b.className = 'mi';
      b.setAttribute('role', 'menuitem');
      b.dataset.id = id;
      menuEl.appendChild(b);
    }
  };

  opener.focus();
  populate();
  fm.openAt(350, 260);
  assert.strictEqual(fm.isOpen(), true);
  assert.strictEqual(menuEl.style.left, '216px', 'clamped horizontally');
  assert.strictEqual(menuEl.style.top, '176px', 'clamped vertically');
  assert.strictEqual(doc.activeElement.dataset.id, 'a', 'first item focused');

  const key = (k) => menuEl.dispatchEvent({ type: 'keydown', key: k, preventDefault() {}, stopPropagation() {} });
  key('ArrowDown');
  assert.strictEqual(doc.activeElement.dataset.id, 'b');
  key('End');
  assert.strictEqual(doc.activeElement.dataset.id, 'c');
  key('ArrowDown');
  assert.strictEqual(doc.activeElement.dataset.id, 'a', 'wraps around');
  key('ArrowUp');
  assert.strictEqual(doc.activeElement.dataset.id, 'c', 'wraps backwards');
  key('Home');
  assert.strictEqual(doc.activeElement.dataset.id, 'a');

  key('Escape');
  assert.strictEqual(fm.isOpen(), false);
  assert.strictEqual(doc.activeElement, opener, 'Escape restores focus to opener');
  assert.deepStrictEqual(reasons, ['escape']);

  // Outside pointerdown closes
  populate();
  fm.openAt(20, 20);
  doc.dispatchEvent({ type: 'pointerdown', target: outside });
  assert.strictEqual(fm.isOpen(), false);
  assert.deepStrictEqual(reasons, ['escape', 'outside']);

  fm.dispose();
}

// 4. Shared panel row builders (switchRow, segmentedRow)
{
  const dom = createDom('<div></div>');
  const { doc } = dom;
  const k = {
    el(tag, cls, text) {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    },
    btn(cls, text, fn, opts = {}) {
      const b = doc.createElement('button');
      b.className = cls;
      if (text) b.textContent = text;
      if (opts.aria) for (const [ak, av] of Object.entries(opts.aria)) b.setAttribute(ak, av);
      b.addEventListener('click', fn);
      return b;
    },
    sw(on) {
      const s = doc.createElement('span');
      s.className = on ? 'switch on' : 'switch';
      return s;
    },
  };

  let toggled = 0;
  const sw = VpeUi.switchRow(k, 'Sync offsets', true, () => toggled++);
  assert.strictEqual(sw.getAttribute('role'), 'switch');
  assert.strictEqual(sw.getAttribute('aria-checked'), 'true');
  sw.click();
  assert.strictEqual(toggled, 1);

  let picked = '';
  const seg = VpeUi.segmentedRow(k, 'Layout', [['spotlight', 'Spotlight'], ['grid', 'Grid']], 'grid', (v) => { picked = v; });
  const chips = seg.querySelectorAll('.chip');
  assert.strictEqual(chips.length, 2);
  assert.strictEqual(chips[0].getAttribute('aria-pressed'), 'false');
  assert.strictEqual(chips[1].getAttribute('aria-pressed'), 'true');
  chips[0].click();
  assert.strictEqual(picked, 'spotlight');
}

console.log('ui_primitives: ok');
