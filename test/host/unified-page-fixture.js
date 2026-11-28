'use strict';

const S = require('../../media/player-state');
const PUI = require('../../media/player-ui');
const EngineAdapter = require('../../media/player-engine-adapter');
const HostAdapter = require('../../media/player-host-adapter');
const U = require('../../media/player-unified');
const { unifiedHtml } = require('../../src/unified-html');
const { createDom, Element: FakeElement, Node: FakeNode } = require('./fake-dom');

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
  defaultFactory = false, extraWidgets = {}, createEngine,
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
  if (createEngine) dom.win.createEngine = createEngine;
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

module.exports = { withPage, withGlobals, widgets, stubPlayer, CLIPS };
