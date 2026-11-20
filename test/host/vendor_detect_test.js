'use strict';
// node test/host/vendor_detect_test.js: the GPU vendor detection (src/hardware.js, a PowerShell start on
// Windows) runs only when no stored record exists, the stored one is older than 30 days, or a method
// guessed from it produced no picture (src/native.js onGuessFailed); otherwise the stored GPUs choose
// ffmpeg's method with nothing started. Mock vscode, ffmpeg on PATH (or VPE_FFMPEG); skipped without.
const assert = require('assert');
const path = require('path');
const ff = require('../../src/ffmpeg');
const hardware = require('../../src/hardware');
const native = require('../../src/native');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const HW_KEY = 'videoPreviewEnhanced.gpus';
const DAY = 24 * 3600e3;

let detects = 0;
hardware.detect = async () => { detects++; return { os: 'win32', arch: 'x64', gpus: [{ vendor: 'nvidia', name: 'Test GPU', driver: '581.15' }], nvidiaDriver: null, vaapi: false }; };
let guessFailed = null;
const realOn = native.onGuessFailed;
native.onGuessFailed = (fn) => { guessFailed = fn; realOn(fn); };

(async () => {
  const tools = await ff.locateTools(process.env.VPE_FFMPEG || '', '');
  if (!tools) { console.log('vendor detect: skipped (no ffmpeg)'); return; }
  const settings = { 'videoPreviewEnhanced.ffmpegPath': tools.ffmpeg };
  /** Opens the clip in a fresh window whose globalState holds `stored`; returns the detections it started. */
  const session = async (stored, between) => {
    const state = new Map();
    if (stored) state.set(HW_KEY, stored);
    const h = load({ settings, state });
    h.vscode.window.withProgress = async () => null;
    const before = detects;
    const s = h.open(clip);
    await s.send({ type: 'ready' });
    await s.until((p) => p.some((m) => m.type === 'libav'), 15000);
    await new Promise((r) => setTimeout(r, 50)); // a background detection would have started by now
    const n = detects - before;
    let again = 0;
    if (between) {
      between();
      const s2 = h.open(clip);
      const b2 = detects;
      await s2.send({ type: 'ready' });
      await s2.until((p) => p.some((m) => m.type === 'libav'), 15000);
      await new Promise((r) => setTimeout(r, 50));
      again = detects - b2;
      s2.panel.dispose();
    }
    s.panel.dispose(); h.dispose();
    return { n, again, stored: state.get(HW_KEY) };
  };
  const gpus = [{ vendor: 'nvidia', name: 'Test GPU' }];
  let r = await session({ os: 'win32', gpus, at: Date.now() - 2 * DAY });
  assert.strictEqual(r.n, 0, 'a recent record was detected again');
  r = await session(null);
  assert.strictEqual(r.n, 1, 'no record: detect');
  assert.ok(r.stored && r.stored.at > Date.now() - 60e3 && r.stored.gpus[0].vendor === 'nvidia', JSON.stringify(r.stored));
  r = await session({ os: 'win32', gpus, at: Date.now() - 40 * DAY });
  assert.strictEqual(r.n, 1, 'an old record (40 days) was not detected again');
  assert.ok(r.stored.at > Date.now() - 60e3, 'the new detection is stored with its time');
  r = await session({ os: 'win32', gpus }); // stored by a version without the time
  assert.strictEqual(r.n, 1, 'a record without a time was not detected again');
  // A guessed method that failed (another GPU or driver?): the next file detects again.
  r = await session({ os: 'win32', gpus, at: Date.now() - DAY }, () => guessFailed('cuda'));
  assert.strictEqual(r.n, 0, 'a recent record was detected again');
  assert.strictEqual(r.again, 1, 'a failed guessed method did not detect the GPUs again');
  console.log('vendor detect: ok (recent record: no detection; none, 40 days old, no time, a failed guess: detected)');
})().catch((e) => { console.error(e); process.exit(1); });
