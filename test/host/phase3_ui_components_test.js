'use strict';
// node test/run.js unit --grep phase3_ui_components: the Preact Compare tile overlay (media/ui/TileOverlay.tsx) and the
// Folder Rail list (media/ui/FolderRailList.tsx) from the built bundle, in the Node fake DOM. They must render the DOM
// media/player-ui.js overlayHtml() and media/folder-rail.js render() build by hand (classes, data-* hooks, names).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./fake-dom');

const dom = createDom('<div id="host"></div>');
const context = vm.createContext({
  console, document: dom.doc, window: dom.win, Node: dom.win.Node, Element: dom.win.Element, HTMLElement: dom.win.Element,
  setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, queueMicrotask,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'dist', 'webview-ui.js'), 'utf8'), context);
const UI = context.VpeWebviewUi;
assert.strictEqual(typeof UI.renderTileOverlay, 'function');
assert.strictEqual(typeof UI.renderFolderRailList, 'function');

const mount = () => dom.doc.createElement('div');
const all = (root, sel) => root.querySelectorAll(sel);
const one = (root, sel) => root.querySelector(sel);
const text = (el) => el.textContent;
const icons = Object.fromEntries(['close', 'expand', 'collapse', 'info', 'sound', 'muted', 'noAudio']
  .map((n) => [n, `<svg data-ico="${n}"></svg>`]));
const base = {
  vid: 2, letter: 'B', name: 'two.mp4', tileCount: 3, side: '', isHero: false, confirming: false, statsOn: false,
  hasAudio: true, heard: false, isClock: false, offsetShort: '+3f', offsetLong: '+3 frames', icons,
};

{ // A normal tile: top buttons, pill, nudge.
  const host = mount();
  UI.renderTileOverlay(host, base);
  const top = one(host, '.tile-top-acts');
  const enl = one(top, 'button[data-enlarge]');
  assert.strictEqual(enl.getAttribute('data-act'), 'enlarge');
  assert.strictEqual(enl.getAttribute('data-i'), '2');
  assert.strictEqual(enl.getAttribute('aria-label'), 'Enlarge tile B');
  assert.ok(one(enl, 'svg[data-ico="expand"]'));
  const rm = one(top, 'button[data-rm]');
  assert.strictEqual(rm.className, 'tbtn rm');
  assert.strictEqual(rm.getAttribute('aria-label'), 'Remove B from compare');
  assert.strictEqual(rm.getAttribute('title'), 'Remove from compare');
  const pill = one(host, '.tile-bottom-pill.pill');
  assert.ok(pill.classList.contains('left') && !pill.classList.contains('clock'));
  assert.strictEqual(pill.getAttribute('data-zoom-drag'), '1');
  assert.strictEqual(text(one(pill, '.zoom-grip')), '⋮⋮');
  const open = one(pill, '.pill-open');
  assert.strictEqual(open.getAttribute('aria-label'), 'B: two.mp4. Offset, clock and sound');
  assert.strictEqual(text(one(open, '.ltr')), 'B');
  assert.strictEqual(text(one(open, '.nm')), 'two.mp4');
  assert.ok(one(open, '.fr.mono'));
  const info = one(pill, '.mute-mini[data-act="info"]');
  assert.strictEqual(info.getAttribute('aria-pressed'), 'false');
  const snd = one(pill, '.mute-mini[data-act="sound"]');
  assert.strictEqual(snd.getAttribute('aria-label'), 'Sound from B');
  assert.strictEqual(snd.getAttribute('aria-pressed'), 'false');
  assert.ok(one(snd, 'svg[data-ico="muted"]'));
  const nudge = one(host, '.sync-pill.nudge');
  assert.strictEqual(nudge.getAttribute('role'), 'group');
  assert.strictEqual(nudge.getAttribute('aria-label'), 'Offset of B');
  const [minus, off, plus] = all(nudge, 'button');
  assert.strictEqual(minus.getAttribute('data-d'), '-1');
  assert.strictEqual(plus.getAttribute('data-d'), '1');
  assert.strictEqual(text(off), '+3f');
  assert.strictEqual(off.getAttribute('aria-label'), 'Offset of B: +3 frames');
}

