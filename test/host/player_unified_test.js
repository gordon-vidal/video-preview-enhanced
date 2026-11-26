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

/** A stub decoder: records what reaches it. `ready`: its file is open already (the overlay need not wait). */
function stubPlayer(clip, host, hooks) {
  const p = {
    clip, hooks, calls: [], disposed: false, playing: false, frame: 0, ready: true,
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
function withPage(fn, {
  cfg = {}, createPlayer = stubPlayer, hostSink = null, engineApi = EngineAdapter, uiApi = PUI, raf = false,
  defaultFactory = false, extraWidgets = {},
} = {}) {
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
  // raf: animation frames run only when the test says (`frames(n, now)`); `rafQueue` shows what is waiting.
  const rafQueue = [];
  let clock = 1000;
  if (raf) dom.win.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  const frames = (n = 1, step = 40) => {
    let ran = 0;
    for (; ran < n && rafQueue.length; ran++) { clock += step; rafQueue.shift()(clock); }
    return ran;
  };
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
      doc: dom.doc, win: dom.win, vscode, ...(defaultFactory ? {} : { createPlayer: factory }),
      widgets: { ...widgets(), ...extraWidgets },
      stateApi: S, engineApi, hostApi: HostAdapter, uiApi,
    });
    try { return fn({ ...dom, app, posted, send, made, vscode, frames, rafQueue }); } finally { app.dispose(); }
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
    // resize by tile index in the active tab.
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
    assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'rate' || c[0] === 'loop'), [['rate', 1], ['loop', false], ['rate', 2], ['loop', true]]);
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

// ---- the shared tick loop, mixed-fps targets, replay after the end, the clip descriptor, decoder messages ----

/**
 * A decoder shaped like media/engine.js LibavPlayer for the frame loop: nothing shows until tick(now) runs; a seek
 * settles after `settleTicks` ticks (seekTarget / shownStale until then); playing advances one frame per tick and
 * stops at the end with onEnded({ natural: true }). The first frame shown calls onReady.
 */
function enginePlayer(clip, host, hooks) {
  const p = stubPlayer(clip, host, hooks);
  const end = (clip.frames || 250) - 1;
  Object.assign(p, { ready: false, firstShown: false, seekTarget: null, shownStale: true, ticks: [], settleTicks: 1, wait: 0 });
  p.seekFrame = (f) => { p.calls.push(['seek', f]); p.seekTarget = f; p.shownStale = true; p.wait = p.settleTicks; hooks.wake(); };
  p.tick = (now) => {
    p.ticks.push(now);
    if (p.seekTarget !== null) {
      if (--p.wait > 0) return;
      p.frame = p.seekTarget;
      p.seekTarget = null;
    } else if (p.playing) {
      if (p.frame >= end) { p.playing = false; hooks.onEnded({ natural: true }); return; }
      p.frame++;
    }
    p.shownStale = false;
    if (!p.firstShown) { p.firstShown = true; hooks.onReady(); }
  };
  return p;
}

