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
  VpeUi: require('../../media/ui-primitives'),
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
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  };
  return settle(fn, restore);
};
/** fn(), then `after` once it is done: at once, or when the promise it returned settles (testAsync). */
function settle(fn, after) {
  let r;
  try { r = fn(); } catch (e) { after(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(after);
  after();
  return r;
}
/** Async tests run after the others, one at a time (each swaps the browser globals while it runs). */
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push([name, fn]);
const microtasks = () => new Promise((r) => setImmediate(r));

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
    return settle(() => fn({ ...dom, app, posted, send, made, vscode, frames, rafQueue }), () => app.dispose());
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
    const atHide = posted.length;
    win.fire('pagehide');
    // The last position goes out while the page hides (nothing lost to the 2 s report interval), then nothing.
    assert.deepStrictEqual(posted.slice(atHide).map((m) => m.type), ['pos'], 'the position is flushed once on pagehide');
    const before = posted.length;
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
    // In Compare (2+ tiles), rate applies to all decoders while per-decoder loop stays false so unequal-length
    // tiles never wrap independently (the clock's onEnded triggers one shared wrap).
    assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'rate'), [['rate', 1], ['rate', 2]]);
    assert.ok(b.calls.filter((c) => c[0] === 'loop').every((c) => c[1] === false), 'Compare keeps per-decoder loop off');
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

test('decoder metadata: the measured rate and length win over a lying container header (AVI 600 fps, 1800 frames)', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    let t = S.getTab(app.ui.getState());
    assert.strictEqual(t.fps, 600, 'the host\'s probe said 600 fps');
    assert.strictEqual(t.maxFrame, 1799);
    // media/engine.js measures 30 fps and 90 frames from the packets' timestamps.
    Object.assign(p, { fps: 30, n: 90, meta: { duration: 3 } });
    p.hooks.onMeta();
    t = S.getTab(app.ui.getState());
    assert.strictEqual(t.fps, 30, 'the clock runs at the measured rate');
    assert.strictEqual(t.maxFrame, 89, 'the seek bar counts the decoder\'s frames');
    assert.strictEqual(app.engine.getClip('A').fps, 30);
    assert.strictEqual(app.engine.getClip('A').frames, 90);
  }, { cfg: { clips: [{ id: 'A', name: 'h264_aac.avi', fps: 600, frames: 1800 }] }, engineApi: liveEngineApi() });
});

test('decoder log lines beside others carry the tile\'s letter, as media/compare.js wrote them', () => {
  withPage(({ send, made, posted }) => {
    send({ type: 'open' });
    made[0].hooks.log('one video: no prefix');
    send({ type: 'openVideo', clipId: 'clip9', label: 'b.mp4', compare: true, clip: { ...CLIPS[1], id: 'clip9' } });
    made[0].hooks.log('loop: replaying 12 cached frames');
    made[1].hooks.log('loop: replaying 3 cached frames');
    const lines = posted.filter((m) => m.type === 'log').map((m) => m.msg);
    assert.ok(lines.includes('one video: no prefix'), lines.join('\n'));
    assert.ok(lines.includes('[A] loop: replaying 12 cached frames'), lines.join('\n'));
    assert.ok(lines.includes('[B] loop: replaying 3 cached frames'), lines.join('\n'));
  });
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
    // Add B while rate is 2x and loop is on: rate applies, per-decoder loop turns off in Compare (shared wrap).
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    const a = made.find((p) => p.clip.id === 'A');
    const b = made.find((p) => p.clip.id === 'B');
    assert.ok(b && b.calls.some((c) => c[0] === 'rate' && c[1] === 2), 'newly added tile inherits active rate');
    assert.strictEqual(b.calls.filter((c) => c[0] === 'loop').pop()[1], false, 'Compare tile keeps per-decoder loop off');
    // Replace B with C.
    send({ type: 'replaceTile', oldId: 'B', newId: 'C', label: 'c.mp4', clip: CLIPS[2] });
    const c = made.find((p) => p.clip.id === 'C');
    assert.ok(c && c.calls.some((c2) => c2[0] === 'rate' && c2[1] === 2), 'replaced tile inherits active rate');
    assert.strictEqual(c.calls.filter((c2) => c2[0] === 'loop').pop()[1], false, 'replaced Compare tile keeps per-decoder loop off');
    // Leaving Compare (removing C) restores single-video loop=true on A.
    app.ui.dispatch('removeTile', 'C');
    assert.strictEqual(a.calls.filter((c2) => c2[0] === 'loop').pop()[1], true, 'leaving Compare restores loop on single video');
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

test('drop hint: a dragged file shows the page\'s "Drop to compare" frame; the drop hides it and asks the host', () => {
  withPage(({ doc, posted }) => {
    const hint = doc.getElementById('dropHint');
    assert.ok(hint, 'the page has #dropHint (media/player-ui.js shows it while a file is dragged over)');
    assert.strictEqual(hint.hidden, true, 'hidden until something is dragged');
    assert.strictEqual(hint.textContent, 'Drop to compare');
    const uri = 'file:///v/b.mp4';
    const dataTransfer = { types: ['text/uri-list'], getData: (k) => (k === 'text/uri-list' ? `${uri}\r\n` : '') };
    doc.fire('dragenter', { dataTransfer, bubbles: true, cancelable: true });
    assert.strictEqual(hint.hidden, false, 'shown while a video is dragged over the page');
    doc.fire('drop', { dataTransfer, bubbles: true, cancelable: true });
    assert.strictEqual(hint.hidden, true, 'hidden again after the drop');
    assert.deepStrictEqual(posted.filter((m) => m.type === 'compareDrop').map((m) => m.uris), [[uri]]);
  });
});

test('debug seek in Compare: the time is the clock video\'s own, its sync offset taken off', () => {
  const VpeCompareDebug = require('../../media/compare-debug');
  withPage(({ app, send }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    send({ type: 'debug', action: 'clock', tile: 1 });
    send({ type: 'debug', action: 'offset', tile: 1, v: -500, unit: 'ms' });
    send({ type: 'debug', action: 'seek', t: 0.5 });
    const t = S.getTab(app.ui.getState());
    assert.strictEqual(t.clockId, 'B');
    // B (the clock, -500 ms) at its own 0.5 s: the shared timeline, and A (no offset), at about 1.0 s (frame 25 at
    // 25 fps), not at 0.5 s with B before its start.
    assert.ok(Math.abs(t.frame - 25) <= 1, `shared frame ${t.frame}, expected about 25`);
    const EA = require('../../media/player-engine-adapter');
    assert.strictEqual(EA.tileFrameAt(t.frame, 25, t.fps, S.getOffset(t, 'B')), 12, 'B shows its frame at 0.5 s');
    // No offset on the clock: plain seconds, as before.
    send({ type: 'debug', action: 'offset', tile: 1, v: 0, unit: 'ms' });
    send({ type: 'debug', action: 'seek', t: 1.0 });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 25);
  }, { cfg: { debug: true }, extraWidgets: { VpeCompareDebug } });
});

test('entering Compare in place keeps the player\'s moment: the second video joins at the paused frame', () => {
  const VpeDebugProbe = require('../../media/debug-probe');
  const timedPlayer = (clip, host, hooks) => Object.assign(stubPlayer(clip, host, hooks), { currentTime() { return this.frame / 25; } });
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    send({ type: 'debug', action: 'seek', t: 1.0 });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 25, 'the player is paused at 1.0 s');
    send({ type: 'openVideo', clipId: 'B', label: 'b.mp4', compare: true, clip: CLIPS[1] });
    const t = S.getTab(app.ui.getState());
    assert.deepStrictEqual(t.tiles, ['A', 'B']);
    assert.strictEqual(t.frame, 25, 'the comparison starts at the player\'s frame, not at the start');
    assert.ok(seeksOf(made[1]).length === 0 || seeksOf(made[1]).slice(-1)[0] === 25, `B sought to ${seeksOf(made[1])}`);
  }, { cfg: { debug: true }, createPlayer: timedPlayer, extraWidgets: { VpeDebugProbe } });
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

// ---- sound and subtitle tracks, picture subtitles, the X-ray, the pixel inspector, frame links ----

