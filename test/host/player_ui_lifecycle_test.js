'use strict';
// Millisecond tests for the player's lifecycle and host-sync controllers (media/player-ui-lifecycle.js) on the strict
// fake DOM (test/host/fake-dom.js): shared playback prefs and saved state, frame links and resume, the folder-rail
// handoff, the centre overlay and the ready / tileSize / pauseForTest / pagehide bridge. Timers are the fake window's
// list: nothing runs until a test fires them.
const assert = require('assert');
const L = require('../../media/player-ui-lifecycle');
const { createDom } = require('./fake-dom');

const T0 = Date.now();
let count = 0;
const test = (name, fn) => {
  try { fn(); count++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; }
};

function env(html = '') {
  const dom = createDom(html);
  const posted = [];
  const host = { postMessage: (m) => posted.push(m) };
  let state;
  const writes = [];
  const storage = { getState: () => state, setState: (s) => { state = s; writes.push(s); } };
  /** Fires every live timer (optionally only those of `ms`); returns how many ran. */
  const flush = (ms) => {
    let n = 0;
    dom.timers.forEach((t, i) => {
      if (!t || (ms !== undefined && t.ms !== ms)) return;
      dom.timers[i] = null;
      t.fn();
      n++;
    });
    return n;
  };
  const live = () => dom.timers.filter(Boolean);
  return { ...dom, host, posted, storage, writes, getState: () => state, setState: (s) => { state = s; }, flush, live };
}

// ---- 1. prefs sync ----

test('publishPlaybackPrefs posts the prefs and keeps them in the saved state', () => {
  const e = env();
  e.setState({ t: 12 });
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage });
  assert.strictEqual(p.publishPlaybackPrefs({ volume: 0.5, rate: 1.5, timeMode: 1, stepSize: 'frame' }), true);
  assert.deepStrictEqual(e.posted, [{ type: 'playbackPrefs', volume: 0.5, rate: 1.5, timeMode: 1, stepSize: 'frame' }]);
  assert.deepStrictEqual(e.getState(), { t: 12, volume: 0.5, rate: 1.5, timeMode: 1, stepSize: 'frame' });
});

test('publishPlaybackPrefs drops invalid values and posts nothing for unchanged ones', () => {
  const e = env();
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage });
  p.publishPlaybackPrefs({ volume: 2, rate: -1, timeMode: 7, stepSize: null });
  assert.deepStrictEqual(e.posted, [{ type: 'playbackPrefs', volume: undefined, rate: undefined, timeMode: undefined, stepSize: null }]);
  assert.strictEqual(p.publishPlaybackPrefs({ stepSize: null }), false);
  assert.strictEqual(e.posted.length, 1);
});

test('inbound playbackPrefs applies quietly and a publish of the same values does not echo', () => {
  const e = env();
  const applied = [];
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage, onApplyPlaybackPrefs: (x, info) => applied.push([x, info]) });
  assert.strictEqual(p.onHostMessage({ type: 'playbackPrefs', prefs: { volume: 0.3, rate: 2, timeMode: 2 } }), true);
  assert.deepStrictEqual(applied, [[{ volume: 0.3, rate: 2, timeMode: 2 }, { quiet: true }]]);
  assert.deepStrictEqual(e.posted, [], 'applying never posts');
  assert.deepStrictEqual(e.getState(), { volume: 0.3, rate: 2, timeMode: 2 });
  // The page's setters may call publish with what it just applied: still nothing goes out.
  assert.strictEqual(p.publishPlaybackPrefs({ volume: 0.3, rate: 2 }), false);
  assert.deepStrictEqual(e.posted, []);
  // A real change goes out with everything this tab knows.
  assert.strictEqual(p.publishPlaybackPrefs({ rate: 1 }), true);
  assert.deepStrictEqual(e.posted, [{ type: 'playbackPrefs', volume: 0.3, rate: 1, timeMode: 2, stepSize: null }]);
});

