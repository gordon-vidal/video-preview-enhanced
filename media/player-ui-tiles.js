// @ts-check
// Compare tile interactions as small DOM controllers, lifted out of media/compare.js so the real page and the mockup
// harness (tools/mockup/) share them and a Node test (test/host/player_ui_tiles_test.js) drives them on the strict
// fake DOM (test/host/fake-dom.js):
//
//   createGlide          FLIP glide of the cell elements into their new slots (200 ms, none with reduced motion)
//   bindTileDrag         lift a tile past 6 px, preview reorder / Spotlight swap / Spotlight edge dock, drop commits
//   createTileMenu       the tiles' right-click menu (#menu): items, viewport clamp, keyboard, outside dismiss
//   renderTileStatsCard  the ⓘ details card (.tile-stats), values that differ from slot A marked .diff
//   moveArrowHandlers    ▲ / ▼ move buttons: target slot and focus kept on the moved tile's button
//   hoverTracker         which tile is under the pointer (Split Wipe: the side of the divider)
//
// Zero VS Code, zero decoder coupling: every DOM access goes through the `doc` / `win` / elements the caller passes,
// and layout geometry comes in through callbacks (the page computes cells; this module only hit-tests them).
// The grid helpers (media/compare-grid.js) come in as `grid`, default the page global `CompareGrid`.
'use strict';