const SubtitlesApi = require('../../media/subtitles');
/** media/engine.js's track API on the stub (tracks_multi.mkv's streams plus a PGS track); onTracks as engine.js. */
function trackPlayer(clip, host, hooks) {
  const p = stubPlayer(clip, host, hooks);
  Object.assign(p, {
    info: { tracks: true }, audioId: 1, subId: null, gen: 1, startT: 0,
    audioTracks: [
      { id: 1, codec: 'aac', lang: 'eng', title: 'English stereo', channels: 2, default: true },
      { id: 2, codec: 'ac3', lang: 'ger', title: 'Deutsch 5.1', channels: 6 },
    ],
    subTracks: [
      { id: 4, codec: 'subrip', lang: 'eng', default: true, kind: 'text' },
      { id: 5, codec: 'ass', lang: 'ger', title: 'Signs', forced: true, kind: 'text' },
      { id: 6, codec: 'hdmv_pgs_subtitle', kind: 'bitmap' },
    ],
    cv: { width: 320, height: 180, hidden: false, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) },
    tracks() { return { audio: p.audioTracks, sub: p.subTracks, audioId: p.audioId, subId: p.subId }; },
    selectSub(id) { p.calls.push(['selectSub', id]); p.subId = id; hooks.onTracks(p); return Promise.resolve(p.tracks()); },
    selectAudio(id) { p.calls.push(['selectAudio', id]); p.audioId = id; hooks.onTracks(p); return Promise.resolve(p.tracks()); },
    currentTime() { return p.frame / 25; },
    onWorkerRead() {},
  });
  return p;
}
const subSelects = (p) => p.calls.filter((c) => c[0] === 'selectSub').map((c) => c[1]);
/** media/subtitles.js with a BitmapRenderer that records (the real one needs ImageData and a 2D canvas). */
const bitmapLog = [];
const SubtitlesStub = {
  ...SubtitlesApi,
  BitmapRenderer: class {
    constructor(box) { this.box = box; }
    render(cues) { bitmapLog.push(cues.map((c) => c.start)); }
    clear() { bitmapLog.push('clear'); }
  },
};

test('embedded subtitles: listed once with names, the default stream on, text cues on the overlay, CC and a pick switch streams', () => {
  withPage(({ doc, app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    const subs = app.ui.parts.subs;
    assert.deepStrictEqual(subs.getState().tracks, [], 'nothing before the decoder knows its streams');
    p.hooks.onTracks(p);
    p.hooks.onTracks(p);
    assert.deepStrictEqual(subs.getState().tracks, ['English · subrip', 'Signs · German · ass', 'Track 3 · hdmv_pgs_subtitle'],
      'each stream once, the codec in the name');
    assert.strictEqual(subs.getState().track, 0, 'the default stream is chosen');
    assert.strictEqual(p.subId, 4, 'and demuxed by the decoder');
    assert.deepStrictEqual(subSelects(p), [4]);
    // A text cue (engine.js player time) shows on #subs at its time, also when it arrives after the frame.
    p.onSubCue({ start: 4, end: 5.5, text: 'EN cue 4', track: 4 });
    app.ui.dispatch('seek', 115); // 4.6 s
    assert.strictEqual(doc.getElementById('subs').hidden, false);
    assert.strictEqual(doc.getElementById('subs').textContent, 'EN cue 4');
    app.ui.dispatch('seek', 150); // 6 s: after its end
    assert.strictEqual(doc.getElementById('subs').hidden, true);
    // CC: off and on again; the decoder demuxes nothing while off.
    subs.toggle();
    assert.strictEqual(p.subId, null);
    subs.toggle();
    assert.strictEqual(p.subId, 4);
    // The Subtitles page picks Signs.
    subs.select(1);
    assert.strictEqual(p.subId, 5);
    assert.deepStrictEqual(subSelects(p), [4, null, 4, 5]);
    // A restarted decoder (another decoder kind, the host's new meta) demuxes the chosen stream again, not listed twice.
    send({ type: 'libav', clipId: 'A', meta: { size: 1, duration: 10 } });
    const p2 = made[1];
    assert.notStrictEqual(p2, p);
    p2.hooks.onTracks(p2);
    assert.strictEqual(p2.subId, 5);
    assert.strictEqual(subs.getState().tracks.length, 3);
  }, { createPlayer: trackPlayer, extraWidgets: { Subtitles: SubtitlesStub } });
});

test('embedded subtitles: no default stream leaves them off; a sidecar file the host sends shows through cueAt', () => {
  const noDefault = (clip, host, hooks) => {
    const p = trackPlayer(clip, host, hooks);
    p.subTracks = p.subTracks.map((s) => ({ ...s, default: false }));
    return p;
  };
  withPage(({ doc, app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    const subs = app.ui.parts.subs;
    p.hooks.onTracks(p);
    assert.strictEqual(subs.getState().tracks.length, 3);
    assert.strictEqual(subs.getState().track, -1, 'no default: off');
    assert.strictEqual(p.subId, null);
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello from the sidecar\n';
    send({ type: 'subs', clipId: 'A', tracks: [{ name: 'a.srt', data: new TextEncoder().encode(srt) }], select: true });
    assert.strictEqual(subs.getState().track, 3, 'the loaded file is chosen');
    assert.strictEqual(p.subId, null, 'a file: the decoder demuxes no stream');
    app.ui.dispatch('seek', 50); // 2 s
    assert.strictEqual(doc.getElementById('subs').textContent, 'Hello from the sidecar');
  }, { createPlayer: noDefault, extraWidgets: { Subtitles: SubtitlesStub } });
});

test('picture subtitles: drawn over the picture at their time, cleared after their end and after a seek', () => {
  bitmapLog.length = 0;
  withPage(({ doc, app, send, made, setRect }) => {
    send({ type: 'open' });
    const p = made[0];
    p.hooks.onTracks(p);
    const subs = app.ui.parts.subs;
    subs.select(2);
    assert.strictEqual(p.subId, 6);
    app.ui.render(); // the browser's first layout (a resize) builds the tile cells
    const cell = doc.getElementById('cells').querySelector('.cell canvas');
    assert.ok(cell, 'the tile canvas');
    setRect(cell, { left: 0, top: 0, width: 680, height: 370 });
    p.onSubCue({ track: 6, span: 1, gen: 1, rects: null });
    p.onSubCue({ track: 6, span: 1, gen: 1, start: 5, end: 7, frame: [320, 180], rects: [{ x: 10, y: 20, w: 30, h: 40 }] });
    app.ui.dispatch('seek', 150); // 6 s
    app.tick(0);
    const box = doc.querySelector('.subs-pic');
    assert.ok(box, '.subs-pic is made');
    assert.strictEqual(box.hidden, false);
    assert.deepStrictEqual(bitmapLog.filter((x) => x !== 'clear').pop(), [5]);
    // The frame covers the whole picture (fit: 320×180 in 680×370 → 657.8×370 centred), the box clips it.
    const f = box.querySelector('.subs-frame').style;
    assert.ok(Math.abs(parseFloat(f.height) - 370) < 0.01 && Math.abs(parseFloat(f.width) - 657.8) < 0.1, `${f.width} × ${f.height}`);
    assert.strictEqual(doc.getElementById('subs').hidden, true, 'no text for a picture track');
    app.ui.dispatch('seek', 200); // 8 s
    app.tick(0);
    assert.strictEqual(box.hidden, true, 'after its end');
    // A seek starts a new read (the decoder's gen): nothing until the worker answers for it.
    app.ui.dispatch('seek', 150);
    p.gen = 2;
    app.tick(0);
    assert.strictEqual(box.hidden, true, 'an older read is not shown after a seek');
    subs.select(-1);
    assert.strictEqual(p.subId, null);
  }, { createPlayer: trackPlayer, extraWidgets: { Subtitles: SubtitlesStub } });
});

test('Audio track page: the decoder\'s streams with their labels; a pick switches the decoder\'s sound', () => {
  withPage(({ doc, app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    p.hooks.onTracks(p);
    app.ui.controls.show('audio');
    const radios = () => Array.from(doc.getElementById('panel').querySelectorAll('[role=radio]'));
    // As the layer-3 probe reads them (media/debug-probe.js tracksMenu): '*' when checked, then the label.
    const labels = radios().map((b) => `${b.getAttribute('aria-checked') === 'true' ? '*' : ''}${(b.querySelector('.grow') || b).textContent.trim()}`);
    assert.ok(/^\*English stereo/.test(labels[0]) && /^Deutsch 5\.1/.test(labels[1]) && labels.length === 2, labels.join(' | '));
    radios()[1].click();
    assert.deepStrictEqual(p.calls.filter((c) => c[0] === 'selectAudio'), [['selectAudio', 2]]);
    assert.strictEqual(p.audioId, 2);
    // A restarted decoder plays the chosen stream again.
    send({ type: 'libav', clipId: 'A', meta: { size: 1, duration: 10 } });
    const p2 = made[1];
    p2.hooks.onTracks(p2);
    assert.strictEqual(p2.audioId, 2);
  }, { createPlayer: trackPlayer, extraWidgets: { Subtitles: SubtitlesStub } });
  // One sound stream (or a decoder without streams): nothing to choose, the mockup's demo list never shows.
  withPage(({ doc, app, send }) => {
    send({ type: 'open' });
    app.ui.controls.show('audio');
    assert.strictEqual(doc.getElementById('panel').querySelectorAll('[role=radio]').length, 0);
    assert.ok(!/Director Commentary/.test(doc.getElementById('panel').textContent));
  });
});

/** media/xray.js's createXray, recorded: its index state is what the test puts there. */
function xrayStub() {
  const made = [];
  const create = (env) => {
    const x = {
      env, shown: false, st: { p: null, n: 0, pts: [], key: [], base: 0, chapters: null },
      toggle(on) { x.shown = on === undefined ? !x.shown : !!on; }, isShown: () => x.shown, chapterTicks() { x.ticks = (x.ticks || 0) + 1; },
      _state: () => x.st,
    };
    made.push(x);
    return x;
  };
  return { made, create };
}

testAsync('Codec X-ray: Shift+X shows media/xray.js\'s strip; { } step through its index; its own key listener stays out', async () => {
  const X = xrayStub();
  await withPage(async ({ doc, app, send, made }) => {
    send({ type: 'open' });
    const p = made[0];
    const listeners0 = doc._listeners ? doc._listeners.keydown : undefined;
    doc.body.fire('keydown', { key: 'X', shiftKey: true });
    await microtasks();
    assert.strictEqual(X.made.length, 1, 'the strip is made on first use');
    assert.strictEqual(X.made[0].shown, true, 'and shown');
    assert.strictEqual(X.made[0].env.ui.seek, doc.getElementById('seek'));
    assert.strictEqual(doc._listeners ? doc._listeners.keydown : undefined, listeners0, 'no keydown listener of its own');
    // The index grows while the strip is open: the keyframe keys read it each time.
    Object.assign(X.made[0].st, { p, n: 4, pts: [0, 0.04, 1, 2], key: [1, 0, 1, 1] });
    app.ui.dispatch('seek', 0);
    doc.body.fire('keydown', { key: '}' });
    await microtasks();
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 25, '} goes to the keyframe at 1 s');
    doc.body.fire('keydown', { key: '}' });
    await microtasks();
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 50);
    doc.body.fire('keydown', { key: '{' });
    await microtasks();
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 25, '{ goes back');
    doc.body.fire('keydown', { key: 'X', shiftKey: true });
    await microtasks();
    assert.strictEqual(X.made[0].shown, false, 'Shift+X again hides it');
    // Chapters come from the file (engine.js info) relative to its start.
    p.info.chapters = [{ start: 0, title: 'One' }, { start: 3, title: 'Two' }];
    doc.body.fire('keydown', { key: 'PageDown' });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 75, 'PageDown: the next chapter at 3 s');
  }, { createPlayer: trackPlayer, extraWidgets: { createXray: X.create } });
});

