'use strict';
// node test/host/speed_hint_test.js: the extension side of the built-in speed samples
// (src/extension.js with the mock vscode): speeds stored per class, the "set up
// ffmpeg" hint after sustained slow decoding only, its buttons and "Don't Show Again",
// and no hint in remote windows or when ffmpeg is there.
const assert = require('assert');
const path = require('path');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
const slow = { type: 'decodeSpeed', codec: 'hevc', depth: 10, width: 3840, height: 2160, fps: 30, vmode: 'soft', realtime: false, ratio: 0.7 };
const hopeless = { ...slow, ratio: 0.1 };
const fast = { ...slow, realtime: true, ratio: 1 };
const settings = { 'videoPreviewEnhanced.ffmpegPath': path.join(__dirname, 'no-such-ffmpeg.exe') }; // ffmpeg "not installed"
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function session({ answer, remote, before } = {}) {
  const h = load({ settings });
  const shown = [];
  h.vscode.window.showInformationMessage = async (...a) => { if (a.includes('Undo')) return undefined; shown.push(a); return answer; }; // not the MP4/WebM default notice
  h.vscode.env.remoteName = remote;
  if (before) await before(h);
  const s = h.open(clip);
  return { h, s, shown };
}

(async () => {
  // Slow, then real time, then slow again: never two slow samples in a row -> no hint.
  let { h, s, shown } = await session({ answer: 'Not now' });
  for (const m of [slow, fast, slow, fast]) { await s.send(m); await wait(30); }
  assert.strictEqual(shown.length, 0, 'no hint for blips: ' + JSON.stringify(shown));
  // Two in a row: the hint, with the measured speed and the three choices.
  await s.send(slow);
  await s.send(slow);
  for (let i = 0; i < 100 && !shown.length; i++) await wait(10);
  assert.strictEqual(shown.length, 1);
  assert.match(shown[0][0], /^HEVC 10-bit 4K plays at about 21 of 30 frames per second here\. Set up ffmpeg \(≈\d+ MB, no admin needed\): about \d+× faster with a GPU \([\d.]+× on CPU\) on our test PC, likely smooth here\.$/);
  assert.deepStrictEqual(shown[0].slice(1), ['Set up', 'Not now', "Don't Show Again"]);
  await wait(30);
  const hint = h.context.globalState.get('videoPreviewEnhanced.setupHint');
  assert.ok(hint.snoozedUntil > Date.now(), 'Not now snoozes');
  // Once per session.
  await s.send(slow); await s.send(slow); await wait(50);
  assert.strictEqual(shown.length, 1);
  // Speeds stored per class (written in batches; flushed on deactivate).
  s.panel.dispose(); h.dispose();
  const sp = h.context.globalState.get('videoPreviewEnhanced.builtinSpeed');
  assert.ok(sp && sp['hevc/10/2160'] && sp['hevc/10/2160'].n >= 6 && sp['hevc/10/2160'].ratio < 1, JSON.stringify(sp));

  // Hopeless (far below real time): the first slow sample is enough.
  ({ h, s, shown } = await session({ answer: 'Not now' }));
  await s.send(hopeless);
  for (let i = 0; i < 100 && !shown.length; i++) await wait(10);
  assert.strictEqual(shown.length, 1, 'hopeless: hint after one sample');
  assert.match(shown[0][0], /^HEVC 10-bit 4K plays at about 3\.0 of 30 frames per second here\. Set up ffmpeg .*faster with a GPU \([\d.]+× on CPU\) on our test PC\.$/);
  await wait(30);
  s.panel.dispose(); h.dispose();
  ({ h, s, shown } = await session({ before: (x) => x.context.globalState.update('videoPreviewEnhanced.setupHint', { snoozedUntil: Date.now() + 1e6 }) }));
  await s.send(hopeless); await wait(100);
  assert.strictEqual(shown.length, 0, 'hopeless: snooze respected');
  s.panel.dispose(); h.dispose();

  // "Don't Show Again" is kept.
  ({ h, s, shown } = await session({ answer: "Don't Show Again" }));
  await s.send(slow); await s.send(slow);
  for (let i = 0; i < 100 && !shown.length; i++) await wait(10);
  await wait(30);
  assert.strictEqual(h.context.globalState.get('videoPreviewEnhanced.setupHint').never, true);
  s.panel.dispose(); h.dispose();
  ({ h, s, shown } = await session({ before: (x) => x.context.globalState.update('videoPreviewEnhanced.setupHint', { never: true }) }));
  await s.send(slow); await s.send(slow); await wait(100);
  assert.strictEqual(shown.length, 0, "Don't Show Again respected");
  s.panel.dispose(); h.dispose();

  // Remote window: no hint (native ffmpeg wouldn't be used there anyway).
  ({ h, s, shown } = await session({ remote: 'ssh-remote' }));
  await s.send(slow); await s.send(slow); await wait(100);
  assert.strictEqual(shown.length, 0, 'remote: no hint');
  s.panel.dispose(); h.dispose();

  // Garbage from the page is ignored.
  ({ h, s, shown } = await session({}));
  await s.send({ type: 'decodeSpeed', codec: 'hevc', width: 'x', ratio: -1 });
  await s.send({ type: 'decodeSpeed' });
  await wait(50);
  assert.strictEqual(shown.length, 0);
  s.panel.dispose(); h.dispose();
  console.log('speed hint: ok');
})().catch((e) => { console.error(e); process.exit(1); });
