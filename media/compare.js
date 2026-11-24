/* global createEngine, VpeControls, VpeModes, VpeCompareCompositor */
// @ts-check
// Compare / multi-view: 2-16 videos (up to compare.maxVideos) on one
// transport, frame accurate, with the player's own bar and panels (docs/notes/compare-ui.md, the approved
// mock-up; docs/notes/multiview-engine.md for more than 4).
//
// Design:
// - One LibavPlayer engine per tile (engine.js), each with its own detached
//   canvas and message key ('A'-'P'), so the host serves each file's blocks, or runs native
//   ffmpeg for that tile with frames at the tile's size. From 5 tiles on, the engines share one
//   WebGL renderer (sharedRenderer) and split fixed memory budgets (media/compare-grid.js).
// - One tile is the clock (the first by default): its own clock (audio, or timer) drives
//   playback, frame steps move it and the seek bar counts its frames. Every other tile follows:
//   it follows the clock's time plus the offsets (per tile, in ms or in that tile's
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
    mute: $('mute'), volume: $('volume'), rate: $('rate'), cog: $('cog'), infoBtn: $('infoBtn'), picBtn: $('picBtn'), cmpBtn: $('cmpBtn'), full: $('full'),
    panel: $('panel'), sheet: $('sheet'), menu: $('menu'), toast: $('toast'), live: $('live'), abMarks: $('abMarks'),
    abA: $('abA'), abB: $('abB'), setABtn: $('setABtn'), setBBtn: $('setBBtn'), prevSize: $('prevSize'), nextSize: $('nextSize'),
    remoteLiveBtn: $('remoteLiveBtn'),
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
  const { captureLuma, computeMetrics, ssim } = VpeCompareMetrics;
  const { CompareSyncController, settled, atFirstFrame, outOfRange } = VpeCompareSync;

  const log = (/** @type {any[]} */ ...a) => vscode.postMessage({ type: 'log', msg: a.map(String).join(' ') });
  window.addEventListener('error', (e) => log('error:', e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('unhandled rejection:', e.reason && e.reason.stack || e.reason));

  const saved = vscode.getState() || {};
  const ab = VpeAbLoop.create();
  if (Number.isFinite(saved.ab?.a)) ab.set('a', saved.ab.a, 0, Number.isFinite(saved.ab.aPts) ? saved.ab.aPts : saved.ab.a, !!saved.ab.aNative);
  if (Number.isFinite(saved.ab?.b)) ab.set('b', saved.ab.b, 0, Number.isFinite(saved.ab.bPts) ? saved.ab.bPts : saved.ab.b, !!saved.ab.bNative);
  const tileOr0 = (i) => (Number.isInteger(i) && i >= 0 && i < N ? i : 0);
  const splitterEl = $('splitter'), skeletonEl = $('skeleton'), skeletonSubEl = $('skeletonSub'), skeletonLabelEl = $('skeletonLabel');
  const cmpGroupEl = $('cmpGroup'), layoutSpotlightBtn = $('layoutSpotlightBtn'), layoutGridBtn = $('layoutGridBtn'), layoutSplitBtn = $('layoutSplitBtn');
  const addPopBtn = $('addPopBtn'), addPopEl = $('addPop'), addPickBtn = $('addPickBtn'), addModePopBtn = $('addModePopBtn');
  const syncModeBtn = $('syncModeBtn');
  let syncMode = false;
  let confirmingId = -1;
  /** @type {Set<number>} tile indices with the per-tile stats HUD open */
  const statsIds = new Set();
  /** @type {any} */
  let tileDrag = null;
  /** Tiles were moved (glide or lifted) at the last placement: one more placement clears their transforms. */
  let tilesMoving = false;
  // Tiles glide into their new rects (full FLIP) on swaps, docking, and layout switches (none with reduced motion).
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const glide = Grid.createGlide(() => (reduceMotion && reduceMotion.matches ? 0 : 200));
  const prefs = {
    ...cfg.prefs,
    jump: { arrow: 5, shift: 1, ctrl: 'frame', wheel: 'frame', wheelShift: 1, ...cfg.prefs?.jump },
    stepButtons: cfg.prefs?.stepButtons || 'frame',
    // The step buttons' size picked with their badge (kept over a reload, shared by all tabs); null: the setting stepButtons.
    stepSize: VpeControls.STEP_SIZES.includes(saved.stepSize) ? saved.stepSize
      : VpeControls.STEP_SIZES.includes(cfg.prefs?.stepSize) ? cfg.prefs.stepSize : null,
  };
  const initPrefs = cfg.prefs || {};
  const rawVol = saved.volume !== undefined ? Number(saved.volume) : initPrefs.volume !== undefined ? Number(initPrefs.volume) : 1;
  const Pic = VpePicture;
  const initialMode = () => {
    if (saved.mode === 'spotlight' && N >= 2) return 'spotlight';
    if (N === 2 && (saved.mode === 'split' || saved.mode === 'wipe')) return 'split';
    return 'grid';
  };
  const st = {
    // The picture size, zoom and pan, one for every tile (media/picture.js): this tab starts as the setting and keeps its own choice.
    pic: Pic.fresh(Pic.parse(saved.pic || (cfg.prefs && cfg.prefs.pictureSize))),
    // Primary layouts: 'grid' (Equal Grid; 2 videos = 2x1 side by side) and 'spotlight' (1 Main + strip); 'split' for 2 videos only.
    mode: initialMode(),
    dock: Grid.clampDock(saved.dock),
    heroRatio: Grid.clampHeroRatio(saved.heroRatio),
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
    rate: VpeControls.clampRate(saved.rate || initPrefs.rate || 1),
    volume: Number.isFinite(rawVol) && rawVol >= 0 && rawVol <= 1 ? Math.round(rawVol * 100) / 100 : 1,
    muted: saved.muted !== undefined ? !!saved.muted : true,
    loop: saved.loop !== undefined ? saved.loop : true, thresh: saved.thresh || 40, metrics: INTERNAL,
    timeMode: [0, 1, 2].includes(Number(saved.timeMode)) ? Number(saved.timeMode)
      : [0, 1, 2].includes(Number(initPrefs.timeMode)) ? Number(initPrefs.timeMode) : 0,
  };

  // Decoder keys and per-video state use the host's indices. Only the display slots move.
  const displayOrder = () => tileDrag?.previewOrder || st.order;
  const displayDock = () => tileDrag?.previewDock || st.dock;
  const tileLabel = (i) => KEYS[st.order.indexOf(i)];

  // Screen readers: toasts and messages go to one polite live region (#live).
  let liveTimer = 0;
  function announce(text) {
    if (!ui.live || !text) return;
    ui.live.textContent = ''; // cleared first, so the same text twice is read twice
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { ui.live.textContent = text; }, 50);
  }
  const toast = VpeControls.createToast(ui.toast, announce);
  const flashPlay = VpeControls.createPlayFlash($('playFlash'), stage);
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

  // Labels: media/timefmt.js. Compare's m:ss.mmm cuts the milliseconds (fmtClock), as the player's clock does.
  const { fmtClock: fmtTime, fmtTimecode } = /** @type {any} */ (self).VpeTime;

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
      setMuteUi: (m) => {
        if (key === KEYS[st.sound] && m !== st.muted) setMute(m, false);
      },
      onReady: () => onEngineReady(key),
      onMeta: () => onEngineMeta(key),
      wake: () => wakeLoop(),
      createRenderer: largeGrid && !quiet ? (Renderer) => comp.sharedRenderer(Renderer, cv, file) : undefined,
    };
    const eng = createEngine(env);
    const p = new eng.LibavPlayer({ size: sizes[file], duration: 0, label: '', native: !quiet && !!nativeTiles[file] },
      { ...cfg.engine, mem: memory.engine, rotation: (cfg.rotation || [])[file] || 0,
        noStepBack: true, videoOnly: quiet, ...(largeGrid ? { largeGrid: true } : {}) });
    p.cv = cv;
    p.key = key;
    p.setBudget(budget);
    p.setLoop(false);
    // Metrics are for two videos. Cloning every frame in a large grid is expensive.
    if (!largeGrid) captureLuma(p, typeof VpeGlRenderer !== 'undefined' ? VpeGlRenderer : undefined);
    engines[key] = p;
    return p;
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
  const frameOf = (p) => (p.shownT === null ? 0 : p.currentFrame());
  /** Seconds a frame may be shown early in engine.tick(): a quarter frame. */
  const earlyOf = (p) => 0.25 / fpsOf(p);
  /** Tile i's offset in seconds: ms, or frames of that tile at its own frame rate. */
  const offSec = (i) => VpeCompareRange.offsetSeconds(st.offsets[i], fpsOf(tiles[i]));
  const sync = new CompareSyncController({ tiles: () => tiles, offset: offSec, sound: () => st.sound });
  /** The clock's position at which tile i is at rel, without the early-frame nudge. */
  const clockRelFor = (i, rel) => rel - offSec(i) + offSec(st.clock);

  // Store the markers on the shared timeline so changing the clock or reordering leaves them in place.
  function fmtAB(t) {
    const rel = t + offSec(st.clock);
    return rel < 0 ? `−${fmtTime(-rel)}` : fmtTime(rel);
  }
  /** Per mark (keyed by its time on the clock): what every tile showed then. Not kept across a reload. */
  const marks = new Map();
  function markAB(end) {
    const mark = VpeCompareRange.captureMark(presentedMarks, st.clock, tiles.map((_, i) => offSec(i)));
    if (!mark) return;
    const { t, pts, native } = mark;
    marks.set(pts, mark.tiles);
    if (end) ab.set(end, t, 0, pts, native);
    else ab.cycle(t, 0, pts, native);
    for (const key of [...marks.keys()]) if (key !== ab.aPts && key !== ab.bPts) marks.delete(key);
    toast(ab.toast(fmtAB));
    controls.refresh();
    updateUi();
    save();
  }
  ui.setABtn.onclick = () => markAB('a');
  ui.setBBtn.onclick = () => markAB('b');
  // Dragging a pin moves that end to the nearest frame of the clock video. Its time is that frame's time on the clock
  // (minus the clock's offset, as marks are stored); no per-tile capture exists for it, so the clip export maps
  // the time to every tile through the offsets (the nominal mapping), the same fallback as a mark set while seeking.
  for (const [which, pin] of [['a', ui.abA], ['b', ui.abB]]) {
    self.VpeAbLoop.bindPin(pin, which, {
      rect: () => ui.seek.getBoundingClientRect(),
      n: () => clock ? clock.n || 0 : 0,
      fps: () => clock ? fpsOf(clock) : 0,
      dur: () => clock ? clock.meta.duration || 0 : 0,
      move(w, snap, clientX) {
        if (!clock) return;
        const r = ui.seek.getBoundingClientRect();
        const dur = clock.meta.duration || 0;
        const pct = clock.n > 1 ? snap.f / (clock.n - 1) * 100 : dur ? snap.t / dur * 100 : 0;
        pin.style.left = `${pct}%`;
        ui.tip.textContent = `${w.toUpperCase()} ${tileLabel(st.clock)} ${fmtTime(snap.t)}${clock.n ? ` · #${snap.f + 1}` : ''}`;
        ui.tip.style.left = `${Math.max(30, Math.min(r.width - 30, clientX - r.left))}px`;
        ui.tip.hidden = false;
      },
      commit(w, snap) {
        if (!clock) return;
        const t = snap.t - offSec(st.clock);
        const native = !!(clock.shownFrame?.nativeTimestamp || clock.remoteStream);
        ab.reset(w, t, snap.f, t, native);
        for (const key of [...marks.keys()]) if (key !== ab.aPts && key !== ab.bPts) marks.delete(key);
        toast(ab.toast(fmtAB));
        controls.refresh();
        updateUi();
        save();
      },
      end() { ui.tip.hidden = true; lastUi = ''; updateUi(); },
    });
  }
  function exportAB() {
    const span = ab.presentationRange();
    const ranges = ab.isRange() && span && clock?.shownT != null
      ? tiles.map((p, i) => VpeCompareRange.tileRange(marks.get(span.a)?.[i], marks.get(span.b)?.[i], {
        ...VpeCompareRange.mapRange(span.a, span.b, offSec(i), fpsOf(p), i === st.clock),
        // A native tile is exact once its pictures carry their own timestamps; before one shows, it is not known.
        native: ab.aNative || ab.bNative || !!p.remoteStream || !!(p.cfg.native && (!p.shownFrame || p.shownFrame.nativeTimestamp)),
      }))
      : null;
    vscode.postMessage({ type: 'clipRange', ranges, clock: st.clock, order: st.order });
  }
  /** The bar's remote Live transcode chip (remote windows only, while a tile plays through it; media/controls.js). */
  function updateRemoteChip() {
    const b = ui.remoteLiveBtn;
    if (!b) return;
    const live = tiles.filter((p) => p && p.remoteStream);
    const primary = live.find((p) => p.info && p.info.transcode && p.info.transcode.adaptingDir)
      || (clock && clock.remoteStream ? clock : live[0]);
    const st = VpeControls.remoteChipState({
      remote: !!(cfg.engine && cfg.engine.remote),
      active: live.length > 0,
      transcode: primary && primary.info && primary.info.transcode,
      height: primary && primary.info && primary.info.video && primary.info.video.height,
    });
    b.hidden = !st.visible;
    if (!st.visible) return;
    b.textContent = st.text;
    b.title = st.title;
    b.setAttribute('aria-label', st.ariaLabel);
    b.classList.toggle('adapting', st.adapting);
  }
  function onEngineReady(key) {
    if (key.length > 1) { scanner.onReady(key); return; }
    const p = engines[key];
    if (p?.remoteStream) {
      if (visible && !p.hidden) p.worker.postMessage({ type: 'hidden', on: false });
      else p.setHidden(!visible);
    }
    updateMuteUi();
    updateRemoteChip();
    if (tiles.length === N && tiles.every((p) => p.vmode !== undefined) && !begun) begin();
  }
  function onEngineMeta(key) {
    if (clock && key === clock.key) ui.seek.max = String(Math.max(0, (clock.n || 1) - 1));
    infoDirty = true;
    updateRemoteChip();
    if (controls.view() === 'info' && KEYS[st.infoSel] === key) controls.refresh();
    if (largeGrid && key === KEYS[0]) requestTileSize(); // the first tile's shape sizes the native tiles
    if (sync.updateFps(key, begun, st.offsets.some((o) => o.unit === 'frames' && o.v))) refreshPanel();
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

  function setClock(i, quiet) {
    clearStep();
    const was = isPlaying();
    // Followers record their paused positions with the old clock's offset, so pause before it changes.
    pause();
    st.clock = tileOr0(i);
    clock = sync.setClock(st.clock, st.loop);
    if (clock) {
      ui.seek.max = String(Math.max(0, (clock.n || 1) - 1));
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

  let scrubbing = false;
  let seekDragger;
  const stepGoal = VpeStepGoal.create({
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (timer) => clearTimeout(timer),
    dispatch({ frame, time, exact }) {
      sync.clearStep();
      if (exact) clock.commitScrubFrame(frame);
      else clock.seekFrame(frame);
      if (clock.playing) sync.syncPlaying(true);
      else sync.seekFollowers(time);
      wakeLoop();
    },
  });

  function clearStep() {
    seekDragger?.stop();
    stepGoal.clear();
    sync.clearStep();
  }

  const isPlaying = () => !!clock && clock.playing;
  function play() {
    if (!clock) return;
    clearStep();
    // Followers move while playing: the next pause sends each of them again, even to the same position.
    sync.resetRequests();
    const { eof, nextQueuedT } = clock.syncState();
    if (eof && nextQueuedT === null && clock.currentFrame() >= clock.n - 1) seekClock(0);
    clock.play();
    sync.syncPlaying();
  }
  function pause() { for (const p of tiles) p.pause(); }
  const togglePlay = () => {
    if (!clock) return;
    if (isPlaying()) pause();
    else play();
    flashPlay(isPlaying());
  };

  /** Seek the clock (relative seconds); the others follow at once when playing, after it settles when paused. */
  function seekClock(rel) {
    if (!clock) return;
    clearStep();
    clock.seekTime(rel);
    if (clock.playing) sync.syncPlaying(true);
  }
  /** Shows frame `frame` of tile i (through the clock). */
  function seekTile(i, frame) {
    if (!clock) return;
    if (i === st.clock) {
      clearStep();
      clock.seekFrame(frame);
      if (clock.playing) sync.syncPlaying(true);
    } else seekClock(Math.max(0, clockRelFor(i, tiles[i].frameSeekTime(frame))));
  }
  const goalBounds = () => ({ totalFrames: clock.n, rate: clock.frameNumberRate(), duration: clock.meta.duration });
  /** The bar shows the requested frame while the tiles decode the matching pictures. */
  function step(d) {
    if (!clock || clock.vmode === undefined || clock.meta.live) return;
    pause();
    stepGoal.step(d, { ...goalBounds(), frame: clock.currentFrame() });
    updateUi();
    wakeLoop();
  }
  const skip = (s) => { if (clock) { seekClock(clock.currentTime() + s); toast(`${s > 0 ? '+' : ''}${s} s`); } };

  const { Compositor, glProgram, glTexture } = VpeCompareCompositor;
  /** @type {InstanceType<typeof Compositor>|null} */ let comp = null;
  const { pairMetrics, hasReadback, resetReadback } = VpeCompareMetrics.install({ glProgram, glTexture, log });

  // ---- layout: cells and the pictures in them ---------------------------------------------
  const { esc } = Grid;
  const aspectOf = (i) => Grid.aspectOf(tiles[i]);
  const tileNat = (i) => Grid.tileNat(tiles[i]);
  const tileSrc = (i) => Grid.tileSrc(tiles[i], Pic);
  const picOpts = () => ({ dpr: window.devicePixelRatio || 1 });
  const pictureRect = (view, i, w, h) => Pic.rectOf(view, tileNat(i), tileSrc(i), { w, h }, picOpts());
  const computeCells = (order = displayOrder(), dock = displayDock(), mode = st.mode) => Grid.computeCells({
    order, mode, dock, heroRatio: st.heroRatio, width: stage.clientWidth, height: stage.clientHeight, maxTiles: MAX_TILES,
    pictureRect: (i, w, h) => pictureRect(st.pic, i, w, h),
  });
  /** @type {any[]} */
  let cells = [];

  // ---- the hover layer: minimal monochrome bottom-left pill, top-right controls, stats HUD, sync pill ----

  const SVG = (body, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    clock: (s) => SVG('<circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2.5 2M10 2.5h4"></path>', s),
    sound: (s) => SVG('<path d="M3.5 9.5H7l5-4v13l-5-4H3.5ZM15.5 9a4.2 4.2 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"></path>', s),
    muted: SVG('<path d="M3.5 9.5H7l5-4v13l-5-4H3.5ZM15.5 9.5l5 5m0-5-5 5"></path>', 13),
    info: SVG('<circle cx="12" cy="12" r="9"></circle><path d="M12 11v6m0-9.5v.01"></path>', 13),
    // Promote to Spotlight (child tile corner, 14x14px on 24x24 grid, 68% hairline brightening to 100% on hover).
    spot: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4.5" width="16" height="9.5" rx="1.6" opacity="0.68"/><rect x="4" y="16.5" width="6.8" height="3.2" rx="0.9" opacity="0.25"/><rect x="13.2" y="16.5" width="6.8" height="3.2" rx="0.9" opacity="0.25"/></svg>',
    plus: SVG('<path d="M12 5v14M5 12h14"></path>', 18),
    swap: SVG('<path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4"></path>', 18),
    view: SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M12 5v14"></path>', 18),
    leave: SVG('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M9 12h8M13 8l4 4-4 4"></path>', 18),
    replace: SVG('<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4v3h3M4 13a8 8 0 0 0 14.5 4.5M20 20v-3h-3"></path>', 18),
    remove: SVG('<path d="M6 6l12 12M18 6L6 18"></path>', 18),
    close: '×',
    split: SVG('<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"></path>', 14),
  };
  const offText = (i, long = false) => Grid.offText(st.offsets[i], long);

  function tileStats(i) {
    const p = tiles[i];
    if (!p) return null;
    const v = p.info && p.info.video ? p.info.video : {};
    const w = v.sourceWidth || p.meta?.width || p.cv?.width || 0;
    const h = v.sourceHeight || p.meta?.height || p.cv?.height || 0;
    const fps = p.fps || p.meta?.fps || 0;
    const frames = p.n || (fps && p.meta?.duration ? Math.round(p.meta.duration * fps) : 0);
    const rawCodec = String(v.codec || '').toUpperCase();
    const depth = v.depth || (/10/.test(String(v.pixFmt || '')) ? 10 : /12/.test(String(v.pixFmt || '')) ? 12 : rawCodec ? 8 : 0);
    const codec = rawCodec ? `${rawCodec}${depth ? ` ${depth}b` : ''}` : '';
    return { w, h, fps, frames, codec };
  }

  function syncCapsuleButtons() {
    if (layoutSplitBtn) layoutSplitBtn.hidden = N !== 2;
    if (layoutSpotlightBtn) {
      layoutSpotlightBtn.disabled = N < 2;
      layoutSpotlightBtn.classList.toggle('active', st.mode === 'spotlight');
      layoutSpotlightBtn.setAttribute('aria-pressed', String(st.mode === 'spotlight'));
    }
    if (layoutGridBtn) {
      layoutGridBtn.classList.toggle('active', st.mode === 'grid' || st.mode === 'side');
      layoutGridBtn.setAttribute('aria-pressed', String(st.mode === 'grid' || st.mode === 'side'));
    }
    if (layoutSplitBtn) {
      layoutSplitBtn.classList.toggle('active', st.mode === 'split');
      layoutSplitBtn.setAttribute('aria-pressed', String(st.mode === 'split'));
    }
    if (addPopBtn) {
      addPopBtn.disabled = N >= MAX_TILES;
      addPopBtn.title = N >= MAX_TILES ? `Maximum videos reached (${MAX_TILES})` : 'Add video to Compare';
    }
    if (syncModeBtn) {
      syncModeBtn.classList.toggle('active', syncMode);
      syncModeBtn.setAttribute('aria-pressed', String(syncMode));
    }
  }

  function placeSplitter() {
    if (!splitterEl) return;
    const show = st.mode === 'spotlight' && N >= 2 && !(tileDrag && tileDrag.lifted);
    splitterEl.hidden = !show;
    if (!show) return;
    const { splitter } = Grid.spotlightLayout({
      order: displayOrder(), dock: displayDock(), heroRatio: st.heroRatio,
      width: stage.clientWidth, height: stage.clientHeight, gap: Grid.GAP, pad: 0,
    });
    if (!splitter) { splitterEl.hidden = true; return; }
    splitterEl.className = `splitter ${splitter.dir}${splitterEl.classList.contains('dragging') ? ' dragging' : ''}`;
    Object.assign(splitterEl.style, {
      left: `${splitter.x}px`, top: `${splitter.y}px`, width: `${splitter.w}px`, height: `${splitter.h}px`,
    });
    const pct = Math.round(st.heroRatio * 100);
    splitterEl.setAttribute('aria-orientation', splitter.dir === 'h' ? 'horizontal' : 'vertical');
    splitterEl.setAttribute('aria-valuenow', String(pct));
    splitterEl.setAttribute('aria-valuetext', `Spotlight ${pct}%`);
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
        const d = document.createElement('div');
        d.className = `cell${c.add ? ' add' : ''}${c.split ? ' split' : ''}`;
        if (c.add) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'addcell';
          btn.dataset.act = 'add';
          btn.setAttribute('aria-label', 'Add video');
          btn.innerHTML = `${ICONS.plus}<span>Add video</span>`;
          d.appendChild(btn);
        } else if (c.split) {
          d.dataset.tile = 'split';
          d.innerHTML = `<div class="ov L" data-side="L"></div><div class="ov R" data-side="R"></div><div class="move L"></div><div class="move R"></div><div class="oor" hidden>One side has no picture at this moment</div>`
            + `<div id="divider" role="slider" tabindex="0" aria-label="Split position" aria-valuemin="0" aria-valuemax="100" title="Drag, or ← → (Shift: 10 %), Home / End"><span class="h">${ICONS.split}</span></div>`;
        } else {
          d.innerHTML = `<div class="ended-ov"><span class="ended-badge">No frame (clip ended)</span></div><div class="tile-stats"></div><div class="ov"></div><div class="move"></div>`;
        }
        cellsEl.appendChild(d);
      }
      bindDivider();
      overlaysKey = '';
    }
    [...cellsEl.children].forEach((d, k) => {
      const c = cells[k];
      if (!c) return;
      if (!c.add && !c.split) d.dataset.tile = String(c.tiles[0]);
      Object.assign(d.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
      for (const ov of d.querySelectorAll('.ov')) {
        // Cover the cell so bottom-left pill, top-right controls and bottom-right sync pill stay cleanly anchored.
        const box = c.split ? c.pic : c;
        Object.assign(ov.style, {
          left: `${box.x - c.x}px`, top: `${box.y - c.y}px`, width: `${box.w}px`, height: `${box.h}px`,
        });
      }
      if (!c.add) {
        const pic = c.pic || c;
        const inset = (v) => `${Math.max(0, Math.round(v * 10) / 10)}px`;
        d.style.setProperty('--pic-l', inset(pic.x - c.x));
        d.style.setProperty('--pic-r', inset(c.x + c.w - (pic.x + pic.w)));
        d.style.setProperty('--pic-t', inset(pic.y - c.y));
        d.style.setProperty('--pic-b', inset(c.y + c.h - (pic.y + pic.h)));
      }
      if (c.split) placeDivider(d, c);
    });
    const isPannable = cells.some(overflows);
    stage.classList.toggle('pannable', isPannable);
    stage.classList.toggle('zoomed', isPannable || Pic.isZoomed(st.pic));
    placeSplitter();
    syncCapsuleButtons();
    updateOverlays();
    placeTileMotion(performance.now());
  }

  /** True when the picture is larger than its cell on some side (it can be dragged). */
  const overflows = Pic.overflows;
  let overlaysKey = '';
  /** Pill, top-right controls, stats HUD and sync stepper of every tile. */
  function updateOverlays() {
    const order = displayOrder();
    const statsKey = [...statsIds].sort((a, b) => a - b).join(',');
    const key = `${cellsKey}|${st.mode}|${order}|${st.clock}|${st.sound}|${st.muted}|${confirmingId}|${statsKey}|${st.offsets.map((o) => `${o.v}${o.unit}`).join(',')}`;
    if (key === overlaysKey) return;
    overlaysKey = key;
    infoDirty = true;  // the new pills start empty: refill the frame numbers on the next tick even when paused
    const refStats = tileStats(order[0]);
    const html = (i, side) => {
      const k = KEYS[order.indexOf(i)];
      const tileMuted = st.muted || i !== st.sound;
      const showStats = statsIds.has(i);
      const isMain = st.mode === 'spotlight' && order[0] === i;
      const showSpot = !side && st.mode === 'spotlight' && !isMain;
      const rmHtml = side ? '' : Grid.removeButtonHtml(N, i, esc(names[i]), ICONS.close, confirmingId === i);
      const topActs = (showSpot || rmHtml)
        ? `<div class="tile-top-acts">${showSpot ? `<button class="tbtn spot" type="button" data-act="spot" data-i="${i}" aria-label="Make ${esc(names[i])} Spotlight" title="Make Spotlight">${ICONS.spot}</button>` : ''}${rmHtml}</div>`
        : '';
      const pillCls = `tile-bottom-pill pill${side === 'R' ? ' right' : ' left'}`;
      const pill = `<div class="${pillCls}" data-zoom-drag="1">`
        + `<span class="zoom-grip" title="Drag here to reposition while zoomed" aria-hidden="true">⋮⋮</span>`
        + `<button class="pill-open" type="button" data-act="openVid" data-i="${i}" title="${esc(names[i])}: offset, clock, sound, replace, remove"><span class="ltr">${k}</span><span class="nm">${esc(names[i])}</span><span class="fr mono" data-fr="${i}"></span></button>`
        + (side ? '' : `<button class="mute-mini${showStats ? ' info-on' : ''}" type="button" data-act="info" data-i="${i}" aria-label="Toggle details for ${k}" aria-pressed="${showStats}" title="Toggle clip details (mismatch highlighted)">${ICONS.info}</button>`)
        + `<button class="mute-mini${!tileMuted ? ' on' : ''}" type="button" data-act="mute" data-i="${i}" aria-label="${tileMuted ? `Unmute ${k}` : `Mute ${k}`}" aria-pressed="${!tileMuted}" title="${tileMuted ? `Sound from ${k}` : 'Mute'}">${tileMuted ? ICONS.muted : ICONS.sound(13)}</button>`
        + `</div>`;
      const nudgeCls = `sync-pill nudge${side === 'R' ? ' right below' : side === 'L' ? ' left below' : ''}`;
      const nudge = `<div class="${nudgeCls}" role="group" aria-label="Offset of ${k}">`
        + `<button type="button" data-act="nudge" data-i="${i}" data-d="-1" aria-label="${k} earlier" title="Earlier (−)">−</button>`
        + `<button class="offv mono" type="button" data-act="openVid" data-i="${i}" title="Offset of ${k}" aria-label="Offset of ${k}: ${offText(i, true)}">${offText(i)}</button>`
        + `<button type="button" data-act="nudge" data-i="${i}" data-d="1" aria-label="${k} later" title="Later (+)">+</button>`
        + `</div>`;
      return topActs + pill + nudge;
    };
    const arrows = (i) => [-1, 1].map((d) => {
      const pos = order.indexOf(i) + d;
      const label = `Move ${esc(names[i])} ${d < 0 ? 'earlier' : 'later'}`;
      const icon = d < 0 ? 'M6 14l6-6 6 6' : 'M6 10l6 6 6-6';
      const disabled = pos < 0 || pos >= N ? ' disabled' : '';
      return `<button type="button" data-act="move" data-i="${i}" data-d="${d}" aria-label="${label}" title="${label}"${disabled}>${SVG(`<path d="${icon}"></path>`)}</button>`;
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
        const i = c.tiles[0];
        d.querySelector('.ov').innerHTML = html(i);
        d.querySelector('.move').innerHTML = arrows(i);
        d.classList.toggle('confirming', confirmingId === i);
        const showStats = statsIds.has(i);
        d.classList.toggle('show-stats', showStats);
        const statsEl = d.querySelector('.tile-stats');
        if (statsEl && showStats) {
          const f = factsOf(i);
          const refFacts = i === order[0] ? null : factsOf(order[0]);
          const refMap = refFacts ? new Map(refFacts.rows) : null;
          const stRows = Grid.tileStatsRows(tileStats(i), i === order[0] ? null : refStats);
          const framesRow = stRows.find((r) => r.key === 'Frames');
          const rows = [...f.rows];
          if (framesRow && framesRow.value !== '—') rows.splice(1, 0, ['Frames', framesRow.value]);
          const diffOf = (label, value) => {
            if (i === order[0]) return false;
            if (label === 'Frames') return !!framesRow?.diff;
            if (label === 'Picture') return stRows.some((r) => (r.key === 'Size' || r.key === 'FPS') && r.diff);
            if (label === 'Video') return !!stRows.find((r) => r.key === 'Codec')?.diff;
            return !!(refMap && refMap.has(label) && refMap.get(label) !== value && (label === 'Quality'));
          };
          statsEl.innerHTML = `<div class="itop"><div class="iname">${esc(f.title)}</div>${f.sub ? `<div class="isub">${esc(f.sub)}</div>` : ''}</div>`
            + `<dl class="igrid">${rows.map(([rk, rv]) => `<dt>${esc(rk)}</dt><dd${diffOf(rk, rv) ? ' class="diff"' : ''}>${esc(rv)}</dd>`).join('')}</dl>`;
        }
      }
    });
    lastFr = '';
  }
  let lastFr = '';
  /** Each tile's frame number in its pill; the out-of-range / ended overlays. */
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
      if (!c || c.add) return;
      if (c.split) {
        const o = d.querySelector('.oor');
        if (o) o.hidden = !c.tiles.some((i) => outs[i]);
      } else {
        d.classList.toggle('ended', !!outs[c.tiles[0]]);
      }
    });
  }

  // ---- the split divider ----------------------------------------------------------------------

  function placeDivider(d, c) {
    const dv = d.querySelector('#divider');
    if (!dv) return;
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
  let uploadedMarks = [];
  let presentedMarks = [];
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
    if (!comp) comp = new Compositor(canvas, N, Grid);
    if (canvas.hidden) canvas.hidden = false;
    const paused = !clock.playing;
    const cRel = clock.rel(clock.shownT);
    outs = tiles.map((p, i) => p !== clock && outOfRange(p, sync.relFor(i, cRel)));
    let ready = true;
    if (paused) {
      // Nothing was drawn yet: the first picture needs each tile's first frame only.
      ready = !stepGoal.goal && tiles.every((p, i) => outs[i] || settled(p) || (!drawn && atFirstFrame(p)));
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
        if (p.shownT === null || n === upCount[i]) return;
        if (!largeGrid) {
          comp.upload(i, p.cv);
          uploadedMarks[i] = VpeCompareRange.snapshotTile(p, fpsOf(p));
        }
        upCount[i] = n;
        viewDirty = true;
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
    const now = performance.now();
    const px = (c, slot) => {
      const src = tileSrc(slot);
      let p = c.pic, f = c.full, s = 1;
      if (!c.split) {
        // Full rect FLIP: while gliding between Spotlight/Grid or across swaps, refit the picture inside the interpolated rect.
        const r = shownRect(slot, c, now);
        s = r.s;
        if (Math.abs(r.x - c.x) > 0.25 || Math.abs(r.y - c.y) > 0.25 || Math.abs(r.w - c.w) > 0.25 || Math.abs(r.h - c.h) > 0.25) {
          const box = Grid.placed(pictureRect(st.pic, slot, r.w, r.h), r.x, r.y, r.w, r.h);
          p = box.pic;
          f = box.full;
        }
      }
      const w = p.w * s, h = p.h * s;
      return {
        x: (p.x - (w - p.w) / 2) * dpr, y: (p.y - (h - p.h) / 2) * dpr, w: w * dpr, h: h * dpr,
        win: f.w > 0 && f.h > 0 ? [(p.x - f.x) / f.w, (p.y - f.y) / f.h, p.w / f.w, p.h / f.h] : [0, 0, 1, 1],
        nearest: src.w > 0 && (f.w * dpr) / src.w >= 2,
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
    // The lifted tile is drawn last, over the tiles it passes.
    const lifted = liftedTile();
    if (lifted >= 0) rects.sort((a, b) => Number(a.slot === lifted) - Number(b.slot === lifted));
    comp.draw(W, H, rects);
    // Small grids may still be displaying older uploads while the engines decode the next set.
    // Large-grid textures are filled directly by the shared renderer.
    presentedMarks = [];
    for (const { slot, w, h } of rects) {
      if (w < 1 || h < 1 || !comp.hasPicture(slot)) continue;
      presentedMarks[slot] = largeGrid ? VpeCompareRange.snapshotTile(tiles[slot], fpsOf(tiles[slot])) : uploadedMarks[slot];
    }
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
      zoom: Math.round(Math.max(0.1, Math.min(64, st.pic.zoom || 1)) * 100) / 100,
    };
  }
  /**
   * How much larger than the plain Fit a tile's picture is now (Fill, Stretch, 100 %, zoom): native frames are sized
   * by it, so a zoomed or cropped picture still gets enough pixels (the host's tileHeights multiplies the view by it).
   */
  function frameFactor() {
    if (st.pic.mode === 'fit' && Pic.plain(st.pic)) return 1;
    return Grid.frameFactor(computeCells(st.order), (i, w, h) => pictureRect(Pic.fresh('fit'), i, w, h));
  }
  let lastTileSize, sizeTimer;
  function requestTileSize() {
    if (!begun || !nativeTiles.some(Boolean)) return;
    clearTimeout(sizeTimer);
    // A transcoded tile restarts ffmpeg when it resizes: wait longer than for raw frames (smooth Ctrl+wheel zoom).
    const delay = nativeTiles.includes('transcode') ? 300 : 150;
    sizeTimer = setTimeout(() => {
      const tile = tileSize();
      const key = JSON.stringify(tile);
      if (!tile.w || !tile.h || key === lastTileSize) return;
      lastTileSize = key;
      vscode.postMessage({ type: 'tileSize', tile });
    }, delay);
  }
  new ResizeObserver(() => { layoutDirty = true; requestTileSize(); if (!clock) layoutCells(); }).observe(stage);
  window.addEventListener('resize', requestTileSize);

  // ---- state changes -------------------------------------------------------------------------

  function setMode(m) {
    if (m === 'wipe') m = 'split';
    if (m === 'side') m = 'grid';
    if (m === 'split' && N !== 2) m = 'grid';
    if (m === 'spotlight' && N < 2) m = 'grid';
    if (m !== 'grid' && m !== 'spotlight' && m !== 'split') return;
    finishTileDrag(false);
    closeAddPop();
    const animate = st.mode !== 'split' && m !== 'split' && st.mode !== m;
    const apply = () => {
      st.mode = m;
      layoutDirty = false;
      layoutCells();
      viewDirty = true;
    };
    if (animate) relayout(apply);
    else { apply(); wakeLoop(); }
    requestTileSize();
    refreshPanel();
    save();
  }
  function setDock(d) {
    const next = Grid.clampDock(d);
    if (next === st.dock) return;
    relayout(() => {
      st.dock = next;
      layoutDirty = false;
      layoutCells();
      viewDirty = true;
    });
    requestTileSize();
    save();
  }
  function setHeroRatio(r) {
    const next = Grid.clampHeroRatio(r);
    if (Math.abs(next - st.heroRatio) < 1e-4) return;
    st.heroRatio = next;
    layoutDirty = false;
    layoutCells();
    viewDirty = true;
    wakeLoop();
    save();
  }
  function promoteToSpotlight(i) {
    const idx = st.order.indexOf(i);
    if (idx < 0) return;
    finishTileDrag(false);
    closeAddPop();
    relayout(() => {
      st.mode = 'spotlight';
      if (idx > 0) {
        const next = st.order.slice();
        [next[0], next[idx]] = [next[idx], next[0]];
        st.order = next;
        vscode.postMessage({ type: 'tileOrder', order: next });
      }
      layoutDirty = false;
      layoutCells();
      viewDirty = true;
    });
    updateMuteUi();
    requestTileSize();
    refreshPanel();
    saveNow();
    announce(`${names[i]} in Spotlight`);
  }
  function setSyncMode(on) {
    const next = !!on;
    if (next === syncMode) return;
    syncMode = next;
    stage.classList.toggle('sync-mode', syncMode);
    syncCapsuleButtons();
    if (syncMode) closeAddPop();
    announce(syncMode ? 'Sync mode on: adjust per-clip frame offsets' : 'Sync mode off');
  }
  function closeAddPop() {
    if (!addPopEl || addPopEl.hidden) return;
    addPopEl.hidden = true;
    if (addPopBtn) addPopBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleAddPop(force) {
    if (!addPopEl || !addPopBtn || addPopBtn.disabled) return;
    const open = force !== undefined ? !!force : addPopEl.hidden;
    if (!open) { closeAddPop(); return; }
    closeMenu();
    controls.closeAll(false);
    addPopEl.hidden = false;
    addPopBtn.setAttribute('aria-expanded', 'true');
    const br = addPopBtn.getBoundingClientRect();
    const pr = addPopEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, br.right - pr.width));
    const bottom = Math.max(8, window.innerHeight - br.top + 8);
    addPopEl.style.left = `${left}px`;
    addPopEl.style.right = 'auto';
    addPopEl.style.bottom = `${bottom}px`;
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
    toastPicture();
  }
  /** The toast for the current size: the mode with its percent, or "Zoom N%" once zoomed (percent of the clock's cell). */
  function toastPicture(cell) {
    const c = cell || clockCell();
    toast(Pic.pictureToast(st.pic.mode, c ? cellPercent(c) : null, Pic.isZoomed(st.pic)));
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
    sync.invalidate();
    if (isPlaying()) sync.syncPlaying(true);
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
    finishTileDrag(false);
    if (N === 2) relayout(() => commitOrder(Grid.moveTile(st.order, 0, 1), st.order[1]));
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
  function hasAudio() {
    if (tiles.some((p) => p && !!(p.audio || (p.info && p.info.audio)))) return true;
    return !tiles.length || !tiles.every((p) => p && (p.info || p.vmode !== undefined));
  }
  function applyVolume() { tiles.forEach((p, j) => p.setVolume(st.volume, st.muted || j !== st.sound)); }
  function updateMuteUi() {
    const noAudio = !hasAudio();
    ui.mute.disabled = noAudio;
    ui.volume.disabled = noAudio;
    if (ui.mute.parentElement) ui.mute.parentElement.classList.toggle('no-audio', noAudio);
    if (noAudio) {
      ui.mute.classList.toggle('muted', true);
      ui.mute.classList.toggle('on', true);
      if (ui.mute.removeAttribute) ui.mute.removeAttribute('aria-pressed');
      ui.mute.setAttribute('aria-label', 'No audio track');
      ui.mute.title = 'No audio track';
      return;
    }
    const m = st.muted;
    ui.mute.classList.toggle('muted', m || st.volume === 0);
    ui.mute.classList.toggle('on', m);
    ui.mute.setAttribute('aria-pressed', String(m));
    ui.mute.setAttribute('aria-label', `${m ? 'Unmute' : 'Mute'} (sound from ${tileLabel(st.sound)})`);
    ui.mute.title = `${m ? 'Unmute' : 'Mute'} (sound from ${tileLabel(st.sound)})  M`;
  }
  function postPlaybackPrefs() {
    vscode.postMessage({ type: 'playbackPrefs', volume: st.volume, rate: st.rate, timeMode: st.timeMode,
      stepSize: prefs.stepSize });
  }
  /** Another tab changed a shared playback preference (src/extension.js rememberPlaybackPrefs): follow it quietly. */
  function applyPlaybackPrefs(p) {
    if (!p) return;
    if (Number.isFinite(p.volume) && p.volume !== st.volume) {
      st.volume = p.volume;
      ui.volume.value = String(st.volume);
      updateMuteUi();
      applyVolume();
    }
    if (Number.isFinite(p.rate) && p.rate !== st.rate) setRate(p.rate, false);
    if ([0, 1, 2].includes(p.timeMode) && p.timeMode !== st.timeMode) { st.timeMode = p.timeMode; lastUi = ''; updateUi(); }
    if (p.stepSize !== undefined && p.stepSize !== prefs.stepSize) { prefs.stepSize = p.stepSize; updateStepTips(); }
    save();
    if (controls) controls.refresh();
  }
  function setMute(m, byUser = true) {
    if (byUser && !hasAudio()) { toast('No audio track'); return; }
    st.muted = m;
    updateMuteUi();
    applyVolume();
    updateOverlays();
    save();
  }
  function setVolume(v) {
    st.volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    ui.volume.value = String(st.volume);
    if (st.volume > 0 && st.muted && hasAudio()) setMute(false);
    else {
      updateMuteUi();
      applyVolume();
      updateOverlays();
      save();
    }
    postPlaybackPrefs();
  }
  function setRate(r, persist = true) {
    st.rate = VpeControls.clampRate(r);
    ui.rate.textContent = VpeControls.speedText(st.rate);
    ui.rate.setAttribute('aria-label', `Speed ${VpeControls.speedText(st.rate)}`);
    for (const p of tiles) p.setRate(st.rate);
    requestTileSize();
    save();
    if (persist) postPlaybackPrefs();
  }
  /** Speed change with the player's toast ("4× (fastest)"). */
  function changeRate(r) {
    setRate(r);
    toast(`${VpeControls.speedText(st.rate)}${r > VpeControls.SPEED_MAX + 1e-9 ? ' (fastest)' : r < VpeControls.SPEED_MIN - 1e-9 ? ' (slowest)' : ''}`);
    if (controls) controls.refresh();
  }
  const bumpRate = (d) => changeRate(Math.round((st.rate + d * VpeControls.SPEED_STEP) * 100) / 100);
  function setLoop(l) { st.loop = l; if (clock) clock.setLoop(l); if (controls) controls.refresh(); save(); }
  /** A jump: one frame (lockstep) or seconds on the clock. */
  function jump(size, dir) {
    if (size === 'frame') step(dir);
    else skip(dir * Number(size));
  }

  // ---- files: add, replace, remove, leave ---------------------------------------------------------

  const toggleAddMode = () => { closeMenu(); vscode.postMessage({ type: 'addMode' }); };
  // The add mode's hint, while it is on (the host says so with 'addMode' messages).
  const addHint = $('addHint');
  const addHintText = $('addHintText');
  const stopAdd = $('stopAddBtn');
  stopAdd.addEventListener('pointerdown', (e) => e.stopPropagation());
  stopAdd.onclick = (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'stopAddMode' });
  };
  function showAddMode(m) {
    const refocus = !m.on && document.activeElement === stopAdd;
    addHint.hidden = !m.on;
    addHintText.textContent = m.on ? 'Click videos in Explorer to add · Esc to stop' : '';
    if (refocus) ui.cmpBtn.focus();
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
      pic: st.pic.mode, mode: st.mode, dock: st.dock, heroRatio: st.heroRatio, split: st.split, order: st.order, offsets: st.offsets, clock: st.clock, sound: st.sound, sel: st.sel,
      rate: st.rate, volume: st.volume, muted: st.muted, loop: st.loop, thresh: st.thresh, timeMode: st.timeMode, stepSize: prefs.stepSize,
      ab: { a: ab.a, b: ab.b, aPts: ab.aPts, bPts: ab.bPts, aNative: ab.aNative, bNative: ab.bNative },
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
    copyCanvas(out, `Display-size frame of ${tileLabel(i)}`, tiles[i]?.remoteStream);
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
    if (N >= 2) {
      const row = k.el('div', 'row static');
      row.insertAdjacentHTML('beforeend', ICONS.view);
      row.appendChild(k.el('span', 'grow', 'Layout'));
      const seg = k.el('div', 'seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Layout');
      const modes = N === 2
        ? [['spotlight', 'Spotlight'], ['grid', 'Grid'], ['split', 'Split']]
        : [['spotlight', 'Spotlight'], ['grid', 'Equal Grid']];
      for (const [m, label] of modes) {
        seg.appendChild(k.btn('chip', label, () => { setMode(m); toast(m === 'split' ? 'Split · drag the divider' : m === 'spotlight' ? 'Spotlight' : 'Equal Grid'); k.render(); }, { aria: { 'aria-pressed': String(st.mode === m) } }));
      }
      row.appendChild(seg);
      f.appendChild(row);
      if (N === 2) f.appendChild(k.btn('row', 'Swap sides', () => { swapSides(); k.render(); }, { icon: ICONS.swap, kbd: 'X' }));
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
    buttons: { cog: ui.cog, info: ui.infoBtn, rate: ui.rate, cmp: ui.cmpBtn, tracks: null, stepPrev: ui.prevSize, stepNext: ui.nextSize, remoteLive: ui.remoteLiveBtn },
    get: () => ({
      rate: st.rate, loop: st.loop, jump: prefs.jump, stepButtons: prefs.stepButtons, stepSize: VpeControls.stepSizeOf(prefs), picture: picState(), compare: { soundLabel: `from ${tileLabel(st.sound)}` },
      abLabel: ab.label(fmtAB),
      tools: [
        { label: 'Compare', note: `${N} videos`, on: true, keepOpen: true, run: () => controls.show('cmp', ui.cmpBtn) },
      ],
      ab: { items: [{ label: 'Export A–B Clips…', ariaLabel: 'Export A–B video for all Compare tiles', run: exportAB }] },
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
      stepSize: (v) => { prefs.stepSize = v; updateStepTips(); save(); postPlaybackPrefs(); toast(`Step buttons: ${VpeControls.stepName(v)}`); },
      cycleAB: () => markAB(),
      loop: () => { setLoop(!st.loop); toast(st.loop ? 'Loop on' : 'Loop off'); },
      copyFrame: () => copyView(),
      setPicture: (m) => { setPic(Pic.fresh(m)); toastPicture(); },
      zoomPicture: (d) => zoomPic(st.pic.zoom * (d > 0 ? Pic.STEP : 1 / Pic.STEP)),
      resetPicture: () => setPic(Pic.fresh(st.pic.mode)),
      setRate, pickRate: changeRate,
      stepRate: (d) => bumpRate(d),
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
    clearStep();
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
    finishTileDrag(false);
    relayout(() => commitOrder(Grid.moveTile(st.order, from, from + direction), video));
    if (focused) {
      const buttons = `[data-act="move"][data-i="${video}"]:enabled`;
      (cellsEl.querySelector(`${buttons}[data-d="${direction}"]`) || cellsEl.querySelector(buttons))?.focus();
    }
  }

  // ---- direct drag, 4-sided edge docking, full rect FLIP glide & skeletons ----------------------

  /** Each video's target cell rect (stage CSS px) in the current layout. */
  function slotRects() {
    /** @type {Record<string, {x: number, y: number, w: number, h: number}>} */
    const m = {};
    for (const c of cells) if (!c.add && !c.split) m[c.tiles[0]] = { x: c.x, y: c.y, w: c.w, h: c.h };
    return m;
  }
  /** The video that follows the pointer, or -1. */
  function liftedTile() { return tileDrag && tileDrag.lifted ? tileDrag.video : -1; }
  /** Where video v is shown right now (interpolated rect + scale 1.02 when lifted). */
  function shownRect(v, c, now) {
    const drag = tileDrag;
    if (drag && drag.lifted && v === drag.video && drag.lift) {
      return {
        x: drag.lift.x + (drag.px - drag.x),
        y: drag.lift.y + (drag.py - drag.y),
        w: drag.lift.w,
        h: drag.lift.h,
        s: 1.02,
      };
    }
    const o = glide.offset(v, now);
    return {
      x: c.x + o.dx,
      y: c.y + o.dy,
      w: Math.max(1, c.w + o.dw),
      h: Math.max(1, c.h + o.dh),
      s: 1,
    };
  }
  /** Snapshot of where every video is currently shown (for retargeting FLIP mid-flight). */
  function shownRects(now) {
    /** @type {Record<string, {x: number, y: number, w: number, h: number}>} */
    const m = {};
    for (const c of cells) {
      if (c.add || c.split) continue;
      const r = shownRect(c.tiles[0], c, now);
      m[c.tiles[0]] = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    return m;
  }
  /** Runs a layout change; tiles smoothly FLIP-glide (x, y, w, h) from where they were shown to their new slots. */
  function relayout(change) {
    const now = performance.now();
    const shown = shownRects(now);
    change();
    glide.retarget(shown, slotRects(), now, liftedTile());
    placeTileMotion(now);
    viewDirty = true;
    wakeLoop();
  }
  /** Positions each cell's DOM at its shown rect without distorting text/buttons; true while animating or lifted. */
  function placeTileMotion(now) {
    const lifted = liftedTile();
    const moving = lifted >= 0 || glide.active(now);
    if (!moving && !tilesMoving) return false;
    [...cellsEl.children].forEach((d, k) => {
      const c = cells[k];
      if (!c || c.add || c.split) return;
      const v = c.tiles[0];
      const r = shownRect(v, c, now);
      Object.assign(d.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      for (const ov of d.querySelectorAll('.ov')) {
        Object.assign(ov.style, { left: '0px', top: '0px', width: `${r.w}px`, height: `${r.h}px` });
      }
      d.style.transform = r.s !== 1 ? `scale(${r.s})` : '';
      d.classList.toggle('lifted', v === lifted);
    });
    tilesMoving = moving;
    return true;
  }
  /** Per frame: move the cells and redraw WebGL pictures while tiles glide or follow the pointer. */
  function stepTileMotion(now) {
    if (placeTileMotion(now)) viewDirty = true;
  }

  function showSkeleton(r, label, subRect = null) {
    if (!skeletonEl || !r) return;
    skeletonEl.hidden = false;
    Object.assign(skeletonEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    if (skeletonLabelEl) skeletonLabelEl.textContent = label;
    if (skeletonSubEl) {
      if (subRect) {
        skeletonSubEl.hidden = false;
        Object.assign(skeletonSubEl.style, { left: `${subRect.x}px`, top: `${subRect.y}px`, width: `${subRect.w}px`, height: `${subRect.h}px` });
      } else {
        skeletonSubEl.hidden = true;
      }
    }
  }
  function hideSkeleton() {
    if (skeletonEl) skeletonEl.hidden = true;
    if (skeletonSubEl) skeletonSubEl.hidden = true;
  }

  function previewTileDrag(e) {
    const drag = tileDrag;
    if (!drag || e.pointerId !== drag.id) return;
    drag.px = e.clientX;
    drag.py = e.clientY;
    const dx = drag.px - drag.x, dy = drag.py - drag.y;
    if (!drag.lifted && Math.hypot(dx, dy) < 6) return;
    if (!drag.lifted) {
      drag.lifted = true;
      stage.classList.add('tile-dragging');
      drag.lift = shownRects(performance.now())[drag.video] || null;
      if (splitterEl) splitterEl.hidden = true;
      if (confirmingId !== -1) { confirmingId = -1; updateOverlays(); }
      closeMenu();
      closeAddPop();
      try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    }

    const stRect = stage.getBoundingClientRect();
    const px = e.clientX - stRect.left;
    const py = e.clientY - stRect.top;

    if (drag.isHero) {
      const edge = Grid.detectEdgeDock(px, py, stRect.width, stRect.height);
      const nextDock = edge || drag.origDock;
      const preview = Grid.spotlightLayout({
        order: drag.origOrder, dock: nextDock, heroRatio: st.heroRatio,
        width: stRect.width, height: stRect.height, gap: Grid.GAP, pad: 0,
      });
      const mainRect = preview.rects[drag.video];
      showSkeleton(mainRect, nextDock === drag.origDock ? `Spotlight (${nextDock})` : `Dock Spotlight ${nextDock}`, preview.stripBounds);
      if (nextDock !== drag.previewDock) {
        drag.previewDock = nextDock;
        relayout(layoutCells);
      } else {
        placeTileMotion(performance.now());
        viewDirty = true;
      }
      return;
    }

    // Hit-test against the original layout's cells so targets stay stable while previewing.
    const baseCells = computeCells(drag.origOrder, drag.origDock, st.mode);
    let targetIdx = -1;
    for (let k = 0; k < baseCells.length; k++) {
      const c = baseCells[k];
      if (c.add || c.split) continue;
      if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
        targetIdx = drag.origOrder.indexOf(c.tiles[0]);
        break;
      }
    }
    const fromIdx = drag.fromIdx;
    let nextOrder = drag.origOrder;
    if (targetIdx >= 0) {
      if (st.mode === 'spotlight' && targetIdx === 0 && fromIdx !== 0) {
        nextOrder = drag.origOrder.slice();
        [nextOrder[0], nextOrder[fromIdx]] = [nextOrder[fromIdx], nextOrder[0]];
        const mainCell = baseCells.find((c) => !c.add && c.tiles[0] === drag.origOrder[0]);
        showSkeleton(mainCell, 'Swap into Spotlight');
      } else {
        nextOrder = Grid.moveTile(drag.origOrder, fromIdx, targetIdx);
        const destCells = computeCells(nextOrder, drag.origDock, st.mode);
        const dest = destCells.find((c) => !c.add && c.tiles[0] === drag.video);
        showSkeleton(dest, 'Move here');
      }
    } else {
      hideSkeleton();
    }
    const changed = nextOrder.length !== drag.previewOrder.length || nextOrder.some((v, idx) => v !== drag.previewOrder[idx]);
    if (changed) {
      drag.previewOrder = nextOrder;
      relayout(layoutCells);
    } else {
      placeTileMotion(performance.now());
      viewDirty = true;
    }
  }

  function finishTileDrag(commit = false) {
    const drag = tileDrag;
    if (!drag) return;
    const wasLifted = drag.lifted;
    const nextDock = commit ? drag.previewDock : drag.origDock;
    const nextOrder = commit ? drag.previewOrder : drag.origOrder;
    hideSkeleton();
    stage.classList.remove('tile-dragging');
    if (stage.hasPointerCapture(drag.id)) stage.releasePointerCapture(drag.id);
    if (!wasLifted) {
      tileDrag = null;
      return;
    }
    dragEnded = performance.now();
    if (drag.isHero) {
      relayout(() => {
        tileDrag = null;
        if (nextDock !== st.dock) {
          st.dock = nextDock;
          save();
          requestTileSize();
          announce(`Spotlight docked ${st.dock}`);
        }
        layoutCells();
      });
      return;
    }
    const orderChanged = nextOrder.some((v, idx) => v !== st.order[idx]);
    relayout(() => {
      tileDrag = null;
      if (orderChanged) commitOrder(nextOrder, drag.video);
      else updateOrderLayout();
    });
  }

  // Spotlight splitter resize (10%-90%, pointer + keyboard).
  if (splitterEl) {
    let splitDrag = null;
    const ratioFromEvent = (ev) => {
      const r = stage.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const innerW = Math.max(1, r.width - Grid.GAP), innerH = Math.max(1, r.height - Grid.GAP);
      if (st.dock === 'top') return py / innerH;
      if (st.dock === 'bottom') return 1 - py / innerH;
      if (st.dock === 'left') return px / innerW;
      return 1 - px / innerW;
    };
    splitterEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || st.mode !== 'spotlight') return;
      e.preventDefault();
      e.stopPropagation();
      splitDrag = { id: e.pointerId };
      splitterEl.classList.add('dragging');
      try { splitterEl.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    });
    splitterEl.addEventListener('pointermove', (e) => {
      if (!splitDrag || e.pointerId !== splitDrag.id) return;
      setHeroRatio(ratioFromEvent(e));
    });
    const endSplitDrag = (e) => {
      if (!splitDrag || (e && e.pointerId !== splitDrag.id)) return;
      splitDrag = null;
      splitterEl.classList.remove('dragging');
      dragEnded = performance.now();
      requestTileSize();
    };
    splitterEl.addEventListener('pointerup', endSplitDrag);
    splitterEl.addEventListener('pointercancel', endSplitDrag);
    splitterEl.addEventListener('click', (e) => e.stopPropagation());
    splitterEl.addEventListener('dblclick', (e) => { e.stopPropagation(); setHeroRatio(Grid.SPOTLIGHT_DEFAULT); requestTileSize(); });
    splitterEl.addEventListener('keydown', (e) => {
      const delta = e.shiftKey ? 0.10 : 0.05;
      const horiz = st.dock === 'top' || st.dock === 'bottom';
      let next = null;
      if (horiz && e.key === 'ArrowDown') next = st.heroRatio + (st.dock === 'top' ? delta : -delta);
      else if (horiz && e.key === 'ArrowUp') next = st.heroRatio + (st.dock === 'top' ? -delta : delta);
      else if (!horiz && e.key === 'ArrowRight') next = st.heroRatio + (st.dock === 'left' ? delta : -delta);
      else if (!horiz && e.key === 'ArrowLeft') next = st.heroRatio + (st.dock === 'left' ? -delta : delta);
      else if (e.key === 'Home') next = Grid.SPOTLIGHT_MIN;
      else if (e.key === 'End') next = Grid.SPOTLIGHT_MAX;
      if (next !== null) {
        e.preventDefault();
        e.stopPropagation();
        setHeroRatio(next);
        requestTileSize();
      }
    });
  }

  // Grouped Compare capsule + Add popover handlers.
  if (cmpGroupEl) {
    cmpGroupEl.addEventListener('click', (e) => {
      const b = /** @type {HTMLElement|null} */ (/** @type {any} */ (e.target).closest('button'));
      if (!b) return;
      if (b.dataset.layout) {
        e.stopPropagation();
        setMode(b.dataset.layout);
      } else if (b.id === 'addPopBtn') {
        e.stopPropagation();
        toggleAddPop();
      } else if (b.id === 'syncModeBtn') {
        e.stopPropagation();
        setSyncMode(!syncMode);
      }
    });
  }
  if (addPickBtn) addPickBtn.onclick = (e) => { e.stopPropagation(); closeAddPop(); vscode.postMessage({ type: 'add' }); };
  if (addModePopBtn) addModePopBtn.onclick = (e) => { e.stopPropagation(); closeAddPop(); toggleAddMode(); };

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
    item(largeGrid ? `Copy tile as shown (${k})` : `Copy frame (${k})`, '', () => copyTileFrame(i));
    item(`Copy timestamp (${k})`, fmtTime(tileTime(i)), () => copyTileTime(i));
    sep();
    item(`Replace ${k}…`, '', () => replaceVideo(i));
    item(`Remove ${k}`, '', () => removeTile(i));
    if (N < MAX_TILES) item('Add video…', '', addVideo);
    item('Leave compare', '', () => leave());
    sep();
    item('Keyboard shortcuts', '?', () => controls.openSheet(ui.cog));
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
    if (tileDrag?.lifted || !clock) return;
    const t = tileAt(e.target, e.clientX);
    openMenu(t === null ? st.clock : t, e.clientX, e.clientY);
  });

  // ---- pointer on the tiles --------------------------------------------------------------------

  /** The tile under the pointer (− / + nudge it), or null. */
  let hover = null;
  cellsEl.addEventListener('pointermove', (e) => {
    const nextHover = tileAt(e.target, e.clientX);
    if (confirmingId !== -1 && nextHover !== confirmingId) {
      confirmingId = -1;
      updateOverlays();
    }
    hover = nextHover;
  });
  cellsEl.addEventListener('pointerleave', () => {
    hover = null;
    if (confirmingId !== -1) { confirmingId = -1; updateOverlays(); }
  });
  cellsEl.addEventListener('click', (e) => {
    if (performance.now() - dragEnded < 300) { e.stopPropagation(); e.preventDefault(); return; }
    const el = /** @type {any} */ (e.target).closest('[data-act]');
    if (!el) return;
    e.stopPropagation();
    const i = Number(el.dataset.i);
    switch (el.dataset.act) {
      case 'move': moveWithArrow(el); break;
      case 'spot': promoteToSpotlight(i); break;
      case 'info':
        if (statsIds.has(i)) statsIds.delete(i); else statsIds.add(i);
        updateOverlays();
        break;
      case 'mute':
        if (st.muted || i !== st.sound) {
          if (i !== st.sound) setSound(i, true);
          if (st.muted) setMute(false);
          else updateOverlays();
        } else {
          setMute(true);
        }
        break;
      case 'remove':
        if (!Grid.canRemoveTile(N)) return;
        if (confirmingId === i) { confirmingId = -1; removeTile(i); }
        else { confirmingId = i; updateOverlays(); }
        break;
      case 'openVid': closeMenu(); closeAddPop(); st.sel = i; controls.show('cmpVid', ui.cmpBtn); break;
      case 'nudge': nudge(i, Number(el.dataset.d)); break;
      case 'add': addVideo(); break;
    }
  });
  // A press outside the tile menu or Add popover closes them; the click that follows was only the dismissal.
  let menuDismissed = false;
  document.addEventListener('pointerdown', (e) => {
    menuDismissed = false;
    const t = /** @type {Node} */ (e.target);
    if (!ui.menu.hidden && !ui.menu.contains(t)) {
      menuDismissed = stage.contains(t);
      closeMenu();
    }
    if (addPopEl && !addPopEl.hidden && !addPopEl.contains(t) && (!addPopBtn || !addPopBtn.contains(t))) {
      menuDismissed = menuDismissed || stage.contains(t);
      closeAddPop();
    }
  }, true);
  // A click on the picture plays or pauses; with a panel or the menu open it only closes them.
  stage.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const menuWas = menuDismissed;
    menuDismissed = false;
    if (controls.consumeDismiss() || menuWas) return;
    if (!ui.menu.hidden) { closeMenu(); return; }
    if (addPopEl && !addPopEl.hidden) { closeAddPop(); return; }
    if (controls.anyOpen()) { controls.closeAll(false); return; }
    if (performance.now() - dragEnded < 300) return;
    if (/** @type {any} */ (e.target).closest('#divider, #splitter, button')) return;
    togglePlay();
  });
  // Ctrl+wheel (pinch) zooms every tile around the pointer; a drag moves them all (the same part of each picture).
  stage.addEventListener('wheel', (e) => {
    if (tileDrag?.lifted) { e.preventDefault(); return; }
    if (!e.ctrlKey || !clock) return;
    const hit = cellAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    zoomPic(st.pic.zoom * Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.002), hit);
    toastPicture(hit.c);
  }, { passive: false });
  let panDrag = null;
  // Unified pointerdown:
  // - Zoomed (>1x / overflowing): video body pans all tiles in lockstep, EXCEPT grabbing the ⋮⋮ bottom-left name pill repositions/docks tiles.
  // - Unzoomed (1x): dragging anywhere on any tile past 6 px lifts and repositions/docks it.
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || tileDrag || panDrag) return;
    const target = /** @type {any} */ (e.target);
    if (target.closest('#divider, #splitter, #menu, .move, .tbtn, .mute-mini, .sync-pill, .addcell')) return;
    const hit = cellAt(e.clientX, e.clientY);
    const fromZoomHandle = !!target.closest('[data-zoom-drag="1"]');
    const panBase = hit ? hit.c : clockCell();
    const ref = clock && panBase ? Pic.panCell(cells, panBase) : null;
    if (ref && !fromZoomHandle) {
      const h = hit || { c: ref, i: ref.tiles[0], px: ref.w / 2, py: ref.h / 2 };
      panDrag = { x: e.clientX, y: e.clientY, pic: st.pic, hit: { ...h, c: ref, i: ref.tiles[0] }, moved: false, id: e.pointerId };
      return;
    }
    if (!hit || hit.c.add || st.mode === 'split' || hit.c.split) return;
    const video = hit.c.tiles[0];
    const fromIdx = st.order.indexOf(video);
    if (fromIdx < 0) return;
    tileDrag = {
      id: e.pointerId, video, fromIdx,
      x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY,
      lift: null,
      origOrder: st.order.slice(), previewOrder: st.order.slice(),
      origDock: st.dock, previewDock: st.dock,
      isHero: st.mode === 'spotlight' && st.order[0] === video,
      lifted: false,
    };
  });
  stage.addEventListener('pointermove', (e) => {
    if (tileDrag && e.pointerId === tileDrag.id) { previewTileDrag(e); return; }
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
  stage.addEventListener('pointerup', (e) => {
    if (tileDrag && e.pointerId === tileDrag.id) { previewTileDrag(e); finishTileDrag(true); return; }
    endPan(e);
  });
  stage.addEventListener('click', (e) => {
    if (performance.now() - dragEnded >= 300 || !(/** @type {any} */ (e.target).closest('.pill, .nudge'))) return;
    e.stopPropagation(); // the end of a pan or tile drag that started on a pill is not a click on it
    e.preventDefault();
  }, true);
  for (const event of ['pointercancel', 'lostpointercapture']) {
    stage.addEventListener(event, (e) => {
      if (tileDrag && e.pointerId === tileDrag.id) finishTileDrag(false);
      else endPan(e);
    });
  }
  // Prevent Chromium from starting a native text/element drag ghost when dragging across tiles or pills.
  stage.addEventListener('dragstart', (e) => e.preventDefault());
  // Wheel while paused: jump.wheel; Shift+wheel: jump.wheelShift. Chromium on Windows reports Shift+wheel as deltaX.
  stage.addEventListener('wheel', (e) => {
    if (tileDrag?.lifted || e.ctrlKey) return;
    if (!clock || clock.playing) return;
    e.preventDefault();
    const delta = e.deltaY || (e.shiftKey ? e.deltaX : 0);
    if (delta) jump(e.shiftKey ? prefs.jump.wheelShift : prefs.jump.wheel, delta > 0 ? 1 : -1);
  }, { passive: false });

  // ---- the bar ------------------------------------------------------------------------------------

  // The time follows the clock video: its letter first.
  const who = document.createElement('span');
  who.className = 'who';
  ui.time.insertBefore(who, ui.time.firstChild);

  let lastUi = '';
  function updateUi() {
    if (!clock) return;
    const goal = stepGoal.goal;
    const dragFrame = scrubbing ? Number(ui.seek.value) : null;
    const f = goal?.frame ?? dragFrame ?? clock.currentFrame();
    if (!scrubbing) ui.seek.value = String(f);
    const playing = clock.playing;
    const fr = tiles.map((p, i) => (p === clock ? p.currentFrame() + 1 : p.shownT !== null && !outs[i] ? frameOf(p) + 1 : null));
    const t = goal?.time ?? (dragFrame === null ? clock.currentTime()
      : Math.min(clock.meta.duration || Infinity, dragFrame / clock.frameNumberRate()));
    const offset = offSec(st.clock);
    const key = `${fr.join(',')}|${f}|${playing}|${t.toFixed(3)}|${tiles.map((p) => p.n).join(',')}|${st.timeMode}|${st.clock}|${ab.a}|${ab.b}|${offset}`;
    if (key !== lastUi || infoDirty) {
      lastUi = key;
      infoDirty = false;
      const dur = clock.meta.duration || 0;
      VpeControls.drawRangeMarks(ui.abMarks, ui.abA, ui.abB, ab.marks(dur, offset));
      VpeControls.drawRangeButtons(ui.setABtn, ui.setBBtn, ab);
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
  // The buttons beside Play: the size picked with their badge, else one frame (lockstep) or the Ctrl+arrow jump
  // (setting stepButtons), as in the player.
  const stepBtn = (d) => {
    const a = VpeControls.stepAmount(VpeControls.stepSizeOf(prefs));
    if (a.n) step(d * a.n); else skip(d * a.s);
  };
  ui.prev.onclick = () => stepBtn(-1);
  ui.next.onclick = () => stepBtn(1);
  // The badge on a step button opens the size popover above it; the click never reaches the step button or the bar.
  for (const b of [ui.prevSize, ui.nextSize]) b.addEventListener('click', (e) => { e.stopPropagation(); controls.toggle('step', b); });
  function updateStepTips() {
    const tips = VpeControls.stepTips(prefs);
    const frame = VpeControls.stepSizeOf(prefs) === 'frame';
    ui.prev.title = frame ? 'Previous frame (all videos)  ,' : tips.back;
    ui.next.title = frame ? 'Next frame (all videos)  .' : tips.fwd;
    ui.prev.setAttribute('aria-label', frame ? 'Previous frame' : tips.backLabel);
    ui.next.setAttribute('aria-label', frame ? 'Next frame' : tips.fwdLabel);
    VpeControls.drawStepBadges([ui.prevSize, ui.nextSize], VpeControls.stepSizeOf(prefs));
  }
  updateStepTips();
  ui.mute.onclick = () => setMute(!st.muted);
  VpeRangeDrag.bind(ui.volume);
  VpeControls.holdVolumeOpen(ui.volume);
  ui.volume.addEventListener('input', () => { if (hasAudio()) setVolume(Number(ui.volume.value)); });
  ui.volume.addEventListener('wheel', (e) => { if (!hasAudio()) return; e.preventDefault(); setVolume(st.volume + (e.deltaY < 0 ? 0.05 : -0.05)); toast(`Volume ${Math.round(st.volume * 100)}%`); }, { passive: false });
  ui.time.onclick = () => { st.timeMode = (st.timeMode + 1) % 3; lastUi = ''; updateUi(); save(); postPlaybackPrefs(); toast(['Time', 'Timecode', 'Frame number'][st.timeMode]); };
  ui.rate.onclick = () => controls.toggle('speed', ui.rate);
  ui.rate.addEventListener('wheel', (e) => { e.preventDefault(); bumpRate(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  ui.cog.onclick = () => controls.toggle('main', ui.cog);
  if (ui.remoteLiveBtn) ui.remoteLiveBtn.onclick = (e) => { e.stopPropagation(); controls.toggle('transcode', ui.remoteLiveBtn); };
  ui.infoBtn.onclick = () => controls.toggle('info', ui.infoBtn);
  ui.infoBtn.title = 'About these videos  I';
  ui.infoBtn.setAttribute('aria-label', 'About these videos');
  ui.picBtn.onclick = (e) => { e.stopPropagation(); cyclePic(); };
  updatePicBtn();
  ui.cmpBtn.onclick = () => controls.toggle('cmp', ui.cmpBtn);
  ui.full.onclick = toggleFullscreen;
  const thumbBox = document.createElement('div');
  const thumbCv = document.createElement('canvas');
  thumbBox.id = 'thumb';
  thumbBox.hidden = true;
  thumbBox.appendChild(thumbCv);
  ui.tip.parentElement.appendChild(thumbBox);
  const canSeek = () => clock && clock.vmode !== undefined && !clock.meta.live;
  seekDragger = VpeRangeDrag.bindSeek(ui.seek, {
    preview(frame) {
      if (!canSeek()) return;
      if (!scrubbing) {
        stepGoal.clear();
        sync.clearStep();
        scrubbing = true;
        for (const p of tiles) p.beginScrub();
      }
      const source = clock;
      const rect = ui.seek.getBoundingClientRect();
      const px = rect.width * frame / (Number(ui.seek.max) || 1);
      showSeekTip(frame, px, rect.width);
      source.thumbnail(frame / source.frameNumberRate(), (picture) => {
        if (!scrubbing || source !== clock) return;
        ThumbService.draw(thumbCv, picture);
        thumbBox.hidden = false;
        const half = thumbBox.offsetWidth / 2 || 82;
        thumbBox.style.left = `${Math.max(half, Math.min(rect.width - half, px))}px`;
      }, true);
      updateUi();
      wakeLoop();
    },
    finish() {
      if (!scrubbing) return;
      scrubbing = false;
      clock?.thumbnailLeave(true);
      for (const p of tiles) p.endScrub();
      ui.tip.hidden = true;
      thumbBox.hidden = true;
      wakeLoop();
    },
    commit(frame) {
      if (!canSeek()) return;
      stepGoal.clear();
      stepGoal.set(frame, goalBounds(), true);
      updateUi();
      wakeLoop();
    },
  });
  function showSeekTip(frame, px, width) {
    ui.tip.textContent = `${tileLabel(st.clock)} ${fmtTime(frame / fpsOf(clock))} ? #${frame + 1}`;
    ui.tip.style.left = `${Math.max(30, Math.min(width - 30, px))}px`;
    ui.tip.hidden = false;
  }
  ui.seek.addEventListener('mousemove', (e) => {
    if (scrubbing || !clock || !clock.n) return;
    const r = ui.seek.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    showSeekTip(Math.round(x * (clock.n - 1)), e.clientX - r.left, r.width);
  });
  ui.seek.addEventListener('mouseleave', () => { if (!scrubbing) ui.tip.hidden = true; });
  // A click on the bar's empty space closes the menu.
  ui.bar.addEventListener('click', () => closeMenu());

  let fsBusy = false;
  let lastEscAt = 0;
  async function toggleFullscreen() {
    if (fsBusy) return;
    fsBusy = true;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      // Some hosts don't allow fullscreen in webviews; toggle Zen Mode on the host (which syncs body.maxi).
      log(`fullscreen refused: ${e}`);
      vscode.postMessage({ type: 'focusMode' });
    } finally {
      fsBusy = false;
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
    if (e.key !== 'Escape') return;
    if (tileDrag) {
      e.preventDefault();
      e.stopPropagation();
      finishTileDrag(false);
      return;
    }
    if (confirmingId !== -1) {
      e.preventDefault();
      e.stopPropagation();
      confirmingId = -1;
      updateOverlays();
      return;
    }
    if (addPopEl && !addPopEl.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeAddPop();
      if (addPopBtn) addPopBtn.focus();
    }
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
    if (e.key === 'Escape' && syncMode) { e.preventDefault(); setSyncMode(false); if (syncModeBtn) syncModeBtn.focus(); return; }
    if (e.key === 'Escape' && !addHint.hidden) { e.preventDefault(); vscode.postMessage({ type: 'stopAddMode' }); return; }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); controls.toggleSheet(); return; }
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
      case 'ArrowUp':
        if (!hasAudio()) { toast('No audio track'); break; }
        setVolume(st.volume + 0.05); toast(`Volume ${Math.round(st.volume * 100)}%`); break;
      case 'ArrowDown':
        if (!hasAudio()) { toast('No audio track'); break; }
        setVolume(st.volume - 0.05); toast(`Volume ${Math.round(st.volume * 100)}%`); break;
      case 'Home': pause(); seekClock(0); break;
      case 'End': pause(); seekTile(st.clock, clock.n - 1); break;
      case 'm': case 'M': setMute(!st.muted); break;
      case 'r': case 'R': setLoop(!st.loop); toast(st.loop ? 'Loop on' : 'Loop off'); break;
      case 'a': case 'A': markAB('a'); break;
      case 'b': case 'B': markAB('b'); break;
      case 'f': case 'F': if (!e.repeat) toggleFullscreen(); break;
      case 'i': case 'I': controls.toggle('info', ui.infoBtn); break;
      case 'x': case 'X': if (pair) swapSides(); else handled = false; break;
      case 'z': case 'Z': if (e.shiftKey) handled = false; else cyclePic(); break;
      case 'D': if (e.shiftKey && N < MAX_TILES) toggleAddMode(); else handled = false; break;
      case '-': case '_': nudge(target(), -1); break;
      case '+': case '=': nudge(target(), 1); break;
      case 'Escape':
        if (INTERNAL && scanner.running) scanner.stop('Stopped');
        else {
          handled = false;
          if (!e.repeat && document.body.classList.contains('maxi')) {
            const now = Date.now();
            if (now - lastEscAt <= 1000) { lastEscAt = 0; vscode.postMessage({ type: 'focusModeExited' }); }
            else lastEscAt = now;
          }
        }
        break;
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
          const { nextQueuedT: tA, seekTarget, eof } = sA.syncState();
          if (seekTarget !== null || tA === null) {
            if (eof && tA === null && seekTarget === null && !(sA.vdec && sA.vdec.decodeQueueSize)) {
              this.stop(`No frame below ${this.thresh} dB after #${this.from} (${this.count} frames checked)`);
              return;
            }
            break;
          }
          const aRel = sA.rel(tA);
          const bRel = aRel + this.d + 0.25 / fpsOf(sB);
          const Tb = sB.startT + bRel;
          const eB = earlyOf(sB);
          const bLast = sB.queue.length ? sB.queue[sB.queue.length - 1].t : -Infinity;
          const bDone = sB.eof && sB.seekTarget === null && !(sB.vdec && sB.vdec.decodeQueueSize);
          if (sB.seekTarget !== null || (bLast <= Tb + eB && !bDone)) break; // B not decoded that far yet
          sA.retargetPaused(tA);
          sA.tick();
          sB.retargetPaused(Tb);
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
    clearStep();
    uploadedMarks = [];
    presentedMarks = [];
    scanner.stop();
    for (const p of Object.values(engines)) {
      try {
        p.dispose();
        p.gl?.dispose?.({ loseContext: true });
      } catch (e) { log(`dispose ${p.key}: ${e && e.message || e}`); }
      delete engines[p.key];
    }
    comp?.dispose();
    resetReadback();
    tiles = [];
    sync.setClock(st.clock, st.loop);
    clock = comp = null;
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
    return !!clock && tiles.length === N && begun && !clock.playing && !pendingStart && !scanner.running && !sync.waiting
      && !waitSince && !viewDirty && !layoutDirty && !infoDirty && !scrubbing && !tilesMoving && tiles.every((p) => typeof p.settled === 'function' && p.settled());
  }

  function frameLoop(now) {
    if (clock && tiles.length === N) {
      try {
        const offset = offSec(st.clock);
        const start = Math.max(0, ab.a === null ? 0 : ab.a + offset);
        const end = ab.b === null ? -Infinity : ab.b + offset;
        const range = begun && visible && clock.startT !== null && end >= start
          ? { start: clock.startT + start, end: clock.startT + end } : undefined;
        clock.tick(now, range);
        if (restoreClock && clock.startT !== null && clock.vmode !== undefined && visible) {
          const { time, playing } = restoreClock;
          restoreClock = null;
          if (time > 0) seekClock(time);
          if (playing) play();
        }
        if (begun && visible && !scrubbing) {
          if (pendingStart && tiles.every((p) => p.startT !== null)) { seekClock(pendingStart); pendingStart = 0; }
          if (stepGoal.goal && sync.clockStepReady) stepGoal.settle();
          if (clock.playing) sync.syncPlaying();
        }
        for (const p of tiles) if (p !== clock) p.tick(now);
        if (begun && visible && !scrubbing && !stepGoal.goal) sync.syncPaused();
        stepTileMotion(now);
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
    if (!visible) { finishTileDrag(false); closeAddPop(); }
    if (!clock) return;
    if (!visible) { clearStep(); resumeOnShow = resumeOnShow || clock.playing; pause(); }
    for (const p of tiles) if (p.remoteStream) p.setHidden(!visible);
    if (visible && resumeOnShow) { resumeOnShow = false; play(); }
  });
  document.addEventListener('visibilitychange', () => syncVisibility(document.hidden));

  function useOriginalTile(i, notice) {
    seekDragger?.stop();
    const old = tiles[i];
    if (!old || nativeTiles[i] !== 'transcode') return;
    if (old === clock) {
      clearStep();
      restoreClock = { time: clock.currentTime(), playing: clock.playing };
      pause();
    }
    old.dispose();
    old.gl?.dispose?.({ loseContext: true });
    nativeTiles[i] = false;
    const p = makeEngine(KEYS[i], { quiet: false, budget: memory.frames });
    tiles[i] = p;
    clock = sync.replaceTile(i, old, st.loop);
    p.setRate(st.rate);
    applyVolume();
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
      case 'abQuery': exportAB(); break;
      case 'toast': toast(String(m.text || ''), Math.min(10000, Number(m.ms)) || undefined); break;
      case 'addMode':
        if (m.on) { finishTileDrag(false); closeAddPop(); }
        showAddMode(m);
        break;
      case 'open':
        syncVisibility(document.hidden, m.visible !== false);
        sizes = m.sizes;
        nativeTiles = m.native || nativeTiles;
        try {
          // The shared renderer of a large grid draws into the compositor's textures from the first frame.
          if (largeGrid && !comp) comp = new Compositor(canvas, N, Grid);
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
        if (p) p.onBlock(m.pos, m.data, m.error);
        break;
      }
      case 'resize': {
        if (!clock) break;
        // Every resized tile seeks from the same clock sample, including when playback is paused.
        sync.resyncAfterResize((cRel, master) => {
          for (const i of m.tiles) {
            const p = tiles[i];
            if (p) p.refreshNativeFrame(false, p === master ? cRel : sync.relFor(i, cRel));
          }
        });
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
      case 'thumb': engines[m.key]?.onHostThumb(m); break;
      case 'ndv': { const p = engines[m.key]; if (p) p.onNativeVideo(m); break; }
      case 'nda': { const p = engines[m.key]; if (p) p.onNativeAudio(m); break; }
      case 'originalTile': useOriginalTile(m.index, m.notice); break;
      case 'playbackPrefs': applyPlaybackPrefs(m.prefs); break;
      case 'focusMode': document.body.classList.toggle('maxi', !!m.active); break;
      case 'visible':
        if (m.active === false) { finishTileDrag(false); closeAddPop(); }
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
  setRate(st.rate, false);
  ui.volume.value = String(st.volume);
  setMute(st.muted, false);
  // A video opened into compare starts where the player was.
  if (!(saved.t > 0) && cfg.start > 0) saved.t = cfg.start;

  const synced = () => !!clock && !clock.playing && !stepGoal.goal
    && tiles.every((p, i) => outs[i] || settled(p)) && upCount[st.clock] === (clock.shownCount || 0);
  // For tests and debugging (and the future advanced mode: metrics, the difference search).
  /** @type {any} */ (window).vpeCompare = {
    get tiles() { return tiles; }, get clock() { return clock; }, get A() { return tiles[0]; }, get B() { return tiles[1]; },
    st, scanner, settled, computeMetrics, ssim, synced,
    step, seekClock, seekA: seekClock, play, pause, setMode, setDock, setHeroRatio, setSyncMode, setOffset, setClock, setSound, setSplit, swapSides, nudge, leave, removeTile,
    metrics: () => lastMetrics,
    measure: (opt) => pairMetrics(tiles[0], tiles[1], { ssim: true, rgb: true, ...opt }),
  };

  VpeCompareDebug.install({
    cfg, log, Grid, N, MAX_TILES, st, canvas, stage, cellsEl, ui, controls,
    scanner, $, getState: () => ({ tiles, clock, cells, hover, syncMode, statsIds }),
    contextCount: () => (comp?.contextCount ?? 0) + Number(hasReadback()),
    setHover: (value) => { hover = value; },
    frameOf, fpsOf, synced, tileSize, frameFactor, picState, setMode, setDock, setHeroRatio, setSyncMode, setOffset,
    setClock, removeTile, setSound, step, play, pause, seekClock, setRate,
    setSplit, tileOr0, leave,
  });

  // Frames for native tiles come at the tile's size: tell the host how big a tile is.
  const tile = tileSize();
  lastTileSize = JSON.stringify(tile);
  vscode.postMessage({ type: 'tileOrder', order: st.order });
  vscode.postMessage({ type: 'ready', tile, origin: window.location.origin });
})();
