'use strict';
// Millisecond tests for the shared webview UI controller (media/player-ui.js): its pure helpers, the FakeHost
// protocol (tools/mockup/fake-host.js), and create() end to end over the REAL widgets (controls.js, folder-rail.js,
// ctxmenu.js, abloop.js, autoplay.js) on a tiny permissive fake DOM. The fake DOM does not lay out or parse HTML:
// it only lets the real code run so the adapter contracts (what the page posts, how it answers the host, which
// bar controls follow the state) are checked without a browser or VS Code.
const assert = require('assert');
const S = require('../../media/player-state');
const PUI = require('../../media/player-ui');
const { createFakeEngine } = require('../../tools/mockup/fake-engine');
const { createFakeHost } = require('../../tools/mockup/fake-host');
const { buildMockupHtml, SCENARIOS } = require('../../tools/mockup/render');

// ---- 1. keyAction: the same keys as media/player.js / media/compare.js ----
{
  const k = (key, mods = {}) => PUI.keyAction({ key, ...mods });
  assert.strictEqual(k(' '), 'playPause');
  assert.strictEqual(k('k'), 'playPause');
  assert.strictEqual(k(','), 'prevFrame');
  assert.strictEqual(k('.'), 'nextFrame');
  assert.strictEqual(k('m'), 'mute');
  assert.strictEqual(k('R'), 'loop');
  assert.strictEqual(k('a'), 'setA');
  assert.strictEqual(k('A', { shiftKey: true }), null, 'Shift+A is the audio track key, not A–B');
  assert.strictEqual(k('b'), 'setB');
  assert.strictEqual(k('Z'), 'cyclePicture');
  assert.strictEqual(k('Z', { shiftKey: true }), null);
  assert.strictEqual(k('i'), 'info');
  assert.strictEqual(k('?'), 'keys');
  assert.strictEqual(k('Escape'), 'escape');
  assert.strictEqual(k('D', { shiftKey: true }), 'capture');
  assert.strictEqual(k('N', { shiftKey: true }), 'nextVideo');
  assert.strictEqual(k('P', { shiftKey: true }), 'prevVideo');
  assert.strictEqual(k(',', { ctrlKey: true }), null, 'modified keys are left to VS Code');
  assert.strictEqual(k('q'), null);
}

// ---- 2. formatTime: clock, timecode, frame number ----
{
  assert.strictEqual(PUI.formatTime(48, 24, 0), '0:02.00');
  assert.strictEqual(PUI.formatTime(48, 24, 2), '#48');
  assert.strictEqual(PUI.formatTime(48, 24, 1, (f, r) => `tc${f}@${r}`), 'tc48@24');
  assert.strictEqual(PUI.formatTime(1500, 24, 0), '1:02.50');
}

// ---- 3. applyHostMessage: the pure half of host -> page ----
{
  const getClip = (id) => ({ id, name: `${id}.mp4` });
  let ws = S.createWorkspaceState({ tiles: ['clip-0'] });
  let r = PUI.applyHostMessage(S, ws, { type: 'nope' }, getClip);
  assert.strictEqual(r.handled, false);
  assert.strictEqual(r.state, ws);

  r = PUI.applyHostMessage(S, ws, { type: 'openVideo', clipId: 'clip-1', replace: true }, getClip);
  assert.deepStrictEqual(S.getTab(r.state).tiles, ['clip-1'], 'replace swaps the single video in place');

  r = PUI.applyHostMessage(S, ws, { type: 'openVideo', clipId: 'clip-2', compare: true }, getClip);
  assert.deepStrictEqual(S.getTab(r.state).tiles, ['clip-0', 'clip-2'], 'compare turns capture on and joins');
  assert.strictEqual(S.getTab(r.state).capture, true);
  assert.ok(r.toast.includes('clip-2.mp4'));

  ws = r.state;
  r = PUI.applyHostMessage(S, ws, { type: 'openVideo', clipId: 'clip-3', replace: true }, getClip);
  assert.deepStrictEqual(S.getTab(r.state).tiles, ['clip-0', 'clip-2', 'clip-3'], 'replace in Compare falls back to open (capture joins)');
}

