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
   * @property {Record<string, number>} offsets per-clip frame offsets
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
   */

  const TILE_KEYS = 'ABCDEFGHIJKLMNOP';
  const DOCKS = /** @type {const} */ (['top', 'bottom', 'left', 'right']);
  const DEFAULT_MAX_VIDEOS = 8;

  /**
   * @param {number} v
   * @param {number} lo
   * @param {number} hi
   */
  const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);

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
   * @param {Partial<TabState> & { id: number, tiles: string[] }} init
   * @returns {TabState}
   */
  function createTab(init) {
    const tiles = Array.from(new Set(init.tiles || []));
    const maxVideos = Math.max(2, Math.min(TILE_KEYS.length, Math.floor(init.maxVideos || DEFAULT_MAX_VIDEOS)));
    /** @type {LayoutMode} */
    let layout = init.layout === 'spotlight' || init.layout === 'split' ? init.layout : 'grid';
    if (tiles.length < 2) layout = 'grid';
    if (layout === 'split' && tiles.length !== 2) layout = 'grid';
    const spotlightId = layout === 'spotlight'
      ? (init.spotlightId && tiles.includes(init.spotlightId) ? init.spotlightId : tiles[0] || null)
      : null;
    /** @type {DockSide} */
    const dock = DOCKS.includes(/** @type {any} */ (init.dock)) ? /** @type {DockSide} */ (init.dock) : 'top';
    return {
      id: init.id,
      tiles,
      capture: !!init.capture,
      layout,
      spotlightId,
      dock,
      heroRatio: clamp(init.heroRatio ?? 0.70, 0.10, 0.90),
      split: clamp(init.split ?? 0.5, 0, 1),
      offsets: { ...(init.offsets || {}) },
      syncMode: tiles.length >= 2 && !!init.syncMode,
      playing: !!init.playing,
      frame: Math.max(0, Math.floor(init.frame ?? 48)),
      maxFrame: Math.max(1, Math.floor(init.maxFrame ?? 240)),
      fps: Math.max(1, Number(init.fps) || 24),
      muted: init.muted !== undefined ? !!init.muted : true,
      maxVideos,
    };
  }

  /**
   * @param {{ tiles?: string[], capture?: boolean, layout?: LayoutMode, spotlightId?: string | null, maxVideos?: number, frame?: number }} [opts]
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
    return { ...ws, tabs: ws.tabs.map((t) => (t.id === tabId ? fn(t) : t)) };
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
      const nextLayout = nextTiles.length > 2 && capTab.layout === 'split' ? 'grid' : capTab.layout;
      const state = updateTab({ ...ws, activeTabId: capTab.id }, capTab.id, (t) => ({
        ...t,
        tiles: nextTiles,
        layout: nextLayout,
      }));
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
   * Multi-video tabs are left unchanged (navigation there is the host's call).
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
    if (nextTiles.length === 1) {
      nextLayout = 'grid';
      nextSpot = null;
    } else {
      if (nextSpot === clipId) {
        nextLayout = 'grid';
        nextSpot = null;
      }
      if (nextLayout === 'split' && nextTiles.length !== 2) {
        nextLayout = 'grid';
      }
    }
    const nextOffsets = { ...target.offsets };
    delete nextOffsets[clipId];
    const state = updateTab(ws, target.id, (t) => ({
      ...t,
      tiles: nextTiles,
      layout: nextLayout,
      spotlightId: nextSpot,
      offsets: nextOffsets,
      syncMode: nextTiles.length >= 2 ? t.syncMode : false,
    }));
    return { state, toast: nextTiles.length === 1 ? 'Back to single video' : '' };
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
      return updateTab(ws, target.id, (t) => ({ ...t, layout: 'grid', spotlightId: null }));
    }
    return updateTab(ws, target.id, (t) => ({ ...t, layout: 'spotlight', spotlightId: clipId }));
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
    return updateTab(ws, target.id, (t) => ({ ...t, layout: next, spotlightId: null }));
  }

  /**
   * @param {WorkspaceState} ws
   * @param {string} clipId
   * @param {number} delta
   * @param {number} [tabId]
   */
  function nudgeOffset(ws, clipId, delta, tabId) {
    const target = getTab(ws, tabId);
    if (!target.tiles.includes(clipId)) return ws;
    return updateTab(ws, target.id, (t) => ({
      ...t,
      offsets: { ...t.offsets, [clipId]: (t.offsets[clipId] || 0) + Math.trunc(delta) },
    }));
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
   * Pure UI derivation from tab state + stage dimensions.
   * Guarantees N === 1 is always full-width (no empty black half), single-player controls react
   * seamlessly to N, and Spotlight / Split / Grid cell rectangles stay consistent everywhere.
   * @param {TabState} tab
   * @param {{ width: number, height: number }} stage
   * @returns {DerivedUi}
   */
  function deriveUi(tab, { width, height }) {
    const W = Math.max(1, Math.round(width));
    const H = Math.max(1, Math.round(height));
    const n = tab.tiles.length;
    const isMulti = n >= 2;
    /** @type {LayoutMode} */
    const effectiveLayout = !isMulti
      ? 'grid'
      : (tab.layout === 'split' && n === 2) ? 'split'
        : tab.layout === 'spotlight' ? 'spotlight' : 'grid';

    /** @type {CellRect[]} */
    const cells = [];
    /** @type {{ x: number, y: number, w: number, h: number } | null} */
    let addSlot = null;

    if (n === 1) {
      cells.push({ clipId: tab.tiles[0], index: 0, letter: TILE_KEYS[0], x: 0, y: 0, w: W, h: H, role: 'single' });
    } else if (effectiveLayout === 'split') {
      cells.push({ clipId: tab.tiles[0], index: 0, letter: TILE_KEYS[0], x: 0, y: 0, w: W, h: H, role: 'split-a' });
      cells.push({ clipId: tab.tiles[1], index: 1, letter: TILE_KEYS[1], x: 0, y: 0, w: W, h: H, role: 'split-b' });
    } else if (effectiveLayout === 'spotlight') {
      const heroId = tab.spotlightId && tab.tiles.includes(tab.spotlightId) ? tab.spotlightId : tab.tiles[0];
      const heroIdx = tab.tiles.indexOf(heroId);
      const others = tab.tiles.map((id, index) => ({ id, index })).filter((o) => o.id !== heroId);
      const heroH = Math.round(H * tab.heroRatio);
      const stripH = Math.max(1, H - heroH);
      cells.push({ clipId: heroId, index: heroIdx, letter: TILE_KEYS[heroIdx], x: 0, y: 0, w: W, h: heroH, role: 'hero' });
      const sw = W / Math.max(1, others.length);
      others.forEach((o, i) => {
        const x = Math.round(i * sw);
        const x2 = Math.round((i + 1) * sw);
        cells.push({
          clipId: o.id, index: o.index, letter: TILE_KEYS[o.index],
          x, y: heroH, w: Math.max(1, x2 - x), h: stripH, role: 'strip',
        });
      });
    } else {
      const { cols, rows } = gridDimensions(n);
      const cw = W / cols;
      const ch = H / rows;
      tab.tiles.forEach((clipId, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const x = Math.round(c * cw);
        const y = Math.round(r * ch);
        const x2 = Math.round((c + 1) * cw);
        const y2 = Math.round((r + 1) * ch);
        cells.push({
          clipId, index: i, letter: TILE_KEYS[i],
          x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y), role: 'grid',
        });
      });
      if (isMulti && n < tab.maxVideos && n < cols * rows) {
        const c = n % cols;
        const r = Math.floor(n / cols);
        const x = Math.round(c * cw);
        const y = Math.round(r * ch);
        const x2 = Math.round((c + 1) * cw);
        const y2 = Math.round((r + 1) * ch);
        addSlot = { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
      }
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
    };
  }

  const api = {
    TILE_KEYS,
    DEFAULT_MAX_VIDEOS,
    gridDimensions,
    createTab,
    createWorkspaceState,
    getTab,
    toggleCapture,
    openVideo,
    replaceVideo,
    removeTile,
    moveTile,
    toggleEnlarge,
    toggleSplit,
    nudgeOffset,
    setHeroRatio,
    setSplitRatio,
    toggleSyncMode,
    togglePlay,
    stepFrame,
    seekFrame,
    selectTab,
    closeTab,
    deriveUi,
  };
  // checkJs: end

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (globalThis).VpePlayerState = api;
})();
