'use strict';
// node test/run.js unit --grep compare_panels_ui: the Preact Compare panel and per-video page (media/ui/ComparePanels.tsx,
// built into media/dist/webview-ui.js). They must render the DOM media/controls.js pages use (classes, roles, names) and
// call the controller's actions; the Node fake DOM stands in for the browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./fake-dom');

const BUNDLE = path.join(__dirname, '..', '..', 'media', 'dist', 'webview-ui.js');
const dom = createDom('<div id="host"></div>');
const context = vm.createContext({
  console, document: dom.doc, window: dom.win, Node: dom.win.Node, Element: dom.win.Element, HTMLElement: dom.win.Element,
  setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, queueMicrotask,
});
vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, { filename: 'webview-ui.js' });
const UI = context.VpeWebviewUi;
assert.strictEqual(typeof UI.renderComparePanel, 'function');
assert.strictEqual(typeof UI.renderCompareVideoPanel, 'function');

const mount = (fn, props) => {
  const host = dom.doc.createElement('div');
  fn(host, props);
  return host;
};
const all = (root, sel) => root.querySelectorAll(sel);
const text = (el) => el.textContent;
const byLabel = (root, label) => all(root, 'button').find((b) => b.getAttribute('aria-label') === label || text(b).startsWith(label));

{ // The Compare page: videos, add, capture switch, layout, swap, sync, leave.
  const calls = [];
  const rec = (name) => (...a) => calls.push([name, ...a]);
  const props = {
    rows: [
      { id: 'a', letter: 'A', name: 'one.mp4', value: '⏱ 🔊 0f', ariaLabel: 'A: one.mp4, offset in step, sets the clock, sound on' },
      { id: 'b', letter: 'B', name: 'two.mp4', value: '+3f', ariaLabel: 'B: two.mp4, offset +3 frames' },
    ],
    addValue: '2 of 4', capture: false, multi: true,
    layoutModes: [['spotlight', 'Spotlight'], ['grid', 'Grid'], ['split', 'Split']], layout: 'grid',
    showSwap: true, syncMode: true, keepLetter: 'A',
    onOpenVideo: rec('open'), onAdd: rec('add'), onCapture: rec('capture'), onLayout: rec('layout'),
    onSwap: rec('swap'), onSync: rec('sync'), onLeave: rec('leave'),
  };
  const host = mount(UI.renderComparePanel, props);
  assert.strictEqual(text(all(host, '.phead')[0]), 'Videos');
  assert.strictEqual(all(host, '.phead')[0].getAttribute('aria-hidden'), 'true');
  const rows = all(host, 'button.row.cvid');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].getAttribute('aria-label'), props.rows[0].ariaLabel);
  assert.strictEqual(rows[0].getAttribute('data-nav'), '1');
  assert.strictEqual(rows[0].getAttribute('type'), 'button');
  assert.strictEqual(text(rows[0].querySelector('.ltr')), 'A');
  assert.strictEqual(rows[0].querySelector('.ltr').getAttribute('aria-hidden'), 'true');
  assert.strictEqual(rows[0].firstChild, rows[0].querySelector('.ltr'), 'the letter leads the row');
  assert.strictEqual(text(rows[1].querySelector('.grow')), 'two.mp4');
  assert.strictEqual(text(rows[1].querySelector('.val')), '+3f');
  assert.ok(rows[1].querySelector('svg'), 'rows with sub-pages end in a chevron');
  rows[1].fire('click');
  assert.deepStrictEqual(calls.pop(), ['open', 'b']);

  const add = byLabel(host, 'Add video…');
  assert.strictEqual(text(add.querySelector('.val')), '2 of 4');
  add.fire('click');
  assert.deepStrictEqual(calls.pop(), ['add']);

  const sw = all(host, '[role="switch"]');
  assert.deepStrictEqual(sw.map((b) => [text(b.querySelector('.grow')), b.getAttribute('aria-checked')]),
    [['Open new videos here', 'false'], ['Sync offsets on tiles', 'true']]);
  assert.strictEqual(sw[0].getAttribute('aria-keyshortcuts'), 'Shift+D');
  assert.strictEqual(text(sw[0].querySelector('kbd')), 'Shift+D');
  assert.ok(!sw[0].querySelector('.switch').classList.contains('on') && sw[1].querySelector('.switch').classList.contains('on'));
  assert.ok(sw[0].querySelector('.switch > .knob'));
  sw[0].fire('click');
  sw[1].fire('click');
  assert.deepStrictEqual(calls.splice(0), [['capture'], ['sync']]);

  const seg = host.querySelector('.row.static .seg');
  assert.strictEqual(seg.getAttribute('role'), 'group');
  assert.strictEqual(seg.getAttribute('aria-label'), 'Layout');
  const chips = all(seg, 'button.chip');
  assert.deepStrictEqual(chips.map((c) => [text(c), c.getAttribute('aria-pressed')]),
    [['Spotlight', 'false'], ['Grid', 'true'], ['Split', 'false']]);
  chips[2].fire('click');
  assert.deepStrictEqual(calls.pop(), ['layout', 'split']);

  byLabel(host, 'Swap sides').fire('click');
  assert.deepStrictEqual(calls.pop(), ['swap']);
  const leave = byLabel(host, 'Leave compare, keep A');
  assert.strictEqual(text(leave.querySelector('.val')), 'keep A');
  leave.fire('click');
  assert.deepStrictEqual(calls.pop(), ['leave']);
  assert.strictEqual(all(host, '.sep').length, 2);

  // Rendering into the same container again updates it: one video leaves no Add, no layout rows, no Swap.
  UI.renderComparePanel(host, { ...props, rows: [props.rows[0]], addValue: null, multi: false, showSwap: false });
  assert.strictEqual(all(host, 'button.row.cvid').length, 1);
  assert.ok(!byLabel(host, 'Add video…') && !byLabel(host, 'Swap sides') && !byLabel(host, 'Leave compare, keep A'));
  assert.strictEqual(all(host, '.row.static').length, 0, 'no layout row with one video');
}

