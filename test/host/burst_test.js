'use strict';
// Open together (src/burst.js, docs/notes/compare-ui.md "Open together"): videos VS Code opens in one burst
// (an Explorer multi-selection) become one compare. First the rules with fake timers, then the host with a fake
// VS Code: a burst becomes compare in the first player's place and the other tabs close; one video, or videos
// a moment apart, are untouched; the maximum follows compare.maxVideos; the setting turns it off.
const assert = require('assert');
const path = require('path');
const { BURST_WINDOW_MS, createBurst, leftoverTabs, togetherNotice } = require('../../src/burst');

// ---- leftover tabs: a preview tab still showing a compared video is a duplicate ----
{
  const T = (uri, viewType = 'videoPreviewEnhanced.player') => ({ input: { uri: { toString: () => uri }, viewType } });
  const a = T('file:///v/a.mp4'); const b = T('file:///v/b.mp4'); const z = T('file:///v/z.mp4');
  const txt = T('file:///v/a.mp4', 'default'); const other = T('file:///v/a.mp4');
  const groups = [{ viewColumn: 1, tabs: [a, z, txt, { input: {} }] }, { viewColumn: 2, tabs: [other, b] }];
  assert.deepStrictEqual(leftoverTabs(groups, ['file:///v/a.mp4', 'file:///v/b.mp4']), [a, other, b], 'players of compared videos');
  assert.deepStrictEqual(leftoverTabs(groups, ['file:///v/a.mp4', 'file:///v/b.mp4'], 1), [a], 'one editor group only');
  assert.deepStrictEqual(leftoverTabs(groups, ['file:///v/q.mp4']), [], 'others stay');
  assert.deepStrictEqual(leftoverTabs(undefined, ['x']), []);
  assert.ok(/3 videos together.*compare\.openTogether/.test(togetherNotice(3)), 'notice names the setting');
}

// ---- the rules ----
const rules = async () => {
  let now = 0;
  let timers = [];
  const setTimer = (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; };
  const clearTimer = (t) => { timers = timers.filter((x) => x !== t); };
  // A burst's end is async (compare opens, then the players are told): let the promises settle after each step.
  const settle = () => new Promise((r) => setImmediate(r));
  const advance = async (ms) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) { timers = timers.filter((x) => x !== t); t.fn(); }
    await settle();
  };
  const bursts = [];
  let max = 4;
  const b = createBurst({ windowMs: 400, max: () => max, onBurst: (x) => { bursts.push(x); }, setTimer, clearTimer });
  const add = (n, o) => b.add(`file:///v/${n}.mp4`, { n }, o);

  assert.strictEqual(BURST_WINDOW_MS, 120, 'the default window: opens VS Code makes for one gesture arrive within a few ms');
  add('a'); await advance(1000);
  assert.strictEqual(bursts.length, 0, 'one video alone: nothing');
  add('a'); await advance(1000); add('b'); await advance(1000);
  assert.strictEqual(bursts.length, 0, 'two videos a second apart: two separate opens');
  add('a'); await advance(100); add('b'); await advance(399);
  assert.strictEqual(bursts.length, 0, 'the window is not over yet');
  await advance(1);
  assert.strictEqual(bursts.length, 1, 'two videos 100 ms apart: one burst');
  assert.deepStrictEqual(bursts[0].items.map((i) => i.uri.n), ['a', 'b']);
  // A longer burst keeps going while each open is within the window of the one before.
  add('a'); await advance(300); add('b'); await advance(300); add('c'); await advance(300); add('d'); await advance(400);
  assert.deepStrictEqual(bursts[1].items.map((i) => i.uri.n), ['a', 'b', 'c', 'd'], 'a chain of opens');
  // The same file reported twice (the editor and its tab) is one entry; panels and tabs are kept. A repeat report
  // does not extend the window.
  const p1 = { id: 'p' }; const t1 = { id: 't' };
  add('a', { panel: p1 }); await advance(300); add('a', { tab: t1 }); add('b'); await advance(400);
  assert.strictEqual(bursts[2].items.length, 2);
  assert.deepStrictEqual([bursts[2].items[0].panels, bursts[2].items[0].tabs], [[p1], [t1]]);
  // The same file twice alone is not a burst.
  add('a'); add('a'); await advance(400);
  assert.strictEqual(bursts.length, 3, 'one file twice is not two videos');
  // The maximum (compare.maxVideos): the rest stay separate.
  max = 3;
  for (const n of ['a', 'b', 'c', 'd', 'e']) add(n);
  await advance(400);
  assert.deepStrictEqual([bursts[3].items.length, bursts[3].extra.map((i) => i.uri.n)], [3, ['d', 'e']]);
  add('a'); add('b'); b.cancel(); await advance(400);
  assert.strictEqual(bursts.length, 4, 'cancel');
};

