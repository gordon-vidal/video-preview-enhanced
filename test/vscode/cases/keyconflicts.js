'use strict';
// Which player keys VS Code would also run a workbench command for (docs/notes/ui-simple.md "Keys and VS Code").
// A webview forwards every trusted keydown to the workbench (webview/browser/pre/index.html handleInnerKeydown ->
// 'did-keydown' -> the workbench dispatches it again), even when the page handled it. So a player key is safe only
// when no default keybinding without an editor-only `when` matches it. This case reads VS Code's own default
// keybindings (workbench.action.openDefaultKeybindingsFile, through the test hook) for the player's keys.
const fs = require('fs');
const path = require('path');
const lib = require('../lib');

// Player keys (must be free) and keys the player avoids on purpose (expected to be taken).
const PLAYER = ['left', 'right', 'shift+left', 'shift+right', 'ctrl+left', 'ctrl+right', 'up', 'down', 'space', ',', '.', 'shift+/', 'shift+,', 'shift+.', 'ctrl+c', 'k', 'j', 'l', 'home', 'end', 'escape'];
const AVOIDED = ['alt+left', 'alt+right', 'ctrl+k', 'ctrl+shift+c'];
// Reported only (the player uses them today; see the notes).
const INFO = ['ctrl+g', 'shift+c', 'ctrl+shift+n'];
// A binding can run while a video (a custom editor's webview) has focus only when its `when` is empty or made of
// context keys that are true whatever has focus (an editor-only, list-only or widget-only clause never holds there).
const ANY_FOCUS = new Set(['canNavigateBack', 'canNavigateForward', 'isWindows', 'isLinux', '!isMac', 'isMac', '!isWeb', 'isWeb', '!isLinux', '!isWindows', 'remoteName', '!remoteName']);
const canRunHere = (when) => !when || when.split(/\s*(?:&&|\|\|)\s*/).every((x) => ANY_FOCUS.has(x.trim()) || /^!\w*(Focus|focus|Visible|Focused)\w*$/.test(x.trim()));

module.exports = {
  name: 'keyconflicts',
  async run(vs, h) {
    const out = [];
    const t = (name) => {
      const r = { name, ok: true, problems: [] };
      out.push(r);
      return (cond, msg) => { if (!cond) { r.ok = false; r.problems.push(msg); } };
    };
    // The extension (and its test hook) starts with the first video.
    const P = await lib.open(vs, h, path.join(h.MEDIA, 'h264_aac_anim_1080p.mp4'));
    await P.close();
    const from = vs.mark();
    vs.send({ action: 'defaultKeybindings', keys: [...PLAYER, ...AVOIDED, ...INFO] });
    const line = await vs.waitLog(/debug keybindings \{/, { from, timeout: 30000, what: 'default keybindings' });
    const r = JSON.parse(line.slice(line.indexOf('debug keybindings {') + 18));
    let ok = t('read');
    ok(r.size > 10000, `default keybindings file has ${r.size} characters`);
    const global = (k) => r.found.filter((x) => (x.key.toLowerCase() === k || x.key.toLowerCase().startsWith(`${k} `)) && !x.command.startsWith('-') && canRunHere(x.when));
    ok = t('player-keys-free');
    const report = {};
    for (const k of PLAYER) {
      const g = global(k);
      report[k] = g;
      // Ctrl+C: VS Code's own copy is expected (the webview gets it as a copy command: nothing selected, nothing copied).
      if (k === 'ctrl+c') continue;
      ok(!g.length, `${k} also runs ${g.map((x) => `${x.command}${x.when ? ` (when ${x.when})` : ''}`).join(', ')}`);
    }
    ok = t('avoided-keys-taken');
    for (const k of AVOIDED) {
      const g = global(k);
      report[k] = g;
      // Alt+Left / Right (Go Back / Forward) and the Ctrl+K chords must be there; Ctrl+Shift+C (external terminal) is reported only.
      if (k !== 'ctrl+shift+c') ok(g.length > 0, `${k}: no VS Code binding that runs with a video focused (expected one, which is why the player does not use it)`);
    }
    for (const k of INFO) report[k] = global(k);
    const file = path.join(__dirname, '..', 'out', 'keyconflicts.json');
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ found: r.found, report }, null, 1)); } catch { /* best effort */ }
    out[out.length - 1].found = Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.map((x) => `${x.command}${x.when ? ` [${x.when}]` : ''}`)]));
    return out;
  },
};
