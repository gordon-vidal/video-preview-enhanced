'use strict';
// Millisecond tests for the player's tool controllers (media/player-ui-tools.js) on the strict fake DOM
// (test/host/fake-dom.js): the #notice banner (reduced resolution, slow playback, A-B clip refusal, dismissals, Esc),
// inspection (scopes, pixel inspector, stats, Codec X-ray, keyframe and chapter steps, Esc order, missing engine
// hooks), subtitles (CC button, keys, delay / size, the host's tracks, cue placement) and frame export (save, copy,
// clipboard fallback, timestamp, link, the A-B export protocol). Nothing decodes video: the engine is a stub.
const assert = require('assert');
const T = require('../../media/player-ui-tools');
const reducedResNotice = require('../../media/reduced-res-notice');
const slowNotice = require('../../media/slow-notice');
const { createDom } = require('./fake-dom');

const T0 = Date.now();
let count = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise((r) => setImmediate(r));

const NOTICE_HTML = `<div id="stage"><canvas id="cv"></canvas><div id="subs" hidden></div>
  <div id="notice" hidden>
    <span id="noticeText"></span>
    <button id="noticeAction"></button>
    <button id="noticeSettings" class="noticeSecondary" hidden></button>
    <button id="noticeHide" class="noticeSecondary" hidden></button>
    <button id="noticeClose" title="Dismiss" aria-label="Dismiss">×</button>
  </div></div><button id="play">Play</button>`;

function noticeSetup(opts = {}) {
  const dom = createDom(NOTICE_HTML);
  const log = { actions: [], dismissed: [], announced: [], stageClicks: 0 };
  dom.$('stage').addEventListener('click', () => { log.stageClicks++; });
  const n = T.createNoticeController({
    doc: dom.doc, win: dom.win, noticeEl: dom.$('notice'), playBtnEl: dom.$('play'),
    reducedResHelper: reducedResNotice, slowHelper: slowNotice,
    onAction: (id, detail) => log.actions.push(detail ? [id, detail] : id),
    onDismiss: (kind, d) => log.dismissed.push([kind, d]),
    onAnnounce: (t) => log.announced.push(t),
    ...opts,
  });
  return { ...dom, n, log };
}

// ---- 1. notice banner ----

test('notice: reduced resolution shows once, with its buttons', () => {
  const { $, n, log } = noticeSetup();
  assert.strictEqual(n.maybeShowReducedRes({ nativeLossy: false }), false, 'exact pixels: no notice');
  const video = { width: 1280, height: 720, sourceWidth: 3840, sourceHeight: 2160, pixFmt: 'yuv420p10le', depth: 8 };
  assert.strictEqual(n.maybeShowReducedRes({ reason: 'inspector', nativeLossy: true, video }), true);
  assert.strictEqual($('notice').hidden, false);
  assert.strictEqual($('notice').dataset.kind, 'reducedRes');
  assert.match($('noticeText').textContent, /^Playing at 1280×720 \(8-bit\).*original 3840×2160 \(10-bit\) file\.$/);
  assert.deepStrictEqual(log.announced, [$('noticeText').textContent]);
  assert.strictEqual($('noticeAction').textContent, 'Use full resolution (this tab)');
  assert.strictEqual($('noticeSettings').hidden, false);
  assert.strictEqual($('noticeHide').textContent, "Don't show again");
  $('noticeSettings').click();
  assert.deepStrictEqual(log.actions, ['nativeResolutionSettings']);
  assert.strictEqual(n.isOpen(), true, 'Settings does not close');
  $('noticeAction').click();
  assert.deepStrictEqual(log.actions, ['nativeResolutionSettings', 'fullRes']);
  $('noticeHide').click();
  assert.deepStrictEqual(log.actions.slice(-1), ['hideReducedResNotice']);
  assert.strictEqual(n.isOpen(), false);
  assert.deepStrictEqual(log.dismissed, [['reducedRes', { reducedRes: true }]]);
  assert.strictEqual(n.maybeShowReducedRes({ nativeLossy: true, video }), false, 'once per page');
});

test('notice: reduced resolution for Live transcode points at the transcode settings', () => {
  const { $, n } = noticeSetup();
  n.maybeShowReducedRes({ transcoded: true, stream: { sourceWidth: 1920, sourceHeight: 1080 }, display: { width: 960, height: 540 } });
  assert.match($('noticeText').textContent, /Live transcode \(960×540\)/);
  $('noticeSettings').click();
});

test('notice: a persisted dismissal keeps it away; setDismissals / getDismissals', () => {
  const { n } = noticeSetup({ dismissals: { reducedRes: true } });
  assert.strictEqual(n.maybeShowReducedRes({ nativeLossy: true }), false);
  assert.deepStrictEqual(n.getDismissals(), { reducedRes: true });
  n.setDismissals({});
  assert.strictEqual(n.maybeShowReducedRes({ nativeLossy: true }), true);
  n.setDismissals({ slowPlayback: true });
  assert.strictEqual(n.maybeShowSlowPlayback('skip'), false);
});

test('notice: Esc closes, returns focus to Play and persists; the banner click does not reach the stage', () => {
  const { $, doc, n, log } = noticeSetup();
  n.maybeShowReducedRes({ nativeLossy: true });
  $('noticeAction').focus();
  const click = $('noticeText').fire('click');
  assert.strictEqual(click.propagationStopped, true);
  $('notice').fire('pointerdown');
  assert.strictEqual(log.stageClicks, 0, 'the stage never saw it');
  doc.body.focus();
  const esc = doc.body.fire('keydown', { key: 'Escape' });
  assert.strictEqual(esc.defaultPrevented, true);
  assert.strictEqual($('notice').hidden, true);
  assert.strictEqual(doc.activeElement, $('play'), 'Esc always returns focus to Play');
  assert.deepStrictEqual(log.dismissed.map((d) => d[0]), ['reducedRes']);
  const again = doc.body.fire('keydown', { key: 'Escape' });
  assert.strictEqual(again.defaultPrevented, false, 'closed: Esc is not taken');
});

test('notice: × returns focus to Play only when the focus was inside', () => {
  const { $, doc, n } = noticeSetup();
  n.showClipRefusal({ transcoded: true });
  doc.body.focus();
  $('noticeClose').click();
  assert.strictEqual(doc.activeElement, doc.body);
  n.showClipRefusal({});
  $('noticeClose').focus();
  $('noticeClose').click();
  assert.strictEqual(doc.activeElement, $('play'));
});

test('notice: slow playback once per kind, whenSlow action, × persists, Don\'t show again posts', () => {
  const { $, n, log } = noticeSetup();
  assert.strictEqual(n.maybeShowSlowPlayback('every'), true);
  assert.strictEqual($('notice').dataset.kind, 'slowPlayback');
  assert.strictEqual($('noticeAction').textContent, 'Skip frames (all videos)');
  $('noticeAction').click();
  assert.deepStrictEqual(log.actions, [['whenSlow', { value: 'skip' }]]);
  assert.strictEqual(n.isOpen(), false, 'the action closes');
  assert.deepStrictEqual(log.dismissed, [], 'an action is not a dismissal');
  assert.strictEqual(n.maybeShowSlowPlayback('skip'), false, "kind 'slow' already shown");
  assert.strictEqual(n.maybeShowSlowPlayback({ variant: 'setupFfmpeg', mb: 75 }), true);
  assert.strictEqual($('noticeAction').textContent, 'Set up ffmpeg');
  assert.match($('noticeAction').title, /about 75 MB/);
  $('noticeAction').click();
  assert.deepStrictEqual(log.actions.slice(-1), ['setupFfmpeg']);
  // A fresh page: the × remembers.
  const s = noticeSetup();
  s.n.maybeShowSlowPlayback('fast');
  assert.strictEqual(s.$('noticeAction').hidden, true, 'fast: no action');
  s.$('noticeSettings').click();
  assert.deepStrictEqual(s.log.actions, ['fastPreviewSettings']);
  s.$('noticeClose').click();
  assert.deepStrictEqual(s.log.dismissed, [['slowPlayback', { slowPlayback: true }]]);
  assert.strictEqual(s.n.maybeShowSlowPlayback('setupFfmpeg'), false);
  const h = noticeSetup();
  h.n.maybeShowSlowPlayback('autoEvery');
  h.$('noticeHide').click();
  assert.deepStrictEqual(h.log.actions, ['hideSlowPlaybackNotice']);
  assert.strictEqual(h.n.isOpen(), false);
});

