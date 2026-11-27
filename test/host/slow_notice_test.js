'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const slowNotice = require('../../media/slow-notice');
const { load } = require('./mock_vscode');

const every = slowNotice('every');
const skip = slowNotice('skip');
const auto = slowNotice('autoEvery', true, 90);
const fast = slowNotice('fast');
const setup = slowNotice('setupFfmpeg');

assert.equal(every.text, 'Playing slower than normal so every frame is shown. You can skip frames to keep real-time speed instead.');
assert.equal(every.whenSlow, 'skip');
assert.equal(every.action.label, 'Skip frames (all videos)');
assert.equal(every.action.title, 'Skip frames to keep real-time speed; saved as your default in Settings');
assert.equal(skip.text, 'Skipping frames to keep real-time speed with audio. You can show every frame instead, at slower playback.');
assert.equal(skip.whenSlow, 'every');
assert.equal(skip.action.label, 'Show every frame (all videos)');
assert.equal(skip.action.title, 'Slow playback to show every frame; saved as your default in Settings');
assert.match(auto.text, /playback is slower to show every frame.*GPU/);
assert.equal(auto.action.id, 'setupFfmpeg');
assert.match(auto.action.title, /all videos \(about 90 MB\)/);
assert.equal(slowNotice('autoEvery').action, null);
assert.doesNotMatch(slowNotice('autoEvery').text, /ffmpeg/);
assert.match(fast.text, /Fast preview.*while playing.*Paused and stepped frames stay exact/);
assert.match(setup.text, /ffmpeg.*GPU.*more smoothly/);
assert.equal(setup.action.label, 'Set up ffmpeg');
for (const notice of [every, skip, auto, fast, setup]) {
  assert.deepEqual(notice.settings, {
    label: 'Settings', id: notice === fast ? 'fastPreviewSettings' : 'whenSlowSettings',
  });
  assert.deepEqual(notice.hide, { label: "Don't show again", id: 'hideSlowPlaybackNotice', close: true });
}

(async () => {
  const h = load();
  const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
  const first = h.open(clip);
  await first.send({ type: 'ready' });
  const existing = h.open(clip);
  await existing.send({ type: 'ready' });
  assert.ok(!first.posted.some((m) => m.type === 'hideSlowPlaybackNotice'), 'shown until hidden');
  h.vscode.executed = [];
  for (const notice of [every, fast]) await first.send({ type: 'action', id: notice.settings.id });
  assert.deepEqual(h.vscode.executed, [
    ['workbench.action.openSettings', '@id:videoPreviewEnhanced.whenSlow'],
    ['workbench.action.openSettings', '@id:videoPreviewEnhanced.fastPreviewWhenBehind'],
  ]);
  await first.send({ type: 'action', id: every.hide.id });
  assert.equal(h.context.globalState.get('videoPreviewEnhanced.hideSlowPlaybackNotice'), true);
  for (const session of [first, existing]) {
    assert.ok(session.posted.some((message) => message.type === 'hideSlowPlaybackNotice'));
  }
  // A page opened later hears it as soon as it is ready.
  const next = h.open(clip);
  await next.send({ type: 'ready' });
  assert.ok(next.posted.some((message) => message.type === 'hideSlowPlaybackNotice'));
  for (const session of [first, existing, next]) session.panel.dispose();
  h.dispose();
  console.log('slow playback notice: ok');
})().catch((error) => { console.error(error); process.exit(1); });
