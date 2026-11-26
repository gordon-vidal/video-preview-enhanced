'use strict';
// Millisecond tests for the webview UI controller (media/player-ui.js): its pure helpers (keys, bar buttons, step
// buttons, A–B pins, time readout, Picture size, context menu, Folder Rail, Spotlight splitter / Split Wipe divider),
// the FakeHost protocol (tools/mockup/fake-host.js), and create() end to end over the REAL widgets (controls.js,
// folder-rail.js, ctxmenu.js, abloop.js, autoplay.js, picture.js, modes.js) on a strict fake DOM parsed from the real
// markup (test/host/fake-dom.js: unknown ids are null, closest() and parent-chain bubbling are real; no layout). The
// last section checks the UI / state / engine boundary. Nothing decodes video. docs/TESTING.md "UI and gesture tests
// without video" explains the split.
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

  // D: the viewer picks another video in any N, through the host; the old pages' shapes are kept by the mapping.
  assert.deepStrictEqual(PUI.pickVideoMessage('player', { t: 2.5 }), { type: 'comparePick', t: 2.5 });
  assert.deepStrictEqual(PUI.pickVideoMessage('player'), { type: 'comparePick', t: 0 }, 'no video yet: from 0');
  assert.strictEqual(PUI.pickVideoMessage('compare', { t: 2.5 }), null, 'Compare: plain D is not a Compare key');
  assert.deepStrictEqual(PUI.pickVideoMessage('unified', { exclude: ['clip-0', 'clip-1'] }), { type: 'pickVideo', exclude: ['clip-0', 'clip-1'] });
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

  // Split Wipe end to end (bindSplitDivider, the one binding compare.js and create() use) over a letterboxed
  // picture: stage 800 x 400 at client x = 50, picture inset x = 100, w = 600 (Fit of a 3:2 clip).
  {
    const stageRect = { left: 50, top: 0, width: 800, height: 400 };
    const pic = { x: 100, w: 600 };
    assert.strictEqual(PUI.splitRatioAt(50 + 100, stageRect, pic), 0, 'the picture\'s left edge is 0 %');
    assert.strictEqual(PUI.splitRatioAt(50 + 700, stageRect, pic), 1, 'its right edge is 100 %');
    assert.strictEqual(PUI.splitRatioAt(50 + 400, stageRect, pic), 0.5, 'the middle of the picture, not of the stage');
    assert.strictEqual(PUI.splitRatioAt(50 + 250, stageRect, pic), 0.25);
    assert.strictEqual(PUI.splitRatioAt(50 + 20, stageRect, pic), 0, 'the left bar clamps to 0 %');
    assert.strictEqual(PUI.splitRatioAt(50 + 790, stageRect, pic), 1, 'the right bar clamps to 100 %');
    assert.strictEqual(PUI.splitRatioAt(300, stageRect, null), null, 'no picture: no move');
    assert.strictEqual(PUI.splitRatioAt(300, stageRect, { x: 0, w: 0 }), null);

    const { createDom } = require('./fake-dom');
    const d = createDom('<div id="stage"><div class="cell split"><div id="divider" role="slider" tabindex="0"></div></div></div>');
    const dv = d.$('divider');
    let split = 0.5;
    const ends = [];
    let stageClicks = 0;
    d.$('stage').addEventListener('click', () => stageClicks++);
    PUI.bindSplitDivider(dv, { stageRect: () => stageRect, pictureRect: () => pic, get: () => split, set: (r) => { split = r; }, onDragEnd: (m) => ends.push(m) });
    dv.fire('pointerdown', { button: 2, pointerId: 7, clientX: 450 });
    dv.fire('pointermove', { pointerId: 7, clientX: 250 });
    assert.strictEqual(split, 0.5, 'a right-button press is not a drag');
    const down = dv.fire('pointerdown', { button: 0, pointerId: 7, clientX: 450 });
    assert.ok(down.defaultPrevented && down.propagationStopped, 'the press stays on the divider');
    assert.ok(dv.hasPointerCapture(7), 'the divider captures the pointer');
    dv.fire('pointermove', { pointerId: 7, clientX: 50 + 250 });
    assert.strictEqual(split, 0.25, 'drag over the letterboxed picture');
    dv.fire('pointermove', { pointerId: 7, clientX: 50 + 10 });
    assert.strictEqual(split, 0, 'drag to 0 %');
    dv.fire('pointermove', { pointerId: 7, clientX: 50 + 799 });
    assert.strictEqual(split, 1, 'drag to 100 %');
    dv.fire('pointerup', { pointerId: 7 });
    dv.fire('pointermove', { pointerId: 7, clientX: 50 + 400 });
    assert.strictEqual(split, 1, 'no move after the release');
    assert.deepStrictEqual(ends, [true], 'the page learns a drag ended (Compare: the ending click must not play)');
    dv.fire('click', { button: 0 });
    assert.strictEqual(stageClicks, 0, 'a click on the divider does not bubble to the stage');
    const key = (k, shiftKey = false) => dv.fire('keydown', { key: k, shiftKey });
    key('Home');
    assert.strictEqual(split, 0, 'Home: 0 %');
    key('ArrowLeft');
    assert.strictEqual(split, 0, 'no further than 0 %');
    key('ArrowRight', true);
    assert.ok(Math.abs(split - 0.1) < 1e-9, 'Shift+→ 10 %');
    key('End');
    assert.strictEqual(split, 1, 'End: 100 %');
    key('PageUp');
    assert.strictEqual(split, 1, 'no further than 100 %');
    const other = key('Enter');
    assert.strictEqual(other.defaultPrevented, false, 'other keys go on');
    // The state accepts the same range (player-state.js clamps 0..1, as Compare's setSplit).
    const ws2 = S.toggleSplit(S.createWorkspaceState({ tiles: ['clip-0', 'clip-1'] }));
    assert.deepStrictEqual([S.getTab(S.setSplitRatio(ws2, 0)).split, S.getTab(S.setSplitRatio(ws2, 1)).split], [0, 1]);
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
  assert.deepStrictEqual(S.getTab(r.state).tiles, ['clip-0', 'clip-2'], 'compare joins without turning capture on');
  assert.strictEqual(S.getTab(r.state).capture, false);
  assert.ok(r.toast.includes('clip-2.mp4'));

  ws = S.toggleCapture(r.state).state;
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
  assert.deepStrictEqual(rows.map((r) => [r.letter, r.name, r.offText, r.offLong]), [['A', 'CLIP-4', '0', 'In step'], ['B', 'CLIP-1', '−3 f', '−3 frames']],
    'offsets are { unit, v } and read as Compare writes them (U+2212 minus)');
  assert.deepStrictEqual(rows.map((r) => r.offset), [{ unit: 'frames', v: 0 }, { unit: 'frames', v: -3 }]);
  assert.deepStrictEqual(rows.map((r) => [r.clock, r.sound]), [[true, true], [false, false]], 'A sets the clock and is heard by default');
  const msRows = PUI.compareRows(S, S.getTab(S.nudgeOffset(S.setOffsetUnit(multi, 'clip-1', 'ms'), 'clip-1', 4)), (id) => ({ id, name: id }));
  assert.deepStrictEqual([msRows[1].offset, msRows[1].offText], [{ unit: 'ms', v: 40 }, '+40 ms'], 'ms offsets step 10 ms');

  // replaceTile: the host's answer to 'replaceVideo' keeps the slot (pure half).
  const getClip = (id) => ({ id, name: `${id}.mp4` });
  const rt = PUI.applyHostMessage(S, multi, { type: 'replaceTile', oldId: 'clip-1', newId: 'clip-3' }, getClip);
  assert.deepStrictEqual([S.getTab(rt.state).tiles, rt.toast, rt.handled], [['clip-4', 'clip-3'], 'Replaced with clip-3.mp4', true]);
  const rtBad = PUI.applyHostMessage(S, multi, { type: 'replaceTile', oldId: 'nope', newId: 'clip-3' }, getClip);
  assert.deepStrictEqual([rtBad.state, rtBad.toast], [multi, ''], 'an unknown tile is left alone');

  // Autoplay "Play next in folder": the one before paused on its last frame (decoderEnded); the host's replaceTile
  // with autoPlay plays the next one from frame 0. A manual Next (no autoPlay) keeps it paused where it was.
  const ended = S.createWorkspaceState({ tiles: ['clip-0'], frame: 90 });
  assert.strictEqual(S.getTab(ended).playing, false, 'paused on the last frame');
  const auto = PUI.applyHostMessage(S, ended, { type: 'replaceTile', oldId: 'clip-0', newId: 'clip-1', autoPlay: true }, getClip);
  assert.deepStrictEqual([S.getTab(auto.state).tiles, S.getTab(auto.state).frame, S.getTab(auto.state).playing],
    [['clip-1'], 0, true], 'natural end: the next video plays from its start');
  const manual = PUI.applyHostMessage(S, ended, { type: 'replaceTile', oldId: 'clip-0', newId: 'clip-1' }, getClip);
  assert.deepStrictEqual([S.getTab(manual.state).tiles, S.getTab(manual.state).playing], [['clip-1'], false],
    'manual Next: no forced play');
  const unknown = PUI.applyHostMessage(S, ended, { type: 'replaceTile', oldId: 'nope', newId: 'clip-1', autoPlay: true }, getClip);
  assert.strictEqual(unknown.state, ended, 'autoPlay for a tile not shown changes nothing');
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

// ---- 7. create() end to end: real widgets on a strict fake DOM of the real markup, FakeEngine + FakeHost ----
// The fixture uses the exact shared stage/rail/bar/popup markup from tools/mockup/render.js (stageMarkupHtml)
// so tests can never drift from the rendered harness. test/host/fake-dom.js is strict: unknown ids return null.
const { createDom, Element: FakeElement, Node: FakeNode } = require('./fake-dom');
const { stageMarkupHtml } = require('../../tools/mockup/render');
const FIXTURE = stageMarkupHtml();
const STAGE = { width: 680, height: 370 };
const fixtureDom = (html = FIXTURE) => {
  const dom = createDom(html);
  dom.setRect(dom.doc.documentElement, { width: 1024, height: 768 });
  if (dom.$('stage')) dom.setRect(dom.$('stage'), STAGE);
  if (dom.$('seek')) dom.setRect(dom.$('seek'), { width: 680, height: 4 });
  return dom;
};
const realWidgets = () => ({
  VpeControls: require('../../media/controls'),
  VpeFolderRail: require('../../media/folder-rail'),
  VpeCtxMenu: require('../../media/ctxmenu'),
  VpeAbLoop: require('../../media/abloop'),
  VpeAutoplay: require('../../media/autoplay'),
  VpeTime: require('../../media/timefmt'),
  VpePicture: require('../../media/picture'),
  VpeModes: require('../../media/modes'),
  VpePlayerUiTiles: require('../../media/player-ui-tiles'),
  VpePlayerUiInput: require('../../media/player-ui-input'),
  CompareGrid: require('../../media/compare-grid'),
});
/** Run fn with the browser globals the widgets read directly (document, window, matchMedia, animation frames). */
const withGlobals = (dom, fn) => {
  const GLOBALS = {
    document: dom.doc, window: dom.win, innerWidth: dom.win.innerWidth, innerHeight: dom.win.innerHeight,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, Element: FakeElement, HTMLElement: FakeElement, Node: FakeNode,
  };
  const saved = Object.fromEntries(Object.keys(GLOBALS).map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
  Object.assign(global, GLOBALS);
  try { return fn(); } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  }
};

// The fixture is strict, and create() needs the real controls.
{
  const dom = fixtureDom();
  assert.strictEqual(dom.$('no-such-control'), null, 'unknown ids are null (no auto-created elements)');
  assert.strictEqual(dom.$('splitBtn'), null, 'src/bar.js has no Split button yet: create() must add it itself');
  for (const id of ['bar', 'seek', 'play', 'prev', 'next', 'cog', 'infoBtn', 'startCompareBtn', 'rail', 'folderCap', 'railFilter']) {
    assert.ok(dom.$(id), `#${id} is in the production markup`);
  }
  for (const id of ['panel', 'sheet', 'ctxmenu', 'rail', 'railHover', 'railColMenu', 'railEndMenu', 'capBanner', 'splitter', 'divider']) {
    assert.strictEqual(dom.$(id).hidden, true, `#${id} starts hidden, as in the real markup`);
  }
  assert.strictEqual(dom.$('prevSize').closest('#bar'), dom.$('bar'), 'closest() walks the real parent chain');
  assert.strictEqual(dom.$('play').closest('#rail'), null);
  // Bubbling: a click on the icon inside #play reaches #play's listeners and then #bar's, unless stopped.
  const seen = [];
  dom.$('bar').addEventListener('click', () => seen.push('bar'));
  dom.$('play').addEventListener('click', (e) => { seen.push('play'); if (e.stop) e.stopPropagation(); });
  dom.$('play').querySelector('svg.i-play').fire('click');
  dom.$('play').querySelector('svg.i-pause path, svg.i-pause rect').fire('click', { stop: true });
  assert.deepStrictEqual(seen, ['play', 'bar', 'play'], 'events bubble up the parent chain; stopPropagation stops them');
  // A missing required control is an error, not a silent stand-in.
  for (const gone of ['seek', 'startCompareBtn']) {
    const d = fixtureDom(FIXTURE.replace(new RegExp(` id="${gone}"`), ' data-was="gone"'));
    assert.strictEqual(d.$(gone), null);
    withGlobals(d, () => assert.throws(() => PUI.create({
      doc: d.doc, win: d.win, stateApi: S, engine: createFakeEngine(), host: createFakeHost({ clips: createFakeEngine().clips }),
      widgets: realWidgets(), tickMs: 0,
    }), new RegExp(`#${gone} is missing`), `create() refuses a page without #${gone}`));
  }
  // URLs and image sequences have no folder (unifiedHtml({ folder: false })): no #rail, no Folder Rail, still a player.
  {
    const d = fixtureDom(FIXTURE.replace(/ id="rail"/, ' data-was="gone"'));
    assert.strictEqual(d.$('rail'), null);
    withGlobals(d, () => {
      const host = createFakeHost({ clips: createFakeEngine().clips });
      const ui = PUI.create({ doc: d.doc, win: d.win, stateApi: S, engine: { ...createFakeEngine(), draw() {} }, host, widgets: realWidgets(), tickMs: 0 });
      host.connect(ui.onHostMessage);
      ui.render();
      assert.strictEqual(ui.rail, null, 'create() mounts without #rail: no rail');
      ui.onHostMessage({ type: 'rail', op: 'list', items: [] });
      ui.dispatch('loop');
      ui.dispatch('nextVideo');
      assert.deepStrictEqual(host.log.filter((m) => m.type === 'neighbour').pop(), { type: 'neighbour', d: 1 }, 'Shift+N asks the host instead');
      ui.controls.show('main', d.$('cog'));
      assert.ok(![...d.$('panel').querySelectorAll('[data-tool]')].some((b) => /Folder Rail/.test(b.textContent)), 'no Folder Rail row in ⚙');
      ui.dispose();
    });
  }
}

{
  const dom = fixtureDom();
  withGlobals(dom, () => {
    const widgets = realWidgets();
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
    const timers = () => dom.timers.filter(Boolean);
    /** Run the pending single click of a tile (it waits out the double-click window). */
    const flushClick = () => {
      const i = dom.timers.findIndex((t) => t && t.ms === 250);
      assert.ok(i >= 0, 'a tile click is pending');
      const t = dom.timers[i]; dom.timers[i] = null; t.fn();
    };

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
    assert.strictEqual($('splitBtn').parentNode, $('startCompareBtn').parentNode, 'Split sits in the real bar row, beside Compare');
    assert.strictEqual($('splitBtn').hidden, true, 'Split only at N = 2');
    assert.ok($('cmpBtn').innerHTML.includes('<circle') && !$('cmpBtn').innerHTML.includes('M12 4.5v15'),
      'the Compare panel button is the list icon, not the Split Wipe rectangle with a divider');
    assert.notStrictEqual($('cmpBtn').innerHTML, $('splitBtn').innerHTML, 'its icon differs from the Split button icon');
    assert.strictEqual($('syncBtn').hidden, true, 'Sync only at N >= 2');
    assert.strictEqual($('tracks').hidden, false, 'CC at N = 1');

    // The real #bar buttons drive the state; their clicks do not reach the stage.
    $('play').querySelector('svg').fire('click');
    assert.strictEqual(tab().playing, true, 'a click on #play (its icon, bubbling to the button) toggles playback');
    assert.strictEqual(timers().length, 1, 'one playback clock');
    timers()[0].fn();
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
    $('now').fire('click');
    assert.strictEqual(ui.getPrefs().timeMode, 1, 'clicking the time (its #now span) cycles the format');
    assert.strictEqual($('now').textContent, widgets.VpeTime.fmtTimecode(120, 24));
    $('picBtn').fire('click');
    assert.strictEqual(ui.getPrefs().picMode, 'fill', 'Picture size cycles');
    assert.strictEqual($('picBtn').dataset.mode, 'fill', 'the button follows (shared pictureButton)');
    assert.match($('picBtn').title, /^Picture size: Fill .*Click for Stretch {2}Z$/);
    assert.match($('toast').textContent, /^Fill \(\d+%\)$/, 'the toast names the size and its percent, as the single player does');
    $('time').fire('click');
    assert.deepStrictEqual([$('now').textContent, $('dur').textContent], ['frame 121', '/ 241'], 'frame numbers, as in the player');
    $('time').fire('click');
    assert.strictEqual(ui.getPrefs().timeMode, 0, 'back to the clock');
    assert.strictEqual($('now').textContent, '0:05.000');

    // Keyboard shortcuts: keydown on the focused body bubbles to the document listener.
    const key = (k, mods = {}) => dom.doc.body.fire('keydown', { key: k, ...mods });
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
    const altGr = key(']', { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' });
    assert.strictEqual(altGr.defaultPrevented, true, 'AltGr+] (typed ]) is a player key');
    key('[');
    assert.strictEqual(key(',', { ctrlKey: true }).defaultPrevented, false, 'Ctrl+, goes to VS Code');
    const vol0 = ui.getPrefs().volume;
    key('ArrowDown');
    assert.ok(Math.abs(ui.getPrefs().volume - (vol0 - 0.05)) < 1e-9, '↓ lowers the volume');
    key('ArrowUp');
    const copies = host.log.filter((m) => m.type === 'copyText').length;
    key('t');
    assert.strictEqual(host.log.filter((m) => m.type === 'copyText').length, copies + 1, 'T copies the time');
    key('s');
    assert.ok(host.log.some((m) => m.type === 'saveFrame'), 'S asks the host to save the frame');
    assert.strictEqual(key('q').defaultPrevented, false, 'unknown keys are left alone');

    // A–B pins: the real abloop.js drag over the shared bindAbPins (the same path as both pages).
    $('abA').fire('pointerdown', { clientX: 340, pointerId: 1, button: 0 });
    assert.strictEqual($('abA').style.left, '50%', 'the pin follows the pointer to the nearest frame');
    assert.match($('tip').textContent, /^A 0:05\.000 · #121$/, 'the tip names the end, the time and the frame');
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
    $('cells').fire('contextmenu', { clientX: 20, clientY: 20 });
    assert.strictEqual(ui.ctxMenu.isOpen(), true, 'a right-click in the stage bubbles to its menu handler');
    key('Escape');
    assert.strictEqual(ui.ctxMenu.isOpen(), false, 'Esc closes it');
    $('railFilter').focus();
    assert.strictEqual($('railFilter').fire('keydown', { key: ',' }).defaultPrevented, false, 'keys typed into the rail filter are left alone');
    dom.doc.body.focus();
    key('?');
    assert.strictEqual(ui.controls.sheetOpen(), true, '? opens the shortcuts sheet');
    key('Escape');
    assert.strictEqual(ui.controls.anyOpen(), false, 'Esc closes it');
    key('i');
    assert.strictEqual(ui.controls.view(), 'info', 'I opens About this video');
    key('Escape');

    // UNIFIED PROPOSAL from here on (not production): one tab grows from 1 to N videos (docs/notes/player-ui-controller.md).
    // The real Folder Rail through FakeHost: open, list, activate, ‹ / ›.
    ui.rail.show();
    const snap = ui.rail.snapshot();
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
    const cellOf = (id) => cellsEl.querySelector(`.cell[data-clip="${id}"]`);
    const cellA = cellOf('clip-2');
    assert.ok(cellA && cellOf('clip-0'), 'one cell per tile');
    const nCells = cellsEl.children.length;
    $('play').fire('click');
    const drawn0 = drawn.length;
    for (let i = 0; i < 5; i++) timers()[0].fn();
    assert.strictEqual(cellsEl.children.length, nCells, 'ticks do not rebuild the cells');
    assert.strictEqual(cellOf('clip-2'), cellA, 'the same node');
    assert.ok(drawn.length >= drawn0 + 10, 'each tick draws both tiles');
    cellA.querySelector('canvas').fire('click');
    assert.strictEqual(tab().playing, true, 'a tile click waits out the double-click window');
    flushClick();
    assert.strictEqual(tab().playing, false, 'a click on the tile picture (its canvas bubbles to the cell) pauses');
    // The name pill is a button: it opens that video's Compare page and never plays / pauses.
    cellA.querySelector('.pill .nm').fire('click');
    assert.deepStrictEqual([ui.controls.view(), tab().playing], ['cmpVid', false], 'the name pill opens Compare › video');
    assert.ok(!dom.timers.some((t) => t && t.ms === 250), 'no pending play / pause');
    key('Escape');
    cellA.fire('click'); cellA.fire('click'); cellA.fire('dblclick');
    assert.ok(!dom.timers.some((t) => t && t.ms === 250), 'a double-click cancels the pending play / pause');
    assert.deepStrictEqual([tab().layout, tab().spotlightId, tab().playing], ['spotlight', 'clip-2', false], 'double-click only enlarges');
    cellOf('clip-2').fire('dblclick');
    assert.strictEqual(tab().layout, 'grid', 'double-click on the enlarged tile goes back to the grid');

    // Nested tile buttons: their clicks run their own action and never bubble up to play / pause the tile.
    const btnOf = (id, sel) => cellOf(id).querySelector(sel);
    assert.ok(btnOf('clip-0', '[data-enlarge]') && btnOf('clip-0', '[data-rm]') && btnOf('clip-0', '.sync-pill [data-d="1"]'),
      'the tile overlay has real Enlarge / Remove / Sync buttons');
    btnOf('clip-0', '.sync-pill [data-d="1"]').fire('click');
    assert.deepStrictEqual([tab().offsets['clip-0'], tab().playing], [{ unit: 'frames', v: 1 }, false], 'Sync + nudges, no play');
    btnOf('clip-0', '.sync-pill [data-d="-1"]').fire('click');
    assert.deepStrictEqual([tab().offsets['clip-0'], tab().playing], [{ unit: 'frames', v: 0 }, false], 'Sync − nudges, no play');
    btnOf('clip-2', '[data-enlarge] svg').fire('click');
    assert.deepStrictEqual([tab().layout, tab().spotlightId, tab().playing], ['spotlight', 'clip-2', false],
      'Enlarge (a click on its icon) enlarges that tile and does not toggle play');
    btnOf('clip-2', '[data-enlarge]').fire('click');
    assert.deepStrictEqual([tab().layout, tab().playing], ['grid', false], 'Back to grid, still paused');
    btnOf('clip-0', '[data-enlarge]').fire('dblclick');
    assert.strictEqual(tab().layout, 'grid', 'a double-click on a tile button is not a tile double-click');
    cellOf('clip-2').fire('dblclick');
    assert.deepStrictEqual([tab().layout, tab().spotlightId], ['spotlight', 'clip-2'], 'double-click on the tile enlarges it');
    key('Escape');
    assert.strictEqual(tab().layout, 'grid', 'Esc collapses Spotlight');

    $('splitBtn').querySelector('svg').fire('click');
    assert.strictEqual(tab().layout, 'split', 'Split Wipe');
    assert.strictEqual($('divider').hidden, false, 'the divider shows');
    assert.ok(drawn.some((d) => d.split === tab().split), 'tile B is drawn clipped at the divider');
    // The divider: the shared bindSplitDivider (as media/compare.js), 0–100 %, pointer capture.
    const sp0 = tab().split;
    $('divider').fire('keydown', { key: 'ArrowRight' });
    assert.ok(Math.abs(tab().split - (sp0 + 0.01)) < 1e-9, '→ moves the divider 1 %');
    $('divider').fire('keydown', { key: 'End' });
    assert.strictEqual(tab().split, 1, 'End: 100 %, as in Compare');
    $('divider').fire('keydown', { key: 'Home' });
    assert.strictEqual(tab().split, 0, 'Home: 0 %, as in Compare');
    const playing0 = tab().playing;
    $('divider').fire('pointerdown', { button: 0, pointerId: 3, clientX: 0 });
    assert.ok($('divider').hasPointerCapture(3), 'the divider captures the pointer');
    $('divider').fire('pointermove', { pointerId: 3, clientX: 170, clientY: 10 });
    $('divider').fire('pointerup', { pointerId: 3 });
    $('divider').fire('click', { button: 0 });
    assert.strictEqual(tab().split, 0.25, 'dragging the divider (170 of the 680 px picture)');
    assert.strictEqual(tab().playing, playing0, 'the click that ends the drag does not play / pause');
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
    const spl = $('splitter');
    assert.deepStrictEqual([spl.classList.contains('h'), spl.getAttribute('aria-orientation'), spl.getAttribute('aria-valuetext')],
      [true, 'horizontal', 'Spotlight 10%'], 'dock top: a horizontal bar, its value spoken');
    spl.fire('pointerdown', { button: 2, pointerId: 4, clientY: 200 });
    spl.fire('pointermove', { pointerId: 4, clientY: 200 });
    assert.ok(Math.abs(tab().heroRatio - 0.1) < 1e-9, 'a right-button press is not a drag');
    spl.fire('pointerdown', { button: 0, pointerId: 4, clientX: 0, clientY: 37 });
    assert.ok(spl.hasPointerCapture(4), 'the splitter captures the pointer');
    spl.fire('pointermove', { pointerId: 9, clientX: 0, clientY: 300 });
    assert.ok(Math.abs(tab().heroRatio - 0.1) < 1e-9, 'another pointer does not move it');
    spl.fire('pointermove', { pointerId: 4, clientX: 0, clientY: 0.3 * (STAGE.height - S.GAP) });
    spl.fire('pointerup', { pointerId: 4 });
    const playingBefore = tab().playing;
    spl.fire('click', { button: 0 });
    assert.ok(Math.abs(tab().heroRatio - 0.3) < 1e-9, 'dragging the splitter (along the dock, over the stage less the gap)');
    assert.strictEqual(tab().playing, playingBefore, 'the click that ends the drag does not play / pause');
    assert.strictEqual(spl.getAttribute('aria-valuenow'), '30');
    spl.fire('dblclick');
    assert.ok(Math.abs(tab().heroRatio - S.HERO_DEFAULT) < 1e-9, 'double-click resets the Spotlight size to 72 %');
    ui.setState(S.setDock(ui.getState(), 'left'));
    assert.deepStrictEqual([spl.classList.contains('v'), spl.classList.contains('h'), spl.getAttribute('aria-orientation')],
      [true, false, 'vertical'], 'dock left: a vertical bar');
    spl.fire('keydown', { key: 'ArrowRight' });
    assert.ok(Math.abs(tab().heroRatio - (S.HERO_DEFAULT + 0.05)) < 1e-9, '→ grows the main tile (dock left)');
    ui.setState(S.setDock(ui.getState(), 'top'));
    assert.strictEqual(tab().syncMode, true, 'Sync mode is still on');
    ui.controls.show('cmp', $('startCompareBtn'));
    key('Escape');
    assert.deepStrictEqual([ui.controls.anyOpen(), tab().syncMode], [false, true], 'Esc closes the panel first');
    key('Escape');
    assert.deepStrictEqual([tab().syncMode, tab().layout], [false, 'spotlight'], 'then Esc leaves Sync mode');
    assert.strictEqual($('toast').textContent, 'Sync offsets off', 'and says so');
    key('Escape');
    assert.strictEqual(tab().layout, 'grid', 'Esc collapses Spotlight once the panels and Sync are closed');

    // D in Compare: the unified proposal picks another video through the host (production Compare has no plain-D
    // key: section 1 checks that separately).
    const picks0 = host.log.filter((m) => m.type === 'pickVideo').length;
    key('d');
    const pick = host.log.filter((m) => m.type === 'pickVideo');
    assert.strictEqual(pick.length, picks0 + 1, 'proposal: D asks the host for another video');
    assert.deepStrictEqual(pick[pick.length - 1], PUI.pickVideoMessage('unified', { exclude: ['clip-2', 'clip-0'] }), 'it excludes the shown videos');
    assert.strictEqual(tab().tiles.length, 3, '+ Add video asks the host and joins its answer');
    ui.dispatch('nudge', 'clip-0', 2);
    assert.deepStrictEqual(tab().offsets['clip-0'], { unit: 'frames', v: 2 });
    // 2-click remove from 3 videos on: the first click asks "Remove?", the second removes.
    btnOf('clip-0', '[data-rm]').fire('click');
    assert.deepStrictEqual([tab().tiles.includes('clip-0'), tab().removeConfirmId], [true, 'clip-0'], 'the first click only asks');
    assert.strictEqual(btnOf('clip-0', '[data-rm]').textContent, 'Remove?');
    assert.ok(cellOf('clip-0').classList.contains('confirming'));
    key('Escape');
    assert.strictEqual(tab().removeConfirmId, null, 'Esc cancels the question');
    btnOf('clip-0', '[data-rm]').fire('click');
    btnOf('clip-0', '[data-rm]').fire('click');
    assert.strictEqual(tab().tiles.includes('clip-0'), false, 'Remove on the tile removes it (second click)');
    assert.strictEqual(tab().playing, false, 'and does not toggle play');
    ui.dispatch('leaveCompare');
    assert.strictEqual(tab().tiles.length, 1, 'Leave compare keeps A');
    assert.strictEqual($('tracks').hidden, false, 'single-video controls come back');

    // Bar commands the page cannot do itself go to the host.
    ui.dispatch('fullscreen');
    assert.ok(host.log.some((m) => m.type === 'fullscreen'));

    ui.onHostMessage({ type: 'toast', text: 'hello' });
    assert.strictEqual($('stage').listenerCount('contextmenu'), 1, 'the stage has one right-click listener (the tile menu)');

    ui.dispose();
    assert.strictEqual(timers().length, 0, 'dispose stops the clock');
    assert.strictEqual($('play').listenerCount('click'), 0, 'dispose removes the bar listeners');
    assert.strictEqual($('divider').listenerCount('keydown'), 0, 'and the divider\'s');
  });
}

// ---- 7b. Phase 1 & 2A wired into create(): tiles (media/player-ui-tiles.js) and input (media/player-ui-input.js) ----
// Each block mounts a fresh controller on the real markup over FakeEngine + FakeHost (clip-2 has no audio track).
{
  /** Mount create() on a fresh fixture; `fn` runs inside the browser globals the widgets read. */
  const mount = (initial, fn, extra = {}) => {
    const dom = fixtureDom();
    return withGlobals(dom, () => {
      const widgets = realWidgets();
      let menuEnv = null;
      let menuOpens = 0;
      const realMenu = widgets.VpeCtxMenu;
      widgets.VpeCtxMenu = {
        ...realMenu,
        create: (env) => {
          const before = env.beforeOpen;
          menuEnv = { ...env, beforeOpen: () => { menuOpens++; if (before) before(); } };
          return realMenu.create(menuEnv);
        },
      };
      // The fake DOM has no 2D context: drawing (and the thumbnail drawn into its canvas) is recorded, not painted.
      const base = createFakeEngine();
      const thumbs = [];
      const engine = { ...base, draw() {}, thumbnail: (id, sec, _cv, scrub) => base.thumbnail(id, sec, (p) => thumbs.push(p), scrub) };
      const host = createFakeHost({ clips: engine.clips });
      const ui = PUI.create({ doc: dom.doc, win: dom.win, stateApi: S, engine, host, widgets, initial, tickMs: 42, ...extra });
      host.connect(ui.onHostMessage);
      ui.render();
      const tab = () => S.getTab(ui.getState());
      const cellOf = (id) => dom.$('cells').querySelector(`.cell[data-clip="${id}"]`);
      const key = (k, mods = {}) => dom.doc.body.fire('keydown', { key: k, ...mods });
      const t = { dom, ui, host, engine, tab, cellOf, key, $: dom.$, menuEnv: () => menuEnv, menuOpens: () => menuOpens };
      try { return fn(t); } finally { ui.dispose(); }
    });
  };
  const last = (log, type) => log.filter((m) => m.type === type).pop();

  // Duplicate right-click fix: one video opens the player menu exactly once (ctxmenu.js's own listener).
  mount({ tiles: ['clip-0'] }, ({ $, ui, menuOpens }) => {
    $('cells').querySelector('canvas').fire('contextmenu', { clientX: 30, clientY: 30, button: 2 });
    assert.strictEqual(ui.ctxMenu.isOpen(), true, 'right-click opens the player menu');
    assert.strictEqual(menuOpens(), 1, 'it opens once, not twice');
    assert.strictEqual(ui.tileMenu.isOpen(), false, 'one video: no tile menu');
  });

  // What the real VS Code checks of the bar and the picture (test/vscode/cases/ui.js, ctxmenu.js), over the real
  // media/range-drag.js: names and states, a click on the picture, Loop, the menu's "Set", wheel and drags off the edge.
  {
    const dom = fixtureDom();
    dom.win.Event = dom.FakeEvent;
    const RangeDrag = require('../../media/range-drag');
    withGlobals(dom, () => {
      global.VpeRangeDrag = RangeDrag; // controls.js's speed slider uses the page global
      const widgets = { ...realWidgets(), VpeRangeDrag: RangeDrag };
      let menuEnv = null;
      const realMenu = widgets.VpeCtxMenu;
      widgets.VpeCtxMenu = { ...realMenu, create: (env) => { menuEnv = env; return realMenu.create(env); } };
      const engine = { ...createFakeEngine(), draw() {} };
      const host = createFakeHost({ clips: engine.clips });
      const told = [];
      const ui = PUI.create({
        doc: dom.doc, win: dom.win, stateApi: S, engine, host, widgets, initial: { tiles: ['clip-0'] }, tickMs: 0,
        onTransport: (ev) => told.push(ev),
      });
      const $ = dom.$;
      const tab = () => S.getTab(ui.getState());
      const runShortTimers = () => dom.timers.forEach((t, i) => { if (t && t.ms <= 100) { dom.timers[i] = null; t.fn(); } });
      try {
        ui.render();
        // Names: the time button and the seek slider speak m:ss.mmm and the frame; Play says what it does.
        assert.match($('time').getAttribute('aria-label'), /^Position \d+:\d\d\.\d{3}, frame \d+\. /);
        assert.match($('seek').getAttribute('aria-valuetext'), /^\d+:\d\d\.\d{3} of \d+:\d\d\.\d{3}, frame \d+$/);
        assert.match(`${$('now').textContent} ${$('dur').textContent}`, /^\d+:\d\d\.\d{3} \/ \d+:\d\d\.\d{3}$/);
        assert.strictEqual($('cmpBtn').hidden, true, 'one video: no Compare panel button');
        const unnamed = [...dom.doc.querySelectorAll('button')]
          .filter((b) => !(b.getAttribute('aria-label') || '').trim() && !/[A-Za-z]/.test(b.textContent || '')).map((b) => b.id);
        assert.deepStrictEqual(unnamed, [], 'every button has a name in words, the empty placeholders too');
        ui.dispatch('playPause');
        assert.strictEqual($('play').getAttribute('aria-label'), 'Pause', 'playing: Pause');
        ui.dispatch('playPause');
        assert.strictEqual($('play').getAttribute('aria-label'), 'Play', 'paused: Play');

        // R: Loop in the prefs the page reports, told to the decoders, said in the live region.
        dom.doc.body.fire('keydown', { key: 'r' });
        runShortTimers();
        assert.strictEqual(ui.getPrefs().loop, true, 'R: loop on in the prefs');
        assert.deepStrictEqual(told.filter((e) => e.type === 'loop').pop(), { type: 'loop', loop: true }, 'the decoders hear it');
        assert.strictEqual($('live').textContent, 'Loop on', 'the live region says so');
        dom.doc.body.fire('keydown', { key: 'r' });
        assert.strictEqual(ui.getPrefs().loop, false);

        // A click on the picture plays / pauses at once (no double-click wait with one video), on the tile's canvas
        // or the stage around it; with a panel or the menu open it only closes them, also when the press closed them.
        const canvas = $('cells').querySelector('canvas');
        canvas.fire('click', { button: 0 });
        assert.strictEqual(tab().playing, true, 'a click on the picture plays');
        $('stage').fire('click', { button: 0 });
        assert.strictEqual(tab().playing, false, 'a click beside a letterboxed picture pauses');
        ui.controls.show('main', $('cog'));
        canvas.fire('click', { button: 0 });
        assert.deepStrictEqual([ui.controls.view(), tab().playing], [null, false], 'with a panel open: only closes it');
        ui.controls.show('main', $('cog'));
        canvas.fire('pointerdown', { button: 0, pointerId: 1 });
        assert.strictEqual(ui.controls.view(), null, 'the press closed the panel');
        canvas.fire('click', { button: 0 });
        assert.strictEqual(tab().playing, false, 'and the click that follows does not play');
        ui.ctxMenu.open(40, 40);
        canvas.fire('pointerdown', { button: 0, pointerId: 1 });
        canvas.fire('click', { button: 0 });
        assert.deepStrictEqual([ui.ctxMenu.isOpen(), tab().playing], [false, false], 'a click that closes the menu does not play');
        canvas.fire('click', { button: 0 });
        assert.strictEqual(tab().playing, true, 'the next click plays again');
        ui.dispatch('playPause');

        // The menu's Set Range Start / End always set; the A key toggles.
        ui.dispatch('seek', 12);
        menuEnv.run('setA');
        menuEnv.run('setA');
        assert.strictEqual(ui.ab.a, 0.5, 'Set Range Start twice keeps it set');
        ui.dispatch('seek', 36);
        menuEnv.run('setB');
        menuEnv.run('setB');
        assert.deepStrictEqual([ui.ab.a, ui.ab.b], [0.5, 1.5], 'Set Range End twice keeps it set');
        ui.dispatch('clearAB');
        ui.dispatch('setA');
        ui.dispatch('setA');
        assert.strictEqual(ui.ab.a, null, 'A twice clears it again');

        // The wheel over the speed button: ±0.05; over the volume: ±5 %.
        ui.dispatch('volume', 0.5);
        $('rate').fire('wheel', { deltaY: -100 });
        assert.ok(Math.abs(ui.getPrefs().rate - 1.05) < 1e-9, 'wheel up over the speed button');
        assert.strictEqual($('rate').fire('wheel', { deltaY: 100 }).defaultPrevented, true, 'the page does not scroll');
        assert.ok(Math.abs(ui.getPrefs().rate - 1) < 1e-9, 'wheel down');
        $('volume').fire('wheel', { deltaY: -100 });
        assert.ok(Math.abs(ui.getPrefs().volume - 0.55) < 1e-9, 'wheel up over the volume');

        // Volume: a drag goes on past either end and above the bar; a move after the release changes nothing.
        const vol = $('volume');
        Object.assign(vol, { min: '0', max: '1', step: '0.05' });
        dom.setRect(vol, { left: 100, top: 700, width: 100, height: 4 });
        vol.fire('pointerdown', { button: 0, pointerId: 1, clientX: 150, clientY: 702 });
        assert.deepStrictEqual([ui.dragState().volume, ui.getPrefs().volume], [true, 0.5], 'the press sets the volume');
        assert.ok(vol.closest('.vol-wrap').classList.contains('dragging'), 'the slider stays open while dragged');
        dom.win.fire('pointermove', { pointerId: 1, clientX: 500, clientY: 500 });
        assert.strictEqual(ui.getPrefs().volume, 1, 'off the right edge');
        dom.win.fire('pointermove', { pointerId: 1, clientX: -50, clientY: 500 });
        assert.deepStrictEqual([ui.getPrefs().volume, ui.getPrefs().muted], [0, true], 'off the left edge: silent');
        dom.win.fire('pointerup', { pointerId: 1, clientX: 160, clientY: 500 });
        // (a real range input rounds its value to the step; the fake one keeps the float)
        const v1 = ui.getPrefs().volume;
        assert.ok(!ui.dragState().volume && Math.abs(v1 - 0.6) < 1e-9, `released at 60 %: ${v1}`);
        dom.win.fire('pointermove', { pointerId: 1, clientX: 200, clientY: 500 });
        assert.strictEqual(ui.getPrefs().volume, v1, 'a move after the release does nothing');

        // Seek bar: with thumbnails active, a drag holds the main picture while moving the slider; the release commits.
        const seek = $('seek');
        Object.assign(seek, { min: '0', step: '1' });
        const beforeSeek = tab().frame;
        const want = Math.round(0.75 * Number(seek.max));
        seek.fire('pointerdown', { button: 0, pointerId: 2, clientX: 680 * 0.2, clientY: 2 });
        assert.deepStrictEqual([ui.dragState().seek, seek.value, tab().frame], [true, '48', beforeSeek], 'the press moves the slider and holds the picture');
        dom.win.fire('pointermove', { pointerId: 2, clientX: 680 * 0.75, clientY: -250 });
        assert.deepStrictEqual([seek.value, tab().frame], [String(want), beforeSeek], 'above the bar the slider follows while holding the picture');
        ui.onDecoderFrame(150); // a late decoder frame does not pull the bar back under the pointer
        assert.strictEqual(seek.value, String(want));
        dom.win.fire('pointerup', { pointerId: 2, clientX: 680 * 0.75, clientY: -250 });
        assert.deepStrictEqual([ui.dragState().seek, tab().frame, seek.value], [false, want, String(want)], 'lands where let go');
        assert.deepStrictEqual(told.filter((e) => e.type === 'seek').pop(), { type: 'seek', frame: want, playing: false });

        // Speed slider: the panel is not redrawn under the drag, so it goes on off the edges until the release.
        ui.controls.show('speed', $('rate'));
        const slider = $('speedSlider');
        dom.setRect(slider, { left: 0, top: 400, width: 375, height: 4 });
        slider.fire('pointerdown', { button: 0, pointerId: 3, clientX: 100, clientY: 402 });
        dom.win.fire('pointermove', { pointerId: 3, clientX: 900, clientY: -20 });
        assert.deepStrictEqual([ui.getPrefs().rate, $('rate').textContent, $('speedSlider')], [4, '4×', slider], 'off the top edge: 4×');
        dom.win.fire('pointermove', { pointerId: 3, clientX: -20, clientY: -20 });
        assert.strictEqual(ui.getPrefs().rate, 0.25, 'off the left edge: 0.25×');
        dom.win.fire('pointerup', { pointerId: 3, clientX: 75, clientY: -20 });
        dom.win.fire('pointermove', { pointerId: 3, clientX: 375, clientY: -20 });
        assert.ok(Math.abs(ui.getPrefs().rate - 1) < 1e-9 && $('rate').textContent === '1×', `released at 1×: ${ui.getPrefs().rate}`);
        ui.controls.close(false);
      } finally {
        ui.dispose();
        delete global.VpeRangeDrag;
      }
    });
  }

  // Compare: its own panel button (#cmpBtn) opens Compare's page; Esc gives it the focus back.
  mount({ tiles: ['clip-0', 'clip-1'] }, ({ $, ui, key }) => {
    const b = $('cmpBtn');
    assert.deepStrictEqual([b.hidden, b.getAttribute('aria-label'), b.getAttribute('aria-expanded')], [false, 'Compare', 'false']);
    b.fire('click');
    assert.deepStrictEqual([ui.controls.view(), b.getAttribute('aria-expanded')], ['cmp', 'true'], '#cmpBtn opens the Compare page');
    key('Escape');
    assert.deepStrictEqual([ui.controls.view(), b.getAttribute('aria-expanded')], [null, 'false']);
    assert.strictEqual($('startCompareBtn').hasAttribute('aria-expanded'), false, 'the capture toggle is no menu button');
  });

  // Add to Compare never switches a running capture off.
  mount({ tiles: ['clip-0', 'clip-1'], capture: true }, ({ ui, tab, host, menuEnv }) => {
    const picks = host.log.filter((m) => m.type === 'pickVideo').length;
    menuEnv().run('addToCompare');
    assert.strictEqual(tab().capture, true, 'capture stays on');
    assert.strictEqual(host.log.filter((m) => m.type === 'pickVideo').length, picks + 1, 'it picks the next video instead');
    assert.deepStrictEqual(tab().tiles, ['clip-0', 'clip-1', 'clip-2'], 'which joins the view');
    ui.setState(S.toggleCapture(ui.getState()).state);
    menuEnv().run('addToCompare');
    assert.strictEqual(tab().capture, true, 'with capture off, Add to Compare turns it on');
  });

  // Clock and sound: tile buttons, the tile menu, the bar, the engine.
  mount({ tiles: ['clip-0', 'clip-1', 'clip-2'] }, ({ $, ui, tab, cellOf, engine, dom, host, key }) => {
    assert.strictEqual($('play').getAttribute('aria-label'), 'Play all', 'Compare plays all');
    assert.match($('seek').getAttribute('aria-valuetext'), /^A 0:02\.000 of 0:10\.000, frame 49$/, 'the seek slider speaks the clock tile, letter first');
    const snd = (id) => cellOf(id).querySelector('[data-act="sound"]');
    assert.strictEqual(snd('clip-0').getAttribute('aria-pressed'), 'false', 'muted by default');
    snd('clip-1').fire('click');
    assert.deepStrictEqual([tab().soundId, ui.getPrefs().muted, engine.fake.soundSource], ['clip-1', false, 'clip-1'], 'the tile sound button picks the heard tile');
    assert.strictEqual(snd('clip-1').getAttribute('aria-label'), 'Mute B');
    snd('clip-1').fire('click');
    assert.deepStrictEqual([tab().soundId, ui.getPrefs().muted, engine.fake.soundSource], ['clip-1', true, null], 'again: mute');
    assert.strictEqual(snd('clip-2').getAttribute('aria-label'), 'No audio track in C', 'a clip without audio says so');
    snd('clip-2').fire('click');
    assert.strictEqual(tab().soundId, 'clip-1', 'and cannot be heard');
    // The tile menu: right-click a tile (N >= 2), not the player menu.
    cellOf('clip-1').querySelector('canvas').fire('contextmenu', { clientX: 40, clientY: 40, button: 2 });
    assert.deepStrictEqual([ui.tileMenu.isOpen(), ui.ctxMenu.isOpen()], [true, false], 'right-click on a tile opens the tile menu only');
    const items = [...$('menu').querySelectorAll('.mi')].map((b) => b.dataset.action);
    assert.deepStrictEqual(items, ['playPause', 'setClock', 'setSound', 'offset', 'copyFrame', 'copyTime', 'replace', 'remove', 'add', 'leave', 'keys', 'settings']);
    $('menu').querySelector('[data-action="setClock"]').fire('click');
    assert.deepStrictEqual([tab().clockId, ui.tileMenu.isOpen()], ['clip-1', false], 'B sets the clock');
    assert.match($('seek').getAttribute('aria-valuetext'), /^B /, 'the seek slider follows the clock tile');
    assert.ok(cellOf('clip-1').querySelector('.pill').classList.contains('clock'), 'the clock tile is marked');
    // Replace through the host keeps the slot.
    cellOf('clip-0').querySelector('canvas').fire('contextmenu', { clientX: 40, clientY: 40, button: 2 });
    $('menu').querySelector('[data-action="replace"]').fire('click');
    assert.deepStrictEqual(last(host.log, 'replaceVideo').oldId, 'clip-0', 'Replace asks the host');
    assert.deepStrictEqual(tab().tiles, ['clip-3', 'clip-1', 'clip-2'], 'and its answer takes the slot');
    // Copy timestamp of a tile: its letter and its own time.
    cellOf('clip-2').querySelector('canvas').fire('contextmenu', { clientX: 40, clientY: 40, button: 2 });
    $('menu').querySelector('[data-action="copyTime"]').fire('click');
    assert.strictEqual(last(host.log, 'copyText').text, 'C 0:02.00');
    // Esc closes the tile menu.
    cellOf('clip-2').querySelector('canvas').fire('contextmenu', { clientX: 40, clientY: 40, button: 2 });
    $('menu').querySelector('.mi').fire('keydown', { key: 'Escape' });
    assert.strictEqual(ui.tileMenu.isOpen(), false, 'Esc closes the tile menu');
    // Leave compare keeps the clock tile.
    ui.dispatch('leaveCompare');
    assert.deepStrictEqual(tab().tiles, ['clip-1'], 'Leave compare keeps the clock tile (B)');
    assert.deepStrictEqual(last(host.log, 'leaveCompare').keepId, 'clip-1');
    assert.strictEqual($('play').getAttribute('aria-label'), 'Play', 'back to one video');
    void dom; void key;
  });

  // The bar's mute speaks "No audio track" when the heard clip has none; M then only says so.
  mount({ tiles: ['clip-2'] }, ({ $, ui, key }) => {
    assert.deepStrictEqual([$('mute').getAttribute('aria-label'), $('mute').disabled], ['No audio track', true]);
    const muted = ui.getPrefs().muted;
    key('m');
    assert.strictEqual(ui.getPrefs().muted, muted, 'M changes nothing without audio');
    assert.strictEqual($('toast').textContent, 'No audio track');
    assert.match($('rate').getAttribute('aria-label'), /^Speed /, 'the speed button names itself');
    key('l');
    assert.strictEqual($('toast').textContent, '+10 s', 'L says how far it skipped');
    key('j');
    assert.strictEqual($('toast').textContent, '-10 s');
  });

  // Swap (X, the bar button), layout buttons, dense grid.
  mount({ tiles: ['clip-0', 'clip-1'] }, ({ $, ui, tab, host, key }) => {
    assert.deepStrictEqual([$('swapBtn').hidden, $('spotlightBtn').hidden, $('gridBtn').hidden, $('splitBtn').hidden], [false, false, false, false]);
    assert.deepStrictEqual([$('gridBtn').getAttribute('aria-pressed'), $('gridBtn').classList.contains('active')], ['true', true]);
    key('x');
    assert.deepStrictEqual(tab().tiles, ['clip-1', 'clip-0'], 'X swaps the sides');
    assert.deepStrictEqual(last(host.log, 'tileOrder').order, ['clip-1', 'clip-0'], 'the host learns the new order');
    $('swapBtn').fire('click');
    assert.deepStrictEqual(tab().tiles, ['clip-0', 'clip-1'], 'the Swap button too');
    $('spotlightBtn').fire('click');
    assert.deepStrictEqual([tab().layout, $('spotlightBtn').getAttribute('aria-pressed'), $('gridBtn').getAttribute('aria-pressed')], ['spotlight', 'true', 'false']);
    $('splitBtn').fire('click');
    assert.strictEqual(tab().layout, 'split');
    $('splitBtn').fire('click');
    assert.strictEqual(tab().layout, 'grid', 'Split again goes back to the grid');
    ui.setState(S.openVideo(S.toggleCapture(ui.getState()).state, 'clip-2').state);
    assert.deepStrictEqual([$('swapBtn').hidden, $('splitBtn').hidden], [true, true], 'Swap and Split only at N = 2');
    assert.strictEqual(key('x').defaultPrevented, false, 'X is not a key at N = 3');
    assert.strictEqual($('cells').classList.contains('dense'), false);
    for (const id of ['clip-3', 'clip-4']) ui.setState(S.openVideo(ui.getState(), id).state);
    assert.strictEqual($('cells').classList.contains('dense'), true, '5 videos: the dense grid');
  });

  // Per-tile chrome: ⓘ card, offsets in frames / ms, ▲ / ▼, ended, letterbox insets.
  mount({ tiles: ['clip-0', 'clip-1', 'clip-2'] }, ({ $, ui, tab, cellOf, dom, host }) => {
    const c1 = cellOf('clip-1');
    // Letterboxing: a 16:9 clip in a 340 x 185 cell has bars left and right (clip-0 is 3840 x 2160, 1.78 < 1.84).
    const c0 = cellOf('clip-0');
    assert.strictEqual(c0.style['--pic-t'], '0px');
    assert.ok(parseInt(c0.style['--pic-l'], 10) > 0 && c0.style['--pic-l'] === c0.style['--pic-r'], 'the tile chrome hugs the picture');
    // ⓘ details card with the values that differ from A marked.
    c1.querySelector('.mute-mini[data-act="info"]').fire('click');
    assert.ok(c1.classList.contains('show-stats'), 'ⓘ opens the details card');
    const card = c1.querySelector('.tile-stats');
    assert.strictEqual(card.querySelector('.iname').textContent, 'shot_01_raw.mov');
    assert.ok([...card.querySelectorAll('dd.diff')].length >= 1, 'what differs from A is marked');
    assert.strictEqual(c1.querySelector('.mute-mini[data-act="info"]').getAttribute('aria-pressed'), 'true');
    card.querySelector('.tile-stats-close').fire('click');
    assert.deepStrictEqual([c1.classList.contains('show-stats'), tab().statsOpen], [false, []], '× closes it');
    assert.strictEqual(dom.doc.activeElement, c1.querySelector('.mute-mini[data-act="info"]'), 'focus goes back to ⓘ');
    // Offset stepper: frames, the value opens Compare › video, its unit switch keeps the moment.
    ui.dispatch('sync');
    assert.ok($('stage').classList.contains('sync-mode'));
    c1.querySelector('.sync-pill [data-d="1"]').fire('click');
    c1.querySelector('.sync-pill [data-d="1"]').fire('click');
    assert.strictEqual(c1.querySelector('.offv').textContent, '+2 f');
    c1.querySelector('.offv').fire('click');
    assert.strictEqual(ui.controls.view(), 'cmpVid', 'the offset value opens the video page');
    const chip = (label) => [...$('panel').querySelectorAll('.chip')].find((b) => b.textContent === label);
    assert.strictEqual(chip('Frames').getAttribute('aria-pressed'), 'true');
    chip('Time ms').fire('click');
    assert.deepStrictEqual(S.getOffset(tab(), 'clip-1'), { unit: 'ms', v: 83.333 }, '2 frames at 24 fps = 83.333 ms');
    assert.strictEqual(c1.querySelector('.offv').textContent, '+83.3 ms');
    c1.querySelector('.sync-pill [data-d="-1"]').fire('click');
    assert.deepStrictEqual(S.getOffset(tab(), 'clip-1'), { unit: 'ms', v: 73.333 }, 'a ms nudge is 10 ms');
    const reset = [...$('panel').querySelectorAll('button')].find((b) => b.textContent === 'Reset offset');
    assert.ok(reset, 'Reset offset is offered');
    reset.fire('click');
    assert.deepStrictEqual(S.getOffset(tab(), 'clip-1'), { unit: 'ms', v: 0 }, 'Reset keeps the unit');
    const sw = (label) => [...$('panel').querySelectorAll('[role="switch"]')].find((b) => b.textContent.startsWith(label));
    sw('B sets the clock').fire('click');
    assert.strictEqual(tab().clockId, 'clip-1', 'the page sets the clock');
    sw('Sound from B').fire('click');
    assert.strictEqual(tab().soundId, 'clip-1', 'and the sound');
    ui.controls.closeAll(false);
    // ▲ / ▼ move the tile one slot; a focused button keeps the focus on the moved tile.
    const down = c1.querySelector('[data-act="move"][data-d="1"]');
    down.focus();
    down.fire('click');
    assert.deepStrictEqual(tab().tiles, ['clip-0', 'clip-2', 'clip-1'], '▼ moves B one slot later');
    assert.deepStrictEqual(last(host.log, 'tileOrder').order, ['clip-0', 'clip-2', 'clip-1']);
    assert.strictEqual(cellOf('clip-1'), c1, 'the same cell (it glides, it is not rebuilt)');
    const focused = dom.doc.activeElement;
    assert.ok(focused && focused.dataset.act === 'move' && c1.contains(focused), 'focus stays on the moved tile');
    assert.strictEqual(c1.querySelector('[data-act="move"][data-d="1"]').disabled, true, 'the last slot cannot move later');
    // Out of range: an offset past the clip's end shows "ended" and no frame number.
    ui.setState(S.setOffset(S.setOffsetUnit(ui.getState(), 'clip-2', 'frames'), 'clip-2', 300));
    assert.ok(cellOf('clip-2').classList.contains('ended'), 'past its end the tile says so');
    assert.strictEqual(cellOf('clip-2').querySelector('.fr').textContent, '—');
  });

  // 2-click remove: the pointer leaving the tile cancels the question; N = 2 removes at once (back to one video).
  mount({ tiles: ['clip-0', 'clip-1', 'clip-2'] }, ({ ui, tab, cellOf, $ }) => {
    cellOf('clip-1').querySelector('[data-rm]').fire('click');
    assert.strictEqual(tab().removeConfirmId, 'clip-1');
    cellOf('clip-1').querySelector('canvas').fire('pointermove', { clientX: 400, clientY: 50 });
    $('cells').fire('pointerleave');
    assert.strictEqual(tab().removeConfirmId, null, 'leaving the tile cancels "Remove?"');
    cellOf('clip-1').querySelector('[data-rm]').fire('click');
    cellOf('clip-1').querySelector('[data-rm]').fire('click');
    assert.deepStrictEqual(tab().tiles, ['clip-0', 'clip-2']);
    cellOf('clip-2').querySelector('[data-rm]').fire('click');
    assert.deepStrictEqual(tab().tiles, ['clip-0'], 'with 2 videos one click goes back to the single player');
    void ui;
  });

  // Tile drag: reorder in the grid, dock the Spotlight main tile, the click after a drop does not play.
  mount({ tiles: ['clip-0', 'clip-1'] }, ({ $, tab, cellOf, host, dom }) => {
    const stage = $('stage');
    const a = cellOf('clip-0').querySelector('canvas');
    a.fire('pointerdown', { button: 0, pointerId: 5, clientX: 100, clientY: 100 });
    stage.fire('pointermove', { pointerId: 5, clientX: 300, clientY: 100 });
    assert.ok(stage.classList.contains('tile-dragging'), 'past 6 px the tile lifts');
    stage.fire('pointermove', { pointerId: 5, clientX: 500, clientY: 100 });
    const sk = stage.querySelector('.skeleton');
    assert.ok(sk && !sk.hidden && sk.textContent === 'Move here', 'the drop outline shows');
    stage.fire('pointerup', { pointerId: 5, clientX: 500, clientY: 100 });
    assert.deepStrictEqual(tab().tiles, ['clip-1', 'clip-0'], 'dropping on B moves A there');
    assert.deepStrictEqual(last(host.log, 'tileOrder').order, ['clip-1', 'clip-0'], 'the host learns the order');
    assert.strictEqual(sk.hidden, true);
    const playing = tab().playing;
    cellOf('clip-0').querySelector('canvas').fire('click');
    assert.ok(!dom.timers.some((t) => t && t.ms === 250) && tab().playing === playing, 'the click of the drop does not play / pause');
    // Spotlight: the main tile docks to the edge it is dropped near.
    stage.fire('pointerup', { pointerId: 99 });
  });
  mount({ tiles: ['clip-0', 'clip-1', 'clip-2'], layout: 'spotlight', spotlightId: 'clip-0' }, ({ $, tab, cellOf, ui }) => {
    const stage = $('stage');
    cellOf('clip-0').querySelector('canvas').fire('pointerdown', { button: 0, pointerId: 6, clientX: 340, clientY: 100 });
    stage.fire('pointermove', { pointerId: 6, clientX: 10, clientY: 185 });
    assert.strictEqual(stage.querySelector('.skeleton').textContent, 'Dock Spotlight left');
    stage.fire('pointerup', { pointerId: 6, clientX: 10, clientY: 185 });
    assert.strictEqual(tab().dock, 'left', 'the main tile docks left');
    assert.ok($('splitter').classList.contains('v'), 'the splitter turns vertical');
    // A strip tile dropped on the main tile swaps into Spotlight.
    cellOf('clip-2').querySelector('canvas').fire('pointerdown', { button: 0, pointerId: 7, clientX: 600, clientY: 300 });
    stage.fire('pointermove', { pointerId: 7, clientX: 200, clientY: 180 });
    stage.fire('pointerup', { pointerId: 7, clientX: 200, clientY: 180 });
    assert.deepStrictEqual([tab().spotlightId, tab().tiles], ['clip-2', ['clip-2', 'clip-1', 'clip-0']],
      'C swaps places with the main tile (as Compare: the main tile is A)');
    // A cancelled lift changes nothing.
    cellOf('clip-1').querySelector('canvas').fire('pointerdown', { button: 0, pointerId: 8, clientX: 600, clientY: 60 });
    stage.fire('pointermove', { pointerId: 8, clientX: 200, clientY: 180 });
    ui.parts.tileDrag.cancel();
    assert.strictEqual(stage.classList.contains('tile-dragging'), false, 'a cancelled lift lets go');
    assert.deepStrictEqual(tab().tiles, ['clip-2', 'clip-1', 'clip-0']);
  });

  // Seek bar hover: tip "time · #frame", the clock letter in Compare, the thumbnail through the engine.
  mount({ tiles: ['clip-0'] }, ({ $, engine }) => {
    const seek = $('seek');
    seek.fire('pointermove', { clientX: 340 });
    assert.strictEqual($('tip').textContent, '0:05.000 · #121', 'time · frame (middle dot, 1-based frame)');
    assert.strictEqual($('tip').hidden, false);
    assert.strictEqual(engine.fake.thumbnails, 1, 'the engine draws the thumbnail');
    const thumb = $('bar').querySelector('canvas.seek-thumb');
    assert.ok(thumb && !thumb.hidden, 'the thumbnail shows');
    seek.fire('pointerleave');
    assert.deepStrictEqual([$('tip').hidden, thumb.hidden, engine.fake.thumbHover], [true, true, false], 'leaving hides both');
  });
  mount({ tiles: ['clip-0', 'clip-1'] }, ({ $ }) => {
    $('seek').fire('pointermove', { clientX: 0 });
    assert.strictEqual($('tip').textContent, 'A 0:00.000 · #1', 'Compare: the clock tile\'s letter first');
  });

  // Wheel, zoom, pan, − / +, Ctrl keys, the go-to box.
  mount({ tiles: ['clip-0'] }, ({ $, ui, tab, cellOf, key, host, dom }) => {
    const stage = $('stage');
    const f0 = tab().frame;
    const w = stage.fire('wheel', { deltaY: 100 });
    assert.deepStrictEqual([tab().frame, w.defaultPrevented], [f0 + 1, true], 'wheel steps one frame while paused');
    stage.fire('wheel', { deltaY: -100 });
    assert.strictEqual(tab().frame, f0);
    stage.fire('wheel', { deltaY: 0, deltaX: 100, shiftKey: true });
    assert.strictEqual(tab().frame, f0 + 24, 'Shift+wheel takes the 1 s jump (deltaX on Windows)');
    ui.dispatch('playPause');
    stage.fire('wheel', { deltaY: 100 });
    assert.strictEqual(tab().frame, f0 + 24, 'no wheel step while playing');
    ui.dispatch('playPause');
    stage.fire('wheel', { deltaY: -100, ctrlKey: true, clientX: 340, clientY: 185 });
    assert.ok(tab().zoom > 1.2 && tab().zoom < 1.3, 'Ctrl+wheel zooms (one notch ≈ ×1.22)');
    assert.deepStrictEqual([tab().panX, tab().panY], [0, 0], 'about the pointer: the stage centre stays');
    // Drag to pan the zoomed picture; the click that ends it is not play / pause.
    const cv = cellOf('clip-0').querySelector('canvas');
    cv.fire('pointerdown', { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    stage.fire('pointermove', { pointerId: 2, clientX: 130, clientY: 90 });
    stage.fire('pointermove', { pointerId: 2, clientX: 150, clientY: 80 });
    stage.fire('pointerup', { pointerId: 2 });
    assert.deepStrictEqual([tab().panX, tab().panY], [50, -20], 'drag pans by the pointer travel');
    const playing = tab().playing;
    cv.fire('click');
    assert.strictEqual(tab().playing, playing, 'the click after a pan does not play / pause');
    // − / + zoom in the single player; the bar's picture page follows.
    const z = tab().zoom;
    key('+');
    assert.ok(Math.abs(tab().zoom - z * 1.25) < 1e-9, '+ zooms in');
    key('-');
    assert.ok(Math.abs(tab().zoom - z) < 1e-9, '− zooms out');
    ui.dispatch('resetView');
    assert.deepStrictEqual([tab().zoom, tab().panX], [1, 0]);
    // Ctrl+← / → step a frame; Ctrl+C copies the frame; Ctrl+G opens the go-to box.
    const f1 = tab().frame;
    assert.strictEqual(key('ArrowRight', { ctrlKey: true }).defaultPrevented, true);
    assert.strictEqual(tab().frame, f1 + 1, 'Ctrl+→ one frame');
    key('ArrowLeft', { ctrlKey: true });
    assert.strictEqual(tab().frame, f1);
    const copies = host.log.filter((m) => m.type === 'copyFrame').length;
    key('c', { ctrlKey: true });
    assert.strictEqual(host.log.filter((m) => m.type === 'copyFrame').length, copies + 1, 'Ctrl+C copies the frame');
    key('g', { ctrlKey: true });
    const box = $('goto');
    assert.strictEqual(box.hidden, false, 'Ctrl+G opens the go-to box');
    const input = box.querySelector('input');
    assert.strictEqual(dom.doc.activeElement, input);
    input.value = '1:75';
    const bad = input.fire('keydown', { key: 'Enter' });
    assert.deepStrictEqual([input.getAttribute('aria-invalid'), box.hidden, bad.propagationStopped], ['true', false, true],
      'a typo is marked and the box stays; keys typed here never reach the player');
    input.value = '#10';
    input.fire('keydown', { key: 'Enter' });
    assert.deepStrictEqual([box.hidden, tab().frame], [true, 9], 'frame 10 (as the counter shows it) is index 9');
    assert.strictEqual(key('Escape').defaultPrevented, false, 'nothing open: Esc goes on to VS Code');
  });
  // − / + in Compare nudge the hovered tile.
  mount({ tiles: ['clip-0', 'clip-1'] }, ({ tab, cellOf, key }) => {
    cellOf('clip-1').querySelector('canvas').fire('pointermove', { clientX: 500, clientY: 100 });
    key('+');
    key('+');
    key('-');
    assert.deepStrictEqual([S.getOffset(tab(), 'clip-1'), S.getOffset(tab(), 'clip-0')], [{ unit: 'frames', v: 1 }, { unit: 'frames', v: 0 }],
      '− / + nudge the tile under the pointer');
    assert.strictEqual(tab().zoom, 1, 'and do not zoom');
  });

  // Zen Mode Esc Esc, auto-pause of hidden tabs, the live region, the idle bar in fullscreen.
  mount({ tiles: ['clip-0'] }, ({ $, ui, tab, host, key, dom }) => {
    ui.onHostMessage({ type: 'focusMode', active: true });
    key('Escape');
    key('Escape');
    assert.ok(host.log.some((m) => m.type === 'focusModeExited'), 'Esc Esc in Zen Mode tells the host');
    ui.dispatch('playPause');
    ui.onHostMessage({ type: 'setVisible', visible: false });
    assert.strictEqual(tab().playing, false, 'a hidden tab pauses');
    ui.onHostMessage({ type: 'setVisible', visible: true });
    assert.strictEqual(tab().playing, true, 'and resumes what it paused');
    ui.dispatch('playPause');
    ui.onHostMessage({ type: 'setVisible', visible: false });
    ui.onHostMessage({ type: 'setVisible', visible: true });
    assert.strictEqual(tab().playing, false, 'a paused tab stays paused');
    // The live region: emptied, then written 50 ms later (a repeated text is read again).
    ui.dispatch('cycleTime');
    const live = $('live');
    assert.strictEqual(live.textContent, '', 'emptied first');
    const t50 = dom.timers.filter(Boolean).find((t) => t.ms === 50);
    assert.ok(t50, 'written 50 ms later');
    t50.fn();
    assert.strictEqual(live.textContent, 'Timecode');
    assert.strictEqual(dom.doc.body.classList.contains('idle'), false, 'not fullscreen: the bar never hides');
  });

  // The rendered harness wires the same modules.
  const html = buildMockupHtml({ scenario: 'grid-3' });
  for (const src of ['media/compare-grid.js', 'media/player-ui-tiles.js', 'media/player-ui-input.js']) {
    assert.ok(html.indexOf(`data-src="${src}"`) >= 0 && html.indexOf(`data-src="${src}"`) < html.indexOf('data-src="media/player-ui.js"'),
      `the harness inlines ${src} before media/player-ui.js`);
  }
  const harness = html.slice(html.lastIndexOf('<script>'));
  for (const w of ['VpePlayerUiTiles', 'VpePlayerUiInput', 'CompareGrid']) assert.ok(harness.includes(`${w}: globalThis.${w}`), `the harness passes ${w}`);
  assert.ok(FIXTURE.includes('id="menu"'), 'the shared markup has the tile menu');
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

// ---- 9. Boundary contract: syntax-aware AST check (TypeScript parser) + .dependency-cruiser.cjs rules ----
{
  const ts = require('typescript');
  /** Collect all executable Identifier names (including inside template literal `${...}` expressions). */
  function findForbiddenIdentifiers(sourceText, forbiddenSet) {
    const sf = ts.createSourceFile('check.js', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const hits = new Set();
    const visit = (node) => {
      if (ts.isIdentifier(node) && forbiddenSet.has(node.text)) {
        // Ignore property names on member access (e.g. `obj.window`) and object literal keys (`{ document: 1 }`).
        const p = node.parent;
        const isPropName = (ts.isPropertyAccessExpression(p) && p.name === node)
          || (ts.isPropertyAssignment(p) && p.name === node)
          || (ts.isMethodDeclaration(p) && p.name === node);
        if (!isPropName) hits.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return [...hits];
  }

  const STATE_FORBIDDEN = new Set(['document', 'window', 'acquireVsCodeApi', 'LibavPlayer', 'navigator', 'require', 'createEngine', 'Worker', 'SharedWorker']);
  const UI_FORBIDDEN = new Set(['acquireVsCodeApi', 'vscode', 'LibavPlayer', 'createEngine', 'VpeGlRenderer', 'VpeCompareCompositor', 'VpeFramePlayer', 'require', 'postMessage', 'Worker', 'SharedWorker']);

  // Negative fixtures: prove executable template expressions and Worker instantiation are caught.
  assert.deepStrictEqual(findForbiddenIdentifiers('const x = `${document.title}`;', STATE_FORBIDDEN), ['document'], 'catches template-expression DOM leak');
  assert.deepStrictEqual(findForbiddenIdentifiers('const w = new Worker("a.js");', UI_FORBIDDEN), ['Worker'], 'catches Worker instantiation');
  assert.deepStrictEqual(findForbiddenIdentifiers('acquireVsCodeApi();', UI_FORBIDDEN), ['acquireVsCodeApi'], 'catches VS Code API leak');

  const stateSrc = fs.readFileSync(path.join(ROOT, 'media/player-state.js'), 'utf8');
  assert.deepStrictEqual(findForbiddenIdentifiers(stateSrc, STATE_FORBIDDEN), [], 'media/player-state.js has zero forbidden references');
  for (const f of ['player-ui.js', 'player-ui-tools.js', 'player-ui-lifecycle.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.deepStrictEqual(findForbiddenIdentifiers(src, UI_FORBIDDEN), [], `media/${f} has zero forbidden references`);
  }

  // Rendered harness divider is keyboard-reachable and labelled as a slider.
  const renderedHtml = buildMockupHtml({ scenario: 'split-wipe' });
  assert.ok(/id="divider"[^>]*role="slider"[^>]*tabindex="0"/.test(renderedHtml), 'rendered mockup divider is a focusable slider');

  // The DOM-free halves load in Node with no browser globals (this test requires them at the top).
  assert.strictEqual(typeof S.deriveUi, 'function');
  assert.strictEqual(typeof PUI.create, 'function');
  // The dependency rules that back this up are present with non-empty forbidden patterns.
  const depRules = require('../../.dependency-cruiser.cjs').forbidden;
  for (const name of ['player-state-imports-nothing', 'player-state-no-core', 'player-ui-not-to-host-or-engine', 'player-ui-no-core']) {
    const rule = depRules.find((r) => r.name === name);
    assert.ok(rule && rule.severity === 'error' && rule.from && rule.from.path, `.dependency-cruiser.cjs enforces ${name}`);
  }
  for (const name of ['player-ui-not-to-host-or-engine', 'player-ui-no-core']) {
    const from = new RegExp(depRules.find((r) => r.name === name).from.path);
    for (const f of ['player-ui', 'player-ui-tiles', 'player-ui-input', 'player-ui-tools', 'player-ui-lifecycle']) {
      assert.ok(from.test(`media/${f}.js`), `${name} covers media/${f}.js`);
    }
    assert.ok(!from.test('media/player-ui-other.js'), `${name} names its modules`);
  }
  // checkJs (tools/check-js.js) covers the controller, its modules and the production adapters.
  const checked = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.check.json'), 'utf8')).files;
  for (const f of ['player-ui.js', 'player-ui-tiles.js', 'player-ui-input.js', 'player-ui-tools.js', 'player-ui-lifecycle.js',
    'player-engine-adapter.js', 'player-host-adapter.js']) assert.ok(checked.includes(`media/${f}`), `tsconfig.check.json checks media/${f}`);
  // Multi-pointer guard on bindSplitDivider: a second pointer cannot hijack or terminate an active drag.
  {
    const el = createDom('<div id="d" role="slider" tabindex="0"></div>').$('d');
    let cur = 0.5;
    let ended = 0;
    PUI.bindSplitDivider(el, {
      stageRect: () => ({ left: 0 }),
      pictureRect: () => ({ x: 0, w: 100 }),
      get: () => cur,
      set: (r) => { cur = r; },
      onDragEnd: () => { ended++; },
    });
    el.fire('pointerdown', { button: 0, pointerId: 1, clientX: 50 });
    el.fire('pointerdown', { button: 0, pointerId: 2, clientX: 10 }); // ignored
    el.fire('pointermove', { pointerId: 2, clientX: 10 }); // ignored
    assert.strictEqual(cur, 0.5, 'stray pointer move ignored');
    el.fire('pointerup', { pointerId: 2 }); // ignored
    assert.strictEqual(ended, 0, 'stray pointer up does not end drag');
    el.fire('pointermove', { pointerId: 1, clientX: 80 });
    assert.strictEqual(cur, 0.8, 'initiating pointer moves divider');
    el.fire('pointerup', { pointerId: 1 });
    assert.strictEqual(ended, 1, 'initiating pointer ends drag');
  }
}

// ---- 10. Phase 3 and 4 wired into create(): VpePlayerUiTools (notices, inspection, subtitles, frame export) and
// VpePlayerUiLifecycle (prefs sync, goto / resume, rail handoff, overlay, lifecycle bridge), over the same fixture ----
const toolWidgets = () => ({
  ...realWidgets(),
  VpePlayerUiTools: require('../../media/player-ui-tools'),
  VpePlayerUiLifecycle: require('../../media/player-ui-lifecycle'),
  VpeReducedResNotice: require('../../media/reduced-res-notice'),
  VpeSlowNotice: require('../../media/slow-notice'),
});
/** The fake engine plus the optional tool methods a decoder adapter may have (none decodes anything). */
const toolEngine = (base = createFakeEngine()) => ({
  ...base,
  draw() {},
  statsText: (id) => `stats ${id}`,
  packetIndex: () => [{ t: 0, key: true }, { t: 1, key: false }, { t: 2, key: true }, { t: 4, key: true }],
  chapters: () => [{ start: 0, title: 'Intro' }, { start: 5, title: 'Middle' }],
  pixelAt: (_id, x, y) => ({ text: `rgb(${x},${y},0)` }),
  cueAt: (_id, t, track) => (t >= 1 && t < 3 ? `cue ${track}` : null),
  pictureInfo: () => ({ nativeLossy: true, video: { width: 1280, height: 720, sourceWidth: 3840, sourceHeight: 2160 } }),
});
/** mount() for the tool and lifecycle wiring; `fn` may be async (the globals stay until it settles). */
async function mountTools(initial, fn, extra = {}) {
  const dom = fixtureDom();
  const GLOBALS = {
    document: dom.doc, window: dom.win, innerWidth: dom.win.innerWidth, innerHeight: dom.win.innerHeight,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, Element: FakeElement, HTMLElement: FakeElement, Node: FakeNode,
  };
  const savedGlobals = Object.fromEntries(Object.keys(GLOBALS).map((k) => [k, Object.getOwnPropertyDescriptor(global, k)]));
  Object.assign(global, GLOBALS);
  try {
    const engine = extra.engine || toolEngine();
    const host = createFakeHost({ clips: engine.clips });
    const docKeys0 = dom.doc.listenerCount('keydown');
    const winHide0 = dom.win.listenerCount('pagehide');
    const ui = PUI.create({ doc: dom.doc, win: dom.win, stateApi: S, engine, host, widgets: toolWidgets(), initial, tickMs: 42, ...(extra.env || {}) });
    host.connect(ui.onHostMessage);
    ui.render();
    const tab = () => S.getTab(ui.getState());
    const key = (k, mods = {}) => dom.doc.body.fire('keydown', { key: k, ...mods });
    const timer = (ms) => { const i = dom.timers.findIndex((x) => x && x.ms === ms); if (i < 0) return null; const t = dom.timers[i]; dom.timers[i] = null; return t; };
    const run = (ms) => { const t = timer(ms); assert.ok(t, `a ${ms} ms timer is pending`); t.fn(); };
    const last = (type) => host.log.filter((m) => m.type === type).pop();
    const count = (type) => host.log.filter((m) => m.type === type).length;
    /** One beat of create()'s playback clock (its 42 ms interval). */
    const clock = () => { const t = dom.timers.find((x) => x && x.ms === 42); assert.ok(t, 'the playback clock runs'); t.fn(); };
    try {
      await fn({ dom, ui, host, engine, tab, key, timer, run, clock, last, count, $: dom.$, docKeys0, winHide0 });
    } finally { ui.dispose(); }
  } finally {
    for (const [k, d] of Object.entries(savedGlobals)) { if (d) Object.defineProperty(global, k, d); else delete global[k]; }
  }
}
const tick = () => new Promise((r) => setImmediate(r));

async function phase34() {
  assert.ok(FIXTURE.includes('id="subs"') && FIXTURE.includes('id="overlay"') && FIXTURE.includes('id="notice"'),
    'the shared stage has the cue layer, the overlay and the notice banner');
  assert.ok(/<div id="overlay" hidden>/.test(FIXTURE), 'the mockup overlay starts hidden');

  // Notices: the reduced-resolution offer before an exact tool, the slow-playback hint, Esc after the panels, focus back to Play.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, host, key, $, dom }) => {
    const n = ui.parts.notices;
    assert.ok(n && ui.parts.insp && ui.parts.subs && ui.parts.frameExport, 'the tool controllers are mounted');
    assert.ok(ui.parts.prefsSync && ui.parts.gotoResume && ui.parts.railCtl && ui.parts.overlay && ui.parts.bridge, 'and the lifecycle ones');
    key('w');
    assert.strictEqual($('notice').hidden, false, 'W first offers the full-resolution picture (exactTool)');
    assert.match($('noticeText').textContent, /^Playing at 1280×720 \(8-bit\)/, 'media/reduced-res-notice.js words it');
    assert.strictEqual(n.kind(), 'reducedRes');
    $('noticeAction').fire('click');
    assert.deepStrictEqual(host.log.filter((m) => m.type === 'action').pop(), { type: 'action', id: 'fullRes' }, 'its action goes to the host');
    n.hide();
    assert.strictEqual(n.getDismissals().reducedRes, true, 'any close is remembered');
    ui.onHostMessage({ type: 'slowPlayback', variant: 'every' });
    assert.strictEqual(n.kind(), 'slowPlayback');
    assert.match($('noticeText').textContent, /every frame is shown/);
    $('noticeAction').focus();
    key('?');
    assert.strictEqual(ui.controls.sheetOpen(), true);
    key('Escape');
    assert.deepStrictEqual([ui.controls.anyOpen(), $('notice').hidden], [false, false], 'Esc: the sheet goes before the banner');
    $('noticeAction').focus();
    key('Escape');
    assert.strictEqual($('notice').hidden, true, 'the second Esc closes the banner');
    assert.strictEqual(dom.doc.activeElement, $('play'), 'and the focus goes back to Play');
    assert.strictEqual(n.getDismissals().slowPlayback, true, 'Esc counts as a close');
    n.setDismissals({});
    ui.onHostMessage({ type: 'slowPlayback', variant: 'setupFfmpeg', offerSetup: true });
    assert.strictEqual(n.kind(), 'slowPlayback');
    ui.onHostMessage({ type: 'hideSlowPlaybackNotice' });
    assert.deepStrictEqual([$('notice').hidden, n.getDismissals().slowPlayback], [true, true], 'turned off in Settings: closed and remembered');
  });

  // Story C: a toast that repeats the open banner is dropped; Live transcode / streaming keeps the slow hint away.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, $ }) => {
    const n = ui.parts.notices;
    ui.onHostMessage({ type: 'slowPlayback', variant: 'every' });
    assert.strictEqual(n.kind(), 'slowPlayback');
    ui.onHostMessage({ type: 'toast', text: 'hello' });
    assert.strictEqual($('toast').textContent, 'hello', 'an unrelated toast shows beside the banner');
    ui.onHostMessage({ type: 'toast', text: $('noticeText').textContent });
    assert.strictEqual($('toast').textContent, 'hello', 'a toast with the banner text is suppressed');
    n.hide();
    ui.onHostMessage({ type: 'toast', text: 'Transcoding started' });
    assert.strictEqual($('toast').textContent, 'Transcoding started', 'no Live chip on screen: the status toast shows');
    $('remoteLiveBtn').hidden = false;
    ui.onHostMessage({ type: 'toast', text: 'Transcoding at 720p' });
    assert.strictEqual($('toast').textContent, 'Transcoding started', 'the visible Live chip already says it');
  });
  // "Use full resolution" switched the decoder in place: the reduced-picture offer goes at once (it no longer
  // applies) and the lower-priority notice waiting behind it shows.
  const switchEngine = toolEngine();
  let lossy = true;
  switchEngine.pictureInfo = (id) => ({ clipId: id, nativeLossy: lossy, transcoded: false, streaming: false,
    video: { width: 1280, height: 720, sourceWidth: 3840, sourceHeight: 2160 } });
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, key }) => {
    const n = ui.parts.notices;
    n.setDismissals({});
    key('w');
    assert.strictEqual(n.kind(), 'reducedRes');
    ui.onHostMessage({ type: 'slowPlayback', variant: 'every' });
    assert.deepStrictEqual([n.kind(), n.pendingKinds()], ['reducedRes', ['slowPlayback']], 'slow advice waits behind it');
    ui.render();
    assert.strictEqual(n.kind(), 'reducedRes', 'still a reduced picture: the offer stays');
    lossy = false;
    ui.render();
    assert.deepStrictEqual([n.kind(), n.pendingKinds()], ['slowPlayback', []],
      'full resolution: the offer is gone and the queued notice shows');
  }, { engine: switchEngine });
  const liveEngine = toolEngine();
  liveEngine.pictureInfo = (id) => ({ clipId: id, nativeLossy: false, transcoded: true, streaming: false, video: null });
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, $ }) => {
    const n = ui.parts.notices;
    n.setDismissals({});
    ui.onHostMessage({ type: 'slowPlayback', variant: 'every' });
    assert.deepStrictEqual([n.isOpen(), $('notice').hidden], [false, true],
      'pictureInfo says Live transcode: the local slow-playback notice stays away');
  }, { engine: liveEngine });

  // Inspection: W, X (one video), Shift+I, Shift+X, { }, PageUp / PageDown, a click with the inspector on, ⚙ › Inspection, Esc order.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, host, tab, key, $, dom }) => {
    const insp = ui.parts.insp;
    ui.parts.notices.setDismissals({ reducedRes: true });
    assert.strictEqual(key('w').defaultPrevented, true);
    assert.strictEqual(insp.getState().scopes, 'waveform', 'W: the luma waveform');
    assert.strictEqual($('toast').textContent, 'Luma waveform');
    key('x');
    assert.strictEqual(insp.getState().inspector, 'loupe', 'X: the pixel inspector with one video');
    const playing = tab().playing;
    dom.$('cells').querySelector('canvas').fire('click', { clientX: 340, clientY: 185 });
    assert.match(host.log.filter((m) => m.type === 'copyText').pop().text, /^rgb\(\d+,\d+,0\)$/, 'a click copies the pixel under it');
    assert.strictEqual(tab().playing, playing, 'and does not play');
    key('I', { shiftKey: true });
    assert.strictEqual(insp.getState().stats, true, 'Shift+I: the stats overlay');
    assert.strictEqual(dom.doc.querySelector('pre.stats').textContent, 'stats clip-0');
    key('X', { shiftKey: true });
    await tick();
    assert.strictEqual(insp.getState().xray, true, 'Shift+X: Codec X-ray');
    ui.dispatch('seek', 0);
    key('}');
    await tick(); await tick();
    assert.strictEqual(tab().frame, 48, '}: the next keyframe (2 s)');
    key('{');
    await tick(); await tick();
    assert.strictEqual(tab().frame, 0, '{: the one before');
    key('PageDown');
    assert.deepStrictEqual([tab().frame, $('toast').textContent], [120, 'Chapter 2: Middle'], 'PageDown: the next chapter');
    ui.controls.show('inspect', $('cog'));
    const rows = [...$('panel').querySelectorAll('[data-tool]')].map((b) => b.dataset.tool);
    assert.deepStrictEqual(rows, ['Scopes', 'Inspector', 'Stats', 'Codec X-ray'], '⚙ › Inspection lists the tools');
    key('Escape');
    assert.strictEqual(ui.controls.anyOpen(), false, 'Esc: the panel first');
    key('Escape');
    assert.strictEqual(insp.getState().inspector, null, 'then the inspector');
    key('Escape');
    assert.strictEqual(insp.getState().scopes, null, 'then the scopes');
    key('Escape');
    assert.strictEqual(insp.getState().xray, false, 'then X-ray');
    assert.strictEqual(key('Escape').defaultPrevented, false, 'then nothing: Esc goes on');
  });
  await mountTools({ tiles: ['clip-0', 'clip-1'] }, async ({ ui, tab, key }) => {
    key('x');
    assert.deepStrictEqual(tab().tiles, ['clip-1', 'clip-0'], 'X is still Swap with two videos');
    assert.strictEqual(ui.parts.insp.getState().inspector, null);
    key('X', { shiftKey: true });
    await tick();
    assert.strictEqual(ui.parts.insp.getState().xray, true, 'Shift+X works in Compare too');
  });

  // Subtitles: C / V / Shift+V / G / H, the CC button, the host's tracks, the cue over the picture, the panel.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, tab, key, $ }) => {
    assert.strictEqual($('tracks').hidden, true, 'no CC button while the clip has no subtitle track');
    key('c');
    assert.strictEqual(ui.controls.view(), 'subs', 'C without tracks opens Settings › Subtitles (to load a file)');
    assert.match($('panel').textContent, /no subtitle tracks/, 'the page says there are none');
    key('c');
    assert.strictEqual(ui.controls.view(), null, 'C again closes it');
    $('tracks').fire('click');
    assert.strictEqual(ui.controls.view(), 'subs', 'the CC button without tracks opens Settings › Subtitles');
    key('Escape');
    ui.onHostMessage({ type: 'subs', tracks: [{ name: 'English' }, { lang: 'de' }] });
    assert.strictEqual($('tracks').hidden, false, 'the CC button shows once there is a track');
    assert.strictEqual($('toast').textContent, 'Subtitles: English', 'the first track comes on');
    assert.deepStrictEqual([$('tracks').classList.contains('on'), $('tracks').getAttribute('aria-label')], [true, 'Subtitles on: English']);
    ui.dispatch('seek', 48);
    assert.deepStrictEqual([$('subs').hidden, $('subs').textContent], [false, 'cue 0'], 'the cue of the shown time');
    assert.ok(/px$/.test($('subs').style.top) && $('subs').style.width, 'placed inside the picture');
    key('v');
    assert.deepStrictEqual([ui.parts.subs.getState().track, $('subs').textContent], [1, 'cue 1'], 'V: the next track');
    key('V', { shiftKey: true });
    assert.deepStrictEqual([ui.parts.subs.getState().track, $('subs').hidden], [-1, true], 'Shift+V: off');
    $('tracks').fire('click');
    assert.strictEqual(ui.parts.subs.getState().track, 1, 'the CC button turns the last track back on');
    key('h');
    assert.strictEqual($('toast').textContent, 'Subtitle delay +50 ms', 'H: later');
    key('g'); key('g');
    assert.strictEqual(ui.parts.subs.getState().delayMs, -50, 'G: earlier');
    ui.controls.show('subs', $('tracks'));
    const radios = [...$('panel').querySelectorAll('[role="radio"], [role="menuitemradio"]')].map((b) => b.textContent.trim());
    assert.deepStrictEqual(radios.map((t) => t.replace(/^\W+/, '')), ['Off', 'English', 'de'], "the panel lists the host's tracks");
    key('Escape');
    ui.setState(S.openVideo(S.toggleCapture(ui.getState()).state, 'clip-1').state);
    assert.strictEqual($('subs').hidden, true, 'no cue in Compare');
    assert.strictEqual(key('c').defaultPrevented, false, 'C is not a Compare key');
    void tab;
  });

  // Frame export: T, Shift+C, S, Ctrl+C without a clipboard, the A–B items, abQuery, exportGrab.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, host, tab, key, last, count, $ }) => {
    ui.parts.notices.setDismissals({ reducedRes: true });
    ui.dispatch('seek', 48);
    key('t');
    assert.strictEqual(last('copyText').text, '0:02.000', 'T copies m:ss.mmm');
    key('C', { shiftKey: true });
    assert.deepStrictEqual(last('copyLink'), { type: 'copyLink', frame: 49, t: 2.0208 }, 'Shift+C: a link to frame 49 (its middle)');
    assert.strictEqual(key('s').defaultPrevented, true);
    await tick(); await tick();
    const save = last('saveFrame');
    assert.ok(save && save.frame === 48 && save.data instanceof Uint8Array && save.data[1] === 0x50, 'S saves the shown frame as PNG bytes');
    const copies = count('copyFrame');
    key('c', { ctrlKey: true });
    assert.strictEqual(count('copyFrame'), copies + 1, 'Ctrl+C without a clipboard API: the host copies');
    key('Escape');
    ui.onHostMessage({ type: 'abQuery' });
    assert.deepStrictEqual(last('exportRange'), { type: 'exportRange', range: null }, 'abQuery with no range: the host says so');
    ui.dispatch('seek', 24); key('a');
    ui.dispatch('seek', 48); key('b');
    ui.onHostMessage({ type: 'abQuery', then: 'ffmpeg' });
    assert.deepStrictEqual([last('ffmpegRange').range.fa, last('ffmpegRange').range.fb], [24, 48], 'abQuery answers with the frames');
    ui.controls.show('ab', $('cog'));
    const item = [...$('panel').querySelectorAll('[data-tool]')].find((b) => b.dataset.tool === 'Export frames A–B…');
    assert.ok(item, '⚙ › A–B Range lists the exports');
    item.fire('click');
    assert.strictEqual(last('exportRange').range.fb, 48, 'Export frames A–B… sends the range');
    ui.dispatch('playPause');
    ui.onHostMessage({ type: 'exportGrab', id: 7, frame: 30 });
    await ui.parts.frameExport.idle();
    const f = last('exportFrame');
    assert.deepStrictEqual([f.id, f.frame, f.data instanceof Uint8Array, tab().frame, tab().playing], [7, 30, true, 30, false],
      'exportGrab shows frame 30 paused and answers with its PNG');
    ui.onHostMessage({ type: 'exportEnd' });
  });

  // Prefs: published on change, applied quietly without an echo, live settings, saved state and resume.
  {
    let store = { clipId: 'clip-0', time: 4, volume: 0.4, rate: 1.5 };
    const storage = { getState: () => store, setState: (s) => { store = s; } };
    await mountTools({ tiles: ['clip-0'] }, async ({ ui, tab, key, last, count, run, $ }) => {
      assert.deepStrictEqual([tab().frame, ui.getPrefs().volume, ui.getPrefs().rate], [96, 0.4, 1.5], 'resumes at the saved time with the saved prefs');
      assert.strictEqual($('toast').textContent, 'Resumed at 0:04.000 (Home: start)');
      assert.strictEqual(count('playbackPrefs'), 0, 'opening posts no prefs');
      key(']');
      assert.strictEqual(last('playbackPrefs').rate, ui.getPrefs().rate, '] tells the other tabs');
      const n = count('playbackPrefs');
      ui.onHostMessage({ type: 'playbackPrefs', prefs: { rate: 2, volume: 0.5, timeMode: 2 } });
      ui.render();
      assert.deepStrictEqual([ui.getPrefs().rate, ui.getPrefs().volume, ui.getPrefs().timeMode], [2, 0.5, 2], 'another tab\'s prefs apply');
      assert.strictEqual(count('playbackPrefs'), n, 'quietly: no echo');
      assert.strictEqual($('now').textContent, 'frame 97', 'the bar follows');
      ui.onHostMessage({ type: 'prefs', prefs: { jump: { arrow: 2 } } });
      ui.dispatch('seek', 0);
      key('ArrowRight');
      assert.strictEqual(tab().frame, 48, 'live settings: → jumps 2 s');
      run(300);
      assert.deepStrictEqual([store.clipId, store.time, store.rate], ['clip-0', 2, 2], 'the state is saved after a quiet spell');
    }, { env: { storage } });
  }

  // Live goto, rail handoff, Autoplay next, the overlay, pauseForTest, tile size.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, host, tab, key, last, run, clock, $ }) => {
    assert.ok(host.log.some((m) => m.type === 'rail' && m.op === 'self' && m.duration === 10 && m.width === 3840), 'the rail learns this clip once');
    ui.dispatch('playPause');
    ui.onHostMessage({ type: 'goto', frame: 100 });
    assert.deepStrictEqual([tab().frame, tab().playing, $('toast').textContent], [99, false, 'Frame 100'], 'a frame link: frame 100, paused');
    ui.onHostMessage({ type: 'goto', t: 3 });
    assert.strictEqual(tab().frame, 72);
    ui.onHostMessage({ type: 'railHandoff', id: 'h1', onEnd: 'next', fromAutoNext: true, rail: { open: false } });
    assert.deepStrictEqual(last('railAdopted'), { type: 'railAdopted', id: 'h1', ok: true }, 'the handoff applies and the host may close the source tab');
    assert.deepStrictEqual([ui.getPrefs().onEnd, tab().frame, tab().playing], ['next', 0, true], 'Autoplay next, from the start, playing');
    ui.onHostMessage({ type: 'railHandoffCancel', id: 'h1' });
    ui.dispatch('seek', 240);
    ui.dispatch('playPause'); ui.dispatch('playPause');
    clock();
    assert.ok(host.log.some((m) => m.type === 'neighbour' && m.d === 1 && m.auto === true), 'the natural end plays the next video in the folder');
    assert.deepStrictEqual(tab().tiles, ['clip-1']);
    ui.onHostMessage({ type: 'error', message: 'Cannot open this file', hint: 'Optional ffmpeg can play it.', action: 'setupFfmpeg' });
    assert.deepStrictEqual([$('overlay').hidden, $('overlay').classList.contains('error'), $('message').textContent, $('action').textContent],
      [false, true, 'Cannot open this file', 'Set up ffmpeg'], 'host errors show in #overlay with their action');
    $('action').fire('click');
    assert.deepStrictEqual(last('action'), { type: 'action', id: 'setupFfmpeg' });
    ui.onHostMessage({ type: 'openVideo', clipId: 'clip-2', replace: true });
    assert.strictEqual($('overlay').hidden, true, 'the next video clears it');
    if (!tab().playing) ui.dispatch('playPause');
    ui.onHostMessage({ type: 'pauseForTest' });
    assert.deepStrictEqual([tab().playing, $('toast').textContent], [false, 'Paused while ffmpeg is tested'], 'pauseForTest pauses');
    key(']');
    run(150);
    assert.strictEqual(last('tileSize').tile.rate, ui.getPrefs().rate, 'a speed change posts the tile size after a quiet spell');
  });

  // A–B clip marks in Compare: each end takes the pictures on screen (engine.markOf), and the clip export sends one
  // range per tile; the tile size carries each tile's cell.
  await mountTools({ tiles: ['clip-0', 'clip-1'] }, async ({ ui, engine, host, tab, key, last, run }) => {
    ui.parts.notices.setDismissals({ reducedRes: true });
    const fpsOf = (id) => engine.getClip(id).fps;
    // clip-0 (the clock) holds a picture 10 ms before its slot (variable frame rate); clip-1 shows its slot.
    engine.markOf = (id) => {
      const f = tab().frame;
      const s = f / fpsOf(id);
      return { shownRel: s, markRel: id === 'clip-0' ? s - 0.01 : s, synthetic: false, fps: fpsOf(id) };
    };
    const r0 = fpsOf('clip-0');
    ui.dispatch('seek', 24); key('a');
    ui.dispatch('seek', 48); key('b');
    ui.onHostMessage({ type: 'abQuery', then: 'clip' });
    const m = last('clipRange');
    assert.ok(m && Array.isArray(m.ranges), `Compare sends per-tile ranges: ${JSON.stringify(m)}`);
    assert.deepStrictEqual(m.ranges.map((x) => x.clipId), ['clip-0', 'clip-1']);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    const [a0, a1] = m.ranges.map((x) => x.range);
    assert.ok(near(a0.a, 24 / r0 - 0.01) && near(a0.b, 48 / r0 - 0.01) && a0.early === 0, `the clock's own picture times: ${JSON.stringify(a0)}`);
    assert.ok(near(a1.a, 24 / fpsOf('clip-1')) && near(a1.b, 48 / fpsOf('clip-1')), `the follower's own pictures: ${JSON.stringify(a1)}`);
    assert.ok(near(m.range.a, a0.a), 'range: the clock tile\'s');
    // A tile that was still seeking at A: its range is mapped through its offset (and the follower allowance).
    engine.markOf = (id) => (id === 'clip-1' ? null : { shownRel: tab().frame / r0, markRel: tab().frame / r0, synthetic: false, fps: r0 });
    ui.dispatch('seek', 24); key('a'); key('a');
    ui.onHostMessage({ type: 'abQuery', then: 'clip' });
    const r1 = last('clipRange').ranges[1].range;
    assert.ok(near(r1.early, 0.5 / fpsOf('clip-1')), `nominal follower range: ${JSON.stringify(r1)}`);
    // Each tile's cell goes with the tile size (the host decodes native tiles at their own cell).
    key(']');
    run(150);
    const ts = last('tileSize').tile;
    assert.deepStrictEqual(ts.tiles.map((x) => x.clipId), ['clip-0', 'clip-1']);
    assert.ok(ts.tiles.every((x) => x.w > 0 && x.h > 0), JSON.stringify(ts.tiles));
    assert.strictEqual(host.log.filter((x) => x.type === 'clipRange').every((x) => x.range), true);
  });

  // dispose() and pagehide leave nothing behind.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, dom, host, key, docKeys0, winHide0 }) => {
    ui.dispose();
    assert.strictEqual(dom.doc.listenerCount('keydown'), docKeys0, 'no key listener left');
    assert.strictEqual(dom.win.listenerCount('pagehide'), winHide0, 'no pagehide listener left');
    const n = host.log.length;
    key('w'); key('t');
    ui.onHostMessage({ type: 'goto', frame: 5 });
    ui.onHostMessage({ type: 'subs', tracks: [{ name: 'x' }] });
    assert.strictEqual(host.log.length, n, 'a disposed page posts nothing');
  });
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, dom, host, key }) => {
    dom.win.fire('pagehide');
    const n = host.log.length;
    key('t');
    ui.onHostMessage({ type: 'abQuery' });
    assert.strictEqual(host.log.length, n, 'pagehide disposes the page');
  });

  // Mixed frame rates (Astra #3): the bar follows the clock tile's fps and length, at the same moment, and
  // engine.shownFrame hears the clock's fps.
  {
    const clips = [{ id: 'a', name: 'a.mp4', fps: 24, frames: 48 }, { id: 'b', name: 'b.mp4', fps: 60, frames: 600 }];
    const base = toolEngine(createFakeEngine(clips));
    const calls = [];
    const engine = { ...base, shownFrame: (id, f, off, clockFps) => { calls.push([id, f, clockFps]); return base.shownFrame(id, f, off); } };
    const initial = S.syncClockMeta(S.createWorkspaceState({ tiles: ['a', 'b'], frame: 24 }), { fps: 24, maxFrame: 47 });
    await mountTools(initial, async ({ ui, tab, $ }) => {
      assert.ok(calls.length && calls.every((c) => c[2] === 24), 'shownFrame gets the clock fps (A: 24)');
      ui.dispatch('setClock', 'b');
      assert.deepStrictEqual([tab().clockId, tab().fps, tab().maxFrame, tab().frame], ['b', 60, 599, 60], 'B sets the clock: 1 s = frame 60');
      assert.deepStrictEqual([$('seek').max, $('seek').value], ['599', '60'], 'the seek bar follows B');
      assert.strictEqual($('now').textContent, '0:01.000', 'the readout keeps the moment');
      assert.strictEqual(calls[calls.length - 1][2], 60, 'shownFrame gets the clock fps (B: 60)');
      ui.dispatch('seek', 300); // 5 s, past A's 2 s
      ui.dispatch('removeTile', 'b');
      assert.deepStrictEqual([tab().tiles, tab().clockId, tab().fps, tab().maxFrame, tab().frame], [['a'], 'a', 24, 47, 47],
        'back to one tile (A): its rate and length, clamped to its last frame');
      assert.strictEqual($('seek').max, '47');
      assert.strictEqual(calls[calls.length - 1][2], 24);
      // The host adds B again and replaces it with itself as the clock via leaveCompare: same rule.
      ui.dispatch('capture');
      ui.onHostMessage({ type: 'openVideo', clipId: 'b' });
      ui.dispatch('seek', 12); // 0.5 s on A
      ui.dispatch('setClock', 'b');
      ui.dispatch('leaveCompare');
      assert.deepStrictEqual([tab().tiles, tab().fps, tab().maxFrame, tab().frame], [['b'], 60, 599, 30], 'leave Compare on B: 0.5 s = frame 30');
    }, { engine });
  }

  // The clock's decoder learns its real fps / length after boot (Astra #2 High #5): same clockId, new numbers.
  {
    const meta = { id: 'a', name: 'a.mp4', fps: 24, frames: 240 };
    const base = toolEngine(createFakeEngine([meta]));
    const engine = { ...base, getClip: (id) => (id === 'a' ? { ...base.getClip('a'), fps: meta.fps, frames: meta.frames } : base.getClip(id)) };
    const initial = S.syncClockMeta(S.createWorkspaceState({ tiles: ['a'], frame: 48 }), { fps: 24, maxFrame: 239 });
    await mountTools(initial, async ({ ui, tab, $ }) => {
      assert.deepStrictEqual([tab().clockId, tab().fps, tab().maxFrame], ['a', 24, 239], 'boots with the guessed numbers');
      assert.strictEqual(typeof ui.syncClockMeta, 'function', 'the controller exposes syncClockMeta');
      meta.fps = 60;
      meta.frames = 600;
      ui.syncClockMeta();
      assert.deepStrictEqual([tab().clockId, tab().fps, tab().maxFrame, tab().frame], ['a', 60, 599, 120], 'the real numbers: 2 s = frame 120');
      assert.deepStrictEqual([$('seek').max, $('seek').value], ['599', '120'], 'the seek bar follows');
      const before = ui.getState();
      ui.syncClockMeta();
      assert.strictEqual(ui.getState(), before, 'nothing new: the state is left alone');
      meta.frames = 900;
      ui.dispatch('seek', 60);
      assert.strictEqual(tab().maxFrame, 599, 'an ordinary commit on the same clock leaves the numbers to syncClockMeta');
      ui.syncClockMeta();
      assert.deepStrictEqual([tab().fps, tab().maxFrame, tab().frame, $('seek').max], [60, 899, 60, '899'], 'a longer clip: only the length moves');
    }, { engine });
  }

  // Compare capture is told to the host on every change (Astra #2 High #4), not kept in the page alone.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, host, tab }) => {
    const caps = () => host.log.filter((m) => m.type === 'capture').map((m) => ({ on: m.on, tabId: m.tabId }));
    assert.deepStrictEqual(caps(), [], 'nothing posted at boot');
    ui.dispatch('capture');
    assert.strictEqual(tab().capture, true);
    assert.deepStrictEqual(caps(), [{ on: true, tabId: tab().id }], 'capture on is posted');
    ui.render();
    assert.strictEqual(caps().length, 1, 'a redraw without a change posts nothing');
    ui.dispatch('capture');
    assert.deepStrictEqual(caps().map((c) => c.on), [true, false], 'capture off is posted');
    // A video the host opens into Compare (Compare With…, multi-select) joins without turning Explorer capture on.
    ui.onHostMessage({ type: 'openVideo', clipId: 'clip-1', compare: true });
    assert.strictEqual(tab().capture, false, 'openVideo with compare keeps capture off');
    assert.deepStrictEqual(caps().map((c) => c.on), [true, false], 'no extra capture message posted');
    ui.dispatch('capture');
    assert.deepStrictEqual(caps().map((c) => c.on), [true, false, true], 'capture on is posted in Compare');
    ui.dispatch('leaveCompare');
    assert.strictEqual(caps().pop().on, tab().capture, 'after leaving Compare the host has the same capture flag as the page');
  });

  // Frame export through a decoder (Astra #1): engine.showFrame(id, k, { signal }) is awaited, and the bar shows the
  // frame it really presented.
  {
    const asked = [];
    let present = null;
    const engine = toolEngine();
    engine.showFrame = (id, k, opts) => {
      asked.push({ id, k, signal: opts && opts.signal });
      return new Promise((r) => { present = r; });
    };
    await mountTools({ tiles: ['clip-0'] }, async ({ ui, tab, last }) => {
      ui.parts.notices.setDismissals({ reducedRes: true });
      ui.dispatch('playPause');
      ui.onHostMessage({ type: 'exportGrab', id: 9, frame: 30 });
      await tick(); await tick();
      assert.strictEqual(asked.length, 1, 'the decoder is asked to show the frame');
      assert.deepStrictEqual([asked[0].id, asked[0].k, typeof asked[0].signal.aborted], ['clip-0', 30, 'boolean'], 'with an abort signal');
      assert.deepStrictEqual([tab().playing, tab().frame], [false, 48], 'paused; the bar waits for the presented frame');
      present(31); // a VFR neighbour
      await ui.parts.frameExport.idle();
      const f = last('exportFrame');
      assert.deepStrictEqual([f.id, f.frame, f.data instanceof Uint8Array], [9, 31, true], 'the host gets the frame really shown');
      assert.strictEqual(tab().frame, 31, 'and the bar shows it');
      ui.onHostMessage({ type: 'exportEnd' });
    }, { engine });
  }

  // Pixel inspector through the mounted controller (Astra #6): engine.pixelAt reaches the click, the value is copied.
  {
    const seen = [];
    const engine = toolEngine();
    engine.pixelAt = (id, x, y) => { seen.push([id, x, y]); return { text: 'rgb(12,34,56)' }; };
    await mountTools({ tiles: ['clip-0'] }, async ({ ui, key, last, $, dom }) => {
      ui.parts.notices.setDismissals({ reducedRes: true });
      key('x');
      dom.$('cells').querySelector('canvas').fire('click', { clientX: 340, clientY: 185 });
      assert.strictEqual(seen.length, 1, 'engine.pixelAt runs once');
      assert.strictEqual(seen[0][0], 'clip-0');
      assert.ok(Number.isInteger(seen[0][1]) && Number.isInteger(seen[0][2]), 'with picture coordinates');
      assert.strictEqual(last('copyText').text, 'rgb(12,34,56)', 'its value is copied');
      assert.strictEqual($('toast').textContent, 'Pixel value copied');
    }, { engine });
    const bare = toolEngine();
    delete bare.pixelAt;
    await mountTools({ tiles: ['clip-0'] }, async ({ ui, key, $, dom, count }) => {
      ui.parts.notices.setDismissals({ reducedRes: true });
      key('x');
      dom.$('cells').querySelector('canvas').fire('click', { clientX: 340, clientY: 185 });
      assert.strictEqual($('toast').textContent, 'Pixel values are not available for this video', 'no pixelAt: it says so');
      assert.strictEqual(count('copyText'), 0);
    }, { engine: bare });
  }

  // The host's toast duration (Astra low): { ms } reaches the toast's timer, clamped to 1..10000; else the default.
  await mountTools({ tiles: ['clip-0'] }, async ({ ui, $ }) => {
    const realSetTimeout = global.setTimeout;
    const durations = [];
    global.setTimeout = (fn, ms) => { durations.push(ms); return 0; };
    try {
      ui.onHostMessage({ type: 'toast', text: 'Four seconds', ms: 4000 });
      ui.onHostMessage({ type: 'toast', text: 'Too long', ms: 60000 });
      ui.onHostMessage({ type: 'toast', text: 'Negative', ms: -5 });
      ui.onHostMessage({ type: 'toast', text: 'Default' });
    } finally { global.setTimeout = realSetTimeout; }
    assert.deepStrictEqual(durations, [4000, 10000, 1500, 1500], 'the toast timer runs for the host\'s ms');
    assert.strictEqual($('toast').textContent, 'Default');
  });

  // A decoder clock (tickMs: 0): user transport goes out through onTransport, decoder frames and ends come in.
  {
    const evs = [];
    const take = () => evs.splice(0);
    await mountTools({ tiles: ['clip-0'] }, async ({ ui, tab, key, host, dom, $ }) => {
      assert.ok(!dom.timers.some((x) => x && x.ms === 42), 'no page clock with tickMs: 0');
      ui.parts.notices.setDismissals({ reducedRes: true });
      take();
      ui.dispatch('playPause');
      assert.deepStrictEqual(take(), [{ type: 'play', frame: 48, playing: true }], 'Play is told');
      ui.onDecoderFrame(60);
      ui.onDecoderFrame(61);
      assert.deepStrictEqual([tab().frame, $('seek').value, take()], [61, '61', []], 'decoder frames move the bar, and are not told back');
      ui.dispatch('seek', 100);
      assert.deepStrictEqual(take(), [{ type: 'seek', frame: 100, playing: true }], 'a seek is told');
      key(']');
      assert.deepStrictEqual(take(), [{ type: 'rate', rate: ui.getPrefs().rate }], 'a speed change is told');
      ui.dispatch('playPause');
      assert.deepStrictEqual(take(), [{ type: 'pause', frame: 100, playing: false }], 'Pause is told');
      ui.dispatch('playPause');
      take();

      // A natural end without Loop: pause on the last frame, nothing told back.
      assert.strictEqual(ui.onDecoderEnded(), 'end');
      assert.deepStrictEqual([tab().playing, tab().frame, take()], [false, tab().maxFrame, []], 'paused on the last frame');

      // Loop: the decoder hears the restart.
      ui.dispatch('loop');
      assert.deepStrictEqual(take(), [{ type: 'loop', loop: true }], 'Loop is told');
      ui.dispatch('playPause');
      take();
      assert.strictEqual(ui.onDecoderEnded(), 'loop');
      assert.deepStrictEqual([tab().playing, tab().frame], [true, 0], 'Loop plays again from the start');
      assert.deepStrictEqual(take(), [{ type: 'seek', frame: 0, playing: true }, { type: 'play', frame: 0, playing: true }]);

      // A–B: the end wraps to A (before Loop).
      ui.dispatch('seek', 24); key('a');
      ui.dispatch('seek', 48); key('b');
      take();
      assert.strictEqual(ui.onDecoderEnded(), 'ab');
      assert.deepStrictEqual([tab().frame, tab().playing], [24, true], 'the A–B range wraps to A');
      assert.deepStrictEqual(take(), [{ type: 'seek', frame: 24, playing: true }, { type: 'play', frame: 24, playing: true }]);
      ui.dispatch('clearAB');
      ui.dispatch('loop');
      take();

      // Autoplay "Play next in folder" with no page clock: a natural end plays the next video, a stop short does not.
      ui.onHostMessage({ type: 'railHandoff', id: 'h1', onEnd: 'next', fromAutoNext: true, rail: { open: false } });
      assert.strictEqual(ui.getPrefs().onEnd, 'next');
      const neighbours = () => host.log.filter((m) => m.type === 'neighbour' && m.d === 1 && m.auto === true).length;
      ui.dispatch('seek', tab().maxFrame);
      if (!tab().playing) ui.dispatch('playPause');
      assert.strictEqual(ui.onDecoderEnded({ natural: false }), 'end');
      assert.strictEqual(neighbours(), 0, 'stopped short (natural: false): no next video');
      ui.dispatch('playPause');
      assert.strictEqual(ui.onDecoderEnded(), 'end');
      assert.strictEqual(neighbours(), 1, 'the natural end plays the next video in the folder');
      assert.deepStrictEqual(tab().tiles, ['clip-1']);
    }, { env: { tickMs: 0, onTransport: (e) => evs.push(e) } });
  }

  // The rendered harness inlines the tool and lifecycle modules and hands them to create().
  const html = buildMockupHtml({ scenario: 'single' });
  for (const src of ['media/reduced-res-notice.js', 'media/slow-notice.js', 'media/player-ui-tools.js', 'media/player-ui-lifecycle.js']) {
    assert.ok(html.indexOf(`data-src="${src}"`) >= 0 && html.indexOf(`data-src="${src}"`) < html.indexOf('data-src="media/player-ui.js"'),
      `the harness inlines ${src} before media/player-ui.js`);
  }
  const harness = html.slice(html.lastIndexOf('<script>'));
  for (const w of ['VpePlayerUiTools', 'VpePlayerUiLifecycle', 'VpeReducedResNotice', 'VpeSlowNotice']) {
    assert.ok(harness.includes(`${w}: globalThis.${w}`), `the harness passes ${w}`);
  }
}
phase34().then(() => {
  const ms = Date.now() - T0;
  assert.ok(ms < 5000, `the UI seam is checked in milliseconds, not by playing video (${ms} ms)`);
  console.log(`player_ui_test: ok (${ms} ms, no video decoded)`);
}, (e) => { console.error(e); process.exit(1); });
