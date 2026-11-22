'use strict';
// node test/host/step_buttons_test.js: the stepButtons setting (buttons beside Play: frame step or the Ctrl+arrow jump
// size) reaches the page in its prefs, a page choice is written only for declared values, and package.json declares it.
const assert = require('assert');
const path = require('path');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const pkg = require('../../package.json').contributes.configuration.properties['videoPreviewEnhanced.stepButtons'];
assert.deepStrictEqual(pkg.enum, ['frame', 'jump']);
assert.strictEqual(pkg.default, 'frame');
assert.ok(/Ctrl\+Left/.test(pkg.markdownDescription));

// Wheel jump sizes: declared with the same values as the other jumps, wired in both pages, Shift+wheel falls back to deltaX.
const props = require('../../package.json').contributes.configuration.properties;
const jumpEnum = props['videoPreviewEnhanced.jump.ctrl'].enum;
assert.deepStrictEqual(props['videoPreviewEnhanced.jump.wheel'].enum, jumpEnum);
assert.strictEqual(props['videoPreviewEnhanced.jump.wheel'].default, 'frame');
assert.deepStrictEqual(props['videoPreviewEnhanced.jump.wheelShift'].enum, jumpEnum);
assert.strictEqual(props['videoPreviewEnhanced.jump.wheelShift'].default, 1);
const fs = require('fs');
for (const f of ['player.js', 'compare.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'media', f), 'utf8');
  assert.ok(src.includes('e.deltaY || (e.shiftKey ? e.deltaX : 0)'), `${f}: Shift+wheel falls back to deltaX (Windows)`);
  assert.ok(src.includes('e.shiftKey ? prefs.jump.wheelShift : prefs.jump.wheel'), `${f}: wheel sizes come from prefs`);
}

(async () => {
  const prefsOf = async (h) => { const s = h.open(clip); await s.shown; return { s, m: /"stepButtons":"(\w+)"/.exec(s.panel.webview.html) }; };
  let h = load({});
  let r = await prefsOf(h);
  assert.strictEqual(r.m && r.m[1], 'frame', 'default: one frame');
  r.s.panel.dispose();
  h = load({ settings: { 'videoPreviewEnhanced.stepButtons': 'jump', 'videoPreviewEnhanced.jump.ctrl': 10 } });
  r = await prefsOf(h);
  assert.strictEqual(r.m && r.m[1], 'jump');
  assert.match(r.s.panel.webview.html, /"ctrl":10/);
  assert.match(r.s.panel.webview.html, /"wheel":"frame","wheelShift":1/, 'wheel defaults reach the page');
  const writes = [];
  const cfg = h.vscode.workspace.getConfiguration;
  h.vscode.workspace.getConfiguration = (...a) => { const c = cfg(...a); const u = c.update; c.update = (k, v, t) => { writes.push([k, v]); return u ? u.call(c, k, v, t) : undefined; }; return c; };
  await r.s.send({ type: 'pref', key: 'stepButtons', value: 'frame' });
  await r.s.send({ type: 'pref', key: 'stepButtons', value: 'bogus' });
  assert.deepStrictEqual(writes, [['stepButtons', 'frame']], 'only declared values are written');
  console.log('step buttons: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
