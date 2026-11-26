'use strict';
// node test/run.js unit --grep size_frames: the sizeFramesToView setting end to end (src/extension.js with the mock
// vscode and a real ffmpeg on PATH or VPE_FFMPEG): on (default), a 4K file shown in a 1600x900 tile gets 1600x900
// frames over the frame server; off, it gets the automatic cap (3840x2160 for 4K30); a number in nativeMaxHeight wins
// either way. Skipped without ffmpeg.
const assert = require('assert');
const http = require('http');
const path = require('path');
const ff = require('../../src/ffmpeg');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const origin = 'vscode-webview://size-frames-test';

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (!tools) { console.log('size frames to view: skipped (no ffmpeg)'); return; }
  const record = {
    fp: 'whatever', complete: true, ffmpeg: tools.version, ffmpegPath: tools.ffmpeg, gpus: [], at: 1, maxHeight: 2160,
    results: { 'hevc/10/2160': { method: 'none', fps: 140, realtimeFactor: 4.6, sw: 140, tried: [{ method: 'none', ok: true, fps: 140 }] } },
  };
  /** The frame size native ffmpeg sends for a page whose picture is 1600x900 device pixels. */
  async function frames(extra) {
    const h = load({ settings: { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg, ...extra } });
    h.vscode.window.withProgress = async () => null;
    await h.context.globalState.update('videoPreviewEnhanced.probe', record);
    const s = h.open(clip);
    await s.shown;
    await s.send({ type: 'ready', origin });
    assert.strictEqual(s.cfg().clips[0].native, true, 'native ffmpeg chosen');
    const posted = (type) => s.posted.filter((m) => m.type === 'nd' && m.m.type === type).map((m) => m.m);
    // The page reports its tile (device pixels) before its decoder opens.
    await s.send({ type: 'tileSize', tile: { w: 1600, h: 900, cols: 1, rows: 1 } });
    const opening = s.send({ type: 'nd', m: { type: 'open', view: { w: 1600, h: 900 } } });
    await s.until(() => posted('link').length, 5000);
    const res = await new Promise((resolve, reject) => http.get(posted('link')[0].url, { headers: { Origin: origin } }, resolve).on('error', reject));
    await opening;
    res.destroy();
    const v = posted('streams')[0].info.video;
    s.panel.dispose();
    h.dispose();
    return `${v.width}x${v.height}`;
  }
  // The tile's own height (src/unified-viewer.js nativeHeightFor), never above the source.
  assert.strictEqual(await frames({}), '1600x900', 'default (on): frames sized to the tile');
  assert.strictEqual(await frames({ 'videoPreviewEnhanced.sizeFramesToView': true }), '1600x900', 'on');
  assert.strictEqual(await frames({ 'videoPreviewEnhanced.sizeFramesToView': false }), '3840x2160', 'off: the automatic cap (2160p for 4K30)');
  assert.strictEqual(await frames({ 'videoPreviewEnhanced.sizeFramesToView': false, 'videoPreviewEnhanced.nativeMaxHeight': 1440 }), '2560x1440', 'off: a number wins');
  assert.strictEqual(await frames({ 'videoPreviewEnhanced.sizeFramesToView': true, 'videoPreviewEnhanced.nativeMaxHeight': 2160 }), '3840x2160', 'on: a number wins too');
  console.log('size frames to view: ok');
})().catch((e) => { console.error(e); process.exit(1); });