test('tick loop: decoders tick on animation frames until they settle; wake starts it again', () => {
  withPage(({ doc, app, send, made, frames, rafQueue }) => {
    send({ type: 'open' });
    const p = made[0];
    assert.deepStrictEqual(seeksOf(p), [0], 'the decoder is sent to the tab\'s frame');
    assert.strictEqual(doc.getElementById('overlay').hidden, false, 'Opening… stays until the decoder is ready');
    assert.strictEqual(rafQueue.length, 1, 'the seek woke the loop');
    // First frame: the tick presents it, the decoder is ready, nothing is left to do: the loop rests.
    assert.strictEqual(frames(10), 1);
    assert.strictEqual(p.ticks.length, 1);
    assert.strictEqual(p.firstShown, true);
    assert.strictEqual(doc.getElementById('overlay').hidden, true, 'the first ready decoder takes Opening… away');
    assert.strictEqual(rafQueue.length, 0, 'paused and settled: no animation frame asked for');
    // Playing: every frame ticks the decoder first, then its frame drives the bar.
    app.ui.dispatch('playPause');
    assert.strictEqual(p.playing, true);
    assert.strictEqual(frames(5), 5);
    assert.strictEqual(p.frame, 5);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 5, 'the bar follows the ticked decoder');
    assert.strictEqual(rafQueue.length, 1, 'still playing: the next frame is asked for');
    assert.deepStrictEqual(seeksOf(p), [0], 'no seek back to the clock');
    // Pause: one more frame, then the loop rests.
    app.ui.dispatch('playPause');
    assert.strictEqual(p.playing, false);
    assert.strictEqual(frames(10), 1);
    assert.strictEqual(rafQueue.length, 0);
    // A paused seek keeps the loop running until the decoder has shown it (seekTarget back to null).
    p.settleTicks = 3;
    app.ui.dispatch('seek', 100);
    assert.deepStrictEqual(seeksOf(p).slice(-1), [100]);
    assert.strictEqual(p.seekTarget, 100);
    assert.strictEqual(frames(10), 3, 'three ticks to settle, then rest');
    assert.strictEqual(p.seekTarget, null);
    assert.strictEqual(p.frame, 100);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 100);
    assert.strictEqual(rafQueue.length, 0);
    // The decoder's own wake (a worker message) asks for one frame, once.
    p.hooks.wake();
    p.hooks.wake();
    assert.strictEqual(rafQueue.length, 1);
    assert.strictEqual(frames(10), 1);
  }, { createPlayer: enginePlayer, raf: true });
});

test('tick loop: the visible decoders all tick, and a disposed page asks for no frame', () => {
  withPage(({ app, send, made, frames, rafQueue }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    frames(5);
    const [a, b] = made;
    assert.ok(a.ticks.length > 0 && b.ticks.length > 0, 'both visible tiles tick');
    app.ui.dispatch('playPause');
    frames(2);
    app.dispose();
    const n = rafQueue.length;
    a.hooks.wake();
    assert.strictEqual(rafQueue.length, n, 'no frame after dispose');
  }, { createPlayer: enginePlayer, raf: true });
});

const MIXED = [
  { id: 'A', name: 'a24.mp4', fps: 24, frames: 240, width: 1280, height: 720 },
  { id: 'B', name: 'b30.mp4', fps: 30, frames: 300, width: 1280, height: 720 },
];

test('mixed fps: a 24 fps clock seeks a 30 fps follower by time; a paused offset edit seeks the follower at once', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: MIXED[1] });
    const [a, b] = made;
    const t0 = S.getTab(app.ui.getState());
    assert.strictEqual(t0.fps, 24, 'A (24 fps) is the clock');
    app.ui.dispatch('seek', 24);
    assert.deepStrictEqual(seeksOf(a).slice(-1), [24]);
    assert.deepStrictEqual(seeksOf(b).slice(-1), [30], 'one second in: frame 30 of the 30 fps follower');
    const na = seeksOf(a).length;
    // The follower's offset while paused: only the follower moves, at once.
    app.ui.setState(S.setOffset(app.ui.getState(), 'B', 5));
    assert.deepStrictEqual(seeksOf(b).slice(-1), [35]);
    assert.strictEqual(seeksOf(a).length, na, 'the clock tile is not sought again');
    const nb = seeksOf(b).length;
    // The same state again (a render): nothing is sent.
    app.ui.render();
    app.ui.setState(app.ui.getState());
    assert.strictEqual(seeksOf(b).length, nb);
    // An offset that takes the follower out of its clip: no seek; back in: sought again.
    app.ui.setState(S.setOffset(app.ui.getState(), 'B', -100));
    assert.strictEqual(seeksOf(b).length, nb);
    app.ui.setState(S.setOffset(app.ui.getState(), 'B', 0));
    assert.deepStrictEqual(seeksOf(b).slice(-1), [30]);
  }, { cfg: { clips: [MIXED[0]] } });
});

