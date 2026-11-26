// @ts-check
'use strict';
// The unified page's entry script (docs/notes/player-ui-controller.md, "Next step: one unified page"): the one browser
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
   * @typedef {{ id: string, name?: string, fps?: number, frames?: number, duration?: number, width?: number,
   *   height?: number, hasAudio?: boolean, codec?: string, size?: number, [k: string]: any }} ClipSpec
   * @typedef {{ onFrame: (frame: number) => void, onReady: () => void, onMeta: () => void, post: (m: any) => void,
   *   log: (...a: any[]) => void }} PlayerHooks
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
  const DECODER_TYPES = Object.keys(DECODER_ROUTES);

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
        log: hooks.log, showMessage: () => {}, toast: () => {},
        getState: () => ({}), setMuteUi: () => {},
        onReady: () => hooks.onReady(), onMeta: () => hooks.onMeta(), wake: () => {},
      });
      const p = new eng.LibavPlayer({ size: clip.size || 0, duration: clip.duration || 0, label: clip.name || '', native: !!clip.native },
        { ...(cfg.engine || {}), rotation: Number(clip.rotation) || 0 });
      p.cv = cv;
      p.key = clip.id;
      return p;
    };
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

    /** The adapter is rebuilt when a clip arrives (it reads its clips once); the controller keeps this facade. */
    const makeAdapter = () => EngineApi.create({
      clips: [...specs.values()], getPlayer: (/** @type {string} */ id) => players.get(id) || null, compositor,
      pictureApi: W('VpePicture'), controlsApi: W('VpeControls'), doc,
    });
    let adapter = makeAdapter();
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
      const next = { ...(prev || {}), ...(m.clip && typeof m.clip === 'object' ? m.clip : {}), id };
      if (typeof m.label === 'string' && !next.name) next.name = m.label;
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) { specs.set(id, next); adapter = makeAdapter(); }
    }

    /** The decoder for `id`, made on first need (after 'open': the host serves blocks from then on). @param {string} id */
    function ensurePlayer(id) {
      if (players.has(id) || !opened || disposed || typeof createPlayer !== 'function') return players.get(id) || null;
      const spec = specs.get(id) || { id };
      /** @type {PlayerHooks} */
      const hooks = {
        onFrame: (f) => onPlayerFrame(id, f),
        onReady: () => { if (ui) ui.render(); },
        onMeta: () => { adapter = makeAdapter(); if (ui) ui.render(); },
        post: (m) => { if (!disposed) host.post(m); },
        log: (...a) => log(`[${id}]`, ...a),
      };
      try {
        const p = createPlayer(spec, host, hooks);
        if (p) players.set(id, p);
        return p || null;
      } catch (err) {
        log(`decoder could not start for ${id}: ${err && /** @type {any} */ (err).message || err}`);
        return null;
      }
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
      for (const id of wanted) ensurePlayer(id);
    }

    // ---- the decoder clock drives the controller; the controller's seeks and play / pause drive the decoders ----
    let fromClock = false;
    /** @type {{ frame: number, playing: boolean, tiles: string } | null} */
    let applied = null;
    const clockIdOf = (/** @type {any} */ t) => (t.clockId && t.tiles.includes(t.clockId) ? t.clockId : t.tiles[0]);
    /** @param {string} id @param {number} frame */
    function onPlayerFrame(id, frame) {
      if (disposed || !ui) return;
      const t = S.getTab(ui.getState());
      if (id !== clockIdOf(t) || !Number.isFinite(frame)) return;
      const f = Math.round(frame);
      if (f === t.frame) return;
      fromClock = true;
      try { ui.dispatch('seek', f); } finally { fromClock = false; }
    }
    /** Poll the clock decoder (media/engine.js has no frame callback): one read per animation frame while playing. */
    function pump() {
      if (disposed || !ui) return;
      const t = S.getTab(ui.getState());
      const p = players.get(clockIdOf(t));
      if (p && typeof p.currentFrame === 'function') {
        try { onPlayerFrame(clockIdOf(t), Number(p.currentFrame())); } catch { /* a closing decoder */ }
      }
    }
    let raf = 0;
    const loop = () => {
      raf = 0;
      if (disposed || !ui) return;
      pump();
      if (S.getTab(ui.getState()).playing && win && typeof win.requestAnimationFrame === 'function') raf = win.requestAnimationFrame(loop);
    };
    const wakeLoop = () => { if (!raf && win && typeof win.requestAnimationFrame === 'function') raf = win.requestAnimationFrame(loop) || 0; };

    /** The controller changed the tab: seeks (not the clock's own), play / pause and new tiles reach the decoders. @param {any} t */
    function driveDecoders(t) {
      const tilesKey = t.tiles.join(',');
      const prev = applied;
      applied = { frame: t.frame, playing: t.playing, tiles: tilesKey };
      const seek = !fromClock && (!prev || prev.frame !== t.frame || prev.tiles !== tilesKey);
      const play = !prev || prev.playing !== t.playing || prev.tiles !== tilesKey;
      for (const id of t.tiles) {
        const p = players.get(id);
        if (!p) continue;
        try {
          if (seek && typeof p.seekFrame === 'function') {
            const s = adapter.shownFrame(id, t.frame, S.getOffset ? S.getOffset(t, id) : null);
            if (s.frame !== null) p.seekFrame(s.frame);
          }
          if (play) {
            const isPlaying = typeof p.isPlaying === 'function' ? !!p.isPlaying() : null;
            if (t.playing && isPlaying !== true && typeof p.play === 'function') p.play();
            else if (!t.playing && isPlaying !== false && typeof p.pause === 'function') p.pause();
          }
        } catch (err) { log(`decoder ${id}: ${err && /** @type {any} */ (err).message || err}`); }
      }
      if (t.playing) wakeLoop();
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

    /** @type {any} */
    let ui = null;
    ui = UiApi.create({
      doc, win, stateApi: S, engine, host, widgets: env.widgets, initial,
      prefs: cfg.prefs, railCfg: cfg.rail || cfg.railCfg, storage: host.storage, goto: cfg.goto,
      fragment: win && win.location ? win.location.hash : null, railCarry: cfg.railCarry, page: cfg.page,
      tickMs: 0, onChange,
    });
    onChange(ui.getState());

    // ---- host -> page ----
    /** @param {any} m */
    function onHostMessage(m) {
      if (disposed || !m || typeof m.type !== 'string') return;
      if (DECODER_ROUTES[m.type]) { routeDecoder(m); return; }
      if (m.type === 'open') { onOpen(m); return; }
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

    /** The host is ready to serve the clips: start their decoders and take the "Opening…" overlay away. @param {any} m */
    function onOpen(m) {
      if (Array.isArray(m.clips)) for (const c of m.clips) if (c && typeof c.id === 'string') addSpec({ clipId: c.id, clip: c });
      opened = true;
      syncPlayers(ui.getState());
      const overlay = ui.parts && ui.parts.overlay;
      if (overlay && overlay.isShown()) overlay.hide();
      else { const el = doc.getElementById('overlay'); if (el) el.hidden = true; }
      applied = null;
      driveDecoders(S.getTab(ui.getState()));
    }

    host.connect(onHostMessage);

    // ---- teardown: the page goes away (pagehide) or the caller disposes ----
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (raf && win && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(raf);
      raf = 0;
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

    return { ui, host, engine, players, onHostMessage, pump, dispose, isDisposed: () => disposed };
  }

  const api = { boot, clipsOf, readCfg, DECODER_TYPES };
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
