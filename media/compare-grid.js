// @ts-check
// Compare with many videos: the grid and the per-tile budgets, shared by the page (media/compare.js) and
// the host (src/compare.js), small enough for a Node test (test/host/compare_grid_test.js).
// Up to 4 videos everything stays as it was; from 5 on
// the tiles split fixed budgets, so 16 videos use about what 4 did (docs/notes/multiview-engine.md).
'use strict';

(function (root) {
  /** Tile letters: 'A'-'P'. Engine keys are these (the scan's 'sA' / 'sB' end in one). */
  const TILE_KEYS = 'ABCDEFGHIJKLMNOP';
  const MAX_VIDEOS = TILE_KEYS.length;
  const DEFAULT_MAX = 8;
  /** From this many videos on, tiles share one renderer and the large-grid budgets below. */
  const LARGE = 5;

  /** The setting compare.maxVideos as a count: 2-16, 8 when unset or not a number. */
  function clampMax(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(2, Math.min(MAX_VIDEOS, n)) : DEFAULT_MAX;
  }

  const isLarge = (n) => n >= LARGE;

  /**
   * Columns and rows: 2 side by side (split: 1x1), 3-4 the 2x2 grid, more the smallest square-ish
   * grid (5-6: 3x2, 7-9: 3x3, 10-12: 4x3, 13-16: 4x4).
   */
  function gridFor(n, mode) {
    if (mode === 'split') return { cols: 1, rows: 1 };
    if (mode === 'side' || n <= 2) return { cols: 2, rows: 1 };
    if (n <= 4) return { cols: 2, rows: 2 };
    const cols = Math.ceil(Math.sqrt(n));
    return { cols, rows: Math.ceil(n / cols) };
  }

  /** Videos occupy the grid in order, followed by an Add cell if there is room. */
  const gridCellCount = (n, max, cols, rows) => n + Number(n < max && n < cols * rows);

  /** Slot -> video index. Append any videos added since the order was saved; accept the old pair-swap flag. */
  function tileOrder(n, saved, swap = false) {
    const indices = Array.from({ length: n }, (_, i) => i);
    const order = Array.isArray(saved) ? saved : swap && n >= 2 ? [1, 0] : [];
    return [...new Set([...order.filter((i) => Number.isInteger(i) && i >= 0 && i < n), ...indices])];
  }

  /** Move one video to its final slot, shifting the videos in between. */
  function moveTile(order, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || to < 0 || from >= order.length || to >= order.length || from === to) return order;
    const next = order.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    return next;
  }

  /** When the host removes a file, its page's remaining video indices close up too. */
  const orderAfterRemoval = (order, i) => order.filter((j) => j !== i).map((j) => j > i ? j - 1 : j);

  /**
   * Each tile's engine budgets from the machine's (media/membudget.js; null: the 32 GB defaults).
   * frames: decoded pictures one tile keeps; engine: the engine's own mem (undefined: its defaults).
   * Up to 4 tiles: the values compare always had. From 5: every budget divided by the count, no
   * floors, no extra pool workers, and decoded frames share 480 MB (at 32 GB) in all.
   * @param {Record<string, number> | null | undefined} mem
   * @param {number} n tiles
   */
  function tileMemory(mem, n) {
    n = Math.max(1, n);
    const scale = mem && mem.frames > 0 ? Math.min(1, mem.frames / 400e6) : 1;
    const large = isLarge(n);
    const frames = (n <= 2 ? 250e6 : large ? 480e6 / n : 120e6) * scale;
    if (!mem) return { frames, scale, engine: undefined };
    const engine = {
      ...mem, frames: mem.frames / n, pool: mem.pool / n, thumbs: mem.thumbs / n,
      workers: large ? Math.floor(mem.workers / n) : Math.max(1, Math.floor(mem.workers / n)),
      blocks: large ? mem.blocks / n : Math.max(16e6, mem.blocks / n),
    };
    if (large) {
      engine.batch = mem.batch / n;
      engine.freeBufs = mem.freeBufs / n;
    }
    return { frames, scale, engine };
  }

  /**
   * Pixels of one tile's picture texture in a large grid: all tiles together hold one 4K picture
   * (33 MB at 4 bytes per pixel), whatever the sources' sizes. 0: no cap (up to 4 tiles).
   */
  const GRID_PIXELS = 3840 * 2160;
  const texturePixels = (n) => (isLarge(n) ? Math.floor(GRID_PIXELS / n) : 0);

  /** w x h scaled down (aspect kept) to at most `max` pixels; 0 = no cap. */
  function capSize(w, h, max) {
    if (!(max > 0) || w * h <= max) return { w, h };
    const s = Math.sqrt(max / (w * h));
    return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) };
  }

  /**
   * Native frames a tile's page may have in flight: each 'more' grants `batch`, at most `cap` held.
   * A large grid keeps fewer per tile (frames queue in every tile's socket and page).
   */
  const nativeCredits = (large) => (large ? { batch: 2, cap: 4 } : { batch: 8, cap: 16 });

  /** Frames the host queues per native tile before it pauses ffmpeg: the machine's queue shared, one at least. */
  const nativeQueuePerTile = (queue, n) => Math.max(1, Math.floor(queue / Math.max(1, n)));

  /** Retain the last panel signal and sample the document on either event. */
  function compareVisibility(apply) {
    let panelVisible = true;
    return (documentHidden, visible = panelVisible) => {
      panelVisible = visible;
      apply(panelVisible && !documentHidden);
    };
  }

  const api = {
    TILE_KEYS, MAX_VIDEOS, DEFAULT_MAX, LARGE, GRID_PIXELS, clampMax, isLarge, gridFor, gridCellCount,
    tileOrder, moveTile, orderAfterRemoval, tileMemory, texturePixels, capSize, nativeCredits, nativeQueuePerTile,
    compareVisibility,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CompareGrid = api;
}(typeof self !== 'undefined' ? self : this));
