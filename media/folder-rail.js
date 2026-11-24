// @ts-check
// The folder rail in the page (docs/notes/folder-rail.md): the bar's ‹ 2/5 › capsule, the right-edge fold-out tab,
// and the rail (header, filter, Playable formats, the column, the list, Autoplay and the position in the folder).
// The host (src/folder-rail.js) sends the listing as data with opaque ids; rows are built with textContent, and the
// page only ever sends back an id of the snapshot it got. The pure helpers (formatting, filtering) are exported for
// Node tests (test/host/folder_rail_test.js).
'use strict';

(function (root) {
  // checkJs: start
  const COLUMN_LABEL = { duration: 'Duration', size: 'Size', modified: 'Modified', none: 'None' };
  const WIDTH = { min: 176, max: 360, dflt: 218 };
  const EDGE_PX = 48; // how near the picture's right edge the fold-out tab shows
  const ROW_PX = 25; // 24 px rows + 1 px gap (folder-rail.css)

  // 24-unit icons with the bar's 1.6 stroke (src/bar.js).
  const svg = (size, body, fill = 'none') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${fill === 'none' ? 'currentColor' : 'none'}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICO = {
    up: svg(13, '<path d="M9 14L4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>'),
    dir: svg(13, '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    playing: svg(11, '<path d="M8 5v14l11-7z"/>', 'currentColor'),
    video: svg(13, '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3V9z"/>'),
    file: svg(13, '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    cmp: svg(11, '<rect x="2.5" y="4.5" width="19" height="15" rx="1.5"/><path d="M12 4.5v15"/>'),
  };

  // ---- pure helpers ----------------------------------------------------------------------------------------

  /** 75.2 -> "1:15"; 3725 -> "1:02:05"; unknown -> "—". @param {any} s */
  function fmtDuration(s) {
    const n = Number(s);
    if (!(n > 0) || !Number.isFinite(n)) return '—';
    const t = Math.round(n);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    const pad = (/** @type {number} */ x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
  /** Bytes as "2.1 KB", "14.2 MB", "1.4 GB"; unknown -> "—". @param {any} b */
  function fmtSize(b) {
    const n = Number(b);
    if (!(n >= 0) || !Number.isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }
  /** Today: "14:22"; this year: "Nov 22"; older: "2024-03-05"; unknown -> "—". @param {any} ms @param {number} [now] */
  function fmtModified(ms, now = Date.now()) {
    const n = Number(ms);
    if (!(n > 0)) return '—';
    const d = new Date(n), today = new Date(now);
    const pad = (/** @type {number} */ x) => String(x).padStart(2, '0');
    if (d.toDateString() === today.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === today.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  /** The right-hand column's text for an entry. @param {{kind: string}} e @param {any} m @param {string} column */
  function colText(e, m, column) {
    if (column === 'none' || e.kind === 'up') return '';
    const meta = m || {};
    if (column === 'modified') return fmtModified(meta.mtime);
    if (e.kind === 'dir') return '';
    if (column === 'size') return fmtSize(meta.size);
    return e.kind === 'video' ? fmtDuration(meta.duration) : '';
  }
  /**
   * The rows shown: `..` (unless filtering), folders, then files; with Playable formats on, only videos among the
   * files. The filter matches anywhere in the name, case-insensitively.
   * @template {{name: string, kind: string}} E
   * @param {E[]} entries @param {{ q?: string, playable?: boolean }} o
   * @returns {E[]}
   */
  function filterEntries(entries, { q = '', playable = true } = {}) {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (e.kind === 'up') return !needle;
      if (playable && e.kind === 'file') return false;
      return !needle || e.name.toLowerCase().includes(needle);
    });
  }
  /** "2/5", or '' when the file is not among them. @param {number} index 0-based @param {number} count */
  const posText = (index, count) => (index >= 0 && count > 0 ? `${index + 1}/${count}` : '');
  /** The capsule shows for a folder of two videos or more that holds the playing one. */
  const capsuleShown = (/** @type {number} */ index, /** @type {number} */ count) => index >= 0 && count > 1;
  const clampWidth = (/** @type {any} */ w) => {
    const n = Math.round(Number(w));
    return Number.isFinite(n) && n > 0 ? Math.max(WIDTH.min, Math.min(WIDTH.max, n)) : WIDTH.dflt;
  };
  /** Whether the pointer at (x, y) should reveal the fold-out tab. */
  function nearEdge(/** @type {{ x: number, right: number, open: boolean, buttons: number, overScopes: boolean, panning: boolean, idle: boolean }} */ s) {
    return !s.open && !s.buttons && !s.overScopes && !s.panning && !s.idle && s.x >= s.right - EDGE_PX && s.x <= s.right;
  }

  // ---- the DOM part ----------------------------------------------------------------------------------------

  /**
   * @param {{
   *   doc: Document, post: (m: any) => void, toast: (t: string, ms?: number) => void,
   *   cfg: { layout?: string, width?: number, column?: string, playable?: boolean },
   *   getOnEnd: () => string, setOnEnd: (mode: string) => void, label: (mode: string) => string,
   *   time?: () => number,
   * }} env
   */
  function create(env) {
    const { doc, post, toast } = env;
    const $ = (/** @type {string} */ id) => /** @type {any} */ (doc.getElementById(id));
    const rail = $('rail'), list = $('railList'), main = $('main'), stage = $('stage');
    const cap = $('folderCap'), capCount = $('capCount'), capPrev = $('capPrev'), capNext = $('capNext');
    const edge = $('railEdge'), openTab = $('railOpenTab'), closeBtn = $('railClose');
    const filter = $('railFilter'), playableBtn = $('railPlayable'), colHead = $('railColHead'), colBtn = $('railColBtn');
    const colMenu = $('railColMenu'), endMenu = $('railEndMenu'), endBtn = $('railEndBtn'), endVal = $('railEndVal');
    const pos = $('railPos'), crumb = $('railCrumb'), resizer = $('railResizer');
    const hover = $('railHover'), hoverName = $('railHoverName'), hoverL1 = $('railHoverLine1'), hoverL2 = $('railHoverLine2');
    const cfg = env.cfg || {};

    let open = false;
    let width = clampWidth(cfg.width);
    let column = COLUMN_LABEL[/** @type {keyof COLUMN_LABEL} */ (cfg.column)] ? String(cfg.column) : 'duration';
    let playable = cfg.playable !== false;
    let layout = cfg.layout === 'overlay' ? 'overlay' : 'dock';
    /** @type {{ gen: number, crumb: string, entries: any[], current: string|null, error?: string }} */
    let snap = { gen: 0, crumb: '', entries: [], current: null };
    /** @type {Map<string, any>} */ let metas = new Map();
    /** @type {Map<string, { row: HTMLElement, col: HTMLElement|null, e: any }>} */ let rows = new Map();
    /** @type {string|null} */ let cur = null; // keyboard cursor (row id)
    let place = { index: -1, count: 0 };
    let near = false;

    const send = (/** @type {any} */ m) => post({ type: 'rail', ...m });
    const prefs = () => post({ type: 'rail', op: 'prefs', width, column, playable });

    function applyLayout() {
      rail.classList.toggle('dock', layout === 'dock');
      rail.classList.toggle('overlay', layout === 'overlay');
      rail.style.setProperty('--rail-w', `${width}px`);
    }
    applyLayout();

    // ---- open / close ----
    function setOpen(on, { focus = false, refocus = false } = {}) {
      if (on === open) return;
      open = on;
      rail.hidden = !on;
      edge.hidden = on;
      near = false;
      edge.classList.remove('near');
      capCount.setAttribute('aria-expanded', String(on));
      capCount.classList.toggle('open', on);
      hideHover();
      closeMenus();
      if (on) {
        send({ op: 'open' });
        if (focus) list.focus();
      } else {
        send({ op: 'close' });
        if (refocus && (rail.contains(doc.activeElement) || doc.activeElement === doc.body)) opener().focus();
      }
      updateOpener();
    }
    /** The capsule is shown (the narrow-bar ladder hides it below 720 px with CSS, not with `hidden`). */
    const capVisible = () => !cap.hidden && cap.getClientRects().length > 0;
    /** Where the keyboard opens the rail: the capsule's count, else the fold-out tab. */
    const opener = () => (capVisible() ? capCount : openTab);
    /** The fold-out tab joins the Tab order only while the capsule is not there to open the rail. */
    function updateOpener() { openTab.tabIndex = !open && !capVisible() ? 0 : -1; }
    window.addEventListener('resize', updateOpener, { passive: true });
    // Opened from the keyboard (a click with no pointer, detail 0): focus goes to the list; a mouse click leaves it.
    const byKey = (/** @type {any} */ e) => e.detail === 0;
    openTab.addEventListener('click', (/** @type {MouseEvent} */ e) => { e.stopPropagation(); setOpen(true, { focus: byKey(e) }); });
    closeBtn.addEventListener('click', (/** @type {Event} */ e) => { e.stopPropagation(); setOpen(false, { refocus: true }); });
    capCount.addEventListener('click', (/** @type {MouseEvent} */ e) => { e.stopPropagation(); setOpen(!open, { focus: !open && byKey(e) }); });
    capPrev.addEventListener('click', (/** @type {Event} */ e) => { e.stopPropagation(); go(-1); });
    capNext.addEventListener('click', (/** @type {Event} */ e) => { e.stopPropagation(); go(1); });

    /** The next (1) or previous (-1) video of the playing file's folder, in this tab's place (the host decides). */
    function go(/** @type {number} */ d, auto = false) {
      post({ type: 'neighbour', d, ...(auto ? { auto: true } : {}), rail: carry() });
    }
    /** What the next tab of a folder navigation takes over. */
    function carry() {
      return { open, width, filter: filter ? filter.value : '', onEnd: env.getOnEnd() };
    }
    /**
     * Takes over a folder navigation's rail state (src/folder-rail.js RailCarry): the same for a new tab (its cfg)
     * and an already open one (railHandoff). Open or closed, width and filter all follow the source tab.
     * @param {{ open?: boolean, width?: number, filter?: string } | null | undefined} c
     */
    function adopt(c) {
      if (!c) return;
      if (c.width) { width = clampWidth(c.width); applyLayout(); }
      const q = typeof c.filter === 'string' ? c.filter : '';
      if (filter.value !== q) { filter.value = q; render(); }
      setOpen(!!c.open);
    }

    // ---- the fold-out tab: revealed near the right edge of the picture, opened by a click only ----
    main.addEventListener('pointermove', (/** @type {PointerEvent} */ e) => {
      const r = main.getBoundingClientRect();
      const t = /** @type {any} */ (e.target);
      const on = nearEdge({
        x: e.clientX, right: r.right, open, buttons: e.buttons,
        overScopes: !!(t && t.closest && t.closest('#scopes')),
        panning: stage.classList.contains('panning'), idle: doc.body.classList.contains('idle'),
      });
      if (on !== near) { near = on; edge.classList.toggle('near', on); }
    }, { passive: true });
    main.addEventListener('pointerleave', () => { if (near) { near = false; edge.classList.remove('near'); } }, { passive: true });

    // ---- resize from the left edge ----
    let drag = null;
    resizer.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      drag = { x: e.clientX, w: width, id: e.pointerId };
      try { resizer.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      rail.classList.add('resizing');
    });
    resizer.addEventListener('pointermove', (/** @type {PointerEvent} */ e) => {
      if (!drag) return;
      width = clampWidth(drag.w + (drag.x - e.clientX));
      rail.style.setProperty('--rail-w', `${width}px`);
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      rail.classList.remove('resizing');
      prefs();
    };
    resizer.addEventListener('pointerup', endDrag);
    resizer.addEventListener('pointercancel', endDrag);
    resizer.addEventListener('lostpointercapture', endDrag);

    // ---- filter, Playable formats ----
    filter.addEventListener('input', () => render());
    filter.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (filter.value) { filter.value = ''; render(); } else setOpen(false, { refocus: true });
      } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        list.focus();
        if (!cur) moveCursor(0, true);
        if (e.key === 'Enter' && cur) activate(cur);
      }
    });
    playableBtn.addEventListener('click', () => {
      playable = !playable;
      playableBtn.classList.toggle('on', playable);
      playableBtn.setAttribute('aria-checked', String(playable));
      render();
      prefs();
    });
    playableBtn.classList.toggle('on', playable);
    playableBtn.setAttribute('aria-checked', String(playable));

    // ---- menus: the column (left-click on DURATION ▾ or right-click on the header) and Autoplay ----
    function closeMenus() {
      for (const [m, b] of [[colMenu, colBtn], [endMenu, endBtn]]) { m.hidden = true; b.setAttribute('aria-expanded', 'false'); }
    }
    function showMenu(/** @type {HTMLElement} */ menu, /** @type {HTMLElement} */ btn, /** @type {string} */ attr, /** @type {string} */ value, /** @type {{x: number, y: number}|null} */ at) {
      const was = !menu.hidden;
      closeMenus();
      if (was && !at) return;
      for (const b of /** @type {any[]} */ ([...menu.querySelectorAll('button')])) {
        const on = b.dataset[attr] === value;
        b.setAttribute('aria-checked', String(on));
        b.querySelector('.chk').textContent = on ? '✓' : '';
      }
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const r = btn.getBoundingClientRect();
      const w = menu.offsetWidth, h = menu.offsetHeight;
      const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      const x = at ? at.x : r.right - w;
      const y = at ? at.y : (menu === endMenu ? r.top - h - 4 : r.bottom + 4);
      menu.style.left = `${Math.max(4, Math.min(x, vw - w - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, vh - h - 4))}px`;
      const first = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button');
      if (first) /** @type {HTMLElement} */ (first).focus();
    }
    colBtn.addEventListener('click', (/** @type {Event} */ e) => { e.stopPropagation(); showMenu(colMenu, colBtn, 'col', column, null); });
    colHead.addEventListener('contextmenu', (/** @type {MouseEvent} */ e) => {
      e.preventDefault(); e.stopPropagation(); // not the player's right-click menu
      showMenu(colMenu, colBtn, 'col', column, { x: e.clientX, y: e.clientY });
    });
    endBtn.addEventListener('click', (/** @type {Event} */ e) => { e.stopPropagation(); showMenu(endMenu, endBtn, 'end', env.getOnEnd(), null); });
    colMenu.addEventListener('click', (/** @type {Event} */ e) => {
      const b = /** @type {any} */ (e.target).closest('button');
      if (!b) return;
      e.stopPropagation();
      column = b.dataset.col;
      closeMenus();
      colBtn.focus();
      render();
      prefs();
    });
    endMenu.addEventListener('click', (/** @type {Event} */ e) => {
      const b = /** @type {any} */ (e.target).closest('button');
      if (!b) return;
      e.stopPropagation();
      closeMenus();
      endBtn.focus();
      env.setOnEnd(b.dataset.end);
    });
    for (const m of [colMenu, endMenu]) {
      m.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
        const items = /** @type {HTMLElement[]} */ ([...m.querySelectorAll('button')]);
        const i = items.indexOf(/** @type {any} */ (doc.activeElement));
        let handled = true;
        if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
        else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
        else if (e.key === 'Escape' || e.key === 'Tab') { closeMenus(); (m === colMenu ? colBtn : endBtn).focus(); } else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
      });
    }
    doc.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
      const t = /** @type {any} */ (e.target);
      if (!colMenu.hidden && !colMenu.contains(t) && t !== colBtn) { colMenu.hidden = true; colBtn.setAttribute('aria-expanded', 'false'); }
      if (!endMenu.hidden && !endMenu.contains(t) && !(t && t.closest && t.closest('#railEndBtn'))) { endMenu.hidden = true; endBtn.setAttribute('aria-expanded', 'false'); }
    }, true);

    // ---- the list ----
    function render() {
      hideHover();
      colBtn.textContent = `${column === 'none' ? 'Column' : COLUMN_LABEL[/** @type {keyof COLUMN_LABEL} */ (column)]} ▾`;
      crumb.textContent = snap.crumb;
      crumb.title = snap.crumb;
      list.textContent = '';
      rows = new Map();
      const shown = filterEntries(snap.entries, { q: filter.value, playable });
      if (snap.error || !shown.length) {
        const empty = doc.createElement('div');
        empty.className = 'r-empty';
        empty.textContent = snap.error || (snap.entries.length ? 'No matching files' : snap.gen ? 'Empty folder' : 'Loading…');
        list.appendChild(empty);
      }
      for (const e of shown) {
        const row = doc.createElement('div');
        const active = e.id === snap.current;
        row.className = `r-row${active ? ' active' : ''}${e.kind === 'file' ? ' dim' : ''}`;
        row.id = `rail-${e.id.replace('.', '-')}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(active));
        row.dataset.id = e.id;
        const ic = doc.createElement('span');
        ic.className = 'r-ico';
        ic.innerHTML = e.kind === 'up' ? ICO.up : e.kind === 'dir' ? ICO.dir : e.kind === 'video' ? (active ? ICO.playing : ICO.video) : ICO.file;
        const name = doc.createElement('span');
        name.className = 'r-name';
        name.textContent = e.name;
        if (e.kind === 'up') row.title = 'Parent folder';
        else name.title = e.name;
        row.append(ic, name);
        // A video: compare it with the playing one; a folder: compare all its videos.
        const canCompare = (e.kind === 'video' && !active) || e.kind === 'dir';
        /** @type {HTMLElement|null} */
        let col = null;
        if (column !== 'none' && e.kind !== 'up') {
          col = doc.createElement('span');
          col.className = `r-col${canCompare ? ' cmp-able' : ''}`;
          col.textContent = colText(e, metas.get(e.id), column);
          row.appendChild(col);
        }
        if (canCompare) {
          const b = doc.createElement('button');
          b.type = 'button';
          b.className = 'r-cmp';
          const folder = e.kind === 'dir';
          b.title = folder ? 'Compare all videos in folder' : 'Compare with the playing video';
          b.setAttribute('aria-label', folder ? `Compare all videos in folder ${e.name}` : `Compare with ${e.name}`);
          b.tabIndex = -1;
          b.innerHTML = ICO.cmp;
          b.addEventListener('click', (/** @type {Event} */ ev) => {
            ev.stopPropagation();
            if (folder) send({ op: 'compareFolder', gen: snap.gen, id: e.id }); else compareRow(e.id);
          });
          row.appendChild(b);
        }
        row.addEventListener('click', () => { setCursor(e.id); activate(e.id); });
        row.addEventListener('mouseenter', () => { send({ op: 'hover', gen: snap.gen, id: e.id }); showHover(e.id); });
        row.addEventListener('mouseleave', () => { send({ op: 'hover', gen: snap.gen, id: null }); hideHover(); });
        list.appendChild(row);
        rows.set(e.id, { row, col, e });
      }
      if (cur && !rows.has(cur)) cur = null;
      if (cur) setCursor(cur);
      reportVisible();
    }
    function activate(/** @type {string} */ id) {
      const r = rows.get(id);
      if (!r) return;
      const e = r.e;
      if (e.kind === 'file') { toast('Not a video file'); return; }
      if (e.id === snap.current) return;
      if (e.kind === 'up' || e.kind === 'dir') {
        // The cursor goes back to the folder walked out of (".."), like a file manager.
        send({ op: 'browse', gen: snap.gen, id });
        return;
      }
      send({ op: 'activate', gen: snap.gen, id, rail: carry() });
    }
    function compareRow(/** @type {string} */ id) {
      send({ op: 'compare', gen: snap.gen, id, t: env.time ? env.time() : 0 });
    }
    function setCursor(/** @type {string|null} */ id) {
      if (cur && rows.has(cur)) /** @type {any} */ (rows.get(cur)).row.classList.remove('cur');
      cur = id;
      const r = id ? rows.get(id) : null;
      if (r) {
        r.row.classList.add('cur');
        list.setAttribute('aria-activedescendant', r.row.id);
        r.row.scrollIntoView({ block: 'nearest' });
      } else list.removeAttribute('aria-activedescendant');
    }
    function moveCursor(/** @type {number} */ d, absolute = false) {
      const ids = [...rows.keys()];
      if (!ids.length) return;
      let i = absolute ? d : ids.indexOf(/** @type {string} */ (cur)) + d;
      if (!absolute && cur === null) i = d > 0 ? 0 : ids.length - 1;
      if (i < 0) i = absolute ? ids.length - 1 : 0;
      setCursor(ids[Math.max(0, Math.min(ids.length - 1, i))]);
    }
    list.addEventListener('focus', () => { if (!cur) { const a = snap.current && rows.has(snap.current) ? snap.current : null; if (a) setCursor(a); else moveCursor(0, true); } });
    list.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': moveCursor(1); break;
        case 'ArrowUp': moveCursor(-1); break;
        case 'Home': moveCursor(0, true); break;
        case 'End': moveCursor(-1, true); break;
        case 'PageDown': moveCursor(10); break;
        case 'PageUp': moveCursor(-10); break;
        case 'Enter': if (cur) activate(cur); break;
        case 'd': case 'D': {
          const r = cur ? rows.get(cur) : null;
          if (!e.ctrlKey && !e.metaKey && !e.altKey && r) {
            if (r.e.kind === 'dir') send({ op: 'compareFolder', gen: snap.gen, id: r.e.id });
            else if (r.e.kind === 'video' && r.e.id !== snap.current) compareRow(r.e.id);
            else handled = false;
          } else handled = false;
          break;
        }
        case 'Backspace': { const up = snap.entries.find((x) => x.kind === 'up'); if (up) send({ op: 'browse', gen: snap.gen, id: up.id }); break; }
        case 'Escape': setOpen(false, { refocus: true }); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
    // Escape anywhere in the rail (header buttons, the footer) closes it.
    rail.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setOpen(false, { refocus: true }); }
    });
    // The player's right-click menu is about the picture's moment: not on the rail (the column header has its own).
    rail.addEventListener('contextmenu', (/** @type {Event} */ e) => { e.preventDefault(); e.stopPropagation(); });

    let visTimer = 0;
    function reportVisible() {
      clearTimeout(visTimer);
      visTimer = /** @type {any} */ (setTimeout(() => {
        if (!open || !snap.gen) return;
        const top = list.scrollTop, h = list.clientHeight || 400;
        const ids = [...rows.keys()];
        const first = Math.max(0, Math.floor(top / ROW_PX) - 2), last = Math.min(ids.length, Math.ceil((top + h) / ROW_PX) + 2);
        send({ op: 'visible', gen: snap.gen, ids: ids.slice(first, last) });
      }, 60));
    }
    list.addEventListener('scroll', reportVisible, { passive: true });

    // ---- the hover card ----
    function showHover(/** @type {string} */ id) {
      const r = rows.get(id);
      if (!r || (r.e.kind !== 'video' && r.e.kind !== 'file')) { hideHover(); return; }
      hover.dataset.id = id;
      fillHover();
      hover.hidden = false;
      const mr = main.getBoundingClientRect(), rr = r.row.getBoundingClientRect(), railR = rail.getBoundingClientRect();
      hover.style.right = `${Math.max(8, mr.right - railR.left + 8)}px`;
      hover.style.top = `${Math.max(8, Math.min(mr.height - hover.offsetHeight - 8, rr.top - mr.top - 8))}px`;
    }
    function fillHover() {
      const id = hover.dataset.id;
      const r = id ? rows.get(id) : null;
      if (!r) return;
      const m = metas.get(/** @type {string} */ (id)) || {};
      hoverName.textContent = r.e.name;
      hoverL1.textContent = [r.e.kind === 'video' ? fmtDuration(m.duration) : null, fmtSize(m.size), fmtModified(m.mtime)].filter((x) => x !== null).join(' · ');
      hoverL2.textContent = [m.width && m.height ? `${m.width}×${m.height}` : '', m.codec ? String(m.codec).toUpperCase() : ''].filter(Boolean).join(' · ');
    }
    function hideHover() { hover.hidden = true; delete hover.dataset.id; }

    // ---- messages from the host ----
    function onMessage(/** @type {any} */ m) {
      switch (m.op) {
        case 'list': {
          const keep = snap.crumb === m.crumb ? cur : null;
          snap = { gen: m.gen, crumb: String(m.crumb || ''), entries: Array.isArray(m.entries) ? m.entries : [], current: m.current || null, error: m.error };
          metas = new Map();
          cur = keep;
          // Walked out of a folder: the cursor on that folder's row.
          if (m.from) cur = m.from;
          render();
          if (!cur && snap.current && rows.has(snap.current)) /** @type {any} */ (rows.get(snap.current)).row.scrollIntoView({ block: 'center' });
          break;
        }
        case 'meta': {
          if (m.gen !== snap.gen || !Array.isArray(m.patches)) break;
          for (const p of m.patches) {
            if (!p || typeof p.id !== 'string') continue;
            const { id, ...rest } = p;
            const merged = { ...(metas.get(id) || {}), ...rest };
            metas.set(id, merged);
            const r = rows.get(id);
            if (r && r.col) r.col.textContent = colText(r.e, merged, column);
          }
          if (!hover.hidden) fillHover();
          break;
        }
        case 'pos': setPos(Number(m.index), Number(m.count)); break;
        case 'layout': layout = m.layout === 'overlay' ? 'overlay' : 'dock'; applyLayout(); break;
        case 'show': if (m.open) setOpen(true); break;
      }
    }
    function setPos(/** @type {number} */ index, /** @type {number} */ count) {
      place = { index: Number.isFinite(index) ? index : -1, count: Number.isFinite(count) ? count : 0 };
      const text = posText(place.index, place.count);
      cap.hidden = !capsuleShown(place.index, place.count);
      updateOpener();
      capCount.textContent = text;
      capCount.setAttribute('aria-label', text ? `Folder rail, video ${place.index + 1} of ${place.count}` : 'Folder rail');
      pos.textContent = text;
    }
    function refreshOnEnd() { endVal.textContent = env.label(env.getOnEnd()).replace('Play next in folder', 'Next'); }
    refreshOnEnd();

    edge.hidden = false;
    updateOpener();

    return {
      go, carry, adopt, onMessage, setPos, refreshOnEnd,
      isOpen: () => open,
      open: () => setOpen(true, { focus: true }),
      show: () => setOpen(true),
      close: () => setOpen(false, { refocus: true }),
      toggle: () => setOpen(!open, { focus: !open }),
      /** Test hook: what the rail and the capsule show. */
      snapshot: () => ({
        open, layout, width, column, playable, filter: filter.value, crumb: snap.crumb, gen: snap.gen,
        railRect: open ? (() => { const r = rail.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })() : null,
        stageRect: (() => { const r = stage.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })(),
        rows: [...rows.values()].map((r) => {
          const b = /** @type {HTMLElement | null} */ (r.row.querySelector('.r-cmp'));
          return { id: r.e.id, name: r.e.name, kind: r.e.kind, col: r.col ? r.col.textContent : '', active: r.e.id === snap.current, cmp: b ? b.title : '' };
        }),
        openTabIndex: openTab.tabIndex, capVisible: capVisible(),
        openTabRect: (() => { const r = openTab.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })(),
        cap: { hidden: cap.hidden, text: capCount.textContent }, pos: pos.textContent, edgeNear: near, edgeHidden: edge.hidden,
        autoplay: endVal.textContent, hover: hover.hidden ? null : { name: hoverName.textContent, l1: hoverL1.textContent, l2: hoverL2.textContent },
        menus: { column: !colMenu.hidden, autoplay: !endMenu.hidden },
      }),
    };
  }

  // checkJs: end
  const api = { create, fmtDuration, fmtSize, fmtModified, colText, filterEntries, posText, capsuleShown, clampWidth, nearEdge, COLUMN_LABEL, WIDTH, EDGE_PX };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).VpeFolderRail = api;
}(typeof self !== 'undefined' ? self : this));