test('frame link: the controller lands on the link\'s frame once the decoder knows its length, paused', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    const p = made[0];
    assert.ok(S.getTab(app.ui.getState()).frame < 299, 'the link\'s frame is past the length the page knew');
    p.fps = 25;
    p.n = 500;
    p.meta = { duration: 20 };
    p.hooks.onMeta();
    frames(20);
    assert.strictEqual(p.firstShown, true);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 299, 'frame 300 of the link (1-based)');
    assert.strictEqual(seeksOf(p).pop(), 299, 'the decoder is sent there');
    assert.strictEqual(S.getTab(app.ui.getState()).playing, false);
    frames(20);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 299, 'once');
  }, { cfg: { goto: { frame: 300, t: 11.98 }, clips: [{ id: 'A', name: 'a.mp4' }] }, createPlayer: enginePlayer, raf: true });
});

test('pixel inspector (X): the read-out reads the clock decoder\'s picture under the pointer; zoomed far, the grid', () => {
  withPage(({ doc, app, send, made, setRect, frames }) => {
    send({ type: 'open' });
    const p = made[0];
    // A 2D picture (a frame player): read through its context.
    p.ctx = { getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(7) }) };
    app.ui.render();
    const cell = doc.getElementById('cells').querySelector('.cell canvas');
    setRect(cell, { left: 0, top: 0, width: 640, height: 360 });
    doc.body.fire('keydown', { key: 'x' });
    assert.strictEqual(app.ui.parts.insp.getState().inspector, 'loupe');
    doc.getElementById('stage').fire('pointermove', { clientX: 100.5, clientY: 50.5, pointerType: 'mouse' });
    frames(5); // the read waits for an animation frame
    const read = doc.getElementById('pxread');
    assert.strictEqual(read.hidden, false);
    assert.match(read.textContent, /^x 50 {2}y 25\nRGB 7 7 7/);
    doc.body.fire('keydown', { key: 'Escape' });
    assert.strictEqual(read.hidden, true, 'Esc turns it off');
    // Fit shows the 320 px picture at 2 CSS px per pixel: zoom 2 is 400 % (no grid), zoom 4 is 800 % (the grid).
    const grid = doc.getElementById('pxgrid');
    app.ui.setState(S.setZoom(app.ui.getState(), 2, 0, 0));
    assert.strictEqual(grid.hidden, true, '400 %: no grid');
    app.ui.setState(S.setZoom(app.ui.getState(), 4, 0, 0));
    assert.strictEqual(grid.hidden, false, '800 %: the grid');
    app.ui.setState(S.setZoom(app.ui.getState(), 1, 0, 0));
    assert.strictEqual(grid.hidden, true, 'back to Fit');
  }, { createPlayer: trackPlayer, raf: true });
});

test('debug probe: the seek-bar thumbnail (canvas.seek-thumb) is the probe\'s #thumb', () => {
  const VpeDebugProbe = require('../../media/debug-probe');
  withPage(({ send, posted }) => {
    send({ type: 'open' });
    send({ type: 'debug', action: 'state', id: 31 });
    const l = logsOf(posted).filter((x) => x.startsWith('state ')).pop();
    const st = JSON.parse(l.slice(6));
    assert.ok(st.thumb && st.thumb.rect, `the probe finds #thumb: ${JSON.stringify(st.thumb || st.error)}`);
    assert.strictEqual(st.thumb.hidden, true, 'hidden until the pointer is on the seek bar');
  }, { cfg: { debug: true }, createPlayer: trackPlayer, extraWidgets: { VpeDebugProbe } });
});

test('engine adapter: a seek-bar thumbnail (thumbs.js { bmp, w, h, rot }) fills the hover canvas; zoomed tiles draw nearest-neighbour', () => {
  /** A canvas whose 2D context records what is drawn and the smoothing it was drawn with. */
  const canvas = (w = 300, h = 150) => {
    const ops = [];
    const ctx = {
      imageSmoothingEnabled: true,
      save() {}, restore() {}, clearRect() {}, fillRect() {}, beginPath() {}, rect() {}, clip() {},
      setTransform: (...a) => ops.push(['setTransform', ...a]), translate: (...a) => ops.push(['translate', ...a]),
      rotate: (a) => ops.push(['rotate', a]),
      drawImage: (src, ...a) => ops.push(['drawImage', src, ctx.imageSmoothingEnabled, ...a]),
    };
    return { width: w, height: h, style: {}, clientWidth: 0, clientHeight: 0, ops, getContext: () => ctx };
  };
  const bmp = { id: 'bitmap' };
  const cv = canvas();
  assert.strictEqual(EngineAdapter.drawThumbPicture(cv, { bmp, w: 160, h: 90, rot: 0 }), true);
  assert.deepStrictEqual([cv.width, cv.height], [160, 90], 'sized to the picture');
  assert.deepStrictEqual(cv.ops.find((o) => o[0] === 'drawImage').slice(0, 2), ['drawImage', bmp]);
  const turned = canvas();
  EngineAdapter.drawThumbPicture(turned, { bmp, w: 160, h: 90, rot: 90 });
  assert.deepStrictEqual([turned.width, turned.height], [90, 160], 'turned like the video');
  assert.strictEqual(EngineAdapter.drawThumbPicture(canvas(), null), false);
  assert.strictEqual(EngineAdapter.drawThumbPicture(canvas(), { bmp }), false, 'no size: nothing drawn');
  // Through the adapter: the player's thumbnail service answers with such a picture.
  const player = {
    thumbnail: (_t, cb) => { cb({ bmp, w: 64, h: 36, rot: 0 }); return true; },
    snapshotSource: () => ({ width: 320, height: 180 }),
  };
  const A = EngineAdapter.create({ clips: [{ id: 'A', fps: 25, frames: 250, width: 320, height: 180 }], getPlayer: () => player });
  const hover = canvas();
  A.thumbnail('A', 2, hover, false);
  assert.deepStrictEqual([hover.width, hover.height], [64, 36], 'the hover canvas shows the thumbnail, not the shown frame');
  // A tile at 100 % of a 320 px picture is smoothed; zoomed past 200 % it is drawn nearest-neighbour.
  const tile = canvas(640, 360);
  A.draw(tile, 'A', 0, { width: 640, height: 360, picMode: 'fit', zoom: 1 });
  let d = tile.ops.filter((o) => o[0] === 'drawImage').pop();
  assert.strictEqual(d[2], false, 'fit at 2 CSS px per pixel: nearest');
  assert.strictEqual(tile.style.imageRendering, 'pixelated');
  const big = canvas(320, 180);
  A.draw(big, 'A', 0, { width: 320, height: 180, picMode: 'fit', zoom: 1 });
  d = big.ops.filter((o) => o[0] === 'drawImage').pop();
  assert.strictEqual(d[2], true, '100 %: smoothed');
  assert.strictEqual(big.style.imageRendering, '');
});