test('notice: clip refusal variants offer fullRes', () => {
  const { $, n, log } = noticeSetup();
  n.showClipRefusal({ syntheticTimes: true });
  assert.match($('noticeText').textContent, /^This ffmpeg cannot report/);
  assert.strictEqual($('noticeAction').textContent, 'Switch to built-in decoder');
  assert.strictEqual($('noticeSettings').hidden, true);
  assert.strictEqual($('noticeHide').hidden, true);
  n.showClipRefusal({ transcoded: true });
  assert.strictEqual($('noticeAction').textContent, 'Use original video');
  $('noticeAction').click();
  assert.deepStrictEqual(log.actions, ['fullRes']);
  assert.strictEqual(n.isOpen(), false);
});

test('notice: hide(kind), handleEscape, dispose; missing children are created', () => {
  const { n } = noticeSetup();
  n.showClipRefusal({});
  n.hide('reducedRes');
  assert.strictEqual(n.isOpen(), true, 'another kind: stays');
  n.hide('clipRefusal');
  assert.strictEqual(n.isOpen(), false);
  assert.strictEqual(n.handleEscape(), false);
  n.showClipRefusal({});
  assert.strictEqual(n.handleEscape(), true);
  n.dispose();
  const dom = createDom('<div id="notice" hidden></div><button id="play"></button>');
  const bare = T.createNoticeController({ doc: dom.doc, noticeEl: dom.$('notice'), playBtnEl: dom.$('play') });
  bare.maybeShowReducedRes({ nativeLossy: true });
  assert.ok(dom.$('noticeText').textContent.length > 0, 'fallback text without the helper');
  assert.strictEqual(dom.$('noticeClose').getAttribute('aria-label'), 'Dismiss');
});

test('notice priority: lower waits behind higher, higher preempts and restores the lower on close', () => {
  const { $, n, log } = noticeSetup();
  assert.deepStrictEqual(T.NOTICE_PRIORITY, { error: 3, clipRefusal: 3, reducedRes: 2, slowPlayback: 1, info: 0 });
  assert.strictEqual(n.maybeShowReducedRes({ nativeLossy: true }), true);
  const reducedText = $('noticeText').textContent;
  // Lower (slowPlayback) while reducedRes shows: queued, the banner text never changes.
  assert.strictEqual(n.maybeShowSlowPlayback('every'), true, 'offered');
  assert.strictEqual(n.kind(), 'reducedRes');
  assert.strictEqual($('noticeText').textContent, reducedText, 'no flash over the higher notice');
  assert.deepStrictEqual(log.announced, [reducedText], 'the queued one is not announced yet');
  assert.deepStrictEqual(n.pendingKinds(), ['slowPlayback']);
  // Higher (clipRefusal) preempts: reducedRes waits, its dismissal is NOT persisted.
  assert.strictEqual(n.showClipRefusal({ transcoded: true }), true);
  assert.strictEqual(n.kind(), 'clipRefusal');
  assert.deepStrictEqual(n.pendingKinds(), ['slowPlayback', 'reducedRes']);
  assert.deepStrictEqual(log.dismissed, [], 'preemption is not a dismissal');
  // A duplicate of a waiting kind replaces it in place of piling up.
  assert.strictEqual(n.show({ kind: 'slowPlayback', text: 'newer slow text' }), false);
  assert.deepStrictEqual(n.pendingKinds(), ['reducedRes', 'slowPlayback']);
  // The same kind as the banner updates it (no queue entry).
  n.showClipRefusal({});
  assert.match($('noticeText').textContent, /^This ffmpeg/);
  assert.deepStrictEqual(n.pendingKinds(), ['reducedRes', 'slowPlayback']);
  // Close: highest waiting first (reducedRes), then the slow one.
  $('noticeClose').click();
  assert.strictEqual(n.kind(), 'reducedRes');
  assert.strictEqual($('noticeText').textContent, reducedText);
  $('noticeClose').click();
  assert.deepStrictEqual(log.dismissed.map((d) => d[0]), ['reducedRes']);
  assert.strictEqual(n.kind(), 'slowPlayback');
  assert.strictEqual($('noticeText').textContent, 'newer slow text');
  $('noticeClose').click();
  assert.strictEqual(n.isOpen(), false);
  assert.deepStrictEqual(n.pendingKinds(), []);
});

test('notice priority: equal priority replaces (old waits); a waiting notice dismissed meanwhile is dropped', () => {
  const { n } = noticeSetup();
  n.show({ kind: 'info', text: 'a' });
  n.show({ kind: 'info', key: 'b', text: 'b' });
  assert.strictEqual(n.kind(), 'info');
  assert.deepStrictEqual(n.pendingKinds(), ['info']);
  n.show({ kind: 'error', text: 'boom' });
  n.maybeShowReducedRes({ nativeLossy: true });
  assert.deepStrictEqual(n.pendingKinds(), ['info', 'info', 'reducedRes']);
  n.setDismissals({ reducedRes: true });
  n.handleEscape();
  assert.strictEqual(n.kind(), 'info', 'dismissed reducedRes skipped');
  // hide(kind) withdraws it from the banner and the queue; hide() clears everything.
  assert.strictEqual(n.show({ kind: 'slowPlayback', text: 's' }), true, 'outranks info');
  assert.deepStrictEqual(n.pendingKinds(), ['info', 'info']);
  n.hide('slowPlayback');
  assert.strictEqual(n.kind(), 'info');
  assert.deepStrictEqual(n.pendingKinds(), ['info']);
  n.hide();
  assert.strictEqual(n.isOpen(), false);
  assert.deepStrictEqual(n.pendingKinds(), []);
});

test('notice: slow playback never during Live transcode or streaming', () => {
  const { n } = noticeSetup();
  assert.strictEqual(n.maybeShowSlowPlayback({ variant: 'every', transcoded: true }), false);
  assert.strictEqual(n.maybeShowSlowPlayback({ variant: 'setupFfmpeg', streaming: true }), false);
  assert.strictEqual(n.isOpen(), false);
  // Suppressed calls do not use up the once-per-kind budget.
  assert.strictEqual(n.maybeShowSlowPlayback('every'), true);
  // Switching to Live transcode drops a shown or waiting slow notice.
  n.setContext({ transcoded: true });
  assert.strictEqual(n.isOpen(), false);
  assert.strictEqual(n.maybeShowSlowPlayback('setupFfmpeg'), false, 'context blocks it');
  const w = noticeSetup();
  w.n.maybeShowReducedRes({ nativeLossy: true });
  w.n.maybeShowSlowPlayback('every');
  w.n.setContext({ streaming: true });
  assert.deepStrictEqual(w.n.pendingKinds(), []);
  assert.strictEqual(w.n.kind(), 'reducedRes', 'other kinds stay');
  w.n.setContext({});
  assert.strictEqual(w.n.maybeShowSlowPlayback('setupFfmpeg'), true, 'back to the local decoder');
});

