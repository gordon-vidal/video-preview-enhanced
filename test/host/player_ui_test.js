'use strict';
// Millisecond tests for the shared webview UI seam (media/player-ui.js): the helpers media/player.js and
// media/compare.js call in production (keys, bar buttons, step buttons, A–B pins, time readout, Picture size,
// context menu, Folder Rail, Spotlight splitter / Split Wipe divider), the FakeHost protocol
// (tools/mockup/fake-host.js), and create() end to end over the REAL widgets (controls.js, folder-rail.js,
// ctxmenu.js, abloop.js, autoplay.js, picture.js, modes.js) on a tiny permissive fake DOM. Nothing decodes video:
// the fake DOM does not lay out or parse HTML, it only lets the real code run so the gesture paths and the adapter
// contracts (what the page posts, how it answers the host, which bar controls follow the state) are checked
// without a browser or VS Code. docs/TESTING.md "UI and gesture tests without video" explains the split.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../../media/player-state');
const PUI = require('../../media/player-ui');
const { createFakeEngine } = require('../../tools/mockup/fake-engine');
const { createFakeHost } = require('../../tools/mockup/fake-host');
const { buildMockupHtml, SCENARIOS } = require('../../tools/mockup/render');

const T0 = Date.now();
const ROOT = path.join(__dirname, '..', '..');
const playerSrc = fs.readFileSync(path.join(ROOT, 'media', 'player.js'), 'utf8');
const compareSrc = fs.readFileSync(path.join(ROOT, 'media', 'compare.js'), 'utf8');
// The page scripts must still parse: the source checks below read them as text, so a clash with a page's own
// names (Compare already had a `KEYS` of tile letters) would otherwise only show in a real webview.
for (const [name, src] of [['player.js', playerSrc], ['compare.js', compareSrc]]) {
  assert.doesNotThrow(() => new (require('vm').Script)(src, { filename: name }), `${name} parses`);
}
/** A page's key handler table (`const KEY_ACTIONS = { ... };`) as source text. */
const keysOf = (src) => { const i = src.indexOf('const KEY_ACTIONS = {'); assert.ok(i > 0, 'the page has a KEY_ACTIONS table'); return src.slice(i, src.indexOf('\n  };', i)); };
const hasHandler = (src, action) => new RegExp(`\\n    ${action}: `).test(keysOf(src));