test('decoder metadata: the clip learns fps and length, and the clock follows without a clock change', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    assert.strictEqual(S.getTab(app.ui.getState()).maxFrame, 239, 'no numbers yet: the adapter\'s fallback');
    Object.assign(p, { fps: 30, n: 300, meta: { duration: 10, size: 5000 } });
    p.hooks.onMeta();
    const t = S.getTab(app.ui.getState());
    assert.strictEqual(t.fps, 30);
    assert.strictEqual(t.maxFrame, 299);
    assert.strictEqual(app.engine.getClip('A').frames, 300);
  }, { cfg: { clips: [{ id: 'A', name: 'a.mp4' }] }, engineApi: liveEngineApi() });
});

test('natural end: Loop and an A-B range restart the decoder (seek and play), the cached play state does not hide it', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    app.ui.dispatch('loop');
    assert.strictEqual(app.ui.getPrefs().onEnd, 'loop');
    app.ui.dispatch('playPause');
    assert.strictEqual(p.playing, true);
    p.hooks.onFrame(249);
    // The decoder stops itself at its end, then says so.
    p.playing = false;
    const plays = () => p.calls.filter((c) => c[0] === 'play').length;
    const before = plays();
    p.hooks.onEnded({ natural: true });
    assert.deepStrictEqual(seeksOf(p).slice(-1), [0], 'Loop: back to the start');
    assert.strictEqual(plays(), before + 1, 'and playing again');
    assert.strictEqual(p.playing, true);
    assert.strictEqual(S.getTab(app.ui.getState()).playing, true);
    // A-B: the end wraps to A.
    app.ui.dispatch('loop');
    assert.notStrictEqual(app.ui.getPrefs().onEnd, 'loop');
    app.ui.ab.set('a', 2, 50);
    app.ui.ab.set('b', 4, 100);
    p.hooks.onFrame(100);
    p.playing = false;
    p.hooks.onEnded({ natural: true });
    assert.deepStrictEqual(seeksOf(p).slice(-1), [50], 'A-B: back to A');
    assert.strictEqual(plays(), before + 2);
    assert.strictEqual(p.playing, true);
  });
});

test('the full clip descriptor (size, native ...) reaches the decoder and the adapter from every host message', () => {
  withPage(({ app, send, made }) => {
    send({
      type: 'sessionState', order: ['A', 'B'], capture: true,
      clips: [
        { clipId: 'A', label: 'a.mkv', clip: { id: 'A', size: 1234, native: true, fps: 50, frames: 500, codec: 'hevc', kind: 'file' } },
        { clipId: 'B', label: 'b.mp4', size: 777, native: false, duration: 3, hasAudio: true },
      ],
    });
    const byId = (id) => made.find((p) => p.clip.id === id);
    assert.strictEqual(byId('A').clip.size, 1234);
    assert.strictEqual(byId('A').clip.native, true);
    assert.strictEqual(byId('A').clip.codec, 'hevc');
    assert.strictEqual(byId('A').clip.kind, 'file');
    assert.strictEqual(byId('B').clip.size, 777, 'descriptor fields on the session entry itself');
    assert.strictEqual(byId('B').clip.hasAudio, true);
    assert.strictEqual(app.engine.getClip('A').fps, 50);
    assert.strictEqual(app.engine.getClip('A').size, 1234);
    send({ type: 'openVideo', clipId: 'C', label: 'c.mov', compare: true, clip: { id: 'C', size: 4242, native: true, fps: 30, frames: 90 } });
    assert.strictEqual(byId('C').clip.size, 4242);
    assert.strictEqual(byId('C').clip.native, true);
    assert.strictEqual(app.engine.getClip('C').frames, 90);
    send({ type: 'replaceTile', oldId: 'C', newId: 'D', label: 'd.avi', clip: { id: 'D', size: 99, native: true, kind: 'file' } });
    assert.deepStrictEqual(S.getTab(app.ui.getState()).tiles, ['A', 'B', 'D']);
    assert.strictEqual(byId('D').clip.size, 99);
    assert.strictEqual(byId('D').clip.native, true);
    assert.strictEqual(byId('D').clip.name, 'd.avi');
    assert.strictEqual(app.engine.getClip('D').size, 99);
  }, { engineApi: liveEngineApi() });
});