test('notice: notice-open on the stage while the banner shows, with its measured bottom edge', () => {
  const { $, n } = noticeSetup();
  const stage = $('stage');
  assert.strictEqual(T.NOTICE_OPEN_CLASS, 'notice-open');
  assert.strictEqual(stage.classList.contains('notice-open'), false);
  Object.defineProperty($('notice'), 'offsetHeight', { value: 50, configurable: true });
  Object.defineProperty($('notice'), 'offsetTop', { value: 8, configurable: true });
  n.showClipRefusal({});
  assert.strictEqual(stage.classList.contains('notice-open'), true);
  assert.strictEqual(stage.style.getPropertyValue('--notice-bottom'), '58px');
  n.maybeShowReducedRes({ nativeLossy: true });
  $('noticeClose').click();
  assert.strictEqual(stage.classList.contains('notice-open'), true, 'the waiting notice took over');
  n.hide('reducedRes');
  assert.strictEqual(stage.classList.contains('notice-open'), false);
  assert.strictEqual(stage.style.getPropertyValue('--notice-bottom'), '');
  // An explicit stageEl wins over the parent.
  const dom = createDom('<div id="a"><div id="notice" hidden></div></div><div id="b"></div>');
  const c = T.createNoticeController({ doc: dom.doc, noticeEl: dom.$('notice'), stageEl: dom.$('b') });
  c.show({ kind: 'info', text: 'x' });
  assert.strictEqual(dom.$('b').classList.contains('notice-open'), true);
  assert.strictEqual(dom.$('a').classList.contains('notice-open'), false);
});

test('shouldSuppressToast: duplicates of the banner or the Live chip, never user confirmations', () => {
  const s = T.shouldSuppressToast;
  assert.strictEqual(s(''), true, 'empty');
  assert.strictEqual(s('   '), true);
  assert.strictEqual(s('Frame copied'), false);
  assert.strictEqual(s('Playing a Live transcode (960×540)', { liveChipVisible: true }), true);
  assert.strictEqual(s('Transcoding…', { liveChipVisible: true }), true);
  assert.strictEqual(s('Transcoding…', { liveChipVisible: false }), false, 'no chip: the toast is the only signal');
  assert.strictEqual(s('Live transcode: auto', { liveChipVisible: true }), false, 'confirms a user choice');
  const noticeText = 'Skipping frames to keep real-time speed with audio. You can show every frame instead.';
  assert.strictEqual(s('Skipping frames to keep real-time speed with audio.', { noticeOpen: true, noticeText }), true);
  assert.strictEqual(s('skipping  frames to keep real-time speed WITH audio', { noticeOpen: true, noticeText }), true);
  assert.strictEqual(s('Skipping frames to keep real-time speed with audio.', { noticeOpen: false, noticeText }), false);
  assert.strictEqual(s('frames', { noticeOpen: true, noticeText }), false, 'a short word is not a duplicate');
  assert.strictEqual(s('Volume 80%', { noticeOpen: true, noticeText }), false);
  // The controller's bound form fills in its own state.
  const { n } = noticeSetup();
  assert.strictEqual(n.shouldSuppressToast('Use original video and set A and B again'), false, 'closed');
  n.show({ kind: 'info', text: 'Pixel values are not available for this video' });
  assert.strictEqual(n.shouldSuppressToast('Pixel values are not available for this video'), true);
  assert.strictEqual(n.shouldSuppressToast('Transcoding', { liveChipVisible: true }), true);
});

// ---- 2. inspection ----

function inspectSetup(engine, opts = {}) {
  const dom = createDom('<div id="stage"><pre id="stats" class="stats" hidden></pre></div>');
  const log = { toasts: [], seeks: [], before: [], posts: [], scopes: [], insp: [], xray: [] };
  let t = 5;
  const c = T.createInspectionController({
    doc: dom.doc, win: dom.win, engine,
    host: { postMessage: (m) => log.posts.push(m) },
    widgets: {
      scopes: { setMode: (m) => log.scopes.push(m) },
      inspector: { setMode: (m) => log.insp.push(m) },
      stats: dom.$('stats'),
      xray: { show: (p) => log.xray.push(['show', p.length]), hide: () => log.xray.push(['hide']) },
    },
    getActiveClip: () => 'clipA',
    getFrame: () => ({ frame: Math.round(t * 25), t }),
    onToast: (s) => log.toasts.push(s),
    onSeek: (x) => { log.seeks.push(x); t = x; },
    onBeforeInspect: (k) => log.before.push(k),
    ...opts,
  });
  return { ...dom, c, log, setT: (x) => { t = x; } };
}
const fullEngine = () => ({
  statsCalls: 0,
  statsText(id) { this.statsCalls++; return `stats for ${id} #${this.statsCalls}`; },
  packetIndex: (id) => Promise.resolve([
    { t: 0, key: true }, { t: 0.04 }, { t: 2, key: true }, { t: 2.04 }, { t: 4, key: true }, { t: 8, key: true },
  ].map((p) => ({ ...p, id }))),
  chapters: () => [{ start: 0, title: 'Intro' }, { start: 3, title: 'Middle' }, { start: 10, title: '' }],
  pixelAt: (id, x, y) => ({ text: `${id} ${x},${y} rgb(1, 2, 3)` }),
});

// ---- 2b. the pixel inspector widget (#pxread, loupe, #pxgrid) ----

/** A 320×180 picture shown at `scale` CSS px per pixel from (40, 20) in a 680×370 stage at (0, 0). */
function pixelSetup({ scale = 1, read = null, gridAllowed = () => true } = {}) {
  const dom = createDom('<div id="stage"><canvas id="cv"></canvas></div>');
  dom.setRect(dom.$('stage'), { width: 680, height: 370 });
  const reads = [];
  const target = { rect: { left: 40, top: 20, width: 320 * scale, height: 180 * scale }, width: 320, height: 180 };
  const px = T.createPixelInspector({
    doc: dom.doc, win: {}, stageEl: dom.$('stage'), getTarget: () => target,
    read: read || ((x, y) => { reads.push([x, y]); return { rgb: [1, 2, 255], yuv: { y: 30, u: 240, v: 110, depth: 8 } }; }),
    gridAllowed,
  });
  const move = (x, y) => dom.$('stage').fire('pointermove', { clientX: x, clientY: y, pointerType: 'mouse' });
  return { ...dom, px, reads, target, move };
}