// ---- 1. keyCommand: one key table for the player, Compare and create() ----
{
  const k = (key, mods = {}) => PUI.keyAction({ key, ...mods });
  assert.strictEqual(k(' '), 'playPause');
  assert.strictEqual(k('k'), 'playPause');
  assert.strictEqual(k(','), 'prevFrame');
  assert.strictEqual(k('.'), 'nextFrame');
  assert.strictEqual(k('m'), 'mute');
  assert.strictEqual(k('R'), 'loop');
  assert.strictEqual(k('a'), 'setA');
  assert.strictEqual(k('A', { shiftKey: true }), 'setA', 'Shift+A: Compare sets A; the player\'s subtitle keys take it first');
  assert.strictEqual(k('b'), 'setB');
  assert.strictEqual(k('Z'), 'cyclePicture');
  assert.strictEqual(k('Z', { shiftKey: true }), null);
  assert.strictEqual(k('i'), 'info');
  assert.strictEqual(k('?'), 'keys');
  assert.strictEqual(k('Escape'), 'escape');
  assert.strictEqual(k('D', { shiftKey: true }), 'capture');
  assert.strictEqual(k('D'), 'pickVideo', 'D without Shift (Caps Lock) picks, as d does');
  assert.strictEqual(k('N', { shiftKey: true }), 'nextVideo');
  assert.strictEqual(k('N'), null);
  assert.strictEqual(k('P', { shiftKey: true }), 'prevVideo');
  assert.strictEqual(k(',', { ctrlKey: true }), null, 'modified keys are left to VS Code');
  assert.strictEqual(k('q'), null);
  assert.deepStrictEqual(PUI.keyCommand({ key: 'ArrowLeft', shiftKey: true }), { action: 'jump', arg: { dir: -1, shift: true } });
  assert.deepStrictEqual(PUI.keyCommand({ key: 'j' }), { action: 'skip', arg: -10 });
  assert.deepStrictEqual(PUI.keyCommand({ key: ']' }), { action: 'rateStep', arg: 1 });
  assert.deepStrictEqual(PUI.keyCommand({ key: 'ArrowDown' }), { action: 'volumeStep', arg: -0.05 });
  assert.deepStrictEqual(PUI.keyCommand({ key: '7' }), { action: 'seekTenth', arg: 7 });
  assert.strictEqual(PUI.keyCommand({ key: '[', ctrlKey: true, altKey: true }), null, 'Ctrl+Alt+[ is not a player key');
  assert.deepStrictEqual(PUI.keyCommand({ key: '[', ctrlKey: true, altKey: true }, { altGr: true }), { action: 'rateStep', arg: -1 }, 'AltGr types [');
  assert.strictEqual(PUI.keyCommand({ key: 'k', metaKey: true }, { altGr: true }), null, 'Cmd is never a player key');

  // runKey: a missing handler or one that returns false leaves the key; anything else uses it.
  const calls = [];
  const table = { playPause: () => calls.push('pp'), seekTenth: (n) => (n === 0 ? false : calls.push(n)), fullscreen: (_a, e) => calls.push(e.repeat) };
  assert.strictEqual(PUI.runKey({ key: ' ' }, table), true);
  assert.strictEqual(PUI.runKey({ key: '0' }, table), false, 'a handler returning false is not handled');
  assert.strictEqual(PUI.runKey({ key: '5' }, table), true);
  assert.strictEqual(PUI.runKey({ key: 'f', repeat: true }, table), true, 'the event reaches the handler');
  assert.strictEqual(PUI.runKey({ key: 'm' }, table), false, 'no handler: not handled');
  assert.deepStrictEqual(calls, ['pp', 5, true]);

  // The production pages run the same table: what each page handles (and deliberately does not).
  const PARITY = [
    // [key, mods, player handles, Compare handles]
    [' ', {}, true, true], ['j', {}, true, true], ['ArrowRight', {}, true, true], [',', {}, true, true],
    ['[', {}, true, true], ['ArrowUp', {}, true, true], ['Home', {}, true, true], ['End', {}, true, true],
    ['m', {}, true, true], ['r', {}, true, true], ['f', {}, true, true], ['a', {}, true, true], ['b', {}, true, true],
    ['z', {}, true, true], ['i', {}, true, true], ['+', {}, true, true], ['-', {}, true, true],
    ['N', { shiftKey: true }, true, false], ['Backspace', {}, true, false], ['t', {}, true, false],
    ['s', {}, true, false], ['c', {}, true, false], ['w', {}, true, false], ['d', {}, true, false],
    ['D', { shiftKey: true }, true, true], ['5', {}, true, false], ['x', {}, false, true], ['Escape', {}, false, true],
  ];
  for (const [key, mods, inPlayer, inCompare] of PARITY) {
    const c = PUI.keyCommand({ key, ...mods });
    assert.ok(c, `${key} is a key`);
    assert.strictEqual(hasHandler(playerSrc, c.action), inPlayer, `player ${key} -> ${c.action}`);
    assert.strictEqual(hasHandler(compareSrc, c.action), inCompare, `Compare ${key} -> ${c.action}`);
  }
  for (const src of [playerSrc, compareSrc]) {
    assert.ok(src.includes('VpePlayerUi.runKey(e, KEY_ACTIONS, { altGr })'), 'the page dispatches its keys through the shared table');
    assert.ok(!/switch \(e\.key\) \{\s*case ' ': case 'k'/.test(src), 'no second copy of the key switch');
    // Every handler name a page defines is one keyCommand produces (a typo would silently never run).
    const known = new Set(['playPause', 'skip', 'jump', 'prevFrame', 'nextFrame', 'rateStep', 'volumeStep', 'home', 'end',
      'mute', 'loop', 'fullscreen', 'nextVideo', 'prevVideo', 'setA', 'setB', 'clearAB', 'copyTime', 'cyclePicture', 'plus',
      'minus', 'info', 'saveFrame', 'cc', 'scopes', 'swap', 'pickVideo', 'capture', 'keys', 'escape', 'seekTenth']);
    for (const [, name] of keysOf(src).matchAll(/\n {4}(\w+): /g)) assert.ok(known.has(name), `KEY_ACTIONS.${name} is a keyCommand action`);
  }
}

// ---- 2. Time readout, time formats, picture button, copy details ----
{
  assert.strictEqual(PUI.formatTime(48, 24, 0), '0:02.00');
  assert.strictEqual(PUI.formatTime(48, 24, 2), 'frame 49', 'frame numbers count from 1, as on the bar');
  assert.strictEqual(PUI.formatTime(48, 24, 1, (f, r) => `tc${f}@${r}`), 'tc48@24');
  assert.strictEqual(PUI.formatTime(1500, 24, 0), '1:02.50');
  const base = { f: 48, t: 2, dur: 10, fps: 24, nFrames: 240, fmtClock: (s) => `c${s}`, fmtTimecode: (f, r) => `tc${f}@${r}` };
  assert.deepStrictEqual(PUI.timeReadout({ ...base, mode: 0 }), { now: 'c2', dur: '/ c10' });
  assert.deepStrictEqual(PUI.timeReadout({ ...base, mode: 1 }), { now: 'tc48@24', dur: '/ tc240@24' });
  assert.deepStrictEqual(PUI.timeReadout({ ...base, mode: 1, fps: 0 }), { now: 'c2', dur: '/ c10' }, 'no timecode without a frame rate');
  assert.deepStrictEqual(PUI.timeReadout({ ...base, mode: 2 }), { now: 'frame 49', dur: '/ 240' });
  assert.deepStrictEqual(PUI.timeReadout({ ...base, mode: 2, nFrames: 0 }), { now: 'frame 49', dur: '/ ?' });
  assert.deepStrictEqual(PUI.timeReadout({ ...base, mode: 1, live: true }), { now: 'c2', dur: '· LIVE' }, 'a live stream has no end');
  assert.deepStrictEqual([0, 1, 2].map(PUI.nextTimeMode), [1, 2, 0]);
  assert.deepStrictEqual(PUI.TIME_MODE_NAMES, ['Time', 'Timecode', 'Frame number']);
  for (const src of [playerSrc, compareSrc]) {
    assert.ok(src.includes('VpePlayerUi.timeReadout({'), 'the page draws the time through the shared readout');
    assert.ok(src.includes('VpePlayerUi.TIME_MODE_NAMES['), 'the time click toasts the shared names');
  }

  const VpePicture = require('../../media/picture');
  const btn = { dataset: {}, title: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  PUI.pictureButton(btn, VpePicture, 'fit');
  assert.strictEqual(btn.dataset.mode, 'fit');
  assert.match(btn.title, /^Picture size: Fit \([^)]+\)\. Click for Fill {2}Z$/);
  assert.strictEqual(btn.attrs['aria-label'], 'Picture size: Fit. Next: Fill');
  PUI.pictureButton(btn, VpePicture, 'actual', 'all videos');
  assert.match(btn.title, /^Picture size: 100% \([^)]+\), all videos\. Click for Fit {2}Z$/, 'Compare names its scope');
  assert.doesNotThrow(() => PUI.pictureButton(null, VpePicture, 'fit'));

  assert.strictEqual(PUI.copyInfoText({ title: 'a.mp4', sub: 'H.264', rows: [['Size', '1920×1080'], ['FPS', '24']] }), 'a.mp4\nH.264\nSize: 1920×1080\nFPS: 24');
}