test('decoder showMessage / toast: on the overlay and the toast; a startup error shows on the overlay', () => {
  withPage(({ doc, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    const overlay = doc.getElementById('overlay');
    assert.strictEqual(overlay.hidden, true);
    p.hooks.toast('No sound: eac3 is not in the built-in decoder', 1500);
    assert.strictEqual(doc.getElementById('toast').textContent, 'No sound: eac3 is not in the built-in decoder');
    p.hooks.showMessage('This file could not be opened.', 'It may be damaged.');
    assert.strictEqual(overlay.hidden, false);
    assert.ok(overlay.textContent.includes('This file could not be opened.'));
    assert.ok(overlay.textContent.includes('It may be damaged.'));
    // With two videos the message names its clip; another clip's '' does not clear it, its own does.
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    p.hooks.showMessage('Picture codec missing.');
    assert.ok(overlay.textContent.includes('a.mp4: Picture codec missing.'));
    made[1].hooks.showMessage('');
    assert.strictEqual(overlay.hidden, false);
    p.hooks.showMessage('');
    assert.strictEqual(overlay.hidden, true);
  });
  withPage(({ doc, send }) => {
    send({ type: 'open' });
    const overlay = doc.getElementById('overlay');
    assert.strictEqual(overlay.hidden, false);
    assert.ok(overlay.textContent.includes('The decoder failed to start.'));
    assert.ok(overlay.textContent.includes('no wasm here'));
  }, { createPlayer: () => { throw new Error('no wasm here'); } });
});

test('Astra #3: production decoder wrapper stamps page on outbound nd messages & new/replaced tiles inherit rate and loop', () => {
  // 1. defaultCreatePlayer stamps cfg.page and clipId on engine outbound messages (e.g. native nd open).
  const rawPosts = [];
  const win = { document: { createElement: () => ({}) } };
  let capturedEngOpts = null;
  win.createEngine = (opts) => {
    capturedEngOpts = opts;
    return {
      LibavPlayer: function MockLibav() {
        this.dispose = () => {};
        opts.vscode.postMessage({ type: 'nd', m: { op: 'open' } });
      },
    };
  };
  const { html } = (() => ({
    html: unifiedHtml({
      cspSource: 'https://x', uri: (f) => `u/${f}`, base: 'u/b', loader: 'l.js', nonce: 'n',
      cfg: { page: 7, boot: 'b1', clips: [CLIPS[0]], tiles: ['A'] }, sequence: true, folder: true,
    }),
  }))();
  const dom = createDom(html);
  withGlobals(dom, () => {
    const res = U.boot({
      doc: dom.doc, win: Object.assign(dom.win, { createEngine: win.createEngine }),
      vscode: { postMessage: (m) => rawPosts.push(m), getState: () => null, setState() {} },
      widgets: widgets(), stateApi: S, engineApi: EngineAdapter, hostApi: HostAdapter, uiApi: PUI,
    });
    dom.win.fire('message', { data: { type: 'open', page: 7, boot: 'b1' } });
    const ndMsg = rawPosts.find((m) => m.type === 'nd');
    assert.ok(ndMsg && ndMsg.page === 7 && ndMsg.clipId === 'A' && ndMsg.key === 'A' && capturedEngOpts.page === 7,
      `outbound nd message must include page & clipId: ${JSON.stringify(ndMsg)}`);
    res.dispose();
  });

  // 2. Added and replaced decoders inherit active rate and loop policy before playback.
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    // Set rate to 2x and loop on via controller transport.
    app.onTransport({ type: 'rate', rate: 2 });
    app.onTransport({ type: 'loop', loop: true });
    // Add B while rate is 2x.
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    const b = made.find((p) => p.clip.id === 'B');
    assert.ok(b && b.calls.some((c) => c[0] === 'rate' && c[1] === 2), 'newly added tile inherits active rate');
    assert.ok(b && b.calls.some((c) => c[0] === 'loop' && c[1] === true), 'newly added tile inherits active loop');
    // Replace B with C.
    send({ type: 'replaceTile', oldId: 'B', newId: 'C', label: 'c.mp4', clip: CLIPS[2] });
    const c = made.find((p) => p.clip.id === 'C');
    assert.ok(c && c.calls.some((c2) => c2[0] === 'rate' && c2[1] === 2), 'replaced tile inherits active rate');
    assert.ok(c && c.calls.some((c2) => c2[0] === 'loop' && c2[1] === true), 'replaced tile inherits active loop');
  });
});