{ // Hero, clock, sound on, details on; two-click Remove; two tiles never confirm.
  const host = mount();
  UI.renderTileOverlay(host, { ...base, isHero: true, isClock: true, heard: true, statsOn: true });
  assert.strictEqual(one(host, 'button[data-enlarge]').getAttribute('aria-label'), 'Back to grid B');
  assert.ok(one(host, 'button[data-enlarge] svg[data-ico="collapse"]'));
  assert.ok(one(host, '.pill').classList.contains('clock'));
  assert.ok(one(host, '.pill-open').getAttribute('aria-label').includes(', sets the clock'));
  assert.ok(one(host, '.mute-mini.info-on[data-act="info"]'));
  const snd = one(host, '.mute-mini.on[data-act="sound"]');
  assert.strictEqual(snd.getAttribute('aria-label'), 'Mute B');
  assert.strictEqual(snd.getAttribute('aria-pressed'), 'true');

  UI.renderTileOverlay(host, { ...base, confirming: true });
  const rm = one(host, 'button[data-rm]');
  assert.strictEqual(rm.className, 'tbtn rm confirm');
  assert.strictEqual(text(rm), 'Remove?');
  assert.strictEqual(rm.getAttribute('aria-label'), 'Confirm remove two.mp4 from Compare');
  assert.strictEqual(rm.getAttribute('title'), 'Click again to remove');
  assert.strictEqual(all(host, '.tile-top-acts').length, 1, 'updating re-uses the overlay, no duplicates');

  UI.renderTileOverlay(host, { ...base, tileCount: 2, confirming: true });
  assert.strictEqual(one(host, 'button[data-rm]').className, 'tbtn rm', 'two tiles: removing leaves Compare at once');
  assert.strictEqual(one(host, 'button[data-rm]').getAttribute('title'), 'Remove from compare (back to one video)');
}

