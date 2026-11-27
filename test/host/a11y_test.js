'use strict';
// node test/run.js unit --grep a11y: keyboard ownership (media/modes.js ownsKey: which keys the focused
// control keeps from the player's shortcuts) and the accessible names, states and live region in the viewer's page
// (src/unified-html.js, rendered by the extension with the mock vscode) and its Compare tiles (media/player-ui.js).
// The pages themselves are checked in a real VS Code: test/vscode/cases/ui.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const VpeModes = require('../../media/modes');
const { load } = require('./mock_vscode');

// ---- ownsKey ----------------------------------------------------------------------------
const el = (tagName, o = {}) => ({
  nodeType: 1, tagName, type: o.type || '', isContentEditable: !!o.editable,
  getAttribute: (n) => (n === 'role' ? o.role || null : null),
  matches: (sel) => sel === ':focus-visible' && !!o.focusVisible,
});
const owns = (target, key = 'x', mods = {}) => VpeModes.ownsKey(/** @type {any} */ ({ target, key, ...mods }));

// Fields keep every key.
for (const t of ['text', 'number', 'search', '']) assert.strictEqual(owns(el('INPUT', { type: t }), 'k'), true, `input type=${t}`);
assert.strictEqual(owns(el('TEXTAREA'), ' '), true);
assert.strictEqual(owns(el('SELECT'), 'ArrowDown'), true, 'a list box keeps its arrows');
assert.strictEqual(owns(el('DIV', { editable: true }), 'k'), true);
// Sliders (seek, volume): the player's arrows, Home / End drive them.
assert.strictEqual(owns(el('INPUT', { type: 'range' }), 'ArrowLeft'), false);
// Checkbox / radio keep Space only.
assert.strictEqual(owns(el('INPUT', { type: 'radio' }), ' '), true);
assert.strictEqual(owns(el('INPUT', { type: 'checkbox' }), 'k'), false);
// A button reached with the keyboard keeps Space / Enter (they click it); other keys are the player's.
const kbButton = el('BUTTON', { focusVisible: true });
assert.strictEqual(owns(kbButton, ' '), true);
assert.strictEqual(owns(kbButton, 'Enter'), true);
assert.strictEqual(owns(kbButton, 'k'), false);
assert.strictEqual(owns(el('DIV', { role: 'menuitemradio', focusVisible: true }), ' '), true);
// Clicked with the mouse (focus without :focus-visible): Space still plays and pauses.
assert.strictEqual(owns(el('BUTTON', { focusVisible: false }), ' '), false);
// Keys sent to the document (the Tools menu's press(), the test hook) are always the player's.
assert.strictEqual(owns({ nodeType: 9 }, ' '), false);
assert.strictEqual(owns(null, ' '), false);
// isToolKey is unchanged: tool keys only.
assert.strictEqual(VpeModes.isToolKey(/** @type {any} */ ({ key: 'w' })), true);
assert.strictEqual(VpeModes.isToolKey(/** @type {any} */ ({ key: ' ' })), false);

