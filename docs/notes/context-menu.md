# Right-click menu of the player

VS Code's native webview context menu replaces the webview default (Cut / Copy / Paste).
Implementation: `src/ctxmenu.js` (the item table, the generated `package.json` parts, command registration),
`media/player.js` (`updateMenuContext`, `MENU_ACTIONS`, the `menu` message), `test/host/ctxmenu_test.js`,
`test/vscode/cases/ctxmenu.js`.

## How it works

- `package.json`: `contributes.menus["webview/context"]` entries with
  `when: webviewId =~ /^videoPreviewEnhanced\.(player|playerOptional|sequence)$/ && <page context>`,
  `contributes.submenus` (Speed, Advanced) with their own `menus[<submenu id>]`. The compare page is not matched
  (its viewType is `videoPreviewEnhanced.compare`); it keeps VS Code's default menu.
- Page context: one helper, `updateMenuContext()`, writes JSON into `data-vscode-context` on `<body>` (every frame
  of the loop, but only touches the DOM when the JSON changed; plus once at start). Keys: `preventDefaultContextMenuItems: true`
  (drops Cut/Copy/Paste), `vpe`, `vpeReady`, `vpeAdvanced`, `vpePlaying`, `vpeLoop`, `vpeMuted`, `vpeSubs`,
  `vpeAudio` (more than one), `vpeAB` (A and B both set). `<body>` (not just the stage) so the bar and the
  overlays give the same menu.
- Commands (`videoPreviewEnhanced.ctx.*`, hidden from the palette): VS Code passes the context object as the argument;
  it is not used for routing. The command finds the player like the A-B export does (the active session, else the last active)
  and posts `{ type: 'menu', action, value }`. The page maps `action` to the function its key or button uses
  (`togglePlay`, `setLoop`, `setRate`, `copyFrame`, `saveFrame`, `press('C', shift)` for the frame link, `setAB`, ...).
  Already existing commands are used directly (`exportRange`, `copyFfmpegRange`, `compareWith`, `toggleAdvancedMode`).
- Toggles are two commands with opposite `when`s (Play / Pause, Turn Loop On / Off, Mute / Unmute, Switch to Advanced / Simple Mode):
  menu items can't change their title.
- 2026-11-20 (docs/notes/ui-simple.md): one player layout, and the menu is quick actions on this moment only:
  Play/Pause · Loop (✓) · ─ · Set Loop Start (A) · Set Loop End (B) · Clear A-B Loop (when `vpeABSet`) · ─ · Copy Frame ·
  Save Frame as PNG… · Copy Timestamp · ─ · Keyboard Shortcuts · Settings… (opens the ⚙ panel). No submenus, no mode switch; speed, sound, tracks, window and tools are in the ⚙ panel.
  A menu item can't draw a check mark of its own: Loop is two items ("Loop", "✓ Loop") with opposite whens.

## VS Code versions

The extension's minimum is 1.82. The webview context menu (`webview/context`, `data-vscode-context`,
`preventDefaultContextMenuItems`) arrived around 1.57-1.66 (from memory of the release notes, not re-checked);
`contributes.submenus` is older. All are available in 1.82 and in the test VS Code 1.147.0. `webviewId` in a when clause is
the custom editor's viewType (or the panel's viewType for the sequence panel).
Older versions simply show no extra items.

## Limits

- Verified in VS Code 1.147.0 through commands and the context attribute only. A native popup can't be clicked in the hidden test window: the real-VS-Code case (`case/ctxmenu`) runs the commands with a
  context object through the test hook (`{ctxCommand, ctx}` in `<VPE_LOG>.cmd`) and checks the page's `data-vscode-context`
  and the player's state. That the popup shows the items was not verified by eye.
- Fullscreen: VS Code may not show the context menu over a webview in browser fullscreen.
- Not done: Compare page menu; dynamic subtitle / audio lists.
