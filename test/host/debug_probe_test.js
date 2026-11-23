'use strict';
// node test/host/debug_probe_test.js: Layer 1 unit tests for media/debug-probe.js
// (installing, command dispatch, probe queries, passive 60Hz continuity telemetry sampling/reporting,
// generation boundaries across seeks/loops, pageErrors, and idempotent teardown).
const assert = require('node:assert/strict');
const VpeDebugProbe = require('../../media/debug-probe');
const { load } = require('./mock_vscode');

function makeElem(id = '', tagName = 'DIV') {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  return {
    id,
    tagName,
    hidden: false,
    disabled: false,
    textContent: '',
    innerText: '',
    title: '',
    value: '0',
    min: '0.25',
    max: '100',
    width: 1920,
    height: 1080,
    offsetWidth: 100,
    offsetHeight: 30,
    className: 'fit',
    dataset: { mode: 'fit' },
    style: { left: '0%', width: '100%', imageRendering: '' },
    children: [],
    parentElement: null,
    nextElementSibling: null,
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 640, height: 360 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    matches: () => false,
    focus() {},
    click() { this.clicked = (this.clicked || 0) + 1; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(ev) {
      this.lastEvent = ev;
      for (const fn of listeners[ev.type] || []) fn(ev);
      return true;
    },
  };
}

function createHarness(initialPlayer = null) {
  let now = 1000;
  let player = initialPlayer;
  const logs = [];
  const winListeners = {};
  const rafQueue = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  let seq = 0;

  const elements = new Map();
  const el = (id, tag = 'DIV') => {
    if (!elements.has(id)) elements.set(id, makeElem(id, tag));
    return elements.get(id);
  };
  for (const id of [
    'stage', 'canvas', 'overlay', 'message', 'hint', 'action', 'dropHint', 'startCompareBackdrop',
    'notice', 'noticeText', 'noticeClose', 'pxgrid', 'pxread', 'goto', 'stats', 'subs', 'live',
    'thumb', 'xray', 'xrayLegend', 'xrayTip', 'xrayChapters', 'scopes',
    'bar', 'play', 'prev', 'next', 'seek', 'buffered', 'tip', 'time', 'now', 'dur', 'rate',
    'mute', 'volume', 'infoBtn', 'full', 'cog', 'picBtn', 'panel', 'sheet', 'toast', 'abMarks', 'tracks',
  ]) el(id);
  el('notice').hidden = true;
  el('overlay').hidden = true;
  el('toast').hidden = true;
  el('panel').hidden = true;
  el('sheet').hidden = true;
  el('tip').hidden = true;
  el('abMarks').hidden = true;
  el('compareBackdrop').hidden = true;
  el('rate').textContent = '1×';
  el('time').textContent = '0:01.000 / 0:03.000';
  el('seek').value = '30';
  el('seek').max = '89';

  const ui = Object.fromEntries([
    'bar', 'play', 'prev', 'next', 'seek', 'buffered', 'tip', 'time', 'now', 'dur', 'rate',
    'mute', 'volume', 'infoBtn', 'full', 'cog', 'picBtn', 'panel', 'sheet', 'toast', 'abMarks', 'tracks',
  ].map((k) => [k, el(k)]));

  const doc = {
    body: makeElem('body', 'BODY'),
    activeElement: el('play', 'BUTTON'),
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    getElementById: (id) => elements.get(id) || null,
    querySelector: (sel) => (sel === '#play' ? el('play') : null),
    querySelectorAll: (sel) => (sel === '#play' ? [el('play')] : []),
    elementFromPoint: () => el('canvas'),
    createElement: (tag) => makeElem('', tag.toUpperCase()),
    dispatchEvent(ev) { this.lastEvent = ev; return true; },
  };

  const win = {
    crossOriginIsolated: false,
    devicePixelRatio: 1.5,
    navigator: { hardwareConcurrency: 8, userAgent: 'MockVSCode' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', outlineStyle: 'solid', outlineWidth: '1px' }),
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!winListeners[type]) return;
      winListeners[type] = winListeners[type].filter((f) => f !== fn);
    },
    emit(type, ev) { for (const fn of [...(winListeners[type] || [])]) fn(ev); },
  };

  const actions = { steps: [], rates: [], tools: [], panels: [], ctx: [] };
  const probe = VpeDebugProbe.install({
    log: (...a) => logs.push(a.join(' ')),
    getPlayer: () => player,
    isLibavPlayer: (p) => !!(p && p.queue),
    stage: el('stage'),
    canvas: el('canvas'),
    overlay: el('overlay'),
    message: el('message'),
    hint: el('hint'),
    actionBtn: el('action'),
    dropHint: el('dropHint'),
    compareBackdrop: el('compareBackdrop'),
    ui,
    controls: {
      view: () => null,
      sheetOpen: () => false,
      show: (v) => actions.panels.push(v),
      closeAll: () => actions.panels.push('close'),
    },
    ctxMenu: {
      open: (x, y, kb) => actions.ctx.push(['open', x, y, kb]),
      close: () => actions.ctx.push(['close']),
      snapshot: () => null,
    },
    insp: {
      picture: () => ({ mode: 'fit', zoom: 1, panX: 0, panY: 0 }),
      zoomedSize: () => ({ w: 1920, h: 1080, zoomed: false }),
    },
    scopes: {
      mode: () => null,
      analysis: () => null,
      perf: () => ({ ms: 0 }),
      columnLevels: () => [0, 0],
      targets75: () => [],
    },
    hdr: {
      debugPixels: async () => ({ hdr: false }),
      probe: async () => ({ supported: true }),
    },
    ab: {
      presentationRange: () => null,
    },
    frameText: (f, n) => `#${f + 1}/${n || '?'}`,
    step: (d) => actions.steps.push(d),
    setRate: (r) => actions.rates.push(r),
    runTool: (l) => { actions.tools.push(l); return l === 'Scopes'; },
    getToolCount: () => 5,
    getState: () => ({
      prefs: { jump: { arrow: 5, shift: 1, ctrl: 'frame' } },
      volume: 0.8,
      muted: true,
      loop: true,
      streamQ: null,
      loopStats: { frames: 12, rests: 1 },
      loopBusy: '',
      picturePct: 100,
      seekDragging: false,
      volumeDragging: false,
    }),
    win,
    doc,
    perf: { now: () => now },
    raf(cb) {
      const id = ++seq;
      rafQueue.set(id, cb);
      return id;
    },
    caf(id) { rafQueue.delete(id); },
    setIntervalFn(cb, ms) {
      const id = ++seq;
      intervals.set(id, { cb, ms });
      return id;
    },
    clearIntervalFn(id) { intervals.delete(id); },
    setTimeoutFn(cb, ms) {
      const id = ++seq;
      timeouts.set(id, { cb, ms });
      return id;
    },
    clearTimeoutFn(id) { timeouts.delete(id); },
  });

  function stepRaf(dtMs = 16.67) {
    now += dtMs;
    const entries = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of entries) cb(now);
  }

  function flushTimeouts() {
    const entries = [...timeouts.entries()];
    timeouts.clear();
    for (const [, { cb }] of entries) cb();
  }

  function sendDebug(m) {
    win.emit('message', { data: { type: 'debug', ...m } });
  }

  function askProbe(action, extra = {}) {
    const before = logs.length;
    const id = ++seq;
    sendDebug({ action, id, ...extra });
    const line = logs.slice(before).find((l) => l.startsWith(`${action} {`));
    assert.ok(line, `expected log line for ${action}`);
    return JSON.parse(line.slice(action.length + 1));
  }

  return {
    probe,
    logs,
    actions,
    win,
    doc,
    el,
    rafQueue,
    intervals,
    timeouts,
    winListeners,
    stepRaf,
    flushTimeouts,
    sendDebug,
    askProbe,
    setPlayer: (p) => { player = p; },
    getNow: () => now,
  };
}

