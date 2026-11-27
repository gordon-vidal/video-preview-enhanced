'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { barHtml } = require('../../src/bar');
const reducedResNotice = require('../../media/reduced-res-notice');
const { load } = require('./mock_vscode');

const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');

(async () => {
  for (const label of ['Compare', 'Add to Compare']) {
    const html = barHtml({ compareOpen: label === 'Add to Compare' });
    const button = html.match(/<button id="startCompareBtn"[^>]*>(.*?)<\/button>/)[0];
    assert.ok(button.includes(`title="${label}" aria-label="${label}"`));
    assert.match(button, /<svg[^>]*viewBox="0 0 24 24"[^>]*stroke-width="1\.6"[^>]*><rect x="2\.5" y="4\.5" width="19" height="15" rx="1\.5"\/><path d="M12 4\.5v15"\/><\/svg><\/button>$/);
  }

  const native = reducedResNotice({
    width: 1920, height: 1080, sourceWidth: 3840, sourceHeight: 2160, pixFmt: 'yuv420p10le',
  });
  assert.equal(native.text, 'Playing at 1920×1080 (8-bit) for smooth playback. Pixel readings and saved frames use this reduced picture instead of the original 3840×2160 (10-bit) file.');
  assert.equal(native.action.label, 'Use full resolution (this tab)');
  assert.equal(native.action.id, 'fullRes');
  assert.equal(native.action.title, 'Reload this tab at full resolution (playback may be slower)');
  assert.match(reducedResNotice({ width: 1920 }).text, /^Playing a reduced picture \(8-bit\).*original file\.$/);
  const stream = reducedResNotice(null, { sourceWidth: 3840, sourceHeight: 2160 }, { width: 1280, height: 720 });
  assert.equal(stream.text, 'Playing a Live transcode (1280×720) for smooth playback. 100% zoom shows the transcoded picture instead of the original 3840×2160 file.');
  assert.equal(native.hide.label, "Don't show again");

  for (const centerLayout of [true, false]) {
    const h = load({ settings: { 'zenMode.centerLayout': centerLayout } });
    const s = h.open(clip);
    await s.send({ type: 'ready' });
    h.vscode.executed = [];
    h.vscode._updates.length = 0;
    const zen = ['workbench.action.toggleZenMode'];
    // Stateless toggle: overlapping second click during the settle window is ignored;
    // never calls toggleCenteredLayout and never mutates zenMode.centerLayout.
    const first = s.send({ type: 'focusMode' });
    await s.send({ type: 'focusMode' });
    await first;
    assert.deepEqual(h.vscode.executed, [zen], 'only runs toggleZenMode');
    assert.deepEqual(h.vscode._updates, [], 'never mutates zenMode.centerLayout');
    h.vscode.executed = [];
    await s.send({ type: 'focusMode' });
    assert.deepEqual(h.vscode.executed, [zen], 'second click toggles Zen Mode again');
    assert.deepEqual(h.vscode._updates, [], 'still never mutates settings');

    if (centerLayout) {
      assert.ok(!s.posted.some((message) => message.type === 'hideReducedResNotice'), 'shown until hidden');
      h.vscode.executed = [];
      await s.send({ type: 'action', id: native.settings.id });
      await s.send({ type: 'action', id: stream.settings.id });
      assert.deepEqual(h.vscode.executed, [
        ['workbench.action.openSettings', '@id:videoPreviewEnhanced.nativeMaxHeight'],
        ['workbench.action.openSettings', '@id:videoPreviewEnhanced.transcode'],
      ]);
      await s.send({ type: 'action', id: native.hide.id });
      assert.equal(h.context.globalState.get('videoPreviewEnhanced.hideReducedResNotice'), true);
      assert.ok(s.posted.some((message) => message.type === 'hideReducedResNotice'));
      const next = h.open(clip);
      await next.send({ type: 'ready' });
      assert.ok(next.posted.some((message) => message.type === 'hideReducedResNotice'), 'a later page hears it when ready');
      next.panel.dispose();
    }
    s.panel.dispose();
    await h.ext.deactivate();
    h.dispose();
  }
  console.log('player polish: ok');
})().catch((e) => { console.error(e); process.exit(1); });