test('seed sets the known prefs without posting', () => {
  const e = env();
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage });
  p.seed({ volume: 0.4, rate: 1 });
  assert.strictEqual(p.publishPlaybackPrefs({ volume: 0.4 }), false);
  assert.deepStrictEqual(p.known(), { volume: 0.4, rate: 1 });
  assert.deepStrictEqual(e.posted, []);
});

test('live prefs are normalised and handed over', () => {
  const e = env();
  const live = [];
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage, onApplyLivePrefs: (x) => live.push(x) });
  assert.strictEqual(p.onHostMessage({ type: 'prefs', prefs: { jump: { arrow: 10 }, stepButtons: 'odd', transcode: 'always', transcodeMaxBitrate: 'x', transcodeResolution: '720' } }), true);
  assert.deepStrictEqual(live, [{ jump: { arrow: 10 }, stepButtons: 'frame', transcode: 'always', transcodeMaxBitrate: 0, transcodeResolution: 720 }]);
  p.onHostMessage({ type: 'prefs', prefs: { stepButtons: 'jump' } });
  assert.deepStrictEqual(live[1], { stepButtons: 'jump' });
  p.onHostMessage({ type: 'prefs', prefs: {} });
  assert.strictEqual(live.length, 2, 'an empty prefs message applies nothing');
  assert.strictEqual(p.onHostMessage({ type: 'other' }), false);
  assert.deepStrictEqual(e.posted, []);
});

test('scheduleSave debounces, keeps the newest snapshot and dedupes unchanged ones', () => {
  const e = env();
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage, debounceMs: 250 });
  p.scheduleSave({ t: 1 });
  p.scheduleSave({ t: 2 });
  assert.strictEqual(e.writes.length, 0);
  assert.strictEqual(e.live().length, 1, 'one timer waits');
  assert.strictEqual(e.live()[0].ms, 250);
  assert.ok(p.pendingSave());
  e.flush();
  assert.deepStrictEqual(e.writes, [{ t: 2 }]);
  p.scheduleSave({ t: 2 });
  e.flush();
  assert.strictEqual(e.writes.length, 1, 'the same snapshot is not written again');
  assert.strictEqual(p.saveNow({ t: 2 }), false);
  assert.strictEqual(p.saveNow({ t: 3 }), true);
  assert.deepStrictEqual(e.writes, [{ t: 2 }, { t: 3 }]);
});

test('saveNow flushes a waiting snapshot at once and cancels its timer', () => {
  const e = env();
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage });
  p.scheduleSave({ t: 5 });
  assert.strictEqual(e.live()[0].ms, 300, 'default debounce');
  assert.strictEqual(p.saveNow(), true);
  assert.deepStrictEqual(e.writes, [{ t: 5 }]);
  assert.strictEqual(e.live().length, 0);
  assert.strictEqual(p.saveNow(), false, 'nothing waits');
});

test('loadSaved reads the state store (empty object when none)', () => {
  const e = env();
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage });
  assert.deepStrictEqual(p.loadSaved(), {});
  e.setState({ t: 9, rate: 2 });
  assert.deepStrictEqual(p.loadSaved(), { t: 9, rate: 2 });
});

test('dispose cancels the pending save and ignores later calls', () => {
  const e = env();
  const p = L.createPrefsSync({ win: e.win, host: e.host, storage: e.storage });
  p.scheduleSave({ t: 1 });
  p.dispose();
  assert.strictEqual(e.live().length, 0);
  assert.strictEqual(e.flush(), 0);
  assert.strictEqual(p.saveNow({ t: 2 }), false);
  assert.strictEqual(p.publishPlaybackPrefs({ rate: 2 }), false);
  assert.strictEqual(p.onHostMessage({ type: 'playbackPrefs', prefs: { rate: 2 } }), false);
  assert.deepStrictEqual(e.writes, []);
  assert.deepStrictEqual(e.posted, []);
});

// ---- 2. goto and resume ----

