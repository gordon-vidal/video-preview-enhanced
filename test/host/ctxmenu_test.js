'use strict';
// node test/host/ctxmenu_test.js: the player's right-click menu is an HTML menu in the page (media/ctxmenu.js),
// not VS Code's native webview/context menu. Checks its items per player state, that every item is wired to a page
// action and a real key, that nothing of the native menu is left in package.json, and that the host page carries it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const page = read('media', 'player.js');
const css = read('media', 'player.css');
const host = read('src', 'extension.js');

// ---- a minimal fake document for the DOM part (set up before the module is loaded) ----
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.listeners = {}; this.className = ''; this._t = ''; this.isConnected = true; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
  focus() { doc.activeElement = this; }
  click() { for (const f of this.listeners.click || []) f({ stopPropagation() {} }); }
  set textContent(v) { if (v === '') this.children = []; this._t = v; }
  get textContent() { return this._t; }
  get offsetWidth() { return 240; }
  get offsetHeight() { return 20 + 20 * this.children.length; }
  get offsetLeft() { return parseFloat(this.style.left); }
  get offsetTop() { return parseFloat(this.style.top); }
  all(pred) { return this.children.flatMap((c) => [...(pred(c) ? [c] : []), ...c.all(pred)]); }
  querySelectorAll(sel) {
    if (sel === '[role^="menuitem"]') return this.all((c) => /^menuitem/.test(c.attrs.role || ''));
    if (sel === '[role=separator]') return this.all((c) => c.attrs.role === 'separator');
    return [];
  }
  querySelector(sel) { const m = /^\.(.+)$/.exec(sel); return m ? this.all((c) => c.className === m[1])[0] || null : null; }
}
const fire = (el, type, ev) => { for (const f of el.listeners[type] || []) f(ev); };
const doc = new El('document');
doc.activeElement = null;
doc.documentElement = { clientWidth: 800, clientHeight: 500 };
doc.createElement = (t) => new El(t);
doc.getElementById = () => null;
global.document = doc;
global.window = { listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); } };
global.Element = El;
global.innerWidth = 800;
global.innerHeight = 500;
const Menu = require('../../media/ctxmenu');

const READY = { ready: true, playing: false, loop: false, abSet: false, file: true, compareOpen: false };
const shape = (s) => Menu.items(s).map((i) => ('sep' in i ? '-' : `${i.label}|${i.key || ''}${i.checked ? '|on' : ''}`));

// Everything ready, paused, a local file: the five groups in order with their shortcuts.
assert.deepStrictEqual(shape(READY), [
  'Play|Space', 'Loop|R', '-',
  'Set Range Start (A)|A', 'Set Range End (B)|B', '-',
  'Copy Frame|Ctrl+C', 'Save Frame as PNG…|S', 'Copy Timestamp|T', '-',
  'Start Compare|Shift+D', '-',
  'Keyboard Shortcuts|?', 'Settings…|',
]);
// states
assert.strictEqual(Menu.items({ ...READY, playing: true })[0].label, 'Pause');
const loopItem = (s) => Menu.items(s).find((i) => i.id === 'loop');
assert.strictEqual(loopItem(READY).checked, false, 'Loop is a toggle, off');
assert.strictEqual(loopItem({ ...READY, loop: true }).checked, true, 'Loop is a toggle, on: the check mark');
assert(!shape(READY).some((l) => /^Clear/.test(l)), 'no Clear while neither A nor B is set');
assert(shape({ ...READY, abSet: true }).includes('Clear A–B Range|Backspace'), 'Clear while A or B is set');
const cmp = shape({ ...READY, compareOpen: true });
assert(cmp.includes('Add to Compare|Shift+D') && !cmp.some((l) => /^Start/.test(l)), 'Add to Compare while Compare is open');
assert(!shape({ ...READY, file: false }).some((l) => /Compare/.test(l)), 'no Compare for a URL stream');
assert.deepStrictEqual(shape({ ...READY, ready: false, file: false }), ['Play|Space', 'Loop|R', '-', 'Keyboard Shortcuts|?', 'Settings…|'], 'before the first frame: only what works');
// no empty group, no double / leading / trailing separator, in any state
for (let bits = 0; bits < 32; bits++) {
  const s = { ready: !!(bits & 1), playing: !!(bits & 2), loop: !!(bits & 4), abSet: !!(bits & 8), file: !!(bits & 16), compareOpen: false };
  const l = shape(s);
  assert(l[0] !== '-' && l[l.length - 1] !== '-' && !l.some((x, i) => x === '-' && l[i - 1] === '-'), `separators in state ${bits}`);
}