test('pixel inspector: off until X; the read-out names the pixel under the pointer with RGB and YUV', () => {
  const { $, px, reads, move } = pixelSetup({ scale: 2 });
  assert.ok($('pxread') && $('pxgrid'), '#pxread and #pxgrid are made in the stage');
  assert.strictEqual($('pxread').hidden, true);
  move(40 + 21, 20 + 11);
  assert.deepStrictEqual(reads, [], 'nothing is read while the inspector is off');
  px.setMode('loupe');
  assert.deepStrictEqual(reads, [[10, 5]], 'turning it on reads under the pointer at once (2 px per pixel)');
  assert.strictEqual($('pxread').hidden, false);
  const text = px.getState().text;
  assert.match(text, /^x 10 {2}y 5\nRGB 1 2 255 {2}#0102FF\nYUV 30 240 110 {2}8-bit$/);
  // The layer-3 scenario's pattern (test/vscode/cases/inspect.js).
  assert.match(text, /x (\d+)\s+y (\d+)[\s\S]*?RGB (\d+) (\d+) (\d+)[\s\S]*?YUV (\d+) (\d+) (\d+)/);
  assert.strictEqual($('stage').classList.contains('inspecting'), true);
  move(40 + 640 - 1, 20 + 360 - 1);
  assert.deepStrictEqual(reads.pop(), [319, 179], 'the last pixel');
  move(39, 30);
  assert.strictEqual($('pxread').hidden, true, 'outside the picture: no read-out');
  move(100, 100);
  $('stage').fire('pointerleave', {});
  assert.strictEqual($('pxread').hidden, true, 'the pointer left the stage');
  move(100, 100);
  px.setMode(null);
  assert.strictEqual($('pxread').hidden, true);
  assert.strictEqual($('stage').classList.contains('inspecting'), false);
  const n = reads.length;
  move(110, 110);
  assert.strictEqual(reads.length, n, 'off: no reads');
});

test('pixel inspector: a block gives the centre pixel; WebCodecs YUV arrives later; no pixel hides', async () => {
  const block = new Uint8ClampedArray(T.LOUPE_PX * T.LOUPE_PX * 4);
  const c = ((T.LOUPE_PX >> 1) * T.LOUPE_PX + (T.LOUPE_PX >> 1)) * 4;
  block.set([200, 100, 50, 255], c);
  let yuv = null;
  let answer = () => ({ block, rot: 90, yuv });
  const { $, px, move } = pixelSetup({ read: () => answer() });
  px.setMode('readout');
  yuv = Promise.resolve({ y: 1, u: 2, v: 3, depth: 10 });
  move(40 + 5, 20 + 6);
  assert.match(px.getState().text, /^x 5 {2}y 6 {2}\(turned 90°\)\nRGB 200 100 50 {2}#C86432$/);
  await tick();
  assert.match(px.getState().text, /\nYUV 1 2 3 {2}10-bit$/, 'the copyTo answer is appended');
  assert.strictEqual($('pxread').querySelector('canvas').hidden, true, 'readout mode: no loupe');
  answer = () => null;
  move(40 + 7, 20 + 6);
  assert.strictEqual($('pxread').hidden, true, 'nothing to read: no read-out');
  answer = () => { throw new Error('lost context'); };
  move(40 + 8, 20 + 6);
  assert.strictEqual($('pxread').hidden, true, 'a failing read is no read-out');
});

test('pixel inspector: the pixel grid from 800 % over the visible picture, not in Compare; dispose removes it', () => {
  let allowed = true;
  const { $, px, target } = pixelSetup({ scale: 4, gridAllowed: () => allowed });
  px.refresh();
  assert.strictEqual($('pxgrid').hidden, true, '400 %: no grid');
  target.rect = { left: -300, top: -100, width: 320 * 8, height: 180 * 8 };
  px.refresh();
  assert.strictEqual($('pxgrid').hidden, false, '800 %: the grid');
  const s = $('pxgrid').style;
  assert.deepStrictEqual([s.left, s.top, s.width, s.height], ['0px', '0px', '680px', '370px'], 'clipped to the stage');
  assert.strictEqual(s.backgroundSize, '8px 8px');
  assert.strictEqual(s.backgroundPosition, '-300px -100px');
  allowed = false;
  px.refresh();
  assert.strictEqual($('pxgrid').hidden, true, 'Compare: no grid');
  px.dispose();
  assert.strictEqual($('pxgrid'), null);
  assert.strictEqual($('pxread'), null);
});

test('inspection: W cycles the four scopes, then off', () => {
  const { doc, c, log } = inspectSetup(fullEngine());
  for (let i = 0; i < 5; i++) doc.body.fire('keydown', { key: 'w' });
  assert.deepStrictEqual(log.scopes, ['waveform', 'parade', 'vector', 'histogram', null]);
  assert.deepStrictEqual(log.toasts, ['Luma waveform', 'RGB parade', 'Vectorscope', 'Histogram', 'Scopes off']);
  assert.deepStrictEqual(log.before, ['scopes', 'scopes', 'scopes', 'scopes', 'scopes']);
  assert.strictEqual(c.getState().scopes, null);
  const e = doc.body.fire('keydown', { key: 'W', shiftKey: true });
  assert.strictEqual(e.defaultPrevented, false, 'Shift+W is not a scope key');
});

test('inspection: X cycles loupe, readout, off; a click copies the pixel; X is not the inspector in compare', () => {
  const { doc, c, log } = inspectSetup(fullEngine());
  assert.strictEqual(c.pickAt(1, 2), false, 'off: the click is not taken');
  doc.body.fire('keydown', { key: 'x' });
  assert.strictEqual(c.getState().inspector, 'loupe');
  assert.strictEqual(c.pickAt(10, 20), true);
  assert.deepStrictEqual(log.posts, [{ type: 'copyText', text: 'clipA 10,20 rgb(1, 2, 3)' }]);
  doc.body.fire('keydown', { key: 'X' });
  assert.strictEqual(c.getState().inspector, 'readout');
  doc.body.fire('keydown', { key: 'x' });
  assert.deepStrictEqual(log.insp, ['loupe', 'readout', null]);
  assert.deepStrictEqual(log.toasts, ['Pixel inspector: click copies the value (X again: no loupe)', 'Pixel value copied',
    'Pixel inspector without loupe', 'Pixel inspector off']);
  const compare = inspectSetup(fullEngine(), { isSingle: () => false });
  const e = compare.doc.body.fire('keydown', { key: 'x' });
  assert.strictEqual(e.defaultPrevented, false);
  assert.strictEqual(compare.c.getState().inspector, null);
});

test('inspection: Shift+I stats refresh every 250 ms and stop on toggle and dispose', () => {
  const engine = fullEngine();
  const { doc, $, c, timers } = inspectSetup(engine);
  doc.body.fire('keydown', { key: 'I', shiftKey: true });
  assert.strictEqual($('stats').hidden, false);
  assert.strictEqual($('stats').textContent, 'stats for clipA #1', 'drawn at once');
  const live = timers.filter(Boolean);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].ms, T.STATS_MS);
  live[0].fn();
  assert.strictEqual($('stats').textContent, 'stats for clipA #2');
  doc.body.fire('keydown', { key: 'I', shiftKey: true });
  assert.strictEqual($('stats').hidden, true);
  assert.strictEqual(timers.filter(Boolean).length, 0, 'timer cleared');
  c.toggleStats(true);
  assert.strictEqual(timers.filter(Boolean).length, 1);
  engine.statsText = () => { throw new Error('gone'); };
  c.refresh();
  assert.strictEqual($('stats').textContent, 'stats: gone');
  c.dispose();
  assert.strictEqual(timers.filter(Boolean).length, 0, 'dispose clears the timer');
  const after = doc.body.fire('keydown', { key: 'w' });
  assert.strictEqual(after.defaultPrevented, false, 'dispose removes the key listener');
});