{ // A video's page: back, offset nudges and unit, reset, clock, sound, swap, enlarge, replace, remove.
  const calls = [];
  const rec = (name) => (...a) => calls.push([name, ...a]);
  const props = {
    letter: 'B', name: 'two.mp4', offText: '+3f', offLong: '+3 frames', unit: 'frames', hasOffset: true, clock: false,
    sound: true, hasAudio: true, showSwap: true, enlargeLabel: 'Enlarge tile',
    onBack: rec('back'), onNudge: rec('nudge'), onUnit: rec('unit'), onReset: rec('reset'), onClock: rec('clock'),
    onSound: rec('sound'), onSwap: rec('swap'), onEnlarge: rec('enlarge'), onReplace: rec('replace'), onRemove: rec('remove'),
  };
  const host = mount(UI.renderCompareVideoPanel, props);
  const head = host.querySelector('button.row.head');
  assert.strictEqual(head.getAttribute('aria-label'), 'Back from B two.mp4');
  assert.strictEqual(text(head.querySelector('.grow')), 'B two.mp4');
  head.fire('click');
  assert.deepStrictEqual(calls.pop(), ['back']);
  assert.strictEqual(text(all(host, '.phead')[0]), 'Offset');

  const [minus, plus] = all(host, '.speedTop button.big');
  assert.strictEqual(minus.getAttribute('aria-label'), 'B earlier');
  assert.strictEqual(plus.getAttribute('aria-label'), 'B later');
  assert.strictEqual(text(minus), '−');
  assert.strictEqual(text(plus), '+');
  const readout = host.querySelector('.speedTop .readout.off');
  assert.strictEqual(text(readout), '+3f');
  assert.strictEqual(readout.getAttribute('aria-label'), 'Offset of B: +3 frames');
  minus.fire('click');
  plus.fire('click');
  assert.deepStrictEqual(calls.splice(0), [['nudge', -1], ['nudge', 1]]);

  const seg = host.querySelector('.seg');
  assert.strictEqual(seg.getAttribute('aria-label'), 'Offset unit of B');
  const chips = all(seg, 'button.chip');
  assert.deepStrictEqual(chips.map((c) => [text(c), c.getAttribute('aria-pressed')]), [['Frames', 'true'], ['Time ms', 'false']]);
  chips[1].fire('click');
  assert.deepStrictEqual(calls.pop(), ['unit', 'ms']);

  const reset = host.querySelector('button.link');
  assert.strictEqual(reset.getAttribute('aria-label'), 'Reset the offset of B');
  reset.fire('click');
  assert.deepStrictEqual(calls.pop(), ['reset']);

  const sw = all(host, '[role="switch"]');
  assert.deepStrictEqual(sw.map((b) => [text(b.querySelector('.grow')), b.getAttribute('aria-checked')]),
    [['B sets the clock', 'false'], ['Sound from B', 'true']]);
  sw[0].fire('click');
  sw[1].fire('click');
  assert.deepStrictEqual(calls.splice(0), [['clock'], ['sound']]);

  for (const [label, name] of [['Swap sides', 'swap'], ['Enlarge tile', 'enlarge'], ['Replace video…', 'replace'], ['Remove from compare', 'remove']]) {
    byLabel(host, label).fire('click');
    assert.deepStrictEqual(calls.pop(), [name], label);
  }

  // No offset: no Reset; no audio track: a disabled row instead of the sound switch; no Swap with three videos.
  const bare = mount(UI.renderCompareVideoPanel, { ...props, hasOffset: false, hasAudio: false, showSwap: false, enlargeLabel: 'Back to grid' });
  assert.strictEqual(bare.querySelector('button.link'), null);
  const none = byLabel(bare, 'No audio track in B');
  assert.strictEqual(none.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(all(bare, '[role="switch"]').length, 1);
  assert.ok(!byLabel(bare, 'Swap sides'));
  assert.ok(byLabel(bare, 'Back to grid'));
}

{ // A click on a panel row never reaches the page behind the panel (controls.js btn()).
  let reached = 0;
  const host = mount(UI.renderCompareVideoPanel, {
    letter: 'A', name: 'x', offText: '0f', offLong: 'in step', unit: 'ms', hasOffset: false, clock: true, sound: false, hasAudio: true,
    showSwap: false, enlargeLabel: 'Enlarge tile', onBack() {}, onNudge() {}, onUnit() {}, onReset() {}, onClock() {}, onSound() {},
    onSwap() {}, onEnlarge() {}, onReplace() {}, onRemove() {},
  });
  host.addEventListener('click', () => { reached++; });
  host.querySelector('button.big').fire('click');
  assert.strictEqual(reached, 0);
}
console.log('compare_panels_ui ok');