// every item runs a page action, and the key it shows is a key the page handles
const MENU_ACTIONS = page.slice(page.indexOf('const MENU_ACTIONS = {'), page.indexOf('const ctxMenu = VpeCtxMenu.create'));
const every = [READY, { ...READY, playing: true, loop: true, abSet: true }, { ...READY, compareOpen: true }]
  .flatMap((s) => Menu.items(s)).filter((i) => !('sep' in i));
for (const i of every) assert(new RegExp(`\\b${i.action}:`).test(MENU_ACTIONS), `the page handles ${i.action}`);
const keyCase = { play: "case ' '", loop: "case 'r'", setA: "case 'a'", setB: "case 'b'", clearAB: "case 'Backspace'", saveFrame: "case 's'", copyTime: "case 't'" };
for (const [id, c] of Object.entries(keyCase)) assert(every.some((i) => i.id === id) && page.includes(c), `${id}: its key is handled by the page (${c})`);
assert(page.includes("e.key === '?'") && page.includes("e.key === 'c' || e.key === 'C'") && page.includes("label: 'Compare', key: 'Shift+D'"), 'Ctrl+C, ? and Shift+D exist');

// the native menu is gone: no webview/context entries, no ctx commands, no data-vscode-context
assert(!pkg.contributes.menus['webview/context'], 'no webview/context menu');
assert(!JSON.stringify(pkg).includes('videoPreviewEnhanced.ctx.'), 'no ctx commands in package.json');
assert(!pkg.contributes.submenus, 'no submenus');
assert(!fs.existsSync(path.join(root, 'src', 'ctxmenu.js')), 'src/ctxmenu.js is gone');
assert(!/require\('\.\/ctxmenu'\)|ctxCommand|ctxmenu\.register/.test(host), 'the host registers no ctx commands');
assert(!page.includes('data-vscode-context') && !page.includes('updateMenuContext'), 'the page no longer feeds VS Code a context');