test('parseFragmentLink reads #t= (seconds, m:ss, h:mm:ss) and #frame=', () => {
  const f = L.parseFragmentLink;
  assert.deepStrictEqual(f('#t=12.5'), { t: 12.5 });
  assert.deepStrictEqual(f('t=1:30'), { t: 90 });
  assert.deepStrictEqual(f('#t=1:02:03.5'), { t: 3723.5 });
  assert.deepStrictEqual(f('#t=42s'), { t: 42 });
  assert.deepStrictEqual(f('#frame=10'), { frame: 10 });
  assert.deepStrictEqual(f('#x=1&frame=3'), { frame: 3 });
  assert.deepStrictEqual(f('#t=1%3A05'), { t: 65 });
  for (const bad of ['', null, undefined, '#', '#t=', '#t=abc', '#t=-1', '#frame=0', '#frame=1.5', '#frame=-2', '#t=1:99']) {
    assert.strictEqual(f(bad), null, String(bad));
  }
});

function gotoEnv() {
  const calls = [];
  const g = L.createGotoAndResume({
    onSeek: (x) => calls.push(['seek', x]),
    onSetLayout: (m) => calls.push(['layout', m]),
    onToast: (t) => calls.push(['toast', t]),
    formatTime: (t) => `T${t}`,
  });
  return { g, calls };
}

test('a #t= fragment opens paused on that time', () => {
  const { g, calls } = gotoEnv();
  assert.deepStrictEqual(g.applyOpenTarget({ fragment: '#t=1:05', savedTime: 0, duration: 100 }), { kind: 'goto', paused: true, t: 65, mode: undefined });
  assert.deepStrictEqual(calls, [['seek', { time: 65 }], ['toast', 'T65']]);
});

test('a #frame= fragment opens paused on that frame', () => {
  const { g, calls } = gotoEnv();
  assert.deepStrictEqual(g.applyOpenTarget({ fragment: '#frame=24' }), { kind: 'goto', paused: true, frame: 24, mode: undefined });
  assert.deepStrictEqual(calls, [['seek', { frame: 24 }], ['toast', 'Frame 24']]);
});

test('cfg.goto beats the fragment and the saved time and sets the layout first', () => {
  const { g, calls } = gotoEnv();
  const r = g.applyOpenTarget({ gotoCfg: { mode: 'grid', frame: 7 }, fragment: '#t=3', savedTime: 50, duration: 100 });
  assert.deepStrictEqual(r, { kind: 'goto', paused: true, frame: 7, mode: 'grid' });
  assert.deepStrictEqual(calls, [['layout', 'grid'], ['seek', { frame: 7 }], ['toast', 'Frame 7']]);
});

test('a parsed fragment object works too, and an unusable goto falls back to the resume', () => {
  const { g, calls } = gotoEnv();
  assert.strictEqual(g.applyOpenTarget({ fragment: { t: 4 } }).kind, 'goto');
  calls.length = 0;
  const r = g.applyOpenTarget({ gotoCfg: { frame: 0 }, fragment: '#nonsense', savedTime: 20, duration: 100 });
  assert.deepStrictEqual(r, { kind: 'resume', t: 20 });
  assert.deepStrictEqual(calls, [['seek', { time: 20 }], ['toast', 'Resumed at T20 (Home: start)']]);
});

test('resume threshold: not at the start, not at the end', () => {
  const { g, calls } = gotoEnv();
  assert.deepStrictEqual(g.applyOpenTarget({ savedTime: 0.5, duration: 100 }), { kind: 'start' });
  assert.deepStrictEqual(g.applyOpenTarget({ savedTime: 0, duration: 100 }), { kind: 'start' });
  assert.deepStrictEqual(g.applyOpenTarget({ savedTime: 99.5, duration: 100 }), { kind: 'start' });
  assert.deepStrictEqual(g.applyOpenTarget({}), { kind: 'start' });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(g.applyOpenTarget({ savedTime: 0.6, duration: 100 }), { kind: 'resume', t: 0.6 });
  // Unknown duration: any position past the threshold resumes.
  assert.deepStrictEqual(g.applyOpenTarget({ savedTime: 500 }), { kind: 'resume', t: 500 });
  assert.strictEqual(calls.filter((c) => c[0] === 'toast').length, 2);
});