// 1. HTML script wiring in src/extension.js: debug-probe.js loads with CSP nonce before player.js.
(async () => {
  const path = require('node:path');
  const h = load({});
  const s = h.open(path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv'));
  await s.shown;
  const html = s.panel.webview.html;
  const probeIdx = html.indexOf('debug-probe.js"');
  const playerIdx = html.indexOf('player.js"');
  assert.ok(probeIdx > 0 && probeIdx < playerIdx, 'debug-probe.js loads before player.js');
  s.panel.dispose();
  h.dispose();
})().then(() => {
  // 2. Installation, command dispatch, and probe queries (before and after a player is attached).
  const h = createHarness(null);
  assert.match(h.logs[0], /^webview env: crossOriginIsolated=false/);
  assert.equal(h.intervals.size, 1, 'status interval installed');
  assert.equal(h.rafQueue.size, 0, 'no RAF loop scheduled when no player is playing');

  // Probe works even before a player exists (e.g. error screen inspection).
  const s0 = h.askProbe('state');
  assert.equal(s0.playing, false);
  assert.equal(s0.volume, 0.8);
  assert.equal(s0.telemetry.samples, 0);

  let playing = false;
  let t = 1.0;
  let frame = 30;
  let gen = 0;
  let shownCount = 31;
  let seekTarget = null;
  const seeks = [];
  const p = {
    queue: [],
    cfg: { native: false },
    meta: { duration: 3, label: 'test' },
    vmode: 'webcodecs',
    amode: 'webcodecs',
    fps: 30,
    n: 90,
    rate: 1,
    firstShown: true,
    eof: false,
    get gen() { return gen; },
    get shownCount() { return shownCount; },
    get seekTarget() { return seekTarget; },
    isPlaying: () => playing,
    currentTime: () => t,
    currentFrame: () => frame,
    audioMaster: () => true,
    play: () => { playing = true; },
    pause: () => { playing = false; },
    seekTime: (target) => { seeks.push(target); gen++; t = target; frame = Math.round(target * 30); shownCount++; },
    rel: (x) => x,
    now: () => t,
  };
  h.setPlayer(p);

  h.sendDebug({ action: 'seek', t: 1.5 });
  assert.deepEqual(seeks, [1.5]);
  h.sendDebug({ action: 'step', d: -1 });
  assert.deepEqual(h.actions.steps, [-1]);
  h.sendDebug({ action: 'rate', r: 1.5 });
  assert.deepEqual(h.actions.rates, [1.5]);
  h.sendDebug({ action: 'panel', view: 'info' });
  h.sendDebug({ action: 'panel' });
  assert.deepEqual(h.actions.panels, ['info', 'close']);
  h.sendDebug({ action: 'ctxOpen', x: 50, y: 60, keyboard: true });
  h.sendDebug({ action: 'ctxClose' });
  assert.deepEqual(h.actions.ctx, [['open', 50, 60, true], ['close']]);
  h.sendDebug({ action: 'tool', label: 'Scopes' });
  h.sendDebug({ action: 'tool', label: 'UnknownTool' });
  assert.deepEqual(h.actions.tools, ['Scopes', 'UnknownTool']);
  assert.ok(h.logs.some((l) => l.includes('tool not found: UnknownTool')));
  h.sendDebug({ action: 'stageSize', w: 800, h: 600 });
  assert.equal(h.el('stage').style.width, '800px');
  assert.equal(h.el('stage').style.height, '600px');

  const clickRes = h.askProbe('click', { sel: '#play' });
  assert.equal(clickRes.found, true);
  assert.equal(h.el('play').clicked, 1);

  const a11yRes = h.askProbe('a11y');
  assert.equal(a11yRes.muted, true);
  assert.equal(a11yRes.loop, true);

  h.sendDebug({ action: 'report', delay: 10 });
  h.sendDebug({ action: 'modesReport', delay: 10 });
  assert.equal(h.timeouts.size, 2);
  h.flushTimeouts();
  assert.ok(h.logs.some((l) => l.startsWith('report frame=')));
  assert.ok(h.logs.some((l) => l.startsWith('modes report panel=')));

  // 3. Passive 60Hz continuity telemetry during active playback.
  h.probe.resetTelemetry();
  h.sendDebug({ action: 'play' });
  assert.equal(playing, true);
  assert.equal(h.rafQueue.size, 1, 'play arms the 60Hz telemetry RAF sampler');

  // Simulate 10 clean 60Hz ticks (~166.7 ms) advancing 1 frame every 2 ticks (30 fps on 60 Hz).
  t = 0;
  frame = 0;
  shownCount = 1;
  for (let i = 0; i < 10; i++) {
    t += 1 / 60;
    if (i % 2 === 1) { frame++; shownCount++; }
    h.stepRaf(16.67);
  }
  let tm = h.askProbe('telemetry');
  assert.equal(tm.active, true);
  assert.equal(tm.samples, 10);
  assert.equal(tm.segments, 1);
  assert.equal(tm.framesAdvanced, 5);
  assert.equal(tm.frameGaps, 0);
  assert.equal(tm.maxFrameGap, 0);
  assert.equal(tm.backwardFrames, 0);
  assert.equal(tm.backwardClockJumps, 0);
  assert.equal(tm.unexpectedClockJumps, 0);
  assert.deepEqual(tm.pageErrors, []);

  // Simulate a 3-frame gap (frame jumps from 5 -> 8), a backward frame jump (8 -> 5) and backward clock jump (-0.2s),
  // and an unexpected forward clock jump (+1.2s in a single 16ms tick) within the same generation.
  t += 3 / 30;
  frame = 8;
  shownCount++;
  h.stepRaf(16.67);

  t -= 0.2;
  frame = 5;
  shownCount++;
  h.stepRaf(16.67);

  t += 1.2;
  frame = 6;
  shownCount++;
  h.stepRaf(16.67);

  tm = h.probe.telemetry();
  assert.equal(tm.frameGaps, 1);
  assert.equal(tm.droppedFrames, 2);
  assert.equal(tm.maxFrameGap, 2);
  assert.equal(tm.backwardFrames, 1);
  assert.equal(tm.backwardClockJumps, 1);
  assert.ok(tm.maxBackwardSec >= 0.19);
  assert.equal(tm.unexpectedClockJumps, 1);
  assert.ok(tm.maxClockJumpSec >= 1.19);

  // An intentional seek / loop wrap (gen increments) starts a new segment without counting as a backward jump!
  h.probe.resetTelemetry();
  t = 2.0;
  frame = 60;
  shownCount = 61;
  h.stepRaf(16.67);
  // Async seek to 1.0s (frame 30): gen increments, shownT/frame stays at 60 until shownCount increments.
  gen++;
  seekTarget = 1.0;
  h.stepRaf(16.67); // while seekTarget is set
  seekTarget = null;
  h.stepRaf(16.67); // seekTarget cleared in addFrame, but tick() has not yet drawn frame 30 (shownCount still 61)
  // Now tick() draws frame 30 and increments shownCount:
  t = 1.0;
  frame = 30;
  shownCount = 62;
  h.stepRaf(16.67);
  t = 1.0167;
  frame = 30;
  h.stepRaf(16.67);

  tm = h.askProbe('telemetry');
  assert.equal(tm.segments, 2, 'seek while playing splits telemetry into two clean segments');
  assert.equal(tm.backwardFrames, 0, 'pre-seek picture lingering until first post-seek draw is not a backward jump');
  assert.equal(tm.backwardClockJumps, 0);
  assert.equal(tm.unexpectedClockJumps, 0);

  // Pausing stops the RAF loop cleanly on the next tick.
  h.sendDebug({ action: 'pause' });
  h.stepRaf(16.67);
  assert.equal(h.rafQueue.size, 0, 'RAF loop rests while paused');
  assert.equal(h.probe.telemetry().active, false);

  // Page errors and unhandled rejections are captured.
  h.win.emit('error', { message: 'ReferenceError: x is not defined', filename: 'player.js', lineno: 99 });
  h.win.emit('unhandledrejection', { reason: new Error('decode failed') });
  tm = h.askProbe('telemetry', { reset: true });
  assert.equal(tm.pageErrors.length, 2);
  assert.match(tm.pageErrors[0], /ReferenceError: x is not defined/);
  assert.match(tm.pageErrors[1], /decode failed/);
  assert.equal(h.probe.telemetry().pageErrors.length, 0, 'reset: true cleared telemetry after reading');

  // 4. Idempotent teardown: cancels active RAF, interval, pending timeouts, and window listeners.
  h.sendDebug({ action: 'play' });
  h.sendDebug({ action: 'report', delay: 500 });
  assert.equal(h.rafQueue.size, 1);
  assert.equal(h.timeouts.size, 1);
  assert.equal(h.intervals.size, 1);

  h.probe.dispose();
  h.probe.dispose(); // idempotent second call
  assert.equal(h.rafQueue.size, 0, 'pending RAF cancelled on dispose');
  assert.equal(h.timeouts.size, 0, 'pending timeouts cancelled on dispose');
  assert.equal(h.intervals.size, 0, 'status interval cleared on dispose');
  assert.equal(h.winListeners.message.length, 0, 'message listener removed');
  assert.equal(h.winListeners.error.length, 0, 'error listener removed');
  assert.equal(h.winListeners.unhandledrejection.length, 0, 'unhandledrejection listener removed');

  const logsBefore = h.logs.length;
  h.sendDebug({ action: 'state', id: 999 });
  h.win.emit('error', { message: 'after dispose' });
  h.probe.wake();
  assert.equal(h.logs.length, logsBefore, 'no messages handled after dispose');
  assert.equal(h.rafQueue.size, 0, 'wake() is a no-op after dispose');
  assert.equal(h.probe.telemetry().pageErrors.length, 0, 'no errors recorded after dispose');

  console.log('debug_probe_test: ok');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