// ---- 2b. Bar buttons, step buttons, A–B pins, menu, rail, Compare gestures: the shared helpers ----
{
  // bindButtons: the onclick property (production) or a listener (create), with the stop flag per entry.
  const mk = () => ({ onclick: null, on: [] });
  const play = mk(), cog = mk();
  const ran = [];
  PUI.bindButtons([[play, () => ran.push('play')], [cog, () => ran.push('cog'), true], [null, () => ran.push('none')]]);
  let stopped = 0;
  play.onclick({ stopPropagation: () => stopped++ });
  cog.onclick({ stopPropagation: () => stopped++ });
  cog.onclick();
  assert.deepStrictEqual(ran, ['play', 'cog', 'cog']);
  assert.strictEqual(stopped, 1, 'only entries with stop keep the click from the stage');
  const added = [];
  PUI.bindButtons([[play, () => ran.push('x'), true]], (el, fn) => added.push([el, fn]));
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0][0], play);

  // stepBy: the badge's size, else one frame / the Ctrl+arrow jump (setting stepButtons).
  const VpeControls = require('../../media/controls');
  const moves = [];
  const go = { step: (n) => moves.push(['f', n]), skip: (s) => moves.push(['s', s]) };
  PUI.stepBy(VpeControls, { stepSize: null, stepButtons: 'frame', jump: { ctrl: 10 } }, 1, go);
  PUI.stepBy(VpeControls, { stepSize: 'frames5', stepButtons: 'frame', jump: { ctrl: 10 } }, -1, go);
  PUI.stepBy(VpeControls, { stepSize: 5, stepButtons: 'frame', jump: { ctrl: 10 } }, 1, go);
  PUI.stepBy(VpeControls, { stepSize: null, stepButtons: 'jump', jump: { ctrl: 10 } }, -1, go);
  assert.deepStrictEqual(moves, [['f', 1], ['f', -5], ['s', 5], ['s', -10]]);
  for (const src of [playerSrc, compareSrc]) assert.ok(src.includes('VpePlayerUi.stepBy(VpeControls, prefs,'), 'the page steps through stepBy');

  // bindStepBadges: the badge opens the size popover and never reaches the step button.
  const badge = { l: {}, addEventListener(t, fn) { this.l[t] = fn; } };
  const opened = [];
  PUI.bindStepBadges([badge, null], (b) => opened.push(b));
  let badgeStopped = false;
  badge.l.click({ stopPropagation: () => { badgeStopped = true; } });
  assert.deepStrictEqual([opened[0] === badge, badgeStopped], [true, true]);

  // bindAbPins over a fake VpeAbLoop: the pin follows the snapped frame, the tip says where, commit only when ready.
  const bound = {};
  const fakeAb = { bindPin: (pin, which, cfg) => { bound[which] = { pin, cfg }; } };
  const pinA = { style: {} }, pinB = { style: {} };
  const tip = { style: {}, hidden: true, textContent: '' };
  const seek = { getBoundingClientRect: () => ({ left: 100, width: 400 }) };
  let ready = false;
  const commits = [];
  PUI.bindAbPins(fakeAb, { a: pinA, b: pinB, seek, tip }, {
    ready: () => ready, n: () => 101, fps: () => 25, dur: () => 4, tipLabel: (s) => `t${s.t}`,
    commit: (w, s) => commits.push([w, s.f]), end: () => commits.push('end'),
  });
  assert.deepStrictEqual(Object.keys(bound), ['a', 'b']);
  assert.strictEqual(bound.a.cfg.n(), 0, 'no video yet: no frames');
  bound.a.cfg.move('a', { f: 50, t: 2 }, 300);
  assert.strictEqual(pinA.style.left, undefined, 'no move before the video is ready');
  bound.a.cfg.commit('a', { f: 50, t: 2 });
  assert.deepStrictEqual(commits, []);
  ready = true;
  bound.b.cfg.move('b', { f: 50, t: 2 }, 300);
  assert.strictEqual(pinB.style.left, '50%');
  assert.deepStrictEqual([tip.textContent, tip.style.left, tip.hidden], ['B t2 · #51', '200px', false]);
  bound.b.cfg.move('b', { f: 0, t: 0 }, 0);
  assert.strictEqual(tip.style.left, '30px', 'the tip stays on the bar');
  bound.b.cfg.commit('b', { f: 50, t: 2 });
  bound.b.cfg.end();
  assert.deepStrictEqual(commits, [['b', 50], 'end']);
  assert.strictEqual(PUI.pinPercent({ f: 0, t: 1 }, 1, 4), 25, 'one frame: by time');
  assert.strictEqual(PUI.pinPercent({ f: 0, t: 1 }, 0, 0), 0);

  // createContextMenu: menu items run the page's named actions; unknown items do nothing.
  let menuEnv = null;
  const fakeMenu = { create: (env) => { menuEnv = env; return { env }; } };
  const hits = [];
  PUI.createContextMenu(fakeMenu, { menu: 'm', getState: () => ({}), actions: { copyTime: () => hits.push('t') } });
  menuEnv.run('copyTime');
  menuEnv.run('nope');
  assert.deepStrictEqual(hits, ['t']);
  assert.ok(!('container' in menuEnv), 'no container unless the page gives one (ctxmenu.js defaults to body)');

  // createFolderRail: null without #rail or the script (URLs, image sequences), else the real rail's options.
  let railOpts = null;
  const fakeRail = { create: (o) => { railOpts = o; return { go: (d) => hits.push(`go${d}`) }; } };
  const docWith = (has) => ({ getElementById: (id) => (has && id === 'rail' ? {} : null) });
  assert.strictEqual(PUI.createFolderRail(fakeRail, docWith(false), {}), null);
  assert.strictEqual(PUI.createFolderRail(null, docWith(true), {}), null);
  const doc = docWith(true);
  const rail = PUI.createFolderRail(fakeRail, doc, { compare: true });
  assert.deepStrictEqual([railOpts.doc, railOpts.compare], [doc, true]);
  const posted = [];
  PUI.goNeighbour(rail, (m) => posted.push(m), 1);
  PUI.goNeighbour(null, (m) => posted.push(m), -1);
  assert.deepStrictEqual([hits.pop(), posted], ['go1', [{ type: 'neighbour', d: -1 }]], 'the rail when there is one, else the host');

  // Spotlight splitter and Split Wipe divider: pointer and keys, by dock.
  assert.strictEqual(PUI.spotlightRatioAt('top', 0, 100, 400, 400), 0.25);
  assert.strictEqual(PUI.spotlightRatioAt('bottom', 0, 100, 400, 400), 0.75);
  assert.strictEqual(PUI.spotlightRatioAt('left', 300, 0, 400, 400), 0.75);
  assert.strictEqual(PUI.spotlightRatioAt('right', 300, 0, 400, 400), 0.25);
  const kr = (key, dock, shiftKey = false) => PUI.spotlightKeyRatio({ key, shiftKey }, dock, 0.5, 0.1, 0.9);
  assert.ok(Math.abs(kr('ArrowDown', 'top') - 0.55) < 1e-9);
  assert.ok(Math.abs(kr('ArrowDown', 'bottom') - 0.45) < 1e-9);
  assert.ok(Math.abs(kr('ArrowUp', 'top', true) - 0.4) < 1e-9, 'Shift: 10 %');
  assert.ok(Math.abs(kr('ArrowRight', 'left') - 0.55) < 1e-9);
  assert.ok(Math.abs(kr('ArrowLeft', 'right') - 0.55) < 1e-9);
  assert.strictEqual(kr('ArrowLeft', 'top'), null, 'across the dock: not a splitter key');
  assert.deepStrictEqual([kr('Home', 'top'), kr('End', 'left'), kr('x', 'top')], [0.1, 0.9, null]);
  const sk = (key, shiftKey = false) => PUI.splitKeyRatio({ key, shiftKey }, 0.5);
  assert.ok(Math.abs(sk('ArrowRight') - 0.51) < 1e-9);
  assert.ok(Math.abs(sk('ArrowDown') - 0.49) < 1e-9);
  assert.ok(Math.abs(sk('ArrowLeft', true) - 0.4) < 1e-9);
  assert.ok(Math.abs(sk('PageUp') - 0.6) < 1e-9);
  assert.deepStrictEqual([sk('Home'), sk('End'), sk('Enter')], [0, 1, null]);

  // The production pages call these helpers rather than carrying their own copies.
  const uses = {
    player: [playerSrc, ['bindButtons([', 'bindStepBadges(', 'bindAbPins(self.VpeAbLoop', 'pictureButton(ui.picBtn',
      'copyInfoText(d)', 'createContextMenu(VpeCtxMenu', 'createFolderRail(', 'goNeighbour(rail']],
    compare: [compareSrc, ['bindButtons([', 'bindStepBadges(', 'bindAbPins(self.VpeAbLoop', 'pictureButton(ui.picBtn',
      'copyInfoText(d)', 'createFolderRail(', 'spotlightRatioAt(st.dock', 'spotlightKeyRatio(e, st.dock', 'splitKeyRatio(e, st.split']],
  };
  for (const [name, [src, calls]] of Object.entries(uses)) {
    for (const c of calls) assert.ok(src.includes(`VpePlayerUi.${c}`), `${name}: calls VpePlayerUi.${c}`);
    for (const old of ['self.VpeAbLoop.bindPin(', 'VpeCtxMenu.create(', 'VpeFolderRail.create(', 'ui.play.onclick =', 'ui.picBtn.onclick =']) {
      assert.ok(!src.includes(old), `${name}: no local copy of ${old}`);
    }
  }
}