test('the default formatter writes m:ss.mmm', () => {
  const toasts = [];
  const g = L.createGotoAndResume({ onSeek: () => {}, onToast: (t) => toasts.push(t) });
  g.applyOpenTarget({ savedTime: 75.25 });
  assert.deepStrictEqual(toasts, ['Resumed at 1:15.250 (Home: start)']);
  assert.strictEqual(L.defaultFormatTime(3723.5), '1:02:03.500');
});

test('a live goto message sets the layout and seeks to the frame or time', () => {
  const { g, calls } = gotoEnv();
  assert.strictEqual(g.handleGotoMessage({ type: 'goto', mode: 'spotlight', frame: 3 }), true);
  assert.strictEqual(g.handleGotoMessage({ type: 'goto', t: 2.5 }), true);
  assert.strictEqual(g.handleGotoMessage({ type: 'goto', mode: 'grid' }), true);
  assert.strictEqual(g.handleGotoMessage({ type: 'goto', frame: 'x' }), true);
  assert.strictEqual(g.handleGotoMessage({ type: 'pos' }), false);
  assert.deepStrictEqual(calls, [
    ['layout', 'spotlight'], ['seek', { frame: 3 }], ['toast', 'Frame 3'],
    ['seek', { time: 2.5 }], ['toast', 'T2.5'],
    ['layout', 'grid'],
  ]);
});

// ---- 3. rail handoff ----

function railEnv(withRail = true) {
  const e = env();
  const calls = [];
  const rail = withRail ? {
    go: (d, auto) => calls.push(['go', d, auto]),
    adopt: (s) => calls.push(['adopt', s]),
    onMessage: (m) => calls.push(['railMsg', m.op]),
  } : null;
  const c = L.createRailHandoffController({
    host: e.host, rail,
    onSetAutoplay: (m) => calls.push(['autoplay', m]),
    onPlayFromStart: () => calls.push(['play0']),
  });
  return { e, c, calls };
}

test('Autoplay next on a natural end opens the next video only when it should', () => {
  const { c, calls } = railEnv();
  const ok = { visible: true, rate: 1, isFile: true, autoplayMode: 'next' };
  assert.strictEqual(c.onNaturalEnd({ ...ok, autoplayMode: 'loop' }), false);
  assert.strictEqual(c.onNaturalEnd({ ...ok, autoplayMode: 'off' }), false);
  assert.strictEqual(c.onNaturalEnd({ ...ok, visible: false }), false);
  assert.strictEqual(c.onNaturalEnd({ ...ok, rate: 0 }), false);
  assert.strictEqual(c.onNaturalEnd({ ...ok, rate: -1 }), false);
  assert.strictEqual(c.onNaturalEnd({ ...ok, isFile: false }), false);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(c.onNaturalEnd(ok), true);
  assert.deepStrictEqual(calls, [['go', 1, true]]);
  assert.strictEqual(railEnv(false).c.onNaturalEnd(ok), false, 'no rail, no next');
});

test('a railHandoff before markReady waits, then applies and answers railAdopted', () => {
  const { e, c, calls } = railEnv();
  c.onHostMessage({ type: 'railHandoff', id: 1, onEnd: 'loop', rail: { a: 1 } });
  c.onHostMessage({ type: 'railHandoff', id: 2, onEnd: 'next', rail: { b: 2 }, fromAutoNext: true });
  assert.ok(c.hasPending());
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(e.posted, []);
  c.markReady();
  assert.deepStrictEqual(calls, [['autoplay', 'next'], ['adopt', { b: 2 }], ['play0']], 'the newer handoff replaced the older');
  assert.deepStrictEqual(e.posted, [{ type: 'railAdopted', id: 2, ok: true }]);
  assert.ok(!c.hasPending());
  // Once ready, a handoff applies at once; without fromAutoNext it does not play.
  c.onHostMessage({ type: 'railHandoff', id: 3, rail: { c: 3 } });
  assert.deepStrictEqual(calls.slice(3), [['adopt', { c: 3 }]]);
  assert.deepStrictEqual(e.posted[1], { type: 'railAdopted', id: 3, ok: true });
});