test('pause then play on a fully-decoded clip (p.eof true mid-clip) resumes in place instead of seeking to 0', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    const p = made[0];
    p.n = 90;
    p.eof = true; // demuxer finished decoding all frames into RAM, playhead is still mid-clip
    p.seekTime = (s) => { p.calls.push(['seekTime', s]); p.frame = Math.round(s * 30); };
    app.ui.dispatch('seek', 30);
    frames(2);
    assert.strictEqual(p.currentFrame(), 30);
    const seeksBefore = p.calls.filter((c) => c[0] === 'seekTime').length;
    app.ui.dispatch('playPause'); // play from frame 30 with p.eof === true
    assert.strictEqual(p.calls.filter((c) => c[0] === 'seekTime').length, seeksBefore, 'must not seek back to 0 mid-clip');
    assert.strictEqual(p.currentFrame(), 30);
    app.ui.dispatch('playPause'); // pause
    // At the actual last frame with p.eof === true, play DOES restart from 0.
    app.ui.dispatch('seek', 89);
    frames(2);
    const seeksAtEnd = p.calls.filter((c) => c[0] === 'seekTime').length;
    app.ui.dispatch('playPause');
    assert.strictEqual(p.calls.filter((c) => c[0] === 'seekTime').length, seeksAtEnd + 1, 'restarts from 0 when on the last frame');
    assert.strictEqual(p.calls.filter((c) => c[0] === 'seekTime').pop()[1], 0);
  }, { cfg: { clips: [{ id: 'A', name: 'a.mp4', fps: 30, frames: 90 }] }, createPlayer: enginePlayer, raf: true });
});

test('compare: when a shorter clock ends, longer followers pause too and stay paused on seek', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    const [pA, pB] = made;
    app.ui.dispatch('playPause'); // start both playing
    assert.deepStrictEqual([pA.isPlaying(), pB.isPlaying()], [true, true], 'both playing');
    // Clock A (shorter) reaches its end naturally while B (longer) is still mid-clip.
    pA.playing = false;
    pA.frame = 59;
    pA.hooks.onEnded({ natural: true });
    assert.strictEqual(S.getTab(app.ui.getState()).playing, false, 'tab paused at clock end');
    assert.deepStrictEqual([pA.isPlaying(), pB.isPlaying()], [false, false], 'longer follower B paused with clock A');
    // Seeking backwards while paused must keep both paused (even if a follower drifted into playing).
    pB.playing = true;
    app.ui.dispatch('seek', 20);
    frames(2);
    assert.deepStrictEqual([pA.isPlaying(), pB.isPlaying()], [false, false], 'both remain paused after seek');
  }, {
    cfg: {
      clips: [
        { id: 'A', name: 'short.mp4', fps: 30, frames: 60 },
        { id: 'B', name: 'long.mp4', fps: 30, frames: 300 },
      ],
      tiles: ['A', 'B'],
    },
    createPlayer: enginePlayer,
    raf: true,
  });
});

/**
 * A decoder shaped like media/engine.js for Compare's transport: playing advances a frame per tick and stops itself on
 * its last frame (onEnded, as ended() does); play() on the last frame starts over from 0 (engine.js play(), no follower
 * mode); a seek pauses it until it is told to play again. `restartsByPlay` counts the starts-over play() caused.
 */
function selfStoppingPlayer(clip, host, hooks) {
  const p = stubPlayer(clip, host, hooks);
  const n = clip.frames;
  const clamp = (f) => Math.max(0, Math.min(n - 1, Math.round(f)));
  Object.assign(p, {
    n, fps: clip.fps, firstShown: true, shownCount: 1, seekTarget: null, eof: false, restartsByPlay: 0, seekPending: false,
    frameSeekTime: (f) => (f + 0.5) / clip.fps,
    seekFrame(f) { p.calls.push(['seek', f]); p.frame = clamp(f); p.playing = false; p.seekPending = true; },
    seekTime(s, stepping) {
      p.calls.push(['seekTime', s, !!stepping]);
      p.frame = clamp(s * clip.fps - 0.5);
      p.playing = false;
      p.seekPending = true;
    },
    play() {
      p.calls.push(['play']);
      // engine.js play(): starts over only at the end with no seek pending (seekTarget === null).
      if (p.frame >= n - 1 && !p.seekPending) { p.frame = 0; p.restartsByPlay++; }
      p.playing = true;
    },
    tick() {
      p.seekPending = false;
      if (!p.playing) return;
      if (p.frame >= n - 1) { p.playing = false; hooks.onEnded({ natural: true }); return; }
      p.frame++;
    },
  });
  return p;
}
const SHORT_LONG = {
  clips: [
    { id: 'A', name: 'long.mp4', fps: 30, frames: 300 },
    { id: 'B', name: 'short.mp4', fps: 30, frames: 60 },
  ],
  tiles: ['A', 'B'],
};
const playsOf = (p) => p.calls.filter((c) => c[0] === 'play').length;

test('compare transport invariant fuzzer: no tile out of its clip plays, every other one plays with the tab, none starts over from 0, a paused one settles on its target', () => {
  // Deterministic LCG so failures are 100% reproducible.
  let seed = 0x51a7c0de;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const pick = (n) => Math.floor(rnd() * n);
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    frames(2);
    const playerOf = (id) => made.filter((p) => p.clip.id === id).pop();
    const assertInvariants = (step, what) => {
      const tab = S.getTab(app.ui.getState());
      for (const id of tab.tiles) {
        const p = playerOf(id);
        const s = app.engine.shownFrame(id, tab.frame, S.getOffset(tab, id), tab.fps);
        const at = `step ${step} (${what}), tile ${id} at ${p.frame}/${p.n - 1}, target ${s.frame}, tab ${tab.playing ? 'playing' : 'paused'}`;
        // (a) outside its clip: never playing (nor heard from 0 behind "No frame").
        if (s.frame === null) assert.strictEqual(p.isPlaying(), false, `${at}: out of range but playing`);
        // (b) and (c) in its clip: plays exactly when the tab plays (a paused seek leaves none playing), except a tile
        // resting on its own last frame that the timeline has not left.
        else if (!(tab.playing && p.frame === p.n - 1 && s.frame >= p.n - 1)) {
          assert.strictEqual(p.isPlaying(), tab.playing, `${at}: isPlaying() does not match the tab`);
        }
        // (d) play() never landed on a decoder's end (it would start over from 0, mid-timeline).
        assert.strictEqual(p.restartsByPlay, 0, `${at}: play() at its end restarted it from 0`);
      }
    };
    const ops = ['playPause', 'seek', 'step', 'selfEnd', 'setClock', 'nudge', 'loop', 'play on'];
    for (let step = 0; step < 400; step++) {
      const tab = S.getTab(app.ui.getState());
      // Demuxer end of file mid-clip on any tile (short, fully decoded videos): not the playhead's end.
      if (rnd() < 0.3) made[pick(made.length)].eof = true;
      const op = ops[pick(ops.length)];
      if (op === 'playPause') app.ui.dispatch('playPause');
      else if (op === 'seek') app.ui.dispatch('seek', pick(Math.max(1, tab.maxFrame + 1)));
      else if (op === 'step') app.ui.dispatch(rnd() < 0.5 ? 'nextFrame' : 'prevFrame');
      else if (op === 'selfEnd') {
        // A tile runs into its end by itself (often the shorter one while the others are mid-clip).
        const p = playerOf(tab.tiles[pick(tab.tiles.length)]);
        if (p.playing) { p.frame = p.n - 1; p.tick(); }
      } else if (op === 'setClock') app.ui.dispatch('setClock', tab.tiles[pick(tab.tiles.length)]);
      else if (op === 'nudge') app.ui.setState(S.nudgeOffset(app.ui.getState(), tab.tiles[pick(tab.tiles.length)], pick(41) - 20));
      else if (op === 'loop') app.ui.dispatch('loop');
      frames(1 + pick(6));
      assertInvariants(step, op);
      // (e) paused and settled: every tile in its clip shows its target (seek / step and playback map alike).
      if (rnd() < 0.15) {
        if (S.getTab(app.ui.getState()).playing) app.ui.dispatch('playPause');
        frames(3);
        const paused = S.getTab(app.ui.getState());
        for (const id of paused.tiles) {
          const s = app.engine.shownFrame(id, paused.frame, S.getOffset(paused, id), paused.fps);
          if (s.frame === null) continue;
          assert.strictEqual(playerOf(id).currentFrame(), s.frame,
            `step ${step} (${op}, then paused) clock ${paused.clockId} frame ${paused.frame} max ${paused.maxFrame}: tile ${id} settled on ${playerOf(id).currentFrame()}, target ${s.frame}`);
        }
      }
    }
  }, {
    cfg: {
      clips: [
        { id: 'A', name: 'short.mp4', fps: 30, frames: 60 },
        { id: 'B', name: 'med.mp4', fps: 30, frames: 120 },
        { id: 'C', name: 'long.mp4', fps: 24, frames: 240 },
      ],
      tiles: ['A', 'B', 'C'],
    },
    createPlayer: selfStoppingPlayer,
    raf: true,
  });
});

