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
   *   toast: (text: string, ms?: number) => void }} PlayerHooks
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
    'kind', 'rotation'];

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

  /** #cfg's JSON, or {} if the page has none or it does not parse. @param {any} doc */
  function readCfg(doc) {
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('cfg') : null;
    if (!el) return {};
    try { const v = JSON.parse(el.textContent || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }

  /**
   * The production decoder factory over media/engine.js (the page global createEngine), as media/compare.js
   * makeEngine builds a tile: one LibavPlayer per clip, its host messages tagged with the clip. null when the page has
   * no engine (Node, or a page without engine.js).
   * @param {any} G the page's globals @param {any} vscode @param {any} cfg
   * @returns {CreatePlayer | null}
   */
  function defaultCreatePlayer(G, vscode, cfg) {
    const createEngine = G && G.createEngine;
    if (typeof createEngine !== 'function' || !G.document) return null;
    return (clip, _host, hooks) => {
      const cv = G.document.createElement('canvas');
      const eng = createEngine({
        page: cfg.page, debug: !!cfg.debug, canvas: cv,
        // Decoder traffic (blocks, native frames) is not the controller's: it goes straight to the host, tagged.
        vscode: { postMessage: (/** @type {any} */ m) => vscode.postMessage({ ...m, key: clip.id, clipId: clip.id }), getState: () => ({}), setState() {} },
        log: hooks.log,
        showMessage: (/** @type {any} */ msg, /** @type {any} */ hint) => hooks.showMessage(msg, hint),
        toast: (/** @type {any} */ text, /** @type {any} */ ms) => hooks.toast(text, ms),
        getState: () => ({}), setMuteUi: () => {},
        // The decoder's wake (a worker message, a decoded frame) runs the page's shared tick loop.
        onReady: () => hooks.onReady(), onMeta: () => hooks.onMeta(), wake: () => hooks.wake(),
        onEnded: (/** @type {any} */ _p, /** @type {any} */ info) => hooks.onEnded(info),
      });
      const p = new eng.LibavPlayer({ size: clip.size || 0, duration: clip.duration || 0, label: clip.name || '', native: !!clip.native },
        { ...(cfg.engine || {}), rotation: Number(clip.rotation) || 0 });
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
    const log = env.log || (() => {});
    const widgets = env.widgets || {};
    const W = (/** @type {string} */ k) => widgets[k] || (win && win[k]) || G[k];

    /** @type {HostAdapter & { slots: () => string[] }} */
    const host = HostApi.create({ vscode, win, page: cfg.page, boot: cfg.boot, surface: cfg.surface || 'unified' });
    const createPlayer = env.createPlayer !== undefined ? env.createPlayer : defaultCreatePlayer(G, vscode, cfg);
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
    const makeAdapter = () => EngineApi.create({
      clips: [...specs.values()], getPlayer: (/** @type {string} */ id) => players.get(id) || null, compositor,
      pictureApi: W('VpePicture'), controlsApi: W('VpeControls'), doc,
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

    /** The decoder for `id`, made on first need (after 'open': the host serves blocks from then on). @param {string} id */
    function ensurePlayer(id) {
      if (players.has(id) || !opened || disposed || typeof createPlayer !== 'function') return players.get(id) || null;
      const spec = specs.get(id) || { id };
      /** @type {PlayerHooks} */
      const hooks = {
        onFrame: (f) => { onPlayerFrame(id, f); markReady(); },
        onReady: () => { markReady(); if (ui) ui.render(); scheduleTick(); },
        onMeta: () => onPlayerMeta(id),
        onEnded: (info) => onPlayerEnded(id, info),
        post: (m) => { if (!disposed) host.post(m); },
        log: (...a) => log(`[${id}]`, ...a),
        wake: () => scheduleTick(),
        showMessage: (msg, hint) => showDecoderMessage(id, msg, hint),
        toast: (text, ms) => { if (!disposed && ui && text) ui.onHostMessage({ type: 'toast', text: String(text), ms }); },
      };
      try {
        const p = createPlayer({ ...spec }, host, hooks);
        if (p) players.set(id, p);
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
        return (p.seekTarget !== null && p.seekTarget !== undefined) || !!p.shownStale;
      } catch { return false; }
    }
    /**
     * One animation frame of the shared loop (media/player.js frameTick): every visible decoder ticks (presents its
     * due frame, settles its seek, reaches its end), then the clock decoder's frame drives the controller.
     * @param {number} now
     */
    function tick(now) {
      if (disposed || !ui) return;
      for (const [id, p] of visiblePlayers(S.getTab(ui.getState()))) {
        if (typeof p.tick !== 'function') continue;
        try { p.tick(now); } catch (err) { log(`decoder ${id} tick: ${err && /** @type {any} */ (err).message || err}`); }
      }
      pump();
    }
    let tickPending = false;
    let raf = 0;
    /** One animation frame: tick, then another while a visible decoder is busy or the tab plays; else rest. */
    const frame = (/** @type {number} */ now) => {
      raf = 0;
      if (disposed || !ui) { tickPending = false; return; }
      // A wake from inside the tick (onReady, a frame, the end) asks for nothing more: the check below decides.
      try { tick(Number.isFinite(now) ? now : Date.now()); } finally { tickPending = false; }
      if (disposed || !ui) return;
      const t = S.getTab(ui.getState());
      if (t.playing || visiblePlayers(t).some((/** @type {any} */ e) => busy(e[1]))) scheduleTick();
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
          return;
        }
        case 'rate': case 'loop':
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

    /** @param {any} ws */
    function onChange(ws) {
      if (disposed) return;
      const t = S.getTab(ws);
      doc.body.classList.toggle('compare', t.tiles.length >= 2);
      syncPlayers(ws);
      driveDecoders(t);
    }

    // ---- the initial state: the config's clips in one tab, at the clip's own fps and length ----
    const first = specs.values().next().value;
    const tileIds = Array.isArray(cfg.tiles) && cfg.tiles.length ? cfg.tiles.filter((/** @type {any} */ id) => specs.has(id)) : [first.id];
    const ws0 = S.createWorkspaceState({ tiles: tileIds.length ? tileIds : [first.id], capture: tileIds.length >= 2, frame: 0 });
    const meta0 = adapter.getClip(tileIds[0] || first.id);
    const initial = meta0
      ? { ...ws0, tabs: ws0.tabs.map((/** @type {any} */ t) => ({ ...t, fps: meta0.fps, maxFrame: Math.max(1, meta0.frames - 1) })) }
      : ws0;

    /** @type {UnifiedControllerApi} the controller; null only until create() below returns */
    let ui = /** @type {any} */ (null);
    ui = UiApi.create({
      doc, win, stateApi: S, engine, host, widgets: env.widgets, initial,
      prefs: cfg.prefs, railCfg: cfg.rail || cfg.railCfg, storage: host.storage, goto: cfg.goto,
      fragment: win && win.location ? win.location.hash : null, railCarry: cfg.railCarry, page: cfg.page,
      tickMs: 0, onChange, onTransport,
    });
    onChange(ui.getState());

    // ---- host -> page ----
    /** @param {HostToPageMessage} msg */
    function onHostMessage(msg) {
      // Read loosely: the host's message is checked field by field at run time.
      const m = /** @type {any} */ (msg);
      if (disposed || !m || typeof m.type !== 'string') return;
      if (DECODER_ROUTES[m.type]) { routeDecoder(m); return; }
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
      /** @type {any[]} */
      let targets = [];
      if (key !== null) {
        const p = players.get(key);
        if (p) targets = [p];
      } else if (m.type === 'resize' && Array.isArray(m.tiles)) {
        // Compare's host names tiles by index (the slots of the last 'tiles' report).
        const slots = host.slots();
        targets = m.tiles.map((/** @type {any} */ i) => players.get(typeof i === 'number' ? slots[i] : i)).filter(Boolean);
      } else if (players.size === 1) targets = [...players.values()];
      for (const p of targets) {
        try { DECODER_ROUTES[m.type](p, m); } catch (err) { log(`${m.type}: ${err && /** @type {any} */ (err).message || err}`); }
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

    host.connect(onHostMessage);

    // ---- teardown: the page goes away (pagehide) or the caller disposes ----
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (raf && win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(raf);
      raf = 0;
      tickPending = false;
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pagehide', dispose);
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
      try { root.vpeUnified = boot(); } catch (err) { console.error('VpeUnified.boot failed', err); }
    }
  }
}(typeof self !== 'undefined' ? self : /** @type {any} */ (this)));
