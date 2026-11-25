'use strict';
// Millisecond tests for the shared input interactions (media/player-ui-input.js) on the strict fake DOM
// (test/host/fake-dom.js): seek hover tip, stage wheel step / Ctrl+wheel zoom / drag to pan, fullscreen idle bar,
// Zen Mode Esc Esc, auto-pause of hidden tabs, the live region and the go-to box. Timers are the fake window's
// list (`timers[id - 1].fn()` runs one); clocks are injected. Nothing decodes video.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../../media/player-ui-input');
const { createDom } = require('./fake-dom');

const T0 = Date.now();
const fireTimer = (win, id) => { const t = win.timers[id - 1]; assert.ok(t, `timer ${id} is pending`); win.timers[id - 1] = null; t.fn(); };
const pending = (win) => win.timers.filter(Boolean).length;

// ---- boundary -------------------------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'player-ui-input.js'), 'utf8');
  assert.ok(!/acquireVsCodeApi|require\(|\bimport\s|from '\.\.\/src|VpeEngine|libav/.test(src), 'no VS Code, Node or decoder reach');
  assert.ok(!/\bdocument\.|\bsetTimeout\(|\bclearTimeout\(/.test(src.replace(/win\.(set|clear)Timeout/g, '')), 'DOM and timers only through doc / win');
}

// ---- 1. seek hover ----------------------------------------------------------------------------------------
{
  assert.strictEqual(I.formatSeekTip({ timeText: '1:23.456', frame: 1431, knownFrames: true }), '1:23.456 · #1432');
  assert.strictEqual(I.formatSeekTip({ letter: 'B', timeText: '1:23.456', frame: 1431, knownFrames: true }), 'B 1:23.456 · #1432');
  assert.strictEqual(I.formatSeekTip({ timeText: '0:05.000', frame: 0, knownFrames: true, chapterTitle: 'Intro' }), '0:05.000 · #1 · Intro');
  assert.strictEqual(I.formatSeekTip({ timeText: '0:05.000', frame: 3, knownFrames: false }), '0:05.000', 'time only while frames are unknown');
  assert.ok(!I.formatSeekTip({ letter: 'A', timeText: 'x', frame: 1, knownFrames: true }).includes('?'), 'no ? placeholder (old compare.js bug)');
  assert.strictEqual(I.formatSeekAria({ letter: 'A', timeText: '0:01.000', durText: '0:10.000', frame: 29 }), 'A 0:01.000 of 0:10.000, frame 30');
  assert.strictEqual(I.formatSeekAria({ timeText: '0:01.000', durText: '0:10.000' }), '0:01.000 of 0:10.000');
  assert.strictEqual(I.fmtClock(83.456), '1:23.456');
  assert.strictEqual(I.fmtClock(3723.5), '1:02:03.500');

  const { doc, win, $, setRect } = createDom('<div id="bar"><input id="seek" type="range" min="0" max="99"><div id="tip" hidden></div><canvas id="cv"></canvas></div>');
  const seek = $('seek'), tip = $('tip'), cv = $('cv');
  seek.max = '99'; // a real range input's max property (the fake DOM only has the attribute)
  setRect(seek, { left: 100, width: 400 });
  let info = { frames: 100, fps: 25, duration: 4, formatTime: (t) => `${t.toFixed(2)}s` };
  const thumbs = [], leaves = [];
  const h = I.bindSeekHover({ seekEl: seek, tipEl: tip, thumbCanvas: cv, win, getInfo: () => info,
    onThumbnail: (t, c, scrub, place) => thumbs.push({ t, c, scrub, place }), onThumbnailLeave: (imm) => leaves.push(imm) });
  seek.fire('mousemove', { clientX: 300 }); // half way: frame round(0.5 * 99) = 50
  assert.strictEqual(tip.hidden, false);
  assert.strictEqual(tip.textContent, '2.00s · #51');
  assert.strictEqual(tip.style.left, '200px');
  assert.deepStrictEqual(thumbs.at(-1), { t: 2, c: cv, scrub: false, place: { px: 200, width: 400 } });
  seek.fire('mousemove', { clientX: 105 });
  assert.strictEqual(tip.style.left, '30px', 'clamped 30 px from the left end');
  seek.fire('pointermove', { clientX: 499 });
  assert.strictEqual(tip.style.left, '370px', 'clamped 30 px from the right end');
  seek.fire('mousemove', { clientX: 50 });
  assert.strictEqual(tip.textContent, '0.00s · #1', 'left of the bar: the first frame');
  // Chapter and Compare letter.
  info = { ...info, letter: 'A', chapterAt: (t) => (t < 1 ? 'Intro' : null) };
  seek.fire('mousemove', { clientX: 100 });
  assert.strictEqual(tip.textContent, 'A 0.00s · #1 · Intro');
  seek.fire('mousemove', { clientX: 500 });
  assert.strictEqual(tip.textContent, 'A 3.96s · #100');
  // Unknown frame count: time from the duration only.
  info = { frames: 0, duration: 10, formatTime: (t) => `${t}s` };
  seek.fire('mousemove', { clientX: 200 });
  assert.strictEqual(tip.textContent, '2.5s');
  // Nothing to show yet: the tip stays as is.
  info = null;
  tip.textContent = 'old';
  seek.fire('mousemove', { clientX: 200 });
  assert.strictEqual(tip.textContent, 'old');
  // Leave hides and tells the thumbnail service (not immediate).
  seek.fire('mouseleave');
  assert.strictEqual(tip.hidden, true);
  assert.deepStrictEqual(leaves, [false]);
  seek.fire('pointerleave');
  assert.deepStrictEqual(leaves, [false, false]);
  // Dragging: follows the slider value (also after leaving the bar), scrubbing thumbnails; hides on release outside.
  info = { frames: 100, fps: 25, duration: 4, formatTime: (t) => `${t.toFixed(2)}s` };
  seek.fire('pointerdown', { button: 0, clientX: 300 });
  assert.strictEqual(h.dragging(), true);
  seek.fire('mousemove', { clientX: 120 });
  assert.notStrictEqual(tip.textContent, '0.20s · #6', 'pointer position ignored while dragging');
  seek.value = '99';
  seek.fire('input');
  assert.strictEqual(tip.textContent, '3.96s · #100');
  assert.strictEqual(thumbs.at(-1).scrub, true, 'a drag asks for scrub thumbnails');
  seek.fire('mouseleave');
  assert.strictEqual(tip.hidden, false, 'leaving the bar while dragging keeps the tip');
  win.fire('pointerup');
  assert.strictEqual(h.dragging(), false);
  assert.strictEqual(tip.hidden, true, 'released off the bar: hidden');
  // Released over the bar: stays (the next move updates it).
  seek.fire('pointerdown', { button: 0 });
  seek.fire('mousemove', { clientX: 300 });
  win.fire('pointerup');
  seek.value = '0';
  seek.fire('input');
  assert.notStrictEqual(tip.textContent, '0.00s · #1', 'input after the drag does not move the tip');
  // explicit hide(immediate) and cancel
  h.hide(true);
  assert.strictEqual(leaves.at(-1), true);
  seek.fire('pointerdown', { button: 0 });
  h.cancel();
  assert.strictEqual(h.dragging(), false);
  h.dispose();
  assert.strictEqual(seek.listenerCount('mousemove'), 0);
  assert.strictEqual(win.listenerCount('pointerup'), 0);
}

// ---- 2. stage wheel and pan --------------------------------------------------------------------------------
{
  const { doc, win, $, FakeEvent } = createDom('<div id="stage"><canvas id="cv"></canvas><button id="btn">x</button><div class="pill" data-zoom-drag="1"><span id="grip">::</span></div></div>');
  const stage = $('stage');
  let playing = false, zoomed = false, blocked = false, t = 1000;
  const steps = [], zooms = [], pans = [], ends = [];
  let starts = 0;
  const w = I.bindStageWheelAndPan({ stage, win, isPlaying: () => playing, isZoomed: () => zoomed, isBlocked: () => blocked,
    getZoom: () => 2, onStepWheel: (d, s) => steps.push([d, s]), onZoomWheel: (f, x, y, z) => zooms.push([f, x, y, z]),
    onPanStart: () => { starts++; }, onPanMove: (dx, dy) => pans.push([dx, dy]), onPanEnd: (i) => ends.push(i), now: () => t });
  const wheel = (init) => { const e = new FakeEvent('wheel', init); $('cv').dispatchEvent(e); return e; };
  // Paused: plain wheel steps, Shift+wheel bigger step; Windows Chromium Shift+wheel arrives on deltaX.
  assert.ok(wheel({ deltaY: 100 }).defaultPrevented);
  wheel({ deltaY: -3 });
  wheel({ deltaY: 100, shiftKey: true });
  wheel({ deltaY: 0, deltaX: -120, shiftKey: true });
  wheel({ deltaY: 0, deltaX: 120 }); // a horizontal scroll without Shift is not a step
  assert.deepStrictEqual(steps, [[1, false], [-1, false], [1, true], [-1, true]]);
  // Playing: the wheel is left alone.
  playing = true;
  assert.ok(!wheel({ deltaY: 100 }).defaultPrevented);
  assert.strictEqual(steps.length, 4);
  // Ctrl / Meta zoom around the pointer, also while playing; deltaY clamped to ±300.
  const z = wheel({ deltaY: -100, ctrlKey: true, clientX: 10, clientY: 20 });
  assert.ok(z.defaultPrevented);
  assert.ok(Math.abs(zooms[0][0] - Math.exp(0.2)) < 1e-12);
  assert.deepStrictEqual(zooms[0].slice(1), [10, 20, 2]);
  wheel({ deltaY: 5000, metaKey: true, clientX: 1, clientY: 2 });
  assert.ok(Math.abs(zooms[1][0] - Math.exp(-0.6)) < 1e-12, 'clamped to 300');
  assert.strictEqual(I.zoomFactor(-1000), Math.exp(0.6));
  assert.strictEqual(I.zoomFactor(0), 1);
  playing = false;
  // Ctrl+wheel never steps.
  assert.strictEqual(steps.length, 4);
  // Blocked (a tile is being dragged): eaten, nothing happens.
  blocked = true;
  assert.ok(wheel({ deltaY: 100 }).defaultPrevented);
  wheel({ deltaY: 100, ctrlKey: true });
  assert.strictEqual(steps.length, 4);
  assert.strictEqual(zooms.length, 2);
  blocked = false;

  // Pan: nothing when not zoomed.
  $('cv').fire('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  $('cv').fire('pointermove', { pointerId: 1, clientX: 50, clientY: 0 });
  assert.strictEqual(starts, 0);
  assert.strictEqual(pans.length, 0);
  zoomed = true;
  // Below the 4 px threshold: no pan, no capture.
  $('cv').fire('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  assert.strictEqual(starts, 1);
  $('cv').fire('pointermove', { pointerId: 1, clientX: 102, clientY: 102 });
  assert.strictEqual(pans.length, 0);
  assert.ok(!stage.hasPointerCapture(1));
  assert.ok(!stage.classList.contains('panning'));
  // Another pointer is ignored.
  $('cv').fire('pointermove', { pointerId: 2, clientX: 200, clientY: 200 });
  assert.strictEqual(pans.length, 0);
  $('cv').fire('pointermove', { pointerId: 1, clientX: 104, clientY: 100 });
  assert.deepStrictEqual(pans, [[4, 0]]);
  assert.ok(stage.hasPointerCapture(1));
  assert.ok(stage.classList.contains('panning'));
  assert.ok(w.panning());
  $('cv').fire('pointermove', { pointerId: 1, clientX: 90, clientY: 130 });
  assert.deepStrictEqual(pans.at(-1), [-10, 30], 'cumulative from the press');
  t = 2000;
  $('cv').fire('pointerup', { pointerId: 1 });
  assert.deepStrictEqual(ends.at(-1), { moved: true, cancelled: false });
  assert.ok(!stage.classList.contains('panning'));
  assert.ok(!stage.hasPointerCapture(1));
  assert.ok(w.wasRecentPan(2299), 'click guard within 300 ms');
  assert.ok(!w.wasRecentPan(2300), 'not after 300 ms');
  // A press with no move: not a pan, no click guard.
  t = 5000;
  $('cv').fire('pointerdown', { button: 0, pointerId: 3, clientX: 0, clientY: 0 });
  $('cv').fire('pointerup', { pointerId: 3 });
  assert.deepStrictEqual(ends.at(-1), { moved: false, cancelled: false });
  assert.ok(!w.wasRecentPan(5001));
  // Secondary button, controls and the ⋮⋮ grip do not pan (the grip still moves the tile).
  const before = starts;
  $('cv').fire('pointerdown', { button: 2, pointerId: 4 });
  $('btn').fire('pointerdown', { button: 0, pointerId: 4 });
  $('grip').fire('pointerdown', { button: 0, pointerId: 4 });
  assert.strictEqual(starts, before);
  // onPanStart can refuse.
  const w2 = I.bindStageWheelAndPan({ stage: doc.createElement('div'), win: null, isPlaying: () => false, isZoomed: () => true, onPanStart: () => false, onPanMove: () => assert.fail('refused') });
  w2.dispose();
  // Esc cancels a pan (and is consumed), pointercancel / lostpointercapture cancel, no click guard after.
  $('cv').fire('pointerdown', { button: 0, pointerId: 5, clientX: 0, clientY: 0 });
  $('cv').fire('pointermove', { pointerId: 5, clientX: 10, clientY: 0 });
  const esc = win.fire('keydown', { key: 'Escape' });
  assert.ok(esc.defaultPrevented && esc.propagationStopped);
  assert.deepStrictEqual(ends.at(-1), { moved: true, cancelled: true });
  assert.ok(!w.wasRecentPan(t + 1));
  assert.ok(!stage.classList.contains('panning'));
  $('cv').fire('pointermove', { pointerId: 5, clientX: 50, clientY: 0 });
  assert.deepStrictEqual(pans.at(-1), [10, 0], 'no moves after cancel');
  // Esc without a moved pan is left to the page.
  $('cv').fire('pointerdown', { button: 0, pointerId: 6, clientX: 0, clientY: 0 });
  assert.ok(!win.fire('keydown', { key: 'Escape' }).defaultPrevented);
  assert.deepStrictEqual(ends.at(-1), { moved: false, cancelled: true });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    $('cv').fire('pointerdown', { button: 0, pointerId: 7, clientX: 0, clientY: 0 });
    $('cv').fire('pointermove', { pointerId: 7, clientX: 0, clientY: 9 });
    stage.fire(type, { pointerId: 7 });
    assert.deepStrictEqual(ends.at(-1), { moved: true, cancelled: true }, type);
    assert.ok(!w.panning());
  }
  w.dispose();
  assert.strictEqual(stage.listenerCount('wheel'), 0);
  assert.strictEqual(win.listenerCount('keydown'), 0);
}

// ---- 3. idle -----------------------------------------------------------------------------------------------
{
  const { doc, win } = createDom('<div id="bar"></div>');
  let fs1 = true, playing = true, suppressed = false;
  const idle = I.createIdleController({ doc, win, isFullscreen: () => fs1, isPlaying: () => playing, isSuppressed: () => suppressed });
  idle.wake();
  assert.strictEqual(win.timers.at(-1).ms, 2500);
  assert.ok(!idle.isIdle());
  fireTimer(win, win.timers.length);
  assert.ok(idle.isIdle(), 'idle after 2.5 s');
  for (const ev of ['mousemove', 'focusin', 'keydown', 'fullscreenchange']) {
    doc.body.classList.add('idle');
    doc.fire(ev);
    assert.ok(!idle.isIdle(), `${ev} wakes`);
  }
  // A wake restarts the timer: only one pending.
  assert.strictEqual(pending(win), 1);
  // Not while paused, windowed or suppressed (a dialog is open).
  for (const set of [() => { playing = false; }, () => { fs1 = false; }, () => { suppressed = true; }]) {
    playing = true; fs1 = true; suppressed = false;
    set();
    for (let i = 0; i < win.timers.length; i++) win.timers[i] = null;
    idle.wake();
    assert.strictEqual(pending(win), 0);
  }
  // Conditions change while waiting: no idle.
  playing = true; fs1 = true; suppressed = false;
  idle.wake();
  const id = win.timers.length;
  playing = false;
  fireTimer(win, id);
  assert.ok(!idle.isIdle());
  // Default isFullscreen reads doc.fullscreenElement.
  const d2 = createDom('');
  const idle2 = I.createIdleController({ doc: d2.doc, win: d2.win, isPlaying: () => true, timeoutMs: 10 });
  idle2.wake();
  assert.strictEqual(pending(d2.win), 0, 'windowed');
  d2.doc.fullscreenElement = d2.doc.body;
  d2.doc.fire('fullscreenchange');
  assert.strictEqual(d2.win.timers.at(-1).ms, 10);
  fireTimer(d2.win, d2.win.timers.length);
  assert.ok(idle2.isIdle());
  idle2.dispose();
  assert.ok(!idle2.isIdle(), 'dispose shows the bar');
  assert.strictEqual(d2.doc.listenerCount('mousemove'), 0);
  idle.dispose();
}

// ---- 4. Zen Esc Esc ----------------------------------------------------------------------------------------
{
  let t = 0, exits = 0;
  const z = I.createZenEscTracker({ onExitZen: () => exits++, now: () => t });
  const esc = (extra = {}) => z.onKey({ key: 'Escape', ...extra });
  assert.strictEqual(esc(), false);
  t = 500; esc();
  assert.strictEqual(exits, 0, 'not in Zen Mode: nothing');
  z.setActive(true);
  assert.strictEqual(z.active, true);
  t = 1000; assert.strictEqual(esc(), false);
  t = 2000; assert.strictEqual(esc(), true, 'inside 1 s');
  assert.strictEqual(exits, 1);
  t = 2100; assert.strictEqual(esc(), false, 'the pair is used up');
  t = 3101; assert.strictEqual(esc(), false, 'outside 1 s: starts a new pair');
  t = 3200; assert.strictEqual(esc({ repeat: true }), false, 'a held key is not a second press');
  assert.strictEqual(z.onKey({ key: 'Enter' }), false);
  t = 3300; assert.strictEqual(esc(), true);
  assert.strictEqual(exits, 2);
  t = 4000; esc();
  z.setActive(false); z.setActive(true);
  t = 4100; assert.strictEqual(esc(), false, 'leaving Zen Mode forgets the first Esc');
  t = 4200; z.reset();
  t = 4300; assert.strictEqual(esc(), false);
  const z2 = I.createZenEscTracker({ windowMs: 200, onExitZen: () => exits++, now: () => t });
  z2.setActive(true);
  t = 0; z2.onKey({ key: 'Escape' }); t = 201;
  assert.strictEqual(z2.onKey({ key: 'Escape' }), false, 'custom window');
}

// ---- 5. visibility ----------------------------------------------------------------------------------------
{
  const { doc, win } = createDom('');
  let playing = true;
  const log = [];
  const v = I.createVisibilityController({ doc, win, isPlaying: () => playing,
    onAutoPause: () => { log.push('pause'); playing = false; }, onAutoResume: () => { log.push('resume'); playing = true; },
    onHideCleanup: () => log.push('cleanup') });
  doc.hidden = true; doc.fire('visibilitychange');
  assert.deepStrictEqual(log, ['cleanup', 'pause']);
  assert.ok(v.willResume());
  doc.hidden = false; doc.fire('visibilitychange');
  assert.deepStrictEqual(log, ['cleanup', 'pause', 'resume']);
  // Paused by the user: hidden and back does not start it.
  log.length = 0; playing = false;
  v.setVisible(false, false);
  v.setVisible(true, true);
  assert.deepStrictEqual(log, ['cleanup']);
  assert.ok(v.isActive());
  // Host hidden and page hidden together: visible only when both are.
  log.length = 0; playing = true;
  v.setVisible(false);
  doc.hidden = true; doc.fire('visibilitychange');
  v.setVisible(true);
  assert.deepStrictEqual(log, ['cleanup', 'pause'], 'still hidden by the page');
  assert.ok(!v.isVisible());
  doc.hidden = false; doc.fire('visibilitychange');
  assert.deepStrictEqual(log, ['cleanup', 'pause', 'resume']);
  // Repeated hidden calls do not pause twice; forgetResume drops the auto-resume.
  log.length = 0;
  v.setVisible(false); v.setVisible(false);
  assert.deepStrictEqual(log, ['cleanup', 'pause']);
  v.forgetResume();
  v.setVisible(true);
  assert.deepStrictEqual(log, ['cleanup', 'pause']);
  v.dispose();
  assert.strictEqual(doc.listenerCount('visibilitychange'), 0);
}

// ---- 6. live announcer -------------------------------------------------------------------------------------
{
  const { win, $ } = createDom('<div id="live" aria-live="polite">old</div>');
  const live = $('live');
  const a = I.createLiveAnnouncer({ liveEl: live, win });
  a.announce('Frame 12');
  assert.strictEqual(live.textContent, '', 'emptied first');
  assert.strictEqual(win.timers.at(-1).ms, 50);
  fireTimer(win, win.timers.length);
  assert.strictEqual(live.textContent, 'Frame 12');
  a.announce('Frame 12'); // the same text again is re-read: emptied, then written
  assert.strictEqual(live.textContent, '');
  const first = win.timers.length;
  a.announce('Frame 13'); // a newer announcement cancels the pending one
  assert.strictEqual(win.timers[first - 1], null);
  assert.strictEqual(pending(win), 1);
  fireTimer(win, win.timers.length);
  assert.strictEqual(live.textContent, 'Frame 13');
  a.announce('');
  assert.strictEqual(live.textContent, 'Frame 13', 'empty text is ignored');
  a.announce('Gone');
  a.dispose();
  assert.strictEqual(pending(win), 0, 'dispose cancels');
  I.createLiveAnnouncer({ liveEl: null, win }).announce('x'); // no live region: no-op
  const b = I.createLiveAnnouncer({ liveEl: live, win, delayMs: 5 });
  b.announce('x');
  assert.strictEqual(win.timers.at(-1).ms, 5);
}

// ---- 7. go to ----------------------------------------------------------------------------------------------
{
  const clip = { fps: 25, duration: 100, frames: 2500, current: 9 };
  const P = (s, c = clip) => I.parseGoto(s, c);
  assert.deepStrictEqual(P('1432'), { kind: 'frame', frame: 1431 });
  assert.deepStrictEqual(P('#1432'), { kind: 'frame', frame: 1431 });
  assert.deepStrictEqual(P('  # 7 '), { kind: 'frame', frame: 6 });
  assert.deepStrictEqual(P('0'), { kind: 'frame', frame: 0 }, 'frame 0 clamps to the first');
  assert.deepStrictEqual(P('99999'), { kind: 'frame', frame: 2499 }, 'clamped to the last frame');
  assert.deepStrictEqual(P('99999', {}), { kind: 'frame', frame: 99998 }, 'unknown frame count: unclamped');
  assert.deepStrictEqual(P('+10'), { kind: 'delta', frame: 19 });
  assert.deepStrictEqual(P('-30'), { kind: 'delta', frame: 0 });
  assert.deepStrictEqual(P('1:23.456'), { kind: 'time', time: 83.456 });
  assert.deepStrictEqual(P('01:02:03', { duration: 0 }), { kind: 'time', time: 3723 });
  assert.deepStrictEqual(P('01:02:03'), { kind: 'time', time: 100 }, 'clamped to the duration');
  assert.deepStrictEqual(P('83.5'), { kind: 'time', time: 83.5 });
  assert.deepStrictEqual(P('.5'), { kind: 'time', time: 0.5 });
  assert.deepStrictEqual(P('12s'), { kind: 'time', time: 12 });
  assert.deepStrictEqual(P('12.5 S'), { kind: 'time', time: 12.5 });
  assert.deepStrictEqual(P('50%'), { kind: 'percent', time: 50 });
  assert.deepStrictEqual(P('12.5 %'), { kind: 'percent', time: 12.5 });
  assert.deepStrictEqual(P('150%'), { kind: 'percent', time: 100 });
  assert.strictEqual(P('50%', { frames: 10 }), null, 'percent needs a duration');
  for (const bad of ['', '   ', 'abc', '1:2:3:4', '1:75', '1:60:00', '--1', '5%%', '1.2.3', '#', null, undefined, '-', '1e3']) {
    assert.strictEqual(I.parseGoto(bad, clip), null, `invalid: ${JSON.stringify(bad)}`);
  }
  assert.deepStrictEqual(I.parseGoto('5'), { kind: 'frame', frame: 4 }, 'no clip info');

  const { doc, win, $ } = createDom('<div id="stage"><div id="goto" class="goto" hidden><input id="gi" type="text"></div></div>');
  const box = $('goto'), input = $('gi');
  const seeks = [], toasts = [];
  let stageClicks = 0, stageKeys = 0;
  $('stage').addEventListener('click', () => stageClicks++);
  doc.addEventListener('keydown', () => stageKeys++);
  let meta = { ...clip };
  const g = I.createGotoBox({ doc, win, inputEl: input, boxEl: box, getClipMeta: () => meta,
    onSeek: (t) => seeks.push(t), onToast: (s) => toasts.push(s) });
  g.open();
  assert.ok(g.isOpen());
  assert.strictEqual(input.value, '10', 'opens with the current frame (1-based)');
  assert.strictEqual(doc.activeElement, input);
  box.fire('click');
  assert.strictEqual(stageClicks, 0, 'a click in the box is not a play / pause');
  input.value = 'nope';
  input.fire('keydown', { key: 'Enter' });
  assert.ok(box.classList.contains('bad'));
  assert.strictEqual(input.getAttribute('aria-invalid'), 'true');
  assert.ok(g.isOpen(), 'bad input keeps it open');
  assert.strictEqual(stageKeys, 0, 'keys typed in the box do not reach the player');
  input.fire('input');
  assert.ok(!box.classList.contains('bad'));
  assert.strictEqual(input.getAttribute('aria-invalid'), null);
  input.value = '#1432';
  const enter = input.fire('keydown', { key: 'Enter' });
  assert.ok(enter.defaultPrevented);
  assert.ok(!g.isOpen());
  assert.deepStrictEqual(seeks, [{ kind: 'frame', frame: 1431 }]);
  assert.deepStrictEqual(toasts, ['Frame 1432']);
  assert.notStrictEqual(doc.activeElement, input, 'closing leaves the field');
  g.open();
  input.value = '1:23.5';
  g.submit();
  assert.deepStrictEqual(seeks.at(-1), { kind: 'time', time: 83.5 });
  assert.strictEqual(toasts.at(-1), '1:23.500');
  // Esc closes without seeking; blur closes.
  g.open();
  input.value = '5';
  input.fire('keydown', { key: 'Escape' });
  assert.ok(!g.isOpen());
  assert.strictEqual(seeks.length, 2);
  g.open();
  input.fire('blur');
  assert.ok(!g.isOpen());
  // No clip yet: empty field.
  meta = null;
  g.open();
  assert.strictEqual(input.value, '');
  g.close();
  g.dispose();
  assert.strictEqual(input.listenerCount('keydown'), 0);
}

const ms = Date.now() - T0;
assert.ok(ms < 5000, `input interactions are checked in milliseconds (${ms} ms)`);
console.log(`player_ui_input_test: ok (${ms} ms, no video decoded)`);