// ---- 4. replaceVideo (player-state) and compareRows ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0'], capture: true, frame: 30 });
  ws = S.replaceVideo(ws, 'clip-4');
  const t = S.getTab(ws);
  assert.deepStrictEqual(t.tiles, ['clip-4']);
  assert.strictEqual(t.capture, true, 'navigation keeps capture');
  assert.strictEqual(t.frame, 0);
  const multi = S.openVideo(ws, 'clip-1').state;
  assert.strictEqual(S.replaceVideo(multi, 'clip-2'), multi, 'multi-video tabs are left alone');

  const rows = PUI.compareRows(S, S.getTab(S.nudgeOffset(multi, 'clip-1', -3)), (id) => ({ id, name: id.toUpperCase() }));
  assert.deepStrictEqual(rows.map((r) => [r.letter, r.name, r.offText]), [['A', 'CLIP-4', '+0 f'], ['B', 'CLIP-1', '-3 f']]);
}

// ---- 5. FakeHost: the folder rail protocol of src/folder-rail.js, in Node ----
{
  const engine = createFakeEngine();
  const out = [];
  const host = createFakeHost({ clips: engine.clips, deliver: (m) => out.push(m) });
  host.post({ type: 'tiles', tabId: 1, tiles: ['clip-1'], current: 'clip-1' });
  assert.deepStrictEqual(out.shift(), { type: 'rail', op: 'pos', index: 1, count: 4 });
  host.post({ type: 'rail', op: 'open' });
  const list = out.shift();
  assert.strictEqual(list.op, 'list');
  assert.strictEqual(list.current, 'clip-1');
  assert.deepStrictEqual(list.entries.map((e) => e.kind), ['dir', 'video', 'video', 'video', 'video', 'file']);
  const meta = out.shift();
  assert.strictEqual(meta.op, 'meta');
  assert.strictEqual(meta.gen, list.gen, 'meta answers the same listing');
  assert.ok(Array.isArray(meta.patches) && meta.patches.every((p) => typeof p.id === 'string'), 'meta carries patches[] like src/folder-rail.js');
  assert.strictEqual(out.shift().op, 'pos');

  host.post({ type: 'rail', op: 'activate', gen: list.gen, id: 'clip-2' });
  assert.deepStrictEqual(out.shift(), { type: 'openVideo', clipId: 'clip-2', label: engine.getClip('clip-2').name, replace: true });
  host.post({ type: 'rail', op: 'compare', gen: list.gen, id: 'clip-3' });
  assert.strictEqual(out.shift().compare, true);
  host.post({ type: 'rail', op: 'activate', gen: list.gen - 1, id: 'clip-2' });
  assert.strictEqual(out.length, 0, 'a stale listing generation is ignored');

  host.post({ type: 'rail', op: 'browse', gen: list.gen, id: 'dir:renders' });
  const sub = out.shift();
  assert.ok(sub.crumb.endsWith('renders'));
  assert.strictEqual(sub.entries[0].kind, 'up');
  out.length = 0;
  host.post({ type: 'rail', op: 'browse', gen: sub.gen, id: 'up:root' });
  assert.strictEqual(out.shift().from, 'dir:renders', 'walking up puts the cursor on the folder walked out of');
  out.length = 0;

  host.post({ type: 'neighbour', d: 1 });
  assert.strictEqual(out.shift().clipId, 'clip-2');
  host.post({ type: 'neighbour', d: -1 });
  assert.strictEqual(out.shift().clipId, 'clip-0');
  host.post({ type: 'pickVideo', exclude: ['clip-0', 'clip-1'] });
  assert.deepStrictEqual([out[0].clipId, out[0].compare], ['clip-2', true]);
  out.length = 0;
  host.post({ type: 'saveFrame' });
  assert.strictEqual(out.shift().type, 'toast');
}

// ---- 6. create() validates its adapters before touching the DOM ----
{
  assert.throws(() => PUI.create(/** @type {any} */ ({})), /env\.doc/);
  assert.throws(() => PUI.create(/** @type {any} */ ({ doc: {}, stateApi: {} })), /stateApi/);
  assert.throws(() => PUI.create(/** @type {any} */ ({ doc: {}, stateApi: S, engine: {} })), /engine/);
  assert.throws(() => PUI.create(/** @type {any} */ ({ doc: {}, stateApi: S, engine: createFakeEngine(), host: {} })), /host/);
}