/**
 * A decoder whose sound outlasts its picture (media/engine.js): its length `n` comes from the duration (150 frames)
 * but its last picture is frame 100, so currentFrame() stays there while the sound plays on to its end. `t` is its
 * position in frames; play() at its end with no seek pending starts over from 0, as engine.js does.
 */
function soundLongerPlayer(clip, host, hooks) {
  const p = selfStoppingPlayer(clip, host, hooks);
  const lastPicture = 100;
  Object.assign(p, {
    n: 150, t: 0,
    seekFrame(f) { p.calls.push(['seek', f]); p.t = Math.max(0, Math.min(149, f)); p.frame = Math.min(p.t, lastPicture); p.playing = false; p.seekPending = true; },
    seekTime(sec) { p.calls.push(['seekTime', sec]); p.seekFrame(Math.round(sec * clip.fps)); p.calls.pop(); },
    play() {
      p.calls.push(['play']);
      if (p.t >= 149 && !p.seekPending) { p.t = 0; p.frame = 0; p.restartsByPlay++; }
      p.playing = true;
    },
    tick() {
      p.seekPending = false;
      if (!p.playing) return;
      if (p.t >= 149) { p.playing = false; hooks.onEnded({ natural: true }); return; }
      p.t++;
      p.frame = Math.min(p.t, lastPicture);
    },
  });
  return p;
}

test('sound longer than the picture: play after its end starts over from 0, not from the end of the sound', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    frames(2);
    const p = made[0];
    app.ui.dispatch('playPause');
    frames(160);
    assert.strictEqual(p.isPlaying(), false, 'stopped at the end of the sound');
    assert.strictEqual(S.getTab(app.ui.getState()).playing, false, 'and the bar with it');
    assert.strictEqual(p.t, 149, 'the bar going to its end did not seek the decoder (it stays at its own end)');
    app.ui.dispatch('playPause');
    frames(5);
    assert.strictEqual(p.isPlaying(), true, 'play after the end plays');
    assert.ok(p.t < 10, `and starts over (at ${p.t})`);
  }, { cfg: { clips: [{ id: 'A', name: 'audio_longer.mp4', fps: 30, frames: 150 }] }, createPlayer: soundLongerPlayer, raf: true });
});

test('a sound-only file whose length was counted at another rate plays and loops to the end of its sound', () => {
  // The clip's numbers (24 fps fallback, 121 frames by the duration) and the decoder's frames (counted at 30 fps, 151)
  // disagree: a single video is never "outside its clip", so it is never paused for it, and the bar follows it.
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    frames(2);
    const p = made[0];
    // As seen in VS Code: the timeline kept the fallback length (240 frames), the clip learnt 121.
    app.ui.setState(S.syncClockMeta(app.ui.getState(), { fps: 24, maxFrame: 239 }));
    assert.strictEqual(app.engine.getClip('A').frames, 121);
    app.ui.dispatch('loop');
    app.ui.dispatch('playPause');
    frames(135);
    assert.ok(p.frame > 125, `plays past the clip's counted length (at ${p.frame})`);
    assert.strictEqual(p.isPlaying(), true, 'never paused for being outside its clip');
    assert.ok(S.getTab(app.ui.getState()).frame > 121, `the bar follows it (at ${S.getTab(app.ui.getState()).frame}, max ${S.getTab(app.ui.getState()).maxFrame})`);
    frames(20); // the end of its sound: Loop starts it over
    assert.strictEqual(p.isPlaying(), true, 'loops');
    assert.ok(p.frame < 25, `from the start (at ${p.frame})`);
  }, {
    cfg: { clips: [{ id: 'A', name: 'sine_only.mkv', fps: 24, frames: 121 }] }, raf: true,
    // The decoder counts 151 frames (5.02 s at its default 30 fps).
    createPlayer: (clip, host, hooks) => Object.assign(selfStoppingPlayer({ ...clip, fps: 30, frames: 151 }, host, hooks), { clip }),
  });
});

/**
 * selfStoppingPlayer with media/engine.js's lockstep surface (syncState, rel, now, holdAt, setFollowerMode). `frozen`:
 * its picture stops (a slow decoder): shownT and shownCount stay where they are while it "plays".
 */
function syncedPlayer(clip, host, hooks) {
  const p = selfStoppingPlayer(clip, host, hooks);
  const fps = clip.fps;
  const tick = p.tick;
  Object.assign(p, {
    frozen: false, holds: [], gen: 0, follow: null,
    tick() { if (p.frozen) { p.seekPending = false; return; } tick(); if (p.playing) p.shownCount++; },
    syncState: () => Object.freeze({
      startT: 0, shownT: p.frame / fps, pauseT: p.frame / fps, seekTarget: null, nextQueuedT: null, eof: false,
      gen: p.gen, fps, shownCount: p.shownCount, current: true, firstFrameReady: false, settled: !p.playing,
    }),
    rel: (x) => x,
    now: () => p.frame / fps,
    holdAt: (x) => p.holds.push(x),
    setFollowerMode: (fn) => { p.follow = fn; },
  });
  return p;
}

test('compare lockstep: a follower that lags holds the clock (and the heard tile) until it catches up or stalls for 3 s', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    frames(2);
    const [pA, pB, pC] = made;
    assert.strictEqual(typeof pB.follow, 'function', 'a follower follows the clock decoder');
    assert.strictEqual(pA.follow, null, 'the clock runs on its own');
    app.ui.setState(S.setSound(app.ui.getState(), 'C'));
    app.ui.dispatch('playPause');
    frames(10, 40);
    assert.deepStrictEqual([pA.holds.length, pC.holds.length], [0, 0], 'in step: nothing is held');
    pB.frozen = true; // B's picture stops (a slow 4K tile in the built-in decoder)
    frames(3, 40); // lag below max(0.12 s, 2 frames): not yet
    const before = pA.holds.length;
    frames(5, 40);
    assert.ok(pA.holds.length > before, 'B more than 0.12 s behind holds the clock');
    assert.strictEqual(pA.holds[pA.holds.length - 1], pA.frame / 30, 'on its shown picture');
    assert.ok(pC.holds.length > 0, 'and the heard tile with it');
    // B makes no progress at all: after 3 s it stops holding the group.
    frames(80, 40);
    const stalled = pA.holds.length;
    frames(10, 40);
    assert.strictEqual(pA.holds.length, stalled, 'a follower stalled for 3 s holds no more');
    // B moves again (and lags): it holds again; caught up (in step with the clock): it lets go.
    pB.frozen = false;
    pB.shownCount++;
    frames(1, 40);
    assert.ok(pA.holds.length > stalled, 'progress holds again while it lags');
    pB.frame = pA.frame;
    pB.shownCount++;
    const caught = pA.holds.length;
    frames(5, 40);
    assert.strictEqual(pA.holds.length, caught, 'caught up: nothing is held');
    // Paused: no lockstep.
    app.ui.dispatch('playPause');
    pB.frozen = true;
    frames(5, 40);
    assert.strictEqual(pA.holds.length, caught);
  }, {
    cfg: {
      clips: [
        { id: 'A', name: 'a.mp4', fps: 30, frames: 600 },
        { id: 'B', name: 'b.mp4', fps: 30, frames: 600 },
        { id: 'C', name: 'c.mp4', fps: 30, frames: 600 },
      ],
      tiles: ['A', 'B', 'C'],
    },
    createPlayer: syncedPlayer,
    raf: true,
  });
});