(() => {
  // checkJs: start
  /** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
  /** @typedef {Rect & { tiles: number[], add?: boolean, split?: boolean }} Cell */
  /** @typedef {{ mode: string, dock: string }} TileLayout */
  /**
   * @typedef {object} GridApi The parts of media/compare-grid.js this module uses.
   * @property {(px: number, py: number, W: number, H: number) => string | null} detectEdgeDock
   * @property {(order: number[], from: number, to: number) => number[]} moveTile
   * @property {(clip: any, ref: any) => { key: string, value: string, diff: boolean }[]} tileStatsRows
   * @property {(i: number, letter: string, icon: string) => string} statsCloseHtml
   */

  /** Presses here are buttons or other gestures, never a tile lift (as compare.js). */
  const DRAG_IGNORE = '#divider, #splitter, #menu, .move, .tbtn, .mute-mini, .tile-stats-close, .sync-pill, .addcell';
  /** Pointer travel before a press becomes a lift. */
  const LIFT_PX = 6;
  /** A click this soon after a drop is the drop's release, not play / pause. */
  const RECENT_DRAG_MS = 300;
  const GLIDE_MS = 200;
  const GLIDE_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

  /** @param {GridApi | undefined} grid @returns {GridApi} */
  function resolveGrid(grid) {
    const g = grid || /** @type {any} */ (globalThis).CompareGrid;
    if (!g) throw new Error('player-ui-tiles: pass `grid` (media/compare-grid.js) or load it first');
    return g;
  }

  /** @param {any} win */
  function reducedMotion(win) {
    try { return !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }

  /** @param {any} win @returns {() => number} */
  function clockOf(win) {
    return () => (win && win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now());
  }

  // ---- FLIP glide --------------------------------------------------------------------------------

  /**
   * Cells glide from where they were (capture) to where the new layout put them (play). Position moves by a
   * translate and size by the inline width / height, so names and buttons in a tile are never stretched.
   * @param {{ doc?: Document, win: any, duration?: number }} opts
   */
  function createGlide({ win, duration = GLIDE_MS }) {
    /** @type {Map<HTMLElement, DOMRect>} */
    let before = new Map();
    /** @type {Set<HTMLElement>} */
    const active = new Set();
    /** @type {any[]} */
    const timers = [];
    const ms = () => (reducedMotion(win) ? 0 : duration);
    /** @param {HTMLElement} el */
    function settle(el) {
      el.style.transition = '';
      el.style.transform = '';
      active.delete(el);
    }
    return {
      /** Snapshot where each cell is now. @param {Iterable<HTMLElement>} cells */
      capture(cells) {
        before = new Map();
        for (const el of cells) before.set(el, el.getBoundingClientRect());
      },
      /**
       * Animate each captured cell from its old rect to its current one; returns how many glide.
       * @param {Iterable<HTMLElement>} cells
       */
      play(cells) {
        const t = ms();
        let n = 0;
        for (const el of cells) {
          const a = before.get(el);
          if (!a) continue;
          const b = el.getBoundingClientRect();
          const dx = a.left - b.left, dy = a.top - b.top, dw = a.width - b.width, dh = a.height - b.height;
          if (t <= 0 || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dw) < 0.5 && Math.abs(dh) < 0.5)) {
            settle(el);
            continue;
          }
          const sized = /px$/.test(el.style.width || '') && /px$/.test(el.style.height || '');
          const to = { width: el.style.width, height: el.style.height };
          // First: jump back to the old place with no transition...
          el.style.transition = 'none';
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          if (sized) { el.style.width = `${a.width}px`; el.style.height = `${a.height}px`; }
          void el.offsetWidth; // commit the start state before the transition
          // ...then play to the new one.
          const tr = (p) => `${p} ${t}ms ${GLIDE_EASE}`;
          el.style.transition = sized ? [tr('transform'), tr('width'), tr('height')].join(', ') : tr('transform');
          el.style.transform = '';
          if (sized) { el.style.width = to.width; el.style.height = to.height; }
          active.add(el);
          n++;
        }
        before = new Map();
        if (n) timers.push(win.setTimeout(() => { for (const el of [...active]) settle(el); }, t + 50));
        return n;
      },
      /** Stop every glide where it is headed (no transition left behind). */
      cancel() {
        for (const id of timers.splice(0)) win.clearTimeout(id);
        for (const el of [...active]) settle(el);
        before = new Map();
      },
      isActive: () => active.size > 0,
      /** The duration the next play() uses: 0 with prefers-reduced-motion. */
      duration: ms,
    };
  }

  // ---- direct tile drag ----------------------------------------------------------------------------

  /** @param {Cell[]} cells @param {number} px @param {number} py */
  function hitCell(cells, px, py) {
    return cells.find((c) => !c.add && !c.split && px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) || null;
  }
  /** Bounding box of rects (the Spotlight strip), or null. @param {Rect[]} rs @returns {Rect | null} */
  function boundsOf(rs) {
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
  }
  const sameOrder = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.length === b.length && a.every((v, i) => v === b[i]);

  /**
   * @typedef {object} DragPreview
   * @property {number} video          the lifted video
   * @property {number[]} order        the order the tiles show now (the original one off-tile)
   * @property {string} dock           the Spotlight dock shown now
   * @property {boolean} changed       order or dock differs from the last preview (the page relayouts)
   * @property {{ rect: Rect, label: string, sub: Rect | null } | null} skeleton   the drop outline, or none
   * @property {number} dx             pointer travel since the press (the lifted tile follows it)
   * @property {number} dy
   */
  /**
   * Lift a tile and drop it elsewhere (compare.js B1 / B2). Grid and Spotlight strip tiles reorder (a strip tile
   * dropped on the main tile swaps with it); the Spotlight main tile docks to the stage edge it is dropped near.
   * @param {object} o
   * @param {HTMLElement} o.stage
   * @param {HTMLElement} o.cellsEl              holds the `.cell[data-tile]` elements
   * @param {any} o.win
   * @param {GridApi} [o.grid]
   * @param {() => TileLayout} o.getLayout        current mode ('grid' | 'spotlight' | 'split' ...) and dock
   * @param {() => number[]} o.getOrder
   * @param {(order: number[], dock: string) => Cell[]} o.getCells   stage-px cells of a layout
   * @param {() => boolean} [o.isZoomed]          zoomed tiles pan instead: only the ⋮⋮ grip lifts
   * @param {(p: DragPreview) => void} [o.onPreview]
   * @param {(order: number[], fromIdx: number, toIdx: number) => void} [o.onCommitOrder]
   * @param {(edge: string) => void} [o.onCommitDock]
   * @param {(busy: boolean) => void} [o.onBusyChange]   true on lift (close menus), false after drop / cancel
   * @param {() => void} [o.onCancel]                  a lift ended without a change
   * @param {() => number} [o.now]
   */
  function bindTileDrag(o) {
    const { stage, cellsEl, win } = o;
    const grid = resolveGrid(o.grid);
    const now = o.now || clockOf(win);
    const isZoomed = o.isZoomed || (() => false);
    /** @type {any} */
    let drag = null;
    let dragEnded = -Infinity;

    /** @param {number} v */
    const cellEl = (v) => /** @type {HTMLElement | null} */ (cellsEl.querySelector(`.cell[data-tile="${v}"]`));

    /** @param {PointerEvent} e */
    function onDown(e) {
      if (e.button !== 0 || drag) return;
      const target = /** @type {any} */ (e.target);
      if (!target || !target.closest || target.closest(DRAG_IGNORE)) return;
      if (isZoomed() && !target.closest('[data-zoom-drag]')) return;
      const layout = o.getLayout();
      const order = o.getOrder().slice();
      if (layout.mode === 'split' || order.length < 2) return;
      const cell = target.closest('.cell');
      if (!cell || !cellsEl.contains(cell)) return;
      const video = Number(cell.dataset.tile);
      if (!Number.isInteger(video)) return; // the split cell or the add cell
      const fromIdx = order.indexOf(video);
      if (fromIdx < 0) return;
      drag = {
        id: e.pointerId, video, fromIdx, x: e.clientX, y: e.clientY, lifted: false,
        mode: layout.mode, origOrder: order, previewOrder: order, origDock: layout.dock, previewDock: layout.dock,
        isHero: layout.mode === 'spotlight' && fromIdx === 0, toIdx: fromIdx,
      };
    }

    function lift() {
      drag.lifted = true;
      stage.classList.add('tile-dragging');
      cellEl(drag.video)?.classList.add('lifted');
      try { stage.setPointerCapture(drag.id); } catch { /* synthetic pointer */ }
      win.addEventListener('keydown', onKey, true);
      o.onBusyChange?.(true);
    }

    /** @param {PointerEvent} e */
    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.lifted) {
        if (Math.hypot(dx, dy) < LIFT_PX) return;
        lift();
      }
      const sr = stage.getBoundingClientRect();
      const px = e.clientX - sr.left, py = e.clientY - sr.top;
      /** @type {DragPreview['skeleton']} */
      let skeleton = null;
      let order = drag.origOrder, dock = drag.origDock, toIdx = drag.fromIdx;
      if (drag.isHero) {
        dock = grid.detectEdgeDock(px, py, sr.width, sr.height) || drag.origDock;
        const cells = o.getCells(drag.origOrder, dock).filter((c) => !c.add && !c.split);
        const main = cells.find((c) => c.tiles[0] === drag.video);
        if (main) {
          const sub = boundsOf(cells.filter((c) => c !== main));
          skeleton = { rect: main, label: dock === drag.origDock ? `Spotlight (${dock})` : `Dock Spotlight ${dock}`, sub };
        }
      } else {
        // Hit-test the original cells so the targets stay put while the preview moves the tiles.
        const hit = hitCell(o.getCells(drag.origOrder, drag.origDock), px, py);
        const targetIdx = hit ? drag.origOrder.indexOf(hit.tiles[0]) : -1;
        if (targetIdx >= 0) {
          toIdx = targetIdx;
          if (drag.mode === 'spotlight' && targetIdx === 0) {
            order = drag.origOrder.slice();
            [order[0], order[drag.fromIdx]] = [order[drag.fromIdx], order[0]];
            skeleton = { rect: /** @type {Cell} */ (hit), label: 'Swap into Spotlight', sub: null };
          } else {
            order = grid.moveTile(drag.origOrder, drag.fromIdx, targetIdx);
            const dest = o.getCells(order, drag.origDock).find((c) => !c.add && !c.split && c.tiles[0] === drag.video);
            if (dest) skeleton = { rect: dest, label: 'Move here', sub: null };
          }
        }
      }
      const changed = !sameOrder(order, drag.previewOrder) || dock !== drag.previewDock;
      drag.previewOrder = order;
      drag.previewDock = dock;
      drag.toIdx = toIdx;
      o.onPreview?.({ video: drag.video, order, dock, changed, skeleton, dx, dy });
    }

    /** @param {boolean} commit */
    function finish(commit) {
      const d = drag;
      if (!d) return;
      drag = null; // first: releasing the capture below may fire lostpointercapture
      if (!d.lifted) return;
      win.removeEventListener('keydown', onKey, true);
      stage.classList.remove('tile-dragging');
      cellEl(d.video)?.classList.remove('lifted');
      try { if (stage.hasPointerCapture(d.id)) stage.releasePointerCapture(d.id); } catch { /* synthetic pointer */ }
      dragEnded = now();
      o.onBusyChange?.(false);
      if (commit && d.isHero && d.previewDock !== d.origDock) o.onCommitDock?.(d.previewDock);
      else if (commit && !d.isHero && !sameOrder(d.previewOrder, d.origOrder)) o.onCommitOrder?.(d.previewOrder, d.fromIdx, d.toIdx);
      else o.onCancel?.();
    }

    /** @param {PointerEvent} e */
    function onUp(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.lifted) onMove(e); // the release point is the drop point
      finish(true);
    }
    /** @param {PointerEvent} e */
    function onLost(e) { if (drag && e.pointerId === drag.id) finish(false); }
    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (e.key !== 'Escape' || !drag || !drag.lifted) return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
    /** @param {Event} e */
    const onDragStart = (e) => e.preventDefault(); // no native drag ghost across tiles or pills

    /** @type {[string, any][]} */
    const listeners = [
      ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp],
      ['pointercancel', onLost], ['lostpointercapture', onLost], ['dragstart', onDragStart],
    ];
    for (const [type, fn] of listeners) stage.addEventListener(type, fn);

    return {
      isDragging: () => !!(drag && drag.lifted),
      /** The lifted video, or -1 (drawn last, follows the pointer). */
      liftedVideo: () => (drag && drag.lifted ? drag.video : -1),
      /** True within 300 ms of a drop: the click that follows is the release. @param {number} [t] */
      wasRecentDrag: (t = now()) => t - dragEnded < RECENT_DRAG_MS,
      cancel: () => finish(false),
      dispose() {
        finish(false);
        for (const [type, fn] of listeners) stage.removeEventListener(type, fn);
        win.removeEventListener('keydown', onKey, true);
      },
    };
  }

  // ---- the tiles' right-click menu -----------------------------------------------------------------

  /**
   * @typedef {object} TileMenuContext
   * @property {number} tile
   * @property {string} letter          the tile's label ('A', 'B' ...)
   * @property {boolean} [playing]
   * @property {boolean} [isClock]      this tile sets the clock
   * @property {boolean} [isSound]      the sound comes from this tile
   * @property {string} [offsetHint]    e.g. '+0.20 s'
   * @property {string} [timeHint]      the tile's time, e.g. '0:01.234'
   * @property {boolean} [dense]        large grid: the copy is the tile as shown
   * @property {boolean} [canAdd]       fewer than the most videos
   */
  /** The menu's items for a tile, in order; `null` is a separator. Pure, for the tests and the mockup. @param {TileMenuContext} c */
  function tileMenuItems(c) {
    const k = c.letter;
    return [
      { id: 'playPause', label: c.playing ? 'Pause' : 'Play', hint: 'Space' },
      null,
      { id: 'setClock', label: `${k} sets the clock`, checked: !!c.isClock },
      { id: 'setSound', label: `Sound from ${k}`, checked: !!c.isSound },
      { id: 'offset', label: `Offset of ${k}…`, hint: c.offsetHint || '' },
      null,
      { id: 'copyFrame', label: c.dense ? `Copy tile as shown (${k})` : `Copy frame (${k})` },
      { id: 'copyTime', label: `Copy timestamp (${k})`, hint: c.timeHint || '' },
      null,
      { id: 'replace', label: `Replace ${k}…` },
      { id: 'remove', label: `Remove ${k}` },
      ...(c.canAdd ? [{ id: 'add', label: 'Add video…' }] : []),
      { id: 'leave', label: 'Leave compare' },
      null,
      { id: 'keys', label: 'Keyboard shortcuts', hint: '?' },
      { id: 'settings', label: 'Settings…' },
    ];
  }

  /**
   * The tiles' right-click menu (compare.js F1 / F2) in `menuEl` (#menu).
   * @param {object} o
   * @param {Document} o.doc
   * @param {any} o.win
   * @param {HTMLElement} o.menuEl
   * @param {(id: string, ctx: TileMenuContext) => void} o.onAction
   * @param {(info: { reason: string, target?: any }) => void} [o.onClose]
   */
  function createTileMenu({ doc, win, menuEl, onAction, onClose }) {
    /** @type {HTMLElement | null} */
    let opener = null;
    /** @param {string} reason @param {any} [target] */
    function close(reason = 'api', target) {
      if (menuEl.hidden) return;
      menuEl.hidden = true;
      menuEl.textContent = '';
      delete menuEl.dataset.tile;
      onClose?.({ reason, target });
    }
    const items = () => /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll('.mi')]);

    /** @param {number} x @param {number} y @param {TileMenuContext} ctx */
    function open(x, y, ctx) {
      menuEl.textContent = '';
      for (const it of tileMenuItems(ctx)) {
        if (!it) {
          const s = doc.createElement('div');
          s.className = 'msep';
          s.setAttribute('role', 'separator');
          menuEl.appendChild(s);
          continue;
        }
        const b = doc.createElement('button');
        b.className = 'mi';
        b.type = 'button';
        b.dataset.action = it.id;
        if (it.checked === undefined) b.setAttribute('role', 'menuitem');
        else {
          b.setAttribute('role', 'menuitemcheckbox');
          b.setAttribute('aria-checked', String(it.checked));
        }
        const lab = doc.createElement('span');
        lab.className = 'grow';
        lab.textContent = `${it.checked ? '✓ ' : ''}${it.label}`;
        b.appendChild(lab);
        if (it.hint) {
          const h = doc.createElement('span');
          h.className = 'h';
          h.textContent = it.hint;
          b.appendChild(h);
        }
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          close('action');
          onAction(it.id, ctx);
        });
        menuEl.appendChild(b);
      }
      menuEl.setAttribute('role', 'menu');
      menuEl.hidden = false;
      menuEl.dataset.tile = String(ctx.tile);
      const r = menuEl.getBoundingClientRect();
      menuEl.style.left = `${Math.max(4, Math.min(x, win.innerWidth - r.width - 4))}px`;
      menuEl.style.top = `${Math.max(4, Math.min(y, win.innerHeight - r.height - 4))}px`;
      opener = /** @type {HTMLElement | null} */ (doc.activeElement);
      items()[0]?.focus();
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (menuEl.hidden) return;
      const list = items();
      const i = list.indexOf(/** @type {any} */ (doc.activeElement));
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': list[(i + 1) % list.length].focus(); break;
        case 'ArrowUp': list[(i - 1 + list.length) % list.length].focus(); break;
        case 'Home': list[0].focus(); break;
        case 'End': list[list.length - 1].focus(); break;
        case 'Escape': case 'Tab': {
          const back = opener;
          close(e.key === 'Tab' ? 'tab' : 'escape');
          if (back && back.focus && back.isConnected) back.focus();
          break;
        }
        // Activate here (not by the button's default) so it runs once and the key never reaches the page's keys.
        case 'Enter': case ' ': if (i >= 0) list[i].click(); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }
    /** @param {Event} e */
    const onMenuClick = (e) => e.stopPropagation();
    /** @param {Event} e */
    function onDocDown(e) {
      if (!menuEl.hidden && !menuEl.contains(/** @type {any} */ (e.target))) close('outside', e.target);
    }
    const onBlur = () => close('blur');

    menuEl.addEventListener('keydown', onKey);
    menuEl.addEventListener('click', onMenuClick);
    doc.addEventListener('pointerdown', onDocDown, true);
    win.addEventListener('blur', onBlur);

    return {
      open,
      close: () => close('api'),
      isOpen: () => !menuEl.hidden,
      dispose() {
        close('dispose');
        menuEl.removeEventListener('keydown', onKey);
        menuEl.removeEventListener('click', onMenuClick);
        doc.removeEventListener('pointerdown', onDocDown, true);
        win.removeEventListener('blur', onBlur);
      },
    };
  }

  // ---- the ⓘ details card --------------------------------------------------------------------------

  /**
   * The card's rows: the clip's facts with Frames second, each marked `diff` where it differs from slot A
   * (Frames; Picture by size or fps; Video by codec; Quality as text). `baseClip` / `baseFacts` null: this is slot A.
   * @param {{ clip: any, facts: { rows: string[][] }, baseClip?: any, baseFacts?: { rows: string[][] } | null, grid?: GridApi }} o
   * @returns {{ label: string, value: string, diff: boolean }[]}
   */
  function tileStatsCardRows({ clip, facts, baseClip = null, baseFacts = null, grid }) {
    const g = resolveGrid(grid);
    const isBase = !baseFacts;
    const st = g.tileStatsRows(clip, isBase ? null : baseClip);
    const flag = (/** @type {string} */ key) => !!st.find((r) => r.key === key)?.diff;
    const framesRow = st.find((r) => r.key === 'Frames');
    const rows = [...facts.rows];
    if (framesRow && framesRow.value !== '—') rows.splice(1, 0, ['Frames', framesRow.value]);
    const ref = baseFacts ? new Map(baseFacts.rows.map((r) => [r[0], r[1]])) : null;
    return rows.map(([label, value]) => {
      let diff = false;
      if (!isBase) {
        if (label === 'Frames') diff = flag('Frames');
        else if (label === 'Picture') diff = flag('Size') || flag('FPS');
        else if (label === 'Video') diff = flag('Codec');
        else if (label === 'Quality') diff = !!(ref && ref.has(label) && ref.get(label) !== value);
      }
      return { label, value, diff };
    });
  }

  /**
   * Fill `el` (a cell's `.tile-stats`; a new one when absent) with tile `index`'s details card (compare.js C5).
   * The × calls onClose(index), then focuses the pill's ⓘ in `focusRoot` (the overlay the caller rebuilt).
   * @param {object} o
   * @param {Document} o.doc
   * @param {HTMLElement} [o.el]
   * @param {number} [o.index]
   * @param {any} o.clip                 { w, h, fps, frames, codec } as compare-grid tileStatsRows reads
   * @param {{ title: string, sub?: string, rows: string[][] }} o.facts
   * @param {any} [o.baseClip]
   * @param {{ rows: string[][] } | null} [o.baseFacts]   slot A's facts; null for slot A itself
   * @param {string} o.letter
   * @param {string} [o.closeIcon]
   * @param {GridApi} [o.grid]
   * @param {(index: number) => void} [o.onClose]
   * @param {HTMLElement} [o.focusRoot]
   */
  function renderTileStatsCard(o) {
    const { doc, facts, letter } = o;
    const grid = resolveGrid(o.grid);
    const index = o.index ?? 0;
    const el = o.el || doc.createElement('div');
    el.classList.add('tile-stats');
    el.innerHTML = grid.statsCloseHtml(index, letter, o.closeIcon || '×');
    const top = doc.createElement('div');
    top.className = 'itop';
    const name = doc.createElement('div');
    name.className = 'iname';
    name.textContent = facts.title;
    top.appendChild(name);
    if (facts.sub) {
      const sub = doc.createElement('div');
      sub.className = 'isub';
      sub.textContent = facts.sub;
      top.appendChild(sub);
    }
    el.appendChild(top);
    const dl = doc.createElement('dl');
    dl.className = 'igrid';
    const rows = tileStatsCardRows({ clip: o.clip, facts, baseClip: o.baseClip, baseFacts: o.baseFacts, grid });
    for (const r of rows) {
      const dt = doc.createElement('dt');
      dt.textContent = r.label;
      const dd = doc.createElement('dd');
      dd.textContent = r.value;
      if (r.diff) dd.className = 'diff';
      dl.append(dt, dd);
    }
    el.appendChild(dl);
    const closeBtn = /** @type {HTMLElement} */ (el.querySelector('.tile-stats-close'));
    if (o.onClose && closeBtn) {
      const onClose = o.onClose;
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClose(index);
        // The caller rebuilds the overlay, so the pill's ⓘ is a new element: look it up after, not before.
        /** @type {HTMLElement | null} */ (o.focusRoot?.querySelector(`.mute-mini[data-act="info"][data-i="${index}"]`) || null)?.focus();
      });
    }
    return { el, rows };
  }

  // ---- ▲ / ▼ move arrows ---------------------------------------------------------------------------

  const moveArrowHandlers = {
    /**
     * Where a move button sends its tile: `{ from, to }` order indexes, or null at an end.
     * @param {number[]} order @param {number} video @param {number} direction -1 earlier, 1 later
     */
    target(order, video, direction) {
      const from = order.indexOf(video);
      const to = from + direction;
      return from < 0 || to < 0 || to >= order.length ? null : { from, to };
    },
    /**
     * After the overlay was rebuilt: focus the moved tile's button for the same direction, or its other one
     * (at an end the same direction is disabled). Returns the focused button.
     * @param {ParentNode} root @param {number} video @param {number} direction
     */
    refocus(root, video, direction) {
      const sel = `[data-act="move"][data-i="${video}"]:not([disabled])`;
      const b = /** @type {HTMLElement | null} */ (root.querySelector(`${sel}[data-d="${direction}"]`) || root.querySelector(sel));
      b?.focus();
      return b;
    },
    /** Read before the move: a mouse click does not leave the button focused. @param {Document} doc @param {Element} el */
    wasFocused: (doc, el) => doc.activeElement === el,
  };

  // ---- the tile under the pointer -----------------------------------------------------------------

  /**
   * @typedef {object} SplitInfo  Split Wipe's one cell with two tiles.
   * @property {number[]} tiles   [left, right]
   * @property {number} picX      the picture's left in stage px
   * @property {number} picW
   * @property {number} ratio     the divider at 0-1 of the picture
   */
  /**
   * The tile at `target` / client x: the cell's tile, or in Split Wipe the side of the divider. Null off the tiles.
   * @param {any} target @param {number} clientX @param {{ stageLeft?: number, split?: SplitInfo | null }} [o]
   */
  function tileAt(target, clientX, o = {}) {
    const cell = target && target.closest ? target.closest('.cell') : null;
    const t = cell ? cell.getAttribute('data-tile') : null;
    if (t === null || t === undefined) return null;
    if (t !== 'split') { const n = Number(t); return Number.isInteger(n) ? n : null; }
    const s = o.split;
    if (!s) return null;
    return clientX - (o.stageLeft || 0) < s.picX + s.picW * s.ratio ? s.tiles[0] : s.tiles[1];
  }

  /**
   * Track the tile under the pointer over `cellsEl`; onChange(next, prev) when it changes (compare.js resets a
   * pending remove confirmation there).
   * @param {{ cellsEl: HTMLElement, stage?: HTMLElement, getSplit?: () => SplitInfo | null, onChange?: (next: number | null, prev: number | null) => void }} o
   */
  function hoverTracker({ cellsEl, stage, getSplit, onChange }) {
    /** @type {number | null} */
    let hover = null;
    /** @param {number | null} next */
    const set = (next) => {
      if (next === hover) return;
      const prev = hover;
      hover = next;
      onChange?.(next, prev);
    };
    /** @param {PointerEvent} e */
    const onMove = (e) => set(tileAt(e.target, e.clientX, {
      stageLeft: stage ? stage.getBoundingClientRect().left : 0,
      split: getSplit ? getSplit() : null,
    }));
    const onLeave = () => set(null);
    cellsEl.addEventListener('pointermove', onMove);
    cellsEl.addEventListener('pointerleave', onLeave);
    return {
      current: () => hover,
      reset: () => { hover = null; },
      dispose() {
        cellsEl.removeEventListener('pointermove', onMove);
        cellsEl.removeEventListener('pointerleave', onLeave);
      },
    };
  }

  const api = {
    DRAG_IGNORE, LIFT_PX, RECENT_DRAG_MS, GLIDE_MS, GLIDE_EASE,
    createGlide, bindTileDrag, tileMenuItems, createTileMenu, tileStatsCardRows, renderTileStatsCard,
    moveArrowHandlers, tileAt, hoverTracker,
  };
  // checkJs: end

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (globalThis).VpePlayerUiTiles = api;
})();