// ---- 7. create() end to end: real widgets, fake DOM, FakeEngine + FakeHost ----
const fakeDom = () => {
  const byId = new Map();
  /** @param {string} tag */
  function node(tag) {
    const store = new Map();
    const listeners = new Map();
    const attrs = new Map();
    const classes = new Set();
    const children = [];
    const self = new Proxy(function () {}, {
      apply: () => node('ret'),
      set: (_t, p, v) => { store.set(p, v); return true; },
      get: (_t, p) => {
        if (store.has(p)) return store.get(p);
        switch (p) {
          case Symbol.iterator: return function* () { yield* children; };
          case Symbol.toPrimitive: return () => '';
          case 'then': return undefined;
          case 'tagName': return String(tag).toUpperCase();
          case 'hidden': case 'disabled': case 'checked': case 'isContentEditable': return false;
          case 'isConnected': return true;
          case 'textContent': case 'innerHTML': case 'value': case 'title': case 'id': return '';
          case 'clientWidth': return 680;
          case 'clientHeight': return 370;
          case 'children': case 'childNodes': return children;
          case 'firstChild': return children[0] || null;
          case 'parentNode': case 'parentElement': return store.get('__parent') || null;
          case 'classList': return {
            add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
            toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
            contains: (c) => classes.has(c),
          };
          case 'style': { const st = { setProperty: () => {}, removeProperty: () => {} }; store.set('style', st); return st; }
          case 'dataset': { const d = {}; store.set('dataset', d); return d; }
          case 'addEventListener': return (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); };
          case 'removeEventListener': return (type, fn) => { const l = listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
          case 'fire': return (type, ev = {}) => {
            const e = { target: self, currentTarget: self, preventDefault() { e.defaultPrevented = true; }, stopPropagation() {}, ...ev };
            for (const fn of (listeners.get(type) || []).slice()) fn(e);
            return e;
          };
          case 'listenerCount': return (type) => (listeners.get(type) || []).length;
          case 'setAttribute': return (k, v) => attrs.set(k, String(v));
          case 'getAttribute': return (k) => (attrs.has(k) ? attrs.get(k) : null);
          case 'removeAttribute': return (k) => attrs.delete(k);
          case 'hasAttribute': return (k) => attrs.has(k);
          case 'appendChild': return (c) => { children.push(c); if (c && typeof c === 'function') c.__parent = self; return c; };
          case 'insertBefore': return (c) => { children.unshift(c); if (c && typeof c === 'function') c.__parent = self; return c; };
          case 'append': case 'prepend': case 'replaceChildren': return (...cs) => { children.push(...cs); };
          case 'remove': return () => {};
          case 'querySelector': case 'closest': return () => null;
          case 'querySelectorAll': return () => [];
          case 'contains': return (x) => x === self;
          case 'getBoundingClientRect': return () => ({ left: 0, top: 0, right: 680, bottom: 370, width: 680, height: 370, x: 0, y: 0 });
          case 'getClientRects': return () => [{}];
          case 'getElementById': return (id) => { if (!byId.has(id)) { const n = node('div'); n.id = id; byId.set(id, n); } return byId.get(id); };
          case 'createElement': return (t) => node(t);
          case 'createDocumentFragment': return () => node('#fragment');
          case 'createTextNode': return () => node('#text');
          default: { const n = node('auto'); store.set(p, n); return n; }
        }
      },
    });
    return self;
  }
  const doc = node('#document');
  doc.body = node('body');
  doc.activeElement = doc.body;
  const timers = [];
  const win = node('#window');
  win.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  win.clearInterval = (id) => { timers[id - 1] = null; };
  win.ResizeObserver = undefined;
  win.innerWidth = 1024;
  win.innerHeight = 768;
  win.devicePixelRatio = 1;
  return { doc, win, byId, timers, $: (id) => doc.getElementById(id) };
};

