// @ts-check
// Pure unified player & compare state (zero DOM, zero VS Code, zero decoder).
// Shared by the webview UI, Node unit tests (millisecond verification), and the reusable mockup harness
// (tools/mockup/render.js). Plain JS, no build step (ADR 0001).
'use strict';

(() => {
  // checkJs: start
  /**
   * @typedef {object} ClipMeta
   * @property {string} id
   * @property {string} name
   * @property {string} [codec]
   * @property {number} [fps]
   * @property {number} [frames]
   * @property {string} [color]
   * @property {string} [bg1]
   * @property {string} [bg2]
   * @property {string} [accent]
   */

  /** @typedef {'grid' | 'spotlight' | 'split'} LayoutMode */
  /** @typedef {'top' | 'bottom' | 'left' | 'right'} DockSide */
  /** @typedef {'frames' | 'ms'} OffsetUnit */
  /** @typedef {'fit' | 'fill' | 'stretch' | 'actual'} PicMode */

  /**
   * A tile's offset against the clock, as in Compare (media/compare.js `st.offsets`): whole frames of that video,
   * or milliseconds kept to 1/1000 ms so frames → ms → frames is lossless at 23.976 / 29.97.
   * @typedef {object} Offset
   * @property {OffsetUnit} unit
   * @property {number} v
   */

  /**
   * @typedef {object} TabState
   * @property {number} id
   * @property {string[]} tiles ordered clip ids currently in this tab
   * @property {boolean} capture when true, newly opened videos join this tab
   * @property {LayoutMode} layout
   * @property {string | null} spotlightId clip id currently enlarged in Spotlight (null in Grid/Split)
   * @property {DockSide} dock which edge the Spotlight main tile sits on
   * @property {number} heroRatio Spotlight main tile fraction (0.10-0.90)
   * @property {number} split Split Wipe divider fraction (0-1, as in Compare: Home 0 %, End 100 %)
   * @property {Record<string, Offset>} offsets per-clip offsets; exactly one entry per tile
   * @property {string | null} clockId the tile whose time the seek bar and frame counter show (null only when empty)
   * @property {string | null} soundId the tile heard; the others are muted (null only when empty)
   * @property {string[]} statsOpen clip ids whose ⓘ details card is open
   * @property {string | null} removeConfirmId clip id whose remove button asks "Remove?"
   * @property {number} zoom picture zoom of every tile (1 = the mode's own size)
   * @property {number} panX horizontal pan in CSS px
   * @property {number} panY vertical pan in CSS px
   * @property {PicMode} picMode picture size mode (media/picture.js MODES)
   * @property {boolean} syncMode whether per-tile offset steppers are shown
   * @property {boolean} playing
   * @property {number} frame
   * @property {number} maxFrame
   * @property {number} fps
   * @property {boolean} muted
   * @property {number} maxVideos
   */

  /**
   * @typedef {object} WorkspaceState
   * @property {TabState[]} tabs
   * @property {number} activeTabId
   * @property {number} nextTabId
   * @property {number} maxVideos
   */

  /**
   * @typedef {object} CellRect
   * @property {string} clipId
   * @property {number} index
   * @property {string} letter
   * @property {number} x
   * @property {number} y
   * @property {number} w
   * @property {number} h
   * @property {'single' | 'grid' | 'hero' | 'strip' | 'split-a' | 'split-b'} role
   */

  /**
   * The Spotlight splitter: the gap band between the main tile and the strip.
   * 'horizontal' = a horizontal line (dock top / bottom, dragged up and down); 'vertical' for left / right.
   * @typedef {object} SplitterRect
   * @property {'horizontal' | 'vertical'} orientation
   * @property {number} x
   * @property {number} y
   * @property {number} w
   * @property {number} h
   * @property {DockSide} dock
   * @property {number} ratio
   */

  /**
   * @typedef {object} DerivedUi
   * @property {number} n
   * @property {boolean} isMulti
   * @property {LayoutMode} effectiveLayout
   * @property {boolean} showCC
   * @property {boolean} showFolderCapsule
   * @property {boolean} showSplitBtn
   * @property {boolean} showSyncBtn
   * @property {boolean} showCaptureBanner
   * @property {string} captureLabel
   * @property {string} captureTitle
   * @property {string} layoutLabel
   * @property {boolean} showSplitter
   * @property {boolean} showDivider
   * @property {CellRect[]} cells
   * @property {{ x: number, y: number, w: number, h: number } | null} addSlot
   * @property {SplitterRect | null} splitter Spotlight splitter geometry (null outside Spotlight)
   */

  const TILE_KEYS = 'ABCDEFGHIJKLMNOP';
  const DOCKS = /** @type {const} */ (['top', 'bottom', 'left', 'right']);
  const PIC_MODES = /** @type {const} */ (['fit', 'fill', 'stretch', 'actual']);
  const DEFAULT_MAX_VIDEOS = 8;
  /** Spotlight main tile default, as media/compare-grid.js SPOTLIGHT_DEFAULT. */
  const HERO_DEFAULT = 0.72;
  /** Gap between tiles in CSS px, as media/compare-grid.js GAP. */
  const GAP = 2;
  /** Zoom bounds the pure state accepts (media/picture.js ACTUAL_MIN / ABS_MAX); the engine applies the per-mode limits. */
  const ZOOM_MIN = 1 / 16;
  const ZOOM_MAX = 64;
  /** One ms nudge, as media/compare.js `nudge`. */
  const MS_STEP = 10;
  /** @type {Record<string, LayoutMode>} Compare's old names for the same layouts. */
  const LAYOUT_ALIASES = { grid: 'grid', side: 'grid', spotlight: 'spotlight', split: 'split', wipe: 'split' };

  /**
   * @param {number} v
   * @param {number} lo
   * @param {number} hi
   */
  const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);

  /** @param {number} v */
  const round3 = (v) => Math.round(v * 1000) / 1000;

  /**
   * An offset value rounded for its unit: whole frames, or ms to 1/1000 (media/compare.js setOffset).
   * @param {OffsetUnit} unit
   * @param {number} v
   */
  const roundFor = (unit, v) => {
    const r = unit === 'ms' ? round3(v) : Math.round(v);
    return r === 0 ? 0 : r; // no -0
  };

  /**
   * Coerce a stored or legacy offset (a plain number = frames) to `{ unit, v }`.
   * @param {unknown} o
   * @returns {Offset}
   */
  function toOffset(o) {
    if (typeof o === 'number') return { unit: 'frames', v: Number.isFinite(o) ? roundFor('frames', o) : 0 };
    if (o && typeof o === 'object') {
      const r = /** @type {{ unit?: unknown, v?: unknown }} */ (o);
      /** @type {OffsetUnit} */
      const unit = r.unit === 'ms' ? 'ms' : 'frames';
      const v = Number(r.v);
      return { unit, v: Number.isFinite(v) ? roundFor(unit, v) : 0 };
    }
    return { unit: 'frames', v: 0 };
  }

  /**
   * Offset text as Compare shows it (media/compare-grid.js offText): short "0", "+3 f", "−40 ms" (U+2212 minus) for
   * the nudge and panel rows, long "In step", "+1 frame", "+3 frames", "−40 ms" for the page.
   * @param {Offset | number | null | undefined} off
   * @returns {{ short: string, long: string }}
   */
  function formatOffset(off) {
    const o = toOffset(off);
    if (!o.v) return { short: '0', long: 'In step' };
    const sg = o.v > 0 ? '+' : '−';
    const a = Math.abs(o.v);
    if (o.unit === 'ms') {
      const ms = `${sg}${Math.round(a * 10) / 10} ms`;
      return { short: ms, long: ms };
    }
    return { short: `${sg}${a} f`, long: `${sg}${a}${a === 1 ? ' frame' : ' frames'}` };
  }

  /**
   * @param {number} n
   * @returns {{ cols: number, rows: number }}
   */
  function gridDimensions(n) {
    if (n <= 1) return { cols: 1, rows: 1 };
    if (n === 2) return { cols: 2, rows: 1 };
    if (n <= 4) return { cols: 2, rows: 2 };
    const cols = Math.ceil(Math.sqrt(n));
    return { cols, rows: Math.ceil(n / cols) };
  }

  /**
   * Restore every cross-field invariant after an action: clock, sound, Spotlight and the per-tile UI ids point at
   * tiles that exist, offsets have exactly one entry per tile, and the layout is valid for N (N = 1 is the plain
   * single player). Every tab change goes through here, so no action can leave a dangling id behind.
   * @param {TabState} t
   * @returns {TabState}
   */
  function reconcile(t) {
    const tiles = t.tiles;
    const n = tiles.length;
    const first = tiles[0] ?? null;
    const has = (/** @type {string | null | undefined} */ id) => id != null && tiles.includes(id);
    /** @type {LayoutMode} */
    let layout = t.layout;
    if (n < 2 || (layout === 'split' && n !== 2)) layout = 'grid';
    /** @type {string | null} */
    let spotlightId = null;
    if (layout === 'spotlight') spotlightId = has(t.spotlightId) ? t.spotlightId : first;
    /** @type {Record<string, Offset>} */
    const offsets = {};
    for (const id of tiles) offsets[id] = toOffset(t.offsets[id]);
    return {
      ...t,
      layout,
      spotlightId,
      offsets,
      clockId: has(t.clockId) ? t.clockId : first,
      soundId: has(t.soundId) ? t.soundId : first,
      statsOpen: t.statsOpen.filter((id, i, a) => has(id) && a.indexOf(id) === i),
      removeConfirmId: has(t.removeConfirmId) ? t.removeConfirmId : null,
      syncMode: n >= 2 && t.syncMode,
    };
  }

  /**
   * @param {Partial<Omit<TabState, 'offsets'>> & { id: number, tiles: string[], offsets?: Record<string, Offset | number> }} init
   * @returns {TabState}
   */
  function createTab(init) {
    const tiles = Array.from(new Set(init.tiles || []));
    const maxVideos = Math.max(2, Math.min(TILE_KEYS.length, Math.floor(init.maxVideos || DEFAULT_MAX_VIDEOS)));
    const layout = normalizeLayout(init.layout) || 'grid';
    /** @type {DockSide} */
    const dock = DOCKS.includes(/** @type {any} */ (init.dock)) ? /** @type {DockSide} */ (init.dock) : 'top';
    /** @type {PicMode} */
    const picMode = PIC_MODES.includes(/** @type {any} */ (init.picMode)) ? /** @type {PicMode} */ (init.picMode) : 'fit';
    /** @type {Record<string, Offset>} */
    const offsets = {};
    for (const [id, o] of Object.entries(init.offsets || {})) offsets[id] = toOffset(o);
    return reconcile({
      id: init.id,
      tiles,
      capture: !!init.capture,
      layout,
      spotlightId: init.spotlightId ?? null,
      dock,
      heroRatio: clamp(init.heroRatio ?? HERO_DEFAULT, 0.10, 0.90),
      split: clamp(init.split ?? 0.5, 0, 1),
      offsets,
      clockId: init.clockId ?? null,
      soundId: init.soundId ?? null,
      statsOpen: Array.isArray(init.statsOpen) ? init.statsOpen.slice() : [],
      removeConfirmId: init.removeConfirmId ?? null,
      zoom: clamp(init.zoom ?? 1, ZOOM_MIN, ZOOM_MAX),
      panX: Number.isFinite(init.panX) ? Number(init.panX) : 0,
      panY: Number.isFinite(init.panY) ? Number(init.panY) : 0,
      picMode,
      syncMode: !!init.syncMode,
      playing: !!init.playing,
      frame: Math.max(0, Math.floor(init.frame ?? 48)),
      maxFrame: Math.max(1, Math.floor(init.maxFrame ?? 240)),
      fps: Math.max(1, Number(init.fps) || 24),
      muted: init.muted !== undefined ? !!init.muted : true,
      maxVideos,
    });
  }

  /**
   * @param {{ tiles?: string[], capture?: boolean, layout?: LayoutMode, spotlightId?: string | null, maxVideos?: number, frame?: number, offsets?: Record<string, Offset | number> }} [opts]
   * @returns {WorkspaceState}
   */
  function createWorkspaceState(opts = {}) {
    const maxVideos = Math.max(2, Math.min(TILE_KEYS.length, Math.floor(opts.maxVideos || DEFAULT_MAX_VIDEOS)));
    const first = createTab({
      id: 1,
      tiles: opts.tiles && opts.tiles.length ? opts.tiles : ['clip-0'],
      capture: !!opts.capture,
      layout: opts.layout || 'grid',
      spotlightId: opts.spotlightId ?? null,
      maxVideos,
      frame: opts.frame ?? 48,
      offsets: opts.offsets,
    });
    return { tabs: [first], activeTabId: first.id, nextTabId: 2, maxVideos };
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} [tabId]
   * @returns {TabState}
   */
  function getTab(ws, tabId) {
    const id = tabId !== undefined ? tabId : ws.activeTabId;
    return ws.tabs.find((t) => t.id === id) || ws.tabs[0];
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} tabId
   * @param {(t: TabState) => TabState} fn
   * @returns {WorkspaceState}
   */
  function updateTab(ws, tabId, fn) {
    return { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? reconcile(fn(t)) : t)) };
  }

  /**
   * A layout name or one of Compare's aliases ('wipe' = Split, 'side' = Grid); null when unknown.
   * @param {unknown} mode
   * @returns {LayoutMode | null}
   */
  function normalizeLayout(mode) {
    return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(LAYOUT_ALIASES, mode)
      ? LAYOUT_ALIASES[mode]
      : null;
  }

  /**
   * Toggle capture ("open new videos in this compare view") on a tab.
   * Only one tab captures at a time.
   * @param {WorkspaceState} ws
   * @param {number} [tabId]
   * @returns {{ state: WorkspaceState, toast: string }}
   */
  function toggleCapture(ws, tabId) {
    const target = getTab(ws, tabId);
    const nextOn = !target.capture;
    const tabs = ws.tabs.map((t) => ({ ...t, capture: t.id === target.id ? nextOn : false }));
    const toast = nextOn
      ? (target.tiles.length === 1
        ? 'Compare ready — open another video to add it'
        : 'New videos will open in this compare view')
      : 'Paused — new videos open in their own tab';
    return { state: { ...ws, tabs }, toast };
  }

  /**
   * Open a video (e.g. Explorer click). If any tab is capturing, the video joins that tab.
   * Otherwise it opens in the active single-video tab or creates a new tab.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {{ forceNewTab?: boolean, label?: string }} [opts]
   * @returns {{ state: WorkspaceState, action: 'added' | 'duplicate' | 'full' | 'switched' | 'replaced' | 'opened', toast: string }}
   */
  function openVideo(ws, clipId, opts = {}) {
    const label = opts.label || clipId;
    const active = getTab(ws);
    // Capture pauses automatically while another editor/tab is active: only an active capturing tab catches opens.
    const capTab = !opts.forceNewTab && active.capture ? active : null;
    if (capTab) {
      if (capTab.tiles.includes(clipId)) {
        return {
          state: { ...ws, activeTabId: capTab.id },
          action: 'duplicate',
          toast: `${label} is already in this view`,
        };
      }
      if (capTab.tiles.length >= capTab.maxVideos) {
        return {
          state: { ...ws, activeTabId: capTab.id },
          action: 'full',
          toast: `Maximum ${capTab.maxVideos} videos reached`,
        };
      }
      const nextTiles = [...capTab.tiles, clipId];
      const state = updateTab({ ...ws, activeTabId: capTab.id }, capTab.id, (t) => ({ ...t, tiles: nextTiles }));
      return { state, action: 'added', toast: `Added ${label} (${nextTiles.length} videos)` };
    }

    const existingSingle = ws.tabs.find((t) => t.tiles.length === 1 && t.tiles[0] === clipId);
    if (existingSingle && !opts.forceNewTab) {
      return { state: { ...ws, activeTabId: existingSingle.id }, action: 'switched', toast: '' };
    }

    if (!opts.forceNewTab && active.tiles.length === 1) {
      const state = updateTab(ws, active.id, (t) => ({ ...t, tiles: [clipId], offsets: {} }));
      return { state, action: 'replaced', toast: '' };
    }

    const created = createTab({
      id: ws.nextTabId,
      tiles: [clipId],
      capture: false,
      maxVideos: ws.maxVideos,
      frame: active.frame,
    });
    return {
      state: { ...ws, tabs: [...ws.tabs, created], activeTabId: created.id, nextTabId: ws.nextTabId + 1 },
      action: 'opened',
      toast: `Opened ${label} in new tab`,
    };
  }

  /**
   * Replace the video of a single-video tab in place (folder ‹ / › and the rail's click in a single view).
   * Unlike `openVideo` it never joins a capturing tab: the user navigated *this* tab, not "open another".
   * Multi-video tabs are left unchanged (navigation there is the host's call; see `replaceTile`).
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function replaceVideo(ws, clipId, tabId) {
    const target = getTab(ws, tabId);
    if (target.tiles.length !== 1 || target.tiles[0] === clipId) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, tiles: [clipId], offsets: {}, frame: 0, playing: false }));
  }

  /**
   * Replace one tile's video in a compare view, keeping its slot. The new video starts in step (offset 0), and the
   * Spotlight, clock and sound follow the slot when they were on the replaced video.
   * @param {WorkspaceState} ws
   * @param {string} oldId
   * @param {string} newId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function replaceTile(ws, oldId, newId, tabId) {
    const target = getTab(ws, tabId);
    if (typeof newId !== 'string' || !newId || oldId === newId) return ws;
    const idx = target.tiles.indexOf(oldId);
    if (idx < 0 || target.tiles.includes(newId)) return ws;
    const swapId = (/** @type {string | null} */ id) => (id === oldId ? newId : id);
    return updateTab(ws, target.id, (t) => {
      const tiles = t.tiles.slice();
      tiles[idx] = newId;
      const offsets = { ...t.offsets };
      delete offsets[oldId];
      offsets[newId] = { unit: 'frames', v: 0 };
      return {
        ...t,
        tiles,
        offsets,
        spotlightId: swapId(t.spotlightId),
        clockId: swapId(t.clockId),
        soundId: swapId(t.soundId),
        statsOpen: t.statsOpen.filter((id) => id !== oldId),
        removeConfirmId: t.removeConfirmId === oldId ? null : t.removeConfirmId,
      };
    });
  }

  /**
   * Remove a tile from a tab. Dropping to 1 video seamlessly restores single-player state.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} [tabId]
   * @returns {{ state: WorkspaceState, toast: string }}
   */
  function removeTile(ws, clipId, tabId) {
    const target = getTab(ws, tabId);
    if (target.tiles.length <= 1 || !target.tiles.includes(clipId)) {
      return { state: ws, toast: '' };
    }
    const nextTiles = target.tiles.filter((id) => id !== clipId);
    /** @type {LayoutMode} */
    let nextLayout = target.layout;
    let nextSpot = target.spotlightId;
    if (nextSpot === clipId) {
      // Removing the enlarged tile collapses Spotlight (the user did not pick a new main tile).
      nextLayout = 'grid';
      nextSpot = null;
    }
    const state = updateTab(ws, target.id, (t) => ({
      ...t,
      tiles: nextTiles,
      layout: nextLayout,
      spotlightId: nextSpot,
      removeConfirmId: null,
    }));
    return { state, toast: nextTiles.length === 1 ? 'Back to single video' : '' };
  }

  /**
   * Leave Compare: keep one video as the single player. Defaults to the clock tile (what the seek bar shows).
   * @param {WorkspaceState} ws
   * @param {string} [keepId]
   * @param {number} [tabId]
   * @returns {{ state: WorkspaceState, toast: string }}
   */
  function leaveCompare(ws, keepId, tabId) {
    const target = getTab(ws, tabId);
    if (target.tiles.length < 2) return { state: ws, toast: '' };
    const keep = keepId !== undefined && target.tiles.includes(keepId)
      ? keepId
      : (target.clockId || target.tiles[0]);
    const state = updateTab(ws, target.id, (t) => ({
      ...t,
      tiles: [keep],
      layout: 'grid',
      spotlightId: null,
      // A single player has nothing to be offset against.
      offsets: {},
      clockId: keep,
      soundId: keep,
      statsOpen: [],
      removeConfirmId: null,
      syncMode: false,
    }));
    return { state, toast: 'Back to single video' };
  }

  /**
   * Move a tile to another slot (drag onto another tile, or the ‹ / › move arrows). Offsets, the Spotlight tile and
   * the Split sides follow the clip, not the slot, so only the order changes.
   * @param {WorkspaceState} ws
   * @param {number} from slot index
   * @param {number} to slot index
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function moveTile(ws, from, to, tabId) {
    const target = getTab(ws, tabId);
    const n = target.tiles.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n || to < 0 || to >= n || from === to) return ws;
    const tiles = target.tiles.slice();
    const [moved] = tiles.splice(from, 1);
    tiles.splice(to, 0, moved);
    return updateTab(ws, target.id, (t) => ({ ...t, tiles }));
  }

  /**
   * Swap the two sides (Compare's Swap A ⇄ B): only with exactly 2 videos.
   * @param {WorkspaceState} ws
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function swapSides(ws, tabId) {
    const target = getTab(ws, tabId);
    if (target.tiles.length !== 2) return ws;
    return moveTile(ws, 0, 1, target.id);
  }

  /**
   * Camera-app enlarge/collapse gesture on a tile:
   * - In Grid (or Split): enlarges `clipId` into Spotlight.
   * - In Spotlight on the currently enlarged tile: collapses back to Grid.
   * - In Spotlight on a strip tile: promotes that tile to the Spotlight main slot.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function toggleEnlarge(ws, clipId, tabId) {
    const target = getTab(ws, tabId);
    if (target.tiles.length < 2 || !target.tiles.includes(clipId)) return ws;
    if (target.layout === 'spotlight' && target.spotlightId === clipId) {
      return updateTab(ws, target.id, (t) => ({ ...t, layout: 'grid', spotlightId: null, removeConfirmId: null }));
    }
    return updateTab(ws, target.id, (t) => ({
      ...t,
      layout: 'spotlight',
      spotlightId: clipId,
      removeConfirmId: t.layout === 'spotlight' ? t.removeConfirmId : null,
    }));
  }

  /**
   * Toggle Split Wipe (only valid for 2 videos).
   * @param {WorkspaceState} ws
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function toggleSplit(ws, tabId) {
    const target = getTab(ws, tabId);
    if (target.tiles.length !== 2) return ws;
    const next = target.layout === 'split' ? 'grid' : 'split';
    return updateTab(ws, target.id, (t) => ({ ...t, layout: next, spotlightId: null, removeConfirmId: null }));
  }

  /**
   * Pick a layout by name ('grid' | 'spotlight' | 'split', or Compare's aliases 'side' = Grid, 'wipe' = Split).
   * Split needs exactly 2 videos and Spotlight at least 2; Spotlight enlarges the remembered tile, else the clock tile.
   * Unknown names, an invalid layout for N and the current layout are no-ops.
   * @param {WorkspaceState} ws
   * @param {string} mode
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setLayout(ws, mode, tabId) {
    const target = getTab(ws, tabId);
    const layout = normalizeLayout(mode);
    const n = target.tiles.length;
    if (!layout || layout === target.layout) return ws;
    if (layout === 'split' && n !== 2) return ws;
    if (layout === 'spotlight' && n < 2) return ws;
    return updateTab(ws, target.id, (t) => ({
      ...t,
      layout,
      spotlightId: layout === 'spotlight' ? (t.spotlightId || t.clockId || t.tiles[0]) : null,
      removeConfirmId: null,
    }));
  }

  /**
   * Which stage edge the Spotlight main tile sits on (the strip takes the opposite side). Invalid edges are a no-op.
   * @param {WorkspaceState} ws
   * @param {string} edge
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setDock(ws, edge, tabId) {
    const target = getTab(ws, tabId);
    if (!DOCKS.includes(/** @type {any} */ (edge)) || target.dock === edge) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, dock: /** @type {DockSide} */ (edge) }));
  }

  /**
   * The clock tile: the seek bar, frame counter and stepping follow its frames. Only a tile of this tab.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setClock(ws, clipId, tabId) {
    const target = getTab(ws, tabId);
    if (!target.tiles.includes(clipId) || target.clockId === clipId) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, clockId: clipId }));
  }

  /**
   * The sound tile: heard alone, the others muted. Only a tile of this tab.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setSound(ws, clipId, tabId) {
    const target = getTab(ws, tabId);
    if (!target.tiles.includes(clipId) || target.soundId === clipId) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, soundId: clipId }));
  }

  /**
   * A tile's offset (zero frames when it has none).
   * @param {TabState} tab
   * @param {string} clipId
   * @returns {Offset}
   */
  function getOffset(tab, clipId) {
    return toOffset(tab.offsets[clipId]);
  }

  /**
   * Set a tile's offset value in its current unit (frames rounded to whole frames, ms to 1/1000 ms).
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} v
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setOffset(ws, clipId, v, tabId) {
    const target = getTab(ws, tabId);
    if (!target.tiles.includes(clipId) || !Number.isFinite(v)) return ws;
    const o = getOffset(target, clipId);
    const next = { unit: o.unit, v: roundFor(o.unit, v) };
    if (next.v === o.v) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, offsets: { ...t.offsets, [clipId]: next } }));
  }

  /**
   * One nudge (or `dir` nudges) of a tile's offset: a frame of that video, or 10 ms (media/compare.js `nudge`).
   * `fps` is not needed for a nudge (the step stays in the tile's own unit); it is accepted so callers can pass the
   * same arguments as `setOffsetUnit`.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} dir
   * @param {number} [fps]
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function nudgeOffset(ws, clipId, dir, fps, tabId) {
    void fps;
    const target = getTab(ws, tabId);
    if (!target.tiles.includes(clipId) || !Number.isFinite(dir)) return ws;
    const o = getOffset(target, clipId);
    return setOffset(ws, clipId, o.v + dir * (o.unit === 'ms' ? MS_STEP : 1), target.id);
  }

  /**
   * Put a tile back in step (offset 0, its unit kept).
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function resetOffset(ws, clipId, tabId) {
    return setOffset(ws, clipId, 0, tabId);
  }

  /**
   * Show a tile's offset in frames or in ms, keeping the moment it stands for (media/compare.js `setUnit`):
   * ms stays fractional (1/1000 ms), so frames → ms → frames is lossless at 23.976 / 29.97.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {OffsetUnit} unit
   * @param {number} [fps] that tile's frame rate (default: the tab's)
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setOffsetUnit(ws, clipId, unit, fps, tabId) {
    const target = getTab(ws, tabId);
    if (!target.tiles.includes(clipId) || (unit !== 'ms' && unit !== 'frames')) return ws;
    const o = getOffset(target, clipId);
    if (o.unit === unit) return ws;
    const rate = Number(fps) > 0 ? Number(fps) : target.fps;
    const v = unit === 'ms' ? (o.v / rate) * 1000 : (o.v / 1000) * rate;
    const next = { unit, v: roundFor(unit, v) };
    return updateTab(ws, target.id, (t) => ({ ...t, offsets: { ...t.offsets, [clipId]: next } }));
  }

  /**
   * Open or close a tile's ⓘ details card.
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function toggleTileStats(ws, clipId, tabId) {
    const target = getTab(ws, tabId);
    if (!target.tiles.includes(clipId)) return ws;
    return updateTab(ws, target.id, (t) => ({
      ...t,
      statsOpen: t.statsOpen.includes(clipId) ? t.statsOpen.filter((id) => id !== clipId) : [...t.statsOpen, clipId],
    }));
  }

  /**
   * Arm (clipId) or disarm (null) a tile's inline "Remove?" confirmation; one at a time.
   * @param {WorkspaceState} ws
   * @param {string | null} clipId
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setRemoveConfirm(ws, clipId, tabId) {
    const target = getTab(ws, tabId);
    const next = clipId !== null && target.tiles.includes(clipId) ? clipId : null;
    if (next === target.removeConfirmId) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, removeConfirmId: next }));
  }

  /**
   * Picture size mode; a new mode starts at its own size, centred (media/picture.js `fresh`).
   * @param {WorkspaceState} ws
   * @param {string} mode
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setPicMode(ws, mode, tabId) {
    const target = getTab(ws, tabId);
    if (!PIC_MODES.includes(/** @type {any} */ (mode))) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, picMode: /** @type {PicMode} */ (mode), zoom: 1, panX: 0, panY: 0 }));
  }

  /**
   * Zoom every tile (clamped to 1/16-64; the engine applies the per-mode limits), optionally with a new pan.
   * @param {WorkspaceState} ws
   * @param {number} zoom
   * @param {number} [panX]
   * @param {number} [panY]
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function setZoom(ws, zoom, panX, panY, tabId) {
    const target = getTab(ws, tabId);
    if (!Number.isFinite(zoom)) return ws;
    return updateTab(ws, target.id, (t) => ({
      ...t,
      zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX),
      panX: panX !== undefined && Number.isFinite(panX) ? panX : t.panX,
      panY: panY !== undefined && Number.isFinite(panY) ? panY : t.panY,
    }));
  }

  /**
   * Pan the picture by a CSS px delta.
   * @param {WorkspaceState} ws
   * @param {number} dx
   * @param {number} dy
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function panBy(ws, dx, dy, tabId) {
    const target = getTab(ws, tabId);
    const ddx = Number.isFinite(dx) ? dx : 0;
    const ddy = Number.isFinite(dy) ? dy : 0;
    if (!ddx && !ddy) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, panX: t.panX + ddx, panY: t.panY + ddy }));
  }

  /**
   * Back to the mode's own size, centred (the mode is kept).
   * @param {WorkspaceState} ws
   * @param {number} [tabId]
   * @returns {WorkspaceState}
   */
  function resetView(ws, tabId) {
    const target = getTab(ws, tabId);
    return updateTab(ws, target.id, (t) => ({ ...t, zoom: 1, panX: 0, panY: 0 }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} ratio
   * @param {number} [tabId]
   */
  function setHeroRatio(ws, ratio, tabId) {
    const target = getTab(ws, tabId);
    return updateTab(ws, target.id, (t) => ({ ...t, heroRatio: clamp(ratio, 0.10, 0.90) }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} ratio
   * @param {number} [tabId]
   */
  function setSplitRatio(ws, ratio, tabId) {
    const target = getTab(ws, tabId);
    return updateTab(ws, target.id, (t) => ({ ...t, split: clamp(ratio, 0, 1) }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} [tabId]
   */
  function toggleSyncMode(ws, tabId) {
    const target = getTab(ws, tabId);
    if (target.tiles.length < 2) return ws;
    return updateTab(ws, target.id, (t) => ({ ...t, syncMode: !t.syncMode }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} [tabId]
   */
  function togglePlay(ws, tabId) {
    const target = getTab(ws, tabId);
    return updateTab(ws, target.id, (t) => ({ ...t, playing: !t.playing }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} delta
   * @param {number} [tabId]
   */
  function stepFrame(ws, delta, tabId) {
    const target = getTab(ws, tabId);
    const next = clamp(target.frame + Math.trunc(delta), 0, target.maxFrame);
    return updateTab(ws, target.id, (t) => ({ ...t, playing: false, frame: next }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} frame
   * @param {number} [tabId]
   */
  function seekFrame(ws, frame, tabId) {
    const target = getTab(ws, tabId);
    return updateTab(ws, target.id, (t) => ({ ...t, frame: clamp(Math.round(frame), 0, t.maxFrame) }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} tabId
   */
  function selectTab(ws, tabId) {
    if (!ws.tabs.some((t) => t.id === tabId)) return ws;
    return { ...ws, activeTabId: tabId };
  }

  /**
   * @param {WorkspaceState} ws
   * @param {number} tabId
   */
  function closeTab(ws, tabId) {
    if (ws.tabs.length <= 1) return ws;
    const tabs = ws.tabs.filter((t) => t.id !== tabId);
    const activeTabId = ws.activeTabId === tabId ? tabs[0].id : ws.activeTabId;
    return { ...ws, tabs, activeTabId };
  }

  /**
   * Spotlight cells and splitter in whole stage pixels, the same geometry as media/compare-grid.js spotlightLayout:
   * the main tile on `tab.dock`, a GAP px band, then the strip of the other tiles (in slot order) split by GAP px.
   * @param {TabState} tab
   * @param {string} heroId
   * @param {number} W
   * @param {number} H
   * @param {number} minSize smallest cell side (1 with a stage, 0 without one)
   * @returns {{ cells: CellRect[], splitter: SplitterRect }}
   */
  function spotlightCells(tab, heroId, W, H, minSize) {
    const heroIdx = tab.tiles.indexOf(heroId);
    const others = tab.tiles.map((id, index) => ({ id, index })).filter((o) => o.id !== heroId);
    const subN = Math.max(1, others.length);
    const dock = tab.dock;
    const ratio = tab.heroRatio;
    const horizontal = dock === 'top' || dock === 'bottom';
    const along = horizontal ? H : W; // the axis the main tile and the strip share
    const across = horizontal ? W : H; // the axis the strip tiles are laid along
    const gap = along > GAP ? GAP : 0;
    const heroLen = Math.round(Math.max(0, along - gap) * ratio);
    const stripLen = Math.max(0, along - gap - heroLen);
    const heroFirst = dock === 'top' || dock === 'left';
    const heroPos = heroFirst ? 0 : stripLen + gap;
    const stripPos = heroFirst ? heroLen + gap : 0;
    const splitPos = heroFirst ? heroLen : stripLen;
    const sgap = across > GAP * (subN - 1) ? GAP : 0;
    const sub = Math.max(0, across - sgap * (subN - 1)) / subN;
    /**
     * @param {number} a position along the shared axis
     * @param {number} b position along the strip axis
     * @param {number} la
     * @param {number} lb
     */
    const rect = (a, b, la, lb) => (horizontal
      ? { x: b, y: a, w: Math.max(minSize, lb), h: Math.max(minSize, la) }
      : { x: a, y: b, w: Math.max(minSize, la), h: Math.max(minSize, lb) });
    /** @type {CellRect[]} */
    const cells = [{
      clipId: heroId, index: heroIdx, letter: TILE_KEYS[heroIdx], ...rect(heroPos, 0, heroLen, across), role: 'hero',
    }];
    others.forEach((o, k) => {
      const b0 = Math.round(k * (sub + sgap));
      const b1 = Math.round(k * (sub + sgap) + sub);
      cells.push({
        clipId: o.id, index: o.index, letter: TILE_KEYS[o.index], ...rect(stripPos, b0, stripLen, b1 - b0), role: 'strip',
      });
    });
    const band = horizontal ? { x: 0, y: splitPos, w: W, h: gap } : { x: splitPos, y: 0, w: gap, h: H };
    return { cells, splitter: { orientation: horizontal ? 'horizontal' : 'vertical', ...band, dock, ratio } };
  }

  /**
   * Pure UI derivation from tab state + stage dimensions.
   * Guarantees N === 1 is always full-width (no empty black half), single-player controls react
   * seamlessly to N, and Spotlight / Split / Grid cell rectangles stay consistent everywhere.
   * Without a stage the flags, labels and cell order are the same and every rectangle is 0 × 0.
   * @param {TabState} tab
   * @param {{ width: number, height: number }} [stage]
   * @returns {DerivedUi}
   */
  function deriveUi(tab, stage) {
    const hasStage = !!stage;
    const minSize = hasStage ? 1 : 0;
    const W = stage ? Math.max(1, Math.round(stage.width)) : 0;
    const H = stage ? Math.max(1, Math.round(stage.height)) : 0;
    const n = tab.tiles.length;
    const isMulti = n >= 2;
    /** @type {LayoutMode} */
    const effectiveLayout = !isMulti
      ? 'grid'
      : (tab.layout === 'split' && n === 2) ? 'split'
        : tab.layout === 'spotlight' ? 'spotlight' : 'grid';

    /** @type {CellRect[]} */
    let cells = [];
    /** @type {{ x: number, y: number, w: number, h: number } | null} */
    let addSlot = null;
    /** @type {SplitterRect | null} */
    let splitter = null;

    if (n === 1) {
      cells.push({ clipId: tab.tiles[0], index: 0, letter: TILE_KEYS[0], x: 0, y: 0, w: W, h: H, role: 'single' });
    } else if (effectiveLayout === 'split') {
      cells.push({ clipId: tab.tiles[0], index: 0, letter: TILE_KEYS[0], x: 0, y: 0, w: W, h: H, role: 'split-a' });
      cells.push({ clipId: tab.tiles[1], index: 1, letter: TILE_KEYS[1], x: 0, y: 0, w: W, h: H, role: 'split-b' });
    } else if (effectiveLayout === 'spotlight') {
      const heroId = tab.spotlightId && tab.tiles.includes(tab.spotlightId) ? tab.spotlightId : tab.tiles[0];
      ({ cells, splitter } = spotlightCells(tab, heroId, W, H, minSize));
    } else {
      const { cols, rows } = gridDimensions(n);
      const cw = W / cols;
      const ch = H / rows;
      /**
       * @param {number} c
       * @param {number} r
       */
      const slot = (c, r) => {
        const x = Math.round(c * cw);
        const y = Math.round(r * ch);
        const x2 = Math.round((c + 1) * cw);
        const y2 = Math.round((r + 1) * ch);
        return { x, y, w: Math.max(minSize, x2 - x), h: Math.max(minSize, y2 - y) };
      };
      tab.tiles.forEach((clipId, i) => {
        cells.push({ clipId, index: i, letter: TILE_KEYS[i], ...slot(i % cols, Math.floor(i / cols)), role: 'grid' });
      });
      if (isMulti && n < tab.maxVideos && n < cols * rows) addSlot = slot(n % cols, Math.floor(n / cols));
    }

    const captureLabel = tab.capture
      ? 'Adding videos'
      : (isMulti ? 'Add videos' : 'Compare');
    const captureTitle = tab.capture
      ? 'Open videos to add to comparison (click to stop)'
      : (isMulti ? 'Click to add newly opened videos to this comparison' : 'Start Compare — open videos to add to comparison');
    const { cols, rows } = gridDimensions(n);
    const layoutLabel = !isMulti
      ? 'Full-width (1×1)'
      : effectiveLayout === 'spotlight'
        ? 'Spotlight'
        : effectiveLayout === 'split'
          ? 'Split Wipe'
          : `Grid (${cols}×${rows})`;

    return {
      n,
      isMulti,
      effectiveLayout,
      showCC: !isMulti,
      showFolderCapsule: !isMulti,
      showSplitBtn: n === 2,
      showSyncBtn: isMulti,
      showCaptureBanner: tab.capture && !isMulti,
      captureLabel,
      captureTitle,
      layoutLabel,
      showSplitter: effectiveLayout === 'spotlight',
      showDivider: effectiveLayout === 'split',
      cells,
      addSlot,
      splitter,
    };
  }

  /**
   * Every invariant a tab must hold after any action; returns the broken ones (empty = valid). Used by the
   * randomized action-sequence test and handy as a debug assertion.
   * @param {TabState} t
   * @returns {string[]}
   */
  function tabInvariantErrors(t) {
    /** @type {string[]} */
    const errs = [];
    const n = t.tiles.length;
    const has = (/** @type {string | null} */ id) => id !== null && t.tiles.includes(id);
    if (new Set(t.tiles).size !== n) errs.push('duplicate tiles');
    if (n > t.maxVideos) errs.push('more tiles than maxVideos');
    if (n >= 1 && !has(t.clockId)) errs.push('clockId not a tile');
    if (n >= 1 && !has(t.soundId)) errs.push('soundId not a tile');
    if (n === 0 && (t.clockId !== null || t.soundId !== null)) errs.push('clock/sound set without tiles');
    if (t.layout === 'spotlight' ? !has(t.spotlightId) : t.spotlightId !== null) errs.push('spotlightId vs layout');
    if (n < 2 && t.layout !== 'grid') errs.push('single tile not in grid');
    if (t.layout === 'split' && n !== 2) errs.push('split without 2 tiles');
    if (n < 2 && t.syncMode) errs.push('syncMode with a single tile');
    if (!DOCKS.includes(t.dock)) errs.push('bad dock');
    if (!(t.heroRatio >= 0.1 && t.heroRatio <= 0.9)) errs.push('heroRatio out of range');
    const keys = Object.keys(t.offsets);
    if (keys.length !== n || !keys.every((k) => t.tiles.includes(k))) errs.push('offsets keys != tiles');
    for (const k of keys) {
      const o = t.offsets[k];
      if (!o || (o.unit !== 'frames' && o.unit !== 'ms') || !Number.isFinite(o.v)) errs.push(`bad offset ${k}`);
      else if (o.unit === 'frames' && !Number.isInteger(o.v)) errs.push(`fractional frame offset ${k}`);
    }
    if (!t.statsOpen.every((id) => t.tiles.includes(id)) || new Set(t.statsOpen).size !== t.statsOpen.length) {
      errs.push('statsOpen not a set of tiles');
    }
    if (t.removeConfirmId !== null && !has(t.removeConfirmId)) errs.push('removeConfirmId not a tile');
    if (!PIC_MODES.includes(t.picMode)) errs.push('bad picMode');
    if (!(t.zoom >= ZOOM_MIN && t.zoom <= ZOOM_MAX)) errs.push('zoom out of range');
    if (!Number.isFinite(t.panX) || !Number.isFinite(t.panY)) errs.push('pan not finite');
    return errs;
  }

  const api = {
    TILE_KEYS,
    DOCKS,
    PIC_MODES,
    DEFAULT_MAX_VIDEOS,
    HERO_DEFAULT,
    GAP,
    ZOOM_MIN,
    ZOOM_MAX,
    gridDimensions,
    normalizeLayout,
    toOffset,
    formatOffset,
    createTab,
    createWorkspaceState,
    getTab,
    getOffset,
    toggleCapture,
    openVideo,
    replaceVideo,
    replaceTile,
    removeTile,
    leaveCompare,
    moveTile,
    swapSides,
    toggleEnlarge,
    toggleSplit,
    setLayout,
    setDock,
    setClock,
    setSound,
    setOffset,
    nudgeOffset,
    resetOffset,
    setOffsetUnit,
    toggleTileStats,
    setRemoveConfirm,
    setPicMode,
    setZoom,
    panBy,
    resetView,
    setHeroRatio,
    setSplitRatio,
    toggleSyncMode,
    togglePlay,
    stepFrame,
    seekFrame,
    selectTab,
    closeTab,
    deriveUi,
    tabInvariantErrors,
  };
  // checkJs: end

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (globalThis).VpePlayerState = api;
})();
