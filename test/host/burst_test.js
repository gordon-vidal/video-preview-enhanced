'use strict';
// Open together (src/burst.js, docs/notes/compare-ui.md "Open together"): videos VS Code opens in one burst
// (an Explorer multi-selection) become one compare. First the rules with fake timers, then the host with a fake
// VS Code: a burst becomes compare in the first player's place and the other tabs close; one video, or videos
// a moment apart, are untouched; the maximum follows compare.maxVideos; the setting turns it off.
const assert = require('assert');
const path = require('path');
const { createBurst } = require('../../src/burst');

// ---- the rules ----
{
  let now = 0;
  let timers = [];
  const setTimer = (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; };
  const clearTimer = (t) => { timers = timers.filter((x) => x !== t); };
  const advance = (ms) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) { timers = timers.filter((x) => x !== t); t.fn(); }
  };
  const bursts = [];
  let max = 4;
  const b = createBurst({ windowMs: 400, max: () => max, onBurst: (x) => bursts.push(x), setTimer, clearTimer });
  const add = (n, o) => b.add(`file:///v/${n}.mp4`, { n }, o);

  add('a'); advance(1000);
  assert.strictEqual(bursts.length, 0, 'one video alone: nothing');
  add('a'); advance(1000); add('b'); advance(1000);
  assert.strictEqual(bursts.length, 0, 'two videos a second apart: two separate opens');
  add('a'); advance(100); add('b'); advance(399);
  assert.strictEqual(bursts.length, 0, 'the window is not over yet');
  advance(1);
  assert.strictEqual(bursts.length, 1, 'two videos 100 ms apart: one burst');
  assert.deepStrictEqual(bursts[0].items.map((i) => i.uri.n), ['a', 'b']);
  // A longer burst keeps going while each open is within the window of the one before.
  add('a'); advance(300); add('b'); advance(300); add('c'); advance(300); add('d'); advance(400);
  assert.deepStrictEqual(bursts[1].items.map((i) => i.uri.n), ['a', 'b', 'c', 'd'], 'a chain of opens');
  // The same file reported twice (the editor and its tab) is one entry; panels and tabs are kept.
  const p1 = { id: 'p' }; const t1 = { id: 't' };
  add('a', { panel: p1 }); add('a', { tab: t1 }); add('b'); advance(400);
  assert.strictEqual(bursts[2].items.length, 2);
  assert.deepStrictEqual([bursts[2].items[0].panels, bursts[2].items[0].tabs], [[p1], [t1]]);
  // The same file twice alone is not a burst.
  add('a'); add('a'); advance(400);
  assert.strictEqual(bursts.length, 3, 'one file twice is not two videos');
  // The maximum (compare.maxVideos): the rest stay separate.
  max = 3;
  for (const n of ['a', 'b', 'c', 'd', 'e']) add(n);
  advance(400);
  assert.deepStrictEqual([bursts[3].items.length, bursts[3].extra.map((i) => i.uri.n)], [3, ['d', 'e']]);
  add('a'); add('b'); b.cancel(); advance(400);
  assert.strictEqual(bursts.length, 4, 'cancel');
}

// ---- the host ----
process.env.VPE_BURST_MS = '60';
const { load } = require('./mock_vscode');
const { make } = require('../media/make_cases_media');
(async () => {
  const a = make('s_h264.mp4');
  const b = make('rotated.mp4');
  assert.ok(a && b, 'ffmpeg test clips');
  const panels = [];
  const fakePanel = () => {
    const p = {
      active: true, visible: true, viewColumn: 1, title: '', disposed: false, fns: [], posted: [],
      webview: { cspSource: 'x:', html: '', asWebviewUri: (u) => u, postMessage(m) { p.posted.push(m); }, onDidReceiveMessage(fn) { p.msg = fn; } },
      onDidDispose(fn) { p.fns.push(fn); }, onDidChangeViewState() {},
      dispose() { p.disposed = true; for (const fn of p.fns) fn(); },
    };
    panels.push(p);
    return p;
  };
  let tabListener = null;
  const closedTabs = [];
  const tabGroups = { onDidChangeTabs: (fn) => { tabListener = fn; return { dispose() {} }; }, close: async (t) => { closedTabs.push(t); }, all: [] };
  const settings = { 'videoPreviewEnhanced.decoder': 'builtin' };
  const h2 = load({ settings, setup: (v) => { v.window.createWebviewPanel = fakePanel; v.window.tabGroups = tabGroups; } });
  const W = h2.vscode;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const resolve = (file) => {
    const p = { webview: { html: '', options: null, onDidReceiveMessage() {}, postMessage: async () => true, cspSource: 'x:', asWebviewUri: (u) => u }, fns: [], onDidDispose(fn) { p.fns.push(fn); }, onDidChangeViewState() {}, viewColumn: 1, dispose() { p.disposed = true; for (const fn of p.fns) fn(); } };
    W._providers['videoPreviewEnhanced.player'].resolveCustomEditor({ uri: W.Uri.file(file) }, p);
    return p;
  };
  try {
    // One video: a player of its own, no compare.
    const one = resolve(a);
    await sleep(250);
    assert.ok(!one.disposed && panels.length === 0, 'one video is untouched');
    // Two videos a moment apart (more than the window): two players.
    const x = resolve(b);
    await sleep(250);
    assert.ok(!one.disposed && !x.disposed && panels.length === 0, 'videos apart are untouched');
    // A burst of two: compare, and the burst's tabs close.
    const p1 = resolve(a); const p2 = resolve(b);
    const tab = { input: { uri: W.Uri.file(b), viewType: 'videoPreviewEnhanced.player' }, group: { viewColumn: 1 } };
    tabListener({ opened: [tab], closed: [], changed: [] });
    await sleep(300);
    assert.strictEqual(panels.length, 1, 'one compare opened');
    assert.ok(/"names":\["s_h264\.mp4","rotated\.mp4"\]/.test(panels[0].webview.html), 'both videos, in order');
    assert.ok(p1.disposed && p2.disposed, 'the burst players close');
    assert.strictEqual(closedTabs.length, 1, 'the tab of the burst closes');
    // The setting turns it off.
    settings['videoPreviewEnhanced.compare.openTogether'] = false; // read at each open
    const q1 = resolve(a); const q2 = resolve(b);
    await sleep(250);
    assert.ok(!q1.disposed && !q2.disposed && panels.length === 1, 'setting off: separate tabs');
  } finally { h2.dispose(); }
})().then(() => { console.log('burst: ok'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