test('railHandoffCancel drops only the matching waiting handoff', () => {
  const { e, c } = railEnv();
  c.onHostMessage({ type: 'railHandoff', id: 5 });
  c.onHostMessage({ type: 'railHandoffCancel', id: 4 });
  assert.ok(c.hasPending());
  c.onHostMessage({ type: 'railHandoffCancel', id: 5 });
  assert.ok(!c.hasPending());
  c.markReady();
  assert.deepStrictEqual(e.posted, []);
});

test('resetClip makes handoffs wait again and allows a fresh seed', () => {
  const { e, c } = railEnv();
  c.markReady();
  assert.ok(c.seedSelf({ duration: 1 }));
  c.resetClip();
  assert.ok(!c.isReady());
  c.onHostMessage({ type: 'railHandoff', id: 9 });
  assert.strictEqual(e.posted.filter((m) => m.type === 'railAdopted').length, 0);
  assert.ok(c.seedSelf({ duration: 2 }));
  c.markReady();
  assert.strictEqual(e.posted.filter((m) => m.type === 'railAdopted').length, 1);
});

test('railCarry is adopted; rail messages go to the rail', () => {
  const { c, calls } = railEnv();
  assert.strictEqual(c.adoptCarry({ items: [1] }), true);
  assert.strictEqual(c.adoptCarry(null), false);
  assert.strictEqual(c.onHostMessage({ type: 'rail', op: 'list' }), true);
  assert.strictEqual(c.onHostMessage({ type: 'nope' }), false);
  assert.deepStrictEqual(calls, [['adopt', { items: [1] }], ['railMsg', 'list']]);
  assert.strictEqual(railEnv(false).c.adoptCarry({}), false);
});

test('seedSelf posts the rail seed once per clip', () => {
  const { e, c } = railEnv();
  assert.strictEqual(c.seedSelf({ duration: 10.5, width: 1920, height: 1080, codec: 'h264' }), true);
  assert.strictEqual(c.seedSelf({ duration: 99 }), false);
  assert.deepStrictEqual(e.posted, [{ type: 'rail', op: 'self', duration: 10.5, width: 1920, height: 1080, codec: 'h264' }]);
  const n = railEnv(false);
  assert.strictEqual(n.c.seedSelf({ duration: 1 }), false, 'no rail, no seed');
  assert.deepStrictEqual(n.e.posted, []);
});

// ---- 4. overlay ----

const OVERLAY = '<div id="overlay" hidden><div id="message"></div><div id="hint"></div><button id="action" hidden></button></div><div id="stage"></div>';
function overlayEnv({ withAction = true } = {}) {
  const e = env(OVERLAY);
  if (!withAction) e.$('action').remove();
  const said = [];
  const o = L.createOverlayController({
    doc: e.doc, overlayEl: e.$('overlay'), messageEl: e.$('message'), hintEl: e.$('hint'),
    actionEl: withAction ? e.$('action') : undefined, host: e.host, onAnnounce: (t) => said.push(t),
  });
  return { e, o, said };
}

test('a single status line shows and is announced once', () => {
  const { e, o, said } = overlayEnv();
  o.showStatus('Opening…');
  assert.ok(o.isShown());
  assert.strictEqual(e.$('message').textContent, 'Opening…');
  assert.strictEqual(e.$('hint').textContent, '');
  assert.ok(e.$('action').hidden);
  o.showStatus('Opening…');
  o.showStatus('Switching quality…', 'HLS');
  assert.strictEqual(e.$('hint').textContent, 'HLS');
  assert.deepStrictEqual(said, ['Opening…', 'Switching quality… HLS']);
});

test('per-tile Compare status lines render one row each', () => {
  const { e, o, said } = overlayEnv();
  o.showStatus(['A: Opening…', 'B: Ready', '']);
  const rows = e.$('message').querySelectorAll('.overlay-line');
  assert.deepStrictEqual(rows.map((r) => r.textContent), ['A: Opening…', 'B: Ready']);
  assert.deepStrictEqual(said, ['A: Opening…. B: Ready']);
  o.showStatus('Loading…');
  assert.strictEqual(e.$('message').querySelectorAll('.overlay-line').length, 0, 'a single line replaces the rows');
});

