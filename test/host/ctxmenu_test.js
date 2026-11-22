'use strict';
// node test/host/ctxmenu_test.js: the right-click menu's package.json contributions
// (webview/context, submenus) and the routing of its commands to the player (src/ctxmenu.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load } = require('./mock_vscode');
const ctx = require('../../src/ctxmenu');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const declared = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
const menus = pkg.contributes.menus;
const submenus = new Map((pkg.contributes.submenus || []).map((s) => [s.id, s]));

// every command used by a menu is declared (ours here, the built-in settings command excepted), with a title
const used = (arr) => arr.filter((m) => m.command).map((m) => m.command);
const WC = menus['webview/context'];
assert(WC.length === 14, 'webview/context has the items');
for (const m of [WC, ...[...submenus.keys()].map((k) => menus[k])]) {
  for (const id of used(m)) {
    if (id === 'workbench.action.openSettings') continue;
    assert(declared.has(id), `${id} is declared in contributes.commands`);
    assert(declared.get(id).title, `${id} has a title`);
  }
}
for (const i of ctx.ITEMS) {
  if (i.run === 'workbench.action.openSettings') continue;
  const id = i.existing ? i.run : ctx.PREFIX + i.id;
  assert(declared.has(id), `${id} declared`);
  if (!i.existing) {
    assert.strictEqual(declared.get(id).title, i.title, `${id} title`);
    assert(menus.commandPalette.some((m) => m.command === id && m.when === 'false'), `${id} hidden from the palette`);
  }
}
// top-level entries: when reaches only the player's webviews (not compare, not other extensions)
const re = new RegExp(/webviewId =~ \/(.*?)\/ &&/.exec(WC[0].when)[1]);
for (const m of WC) assert(m.when.startsWith(ctx.WEBVIEW_WHEN), `webview/context entry has the viewType clause: ${m.command || m.submenu}`);
for (const v of ['videoPreviewEnhanced.player', 'videoPreviewEnhanced.playerOptional', 'videoPreviewEnhanced.sequence']) assert(re.test(v), `${v} matches`);
for (const v of ['videoPreviewEnhanced.compare', 'other.player', 'xvideoPreviewEnhanced.player']) assert(!re.test(v), `${v} does not match`);
for (const t of pkg.contributes.customEditors) assert(re.test(t.viewType), `custom editor ${t.viewType} matches`);
// submenus: declared, referenced, filled
for (const s of WC.filter((m) => m.submenu)) {
  assert(submenus.has(s.submenu) && submenus.get(s.submenu).label, `submenu ${s.submenu} declared with a label`);
  assert(menus[s.submenu] && menus[s.submenu].length, `submenu ${s.submenu} has items`);
}
// context keys the when-clauses read are all set by the page (media/player.js updateMenuContext)
const page = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'player.js'), 'utf8');
const keys = new Set();
for (const m of [...WC, ...[...submenus.keys()].flatMap((k) => menus[k])]) for (const k of (m.when.replace(/\/.*?\/[^ ]*/, '').match(/\bvpe\w*/g) || [])) keys.add(k);
for (const k of keys) assert(new RegExp(`\\b${k}\\b`).test(page.slice(page.indexOf('function updateMenuContext'), page.indexOf('const MENU_ACTIONS'))), `page sets ${k}`);
assert(keys.has('vpePlaying') && keys.has('vpeLoop') && !keys.has('vpeAdvanced'));
// The menu is quick actions on this moment, in this order (2026-11-19; Compare With… from the compare mock-up, 2026-11-20): no speed, sound, tracks,
// window, frame-step or tool entries (those are in the cog panel), no submenus.
const order = WC.slice().sort((x, y) => x.group.localeCompare(y.group, 'en', { numeric: true })).map((m) => m.command.slice(ctx.PREFIX.length));
assert.deepStrictEqual(order, ['play', 'pause', 'loopOn', 'loopOff', 'setA', 'setB', 'clearAB', 'copyFrame', 'saveFrame', 'copyTime', 'startCompare', 'addToCompare', 'keys', 'playerSettings']);
assert.deepStrictEqual(ctx.ITEMS.map((i) => i.title), ['Play (Space)', 'Pause (Space)', 'Loop (R)', '✓ Loop (R)', 'Set Range Start (A)', 'Set Range End (B)', 'Clear A–B Range (Backspace)', 'Copy Frame (Ctrl+C)', 'Save Frame as PNG… (S)', 'Copy Timestamp (T)', 'Start Compare (Shift+D)', 'Add to Compare (Shift+D)', 'Keyboard Shortcuts (?)', 'Settings…']);
assert(WC.find((m) => m.command === ctx.PREFIX + 'clearAB').when.endsWith('&& vpeABSet'), 'Clear only while a loop is set');
const whenOf = (id) => WC.find((m) => m.command === ctx.PREFIX + id).when;
assert(whenOf('startCompare').endsWith('&& vpeFile && !videoPreviewEnhanced.compareOpen'), 'Start Compare: files only, while no Compare is open');
assert(whenOf('addToCompare').endsWith('&& vpeFile && videoPreviewEnhanced.compareOpen'), 'Add to Compare: files only, while a Compare is open');
assert(!ctx.ITEMS.some((i) => /Compare With/.test(i.title)) && !declared.has('videoPreviewEnhanced.ctx.compareWith'), 'Compare With… is gone from the menu');
// Shortcuts shown in the titles are real page keys (no bare-letter keybindings in package.json: the workbench would run them too)
assert(!(pkg.contributes.keybindings || []).some((k) => /^[a-z?]$|^space$|^backspace$/i.test(k.key) && /videoPreviewEnhanced\.ctx/.test(k.command)), 'no keybindings for the menu commands');
const shown = Object.fromEntries(ctx.ITEMS.map((i) => [i.id, (/ \((.+)\)$/.exec(i.title) || [])[1]]));
const keyCase = { play: "case ' '", loopOn: "case 'r'", setA: "case 'a'", setB: "case 'b'", clearAB: "case 'Backspace'", saveFrame: "case 's'", copyTime: "case 't'" };
for (const [id, c] of Object.entries(keyCase)) assert(shown[id] && page.includes(c), `${id}: ${shown[id]} is handled by the page (${c})`);
assert(page.includes("e.key === '?'") && page.includes("e.key === 'c' || e.key === 'C'") && page.includes("label: 'Compare', key: 'Shift+D'"), 'Ctrl+C, ? and Shift+D exist');
assert(!WC.some((m) => m.submenu) && !pkg.contributes.submenus, 'no submenus');
assert(!pkg.contributes.commands.some((c) => c.command === 'videoPreviewEnhanced.toggleAdvancedMode'), 'the mode switch is gone');
assert(!Object.keys(menus).some((k) => /ctx(Speed|Advanced|Tools)/.test(k)));
// the page handles every action
for (const i of ctx.ITEMS) if (i.action) assert(new RegExp(`\\b${i.action}:`).test(page), `page handles action ${i.action}`);