// Holding players (wait): a video opened alone starts at once; with another pending it waits for the burst's verdict.
const holds = async () => {
  let now = 0;
  let timers = [];
  const setTimer = (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; };
  const clearTimer = (t) => { timers = timers.filter((x) => x !== t); };
  const settle = () => new Promise((r) => setImmediate(r));
  const advance = async (ms) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) { timers = timers.filter((x) => x !== t); t.fn(); }
    await settle();
  };
  let verdict = true;
  let finish = null;
  const opened = [];
  const b = createBurst({
    max: () => 2,
    onBurst: (x) => { opened.push(x.items.map((i) => i.uri.n)); return new Promise((r) => { finish = () => r(verdict); }); },
    setTimer, clearTimer,
  });
  const add = (n, o) => b.add(`file:///v/${n}.mp4`, { n }, o);
  const key = (n) => `file:///v/${n}.mp4`;
  const log = [];
  const hold = (n) => { const p = b.wait(key(n)); if (p) p.then((taken) => log.push([n, taken])); return !!p; };

  add('a');
  assert.strictEqual(hold('a'), false, 'alone: nothing to wait for');
  await advance(BURST_WINDOW_MS); // single: the timer ends it
  assert.deepStrictEqual(log, [], 'a single video is never held');
  add('a'); add('b'); add('c');
  assert.ok(hold('a') && hold('b') && hold('c'), 'with others pending: held');
  assert.strictEqual(hold('zz'), false, 'unknown video: not held');
  await advance(BURST_WINDOW_MS);
  assert.deepStrictEqual(opened, [['a', 'b']], 'the first two are taken (maximum 2)');
  assert.deepStrictEqual(log, [['c', false]], 'the one past the maximum starts as its own player at once');
  assert.ok(b.wait(key('a')), 'still held while compare opens');
  add('a', { tab: { id: 'late' } }); // its tab reported late: part of the same entry, no new burst
  assert.strictEqual(b.waiting, 0, 'a late report of a closing video starts no new burst');
  finish(); await settle();
  assert.deepStrictEqual(log.slice(1).map((x) => x.join()).sort(), ['a,true', 'b,true'], 'taken: the players never start');
  assert.strictEqual(b.wait(key('a')), false, 'after the burst nothing is held');
  // A burst that is not taken (compare could not open): the players start.
  log.length = 0; verdict = false;
  add('a'); add('b'); hold('a'); hold('b');
  await advance(BURST_WINDOW_MS); finish(); await settle();
  assert.deepStrictEqual(log.map((x) => x.join()).sort(), ['a,false', 'b,false']);
  // cancel releases what waits.
  log.length = 0;
  add('a'); add('b'); hold('a'); hold('b'); b.cancel(); await settle();
  assert.deepStrictEqual(log.map((x) => x.join()).sort(), ['a,false', 'b,false'], 'cancel: start as usual');
  // A failing compare releases them too.
  const bad = createBurst({ max: () => 4, onBurst: () => Promise.reject(new Error('x')), setTimer, clearTimer });
  bad.add(key('a'), { n: 'a' }); bad.add(key('b'), { n: 'b' });
  const w = bad.wait(key('a'));
  now += BURST_WINDOW_MS; for (const t of timers.splice(0)) await t.fn();
  assert.strictEqual(await w, false, 'rejected: not taken');
};

// ---- the host ----
process.env.VPE_BURST_MS = '60';
const { load } = require('./mock_vscode');
const { make } = require('../media/make_cases_media');
(async () => {
  await rules();
  await holds();
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
  const infos = [];
  const h2 = load({ settings, setup: (v) => { v.window.createWebviewPanel = fakePanel; v.window.tabGroups = tabGroups; v.window.showInformationMessage = async (m, ...b) => { infos.push([m, ...b]); return undefined; }; } });
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
    assert.strictEqual(infos.length, 1, 'first time: one notice');
    assert.ok(/2 videos together/.test(infos[0][0]) && infos[0].slice(1).join() === 'Got it,Open Settings', 'notice text and buttons');
    assert.strictEqual(h2.context.globalState.get('videoPreviewEnhanced.openTogetherNoticed'), true, 'noticed is remembered');
    // End Add Mode so subsequent opens exercise Open Together again.
    await W._commands['videoPreviewEnhanced.stopAddFromExplorer']();
    // A single click's preview tab of a compared video stays in the group: it closes with the compare.
    const prev = { input: { uri: W.Uri.file(a), viewType: 'videoPreviewEnhanced.player' }, group: { viewColumn: 1 } };
    const elsewhere = { input: { uri: W.Uri.file(a), viewType: 'videoPreviewEnhanced.player' }, group: { viewColumn: 2 } };
    tabGroups.all = [{ viewColumn: 1, tabs: [prev] }, { viewColumn: 2, tabs: [elsewhere] }];
    closedTabs.length = 0;
    resolve(a); resolve(b);
    await sleep(300);
    assert.deepStrictEqual(closedTabs, [prev], 'the leftover preview tab closes, other groups stay');
    assert.strictEqual(infos.length, 1, 'the notice never repeats');
    tabGroups.all = [];
    // The direct compare command closes the same duplicates.
    tabGroups.all = [{ viewColumn: 1, tabs: [prev] }];
    closedTabs.length = 0;
    await W._commands['videoPreviewEnhanced.compare'](W.Uri.file(a), [W.Uri.file(a), W.Uri.file(b)]);
    assert.deepStrictEqual(closedTabs, [prev], 'Compare Videos closes the duplicate tab');
    tabGroups.all = [];
    panels.length = 1;
    await W._commands['videoPreviewEnhanced.stopAddFromExplorer']();
    // The setting turns it off.
    settings['videoPreviewEnhanced.compare.openTogether'] = false; // read at each open
    const q1 = resolve(a); const q2 = resolve(b);
    await sleep(250);
    assert.ok(!q1.disposed && !q2.disposed && panels.length === 1, 'setting off: separate tabs');
  } finally { h2.dispose(); }
})().then(() => { console.log('burst: ok'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