const logsOf = (posted) => posted.filter((m) => m.type === 'log').map((m) => m.msg);
const FramePlayerApi = require('../../media/frame-player');

test('a sequence clip gets a FramePlayer: its picture requests go out tagged, its pictures come back to it', () => {
  const SEQ = { id: 'S', name: 'shot_%04d.png', kind: 'sequence', fps: 10, frames: 30, width: 64, height: 36 };
  withPage(({ app, send, posted }) => {
    assert.strictEqual(app.players.size, 0, 'no decoder before open');
    send({ type: 'open' });
    const p = app.players.get('S');
    assert.ok(p && p.bitmaps instanceof Map && p.n === 30 && p.fps === 10, 'a frame player with the clip\'s numbers');
    const req = posted.find((m) => m.type === 'frames');
    assert.ok(req && req.clipId === 'S' && req.page === 7 && req.indices[0] === 0, `tagged picture request ${JSON.stringify(req)}`);
    const got = [];
    p.onFrame = (i, data) => got.push([i, data]);
    send({ type: 'frame', clipId: 'S', index: 3, data: 'jpeg' });
    send({ type: 'frame', index: 4, data: 'jpeg' }); // untagged, one clip: still this one
    assert.deepStrictEqual(got, [[3, 'jpeg'], [4, 'jpeg']]);
    assert.strictEqual(app.engine.getClip('S').frames, 30);
  }, { cfg: { clips: [SEQ] }, defaultFactory: true, extraWidgets: { VpeFramePlayer: FramePlayerApi } });

  // A clip the host plays as pictures ('frames', MJPEG AVI): the frame player starts with the host's meta.
  withPage(({ app, send }) => {
    send({ type: 'open' });
    assert.strictEqual(app.players.size, 0, 'no engine.js in Node and not a sequence: no decoder');
    send({ type: 'frames', clipId: 'A', meta: { frames: 5, fps: 10, width: 32, height: 18 } });
    const p = app.players.get('A');
    assert.ok(p && p.n === 5 && p.meta.width === 32, 'the frame player has the host\'s meta');
    assert.strictEqual(app.engine.getClip('A').frames, 5, 'the clip learns the frame count');
    // A second 'frames' (reopened) replaces the decoder; the old one is closed.
    send({ type: 'frames', clipId: 'A', meta: { frames: 6, fps: 10 } });
    assert.ok(p.disposed && app.players.get('A') !== p && app.players.get('A').n === 6, 'restarted with the new meta');
  }, { defaultFactory: true, extraWidgets: { VpeFramePlayer: FramePlayerApi } });
});

