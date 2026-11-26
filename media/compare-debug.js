// @ts-check
'use strict';

(function () {
  // checkJs: start
  /**
   * @typedef {{x: number, y: number, w: number, h: number}} Box
   * @typedef {{add?: boolean, tiles?: number[], full: Box, pic: Box} & Box} Cell
   * @typedef {{
   *   cfg: {debug?: boolean, page: string},
   *   log: (message: string) => void,
   *   Grid: {gridFor: (count: number, mode: string) => {cols: number, rows: number}},
   *   N: number,
   *   MAX_TILES: number,
   *   st: {mode: string, dock: string, heroRatio: number, clock: number, sound: number, muted: boolean, split: number, order: number[],
   *     offsets: {v: number, unit: string}[], pic: {mode: string, zoom: number, cx: number, cy: number},
   *     rate: number, loop: boolean, sel: number, thresh: number},
   *   canvas: HTMLCanvasElement,
   *   stage: HTMLElement,
   *   cellsEl: HTMLElement,
   *   ui: Record<string, any>,
   *   controls: { show: (view: string, anchor: HTMLElement) => void, closeAll: (restoreFocus: boolean) => void,
   *     view: () => string | null },
   *   scanner: {start: () => void, running: boolean, found: {frame: number} | null},
   *   $: (id: string) => HTMLElement | null,
   *   getState: () => {tiles: any[], clock: any, cells: Cell[], hover: number | null, syncMode: boolean, statsIds: Set<number>},
   *   contextCount: () => number,
   *   setHover: (tile: number | null) => void,
   *   frameOf: (player: any) => number,
   *   fpsOf: (player: any) => number,
   *   synced: () => boolean,
   *   tileSize: () => {w: number, h: number},
   *   frameFactor: () => number,
   *   picState: () => {pct: number | null},
   *   setMode: (mode: string) => void,
   *   setDock: (dock: string) => void,
   *   setHeroRatio: (ratio: number) => void,
   *   setSyncMode: (on: boolean) => void,
   *   setOffset: (tile: number, value: number, unit: string) => void,
   *   setClock: (tile: number) => void,
   *   removeTile: (tile: number) => void,
   *   setSound: (tile: number) => void,
   *   step: (delta: number) => void,
   *   play: () => void,
   *   pause: () => void,
   *   seekClock: (time: number) => void,
   *   setRate: (rate: number) => void,
   *   setSplit: (position: number) => void,
   *   tileOr0: (tile: number) => number,
   *   leave: (tile: number) => void,
   * }} CompareDebugDeps
   */

  /** @param {CompareDebugDeps} deps */
  function install(deps) {
    const {
      cfg, log, Grid, N, MAX_TILES, st, canvas, stage, cellsEl, ui, controls,
      scanner, $, getState, contextCount, setHover,
      frameOf, fpsOf, synced, tileSize, frameFactor, picState, setMode, setDock, setHeroRatio, setSyncMode, setOffset,
      setClock, removeTile, setSound, step, play, pause, seekClock, setRate,
      setSplit, tileOr0, leave,
    } = deps;
    if (!cfg.debug) return;

    // Test hook (VPE_LOG only): the host forwards debug messages from the test runner.
    function report() {
      const { tiles, clock, cells, syncMode } = getState();
      const per = (f) => tiles.map(f).join(',');
      const g = Grid.gridFor(N, st.mode);
      log(`compare report n=${N} mode=${st.mode} dock=${st.dock} heroRatio=${st.heroRatio.toFixed(2)} syncMode=${syncMode} modes=${N > 2 ? 'spotlight,grid' : 'spotlight,grid,split'} canvas=${canvas.width}x${canvas.height} grid=${g.cols}x${g.rows} max=${MAX_TILES} now=${Math.round(performance.now())}`
        // WebGL contexts in use: the compositor, the shared renderer (5+ tiles), each engine's own (2-4 tiles), metrics.
        + ` contexts=${contextCount() + tiles.filter((p) => p.gl && p.gl.gl).length}`
        + ` frame=${clock ? clock.currentFrame() + 1 : '-'} clock=${st.clock} sound=${st.sound} muted=${st.muted} split=${st.split.toFixed(3)} swap=${N === 2 && st.order[0] === 1}`
        + ` playing=${per((p) => (p.playing ? 1 : 0))} frames=${per((p) => (p.shownT === null ? '-' : frameOf(p) + 1))} shown=${per((p) => p.shownCount || 0)}`
        + ` pts=${per((p) => p.shownT === null ? '-' : p.rel(p.shownT).toFixed(6))} srcs=${per((p) => (p.shownT === null || !p.shownMarkTime ? '-' : p.shownMarkTime().toFixed(6)))} targets=${per((p) => p.startT === null ? '-' : p.rel(p.pauseT).toFixed(6))}`
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
      const { cells, hover, syncMode, statsIds } = getState();
      const text = (e) => (e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '');
      const rect = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
      const shown = (e) => !!e && !e.hidden && (!e.closest || !e.closest('[hidden]')) && getComputedStyle(e).display !== 'none';
      const splitter = $('splitter');
      const addPop = $('addPop');
      return {
        bar: {
          ids: [...ui.bar.querySelectorAll('button, input')].filter(shown).map((b) => b.id),
          time: text(ui.time), play: ui.play.getAttribute('aria-label'), mute: ui.mute.title, rate: ui.rate.textContent,
          cmpExpanded: ui.cmpBtn.getAttribute('aria-expanded'), cogExpanded: ui.cog.getAttribute('aria-expanded'),
        },
        panel: ui.panel.hidden ? null : {
          view: controls.view(), label: ui.panel.getAttribute('aria-label'), text: text(ui.panel),
          sliderRect: $('speedSlider') ? rect($('speedSlider')) : null,
          rows: [...ui.panel.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label') || text(b), pressed: b.getAttribute('aria-pressed'), checked: b.getAttribute('aria-checked') })),
        },
        sheet: ui.sheet.hidden ? null : text(ui.sheet),
        // The folder rail (media/folder-rail.js snapshot), when the page has one.
        rail: /** @type {any} */ (window).vpeCompare?.railState?.() ?? null,
        active: document.activeElement?.id || document.activeElement?.getAttribute('aria-label'),
        menu: ui.menu.hidden ? null : { tile: Number(ui.menu.dataset.tile), items: [...ui.menu.querySelectorAll('.mi')].map((b) => text(b)) },
        addPop: addPop && !addPop.hidden ? text(addPop) : null,
        cells: [...cellsEl.children].map((/** @type {HTMLElement} */ d) => ({
          tile: d.dataset.tile === undefined ? (d.classList.contains('add') ? 'add' : '') : d.dataset.tile, rect: rect(d),
          pills: [...d.querySelectorAll('.pill')].map((p) => text(p)), nudges: [...d.querySelectorAll('.nudge')].map((n) => text(n)),
          moves: [...d.querySelectorAll('[data-act="move"]')].map((/** @type {HTMLButtonElement} */ b) => ({
            label: b.getAttribute('aria-label'), disabled: b.disabled, focused: b === document.activeElement,
          })),
          hasSpot: !!d.querySelector('[data-act="spot"]'),
          hasRm: !!d.querySelector('[data-act="remove"]'),
          rmConfirm: !!d.querySelector('[data-act="remove"].confirm'),
          statsOpen: d.classList.contains('show-stats'),
          info: (() => { const b = d.querySelector('.mute-mini[data-act="info"]'); return b ? { pressed: b.getAttribute('aria-pressed'), focused: b === document.activeElement } : null; })(),
          ended: d.classList.contains('ended'),
          pillRects: [...d.querySelectorAll('.pill')].map(rect),
          nudgeRects: [...d.querySelectorAll('.nudge')].map(rect),
          moveRects: [...d.querySelectorAll('.move button')].map(rect),
          picRect: (() => { const c = cells[[...cellsEl.children].indexOf(d)]; const o = cellsEl.getBoundingClientRect(); return c && c.pic ? [Math.round(o.left + c.pic.x), Math.round(o.top + c.pic.y), Math.round(c.pic.w), Math.round(c.pic.h)] : null; })(),
          pics: [...d.querySelectorAll('.ov')].map((o) => rect(o)), oor: !!d.querySelector('.oor:not([hidden])') || d.classList.contains('ended'),
        })),
        divider: (() => { const dv = cellsEl.querySelector('#divider'); return dv ? { rect: rect(dv), value: dv.getAttribute('aria-valuenow') } : null; })(),
        splitter: splitter && !splitter.hidden ? { rect: rect(splitter), value: splitter.getAttribute('aria-valuenow'), dir: splitter.classList.contains('v') ? 'v' : 'h' } : null,
        stage: rect(stage), toast: ui.toast.hidden ? '' : ui.toast.textContent,
        toastRect: ui.toast.hidden ? null : rect(ui.toast), live: ui.live.textContent, hover,
        syncMode, stats: [...statsIds],
        spotlight: { mode: st.mode, dock: st.dock, heroRatio: st.heroRatio },
        picture: {
          ...st.pic, factor: frameFactor(), pct: picState().pct, btnMode: ui.picBtn.dataset.mode, btnLabel: ui.picBtn.getAttribute('aria-label'), pannable: stage.classList.contains('pannable'),
          tiles: cells.filter((c) => !c.add).map((c) => ({ tiles: c.tiles, box: [c.x, c.y, c.w, c.h], full: [c.full.x, c.full.y, c.full.w, c.full.h], pic: [c.pic.x, c.pic.y, c.pic.w, c.pic.h] })),
        },
      };
    }
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || m.type !== 'debug' || m.page !== cfg.page) return;
      switch (m.action) {
        case 'mode': setMode(m.mode); break;
        case 'dock': setDock(m.dock); break;
        case 'heroRatio': setHeroRatio(Number(m.ratio)); break;
        case 'syncMode': setSyncMode(!!m.on); break;
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
        case 'hover': setHover(m.tile === null || m.tile === undefined ? null : tileOr0(m.tile)); break;
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
          const c = getState().cells[0];
          const r = stage.getBoundingClientRect();
          const from = dv.getBoundingClientRect();
          const y = from.top + from.height / 2;
          const ev = (type, x) => dv.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0, isPrimary: true }));
          ev('pointerdown', from.left + from.width / 2);
          for (let k = 1; k <= 4; k++) ev('pointermove', r.left + c.pic.x + c.pic.w * (st.split + (m.x - st.split) * k / 4));
          ev('pointerup', r.left + c.pic.x + c.pic.w * m.x);
          break;
        }
        case 'dom': { // a mouse / pointer / wheel event at client (x, y), or at an explicit target
          const target = m.target === 'document' ? document : m.target ? $(m.target) : document.elementFromPoint(m.x, m.y);
          if (!target) { log(`dom: nothing at ${m.x},${m.y}`); break; }
          if (m.ev === 'pointerdown') {
            const el = /** @type {Partial<Element>} */ (target);
            log(`dom target ${el.tagName}.${el.className} #${el.id}`);
          }
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
          const { clock, tiles } = getState();
          const at = (el, n) => (el ? el.getAttribute(n) : null);
          const ids = ['play', 'prev', 'next', 'seek', 'mute', 'volume', 'time', 'cmpBtn', 'infoBtn', 'rate', 'cog', 'full', 'divider'];
          const a = /** @type {any} */ (document.activeElement);
          log(`compare a11y ${JSON.stringify({
            controls: Object.fromEntries(ids.map((k) => { const el = $(k); return [k, el ? { label: at(el, 'aria-label'), pressed: at(el, 'aria-pressed'), expanded: at(el, 'aria-expanded'), valuetext: at(el, 'aria-valuetext'), role: at(el, 'role') } : null]; })),
            unnamed: [...document.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || '').trim() && !/[A-Za-z]/.test(b.textContent || '')).map((b) => b.id || b.className),
            live: ui.live ? ui.live.textContent : null, active: a ? a.id || a.className || a.tagName : '', panel: controls.view(),
            muted: st.muted, loop: st.loop, playing: !!(clock && clock.playing),
            ready: tiles.length === N && tiles.every((p) => p.shownT !== null) && ui.overlay.hidden,
          })}`);
          break;
        }
        default: break;
      }
    });
  }

  const api = { install };
  const commonJs = /** @type {{ exports?: typeof api } | undefined} */ (
    // @ts-ignore The webview has no CommonJS globals.
    typeof module === 'undefined' ? undefined : module
  );
  if (commonJs) commonJs.exports = api;
  else /** @type {typeof globalThis & { VpeCompareDebug?: typeof api }} */ (globalThis).VpeCompareDebug = api;
  // checkJs: end
})();
