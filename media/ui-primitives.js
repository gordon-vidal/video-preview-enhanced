// @ts-check
// Reusable zero-dependency UI primitives shared by the webview modules (ctxmenu.js, player-ui-tiles.js,
// player-ui.js, controls.js): one SVG icon factory & registry, one viewport-clamping floating-menu controller
// (keyboard nav, Esc/Tab focus restore, outside-click dismissal, blur/resize close), and shared panel row builders.
// Zero VS Code, zero decoder, zero Node built-in dependencies.
'use strict';

(() => {
  // checkJs: start

  /**
   * Build an accessible decorative inline SVG on a 24×24 grid (matching src/bar.js stroke weight).
   * @param {string} body
   * @param {number} [size]
   * @param {number} [sw]
   */
  const svg = (body, size = 18, sw = 1.6) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  /** Shared icons for Compare controls, tile overlays, and panel rows. */
  const ICONS = {
    split: svg('<rect x="4" y="5" width="16" height="14" rx="1.6"/><path d="M12 3v18"/>'),
    sync: svg('<rect x="4" y="6" width="11.5" height="4.2" rx="1.1"/><rect x="8.5" y="13.8" width="11.5" height="4.2" rx="1.1"/><path d="M12 3.5v17" stroke-dasharray="1.8 2.2"/>'),
    spotlight: svg('<rect x="3" y="4" width="18" height="10" rx="1.4"/><rect x="3" y="16" width="5" height="4" rx="0.8"/><rect x="9.5" y="16" width="5" height="4" rx="0.8"/><rect x="16" y="16" width="5" height="4" rx="0.8"/>'),
    grid: svg('<rect x="3.5" y="4" width="7.5" height="7" rx="1.2"/><rect x="13" y="4" width="7.5" height="7" rx="1.2"/><rect x="3.5" y="13" width="7.5" height="7" rx="1.2"/><rect x="13" y="13" width="7.5" height="7" rx="1.2"/>'),
    swap: svg('<path d="M7 7h12l-3-3M17 17H5l3 3"/>'),
    compare: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="1.5"/><path d="M12 4.5v15"/>', 16),
    cmpPanel: svg('<path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10"/><circle cx="5.2" cy="6.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="5.2" cy="12" r="0.9" fill="currentColor" stroke="none"/><circle cx="5.2" cy="17.5" r="0.9" fill="currentColor" stroke="none"/>'),
    expand: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', 13, 2),
    collapse: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/>', 13, 2),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 12, 2.1),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    leave: svg('<path d="M10 17l-5-5 5-5M5 12h11a4 4 0 0 1 4 4v3"/>'),
    info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/>', 13, 2),
    sound: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>', 13, 1.9),
    muted: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>', 13, 1.9),
    noAudio: svg('<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M3 3l18 18"/>', 13, 1.9),
    up: svg('<path d="M6 14l6-6 6 6"/>', 14, 2),
    down: svg('<path d="M6 10l6 6 6-6"/>', 14, 2),
  };

  /**
   * Clamp a floating surface (menu/popover) inside the viewport with a margin on every edge.
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {number} vw @param {number} vh @param {number} [margin]
   * @returns {{ left: number, top: number }}
   */
  function clampToViewport(x, y, w, h, vw, vh, margin = 4) {
    const left = Math.max(margin, Math.min(x, (vw || 0) - (w || 0) - margin));
    const top = Math.max(margin, Math.min(y, (vh || 0) - (h || 0) - margin));
    return { left, top };
  }

  /**
   * Shared floating-menu lifecycle controller: viewport clamping, roving arrow/Home/End focus, Enter/Space
   * activation, Esc/Tab focus restore, outside pointerdown dismissal, and window blur/resize dismissal.
   * Used by both media/ctxmenu.js and media/player-ui-tiles.js (createTileMenu).
   * @param {object} o
   * @param {Document} o.doc
   * @param {any} o.win
   * @param {HTMLElement} o.menuEl
   * @param {string} [o.itemSelector]
   * @param {number} [o.margin]
   * @param {boolean} [o.passThroughKeys] close on unknown keys so player shortcuts still fire
   * @param {boolean} [o.closeOnResize]
   * @param {(e: any) => void} [o.onOutsideDown] called before closing on an outside pointerdown
   * @param {(info: { reason: string, target?: any }) => void} [o.onClose]
   */
  function createFloatingMenu(o) {
    const { doc, win, menuEl } = o;
    const itemSelector = o.itemSelector || '[role^="menuitem"]';
    const margin = o.margin === undefined ? 4 : o.margin;
    const passThroughKeys = !!o.passThroughKeys;
    const closeOnResize = !!o.closeOnResize;
    /** @type {HTMLElement | null} */
    let opener = null;

    const isOpen = () => !menuEl.hidden;
    /** The webview UI bundle's overlay engine (media/ui/floating.ts), when the page loaded it. */
    const overlay = () => /** @type {any} */ (globalThis).VpeWebviewUi?.showTopLayer ? /** @type {any} */ (globalThis).VpeWebviewUi : null;
    const items = () => /** @type {HTMLElement[]} */ ([...menuEl.querySelectorAll(itemSelector)]);

    /**
     * @param {string} [reason]
     * @param {{ refocus?: boolean, target?: any }} [opts]
     */
    function close(reason = 'api', opts = {}) {
      if (!isOpen()) return;
      overlay()?.hideTopLayer(menuEl);
      menuEl.hidden = true;
      menuEl.textContent = '';
      const back = opener;
      opener = null;
      if (opts.refocus && back && back.focus && back.isConnected) back.focus();
      o.onClose?.({ reason, target: opts.target });
    }

    /**
     * Position an already-populated menu at (x, y), clamped inside the viewport, and focus it.
     * @param {number} x @param {number} y @param {{ focusFirst?: boolean }} [opts]
     */
    function openAt(x, y, opts = {}) {
      if (!isOpen()) opener = /** @type {HTMLElement | null} */ (doc.activeElement);
      menuEl.hidden = false;
      const engine = overlay();
      engine?.showTopLayer(menuEl);
      menuEl.style.left = '0px';
      menuEl.style.top = '0px';
      if (engine) {
        engine.positionAtPoint(menuEl, x, y, { padding: margin });
        const first = items()[0];
        if (opts.focusFirst !== false && first && first.focus) first.focus();
        else if (menuEl.focus) menuEl.focus();
        return;
      }
      const rect = typeof menuEl.getBoundingClientRect === 'function' ? menuEl.getBoundingClientRect() : { width: 0, height: 0 };
      const w = menuEl.offsetWidth || rect.width || 0;
      const h = menuEl.offsetHeight || rect.height || 0;
      const vw = (doc.documentElement && doc.documentElement.clientWidth) || (win && win.innerWidth) || 0;
      const vh = (doc.documentElement && doc.documentElement.clientHeight) || (win && win.innerHeight) || 0;
      const pos = clampToViewport(x, y, w, h, vw, vh, margin);
      menuEl.style.left = `${pos.left}px`;
      menuEl.style.top = `${pos.top}px`;
      const first = items()[0];
      if (opts.focusFirst !== false && first && first.focus) first.focus();
      else if (menuEl.focus) menuEl.focus();
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (!isOpen()) return;
      const list = items();
      if (!list.length) return;
      const i = list.indexOf(/** @type {any} */ (doc.activeElement));
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': list[i < 0 ? 0 : (i + 1) % list.length]?.focus(); break;
        case 'ArrowUp': list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length]?.focus(); break;
        case 'Home': list[0]?.focus(); break;
        case 'End': list[list.length - 1]?.focus(); break;
        case 'Escape': close('escape', { refocus: true }); break;
        case 'Tab': close('tab', { refocus: true }); break;
        case 'Enter': case ' ': if (i >= 0) list[i].click(); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); return; }
      if (passThroughKeys) close('key');
    }

    /** @param {Event} e */
    const onMenuClick = (e) => e.stopPropagation();
    /** @param {Event} e */
    function onDocDown(e) {
      if (!isOpen()) return;
      const t = /** @type {any} */ (e.target);
      if (t && menuEl.contains(t)) return;
      o.onOutsideDown?.(e);
      close('outside', { target: t });
    }
    const onBlur = () => close('blur');
    const onResize = () => close('resize');

    menuEl.addEventListener('keydown', onKey);
    menuEl.addEventListener('click', onMenuClick);
    doc.addEventListener('pointerdown', onDocDown, true);
    if (win) {
      win.addEventListener('blur', onBlur);
      if (closeOnResize) win.addEventListener('resize', onResize);
    }

    return {
      openAt,
      close,
      isOpen,
      items,
      dispose() {
        close('dispose');
        menuEl.removeEventListener('keydown', onKey);
        menuEl.removeEventListener('click', onMenuClick);
        doc.removeEventListener('pointerdown', onDocDown, true);
        if (win) {
          win.removeEventListener('blur', onBlur);
          if (closeOnResize) win.removeEventListener('resize', onResize);
        }
      },
    };
  }

  /**
   * Panel switch row builder (VpeControls helper `k`).
   * @param {any} k @param {string} label @param {boolean} on @param {() => void} run @param {any} [extra]
   */
  function switchRow(k, label, on, run, extra = {}) {
    const b = k.btn('row', label, run, { ...extra, aria: { role: 'switch', 'aria-checked': String(on), ...(extra.aria || {}) } });
    b.appendChild(k.sw(on));
    return b;
  }

  /**
   * Panel segmented-control row builder (VpeControls helper `k`): one label + mutually exclusive chip buttons.
   * @param {any} k @param {string} label @param {[string, string][]} options
   * @param {string} current @param {(value: string) => void} onPick @param {string} [ariaLabel]
   */
  function segmentedRow(k, label, options, current, onPick, ariaLabel = label) {
    const row = k.el('div', 'row static');
    row.appendChild(k.el('span', 'grow', label));
    const seg = k.el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', ariaLabel);
    for (const [value, text] of options) {
      seg.appendChild(k.btn('chip', text, () => onPick(value), { aria: { 'aria-pressed': String(current === value) } }));
    }
    row.appendChild(seg);
    return row;
  }

  const api = { svg, ICONS, clampToViewport, createFloatingMenu, switchRow, segmentedRow };
  // checkJs: end

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else /** @type {any} */ (globalThis).VpeUi = api;
})();