test('originalTile: the transcoded decoder closes, the clip restarts on the built-in decoder, the notice shows', () => {
  const LIVE = { ...CLIPS[0], native: true, transcoded: true };
  withPage(({ app, send, made, doc }) => {
    send({ type: 'open' });
    assert.strictEqual(app.engine.pictureInfo('A').transcoded, true, 'Live transcode before');
    app.ui.dispatch('seek', 40);
    const old = made[0];
    send({ type: 'originalTile', clipId: 'A', notice: 'Playing the original video.' });
    assert.ok(old.disposed, 'the transcoded decoder is closed');
    const now = app.players.get('A');
    assert.ok(now && now !== old && now === made[1], 'a new decoder for A');
    assert.ok(now.clip.native === false && now.clip.transcoded === false, `built-in: ${JSON.stringify(now.clip)}`);
    assert.deepStrictEqual(app.engine.pictureInfo('A').transcoded, false, 'pictureInfo follows');
    assert.ok(now.calls.some((c) => c[0] === 'seek' && c[1] === 40), 'the new decoder is sought to the clip\'s place');
    assert.ok(doc.getElementById('toast').textContent.includes('Playing the original video.'), 'the notice is toasted');
    // Compare's host names the tile by index (its slots).
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: { ...CLIPS[1], native: true, transcoded: true } });
    const b = app.players.get('B');
    send({ type: 'originalTile', index: 1, notice: 'Original.' });
    assert.ok(b.disposed && app.players.get('B').clip.transcoded === false, 'by index');
    assert.ok(doc.getElementById('toast').textContent.includes('b.mp4: Original.'), 'with 2 videos the toast names the clip');
  }, { cfg: { clips: [LIVE] } });
});

test('libav: the host\'s meta restarts the clip\'s built-in decoder with it', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    const meta = { size: 123, duration: 10, native: true, label: 'a.mp4' };
    send({ type: 'libav', clipId: 'A', meta });
    assert.ok(made[0].disposed, 'the old decoder is closed');
    assert.deepStrictEqual(made[1].clip.meta, meta, 'the new decoder opens with the host\'s meta');
    assert.strictEqual(made[1].clip.native, true, 'the clip follows the native flag of the meta');
    assert.strictEqual(app.players.get('A'), made[1]);
  });
});

test('stream and exactFrame: the Quality variants reach pictureInfo; an exact-frame reply reaches the clip\'s request', () => {
  const posts = [];
  const replies = [];
  const VpeExact = {
    available: (p) => !!(p && p.nativeLossy),
    shownTime: () => 1.5,
    failureText: () => 'failed',
    create: (o) => ({
      grab: (key, t) => { o.post({ type: 'grabExactFrame', page: o.page, reqId: 1, t }); posts.push(key); return Promise.resolve(null); },
      onReply: (m) => { replies.push(m); return Promise.resolve(); },
      invalidate() {},
    }),
  };
  const noExact = (clip, host, hooks) => { const p = stubPlayer(clip, host, hooks); delete p.onExactFrame; return p; };
  withPage(({ app, send, posted }) => {
    send({ type: 'open' });
    const quality = { variants: [{ height: 360 }, { height: 720 }] };
    send({ type: 'stream', clipId: 'A', quality });
    assert.ok(app.engine.pictureInfo('A').streaming && app.engine.pictureInfo('A').quality === quality, 'HLS variants');
    const p = app.players.get('A');
    p.nativeLossy = true;
    p.gen = 2;
    app.engine.exactFrame('A');
    const req = posted.find((m) => m.type === 'grabExactFrame');
    assert.ok(req && req.clipId === 'A' && req.page === 7 && req.t === 1.5, `exact request ${JSON.stringify(req)}`);
    assert.deepStrictEqual(posts, ['2|0|0']);
    send({ type: 'exactFrame', clipId: 'A', reqId: 1, png: 'x' });
    assert.ok(replies.length === 1 && replies[0].page === 7 && replies[0].png === 'x', 'the reply, with the page id');
  }, { createPlayer: noExact, extraWidgets: { VpeExact } });
});

