'use strict';
// node test/run.js unit --grep playback_prefs: volume, rate, timeMode and stepSize persist in globalState across
// viewers (one video or several) and VS Code sessions, and broadcast live to open viewers; muted is never persisted.
// The page side (muted by default, a video without sound dims the mute button) is test/host/player_ui_test.js and
// player_ui_lifecycle_test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, webviewConfig } = require('./mock_vscode');

const KEY = 'videoPreviewEnhanced.playbackPrefs';

(async () => {
  const fileA = path.join(os.tmpdir(), `vpe_prefs_a_${process.pid}.mp4`);
  const fileB = path.join(os.tmpdir(), `vpe_prefs_b_${process.pid}.mp4`);
  fs.writeFileSync(fileA, Buffer.alloc(64));
  fs.writeFileSync(fileB, Buffer.alloc(64));
  try {
    const state = new Map();

    const settings = { 'videoPreviewEnhanced.compare.openTogether': false };

    // 1. Fresh session starts with default playback prefs in cfg.prefs (no muted property in shared prefs).
    const h1 = load({ state, settings });
    const s1 = h1.open(fileA);
    await s1.shown;
    const cfg1 = webviewConfig(s1.panel.webview);
    assert.strictEqual(cfg1.prefs.volume, 1);
    assert.strictEqual(cfg1.prefs.muted, undefined);
    assert.strictEqual(cfg1.prefs.rate, 1);
    assert.strictEqual(cfg1.prefs.timeMode, 0);
    assert.strictEqual(cfg1.prefs.stepSize, null);

    // 2. Explicit user changes persist volume, rate, timeMode, stepSize to globalState; muted is not persisted.
    const writes0 = h1.context.stateWrites || 0;
    await s1.send({ type: 'playbackPrefs', volume: 0.35, muted: false, rate: 1.75, timeMode: 2 });
    assert.strictEqual(h1.context.stateWrites, writes0 + 1);
    assert.deepStrictEqual(state.get(KEY), { volume: 0.35, rate: 1.75, timeMode: 2, stepSize: null });
    await s1.send({ type: 'playbackPrefs', volume: 0.35, rate: 1.75, timeMode: 2 });
    assert.strictEqual(h1.context.stateWrites, writes0 + 1, 'identical prefs do not rewrite globalState');

    // 3. A second video tab (and a fresh VS Code session sharing globalState) inherits the saved prefs.
    const s2 = h1.open(fileB);
    await s2.shown;
    await s1.send({ type: 'ready' }); // the viewers' pages take broadcasts once ready
    await s2.send({ type: 'ready' });
    const cfg2 = webviewConfig(s2.panel.webview);
    assert.strictEqual(cfg2.prefs.volume, 0.35);
    assert.strictEqual(cfg2.prefs.muted, undefined);
    assert.strictEqual(cfg2.prefs.rate, 1.75);
    assert.strictEqual(cfg2.prefs.timeMode, 2);

    // 3b. Open tabs follow a change made in another tab at once (their pages stay alive in the background), and the
    // step size is shared too.
    const before = s1.posted.length;
    const senderBefore = s2.posted.length;
    await s2.send({ type: 'playbackPrefs', volume: 0.45, rate: 1.75, timeMode: 2, stepSize: 5 });
    assert.ok(!s2.posted.slice(senderBefore).some((m) => m.type === 'playbackPrefs'),
      'the sender gets no echo (it would snap a slider back mid-drag)');
    const live = s1.posted.slice(before).find((m) => m.type === 'playbackPrefs');
    assert.deepStrictEqual(live && live.prefs, { volume: 0.45, rate: 1.75, timeMode: 2, stepSize: 5 },
      'the other open tab receives the new prefs');
    await s2.send({ type: 'playbackPrefs', volume: 0.35, rate: 1.75, timeMode: 2, stepSize: 'bogus' });
    assert.strictEqual(state.get(KEY).stepSize, 5, 'an unknown step size keeps the previous one');
    await s2.send({ type: 'playbackPrefs', volume: 0.35, rate: 1.75, timeMode: 2, stepSize: null });
    s1.panel.dispose();
    s2.panel.dispose();
    h1.dispose();

    const h2 = load({ state, settings });
    const s3 = h2.open(fileA);
    await s3.shown;
    const cfg3 = webviewConfig(s3.panel.webview);
    assert.strictEqual(cfg3.prefs.volume, 0.35);
    assert.strictEqual(cfg3.prefs.muted, undefined);
    assert.strictEqual(cfg3.prefs.rate, 1.75);
    assert.strictEqual(cfg3.prefs.timeMode, 2);

    // 4. A comparing viewer inherits playbackPrefs and persists its updates back to globalState.
    const cmpPanel = h2.nextPanel();
    await h2.vscode._commands['videoPreviewEnhanced.compare'](null, [fileA, fileB].map(h2.vscode.Uri.file));
    const cmpCfg = cmpPanel.cfg();
    assert.strictEqual(cmpCfg.prefs.volume, 0.35);
    assert.strictEqual(cmpCfg.prefs.muted, undefined);
    assert.strictEqual(cmpCfg.prefs.rate, 1.75);
    assert.strictEqual(cmpCfg.prefs.timeMode, 2);
    await cmpPanel.send({ type: 'playbackPrefs', volume: 0.8, rate: 0.5, timeMode: 1 });
    assert.deepStrictEqual(state.get(KEY), { volume: 0.8, rate: 0.5, timeMode: 1, stepSize: null });

    // 5. Invalid values are ignored in favour of previous or default values.
    await s3.send({ type: 'playbackPrefs', volume: -2, rate: 99, timeMode: 7 });
    assert.deepStrictEqual(state.get(KEY), { volume: 0.8, rate: 0.5, timeMode: 1, stepSize: null });
    state.set(KEY, { volume: 'bad', rate: 0, timeMode: -1 });
    const s4 = h2.open(fileB);
    await s4.shown;
    const cfg4 = webviewConfig(s4.panel.webview);
    assert.strictEqual(cfg4.prefs.volume, 1);
    assert.strictEqual(cfg4.prefs.muted, undefined);
    assert.strictEqual(cfg4.prefs.rate, 1);
    assert.strictEqual(cfg4.prefs.timeMode, 0);
    cmpPanel.panel.dispose();
    s3.panel.dispose();
    s4.panel.dispose();
    h2.dispose();

    console.log('playback prefs: ok');
  } finally {
    fs.rmSync(fileA, { force: true });
    fs.rmSync(fileB, { force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