// the host page: the menu element, its script (nonce, between controls.js and player.js), the CSS block at the end of player.css
const { playerHtml } = require('../../src/player-html');
const html = playerHtml({
  cspSource: 'csp:', uri: (...p) => 'u/' + p.join('/'), base: 'b', loader: 'l.js', nonce: 'N', cfg: {}, sequence: true,
  transport: 'message', debug: false, canCompare: false, compareOpen: false,
});
assert(/<div id="ctxmenu" class="ctxmenu" role="menu"[^>]* hidden><\/div>/.test(html), 'the page has #ctxmenu');
assert(html.indexOf('u/ctxmenu.js') > html.indexOf('u/controls.js') && html.indexOf('u/ctxmenu.js') < html.indexOf('u/player.js'), 'ctxmenu.js loads after controls.js, before player.js');
assert(html.includes('<script nonce="N" src="u/ctxmenu.js"></script>'), 'ctxmenu.js carries the CSP nonce');
const block = css.slice(css.indexOf('/* ==== Right-click menu'));
assert(block.length > 0 && !/^#(bar|volume|row)\b/m.test(block), 'the #ctxmenu CSS is its own block at the end');
for (const t of ['--vpe-panel-bg', '--vpe-panel-fg', '--vpe-panel-border', '--vpe-row-hover', '--vpe-sep', '--vpe-dim', '--vpe-mono']) assert(block.includes(t), `the menu uses ${t}`);
const keyRule = /\.ctx-key \{([^}]*)\}/.exec(block)[1];
assert(/margin-left: 24px/.test(keyRule) && /var\(--vpe-mono\)/.test(keyRule) && /font-size: 11px/.test(keyRule) && /var\(--vpe-dim\)/.test(keyRule), 'the shortcut is dim mono, 24px from the label');
assert(/#ctxmenu\[hidden\] \{ display: none/.test(block), 'hidden really hides (display: flex would win)');

// ---- the DOM part: open, clamp, keys, dismiss ----
{
  const menu = new El('div');
  menu.hidden = true;
  const ran = [];
  let before = 0;
  const m = Menu.create({ menu, getState: () => ({ ...READY, loop: true }), run: (a) => ran.push(a), beforeOpen: () => { before++; } });
  m.open(100, 120);
  assert(!menu.hidden && before === 1, 'opens and closes the other panels first');
  let snap = m.snapshot();
  assert.deepStrictEqual(snap.items.map((i) => i.id), ['play', 'loop', 'setA', 'setB', 'copyFrame', 'saveFrame', 'copyTime', 'startCompare', 'keys', 'playerSettings']);
  assert.strictEqual(snap.seps, 4);
  assert.deepStrictEqual(snap.items.find((i) => i.id === 'loop'), { id: 'loop', role: 'menuitemcheckbox', checked: 'true', label: 'Loop', key: 'R' });
  assert.strictEqual(snap.items.find((i) => i.id === 'play').role, 'menuitem');
  assert(menu.all((c) => c.className === 'ctx-check').some((c) => c.textContent === '✓'), 'a check mark for Loop');
  assert.deepStrictEqual([snap.left, snap.top], [100, 120]);
  // clamped to the right and bottom edge, never negative
  m.open(790, 495);
  snap = m.snapshot();
  assert(snap.left + snap.width <= 800 && snap.top + snap.height <= 500 && snap.left >= 0 && snap.top >= 0, `clamped: ${snap.left},${snap.top}`);
  // keyboard: arrows wrap, Home / End, Enter runs and closes
  const key = (k) => { const e = { key: k, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; fire(menu, 'keydown', e); return e; };
  key('ArrowDown'); assert.strictEqual(m.snapshot().focused, 'play');
  key('ArrowDown'); assert.strictEqual(m.snapshot().focused, 'loop');
  key('ArrowUp'); key('ArrowUp'); assert.strictEqual(m.snapshot().focused, 'playerSettings', 'wraps to the last');
  key('Home'); assert.strictEqual(m.snapshot().focused, 'play');
  key('End'); assert.strictEqual(m.snapshot().focused, 'playerSettings');
  key('Home'); key('ArrowDown');
  const e = key('Enter');
  assert(e.prevented && e.stopped);
  assert.deepStrictEqual(ran, ['loop']);
  assert(menu.hidden && m.snapshot() === null, 'closed after a pick');
  // Space picks too; Escape closes without running
  m.open(10, 10, true);
  assert.strictEqual(m.snapshot().focused, 'play', 'opened from the keyboard: first item focused');
  key(' ');
  assert.deepStrictEqual(ran, ['loop', 'playPause']);
  m.open(10, 10);
  key('Escape');
  assert(menu.hidden && ran.length === 2);
  // another key (a player key) closes it and is not swallowed
  m.open(10, 10);
  const r = key('r');
  assert(menu.hidden && !r.stopped && !r.prevented, 'a player key closes the menu and still reaches the page');
  // click outside closes it; the picture area is told the click that follows was the dismissal
  m.open(10, 10);
  fire(doc, 'pointerdown', { target: new El('canvas') });
  assert(menu.hidden && m.consumeDismiss() === true && m.consumeDismiss() === false, 'outside press dismisses once');
  m.open(10, 10);
  fire(doc, 'pointerdown', { target: menu.children[0] });
  assert(!menu.hidden, 'a press inside the menu keeps it');
  // window blur and resize close it
  for (const ev of ['blur', 'resize']) {
    m.open(10, 10);
    for (const f of global.window.listeners[ev]) f();
    assert(menu.hidden, `${ev} closes`);
  }
  // a click on an item runs its action
  m.open(10, 10);
  menu.children[0].click();
  assert.deepStrictEqual(ran.slice(-1), ['playPause']);
}
// the contextmenu handler: text fields keep the native menu, everything else gets this one
{
  const menu = new El('div');
  menu.hidden = true;
  Menu.create({ menu, getState: () => READY, run() {} });
  const ev = (target) => ({ target, clientX: 30, clientY: 40, prevented: false, preventDefault() { this.prevented = true; } });
  const plain = new El('canvas');
  plain.closest = () => null;
  const field = new El('input');
  field.closest = () => field;
  const a = ev(plain);
  fire(doc, 'contextmenu', a);
  assert(a.prevented && !menu.hidden, 'right-click on the player opens the menu and drops the native one');
  menu.hidden = true;
  const b = ev(field);
  fire(doc, 'contextmenu', b);
  assert(!b.prevented && menu.hidden, 'a text field keeps the native menu');
}
console.log('context menu: ok (HTML menu, 5 groups, keys, clamp, dismiss)');