test('first frame shown: logged once to the host; not again when the decoder said it itself', () => {
  withPage(({ send, made, posted }) => {
    send({ type: 'open' });
    made[0].hooks.onFrame(0);
    made[0].hooks.onFrame(1);
    const lines = logsOf(posted).filter((l) => /first frame shown/.test(l));
    assert.deepStrictEqual(lines, ['first frame shown at 0.000 s'], 'once, unprefixed with one video');
    const log = posted.find((m) => m.type === 'log');
    assert.strictEqual(log.page, 7, 'with the page envelope (src/unified-viewer.js reads it)');
    // 2 videos: "first pictures shown" once both have a picture.
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    made[1].hooks.onFrame(0);
    assert.deepStrictEqual(logsOf(posted).filter((l) => l === 'first pictures shown'), [], 'A has no counted picture yet');
    made[0].shownCount = 1;
    made[1].shownCount = 1;
    made[1].hooks.onFrame(1);
    assert.deepStrictEqual(logsOf(posted).filter((l) => l === 'first pictures shown'), ['first pictures shown']);
    made[1].hooks.log('hello');
    assert.ok(logsOf(posted).includes('[B] hello'), 'with 2 decoders a decoder line names its clip');
  });
  withPage(({ send, made, posted }) => {
    send({ type: 'open' });
    made[0].hooks.log('first frame shown at 0.040 s'); // media/engine.js says it
    made[0].hooks.onFrame(1);
    assert.deepStrictEqual(logsOf(posted).filter((l) => /first frame shown/.test(l)), ['first frame shown at 0.040 s']);
  });
});

test('debug: VpeDebugProbe answers with one video, VpeCompareDebug with two; window.vpe / vpeCompare', () => {
  const VpeDebugProbe = require('../../media/debug-probe');
  const VpeCompareDebug = require('../../media/compare-debug');
  // What the probes read of a real decoder besides the stub's: its clock time.
  const timedPlayer = (clip, host, hooks) => Object.assign(stubPlayer(clip, host, hooks), { currentTime() { return this.frame / 25; } });
  withPage(({ win, app, send, made, posted }) => {
    send({ type: 'open' });
    assert.ok(logsOf(posted).some((l) => l.startsWith('webview env:')), 'the probe is installed');
    assert.ok(win.vpe && win.vpe.clock === made[0] && win.vpeCompare && win.vpeCompare.A === made[0], 'window hooks');
    send({ type: 'debug', action: 'state', id: 11 });
    const state = logsOf(posted).find((l) => l.startsWith('state '));
    assert.ok(state, 'state answered');
    const s = JSON.parse(state.slice(6));
    assert.strictEqual(s.id, 11);
    assert.ok(!s.error, `state without an error: ${s.error}`);
    assert.strictEqual(s.frame, 0, 'the clock decoder\'s frame');
    const frame0 = S.getTab(app.ui.getState()).frame;
    send({ type: 'debug', action: 'step', d: 1 });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, frame0 + 1, 'one step from the single probe');
    // Two videos: the Compare probe answers (one step, not two), the single probe is quiet.
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    const f1 = S.getTab(app.ui.getState()).frame;
    send({ type: 'debug', action: 'step', d: 1 });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, f1 + 1, 'exactly one step with two videos');
    send({ type: 'debug', action: 'a11y', id: 12 });
    const a11y = logsOf(posted).filter((l) => /^(compare )?a11y /.test(l));
    assert.ok(a11y.length === 1 && a11y[0].startsWith('compare a11y '), `the Compare probe answered: ${a11y}`);
    assert.strictEqual(win.vpeCompare.B, made[1]);
    send({ type: 'debug', action: 'offset', tile: 1, v: 3, unit: 'f' });
    assert.deepStrictEqual(S.getOffset(S.getTab(app.ui.getState()), 'B'), { v: 3, unit: 'frames' }, 'offset via the Compare probe');
  }, { cfg: { debug: true }, createPlayer: timedPlayer, extraWidgets: { VpeDebugProbe, VpeCompareDebug } });
});

