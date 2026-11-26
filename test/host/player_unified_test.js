'use strict';
// node test/run.js unit --grep player_unified: the unified page's entry script (media/player-unified.js) booted on the
// strict fake DOM (test/host/fake-dom.js) of the real page (src/unified-html.js), with the real controller, widgets and
// adapters, a stub vscode and a stub decoder factory. Checks: the start at one video (ready sent, no body.compare),
// openVideo to two (a second decoder, body.compare), decoder messages to the right decoder and UI messages to the
// controller, back to one (the removed decoder closed) and pagehide (decoders, controller and host adapter disposed).
const assert = require('assert');
const S = require('../../media/player-state');
const PUI = require('../../media/player-ui');
const EngineAdapter = require('../../media/player-engine-adapter');
const HostAdapter = require('../../media/player-host-adapter');
const U = require('../../media/player-unified');
const { unifiedHtml } = require('../../src/unified-html');
const { createDom, Element: FakeElement, Node: FakeNode } = require('./fake-dom');

const T0 = Date.now();
let count = 0;
const test = (name, fn) => {
  try { fn(); count++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};

const widgets = () => ({
  VpeControls: require('../../media/controls'),
  VpeFolderRail: require('../../media/folder-rail'),
  VpeCtxMenu: require('../../media/ctxmenu'),
  VpeAbLoop: require('../../media/abloop'),
  VpeAutoplay: require('../../media/autoplay'),
  VpeTime: require('../../media/timefmt'),
  VpePicture: require('../../media/picture'),
  VpeModes: require('../../media/modes'),
  VpePlayerUiTiles: require('../../media/player-ui-tiles'),
  VpePlayerUiInput: require('../../media/player-ui-input'),
  CompareGrid: require('../../media/compare-grid'),
  VpePlayerUiTools: require('../../media/player-ui-tools'),
  VpePlayerUiLifecycle: require('../../media/player-ui-lifecycle'),
  VpeReducedResNotice: require('../../media/reduced-res-notice'),
  VpeSlowNotice: require('../../media/slow-notice'),
});

/** Run fn with the browser globals the widgets read directly. */
const withGlobals = (dom, fn) => {
  const GLOBALS = {
    document: dom.doc, window: dom.win, innerWidth: dom.win.innerWidth, innerHeight: dom.win.innerHeight,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, Element: FakeElement, HTMLElement: FakeElement, Node: FakeNode,
  };
  const saved = Object.fromEntries(Object.keys(GLOBALS).map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
  Object.assign(global, GLOBALS);
  try { return fn(); } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  }
};

/** A stub decoder: records what reaches it. */
function stubPlayer(clip, host, hooks) {
  const p = {
    clip, hooks, calls: [], disposed: false, playing: false, frame: 0,
    onBlock: (...a) => p.calls.push(['block', ...a]),
    onWorker: (m) => p.calls.push(['nd', m]),
    onNativeVideo: (m) => p.calls.push(['ndv', m]),
    onNativeAudio: (m) => p.calls.push(['nda', m]),
    onHostThumb: (m) => p.calls.push(['thumb', m]),
    onExactFrame: (m) => p.calls.push(['exactFrame', m]),
    onStream: (m) => p.calls.push(['stream', m]),
    onResize: (m) => p.calls.push(['resize', m]),
    seekFrame: (f) => { p.frame = f; p.calls.push(['seek', f]); },
    play: () => { p.playing = true; p.calls.push(['play']); },
    pause: () => { p.playing = false; p.calls.push(['pause']); },
    isPlaying: () => p.playing,
    currentFrame: () => p.frame,
    dispose: () => { p.disposed = true; },
  };
  return p;
}

const CLIPS = [
  { id: 'A', name: 'a.mp4', fps: 25, frames: 250, width: 1280, height: 720 },
  { id: 'B', name: 'b.mp4', fps: 25, frames: 250, width: 1280, height: 720 },
];

/** Boot the page; `fn` gets the fixture and runs inside the browser globals. */
function withPage(fn, { cfg = {}, createPlayer = stubPlayer } = {}) {
  const page = 7;
  const fullCfg = { page, boot: 1, clips: [CLIPS[0]], ...cfg };
  const html = unifiedHtml({
    cspSource: 'vsc-src:', uri: (...p) => `vsc:/media/${p.join('/')}`, base: 'vsc:/build', loader: 'libav-vpe.js',
    nonce: 'N', cfg: fullCfg, folder: true, entryScript: 'player-unified.js',
  });
  const dom = createDom(/<body[^>]*>([^]*)<\/body>/.exec(html)[1]);
  dom.setRect(dom.doc.documentElement, { width: 1024, height: 768 });
  dom.setRect(dom.$('stage'), { width: 680, height: 370 });
  dom.setRect(dom.$('seek'), { width: 680, height: 4 });
  dom.win.location = { origin: 'vscode-webview://test', hash: '' };
  const posted = [];
  let state;
  const vscode = { postMessage: (m) => posted.push(m), getState: () => state, setState: (s) => { state = s; } };
  const made = [];
  const factory = createPlayer && ((clip, host, hooks) => { const p = createPlayer(clip, host, hooks); made.push(p); return p; });
  /** The host sends one message to the page (window 'message', with this page's envelope). */
  const send = (m) => dom.win.fire('message', { data: { page, boot: 1, ...m } });
  return withGlobals(dom, () => {
    const app = U.boot({
      doc: dom.doc, win: dom.win, vscode, createPlayer: factory, widgets: widgets(),
      stateApi: S, engineApi: EngineAdapter, hostApi: HostAdapter, uiApi: PUI,
    });
    try { return fn({ ...dom, app, posted, send, made, vscode }); } finally { app.dispose(); }
  });
}

const isCompare = (doc) => doc.body.classList.contains('compare');

test('the config is read from #cfg; clipsOf falls back to one clip', () => {
  const dom = createDom('<script type="application/json" id="cfg">{"page":3,"clipId":"X","name":"x.mkv"}</script>');
  assert.deepStrictEqual(U.readCfg(dom.doc), { page: 3, clipId: 'X', name: 'x.mkv' });
  assert.deepStrictEqual(U.clipsOf(U.readCfg(dom.doc)), [{ id: 'X', name: 'x.mkv' }]);
  assert.deepStrictEqual(U.readCfg(createDom('<div></div>').doc), {});
  assert.deepStrictEqual(U.clipsOf({ clips: [{ id: 'A' }, null, { name: 'no id' }] }), [{ id: 'A' }]);
  assert.deepStrictEqual(U.DECODER_TYPES.sort(), ['block', 'exactFrame', 'nd', 'nda', 'ndv', 'resize', 'stream', 'thumb']);
});

test('boots at one video: no body.compare, ready sent with the envelope, no decoder before open', () => {
  withPage(({ doc, app, posted, made, send }) => {
    assert.strictEqual(isCompare(doc), false);
    const ready = posted.find((m) => m.type === 'ready');
    assert.ok(ready, 'ready posted');
    assert.strictEqual(ready.page, 7);
    assert.strictEqual(ready.boot, 1);
    assert.strictEqual(ready.origin, 'vscode-webview://test');
    assert.strictEqual(made.length, 0, 'decoders start on open');
    assert.strictEqual(S.getTab(app.ui.getState()).maxFrame, 249, 'the clip length from the config');
    assert.strictEqual(doc.getElementById('overlay').hidden, false, 'Opening… shows until open');
    send({ type: 'open' });
    assert.deepStrictEqual(made.map((p) => p.clip.id), ['A']);
    assert.strictEqual(app.players.get('A'), made[0]);
    assert.strictEqual(doc.getElementById('overlay').hidden, true, 'open clears the overlay');
    // A reply for another page or an earlier boot is not this page's.
    send({ type: 'block', pos: 1, data: 'x', page: 8 });
    send({ type: 'block', pos: 1, data: 'x', boot: 2 });
    assert.deepStrictEqual(made[0].calls.filter((c) => c[0] === 'block'), []);
  });
});

test('openVideo makes a second decoder and turns body.compare on', () => {
  withPage(({ doc, app, send, made, posted }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', label: 'b.mp4', compare: true, clip: CLIPS[1] });
    const t = S.getTab(app.ui.getState());
    assert.deepStrictEqual(t.tiles, ['A', 'B']);
    assert.strictEqual(isCompare(doc), true);
    assert.deepStrictEqual(made.map((p) => p.clip.id), ['A', 'B']);
    assert.strictEqual(made[1].clip.name, 'b.mp4');
    assert.strictEqual(app.engine.getClip('B').name, 'b.mp4', 'the engine adapter knows the new clip');
    const tiles = posted.filter((m) => m.type === 'tiles').pop();
    assert.deepStrictEqual(tiles.tiles, ['A', 'B']);
    // The same video again: declined, no third decoder.
    send({ type: 'openVideo', clipId: 'B', label: 'b.mp4' });
    assert.strictEqual(made.length, 2);
  });
});

test('decoder messages reach the right decoder; UI messages reach the controller', () => {
  withPage(({ doc, app, send, made }) => {
    send({ type: 'open' });
    // One video: untagged decoder messages go to it.
    send({ type: 'block', pos: 4096, data: 'bytes', error: null });
    send({ type: 'nd', m: { type: 'frameInfo' } });
    assert.deepStrictEqual(made[0].calls.filter((c) => c[0] === 'block' || c[0] === 'nd'),
      [['block', 4096, 'bytes', null], ['nd', { type: 'frameInfo' }]]);
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    const [a, b] = made;
    const n = (p, type) => p.calls.filter((c) => c[0] === type).length;
    send({ type: 'block', clipId: 'B', pos: 0, data: 'b0' });
    send({ type: 'nd', key: 'A', m: { type: 'x' } });
    send({ type: 'ndv', clipId: 'B', w: 1 });
    send({ type: 'nda', clipId: 'A' });
    send({ type: 'thumb', clipId: 'B' });
    send({ type: 'exactFrame', clipId: 'A' });
    send({ type: 'stream', clipId: 'B', quality: {} });
    send({ type: 'block', pos: 9, data: 'nobody' }); // untagged with two videos: nobody's
    send({ type: 'block', clipId: 'Z', pos: 9, data: 'unknown' });
    assert.strictEqual(n(a, 'block'), 1);
    assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'block'), [['block', 0, 'b0', undefined]]);
    assert.strictEqual(n(a, 'nd'), 2);
    assert.strictEqual(n(b, 'nd'), 0);
    assert.deepStrictEqual([n(a, 'ndv'), n(b, 'ndv'), n(a, 'nda'), n(b, 'nda')], [0, 1, 1, 0]);
    assert.deepStrictEqual([n(a, 'thumb'), n(b, 'thumb'), n(a, 'exactFrame'), n(b, 'stream')], [0, 1, 1, 1]);
    // resize by tile index (the slots of the last 'tiles' report).
    send({ type: 'resize', tiles: [1] });
    assert.deepStrictEqual([n(a, 'resize'), n(b, 'resize')], [0, 1]);

    // UI messages: the controller handles them.
    send({ type: 'toast', text: 'Hello there' });
    assert.strictEqual(doc.getElementById('toast').textContent, 'Hello there');
    send({ type: 'goto', frame: 51 });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 50, 'goto frame is 1-based');
    assert.ok(b.calls.some((c) => c[0] === 'seek' && c[1] === 50), 'the controller seek reached the decoders');
    send({ type: 'playbackPrefs', prefs: { rate: 2 } });
    assert.strictEqual(app.ui.getPrefs().rate, 2);
    let railMsg = null;
    const rail = app.ui.rail;
    const orig = rail.onMessage;
    rail.onMessage = (m) => { railMsg = m; return orig.call(rail, m); };
    send({ type: 'rail', op: 'members', members: [] });
    assert.deepStrictEqual(railMsg, { type: 'rail', op: 'members', members: [] });
    assert.ok(a.calls.every((c) => c[0] !== 'toast'), 'UI messages never reach a decoder');
  });
});

