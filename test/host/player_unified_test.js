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
    setRate: (r) => p.calls.push(['rate', r]),
    setLoop: (l) => p.calls.push(['loop', l]),
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

/**
 * Boot the page; `fn` gets the fixture and runs inside the browser globals. `hostSink(send)` returns a function that
 * gets every page -> host message (a real host: src/unified-session.js); it exists before boot, so it sees 'ready'.
 * `engineApi` / `uiApi` replace the production adapter / controller modules.
 */
function withPage(fn, { cfg = {}, createPlayer = stubPlayer, hostSink = null, engineApi = EngineAdapter, uiApi = PUI } = {}) {
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
  /** The host sends one message to the page (window 'message', with this page's envelope). */
  const send = (m) => dom.win.fire('message', { data: { page, boot: 1, ...m } });
  const sink = hostSink ? hostSink(send) : null;
  const vscode = {
    postMessage: (m) => { posted.push(m); if (sink) sink(m); },
    getState: () => state, setState: (s) => { state = s; },
  };
  const made = [];
  const factory = createPlayer && ((clip, host, hooks) => { const p = createPlayer(clip, host, hooks); made.push(p); return p; });
  return withGlobals(dom, () => {
    const app = U.boot({
      doc: dom.doc, win: dom.win, vscode, createPlayer: factory, widgets: widgets(),
      stateApi: S, engineApi, hostApi: HostAdapter, uiApi,
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

// ---- the host's 'sessionState' (src/unified-session.js) and the controller's decoder / transport hooks ----

const seeksOf = (p) => p.calls.filter((c) => c[0] === 'seek').map((c) => c[1]);

test('sessionIds and applySessionState: the tab shows the session\'s clips in its order, no-op when it does already', () => {
  assert.deepStrictEqual(U.sessionIds({ clips: [{ clipId: 'A' }, { clipId: 'B' }, { clipId: 'C' }], order: ['B', 'Z', 'A', 'B'] }), ['B', 'A', 'C']);
  assert.deepStrictEqual(U.sessionIds({}), []);
  const ws = S.createWorkspaceState({ tiles: ['A'], capture: false, frame: 0 });
  assert.strictEqual(U.applySessionState(S, ws, ['A'], { capture: false }), ws, 'same clips: same state object');
  assert.strictEqual(U.applySessionState(S, ws, [], {}), ws);
  const two = U.applySessionState(S, ws, ['B', 'A'], { capture: true, maxVideos: 4 });
  assert.deepStrictEqual(S.getTab(two).tiles, ['B', 'A']);
  assert.strictEqual(S.getTab(two).capture, true);
  assert.strictEqual(S.getTab(two).maxVideos, 4);
  const back = U.applySessionState(S, two, ['A'], { capture: false });
  assert.deepStrictEqual(S.getTab(back).tiles, ['A']);
  assert.strictEqual(S.getTab(back).capture, false);
  // A tab never shows no video: a different single clip is added before the old one goes.
  assert.deepStrictEqual(S.getTab(U.applySessionState(S, ws, ['C'], {})).tiles, ['C']);
  assert.deepStrictEqual(U.transportOf({ type: 'seek', frame: 5 }), { type: 'seek', value: 5 });
  assert.deepStrictEqual(U.transportOf('rate', 2), { type: 'rate', value: 2 });
  assert.deepStrictEqual(U.transportOf({ kind: 'loop', on: true }), { type: 'loop', value: true });
  assert.strictEqual(U.transportOf(null), null);
});

test('sessionState on ready: the session\'s clips and order, their decoders once, the overlay gone', () => {
  withPage(({ doc, app, send, made }) => {
    assert.strictEqual(made.length, 0);
    const msg = { type: 'sessionState', clips: [{ clipId: 'A', label: 'a.mp4' }, { clipId: 'B', label: 'b.mp4' }], order: ['B', 'A'], capture: true, maxVideos: 4 };
    send(msg);
    const t = S.getTab(app.ui.getState());
    assert.deepStrictEqual(t.tiles, ['B', 'A']);
    assert.strictEqual(t.capture, true);
    assert.strictEqual(t.maxVideos, 4);
    assert.strictEqual(isCompare(doc), true);
    assert.deepStrictEqual(made.map((p) => p.clip.id).sort(), ['A', 'B'], 'one decoder per clip');
    assert.strictEqual(app.engine.getClip('B').name, 'b.mp4');
    assert.strictEqual(doc.getElementById('overlay').hidden, true);
    assert.deepStrictEqual(app.session(), { ids: ['B', 'A'], capture: true, maxVideos: 4 });
    // The same state again (a reload of the host's view): nothing changes, no new decoder.
    const ws = app.ui.getState();
    send(msg);
    assert.strictEqual(app.ui.getState(), ws);
    assert.strictEqual(made.length, 2);
  });
});

/** An engine adapter module with registerClip / unregisterClip over the production one (records the calls). */
function liveEngineApi() {
  const calls = [];
  let creates = 0;
  return {
    calls, creates: () => creates,
    create(opts) {
      creates++;
      let specs = opts.clips.slice();
      let inner = EngineAdapter.create({ ...opts, clips: specs });
      const rebuild = () => { inner = EngineAdapter.create({ ...opts, clips: specs }); };
      const extra = {
        registerClip: (spec) => { calls.push(['register', spec.id]); specs = [...specs.filter((s) => s.id !== spec.id), spec]; rebuild(); },
        unregisterClip: (id) => { calls.push(['unregister', id]); specs = specs.filter((s) => s.id !== id); rebuild(); },
      };
      return new Proxy({}, {
        get: (_t, k) => { if (k in extra) return extra[k]; const v = inner[k]; return typeof v === 'function' ? v.bind(inner) : v; },
        has: (_t, k) => k in extra || k in inner,
      });
    },
  };
}

/** The production controller plus onDecoderFrame / onDecoderEnded (records the calls; keeps create's env). */
function hookedUiApi() {
  const rec = { calls: [], env: null };
  return {
    rec,
    api: {
      ...PUI,
      create(env) {
        rec.env = env;
        const ui = PUI.create(env);
        ui.onDecoderFrame = (f, id) => { rec.calls.push(['frame', f, id]); ui.dispatch('seek', f); };
        ui.onDecoderEnded = (o) => rec.calls.push(['ended', o]);
        return ui;
      },
    },
  };
}

test('registerClip / unregisterClip: the adapter learns and forgets clips in place, never rebuilt', () => {
  const eng = liveEngineApi();
  withPage(({ app, send }) => {
    send({ type: 'open' });
    assert.strictEqual(eng.creates(), 1);
    send({ type: 'openVideo', clipId: 'B', label: 'b.mp4', compare: true, clip: CLIPS[1] });
    assert.deepStrictEqual(eng.calls, [['register', 'B']]);
    assert.strictEqual(app.engine.getClip('B').name, 'b.mp4');
    send({ type: 'replaceTile', oldId: 'B', newId: 'C', label: 'c.mp4' });
    assert.deepStrictEqual(eng.calls.slice(1), [['register', 'C'], ['unregister', 'B']]);
    assert.strictEqual(app.engine.getClip('B'), null, 'B is gone from the adapter');
    // B back again: registered anew.
    send({ type: 'openVideo', clipId: 'B', label: 'b.mp4', compare: true });
    assert.deepStrictEqual(eng.calls.slice(3), [['register', 'B']]);
    assert.strictEqual(eng.creates(), 1, 'never rebuilt');
  }, { engineApi: eng });
});

test('onDecoderFrame / onDecoderEnded / onTransport: the clock reaches the controller, user commands the decoders, once each', () => {
  const h = hookedUiApi();
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    const [a, b] = made;
    assert.strictEqual(typeof h.rec.env.onTransport, 'function', 'the page passes onTransport to create()');
    // The clock decoder's frame goes through onDecoderFrame, and is not seeked back.
    const before = [seeksOf(a).length, seeksOf(b).length];
    a.hooks.onFrame(17);
    assert.deepStrictEqual(h.rec.calls, [['frame', 17, 'A']]);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 17);
    assert.deepStrictEqual([seeksOf(a).length, seeksOf(b).length], before, 'no seek echoed to the decoders');
    b.hooks.onFrame(99);
    assert.strictEqual(h.rec.calls.length, 1, 'only the clock tile drives the controller');
    // A user seek: transport first, then the state change; the decoders hear it once.
    h.rec.env.onTransport({ type: 'seek', frame: 30 });
    app.ui.dispatch('seek', 30);
    assert.deepStrictEqual(seeksOf(b).slice(-1), [30]);
    assert.strictEqual(seeksOf(b).filter((f) => f === 30).length, 1);
    // The other order: the state change first, the transport after it adds nothing.
    app.ui.dispatch('seek', 40);
    h.rec.env.onTransport('seek', 40);
    assert.strictEqual(seeksOf(a).filter((f) => f === 40).length, 1);
    // A seek the clock caused is never sent back, even through onTransport.
    const n = seeksOf(a).length;
    app.ui.onDecoderFrame = (f) => { h.rec.env.onTransport({ type: 'seek', frame: f }); app.ui.dispatch('seek', f); };
    a.hooks.onFrame(41);
    assert.strictEqual(seeksOf(a).length, n);
    // Play / pause, rate and loop.
    h.rec.env.onTransport({ type: 'play' });
    assert.strictEqual(a.playing && b.playing, true);
    app.ui.dispatch('playPause');
    assert.strictEqual(a.calls.filter((c) => c[0] === 'play').length, 1, 'play once');
    h.rec.env.onTransport({ type: 'rate', rate: 2 });
    h.rec.env.onTransport({ type: 'loop', loop: true });
    assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'rate' || c[0] === 'loop'), [['rate', 2], ['loop', true]]);
    // The clock decoder's end goes to onDecoderEnded; another tile's does not.
    b.hooks.onEnded({ natural: true });
    a.hooks.onEnded({ natural: true, ran: 3 });
    assert.deepStrictEqual(h.rec.calls.filter((c) => c[0] === 'ended'), [['ended', { natural: true }]]);
  }, { uiApi: h.api });
});