test('an error with the ffmpeg action posts it once and turns into Downloading…', () => {
  const { e, o, said } = overlayEnv();
  let outer = 0;
  e.$('stage').parentNode.addEventListener('click', () => outer++);
  o.showError({ message: 'This URL needs ffmpeg', hint: 'It plays once ffmpeg is set up.', action: 'setupFfmpeg' });
  const btn = e.$('action');
  assert.ok(o.isShown());
  assert.ok(e.$('overlay').classList.contains('error'));
  assert.strictEqual(e.$('message').textContent, 'This URL needs ffmpeg');
  assert.strictEqual(btn.hidden, false);
  assert.strictEqual(btn.textContent, 'Set up ffmpeg');
  assert.deepStrictEqual(said, ['This URL needs ffmpeg It plays once ffmpeg is set up.']);
  btn.click();
  assert.deepStrictEqual(e.posted, [{ type: 'action', id: 'setupFfmpeg' }]);
  assert.strictEqual(btn.textContent, 'Downloading…');
  assert.ok(btn.disabled);
  btn.click();
  assert.strictEqual(e.posted.length, 1, 'a disabled button posts nothing');
  assert.strictEqual(outer, 0, 'the click does not reach the page (no play toggle)');
});

test('an action object with its own label; an unknown action id shows no button', () => {
  const { e, o } = overlayEnv();
  o.showError({ message: 'Boom', action: { id: 'retry', label: 'Retry' } });
  assert.strictEqual(e.$('action').textContent, 'Retry');
  assert.ok(!e.$('action').disabled);
  o.showError({ message: 'Boom', action: 'unknown' });
  assert.ok(e.$('action').hidden);
  o.showError({ message: 'Boom' });
  assert.ok(e.$('action').hidden);
});

test('without an action element the overlay makes its own button', () => {
  const { e, o } = overlayEnv({ withAction: false });
  o.showError({ message: 'x', action: 'setupFfmpeg' });
  const btn = e.$('overlay').querySelector('button.overlay-action');
  assert.ok(btn);
  assert.strictEqual(btn.textContent, 'Set up ffmpeg');
  btn.click();
  assert.deepStrictEqual(e.posted, [{ type: 'action', id: 'setupFfmpeg' }]);
  // A later error re-enables it with its label.
  o.showError({ message: 'y', action: 'setupFfmpeg' });
  assert.ok(!btn.disabled);
  assert.strictEqual(btn.textContent, 'Set up ffmpeg');
});

test('hide clears the overlay; the same text is announced again after it', () => {
  const { e, o, said } = overlayEnv();
  o.showError({ message: 'Bad', hint: 'h', action: 'setupFfmpeg' });
  o.hide();
  assert.ok(!o.isShown());
  assert.ok(e.$('overlay').hidden);
  assert.ok(!e.$('overlay').classList.contains('error'));
  assert.strictEqual(e.$('message').textContent, '');
  assert.strictEqual(e.$('hint').textContent, '');
  assert.ok(e.$('action').hidden);
  o.showStatus('Bad h');
  assert.deepStrictEqual(said, ['Bad h', 'Bad h']);
  o.showStatus('');
  assert.ok(!o.isShown(), 'an empty status hides');
});

test('host error and status messages', () => {
  const { e, o } = overlayEnv();
  assert.strictEqual(o.onHostMessage({ type: 'status', text: 'Connecting…' }), true);
  assert.ok(!o.isShown(), 'a status shows only while the overlay is up');
  o.showStatus('Opening…');
  o.onHostMessage({ type: 'status', text: 'Reading the playlist…' });
  assert.strictEqual(e.$('message').textContent, 'Reading the playlist…');
  o.onHostMessage({ type: 'status', text: 'Late' }, { started: true });
  assert.strictEqual(e.$('message').textContent, 'Reading the playlist…', 'not once the player started');
  o.onHostMessage({ type: 'error', message: 'Nope', hint: 'Try again', action: 'setupFfmpeg' });
  assert.strictEqual(e.$('action').textContent, 'Set up ffmpeg');
  assert.strictEqual(o.onHostMessage({ type: 'other' }), false);
});