test('the decoder clock drives the controller without echoing a seek back', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    app.ui.dispatch('playPause');
    assert.strictEqual(S.getTab(app.ui.getState()).playing, true);
    assert.strictEqual(p.playing, true, 'play reached the decoder');
    const seeksBefore = p.calls.filter((c) => c[0] === 'seek').length;
    p.frame = 12;
    app.pump();
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 12);
    p.hooks.onFrame(13);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 13);
    assert.strictEqual(p.calls.filter((c) => c[0] === 'seek').length, seeksBefore, 'no seek back to the clock');
    app.ui.dispatch('playPause');
    assert.strictEqual(p.playing, false);
  });
});

test('back to one video: body.compare off and the removed decoder closed', () => {
  withPage(({ doc, app, send, made }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    assert.strictEqual(isCompare(doc), true);
    send({ type: 'removeVideo', clipId: 'B' });
    assert.deepStrictEqual(S.getTab(app.ui.getState()).tiles, ['A']);
    assert.strictEqual(isCompare(doc), false);
    assert.strictEqual(made[1].disposed, true);
    assert.strictEqual(app.players.has('B'), false);
    assert.strictEqual(made[0].disposed, false);
    // Leave compare via the controller also closes the other decoder.
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    assert.strictEqual(made.length, 3);
    app.ui.setState(S.leaveCompare(app.ui.getState(), 'B').state);
    assert.strictEqual(isCompare(doc), false);
    assert.strictEqual(made[0].disposed, true, 'A left');
    assert.strictEqual(made[2].disposed, false);
  });
});