test('compare: a follower outside its clip is paused and never played, so it is not heard from 0', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    const [pA, pB] = made;
    app.ui.dispatch('playPause');
    frames(2);
    assert.deepStrictEqual([pA.isPlaying(), pB.isPlaying()], [true, true]);
    const plays = playsOf(pB);
    app.ui.dispatch('seek', 100); // B has 60 frames: "No frame (clip ended)"
    frames(5);
    assert.strictEqual(pA.isPlaying(), true, 'the clock plays on');
    assert.strictEqual(pB.isPlaying(), false, 'B is paused outside its clip');
    assert.strictEqual(playsOf(pB), plays, 'B was never told to play');
    assert.strictEqual(pB.restartsByPlay, 0);
    // Pause and play again outside B's clip: still not B.
    app.ui.dispatch('playPause');
    app.ui.dispatch('playPause');
    frames(3);
    assert.strictEqual(pB.isPlaying(), false);
    assert.strictEqual(playsOf(pB), plays);
  }, { cfg: SHORT_LONG, createPlayer: selfStoppingPlayer, raf: true });
});

test('compare: a shorter follower that stopped at its end plays again from the frame a seek back takes it to', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    const [pA, pB] = made;
    app.ui.dispatch('seek', 55);
    frames(2);
    app.ui.dispatch('playPause');
    frames(10); // B runs into its end (frame 59) and stops itself; A plays on
    assert.strictEqual(pB.frame, 59);
    assert.strictEqual(pB.isPlaying(), false, 'B stopped itself at its end');
    assert.strictEqual(pA.isPlaying(), true);
    assert.strictEqual(S.getTab(app.ui.getState()).playing, true);
    app.ui.dispatch('seek', 20); // back into B's clip while playing
    frames(1);
    assert.deepStrictEqual(seeksOf(pB).slice(-1), [20], 'B is sought to the timeline\'s frame');
    assert.strictEqual(pB.isPlaying(), true, 'and plays again');
    assert.strictEqual(pB.restartsByPlay, 0, 'not from 0');
    assert.ok(pB.frame >= 20 && pB.frame < 25, `B plays on from 20 (at ${pB.frame})`);
  }, { cfg: SHORT_LONG, createPlayer: selfStoppingPlayer, raf: true });
});

test('compare: a follower with a positive offset is sought to its first frame when the timeline reaches it while playing', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    const pB = made[1];
    app.ui.setState(S.setOffset(app.ui.getState(), 'B', -10)); // B starts 10 frames into the timeline
    app.ui.dispatch('seek', 2);
    frames(2);
    const stale = pB.frame;
    app.ui.dispatch('playPause');
    frames(3);
    assert.strictEqual(pB.isPlaying(), false, 'outside its clip before its start');
    frames(10);
    assert.strictEqual(pB.isPlaying(), true, 'playing once inside its clip');
    assert.ok(seeksOf(pB).includes(0), `B was sought to its first frame (seeks ${seeksOf(pB)}, stale ${stale})`);
  }, { cfg: SHORT_LONG, createPlayer: selfStoppingPlayer, raf: true });
});

test('compare: playing seeks never pass stepping = true to seekTime (that flag keeps a step goal, not playback)', () => {
  const timeOnly = (clip, host, hooks) => {
    const p = selfStoppingPlayer(clip, host, hooks);
    delete p.seekFrame;
    return p;
  };
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    app.ui.dispatch('playPause');
    frames(2);
    app.ui.dispatch('seek', 30);
    app.ui.setState(S.nudgeOffset(app.ui.getState(), 'B', 3));
    frames(2);
    const calls = made.flatMap((p) => p.calls.filter((c) => c[0] === 'seekTime'));
    assert.ok(calls.length >= 2, 'the seeks went through seekTime');
    assert.ok(calls.every((c) => c[2] === false), `no seekTime(t, true): ${JSON.stringify(calls)}`);
    assert.deepStrictEqual(made.map((p) => p.isPlaying()), [true, true], 'and both play on');
  }, { cfg: SHORT_LONG, createPlayer: timeOnly, raf: true });
});

test('play on the clock\'s last frame starts the whole timeline over; a paused tile on its own last frame is not played', () => {
  withPage(({ app, send, made, frames }) => {
    send({ type: 'open' });
    const [pA, pB] = made;
    app.ui.dispatch('setClock', 'B');
    app.ui.dispatch('seek', 59); // B (the clock) on its last frame, A mid-clip
    frames(2);
    app.ui.dispatch('playPause');
    assert.strictEqual(pB.restartsByPlay, 0, 'not by play() at the end');
    assert.strictEqual(pB.calls.filter((c) => c[0] === 'seekTime').pop()[1], 0, 'the clock went back to its start');
    assert.deepStrictEqual(seeksOf(pA).slice(-1), [0], 'and A to the timeline\'s start');
    frames(3);
    assert.deepStrictEqual([pA.isPlaying(), pB.isPlaying()], [true, true]);
    assert.ok(S.getTab(app.ui.getState()).frame < 10, 'the bar follows the clock from the start');
  }, { cfg: SHORT_LONG, createPlayer: selfStoppingPlayer, raf: true });
});

/** Two 30 fps tiles on enginePlayer decoders that loop and seek by time, for the Compare cases below. */
function withTwoTiles(fn) {
  withPage((page) => {
    page.send({ type: 'open' });
    const [pA, pB] = page.made;
    pA.n = 120; pB.n = 240;
    for (const p of [pA, pB]) {
      p.frameSeekTime = (f) => f / 30;
      p.seekTime = (s) => { p.calls.push(['seekTime', s]); p.frame = Math.round(s * 30); };
      p.setLoop = (v) => { p.loop = !!v; };
    }
    page.app.ui.render();
    fn({ ...page, pA, pB });
  }, {
    cfg: {
      clips: [
        { id: 'A', name: 'a.mp4', fps: 30, frames: 120 },
        { id: 'B', name: 'b.mp4', fps: 30, frames: 240 },
      ],
      tiles: ['A', 'B'],
    },
    createPlayer: enginePlayer,
    raf: true,
  });
}

test('compare: Loop keeps every decoder\'s own loop off (one shared wrap through the clock\'s end)', () => {
  withTwoTiles(({ app, pA, pB }) => {
    pA.loop = true; pB.loop = true;
    app.ui.dispatch('loop');
    assert.deepStrictEqual([!!pA.loop, !!pB.loop], [false, false]);
  });
});

test('compare: a follower\'s offset edit while playing keeps it playing', () => {
  withTwoTiles(({ app, pA, pB }) => {
    app.ui.dispatch('playPause');
    assert.deepStrictEqual([pA.isPlaying(), pB.isPlaying()], [true, true]);
    app.ui.setState(S.nudgeOffset(app.ui.getState(), 'B', 10));
    assert.strictEqual(pB.isPlaying(), true);
  });
});

test('compare: a clock with an offset does not shift the shared frame twice', () => {
  withTwoTiles(({ app, pB, frames }) => {
    app.ui.setState(S.nudgeOffset(app.ui.getState(), 'B', 10));
    app.ui.dispatch('seek', 40);
    frames(2);
    assert.strictEqual(pB.currentFrame(), 50, 'B is at 40 + 10');
    app.ui.dispatch('setClock', 'B');
    frames(2);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 40, 'the shared frame stays 40 with B (+10 f) the clock');
  });
});

test('compare: a reopened follower catches up with the timeline instead of rewinding it', () => {
  withTwoTiles(({ app, send, made, frames }) => {
    app.ui.dispatch('setClock', 'B');
    app.ui.dispatch('seek', 50);
    send({ type: 'libav', clipId: 'A', meta: { size: 1, duration: 4 } }); // restarts follower A at frame 50
    const pA2 = made[made.length - 1];
    app.ui.dispatch('seek', 70); // the user seeks while A is still reopening
    pA2.firstShown = true;
    frames(2);
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 70, 'the timeline stays at 70');
  });
});

test('clock frames with a fractional ms offset map back to the shared frame they were sent from (no 1-frame drift)', () => {
  withPage(({ app, send, made }) => {
    send({ type: 'open' });
    const pA = made[0];
    app.ui.setState(S.setOffset(app.ui.getState(), 'A', { unit: 'ms', v: 62.5 })); // 1.5 frames at 24 fps
    for (const f of [0, 1, 24, 100, 200]) {
      app.ui.dispatch('seek', f);
      const sent = seeksOf(pA).pop();
      pA.hooks.onFrame(sent);
      assert.strictEqual(S.getTab(app.ui.getState()).frame, f, `shared ${f} -> decoder ${sent} -> back`);
    }
  }, { cfg: { clips: [MIXED[0], MIXED[1]], tiles: ['A', 'B'] } });
});

