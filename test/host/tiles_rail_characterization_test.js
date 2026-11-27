'use strict';
// ADR 0004 Phase 3 contracts at the webview boundary.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDom, Element, Node } = require('./fake-dom');
const { unifiedHtml } = require('../../src/unified-html');
const VpePlayerUi = require('../../media/player-ui');
const { createFakeEngine } = require('../../tools/mockup/fake-engine');

const widgets = {
  VpeUi: require('../../media/ui-primitives'),
  VpeControls: require('../../media/controls'),
  VpeFolderRail: require('../../media/folder-rail'),
  VpeCtxMenu: require('../../media/ctxmenu'),
  VpeAbLoop: require('../../media/abloop'),
  VpeAutoplay: require('../../media/autoplay'),
  VpeTime: require('../../media/timefmt'),
  VpePicture: require('../../media/picture'),
  VpePlayerUiTools: require('../../media/player-ui-tools'),
  VpePlayerUiInput: require('../../media/player-ui-input'),
  VpePlayerUiTiles: require('../../media/player-ui-tiles'),
  CompareGrid: require('../../media/compare-grid'),
};

function viewer(t, { count = 3, folder = false } = {}) {
  const html = unifiedHtml({
    cspSource: 'csp:', uri: (file) => 'u/' + file, base: 'b', loader: 'l.js', nonce: 'N',
    cfg: {}, folder,
  });
  const { doc, win, $, setRect } = createDom(/<body[^>]*>([^]*)<\/body>/.exec(html)[1]);
  setRect($('stage'), { width: 680, height: 370 });
  const globals = {
    document: doc, window: win, Element, HTMLElement: Element, Node,
    VpeRangeDrag: require('../../media/range-drag'),
    innerWidth: win.innerWidth, innerHeight: win.innerHeight,
    matchMedia: win.matchMedia.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((name) => [
    name, Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  let ui;
  t.after(() => {
    try { ui?.dispose(); } finally {
      for (const name of Object.keys(globals)) {
        if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
        else delete globalThis[name];
      }
    }
  });
  Object.assign(globalThis, globals);
  const engine = { ...createFakeEngine(), draw() {} };
  const messages = [];
  const host = { post: (msg) => messages.push(msg) };
  const tiles = engine.clips.slice(0, count).map((clip) => clip.id);
  ui = VpePlayerUi.create({
    doc, win, engine, host, widgets, stateApi: require('../../media/player-state'),
    initial: { tiles, layout: 'grid', frame: 0 }, prefs: { muted: false }, tickMs: 0,
  });
  ui.render();
  return { $, doc, ui, messages, clips: engine.clips };
}

const aria = (el, name) => el.getAttribute(`aria-${name}`);
const label = (el) => aria(el, 'label');

function find(root, selector) {
  const el = root.querySelector(selector);
  assert.ok(el, `Expected ${selector}`);
  return el;
}

const tile = ($, clip) => find($('cells'), `.cell[data-clip="${clip.id}"]`);
const action = (cell, name) => find(cell, `button[data-act="${name}"]`);

test('tile pills identify A through C and update the live frame readout', (t) => {
  const { $, ui, clips } = viewer(t);
  function checkPills(frame) {
    for (const [i, letter] of ['A', 'B', 'C'].entries()) {
      const cell = tile($, clips[i]);
      assert.equal(find(cell, '.pill .ltr').textContent, letter);
      assert.equal(find(cell, '.pill .nm').textContent, clips[i].name);
      assert.equal(find(cell, '.pill .fr').textContent, `#${frame}`);
      const info = action(cell, 'info');
      assert.equal(label(info), `Toggle details for ${letter}`);
      assert.equal(aria(info, 'pressed'), 'false');
    }
  }
  checkPills(0);
  ui.dispatch('seek', 48);
  checkPills(48);
});

test('tile sound switches between sources, mutes, and leaves silent clips disabled', (t) => {
  const { $, clips } = viewer(t);
  const sound = (i) => action(tile($, clips[i]), 'sound');
  const checkSound = (i, name, on) => {
    assert.equal(label(sound(i)), name);
    assert.equal(aria(sound(i), 'pressed'), String(on));
  };
  checkSound(0, 'Mute A', true);
  checkSound(1, 'Sound from B', false);
  sound(0).click();
  checkSound(0, 'Sound from A', false);
  sound(0).click();
  checkSound(0, 'Mute A', true);
  sound(1).click();
  checkSound(0, 'Sound from A', false);
  checkSound(1, 'Mute B', true);
  assert.equal(label(sound(2)), 'No audio track in C');
  assert.equal(aria(sound(2), 'disabled'), 'true');
  assert.equal(aria(sound(2), 'pressed'), null);
  sound(2).click();
  checkSound(1, 'Mute B', true);
});

test('a tile can enlarge into Spotlight and return to Grid', (t) => {
  const { $, clips } = viewer(t);
  const enlarge = () => action(tile($, clips[0]), 'enlarge');
  assert.equal(label(enlarge()), 'Enlarge tile A');
  enlarge().click();
  assert.equal(aria($('spotlightBtn'), 'pressed'), 'true');
  assert.equal(label(enlarge()), 'Back to grid A');
  enlarge().click();
  assert.equal(aria($('gridBtn'), 'pressed'), 'true');
  assert.equal(label(enlarge()), 'Enlarge tile A');
});

test('removing from three tiles prompts inline, then removing from two takes one click', (t) => {
  const { $, clips } = viewer(t);
  const remove = (i) => action(tile($, clips[i]), 'remove');
  const count = () => $('cells').querySelectorAll('.cell:not(.add)').length;
  assert.equal(count(), 3);
  assert.equal(label(remove(2)), 'Remove C from compare');
  remove(2).click();
  assert.equal(count(), 3);
  assert.equal(remove(2).textContent, 'Remove?');
  assert.equal(label(remove(2)), `Confirm remove ${clips[2].name} from Compare`);
  remove(2).click();
  assert.equal(count(), 2);
  assert.equal($('cells').querySelector(`.cell[data-clip="${clips[2].id}"]`), null);
  assert.equal(label(remove(1)), 'Remove B from compare');
  remove(1).click();
  assert.equal(count(), 1);
  assert.ok(tile($, clips[0]));
  assert.equal($('cells').querySelector('[data-act="remove"]'), null);
});

test('Sync mode exposes nudges, updates offset labels, and marks a tile with no frame', (t) => {
  const { $, clips } = viewer(t, { count: 2 });
  const stage = $('stage');
  const cell = () => tile($, clips[1]);
  const pill = () => find(cell(), '.sync-pill[role="group"][aria-label="Offset of B"]');
  const offset = (text, description) => {
    const readout = find(pill(), '.offv');
    assert.equal(readout.textContent, text);
    assert.equal(label(readout), `Offset of B: ${description}`);
  };
  assert.equal(stage.classList.contains('sync-mode'), false);
  $('syncBtn').click();
  assert.ok(find(stage, '#cells .sync-pill'));
  assert.equal(stage.classList.contains('sync-mode'), true);
  offset('0', 'In step');
  const earlier = find(pill(), '[aria-label="B earlier"]');
  assert.equal(earlier.textContent, '−');
  earlier.click();
  offset('−1 f', '−1 frame');
  assert.equal(cell().classList.contains('ended'), true);
  assert.equal(find(cell(), '.fr').textContent, '—');
  assert.equal(find(cell(), '.ended-badge').textContent, 'No frame (clip ended)');
  const later = () => find(pill(), '[aria-label="B later"]');
  assert.equal(later().textContent, '+');
  later().click();
  offset('0', 'In step');
  assert.equal(cell().classList.contains('ended'), false);
  later().click();
  offset('+1 f', '+1 frame');
  assert.equal(find(cell(), '.fr').textContent, '#1');
  $('syncBtn').click();
  assert.equal(stage.classList.contains('sync-mode'), false);
});

test('tile details show facts, highlight differences from A, and close with focus restored', (t) => {
  const { $, doc, clips } = viewer(t, { count: 2 });
  const [a, b] = clips.slice(0, 2).map((clip) => tile($, clip));
  const card = (cell) => find(cell, '.tile-stats');
  const info = (cell) => action(find(cell, '.pill'), 'info');
  const facts = (cell) => {
    const values = card(cell).querySelectorAll('dd');
    return new Map(card(cell).querySelectorAll('dt').map((el, i) => [el.textContent, values[i]]));
  };
  assert.equal(b.classList.contains('show-stats'), false);
  info(a).click();
  info(b).click();
  assert.equal(aria(info(b), 'pressed'), 'true');
  assert.equal(b.classList.contains('show-stats'), true);
  assert.equal(find(card(b), '.iname').textContent, clips[1].name);
  assert.equal(card(a).querySelectorAll('.diff').length, 0);
  const rows = facts(b);
  assert.match(rows.get('Video').textContent, /ProRes 422.*1920×1080.*24 fps/);
  assert.equal(rows.get('Video').classList.contains('diff'), true);
  assert.equal(rows.get('Frames').textContent, '240 f');
  assert.equal(rows.get('Frames').classList.contains('diff'), false);
  find(card(b), 'button[aria-label="Close details for B"]').click();
  assert.equal(b.classList.contains('show-stats'), false);
  assert.equal(aria(info(b), 'pressed'), 'false');
  assert.equal(doc.activeElement, info(b));
  assert.equal(a.classList.contains('show-stats'), true);
  info(a).click();
  assert.equal(a.classList.contains('show-stats'), false);
});

for (const folder of [false, true]) {
  test(`the spare Grid slot opens ${folder ? 'the Folder Rail' : 'the video picker'}`, (t) => {
    const { $, ui, messages, clips } = viewer(t, { folder });
    const add = find($('cells'), '.cell.add .addcell');
    assert.equal(add.textContent, '+ Add video');
    add.click();
    if (folder) {
      assert.equal($('rail').hidden, false);
      assert.ok(messages.some((msg) => msg.type === 'rail' && msg.op === 'open'));
    } else {
      const pick = messages.find((msg) => msg.type === 'pickVideo');
      assert.deepEqual(pick?.exclude, clips.slice(0, 3).map((clip) => clip.id));
    }
    ui.onHostMessage({ type: 'openVideo', clipId: clips[3].id, compare: true });
    assert.equal($('cells').querySelector('.cell.add'), null);
    assert.ok(tile($, clips[3]));
  });
}

test('Folder Rail synchronizes the capsule and close button with its visibility', (t) => {
  const { $, ui, messages } = viewer(t, { count: 1, folder: true });
  ui.onHostMessage({ type: 'rail', op: 'pos', index: 0, count: 4 });
  const checkOpen = (open) => {
    assert.equal($('rail').hidden, !open);
    assert.equal(aria($('capCount'), 'expanded'), String(open));
  };
  checkOpen(false);
  for (const closer of ['railClose', 'capCount']) {
    $('capCount').click();
    checkOpen(true);
    $(closer).click();
    checkOpen(false);
  }
  assert.deepEqual(messages.filter((msg) => msg.type === 'rail' && ['open', 'close'].includes(msg.op))
    .map((msg) => msg.op), ['open', 'close', 'open', 'close']);
});

test('Folder Rail filters rows, navigates and adds to Compare, and marks current members', (t) => {
  const { $, ui, messages, clips } = viewer(t, { count: 1, folder: true });
  const [a, b, c, d] = clips;
  const gen = 7;
  ui.onHostMessage({ type: 'rail', op: 'pos', index: 0, count: 4 });
  $('capCount').click();
  ui.onHostMessage({
    type: 'rail', op: 'list', gen, crumb: 'Dailies', current: a.id,
    entries: [a, b, c, d].map(({ id, name }) => ({ id, name, kind: 'video' }))
      .concat({ id: 'notes', name: 'Notes.txt', kind: 'file' }),
  });
  const row = (clip) => find($('railList'), `.r-row[data-id="${clip.id}"]`);
  const names = () => $('railList').querySelectorAll('.r-name').map((el) => el.textContent);
  const filter = (value) => {
    $('railFilter').value = value;
    $('railFilter').fire('input');
  };
  const playable = $('railPlayable');
  const videos = [a.name, b.name, c.name, d.name];
  assert.equal($('railPos').textContent, '1/4');
  assert.deepEqual(names(), videos);
  assert.equal(aria(playable, 'checked'), 'true');
  playable.click();
  assert.equal(aria(playable, 'checked'), 'false');
  assert.deepEqual(names(), [...videos, 'Notes.txt']);
  filter('RAw');
  assert.deepEqual(names(), [b.name]);
  filter('nOtEs');
  assert.deepEqual(names(), ['Notes.txt']);
  playable.click();
  assert.equal(aria(playable, 'checked'), 'true');
  assert.deepEqual(names(), []);
  assert.equal(find($('railList'), '.r-empty').textContent, 'No matching files');
  filter('');
  assert.deepEqual(names(), videos);
  assert.equal(row(a).classList.contains('active'), true);
  assert.equal(aria(row(a), 'selected'), 'true');
  assert.equal(aria(row(b), 'selected'), 'false');
  row(b).click();
  find(row(b), `button[aria-label="Compare with ${b.name}"]`).click();
  const requests = messages.filter((msg) => msg.type === 'rail' && ['activate', 'compare'].includes(msg.op));
  assert.deepEqual(requests.map(({ op, id, gen }) => ({ op, id, gen })), [
    { op: 'activate', id: b.id, gen }, { op: 'compare', id: b.id, gen },
  ]);
  ui.onHostMessage({ type: 'openVideo', clipId: b.id, compare: true });
  ui.onHostMessage({ type: 'rail', op: 'members', gen, ids: [a.id, b.id], count: 2 });
  assert.equal($('railPos').textContent, '2 in Compare');
  assert.equal(row(a).classList.contains('active'), true);
  assert.equal(row(b).classList.contains('active'), false);
  assert.equal(row(a).classList.contains('in-cmp'), true);
  assert.equal(row(b).classList.contains('in-cmp'), true);
  assert.equal(aria(row(b), 'selected'), 'true');
  assert.equal(row(c).classList.contains('in-cmp'), false);
  assert.equal(aria(row(c), 'selected'), 'false');
});