// ---- the pages' markup ------------------------------------------------------------------
/** Every <button> in html has a name in words: aria-label, or text with letters. */
function checkButtons(html, what) {
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  let n = 0;
  while ((m = re.exec(html))) {
    n++;
    const label = /aria-label="([^"]*)"/.exec(m[1]);
    const text = m[2].replace(/<[^>]*>/g, '').replace(/\$\{[^}]*\}/g, '').trim();
    if (!text && !label) continue; // filled in by the script (notice, action)
    assert.ok((label && /[A-Za-z]/.test(label[1])) || /[A-Za-z]/.test(text), `${what}: button without a name in words: ${m[0].slice(0, 120)}`);
  }
  assert.ok(n > 5, `${what}: only ${n} buttons found`);
}
/** The [ ] buttons beside the time: named, unpressed until an end is set; the pins say they can be dragged. */
function assertRangeButtons(html, where) {
  assert.match(html, /<button id="time"[\s\S]*?<\/button>\s*<button id="setABtn"[^>]*title="Set range start \(A\)"[^>]*aria-label="Set range start \(A\)"[^>]*aria-pressed="false"/, `${where}: #setABtn`);
  assert.match(html, /<button id="setBBtn"[^>]*title="Set range end \(B\)"[^>]*aria-label="Set range end \(B\)"[^>]*aria-pressed="false"/, `${where}: #setBBtn`);
  assert.match(html, /id="abA" class="ab-pin"[^>]*title="Drag to move range start \(A\)"/, `${where}: #abA is draggable`);
  assert.match(html, /id="abB" class="ab-pin"[^>]*title="Drag to move range end \(B\)"/, `${where}: #abB is draggable`);
}
const pressed = (html, id) => new RegExp(`<button id="${id}"[^>]*aria-pressed="false"`).test(html);
const liveRegion = /<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/div>/;
const playFlash = /<div id="playFlash" aria-hidden="true"><svg class="i-play"[\s\S]*?<svg class="i-pause"/;
const playerStyles = fs.readFileSync(path.join(__dirname, '../../media/player.css'), 'utf8');
assert.match(playerStyles, /#seek:focus:not\(:focus-visible\), #volume:focus:not\(:focus-visible\) \{ outline: none; \}/);
assert.match(playerStyles, /#seek:focus-visible, #volume:focus-visible \{ outline: 1px solid var\(--vscode-focusBorder\); outline-offset: 2px; \}/);
assert.match(playerStyles, /\.vol-wrap:not\(\.no-audio\):hover \.vol-slide/, 'no-audio keeps the volume slider folded');
assert.match(playerStyles, /\.vol-wrap\.no-audio #mute \{ opacity: 0\.4;/, 'no-audio dims the disabled mute button');
// Narrow panes shed bar buttons in steps (docs/notes/ui-simple.md, "Narrow bar"); the step buttons go only at the last one.
const ladder = [...playerStyles.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)].map((m) => [Number(m[1]), m[2]]);
assert.deepStrictEqual(ladder.map((m) => m[0]), [720, 640, 500, 400, 320, 250], 'narrow bar steps');
// The folder capsule goes first (Shift+N / Shift+P and a right-click on the step buttons remain).
assert.match(ladder[0][1], /^\s*#row #folderCap \{ display: none; \}\s*$/, 'below 720 px only the folder capsule goes');
for (const [w, css] of ladder) {
  if (w > 250) assert.doesNotMatch(css, /#prev|#next|\.stepw|#play|#cog|#full|#now/, `${w} px keeps Play, the step buttons, the time, Settings, Fullscreen`);
}
assert.match(ladder[5][1], /\.stepw \{ display: none; \}/, 'below 250 px the step buttons go');
assert.match(ladder[4][1], /\.vol-wrap \{ display: none; \}/, 'below 320 px Mute and volume go (M and the arrow keys remain)');
// The folder rail and its openers: named, and the Autoplay menu's choices are radios (media/folder-rail.js keeps the
// fold-out tab in the Tab order while the capsule is hidden, so the keyboard can still open the rail below 720 px).
{
  const { folderRailHtml } = require('../../src/folder-rail-html');
  const { barHtml } = require('../../src/bar');
  const rail = folderRailHtml();
  assert.match(rail, /<button id="railOpenTab"[^>]*aria-label="Open folder rail"/);
  assert.match(rail, /<aside id="rail"[^>]*aria-label="Folder"/);
  assert.match(rail, /id="railList" class="r-list" role="listbox" aria-label="Files" tabindex="0"/);
  assert.match(rail, /id="railEndMenu" class="vpe-pop" role="menu" aria-label="Autoplay"/);
  const endItems = [...rail.matchAll(/<button type="button" role="(\w+)" aria-checked="false" data-end="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(endItems, ['menuitemradio:off', 'menuitemradio:next', 'menuitemradio:loop']);
  assert.match(rail, /id="railEndBtn"[^>]*aria-haspopup="menu" aria-expanded="false" aria-controls="railEndMenu"/);
  assert.match(rail, /id="railPlayable"[^>]*role="checkbox" aria-checked="true"/);
  const cap = barHtml({ folder: true });
  assert.match(cap, /id="folderCap" class="folder-cap" role="group" aria-label="Folder"/);
  assert.match(cap, /id="capCount"[^>]*aria-label="Folder rail" aria-expanded="false" aria-controls="rail"/);
  assert.match(cap, /id="capPrev"[^>]*aria-label="Previous video in folder" aria-keyshortcuts="Shift\+P"/);
  assert.match(cap, /id="capNext"[^>]*aria-label="Next video in folder" aria-keyshortcuts="Shift\+N"/);
}
// The notice takes the theme surface through the one card rule (docs/DESIGN.md), so it follows every theme.
assert.match(playerStyles, /#notice, #toast[^{]*\{[^}]*background: var\(--vpe-surface-float\)/);

// Dense styling uses the same buttons and focus reveal as the regular tiles.
const cmpScript = fs.readFileSync(path.join(__dirname, '../../media/player-ui.js'), 'utf8');
const tileScript = fs.readFileSync(path.join(__dirname, '../../media/player-ui-tiles.js'), 'utf8');
const cmpStyles = fs.readFileSync(path.join(__dirname, '../../media/compare.css'), 'utf8');
assert.match(cmpScript, /aria-label="\$\{k\} earlier"/);
assert.match(cmpScript, /aria-label="\$\{k\} later"/);
assert.match(cmpScript, /aria-label="Offset of \$\{k\}: \$\{off\.long\}"/);
assert.match(tileScript, /c\.dense \? `Copy tile as shown \(\$\{k\}\)`/, 'the large grid labels copies of rendered tiles');
assert.match(cmpStyles, /\.cell:focus-within \.ov \{ opacity: 1; \}/);
assert.match(cmpStyles, /#cells\.dense \.pill:focus-visible \{ outline-color: var\(--vscode-focusBorder\); \}/);

(async () => {
  const h = load({});
  const s = h.open(path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv'));
  await s.shown;
  const html = s.panel.webview.html;
  assert.ok(html.includes('id="bar"'), 'player page rendered');
  checkButtons(html, 'player');
  assert.match(html, liveRegion, 'player: live region');
  assert.match(html, playFlash, 'player: decorative play/pause flash');
  assert.ok(pressed(html, 'mute'), 'player: #mute has aria-pressed');
  assertRangeButtons(html, 'player');
  assert.ok(!html.includes('id="pip"'), 'player: no picture-in-picture button');
  assert.ok(!html.includes('id="info"'), 'player: the old top-left details overlay is gone (ⓘ has everything)');
  // One layout: no mode switch, no Tools / CC popup menus; the bar's panel buttons say what they open.
  for (const id of ['modeBtn', 'toolsBtn', 'toolsMenu', 'tracksMenu', 'pill']) assert.ok(!html.includes(`id="${id}"`), `player: #${id} is gone`);
  for (const id of ['tracks', 'infoBtn', 'rate', 'cog']) assert.match(html, new RegExp(`<button id="${id}"[^>]*aria-expanded="false" aria-controls="panel"`));
  assert.match(html, /<button id="tracks"[^>]* hidden/);
  // The Compare button: named, an icon; in the viewer it is the Capture toggle (media/player-ui.js drops the bar's
  // dialog attributes and sets aria-pressed), so the page needs no start dialog.
  assert.match(html, /<button id="startCompareBtn"[^>]*aria-label="Compare"/);
  assert.match(html, /<button id="startCompareBtn" class="ib" title="Compare"[^>]*><svg[^>]*aria-hidden="true">.*<\/svg><\/button>/);
  assert.doesNotMatch(html, /id="startCompareLabel"/);
  assert.ok(fs.readFileSync(path.join(__dirname, '../../media/player-ui.js'), 'utf8').includes("for (const a of ['aria-haspopup', 'aria-controls', 'aria-expanded']) cmpBtn.removeAttribute(a);"),
    'the Capture toggle points at no dialog');
  assert.doesNotMatch(html, /id="keysBtn"/);
  // The picture size button sits between the keyboard shortcuts and fullscreen; it names the mode and the next one.
  assert.match(html, /<button id="cog"[\s\S]*?<button id="picBtn" class="ib" data-mode="fit"[^>]*aria-label="Picture size: Fit\. Next: Fill"[^>]*aria-keyshortcuts="Z"[\s\S]*?<button id="full"/);
  assert.ok(html.indexOf('picture.js') > 0 && html.indexOf('picture.js') < html.indexOf('inspect.js"'), 'picture.js loads before inspect.js');
  assert.match(html, /<div id="panel" class="panel" role="dialog" aria-label="[^"]+" hidden><\/div>/);
  assert.match(html, /<input id="seek" type="range"[^>]*aria-label="Position"/);
  assert.match(html, /<input id="volume" class="range" type="range"[^>]*aria-label="Volume"/);
  assert.match(html, /<button id="time"[^>]*aria-label="Position"/);
  assert.ok(html.indexOf('controls.js') > 0 && html.indexOf('controls.js') < html.indexOf('player-ui.js"'), 'controls.js loads before player-ui.js');
  assert.ok(html.indexOf('modes.js') > 0 && html.indexOf('modes.js') < html.indexOf('player-ui.js"'), 'modes.js (ownsKey) loads before player-ui.js');
  assert.match(html, /<canvas id="canvas"[^>]*role="img" aria-label="Video"/);
  h.dispose();
  console.log('a11y_test: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
