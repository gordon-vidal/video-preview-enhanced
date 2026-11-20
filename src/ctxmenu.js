'use strict';
// The player's right-click menu: VS Code's native webview context menu (package.json
// contributes.menus["webview/context"], submenus). The page keeps data-vscode-context current
// (media/player.js updateMenuContext: vpe, vpeReady, vpePlaying, vpeLoop, vpeABSet). A command gets that object as its argument; it only picks the
// player (the active one) and posts { type: 'menu', action } which the page runs through the code
// of its keys and buttons. docs/notes/context-menu.md.

const PREFIX = 'videoPreviewEnhanced.ctx.';

/**
 * Menu items. `action` is posted to the page; `run` runs another command instead; `existing` means
 * that command is already declared in package.json (so it is not generated). `menu` puts the item
 * in a submenu (SUBMENUS id) instead of the top level. `when` is the page's context.
 */
const ITEMS = [
  // Right-click = quick actions on this moment (YouTube / browser model); how it plays is in the cog panel.
  { id: 'play', title: 'Play', action: 'playPause', when: '!vpePlaying', group: '1_play@1' },
  { id: 'pause', title: 'Pause', action: 'playPause', when: 'vpePlaying', group: '1_play@1' },
  // A menu item can't show a check mark of its own: two items with opposite when-clauses.
  { id: 'loopOn', title: 'Loop', action: 'loop', when: '!vpeLoop', group: '1_play@2' },
  { id: 'loopOff', title: '✓ Loop', action: 'loop', when: 'vpeLoop', group: '1_play@2' },
  // A-B loop at this moment; Clear only while a start or an end is set
  { id: 'setA', title: 'Set Loop Start (A)', action: 'setA', when: 'vpeReady', group: '2_ab@1' },
  { id: 'setB', title: 'Set Loop End (B)', action: 'setB', when: 'vpeReady', group: '2_ab@2' },
  { id: 'clearAB', title: 'Clear A-B Loop', action: 'clearAB', when: 'vpeABSet', group: '2_ab@3' },
  // this frame and time
  { id: 'copyFrame', title: 'Copy Frame', action: 'copyFrame', when: 'vpeReady', group: '3_copy@1' },
  { id: 'saveFrame', title: 'Save Frame as PNG…', action: 'saveFrame', when: 'vpeReady', group: '3_copy@2' },
  { id: 'copyTime', title: 'Copy Timestamp', action: 'copyTime', when: 'vpeReady', group: '3_copy@3' },
  // compare: VS Code's open dialog, then compare takes this tab's place (src/compare.js); files only, not URLs
  { id: 'compareWith', title: 'Compare With…', action: 'compareWith', when: 'vpeFile', group: '4_compare@1' },
  // help and settings (the player's own settings panel: speed, subtitles, audio track, jump sizes, tools)
  { id: 'keys', title: 'Keyboard Shortcuts', action: 'keys', when: 'vpe', group: '9_help@1' },
  { id: 'playerSettings', title: 'Settings…', action: 'cog', when: 'vpe', group: '9_help@2' },
];

const SUBMENUS = [];

const WEBVIEW_WHEN = 'webviewId =~ /^videoPreviewEnhanced\\.(player|playerOptional|sequence|url)$/';

const cmdId = (i) => (i.existing ? i.run : PREFIX + i.id);

/** The package.json pieces, generated from the table (test/host/ctxmenu_test.js checks package.json has them). */
function contributions() {
  const own = ITEMS.filter((i) => !i.existing);
  const menus = {
    'webview/context': [],
    commandPalette: own.map((i) => ({ command: PREFIX + i.id, when: 'false' })),
  };
  for (const s of SUBMENUS) menus[s.menuId] = [];
  for (const i of ITEMS) {
    const sub = SUBMENUS.find((s) => s.id === i.menu);
    if (sub) menus[sub.menuId].push({ command: cmdId(i), when: i.when, group: i.group });
    else menus['webview/context'].push({ command: cmdId(i), when: `${WEBVIEW_WHEN} && ${i.when}`, group: i.group });
  }
  for (const s of SUBMENUS) menus['webview/context'].push({ submenu: s.menuId, when: `${WEBVIEW_WHEN} && ${s.when}`, group: s.group });
  return {
    commands: own.map((i) => ({ command: PREFIX + i.id, title: i.title, category: 'Video Preview' })),
    menus,
    submenus: SUBMENUS.map((s) => ({ id: s.menuId, label: s.label })),
  };
}

/** Registers the commands. `activeSession()` finds the player to post to (the same rule as the A-B export). */
function register(vscode, activeSession, subscriptions) {
  for (const i of ITEMS) {
    if (i.existing) continue;
    subscriptions.push(vscode.commands.registerCommand(PREFIX + i.id, () => {
      if (i.run) return vscode.commands.executeCommand(i.run, ...(i.args || []));
      const s = activeSession();
      if (s) s.post({ type: 'menu', action: i.action, value: i.value });
      return undefined;
    }));
  }
}

module.exports = { ITEMS, SUBMENUS, PREFIX, WEBVIEW_WHEN, contributions, register };
