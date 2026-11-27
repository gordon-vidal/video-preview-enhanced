'use strict';
// ADR 0004 Phase 2 contracts at the webview boundary.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDom, Element, Node } = require('./fake-dom');
const { unifiedHtml } = require('../../src/unified-html');
const VpePlayerUi = require('../../media/player-ui');
const { createFakeEngine } = require('../../tools/mockup/fake-engine');
const { createFakeHost } = require('../../tools/mockup/fake-host');

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

function viewer(t, tiles = ['clip-0']) {
  const html = unifiedHtml({
    cspSource: 'csp:', uri: (file) => 'u/' + file, base: 'b', loader: 'l.js', nonce: 'N',
    cfg: {}, folder: true,
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
  const host = createFakeHost({ clips: engine.clips });
  ui = VpePlayerUi.create({
    doc, win, engine, host, widgets, stateApi: require('../../media/player-state'),
    initial: { tiles, layout: 'grid' }, prefs: { muted: false }, tickMs: 0,
  });
  host.connect(ui.onHostMessage);
  ui.render();
  ui.onHostMessage({ type: 'rail', op: 'pos', index: 0, count: 4 });
  ui.onHostMessage({ type: 'subs', tracks: [{ title: 'English' }] });
  const panel = $('panel');
  return { $, ui, panel, sources: engine.clips, click: (id) => $(id).click() };
}

const aria = (el, name) => el.getAttribute('aria-' + name);
const label = (el) => aria(el, 'label');

function button(panel, name) {
  const found = panel.querySelectorAll('button').find((el) => name.test(label(el) ?? el.textContent.trim()));
  assert.ok(found, `Expected a button named ${name}`);
  return found;
}

function showPanel(panel, name) {
  assert.equal(panel.hidden, false);
  assert.equal(label(panel), name);
}

function pressed(el, on, className) {
  assert.equal(aria(el, 'pressed'), String(on), el.id || el.textContent);
  if (className) assert.equal(el.classList.contains(className), on, el.id);
}

test('single-video play, step controls and time formats follow the on-screen position', (t) => {
  const { $, ui, click, panel } = viewer(t);
  const checkPlay = (name, playing) => {
    assert.equal(label($('play')), name);
    assert.equal($('play').classList.contains('playing'), playing);
  };
  checkPlay('Play', false);
  click('play');
  checkPlay('Pause', true);
  click('play');
  checkPlay('Play', false);
  // Step forward and back at each chosen size. The badge click itself leaves the playhead in place.
  ui.dispatch('seek', 48);
  for (const [badge, option, delta] of [['1f', null, 1], ['5f', /^5 frames$/, 5], ['1s', /^1 s$/, 24]]) {
    if (option) {
      click('nextSize');
      showPanel(panel, 'Step size');
      assert.equal($('seek').value, '48');
      button(panel, option).click();
    }
    assert.equal($('prevSize').textContent, badge);
    assert.equal($('nextSize').textContent, badge);
    click('next');
    assert.equal($('seek').value, String(48 + delta));
    click('prev');
    assert.equal($('seek').value, '48');
  }
  assert.equal($('now').textContent, '0:02.000');
  for (const [format, now] of [['Timecode', '00:00:02:00'], ['Frame number', 'frame 49'], ['Time', '0:02.000']]) {
    click('time');
    assert.equal($('now').textContent, now);
    assert.equal($('toast').textContent, format);
  }
});

test('single-video audio controls expose mute and unmute state', (t) => {
  const { $, click } = viewer(t);
  assert.equal($('mute').disabled, false);
  assert.equal($('volume').disabled, false);
  assert.equal(label($('mute')), 'Mute');
  click('mute');
  assert.equal(label($('mute')), 'Unmute');
  pressed($('mute'), true, 'muted');
  click('mute');
  assert.equal(label($('mute')), 'Mute');
  pressed($('mute'), false, 'muted');
});

test('single-video controls show a disabled mute button and volume slider for a silent clip', (t) => {
  const { $ } = viewer(t, ['clip-2']);
  assert.equal($('mute').disabled, true);
  assert.equal($('volume').disabled, true);
  assert.equal(label($('mute')), 'No audio track');
  assert.equal(aria($('mute'), 'pressed'), null);
});

test('single-video range buttons place and clear seek pins', (t) => {
  const { $, ui, click } = viewer(t);
  const rangeEnd = (letter, set) => {
    pressed($(`set${letter}Btn`), set);
    assert.equal($(`ab${letter}`).hidden, !set);
  };
  rangeEnd('A', false);
  rangeEnd('B', false);
  ui.dispatch('seek', 48);
  click('setABtn');
  rangeEnd('A', true);
  rangeEnd('B', false);
  ui.dispatch('seek', 96);
  click('setBBtn');
  rangeEnd('B', true);
  assert.equal($('abMarks').hidden, false);
  assert.ok(parseFloat($('abA').style.left) < parseFloat($('abB').style.left));
  ui.dispatch('clearAB');
  rangeEnd('A', false);
  rangeEnd('B', false);
  assert.equal($('abMarks').hidden, true);
});

test('single-video picture size, speed reset, capture banner and folder capsule', (t) => {
  const { $, click, panel } = viewer(t);
  assert.equal($('folderCap').hidden, false);
  assert.equal($('tracks').hidden, false);
  for (const [mode, current, next] of [
    ['fit', 'Fit', 'Fill'], ['fill', 'Fill', 'Stretch'], ['stretch', 'Stretch', '100%'], ['actual', '100%', 'Fit'],
  ]) {
    assert.equal($('picBtn').dataset.mode, mode);
    assert.equal(label($('picBtn')), `Picture size: ${current}. Next: ${next}`);
    click('picBtn');
  }
  assert.equal($('picBtn').dataset.mode, 'fit');
  assert.equal($('rate').textContent, '1×');
  assert.equal($('rateReset').hidden, true);
  click('rate');
  showPanel(panel, 'Speed');
  button(panel, /^Speed 1\.5×$/).click();
  assert.equal($('rate').textContent, '1.5×');
  assert.equal(label($('rate')), 'Speed 1.5×');
  assert.equal($('rateReset').hidden, false);
  click('rateReset');
  assert.equal($('rate').textContent, '1×');
  assert.equal($('rateReset').hidden, true);
  pressed($('startCompareBtn'), false, 'cap-on');
  // Add mode's prompt is a #notice now (docs/notes/notifications.md).
  const prompt = () => !$('notice').hidden && $('notice').dataset.kind === 'capture';
  assert.equal(prompt(), false);
  click('startCompareBtn');
  pressed($('startCompareBtn'), true, 'cap-on');
  assert.equal(prompt(), true);
  click('startCompareBtn');
  pressed($('startCompareBtn'), false, 'cap-on');
  assert.equal(prompt(), false);
});

for (const n of [1, 2, 3]) {
  test(`bar control visibility with ${n} video(s)`, (t) => {
    const { $, click, ui } = viewer(t, Array.from({ length: n }, (_, i) => `clip-${i}`));
    for (const id of ['spotlightBtn', 'gridBtn', 'syncBtn', 'cmpBtn']) assert.equal($(id).hidden, n === 1, id);
    for (const id of ['splitBtn', 'swapBtn']) assert.equal($(id).hidden, n !== 2, id);
    for (const id of ['folderCap', 'tracks']) assert.equal($(id).hidden, n >= 2, id);
    assert.ok($('timeLetter').classList.contains('who'));
    assert.equal($('timeLetter').textContent.trim(), n === 1 ? '' : 'A');
    if (n === 1) return;
    assert.match($('time').textContent, /^A\s+\d/);
    ui.dispatch('setClock', 'clip-1');
    assert.equal($('timeLetter').textContent.trim(), 'B');
    assert.match($('time').textContent, /^B\s+\d/);
    assert.match(aria($('seek'), 'valuetext'), /^B\s/);
    const layouts = ['spotlightBtn', 'gridBtn', ...(n === 2 ? ['splitBtn'] : [])];
    const selected = (id) => {
      for (const layout of layouts) pressed($(layout), layout === id, 'active');
    };
    selected('gridBtn');
    for (const id of layouts) {
      click(id);
      selected(id);
    }
    if (n === 2) {
      click('swapBtn');
      assert.match($('time').textContent, /^A\s+\d/);
    }
    pressed($('syncBtn'), false, 'active');
    click('syncBtn');
    pressed($('syncBtn'), true, 'active');
    click('syncBtn');
    pressed($('syncBtn'), false, 'active');
  });
}

test('Settings opens each subpage and its Back button returns to Settings', (t) => {
  const { $, click, panel } = viewer(t);
  click('cog');
  showPanel(panel, 'Player settings');
  assert.equal(aria($('cog'), 'expanded'), 'true');
  for (const [name, content] of [
    ['Autoplay', /Play next in folder/i],
    ['Picture size', /Stretch/],
    ['Subtitles', /English/],
    ['A–B Range', /Clear A–B Range/],
    ['Inspection', /Pixel inspector/i],
  ]) {
    button(panel, new RegExp(`^${name}`)).click();
    showPanel(panel, name);
    button(panel, content);
    button(panel, new RegExp(`^Back from ${name}$`)).click();
    showPanel(panel, 'Player settings');
  }
  click('cog');
  assert.equal(panel.hidden, true);
  assert.equal(aria($('cog'), 'expanded'), 'false');
});

test('Compare panel controls reflect in the bar and Leave compare keeps the clock video', (t) => {
  const { $, click, panel, sources, ui } = viewer(t, ['clip-0', 'clip-1']);
  click('cmpBtn');
  showPanel(panel, 'Compare');
  assert.equal(aria($('cmpBtn'), 'expanded'), 'true');
  const a = button(panel, /^A: /);
  assert.equal(label(a), `A: ${sources[0].name}, offset In step, sets the clock, sound on`);
  assert.match(a.textContent, /⏱.*🔊.*0/u);
  assert.equal(label(button(panel, /^B: /)), `B: ${sources[1].name}, offset In step`);
  const layout = panel.querySelector('[role="group"][aria-label="Layout"]');
  assert.deepEqual(layout.querySelectorAll('button').map((el) => el.textContent), ['Spotlight', 'Grid', 'Split']);
  pressed(button(layout, /^Grid$/), true);
  button(layout, /^Split$/).click();
  pressed(button(panel, /^Split$/), true);
  pressed($('splitBtn'), true, 'active');
  for (const [name, id, className] of [
    ['Sync offsets on tiles', 'syncBtn', 'active'], ['Open new videos here', 'startCompareBtn', 'cap-on'],
  ]) {
    const toggle = () => button(panel, new RegExp(`^${name}`));
    assert.equal(toggle().getAttribute('role'), 'switch');
    assert.equal(aria(toggle(), 'checked'), 'false', name);
    pressed($(id), false, className);
    for (const on of [true, false]) {
      toggle().click();
      assert.equal(aria(toggle(), 'checked'), String(on), name);
      pressed($(id), on, className);
    }
  }
  ui.dispatch('setClock', 'clip-1');
  // Reopen to read the updated row and Leave compare label.
  click('cmpBtn');
  click('cmpBtn');
  button(panel, /^Leave compare, keep B$/).click();
  assert.equal(panel.hidden, true);
  assert.equal($('cmpBtn').hidden, true);
  click('infoBtn');
  assert.ok(panel.textContent.includes(sources[1].name));
});

test('per-video Compare panel nudges offsets, changes units, clock and sound, and enlarges the tile', (t) => {
  const { $, click, panel, sources } = viewer(t, ['clip-0', 'clip-1']);
  click('cmpBtn');
  button(panel, /^B: /).click();
  showPanel(panel, `B: ${sources[1].name}`);
  const offset = (description, visible) => {
    const readout = panel.querySelector(`[aria-label="Offset of B: ${description}"]`);
    assert.ok(readout, description);
    assert.equal(readout.textContent, visible);
  };
  pressed(button(panel, /^Frames$/), true);
  offset('In step', '0');
  button(panel, /^B earlier$/).click();
  offset('−1 frame', '−1 f');
  button(panel, /^B later$/).click();
  offset('In step', '0');
  button(panel, /^B later$/).click();
  offset('+1 frame', '+1 f');
  button(panel, /^Time ms$/).click();
  pressed(button(panel, /^Time ms$/), true);
  offset('+41.7 ms', '+41.7 ms');
  button(panel, /^B later$/).click();
  offset('+51.7 ms', '+51.7 ms');
  button(panel, /^Back from B /).click();
  const row = button(panel, /^B: /);
  assert.match(label(row), /offset \+51\.7 ms$/);
  assert.match(row.textContent, /\+51\.7 ms/);
  row.click();
  button(panel, /^Reset the offset of B$/).click();
  offset('In step', '0');
  assert.ok(!panel.textContent.includes('Reset offset'));
  pressed(button(panel, /^Time ms$/), true);
  for (const name of [/^B sets the clock$/, /^Sound from B$/]) {
    assert.equal(aria(button(panel, name), 'checked'), 'false');
    button(panel, name).click();
    assert.equal(aria(button(panel, name), 'checked'), 'true');
  }
  assert.match($('time').textContent, /^B\s/);
  assert.equal(label($('mute')), 'Mute (sound from B)');
  button(panel, /^Enlarge tile$/).click();
  pressed($('spotlightBtn'), true, 'active');
  button(panel, /^Back to grid$/).click();
  pressed($('gridBtn'), true, 'active');
  button(panel, /^Back from B /).click();
  showPanel(panel, 'Compare');
  assert.match(label(button(panel, /^B: /)), /sets the clock, sound on$/);
});

test('Info identifies one video and adds selectable letter tabs in Compare', (t) => {
  const { $, ui, click, panel, sources } = viewer(t);
  click('infoBtn');
  showPanel(panel, 'About this video');
  assert.equal(aria($('infoBtn'), 'expanded'), 'true');
  assert.equal(panel.querySelector('[role="tablist"]'), null);
  assert.ok(panel.textContent.includes(sources[0].name));
  click('infoBtn');
  for (const clipId of ['clip-1', 'clip-2']) ui.onHostMessage({ type: 'openVideo', clipId, compare: true });
  click('infoBtn');
  showPanel(panel, 'About these videos');
  const tabs = () => panel.querySelector('[role="tablist"]').querySelectorAll('[role="tab"]');
  assert.deepEqual(tabs().map((el) => el.textContent), ['A', 'B', 'C']);
  assert.deepEqual(tabs().map((el) => aria(el, 'selected')), ['true', 'false', 'false']);
  for (const i of [1, 2, 0]) {
    tabs()[i].click();
    assert.deepEqual(tabs().map((el) => aria(el, 'selected')), ['A', 'B', 'C'].map((_, j) => String(j === i)));
    assert.ok(panel.textContent.includes(sources[i].name));
  }
});
