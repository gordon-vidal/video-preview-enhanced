// @ts-check
// The player's right-click menu (docs/notes/context-menu.md): an HTML menu inside the page, drawn with the
// same theme tokens as the settings panel (media/player.css, "#ctxmenu" block at the end). Not VS Code's native
// webview menu: that one cannot right-align a shortcut, draw a check mark, or show over fullscreen.
// `items(state)` is plain data (test/host/ctxmenu_test.js loads it in Node); `create(env)` is the DOM part.
// Shortcuts are only shown: the page's own keys run them, so no workbench keybinding is involved.
'use strict';
/* exported VpeCtxMenu */
const VpeCtxMenu = (() => {
  /**
   * The menu for a player state: groups separated by one separator, an empty group dropped.
   * `action` names an entry of the page's MENU_ACTIONS.
   * @param {{ready: boolean, playing: boolean, loop: boolean, abSet: boolean, file: boolean, compareOpen: boolean}} s
   * @returns {({sep: true} | {id: string, action: string, label: string, key?: string, checked?: boolean})[]}
   */
  function items(s) {
    /** @type {any[][]} */
    const groups = [
      [
        { id: 'play', action: 'playPause', label: s.playing ? 'Pause' : 'Play', key: 'Space' },
        { id: 'loop', action: 'loop', label: 'Loop', key: 'R', checked: !!s.loop },
      ],
      s.ready ? [
        { id: 'setA', action: 'setA', label: 'Set Range Start (A)', key: 'A' },
        { id: 'setB', action: 'setB', label: 'Set Range End (B)', key: 'B' },
        ...(s.abSet ? [{ id: 'clearAB', action: 'clearAB', label: 'Clear A–B Range', key: 'Backspace' }] : []),
      ] : [],
      s.ready ? [
        { id: 'copyFrame', action: 'copyFrame', label: 'Copy Frame', key: 'Ctrl+C' },
        { id: 'saveFrame', action: 'saveFrame', label: 'Save Frame as PNG…', key: 'S' },
        { id: 'copyTime', action: 'copyTime', label: 'Copy Timestamp', key: 'T' },
      ] : [],
      s.file ? [
        s.compareOpen
          ? { id: 'addToCompare', action: 'addToCompare', label: 'Add to Compare', key: 'Shift+D' }
          : { id: 'startCompare', action: 'startCompare', label: 'Start Compare', key: 'Shift+D' },
      ] : [],
      [
        { id: 'keys', action: 'keys', label: 'Keyboard Shortcuts', key: '?' },
        { id: 'playerSettings', action: 'cog', label: 'Settings…' },
      ],
    ];
    const out = [];
    for (const g of groups.filter((x) => x.length)) {
      if (out.length) out.push({ sep: true });
      out.push(...g);
    }
    return out;
  }

  /**
   * @param {{menu: HTMLElement, getState: () => Parameters<typeof items>[0], run: (action: string) => void,
   *          beforeOpen?: () => void, container?: HTMLElement}} env
   */
  function create(env) {
    const { menu } = env;
    const ui = /** @type {any} */ (globalThis).VpeUi || (typeof require === 'function' ? require('./ui-primitives') : null);
    let dismissedAtPress = false;

    // Reset the picture-dismiss flag before the floating menu's outside-press handler runs.
    document.addEventListener('pointerdown', () => { dismissedAtPress = false; }, true);

    const fm = ui.createFloatingMenu({
      doc: document, win: window, menuEl: menu, itemSelector: '[role^="menuitem"]',
      passThroughKeys: true, closeOnResize: true,
      onOutsideDown: (/** @type {any} */ e) => {
        const t = /** @type {Node|null} */ (e.target);
        const bar = document.getElementById('bar');
        dismissedAtPress = !(bar && t && bar.contains(t));
      },
    });
    const isOpen = () => fm.isOpen();
    const entries = () => fm.items();
    const close = (refocus = false) => fm.close('api', { refocus });

    function build() {
      menu.textContent = '';
      for (const it of items(env.getState())) {
        if ('sep' in it) { menu.appendChild(ui.menuSep(document)); continue; }
        const b = ui.menuItem(document, it);
        b.dataset.id = it.id;
        b.tabIndex = -1;
        if (it.key) b.setAttribute('aria-keyshortcuts', it.key.replace('Ctrl', 'Control'));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          close(false);
          env.run(it.action);
        });
        menu.appendChild(b);
      }
    }

    /** Opens at a point in the page (clamped so the whole menu stays visible). `focusFirst`: opened from the keyboard. */
    function open(x, y, focusFirst = false) {
      if (env.beforeOpen) env.beforeOpen();
      build();
      fm.openAt(x, y, { focusFirst });
    }

    // The page's own menu replaces VS Code's; text fields keep the native Cut / Copy / Paste.
    document.addEventListener('contextmenu', (e) => {
      const t = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
      if (t && t.closest('input:not([type=range]):not([type=button]), textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      e.preventDefault();
      const kb = e.pointerType === '';
      if (kb && !e.clientX && !e.clientY) {
        const r = (document.getElementById('stage') || document.body).getBoundingClientRect();
        open(r.left + r.width / 2, r.top + r.height / 2, true);
      } else open(e.clientX, e.clientY, kb);
    });

    return {
      open, close, isOpen,
      /** True once after a press outside closed the menu in the picture area: the click that follows was the dismissal. */
      consumeDismiss: () => { const d = dismissedAtPress; dismissedAtPress = false; return d; },
      /** Test hook: what the open menu shows. */
      snapshot: () => (isOpen() ? {
        left: menu.offsetLeft, top: menu.offsetTop, width: menu.offsetWidth, height: menu.offsetHeight,
        items: entries().map((b) => ({
          id: b.dataset.id, role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'),
          label: b.querySelector('.vpe-mi-label')?.textContent, key: b.querySelector('.vpe-mi-key')?.textContent || '',
        })),
        seps: menu.querySelectorAll('[role=separator]').length,
        focused: /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.id || '',
      } : null),
    };
  }

  return { items, create };
})();

if (typeof module !== 'undefined') module.exports = VpeCtxMenu;