{
  const dom = fakeDom();
  // As in the real markup (src/player-html.js, src/folder-rail-html.js): popups and the rail start hidden.
  for (const id of ['panel', 'sheet', 'ctxmenu', 'rail', 'railHover', 'railColMenu', 'railEndMenu', 'capBanner', 'splitter', 'divider']) dom.$(id).hidden = true;
  // The widgets read a few browser globals directly (matchMedia for reduced motion, animation frames).
  const GLOBALS = {
    document: dom.doc, window: dom.win,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, HTMLElement: function HTMLElement() {},
  };
  const saved = Object.fromEntries(Object.keys(GLOBALS).map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
  Object.assign(global, GLOBALS);
  try {
    const widgets = {
      VpeControls: require('../../media/controls'),
      VpeFolderRail: require('../../media/folder-rail'),
      VpeCtxMenu: require('../../media/ctxmenu'),
      VpeAbLoop: require('../../media/abloop'),
      VpeAutoplay: require('../../media/autoplay'),
      VpeTime: require('../../media/timefmt'),
    };
    const engine = createFakeEngine();
    const drawn = [];
    const spyEngine = { ...engine, draw: (cv, id, frame, opts) => drawn.push({ id, frame, split: opts && opts.splitClipRatio }) };
    const host = createFakeHost({ clips: engine.clips });
    const changes = [];
    const ui = PUI.create({
      doc: dom.doc, win: dom.win, stateApi: S, engine: spyEngine, host, widgets,
      initial: { tiles: ['clip-0'] }, tickMs: 42, onChange: (ws, d) => changes.push(d),
    });
    host.connect(ui.onHostMessage);
    const $ = dom.$;
    const tab = () => S.getTab(ui.getState());

    // Every documented action is reachable by name.
    for (const a of ['playPause', 'prevFrame', 'nextFrame', 'mute', 'loop', 'setA', 'setB', 'clearAB', 'cyclePicture',
      'info', 'keys', 'escape', 'capture', 'split', 'sync', 'layout', 'enlarge', 'removeTile', 'nudge', 'leaveCompare',
      'pickVideo', 'nextVideo', 'prevVideo', 'cycleTime', 'fullscreen', 'seek', 'volume']) {
      assert.ok(ui.actions().includes(a), `action ${a}`);
    }

    ui.render();
    assert.ok(changes.length > 0, 'onChange runs after render');
    assert.deepStrictEqual(host.log.find((m) => m.type === 'tiles'), { type: 'tiles', tabId: 1, tiles: ['clip-0'], current: 'clip-0' },
      'the page tells the host which videos it shows');
    assert.strictEqual(drawn[drawn.length - 1].id, 'clip-0', 'the engine adapter draws the tile');
    assert.strictEqual($('splitBtn').hidden, true, 'Split only at N = 2');
    assert.strictEqual($('syncBtn').hidden, true, 'Sync only at N >= 2');
    assert.strictEqual($('tracks').hidden, false, 'CC at N = 1');

    // The real #bar buttons drive the state.
    $('play').fire('click');
    assert.strictEqual(tab().playing, true, '#play toggles playback');
    assert.strictEqual(dom.timers.filter(Boolean).length, 1, 'one playback clock');
    dom.timers[0].fn();
    assert.strictEqual(tab().frame, 49, 'the clock advances one frame while playing');
    $('prev').fire('click');
    assert.deepStrictEqual([tab().playing, tab().frame], [false, 48], '#prev pauses and steps back');
    $('next').fire('click');
    assert.strictEqual(tab().frame, 49);
    $('seek').value = '120';
    $('seek').fire('input');
    assert.strictEqual(tab().frame, 120, '#seek seeks');
    $('mute').fire('click');
    assert.strictEqual(ui.getPrefs().muted, false, '#mute toggles');
    $('time').fire('click');
    assert.strictEqual(ui.getPrefs().timeMode, 1, 'clicking the time cycles the format');
    assert.strictEqual($('now').textContent, widgets.VpeTime.fmtTimecode(120, 24));
    $('picBtn').fire('click');
    assert.strictEqual(ui.getPrefs().picMode, 'fill', 'Picture size cycles');

    // Keyboard shortcuts.
    const key = (k, mods = {}) => dom.doc.fire('keydown', { key: k, target: dom.doc.body, ...mods });
    key(',');
    assert.strictEqual(tab().frame, 119, ', steps back');
    key('.');
    key('.');
    assert.strictEqual(tab().frame, 121, '. steps forward');
    key(' ');
    assert.strictEqual(tab().playing, true, 'Space plays');
    key(' ');
    key('a');
    assert.ok(ui.ab.a !== null, 'A sets the range start');
    key('b');
    assert.ok(ui.ab.b !== null || ui.ab.a !== null, 'B sets the range end');
    key('Backspace');
    assert.strictEqual(ui.ab.isSet(), false, 'Backspace clears A–B');
    key('r');
    assert.strictEqual(ui.getPrefs().onEnd, 'loop', 'R loops');
    const typed = dom.doc.fire('keydown', { key: ',', target: { tagName: 'INPUT' } });
    assert.strictEqual(typed.defaultPrevented, undefined, 'keys typed into the rail filter are left alone');
    key('?');
    assert.strictEqual(ui.controls.sheetOpen(), true, '? opens the shortcuts sheet');
    key('Escape');
    assert.strictEqual(ui.controls.anyOpen(), false, 'Esc closes it');
    key('i');
    assert.strictEqual(ui.controls.view(), 'info', 'I opens About this video');
    key('Escape');

    // The real Folder Rail through FakeHost: open, list, activate, ‹ / ›.
    ui.rail.show();
    let snap = ui.rail.snapshot();
    assert.strictEqual(snap.open, true);
    assert.ok(snap.crumb.includes('dailies'), 'the host listed the folder');
    assert.ok(host.log.some((m) => m.type === 'rail' && m.op === 'open'), 'the rail posts its own open');
    const listGen = host.snapshot().gen;
    host.post({ type: 'rail', op: 'activate', gen: listGen, id: 'clip-2' });
    assert.deepStrictEqual(tab().tiles, ['clip-2'], 'activating a rail row opens that video in place');
    key('N', { shiftKey: true });
    assert.ok(host.log.some((m) => m.type === 'neighbour' && m.d === 1), 'Shift+N asks the host for the next video');
    assert.deepStrictEqual(tab().tiles, ['clip-3']);
    key('P', { shiftKey: true });
    assert.deepStrictEqual(tab().tiles, ['clip-2']);

    // Compare: capture, + compare from the rail, the bar follows N.
    key('D', { shiftKey: true });
    assert.strictEqual(tab().capture, true, 'Shift+D toggles capture');
    host.post({ type: 'rail', op: 'compare', gen: host.snapshot().gen, id: 'clip-0' });
    assert.deepStrictEqual(tab().tiles, ['clip-2', 'clip-0'], '+ compare joins the view');
    assert.strictEqual($('splitBtn').hidden, false, 'Split appears at N = 2');
    assert.strictEqual($('syncBtn').hidden, false, 'Sync appears at N >= 2');
    assert.strictEqual($('tracks').hidden, true, 'CC hides in Compare');
    assert.strictEqual($('folderCap').hidden, true, 'the folder capsule hides in Compare');
    const tilesMsg = host.log.filter((m) => m.type === 'tiles').pop();
    assert.deepStrictEqual(tilesMsg.tiles, ['clip-2', 'clip-0']);

    $('splitBtn').fire('click');
    assert.strictEqual(tab().layout, 'split', 'Split Wipe');
    assert.strictEqual($('divider').hidden, false, 'the divider shows');
    assert.ok(drawn.some((d) => d.split === tab().split), 'tile B is drawn clipped at the divider');
    $('syncBtn').fire('click');
    assert.strictEqual(tab().syncMode, true);

    ui.controls.show('cmp', $('startCompareBtn'));
    assert.strictEqual(ui.controls.view(), 'cmp', 'the Compare page renders over the unified state');
    ui.dispatch('layout', 'spotlight');
    assert.strictEqual(tab().layout, 'spotlight');
    assert.strictEqual($('splitter').hidden, false, 'the Spotlight splitter shows');
    key('Escape');
    key('Escape');
    assert.strictEqual(tab().layout, 'grid', 'Esc collapses Spotlight once the panels are closed');

    ui.dispatch('pickVideo');
    assert.strictEqual(tab().tiles.length, 3, '+ Add video asks the host and joins its answer');
    ui.dispatch('nudge', 'clip-0', 2);
    assert.strictEqual(tab().offsets['clip-0'], 2);
    ui.dispatch('removeTile', 'clip-0');
    assert.deepStrictEqual(tab().tiles.includes('clip-0'), false);
    ui.dispatch('leaveCompare');
    assert.strictEqual(tab().tiles.length, 1, 'Leave compare keeps A');
    assert.strictEqual($('tracks').hidden, false, 'single-video controls come back');

    // Bar commands the page cannot do itself go to the host.
    ui.dispatch('fullscreen');
    assert.ok(host.log.some((m) => m.type === 'fullscreen'));

    // Host toasts and the right-click menu.
    ui.onHostMessage({ type: 'toast', text: 'hello' });
    const ctx = $('ctxmenu');
    assert.ok($('stage').listenerCount('contextmenu') === 1, 'the stage opens the real context menu');
    assert.ok(ctx, 'context menu element');

    ui.dispose();
    assert.strictEqual(dom.timers.filter(Boolean).length, 0, 'dispose stops the clock');
    assert.strictEqual($('play').listenerCount('click'), 0, 'dispose removes the bar listeners');
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  }
}

// ---- 8. The mockup harness mounts the shared controller instead of its own wiring ----
for (const key of Object.keys(SCENARIOS)) {
  const html = buildMockupHtml({ scenario: key });
  assert.ok(html.includes('data-src="media/player-ui.js"'), `${key}: inlines media/player-ui.js`);
  assert.ok(html.includes('data-src="tools/mockup/fake-host.js"'), `${key}: inlines the FakeHost`);
  assert.ok(html.includes('VpePlayerUi.create('), `${key}: mounts the shared controller`);
  const harness = html.slice(html.lastIndexOf('<script>'));
  for (const glue of ['VpeControls.create(', 'VpeFolderRail.create(', 'VpeCtxMenu.create(', 'S.togglePlay(', 'engine.draw(']) {
    assert.ok(!harness.includes(glue), `${key}: harness has no duplicated wiring (${glue})`);
  }
}

console.log('player_ui_test: ok');