{ // No audio track.
  const host = mount();
  UI.renderTileOverlay(host, { ...base, hasAudio: false });
  const b = one(host, '.mute-mini.no-audio');
  assert.strictEqual(b.getAttribute('aria-label'), 'No audio track in B');
  assert.strictEqual(b.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(b.getAttribute('title'), 'No audio track');
  assert.ok(one(b, 'svg[data-ico="noAudio"]'));
}

{ // Split sides: no top buttons, no details button; the pill and nudge sit on their side.
  const left = mount();
  UI.renderTileOverlay(left, { ...base, side: 'L' });
  assert.strictEqual(all(left, '.tile-top-acts').length, 0);
  assert.strictEqual(all(left, '[data-act="info"]').length, 0);
  assert.ok(one(left, '.pill').classList.contains('left'));
  assert.strictEqual(one(left, '.sync-pill').className, 'sync-pill nudge left below');
  const right = mount();
  UI.renderTileOverlay(right, { ...base, side: 'R' });
  assert.ok(one(right, '.pill').classList.contains('right'));
  assert.strictEqual(one(right, '.sync-pill').className, 'sync-pill nudge right below');
}

const row = (o) => ({
  id: 'e1', domId: 'rail-e1', name: 'clip.mp4', isUp: false, active: false, inCompare: false, dim: false,
  iconHtml: '<svg data-ico="video"></svg>', colText: null, canCompare: false,
  compareTitle: 'Compare with the playing video', compareLabel: 'Compare with clip.mp4', cmpIconHtml: '<svg data-ico="cmp"></svg>', ...o,
});
const calls = [];
const rec = (n) => (...a) => calls.push([n, ...a]);
const rail = (o) => ({ empty: null, rows: [], onRow: rec('row'), onEnter: rec('enter'), onLeave: rec('leave'), onCompare: rec('cmp'), ...o });

{ // Empty and error notes.
  const host = mount();
  UI.renderFolderRailList(host, rail({ empty: 'Empty folder' }));
  assert.strictEqual(all(host, '.r-row').length, 0);
  assert.strictEqual(text(one(host, '.r-empty')), 'Empty folder');
  UI.renderFolderRailList(host, rail({ empty: null, rows: [row({})] }));
  assert.strictEqual(all(host, '.r-empty').length, 0);
  assert.strictEqual(all(host, '.r-row').length, 1);
}

{ // Rows: active, in Compare, dim, up, columns and the Compare button.
  const host = mount();
  UI.renderFolderRailList(host, rail({
    rows: [
      row({ id: 'up', domId: 'rail-up', name: '..', isUp: true, iconHtml: '<svg data-ico="up"></svg>' }),
      row({ id: 'a.1', domId: 'rail-a-1', name: 'playing.mp4', active: true, colText: '0:10' }),
      row({ id: 'b', domId: 'rail-b', name: 'in.mp4', inCompare: true, colText: '0:20' }),
      row({ id: 'c', domId: 'rail-c', name: 'notes.txt', dim: true, iconHtml: '<svg data-ico="file"></svg>' }),
      row({
        id: 'd', domId: 'rail-d', name: 'dir', canCompare: true, colText: '3',
        compareTitle: 'Compare all videos in folder', compareLabel: 'Compare all videos in folder dir',
      }),
    ],
  }));
  const rows = all(host, '.r-row');
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows[0].getAttribute('title'), 'Parent folder');
  assert.strictEqual(rows[0].getAttribute('role'), 'option');
  assert.strictEqual(all(rows[0], '.r-col').length, 0);
  assert.strictEqual(one(rows[0], '.r-name').getAttribute('title'), null);
  assert.strictEqual(rows[1].className, 'r-row active');
  assert.strictEqual(rows[1].getAttribute('aria-selected'), 'true');
  assert.strictEqual(rows[1].id, 'rail-a-1');
  assert.strictEqual(rows[1].getAttribute('data-id'), 'a.1');
  assert.strictEqual(text(one(rows[1], '.r-col')), '0:10');
  assert.strictEqual(one(rows[1], '.r-name').getAttribute('title'), 'playing.mp4');
  assert.strictEqual(rows[2].className, 'r-row in-cmp');
  assert.strictEqual(rows[2].getAttribute('aria-selected'), 'true');
  assert.strictEqual(rows[2].getAttribute('title'), 'In Compare — click to remove');
  assert.strictEqual(rows[3].className, 'r-row dim');
  assert.strictEqual(rows[3].getAttribute('aria-selected'), 'false');
  assert.strictEqual(one(rows[4], '.r-col').className, 'r-col cmp-able');
  const b = one(rows[4], 'button.r-cmp');
  assert.strictEqual(b.getAttribute('aria-label'), 'Compare all videos in folder dir');
  assert.strictEqual(b.getAttribute('tabindex'), '-1');
  assert.ok(one(b, 'svg[data-ico="cmp"]'));
  assert.strictEqual(all(rows[1], 'button.r-cmp').length, 0);

  calls.length = 0;
  b.fire('click');
  assert.deepStrictEqual(calls, [['cmp', 'd']], 'the button does not also select the row');
  rows[2].fire('click');
  assert.deepStrictEqual(calls.pop(), ['row', 'b']);
}

{ // Re-rendering starts clean even when the rail marked a row itself.
  const host = mount();
  UI.renderFolderRailList(host, rail({ rows: [row({})] }));
  one(host, '.r-row').classList.add('cur');
  UI.renderFolderRailList(host, rail({ rows: [row({}), row({ id: 'e2', domId: 'rail-e2' })] }));
  assert.strictEqual(all(host, '.r-row').length, 2);
  assert.strictEqual(all(host, '.r-row.cur').length, 0);
}
