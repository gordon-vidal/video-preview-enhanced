// @ts-check
// Compare with many videos: the grid and the per-tile budgets, shared by the page (media/compare.js) and
// the host (src/compare.js), small enough for a Node test (test/host/compare_grid_test.js).
// Up to 4 videos everything stays as it was; from 5 on
// the tiles split fixed budgets, so 16 videos use about what 4 did (docs/notes/multiview-engine.md).
'use strict';

(() => {
  // checkJs: start
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
    /** @type {Record<string, number>} */
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

  /**
   * A drag in Reorder mode: every preview starts from the order the drag began with, so moving back over the
   * start slot (or off the tiles, `to` -1) restores it; commit keeps the preview, cancel the start order.
   */
  function reorderSession(order, from) {
    let preview = order;
    return {
      get preview() { return preview; },
      over(to) { preview = to < 0 ? order : moveTile(order, from, to); return preview; },
      commit() { return preview; },
      cancel() { preview = order; return order; },
    };
  }

  /** The tile header's remove button: only from 3 videos on (with 2, Remove leaves Compare: src/compare.js `remove`). */
  const canRemoveTile = (n) => n > 2;
  /** `name` is already HTML-escaped; `icon` an SVG string. */
  function removeButtonHtml(n, i, name, icon) {
    if (!canRemoveTile(n)) return '';
    return `<button class="rm" data-act="remove" data-i="${i}" aria-label="Remove ${name} from Compare" title="Remove from Compare">${icon}</button>`;
  }

  /** cubic-bezier(0.2, 0, 0, 1) (the tiles' glide) at progress p of 0-1: x solved by bisection, then y. */
  function easeStandard(p) {
    if (!(p > 0)) return 0;
    if (p >= 1) return 1;
    const bez = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
    let lo = 0, hi = 1, t = p;
    for (let k = 0; k < 24; k++) {
      t = (lo + hi) / 2;
      if (bez(t, 0.2, 0) < p) lo = t; else hi = t;
    }
    return bez(t, 0, 1);
  }

  /**
   * Tiles gliding into new slots (FLIP): `retarget(shown, next, now)` takes where each video is drawn now
   * (its slot plus any glide still running) and where its new slot is, and starts from the difference;
   * `offset(v, now)` eases that to 0 in `duration` ms (a function: read on each retarget, 0 = jump).
   * Positions are {video: {x, y}}; `skip` is a video that follows the pointer instead.
   * @param {number | (() => number)} duration
   */
  function createGlide(duration = 180) {
    /** @type {Map<number, {dx: number, dy: number, t0: number, ms: number}>} */
    const moving = new Map();
    function offset(v, now) {
      const m = moving.get(v);
      if (!m) return { dx: 0, dy: 0 };
      const p = m.ms > 0 ? (now - m.t0) / m.ms : 1;
      if (p >= 1) { moving.delete(v); return { dx: 0, dy: 0 }; }
      const k = 1 - easeStandard(p);
      return { dx: m.dx * k, dy: m.dy * k };
    }
    return {
      offset,
      retarget(shown, next, now, skip = -1) {
        const ms = typeof duration === 'function' ? duration() : duration;
        for (const key of Object.keys(next)) {
          const v = Number(key), a = shown[key], b = next[key];
          if (v === skip || !a || ms <= 0) { moving.delete(v); continue; }
          const dx = a.x - b.x, dy = a.y - b.y;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) moving.delete(v);
          else moving.set(v, { dx, dy, t0: now, ms });
        }
      },
      active(now) {
        for (const v of [...moving.keys()]) offset(v, now);
        return moving.size > 0;
      },
      clear() { moving.clear(); },
    };
  }

  /** A tile's display aspect: its engine canvas once it has drawn, else the file's size, else 16:9. */
  function aspectOf(p) {
    const { w, h } = tileNat(p);
    return w / h;
  }
  const fitRect = (x, y, w, h, a) => {
    let fw = w, fh = w / a;
    if (fh > h) { fh = h; fw = h * a; }
    return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh };
  };
  const GAP = 2;
  /** Tile i's drawn size (its canvas, else the file's) and the video's own size (what 100 % shows). */
  function tileNat(p) {
    if (p && p.cv && p.cv.width && p.cv.height) return { w: p.cv.width, h: p.cv.height };
    if (p && p.meta && p.meta.width && p.meta.height) return { w: p.meta.width, h: p.meta.height };
    return { w: 1600, h: 900 };
  }
  const tileSrc = (p, Pic) => {
    const stream = p?.info?.remoteStream;
    return Pic.sourceSize(tileNat(p), stream
      ? { w: stream.sourceWidth, h: stream.sourceHeight }
      : { w: p?.meta?.width, h: p?.meta?.height });
  };
  /** Place a cell-local picture in stage coordinates and clip it to the cell. */
  function placed(r, x, y, w, h) {
    const full = { x: x + r.x, y: y + r.y, w: r.w, h: r.h };
    const x0 = Math.max(x, full.x), y0 = Math.max(y, full.y), x1 = Math.min(x + w, full.x + full.w), y1 = Math.min(y + h, full.y + full.h);
    return { full, pic: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) } };
  }
  /**
   * The cells in CSS pixels of the stage: {x, y, w, h, tiles: [i] or [left, right] (split) or [] (the add cell), pic}.
   */
  function computeCells({ order, mode, width: W, height: H, maxTiles, pictureRect }) {
    const n = order.length;
    const place = (i, x, y, w, h) => placed(pictureRect(i, w, h), x, y, w, h);
    if (mode === 'split') {
      const [l, r] = order;
      return [{ x: 0, y: 0, w: W, h: H, tiles: [l, r], split: true, ...place(l, 0, 0, W, H) }];
    }
    if (mode === 'side') {
      const w = (W - GAP) / 2;
      return order.map((i, k) => ({ x: k * (w + GAP), y: 0, w, h: H, tiles: [i], ...place(i, k * (w + GAP), 0, w, H) }));
    }
    const { cols, rows } = gridFor(n, 'grid');
    const w = (W - GAP * (cols - 1)) / cols, h = (H - GAP * (rows - 1)) / rows;
    const out = [];
    // The first empty cell adds a video (3 of 4; in a larger grid while the setting allows more).
    for (let k = 0, count = gridCellCount(n, maxTiles, cols, rows); k < count; k++) {
      const x = (k % cols) * (w + GAP), y = Math.floor(k / cols) * (h + GAP);
      if (k < n) out.push({ x, y, w, h, tiles: [order[k]], ...place(order[k], x, y, w, h) });
      else out.push({ x, y, w, h, tiles: [], add: true, pic: { x, y, w, h }, full: { x, y, w, h } });
    }
    return out;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  /** Offset text: short ("0", "+3 f", "−40 ms") for the nudge and the panel rows, long ("In step", "+3 frames") for the page. */
  function offText(o, long = false) {
    if (!o || !o.v) return long ? 'In step' : '0';
    const sg = o.v > 0 ? '+' : '−';
    const a = Math.abs(o.v);
    if (o.unit === 'ms') return `${sg}${Math.round(a * 10) / 10} ms`;
    return `${sg}${a}${long ? (a === 1 ? ' frame' : ' frames') : ' f'}`;
  }

  function frameFactor(cells, fitRectFor) {
    let f = 0;
    for (const c of cells) {
      if (c.add) continue;
      const fit = fitRectFor(c.tiles[0], c.w, c.h);
      if (fit.w > 0 && fit.h > 0) f = Math.max(f, c.full.w / fit.w, c.full.h / fit.h);
    }
    return Math.round(Math.max(0.1, Math.min(64, f || 1)) * 100) / 100;
  }

  const api = {
    aspectOf, fitRect, tileNat, tileSrc, placed, computeCells, frameFactor, offText, esc,
    TILE_KEYS, MAX_VIDEOS, DEFAULT_MAX, LARGE, GRID_PIXELS, clampMax, isLarge, gridFor, gridCellCount,
    tileOrder, moveTile, orderAfterRemoval, tileMemory, texturePixels, capSize, nativeCredits, nativeQueuePerTile,
    compareVisibility, reorderSession, canRemoveTile, removeButtonHtml, easeStandard, createGlide,
  };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { CompareGrid?: typeof api }} */ (globalThis).CompareGrid = api;
  // checkJs: end
})();