test('without onDecoderEnded the decoder\'s end stops the bar', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    app.ui.dispatch('playPause');
    assert.strictEqual(S.getTab(app.ui.getState()).playing, true);
    made[0].hooks.onEnded({ natural: true });
    assert.strictEqual(S.getTab(app.ui.getState()).playing, false);
  });
});

test('end to end: src/unified-session.js and the page, from one video to two and back', () => {
  const { createUnifiedSession } = require('../../src/unified-session');
  const titles = [];
  let session = null;
  const hostSink = (send) => {
    session = createUnifiedSession({
      initialClip: { id: 'A', label: 'clip-a', fsPath: '/videos/clip-a' },
      onPost: (m) => send(m),
      onTitleChange: (t) => titles.push(t),
    });
    return (m) => { session.onMessage(m); };
  };
  withPage(({ doc, app, posted, made }) => {
    // Open clip A: the page says ready, the session answers with its state, the decoder starts.
    assert.ok(posted.some((m) => m.type === 'ready'));
    assert.strictEqual(session.ready, true);
    assert.deepStrictEqual(app.session(), { ids: ['A'], capture: false, maxVideos: 8 });
    assert.deepStrictEqual(made.map((p) => p.clip.id), ['A']);
    assert.strictEqual(doc.getElementById('overlay').hidden, true);
    assert.strictEqual(session.title, 'clip-a');
    assert.strictEqual(isCompare(doc), false);

    // Add clip B after boot: N = 2.
    assert.strictEqual(session.addClip({ id: 'B', label: 'clip-b', fsPath: '/videos/clip-b' }), true);
    assert.deepStrictEqual(S.getTab(app.ui.getState()).tiles, ['A', 'B']);
    assert.strictEqual(isCompare(doc), true);
    assert.strictEqual(session.title, 'clip-a ↔ clip-b');
    assert.deepStrictEqual(made.map((p) => p.clip.id), ['A', 'B']);
    assert.deepStrictEqual(session.order, ['A', 'B'], 'the page\'s tiles report kept both');

    // Swap: the page tells the order, the session follows.
    app.ui.dispatch('swap');
    assert.deepStrictEqual(posted.filter((m) => m.type === 'tileOrder').pop().order, ['B', 'A']);
    assert.deepStrictEqual(session.order, ['B', 'A']);
    assert.strictEqual(session.title, 'clip-b ↔ clip-a');

    // Leave compare keeping B (the clock tile): N = 1, A's decoder closed.
    app.ui.dispatch('setClock', 'B');
    app.ui.dispatch('leaveCompare');
    assert.deepStrictEqual(posted.filter((m) => m.type === 'leaveCompare').pop().keepId, 'B');
    assert.deepStrictEqual(S.getTab(app.ui.getState()).tiles, ['B']);
    assert.strictEqual(isCompare(doc), false);
    assert.strictEqual(session.title, 'clip-b');
    assert.deepStrictEqual(session.clips.map((c) => c.id), ['B']);
    assert.strictEqual(made[0].disposed, true, 'A\'s decoder closed');
    assert.strictEqual(app.players.has('A'), false);
    assert.strictEqual(made[1].disposed, false);
    assert.deepStrictEqual(titles, ['clip-a', 'clip-a ↔ clip-b', 'clip-b ↔ clip-a', 'clip-b']);

    // Seek: the decoder hears it; its own frame then moves the bar without a seek back.
    const b = made[1];
    app.ui.dispatch('seek', 60);
    assert.deepStrictEqual(seeksOf(b).slice(-1), [60]);
    const n = seeksOf(b).length;
    b.hooks.onFrame(61);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 61);
    assert.strictEqual(seeksOf(b).length, n, 'no feedback seek');
  }, { hostSink });
  assert.strictEqual(session.disposed, false, 'the page going away does not end the host session');
});

console.log(`player_unified_test: ${count} ok (${Date.now() - T0} ms)`);
