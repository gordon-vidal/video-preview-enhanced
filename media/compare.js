/* global createEngine, VpeControls, VpeModes */
// @ts-check
// Compare / multi-view: 2-16 videos (up to compare.maxVideos) on one
// transport, frame accurate, with the player's own bar and panels (docs/notes/compare-ui.md, the approved
// mock-up; docs/notes/multiview-engine.md for more than 4).
//
// Design:
// - One LibavPlayer engine per tile (engine.js, used as it is), each with its own detached
//   canvas and message key ('A'-'P'), so the host serves each file's blocks, or runs native
//   ffmpeg for that tile with frames at the tile's size. From 5 tiles on, the engines share one
//   WebGL renderer (sharedRenderer) and split fixed memory budgets (media/compare-grid.js).
// - One tile is the clock (the first by default): its own clock (audio, or timer) drives
//   playback, frame steps move it and the seek bar counts its frames. Every other tile follows:
//   its clock is replaced by the clock's time plus the offsets (per tile, in ms or in that tile's
//   own frames; positive = a later moment of that video). Sound comes from one chosen tile;
//   the others are muted.
//   Paused, every follower is moved to the frame nearest the clock's shown frame (plus offsets),
//   and the view only updates once every tile shows its frame, so a step always shows matching frames.
// - One visible WebGL2 canvas covers the picture area and draws each tile's engine canvas (uploaded
//   as a texture when it changes, mipmapped) fitted into its cell: 2 tiles side by side or split
//   (one picture, a draggable divider); 3-4 tiles a 2x2 grid (with an "Add video" cell for 3); more a
//   plain automatic grid (3x2, 3x3, 4x3, 4x4).
//   Over each cell, a DOM layer shows on hover: the name pill (letter, name, clock / sound, the
//   tile's frame number) and the ‹ offset › nudge. Right-click on a tile: that tile's actions.
// - The bar is the player's (src/bar.js); the panels are the player's (media/controls.js) plus the
//   Compare panel and its per-video page.
// - Kept for a future advanced mode, not reachable from the UI (2026-11-20): metrics
//   (PSNR Y/RGB, SSIM Y of A against B, logged in debug builds) and the search for the first frame
//   below a PSNR threshold (a hidden pair of engines), through window.vpeCompare and the test hook.
'use strict';
(function () {
  // @ts-ignore
  const api = acquireVsCodeApi();
  const cfg = JSON.parse(/** @type {HTMLElement} */ (document.getElementById('cfg')).textContent || '{}');
  // Every message carries this page's id: the host ignores a replaced page's late messages, and this
  // page ignores replies meant for the one before it (a reload reuses the tile keys).
  const vscode = {
    postMessage: (m) => api.postMessage({ ...m, page: cfg.page }),
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
  };
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const stage = $('stage'), canvas = $('canvas'), cellsEl = $('cells');
  const ui = {
    bar: $('bar'), play: $('play'), prev: $('prev'), next: $('next'), seek: $('seek'), tip: $('tip'), time: $('time'), now: $('now'), dur: $('dur'),
    mute: $('mute'), volume: $('volume'), rate: $('rate'), cog: $('cog'), infoBtn: $('infoBtn'), keysBtn: $('keysBtn'), picBtn: $('picBtn'), cmpBtn: $('cmpBtn'), full: $('full'),
    panel: $('panel'), sheet: $('sheet'), menu: $('menu'), toast: $('toast'), live: $('live'),
    overlay: $('overlay'), message: $('message'), hint: $('hint'),
  };
  const names = cfg.names || ['A', 'B'];
  const Grid = /** @type {any} */ (globalThis).CompareGrid;
  /** Tiles in this panel (up to compare.maxVideos). */
  const N = names.length;
  const KEYS = Grid.TILE_KEYS;
  /** Videos this panel may show (the setting; the host enforces it too). */
  const MAX_TILES = Math.max(N, Grid.clampMax(cfg.maxVideos));
  /** 5 tiles or more: one shared renderer, divided budgets, a plain grid. 2-4 tiles are unchanged. */
  const largeGrid = Grid.isLarge(N);
  /** Metrics and the difference search: kept in code for a future advanced mode; only debug builds run them. */
  const INTERNAL = !!cfg.debug;

  const log = (/** @type {any[]} */ ...a) => vscode.postMessage({ type: 'log', msg: a.map(String).join(' ') });
  window.addEventListener('error', (e) => log('error:', e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('unhandled rejection:', e.reason && e.reason.stack || e.reason));

  const saved = vscode.getState() || {};
  const tileOr0 = (i) => (Number.isInteger(i) && i >= 0 && i < N ? i : 0);
  const reorderBtn = $('reorderBtn'), reorderHint = $('reorderHint');
  let reordering = false;
  let reorderDrag = null;
  const prefs = {
    ...cfg.prefs,
    jump: { arrow: 5, shift: 1, ctrl: 'frame', ...cfg.prefs?.jump },
    stepButtons: cfg.prefs?.stepButtons || 'frame',
  };
  const Pic = VpePicture;
  const st = {
    // The picture size, zoom and pan, one for every tile (media/picture.js): this tab starts as the setting and keeps its own choice.
    pic: Pic.fresh(Pic.parse(saved.pic || (cfg.prefs && cfg.prefs.pictureSize))),
    // 2 videos: side by side or split (an older 'wipe' is the split, 'toggle' is gone); 3-4: the grid.
    mode: N > 2 ? 'grid' : N === 2 && (saved.mode === 'split' || saved.mode === 'wipe') ? 'split' : 'side',
    split: typeof saved.split === 'number' ? saved.split : 0.5,
    order: Grid.tileOrder(N, saved.order, saved.swap),
    /** Per tile: offset value and unit ('frames' of that tile, or 'ms'). */
    offsets: names.map((_, i) => {
      const o = saved.offsets && saved.offsets[i];
      if (i === cfg.replaced) return { unit: 'frames', v: 0 }; // a replaced video starts in step
      if (o && (o.unit === 'ms' || o.unit === 'frames') && isFinite(o.v)) return { unit: o.unit, v: o.v };
      return { unit: 'frames', v: i === 1 && typeof saved.offset === 'number' ? saved.offset : 0 }; // older state: B's offset in frames
    }),
    clock: tileOr0(saved.clock), sound: tileOr0(saved.sound), sel: tileOr0(saved.sel ?? 1), infoSel: 0,
    rate: VpeControls.clampRate(saved.rate || 1), volume: saved.volume !== undefined ? saved.volume : 1, muted: !!saved.muted,
    loop: saved.loop !== undefined ? saved.loop : true, thresh: saved.thresh || 40, metrics: INTERNAL, timeMode: Number(saved.timeMode) || 0,
  };

  // Decoder keys and per-video state use the host's indices. Only the display slots move.
  const displayOrder = () => reorderDrag?.preview || st.order;
  const tileLabel = (i) => KEYS[st.order.indexOf(i)];

  // Screen readers: toasts and messages go to one polite live region (#live).
  let liveTimer = 0;
  function announce(text) {
    if (!ui.live || !text) return;
    ui.live.textContent = ''; // cleared first, so the same text twice is read twice
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { ui.live.textContent = text; }, 50);
  }
  let toastTimer = 0;
  function toast(text, ms = 1500) {
    announce(text);
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
  }
  /** @type {Record<string, string>} */
  const msgs = { host: '' };
  names.forEach((_, i) => { msgs[KEYS[i]] = ''; });
  function showMessage(from, text, sub = '') {
    msgs[from] = text ? `${from === 'host' ? '' : `${from}: `}${text}` : '';
    const lines = Object.values(msgs).filter(Boolean);
    if (text && lines.join('\n') !== ui.message.textContent) announce(sub ? `${msgs[from]} ${sub}` : msgs[from]);
    ui.message.textContent = lines.join('\n');
    ui.hint.textContent = text ? sub : ui.hint.textContent;
    ui.overlay.hidden = !lines.length;
    if (!lines.length) ui.hint.textContent = '';
  }
  showMessage('host', 'Opening…');

  /** m:ss.mmm (h:mm:ss.mmm), as the player shows it. */
  const fmtTime = (/** @type {number} */ t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t - h * 3600 - m * 60;
    const whole = Math.floor(sec + 1e-6);
    return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(whole).padStart(2, '0')}.${String(Math.min(999, Math.floor((sec - whole) * 1000 + 1e-6))).padStart(3, '0')}`;
  };
  /** SMPTE timecode hh:mm:ss:ff of frame index f (non-drop, at the rounded frame rate). */
  const fmtTimecode = (/** @type {number} */ f, /** @type {number} */ fps) => {
    const r = Math.max(1, Math.round(fps || 30));
    const secs = Math.floor(f / r);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(f % r)}`;
  };

  // ---- engines ----------------------------------------------------------------

  /** @type {Record<string, any>} key -> LibavPlayer */
  const engines = {};
  let sizes = names.map(() => 0);
  /** @type {boolean[]} tiles the host decodes with native ffmpeg */
  let nativeTiles = names.map(() => false);

  /**
   * A LibavPlayer drawing into its own detached canvas, with blocks requested under `key`
   * ('A'-'D' for the tiles, 'sA' / 'sB' for the scan, which never decodes sound).
   */
  function makeEngine(key, { quiet, budget }) {
    const cv = document.createElement('canvas');
    const file = Math.max(0, KEYS.indexOf(key.slice(-1)));
    const env = {
      page: cfg.page,
      vscode: {
        postMessage: (m) => {
          if (nativeTiles[file] === 'transcode' && m.type === 'nd' && m.m.type === 'open') {
            m = { ...m, m: { ...m.m, hidden: !visible || document.hidden } };
          }
          vscode.postMessage({ ...m, key });
        },
        getState: () => ({}), setState() {},
      },
      canvas: cv,
      log: (...a) => log(`[${key}]`, ...a),
      showMessage: (text, sub) => { if (!quiet) showMessage(key, text, sub); else if (text) scanner.fail(`${key}: ${text}`); },
      toast: (t) => { if (!quiet) toast(`${key}: ${t}`); },
      getState: () => ({}),
      setMuteUi: (m) => { if (key === KEYS[st.sound]) setMute(m); },
      onReady: () => onEngineReady(key),
      onMeta: () => onEngineMeta(key),
      wake: () => wakeLoop(),
      createRenderer: largeGrid && !quiet ? (Renderer) => sharedRenderer(Renderer, cv, file) : undefined,
    };
    const eng = createEngine(env);
    const p = new eng.LibavPlayer({ size: sizes[file], duration: 0, label: '', native: !quiet && !!nativeTiles[file] },
      { ...cfg.engine, mem: memory.engine, rotation: (cfg.rotation || [])[file] || 0, noStepBack: true, ...(largeGrid ? { largeGrid: true } : {}) });
    p.cv = cv;
    p.key = key;
    p.budget = () => budget;
    p.setLoop(false);
    if (!largeGrid) captureLuma(p); // metrics are for 2 videos; a clone of every frame of 16 tiles is not free
    if (quiet) {
      const streams = p.onStreams.bind(p);
      p.onStreams = (info) => streams({ ...info, audio: null });
      p.slowWarned = true;
    }
    // Followers (every tile but the clock, both scan engines) never slow the clock down for their
    // own decoding; they drop frames instead. Tiles keep their sound: one of them plays it.
    p.isFollower = !!quiet;
    Object.defineProperty(p, 'behindUntil', { get: () => (p.isFollower ? 0 : p.behindRaw || 0), set: (v) => { p.behindRaw = v; }, configurable: true });
    engines[key] = p;
    return p;
  }

  /**
   * Keeps the last drawn frame's source so metrics can use the decoded luma plane
   * itself (exact, like ffmpeg) instead of luma recovered from RGB. Wraps this
   * engine's renderer instance only; GLRenderer itself is untouched.
   * Software frames: a reference to the YUV object (read on demand; if a later
   * frame path recycles or detaches its buffer, metrics fall back to RGB).
   * WebCodecs frames: a clone of the VideoFrame (released when the next one is drawn).
   */
  function captureLuma(p) {
    const g = p.gl;
    if (!g || typeof g.drawYuv !== 'function' || typeof g.drawFrame !== 'function') return;
    const drawYuv = g.drawYuv.bind(g);
    const drawFrame = g.drawFrame.bind(g);
    const keep = (snap) => {
      const old = p.lumaSrc;
      if (old && old.vf) { try { old.vf.close(); } catch { /* closed */ } }
      p.lumaSrc = snap;
    };
    g.drawYuv = (f) => { keep({ yuv: f }); return drawYuv(f); };
    g.drawFrame = (vf) => {
      let c = null;
      try { c = vf.clone(); } catch { /* unsupported */ }
      keep(c ? { vf: c } : null);
      return drawFrame(vf);
    };
    const dispose = p.dispose.bind(p);
    p.dispose = () => { keep(null); dispose(); };
  }

  /** The shown frame's luma plane as {data, w, h, depth}, or null when it can't be had. */
  async function lumaOf(p) {
    const s = p.lumaSrc;
    if (!s) return null;
    if (s.luma !== undefined) return s.luma;
    let out = null;
    try {
      if (s.yuv) {
        const f = s.yuv;
        const depth = f.depth || 8;
        const L = f.layout && f.layout[0];
        if (L && f.data && f.data.byteLength) {
          const w = f.width, h = f.height;
          if (depth > 8) {
            const src = new Uint16Array(f.data.buffer, f.data.byteOffset, f.data.byteLength >> 1);
            const d = new Uint16Array(w * h);
            const o = L.offset >> 1, st2 = L.stride >> 1;
            for (let y = 0; y < h; y++) d.set(src.subarray(o + y * st2, o + y * st2 + w), y * w);
            out = { data: d, w, h, depth };
          } else {
            const d = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) d.set(f.data.subarray(L.offset + y * L.stride, L.offset + y * L.stride + w), y * w);
            out = { data: d, w, h, depth };
          }
        }
      } else if (s.vf) {
        const vf = s.vf;
        // Planar or semi-planar 8-bit: plane 0 is luma.
        if (/^(I420|I420A|I422|I444|NV12)$/.test(vf.format || '')) {
          const vr = vf.visibleRect || { x: 0, y: 0, width: vf.codedWidth, height: vf.codedHeight };
          const buf = new Uint8Array(vf.allocationSize());
          const layout = await vf.copyTo(buf);
          const L = layout[0];
          const vw = vr.width, vh = vr.height;
          const d = new Uint8Array(vw * vh);
          for (let y = 0; y < vh; y++) {
            const o = L.offset + (vr.y + y) * L.stride + vr.x;
            d.set(buf.subarray(o, o + vw), y * vw);
          }
          out = { data: d, w: vw, h: vh, depth: 8 };
        }
      }
    } catch (e) {
      log(`luma read failed: ${e && e.message || e}`);
      out = null;
    }
    if (p.lumaSrc === s) s.luma = out;
    return out;
  }

  /** @type {any[]} the tiles' engines, indexed by the host's file order */
  let tiles = [];
  /** @type {any} the clock tile's engine */
  let clock = null;
  let begun = false;

  // Memory: the host sizes budgets from the machine (media/membudget.js; null in remote windows = the
  // 32 GB values). Every tile runs its own decoders, so they share the machine's budget (review 2026-11-19-3 M3).
  // A large grid in a remote window sizes from this client's memory: 16 tiles at the 32 GB defaults would be 6 GB.
  const MemBudget = /** @type {any} */ (globalThis).MemBudget;
  const MEM = (cfg.engine && cfg.engine.mem)
    || (largeGrid && MemBudget ? MemBudget.fromDeviceMemory(/** @type {any} */ (navigator).deviceMemory) : null);
  /** Each tile's budgets (media/compare-grid.js): frames it keeps decoded, its engine's mem. */
  const memory = Grid.tileMemory(MEM, N);
  const fpsOf = (p) => (p && p.fps) || 30;
  /** Index of the shown frame; unlike currentFrame() also right before the frame count is known. */
  const frameOf = (p) => (p.shownT === null ? 0 : Math.max(0, Math.floor(p.rel(p.shownT) * fpsOf(p) + 0.01)));
  /** Seconds a frame may be shown early in engine.tick(): a quarter frame. */
  const earlyOf = (p) => 0.25 / fpsOf(p);
  /** Tile i's offset in seconds: ms, or frames of that tile at its own frame rate. */
  const offSec = (i) => { const o = st.offsets[i]; return o.unit === 'ms' ? o.v / 1000 : o.v / fpsOf(tiles[i]); };
  /** Tile i's position (relative seconds) for the clock at cRel: the same moment plus the offsets, nearest frame. */
  const relFor = (i, cRel) => cRel - offSec(st.clock) + offSec(i) + 0.25 / fpsOf(tiles[i]);
  /** The clock's position at which tile i is at rel (relFor's inverse, without the nudge). */
  const clockRelFor = (i, rel) => rel - offSec(i) + offSec(st.clock);
  const outOfRange = (p, rel) => !!p && (rel < -0.5 / fpsOf(p) || (p.meta.duration > 0 && rel > p.meta.duration + 0.5 / fpsOf(p)));

  /** The engine shows the newest frame due at its pause position, and no later frame is due. */
  function settled(p) {
    if (p.seekTarget !== null || p.shownT === null || p.startT === null) return false;
    const due = p.pauseT + earlyOf(p);
    if (p.shownT > due + 1e-6) return false;
    return p.queue.length ? p.queue[0].t > due : !!p.eof;
  }

  /**
   * The first picture of a tile sits at its start and nothing earlier or later can be due: the tile need not wait for
   * its second frame to be decoded (settled does), which a slow soft decoder takes a few hundred ms for.
   */
  function atFirstFrame(p) {
    return p.seekTarget === null && p.shownT !== null && p.startT !== null && p.shownT === p.startT &&
      p.pauseT + earlyOf(p) < p.startT + 0.75 / fpsOf(p);
  }

  function onEngineReady(key) {
    if (key.length > 1) { scanner.onReady(key); return; }
    const p = engines[key];
    if (p?.remoteStream) {
      if (visible && !p.hidden) p.worker.postMessage({ type: 'hidden', on: false });
      else p.setHidden(!visible);
    }
    if (tiles.length === N && tiles.every((p) => p.vmode !== undefined) && !begun) begin();
  }
  /** Frame rate each tile's frame offsets were last synced with (30 is assumed before the engine knows). */
  const syncedFps = {};
  function onEngineMeta(key) {
    if (clock && key === clock.key) ui.seek.max = String(Math.max(0, (clock.n || 1) - 1));
    infoDirty = true;
    if (controls.view() === 'info' && KEYS[st.infoSel] === key) controls.refresh();
    if (largeGrid && key === KEYS[0]) requestTileSize(); // the first tile's shape sizes the native tiles
    // A frame offset synced with the assumed 30 fps is redone with the real rate (review 2026-11-19 #7).
    const i = tiles.findIndex((p) => p.key === key);
    if (i < 0) return;
    const fps = fpsOf(tiles[i]);
    const was = syncedFps[key] === undefined ? 30 : syncedFps[key];
    syncedFps[key] = fps;
    if (was === fps || !begun) return;
    if (st.offsets.some((o) => o.unit === 'frames' && o.v)) {
      reqs = [];
      if (isPlaying()) syncPlaying(true);
      refreshPanel();
    }
  }

  function begin() {
    begun = true;
    requestTileSize();
    for (const p of tiles) p.setRate(st.rate);
    applyVolume();
    clock.setLoop(st.loop);
    ui.seek.max = String(Math.max(0, (clock.n || 1) - 1));
    if (saved.t > 0) pendingStart = saved.t;
    log(`begin: ${tiles.map((p, i) => `${KEYS[i]} ${p.meta.width}x${p.meta.height} ${p.vmode}${p.cfg.native ? ' native' : ''}`).join(', ')}; clock ${KEYS[st.clock]}, sound ${KEYS[st.sound]}`);
  }
  let pendingStart = 0;

  /** The clock's position for the others to follow: the frame it shows (its clock while it seeks). */
  const clockPos = () => clock.rel(clock.shownT !== null && clock.seekTarget === null ? clock.shownT : clock.now());
  /** Tile i follows the clock while playing; it never slows the clock down for its own decoding (it drops frames). */
  function followClock(p, i) {
    p.isFollower = true;
    p.now = function () {
      if (!this.playing || this.startT === null || !clock || clock.startT === null) return this.pauseT;
      return this.startT + relFor(i, clockPos());
    };
  }

  /** Tile i becomes the clock: its own clock comes back, every other tile follows it. */
  function setClock(i, quiet) {
    const was = isPlaying();
    // Followers record their paused positions with the old clock's offset, so pause before it changes.
    pause();
    st.clock = tileOr0(i);
    if (tiles.length) {
      tiles.forEach((p, j) => {
        if (j === st.clock) { delete p.now; p.isFollower = false; } else followClock(p, j);
        p.setLoop(j === st.clock && st.loop);
      });
      clock = tiles[st.clock];
      ui.seek.max = String(Math.max(0, (clock.n || 1) - 1));
      reqs = [];
      lastGen = -1;
      if (was) play();
    }
    infoDirty = true;
    updateOverlays();
    lastUi = '';
    refreshPanel();
    save();
    if (!quiet) toast(`Clock: ${tileLabel(st.clock)} · seek bar and frame steps follow it`);
  }

  // ---- transport ---------------------------------------------------------------

  const isPlaying = () => !!clock && clock.playing;
  function play() {
    if (!clock) return;
    // Followers move while playing: the next pause sends each of them again, even to the same position.
    reqs = [];
    if (clock.eof && !clock.queue.length && clock.currentFrame() >= clock.n - 1) seekClock(0);
    clock.play();
    syncPlaying();
  }
  function pause() { for (const p of tiles) p.pause(); }
  const togglePlay = () => (isPlaying() ? pause() : play());

  /** Seek the clock (relative seconds); the others follow at once when playing, after it settles when paused. */
  function seekClock(rel) {
    if (!clock) return;
    clock.seekTime(rel);
    if (clock.playing) syncPlaying(true);
  }
  /** Shows frame `frame` of tile i (through the clock). */
  function seekTile(i, frame) {
    if (!clock) return;
    if (i === st.clock) clock.seekFrame(frame);
    else seekClock(Math.max(0, clockRelFor(i, (frame + 0.5) / fpsOf(tiles[i]))));
  }
  /** Lockstep: the clock moves one frame, the others to their frame for it (syncPaused); shown once all are there. */
  function step(d) {
    if (!clock) return;
    pause();
    clock.seekFrame(clock.currentFrame() + d);
  }
  const skip = (s) => { if (clock) { seekClock(clock.currentTime() + s); toast(`${s > 0 ? '+' : ''}${s} s`); } };

  let lastGen = -1;
  let waiting = false;
  /** While playing: every follower plays from its matching position on the clock. */
  function syncPlaying(force) {
    if (!clock || clock.startT === null || !clock.playing) return;
    const moved = force || clock.gen !== lastGen;
    lastGen = clock.gen;
    const cRel = moved ? clock.rel(clock.now()) : clockPos();
    let hold = false;
    tiles.forEach((p, i) => {
      if (p === clock || p.startT === null) return;
      const rel = relFor(i, cRel);
      if (outOfRange(p, rel)) { if (p.playing) p.pause(); return; }
      const t = p.startT + rel;
      if (moved || !p.playing) {
        // Already decoded ahead from there: just run; otherwise seek.
        if (moved || !(p.queue.length && p.queue[0].t <= t + 0.1 && p.queue[p.queue.length - 1].t >= t)) p.seekTime(Math.max(0, rel));
        p.play();
      }
      const done = p.eof && !p.queue.length;
      const lag = p.seekTarget !== null || p.shownT === null ? Infinity : t - p.shownT;
      if (!done && lag > Math.max(0.12, 2 / fpsOf(p))) hold = true;
    });
    // A follower decodes slower than the clock: hold the clock (and the sound) on its frame until it
    // catches up, so playback slows down instead of showing frames that don't match.
    if (hold && clock.shownT !== null && clock.seekTarget === null) {
      clock.stopAudio();
      clock.anchor(clock.shownT);
      const snd = tiles[st.sound];
      if (snd && snd !== clock && snd.playing) { snd.stopAudio(); snd.anchor(snd.now()); }
    }
    waiting = hold;
  }

  /** @type {string[]} the position each follower was last sent to while paused */
  let reqs = [];
  /** While paused: every follower to the frame nearest the clock's shown frame (plus the offsets). */
  function syncPaused() {
    if (!clock || clock.playing || clock.startT === null || clock.shownT === null || clock.seekTarget !== null) return;
    const cRel = clock.rel(clock.shownT);
    tiles.forEach((p, i) => {
      if (p === clock || p.startT === null) return;
      if (p.playing) p.pause();
      const rel = relFor(i, cRel);
      const key = rel.toFixed(6);
      if (key === reqs[i]) return;
      reqs[i] = key;
      if (outOfRange(p, rel)) return;
      const T = p.startT + Math.max(0, rel);
      const e = earlyOf(p);
      // Already showing it (fewer frames than the clock): nothing to decode.
      if (p.shownT !== null && p.shownT <= T + e + 1e-6 && p.queue.length && p.queue[0].t > T + e && p.seekTarget === null) {
        p.pauseT = T;
        return;
      }
      // Wanted at its first frame, which it is decoding (or shows already, its next one not decoded yet): a seek would
      // throw that work away. A slow tile finishing its first frame after the clock's used to decode it all again.
      if (p.seekTarget === null && (p.shownT === null || p.shownT === p.startT) && rel <= 0.5 / fpsOf(p)) { p.pauseT = T; return; }
      p.seekTime(Math.max(0, rel));
    });
  }

  // ---- compositor ---------------------------------------------------------------

  const VS = `#version 300 es
    in vec2 p; out vec2 uv; uniform float flip;
    void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - flip * p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

  function glProgram(gl, fsSrc) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const u = (n) => gl.getUniformLocation(prog, n);
    return { prog, u };
  }
  function glTexture(gl, unit, filter) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }

  // Each tile is drawn into its own rectangle of the stage-sized canvas (viewport), the split's second
  // tile clipped to the right of the divider (scissor). Tile i's picture is texture slot i.
  const SLOTS = N;
  const DRAW_FS = `#version 300 es
    precision highp float;
    in vec2 uv; out vec4 o; uniform sampler2D t; uniform vec4 win;
    void main() { o = vec4(texture(t, win.xy + uv * win.zw).rgb, 1.0); }`;

  class Compositor {
    constructor(cv) {
      const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      this.cv = cv;
      const { u } = glProgram(gl, DRAW_FS);
      gl.uniform1i(u('t'), 0);
      gl.uniform1f(u('flip'), 1);
      this.uwin = u('win'); // the part of the picture a rectangle shows (zoomed in, only a crop of it is on screen)
      this.tex = [];
      this.size = [];
      for (let i = 0; i < SLOTS; i++) {
        // Mipmapped: a 4K picture in a 960-pixel cell is averaged, not sampled every fourth pixel.
        const t = glTexture(gl, 0, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        this.tex.push(t);
        this.size.push([0, 0]);
      }
    }
    /** Uploads tile `slot`'s engine canvas. */
    upload(slot, src) {
      const gl = this.gl;
      if (!src.width || !src.height || slot >= SLOTS) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[slot]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.size[slot] = [src.width, src.height];
    }
    /**
     * @param {number} w canvas width (device pixels)
     * @param {number} h canvas height
     * @param {{slot: number, x: number, y: number, w: number, h: number, clipX?: number, win?: number[], nearest?: boolean}[]} rects device pixels from the top left
     */
    draw(w, h, rects) {
      const gl = this.gl;
      if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      for (const r of rects) {
        if (!this.size[r.slot][0] || r.w < 1 || r.h < 1) continue;
        const y = h - r.y - r.h;
        gl.bindTexture(gl.TEXTURE_2D, this.tex[r.slot]);
        // Enlarged to twice or more: single pixels, as the player's nearest-neighbour zoom.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, r.nearest ? gl.NEAREST : gl.LINEAR);
        const w4 = r.win || [0, 0, 1, 1];
        gl.uniform4f(this.uwin, w4[0], w4[1], w4[2], w4[3]);
        gl.viewport(Math.round(r.x), Math.round(y), Math.round(r.w), Math.round(r.h));
        if (r.clipX !== undefined) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(Math.round(r.clipX), Math.round(y), Math.max(0, Math.round(r.x + r.w - r.clipX)), Math.round(r.h));
        } else gl.disable(gl.SCISSOR_TEST);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
  }

  // A WebGL context per engine plus the compositor's would pass Chromium's 16 per page (the oldest is
  // lost). From 5 tiles on, one renderer on a scratch canvas draws each tile's frame when its engine
  // shows it, and the result goes straight into that tile's compositor texture; the engine's own
  // canvas only keeps the size (no context). Buffer recycling and colour state stay per tile.
  let scratch = null, renderer = null;
  function sharedRenderer(Renderer, cv, slot) {
    if (!renderer) {
      scratch = document.createElement('canvas');
      renderer = new Renderer(scratch);
      renderer.maxPixels = Grid.texturePixels(N); // all tiles' textures together: one 4K picture
    }
    let rotation = 0;
    let held = null;
    const out = {
      norm16: renderer.norm16, hdrPeak: 0, hdr: 0, onUploaded: null, twin: null, gl: null,
      get rot() { return rotation; },
      setRotation(deg) { rotation = [90, 180, 270].includes(deg) ? deg : 0; },
      prepareNative(w, h) {
        const r = rotation % 180 ? [h, w] : [w, h];
        const c = Grid.capSize(r[0], r[1], renderer ? renderer.maxPixels : 0);
        if (cv.width !== c.w || cv.height !== c.h) { cv.width = c.w; cv.height = c.h; }
      },
      drawYuv(f) { draw(() => renderer.drawYuv(f)); },
      drawFrame(vf) { draw(() => renderer.drawFrame(vf)); },
    };
    function draw(render) {
      if (!renderer || !comp) return;
      renderer.setRotation(rotation);
      renderer.hdrPeak = out.hdrPeak;
      renderer.heldBuf = held;
      renderer.onUploaded = out.onUploaded;
      render();
      held = renderer.heldBuf;
      out.hdr = renderer.hdr;
      if (cv.width !== scratch.width || cv.height !== scratch.height) { cv.width = scratch.width; cv.height = scratch.height; }
      comp.upload(slot, scratch);
    }
    return out;
  }

  // ---- metrics ----------------------------------------------------------------------

  const COPY_FS = `#version 300 es
    precision highp float;
    in vec2 uv; out vec4 o; uniform sampler2D t;
    void main() { o = vec4(texture(t, uv).rgb, 1.0); }`;

  /** Reads two pictures back at the first one's size and computes PSNR / SSIM on the CPU. */
  class Metrics {
    constructor() {
      const cv = document.createElement('canvas');
      cv.width = 4; cv.height = 4;
      const gl = cv.getContext('webgl2', { alpha: false, antialias: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      const { u } = glProgram(gl, COPY_FS);
      gl.uniform1f(u('flip'), -1); // FBO row 0 = top of the picture, so rows read back top-down
      gl.uniform1i(u('t'), 0);
      this.tex = glTexture(gl, 0, gl.LINEAR);
      this.fbo = gl.createFramebuffer();
      this.rt = gl.createTexture();
      this.w = 0; this.h = 0;
    }
    readBack(src, w, h, out) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    }
    /**
     * @param {HTMLCanvasElement} a reference picture (its size is used)
     * @param {HTMLCanvasElement} b scaled to a's size
     * @param {{ssim?: boolean, matrix: number}} opt
     */
    measure(a, b, opt) {
      const gl = this.gl;
      const w = a.width, h = a.height;
      if (!w || !h || !b.width) return null;
      if (w !== this.w || h !== this.h) {
        this.w = w; this.h = h;
        gl.bindTexture(gl.TEXTURE_2D, this.rt);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rt, 0);
        gl.viewport(0, 0, w, h);
        this.pa = new Uint8Array(w * h * 4);
        this.pb = new Uint8Array(w * h * 4);
        this.ya = new Uint8Array(w * h);
        this.yb = new Uint8Array(w * h);
      }
      gl.activeTexture(gl.TEXTURE0);
      this.readBack(a, w, h, this.pa);
      this.readBack(b, w, h, this.pb);
      return computeMetrics(this.pa, this.pb, this.ya, this.yb, w, h, opt);
    }
  }

  /**
   * PSNR of R, G, B and of luma Y, plus SSIM of Y when asked.
   * Y is limited range (16-235), as the decoder had it: recovered from RGB with the
   * reference frame's matrix weights and rounded.
   */
  function computeMetrics(pa, pb, ya, yb, w, h, opt) {
    const [kr, kb] = opt.matrix === 2020 ? [0.2627, 0.0593] : opt.matrix === 709 ? [0.2126, 0.0722] : [0.299, 0.114];
    const kg = 1 - kr - kb;
    const s = 219 / 255;
    let er = 0, eg = 0, eb = 0, ey = 0;
    const n = w * h;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r1 = pa[j], g1 = pa[j + 1], b1 = pa[j + 2];
      const r2 = pb[j], g2 = pb[j + 1], b2 = pb[j + 2];
      const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
      er += dr * dr; eg += dg * dg; eb += db * db;
      const y1 = Math.round(16 + s * (kr * r1 + kg * g1 + kb * b1));
      const y2 = Math.round(16 + s * (kr * r2 + kg * g2 + kb * b2));
      ya[i] = y1; yb[i] = y2;
      const dy = y1 - y2;
      ey += dy * dy;
    }
    const psnr = (mse) => (mse > 0 ? 10 * Math.log10((255 * 255) / mse) : Infinity);
    const mseRgb = (er + eg + eb) / (3 * n);
    const res = { psnrY: psnr(ey / n), psnrRGB: psnr(mseRgb), mseY: ey / n, mseRGB: mseRgb, ssimY: NaN, w, h };
    if (opt.ssim) res.ssimY = ssim(ya, yb, w, h);
    return res;
  }

  /**
   * SSIM over 8x8 windows on a 4-pixel grid (sums of 4x4 blocks, combined 2x2),
   * mean over all windows. C1 = (0.01*255)^2, C2 = (0.03*255)^2, unbiased variances.
   */
  function ssim(x, y, w, h, peak = 255) {
    const bw = w >> 2, bh = h >> 2;
    if (bw < 2 || bh < 2) return NaN;
    const s1 = new Float64Array(bw * bh), s2 = new Float64Array(bw * bh), ss = new Float64Array(bw * bh), s12 = new Float64Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let a1 = 0, a2 = 0, aa = 0, a12 = 0;
        for (let yy = 0; yy < 4; yy++) {
          let o = (by * 4 + yy) * w + bx * 4;
          for (let xx = 0; xx < 4; xx++, o++) {
            const p = x[o], q = y[o];
            a1 += p; a2 += q; aa += p * p + q * q; a12 += p * q;
          }
        }
        const k = by * bw + bx;
        s1[k] = a1; s2[k] = a2; ss[k] = aa; s12[k] = a12;
      }
    }
    const N = 64;
    const C1 = (0.01 * peak) ** 2 * N * N;
    const C2 = (0.03 * peak) ** 2 * N * (N - 1);
    let sum = 0;
    for (let by = 0; by < bh - 1; by++) {
      for (let bx = 0; bx < bw - 1; bx++) {
        const k = by * bw + bx;
        const k2 = k + bw;
        const S1 = s1[k] + s1[k + 1] + s1[k2] + s1[k2 + 1];
        const S2 = s2[k] + s2[k + 1] + s2[k2] + s2[k2 + 1];
        const SS = ss[k] + ss[k + 1] + ss[k2] + ss[k2 + 1];
        const S12 = s12[k] + s12[k + 1] + s12[k2] + s12[k2 + 1];
        const vars = SS * N - S1 * S1 - S2 * S2;
        const covar = S12 * N - S1 * S2;
        sum += ((2 * S1 * S2 + C1) * (2 * covar + C2)) / ((S1 * S1 + S2 * S2 + C1) * (vars + C2));
      }
    }
    return sum / ((bw - 1) * (bh - 1));
  }

  /** PSNR (and SSIM) of two luma planes of the same size and depth. */
  function lumaMetrics(la, lb, wantSsim) {
    const a = la.data, b = lb.data;
    let e = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; e += d * d; }
    const peak = (1 << la.depth) - 1;
    const mse = e / a.length;
    const r = { psnrY: mse > 0 ? 10 * Math.log10((peak * peak) / mse) : Infinity, mseY: mse, ssimY: NaN };
    if (wantSsim) r.ssimY = ssim(a, b, la.w, la.h, peak);
    return r;
  }

  /**
   * Metrics of two engines' shown frames. Luma comes from the decoded planes when both
   * have them at the same size and depth (exact); otherwise from the RGB pictures.
   * RGB PSNR is always from the pictures as shown (B scaled to A's size).
   */
  async function pairMetrics(pa, pb, { ssim: wantSsim, rgb }) {
    const [la, lb0] = await Promise.all([lumaOf(pa), lumaOf(pb)]);
    const planes = !!(la && lb0 && la.depth === lb0.depth && (pa.gl.rot || 0) === (pb.gl.rot || 0));
    const exact = planes && la.w === lb0.w && la.h === lb0.h;
    // Another size: B's plane resized to A's (bilinear), still free of colour-matrix guesses.
    const lb = planes && !exact ? resizeLuma(lb0, la.w, la.h) : lb0;
    let m = null;
    if (rgb || !planes) m = getMetrics().measure(pa.cv, pb.cv, { ssim: wantSsim && !planes, matrix: pa.shownMatrix(true) });
    if (planes) m = { ...(m || { psnrRGB: NaN, w: pa.cv.width, h: pa.cv.height }), ...lumaMetrics(la, lb, wantSsim) };
    if (m) m.exactY = exact;
    return m;
  }

  /** Bilinear resize of a luma plane (pixel centres aligned), rounded to integers. */
  function resizeLuma(l, w, h) {
    const src = l.data, sw = l.w, sh = l.h;
    const d = l.depth > 8 ? new Uint16Array(w * h) : new Uint8Array(w * h);
    const fx = sw / w, fy = sh / h;
    for (let y = 0; y < h; y++) {
      const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * fy - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * fx - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
        const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
        const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
        d[y * w + x] = Math.round(a * (1 - ty) + b * ty);
      }
    }
    return { data: d, w, h, depth: l.depth };
  }

  /** @type {Compositor|null} */ let comp = null;
  /** @type {Metrics|null} */ let metrics = null;
  const getMetrics = () => (metrics = metrics || new Metrics());

  // ---- layout: cells and the pictures in them ---------------------------------------------

  /** A tile's display aspect: its engine canvas once it has drawn, else the file's size, else 16:9. */
  function aspectOf(i) {
    const p = tiles[i];
    if (p && p.cv && p.cv.width && p.cv.height) return p.cv.width / p.cv.height;
    if (p && p.meta && p.meta.width && p.meta.height) return p.meta.width / p.meta.height;
    return 16 / 9;
  }
  const fitRect = (x, y, w, h, a) => {
    let fw = w, fh = w / a;
    if (fh > h) { fh = h; fw = h * a; }
    return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh };
  };
  const GAP = 2;
  /** Tile i's drawn size (its canvas, else the file's) and the video's own size (what 100 % shows). */
  function tileNat(i) {
    const p = tiles[i];
    if (p && p.cv && p.cv.width && p.cv.height) return { w: p.cv.width, h: p.cv.height };
    if (p && p.meta && p.meta.width && p.meta.height) return { w: p.meta.width, h: p.meta.height };
    return { w: 1600, h: 900 };
  }
  const tileSrc = (i) => {
    const p = tiles[i];
    const stream = p?.info?.remoteStream;
    return Pic.sourceSize(tileNat(i), stream
      ? { w: stream.sourceWidth, h: stream.sourceHeight }
      : { w: p?.meta?.width, h: p?.meta?.height });
  };
  const picOpts = () => ({ dpr: window.devicePixelRatio || 1 });
  /** Tile i in a cell (x, y, w, h): `full` is the whole picture with the shared view applied, `pic` the part of it inside the cell. */
  function placed(i, x, y, w, h) {
    const r = Pic.rectOf(st.pic, tileNat(i), tileSrc(i), { w, h }, picOpts());
    const full = { x: x + r.x, y: y + r.y, w: r.w, h: r.h };
    const x0 = Math.max(x, full.x), y0 = Math.max(y, full.y), x1 = Math.min(x + w, full.x + full.w), y1 = Math.min(y + h, full.y + full.h);
    return { full, pic: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) } };
  }
  /**
   * The cells in CSS pixels of the stage: {x, y, w, h, tiles: [i] or [left, right] (split) or [] (the add cell), pic}.
   */
  function computeCells(order = displayOrder()) {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (st.mode === 'split') {
      const [l, r] = order;
      return [{ x: 0, y: 0, w: W, h: H, tiles: [l, r], split: true, ...placed(l, 0, 0, W, H) }];
    }
    if (st.mode === 'side') {
      const w = (W - GAP) / 2;
      return order.map((i, k) => ({ x: k * (w + GAP), y: 0, w, h: H, tiles: [i], ...placed(i, k * (w + GAP), 0, w, H) }));
    }
    const { cols, rows } = Grid.gridFor(N, 'grid');
    const w = (W - GAP * (cols - 1)) / cols, h = (H - GAP * (rows - 1)) / rows;
    const out = [];
    // The first empty cell adds a video (3 of 4; in a larger grid while the setting allows more).
    for (let k = 0, count = Grid.gridCellCount(N, MAX_TILES, cols, rows); k < count; k++) {
      const x = (k % cols) * (w + GAP), y = Math.floor(k / cols) * (h + GAP);
      if (k < N) out.push({ x, y, w, h, tiles: [order[k]], ...placed(order[k], x, y, w, h) });
      else out.push({ x, y, w, h, tiles: [], add: true, pic: { x, y, w, h }, full: { x, y, w, h } });
    }
    return out;
  }
  /** @type {any[]} */
  let cells = [];

  // ---- the hover layer: name pill, frame number and offset nudge per tile ---------------------

  const SVG = (body, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    clock: (s) => SVG('<circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2.5 2M10 2.5h4"></path>', s),
    sound: (s) => SVG('<path d="M4 9h4l5-4v14l-5-4H4z"></path><path d="M16.5 8.5a5 5 0 0 1 0 7"></path>', s),
    plus: SVG('<path d="M12 5v14M5 12h14"></path>', 18),
    swap: SVG('<path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"></path>', 18),
    view: SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M12 5v14"></path>', 18),
    leave: SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M9 12h8M13 8l4 4-4 4"></path>', 18),
    replace: SVG('<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4v3h3M4 13a8 8 0 0 0 14.5 4.5M20 20v-3h-3"></path>', 18),
    remove: SVG('<path d="M6 6l12 12M18 6L6 18"></path>', 18),
    split: SVG('<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"></path>', 14),
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  /** Offset text: short ("0", "+3 f", "−40 ms") for the nudge and the panel rows, long ("In step", "+3 frames") for the page. */
  function offText(i, long) {
    const o = st.offsets[i];
    if (!o || !o.v) return long ? 'In step' : '0';
    const sg = o.v > 0 ? '+' : '−';
    const a = Math.abs(o.v);
    if (o.unit === 'ms') return `${sg}${Math.round(a * 10) / 10} ms`;
    return `${sg}${a}${long ? (a === 1 ? ' frame' : ' frames') : ' f'}`;
  }

  let cellsKey = '';
  /** Builds the cells' DOM when the structure changes; positions them on every layout. */
  function layoutCells() {
    cells = computeCells();
    const key = `${st.mode}|${cells.length}`;
    if (key !== cellsKey) {
      cellsKey = key;
      cellsEl.textContent = '';
      for (const c of cells) {
        const d = document.createElement(c.add ? 'button' : 'div');
        d.className = `cell${c.add ? ' add' : ''}${c.split ? ' split' : ''}`;
        if (c.add) {
          d.dataset.act = 'add';
          d.setAttribute('aria-label', 'Add video');
          d.innerHTML = `<span class="addcell">${ICONS.plus}<span>Add video</span></span>`;
        } else if (c.split) {
          d.dataset.tile = 'split';
          d.innerHTML = `<div class="ov L" data-side="L"></div><div class="ov R" data-side="R"></div><div class="move L"></div><div class="move R"></div><div class="oor" hidden>One side has no picture at this moment</div>`
            + `<div id="divider" role="slider" tabindex="0" aria-label="Split position" aria-valuemin="0" aria-valuemax="100" title="Drag, or ← → (Shift: 10 %), Home / End"><span class="h">${ICONS.split}</span></div>`;
        } else {
          d.innerHTML = '<div class="ov"></div><div class="move"></div><div class="oor" hidden>No picture at this moment (offset or length)</div>';
        }
        cellsEl.appendChild(d);
      }
      bindDivider();
      overlaysKey = '';
    }
    [...cellsEl.children].forEach((d, k) => {
      const c = cells[k];
      if (!c) return;
      if (c.add) d.inert = reordering;
      if (!c.add && !c.split) d.dataset.tile = String(c.tiles[0]);
      Object.assign(d.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
      for (const ov of d.querySelectorAll('.ov')) {
        ov.inert = reordering;
        // A narrow letterboxed picture still gets the whole cell's width for its controls.
        const box = largeGrid ? c : c.pic;
        Object.assign(ov.style, {
          left: `${box.x - c.x}px`, top: `${box.y - c.y}px`, width: `${box.w}px`, height: `${box.h}px`,
        });
      }
      // The reorder arrows sit in the picture's bottom corners, not the cell's: a letterboxed picture leaves black
      // bars between the two, and the arrows would float far from the tile they move. The insets are how far the
      // picture's edges lie inside the cell (0 where it fills or overflows the cell).
      if (!c.add) {
        const pic = c.pic || c;
        const inset = (v) => `${Math.max(0, Math.round(v * 10) / 10)}px`;
        d.style.setProperty('--pic-l', inset(pic.x - c.x));
        d.style.setProperty('--pic-r', inset(c.x + c.w - (pic.x + pic.w)));
        d.style.setProperty('--pic-b', inset(c.y + c.h - (pic.y + pic.h)));
      }
      if (c.split) placeDivider(d, c);
    });
    stage.classList.toggle('pannable', cells.some(overflows));
    updateOverlays();
  }

  /** True when the picture is larger than its cell on some side (it can be dragged). */
  const overflows = Pic.overflows;
  let overlaysKey = '';
  /** Pill and nudge content of every tile (letter, name, clock / sound, offset). */
  function updateOverlays() {
    const order = displayOrder();
    const key = `${cellsKey}|${order}|${st.clock}|${st.sound}|${st.muted}|${st.offsets.map((o) => `${o.v}${o.unit}`).join(',')}`;
    if (key === overlaysKey) return;
    overlaysKey = key;
    infoDirty = true;  // the new pills start empty: refill the frame numbers on the next tick even when paused
    const html = (i, side) => {
      const clockI = i === st.clock ? `<span class="ico" title="Clock">${ICONS.clock(14)}</span>` : '';
      const soundI = i === st.sound ? `<span class="ico${st.muted ? ' dim' : ''}" title="${st.muted ? 'Sound (muted)' : 'Sound'}">${ICONS.sound(14)}</span>` : '';
      const k = KEYS[order.indexOf(i)];
      return `<button class="pill ${side === 'R' ? 'right' : 'left'}" data-act="openVid" data-i="${i}" title="${esc(names[i])}: offset, clock, sound, replace, remove"><span class="ltr">${k}</span><span class="nm">${esc(names[i])}</span>${clockI}${soundI}<span class="fr mono" data-fr="${i}"></span></button>`
        + `<div class="nudge ${side === 'R' ? 'right below' : side === 'L' ? 'left below' : 'right'}" role="group" aria-label="Offset of ${k}"><button data-act="nudge" data-i="${i}" data-d="-1" aria-label="${k} earlier" title="Earlier  −">‹</button>`
        + `<button class="offv mono" data-act="openVid" data-i="${i}" title="Offset of ${k}" aria-label="Offset of ${k}: ${offText(i, true)}">${offText(i)}</button>`
        + `<button data-act="nudge" data-i="${i}" data-d="1" aria-label="${k} later" title="Later  +">›</button></div>`;
    };
    const arrows = (i) => [-1, 1].map((d) => {
      const pos = order.indexOf(i) + d;
      const label = `Move ${esc(names[i])} ${d < 0 ? 'earlier' : 'later'}`;
      const icon = d < 0 ? 'M6 14l6-6 6 6' : 'M6 10l6 6 6-6';
      const disabled = pos < 0 || pos >= N ? ' disabled' : '';
      return `<button data-act="move" data-i="${i}" data-d="${d}" aria-label="${label}" title="${label}"${disabled}>${SVG(`<path d="${icon}"></path>`)}</button>`;
    }).join('');
    [...cellsEl.children].forEach((d, k) => {
      const c = cells[k];
      if (!c || c.add) return;
      if (c.split) {
        const [l, r] = c.tiles;
        d.querySelector('.ov.L').innerHTML = html(l, 'L');
        d.querySelector('.ov.R').innerHTML = html(r, 'R');
        d.querySelector('.move.L').innerHTML = arrows(l);
        d.querySelector('.move.R').innerHTML = arrows(r);
      } else {
        d.querySelector('.ov').innerHTML = html(c.tiles[0]);
        d.querySelector('.move').innerHTML = arrows(c.tiles[0]);
      }
    });
    lastFr = '';
  }
  let lastFr = '';
  /** Each tile's frame number in its pill; the out-of-range notes. */
  function updateTileInfo(fr) {
    const key = `${fr.join(',')}|${outs.join(',')}`;
    if (key === lastFr) return;
    lastFr = key;
    for (const e of cellsEl.querySelectorAll('[data-fr]')) {
      const i = Number(e.dataset.fr);
      e.textContent = fr[i] === null || outs[i] ? '—' : `#${fr[i]}`;
    }
    [...cellsEl.children].forEach((d, k) => {
      const c = cells[k];
      const o = d.querySelector('.oor');
      if (c && o) o.hidden = !c.tiles.some((i) => outs[i]);
    });
  }

  // ---- the split divider ----------------------------------------------------------------------

  function placeDivider(d, c) {
    const dv = d.querySelector('#divider');
    if (!dv) return;
    dv.inert = reordering;
    Object.assign(dv.style, { left: `${c.pic.x - c.x + c.pic.w * st.split}px`, top: `${c.pic.y - c.y}px`, height: `${c.pic.h}px` });
    const pct = Math.round(st.split * 100);
    dv.setAttribute('aria-valuenow', String(pct));
    dv.setAttribute('aria-valuetext', `A ${pct}%, B ${100 - pct}%`);
  }
  function setSplit(x) {
    st.split = Math.max(0, Math.min(1, x));
    viewDirty = true;
    const d = cellsEl.querySelector('.cell.split');
    if (d && cells[0]) placeDivider(d, cells[0]);
    save();
  }
  let dividerDrag = null;
  function bindDivider() {
    const dv = cellsEl.querySelector('#divider');
    if (!dv) return;
    const at = (e) => { const c = cells[0]; const r = stage.getBoundingClientRect(); setSplit((e.clientX - r.left - c.pic.x) / c.pic.w); };
    dv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dividerDrag = { id: e.pointerId, moved: false };
      try { dv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer (test hook) */ }
    });
    dv.addEventListener('pointermove', (e) => { if (dividerDrag) { dividerDrag.moved = true; at(e); } });
    // The click that ends a drag must not play or pause.
    const end = () => { if (dividerDrag) { if (dividerDrag.moved) dragEnded = performance.now(); dividerDrag = null; } };
    dv.addEventListener('pointerup', end);
    dv.addEventListener('pointercancel', end);
    dv.addEventListener('click', (e) => e.stopPropagation());
    dv.addEventListener('keydown', (e) => {
      const big = e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown' ? 0.1 : 0.01;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': case 'PageDown': setSplit(st.split - big); break;
        case 'ArrowRight': case 'ArrowUp': case 'PageUp': setSplit(st.split + big); break;
        case 'Home': setSplit(0); break;
        case 'End': setSplit(1); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
  }
  let dragEnded = 0;

  // ---- presentation -----------------------------------------------------------------------------

  /** @type {number[]} the shownCount of each tile's picture in the compositor */
  let upCount = [];
  let viewDirty = true;
  let layoutDirty = true;
  let infoDirty = true;
  let waitSince = 0;
  let lastMetricsKey = '';
  let lastMetrics = null;
  /** @type {boolean[]} tile i has no frame at the clock's position (offset or length) */
  let outs = [];
  let lastOuts = '';
  let lastAspects = '';
  let firstPictures = false;
  let drawn = false;

  function present(now) {
    if (!clock || clock.shownT === null) return;
    if (!comp) comp = new Compositor(canvas);
    if (canvas.hidden) canvas.hidden = false;
    const paused = !clock.playing;
    const cRel = clock.rel(clock.shownT);
    outs = tiles.map((p, i) => p !== clock && outOfRange(p, relFor(i, cRel)));
    let ready = true;
    if (paused) {
      // Nothing was drawn yet: the first picture needs each tile's first frame only.
      ready = tiles.every((p, i) => outs[i] || settled(p) || (!drawn && atFirstFrame(p)));
      if (!ready) {
        if (!waitSince) waitSince = now;
        // Still decoding a tile after a while: show what there is.
        if (now - waitSince > 1500) ready = true;
      } else waitSince = 0;
    }
    if (ready) {
      tiles.forEach((p, i) => {
        const n = p.shownCount || 0;
        // A large grid's textures are filled by the shared renderer as each engine draws.
        if (p.shownT !== null && n !== upCount[i]) { if (!largeGrid) comp.upload(i, p.cv); upCount[i] = n; viewDirty = true; }
      });
    }
    // A tile's picture size known (or changed): its picture rectangle changes.
    const aspects = tiles.map((_, i) => aspectOf(i).toFixed(4)).join(',');
    if (aspects !== lastAspects) { lastAspects = aspects; layoutDirty = true; }
    const ok = outs.join(',');
    if (ok !== lastOuts) { lastOuts = ok; viewDirty = true; }
    if (layoutDirty) { layoutDirty = false; layoutCells(); viewDirty = true; }
    // A large grid's textures already hold the newest frames: draw only a matching set (paused lockstep).
    if (viewDirty && (!largeGrid || ready)) {
      viewDirty = false;
      draw();
      drawn = true;
      if (cfg.debug && !firstPictures && tiles.every((_, i) => upCount[i] > 0)) {
        firstPictures = true;
        log('first pictures shown');
      }
      infoDirty = true;
    }
    // Metrics (kept for a future advanced mode): debug builds only, logged, never shown.
    if (INTERNAL && N === 2 && paused && ready && st.metrics && !waitSince) {
      const out = outs[0] || outs[1];
      const key = `${upCount[0]}|${upCount[1]}|${offSec(1) - offSec(0)}|${out}`;
      if (key !== lastMetricsKey) {
        lastMetricsKey = key;
        if (out) lastMetrics = { out: true }; else setTimeout(() => runMetrics(key), 0);
      }
    } else if (!paused && lastMetrics) { lastMetrics = null; lastMetricsKey = ''; }
  }

  /** Every tile into its picture rectangle, at device pixels; a tile with no frame here stays black. */
  function draw() {
    if (!comp) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(stage.clientWidth * dpr)), H = Math.max(1, Math.round(stage.clientHeight * dpr));
    const rects = [];
    // The visible part of the picture, and which part of the texture that is (zoomed in, the picture is larger than its cell).
    const px = (c, slot) => {
      const p = c.pic, f = c.full;
      const src = tileSrc(slot);
      return {
        x: p.x * dpr, y: p.y * dpr, w: p.w * dpr, h: p.h * dpr,
        win: [(p.x - f.x) / f.w, (p.y - f.y) / f.h, p.w / f.w, p.h / f.h], nearest: src.w > 0 && (f.w * dpr) / src.w >= 2,
      };
    };
    for (const c of cells) {
      if (c.add) continue;
      if (c.split) {
        const [l, r] = c.tiles;
        if (!outs[l]) rects.push({ slot: l, ...px(c, l) });
        if (!outs[r]) { const q = px(c, r); rects.push({ slot: r, ...q, clipX: q.x + q.w * st.split }); }
      } else if (!outs[c.tiles[0]]) rects.push({ slot: c.tiles[0], ...px(c, c.tiles[0]) });
    }
    comp.draw(W, H, rects);
  }

  async function runMetrics(key) {
    if (key !== lastMetricsKey || !clock || isPlaying()) return;
    const [pa, pb] = tiles;
    try {
      const t0 = performance.now();
      const m = await pairMetrics(pa, pb, { ssim: true, rgb: true });
      if (!m || key !== lastMetricsKey) return;
      m.ms = performance.now() - t0;
      lastMetrics = m;
      if (cfg.debug) log(`metrics frameA=${frameOf(pa) + 1} frameB=${frameOf(pb) + 1} psnrY=${m.psnrY.toFixed(3)} psnrRGB=${m.psnrRGB.toFixed(3)} ssimY=${m.ssimY.toFixed(5)} exactY=${m.exactY} ${m.w}x${m.h} ${m.ms.toFixed(0)}ms`);
    } catch (e) {
      log(`metrics failed: ${e && e.stack || e}`);
      lastMetrics = null;
    }
  }
  const fmtDb = (v) => (v === Infinity ? '∞' : `${v.toFixed(2)} dB`);

  function tileSize() {
    const dpr = window.devicePixelRatio || 1;
    const { cols, rows } = Grid.gridFor(N, st.mode);
    return {
      w: Math.floor(stage.clientWidth * dpr), h: Math.floor(stage.clientHeight * dpr),
      cols, rows,
      // A large grid's first tile may be built-in (no ffprobe on the host): the page says its shape.
      ...(largeGrid ? { aspect: Math.round(aspectOf(0) * 1e4) / 1e4 } : {}),
      rate: st.rate, factor: frameFactor(),
    };
  }
  /**
   * How much larger than the plain Fit a tile's picture is now (Fill, Stretch, 100 %, zoom): native frames are sized
   * by it, so a zoomed or cropped picture still gets enough pixels (the host's tileHeights multiplies the view by it).
   */
  function frameFactor() {
    if (st.pic.mode === 'fit' && Pic.plain(st.pic)) return 1;
    let f = 0;
    for (const c of computeCells(st.order)) {
      if (c.add) continue;
      const i = c.tiles[0];
      const fit = Pic.rectOf(Pic.fresh('fit'), tileNat(i), tileSrc(i), { w: c.w, h: c.h }, picOpts());
      if (fit.w > 0 && fit.h > 0) f = Math.max(f, c.full.w / fit.w, c.full.h / fit.h);
    }
    return Math.round(Math.max(0.1, Math.min(64, f || 1)) * 100) / 100;
  }
  let lastTileSize, sizeTimer;
  function requestTileSize() {
    if (!begun || !nativeTiles.some(Boolean)) return;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const tile = tileSize();
      const key = JSON.stringify(tile);
      if (!tile.w || !tile.h || key === lastTileSize) return;
      lastTileSize = key;
      vscode.postMessage({ type: 'tileSize', tile });
    }, 150);
  }
  new ResizeObserver(() => { layoutDirty = true; requestTileSize(); if (!clock) layoutCells(); }).observe(stage);
  window.addEventListener('resize', requestTileSize);

  // ---- state changes -------------------------------------------------------------------------

  function setMode(m) {
    if (N > 2) m = 'grid';
    else if (m === 'wipe') m = 'split';
    else if (m !== 'side' && m !== 'split') return;
    finishReorderDrag();
    st.mode = m;
    layoutDirty = true;
    viewDirty = true;
    if (!clock) layoutCells();
    requestTileSize();
    refreshPanel();
    save();
  }
  /** The picture size / zoom / pan for every tile at once. */
  function setPic(v) {
    st.pic = v;
    layoutDirty = true;
    viewDirty = true;
    if (!clock) layoutCells();
    updatePicBtn();
    requestTileSize();
    refreshPanel();
    save();
  }
  function updatePicBtn() {
    const m = st.pic.mode;
    const nx = Pic.next(m);
    ui.picBtn.dataset.mode = m;
    ui.picBtn.title = `Picture size: ${Pic.name(m)} (${Pic.WORDS[m]}), all videos. Click for ${Pic.name(nx)}  Z`;
    ui.picBtn.setAttribute('aria-label', `Picture size: ${Pic.name(m)}. Next: ${Pic.name(nx)}`);
  }
  /** Z and the button: the next size for all tiles; zoomed in, back to Fit. */
  function cyclePic() {
    setPic(Pic.cycle(st.pic));
    toast(Pic.name(st.pic.mode));
  }
  /** The cell under a point (client px) and the point inside it, or null. */
  function cellAt(clientX, clientY) {
    const r = stage.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const c = cells.find((k) => !k.add && x >= k.x && x < k.x + k.w && y >= k.y && y < k.y + k.h);
    return c ? { c, i: c.tiles[0], px: x - c.x, py: y - c.y } : null;
  }
  const cellView = (c) => ({ w: c.w, h: c.h });
  const cellPercent = (c) => Pic.percent(c.full, tileSrc(c.tiles[0]), window.devicePixelRatio || 1);
  const clockCell = () => cells.find((k) => !k.add && k.tiles.includes(st.clock)) || cells.find((k) => !k.add);
  /** Zoom every tile to `zoom` of its own size, around a point of one cell (keys and the panel: the middle of the clock's cell). */
  function zoomPic(zoom, hit) {
    const c0 = clockCell();
    const h = hit || (c0 ? { c: c0, i: c0.tiles[0], px: c0.w / 2, py: c0.h / 2 } : null);
    if (!h) return;
    setPic(Pic.zoomAt(st.pic, zoom, h.px, h.py, tileNat(h.i), tileSrc(h.i), cellView(h.c), picOpts()));
  }
  const picState = () => {
    const c = clockCell();
    return { mode: st.pic.mode, pct: c ? cellPercent(c) : null, zoomed: st.pic.zoom !== 1 };
  };
  /** Tile i's offset: v in `unit` (default: its current unit). */
  function setOffset(i, v, unit) {
    if (!(i >= 0 && i < N) || !isFinite(v)) return;
    const o = st.offsets[i];
    if (unit === 'ms' || unit === 'frames') o.unit = unit;
    // ms stays fractional (rounded only for display), so frames → ms → frames is lossless at 23.976 / 29.97 (review 2026-11-19 #7).
    o.v = o.unit === 'ms' ? Math.round(v * 1000) / 1000 : Math.round(v);
    reqs = [];
    if (isPlaying()) syncPlaying(true);
    infoDirty = true;
    updateOverlays();
    refreshPanel();
    save();
  }
  /** One nudge of tile i's offset: a frame of that video, or 10 ms. */
  function nudge(i, d) {
    const o = st.offsets[i];
    if (!o) return;
    st.sel = i;
    setOffset(i, o.v + d * (o.unit === 'ms' ? 10 : 1));
    toast(`${tileLabel(i)} offset ${offText(i, true)}`);
  }
  /** Tile i's offset in frames or in ms, keeping the moment it stands for. */
  function setUnit(i, unit) {
    const o = st.offsets[i];
    if (!o || o.unit === unit) return;
    const fps = fpsOf(tiles[i]);
    if (unit === 'ms') setOffset(i, (o.v / fps) * 1000, 'ms');
    else setOffset(i, (o.v / 1000) * fps, 'frames');
  }
  function swapSides() {
    finishReorderDrag();
    if (N === 2) commitOrder(Grid.moveTile(st.order, 0, 1), st.order[1]);
  }
  /** Sound from tile i only; the others are muted. */
  function setSound(i, quiet) {
    st.sound = tileOr0(i);
    applyVolume();
    updateOverlays();
    updateMuteUi();
    refreshPanel();
    save();
    if (!quiet) toast(`Sound from ${tileLabel(st.sound)}`);
  }
  function applyVolume() { tiles.forEach((p, j) => p.setVolume(st.volume, st.muted || j !== st.sound)); }
  function updateMuteUi() {
    const m = st.muted;
    ui.mute.classList.toggle('muted', m || st.volume === 0);
    ui.mute.classList.toggle('on', m);
    ui.mute.setAttribute('aria-pressed', String(m));
    ui.mute.setAttribute('aria-label', `${m ? 'Unmute' : 'Mute'} (sound from ${tileLabel(st.sound)})`);
    ui.mute.title = `${m ? 'Unmute' : 'Mute'} (sound from ${tileLabel(st.sound)})  M`;
  }
  function setMute(m) {
    st.muted = m;
    updateMuteUi();
    applyVolume();
    updateOverlays();
    save();
  }
  function setVolume(v) {
    st.volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    ui.volume.value = String(st.volume);
    if (st.volume > 0 && st.muted) setMute(false); else setMute(st.muted);
  }
  function setRate(r) {
    st.rate = VpeControls.clampRate(r);
    ui.rate.textContent = VpeControls.speedText(st.rate);
    ui.rate.setAttribute('aria-label', `Speed ${VpeControls.speedText(st.rate)}`);
    for (const p of tiles) p.setRate(st.rate);
    requestTileSize();
    save();
  }
  /** Speed change with the player's toast ("4× (fastest)"). */
  function changeRate(r) {
    setRate(r);
    toast(`${VpeControls.speedText(st.rate)}${r > VpeControls.SPEED_MAX + 1e-9 ? ' (fastest)' : r < VpeControls.SPEED_MIN - 1e-9 ? ' (slowest)' : ''}`);
    if (controls) controls.refresh();
  }
  const bumpRate = (d) => changeRate(Math.round((st.rate + d * VpeControls.SPEED_STEP) * 100) / 100);
  function setLoop(l) { st.loop = l; if (clock) clock.setLoop(l); if (controls) controls.refresh(); save(); }
  function setJump(key, value) {
    prefs.jump[key] = value;
    vscode.postMessage({ type: 'pref', key: `jump.${key}`, value });
    toast(`${key === 'arrow' ? '' : key === 'shift' ? 'Shift + ' : 'Ctrl + '}← → jump ${VpeControls.navName(value)}`);
  }
  /** A jump: one frame (lockstep) or seconds on the clock. */
  function jump(size, dir) {
    if (size === 'frame') step(dir);
    else skip(dir * Number(size));
  }

  // ---- files: add, replace, remove, leave ---------------------------------------------------------

  const toggleAddMode = () => { closeMenu(); vscode.postMessage({ type: 'addMode' }); };
  // The add mode's hint, while it is on (the host says so with 'addMode' messages).
  const addHint = document.createElement('div');
  addHint.id = 'addHint'; addHint.hidden = true; addHint.setAttribute('role', 'status');
  document.getElementById('stage').appendChild(addHint);
  function showAddMode(m) {
    addHint.hidden = !m.on;
    addHint.textContent = m.on ? 'Click videos in Explorer to add · Esc to stop' : '';
    if (m.on) announce(addHint.textContent);
    log(`addMode ${m.on ? 'on' : 'off'}`);
  }
  // Add video…: starts add mode (click videos in the Explorer); the file dialog is only the host's 'add' message (palette / tests).
  const addVideo = () => { if (N < MAX_TILES) { closeMenu(); vscode.postMessage({ type: 'startAddMode' }); } };
  function replaceVideo(i) {
    closeMenu();
    saveNow();
    vscode.postMessage({ type: 'replace', index: i });
  }
  /** Tile i's own position (seconds) at the clock's current position. */
  const tileTime = (i) => (clock ? Math.max(0, clock.currentTime() - offSec(st.clock) + offSec(i)) : 0);
  /** Back to one video: the player opens `keep` (the clock by default) at its moment, in this tab's place. */
  function leave(keep) {
    const k = keep === undefined ? st.clock : tileOr0(keep);
    closeMenu();
    if (controls) controls.closeAll(false);
    pause();
    saveNow();
    vscode.postMessage({ type: 'leave', keep: k, t: tileTime(k) });
  }
  /** Tile i leaves the view: the page starts again with the others (offsets, clock and sound move with their videos); with 2, back to one video. */
  function removeTile(i) {
    if (!(i >= 0 && i < N)) return;
    if (N <= 2) { leave(N === 2 && i === 0 ? 1 : 0); return; }
    closeMenu();
    // If a selected video leaves, use the first remaining display slot.
    const first = st.order.find((j) => j !== i);
    const to = (j) => { const keep = j === i ? first : j; return keep > i ? keep - 1 : keep; };
    const t = clock && i === st.clock ? tileTime(first) : undefined;
    saveNow(t, {
      order: Grid.orderAfterRemoval(st.order, i),
      offsets: st.offsets.filter((_, j) => j !== i),
      clock: to(st.clock), sound: to(st.sound), sel: to(st.sel),
    });
    vscode.postMessage({ type: 'remove', index: i });
  }

  let saveTimer = 0;
  function saveNow(t, changes) {
    clearTimeout(saveTimer);
    vscode.setState({
      pic: st.pic.mode, mode: st.mode, split: st.split, order: st.order, offsets: st.offsets, clock: st.clock, sound: st.sound, sel: st.sel,
      rate: st.rate, volume: st.volume, muted: st.muted, loop: st.loop, thresh: st.thresh, timeMode: st.timeMode,
      t: t ?? (pendingStart || (clock && begun && clock.startT !== null ? clock.currentTime() : saved.t || 0)),
      ...changes,
    });
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  // ---- copying -------------------------------------------------------------------------------

  async function copyCanvas(src, what, transcoded = false) {
    try {
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      if (!c.width || !c.height) return;
      c.getContext('2d').drawImage(src, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      // @ts-ignore
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(transcoded ? `${what} copied with transcoded pixels. For the original, see About.` : `${what} copied`, transcoded ? 4000 : 1500);
    } catch (e) {
      log(`clipboard refused: ${e}`);
      toast('Copy not allowed here');
    }
  }
  /** Ctrl+C: the whole view as shown (all tiles). */
  function copyView() {
    pause();
    if (comp) { draw(); copyCanvas(canvas, 'View', nativeTiles.includes('transcode')); }
  }
  function copyTileFrame(i) {
    const p = tiles[i];
    if (!p) return;
    pause();
    // A large grid's engine canvases hold no picture (sharedRenderer): the tile as drawn in the view.
    if (largeGrid) { copyTileView(i); return; }
    copyCanvas(p.snapshotSource ? p.snapshotSource() : p.cv, `Frame of ${tileLabel(i)}`, p.remoteStream);
  }
  function copyTileView(i) {
    const c = cells.find((x) => !x.add && x.tiles[0] === i);
    if (!comp || !c || !(c.pic.w > 0 && c.pic.h > 0)) return;
    draw();
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(c.pic.w * dpr));
    out.height = Math.max(1, Math.round(c.pic.h * dpr));
    out.getContext('2d').drawImage(canvas, Math.round(c.pic.x * dpr), Math.round(c.pic.y * dpr), out.width, out.height, 0, 0, out.width, out.height);
    copyCanvas(out, `Frame of ${tileLabel(i)}`, tiles[i]?.remoteStream);
  }
  function copyTileTime(i) {
    const text = fmtTime(tileTime(i));
    vscode.postMessage({ type: 'copyText', text });
    toast(`Copied ${text}`);
  }

  // ---- the panels (media/controls.js): ⚙, speed, jump sizes, about, shortcuts, and Compare --------

  function factsOf(i) {
    const p = tiles[i];
    const info = p && p.info ? p.info : {};
    return VpeControls.facts({
      name: names[i], size: sizes[i] || 0, duration: p && p.meta ? p.meta.duration : 0,
      width: p && p.meta ? p.meta.width : 0, height: p && p.meta ? p.meta.height : 0, fps: p ? p.fps || (p.meta && p.meta.fps) : 0,
      info, vmode: p && p.vmode, amode: p && p.amode, native: !!(p && p.cfg && p.cfg.native), remoteStream: !!p?.remoteStream,
      hasSound: !!(p && (p.audio || info.audio)), tracks: { audio: info.audio ? 1 : 0, sub: 0 },
    });
  }

  /** The Compare panel: the videos, Add video, the view (2 videos), Leave compare. */
  function renderCompare(s, k) {
    const f = document.createDocumentFragment();
    f.appendChild(k.heading('Videos'));
    st.order.forEach((i) => {
      const name = names[i];
      const role = `${i === st.clock ? ', clock' : ''}${i === st.sound ? ', sound' : ''}`;
      const b = k.btn('row cvid', name, () => { st.sel = i; k.show('cmpVid'); }, { value: offText(i), chev: true, aria: { 'aria-label': `${tileLabel(i)}: ${name}${role}, offset ${offText(i, true)}` } });
      b.dataset.i = String(i);
      const ltr = k.el('span', 'ltr', tileLabel(i));
      ltr.setAttribute('aria-hidden', 'true');
      b.insertBefore(ltr, b.firstChild);
      const val = b.querySelector('.val');
      val.classList.add('mono');
      if (i === st.clock) val.insertAdjacentHTML('beforebegin', `<span class="ico" title="Clock">${ICONS.clock(15)}</span>`);
      if (i === st.sound) val.insertAdjacentHTML('beforebegin', `<span class="ico" title="Sound">${ICONS.sound(15)}</span>`);
      f.appendChild(b);
    });
    if (N < MAX_TILES) f.appendChild(k.btn('row', 'Add video…', () => { k.close(false); addVideo(); }, { icon: ICONS.plus, value: `${N} of ${MAX_TILES}` }));
    // Add mode (src/addmode.js): every video clicked in the Explorer is added, until Esc, this row again or full.
    if (N < MAX_TILES) f.appendChild(k.btn('row', 'Add from the Explorer', () => { k.close(false); toggleAddMode(); }, { icon: ICONS.plus, kbd: 'Shift+D', aria: { role: 'switch', 'aria-checked': String(!addHint.hidden) } }));
    f.appendChild(k.el('div', 'sep'));
    if (N === 2) {
      const row = k.el('div', 'row static');
      row.insertAdjacentHTML('beforeend', ICONS.view);
      row.appendChild(k.el('span', 'grow', 'View'));
      const seg = k.el('div', 'seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'View');
      for (const [m, label] of [['side', 'Side by side'], ['split', 'Split']]) {
        seg.appendChild(k.btn('chip', label, () => { setMode(m); toast(m === 'split' ? 'Split · drag the divider' : 'Side by side'); k.render(); }, { aria: { 'aria-pressed': String(st.mode === m) } }));
      }
      row.appendChild(seg);
      f.appendChild(row);
      f.appendChild(k.btn('row', 'Swap sides', () => { swapSides(); k.render(); }, { icon: ICONS.swap, kbd: 'X' }));
      f.appendChild(k.el('div', 'sep'));
    }
    f.appendChild(k.btn('row', 'Leave compare', () => leave(), { icon: ICONS.leave, value: `keep ${tileLabel(st.clock)}`, aria: { 'aria-label': `Leave compare, keep ${tileLabel(st.clock)}` } }));
    return f;
  }

  /** One video's page: offset (frames or ms), clock, sound, replace, remove. */
  function renderVideo(s, k) {
    const i = Math.min(st.sel, N - 1);
    const o = st.offsets[i];
    const f = document.createDocumentFragment();
    const head = k.head(`${tileLabel(i)} ${names[i]}`, 'cmp');
    const g = head.querySelector('.grow');
    if (g) { g.textContent = names[i]; const l = k.el('span', 'ltr', tileLabel(i)); l.setAttribute('aria-hidden', 'true'); head.insertBefore(l, g); }
    f.appendChild(head);
    f.appendChild(k.heading('Offset'));
    const top = k.el('div', 'speedTop');
    const read = k.el('div', 'readout off', offText(i, true));
    const minus = k.btn('big', null, () => { nudge(i, -1); k.render(); }, { aria: { 'aria-label': `${tileLabel(i)} earlier` } });
    const plus = k.btn('big', null, () => { nudge(i, 1); k.render(); }, { aria: { 'aria-label': `${tileLabel(i)} later` } });
    minus.textContent = '−';
    plus.textContent = '+';
    top.append(minus, read, plus);
    f.appendChild(top);
    const units = k.el('div', 'unitrow');
    const seg = k.el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Offset in');
    for (const [u, label] of [['frames', 'Frames'], ['ms', 'Time (ms)']]) seg.appendChild(k.btn('chip', label, () => { setUnit(i, u); k.render(); }, { aria: { 'aria-pressed': String(o.unit === u) } }));
    units.appendChild(seg);
    if (o.v) units.appendChild(k.btn('link', 'Reset', () => { setOffset(i, 0); toast(`${tileLabel(i)} in step`); k.render(); }, { aria: { 'aria-label': `Reset the offset of ${tileLabel(i)}` } }));
    f.appendChild(units);
    const note = k.el('div', 'pnote');
    note.append(`Positive shows a later moment of ${tileLabel(i)}. `, k.kbd('−'), ' ', k.kbd('+'), ` nudge the video under the pointer${o.unit === 'ms' ? ' by 10 ms' : ''}.`);
    f.appendChild(note);
    f.appendChild(k.el('div', 'sep'));
    const clockRow = k.btn('row tall', null, () => { setClock(i); k.render(); }, { aria: { role: 'switch', 'aria-checked': String(i === st.clock), 'aria-label': 'Clock: seek bar, time and frame steps follow it' } });
    clockRow.insertAdjacentHTML('beforeend', `${ICONS.clock(18)}<span class="grow two"><span>Clock</span><span class="sub">Seek bar, time and frame steps follow it</span></span>`);
    clockRow.appendChild(k.sw(i === st.clock));
    f.appendChild(clockRow);
    const soundRow = k.btn('row', 'Sound from this video', () => { setSound(i); k.render(); }, { icon: ICONS.sound(18), aria: { role: 'switch', 'aria-checked': String(i === st.sound) } });
    soundRow.appendChild(k.sw(i === st.sound));
    f.appendChild(soundRow);
    f.appendChild(k.el('div', 'sep'));
    f.appendChild(k.btn('row', 'Replace video…', () => { k.close(false); replaceVideo(i); }, { icon: ICONS.replace }));
    f.appendChild(k.btn('row', N === 2 ? 'Remove (back to one video)' : 'Remove from compare', () => { k.close(false); removeTile(i); }, { icon: ICONS.remove }));
    return f;
  }

  const controls = VpeControls.create({
    panel: ui.panel, sheet: ui.sheet, bar: ui.bar,
    buttons: { cog: ui.cog, info: ui.infoBtn, rate: ui.rate, keys: ui.keysBtn, cmp: ui.cmpBtn, tracks: null },
    get: () => ({
      rate: st.rate, loop: st.loop, jump: prefs.jump, stepButtons: prefs.stepButtons, picture: picState(), compare: { soundLabel: `from ${tileLabel(st.sound)}` },
      tools: [{ label: 'Compare', note: `${N} videos`, on: true, keepOpen: true, run: () => controls.show('cmp', ui.cmpBtn) }],
      facts: factsOf(Math.min(st.infoSel, N - 1)),
      infoTabs: { keys: st.order.map(tileLabel), sel: st.order.indexOf(st.infoSel), pick: (slot) => { st.infoSel = st.order[slot]; } },
      canUseOriginal: nativeTiles[st.infoSel] === 'transcode',
      transcode: {
        mode: prefs.transcode, maxBitrateMbps: prefs.transcodeMaxBitrate,
        splitBitrate: prefs.transcodeSplitBitrate !== false,
      },
      canExternal: false,
    }),
    act: {
      loop: () => { setLoop(!st.loop); toast(st.loop ? 'Loop on' : 'Loop off'); },
      copyFrame: () => copyView(),
      setPicture: (m) => { setPic(Pic.fresh(m)); toast(Pic.name(m)); },
      zoomPicture: (d) => zoomPic(st.pic.zoom * (d > 0 ? Pic.STEP : 1 / Pic.STEP)),
      resetPicture: () => setPic(Pic.fresh(st.pic.mode)),
      setRate: (r) => changeRate(r),
      stepRate: (d) => bumpRate(d),
      setJump: (key, v) => { setJump(key, v); updateStepTips(); },
      setStepButtons: (v) => { prefs.stepButtons = v; updateStepTips(); vscode.postMessage({ type: 'pref', key: 'stepButtons', value: v }); },
      setTranscode: (mode) => { saveNow(); vscode.postMessage({ type: 'transcodePref', mode }); },
      setTranscodeMaxBitrate: (maxBitrateMbps) => vscode.postMessage({ type: 'transcodePref', maxBitrateMbps }),
      setTranscodeSplitBitrate: (splitBitrate) => vscode.postMessage({ type: 'transcodePref', splitBitrate }),
      useOriginal: () => vscode.postMessage({ type: 'originalTile', index: st.infoSel }),
      copyInfo: (d) => { vscode.postMessage({ type: 'copyText', text: [d.title, d.sub, ...d.rows.map(([a, b]) => `${a}: ${b}`)].join('\n') }); toast('Details copied'); },
      extSettings: () => vscode.postMessage({ type: 'openSettings' }),
    },
    views: {
      cmp: { label: 'Compare', button: 'cmp', render: renderCompare },
      cmpVid: { label: () => `${tileLabel(st.sel)}: ${names[st.sel]}`, button: 'cmp', parent: 'cmp', render: renderVideo },
    },
  });
  /** An open Compare page follows changes (clock, sound, offsets) made elsewhere (keys, tiles). */
  function refreshPanel() {
    const v = controls.view();
    if (v === 'cmp' || v === 'cmpVid' || v === 'main') controls.render();
  }

  // ---- tile reordering -----------------------------------------------------------------------

  function updateOrderLayout() {
    layoutCells();
    viewDirty = infoDirty = true;
    wakeLoop();
  }
  function commitOrder(order, video) {
    if (order === st.order) return;
    st.order = order;
    hover = null;
    closeMenu();
    updateOrderLayout();
    updateMuteUi();
    if (controls.view() === 'info') controls.refresh();
    else refreshPanel();
    requestTileSize();
    saveNow();
    vscode.postMessage({ type: 'tileOrder', order });
    announce(`${names[video]} moved to ${tileLabel(video)}`);
  }
  function moveWithArrow(el) {
    const video = Number(el.dataset.i), direction = Number(el.dataset.d);
    const from = st.order.indexOf(video);
    const focused = el === document.activeElement;
    finishReorderDrag();
    commitOrder(Grid.moveTile(st.order, from, from + direction), video);
    if (focused) {
      const buttons = `[data-act="move"][data-i="${video}"]:enabled`;
      (cellsEl.querySelector(`${buttons}[data-d="${direction}"]`) || cellsEl.querySelector(buttons))?.focus();
    }
  }
  function setReordering(on) {
    if (on === reordering) return;
    reordering = on;
    finishReorderDrag();
    stage.classList.toggle('reordering', on);
    reorderBtn.textContent = on ? 'Done' : 'Reorder';
    reorderHint.hidden = !on;
    if (on) {
      closeMenu();
      controls.closeAll(false);
      if (!addHint.hidden) vscode.postMessage({ type: 'stopAddMode' });
      panDrag = null;
      stage.classList.remove('panning');
      announce(reorderHint.textContent);
    }
    layoutCells();
  }
  reorderBtn.onclick = () => setReordering(!reordering);

  function reorderSlot(e, splitX) {
    const hit = cellAt(e.clientX, e.clientY);
    if (!hit) return -1;
    return hit.c.split ? Number(e.clientX >= splitX) : cells.indexOf(hit.c);
  }
  stage.addEventListener('pointerdown', (e) => {
    if (!reordering || reorderDrag || e.button !== 0 || e.target.closest('[data-act="move"]')) return;
    const r = stage.getBoundingClientRect(), c = cells[0];
    // Keep the target boundary fixed while previewing two videos of different shapes.
    // A divider at either edge still leaves a target for each video.
    const splitX = c.split ? r.left + Math.max(r.width * 0.1, Math.min(r.width * 0.9, c.pic.x + c.pic.w * st.split)) : 0;
    const from = reorderSlot(e, splitX);
    if (from < 0) return;
    reorderDrag = { id: e.pointerId, from, to: from, x: e.clientX, y: e.clientY, splitX, moved: false, preview: st.order };
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer (test hook) */ }
  });
  function previewReorder(e) {
    const drag = reorderDrag;
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    stage.classList.add('reorder-drag');
    const to = reorderSlot(e, drag.splitX);
    if (to === drag.to) return;
    drag.to = to;
    // Every preview starts from the committed order, so reversing direction is reversible.
    drag.preview = Grid.moveTile(st.order, drag.from, to);
    updateOrderLayout();
  }
  function finishReorderDrag(commit = false) {
    const drag = reorderDrag;
    if (!drag) return;
    reorderDrag = null;
    stage.classList.remove('reorder-drag');
    if (stage.hasPointerCapture(drag.id)) stage.releasePointerCapture(drag.id);
    if (commit && drag.preview !== st.order) commitOrder(drag.preview, st.order[drag.from]);
    else if (drag.preview !== st.order) updateOrderLayout();
  }
  stage.addEventListener('pointermove', previewReorder);
  stage.addEventListener('pointerup', (e) => {
    if (e.pointerId !== reorderDrag?.id) return;
    previewReorder(e);
    finishReorderDrag(true);
  });
  for (const event of ['pointercancel', 'lostpointercapture']) {
    stage.addEventListener(event, (e) => { if (e.pointerId === reorderDrag?.id) finishReorderDrag(); });
  }

  // ---- the tiles' right-click menu --------------------------------------------------------------

  /** @type {HTMLElement|null} */
  let menuOpener = null;
  function closeMenu() {
    if (ui.menu.hidden) return;
    ui.menu.hidden = true;
    ui.menu.textContent = '';
  }
  /** Tile i's actions (as in the mock-up), at client (x, y). */
  function openMenu(i, x, y) {
    controls.closeAll(false);
    const k = tileLabel(i);
    const m = ui.menu;
    m.textContent = '';
    const item = (label, hint, run) => {
      const b = document.createElement('button');
      b.className = 'mi';
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      const lab = document.createElement('span');
      lab.className = 'grow';
      lab.textContent = label;
      b.appendChild(lab);
      if (hint) { const h = document.createElement('span'); h.className = 'h'; h.textContent = hint; b.appendChild(h); }
      b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); run(); });
      m.appendChild(b);
    };
    const sep = () => { const s = document.createElement('div'); s.className = 'msep'; s.setAttribute('role', 'separator'); m.appendChild(s); };
    const playing = isPlaying();
    item(playing ? 'Pause' : 'Play', 'Space', togglePlay);
    sep();
    item(`${i === st.clock ? '✓ ' : ''}${k} sets the clock`, '', () => setClock(i));
    item(`${i === st.sound ? '✓ ' : ''}Sound from ${k}`, '', () => setSound(i));
    item(`Offset of ${k}…`, offText(i), () => { st.sel = i; controls.show('cmpVid', ui.cmpBtn); });
    sep();
    item(`Copy frame (${k})`, '', () => copyTileFrame(i));
    item(`Copy timestamp (${k})`, fmtTime(tileTime(i)), () => copyTileTime(i));
    sep();
    item(`Replace ${k}…`, '', () => replaceVideo(i));
    item(`Remove ${k}`, '', () => removeTile(i));
    if (N < MAX_TILES) item('Add video…', '', addVideo);
    item('Leave compare', '', () => leave());
    sep();
    item('Keyboard shortcuts', '?', () => controls.openSheet(ui.keysBtn));
    item('Settings…', '', () => controls.show('main', ui.cog));
    m.hidden = false;
    m.dataset.tile = String(i);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
    menuOpener = /** @type {any} */ (document.activeElement);
    /** @type {any} */ (m.querySelector('.mi')).focus();
  }
  ui.menu.addEventListener('keydown', (e) => {
    const items = /** @type {HTMLElement[]} */ ([...ui.menu.querySelectorAll('.mi')]);
    const i = items.indexOf(/** @type {any} */ (document.activeElement));
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': items[(i + 1) % items.length].focus(); break;
      case 'ArrowUp': items[(i - 1 + items.length) % items.length].focus(); break;
      case 'Home': items[0].focus(); break;
      case 'End': items[items.length - 1].focus(); break;
      case 'Escape': case 'Tab': closeMenu(); if (menuOpener && menuOpener.focus) menuOpener.focus(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    if (handled || e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  });
  ui.menu.addEventListener('click', (e) => e.stopPropagation());
  window.addEventListener('blur', closeMenu);
  /** The tile under client (x, y): its cell, or (split) the side of the divider. */
  function tileAt(target, x) {
    const cell = target && target.closest ? target.closest('.cell') : null;
    if (!cell || cell.dataset.tile === undefined) return null;
    if (cell.dataset.tile !== 'split') return Number(cell.dataset.tile);
    const c = cells[0];
    const r = stage.getBoundingClientRect();
    const [l, rr] = c.tiles;
    return x - r.left < c.pic.x + c.pic.w * st.split ? l : rr;
  }
  document.addEventListener('contextmenu', (e) => {
    // Our own menu instead of VS Code's (a webview's default menu only has Cut / Copy / Paste).
    e.preventDefault();
    if (reordering || !clock) return;
    const t = tileAt(e.target, e.clientX);
    openMenu(t === null ? st.clock : t, e.clientX, e.clientY);
  });

  // ---- pointer on the tiles --------------------------------------------------------------------

  /** The tile under the pointer (− / + nudge it), or null. */
  let hover = null;
  cellsEl.addEventListener('pointermove', (e) => { hover = tileAt(e.target, e.clientX); });
  cellsEl.addEventListener('pointerleave', () => { hover = null; });
  cellsEl.addEventListener('click', (e) => {
    const el = /** @type {any} */ (e.target).closest('[data-act]');
    if (el) {
      e.stopPropagation();
      const i = Number(el.dataset.i);
      if (el.dataset.act === 'move') moveWithArrow(el);
      else if (reordering) return;
      else if (el.dataset.act === 'openVid') { closeMenu(); st.sel = i; controls.show('cmpVid', ui.cmpBtn); }
      else if (el.dataset.act === 'nudge') nudge(i, Number(el.dataset.d));
      else if (el.dataset.act === 'add') addVideo();
    }
  });
  // A click on the picture plays or pauses; with a panel or the menu open it only closes them.
  stage.addEventListener('click', (e) => {
    if (reordering || e.defaultPrevented) return;
    if (!ui.menu.hidden) { closeMenu(); return; }
    if (controls.anyOpen()) { controls.closeAll(false); return; }
    if (performance.now() - dragEnded < 300) return;
    if (/** @type {any} */ (e.target).closest('#divider')) return;
    togglePlay();
  });
  // Ctrl+wheel (pinch) zooms every tile around the pointer; a drag moves them all (the same part of each picture).
  stage.addEventListener('wheel', (e) => {
    if (reordering) { e.preventDefault(); return; }
    if (!e.ctrlKey || !clock) return;
    const hit = cellAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    zoomPic(st.pic.zoom * Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.002), hit);
    const c = clockCell();
    if (c) toast(`Zoom ${cellPercent(hit.c)}%`);
  }, { passive: false });
  let panDrag = null;
  // A drag may start on a name pill or an offset nudge too (they sit over the picture's corners and edges): the 4 px
  // threshold keeps a plain click on them a click, and the click that ends a drag is swallowed below.
  stage.addEventListener('pointerdown', (e) => {
    if (reordering || e.button !== 0 || !clock || /** @type {any} */ (e.target).closest('#divider, #menu, .move')) return;
    const hit = cellAt(e.clientX, e.clientY);
    if (!hit) return;
    // One view for all tiles: a tile that fits its cell may start the drag when another one overflows.
    const ref = Pic.panCell(cells, hit.c);
    if (!ref) return;
    panDrag = { x: e.clientX, y: e.clientY, pic: st.pic, hit: { ...hit, c: ref, i: ref.tiles[0] }, moved: false, id: e.pointerId };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!panDrag || e.pointerId !== panDrag.id) return;
    const dx = e.clientX - panDrag.x, dy = e.clientY - panDrag.y;
    if (!panDrag.moved && Math.hypot(dx, dy) < 4) return;
    if (!panDrag.moved) { panDrag.moved = true; stage.setPointerCapture(e.pointerId); stage.classList.add('panning'); }
    const h = panDrag.hit;
    setPic(Pic.panBy(panDrag.pic, dx, dy, tileNat(h.i), tileSrc(h.i), cellView(h.c), picOpts()));
  });
  const endPan = (e) => {
    if (!panDrag || e.pointerId !== panDrag.id) return;
    if (panDrag.moved && e.type === 'pointerup') dragEnded = performance.now(); // not a click: no play / pause
    panDrag = null;
    stage.classList.remove('panning');
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('click', (e) => {
    if (performance.now() - dragEnded >= 300 || !(/** @type {any} */ (e.target).closest('.pill, .nudge'))) return;
    e.stopPropagation(); // the end of a pan that started on a pill is not a click on it
    e.preventDefault();
  }, true);
  stage.addEventListener('pointercancel', endPan);
  stage.addEventListener('wheel', (e) => { if (reordering || e.ctrlKey) return; if (clock && !clock.playing) { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); } }, { passive: false });

  // ---- the bar ------------------------------------------------------------------------------------

  // The time follows the clock video: its letter first.
  const who = document.createElement('span');
  who.className = 'who';
  ui.time.insertBefore(who, ui.time.firstChild);

  let scrubbing = false;
  let lastUi = '';
  function updateUi() {
    if (!clock) return;
    const f = clock.currentFrame();
    if (!scrubbing) ui.seek.value = String(f);
    const playing = clock.playing;
    const fr = tiles.map((p, i) => (p === clock ? f + 1 : p.shownT !== null && !outs[i] ? frameOf(p) + 1 : null));
    const t = clock.currentTime();
    const key = `${fr.join(',')}|${playing}|${t.toFixed(3)}|${tiles.map((p) => p.n).join(',')}|${st.timeMode}|${st.clock}`;
    if (key !== lastUi || infoDirty) {
      lastUi = key;
      infoDirty = false;
      const dur = clock.meta.duration || 0;
      const fps = fpsOf(clock);
      const nFrames = clock.n || (fps && dur ? Math.round(dur * fps) : 0);
      who.textContent = tileLabel(st.clock);
      if (st.timeMode === 1) { ui.now.textContent = fmtTimecode(f, fps); ui.dur.textContent = `/ ${fmtTimecode(nFrames, fps)}`; }
      else if (st.timeMode === 2) { ui.now.textContent = `frame ${f + 1}`; ui.dur.textContent = `/ ${nFrames || '?'}`; }
      else { ui.now.textContent = fmtTime(t); ui.dur.textContent = `/ ${fmtTime(dur)}`; }
      ui.time.title = `Time of the clock video (${tileLabel(st.clock)}). Click: time / timecode / frames`;
      ui.time.setAttribute('aria-label', `${tileLabel(st.clock)} position ${fmtTime(t)}, frame ${f + 1}. Click to change the format.`);
      ui.play.classList.toggle('playing', playing);
      ui.play.setAttribute('aria-label', playing ? 'Pause all' : 'Play all');
      ui.play.title = `${playing ? 'Pause' : 'Play'} all  Space`;
      // The slider's value is a frame index: screen readers read the time instead.
      ui.seek.setAttribute('aria-valuetext', `${tileLabel(st.clock)} ${fmtTime(t)} of ${fmtTime(dur)}, frame ${f + 1}`);
      updateTileInfo(fr);
    }
  }

  ui.play.onclick = togglePlay;
  // The buttons beside Play: one frame (lockstep), or the Ctrl+arrow jump (setting stepButtons, as in the player).
  const stepBtn = (d) => (prefs.stepButtons === 'jump' ? jump(prefs.jump.ctrl, d) : step(d));
  ui.prev.onclick = () => stepBtn(-1);
  ui.next.onclick = () => stepBtn(1);
  function updateStepTips() {
    const tips = VpeControls.stepTips(prefs);
    ui.prev.title = prefs.stepButtons === 'jump' ? tips.back : 'Previous frame (all videos)  ,';
    ui.next.title = prefs.stepButtons === 'jump' ? tips.fwd : 'Next frame (all videos)  .';
    ui.prev.setAttribute('aria-label', tips.backLabel);
    ui.next.setAttribute('aria-label', tips.fwdLabel);
  }
  updateStepTips();
  ui.mute.onclick = () => setMute(!st.muted);
  ui.volume.addEventListener('input', () => setVolume(Number(ui.volume.value)));
  ui.volume.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(st.volume + (e.deltaY < 0 ? 0.05 : -0.05)); toast(`Volume ${Math.round(st.volume * 100)}%`); }, { passive: false });
  ui.time.onclick = () => { st.timeMode = (st.timeMode + 1) % 3; lastUi = ''; updateUi(); save(); toast(['Time', 'Timecode', 'Frame number'][st.timeMode]); };
  ui.rate.onclick = () => controls.toggle('speed', ui.rate);
  ui.rate.addEventListener('wheel', (e) => { e.preventDefault(); bumpRate(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  ui.cog.onclick = () => controls.toggle('main', ui.cog);
  ui.infoBtn.onclick = () => controls.toggle('info', ui.infoBtn);
  ui.infoBtn.title = 'About these videos  I';
  ui.infoBtn.setAttribute('aria-label', 'About these videos');
  ui.keysBtn.onclick = () => controls.toggleSheet(ui.keysBtn);
  ui.picBtn.onclick = (e) => { e.stopPropagation(); cyclePic(); };
  updatePicBtn();
  ui.cmpBtn.onclick = () => controls.toggle('cmp', ui.cmpBtn);
  ui.full.onclick = toggleFullscreen;
  ui.seek.addEventListener('input', () => { scrubbing = true; if (clock) { clock.seekFrame(Number(ui.seek.value)); if (clock.playing) syncPlaying(true); } });
  ui.seek.addEventListener('change', () => { scrubbing = false; });
  ui.seek.addEventListener('mousemove', (e) => {
    if (!clock || !clock.n) return;
    const r = ui.seek.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const f = Math.round(x * (clock.n - 1));
    ui.tip.textContent = `${tileLabel(st.clock)} ${fmtTime(f / fpsOf(clock))} · #${f + 1}`;
    ui.tip.style.left = `${Math.max(30, Math.min(r.width - 30, e.clientX - r.left))}px`;
    ui.tip.hidden = false;
  });
  ui.seek.addEventListener('mouseleave', () => { ui.tip.hidden = true; });
  // A click on the bar's empty space closes the menu.
  ui.bar.addEventListener('click', () => closeMenu());

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      // Some hosts don't allow fullscreen in webviews; maximize the editor instead.
      log(`fullscreen refused: ${e}`);
      document.body.classList.toggle('maxi');
      vscode.postMessage({ type: 'focusMode' });
    }
  }
  // Controls hide after a moment in fullscreen.
  let hideTimer = 0;
  const poke = () => {
    document.body.classList.remove('idle');
    clearTimeout(hideTimer);
    if (document.fullscreenElement && isPlaying()) hideTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  };
  document.addEventListener('mousemove', poke);
  document.addEventListener('focusin', poke);
  document.addEventListener('fullscreenchange', () => { poke(); layoutDirty = true; });

  document.addEventListener('keydown', (e) => {
    if (!reordering || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    controls.closeAll(false);
    setReordering(false);
    reorderBtn.focus();
  }, { capture: true });
  document.addEventListener('keydown', (e) => {
    // Typing in a field, a list box, or Space / Enter on a button reached with the keyboard: not player keys.
    if (VpeModes.ownsKey(e)) return;
    const altGr = !!(e.getModifierState && e.getModifierState('AltGraph')); // AltGr types { } [ ] on many layouts
    const mod = !altGr && (e.ctrlKey || e.metaKey) && !e.altKey;
    // Ctrl keys the page uses stop here, so VS Code doesn't run its own binding as well (docs/notes/ui-simple.md).
    if (clock && mod && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); e.stopPropagation(); jump(prefs.jump.ctrl, e.key === 'ArrowLeft' ? -1 : 1); return; }
    if (clock && mod && !e.shiftKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); e.stopPropagation(); copyView(); return; }
    if (e.key === 'Escape' && !ui.menu.hidden) { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'Escape' && controls.anyOpen()) { e.preventDefault(); controls.closeAll(true); return; }
    if (e.key === 'Escape' && !addHint.hidden) { e.preventDefault(); vscode.postMessage({ type: 'stopAddMode' }); return; }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); controls.toggleSheet(ui.keysBtn); return; }
    if (!clock || e.metaKey || (!altGr && (e.ctrlKey || e.altKey))) return;
    poke();
    const pair = N === 2;
    /** − / +: the video under the pointer, else the one last chosen. */
    const target = () => (hover !== null && hover < N ? hover : st.sel < N ? st.sel : 1);
    let handled = true;
    switch (e.key) {
      case ' ': case 'k': case 'K': togglePlay(); break;
      case 'j': case 'J': skip(-10); break;
      case 'l': case 'L': skip(10); break;
      case 'ArrowLeft': jump(e.shiftKey ? prefs.jump.shift : prefs.jump.arrow, -1); break;
      case 'ArrowRight': jump(e.shiftKey ? prefs.jump.shift : prefs.jump.arrow, 1); break;
      case ',': step(-1); break;
      case '.': step(1); break;
      case '<': case '[': bumpRate(-1); break;
      case '>': case ']': bumpRate(1); break;
      case 'ArrowUp': setVolume(st.volume + 0.05); toast(`Volume ${Math.round(st.volume * 100)}%`); break;
      case 'ArrowDown': setVolume(st.volume - 0.05); toast(`Volume ${Math.round(st.volume * 100)}%`); break;
      case 'Home': pause(); seekClock(0); break;
      case 'End': pause(); clock.seekFrame(clock.n - 1); break;
      case 'm': case 'M': setMute(!st.muted); break;
      case 'r': case 'R': setLoop(!st.loop); toast(st.loop ? 'Loop on' : 'Loop off'); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'i': case 'I': controls.toggle('info', ui.infoBtn); break;
      case 'x': case 'X': if (pair) swapSides(); else handled = false; break;
      case 'z': case 'Z': if (e.shiftKey) handled = false; else cyclePic(); break;
      case 'D': if (e.shiftKey && N < MAX_TILES) toggleAddMode(); else handled = false; break;
      case '-': case '_': if (!reordering) nudge(target(), -1); break;
      case '+': case '=': if (!reordering) nudge(target(), 1); break;
      case 'Escape': if (INTERNAL && scanner.running) scanner.stop('Stopped'); else handled = false; break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });


  // ---- background scan: first frame below a PSNR threshold ------------------------------
  // Kept for a future advanced mode (2026-11-20): no button or key; window.vpeCompare and the test hook start it.

  const scanner = {
    running: false,
    sA: /** @type {any} */ (null),
    sB: /** @type {any} */ (null),
    from: 0,
    thresh: 40,
    count: 0,
    t0: 0,
    timer: 0,
    started: false,
    d: 0,
    /** @type {any} */ found: null,
    start() {
      if (N !== 2 || tiles.length < 2 || this.running) return;
      this.running = true;
      this.thresh = st.thresh;
      this.from = frameOf(tiles[0]) + 1;
      this.count = 0;
      this.t0 = performance.now();
      this.started = false;
      this.found = null;
      this.d = offSec(1) - offSec(0); // B against A, seconds
      this.sA = makeEngine('sA', { quiet: true, budget: 96e6 * memory.scale });
      this.sB = makeEngine('sB', { quiet: true, budget: 96e6 * memory.scale });
      this.timer = setTimeout(() => this.loop(), 20);
    },
    onReady() { /* the loop polls */ },
    stop(text, found) {
      if (!this.running) return;
      this.running = false;
      clearTimeout(this.timer);
      for (const p of [this.sA, this.sB]) if (p) { p.dispose(); delete engines[p.key]; }
      this.sA = this.sB = null;
      if (found) this.found = found;
      log(`scan: ${text} (${this.count} frames in ${((performance.now() - this.t0) / 1000).toFixed(1)} s)`);
    },
    fail(text) { this.stop(`Scan failed: ${text}`); },
    async loop() {
      if (!this.running) return;
      const { sA, sB } = this;
      try {
        if (!this.started) {
          // Both engines know where their files start: seek them to the first frame to check.
          // (and their frame rates, measured from the first decoded frames).
          if (sA.startT === null || sB.startT === null || !sA.fps || !sB.fps) { this.timer = setTimeout(() => this.loop(), 20); return; }
          this.started = true;
          sA.seekFrame(this.from);
          const bRel = (this.from + 0.5) / fpsOf(sA) + this.d - 0.75 / fpsOf(sB);
          sB.seekTime(Math.max(0, bRel));
        }
        const t0 = performance.now();
        // Work in slices of ~25 ms so the page stays responsive.
        while (performance.now() - t0 < 25) {
          if (sA.seekTarget !== null || !sA.queue.length) {
            if (sA.eof && !sA.queue.length && sA.seekTarget === null && !(sA.vdec && sA.vdec.decodeQueueSize)) {
              this.stop(`No frame below ${this.thresh} dB after #${this.from} (${this.count} frames checked)`);
              return;
            }
            break;
          }
          const tA = sA.queue[0].t;
          const aRel = sA.rel(tA);
          const bRel = aRel + this.d + 0.25 / fpsOf(sB);
          const Tb = sB.startT + bRel;
          const eB = earlyOf(sB);
          const bLast = sB.queue.length ? sB.queue[sB.queue.length - 1].t : -Infinity;
          const bDone = sB.eof && sB.seekTarget === null && !(sB.vdec && sB.vdec.decodeQueueSize);
          if (sB.seekTarget !== null || (bLast <= Tb + eB && !bDone)) break; // B not decoded that far yet
          sA.pauseT = tA;
          sA.tick();
          sB.pauseT = Tb;
          sB.tick();
          const frame = Math.round(aRel * fpsOf(sA));
          this.count++;
          if (sB.shownT === null || outOfRange(tiles[1], bRel)) continue;
          const m = await pairMetrics(sA, sB, { ssim: false, rgb: false });
          if (!this.running) return;
          if (m && m.psnrY < this.thresh) {
            this.stop(`#${frame + 1}: PSNR Y ${fmtDb(m.psnrY)} (< ${this.thresh} dB)`, { frame, psnrY: m.psnrY });
            pause();
            seekTile(0, frame);
            return;
          }
        }
      } catch (e) {
        log(`scan error: ${e && e.stack || e}`);
        this.fail(String(e && e.message || e));
        return;
      }
      this.timer = setTimeout(() => this.loop(), 0);
    },
  };

  // ---- frame loop ---------------------------------------------------------------------

  /** Page exit or failed setup: stop every engine and release the WebGL contexts now, not at garbage collection. */
  function disposeEngines() {
    scanner.stop();
    for (const p of Object.values(engines)) {
      try {
        p.dispose();
        p.gl?.gl?.getExtension('WEBGL_lose_context')?.loseContext();
      } catch (e) { log(`dispose ${p.key}: ${e && e.message || e}`); }
      delete engines[p.key];
    }
    for (const r of [comp, metrics, renderer]) r?.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    tiles = [];
    clock = comp = metrics = renderer = scratch = null;
  }
  window.addEventListener('pagehide', disposeEngines, { once: true });

  // The frame loop rests while paused with every tile settled and nothing to draw or sync for
  // REST_AFTER_MS (as the player's, media/player.js); input, messages and decoder outputs wake it.
  const REST_AFTER_MS = 1000;
  let loopOn = true;
  let quietSince = null;
  function wakeLoop() {
    quietSince = null;
    if (loopOn) return;
    loopOn = true;
    requestAnimationFrame(frameLoop);
  }
  for (const ev of ['message', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'click', 'focusin', 'resize', 'fullscreenchange', 'visibilitychange', 'contextmenu']) {
    window.addEventListener(ev, wakeLoop, { capture: true, passive: true });
  }
  function restful() {
    return !!clock && tiles.length === N && begun && !clock.playing && !pendingStart && !scanner.running && !waiting
      && !waitSince && !viewDirty && !layoutDirty && !infoDirty && !scrubbing && tiles.every((p) => typeof p.settled === 'function' && p.settled());
  }

  function frameLoop(now) {
    if (clock && tiles.length === N) {
      try {
        clock.tick(now);
        if (restoreClock && clock.startT !== null && clock.vmode !== undefined && visible) {
          const { time, playing } = restoreClock;
          restoreClock = null;
          if (time > 0) clock.seekTime(time);
          if (playing) play();
        }
        if (begun && visible) {
          if (pendingStart && tiles.every((p) => p.startT !== null)) { clock.seekTime(pendingStart); pendingStart = 0; }
          if (clock.playing) syncPlaying(); else syncPaused();
        }
        for (const p of tiles) if (p !== clock) p.tick(now);
        present(now);
        updateUi();
      } catch (e) {
        log(`frame loop: ${e && e.stack || e}`);
      }
    }
    if (!restful()) quietSince = null;
    else if (quietSince === null) quietSince = now;
    else if (now - quietSince > REST_AFTER_MS) { loopOn = false; return; }
    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  let restoreClock = null;
  let visible = !document.hidden;
  let resumeOnShow = false;
  const syncVisibility = Grid.compareVisibility((shown) => {
    visible = shown;
    if (!visible) setReordering(false);
    if (!clock) return;
    if (!visible) { resumeOnShow = resumeOnShow || clock.playing; pause(); }
    for (const p of tiles) if (p.remoteStream) p.setHidden(!visible);
    if (visible && resumeOnShow) { resumeOnShow = false; play(); }
  });
  document.addEventListener('visibilitychange', () => syncVisibility(document.hidden));

  function useOriginalTile(i, notice) {
    const old = tiles[i];
    if (!old || nativeTiles[i] !== 'transcode') return;
    if (old === clock) {
      restoreClock = { time: clock.currentTime(), playing: clock.playing };
      pause();
    }
    old.dispose();
    old.gl?.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    nativeTiles[i] = false;
    const p = makeEngine(KEYS[i], { quiet: false, budget: memory.frames });
    tiles[i] = p;
    if (old === clock) { clock = p; p.setLoop(st.loop); lastGen = -1; }
    else followClock(p, i);
    p.setRate(st.rate);
    applyVolume();
    reqs = [];
    upCount[i] = 0;
    lastMetrics = null;
    lastMetricsKey = '';
    infoDirty = layoutDirty = true;
    if (notice) toast(`${tileLabel(i)}: ${notice}`);
    controls.refresh();
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.page !== cfg.page) return;
    switch (m.type) {
      case 'toast': toast(String(m.text || ''), Math.min(10000, Number(m.ms) || 1500)); break;
      case 'addMode':
        if (m.on) setReordering(false);
        showAddMode(m);
        break;
      case 'open':
        syncVisibility(document.hidden, m.visible !== false);
        sizes = m.sizes;
        nativeTiles = m.native || nativeTiles;
        try {
          // The shared renderer of a large grid draws into the compositor's textures from the first frame.
          if (largeGrid && !comp) comp = new Compositor(canvas);
          tiles = names.map((_, i) => makeEngine(KEYS[i], { quiet: false, budget: memory.frames }));
          setClock(st.clock, true);
        } catch (err) {
          disposeEngines();
          vscode.postMessage({ type: 'stop' });
          log(`decoder could not start: ${err && err.message || err}`);
          showMessage('host', 'The decoder could not start.', String(err && err.message || err));
          return;
        }
        showMessage('host', '');
        showMessage('A', 'Opening…');
        break;
      case 'block': {
        const p = engines[m.key];
        if (p) p.onBlock(m.pos, m.data);
        break;
      }
      case 'resize': {
        if (!clock) break;
        // Every resized tile seeks from the same clock sample, including when playback is paused.
        const cRel = clockPos();
        const synced = lastGen === clock.gen;
        for (const i of m.tiles) {
          const p = tiles[i];
          if (p) p.refreshNativeFrame(false, p === clock ? cRel : relFor(i, cRel));
        }
        if (synced) lastGen = clock.gen; // resizing the clock didn't move it
        break;
      }
      // Native ffmpeg tiles (the host decodes; frames at the tile's size).
      case 'nd': {
        const p = engines[m.key];
        if (!p?.cfg.native) break;
        if (m.m.type === 'size') {
          const { width, height } = m.m;
          Object.assign(p.info.video, { width, height });
          p.updateNativeSize();
        } else if (m.m.type === 'remoteNotice') toast(`${m.key}: ${m.m.text}`, 6000);
        else p.onWorker(m.m);
        break;
      }
      case 'ndv': { const p = engines[m.key]; if (p) p.onNativeVideo(m); break; }
      case 'nda': { const p = engines[m.key]; if (p) p.onNativeAudio(m); break; }
      case 'originalTile': useOriginalTile(m.index, m.notice); break;
      case 'visible':
        if (m.active === false) setReordering(false);
        syncVisibility(document.hidden, m.visible);
        break;
      case 'prefs':
        if (m.prefs && m.prefs.jump) Object.assign(prefs.jump, m.prefs.jump);
        if (m.prefs && m.prefs.stepButtons) prefs.stepButtons = m.prefs.stepButtons;
        if (m.prefs) {
          prefs.transcode = m.prefs.transcode;
          prefs.transcodeMaxBitrate = m.prefs.transcodeMaxBitrate;
          prefs.transcodeSplitBitrate = m.prefs.transcodeSplitBitrate;
        }
        updateStepTips();
        controls.refresh();
        break;
      case 'error': showMessage('host', m.message); break;
    }
  });

  layoutCells();
  setLoop(st.loop);
  setRate(st.rate);
  ui.volume.value = String(st.volume);
  setMute(st.muted);
  // A video opened into compare starts where the player was.
  if (!(saved.t > 0) && cfg.start > 0) saved.t = cfg.start;

  const synced = () => !!clock && !clock.playing && tiles.every((p, i) => outs[i] || settled(p)) && upCount[st.clock] === (clock.shownCount || 0);
  // For tests and debugging (and the future advanced mode: metrics, the difference search).
  /** @type {any} */ (window).vpeCompare = {
    get tiles() { return tiles; }, get clock() { return clock; }, get A() { return tiles[0]; }, get B() { return tiles[1]; },
    st, scanner, settled, computeMetrics, ssim, synced,
    step, seekClock, seekA: seekClock, play, pause, setMode, setOffset, setClock, setSound, setSplit, swapSides, nudge, leave, removeTile,
    metrics: () => lastMetrics,
    measure: (opt) => pairMetrics(tiles[0], tiles[1], { ssim: true, rgb: true, ...opt }),
  };

  // Test hook (VPE_LOG only): the host forwards debug messages from the test runner.
  function report() {
    const per = (f) => tiles.map(f).join(',');
    const g = Grid.gridFor(N, st.mode);
    log(`compare report n=${N} mode=${st.mode} modes=${N > 2 ? 'grid' : 'side,split'} canvas=${canvas.width}x${canvas.height} grid=${g.cols}x${g.rows} max=${MAX_TILES} now=${Math.round(performance.now())}`
      // WebGL contexts in use: the compositor, the shared renderer (5+ tiles), each engine's own (2-4 tiles), metrics.
      + ` contexts=${[comp, renderer, metrics].filter(Boolean).length + tiles.filter((p) => p.gl && p.gl.gl).length}`
      + ` frame=${clock ? clock.currentFrame() + 1 : '-'} clock=${st.clock} sound=${st.sound} muted=${st.muted} split=${st.split.toFixed(3)} swap=${N === 2 && st.order[0] === 1}`
      + ` playing=${per((p) => (p.playing ? 1 : 0))} frames=${per((p) => (p.shownT === null ? '-' : frameOf(p) + 1))} shown=${per((p) => p.shownCount || 0)}`
      + ` synced=${synced()} native=${per((p) => (p.cfg.native ? 1 : 0))} heights=${per((p) => p.cv.height || 0)} fps=${per((p) => fpsOf(p).toFixed(2))}`
      + ` widths=${per((p) => p.cv.width || 0)} stage=${tileSize().w}x${tileSize().h}`
      + ` transport=${per((p) => p.frameStream ? 'stream' : p.cfg.native ? 'message' : '-')}`
      + ` gains=${per((p) => (p.gain ? p.gain.gain.value.toFixed(2) : 'x'))} audio=${per((p) => (p.info && p.info.audio ? 1 : 0))}`
      + ` offsets=${st.offsets.map((o) => `${o.v}${o.unit === 'ms' ? 'ms' : 'f'}`).join(',')} seekMax=${ui.seek.max}`
      + ` picture=${st.pic.mode} zoom=${st.pic.zoom.toFixed(3)} cx=${st.pic.cx.toFixed(3)} cy=${st.pic.cy.toFixed(3)} factor=${frameFactor()} fulls=${cells.filter((c) => !c.add).map((c) => [c.full.x, c.full.y, c.full.w, c.full.h].map(Math.round).join('/')).join(';')} cells=${cells.filter((c) => !c.add).length} add=${cells.some((c) => c.add)} divider=${!!cellsEl.querySelector('#divider')} panel=${controls.view() || '-'} menu=${!ui.menu.hidden}`
      + ` rate=${st.rate} loop=${st.loop} scan=${scanner.running ? 'running' : scanner.found ? `found:${scanner.found.frame + 1}` : '-'}`);
  }
  /** What the page shows, as JSON (test hook): the bar, the open panel, the menu, the tiles' overlays. */
  function uiState() {
    const text = (e) => (e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const rect = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    const shown = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
    return {
      bar: {
        ids: [...ui.bar.querySelectorAll('button, input')].filter(shown).map((b) => b.id),
        time: text(ui.time), play: ui.play.getAttribute('aria-label'), mute: ui.mute.title, rate: ui.rate.textContent,
        cmpExpanded: ui.cmpBtn.getAttribute('aria-expanded'), cogExpanded: ui.cog.getAttribute('aria-expanded'),
      },
      panel: ui.panel.hidden ? null : {
        view: controls.view(), label: ui.panel.getAttribute('aria-label'), text: text(ui.panel),
        rows: [...ui.panel.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label') || text(b), pressed: b.getAttribute('aria-pressed'), checked: b.getAttribute('aria-checked') })),
      },
      sheet: ui.sheet.hidden ? null : text(ui.sheet),
      menu: ui.menu.hidden ? null : { tile: Number(ui.menu.dataset.tile), items: [...ui.menu.querySelectorAll('.mi')].map((b) => text(b)) },
      cells: [...cellsEl.children].map((d) => ({
        tile: d.dataset.tile === undefined ? (d.classList.contains('add') ? 'add' : '') : d.dataset.tile, rect: rect(d),
        pills: [...d.querySelectorAll('.pill')].map((p) => text(p)), nudges: [...d.querySelectorAll('.nudge')].map((n) => text(n)),
        moves: [...d.querySelectorAll('[data-act="move"]')].map((b) => ({
          label: b.getAttribute('aria-label'), disabled: b.disabled, focused: b === document.activeElement,
        })),
        pillRects: [...d.querySelectorAll('.pill')].map(rect),
        nudgeRects: [...d.querySelectorAll('.nudge')].map(rect),
        moveRects: [...d.querySelectorAll('.move button')].map(rect),
        picRect: (() => { const c = cells[[...cellsEl.children].indexOf(d)]; const o = cellsEl.getBoundingClientRect(); return c && c.pic ? [Math.round(o.left + c.pic.x), Math.round(o.top + c.pic.y), Math.round(c.pic.w), Math.round(c.pic.h)] : null; })(),
        pics: [...d.querySelectorAll('.ov')].map((o) => rect(o)), oor: !!d.querySelector('.oor:not([hidden])'),
      })),
      divider: (() => { const dv = cellsEl.querySelector('#divider'); return dv ? { rect: rect(dv), value: dv.getAttribute('aria-valuenow') } : null; })(),
      stage: rect(stage), toast: ui.toast.hidden ? '' : ui.toast.textContent, live: ui.live.textContent, hover,
      reorder: { button: text(reorderBtn), hint: reorderHint.hidden ? '' : text(reorderHint) },
      picture: {
        ...st.pic, factor: frameFactor(), pct: picState().pct, btnMode: ui.picBtn.dataset.mode, btnLabel: ui.picBtn.getAttribute('aria-label'), pannable: stage.classList.contains('pannable'),
        tiles: cells.filter((c) => !c.add).map((c) => ({ tiles: c.tiles, box: [c.x, c.y, c.w, c.h], full: [c.full.x, c.full.y, c.full.w, c.full.h], pic: [c.pic.x, c.pic.y, c.pic.w, c.pic.h] })),
      },
    };
  }
  if (cfg.debug) {
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.type !== 'debug' || m.page !== cfg.page) return;
      switch (m.action) {
        case 'mode': setMode(m.mode); break;
        case 'key': document.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, shiftKey: !!m.shift, ctrlKey: !!m.ctrl, bubbles: true })); break;
        case 'offset': setOffset(m.tile, Number(m.v), m.unit === 'f' ? 'frames' : m.unit); break;
        case 'clock': setClock(m.tile); break;
        case 'remove': removeTile(Number(m.tile)); break;
        case 'sound': setSound(m.tile); break;
        case 'step': step(m.d || 1); break;
        case 'play': play(); break;
        case 'pause': pause(); break;
        case 'seek': pause(); seekClock(Number(m.t) || 0); break;
        case 'scrub': {
          ui.seek.value = String(Math.round(Number(ui.seek.max) * m.frac));
          ui.seek.dispatchEvent(new Event('input'));
          ui.seek.dispatchEvent(new Event('change'));
          break;
        }
        case 'rate': setRate(m.rate); break;
        case 'split': setSplit(Number(m.x)); break;
        case 'panel': if (m.view) controls.show(m.view, m.view === 'main' ? ui.cog : ui.cmpBtn); else controls.closeAll(false); break;
        case 'select': st.sel = tileOr0(m.tile); break;
        case 'hover': hover = m.tile === null || m.tile === undefined ? null : tileOr0(m.tile); break;
        case 'menu': { // right-click on a cell (its centre, or a fraction x of the stage width)
          const r = stage.getBoundingClientRect();
          const x = m.x !== undefined ? r.left + m.x * r.width : r.left + r.width / 2;
          const y = m.y !== undefined ? r.top + m.y * r.height : r.top + r.height / 2;
          const target = document.elementFromPoint(x, y) || stage;
          target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
          break;
        }
        case 'menuPick': { // the menu item whose text starts with `label`
          const b = [...ui.menu.querySelectorAll('.mi')].find((x) => (x.textContent || '').trim().startsWith(m.label));
          if (b) /** @type {any} */ (b).click(); else log(`menuPick: no item ${m.label}`);
          break;
        }
        case 'click': { // a button: CSS selector, or a panel / menu button by its text
          let el = m.sel ? document.querySelector(m.sel) : null;
          const name = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
          for (const where of ['#panel', '#menu', '#cells', '#bar']) if (!el && m.text) el = [...document.querySelectorAll(`${where} button`)].find((b) => name(b).startsWith(m.text)) || null;
          if (el) /** @type {any} */ (el).click(); else log(`click: nothing for ${m.sel || m.text}`);
          break;
        }
        case 'drag': { // the split divider dragged to fraction `x` of the picture, with pointer events
          const dv = cellsEl.querySelector('#divider');
          if (!dv) { log('drag: no divider'); break; }
          const c = cells[0];
          const r = stage.getBoundingClientRect();
          const from = dv.getBoundingClientRect();
          const y = from.top + from.height / 2;
          const ev = (type, x) => dv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0, isPrimary: true }));
          ev('pointerdown', from.left + from.width / 2);
          for (let k = 1; k <= 4; k++) ev('pointermove', r.left + c.pic.x + c.pic.w * (st.split + (m.x - st.split) * k / 4));
          ev('pointerup', r.left + c.pic.x + c.pic.w * m.x);
          break;
        }
        case 'dom': { // a mouse / pointer / wheel event at client (x, y)
          const target = document.elementFromPoint(m.x, m.y);
          if (!target) { log(`dom: nothing at ${m.x},${m.y}`); break; }
          if (m.ev === 'pointerdown') log(`dom target ${target.tagName}.${target.className} #${target.id}`);
          const init = { bubbles: true, cancelable: true, clientX: m.x, clientY: m.y, button: m.button || 0, ctrlKey: !!m.ctrl, deltaY: m.deltaY || 0, pointerId: 1, isPrimary: true };
          target.dispatchEvent(new (/^wheel/.test(m.ev) ? WheelEvent : /^pointer/.test(m.ev) ? PointerEvent : MouseEvent)(m.ev, init));
          break;
        }
        case 'scan': if (m.thresh) st.thresh = Number(m.thresh); scanner.start(); break;
        case 'leave': leave(m.tile); break;
        case 'stageSize': { // CSS pixels, or device pixels with `physical`
          const dpr = m.physical ? window.devicePixelRatio || 1 : 1;
          stage.style.flex = m.w ? 'none' : '';
          stage.style.width = m.w ? `${m.w / dpr}px` : '';
          stage.style.height = m.h ? `${m.h / dpr}px` : '';
          break;
        }
        case 'report': setTimeout(report, m.delay || 400); break;
        case 'ui': setTimeout(() => log(`compare ui ${JSON.stringify({ id: m.id, ...uiState() })}`), m.delay || 50); break;
        case 'a11y': { // names and states of the bar's buttons, the live region, focus
          if (m.focus) { const f = document.querySelector(m.focus); if (f) /** @type {any} */ (f).focus(); }
          if (m.click) { const c = document.querySelector(m.click); if (c) /** @type {any} */ (c).click(); }
          const at = (el, n) => (el ? el.getAttribute(n) : null);
          const ids = ['play', 'prev', 'next', 'seek', 'mute', 'volume', 'time', 'cmpBtn', 'infoBtn', 'rate', 'cog', 'keysBtn', 'full', 'divider'];
          const a = /** @type {any} */ (document.activeElement);
          log(`compare a11y ${JSON.stringify({
            controls: Object.fromEntries(ids.map((k) => { const el = $(k); return [k, el ? { label: at(el, 'aria-label'), pressed: at(el, 'aria-pressed'), expanded: at(el, 'aria-expanded'), valuetext: at(el, 'aria-valuetext'), role: at(el, 'role') } : null]; })),
            unnamed: [...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || '').trim() && !/[A-Za-z]/.test(b.textContent || '')).map((b) => b.id || b.className),
            live: ui.live ? ui.live.textContent : null, active: a ? a.id || a.className || a.tagName : '', panel: controls.view(),
            muted: st.muted, loop: st.loop, playing: !!(clock && clock.playing),
          })}`);
          break;
        }
        default: break;
      }
    });
  }

  // Frames for native tiles come at the tile's size: tell the host how big a tile is.
  const tile = tileSize();
  lastTileSize = JSON.stringify(tile);
  vscode.postMessage({ type: 'tileOrder', order: st.order });
  vscode.postMessage({ type: 'ready', tile, origin: window.location.origin });
})();