test('replaceTile makes the new decoder before the controller swaps', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    send({ type: 'replaceTile', oldId: 'B', newId: 'C', label: 'c.mp4' });
    assert.deepStrictEqual(S.getTab(app.ui.getState()).tiles, ['A', 'C']);
    assert.strictEqual(app.engine.getClip('C').name, 'c.mp4');
    assert.deepStrictEqual(made.map((p) => [p.clip.id, p.disposed]), [['A', false], ['B', true], ['C', false]]);
  });
});

test('pagehide disposes the decoders, the controller and the host adapter', () => {
  withPage(({ win, app, send, made, posted }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    const before = posted.length;
    win.fire('pagehide');
    assert.strictEqual(app.isDisposed(), true);
    assert.ok(made.every((p) => p.disposed), 'every decoder closed');
    assert.strictEqual(app.players.size, 0);
    assert.strictEqual(app.ui.parts.bridge.isDisposed(), true, 'the controller is down');
    assert.strictEqual(win.listenerCount('message'), 0, 'the host adapter stopped listening');
    send({ type: 'toast', text: 'late' });
    app.host.post({ type: 'pickVideo' });
    assert.strictEqual(posted.length, before, 'nothing goes out after pagehide');
    assert.strictEqual(win.listenerCount('pagehide'), 0);
  });
});

test('without a decoder factory the page still boots (no engine.js in Node)', () => {
  withPage(({ doc, app, send }) => {
    send({ type: 'open' });
    assert.strictEqual(app.players.size, 0);
    assert.strictEqual(doc.getElementById('overlay').hidden, true);
  }, { createPlayer: null });
});

console.log(`player_unified_test: ${count} ok (${Date.now() - T0} ms)`);