test('inspection: Shift+X X-ray, { } keyframes, PageUp / PageDown chapters', async () => {
  const { doc, c, log, setT } = inspectSetup(fullEngine());
  doc.body.fire('keydown', { key: 'X', shiftKey: true });
  await tick();
  assert.strictEqual(c.getState().xray, true);
  assert.deepStrictEqual(log.xray, [['show', 6]]);
  assert.strictEqual(c.getState().inspector, null, 'Shift+X is not the inspector');
  setT(2.5);
  await c.stepKey(1);
  assert.deepStrictEqual(log.seeks, [4]);
  doc.body.fire('keydown', { key: '{' });
  await tick(); await tick();
  assert.deepStrictEqual(log.seeks, [4, 2]);
  setT(8);
  await c.stepKey(1);
  assert.strictEqual(log.toasts.at(-1), 'No later keyframe');
  setT(0);
  await c.stepKey(-1);
  assert.strictEqual(log.toasts.at(-1), 'No earlier keyframe');
  // Chapters: forward from 0.5 → Middle; back from 3.5 (near its start) → Intro; back from 0.5 → Start.
  setT(0.5);
  doc.body.fire('keydown', { key: 'PageDown' });
  assert.strictEqual(log.seeks.at(-1), 3);
  assert.strictEqual(log.toasts.at(-1), 'Chapter 2: Middle');
  setT(3.5);
  doc.body.fire('keydown', { key: 'PageUp' });
  assert.strictEqual(log.seeks.at(-1), 0);
  assert.strictEqual(log.toasts.at(-1), 'Chapter 1: Intro');
  setT(5);
  c.stepChapter(1);
  assert.strictEqual(log.toasts.at(-1), 'Chapter 3');
  c.stepChapter(1);
  assert.strictEqual(log.toasts.at(-1), 'Last chapter');
  setT(0.5);
  c.stepChapter(-1);
  assert.strictEqual(log.toasts.at(-1), 'Start');
  doc.body.fire('keydown', { key: 'X', shiftKey: true });
  assert.deepStrictEqual(log.xray.at(-1), ['hide']);
  assert.strictEqual(log.toasts.at(-1), 'Codec X-ray off');
  // Ctrl / Meta / typing are not tool keys.
  assert.strictEqual(doc.body.fire('keydown', { key: '}', ctrlKey: true }).defaultPrevented, false);
  const input = doc.createElement('input');
  doc.body.appendChild(input);
  assert.strictEqual(input.fire('keydown', { key: 'w' }).defaultPrevented, false);
  // AltGr types { } on many layouts: still the keyframe key.
  const altGr = doc.body.fire('keydown', { key: '}', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' });
  assert.strictEqual(altGr.defaultPrevented, true);
});

test('inspection: Esc closes inspector, then scopes, then X-ray', async () => {
  const { doc, c } = inspectSetup(fullEngine());
  c.cycleScopes();
  c.cycleInspector();
  await c.toggleXray(true);
  c.toggleStats(true);
  assert.strictEqual(c.handleEscape(), true);
  assert.deepStrictEqual(c.getState(), { scopes: 'waveform', inspector: null, stats: true, xray: true });
  const e = doc.body.fire('keydown', { key: 'Escape' });
  assert.strictEqual(e.defaultPrevented, true);
  assert.deepStrictEqual(c.getState(), { scopes: null, inspector: null, stats: true, xray: true });
  assert.strictEqual(c.handleEscape(), true);
  assert.deepStrictEqual(c.getState(), { scopes: null, inspector: null, stats: true, xray: false });
  assert.strictEqual(c.handleEscape(), false, 'stats are not closed by Esc');
  assert.strictEqual(c.isAnyOpen(), true);
  c.toggleStats(false);
  assert.strictEqual(c.isAnyOpen(), false);
  c.dispose();
});

test('inspection: an engine without the optional hooks says so and never throws', async () => {
  const { doc, $, c, log, timers } = inspectSetup({}, { widgets: {} });
  doc.body.fire('keydown', { key: 'I', shiftKey: true });
  assert.strictEqual(c.getState().stats, false);
  assert.strictEqual(timers.filter(Boolean).length, 0);
  doc.body.fire('keydown', { key: 'X', shiftKey: true });
  assert.strictEqual(c.getState().xray, false);
  await c.stepKey(1);
  c.stepChapter(-1);
  c.cycleScopes(); // no scopes widget: the state still cycles
  c.cycleInspector();
  c.pickAt(1, 1);
  assert.deepStrictEqual(log.toasts, [
    'Stats are not available for this video',
    'Codec X-ray needs the built-in decoder engine (not used for this file)',
    'Keyframe steps need the built-in decoder engine',
    'No chapters in this file',
    'Luma waveform',
    'Pixel inspector: click copies the value (X again: no loupe)',
    'Pixel values are not available for this video',
  ]);
  assert.strictEqual($('stats').hidden, true, 'the given element is untouched');
  assert.ok(doc.querySelector('pre.stats'), 'a stats element exists');
  // A packet index that fails: no keyframe index; null engine: no crash.
  const bad = inspectSetup({ packetIndex: () => Promise.reject(new Error('x')), chapters: () => { throw new Error('y'); } });
  await bad.c.stepKey(1);
  bad.c.stepChapter(1);
  assert.deepStrictEqual(bad.log.toasts, ['No keyframe index for this file', 'No chapters in this file']);
  const none = inspectSetup(null);
  none.c.toggleStats(true);
  await none.c.toggleXray(true);
  assert.strictEqual(none.c.isAnyOpen(), false);
});

test('inspection: refresh with a new clip reads the packet index again', async () => {
  let calls = 0;
  const engine = { packetIndex: () => { calls++; return [{ t: 1, key: true }]; } };
  const { c, log } = inspectSetup(engine);
  await c.toggleXray(true);
  await c.stepKey(1);
  assert.strictEqual(calls, 1, 'cached');
  c.refresh({ clipChanged: true });
  await tick();
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(log.xray, [['show', 1], ['show', 1]]);
});

test('inspection: a late packet index for the previous clip neither replaces nor seeks the new one', async () => {
  /** One deferred packetIndex answer per call, resolved by the test in any order. */
  const pending = [];
  const engine = { packetIndex: (id) => new Promise((resolve, reject) => pending.push({ id, resolve, reject })) };
  let active = 'clipA';
  const { c, log } = inspectSetup(engine, { getActiveClip: () => active });
  const stepA = c.stepKey(1); // t = 5: asks clip A for its index
  await tick();
  active = 'clipB';
  c.refresh({ clipChanged: true });
  const stepB = c.stepKey(1);
  await tick();
  assert.deepStrictEqual(pending.map((p) => p.id), ['clipA', 'clipB'], 'each clip asks for its own index');
  // B answers first, then A, late.
  pending[1].resolve([{ t: 7, key: true }]);
  await stepB;
  assert.deepStrictEqual(log.seeks, [7], 'B steps to its next keyframe');
  pending[0].resolve([{ t: 6, key: true }, { t: 9, key: true }]);
  await stepA;
  assert.deepStrictEqual(log.seeks, [7], 'A\'s late answer does not seek B');
  assert.deepStrictEqual(log.toasts.filter((x) => /keyframe/i.test(x)), [], 'nor toasts about it');
  // B's index stays cached: the next step uses it without asking again.
  await c.stepKey(-1);
  assert.deepStrictEqual([pending.length, log.seeks], [2, [7]], 'B\'s index is kept (no earlier keyframe than 7: no seek)');
  assert.ok(log.toasts.includes('No earlier keyframe'));

  // A late failure after a clip change is dropped too; a request still out when the page goes answers nobody.
  active = 'clipC';
  c.refresh({ clipChanged: true });
  const stepC = c.stepKey(1);
  await tick();
  c.dispose();
  pending[2].resolve([{ t: 8, key: true }]);
  await stepC;
  assert.deepStrictEqual(log.seeks, [7], 'disposed: no seek');

  // Compare can switch the active tile without a refresh: the cached index of another clip is not used.
  const pend2 = [];
  const eng2 = { packetIndex: (id) => new Promise((resolve) => pend2.push({ id, resolve })) };
  let act2 = 'clipA';
  const s2 = inspectSetup(eng2, { getActiveClip: () => act2 });
  const a1 = s2.c.stepKey(1);
  await tick();
  pend2[0].resolve([{ t: 6, key: true }]);
  await a1;
  act2 = 'clipB';
  const b1 = s2.c.stepKey(1);
  await tick();
  assert.deepStrictEqual(pend2.map((p) => p.id), ['clipA', 'clipB'], 'another tile: its own index');
  pend2[1].resolve([{ t: 9, key: true }]);
  await b1;
  assert.deepStrictEqual(s2.log.seeks, [6, 9]);
  // A request that went stale by a tile switch (same generation) lets go: back on that tile, it asks again.
  act2 = 'clipC';
  const c1 = s2.c.stepKey(1);
  await tick();
  act2 = 'clipB';
  pend2[2].resolve([{ t: 30, key: true }]);
  assert.strictEqual(await c1, undefined);
  act2 = 'clipC';
  const c2 = s2.c.stepKey(1);
  await tick();
  assert.strictEqual(pend2.length, 4, 'clip C asks again');
  pend2[3].resolve([{ t: 30, key: true }]);
  await c2;
  assert.deepStrictEqual(s2.log.seeks.slice(-1), [30]);
  s2.c.dispose();
});

// ---- 3. subtitles ----

function subsSetup(opts = {}) {
  const dom = createDom(NOTICE_HTML);
  const log = { toasts: [], updates: [], pages: [], selected: [] };
  let t = 10;
  const cues = [{ a: 9, b: 11, text: 'Hello\nthere' }, { a: 11, b: 12, text: 'Later' }];
  const engine = {
    cueAt: (id, at, track) => (track === 1 ? 'Second track' : cues.find((c) => at >= c.a && at < c.b) || null),
    selectSubtitle: (id, track) => log.selected.push([id, track]),
  };
  const s = T.createSubtitleController({
    doc: dom.doc, win: dom.win, subsEl: dom.$('subs'), engine,
    getClipId: () => 'clipA', getTime: () => t,
    getPictureRect: () => ({ x: 100, y: 50, w: 800, h: 450 }),
    onToast: (x) => log.toasts.push(x), onUpdate: (st) => log.updates.push(st), onOpenPage: (p) => log.pages.push(p),
    ...opts,
  });
  return { ...dom, s, log, engine, setT: (x) => { t = x; } };
}

test('subtitles: no tracks: CC hidden, CC click opens the Subtitles page, keys toast', () => {
  const { s, log } = subsSetup();
  assert.deepStrictEqual(s.getCcButtonState(), { visible: false, on: false, label: 'Subtitles', title: 'Subtitles  C' });
  assert.strictEqual(s.ccClick(), 'page');
  assert.deepStrictEqual(log.pages, ['subs']);
  s.nextTrack();
  s.toggle();
  assert.deepStrictEqual(log.toasts, ['No subtitles · Load a file in Settings › Subtitles', 'No subtitles · Load a file in Settings › Subtitles']);
});

test('subtitles: host subs reply auto-selects; C, V, Shift+V; CC state', () => {
  const { $, s, log } = subsSetup();
  assert.strictEqual(s.onHostMessage({ type: 'other' }), false);
  assert.strictEqual(s.onHostMessage({ type: 'subs', tracks: [{ name: 'English' }, { lang: 'de' }] }), true);
  assert.deepStrictEqual(log.toasts, ['Subtitles: English']);
  assert.deepStrictEqual(s.getCcButtonState(), { visible: true, on: true, label: 'Subtitles on: English', title: 'Subtitles on: English  C' });
  assert.deepStrictEqual(log.selected.at(-1), ['clipA', 0]);
  assert.strictEqual($('subs').hidden, false);
  assert.strictEqual(s.handleKey({ key: 'C' }), true);
  assert.deepStrictEqual(s.getCcButtonState(), { visible: true, on: false, label: 'Subtitles off', title: 'Subtitles off  C' });
  assert.strictEqual($('subs').hidden, true);
  assert.strictEqual(s.handleKey({ key: 'C', shiftKey: true }), false, 'Shift+C is Copy link');
  s.handleKey({ key: 'V', shiftKey: true });
  assert.strictEqual(s.getState().track, 0, 'Shift+V back to the last track');
  s.handleKey({ key: 'v' });
  assert.strictEqual(s.getState().label, 'de');
  s.handleKey({ key: 'V' });
  assert.strictEqual(s.getState().track, -1, 'V without Shift cycles to off');
  assert.deepStrictEqual(log.toasts.slice(1), ['Subtitles off', 'Subtitles: English', 'Subtitles: de', 'Subtitles off']);
  assert.strictEqual(s.ccClick(), 'toggled');
  assert.strictEqual(s.getState().track, 1, 'toggle returns to the last track on');
  assert.ok(log.updates.length >= 6);
  // The user turned them off: more tracks arriving do not turn them on; select: true does.
  s.toggle();
  s.onHostMessage({ type: 'subs', tracks: [{ name: 'Sidecar' }] });
  assert.strictEqual(s.getState().track, -1);
  s.onHostMessage({ type: 'subs', tracks: [{ name: 'Loaded' }], select: true });
  assert.strictEqual(s.getState().label, 'Loaded');
  assert.strictEqual(log.toasts.at(-1), 'Subtitles: Loaded');
});

test('subtitles: G / H delay, size, resets; the cue follows the delay', () => {
  const { $, s, log, setT } = subsSetup();
  s.onHostMessage({ type: 'subs', tracks: [{ name: 'English' }] });
  assert.strictEqual($('subs').textContent, 'Hello\nthere');
  s.handleKey({ key: 'g' });
  s.handleKey({ key: 'G' });
  assert.strictEqual(s.getState().delayMs, -100);
  s.handleKey({ key: 'h' });
  assert.deepStrictEqual(log.toasts.slice(-3), ['Subtitle delay -50 ms', 'Subtitle delay -100 ms', 'Subtitle delay -50 ms']);
  s.adjustDelay(1050);
  assert.strictEqual(log.toasts.at(-1), 'Subtitle delay +1000 ms');
  // t 10, delay +1 s: the cue at 9 s.
  setT(12);
  s.render();
  assert.strictEqual($('subs').textContent, 'Later', 'cue at 11 s');
  s.resetDelay();
  assert.strictEqual(s.getState().delayMs, 0);
  assert.strictEqual($('subs').hidden, true, 'no cue at 12 s');
  s.adjustSize(10);
  assert.strictEqual(log.toasts.at(-1), 'Subtitle size 110%');
  s.adjustSize(500);
  assert.strictEqual(s.getState().sizePct, 250, 'clamped');
  s.adjustSize(-1000);
  assert.strictEqual(s.getState().sizePct, 50);
  s.resetSize();
  assert.strictEqual(s.getState().sizePct, 100);
  assert.strictEqual(s.handleKey({ key: 'g', ctrlKey: true }), false);
  assert.strictEqual(s.handleKey({ key: 'q' }), false);
});

test('subtitles: the cue is placed inside the picture rectangle and scales with size', () => {
  const { $, s } = subsSetup();
  s.onHostMessage({ type: 'subs', tracks: [{ name: 'English' }] });
  const st = $('subs').style;
  const px = (v) => Number(String(v).replace('px', ''));
  assert.strictEqual(px(st.left), 100);
  assert.strictEqual(px(st.width), 800);
  assert.ok(px(st.top) > 50 && px(st.top) <= 50 + 450, `top ${st.top} inside the picture`);
  assert.strictEqual(px(st.fontSize), 22.5, '5% of the picture height');
  s.adjustSize(100);
  assert.strictEqual(px(st.fontSize), 45);
  // No picture yet, or no cueAt: hidden, no throw.
  const none = subsSetup({ getPictureRect: () => null });
  none.s.onHostMessage({ type: 'subs', tracks: [{ name: 'x' }] });
  assert.strictEqual(none.$('subs').hidden, true);
  const dom = createDom('<div id="subs"></div>');
  const bare = T.createSubtitleController({ doc: dom.doc, subsEl: dom.$('subs'), engine: {} });
  bare.onHostMessage({ type: 'subs', tracks: [{}] });
  assert.strictEqual(bare.getState().label, 'Track 1');
  assert.strictEqual(dom.$('subs').hidden, true);
  bare.dispose();
});

// ---- 4. frame export ----

function exportSetup(opts = {}) {
  const dom = createDom('<div id="stage"></div>');
  const log = { posts: [], toasts: [], pauses: 0, before: [], written: [], refused: [] };
  const ctx = { clipId: 'clipA', frame: 41, t: 1.64, fps: 25, page: 'p1' };
  const png = new Uint8Array([137, 80, 78, 71]);
  const engine = {
    snapshot: async () => new Blob([png], { type: 'image/png' }),
    showFrame: async (_id, k) => { ctx.frame = k; return k; },
  };
  class ClipboardItem { constructor(items) { this.items = items; } }
  dom.win.ClipboardItem = ClipboardItem;
  dom.win.navigator = { clipboard: { write: async (items) => { log.written.push(items); } } };
  const range = { exportRange: { a: 1, b: 5 }, clipRange: { a: 0.1, b: 2 }, ffmpegRange: null };
  const x = T.createFrameExportController({
    win: dom.win, engine, host: { postMessage: (m) => log.posts.push(m) },
    getContext: () => ({ ...ctx }),
    onToast: (s) => log.toasts.push(s), onPause: () => { log.pauses++; }, onBeforeSnapshot: (w) => log.before.push(w),
    getRange: (k) => range[k], onRefuse: (r) => log.refused.push(r),
    ...opts,
  });
  return { ...dom, x, log, ctx, engine, png, range };
}

test('export: saveFrame pauses and posts the frame taken before the await', async () => {
  const { x, log, ctx, engine, png } = exportSetup();
  engine.snapshot = async () => { const b = new Blob([png]); ctx.frame = 41; return b; };
  assert.strictEqual(await x.saveFrame(), true);
  assert.strictEqual(log.pauses, 1);
  assert.deepStrictEqual(log.before, ['save']);
  assert.strictEqual(log.posts.length, 1);
  const m = log.posts[0];
  assert.strictEqual(m.type, 'saveFrame');
  assert.strictEqual(m.frame, 41);
  assert.strictEqual(m.page, 'p1');
  assert.deepStrictEqual([...m.data], [...png]);
  // The frame changed while the snapshot was taken: cancelled.
  engine.snapshot = async () => { ctx.frame = 42; return png; };
  assert.strictEqual(await x.saveFrame(), false);
  assert.strictEqual(log.toasts.at(-1), 'Save cancelled: the frame changed');
  // No picture, no snapshot hook.
  engine.snapshot = async () => null;
  assert.strictEqual(await x.saveFrame(), false);
  delete engine.snapshot;
  assert.strictEqual(await x.saveFrame(), false);
  assert.strictEqual(log.toasts.at(-1), 'Frames cannot be saved from this video');
  assert.strictEqual(log.posts.length, 1);
});

test('export: copyFrame writes a PNG ClipboardItem; View / transcoded wording', async () => {
  const s = exportSetup();
  assert.strictEqual(await s.x.copyFrame(), true);
  assert.strictEqual(s.log.written.length, 1);
  const item = s.log.written[0][0];
  assert.ok(item.items['image/png'] instanceof Blob);
  assert.strictEqual(s.log.toasts.at(-1), 'Frame copied');
  assert.strictEqual(s.log.posts.length, 0, 'nothing for the host');
  const v = exportSetup({ getContext: () => ({ clipId: 0, frame: 1, t: 0, compare: true }) });
  await v.x.copyFrame();
  assert.strictEqual(v.log.toasts.at(-1), 'View copied');
  const tr = exportSetup({ getContext: () => ({ clipId: 0, frame: 1, t: 0, transcoded: true }) });
  tr.engine.snapshot = async () => tr.png; // raw bytes are wrapped in a Blob
  await tr.x.copyFrame();
  assert.strictEqual(tr.log.toasts.at(-1), 'Frame copied with transcoded pixels. For the original, see About.');
});

test('export: copyFrame falls back to saving when the clipboard refuses; cancels when the frame changes', async () => {
  const s = exportSetup();
  s.win.navigator.clipboard.write = async () => { throw new Error('NotAllowedError'); };
  assert.strictEqual(await s.x.copyFrame(), true);
  assert.deepStrictEqual(s.log.toasts, ['Copy not allowed here; saving instead']);
  assert.strictEqual(s.log.posts.length, 1);
  assert.strictEqual(s.log.posts[0].type, 'saveFrame');
  assert.strictEqual(s.log.pauses, 2);
  const noClip = exportSetup();
  delete noClip.win.navigator;
  await noClip.x.copyFrame();
  assert.strictEqual(noClip.log.posts[0].type, 'saveFrame', 'no clipboard API: saved');
  const moved = exportSetup();
  moved.engine.snapshot = async () => { moved.ctx.frame = 99; return moved.png; };
  assert.strictEqual(await moved.x.copyFrame(), false);
  assert.deepStrictEqual(moved.log.toasts, ['Copy cancelled: the frame changed']);
  assert.strictEqual(moved.log.written.length, 0);
  assert.strictEqual(moved.log.posts.length, 0);
});

test('export: copyTimestamp and copyLink', () => {
  const { x, log, ctx } = exportSetup();
  ctx.t = 75.5;
  x.copyTimestamp();
  assert.deepStrictEqual(log.posts.at(-1), { type: 'copyText', text: '1:15.500' });
  assert.strictEqual(log.toasts.at(-1), 'Timestamp copied');
  assert.strictEqual(T.fmtStamp(0.0004), '0:00.000');
  assert.strictEqual(T.fmtStamp(3723.0456), '1:02:03.046');
  x.copyLink();
  assert.deepStrictEqual(log.posts.at(-1), { type: 'copyLink', frame: 42, t: 1.66, page: 'p1' });
  const noFps = exportSetup({ getContext: () => ({ frame: 3, t: 0.123456 }) });
  noFps.x.copyLink();
  assert.deepStrictEqual(noFps.log.posts[0], { type: 'copyLink', frame: 4, t: 0.1235 });
  const none = exportSetup({ getContext: () => null });
  assert.strictEqual(none.x.copyTimestamp(), false);
  assert.strictEqual(none.x.copyLink(), false);
});

test('export: exportAb kinds, empty range, refused clip, abQuery', () => {
  const { x, log, range } = exportSetup();
  assert.strictEqual(x.exportAb('exportRange'), true);
  assert.deepStrictEqual(log.posts.at(-1), { type: 'exportRange', range: { a: 1, b: 5 }, page: 'p1' });
  assert.strictEqual(x.exportAb('ffmpegRange'), false);
  assert.strictEqual(log.toasts.at(-1), 'Set an A–B range first (A, B)');
  range.clipRange = { a: 0, b: 1, native: true };
  assert.strictEqual(x.exportAb('clipRange'), false);
  assert.deepStrictEqual(log.refused, [range.clipRange]);
  // The host asks: an empty range still goes back so the host can prompt.
  assert.strictEqual(x.onHostMessage({ type: 'abQuery', then: 'ffmpeg' }), true);
  assert.deepStrictEqual(log.posts.at(-1), { type: 'ffmpegRange', range: null, page: 'p1' });
  range.clipRange = { a: 0, b: 1 };
  x.onHostMessage({ type: 'abQuery', then: 'clip' });
  assert.strictEqual(log.posts.at(-1).type, 'clipRange');
  x.onHostMessage({ type: 'abQuery' });
  assert.strictEqual(log.posts.at(-1).type, 'exportRange');
  assert.strictEqual(x.onHostMessage({ type: 'exportEnd' }), true);
  assert.strictEqual(x.onHostMessage({ type: 'nope' }), false);
});

test('A-B marks: captureAbMark takes each tile\'s own picture time; compareClipRanges falls back to the offsets', () => {
  // The clock A (offset 0) holds its 0.96 s picture at the 1.00 s slot of a variable-rate file; B (+2 frames at 25 fps)
  // shows 1.08 s; C is still seeking (2 frames away).
  const mk = (shownRel, markRel, synthetic = false) => ({ shownRel, markRel, synthetic, fps: 25 });
  const cap = T.captureAbMark({
    clockId: 'A',
    tiles: [
      { clipId: 'A', offset: 0, fps: 25, mark: mk(1.0, 0.96) },
      { clipId: 'B', offset: 0.08, fps: 25, mark: mk(1.08, 1.08) },
      { clipId: 'C', offset: 0, fps: 25, mark: mk(1.08, 1.08) },
      { clipId: 'D', offset: 0, fps: 25, mark: null },
    ],
  });
  assert.strictEqual(cap.t, 1.0);
  assert.strictEqual(cap.pts, 0.96, 'the clock\'s own picture time is the mark');
  assert.strictEqual(cap.synthetic, false);
  assert.deepStrictEqual(cap.tiles, { A: { rel: 0.96, synthetic: false }, B: { rel: 1.08, synthetic: false }, C: null, D: null });
  assert.strictEqual(T.captureAbMark({ clockId: 'A', tiles: [{ clipId: 'A', offset: 0, fps: 25, mark: null }] }), null);
  // A clock offset moves the mark onto the shared timeline.
  const off = T.captureAbMark({ clockId: 'B', tiles: [{ clipId: 'B', offset: 0.5, fps: 25, mark: mk(2, 2, true) }] });
  assert.deepStrictEqual([off.t, off.pts, off.synthetic], [1.5, 1.5, true]);

  const ranges = T.compareClipRanges({
    a: 1.6, b: 2.76, clockId: 'A',
    tiles: [
      { clipId: 'A', offset: 0, fps: 25, atA: { rel: 1.6, synthetic: false }, atB: { rel: 2.76, synthetic: false } },
      { clipId: 'B', offset: 0.08, fps: 25 },
      { clipId: 'C', offset: 0, fps: 25, synthetic: true, atA: { rel: 1.6, synthetic: false }, atB: null },
    ],
  });
  assert.deepStrictEqual(ranges, [
    { clipId: 'A', range: { a: 1.6, b: 2.76, early: 0 } },
    { clipId: 'B', range: { a: 1.6 + 0.08, b: 2.76 + 0.08, early: 0.02 } },
    { clipId: 'C', range: { a: 1.6, b: 2.76, early: 0.02, native: true } },
  ]);
  const syn = T.compareClipRanges({ a: 0, b: 1, synthetic: true, clockId: 'A', tiles: [{ clipId: 'A', offset: 0, fps: 25 }] });
  assert.deepStrictEqual(syn, [{ clipId: 'A', range: { a: 0, b: 1, early: 0, native: true } }]);
});

test('export: Compare posts one clip range per tile (no page-side refusal: the host weighs every tile)', () => {
  const ranges = [{ clipId: 'clipB', range: { a: 0.08, b: 1.08, early: 0.02, native: true } }, { clipId: 'clipA', range: { a: 0, b: 1, early: 0 } }];
  let give = ranges;
  const { x, log, ctx } = exportSetup({ getClipRanges: () => give });
  assert.strictEqual(x.exportAb('clipRange'), true);
  const m = log.posts.at(-1);
  assert.strictEqual(m.type, 'clipRange');
  assert.deepStrictEqual(m.ranges, ranges);
  assert.deepStrictEqual(m.range, ranges.find((r) => r.clipId === ctx.clipId).range, 'range: the clock tile\'s');
  assert.deepStrictEqual(log.refused, [], 'one synthetic tile does not refuse the export');
  // One video (null): the single range as before.
  give = null;
  assert.strictEqual(x.exportAb('clipRange'), true);
  assert.deepStrictEqual(log.posts.at(-1), { type: 'clipRange', range: { a: 0.1, b: 2 }, page: 'p1' });
  assert.strictEqual(x.exportAb('exportRange'), true, 'the frame export never reads the clip ranges');
  assert.strictEqual(log.posts.at(-1).ranges, undefined);
});

test('export: exportGrab shows each frame in order and posts exportFrame; errors are posted', async () => {
  const { x, log, engine, png } = exportSetup();
  const order = [];
  engine.showFrame = async (_id, k) => { order.push(k); return k === 7 ? 8 : k; }; // VFR: lands on a neighbour
  x.onHostMessage({ type: 'exportGrab', page: 'p1', id: 'r1', frame: 3 });
  x.onHostMessage({ type: 'exportGrab', page: 'p1', id: 'r1', frame: 7 });
  x.onHostMessage({ type: 'exportGrab', page: 'other', id: 'r1', frame: 9 });
  await x.idle();
  assert.deepStrictEqual(order, [3, 7], 'another page: ignored');
  assert.deepStrictEqual(log.posts.map((m) => [m.type, m.id, m.frame, m.page]), [['exportFrame', 'r1', 3, 'p1'], ['exportFrame', 'r1', 8, 'p1']]);
  assert.deepStrictEqual([...log.posts[0].data], [...png]);
  assert.ok(log.pauses >= 2);
  assert.deepStrictEqual(log.before, ['export', 'export']);
  engine.showFrame = async () => null;
  x.exportGrab('r2', 4);
  await x.idle();
  assert.deepStrictEqual(log.posts.at(-1), { type: 'exportFrame', id: 'r2', frame: 4, error: 'frame 5 did not show', page: 'p1' });
  engine.showFrame = async (_id, k) => k;
  engine.snapshot = async () => null;
  x.exportGrab('r3', 1);
  await x.idle();
  assert.strictEqual(log.posts.at(-1).error, 'no picture');
  delete engine.showFrame;
  x.exportGrab('r4', 1);
  await x.idle();
  assert.strictEqual(log.posts.at(-1).error, 'cannot show frames');
});

test('export: a frame that never shows times out after 20 s; cancel and dispose abort quietly', async () => {
  const { x, log, engine, timers } = exportSetup();
  engine.showFrame = () => new Promise(() => {}); // never settles
  x.exportGrab('r1', 5);
  await tick();
  const timeout = timers.filter(Boolean).find((t) => t.ms === T.EXPORT_FRAME_TIMEOUT_MS);
  assert.ok(timeout, '20 s timer armed');
  timeout.fn();
  await x.idle();
  assert.deepStrictEqual(log.posts, [{ type: 'exportFrame', id: 'r1', frame: 5, error: 'frame 6 did not show', page: 'p1' }]);
  // Cancel while waiting: nothing is posted, and later grabs still work.
  let seen = null;
  engine.showFrame = (_id, _k, { signal }) => { seen = signal; return new Promise(() => {}); };
  x.exportGrab('r2', 6);
  await tick();
  x.cancelExport();
  await x.idle();
  assert.strictEqual(seen.aborted, true, 'the engine saw the abort');
  assert.strictEqual(log.posts.length, 1);
  engine.showFrame = async (_id, k) => k;
  x.exportGrab('r3', 2);
  await x.idle();
  assert.strictEqual(log.posts.at(-1).id, 'r3');
  // Dispose mid-wait: aborted, nothing posted, further messages ignored.
  engine.showFrame = () => new Promise(() => {});
  x.exportGrab('r4', 3);
  await tick();
  x.dispose();
  await x.idle();
  assert.strictEqual(log.posts.length, 2);
  assert.strictEqual(x.onHostMessage({ type: 'exportGrab', id: 'r5', frame: 1 }), false);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); count++; } catch (e) { e.message = `${name}: ${e.message}`; console.error(e); process.exit(1); }
  }
  console.log(`player_ui_tools_test: ${count} tests ok (${Date.now() - T0} ms)`);
})();