// ---- 3. applyHostMessage: the pure half of host -> page ----
{
  const getClip = (id) => ({ id, name: `${id}.mp4` });
  let ws = S.createWorkspaceState({ tiles: ['clip-0'] });
  let r = PUI.applyHostMessage(S, ws, { type: 'nope' }, getClip);
  assert.strictEqual(r.handled, false);
  assert.strictEqual(r.state, ws);

  r = PUI.applyHostMessage(S, ws, { type: 'openVideo', clipId: 'clip-1', replace: true }, getClip);
  assert.deepStrictEqual(S.getTab(r.state).tiles, ['clip-1'], 'replace swaps the single video in place');

  r = PUI.applyHostMessage(S, ws, { type: 'openVideo', clipId: 'clip-2', compare: true }, getClip);
  assert.deepStrictEqual(S.getTab(r.state).tiles, ['clip-0', 'clip-2'], 'compare turns capture on and joins');
  assert.strictEqual(S.getTab(r.state).capture, true);
  assert.ok(r.toast.includes('clip-2.mp4'));

  ws = r.state;
  r = PUI.applyHostMessage(S, ws, { type: 'openVideo', clipId: 'clip-3', replace: true }, getClip);
  assert.deepStrictEqual(S.getTab(r.state).tiles, ['clip-0', 'clip-2', 'clip-3'], 'replace in Compare falls back to open (capture joins)');
}

// ---- 4. replaceVideo (player-state) and compareRows ----
{
  let ws = S.createWorkspaceState({ tiles: ['clip-0'], capture: true, frame: 30 });
  ws = S.replaceVideo(ws, 'clip-4');
  const t = S.getTab(ws);
  assert.deepStrictEqual(t.tiles, ['clip-4']);
  assert.strictEqual(t.capture, true, 'navigation keeps capture');
  assert.strictEqual(t.frame, 0);
  const multi = S.openVideo(ws, 'clip-1').state;
  assert.strictEqual(S.replaceVideo(multi, 'clip-2'), multi, 'multi-video tabs are left alone');

  const rows = PUI.compareRows(S, S.getTab(S.nudgeOffset(multi, 'clip-1', -3)), (id) => ({ id, name: id.toUpperCase() }));
  assert.deepStrictEqual(rows.map((r) => [r.letter, r.name, r.offText]), [['A', 'CLIP-4', '+0 f'], ['B', 'CLIP-1', '-3 f']]);
}