test('debug probe: thumb draws the real decoder canvas, seek moves controller and decoder, state has loop and A-B, W scopes', () => {
  const VpeDebugProbe = require('../../media/debug-probe');
  const { isProxy } = require('util').types;
  /** The decoder's own canvas: a plain object (as an HTMLCanvasElement would be), never the probe's Proxy. */
  const realPlayer = (clip, host, hooks) => Object.assign(stubPlayer(clip, host, hooks), {
    cv: { width: 1280, height: 720, hidden: false, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }) },
    currentTime() { return this.frame / 25; },
    seekTime(t) { this.calls.push(['seekTime', t]); },
  });
  /** @type {any[]} */
  const scopeEnvs = [];
  let scopeMode = null;
  const VpeScopes = {
    create: (env) => {
      scopeEnvs.push(env);
      return { setMode: (m) => { scopeMode = m; }, mode: () => scopeMode, analysis: () => null, perf: () => ({ updates: 0 }), tick() {} };
    },
    columnLevels: () => [], targets75: () => [],
  };
  withPage(({ doc, app, send, made, posted }) => {
    send({ type: 'open' });
    const p = made[0];
    const answer = (kind) => {
      const l = logsOf(posted).filter((x) => x.startsWith(`${kind} `)).pop();
      assert.ok(l, `${kind} answered`);
      return JSON.parse(l.slice(kind.length + 1));
    };
    // thumb: drawImage gets the decoder's canvas (Chromium's drawImage throws on a Proxy).
    const drawn = [];
    const make = doc.createElement.bind(doc);
    doc.createElement = (tag) => {
      const e = make(tag);
      if (tag === 'canvas') {
        e.getContext = () => ({
          drawImage: (src) => drawn.push(src),
          getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        });
      }
      return e;
    };
    try {
      send({ type: 'debug', action: 'thumb', id: 21, w: 4, h: 2 });
    } finally { doc.createElement = make; }
    const th = answer('thumb');
    assert.ok(!th.error, `thumb without an error: ${th.error}`);
    assert.strictEqual(drawn[0], p.cv, 'the first drawImage source is the clock decoder\'s canvas');
    assert.ok(!isProxy(drawn[0]), 'never a Proxy');
    // seek: the controller's frame and the decoder both move (the frame holding t), not the decoder alone.
    send({ type: 'debug', action: 'seek', t: 2.5 });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 62, 'the controller is at 2.5 s (frame 62 at 25 fps)');
    assert.deepStrictEqual(seeksOf(p).slice(-1), [62], 'the decoder is sent there');
    assert.ok(!p.calls.some((c) => c[0] === 'seekTime'), 'not seeked behind the controller\'s back');
    send({ type: 'debug', action: 'state', id: 22 });
    const st = answer('state');
    assert.ok(!st.error, `state without an error: ${st.error}`);
    assert.strictEqual(st.frame, 62, 'state reports the new frame');
    // Loop and the A-B range: what the controller holds.
    const loop0 = app.ui.getPrefs().onEnd === 'loop'; // the controller's Loop is its end policy
    app.ui.dispatch('loop');
    assert.strictEqual(app.ui.getPrefs().onEnd === 'loop', !loop0);
    send({ type: 'debug', action: 'a11y', id: 23 });
    assert.strictEqual(answer('a11y').loop, !loop0, 'the probe\'s loop follows the controller');
    app.ui.dispatch('seek', 25);
    app.ui.dispatch('setA');
    app.ui.dispatch('seek', 75);
    app.ui.dispatch('setB');
    const range = app.ui.ab.presentationRange();
    assert.ok(range, 'the controller has an A-B range');
    send({ type: 'debug', action: 'state', id: 24 });
    assert.deepStrictEqual(answer('state').abRange, range, 'state reports the controller\'s A-B range');
    // W: the inspection controller's scopes reach media/scopes.js over the decoder's real canvas.
    app.ui.dispatch('scopes');
    assert.strictEqual(scopeEnvs.length, 1, 'a scopes panel is made');
    assert.strictEqual(scopeEnvs[0].canvas, p.cv, 'over the clock decoder\'s canvas');
    send({ type: 'debug', action: 'scopesDump', id: 25 });
    assert.strictEqual(answer('scopesDump').mode, 'waveform', 'scopesDump sees the open scopes');
    for (let i = 0; i < 4; i++) app.ui.dispatch('scopes');
    send({ type: 'debug', action: 'scopesDump', id: 26 });
    assert.strictEqual(answer('scopesDump').mode, 'off', 'W cycles back to off');
  }, { cfg: { debug: true }, createPlayer: realPlayer, extraWidgets: { VpeDebugProbe, VpeScopes } });
});

console.log(`player_unified_test: ${count} ok (${Date.now() - T0} ms)`);