// ---- 5. lifecycle bridge ----

function bridgeEnv() {
  const e = env();
  e.win.location = { origin: 'vscode-webview://abc' };
  const calls = [];
  const b = L.createLifecycleBridge({
    win: e.win, host: e.host,
    onTileSize: (t) => calls.push(['tile', t]),
    onPauseForTest: () => { calls.push(['pause']); return e.playing; },
    onToast: (t, ms) => calls.push(['toast', t, ms]),
    onDispose: () => calls.push(['dispose']),
  });
  return { e, b, calls };
}

test('sendReady posts ready with the tile, origin and view', () => {
  const { e, b } = bridgeEnv();
  b.sendReady({ tile: { w: 640, h: 360 }, view: 'grid' });
  b.sendReady({ origin: 'o' });
  assert.deepStrictEqual(e.posted, [
    { type: 'ready', tile: { w: 640, h: 360 }, origin: 'vscode-webview://abc', view: 'grid' },
    { type: 'ready', origin: 'o' },
  ]);
});

test('tileSize debounces 150 ms fast / 300 ms normal and skips the same size', () => {
  const { e, b, calls } = bridgeEnv();
  b.sendReady({ tile: { w: 640, h: 360 } });
  e.posted.length = 0;
  b.scheduleTileSize({ w: 640, h: 360 }, true);
  assert.strictEqual(e.live()[0].ms, 150);
  e.flush();
  assert.deepStrictEqual(e.posted, [], 'the ready size is already known');
  let size = { w: 100, h: 50 };
  b.scheduleTileSize(() => size);
  b.scheduleTileSize(() => size);
  assert.strictEqual(e.live().length, 1, 'a newer request replaces the waiting one');
  assert.strictEqual(e.live()[0].ms, 300);
  size = { w: 800, h: 450 };
  e.flush();
  assert.deepStrictEqual(e.posted, [{ type: 'tileSize', tile: { w: 800, h: 450 } }], 'read when the timer fires');
  assert.deepStrictEqual(calls, [['tile', { w: 800, h: 450 }]]);
  b.scheduleTileSize({ w: 800, h: 450 }, true);
  b.scheduleTileSize({ w: 0, h: 450 }, true);
  e.flush();
  assert.strictEqual(e.posted.length, 1, 'same or empty size posts nothing');
});

test('pauseForTest pauses and toasts only when something played', () => {
  const { e, b, calls } = bridgeEnv();
  e.playing = true;
  assert.strictEqual(b.onHostMessage({ type: 'pauseForTest' }), true);
  e.playing = false;
  b.onHostMessage({ type: 'pauseForTest' });
  assert.strictEqual(b.onHostMessage({ type: 'ready' }), false);
  assert.deepStrictEqual(calls, [['pause'], ['toast', 'Paused while ffmpeg is tested', 3000], ['pause']]);
});

test('pagehide disposes once and cancels a waiting tileSize', () => {
  const { e, b, calls } = bridgeEnv();
  b.scheduleTileSize({ w: 1, h: 1 });
  assert.strictEqual(e.win.listenerCount('pagehide'), 1);
  e.win.fire('pagehide');
  assert.ok(b.isDisposed());
  assert.strictEqual(e.live().length, 0);
  assert.strictEqual(e.win.listenerCount('pagehide'), 0);
  e.win.fire('pagehide');
  b.dispose();
  b.scheduleTileSize({ w: 2, h: 2 });
  assert.strictEqual(e.live().length, 0);
  assert.deepStrictEqual(calls, [['dispose']]);
  assert.deepStrictEqual(e.posted, []);
});

test('the browser global and CommonJS export are the same API', () => {
  for (const k of ['createPrefsSync', 'createGotoAndResume', 'createRailHandoffController', 'createOverlayController', 'createLifecycleBridge', 'parseFragmentLink']) {
    assert.strictEqual(typeof L[k], 'function', k);
  }
});

console.log(`player_ui_lifecycle_test: ${count} tests passed in ${Date.now() - T0} ms`);