// ---- 5. FakeHost: the folder rail protocol of src/folder-rail.js, in Node ----
{
  const engine = createFakeEngine();
  const out = [];
  const host = createFakeHost({ clips: engine.clips, deliver: (m) => out.push(m) });
  host.post({ type: 'tiles', tabId: 1, tiles: ['clip-1'], current: 'clip-1' });
  assert.deepStrictEqual(out.shift(), { type: 'rail', op: 'pos', index: 1, count: 4 });
  host.post({ type: 'rail', op: 'open' });
  const list = out.shift();
  assert.strictEqual(list.op, 'list');
  assert.strictEqual(list.current, 'clip-1');
  assert.deepStrictEqual(list.entries.map((e) => e.kind), ['dir', 'video', 'video', 'video', 'video', 'file']);
  const meta = out.shift();
  assert.strictEqual(meta.op, 'meta');
  assert.strictEqual(meta.gen, list.gen, 'meta answers the same listing');
  assert.ok(Array.isArray(meta.patches) && meta.patches.every((p) => typeof p.id === 'string'), 'meta carries patches[] like src/folder-rail.js');
  assert.strictEqual(out.shift().op, 'pos');

  host.post({ type: 'rail', op: 'activate', gen: list.gen, id: 'clip-2' });
  assert.deepStrictEqual(out.shift(), { type: 'openVideo', clipId: 'clip-2', label: engine.getClip('clip-2').name, replace: true });
  host.post({ type: 'rail', op: 'compare', gen: list.gen, id: 'clip-3' });
  assert.strictEqual(out.shift().compare, true);
  host.post({ type: 'rail', op: 'activate', gen: list.gen - 1, id: 'clip-2' });
  assert.strictEqual(out.length, 0, 'a stale listing generation is ignored');

  host.post({ type: 'rail', op: 'browse', gen: list.gen, id: 'dir:renders' });
  const sub = out.shift();
  assert.ok(sub.crumb.endsWith('renders'));
  assert.strictEqual(sub.entries[0].kind, 'up');
  out.length = 0;
  host.post({ type: 'rail', op: 'browse', gen: sub.gen, id: 'up:root' });
  assert.strictEqual(out.shift().from, 'dir:renders', 'walking up puts the cursor on the folder walked out of');
  out.length = 0;

  host.post({ type: 'neighbour', d: 1 });
  assert.strictEqual(out.shift().clipId, 'clip-2');
  host.post({ type: 'neighbour', d: -1 });
  assert.strictEqual(out.shift().clipId, 'clip-0');
  host.post({ type: 'pickVideo', exclude: ['clip-0', 'clip-1'] });
  assert.deepStrictEqual([out[0].clipId, out[0].compare], ['clip-2', true]);
  out.length = 0;
  host.post({ type: 'saveFrame' });
  assert.strictEqual(out.shift().type, 'toast');
}

// ---- 6. create() validates its adapters before touching the DOM ----
{
  assert.throws(() => PUI.create(/** @type {any} */ ({})), /env\.doc/);
  assert.throws(() => PUI.create(/** @type {any} */ ({ doc: {}, stateApi: {} })), /stateApi/);
  assert.throws(() => PUI.create(/** @type {any} */ ({ doc: {}, stateApi: S, engine: {} })), /engine/);
  assert.throws(() => PUI.create(/** @type {any} */ ({ doc: {}, stateApi: S, engine: createFakeEngine(), host: {} })), /host/);
}

// ---- 7. create() end to end: real widgets, fake DOM, FakeEngine + FakeHost ----
const fakeDom = () => {
  const byId = new Map();
  /** @param {string} tag */
  function node(tag) {
    const store = new Map();
    const listeners = new Map();
    const attrs = new Map();
    const classes = new Set();
    const children = [];
    const self = new Proxy(function () {}, {
      apply: () => node('ret'),
      set: (_t, p, v) => { store.set(p, v); return true; },
      get: (_t, p) => {
        if (store.has(p)) return store.get(p);
        switch (p) {
          case Symbol.iterator: return function* () { yield* children; };
          case Symbol.toPrimitive: return () => '';
          case 'then': return undefined;
          case 'tagName': return String(tag).toUpperCase();
          case 'hidden': case 'disabled': case 'checked': case 'isContentEditable': return false;
          case 'isConnected': return true;
          case 'textContent': case 'innerHTML': case 'value': case 'title': case 'id': return '';
          case 'clientWidth': return 680;
          case 'clientHeight': return 370;
          case 'children': case 'childNodes': return children;
          case 'firstChild': return children[0] || null;
          case 'parentNode': case 'parentElement': return store.get('__parent') || null;
          case 'classList': return {
            add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
            toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
            contains: (c) => classes.has(c),
          };
          case 'style': { const st = { setProperty: () => {}, removeProperty: () => {} }; store.set('style', st); return st; }
          case 'dataset': { const d = {}; store.set('dataset', d); return d; }
          case 'addEventListener': return (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); };
          case 'removeEventListener': return (type, fn) => { const l = listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
          case 'fire': return (type, ev = {}) => {
            const e = { target: self, currentTarget: self, preventDefault() { e.defaultPrevented = true; }, stopPropagation() {}, ...ev };
            for (const fn of (listeners.get(type) || []).slice()) fn(e);
            return e;
          };
          case 'listenerCount': return (type) => (listeners.get(type) || []).length;
          case 'setAttribute': return (k, v) => attrs.set(k, String(v));
          case 'getAttribute': return (k) => (attrs.has(k) ? attrs.get(k) : null);
          case 'removeAttribute': return (k) => attrs.delete(k);
          case 'hasAttribute': return (k) => attrs.has(k);
          case 'appendChild': return (c) => { children.push(c); if (c && typeof c === 'function') c.__parent = self; return c; };
          case 'insertBefore': return (c) => { children.unshift(c); if (c && typeof c === 'function') c.__parent = self; return c; };
          case 'append': case 'prepend': case 'replaceChildren': return (...cs) => { children.push(...cs); };
          case 'remove': return () => {};
          case 'querySelector': case 'closest': return () => null;
          case 'querySelectorAll': return () => [];
          case 'contains': return (x) => x === self;
          case 'getBoundingClientRect': return () => ({ left: 0, top: 0, right: 680, bottom: 370, width: 680, height: 370, x: 0, y: 0 });
          case 'getClientRects': return () => [{}];
          case 'getElementById': return (id) => { if (!byId.has(id)) { const n = node('div'); n.id = id; byId.set(id, n); } return byId.get(id); };
          case 'createElement': return (t) => node(t);
          case 'createDocumentFragment': return () => node('#fragment');
          case 'createTextNode': return () => node('#text');
          default: { const n = node('auto'); store.set(p, n); return n; }
        }
      },
    });
    return self;
  }
  const doc = node('#document');
  doc.body = node('body');
  doc.activeElement = doc.body;
  const timers = [];
  const win = node('#window');
  win.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  win.clearInterval = (id) => { timers[id - 1] = null; };
  win.ResizeObserver = undefined;
  win.innerWidth = 1024;
  win.innerHeight = 768;
  win.devicePixelRatio = 1;
  return { doc, win, byId, timers, $: (id) => doc.getElementById(id) };
};

