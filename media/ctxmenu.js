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
    /** @type {HTMLElement|null} */
    let returnFocus = null;
    let dismissedAtPress = false;

    const isOpen = () => !menu.hidden;
    const entries = () => /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('[role^="menuitem"]')]);

    function close(refocus = false) {
      if (!isOpen()) return;
      menu.hidden = true;
      menu.textContent = '';
      const back = returnFocus;
      returnFocus = null;
      if (refocus && back && back.isConnected) back.focus();
    }

    function build() {
      menu.textContent = '';
      for (const it of items(env.getState())) {
        if ('sep' in it) {
          const sep = document.createElement('div');
          sep.setAttribute('role', 'separator');
          sep.className = 'ctx-sep';
          menu.appendChild(sep);
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ctx-item';
        b.dataset.id = it.id;
        b.tabIndex = -1;
        b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
        if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked));
        if (it.key) b.setAttribute('aria-keyshortcuts', it.key.replace('Ctrl', 'Control'));
        const check = document.createElement('span');
        check.className = 'ctx-check';
        check.setAttribute('aria-hidden', 'true');
        check.textContent = it.checked ? '✓' : '';
        const label = document.createElement('span');
        label.className = 'ctx-label';
        label.textContent = it.label;
        b.append(check, label);
        if (it.key) {
          const k = document.createElement('span');
          k.className = 'ctx-key';
          k.setAttribute('aria-hidden', 'true');
          k.textContent = it.key;
          b.appendChild(k);
        }
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
      if (!isOpen()) returnFocus = /** @type {HTMLElement|null} */ (document.activeElement);
      build();
      menu.hidden = false;
      menu.style.left = '0px';
      menu.style.top = '0px';
      const margin = 4;
      const w = menu.offsetWidth, h = menu.offsetHeight;
      const vw = document.documentElement.clientWidth || innerWidth, vh = document.documentElement.clientHeight || innerHeight;
      menu.style.left = `${Math.max(margin, Math.min(x, vw - w - margin))}px`;
      menu.style.top = `${Math.max(margin, Math.min(y, vh - h - margin))}px`;
      const first = entries()[0];
      if (focusFirst && first) first.focus();
      else menu.focus();
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

    // Click outside closes it. A press in the picture area only dismisses (consumeDismiss, like media/controls.js),
    // so the click that follows does not play / pause; a press on the bar still reaches its control.
    document.addEventListener('pointerdown', (e) => {
      dismissedAtPress = false;
      if (!isOpen()) return;
      const t = /** @type {Node|null} */ (e.target);
      if (t && menu.contains(t)) return;
      const bar = document.getElementById('bar');
      dismissedAtPress = !(bar && t && bar.contains(t));
      close(false);
    }, true);

    menu.addEventListener('keydown', (e) => {
      const list = entries();
      const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      let handled = true;
      switch (e.key) {
        case 'ArrowDown': list[i < 0 ? 0 : (i + 1) % list.length]?.focus(); break;
        case 'ArrowUp': list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length]?.focus(); break;
        case 'Home': list[0]?.focus(); break;
        case 'End': list[list.length - 1]?.focus(); break;
        case 'Escape': close(true); break;
        case 'Enter': case ' ': if (i >= 0) list[i].click(); break;
        case 'Tab': close(true); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); return; }
      // Any other key is the player's own key (R, S, ...): the menu gets out of the way and the key still works.
      close(false);
    });

    for (const ev of ['blur', 'resize']) window.addEventListener(ev, () => close(false));

    return {
      open, close, isOpen,
      /** True once after a press outside closed the menu in the picture area: the click that follows was the dismissal. */
      consumeDismiss: () => { const d = dismissedAtPress; dismissedAtPress = false; return d; },
      /** Test hook: what the open menu shows. */
      snapshot: () => (isOpen() ? {
        left: menu.offsetLeft, top: menu.offsetTop, width: menu.offsetWidth, height: menu.offsetHeight,
        items: entries().map((b) => ({
          id: b.dataset.id, role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'),
          label: b.querySelector('.ctx-label')?.textContent, key: b.querySelector('.ctx-key')?.textContent || '',
        })),
        seps: menu.querySelectorAll('[role=separator]').length,
        focused: /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.id || '',
      } : null),
    };
  }

  return { items, create };
})();

if (typeof module !== 'undefined') module.exports = VpeCtxMenu;