test('a FramePlayer (shown counter, no firstShown) starts autoplay', () => {
  const framePlayerStub = (clip, host, hooks) => {
    const p = enginePlayer(clip, host, hooks);
    p.firstShown = undefined;
    p.shown = 0;
    p.shownCount = 1;
    return p;
  };
  withPage(({ app, send, frames }) => {
    send({ type: 'open' });
    frames(2);
    assert.strictEqual(S.getTab(app.ui.getState()).playing, true);
  }, {
    cfg: { clips: [{ id: 'A', name: 'seq', fps: 30, frames: 90, duration: 3 }], prefs: { autoplay: true } },
    createPlayer: framePlayerStub,
    raf: true,
  });
});

test('a natural end reports the final position (the bookmark is cleared)', () => {
  withPage(({ send, made, posted }) => {
    send({ type: 'open' });
    const p = made[0];
    p.frame = p.n - 1;
    p.hooks.onEnded({ natural: true });
    const pos = posted.filter((m) => m.type === 'pos').pop();
    assert.ok(pos && pos.t >= 2.9, `final pos ${pos && pos.t}`);
  }, { cfg: { clips: [{ id: 'A', name: 'a.mp4', fps: 30, frames: 90, duration: 3 }] }, createPlayer: enginePlayer, raf: true });
});

test('playing on, the position is flushed when the page hides (not lost to the 2 s report interval)', () => {
  withPage(({ doc, app, send, made, posted }) => {
    send({ type: 'open' });
    app.ui.dispatch('playPause');
    made[0].hooks.onFrame(40);
    made[0].hooks.onFrame(41); // within 2 s: not reported
    const n = posted.filter((m) => m.type === 'pos').length;
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    const pos = posted.filter((m) => m.type === 'pos');
    assert.strictEqual(pos.length, n + 1);
    assert.ok(Math.abs(pos[pos.length - 1].t - 41 / 25) < 1e-9, `t ${pos[pos.length - 1].t}`);
  });
});

test('Opening… stays after a decoder says ready until it presents a picture', () => {
  const lateFrame = (clip, host, hooks) => {
    const p = enginePlayer(clip, host, hooks);
    const tick = p.tick;
    p.tick = (now) => { if (!p.opened) { p.opened = true; hooks.onReady(); return; } tick(now); };
    return p;
  };
  withPage(({ doc, send, made, frames }) => {
    send({ type: 'open' });
    frames(1); // the decoder opened its file: onReady, no picture yet
    assert.strictEqual(made[0].opened, true);
    assert.strictEqual(made[0].firstShown, false);
    assert.strictEqual(doc.getElementById('overlay').hidden, false, 'still opening');
    frames(1);
    assert.strictEqual(made[0].firstShown, true);
    assert.strictEqual(doc.getElementById('overlay').hidden, true, 'the first picture takes it away');
  }, { createPlayer: lateFrame, raf: true });
});

test('Audio track page in Compare: the sound tile\'s streams, and a pick switches that decoder', () => {
  const twoTrackPlayer = (clip, host, hooks) => {
    const p = trackPlayer(clip, host, hooks);
    if (clip.id === 'B') p.audioTracks = [{ id: 7, codec: 'opus', lang: 'fra', title: 'Français' }, { id: 8, codec: 'aac', lang: 'spa', title: 'Español' }];
    return p;
  };
  withPage(({ doc, app, send, made }) => {
    send({ type: 'open' });
    const [pA, pB] = made;
    pA.hooks.onTracks(pA);
    pB.hooks.onTracks(pB);
    app.ui.setState(S.setSound(app.ui.getState(), 'B'));
    app.ui.controls.show('audio');
    const radios = () => Array.from(doc.getElementById('panel').querySelectorAll('[role=radio]'));
    const text = radios().map((b) => b.textContent).join(' | ');
    assert.ok(/Français/.test(text) && /Español/.test(text) && !/English/.test(text), text);
    radios()[1].click();
    assert.deepStrictEqual(pB.calls.filter((c) => c[0] === 'selectAudio'), [['selectAudio', 8]]);
    assert.deepStrictEqual(pA.calls.filter((c) => c[0] === 'selectAudio'), []);
  }, { cfg: { clips: [CLIPS[0], CLIPS[1]], tiles: ['A', 'B'] }, createPlayer: twoTrackPlayer, extraWidgets: { Subtitles: SubtitlesStub } });
});

test('native thumbnails: the host\'s reply reaches media/engine.js onHostThumb with this page\'s id', () => {
  withPage(({ send, made }) => {
    send({ type: 'open' });
    // The host adapter takes the envelope off; onHostThumb ignores a reply for another page (m.page !== env.page).
    send({ type: 'thumb', clipId: 'A', key: 'A', id: 3, w: 4, h: 2, data: [1] });
    const got = made[0].calls.filter((c) => c[0] === 'thumb').map((c) => c[1]);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].page, 7, 'the page id is back on the reply');
    assert.strictEqual(got[0].id, 3);
  });
});