// the generated pieces are what package.json has
const gen = ctx.contributions();
for (const c of gen.commands) assert.deepStrictEqual(declared.get(c.command), c, `${c.command} as generated`);
assert.deepStrictEqual(menus['webview/context'].slice(-gen.submenus.length), WC.slice(-gen.submenus.length));

(async () => {
  // routing: a command posts { type: 'menu', action } to the active player
  const file = path.join(os.tmpdir(), `vpe_ctx_${process.pid}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(100));
  const h = load({});
  try {
    const a = h.open(file);
    const b = h.open(file);
    await a.shown; await b.shown;
    a.panel.active = false; b.panel.active = true;
    await h.vscode._commands['videoPreviewEnhanced.ctx.loopOn']({ vpe: true, webview: 'videoPreviewEnhanced.player' });
    await h.vscode._commands['videoPreviewEnhanced.ctx.copyTime']({});
    await h.vscode._commands['videoPreviewEnhanced.ctx.startCompare']({});
    await h.vscode._commands['videoPreviewEnhanced.ctx.addToCompare']({});
    const last = (s) => s.posted.filter((m) => m.type === 'menu');
    assert.deepStrictEqual(last(b), [{ type: 'menu', action: 'loop', value: undefined }, { type: 'menu', action: 'copyTime', value: undefined },
      { type: 'menu', action: 'startCompare', value: undefined }, { type: 'menu', action: 'addToCompare', value: undefined }]);
    assert.strictEqual(last(a).length, 0, 'the inactive player gets nothing');
    a.panel.active = true; b.panel.active = false;
    await h.vscode._commands['videoPreviewEnhanced.ctx.pause']({});
    assert.strictEqual(last(a).length, 1);
    await h.vscode._commands['videoPreviewEnhanced.ctx.playerSettings']({});
    await h.vscode._commands['videoPreviewEnhanced.ctx.keys']({});
    assert.deepStrictEqual(last(a).slice(-2).map((m) => m.action), ['cog', 'keys']);
    // the settings panel's "Extension settings" row: VS Code's Settings filtered to this extension
    await a.send({ type: 'openSettings' });
    assert.deepStrictEqual(h.vscode.executed.pop(), ['workbench.action.openSettings', '@ext:gordon-vidal.video-preview-enhanced']);
    // no player: nothing happens, no throw
    a.panel.dispose(); b.panel.dispose();
    await h.vscode._commands['videoPreviewEnhanced.ctx.copyFrame']({});
    console.log(`context menu: ok (${WC.length} top-level entries, ${ctx.ITEMS.length} items)`);
  } finally { fs.unlinkSync(file); h.dispose(); }
})().catch((e) => { console.error(e); process.exit(1); });
