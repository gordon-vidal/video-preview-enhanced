// @ts-check
'use strict';
// The unified page's entry script (docs/notes/player-ui-controller.md, "Production wiring"): the one browser
// script src/unified-html.js loads last (`entryScript`). It owns only what no shared module owns: the decoder per clip
// (a Map clipId -> player), the routing of the host's decoder messages to the right one, and the link between the
// decoder clock and the controller. Every bit of UI behaviour goes through VpePlayerUi.create() (media/player-ui.js)
// over the production adapters (media/player-engine-adapter.js, media/player-host-adapter.js), so the page itself has
// no bar, key or stage wiring of its own. One page for 1 to N videos: body.compare (media/compare.css) follows the
// active tab's tile count.
//
//   VpeUnified.boot({ doc, win, vscode, cfg, createPlayer, compositor, sync, widgets })   // all optional in a webview
//
// Auto-boots in a webview (a window, #cfg and acquireVsCodeApi); Node tests (test/host/player_unified_test.js) call
// boot() with the fake DOM, a stub vscode and a stub createPlayer.
(function (root) {
  // checkJs: start
  /**
   * The shared contracts (media/unified-contracts.d.ts): the adapters, the controller and both message unions.
   * @typedef {import('./unified-contracts').EngineAdapter} EngineAdapter
   * @typedef {import('./unified-contracts').HostAdapter} HostAdapter
   * @typedef {import('./unified-contracts').UnifiedControllerApi} UnifiedControllerApi
   * @typedef {import('./unified-contracts').HostToPageMessage} HostToPageMessage
   * @typedef {import('./unified-contracts').TransportCommand} TransportCommand
   * @typedef {import('./unified-contracts').ClipSpec & { [k: string]: any }} ClipSpec
   * @typedef {{ onFrame: (frame: number) => void, onReady: () => void, onMeta: () => void,
   *   onEnded: (info?: { natural?: boolean }) => void, post: (m: any) => void, log: (...a: any[]) => void,
   *   wake: () => void, showMessage: (msg?: string, hint?: string) => void,
   *   toast: (text: string, ms?: number) => void, getRate: () => number, getLoop: () => boolean,
   *   getMuted: () => boolean, getVolume: () => number }} PlayerHooks
   *   getRate / getLoop / getMuted / getVolume: the page's live settings for a decoder that reads them on demand
   *   (media/frame-player.js); getMuted is true for every clip but the sound source.
   * @typedef {(clip: ClipSpec, host: any, hooks: PlayerHooks) => any} CreatePlayer
   * @typedef {{ doc?: any, win?: any, vscode?: any, cfg?: any, createPlayer?: CreatePlayer | null, compositor?: any,
   *   sync?: any, widgets?: any, stateApi?: any, engineApi?: any, hostApi?: any, uiApi?: any, log?: (...a: any[]) => void }} BootEnv
   */

  /**
   * Host -> page messages only a decoder reads, and the player method each one goes to (media/player.js and
   * media/compare.js route the same ones). The target is the message's clipId (or Compare's `key`); with one video an
   * untagged message goes to it.
   * @type {Record<string, (p: any, m: any) => void>}
   */
  const DECODER_ROUTES = {
    block: (p, m) => { if (typeof p.onBlock === 'function') p.onBlock(m.pos, m.data, m.error); },
    resize: (p, m) => {
      if (typeof p.onResize === 'function') p.onResize(m);
      else if (typeof p.refreshNativeFrame === 'function') p.refreshNativeFrame(false);
    },
    nd: (p, m) => {
      if (typeof p.onNd === 'function') { p.onNd(m.m); return; }
      // Compare's native tiles learn their decoded size this way (media/compare.js 'nd').
      if (m.m && m.m.type === 'size' && p.info && p.info.video && typeof p.updateNativeSize === 'function') {
        Object.assign(p.info.video, { width: m.m.width, height: m.m.height });
        p.updateNativeSize();
      } else if (typeof p.onWorker === 'function') p.onWorker(m.m);
    },
    ndv: (p, m) => { if (typeof p.onNativeVideo === 'function') p.onNativeVideo(m); },
    nda: (p, m) => { if (typeof p.onNativeAudio === 'function') p.onNativeAudio(m); },
    thumb: (p, m) => { if (typeof p.onHostThumb === 'function') p.onHostThumb(m); },
    exactFrame: (p, m) => { if (typeof p.onExactFrame === 'function') p.onExactFrame(m); },
    stream: (p, m) => { if (typeof p.onStream === 'function') p.onStream(m); },
  };
  /** The decoder message types, each one a HostToPageMessage type (tools/unified-contracts-check.js). */
  const DECODER_TYPES = /** @type {Array<'block' | 'resize' | 'nd' | 'ndv' | 'nda' | 'thumb' | 'exactFrame' | 'stream'>} */ (
    Object.keys(DECODER_ROUTES));

  /** The clip a decoder message is for: clipId, else `key` (what the default factory tags a decoder's posts with). @param {any} m */
  const keyOf = (m) => (typeof m.clipId === 'string' ? m.clipId : typeof m.key === 'string' ? m.key : null);

  /**
   * The page's clips from its config: `clips` (unified host), else one clip from clipId / name (single player).
   * @param {any} cfg @returns {ClipSpec[]}
   */
  function clipsOf(cfg) {
    const c = cfg || {};
    if (Array.isArray(c.clips) && c.clips.length) {
      return c.clips.filter((/** @type {any} */ x) => x && typeof x.id === 'string').map((/** @type {any} */ x) => ({ ...x }));
    }
    return [{ id: typeof c.clipId === 'string' ? c.clipId : 'A', name: typeof c.name === 'string' ? c.name : 'Video' }];
  }

  /** The page-safe clip descriptor fields the host may send (src/unified-session.js), besides the clip's id. */
  const CLIP_FIELDS = ['name', 'size', 'duration', 'fps', 'frames', 'width', 'height', 'hasAudio', 'native', 'codec',
    'kind', 'rotation', 'transcoded'];

  /**
   * Host -> page messages about a clip's decoder as a whole (media/player.js and media/compare.js read them too), handled
   * by the page rather than by a decoder method: 'frames' starts a frame player (MJPEG AVI, image sequences) with its
   * meta and the sound sent ahead in 'wavPart's, 'frame' is one of its pictures, 'libav' restarts the built-in
   * decoder with the host's meta, 'originalTile' leaves Live transcode for the built-in decoder. Not in DECODER_TYPES:
   * media/unified-contracts.d.ts does not list them yet (tools/unified-contracts-check.js).
   */
  const LIFECYCLE_TYPES = ['frames', 'frame', 'wavPart', 'libav', 'originalTile'];

  /**
   * The clip descriptor a host message carries: its `clip` object, else the descriptor fields on the message (or
   * sessionState entry) itself. Never its id (the message's clipId / newId names the clip).
   * @param {any} m @returns {Record<string, any>}
   */
  function descriptorOf(m) {
    if (!m || typeof m !== 'object') return {};
    /** @type {Record<string, any>} */
    const out = {};
    const src = m.clip && typeof m.clip === 'object' ? m.clip : m;
    for (const k of src === m ? CLIP_FIELDS : Object.keys(src)) if (src[k] !== undefined && k !== 'id') out[k] = src[k];
    return out;
  }

  /** The positive numbers of a decoder's meta a clip spec keeps (fps, frames, width, height, duration). @param {any} meta */
  function numbersOf(meta) {
    /** @type {Record<string, number>} */
    const out = {};
    if (!meta || typeof meta !== 'object') return out;
    for (const k of ['fps', 'frames', 'width', 'height', 'duration']) if (Number(meta[k]) > 0) out[k] = Number(meta[k]);
    return out;
  }

  /** #cfg's JSON, or {} if the page has none or it does not parse. @param {any} doc */
  function readCfg(doc) {
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('cfg') : null;
    if (!el) return {};
    try { const v = JSON.parse(el.textContent || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }

  /**
   * A clip played as separate pictures (media/frame-player.js): an image sequence, or the host's 'frames' meta.
   * @param {any} clip @param {any} cfg
   */
  const isSequence = (clip, cfg) => !!(clip && (clip.frameMeta || clip.kind === 'sequence')) || !!(cfg && cfg.sequence);

  /**
   * The production decoder factory over media/engine.js (the page global createEngine), as media/compare.js
   * makeEngine builds a tile: one LibavPlayer per clip, its host messages tagged with the clip; an image sequence (or
   * a clip the host sent 'frames' for) gets a FramePlayer (media/frame-player.js, VpeFramePlayer) instead, as
   * media/player.js does. A LibavPlayer opens with the host's 'libav' meta when the clip carries it (`meta`). A
   * sequence whose length is not known yet makes no decoder: the host's 'frames' brings it. null when the page has
   * neither decoder (Node, or a page without engine.js).
   * @param {any} G the page's globals @param {any} win @param {any} doc @param {any} vscode @param {any} cfg
   * @param {any} [framesApi] media/frame-player.js (VpeFramePlayer)
   * @returns {CreatePlayer | null}
   */
  function defaultCreatePlayer(G, win, doc, vscode, cfg, framesApi) {
    const createEngine = (win && win.createEngine) || (G && G.createEngine);
    const FP = framesApi && typeof framesApi.createFramePlayer === 'function' ? framesApi : null;
    const d = doc || (G && G.document);
    if ((typeof createEngine !== 'function' && !FP) || !d) return null;
    return (clip, _host, hooks) => {
      const cv = d.createElement('canvas');
      const envTag = {
        ...(cfg.page !== undefined ? { page: cfg.page } : {}),
        ...(cfg.boot !== undefined ? { boot: cfg.boot } : {}),
        key: clip.id, clipId: clip.id,
      };
      // Decoder traffic (blocks, native frames, picture requests) is not the controller's: straight to the host, tagged.
      const tagged = { postMessage: (/** @type {any} */ m) => vscode.postMessage({ ...m, ...envTag }), getState: () => ({}), setState() {} };
      if (FP && isSequence(clip, cfg)) {
        const fps = Number(clip.fps) || 0;
        const frames = Number(clip.frames) || 0;
        const meta = clip.frameMeta || (fps > 0 && frames > 0
          ? { frames, fps, ...(clip.width ? { width: clip.width, height: clip.height } : {}) } : null);
        if (!meta) return null;
        const FramePlayer = FP.createFramePlayer({
          canvas: cv, vscode: tagged, log: hooks.log,
          showMessage: (/** @type {any} */ text) => hooks.showMessage(text),
          // The bar owns mute: a refused autoplay with sound plays on muted, the bar is not changed from here.
          setMute: () => {},
          getRate: () => hooks.getRate(), getLoop: () => hooks.getLoop(),
          getMuted: () => hooks.getMuted(), getVolume: () => hooks.getVolume(),
          onEnded: (/** @type {any} */ _p, /** @type {any} */ info) => hooks.onEnded(info),
        });
        const fp = /** @type {any} */ (new FramePlayer(meta, clip.wav));
        fp.cv = cv;
        fp.key = clip.id;
        fp.cfg = { native: false };
        return fp;
      }
      if (typeof createEngine !== 'function') return null;
      const eng = createEngine({
        page: cfg.page, debug: !!cfg.debug, canvas: cv,
        vscode: tagged,
        log: hooks.log,
        showMessage: (/** @type {any} */ msg, /** @type {any} */ hint) => hooks.showMessage(msg, hint),
        toast: (/** @type {any} */ text, /** @type {any} */ ms) => hooks.toast(text, ms),
        getState: () => ({}), setMuteUi: () => {},
        // The decoder's wake (a worker message, a decoded frame) runs the page's shared tick loop.
        onReady: () => hooks.onReady(), onMeta: () => hooks.onMeta(), wake: () => hooks.wake(),
        onEnded: (/** @type {any} */ _p, /** @type {any} */ info) => hooks.onEnded(info),
      });
      const meta = clip.meta && typeof clip.meta === 'object' ? clip.meta
        : { size: clip.size || 0, duration: clip.duration || 0, label: clip.name || '', native: !!clip.native };
      const p = new eng.LibavPlayer(meta, { ...(cfg.engine || {}), rotation: Number(clip.rotation) || 0 });
      p.cv = cv;
      p.key = clip.id;
      return p;
    };
  }

  /**
   * The clip ids src/unified-session.js lists in a 'sessionState' (display order first, then its other clips), each once.
   * @param {any} m @returns {string[]}
   */
  function sessionIds(m) {
    /** @type {string[]} */
    const ids = [];
    const clips = Array.isArray(m && m.clips) ? m.clips : [];
    const known = new Set(clips.map((/** @type {any} */ c) => (c && typeof c === 'object' ? c.clipId || c.id : c))
      .filter((/** @type {any} */ id) => typeof id === 'string'));
    for (const id of Array.isArray(m && m.order) ? m.order : []) if (known.has(id) && !ids.includes(id)) ids.push(id);
    for (const id of known) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  /**
   * The workspace state after the host's 'sessionState': the active tab shows exactly `ids` in that order, with the
   * host's capture and limit. Pure, in player-state steps (offsets, clock and Spotlight follow their clips); returns
   * `ws` itself when the page already matches, so a page that booted with the host's clips changes nothing.
   * @param {any} S media/player-state.js @param {any} ws @param {string[]} ids
   * @param {{ capture?: boolean, maxVideos?: number }} [o]
   */
  function applySessionState(S, ws, ids, o = {}) {
    if (!ids.length) return ws;
    let next = ws;
    const t0 = S.getTab(next);
    const max = o.maxVideos;
    if (typeof max === 'number' && Number.isInteger(max) && max >= Math.max(2, ids.length) && t0.maxVideos !== max) {
      next = { ...next, tabs: next.tabs.map((/** @type {any} */ t) => (t.id === t0.id ? { ...t, maxVideos: max } : t)) };
    }
    const capture0 = S.getTab(next).capture;
    // Added first (a tab never shows no video), with capture on so openVideo joins this tab.
    for (const id of ids) {
      if (S.getTab(next).tiles.includes(id)) continue;
      if (!S.getTab(next).capture) next = S.toggleCapture(next).state;
      next = S.openVideo(next, id).state;
    }
    for (const id of S.getTab(next).tiles.slice()) if (!ids.includes(id)) next = S.removeTile(next, id).state;
    ids.forEach((id, i) => {
      const from = S.getTab(next).tiles.indexOf(id);
      if (from >= 0 && from !== i) next = S.moveTile(next, from, i);
    });
    const capture = typeof o.capture === 'boolean' ? o.capture : capture0;
    if (S.getTab(next).capture !== capture) next = S.toggleCapture(next).state;
    const a = S.getTab(ws), b = S.getTab(next);
    const same = a.tiles.join('\n') === b.tiles.join('\n') && a.capture === b.capture && a.maxVideos === b.maxVideos;
    return same ? ws : next;
  }

  /**
   * A transport command from the controller (VpePlayerUi.create's onTransport) as { type, value }. Takes
   * ({ type | kind | op, frame | rate | loop | on | value }) or (type, value).
   * @param {any} a @param {any} [b] @returns {{ type: string, value: any } | null}
   */
  function transportOf(a, b) {
    if (typeof a === 'string') return { type: a, value: b };
    if (!a || typeof a !== 'object') return null;
    const type = a.type || a.kind || a.op;
    if (typeof type !== 'string') return null;
    const value = a.frame !== undefined ? a.frame : a.rate !== undefined ? a.rate : a.loop !== undefined ? a.loop
      : a.on !== undefined ? a.on : a.value;
    return { type, value };
  }

  /** @param {BootEnv} [env] */
  function boot(env = {}) {
    const G = /** @type {any} */ (globalThis);
    const win = env.win || G.window;
    const doc = env.doc || (win && win.document);
    if (!doc) throw new Error('VpeUnified.boot: a document is required');
    const vscode = env.vscode || (typeof G.acquireVsCodeApi === 'function' ? G.acquireVsCodeApi() : null);
    if (!vscode) throw new Error('VpeUnified.boot: the webview API (vscode) is required');
    const cfg = env.cfg || readCfg(doc);
    const S = env.stateApi || G.VpePlayerState;
    const EngineApi = env.engineApi || G.VpeEngineAdapter;
    const HostApi = env.hostApi || G.VpeHostAdapter;
    const UiApi = env.uiApi || G.VpePlayerUi;
    for (const [name, v] of [['VpePlayerState', S], ['VpeEngineAdapter', EngineApi], ['VpeHostAdapter', HostApi], ['VpePlayerUi', UiApi]]) {
      if (!v) throw new Error(`VpeUnified.boot: ${name} is missing`);
    }
    const widgets = env.widgets || {};
    const W = (/** @type {string} */ k) => widgets[k] || (win && win[k]) || G[k];

    /** @type {HostAdapter & { slots: () => string[] }} */
    const host = HostApi.create({ vscode, win, page: cfg.page, boot: cfg.boot, surface: cfg.surface || 'unified' });
    // The page's log goes to the host's output channel as "webview: ..." (src/unified-viewer.js), as media/player.js
    // posts it: the layer-3 scenarios wait for lines such as "webview: first frame shown".
    const log = env.log || ((/** @type {any[]} */ ...a) => host.post({ type: 'log', msg: a.map(String).join(' ') }));
    const createPlayer = env.createPlayer !== undefined ? env.createPlayer
      : defaultCreatePlayer(G, win, doc, vscode, cfg, W('VpeFramePlayer'));
    const { compositor = null, sync = null } = env;

    // ---- clips and their decoders ----
    /** @type {Map<string, ClipSpec>} */
    const specs = new Map(clipsOf(cfg).map((c) => [c.id, c]));
    /** @type {Map<string, any>} */
    const players = new Map();
    let disposed = false;
    let opened = false;

    /**
     * An adapter with registerClip / unregisterClip learns clips in place; one without them reads its clips once, so
     * it is rebuilt when a clip arrives. Either way the controller keeps the facade below.
     */
    /** The host's 'stream' report per clip (URL / HLS: the variants of the Quality page). @type {Map<string, any>} */
    const streams = new Map();
    /** media/exactframe.js controllers per clip, made on the first exact-frame request. @type {Map<string, any>} */
    const exacts = new Map();
    /**
     * The exact picture of the clip's shown frame from the host (Live transcode, lossy native), as media/player.js
     * asks for it: null when VpeExact is missing or the shown picture is exact already.
     * @param {string} id @param {any} p
     */
    function grabExact(id, p) {
      const X = W('VpeExact');
      if (!X || disposed || !p || !X.available(p, cfg)) return null;
      let ex = exacts.get(id);
      if (!ex) {
        ex = X.create({
          page: cfg.page, toast, log: (/** @type {string} */ s) => log(s),
          // The reply names the clip, so it reaches this controller (routeDecoder).
          post: (/** @type {any} */ m) => host.post({ ...m, clipId: id }),
          onFail: (/** @type {any} */ _k, /** @type {any} */ error) => toast(X.failureText(players.get(id), error), 4500),
        });
        exacts.set(id, ex);
      }
      return ex.grab(`${p.gen}|${p.currentFrame()}|${p.shownCount || 0}`, X.shownTime(p));
    }
    const makeAdapter = () => EngineApi.create({
      clips: [...specs.values()], getPlayer: (/** @type {string} */ id) => players.get(id) || null, compositor,
      pictureApi: W('VpePicture'), controlsApi: W('VpeControls'), doc,
      streamInfo: (/** @type {string} */ id) => streams.get(id) || null,
      grabExact: (/** @type {string} */ id, /** @type {any} */ p) => grabExact(id, p),
    });
    /** @type {EngineAdapter} */
    let adapter = makeAdapter();
    const live = () => typeof adapter.registerClip === 'function' && typeof adapter.unregisterClip === 'function';
    /** Clip ids the adapter knows (the config's from create, then each registerClip). */
    const registered = new Set(specs.keys());
    /** @param {ClipSpec} spec */
    function learnClip(spec) {
      if (!live()) { adapter = makeAdapter(); return; }
      try {
        adapter.registerClip(spec);
        registered.add(spec.id);
      } catch (err) { log(`registerClip ${spec.id}: ${err && /** @type {any} */ (err).message || err}`); }
    }
    /** No tab shows the clip any more: the adapter forgets it (a rebuilt adapter keeps its spec instead). @param {string} id */
    function forgetClip(id) {
      if (!live() || !registered.has(id)) return;
      registered.delete(id);
      specs.delete(id);
      openWith.delete(id);
      streams.delete(id);
      try { adapter.unregisterClip(id); } catch { /* already gone */ }
    }
    /** @type {any} */
    const engine = new Proxy({}, {
      get: (_t, k) => {
        const v = adapter[/** @type {any} */ (k)];
        return typeof v === 'function' ? v.bind(adapter) : v;
      },
      has: (_t, k) => k in adapter,
    });

    /** A clip the host named: known from now on (its name and numbers win over the decoder's). @param {any} m */
    function addSpec(m) {
      const id = m.clipId;
      if (typeof id !== 'string') return;
      const prev = specs.get(id);
      // The full descriptor (size, native, fps ...): a decoder made from a bare { id, name } would boot at size 0.
      const next = { ...(prev || {}), ...descriptorOf(m), id };
      if (typeof m.label === 'string' && !next.name) next.name = m.label;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next) || (live() && !registered.has(id))) {
        specs.set(id, next);
        learnClip(next);
      }
    }

    /** Last rate / loop sent via onTransport (null until first set; falls back to controller prefs). */
    let currentRate = /** @type {number | null} */ (null);
    let currentLoop = /** @type {boolean | null} */ (null);
    /**
     * Initialize a newly created/replaced decoder with the controller's active playback rate and loop policy before
     * playback starts (engine.js defaults to 1x and loop=true).
     * @param {any} p
     */
    function applyRateAndLoop(p) {
      if (!p) return;
      const prefs = ui && typeof ui.getPrefs === 'function' ? ui.getPrefs() : null;
      const rate = currentRate !== null ? currentRate : (prefs && Number(prefs.rate) > 0 ? Number(prefs.rate) : 1);
      const loop = currentLoop !== null ? currentLoop : !!(prefs && prefs.loop);
      try {
        if (rate > 0 && typeof p.setRate === 'function') p.setRate(rate);
        if (typeof p.setLoop === 'function') p.setLoop(loop);
        else p.loop = loop;
      } catch (err) { log(`decoder init rate/loop: ${err && /** @type {any} */ (err).message || err}`); }
    }

    /** What the decoder of a clip opens with (the host's 'frames' / 'libav' meta and the sound sent ahead). @type {Map<string, any>} */
    const openWith = new Map();
    /** The prefs the controller has now (null before it exists). */
    const prefsNow = () => (ui && typeof ui.getPrefs === 'function' ? ui.getPrefs() || null : null);
    /** Loop on in the controller's prefs: its end policy (onEnd 'loop'); a bare `loop` flag where there is none. */
    const loopPref = (/** @type {any} */ pr) => !!pr && (pr.onEnd !== undefined ? pr.onEnd === 'loop' : !!pr.loop);
    /** The decoder for `id`, made on first need (after 'open': the host serves blocks from then on). @param {string} id */
    function ensurePlayer(id) {
      if (players.has(id) || !opened || disposed || typeof createPlayer !== 'function') return players.get(id) || null;
      const spec = specs.get(id) || { id };
      /** @type {PlayerHooks} */
      const hooks = {
        onFrame: (f) => { onPlayerFrame(id, f); markReady(); notePresented(id, f); },
        onReady: () => { markReady(); if (ui) ui.render(); scheduleTick(); },
        onMeta: () => onPlayerMeta(id),
        onEnded: (info) => onPlayerEnded(id, info),
        post: (m) => { if (!disposed) host.post(m); },
        log: (...a) => decoderLog(id, a),
        wake: () => scheduleTick(),
        showMessage: (msg, hint) => showDecoderMessage(id, msg, hint),
        toast: (text, ms) => toast(text, ms),
        getRate: () => {
          const pr = prefsNow();
          return currentRate !== null ? currentRate : pr && Number(pr.rate) > 0 ? Number(pr.rate) : 1;
        },
        getLoop: () => (currentLoop !== null ? currentLoop : !!(prefsNow() || {}).loop),
        getMuted: () => {
          const s = typeof /** @type {any} */ (adapter).sound === 'function' ? /** @type {any} */ (adapter).sound() : null;
          return s ? s.soundSource !== id || !!s.muted : !!(prefsNow() || {}).muted;
        },
        getVolume: () => {
          const s = typeof /** @type {any} */ (adapter).sound === 'function' ? /** @type {any} */ (adapter).sound() : null;
          const v = s ? Number(s.volume) : Number((prefsNow() || {}).volume);
          return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
        },
      };
      try {
        // Kept (not taken once): a clip closed and opened again, or restarted, opens with the host's meta again.
        const p = createPlayer({ ...spec, ...(openWith.get(id) || {}) }, host, hooks);
        if (p) {
          players.set(id, p);
          applyRateAndLoop(p);
        }
        if (p && isReady(p)) markReady();
        return p || null;
      } catch (err) {
        const msg = err && /** @type {any} */ (err).message || String(err);
        log(`decoder could not start for ${id}: ${msg}`);
        showDecoderMessage(id, 'The decoder failed to start.', msg);
        return null;
      }
    }

    // ---- the decoders' own messages and the "Opening…" overlay ----
    /** True once a decoder has opened its file (media/engine.js: firstShown / info; a test stub: ready). @param {any} p */
    const isReady = (p) => !!(p && (p.ready === true || p.firstShown === true));
    /** The opening overlay waits for the first decoder to be ready; false once one was (or with no decoders). */
    let opening = true;
    /** The clip whose decoder message the overlay shows now (null: the opening status, or nothing). */
    let overlayClip = /** @type {string | null} */ (null);
    const overlayEl = () => doc.getElementById('overlay');
    const overlayPart = () => (ui && ui.parts && ui.parts.overlay) || null;
    function hideOverlay() {
      const o = overlayPart();
      if (o) o.hide();
      const el = overlayEl();
      if (el) el.hidden = true;
    }
    /** A decoder is ready (or showed its first frame): the opening overlay goes, a decoder's error stays. */
    function markReady() {
      if (!opening || !opened || disposed) return;
      opening = false;
      if (overlayClip === null) hideOverlay();
    }
    /**
     * media/engine.js showMessage(msg, hint): a decoder's error on the overlay ('' takes its own message away again).
     * With several videos the overlay names the clip it is about.
     * @param {string} id @param {any} msg @param {any} [hint]
     */
    function showDecoderMessage(id, msg, hint) {
      if (disposed) return;
      const text = String(msg || '');
      if (!text) {
        if (overlayClip !== id) return;
        overlayClip = null;
        if (!opening) hideOverlay();
        return;
      }
      overlayClip = id;
      const many = ui ? S.getTab(ui.getState()).tiles.length >= 2 : specs.size >= 2;
      const name = (specs.get(id) || {}).name || id;
      const message = many ? `${name}: ${text}` : text;
      const o = overlayPart();
      if (o) o.showError({ message, hint: hint ? String(hint) : '' });
      else {
        const el = overlayEl();
        if (el) { el.textContent = message; el.hidden = false; }
      }
    }
    /** A toast on the controller (a decoder's, a notice of the host's). @param {any} text @param {any} [ms] */
    function toast(text, ms) {
      if (!disposed && ui && text) ui.onHostMessage({ type: 'toast', text: String(text), ...(Number(ms) > 0 ? { ms: Number(ms) } : {}) });
    }

    // ---- the start-up lines the layer-3 scenarios wait for (test/vscode/cases/startup.js and others) ----
    let firstFrameLogged = false;
    let firstPicturesLogged = false;
    /**
     * A decoder's log line: as it is with one decoder (media/player.js: "first frame shown at ..."), with the clip's
     * id in front once several decode.
     * @param {string} id @param {any[]} a
     */
    function decoderLog(id, a) {
      const line = a.map(String).join(' ');
      // media/engine.js says it itself: the page does not say it again (notePresented).
      if (/^first frame shown/.test(line)) firstFrameLogged = true;
      log(players.size >= 2 ? `[${id}] ${line}` : line);
    }
    /** The decoder has a picture on screen (engine.js firstShown, frame-player.js shown, or a counted picture). @param {any} p */
    const presented = (p) => !!p && (p.firstShown === true || (typeof p.shown === 'number' && p.shown >= 0)
      || Number(p.shownCount) > 0);
    /**
     * A decoder presented a picture: the page says "first frame shown" once (for a decoder that does not say it
     * itself), and "first pictures shown" once every tile of a 2+ tab has one (media/compare.js).
     * @param {string} id @param {number} [frame] the frame a decoder's onFrame reported
     */
    function notePresented(id, frame) {
      if (disposed || !ui) return;
      const p = players.get(id);
      if (!firstFrameLogged && (frame !== undefined || presented(p))) {
        firstFrameLogged = true;
        let t = NaN;
        try { t = p && typeof p.currentTime === 'function' ? Number(p.currentTime()) : NaN; } catch { /* closing */ }
        if (!Number.isFinite(t)) {
          const c = engine.getClip(id);
          const f = frame !== undefined ? frame : p && typeof p.currentFrame === 'function' ? Number(p.currentFrame()) : 0;
          t = c && c.fps > 0 ? (Number(f) || 0) / c.fps : 0;
        }
        log(`first frame shown at ${t.toFixed(3)} s`);
      }
      const t = S.getTab(ui.getState());
      if (!firstPicturesLogged && t.tiles.length >= 2 && t.tiles.every((/** @type {string} */ x) => presented(players.get(x)))) {
        firstPicturesLogged = true;
        log('first pictures shown');
      }
    }

    /**
     * The decoder learned its numbers (fps, length, size): the adapter's spec takes the ones the host did not give,
     * and the clock's fps and length follow at once, even when the clock tile did not change.
     * @param {string} id
     */
    function onPlayerMeta(id) {
      if (disposed) return;
      const p = players.get(id);
      const spec = specs.get(id);
      if (!live()) adapter = makeAdapter();
      else if (p && spec) {
        const meta = p.meta || {};
        const video = (p.info && p.info.video) || {};
        /** @type {Record<string, any>} */
        const learnt = {
          fps: Number(p.fps) > 0 ? Number(p.fps) : meta.fps, frames: Number(p.n) > 0 ? Number(p.n) : meta.frames,
          duration: meta.duration, width: video.sourceWidth || video.width, height: video.sourceHeight || video.height,
          size: meta.size,
        };
        const next = { ...spec };
        for (const [k, v] of Object.entries(learnt)) if (!(Number(next[k]) > 0) && Number(v) > 0) next[k] = Number(v);
        specs.set(id, next);
        learnClip(next);
      }
      if (!ui) return;
      const t = S.getTab(ui.getState());
      if (clockIdOf(t) === id) {
        if (typeof ui.syncClockMeta === 'function') ui.syncClockMeta();
        else {
          const c = engine.getClip(id);
          if (c) {
            const next = S.syncClockMeta(ui.getState(), { fps: c.fps, maxFrame: Math.max(1, c.frames - 1) });
            if (next !== ui.getState()) ui.setState(next);
          }
        }
      }
      ui.render();
      scheduleTick();
    }
    /** @param {string} id */
    function disposePlayer(id) {
      const p = players.get(id);
      players.delete(id);
      const ex = exacts.get(id);
      if (ex) { exacts.delete(id); try { ex.invalidate(); } catch { /* nothing pending */ } }
      if (p && typeof p.dispose === 'function') { try { p.dispose(); } catch { /* already closed */ } }
    }
    /** Every clip of every tab has a decoder; one no tab shows any more is closed. @param {any} ws */
    function syncPlayers(ws) {
      const wanted = new Set();
      for (const t of ws.tabs) for (const id of t.tiles) wanted.add(id);
      for (const id of [...players.keys()]) if (!wanted.has(id)) disposePlayer(id);
      for (const id of [...registered]) if (!wanted.has(id)) forgetClip(id);
      for (const id of wanted) ensurePlayer(id);
    }

    // ---- the decoder clock drives the controller; the controller's seeks and play / pause drive the decoders ----
    let fromClock = false;
    /** What the decoders were last told (play / pause) for which tiles. @type {{ playing: boolean, tiles: string } | null} */
    let applied = null;
    /**
     * The frame each tile's decoder was last sent to (null: outside its clip), per clip. Per tile, not per clock
     * frame: a follower whose offset changed while paused is sought at once, and a mixed-fps follower is compared in
     * its own frames.
     * @type {Map<string, number | null>}
     */
    const appliedTargets = new Map();
    const clockIdOf = (/** @type {any} */ t) => (t.clockId && t.tiles.includes(t.clockId) ? t.clockId : t.tiles[0]);
    /** @param {string} id @param {number} frame */
    function onPlayerFrame(id, frame) {
      if (disposed || !ui) return;
      const t = S.getTab(ui.getState());
      if (id !== clockIdOf(t) || !Number.isFinite(frame)) return;
      const f = Math.round(frame);
      if (f === t.frame) return;
      fromClock = true;
      try {
        if (typeof ui.onDecoderFrame === 'function') ui.onDecoderFrame(f, id);
        else ui.dispatch('seek', f);
      } finally { fromClock = false; }
    }
    /**
     * The clock decoder stopped at its end (or on an error): the controller decides (loop, autoplay, pause).
     * @param {string} id @param {any} info
     */
    function onPlayerEnded(id, info) {
      if (disposed || !ui) return;
      const t = S.getTab(ui.getState());
      if (id !== clockIdOf(t)) return;
      const natural = !!(info && info.natural);
      // The decoder paused itself at its end: a Loop or A-B restart's play must reach it, not pass for a repeat.
      if (applied) applied = { ...applied, playing: false };
      if (typeof ui.onDecoderEnded === 'function') { ui.onDecoderEnded({ natural }); return; }
      // A controller without onDecoderEnded: the bar stops playing (its decoders are paused already).
      if (t.playing && typeof S.togglePlay === 'function') ui.setState(S.togglePlay(ui.getState()));
    }
    /** The decoders of the active tab's tiles (the ones on screen), as [clipId, player]. @param {any} t */
    const visiblePlayers = (t) => t.tiles.map((/** @type {string} */ id) => [id, players.get(id)])
      .filter((/** @type {any} */ e) => e[1]);
    /** Read the clock decoder's frame (media/engine.js has no frame callback) and hand it to the controller. */
    function pump() {
      if (disposed || !ui) return;
      const t = S.getTab(ui.getState());
      const p = players.get(clockIdOf(t));
      if (p && typeof p.currentFrame === 'function') {
        try { onPlayerFrame(clockIdOf(t), Number(p.currentFrame())); } catch { /* a closing decoder */ }
      }
    }
    /**
     * A decoder still has work a frame tick moves on: playing, a seek not yet shown, a first frame not yet presented
     * (media/engine.js settled(); else the same from its fields).
     * @param {any} p
     */
    function busy(p) {
      try {
        if (typeof p.settled === 'function') return !p.settled();
        if (typeof p.isPlaying === 'function' ? p.isPlaying() : p.playing) return true;
        // A frame player (media/frame-player.js) draws its target once the picture has arrived and decoded: until
        // then each animation frame looks again (it has no wake of its own).
        if (typeof p.shown === 'number' && p.bitmaps && typeof p.currentFrame === 'function' && p.shown !== p.currentFrame()) return true;
        return (p.seekTarget !== null && p.seekTarget !== undefined) || !!p.shownStale;
      } catch { return false; }
    }
    /** Last seen shownCount per visible decoder so frame 0 / paused seeks repaint the visible tile canvas. @type {Map<string, number>} */
    const lastShown = new Map();
    /**
     * One animation frame of the shared loop (media/player.js frameTick): every visible decoder ticks (presents its
     * due frame, settles its seek, reaches its end), then the clock decoder's frame drives the controller.
     * @param {number} now
     */
    function tick(now) {
      if (disposed || !ui) return;
      let painted = false;
      for (const [id, p] of visiblePlayers(S.getTab(ui.getState()))) {
        if (typeof p.tick !== 'function') continue;
        const prev = Number(p.shownCount) || 0;
        try { p.tick(now); } catch (err) { log(`decoder ${id} tick: ${err && /** @type {any} */ (err).message || err}`); }
        if (!firstFrameLogged || !firstPicturesLogged) notePresented(id);
        const next = Number(p.shownCount) || 0;
        if (next !== prev || (next > 0 && lastShown.get(id) !== next)) {
          lastShown.set(id, next);
          painted = true;
        }
      }
      pump();
      if (painted && ui && !disposed) ui.render();
      scopesHost.tick(now);
    }
    /** The shared loop's work, for the debug probe's state: animation frames that ticked, and the times it rested. */
    const loopStats = { frames: 0, rests: 0 };
    let tickPending = false;
    let raf = 0;
    /** One animation frame: tick, then another while a visible decoder is busy or the tab plays; else rest. */
    const frame = (/** @type {number} */ now) => {
      raf = 0;
      if (disposed || !ui) { tickPending = false; return; }
      // A wake from inside the tick (onReady, a frame, the end) asks for nothing more: the check below decides.
      try { tick(Number.isFinite(now) ? now : Date.now()); } finally { tickPending = false; }
      loopStats.frames++;
      if (disposed || !ui) return;
      const t = S.getTab(ui.getState());
      // Open scopes keep the loop going: their GPU read finishes on a later frame, and a paused frame change is sampled.
      if (t.playing || scopesHost.active() || visiblePlayers(t).some((/** @type {any} */ e) => busy(e[1]))) scheduleTick();
      else loopStats.rests++;
    };
    /** Wake the loop (a decoder's wake, a seek, play): one animation frame is asked for at a time. */
    function scheduleTick() {
      if (tickPending || disposed || !win || typeof win.requestAnimationFrame !== 'function') return;
      tickPending = true;
      raf = win.requestAnimationFrame(frame) || 0;
    }

    /**
     * Seek and / or play-pause every decoder of the tab (to `frame` / `playing`, else the tab's own). A seek goes only
     * to a tile whose target (its offset, the clock's fps) differs from the one it was last sent; `record` only notes
     * the targets (the clock moved the decoders itself).
     * @param {any} t @param {{ seek?: boolean, record?: boolean, play?: boolean, frame?: number, playing?: boolean }} o
     */
    function applyToDecoders(t, o) {
      const frame = o.frame === undefined ? t.frame : o.frame;
      const playing = o.playing === undefined ? t.playing : o.playing;
      for (const id of t.tiles) {
        const p = players.get(id);
        if (!p) continue;
        try {
          if (o.seek || o.record) {
            const s = adapter.shownFrame(id, frame, S.getOffset ? S.getOffset(t, id) : null, t.fps);
            const target = s.frame === null || s.frame === undefined ? null : s.frame;
            const changed = !appliedTargets.has(id) || appliedTargets.get(id) !== target;
            appliedTargets.set(id, target);
            if (o.seek && changed && target !== null && typeof p.seekFrame === 'function') p.seekFrame(target);
          }
          if (o.play) {
            const isPlaying = typeof p.isPlaying === 'function' ? !!p.isPlaying() : null;
            if (playing && isPlaying !== true && typeof p.play === 'function') p.play();
            else if (!playing && isPlaying !== false && typeof p.pause === 'function') p.pause();
          }
        } catch (err) { log(`decoder ${id}: ${err && /** @type {any} */ (err).message || err}`); }
      }
      scheduleTick();
    }

    /**
     * The controller changed the tab: seeks (not the clock's own), offset edits, play / pause and new tiles reach the
     * decoders. `applied` / `appliedTargets` are what the decoders were last told, here or by onTransport, so neither
     * path repeats the other.
     * @param {any} t
     */
    function driveDecoders(t) {
      const tilesKey = t.tiles.join(',');
      const prev = applied;
      applied = { playing: t.playing, tiles: tilesKey };
      for (const id of [...appliedTargets.keys()]) if (!t.tiles.includes(id)) appliedTargets.delete(id);
      const play = !prev || prev.playing !== t.playing || prev.tiles !== tilesKey;
      // The clock's own frames are not sent back: the targets follow it, so a later edit is measured from there.
      applyToDecoders(t, { seek: !fromClock, record: fromClock, play });
    }

    /**
     * The user's play / pause / seek / rate / loop as the controller reports it (VpePlayerUi.create onTransport),
     * straight to the decoders. A seek the decoder clock caused is never sent back to it.
     * @param {TransportCommand | string} a @param {any} [b] the value, when `a` is the command's name
     */
    function onTransport(a, b) {
      const c = transportOf(a, b);
      if (disposed || !c || !ui) return;
      const t = S.getTab(ui.getState());
      const tilesKey = t.tiles.join(',');
      // New tiles first go through driveDecoders (onChange), which seeks and starts them all.
      if (!applied || applied.tiles !== tilesKey) return;
      switch (c.type) {
        case 'seek': {
          const f = Math.round(Number(c.value));
          if (fromClock || !Number.isFinite(f)) return;
          applyToDecoders(t, { seek: true, frame: f });
          return;
        }
        case 'play': case 'pause': {
          const playing = c.type === 'play';
          if (applied.playing === playing) return;
          applied = { ...applied, playing };
          applyToDecoders(t, { play: true, playing });
          if (playing && debugProbe) debugProbe.wake();
          return;
        }
        case 'rate': case 'loop':
          if (c.type === 'rate' && Number(c.value) > 0) currentRate = Number(c.value);
          if (c.type === 'loop') currentLoop = !!c.value;
          for (const id of t.tiles) {
            const p = players.get(id);
            if (!p) continue;
            try {
              if (c.type === 'rate') { if (Number(c.value) > 0 && typeof p.setRate === 'function') p.setRate(Number(c.value)); }
              else if (typeof p.setLoop === 'function') p.setLoop(!!c.value);
              else p.loop = !!c.value;
            } catch (err) { log(`decoder ${id}: ${err && /** @type {any} */ (err).message || err}`); }
          }
          return;
        default: break;
      }
    }

    /** The debug hooks exist (installed after the controller): the tile count may reinstall the Compare probe. */
    let probesReady = false;
    /** media/debug-probe.js once installed (debug pages only). @type {{ dispose: () => void, wake: () => void } | null} */
    let debugProbe = null;
    /** @param {any} ws */
    function onChange(ws) {
      if (disposed) return;
      const t = S.getTab(ws);
      doc.body.classList.toggle('compare', t.tiles.length >= 2);
      syncPlayers(ws);
      driveDecoders(t);
      if (probesReady && cfg.debug && ui) {
        installCompareDebug();
        if (debugProbe && t.playing) debugProbe.wake();
      }
    }

    // ---- the initial state: the config's clips in one tab, at the clip's own fps and length ----
    const first = specs.values().next().value;
    const tileIds = Array.isArray(cfg.tiles) && cfg.tiles.length ? cfg.tiles.filter((/** @type {any} */ id) => specs.has(id)) : [first.id];
    const ws0 = S.createWorkspaceState({ tiles: tileIds.length ? tileIds : [first.id], capture: tileIds.length >= 2, frame: 0 });
    const meta0 = adapter.getClip(tileIds[0] || first.id);
    const initial = meta0
      ? { ...ws0, tabs: ws0.tabs.map((/** @type {any} */ t) => ({ ...t, fps: meta0.fps, maxFrame: Math.max(1, meta0.frames - 1) })) }
      : ws0;

    /** The clock tile's decoder canvas (a real element, which drawImage and the scopes need), else the page's #canvas. */
    function realCanvas() {
      const p = ui ? players.get(clockIdOf(S.getTab(ui.getState()))) : null;
      return (p && (p.cv || p.canvas)) || (doc && typeof doc.getElementById === 'function' ? doc.getElementById('canvas') : null) || null;
    }
    /**
     * The scopes (W, Inspection › Scopes) for the controller's inspection tools (inspectWidgets.scopes). media/scopes.js
     * samples one real canvas, so its panel is made again when the clock tile's decoder canvas changes (another video,
     * a rebuilt decoder). The controller toasts the mode; the panel's own toast stays quiet.
     */
    const scopesHost = (() => {
      /** @type {any} */
      let inst = null;
      /** @type {any} */
      let instCanvas = null;
      /** @type {string | null} */
      let want = null;
      const drop = () => {
        if (!inst) return;
        try { inst.setMode(null); } catch { /* ignore */ }
        const old = doc && typeof doc.getElementById === 'function' ? doc.getElementById('scopes') : null;
        if (old && typeof old.remove === 'function') old.remove();
        inst = null;
        instCanvas = null;
      };
      const ensure = () => {
        const VS = W('VpeScopes');
        const cv = realCanvas();
        const stage = doc && typeof doc.getElementById === 'function' ? doc.getElementById('stage') : null;
        if (!VS || typeof VS.create !== 'function' || !cv || !stage) return null;
        if (inst && instCanvas === cv) return inst;
        drop();
        try {
          inst = VS.create({
            stage, canvas: cv, getPlayer: () => (realCanvas() === cv ? clockPlayer() : null), getExact: () => null,
            toast: () => {}, log, returnFocus: () => { const b = doc.getElementById('play'); if (b && b.focus) b.focus(); },
          });
          instCanvas = cv;
          if (want) inst.setMode(want);
        } catch (err) {
          log(`scopes: ${err && /** @type {any} */ (err).message || err}`);
          inst = null;
        }
        return inst;
      };
      /** @param {string} fn @param {any} dflt */
      const read = (fn, dflt) => { try { return inst && typeof inst[fn] === 'function' ? inst[fn]() : dflt; } catch { return dflt; } };
      return {
        /** @param {string | null} name */
        setMode: (name) => {
          want = name || null;
          const sc = want ? ensure() : inst;
          if (sc) sc.setMode(want);
          scheduleTick();
        },
        /** From the shared loop: follow the clock canvas, then sample (~10 Hz playing, once per paused frame). */
        tick: (/** @type {number} */ now) => {
          if (!want) return;
          const sc = ensure();
          if (sc && typeof sc.tick === 'function') { try { sc.tick(now); } catch (err) { log(`scopes tick: ${err && /** @type {any} */ (err).message || err}`); } }
        },
        active: () => !!want,
        mode: () => (want ? read('mode', null) : null),
        analysis: () => read('analysis', null),
        perf: () => read('perf', null),
        dispose: () => { want = null; drop(); },
      };
    })();

    /** @type {UnifiedControllerApi} the controller; null only until create() below returns */
    let ui = /** @type {any} */ (null);
    ui = UiApi.create({
      doc, win, stateApi: S, engine, host, widgets, initial,
      prefs: cfg.prefs, railCfg: cfg.rail || cfg.railCfg, storage: host.storage, goto: cfg.goto,
      fragment: win && win.location ? win.location.hash : null, railCarry: cfg.railCarry, page: cfg.page,
      tickMs: 0, onChange, onTransport, inspectWidgets: { scopes: scopesHost },
    });
    onChange(ui.getState());

    // ---- host -> page ----
    /** @param {HostToPageMessage} msg */
    function onHostMessage(msg) {
      // Read loosely: the host's message is checked field by field at run time.
      const m = /** @type {any} */ (msg);
      if (disposed || !m || typeof m.type !== 'string') return;
      if (DECODER_ROUTES[m.type]) { routeDecoder(m); return; }
      if (LIFECYCLE_TYPES.includes(m.type)) { onLifecycle(m); return; }
      if (m.type === 'open') { onOpen(m); return; }
      if (m.type === 'sessionState') { onSessionState(m); return; }
      if (m.type === 'openVideo' || m.type === 'replaceTile') {
        const id = m.type === 'replaceTile' ? m.newId : m.clipId;
        if (typeof id === 'string') {
          addSpec({ ...m, clipId: id });
          ensurePlayer(id);
        }
      }
      ui.onHostMessage(m);
      // A message the controller declined (a duplicate, a full view) leaves no decoder behind.
      syncPlayers(ui.getState());
    }

    /** @param {any} m */
    function routeDecoder(m) {
      const key = keyOf(m);
      /** @type {string[]} */
      let ids = [];
      if (key !== null) ids = [key];
      else if (m.type === 'resize' && Array.isArray(m.tiles)) {
        // Compare's host names tiles by index (the slots of the last 'tiles' report).
        const slots = host.slots();
        ids = m.tiles.map((/** @type {any} */ i) => (typeof i === 'number' ? slots[i] : i));
      } else if (players.size === 1) ids = [...players.keys()];
      else if (m.type === 'exactFrame' && exacts.size === 1) ids = [...exacts.keys()];
      for (const id of ids) {
        const p = players.get(id);
        // HLS: the Quality page's variants (media/player.js streamQ), what pictureInfo / transcodeInfo report.
        if (m.type === 'stream' && typeof id === 'string' && specs.has(id)) {
          if (m.quality && Array.isArray(m.quality.variants)) streams.set(id, m.quality);
          else streams.delete(id);
        }
        // An exact frame the page asked for (grabExact): the reply goes to that clip's request, with this page's id.
        if (m.type === 'exactFrame' && !(p && typeof p.onExactFrame === 'function')) {
          const ex = exacts.get(id);
          if (ex) ex.onReply({ ...m, page: cfg.page }).then(() => scheduleTick(), () => {});
          continue;
        }
        if (!p) continue;
        try { DECODER_ROUTES[m.type](p, m); } catch (err) { log(`${m.type}: ${err && /** @type {any} */ (err).message || err}`); }
      }
    }

    /**
     * The clip a lifecycle message is for: clipId / key, else Compare's tile `index` (the host's slots), else the one
     * clip the active tab shows.
     * @param {any} m @returns {string | null}
     */
    function lifecycleClip(m) {
      const key = keyOf(m);
      if (key !== null) return specs.has(key) || players.has(key) ? key : null;
      if (typeof m.index === 'number') {
        const id = host.slots()[m.index];
        if (typeof id === 'string') return id;
      }
      const tiles = ui ? S.getTab(ui.getState()).tiles : [...specs.keys()];
      return tiles.length === 1 ? tiles[0] : null;
    }

    /**
     * The clip's decoder starts over (another decoder kind, the host's new meta): the old one closes, the new one is
     * sought to the clip's place and given the tab's play state, rate and loop.
     * @param {string} id
     */
    function restartPlayer(id) {
      disposePlayer(id);
      appliedTargets.delete(id);
      const p = ensurePlayer(id);
      if (!p || !ui) return p;
      const t = S.getTab(ui.getState());
      if (t.tiles.includes(id)) {
        applied = null;
        driveDecoders(t);
      }
      return p;
    }

    /** 'frames', 'frame', 'wavPart', 'libav', 'originalTile' (LIFECYCLE_TYPES). @param {any} m */
    function onLifecycle(m) {
      const id = lifecycleClip(m);
      if (id === null) { log(`${m.type}: no clip for it`); return; }
      switch (m.type) {
        case 'wavPart': { // MJPEG AVI sound, in parts before its 'frames' message
          const w = openWith.get(id) || {};
          openWith.set(id, { ...w, wavParts: [...(w.wavParts || []), m.data] });
          return;
        }
        case 'frames': {
          const w = openWith.get(id) || {};
          const wav = m.wav || w.wavParts || null;
          openWith.set(id, { frameMeta: m.meta, ...(wav ? { wav } : {}) });
          addSpec({ clipId: id, clip: { kind: 'sequence', ...numbersOf(m.meta) } });
          restartPlayer(id);
          return;
        }
        case 'frame': {
          const p = players.get(id);
          if (p && typeof p.onFrame === 'function') p.onFrame(m.index, m.data);
          scheduleTick();
          return;
        }
        case 'libav': {
          const meta = m.meta && typeof m.meta === 'object' ? m.meta : null;
          openWith.set(id, meta ? { meta } : {});
          const spec = specs.get(id);
          if (spec && meta && typeof meta.native === 'boolean' && spec.native !== meta.native) {
            specs.set(id, { ...spec, native: meta.native });
            learnClip(/** @type {ClipSpec} */ (specs.get(id)));
          }
          restartPlayer(id);
          return;
        }
        case 'originalTile': {
          // Live transcode gave way to the built-in decoder (media/compare.js useOriginalTile).
          const spec = specs.get(id);
          if (!spec) return;
          openWith.delete(id);
          streams.delete(id);
          specs.set(id, { ...spec, native: false, transcoded: false });
          learnClip(/** @type {ClipSpec} */ (specs.get(id)));
          restartPlayer(id);
          if (m.notice) {
            const many = ui ? S.getTab(ui.getState()).tiles.length >= 2 : specs.size >= 2;
            toast(many ? `${spec.name || id}: ${m.notice}` : String(m.notice));
          }
          if (ui) ui.render();
          return;
        }
        default: break;
      }
    }

    /**
     * The host is ready to serve the clips: start their decoders. "Opening…" stays until the first decoder is ready
     * (onReady or its first frame), at once when one already is or the page has no decoders.
     * @param {any} m
     */
    function onOpen(m) {
      if (Array.isArray(m.clips)) for (const c of m.clips) if (c && typeof c.id === 'string') addSpec({ clipId: c.id, clip: c });
      opened = true;
      syncPlayers(ui.getState());
      if (typeof createPlayer !== 'function' || [...players.values()].some(isReady)) markReady();
      applied = null;
      appliedTargets.clear();
      driveDecoders(S.getTab(ui.getState()));
    }

    /** @type {{ ids: string[], capture: boolean, maxVideos: number | null } | null} the host's last 'sessionState' */
    let session = null;
    /**
     * src/unified-session.js answers 'ready' with the panel's clips, their order, capture and the limit: the page
     * shows exactly those (a clip it booted with is not opened again) and starts their decoders, as 'open' does.
     * @param {any} m
     */
    function onSessionState(m) {
      const ids = sessionIds(m);
      for (const c of Array.isArray(m.clips) ? m.clips : []) {
        const id = c && typeof c === 'object' ? c.clipId || c.id : null;
        if (typeof id === 'string') addSpec({ clipId: id, label: c.label, clip: descriptorOf(c) });
      }
      const maxVideos = Number.isInteger(m.maxVideos) ? m.maxVideos : undefined;
      const capture = typeof m.capture === 'boolean' ? m.capture : undefined;
      session = { ids, capture: !!capture, maxVideos: maxVideos === undefined ? null : maxVideos };
      const ws = ui.getState();
      const next = applySessionState(S, ws, ids, { capture, maxVideos });
      // Decoders start with the state that names their clips: no decoder for a clip the session dropped.
      opened = true;
      if (next !== ws) ui.setState(next);
      onOpen({});
    }

    // ---- test hooks: window.vpe / window.vpeCompare and the debug probes the layer-3 scenarios talk to ----
    /** The controller with its extras (rail, controls, ctxMenu, ab), beyond UnifiedControllerApi. */
    const ux = () => /** @type {any} */ (ui);
    const tabNow = () => S.getTab(ui.getState());
    const clockPlayer = () => (ui ? players.get(clockIdOf(tabNow())) || null : null);
    const compareActive = () => !!ui && tabNow().tiles.length >= 2;
    /** The adapter with its extras (transcodeInfo, sound), beyond EngineAdapter; read late (it may be rebuilt). */
    const ax = () => /** @type {any} */ (adapter);
    /** Apply a pure state step to the controller's state. @param {(ws: any) => any} f */
    const update = (f) => ui.setState(f(ui.getState()));
    /**
     * Runs a controller action; false when the controller has no such action (or it failed).
     * @param {string} name @param {any[]} a
     */
    const act = (name, ...a) => {
      try { ui.dispatch(name, ...a); return true; } catch (err) {
        log(`debug ${name}: ${err && /** @type {any} */ (err).message || err}`);
        return false;
      }
    };
    /** @param {number} d frames, + or - */
    const stepBy = (d) => {
      const n = Math.round(Number(d) || 0);
      for (let i = 0; i < Math.abs(n); i++) act(n < 0 ? 'prevFrame' : 'nextFrame');
    };
    const ratePrefs = () => Number((prefsNow() || {}).rate) || 1;
    /** @param {number} r */
    const setRateTo = (r) => {
      const Ctl = W('VpeControls');
      const step = Ctl && Number(Ctl.SPEED_STEP) > 0 ? Number(Ctl.SPEED_STEP) : 0.25;
      if (Number(r) > 0) act('rateStep', (Number(r) - ratePrefs()) / step);
    };
    const playTo = (/** @type {boolean} */ on) => { if (tabNow().playing !== on) act('playPause'); };
    /** The tile id at a Compare index (a number, or a clip id), else the first tile. @param {any} i */
    const tileId = (i) => {
      const tiles = tabNow().tiles;
      return typeof i === 'string' && tiles.includes(i) ? i : tiles[Number(i)] || tiles[0];
    };
    const tileOr0 = (/** @type {any} */ i) => {
      const n = Number(i);
      return Number.isInteger(n) && n >= 0 && n < tabNow().tiles.length ? n : 0;
    };
    const debugApi = {
      ui, host, engine, players, specs, streams,
      get clock() { return clockPlayer(); },
      get tiles() { return tabNow().tiles.map((/** @type {string} */ id) => players.get(id)).filter(Boolean); },
      state: () => ui.getState(),
      tab: () => tabNow(),
      step: stepBy, play: () => playTo(true), pause: () => playTo(false),
      seekFrame: (/** @type {number} */ f) => act('seek', Math.round(Number(f) || 0)),
      seekClock: (/** @type {number} */ s) => act('seek', Math.round((Number(s) || 0) * tabNow().fps)),
      setRate: setRateTo,
      pictureInfo: (/** @type {string} */ id) => (typeof ax().pictureInfo === 'function'
        ? ax().pictureInfo(id || clockIdOf(tabNow())) : null),
      transcodeInfo: (/** @type {string} */ id) => (typeof ax().transcodeInfo === 'function' ? ax().transcodeInfo(id) : null),
    };
    /** media/compare.js window.vpeCompare, over the unified state (tiles by their index in the active tab). */
    const compareApi = {
      get tiles() { return debugApi.tiles; }, get clock() { return clockPlayer(); },
      get A() { return debugApi.tiles[0]; }, get B() { return debugApi.tiles[1]; },
      step: stepBy, seekClock: debugApi.seekClock, seekA: debugApi.seekClock, play: debugApi.play, pause: debugApi.pause,
      setMode: (/** @type {string} */ m) => act('layout', m),
      setDock: (/** @type {string} */ d) => { if (typeof S.setDock === 'function') update((ws) => S.setDock(ws, d)); },
      setHeroRatio: (/** @type {number} */ r) => {
        if (typeof S.setHeroRatio === 'function') update((ws) => S.setHeroRatio(ws, Number(r)));
      },
      setSyncMode: (/** @type {boolean} */ on) => { if (tabNow().syncMode !== !!on) act('sync'); },
      setOffset: (/** @type {any} */ i, /** @type {number} */ v, /** @type {string} */ unit) => {
        const id = tileId(i);
        let ws = ui.getState();
        const u = unit === 'ms' ? 'ms' : 'frames';
        const cur = S.getOffset ? S.getOffset(S.getTab(ws), id) : null;
        if (cur && cur.unit !== u && typeof S.setOffsetUnit === 'function') {
          ws = S.setOffsetUnit(ws, id, u, (engine.getClip(id) || {}).fps || tabNow().fps);
        }
        if (typeof S.setOffset === 'function') ui.setState(S.setOffset(ws, id, Number(v) || 0));
      },
      setClock: (/** @type {any} */ i) => act('setClock', tileId(i)),
      setSound: (/** @type {any} */ i) => act('setSound', tileId(i)),
      removeTile: (/** @type {any} */ i) => act('removeTile', tileId(i)),
      setSplit: (/** @type {number} */ x) => {
        if (typeof S.setSplitRatio === 'function') update((ws) => S.setSplitRatio(ws, Number(x)));
      },
      swapSides: () => act('swap'),
      nudge: (/** @type {any} */ i, /** @type {number} */ d) => act('nudge', tileId(i), Number(d) || 1),
      leave: () => act('leaveCompare'),
      railState: () => (ux().rail && typeof ux().rail.snapshot === 'function' ? ux().rail.snapshot() : null),
    };
    if (win) {
      win.vpe = debugApi;
      win.vpeCompare = compareApi;
    }
    let compareDebugTiles = 0;
    let compareDebugGen = 0;

    /** An element of the page, or an inert stand-in (the unified page lacks a few of media/player.js's). @param {string} id */
    function elOf(id) {
      const e = doc.getElementById(id);
      if (e) return e;
      const none = () => null;
      return {
        id, hidden: true, disabled: false, textContent: '', innerText: '', value: '0', max: '0', min: '0', title: '',
        style: {}, dataset: {}, children: [], className: '', offsetWidth: 0, offsetHeight: 0,
        classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
        getAttribute: none, hasAttribute: () => false, setAttribute() {}, querySelector: none, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }),
        addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, click() {}, focus() {}, closest: none,
      };
    }
    /** The page's elements by id, for the probes' `ui.<id>` reads. */
    const uiEls = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? elOf(k) : undefined) });
    /** Layout properties read from the visible tile canvas in #cells; pixel buffer props read from the decoder canvas. */
    const LAYOUT_PROPS = new Set(['getBoundingClientRect', 'offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight', 'hidden']);
    const visibleCellCanvas = () => {
      const cellsEl = doc.getElementById('cells');
      return (cellsEl && typeof cellsEl.querySelector === 'function' && cellsEl.querySelector('.cell canvas')) || null;
    };
    /** The clock tile's canvas (its decoder's own), else the page's #canvas: what the probe measures and reads. */
    const liveCanvas = new Proxy({}, {
      get: (_t, k) => {
        const p = clockPlayer();
        const cv = (typeof k === 'string' && LAYOUT_PROPS.has(k) && visibleCellCanvas())
          || (p && (p.cv || p.canvas)) || elOf('canvas');
        const v = cv[k];
        return typeof v === 'function' ? v.bind(cv) : v;
      },
      set: (_t, k, v) => {
        const p = clockPlayer();
        const cv = (p && (p.cv || p.canvas)) || elOf('canvas');
        cv[k] = v;
        return true;
      },
    });
    const safe = (/** @type {any} */ o, /** @type {string} */ k, /** @type {any} */ dflt) => (/** @type {any[]} */ ...a) => {
      try { return o && typeof o[k] === 'function' ? o[k](...a) : dflt; } catch { return dflt; }
    };

    /**
     * media/debug-probe.js (window.VpeDebugProbe) over the unified page, as media/player.js installs it: the probe
     * reads the clock tile's decoder. With 2+ tiles the Compare probe answers instead (one handler per message).
     */
    function installDebugProbe() {
      const Probe = W('VpeDebugProbe');
      if (!Probe || typeof Probe.install !== 'function' || !win) return null;
      const VS = W('VpeScopes') || {};
      const H = W('VpeHdr') || null;
      const T = W('VpeTime') || {};
      /** @type {Map<any, any>} the probe's message listeners, wrapped to stay quiet while Compare answers */
      const wrapped = new Map();
      const probeWin = new Proxy(win, {
        get: (t, k) => {
          if (k === 'addEventListener' || k === 'removeEventListener') {
            return (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ o) => {
              let f = fn;
              if (type === 'message') {
                if (k === 'addEventListener') {
                  f = (/** @type {any} */ e) => { if (!compareActive()) fn(e); };
                  wrapped.set(fn, f);
                } else { f = wrapped.get(fn) || fn; wrapped.delete(fn); }
              }
              return t[k](type, f, o);
            };
          }
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const panelButtons = () => Array.from(elOf('panel').querySelectorAll('button') || []);
      try {
        return Probe.install({
          log, win: probeWin, doc,
          getPlayer: () => clockPlayer(),
          isLibavPlayer: (/** @type {any} */ p) => !!(p && p.queue),
          stage: elOf('stage'), canvas: liveCanvas, snapshotSource: realCanvas,
          overlay: elOf('overlay'), message: elOf('message'), hint: elOf('hint'),
          actionBtn: elOf('action'), dropHint: elOf('dropHint'), compareBackdrop: elOf('compareBackdrop'),
          ui: uiEls,
          controls: {
            view: safe(ux().controls, 'view', null), sheetOpen: safe(ux().controls, 'sheetOpen', false),
            show: safe(ux().controls, 'show', undefined), closeAll: safe(ux().controls, 'closeAll', undefined),
          },
          ctxMenu: {
            open: safe(ux().ctxMenu, 'open', undefined), close: safe(ux().ctxMenu, 'close', undefined),
            snapshot: safe(ux().ctxMenu, 'snapshot', null),
          },
          insp: {
            picture: () => { const t = tabNow(); return { mode: t.picMode, zoom: t.zoom, panX: t.panX, panY: t.panY }; },
            zoomedSize: () => null,
          },
          scopes: {
            mode: scopesHost.mode, analysis: scopesHost.analysis, perf: scopesHost.perf,
            columnLevels: typeof VS.columnLevels === 'function' ? VS.columnLevels : () => [],
            targets75: typeof VS.targets75 === 'function' ? VS.targets75 : () => [],
          },
          hdr: {
            debugPixels: H && typeof H.debugPixels === 'function' ? H.debugPixels : () => Promise.reject(new Error('no VpeHdr on this page')),
            probe: H && typeof H.probe === 'function' ? H.probe : () => Promise.reject(new Error('no VpeHdr on this page')),
          },
          // Read late: the controller's A-B marks, whatever object holds them now.
          ab: { presentationRange: () => safe(ux().ab, 'presentationRange', null)() },
          frameText: typeof T.frameText === 'function' ? T.frameText : (/** @type {number} */ f, /** @type {number} */ n) => `${f + 1} / ${n}`,
          step: stepBy,
          setRate: setRateTo,
          // Through the controller, so its frame, the seek bar and every decoder move (a decoder seeked alone is put
          // back by the controller's next drive). The frame holding t, as a decoder's seekTime picks it.
          seek: (/** @type {number} */ sec) => {
            const fps = Number(tabNow().fps) || Number((clockPlayer() || {}).fps) || 30;
            act('seek', Math.max(0, Math.floor((Number(sec) || 0) * fps + 1e-6)));
            scheduleTick();
          },
          play: debugApi.play,
          pause: debugApi.pause,
          runTool: (/** @type {string} */ label) => {
            const b = panelButtons().find((x) => ((x.getAttribute && x.getAttribute('aria-label')) || x.textContent || '').trim().startsWith(label));
            if (b) b.click();
            return !!b;
          },
          getToolCount: () => panelButtons().length,
          getState: () => {
            const pr = prefsNow() || {};
            return {
              prefs: pr, volume: Number(pr.volume) || 0, muted: !!pr.muted, loop: loopPref(pr), onEnd: pr.onEnd,
              rail: ux().rail && typeof ux().rail.snapshot === 'function' ? ux().rail.snapshot() : null,
              streamQ: streams.get(clockIdOf(tabNow())) || null, loopStats: { ...loopStats },
              loopBusy: tickPending ? 'busy' : 'rest', picturePct: null, seekDragging: false, volumeDragging: false,
            };
          },
        });
      } catch (err) {
        log(`debug probe could not start: ${err && /** @type {any} */ (err).message || err}`);
        return null;
      }
    }

    /**
     * media/compare-debug.js (VpeCompareDebug) over the unified page, as media/compare.js installs it. It reads the
     * tile count once (N), so it is installed again when the count changes; an older install keeps its listener but
     * no longer matches the page (its `cfg.page` is a value no message carries), as does every install while the tab
     * shows one video.
     */
    function installCompareDebug() {
      const CD = W('VpeCompareDebug');
      if (!CD || typeof CD.install !== 'function' || !cfg.debug || disposed) return;
      const n = tabNow().tiles.length;
      if (n < 2 || n === compareDebugTiles) return;
      compareDebugTiles = n;
      const gen = ++compareDebugGen;
      const off = {};
      const Grid = W('CompareGrid');
      const t = () => tabNow();
      /** Display index of the clip, -1 when it is not shown. @param {any} id */
      const indexOf = (id) => t().tiles.indexOf(id);
      let sel = 0;
      let thresh = 0;
      const st = {
        get mode() { return t().layout; }, get dock() { return t().dock; }, get heroRatio() { return t().heroRatio; },
        get clock() { return Math.max(0, indexOf(clockIdOf(t()))); }, get sound() { return indexOf(t().soundId); },
        get muted() { return !!(prefsNow() || {}).muted; }, get split() { return t().split; },
        get order() { const slots = host.slots(); return t().tiles.map((/** @type {string} */ id, /** @type {number} */ i) => (slots.includes(id) ? slots.indexOf(id) : i)); },
        get offsets() { return t().tiles.map((/** @type {string} */ id) => (S.getOffset ? S.getOffset(t(), id) : { v: 0, unit: 'frames' })); },
        get pic() { return { mode: t().picMode, zoom: t().zoom, cx: 0.5, cy: 0.5 }; },
        get rate() { return ratePrefs(); }, get loop() { return loopPref(prefsNow()); },
        get sel() { return sel; }, set sel(v) { sel = Number(v) || 0; },
        get thresh() { return thresh; }, set thresh(v) { thresh = Number(v) || 0; },
      };
      const cellsEl = elOf('cells');
      const cells = () => {
        const o = cellsEl.getBoundingClientRect();
        return Array.from(cellsEl.children || []).map((/** @type {any} */ d, /** @type {number} */ i) => {
          const r = d.getBoundingClientRect();
          const box = { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
          const add = !!(d.classList && d.classList.contains('add'));
          return /** @type {any} */ ({ ...box, ...(add ? { add: true } : { tiles: [i] }), full: { ...box }, pic: { ...box } });
        });
      };
      try {
        CD.install({
          cfg: { debug: true, get page() { return gen === compareDebugGen && compareActive() ? cfg.page : off; } },
          log, N: n, MAX_TILES: t().maxVideos,
          Grid: Grid && typeof Grid.gridFor === 'function' ? Grid : { gridFor: () => ({ cols: n, rows: 1 }) },
          st, canvas: liveCanvas, stage: elOf('stage'), cellsEl, ui: uiEls,
          controls: {
            show: safe(ux().controls, 'show', undefined), closeAll: safe(ux().controls, 'closeAll', undefined),
            view: safe(ux().controls, 'view', null),
          },
          scanner: { start: () => log('scan: not in the unified viewer'), running: false, found: null },
          $: (/** @type {string} */ id) => doc.getElementById(id),
          getState: () => ({
            tiles: debugApi.tiles, clock: clockPlayer(), cells: cells(), hover: null, syncMode: !!t().syncMode,
            statsIds: new Set(t().statsOpen.map(indexOf)),
          }),
          contextCount: () => 0,
          setHover: () => {},
          frameOf: (/** @type {any} */ p) => (p && typeof p.currentFrame === 'function' ? Number(p.currentFrame()) : 0),
          fpsOf: (/** @type {any} */ p) => Number(p && p.fps) || t().fps,
          synced: () => t().tiles.every((/** @type {string} */ id) => {
            const p = players.get(id);
            const want = appliedTargets.get(id);
            return !p || want === null || want === undefined || typeof p.currentFrame !== 'function' || Number(p.currentFrame()) === want;
          }),
          tileSize: () => { const c = cells().find((x) => !x.add); return c ? { w: Math.round(c.w), h: Math.round(c.h) } : { w: 0, h: 0 }; },
          frameFactor: () => 1,
          picState: () => ({ pct: null }),
          setMode: compareApi.setMode, setDock: compareApi.setDock, setHeroRatio: compareApi.setHeroRatio,
          setSyncMode: compareApi.setSyncMode, setOffset: compareApi.setOffset, setClock: compareApi.setClock,
          removeTile: compareApi.removeTile, setSound: compareApi.setSound,
          step: stepBy, play: debugApi.play, pause: debugApi.pause, seekClock: debugApi.seekClock, setRate: setRateTo,
          setSplit: compareApi.setSplit, tileOr0, leave: compareApi.leave,
        });
      } catch (err) { log(`compare debug could not start: ${err && /** @type {any} */ (err).message || err}`); }
    }

    debugProbe = cfg.debug ? installDebugProbe() : null;
    probesReady = true;
    if (cfg.debug) installCompareDebug();

    host.connect(onHostMessage);

    // ---- teardown: the page goes away (pagehide) or the caller disposes ----
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (raf && win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(raf);
      raf = 0;
      tickPending = false;
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', dispose);
      if (debugProbe) { try { debugProbe.dispose(); } catch { /* ignore */ } }
      scopesHost.dispose();
      compareDebugGen++; // an installed Compare probe matches no message any more
      for (const id of [...players.keys()]) disposePlayer(id);
      for (const x of [sync, compositor]) if (x && typeof x.dispose === 'function') { try { x.dispose(); } catch { /* ignore */ } }
      try { ui.dispose(); } catch { /* ignore */ }
      host.dispose();
    }
    if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', dispose, { once: true });

    // The host learns the page is up (src/extension.js answers with 'open').
    const bridge = ui.parts && ui.parts.bridge;
    if (bridge) bridge.sendReady({ origin: win && win.location ? win.location.origin : undefined });
    else host.post({ type: 'ready' });

    return {
      ui, host, engine, players, onHostMessage, onTransport, pump, tick, dispose, isDisposed: () => disposed,
      /** The host's last 'sessionState' (null with a host that sends 'open' instead). */
      session: () => (session ? { ...session, ids: session.ids.slice() } : null),
    };
  }

  const api = { boot, clipsOf, readCfg, sessionIds, applySessionState, transportOf, DECODER_TYPES };
  // checkJs: end
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.VpeUnified = api;
    const G = /** @type {any} */ (globalThis);
    if (typeof G.acquireVsCodeApi === 'function' && root.document && root.document.getElementById('cfg')) {
      // Classic <script> top-level `const` widgets live in the global lexical scope, not on `window`.
      const browserWidgets = {
        VpeControls: typeof VpeControls !== 'undefined' ? VpeControls : undefined,
        VpeFolderRail: typeof VpeFolderRail !== 'undefined' ? VpeFolderRail : undefined,
        VpeCtxMenu: typeof VpeCtxMenu !== 'undefined' ? VpeCtxMenu : undefined,
        VpeAbLoop: typeof VpeAbLoop !== 'undefined' ? VpeAbLoop : undefined,
        VpeAutoplay: typeof VpeAutoplay !== 'undefined' ? VpeAutoplay : undefined,
        VpeTime: typeof VpeTime !== 'undefined' ? VpeTime : undefined,
        VpePicture: typeof VpePicture !== 'undefined' ? VpePicture : undefined,
        VpeModes: typeof VpeModes !== 'undefined' ? VpeModes : undefined,
        VpeRangeDrag: typeof VpeRangeDrag !== 'undefined' ? VpeRangeDrag : undefined,
        VpeReducedResNotice: typeof VpeReducedResNotice !== 'undefined' ? VpeReducedResNotice : undefined,
        VpeSlowNotice: typeof VpeSlowNotice !== 'undefined' ? VpeSlowNotice : undefined,
        CompareGrid: typeof CompareGrid !== 'undefined' ? CompareGrid : undefined,
        VpePlayerUiTiles: typeof VpePlayerUiTiles !== 'undefined' ? VpePlayerUiTiles : undefined,
        VpePlayerUiInput: typeof VpePlayerUiInput !== 'undefined' ? VpePlayerUiInput : undefined,
        VpePlayerUiTools: typeof VpePlayerUiTools !== 'undefined' ? VpePlayerUiTools : undefined,
        VpePlayerUiLifecycle: typeof VpePlayerUiLifecycle !== 'undefined' ? VpePlayerUiLifecycle : undefined,
      };
      try { root.vpeUnified = boot({ widgets: browserWidgets }); }
      catch (err) {
        console.error('VpeUnified.boot failed', err);
        const msg = root.document.getElementById('message');
        if (msg) msg.textContent = `Unified viewer boot failed: ${err && err.message || err}`;
      }
    }
  }
}(typeof self !== 'undefined' ? self : /** @type {any} */ (this)));