testAsync('Compare metrics (debug): the paused pair is logged once per pair, the scan finds the first difference; report stage', async () => {
  const VpeCompareDebug = require('../../media/compare-debug');
  const realMetrics = require('../../media/compare-metrics');
  const measured = [];
  // No WebGL in Node: the read-back is a stub; B differs from frame 41 (0-based) on.
  const VpeCompareMetrics = {
    ...realMetrics,
    install: () => ({
      pairMetrics: async (pa, pb, o) => {
        measured.push([pa.frame, pb.frame, o]);
        const v = pa.frame >= 41 ? 21.5 : Infinity;
        return { psnrY: v, psnrRGB: v, ssimY: 1, exactY: true, w: 4, h: 4 };
      },
      resetReadback() {},
    }),
  };
  const timed = (clip, host, hooks) => Object.assign(stubPlayer(clip, host, hooks), {
    // What the Compare report reads of a decoder (media/engine.js fields).
    shownCount: 1, shownT: 0, startT: 0, pauseT: 0, fps: 25, cv: { width: 1280, height: 720 }, cfg: { native: false }, info: {},
    rel(t) { return t; }, shownMarkTime() { return this.frame / 25; }, currentTime() { return this.frame / 25; },
    seekFrame(f) { this.frame = f; this.shownCount++; this.calls.push(['seek', f]); },
  });
  await withPage(async ({ $, win, app, send, made, posted, frames }) => {
    send({ type: 'open' });
    send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
    // seek t: the frame holding t (40.5 / 25 s is frame 40), as media/compare.js seekClock.
    send({ type: 'debug', action: 'seek', t: 40.5 / 25 });
    assert.strictEqual(S.getTab(app.ui.getState()).frame, 40);
    frames(3);
    await microtasks();
    await microtasks();
    const lines = () => logsOf(posted).filter((l) => l.startsWith('metrics '));
    assert.strictEqual(lines().length, 1, `one metrics line: ${logsOf(posted).slice(-5)}`);
    assert.match(lines()[0], /^metrics frameA=41 frameB=41 psnrY=Infinity psnrRGB=Infinity /);
    frames(3);
    await microtasks();
    assert.strictEqual(lines().length, 1, 'the same pictures are not measured again');
    // The scan from #41 on stops at #42 (B's PSNR drops there).
    send({ type: 'debug', action: 'scan', thresh: 35 });
    // The page's timers are the fake window's: run what is due, tick, repeat.
    const runTimers = () => {
      const ts = win.timers;
      for (let i = 0; i < ts.length; i++) { const x = ts[i]; if (x) { ts[i] = null; x.fn(); } }
    };
    for (let i = 0; i < 40 && !logsOf(posted).some((l) => l.startsWith('scan: ')); i++) {
      runTimers();
      frames(1);
      await microtasks();
    }
    const scan = logsOf(posted).find((l) => l.startsWith('scan: '));
    assert.match(scan || '', /^scan: #42: PSNR Y 21\.50 dB \(< 35 dB\)/);
    assert.ok(measured.some((m) => m[2].ssim === false), 'the scan measured luma PSNR only');
    // The report's stage is the whole picture area in device pixels (the scenarios fit tiles into it).
    send({ type: 'debug', action: 'report', delay: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const report = logsOf(posted).find((l) => l.startsWith('compare report '));
    const r = $('stage').getBoundingClientRect();
    assert.ok(report && report.includes(` stage=${Math.floor(r.width)}x${Math.floor(r.height)} `), `stage in the report: ${report}`);
    assert.ok(report.includes(' scan=found:42'), 'the report shows the scan result');
    assert.strictEqual(made.length, 2);
  }, {
    cfg: { debug: true }, createPlayer: timed, raf: true,
    extraWidgets: { VpeCompareDebug, VpeCompareMetrics, VpeCompareCompositor: { glProgram() {}, glTexture() {} } },
  });
});

test('debug cellGroups: cells in layout order (a lifted tile where it is dragged), Split Wipe\'s halves as one cell', () => {
  const { cellGroups } = require('../../media/compare-debug');
  const dom = createDom('<div id="cells"></div>');
  const cell = (clip, left, top, more = {}) => {
    const d = dom.doc.createElement('div');
    d.setAttribute('class', more.cls || 'cell');
    d.dataset.clip = clip;
    if (more.role) d.dataset.role = more.role;
    Object.assign(d.style, { left: `${left}px`, top: `${top}px`, ...(more.style || {}) });
    dom.$('cells').appendChild(d);
    return d;
  };
  // Made A, B, C, D; shown (after a reorder) C A / B D, the add cell last.
  cell('A', 340, 0); cell('B', 0, 185); cell('C', 0, 0); cell('D', 340, 185.4); cell('+', 680, 185, { cls: 'cell add' });
  const ids = (gs) => gs.map((g) => g.map((d) => d.dataset.clip).join('+'));
  assert.deepStrictEqual(ids(cellGroups(dom.$('cells').children)), ['C', 'A', 'B', 'D', '+']);
  // Dragging A (340, 0) over C's place: it counts there, before C (equal place: the one made first).
  dom.$('cells').children[0].style.zIndex = '5';
  dom.$('cells').children[0].style.transform = 'translate(-340px, 0px)';
  assert.deepStrictEqual(ids(cellGroups(dom.$('cells').children)), ['A', 'C', 'B', 'D', '+']);
  // A glide's transform (no lift) does not count: the layout's place does.
  dom.$('cells').children[0].style.zIndex = '';
  assert.deepStrictEqual(ids(cellGroups(dom.$('cells').children)), ['C', 'A', 'B', 'D', '+']);
  const split = createDom('<div id="cells"></div>');
  for (const [clip, role] of [['B', 'split-b'], ['A', 'split-a']]) {
    const d = split.doc.createElement('div');
    d.setAttribute('class', 'cell split');
    d.dataset.clip = clip;
    d.dataset.role = role;
    split.$('cells').appendChild(d);
  }
  assert.deepStrictEqual(ids(cellGroups(split.$('cells').children)), ['A+B'], 'one cell, the left half first');
  assert.deepStrictEqual(cellGroups([]), []);
});

testAsync('debug hooks in Compare: cells as shown, Swap in the report, Split as one cell, divider drag, − / + under the pointer', async () => {
  const VpeCompareDebug = require('../../media/compare-debug');
  const { FakeEvent } = require('./fake-dom');
  class PointerEvent extends FakeEvent {}
  class KeyboardEvent extends FakeEvent {}
  const reportable = (clip, host, hooks) => Object.assign(stubPlayer(clip, host, hooks), {
    shownCount: 1, shownT: 0, startT: 0, pauseT: 0, fps: 25, cv: { width: 1280, height: 720 }, cfg: { native: false }, info: {},
    rel(t) { return t; }, shownMarkTime() { return this.frame / 25; }, currentTime() { return this.frame / 25; },
  });
  const saved = Object.fromEntries(['PointerEvent', 'KeyboardEvent', 'getComputedStyle'].map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
  try {
    await withPage(async ({ win, app, send, posted, $, setRect }) => {
      win.PointerEvent = PointerEvent;
      Object.assign(global, { PointerEvent, KeyboardEvent, getComputedStyle: (e) => e.style });
      setRect($('cells'), { width: 680, height: 370 });
      /** The fake DOM has no layout: each cell's box is where the layout put it (style left / top / size). */
      const layout = () => {
        app.ui.render();
        for (const d of $('cells').children) {
          const n = (k) => parseFloat(d.style[k]) || 0;
          setRect(d, { left: n('left'), top: n('top'), width: n('width'), height: n('height') });
        }
        const dv = $('divider');
        setRect(dv, { left: parseFloat(dv.style.left) || 0, top: 0, width: 8, height: 370 });
      };
      const wait = () => new Promise((r) => setTimeout(r, 5));
      const kv = (line) => Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
      const report = async () => {
        send({ type: 'debug', action: 'report', delay: 1 });
        await wait();
        return kv(logsOf(posted).filter((l) => l.startsWith('compare report ')).pop());
      };
      let uiId = 0;
      const uiState = async () => {
        const id = ++uiId;
        send({ type: 'debug', action: 'ui', id, delay: 1 });
        await wait();
        const line = logsOf(posted).find((l) => l.startsWith(`compare ui {"id":${id},`));
        assert.ok(line, `ui ${id} answered: ${logsOf(posted).slice(-3)}`);
        return JSON.parse(line.slice('compare ui '.length));
      };
      const tab = () => S.getTab(app.ui.getState());
      const dbg = (m) => { send({ type: 'debug', ...m }); layout(); };

      send({ type: 'open' });
      send({ type: 'openVideo', clipId: 'B', compare: true, clip: CLIPS[1] });
      layout();
      let u = await uiState();
      assert.deepStrictEqual(u.cells.map((c) => c.enlarge), ['Enlarge tile', 'Enlarge tile'], 'the grid: Enlarge on each tile');
      assert.match(u.cells[0].pills[0], /Aa\.mp4/);
      assert.strictEqual((await report()).swap, 'false');

      // X swaps: B shows first (as A) and the report says so; the cells are listed as shown, not as made.
      dbg({ action: 'key', key: 'x' });
      assert.deepStrictEqual(tab().tiles, ['B', 'A']);
      assert.strictEqual((await report()).swap, 'true');
      u = await uiState();
      assert.ok(/Ab\.mp4/.test(u.cells[0].pills[0]) && /Ba\.mp4/.test(u.cells[1].pills[0]), `after Swap: ${JSON.stringify(u.cells.map((c) => c.pills))}`);

      // Spotlight: the main tile first, its button goes back to the grid.
      dbg({ action: 'mode', mode: 'spotlight' });
      u = await uiState();
      assert.deepStrictEqual(u.cells.map((c) => c.enlarge), ['Back to grid', 'Enlarge tile']);

      // Split Wipe: one cell with both pills, the divider is the stage's (#divider), dragged to 25 %.
      dbg({ action: 'mode', mode: 'split' });
      let r = await report();
      assert.deepStrictEqual([r.mode, r.cells, r.divider], ['split', '1', 'true']);
      u = await uiState();
      assert.strictEqual(u.cells.length, 1);
      assert.strictEqual(u.cells[0].pills.length, 2, `both pills: ${JSON.stringify(u.cells[0].pills)}`);
      assert.match(u.cells[0].pills[0], /Ab\.mp4/, 'the left pill first');
      assert.strictEqual(u.divider && u.divider.value, '50');
      dbg({ action: 'drag', x: 0.25 });
      r = await report();
      assert.ok(Math.abs(Number(r.split) - 0.25) < 0.01, `divider dragged to 25 %: split=${r.split}`);
      u = await uiState();
      assert.strictEqual(u.divider.value, '25', 'the divider says 25 %');

      // − / + nudge the tile under the pointer (the hover hook moves the pointer there), in the grid and in Split.
      dbg({ action: 'hover', tile: 1 });
      dbg({ action: 'key', key: '+' });
      assert.deepStrictEqual([S.getOffset(tab(), 'A').v, S.getOffset(tab(), 'B').v], [1, 0], 'Split: + on the right half (A)');
      dbg({ action: 'mode', mode: 'grid' });
      dbg({ action: 'hover', tile: 0 });
      dbg({ action: 'key', key: '+' });
      assert.deepStrictEqual([S.getOffset(tab(), 'A').v, S.getOffset(tab(), 'B').v], [1, 1], '+ on the first tile (B)');
      dbg({ action: 'hover', tile: 1 });
      dbg({ action: 'key', key: '-' });
      assert.deepStrictEqual([S.getOffset(tab(), 'A').v, S.getOffset(tab(), 'B').v], [0, 1], '− on the second tile (A)');
      dbg({ action: 'hover', tile: null });
      assert.strictEqual(app.ui.parts.hover.current(), null, 'the pointer left the tiles');
    }, { cfg: { debug: true }, createPlayer: reportable, extraWidgets: { VpeCompareDebug } });
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  }
});

(async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); count++; } catch (e) { e.message = `${name}: ${e.message}`; console.error(e); process.exit(1); }
  }
  console.log(`player_unified_test: ${count} ok (${Date.now() - T0} ms)`);
})();
