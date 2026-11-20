'use strict';
// node test/host/last_view_test.js: the last non-zoomed picture size (device pixels) is kept in globalState and is the
// first guess of the next session's early-started native ffmpeg (no restart for the first 4K video). Zoomed sizes
// are never stored; sizeFramesToView off ignores it; a number in nativeMaxHeight wins. Skipped without ffmpeg.
const assert = require('assert');
const path = require('path');
const ff = require('../../src/ffmpeg');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const KEY = 'videoPreviewEnhanced.lastView';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (!tools) { console.log('last view: skipped (no ffmpeg)'); return; }
  const record = {
    fp: 'whatever', complete: true, ffmpeg: tools.version, ffmpegPath: tools.ffmpeg, gpus: [], at: 1, maxHeight: 2160,
    results: { 'hevc/10/2160': { method: 'none', fps: 140, realtimeFactor: 4.6, sw: 140, tried: [{ method: 'none', ok: true, fps: 140 }] } },
  };
  const state = new Map();
  /** A fresh session sharing globalState: the size its early ffmpeg starts at, after running `act` on the page. */
  async function session(extra, act) {
    const h = load({ settings: { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg, ...extra }, state });
    h.vscode.window.withProgress = async () => null;
    await h.context.globalState.update('videoPreviewEnhanced.probe', record);
    const logs = h.context.subscriptions.find((x) => x && Array.isArray(x.lines)).lines;
    const s = h.open(clip);
    await s.shown;
    const t0 = Date.now();
    while (!logs.some((l) => /native decode from/.test(l))) { if (Date.now() - t0 > 15000) throw new Error(logs.join('\n')); await wait(5); }
    const size = /native decode from [\d.]+ s: (\d+x\d+)/.exec(logs.find((l) => /native decode from/.test(l)))[1];
    if (act) await act(s);
    s.panel.dispose();
    h.dispose(); // flushes the pending globalState write
    return size;
  }
  assert.strictEqual(await session({}, (s) => s.send({ type: 'nd', m: { type: 'view', w: 1600, h: 900 } })), '3840x2160', 'fresh install: nothing known, full size');
  assert.deepStrictEqual(state.get(KEY), { w: 1600, h: 900 }, 'stored');
  assert.strictEqual(await session({}, (s) => s.send({ type: 'nd', m: { type: 'view', w: 3000, h: 1700, zoomed: true } })), '1920x1080', 'next session starts at the picture size');
  assert.deepStrictEqual(state.get(KEY), { w: 1600, h: 900 }, 'a zoomed size is never stored');
  assert.strictEqual(await session({ 'videoPreviewEnhanced.sizeFramesToView': false }), '3840x2160', 'sizeFramesToView off ignores it');
  assert.strictEqual(await session({ 'videoPreviewEnhanced.nativeMaxHeight': 1440 }), '2560x1440', 'a number in nativeMaxHeight wins');
  state.set(KEY, { w: 'x', h: -4 });
  assert.strictEqual(await session({}), '3840x2160', 'garbage in globalState is ignored');
  console.log('last view: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