{
  const dom = fakeDom();
  // As in the real markup (src/player-html.js, src/folder-rail-html.js): popups and the rail start hidden.
  for (const id of ['panel', 'sheet', 'ctxmenu', 'rail', 'railHover', 'railColMenu', 'railEndMenu', 'capBanner', 'splitter', 'divider']) dom.$(id).hidden = true;
  // The widgets read a few browser globals directly (matchMedia for reduced motion, animation frames).
  const GLOBALS = {
    document: dom.doc, window: dom.win,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, HTMLElement: function HTMLElement() {},
  };
  const saved = Object.fromEntries(Object.keys(GLOBALS).map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
  Object.assign(global, GLOBALS);
  try {
    const widgets = {
      VpeControls: require('../../media/controls'),
      VpeFolderRail: require('../../media/folder-rail'),
      VpeCtxMenu: require('../../media/ctxmenu'),
      VpeAbLoop: require('../../media/abloop'),
      VpeAutoplay: require('../../media/autoplay'),
      VpeTime: require('../../media/timefmt'),
      VpePicture: require('../../media/picture'),
      VpeModes: require('../../media/modes'),
    };
    // Capture the env the controller hands the real ctxmenu.js, to run its items as a click on them would.
    let menuEnv = null;
    const realMenu = widgets.VpeCtxMenu;
    widgets.VpeCtxMenu = { ...realMenu, create: (env) => { menuEnv = env; return realMenu.create(env); } };
    const engine = createFakeEngine();
    const drawn = [];
    const spyEngine = { ...engine, draw: (cv, id, frame, opts) => drawn.push({ id, frame, split: opts && opts.splitClipRatio }) };
    const host = createFakeHost({ clips: engine.clips });
    const changes = [];
    const ui = PUI.create({
      doc: dom.doc, win: dom.win, stateApi: S, engine: spyEngine, host, widgets,
      initial: { tiles: ['clip-0'] }, tickMs: 42, onChange: (ws, d) => changes.push(d),
    });
    host.connect(ui.onHostMessage);
    const $ = dom.$;
    const tab = () => S.getTab(ui.getState());

    // Every documented action is reachable by name.
    for (const a of ['playPause', 'prevFrame', 'nextFrame', 'mute', 'loop', 'setA', 'setB', 'clearAB', 'cyclePicture',
      'info', 'keys', 'escape', 'capture', 'split', 'sync', 'layout', 'enlarge', 'removeTile', 'nudge', 'leaveCompare',
      'pickVideo', 'nextVideo', 'prevVideo', 'cycleTime', 'fullscreen', 'seek', 'volume']) {
      assert.ok(ui.actions().includes(a), `action ${a}`);
    }

    ui.render();
    assert.ok(changes.length > 0, 'onChange runs after render');
    assert.deepStrictEqual(host.log.find((m) => m.type === 'tiles'), { type: 'tiles', tabId: 1, tiles: ['clip-0'], current: 'clip-0' },
      'the page tells the host which videos it shows');
    assert.strictEqual(drawn[drawn.length - 1].id, 'clip-0', 'the engine adapter draws the tile');
    assert.strictEqual($('splitBtn').hidden, true, 'Split only at N = 2');
    assert.strictEqual($('syncBtn').hidden, true, 'Sync only at N >= 2');
    assert.strictEqual($('tracks').hidden, false, 'CC at N = 1');

    // The real #bar buttons drive the state.
    $('play').fire('click');
    assert.strictEqual(tab().playing, true, '#play toggles playback');
    assert.strictEqual(dom.timers.filter(Boolean).length, 1, 'one playback clock');
    dom.timers[0].fn();
    assert.strictEqual(tab().frame, 49, 'the clock advances one frame while playing');
    $('prev').fire('click');
    assert.deepStrictEqual([tab().playing, tab().frame], [false, 48], '#prev pauses and steps back');
    $('next').fire('click');
    assert.strictEqual(tab().frame, 49);
    $('seek').value = '120';
    $('seek').fire('input');
    assert.strictEqual(tab().frame, 120, '#seek seeks');
    $('mute').fire('click');
    assert.strictEqual(ui.getPrefs().muted, false, '#mute toggles');
    $('time').fire('click');
    assert.strictEqual(ui.getPrefs().timeMode, 1, 'clicking the time cycles the format');
    assert.strictEqual($('now').textContent, widgets.VpeTime.fmtTimecode(120, 24));
    $('picBtn').fire('click');
    assert.strictEqual(ui.getPrefs().picMode, 'fill', 'Picture size cycles');
    assert.strictEqual($('picBtn').dataset.mode, 'fill', 'the button follows (shared pictureButton)');
    assert.match($('picBtn').title, /^Picture size: Fill .*Click for Stretch {2}Z$/);
    $('time').fire('click');
    assert.deepStrictEqual([$('now').textContent, $('dur').textContent], ['frame 121', '/ 241'], 'frame numbers, as in the player');
    $('time').fire('click');
    assert.strictEqual(ui.getPrefs().timeMode, 0, 'back to the clock');
    assert.strictEqual($('now').textContent, '0:05.00');

    // Keyboard shortcuts.
    const key = (k, mods = {}) => dom.doc.fire('keydown', { key: k, target: dom.doc.body, ...mods });
    key(',');
    assert.strictEqual(tab().frame, 119, ', steps back');
    key('.');
    key('.');
    assert.strictEqual(tab().frame, 121, '. steps forward');
    key(' ');
    assert.strictEqual(tab().playing, true, 'Space plays');
    key(' ');
    key('a');
    assert.ok(ui.ab.a !== null, 'A sets the range start');
    key('b');
    assert.ok(ui.ab.b !== null || ui.ab.a !== null, 'B sets the range end');
    key('Backspace');
    assert.strictEqual(ui.ab.isSet(), false, 'Backspace clears A–B');
    key('r');
    assert.strictEqual(ui.getPrefs().onEnd, 'loop', 'R loops');

    // The rest of the shared key table (media/player-ui.js keyCommand), as media/player.js runs it.
    key('Home');
    assert.strictEqual(tab().frame, 0, 'Home');
    key('End');
    assert.strictEqual(tab().frame, tab().maxFrame, 'End');
    key('5');
    assert.strictEqual(tab().frame, 120, '5 jumps to 50 %');
    key('Home');
    key('l');
    assert.strictEqual(tab().frame, 240, 'L skips 10 s');
    key('j');
    assert.strictEqual(tab().frame, 0, 'J skips back 10 s');
    key('ArrowRight');
    assert.strictEqual(tab().frame, 120, '→ jumps 5 s');
    key('ArrowLeft', { shiftKey: true });
    assert.strictEqual(tab().frame, 96, 'Shift+← jumps 1 s');
    const rate0 = ui.getPrefs().rate;
    key(']');
    assert.ok(ui.getPrefs().rate > rate0, '] speeds up');
    key('[');
    assert.strictEqual(ui.getPrefs().rate, rate0, '[ slows down');
    const altGr = dom.doc.fire('keydown', { key: ']', ctrlKey: true, altKey: true, target: dom.doc.body, getModifierState: (m) => m === 'AltGraph' });
    assert.strictEqual(altGr.defaultPrevented, true, 'AltGr+] (typed ]) is a player key');
    key('[');
    const ctrlKey = dom.doc.fire('keydown', { key: ',', ctrlKey: true, target: dom.doc.body });
    assert.strictEqual(ctrlKey.defaultPrevented, undefined, 'Ctrl+, goes to VS Code');
    const vol0 = ui.getPrefs().volume;
    key('ArrowDown');
    assert.ok(Math.abs(ui.getPrefs().volume - (vol0 - 0.05)) < 1e-9, '↓ lowers the volume');
    key('ArrowUp');
    const copies = host.log.filter((m) => m.type === 'copyText').length;
    key('t');
    assert.strictEqual(host.log.filter((m) => m.type === 'copyText').length, copies + 1, 'T copies the time');
    key('s');
    assert.ok(host.log.some((m) => m.type === 'saveFrame'), 'S asks the host to save the frame');
    const unknown = dom.doc.fire('keydown', { key: 'q', target: dom.doc.body });
    assert.strictEqual(unknown.defaultPrevented, undefined, 'unknown keys are left alone');

    // A–B pins: the real abloop.js drag over the shared bindAbPins (the same path as both pages).
    $('abA').fire('pointerdown', { clientX: 340, pointerId: 1, button: 0 });
    assert.strictEqual($('abA').style.left, '50%', 'the pin follows the pointer to the nearest frame');
    assert.match($('tip').textContent, /^A 0:05\.00 · #121$/, 'the tip names the end, the time and the frame');
    $('abA').fire('pointerup', { clientX: 340, pointerId: 1 });
    assert.strictEqual(ui.ab.a, 5, 'dropping the pin sets A at that frame');
    assert.strictEqual($('tip').hidden, true, 'the tip goes away');
    key('Backspace');

    // Right-click menu items run the same actions as the keys (the env ctxmenu.js gets).
    assert.deepStrictEqual([menuEnv.getState().ready, menuEnv.getState().compareOpen], [true, false]);
    menuEnv.run('setA');
    assert.ok(ui.ab.isSet(), 'menu: Set Range Start');
    menuEnv.run('clearAB');
    assert.strictEqual(ui.ab.isSet(), false, 'menu: Clear A–B Range');
    menuEnv.run('copyTime');
    assert.strictEqual(host.log.filter((m) => m.type === 'copyText').length, copies + 2, 'menu: Copy Timestamp');
    menuEnv.run('cog');
    assert.strictEqual(ui.controls.view(), 'main', 'menu: Settings… opens ⚙');
    key('Escape');
    $('stage').fire('contextmenu', { clientX: 20, clientY: 20 });
    assert.strictEqual(ui.ctxMenu.isOpen(), true, 'a right-click on the stage opens the menu');
    key('Escape');
    assert.strictEqual(ui.ctxMenu.isOpen(), false, 'Esc closes it');
    const typed = dom.doc.fire('keydown', { key: ',', target: { nodeType: 1, tagName: 'INPUT', type: 'text' } });
    assert.strictEqual(typed.defaultPrevented, undefined, 'keys typed into the rail filter are left alone');
    key('?');
    assert.strictEqual(ui.controls.sheetOpen(), true, '? opens the shortcuts sheet');
    key('Escape');
    assert.strictEqual(ui.controls.anyOpen(), false, 'Esc closes it');
    key('i');
    assert.strictEqual(ui.controls.view(), 'info', 'I opens About this video');
    key('Escape');

    // The real Folder Rail through FakeHost: open, list, activate, ‹ / ›.
    ui.rail.show();
    let snap = ui.rail.snapshot();
    assert.strictEqual(snap.open, true);
    assert.ok(snap.crumb.includes('dailies'), 'the host listed the folder');
    assert.ok(host.log.some((m) => m.type === 'rail' && m.op === 'open'), 'the rail posts its own open');
    const listGen = host.snapshot().gen;
    host.post({ type: 'rail', op: 'activate', gen: listGen, id: 'clip-2' });
    assert.deepStrictEqual(tab().tiles, ['clip-2'], 'activating a rail row opens that video in place');
    key('N', { shiftKey: true });
    assert.ok(host.log.some((m) => m.type === 'neighbour' && m.d === 1), 'Shift+N asks the host for the next video');
    assert.deepStrictEqual(tab().tiles, ['clip-3']);
    key('P', { shiftKey: true });
    assert.deepStrictEqual(tab().tiles, ['clip-2']);

    // Compare: capture, + compare from the rail, the bar follows N.
    key('D', { shiftKey: true });
    assert.strictEqual(tab().capture, true, 'Shift+D toggles capture');
    host.post({ type: 'rail', op: 'compare', gen: host.snapshot().gen, id: 'clip-0' });
    assert.deepStrictEqual(tab().tiles, ['clip-2', 'clip-0'], '+ compare joins the view');
    assert.strictEqual($('splitBtn').hidden, false, 'Split appears at N = 2');
    assert.strictEqual($('syncBtn').hidden, false, 'Sync appears at N >= 2');
    assert.strictEqual($('tracks').hidden, true, 'CC hides in Compare');
    assert.strictEqual($('folderCap').hidden, true, 'the folder capsule hides in Compare');
    const tilesMsg = host.log.filter((m) => m.type === 'tiles').pop();
    assert.deepStrictEqual(tilesMsg.tiles, ['clip-2', 'clip-0']);
    assert.strictEqual(menuEnv.getState().compareOpen, true, 'the menu offers Add to Compare now');

    // Cell DOM reuse: playback ticks redraw the same .cell nodes, so a click or double-click mid-playback lands.
    const cellsEl = $('cells');
    const nCells = cellsEl.children.length;
    const cellOf = (id) => cellsEl.children.slice(-tab().tiles.length).find((c) => c.dataset.clip === id);
    const cellA = cellOf('clip-2');
    assert.ok(cellA && cellOf('clip-0'), 'one cell per tile');
    $('play').fire('click');
    const drawn0 = drawn.length;
    for (let i = 0; i < 5; i++) dom.timers.filter(Boolean)[0].fn();
    assert.strictEqual(cellsEl.children.length, nCells, 'ticks do not rebuild the cells');
    assert.strictEqual(cellOf('clip-2'), cellA, 'the same node');
    assert.ok(drawn.length >= drawn0 + 10, 'each tick draws both tiles');
    cellA.fire('click', {});
    assert.strictEqual(tab().playing, false, 'a click on a tile mid-playback pauses');
    cellA.fire('dblclick', {});
    assert.deepStrictEqual([tab().layout, tab().spotlightId], ['spotlight', 'clip-2'], 'double-click enlarges that tile');
    key('Escape');
    assert.strictEqual(tab().layout, 'grid', 'Esc collapses Spotlight');

    $('splitBtn').fire('click');
    assert.strictEqual(tab().layout, 'split', 'Split Wipe');
    assert.strictEqual($('divider').hidden, false, 'the divider shows');
    assert.ok(drawn.some((d) => d.split === tab().split), 'tile B is drawn clipped at the divider');
    // The divider: Compare's keys (shared splitKeyRatio) and a drag.
    const sp0 = tab().split;
    $('divider').fire('keydown', { key: 'ArrowRight' });
    assert.ok(Math.abs(tab().split - (sp0 + 0.01)) < 1e-9, '→ moves the divider 1 %');
    $('divider').fire('keydown', { key: 'End' });
    assert.strictEqual(tab().split, 0.95, 'End: as far as player-state allows');
    $('divider').fire('pointerdown', {});
    dom.win.fire('pointermove', { clientX: 170, clientY: 10 });
    dom.win.fire('pointerup', {});
    assert.strictEqual(tab().split, 0.25, 'dragging the divider');
    assert.strictEqual(dom.win.listenerCount('pointermove'), 0, 'the drag lets go of the window');
    $('syncBtn').fire('click');
    assert.strictEqual(tab().syncMode, true);

    ui.controls.show('cmp', $('startCompareBtn'));
    assert.strictEqual(ui.controls.view(), 'cmp', 'the Compare page renders over the unified state');
    ui.dispatch('layout', 'spotlight');
    assert.strictEqual(tab().layout, 'spotlight');
    assert.strictEqual($('splitter').hidden, false, 'the Spotlight splitter shows');
    // The splitter: Compare's keys (shared spotlightKeyRatio) and a drag along the dock (shared spotlightRatioAt).
    const hr0 = tab().heroRatio;
    $('splitter').fire('keydown', { key: 'ArrowDown' });
    assert.ok(Math.abs(tab().heroRatio - Math.min(0.9, hr0 + 0.05)) < 1e-9, '↓ grows the main tile (dock top)');
    $('splitter').fire('keydown', { key: 'Home' });
    assert.ok(Math.abs(tab().heroRatio - 0.1) < 1e-9, 'Home: smallest');
    $('splitter').fire('pointerdown', {});
    dom.win.fire('pointermove', { clientX: 0, clientY: 111 });
    dom.win.fire('pointerup', {});
    assert.ok(Math.abs(tab().heroRatio - 0.3) < 1e-9, 'dragging the splitter');
    key('Escape');
    key('Escape');
    assert.strictEqual(tab().layout, 'grid', 'Esc collapses Spotlight once the panels are closed');

    key('d');
    assert.ok(host.log.some((m) => m.type === 'pickVideo'), 'D asks the host for another video');
    assert.strictEqual(tab().tiles.length, 3, '+ Add video asks the host and joins its answer');
    ui.dispatch('nudge', 'clip-0', 2);
    assert.strictEqual(tab().offsets['clip-0'], 2);
    ui.dispatch('removeTile', 'clip-0');
    assert.deepStrictEqual(tab().tiles.includes('clip-0'), false);
    ui.dispatch('leaveCompare');
    assert.strictEqual(tab().tiles.length, 1, 'Leave compare keeps A');
    assert.strictEqual($('tracks').hidden, false, 'single-video controls come back');

    // Bar commands the page cannot do itself go to the host.
    ui.dispatch('fullscreen');
    assert.ok(host.log.some((m) => m.type === 'fullscreen'));

    // Host toasts and the right-click menu.
    ui.onHostMessage({ type: 'toast', text: 'hello' });
    const ctx = $('ctxmenu');
    assert.ok($('stage').listenerCount('contextmenu') === 1, 'the stage opens the real context menu');
    assert.ok(ctx, 'context menu element');

    ui.dispose();
    assert.strictEqual(dom.timers.filter(Boolean).length, 0, 'dispose stops the clock');
    assert.strictEqual($('play').listenerCount('click'), 0, 'dispose removes the bar listeners');
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  }
}

// ---- 8. The mockup harness mounts the shared controller instead of its own wiring ----
for (const key of Object.keys(SCENARIOS)) {
  const html = buildMockupHtml({ scenario: key });
  assert.ok(html.includes('data-src="media/player-ui.js"'), `${key}: inlines media/player-ui.js`);
  assert.ok(html.includes('data-src="tools/mockup/fake-host.js"'), `${key}: inlines the FakeHost`);
  assert.ok(html.includes('VpePlayerUi.create('), `${key}: mounts the shared controller`);
  const harness = html.slice(html.lastIndexOf('<script>'));
  for (const glue of ['VpeControls.create(', 'VpeFolderRail.create(', 'VpeCtxMenu.create(', 'S.togglePlay(', 'engine.draw(']) {
    assert.ok(!harness.includes(glue), `${key}: harness has no duplicated wiring (${glue})`);
  }
}

const ms = Date.now() - T0;
assert.ok(ms < 5000, `the UI seam is checked in milliseconds, not by playing video (${ms} ms)`);
console.log(`player_ui_test: ok (${ms} ms, no video decoded)`);
