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
   *   getMuted: () => boolean, getVolume: () => number, onTracks: (player: any) => void }} PlayerHooks
   *   getRate / getLoop / getMuted / getVolume: the page's live settings for a decoder that reads them on demand
   *   (media/frame-player.js); getMuted is true for every clip but the sound source. onTracks: media/engine.js's
   *   track list or a track selection changed (the page reads player.tracks()).
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
        // The sound and subtitle streams (tracks-streams): the page lists them in the CC and Audio track panels.
        onTracks: (/** @type {any} */ pl) => { if (typeof hooks.onTracks === 'function') hooks.onTracks(pl); },
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
    const host = HostApi.create({ vscode, win, page: cfg.page, boot: cfg.boot });
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
    /** @type {Map<string, any>} shown-fps mark per clip for Shift+I stats overlay */
    const statsMarks = new Map();
    /** @type {any} */
    const engine = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'quality') return (/** @type {string} */ id) => streams.get(id) || null;
        if (k === 'statsText') {
          return (/** @type {string} */ id) => {
            const p = players.get(id);
            if (!p) return '';
            if (typeof p.statsText === 'function') return p.statsText();
            const I = W('VpeInspect');
            if (!I || typeof I.formatStats !== 'function') return '';
            const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
            const res = I.formatStats(p, now, p.cv || p.canvas, statsMarks.get(id) || null);
            statsMarks.set(id, res.mark);
            return res.text;
          };
        }
        // Page-owned tools over the decoders (the adapter knows none of them): subtitles, the X-ray, chapters.
        if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(pageEngine, k)) return pageEngine[k];
        const v = adapter[/** @type {any} */ (k)];
        return typeof v === 'function' ? v.bind(adapter) : v;
      },
      has: (_t, k) => k === 'statsText' || (typeof k === 'string' && Object.prototype.hasOwnProperty.call(pageEngine, k)) || k in adapter,
    });
    /**
     * The tool controllers' engine methods only the page can answer (media/player-ui-tools.js reads them once, so
     * they always exist; each answers null / [] while nothing applies).
     * @type {Record<string, (...a: any[]) => any>}
     */
    const pageEngine = {
      cueAt: (/** @type {string} */ id, /** @type {number} */ t, /** @type {number} */ track) => cueAt(id, t, track),
      selectSubtitle: (/** @type {string} */ id, /** @type {number} */ track) => selectSubtitle(id, track),
      packetIndex: (/** @type {string} */ id) => xrayHost.packetIndex(id),
      chapters: (/** @type {string} */ id) => chaptersOf(id),
    };

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
      const loop = effectiveLoop(ui ? S.getTab(ui.getState()) : null);
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
    /**
     * Decoder-level loop flag: in Compare (2+ tiles) every decoder has loop=false so unequal-length tiles never wrap
     * independently — the clock's natural EOF triggers one shared wrap through onPlayerEnded -> onDecoderEnded.
     * @param {any} t
     */
    const effectiveLoop = (t) => (t && t.tiles && t.tiles.length >= 2 ? false
      : (currentLoop !== null ? currentLoop : loopPref(prefsNow())));
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
        getLoop: () => effectiveLoop(ui ? S.getTab(ui.getState()) : null),
        getMuted: () => {
          const s = typeof /** @type {any} */ (adapter).sound === 'function' ? /** @type {any} */ (adapter).sound() : null;
          return s ? s.soundSource !== id || !!s.muted : !!(prefsNow() || {}).muted;
        },
        getVolume: () => {
          const s = typeof /** @type {any} */ (adapter).sound === 'function' ? /** @type {any} */ (adapter).sound() : null;
          const v = s ? Number(s.volume) : Number((prefsNow() || {}).volume);
          return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
        },
        onTracks: (pl) => onPlayerTracks(id, pl),
      };
      try {
        // Kept (not taken once): a clip closed and opened again, or restarted, opens with the host's meta again.
        const p = createPlayer({ ...spec, ...(openWith.get(id) || {}) }, host, hooks);
        if (p) {
          players.set(id, p);
          applyRateAndLoop(p);
          // Embedded subtitle cues (media/engine.js emitCue): the text and picture cues of the selected track.
          if (typeof p === 'object') p.onSubCue = (/** @type {any} */ c) => onSubCue(id, c);
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

    /** Extract resume seconds from SavedPos `{ t, d }` or a plain number. @param {any} v */
    const resumeSecOf = (v) => {
      const n = typeof v === 'number' ? v : v && typeof v === 'object' && typeof v.t === 'number' ? v.t : NaN;
      return Number.isFinite(n) && n > 0.5 ? n : null;
    };
    /** Pending resume time (seconds) from cfg.savedPos or sessionState.savedPos, applied once the clock clip's fps & duration arrive. */
    let pendingResumeSec = !cfg.goto ? resumeSecOf(cfg.savedPos) : null;
    /** Pending { frame, playing } to restore after restartPlayer (e.g. HLS quality switch) once the new decoder opens. @type {Map<string, { frame: number, playing: boolean }>} */
    const pendingRestore = new Map();
    /** Autoplay on open (setting videoPreviewEnhanced.autoplay, or Autoplay "Play next in folder"): start playing once firstShown. */
    let pendingAutoPlay = !cfg.goto && (!!cfg.fromAutoNext || !!(cfg.prefs && cfg.prefs.autoplay));
    let lastPosAt = 0;
    /** Report the clock clip's position to the host so it can persist resume position across reopen. @param {boolean} [force] @param {boolean} [atEnd] */
    function reportPos(force = true, atEnd = false) {
      if (disposed || !ui) return;
      const now = Date.now();
      if (!force && now - lastPosAt < 2000) return;
      const t = S.getTab(ui.getState());
      const cid = clockIdOf(t);
      const c = cid ? engine.getClip(cid) : null;
      const fps = (c && c.fps) || t.fps || 0;
      const d = (c && c.duration) || (fps > 0 && t.maxFrame > 0 ? t.maxFrame / fps : 0);
      if (cid && fps > 0 && d > 0) {
        lastPosAt = now;
        host.post({ type: 'pos', clipId: cid, t: atEnd ? d : t.frame / fps, d });
      }
    }
    /** Apply pendingResumeSec once the clock clip has real fps and duration (wins only when no goto link). */
    function tryApplyResume() {
      if (pendingResumeSec === null || disposed || !ui) return;
      const t = S.getTab(ui.getState());
      const cid = clockIdOf(t);
      const c = cid ? engine.getClip(cid) : null;
      const fps = (c && c.fps) || 0;
      const frames = (c && c.frames) || 0;
      const dur = (c && c.duration) || (fps > 0 && frames > 0 ? frames / fps : 0);
      if (!(fps > 0 && frames > 1 && dur > 0)) return;
      const sec = pendingResumeSec;
      pendingResumeSec = null;
      if (sec <= 0.5 || sec >= dur - 1) return;
      const targetFrame = Math.max(0, Math.min(frames - 1, Math.round(sec * fps)));
      ui.dispatch('seek', targetFrame);
      const fmt = W('VpeTime') && typeof W('VpeTime').fmtClock === 'function' ? W('VpeTime').fmtClock(sec) : `${sec.toFixed(2)}s`;
      ui.onHostMessage({ type: 'toast', text: `Resumed at ${fmt} (Home: start)`, ms: 2500 });
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
      // The cues were this decoder's reads (picture cues carry its worker's gen): a new decoder reads them again.
      cueStore.delete(id);
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
      // Convert the clock decoder's raw frame back to the shared timeline by removing its own sync offset.
      const clkOff = S.getOffset ? S.getOffset(t, id) : null;
      const offFrames = clkOff
        ? Math.round(clkOff.unit === 'ms' ? ((Number(clkOff.v) || 0) / 1000) * (t.fps || 24) : (Number(clkOff.v) || 0))
        : 0;
      const f = Math.max(0, Math.round(frame) - offFrames);
      if (f === t.frame) return;
      fromClock = true;
      try {
        if (typeof ui.onDecoderFrame === 'function') ui.onDecoderFrame(f, id);
        else ui.dispatch('seek', f);
      } finally { fromClock = false; }
      if (t.playing) reportPos(false);
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
      const onEnd = (typeof ui.getPrefs === 'function' && ui.getPrefs().onEnd) || 'off';
      if (natural) {
        log(`end of file: ${onEnd}`);
        reportPos(true, true);
      }
      // Only the clock decoder paused itself at its end; pause every longer follower immediately so none keeps playing.
      for (const cid of t.tiles) {
        if (cid === id) continue;
        const fp = players.get(cid);
        if (fp && typeof fp.pause === 'function') {
          try { fp.pause(); } catch { /* closing */ }
        }
      }
      // All decoders are now paused: a Loop or A-B restart's play must reach them, not pass for a repeat.
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
      // While paused with a seek/step still in flight, or waiting to restore after a reload, never overwrite t.frame.
      if (!p || pendingRestore.has(clockIdOf(t)) || (!t.playing && busy(p))) return;
      if (typeof p.currentFrame === 'function') {
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
        const shownNow = presented(p);
        if (pendingResumeSec !== null && shownNow && id === clockIdOf(S.getTab(ui.getState()))) tryApplyResume();
        if (pendingGoto !== null && shownNow && id === clockIdOf(S.getTab(ui.getState()))) tryApplyGoto(id, p);
        if (pendingRestore.has(id) && shownNow) {
          const r = /** @type {{ frame: number, playing: boolean }} */ (pendingRestore.get(id));
          pendingRestore.delete(id);
          appliedTargets.delete(id);
          const cur = S.getTab(ui.getState());
          if (cur.tiles.length <= 1 || id === clockIdOf(cur)) {
            applied = null;
            let nextWs = S.seekFrame(ui.getState(), r.frame);
            if (r.playing && !S.getTab(nextWs).playing) nextWs = S.togglePlay(nextWs);
            else if (!r.playing && S.getTab(nextWs).playing) nextWs = S.togglePlay(nextWs);
            if (nextWs !== ui.getState()) ui.setState(nextWs);
            driveDecoders(S.getTab(ui.getState()));
          } else if (cur.tiles.includes(id)) {
            // A recovering follower in Compare catches up to the live shared frame and play state instead of
            // rewinding or restarting the whole workspace.
            applyToDecoders({ ...cur, tiles: [id] }, { seek: true, play: true, force: true });
          }
          if (cur.tiles.includes(id)) ui.render();
        }
        if (pendingAutoPlay && shownNow && id === clockIdOf(S.getTab(ui.getState()))) {
          pendingAutoPlay = false;
          const cur = ui.getState();
          if (!S.getTab(cur).playing) ui.setState(S.togglePlay(cur));
        }
        const next = Number(p.shownCount) || 0;
        if (next !== prev || (next > 0 && lastShown.get(id) !== next)) {
          lastShown.set(id, next);
          painted = true;
        }
      }
      pump();
      if (painted && ui && !disposed) {
        ui.render();
        // A paused frame change reads the pixel under the pointer again (not every frame while playing: a GPU read).
        if (!S.getTab(ui.getState()).playing) pixelHost.refresh();
      }
      bitmapSubs.update();
      xrayHost.tick();
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
     * @param {any} t @param {{ seek?: boolean, record?: boolean, play?: boolean, frame?: number, playing?: boolean, keepPlaying?: boolean, force?: boolean }} o
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
            const changed = !!o.force || !appliedTargets.has(id) || appliedTargets.get(id) !== target;
            appliedTargets.set(id, target);
            if (o.seek && changed && target !== null) {
              if ((o.keepPlaying || playing) && typeof p.seekTime === 'function' && typeof p.frameSeekTime === 'function') {
                p.seekTime(p.frameSeekTime(target), true);
              } else if (typeof p.seekFrame === 'function') {
                p.seekFrame(target);
                if (playing && !o.play && !o.keepPlaying && typeof p.play === 'function') p.play();
              }
            }
          }
          if (o.play) {
            const isPlaying = typeof p.isPlaying === 'function' ? !!p.isPlaying() : null;
            if (playing && isPlaying !== true && typeof p.play === 'function') {
              // p.eof is demuxer EOF (true for any short video once fully decoded in RAM), NOT playhead-at-end:
              // only restart from 0 when the playhead is actually on the last frame.
              const atEnd = p.eof && Number(p.n) > 1 && typeof p.currentFrame === 'function' && Number(p.currentFrame()) >= Number(p.n) - 1;
              if (atEnd && typeof p.seekTime === 'function') p.seekTime(0);
              p.play();
            } else if (!playing && isPlaying !== false && typeof p.pause === 'function') p.pause();
          } else if (!playing && typeof p.isPlaying === 'function' && p.isPlaying() && typeof p.pause === 'function') {
            // Invariant: while the tab is paused (e.g. seeking backwards after end), no tile decoder may stay playing.
            p.pause();
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
      const tilesChanged = !prev || prev.tiles !== tilesKey;
      if (tilesChanged) {
        const loop = effectiveLoop(t);
        for (const id of t.tiles) {
          const p = players.get(id);
          if (!p) continue;
          try {
            if (typeof p.setLoop === 'function') p.setLoop(loop);
            else p.loop = loop;
          } catch { /* closing */ }
        }
      }
      const play = !prev || prev.playing !== t.playing || tilesChanged;
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
      if (c.type === 'rate' || c.type === 'loop') {
        if (c.type === 'rate' && Number(c.value) > 0) currentRate = Number(c.value);
        if (c.type === 'loop') currentLoop = !!c.value;
        const loop = effectiveLoop(t);
        for (const id of t.tiles) {
          const p = players.get(id);
          if (!p) continue;
          try {
            if (c.type === 'rate') { if (Number(c.value) > 0 && typeof p.setRate === 'function') p.setRate(Number(c.value)); }
            else if (typeof p.setLoop === 'function') p.setLoop(loop);
            else p.loop = loop;
          } catch (err) { log(`decoder ${id}: ${err && /** @type {any} */ (err).message || err}`); }
        }
        return;
      }
      // New tiles first go through driveDecoders (onChange), which seeks and starts them all.
      if (!applied || applied.tiles !== tilesKey) return;
      switch (c.type) {
        case 'seek': {
          const f = Math.round(Number(c.value));
          const isRestart = !!(a && typeof a === 'object' && 'playing' in a && a.playing === true);
          if ((fromClock && !isRestart) || !Number.isFinite(f)) return;
          applyToDecoders(t, { seek: true, frame: f, keepPlaying: isRestart, force: isRestart });
          reportPos();
          return;
        }
        case 'play': case 'pause': {
          const playing = c.type === 'play';
          if (applied.playing === playing) return;
          applied = { ...applied, playing };
          applyToDecoders(t, { play: true, playing });
          if (!playing) reportPos();
          if (playing && debugProbe) debugProbe.wake();
          return;
        }
        default: break;
      }
    }

    /** The debug hooks exist (installed after the controller): the tile count may reinstall the Compare probe. */
    let probesReady = false;
    /** media/debug-probe.js once installed (debug pages only). @type {{ dispose: () => void, wake: () => void } | null} */
    let debugProbe = null;
    /** The clip whose embedded subtitles the controller currently lists (null before the first clip). @type {string | null} */
    let activeSubClip = null;
    /** @param {any} ws */
    function onChange(ws) {
      if (disposed) return;
      const t = S.getTab(ws);
      doc.body.classList.toggle('compare', t.tiles.length >= 2);
      syncPlayers(ws);
      driveDecoders(t);
      // The shown clip's streams join the subtitle list (a clip whose decoder listed them before it was shown),
      // after this change (the controller is mid-commit); picture subtitles and the pixel grid follow the picture.
      const shownId = t.tiles[0] || null;
      if (shownId !== activeSubClip) {
        const prevSubClip = activeSubClip;
        activeSubClip = shownId;
        if (prevSubClip !== null) {
          subEntries.length = 0;
          announced.clear();
          const ctl = subsCtl();
          if (ctl && typeof ctl.reset === 'function') ctl.reset();
        }
      }
      if (ui && shownId && players.has(shownId) && !announced.has(shownId)) {
        Promise.resolve().then(() => { if (!disposed) announceTracks(shownId); });
      }
      bitmapSubs.update();
      pixelHost.refresh();
      if (probesReady && cfg.debug && ui) {
        installCompareDebug();
        if (debugProbe && t.playing) debugProbe.wake();
      }
    }

    // ---- the picture on screen ----
    /** The clock tile's decoder (the one the single-video tools read), or null. */
    function clockPlayerNow() { return ui ? players.get(clockIdOf(S.getTab(ui.getState()))) || null : null; }
    /** The first tile's canvas in #cells (what the user sees), or null. */
    function visibleCellCanvas() {
      const cellsEl = doc.getElementById('cells');
      return (cellsEl && typeof cellsEl.querySelector === 'function' && cellsEl.querySelector('.cell canvas')) || null;
    }
    /**
     * The clock clip's picture as shown, in client px: its tile canvas's box with the controller's picture size,
     * zoom and pan (the adapter's pictureRect). null before a tile is laid out.
     * @returns {{ left: number, top: number, width: number, height: number } | null}
     */
    function pictureClientRect() {
      if (!ui) return null;
      const cellCv = visibleCellCanvas();
      const base = cellCv && typeof cellCv.getBoundingClientRect === 'function' ? cellCv.getBoundingClientRect() : null;
      if (!base || !(base.width > 0 && base.height > 0) || typeof adapter.pictureRect !== 'function') return null;
      const t = S.getTab(ui.getState());
      const r = adapter.pictureRect(clockIdOf(t), base.width, base.height, t.picMode, t.zoom, t.panX, t.panY);
      if (!r || !(r.w > 0 && r.h > 0)) return null;
      return { left: base.left + r.x, top: base.top + r.y, width: r.w, height: r.h };
    }
    /** @param {number} t seconds */
    const fmtClock = (t) => {
      const T = W('VpeTime');
      return T && typeof T.fmtClock === 'function' ? T.fmtClock(t) : `${(Number(t) || 0).toFixed(2)} s`;
    };

    // ---- sound and subtitle tracks (media/engine.js tracks, selectAudio, selectSub, onSubCue) ----
    // The shared subtitle controller (VpePlayerUiTools.createSubtitleController) lists tracks, toggles them and asks
    // engine.cueAt for the text to show; this page answers for the host's files (parsed here) and the decoders'
    // embedded streams (their cues kept here), switches the decoders' streams and draws picture subtitles.
    const SubsApi = () => /** @type {any} */ (W('Subtitles') || null);
    /** The cues read per clip: track id -> CueIndex (text) or BitmapCueIndex (PGS, DVB, DVD). @type {Map<string, Map<string, any>>} */
    const cueStore = new Map();
    /**
     * What each track of the subtitle controller (in its order) is: a file the host sent (its cues parsed here), an
     * embedded stream of a clip, or nothing this page can show.
     * @type {Array<{ kind: 'file', index: any } | { kind: 'embedded', clipId: string, id: any, bitmap: boolean } | { kind: 'none' }>}
     */
    const subEntries = [];
    /** Clips whose embedded subtitle streams the controller lists already (a restarted decoder is not listed again). */
    const announced = new Set();
    /** The audio stream the user picked per clip: a restarted decoder plays it again. @type {Map<string, any>} */
    const audioPrefs = new Map();
    const subsCtl = () => /** @type {any} */ ((ui && /** @type {any} */ (ui).parts && /** @type {any} */ (ui).parts.subs) || null);
    /** A decoder's tracks() (media/engine.js), or null. @param {any} p */
    const tracksOf = (p) => { try { return p && typeof p.tracks === 'function' ? p.tracks() || null : null; } catch { return null; } };
    const trackErr = (/** @type {string} */ what) => (/** @type {any} */ err) => {
      if (!err || !err.disposed) log(`${what} failed: ${err && err.message || err}`);
    };

    /** ISO 639-2 bibliographic codes Intl.DisplayNames does not know (media/tracks-menu.js has the full list). */
    const ISO3 = /** @type {Record<string, string>} */ ({
      ger: 'de', fre: 'fr', dut: 'nl', chi: 'zh', cze: 'cs', gre: 'el', per: 'fa', rum: 'ro', slo: 'sk', ice: 'is',
      baq: 'eu', may: 'ms', arm: 'hy', geo: 'ka', alb: 'sq', wel: 'cy', bur: 'my', tib: 'bo', mac: 'mk', mao: 'mi',
    });
    /** @type {any} */
    let langNames;
    /** A language code in words in the UI language ('' for none or 'und'). @param {any} code */
    function langName(code) {
      if (!code || code === 'und') return '';
      const c = ISO3[String(code).toLowerCase()] || String(code);
      if (langNames === undefined) {
        try {
          const nav = win && win.navigator;
          langNames = new Intl.DisplayNames([(nav && nav.language) || 'en'], { type: 'language' });
        } catch { langNames = null; }
      }
      try {
        const n = langNames && langNames.of(c);
        return n && n !== c ? n[0].toUpperCase() + n.slice(1) : String(code);
      } catch { return String(code); }
    }
    const CHANNELS = /** @type {Record<number, string>} */ ({ 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' });
    /** A stream's label as media/tracks-menu.js trackLabel: its title, else its language, plus the details. @param {any} t @param {number} n */
    function trackLabel(t, n) {
      const main = t.title || langName(t.lang) || `Track ${n + 1}`;
      const sub = [t.title && langName(t.lang), t.channels ? CHANNELS[t.channels] || `${t.channels} ch` : '', t.codec]
        .filter(Boolean).join(' · ');
      return { main, sub };
    }
    /** One line for the subtitle list, which shows a name only (the codec tells PGS, DVD and DVB apart). @param {any} t @param {number} n */
    const trackName = (t, n) => { const l = trackLabel(t, n); return l.sub ? `${l.main} · ${l.sub}` : l.main; };

    /** The host's subtitle files (sidecars, loaded, HLS renditions), in the controller's order. @param {any} m */
    function noteSubFiles(m) {
      if (!subsCtl()) return;
      const SA = SubsApi();
      for (const f of Array.isArray(m.tracks) ? m.tracks : []) {
        /** @type {any} */
        let entry = { kind: 'none' };
        if (SA && f && f.data !== undefined && f.data !== null) {
          try {
            const parsed = SA.parse(f.data, String(f.name || ''));
            entry = { kind: 'file', index: new SA.CueIndex(parsed.cues) };
            log(`subtitles: ${f.name} (${parsed.format}, ${parsed.cues.length} cues)`);
          } catch (err) { log(`subtitles ${f && f.name}: ${err && /** @type {any} */ (err).message || err}`); }
        }
        subEntries.push(entry);
      }
    }

    /**
     * The clip's embedded subtitle streams join the controller's list once it is the shown clip. The stream flagged
     * default is chosen (text first, as media/tracks-menu.js), unless subtitles are on already; without a default
     * they stay off. True when listed now.
     * @param {string} id @param {any} [pl] the decoder (else the clip's)
     */
    function announceTracks(id, pl) {
      const ctl = subsCtl();
      if (!ctl || !ui || disposed || announced.has(id) || S.getTab(ui.getState()).tiles[0] !== id) return false;
      const tr = tracksOf(pl || players.get(id));
      const subs = tr && Array.isArray(tr.sub) ? tr.sub : [];
      if (!subs.length) return false;
      announced.add(id);
      const before = ctl.getState();
      const wasOn = before.track >= 0;
      const first = before.tracks.length;
      for (const t of subs) subEntries.push({ kind: 'embedded', clipId: id, id: t.id, bitmap: t.kind === 'bitmap' });
      // Off first: the controller would otherwise turn on the first new track by itself.
      if (!wasOn) ctl.select(-1);
      ui.onHostMessage(/** @type {any} */ ({ type: 'subs', tracks: subs.map((t, i) => ({ name: trackName(t, i), lang: t.lang || '' })) }));
      if (!wasOn) {
        let def = subs.findIndex((t) => t.default && t.kind !== 'bitmap');
        if (def < 0) def = subs.findIndex((t) => t.default);
        // Quietly, as media/tracks-menu.js autoChoose: the CC button shows it.
        if (def >= 0) ctl.select(first + def);
      }
      return true;
    }
    /**
     * The controller's subtitle track `track` (-1: off) on the decoders: the stream it names is demuxed by its clip's
     * decoder, every other decoder demuxes none. media/player-ui-tools.js calls it as engine.selectSubtitle.
     * @param {any} _id @param {number} track
     */
    function selectSubtitle(_id, track) {
      const e = subEntries[track];
      for (const [cid, p] of players) {
        if (!p || typeof p.selectSub !== 'function') continue;
        const tr = tracksOf(p);
        if (!tr) continue;
        const want = e && e.kind === 'embedded' && e.clipId === cid ? e.id : null;
        if ((tr.subId === undefined ? null : tr.subId) === want) continue;
        try { Promise.resolve(p.selectSub(want)).catch(trackErr('selectSub')); } catch (err) { trackErr('selectSub')(err); }
      }
      bitmapSubs.update();
    }
    /** The controller's track again (a restarted decoder demuxes nothing yet). */
    const syncSubSelection = () => { const ctl = subsCtl(); if (ctl) selectSubtitle(null, ctl.getState().track); };
    /**
     * The text of the controller's track `track` at `t` (s, the controller's time less the delay), or null: a file's
     * cues, or the embedded cues read so far. Picture subtitles are drawn by bitmapSubs instead.
     * @param {any} _id @param {number} t @param {number} track
     */
    function cueAt(_id, t, track) {
      const e = subEntries[track];
      const SA = SubsApi();
      if (!e || !SA || !Number.isFinite(t)) return null;
      const idx = e.kind === 'file' ? e.index
        : e.kind === 'embedded' && !e.bitmap ? (cueStore.get(e.clipId) || new Map()).get(String(e.id)) : null;
      if (!idx || typeof idx.at !== 'function' || (SA.BitmapCueIndex && idx instanceof SA.BitmapCueIndex)) return null;
      const cues = idx.at(t);
      return cues.length ? cues.map((/** @type {any} */ c) => SA.cueText(c)).join('\n') : null;
    }
    /** A decoder's cue (text, or a picture with its span and gen) into the clip's index. @param {string} id @param {any} c */
    function onSubCue(id, c) {
      const SA = SubsApi();
      if (disposed || !SA || !c || c.track === undefined || c.track === null) return;
      const key = String(c.track);
      let byTrack = cueStore.get(id);
      if (!byTrack) cueStore.set(id, (byTrack = new Map()));
      let idx = byTrack.get(key);
      if (c.span !== undefined) {
        if (!(idx instanceof SA.BitmapCueIndex)) byTrack.set(key, (idx = new SA.BitmapCueIndex()));
        idx.add(c);
      } else {
        const cue = SA.embeddedCue(c);
        if (!cue) return;
        if (!idx || idx instanceof SA.BitmapCueIndex) byTrack.set(key, (idx = new SA.CueIndex()));
        if (!idx.add(cue)) return;
      }
      scheduleSubsRender();
    }
    let subsRenderQueued = false;
    /** A cue arrived after its frame (the demuxer reads ahead or catches up after a seek): draw the overlay again, once. */
    function scheduleSubsRender() {
      if (subsRenderQueued) return;
      subsRenderQueued = true;
      Promise.resolve().then(() => {
        subsRenderQueued = false;
        if (disposed || !ui) return;
        ui.render();
        bitmapSubs.update();
      });
    }
    /** media/engine.js's onTracks: the streams are known or a selection changed. @param {string} id @param {any} pl */
    function onPlayerTracks(id, pl) {
      if (disposed) return;
      if (!announceTracks(id, pl)) syncSubSelection();
      const want = audioPrefs.get(id);
      const tr = tracksOf(pl);
      if (want !== undefined && tr && tr.audioId !== want && (tr.audio || []).some((/** @type {any} */ a) => a.id === want)
        && typeof pl.selectAudio === 'function') {
        try { Promise.resolve(pl.selectAudio(want)).catch(trackErr('selectAudio')); } catch (err) { trackErr('selectAudio')(err); }
      }
      if (controlsInst && typeof controlsInst.refresh === 'function') controlsInst.refresh();
    }

    /**
     * Picture subtitles (PGS, DVB, DVD) of the selected track: .subs-pic clips to the visible picture, .subs-frame
     * covers the whole picture (also zoomed past the view), media/subtitles.js BitmapRenderer draws the rects in it.
     */
    const bitmapSubs = (() => {
      /** @type {any} */ let box = null;
      /** @type {any} */ let frameEl = null;
      /** @type {any} */ let renderer = null;
      let placed = '';
      const ensure = () => {
        if (box) return true;
        const SA = SubsApi();
        const stage = doc.getElementById('stage');
        if (!SA || typeof SA.BitmapRenderer !== 'function' || !stage) return false;
        box = doc.createElement('div');
        box.className = 'subs-pic';
        box.hidden = true;
        frameEl = doc.createElement('div');
        frameEl.className = 'subs-frame';
        box.appendChild(frameEl);
        const subsEl = doc.getElementById('subs');
        if (subsEl && subsEl.parentNode === stage) stage.insertBefore(box, subsEl);
        else stage.appendChild(box);
        renderer = new SA.BitmapRenderer(frameEl);
        return true;
      };
      const hide = () => {
        if (box && !box.hidden) { box.hidden = true; placed = ''; }
        if (renderer) renderer.clear();
      };
      /** At the decoder's time: nothing between a seek and the first picture read after it (its worker's gen). */
      function update() {
        if (disposed || !ui) return;
        const ctl = subsCtl();
        const st = ctl ? ctl.getState() : null;
        const e = st ? subEntries[st.track] : null;
        const t = S.getTab(ui.getState());
        if (!e || e.kind !== 'embedded' || !e.bitmap || t.tiles.length !== 1 || t.tiles[0] !== e.clipId) { hide(); return; }
        const p = players.get(e.clipId);
        const idx = (cueStore.get(e.clipId) || new Map()).get(String(e.id));
        if (!p || !idx || typeof idx.at !== 'function' || typeof idx.prune !== 'function') { hide(); return; }
        let now = NaN;
        try { now = Number(p.currentTime()) - (Number(st.delayMs) || 0) / 1000; } catch { now = NaN; }
        if (!Number.isFinite(now)) { hide(); return; }
        idx.prune(now);
        const cues = typeof p.gen === 'number' && idx.gen < p.gen ? [] : idx.at(now);
        const r = cues.length ? pictureClientRect() : null;
        const stage = doc.getElementById('stage');
        if (!r || !stage) { hide(); return; }
        const sr = stage.getBoundingClientRect();
        const left = Math.max(r.left, sr.left);
        const right = Math.min(r.left + r.width, sr.left + sr.width);
        const top = Math.max(r.top, sr.top);
        const bottom = Math.min(r.top + r.height, sr.top + sr.height);
        if (right - left < 4 || bottom - top < 4 || !ensure()) { hide(); return; }
        const key = [left, top, right, bottom, r.left, r.top, r.width, r.height].map((n) => n.toFixed(1)).join(',');
        if (key !== placed) {
          placed = key;
          Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
          Object.assign(frameEl.style, {
            left: `${r.left - left}px`, top: `${r.top - top}px`, width: `${r.width}px`, height: `${r.height}px`,
          });
        }
        box.hidden = false;
        renderer.render(cues);
      }
      return {
        update: () => { try { update(); } catch (err) { log(`picture subtitles: ${err && /** @type {any} */ (err).message || err}`); } },
        dispose: () => { hide(); if (box && box.parentNode) box.parentNode.removeChild(box); box = null; },
      };
    })();

    // ---- the Audio track page of the settings panel: the clock decoder's sound streams ----
    /** The settings panel (VpeControls.create) the controller made, for a refresh when the streams change. @type {any} */
    let controlsInst = null;
    /** The panel's data with the clock decoder's sound streams (one stream: none to choose). @param {any} s */
    function audioView(s) {
      if (!s || typeof s !== 'object' || !s.tracks || typeof s.tracks !== 'object') return s;
      const tr = tracksOf(clockPlayerNow());
      const list = tr && Array.isArray(tr.audio) ? tr.audio : [];
      const audio = list.length > 1 ? list.map((/** @type {any} */ a, /** @type {number} */ i) => ({
        id: String(a.id), ...trackLabel(a, i), checked: a.id === tr.audioId,
      })) : [];
      const cur = Math.max(0, list.findIndex((/** @type {any} */ a) => a.id === tr.audioId));
      return { ...s, tracks: { ...s.tracks, audio }, audioLabel: list.length ? trackLabel(list[cur], cur).main : 'Default' };
    }
    /** The panel picked sound stream `id` of the clock decoder: true when switched here. @param {any} id */
    function pickAudio(id) {
      const cid = ui ? clockIdOf(S.getTab(ui.getState())) : null;
      const p = cid ? players.get(cid) : null;
      const tr = tracksOf(p);
      const list = tr && Array.isArray(tr.audio) ? tr.audio : [];
      const i = list.findIndex((/** @type {any} */ a) => String(a.id) === String(id));
      if (!cid || i < 0 || typeof p.selectAudio !== 'function') return false;
      audioPrefs.set(cid, list[i].id);
      const name = trackLabel(list[i], i).main;
      const failed = (/** @type {any} */ err) => {
        if (err && err.disposed) return;
        log(`selectAudio failed: ${err && err.message || err}`);
        toast('Could not switch the audio track');
      };
      let switching;
      try { switching = Promise.resolve(p.selectAudio(list[i].id)); } catch (err) { switching = Promise.reject(err); }
      switching.then(() => {
        toast(`Audio: ${name}`);
        if (controlsInst && typeof controlsInst.refresh === 'function') controlsInst.refresh();
      }, failed);
      return true;
    }
    /**
     * VpeControls with the real Audio track page: the controller's panel data gets the decoder's streams and its
     * selectAudio switches them (media/player-ui.js has a demo list for the mockup only).
     * @param {any} C
     */
    function wrapControls(C) {
      if (!C || typeof C.create !== 'function') return C;
      return {
        ...C,
        create: (/** @type {any} */ o) => {
          const act = o && o.act ? o.act : {};
          controlsInst = C.create({
            ...o,
            get: () => audioView(o.get()),
            act: { ...act, selectAudio: (/** @type {any} */ id) => { if (!pickAudio(id) && typeof act.selectAudio === 'function') act.selectAudio(id); } },
          });
          return controlsInst;
        },
      };
    }

    // ---- the pixel inspector (X): read-out, loupe, YUV, and the pixel grid at high zoom ----
    /** A LOUPE² RGBA block around canvas pixel (x, y) of the decoder's picture (transparent outside it), as media/inspect.js. */
    function readBlock(/** @type {any} */ p, /** @type {any} */ cv, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ n) {
      const h = n >> 1;
      const gl = p.gl && p.gl.gl;
      if (gl && typeof gl.readPixels === 'function') {
        const out = new Uint8ClampedArray(n * n * 4);
        const x0 = Math.max(0, x - h);
        const x1 = Math.min(cv.width, x + h + 1);
        const y0 = Math.max(0, y - h);
        const y1 = Math.min(cv.height, y + h + 1);
        if (x1 <= x0 || y1 <= y0) return out;
        const w = x1 - x0;
        const hh = y1 - y0;
        const buf = new Uint8Array(w * hh * 4);
        const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        // GL rows start at the bottom.
        gl.readPixels(x0, cv.height - y1, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
        for (let r = 0; r < hh; r++) {
          const src = (hh - 1 - r) * w * 4;
          out.set(buf.subarray(src, src + w * 4), ((y0 + r - (y - h)) * n + (x0 - (x - h))) * 4);
        }
        return out;
      }
      if (p.ctx && typeof p.ctx.getImageData === 'function') return p.ctx.getImageData(x - h, y - h, n, n).data;
      // Any other picture (a frame player's canvas, a bitmap): through an n×n scratch canvas.
      const src = typeof p.snapshotSource === 'function' ? p.snapshotSource() : cv;
      if (!src || typeof doc.createElement !== 'function') return null;
      const scratch = doc.createElement('canvas');
      scratch.width = n;
      scratch.height = n;
      const ctx = typeof scratch.getContext === 'function' ? scratch.getContext('2d') : null;
      if (!ctx || typeof ctx.getImageData !== 'function') return null;
      ctx.drawImage(src, x - h, y - h, n, n, 0, 0, n, n);
      return ctx.getImageData(0, 0, n, n).data;
    }
    /**
     * The source's code values under canvas pixel (x, y): CPU frames (the built-in decoder) at once, WebCodecs frames
     * through copyTo (a promise), as media/inspect.js; null when the decoder keeps neither.
     * @param {any} p @param {any} cv @param {number} x @param {number} y @param {number} rot
     */
    function yuvOf(p, cv, x, y, rot) {
      const I = W('VpeInspect');
      const shown = p.lastShown;
      if (!I || !shown || typeof I.displayToSource !== 'function') return null;
      try {
        if (shown.yuv && typeof I.yuvAt === 'function') {
          const [sx, sy] = I.displayToSource(x, y, cv.width, cv.height, rot, shown.yuv.width, shown.yuv.height);
          return I.yuvAt(shown.yuv, sx, sy) || null;
        }
        const vf = shown.vf;
        if (!vf || typeof I.vfSample !== 'function' || !vf.format || /^(RGBA|BGRA|RGBX|BGRX)$/.test(vf.format)) return null;
        const vr = vf.visibleRect || { x: 0, y: 0, width: vf.codedWidth, height: vf.codedHeight };
        const [sx, sy] = I.displayToSource(x, y, cv.width, cv.height, rot, vr.width, vr.height);
        const ax = vr.x + (sx & ~1);
        const ay = vr.y + (sy & ~1);
        const rect = { x: ax, y: ay, width: Math.min(2, vf.codedWidth - ax), height: Math.min(2, vf.codedHeight - ay) };
        const buf = new Uint8Array(vf.allocationSize({ rect }));
        return Promise.resolve(vf.copyTo(buf, { rect }))
          .then((layouts) => I.vfSample(vf.format, buf, layouts, vr.x + sx - ax, vr.y + sy - ay) || null, () => null);
      } catch { return null; } // a closed frame
    }
    const pixelHost = (() => {
      /** @type {any} */
      let inst = null;
      const ensure = () => {
        if (inst || disposed) return inst;
        const Tools = W('VpePlayerUiTools');
        const stage = doc.getElementById('stage');
        if (!Tools || typeof Tools.createPixelInspector !== 'function' || !stage) return null;
        const n = Number(Tools.LOUPE_PX) || 15;
        inst = Tools.createPixelInspector({
          doc, win, stageEl: stage,
          getTarget: () => {
            const p = clockPlayerNow();
            const cv = p && (p.cv || p.canvas);
            const rect = pictureClientRect();
            return rect && cv && cv.width > 0 && cv.height > 0 ? { rect, width: cv.width, height: cv.height } : null;
          },
          read: (/** @type {number} */ x, /** @type {number} */ y) => {
            const p = clockPlayerNow();
            const cv = p && (p.cv || p.canvas);
            if (!p || !cv) return null;
            let block = null;
            try { block = readBlock(p, cv, x, y, n); } catch { block = null; }
            /** @type {number[] | null} */
            let rgb = null;
            if (!block) {
              const px = /** @type {any} */ (adapter).pixelAt(clockIdOf(S.getTab(ui.getState())), x, y);
              if (px && Number.isFinite(px.r)) rgb = [px.r, px.g, px.b];
            }
            const rot = p.gl ? Number(p.gl.rot) || 0 : 0;
            return { block, rgb, rot, yuv: yuvOf(p, cv, x, y, rot) };
          },
          gridAllowed: () => !!ui && S.getTab(ui.getState()).tiles.length === 1,
        });
        return inst;
      };
      return {
        /** The inspection controller's inspector widget. @param {string | null} m */
        setMode: (m) => { const i = m ? ensure() : inst; if (i) i.setMode(m); },
        /** The picture moved or changed: the grid follows (made once the picture is zoomed), the read-out reads again. */
        refresh: () => {
          if (!inst && ui) {
            const t = S.getTab(ui.getState());
            if (!(t.zoom > 1 || (t.picMode && t.picMode !== 'fit'))) return;
            ensure();
          }
          if (inst) { try { inst.refresh(); } catch (err) { log(`inspector: ${err && /** @type {any} */ (err).message || err}`); } }
        },
        state: () => (inst ? inst.getState() : null),
        dispose: () => { if (inst) inst.dispose(); inst = null; },
      };
    })();

    // ---- Codec X-ray (Shift+X): media/xray.js's strip, its index for the keyframe keys, chapters ----
    /**
     * Runs fn with document keydown listeners left out: media/xray.js listens for Shift+X, { } and PageUp / PageDown
     * itself, which the shared controller routes here already (they would run twice).
     * @param {() => any} fn
     */
    function withoutKeydown(fn) {
      const d = G.document;
      if (!d || typeof d.addEventListener !== 'function') return fn();
      const own = Object.prototype.hasOwnProperty.call(d, 'addEventListener');
      const orig = d.addEventListener;
      d.addEventListener = function (/** @type {string} */ type, /** @type {any[]} */ ...rest) {
        return type === 'keydown' ? undefined : orig.call(this, type, ...rest);
      };
      try { return fn(); } finally { if (own) d.addEventListener = orig; else delete d.addEventListener; }
    }
    const xrayHost = (() => {
      /** @type {any} */
      let xr = null;
      /** The live keyframe list per clip (the controller keeps the first answer). @type {Map<string, any[]>} */
      const keyLists = new Map();
      const make = () => {
        if (xr || disposed) return xr;
        const create = W('createXray');
        const seek = doc.getElementById('seek');
        if (typeof create !== 'function' || !seek || !seek.parentElement) return null;
        try {
          xr = withoutKeydown(() => create({
            cfg, ui: { seek, tip: elOf('tip'), rate: elOf('rate') }, getPlayer: () => clockPlayerNow(), fmtTime: fmtClock,
            // The controller says on / off itself.
            toast: (/** @type {any} */ text, /** @type {any} */ ms) => { if (!/^Codec X-ray (on|off)\b/.test(String(text))) toast(text, ms); },
            log: (/** @type {any} */ s) => log(s),
          }));
        } catch (err) {
          log(`xray: ${err && /** @type {any} */ (err).message || err}`);
          xr = null;
        }
        return xr;
      };
      const state = () => { try { return xr && typeof xr._state === 'function' ? xr._state() : null; } catch { return null; } };
      return {
        show: () => { const x = make(); if (x && !x.isShown()) x.toggle(true); },
        hide: () => { if (xr && xr.isShown()) xr.toggle(false); },
        /**
         * The clip's keyframes as { key, t } (s from its start), read from the strip's index whenever the controller
         * looks (the index grows while the strip is open). null for a decoder without the built-in demuxer.
         * @param {string} id
         */
        packetIndex: (id) => {
          const p = players.get(id);
          if (!p || typeof p.onWorkerRead !== 'function' || !make()) return null;
          let list = keyLists.get(id);
          if (!list) {
            /** @type {any[]} */
            const arr = [];
            const refresh = () => {
              arr.length = 0;
              const st = state();
              if (!st || !st.n || st.p !== players.get(id)) return;
              const t0 = st.p.startT !== null && st.p.startT !== undefined ? Number(st.p.startT) : Number(st.base) || 0;
              for (let i = 0; i < st.n; i++) if (st.key[i]) arr.push({ key: true, t: st.pts[i] - t0 });
            };
            const READS = new Set(['filter', 'map', 'forEach', 'find', 'slice', Symbol.iterator]);
            list = new Proxy(arr, { get: (t, k, r) => { if (READS.has(k)) refresh(); return Reflect.get(t, k, r); } });
            keyLists.set(id, list);
          }
          return list;
        },
        /** The chapter ticks on the seek bar follow the clock decoder (media/xray.js chapterTicks). */
        tick: () => { if (xr && typeof xr.chapterTicks === 'function') { try { xr.chapterTicks(); } catch { /* no player */ } } },
        state,
        forget: (/** @type {string} */ id) => { keyLists.delete(id); },
        dispose: () => { if (xr && xr.isShown()) { try { xr.toggle(false); } catch { /* gone */ } } },
      };
    })();
    /**
     * The clip's chapters as { start (s from its start), title? }: the decoder's own, else the file's (media/engine.js
     * info), else what the X-ray index found.
     * @param {string} id
     */
    function chaptersOf(id) {
      const p = players.get(id);
      if (!p) return [];
      try { if (typeof p.chapters === 'function') return p.chapters() || []; } catch { return []; }
      const st = xrayHost.state();
      const ch = (p.info && Array.isArray(p.info.chapters) && p.info.chapters.length ? p.info.chapters
        : st && st.p === p && Array.isArray(st.chapters) ? st.chapters : []);
      const t0 = p.startT !== null && p.startT !== undefined ? Number(p.startT) || 0 : 0;
      return ch.map((/** @type {any} */ c) => ({ start: Number(c.start) - t0, ...(c.title ? { title: c.title } : {}) }))
        .filter((/** @type {any} */ c) => Number.isFinite(c.start));
    }

    // ---- a frame link (cfg.goto, or the session's): the controller lands on it once the decoder knows its frames ----
    /** @type {{ frame?: number, t?: number } | null} */
    let pendingGoto = cfg.goto && typeof cfg.goto === 'object' ? cfg.goto : null;
    /**
     * The controller seeked to the link when it was made, before the clip's length was known (its frame may have
     * been clamped): once the clock decoder showed its first picture, the link's frame is shown, paused, and the
     * controller's frame is that frame.
     * @param {string} id @param {any} p
     */
    function tryApplyGoto(id, p) {
      if (pendingGoto === null || disposed || !ui) return;
      const c = engine.getClip(id);
      const fps = (c && c.fps) || Number(p.fps) || 0;
      const frames = (c && c.frames) || Number(p.n) || 0;
      if (!(fps > 0 && frames > 1)) return;
      const g = pendingGoto;
      pendingGoto = null;
      let f = Number.isFinite(Number(g.frame)) ? Math.round(Number(g.frame)) - 1
        : Number.isFinite(Number(g.t)) ? Math.floor(Number(g.t) * fps + 1e-6) : NaN;
      if (!Number.isFinite(f)) return;
      f = Math.max(0, Math.min(frames - 1, f));
      if (S.getTab(ui.getState()).playing) ui.setState(S.togglePlay(ui.getState()));
      if (S.getTab(ui.getState()).frame !== f) { ui.dispatch('seek', f); return; }
      let shown = NaN;
      try { shown = typeof p.currentFrame === 'function' ? Number(p.currentFrame()) : NaN; } catch { shown = NaN; }
      if (shown !== f) applyToDecoders(S.getTab(ui.getState()), { seek: true, frame: f, force: true });
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
    const uiWidgets = W('VpeControls') ? { ...widgets, VpeControls: wrapControls(W('VpeControls')) } : widgets;
    ui = UiApi.create({
      doc, win, stateApi: S, engine, host, widgets: uiWidgets, initial,
      prefs: cfg.prefs, railCfg: cfg.rail || cfg.railCfg, storage: host.storage, goto: cfg.goto,
      fragment: win && win.location ? win.location.hash : null, railCarry: cfg.railCarry, page: cfg.page,
      tickMs: 0, onChange, onTransport,
      inspectWidgets: { scopes: scopesHost, inspector: pixelHost, xray: xrayHost },
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
      if (m.type === 'setVisible') {
        const hidden = m.visible === false;
        for (const p of players.values()) if (p && typeof p.setHidden === 'function') p.setHidden(hidden);
      }
      // Subtitle files join the subtitle controller's list (it shows them through cueAt).
      if (m.type === 'subs') noteSubFiles(m);
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
        // A tile may be named by its display index in the active tab instead of its clip id.
        const shown = ui ? S.getTab(ui.getState()).tiles : [];
        ids = m.tiles.map((/** @type {any} */ i) => (typeof i === 'number' ? shown[i] : i));
      } else if (players.size === 1) ids = [...players.keys()];
      else if (m.type === 'exactFrame' && exacts.size === 1) ids = [...exacts.keys()];
      for (const id of ids) {
        const p = players.get(id);
        // HLS: the Quality page's variants (media/player.js streamQ), what pictureInfo / transcodeInfo report.
        if (m.type === 'stream' && typeof id === 'string' && specs.has(id)) {
          if (m.quality && Array.isArray(m.quality.variants)) streams.set(id, m.quality);
          else streams.delete(id);
          if (ui) {
            ui.render();
            if (controlsInst && typeof controlsInst.refresh === 'function') controlsInst.refresh();
          }
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
     * The clip a lifecycle message is for: clipId / key, else the tile `index` (display order of the active tab),
     * else the one clip the active tab shows.
     * @param {any} m @returns {string | null}
     */
    function lifecycleClip(m) {
      const key = keyOf(m);
      if (key !== null) return specs.has(key) || players.has(key) ? key : null;
      const tiles = ui ? S.getTab(ui.getState()).tiles : [...specs.keys()];
      if (typeof m.index === 'number') {
        const id = tiles[m.index];
        if (typeof id === 'string') return id;
      }
      return tiles.length === 1 ? tiles[0] : null;
    }

    /**
     * The clip's decoder starts over (another decoder kind, the host's new meta): the old one closes, the new one is
     * sought to the clip's place and given the tab's play state, rate and loop.
     * @param {string} id
     */
    function restartPlayer(id) {
      const had = players.has(id);
      const tBefore = ui ? S.getTab(ui.getState()) : null;
      if (had && tBefore && tBefore.tiles.includes(id) && (tBefore.frame > 0 || tBefore.playing)) {
        pendingRestore.set(id, { frame: tBefore.frame, playing: tBefore.playing });
      }
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
          if (spec && meta) {
            const patch = /** @type {any} */ ({ ...spec });
            if (typeof meta.native === 'boolean') patch.native = meta.native;
            if (meta.live !== undefined) patch.live = !!meta.live;
            if (meta.url) { patch.sourceKind = 'url'; patch.kind = 'url'; }
            if (typeof meta.host === 'string' && meta.host) patch.host = meta.host;
            specs.set(id, patch);
            learnClip(patch);
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
      const rSec = !m.goto && !cfg.goto ? resumeSecOf(m.savedPos) : null;
      if (rSec !== null) pendingResumeSec = rSec;
      // A frame link the session carries (the page booted without it): it opens paused on that frame.
      if (!cfg.goto && m.goto && typeof m.goto === 'object' && pendingGoto === null) {
        pendingGoto = m.goto;
        pendingResumeSec = null;
        pendingAutoPlay = false;
      }
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
    /**
     * Layout properties read from the visible tile canvas in #cells (its style: the nearest-neighbour drawing at high
     * zoom); pixel buffer props read from the decoder canvas.
     */
    const LAYOUT_PROPS = new Set(['getBoundingClientRect', 'offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight', 'hidden', 'style']);
    /** The clock tile's canvas (its decoder's own), else the page's #canvas: what the probe measures and reads. */
    const liveCanvas = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'getBoundingClientRect') {
          return () => {
            const r = pictureClientRect();
            if (r) return { left: r.left, top: r.top, x: r.left, y: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
            const cellCv = visibleCellCanvas();
            return cellCv && typeof cellCv.getBoundingClientRect === 'function'
              ? cellCv.getBoundingClientRect()
              : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
          };
        }
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
          return typeof v === 'function' && !/^[A-Z]/.test(String(k)) ? v.bind(t) : v;
        },
      });
      const panelButtons = () => Array.from(elOf('panel').querySelectorAll('button') || []);
      /**
       * The seek-bar thumbnail as the probe reads it (`#thumb` holding a canvas, media/player.js): the unified page's
       * one canvas.seek-thumb in #seekRow (media/player-ui.js), wrapped.
       */
      const thumbView = () => {
        const c = typeof doc.querySelector === 'function' ? doc.querySelector('canvas.seek-thumb') : null;
        if (!c) return null;
        return {
          id: 'thumb', get hidden() { return !!c.hidden; },
          querySelector: () => c, getBoundingClientRect: () => c.getBoundingClientRect(),
        };
      };
      const probeDoc = new Proxy(doc, {
        get: (t, k) => {
          if (k === 'getElementById') return (/** @type {string} */ id) => t.getElementById(id) || (id === 'thumb' ? thumbView() : null);
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      try {
        return Probe.install({
          log, win: probeWin, doc: probeDoc,
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
            if (label === 'Details') { act('info'); return true; }
            if (label === 'Scopes') { act('scopes'); return true; }
            const b = panelButtons().find((x) => ((x.getAttribute && x.getAttribute('aria-label')) || x.textContent || '').trim().startsWith(label));
            if (b) b.click();
            return !!b;
          },
          getToolCount: () => (tabNow().tiles.length >= 2 ? 4 : 5),
          getState: () => {
            const pr = prefsNow() || {};
            return {
              prefs: pr, volume: Number(pr.volume) || 0, muted: !!pr.muted, loop: loopPref(pr), onEnd: pr.onEnd,
              rail: ux().rail && typeof ux().rail.snapshot === 'function' ? ux().rail.snapshot() : null,
              streamQ: streams.get(clockIdOf(tabNow())) || null, loopStats: { ...loopStats },
              loopBusy: tickPending ? 'busy' : 'rest',
              picturePct: (() => {
                const cellCv = visibleCellCanvas();
                const base = cellCv && typeof cellCv.getBoundingClientRect === 'function' ? cellCv.getBoundingClientRect() : null;
                if (!ui || !base || !(base.width > 0 && base.height > 0) || typeof engine.pictureRect !== 'function') return null;
                const t = tabNow();
                const cid = clockIdOf(t);
                const c = cid ? engine.getClip(cid) : null;
                const natW = (c && c.width) || 0;
                if (!(natW > 0)) return null;
                const r = engine.pictureRect(cid, base.width, base.height, t.picMode, t.zoom, t.panX, t.panY);
                const dpr = (win && Number(win.devicePixelRatio) > 0) ? Number(win.devicePixelRatio) : 1;
                return r && r.w > 0 ? Math.round((r.w * dpr / natW) * 100) : null;
              })(),
              seekDragging: !!(ui && typeof /** @type {any} */ (ui).dragState === 'function' && /** @type {any} */ (ui).dragState().seek),
              volumeDragging: !!(ui && typeof /** @type {any} */ (ui).dragState === 'function' && /** @type {any} */ (ui).dragState().volume),
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
        get order() { return t().tiles.map((/** @type {string} */ _id, /** @type {number} */ i) => i); },
        get offsets() { return t().tiles.map((/** @type {string} */ id) => (S.getOffset ? S.getOffset(t(), id) : { v: 0, unit: 'frames' })); },
        get pic() { return { mode: t().picMode, zoom: t().zoom, cx: 0.5, cy: 0.5 }; },
        get rate() { return ratePrefs(); }, get loop() { return loopPref(prefsNow()); },
        get sel() { return sel; }, set sel(v) { sel = Number(v) || 0; },
        get thresh() { return thresh; }, set thresh(v) { thresh = Number(v) || 0; },
      };
      const cellsEl = elOf('cells');
      const picRectFor = (/** @type {string | undefined} */ cid, /** @type {{ x: number, y: number, w: number, h: number }} */ box) => {
        if (!cid || typeof engine.pictureRect !== 'function') return { ...box };
        const tab = t();
        const r = engine.pictureRect(cid, box.w, box.h, tab.picMode, tab.zoom, tab.panX, tab.panY);
        return r && r.w > 0 ? { x: box.x + r.x, y: box.y + r.y, w: r.w, h: r.h } : { ...box };
      };
      const cells = () => {
        const o = cellsEl.getBoundingClientRect();
        const tab = t();
        if (tab.layout === 'split' && tab.tiles.length === 2) {
          const first = cellsEl.children[0];
          const r = first ? first.getBoundingClientRect() : o;
          const box = { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
          const full = picRectFor(tab.tiles[0], box);
          return [/** @type {any} */ ({ ...box, tiles: [0, 1], full, pic: { ...box } })];
        }
        return Array.from(cellsEl.children || []).map((/** @type {any} */ d, /** @type {number} */ i) => {
          const r = d.getBoundingClientRect();
          const box = { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
          const add = !!(d.classList && d.classList.contains('add'));
          const full = add ? { ...box } : picRectFor(tab.tiles[i], box);
          return /** @type {any} */ ({ ...box, ...(add ? { add: true } : { tiles: [i] }), full, pic: { ...box } });
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
          frameFactor: () => {
            const tab = t();
            const c = cells().find((x) => !x.add);
            if (!c || !tab.tiles[0] || typeof engine.pictureRect !== 'function') return 1;
            const fit = engine.pictureRect(tab.tiles[0], c.w, c.h, 'fit', 1, 0, 0);
            if (!fit || !(fit.w > 0 && fit.h > 0)) return 1;
            return Math.max(1, c.full.w / fit.w, c.full.h / fit.h);
          },
          picState: () => {
            const tab = t();
            const c = cells().find((x) => !x.add);
            const cid = tab.tiles[0];
            const clip = cid ? engine.getClip(cid) : null;
            if (!c || !clip || !(clip.width > 0)) return { pct: null };
            const dpr = (win && Number(win.devicePixelRatio) > 0) ? Number(win.devicePixelRatio) : 1;
            return { pct: Math.round((c.full.w * dpr / clip.width) * 100) };
          },
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
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('pagehide', dispose);
        win.removeEventListener('resize', onResize);
      }
      if (debugProbe) { try { debugProbe.dispose(); } catch { /* ignore */ } }
      scopesHost.dispose();
      pixelHost.dispose();
      bitmapSubs.dispose();
      xrayHost.dispose();
      compareDebugGen++; // an installed Compare probe matches no message any more
      for (const id of [...players.keys()]) disposePlayer(id);
      for (const x of [sync, compositor]) if (x && typeof x.dispose === 'function') { try { x.dispose(); } catch { /* ignore */ } }
      try { ui.dispose(); } catch { /* ignore */ }
      host.dispose();
    }
    if (win && typeof win.addEventListener === 'function') win.addEventListener('pagehide', dispose, { once: true });
    // Picture subtitles and the pixel grid are placed in client px: a resized view places them again.
    function onResize() { if (!disposed) { bitmapSubs.update(); pixelHost.refresh(); } }
    if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);

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
        VpeScopes: typeof VpeScopes !== 'undefined' ? VpeScopes : undefined,
        VpeInspect: typeof VpeInspect !== 'undefined' ? VpeInspect : undefined,
        // media/xray.js's strip (a global function) and media/subtitles.js (globalThis.Subtitles).
        createXray: typeof createXray !== 'undefined' ? createXray : undefined,
        Subtitles: typeof Subtitles !== 'undefined' ? Subtitles : undefined,
        VpeHdr: typeof VpeHdr !== 'undefined' ? VpeHdr : undefined,
        VpeExact: typeof VpeExact !== 'undefined' ? VpeExact : undefined,
        VpeFramePlayer: typeof VpeFramePlayer !== 'undefined' ? VpeFramePlayer : undefined,
        VpeDebugProbe: typeof VpeDebugProbe !== 'undefined' ? VpeDebugProbe : undefined,
        VpeCompareDebug: typeof VpeCompareDebug !== 'undefined' ? VpeCompareDebug : undefined,
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
