# Right-click menu of the player

An HTML menu inside the player's page replaces VS Code's native webview context menu (2026-11-22).
Implementation: `media/ctxmenu.js` (`VpeCtxMenu.items(state)` is the item data, `create(env)` the DOM part),
`media/player.js` (`MENU_ACTIONS`, the state it passes, the `#ctxmenu` wiring), `media/controls.js` (`onShow` hook),
the `#ctxmenu` block at the end of `media/player.css`, the `#ctxmenu` element and script tag in `src/extension.js`,
`test/host/ctxmenu_test.js`, `test/vscode/cases/ctxmenu.js`.

## Why not the native menu

The native menu (`contributes.menus["webview/context"]`, `data-vscode-context`) could not:

- right-align the shortcut in its own muted font: a shortcut only appears for a command with a keybinding, and a
  keybinding for a bare letter (`r`, `space`) also runs in the workbench, which sees every key a webview forwards
  (Loop would toggle twice). So the keys were written into the titles, "Play (Space)", looking like part of the label;
- draw a check mark: Loop was two items with opposite `when`s ("Loop" / "✓ Loop");
- show over a webview in browser fullscreen (not guaranteed).

The HTML menu does all three, uses the settings panel's theme tokens, and needs no command, no `package.json`
entry and no minimum VS Code version. Because the page calls `preventDefault()` on `contextmenu`, VS Code does
not show its own menu. The Compare page keeps VS Code's default menu (its own `contextmenu` handling is unchanged).

## What it shows

Plain data in `VpeCtxMenu.items(state)`, state = `{ ready, playing, loop, abSet, file, compareOpen }`; groups are
separated by one separator and an empty group is dropped:

| Group | Items (shortcut on the right) | Shown |
|---|---|---|
| 1 | Play / Pause (`Space`), Loop (`R`, ✓ when on) | always |
| 2 | Set Range Start (A) (`A`), Set Range End (B) (`B`), Clear A–B Range (`Backspace`) | ready; Clear only while A or B is set |
| 3 | Copy Frame (`Ctrl+C`), Save Frame as PNG… (`S`), Copy Timestamp (`T`) | ready |
| 4 | Start Compare / Add to Compare (`Shift+D`) | local file (not a URL); Add while a Compare is open |
| 5 | Keyboard Shortcuts (`?`), Settings… (no shortcut; opens the ⚙ panel) | always |

Quick actions on this moment only; speed, sound, tracks, window and tools stay in the ⚙ panel
(docs/notes/ui-simple.md, 2026-11-20). The shortcuts are labels only: the page's own key handler runs the keys, and
each item calls the same function as its key or button (`MENU_ACTIONS` in `media/player.js`). From the menu "Set Range
Start / End" always sets at this moment; the A / B keys toggle.

## Look

Same tokens as `.panel`: `--vpe-panel-bg`, `--vpe-panel-fg`, `--vpe-panel-border`, `--vpe-row-hover`, `--vpe-sep`,
`--vpe-dim`, `--vpe-mono`. The rows are the shared menu row (`VpeUi.menuItem`, `.vpe-mi`, docs/DESIGN.md "Menus"), the same
as the tile menu and the rail's menus: a 22 px check column (✓ for Loop when on, empty otherwise, so labels align), the
label (`flex: 1`), the shortcut (`.vpe-mi-key`: `--vpe-mono`, 11 px, `--vpe-dim`, 24 px from the label); 28 px high, the
row fill on hover and focus, the focus ring on keyboard focus. `position: fixed`, clamped to the
window with a 4 px margin (right and bottom edges; `max-height` scrolls on a very small window). Fullscreen is
`document.documentElement`, so the menu is inside it.

## Behaviour

- Opens on `contextmenu` anywhere in the page (stage, bar, overlays) except in `<input>` (not range / button),
  `<textarea>`, `<select>` and contenteditable, which keep the native Cut / Copy / Paste. Opened from the keyboard
  (the Menu key, Shift+F10: `pointerType === ''`) it is centred on the picture and the first item is focused.
- Keys inside: `ArrowDown` / `ArrowUp` (wrap), `Home` / `End`, `Enter` / `Space` run the item, `Escape` closes and
  returns focus, `Tab` closes. Any other key closes the menu and still reaches the player (so `R` or `S` work while it is open).
- Closes on a press outside (capture `pointerdown`), on `Escape`, on window `blur` and on `resize`. A press in the
  picture area only dismisses it: `consumeDismiss()` is checked by the stage's click handler next to the panels' own
  (media/controls.js), so the dismissing click does not play or pause. A press on the bar reaches its control.
- Opening the menu closes any open panel or the shortcuts sheet (`controls.closeAll`); opening a panel or the
  sheet closes the menu (`onShow` in `VpeControls.create`, so keys, bar buttons and menu items all do it).
- ARIA: `role="menu"` with `menuitem` buttons; Loop is `menuitemcheckbox` with `aria-checked` (a checkable menu item;
  still a menu item to assistive technology); separators are `role="separator"`; each item has `aria-keyshortcuts`;
  the visible shortcut and check mark are `aria-hidden` (the role and state carry them).

## Tests

- `test/host/ctxmenu_test.js` (layer 1): the items in every state, separators never doubled, every item wired to a
  `MENU_ACTIONS` entry and a real page key, package.json has no `webview/context` / `ctx.*` commands, the page has `#ctxmenu`
  and a nonce'd script, the CSS block is its own and uses the panel tokens, plus the DOM part in a minimal fake
  document (open, clamp, arrows / Home / End / Enter / Space / Escape, other keys, outside press, blur / resize, text fields).
- `test/vscode/cases/ctxmenu.js` (layer 3): the hidden desktop can click this menu. The hook actions `ctxOpen` (x, y),
  `ctxPick` (item id), `ctxClose` and `stageClick` open it, click an item and press in the picture; the state has `ctxMenu`
  (items, roles, checked, keys, rectangle, focus) and `viewport`. Covers the items, viewport clamp, panel interplay,
  Escape, transport / Loop, keys sheet and Settings…, the A–B items, Copy Timestamp and that the dismissing click does not toggle play.
  Real pixels (colours, the font of the shortcut column) are not compared.

## Limits

- Not done: Compare page menu; dynamic subtitle / audio lists.
- Whether a real right-click is delivered to the page in every VS Code version is VS Code's: the page only handles
  `contextmenu`. In browser fullscreen on a host that refuses it, the player falls back to the editor's Zen Mode; the menu
  works there as well, being part of the page.
