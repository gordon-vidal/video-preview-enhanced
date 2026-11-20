'use strict';
// node test/host/a11y_test.js: keyboard ownership (media/modes.js ownsKey: which keys the focused
// control keeps from the player's shortcuts) and the accessible names, states and live region in
// the player's and compare's HTML (src/extension.js html(), src/compare.js compareHtml).
// The pages themselves are checked in a real VS Code: test/vscode/cases/ui.js.
const assert = require('assert');
const path = require('path');
const VpeModes = require('../../media/modes');
const { compareHtml } = require('../../src/compare');
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
const pressed = (html, id) => new RegExp(`<button id="${id}"[^>]*aria-pressed="false"`).test(html);
const liveRegion = /<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"><\/div>/;

const cmp = compareHtml({ uri: (...p) => `https://webview/${p.join('/')}`, cspSource: 'vscode-resource:', nonce: 'n', cfg: {}, frameSource: '' });
checkButtons(cmp, 'compare');
assert.match(cmp, liveRegion, 'compare: live region');
assert.ok(pressed(cmp, 'mute'), 'compare: #mute has aria-pressed');
// The player's bar (src/bar.js) without CC and picture-in-picture, plus the Compare button that opens its panel.
assert.match(cmp, /<button id="cmpBtn"[^>]*aria-controls="panel"/);
assert.ok(!/id="tracks"|id="pip"|id="syncBtn"|id="mode"/.test(cmp), 'compare: no CC, PiP or old compare toolbar');
for (const id of ['prev', 'play', 'next', 'mute', 'volume', 'time', 'infoBtn', 'rate', 'cog', 'keysBtn', 'full', 'panel', 'sheet', 'menu']) assert.match(cmp, new RegExp(`id="${id}"`), `compare: #${id}`);
assert.ok(cmp.indexOf('controls.js') > 0 && cmp.indexOf('controls.js') < cmp.indexOf('compare.js"'), 'compare: controls.js (the panels) loads before compare.js');
assert.ok(cmp.indexOf('modes.js') > 0 && cmp.indexOf('modes.js') < cmp.indexOf('compare.js"'), 'compare: modes.js (ownsKey) loads before compare.js');

(async () => {
  const h = load({});
  const s = h.open(path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv'));
  await s.shown;
  const html = s.panel.webview.html;
  assert.ok(html.includes('id="bar"'), 'player page rendered');
  checkButtons(html, 'player');
  assert.match(html, liveRegion, 'player: live region');
  for (const id of ['mute', 'pip']) assert.ok(pressed(html, id), `player: #${id} has aria-pressed`);
  // One layout: no mode switch, no Tools / CC popup menus; the bar's panel buttons say what they open.
  for (const id of ['modeBtn', 'toolsBtn', 'toolsMenu', 'tracksMenu', 'pill']) assert.ok(!html.includes(`id="${id}"`), `player: #${id} is gone`);
  for (const id of ['tracks', 'infoBtn', 'rate', 'cog']) assert.match(html, new RegExp(`<button id="${id}"[^>]*aria-expanded="false" aria-controls="panel"`));
  assert.match(html, /<button id="keysBtn"[^>]*aria-label="Keyboard shortcuts"/);
  assert.match(html, /<div id="panel" class="panel" role="dialog" aria-label="[^"]+" hidden><\/div>/);
  assert.match(html, /<input id="seek" type="range"[^>]*aria-label="Position"/);
  assert.match(html, /<input id="volume" type="range"[^>]*aria-label="Volume"/);
  assert.match(html, /<button id="time"[^>]*aria-label="Position"/);
  assert.ok(html.indexOf('controls.js') > 0 && html.indexOf('controls.js') < html.indexOf('player.js"'), 'controls.js loads before player.js');
  assert.match(html, /<canvas id="canvas"[^>]*role="img" aria-label="Video"/);
  h.dispose();
  console.log('a11y_test: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
