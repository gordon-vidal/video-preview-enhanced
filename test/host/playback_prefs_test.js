'use strict';
// node test/host/playback_prefs_test.js: volume, muted, rate, and timeMode persist in globalState across
// video tabs, Compare panels, and VS Code sessions, while transient autoplay-policy mutes never overwrite
// the user's saved muted preference.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { load, webviewConfig } = require('./mock_vscode');

const KEY = 'videoPreviewEnhanced.playbackPrefs';
const playerSrc = fs.readFileSync(path.join(__dirname, '../../media/player.js'), 'utf8');
const compareSrc = fs.readFileSync(path.join(__dirname, '../../media/compare.js'), 'utf8');

function slice(src, from, to) {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing slice: ${from}`);
  return src.slice(start, end);
}

(async () => {
  const fileA = path.join(os.tmpdir(), `vpe_prefs_a_${process.pid}.mp4`);
  const fileB = path.join(os.tmpdir(), `vpe_prefs_b_${process.pid}.mp4`);
  fs.writeFileSync(fileA, Buffer.alloc(64));
  fs.writeFileSync(fileB, Buffer.alloc(64));
  try {
    const state = new Map();

    const settings = { 'videoPreviewEnhanced.compare.openTogether': false };

    // 1. Fresh session starts with default playback prefs in cfg.prefs.
    const h1 = load({ state, settings });
    const s1 = h1.open(fileA);
    await s1.shown;
    const cfg1 = webviewConfig(s1.panel.webview);
    assert.strictEqual(cfg1.prefs.volume, 1);
    assert.strictEqual(cfg1.prefs.muted, false);
    assert.strictEqual(cfg1.prefs.rate, 1);
    assert.strictEqual(cfg1.prefs.timeMode, 0);

    // 2. Explicit user changes persist to globalState; duplicate messages do not rewrite globalState.
    const writes0 = h1.context.stateWrites || 0;
    await s1.send({ type: 'playbackPrefs', volume: 0.35, muted: true, rate: 1.75, timeMode: 2 });
    assert.strictEqual(h1.context.stateWrites, writes0 + 1);
    assert.deepStrictEqual(state.get(KEY), { volume: 0.35, muted: true, rate: 1.75, timeMode: 2, stepSize: null });
    await s1.send({ type: 'playbackPrefs', volume: 0.35, muted: true, rate: 1.75, timeMode: 2 });
    assert.strictEqual(h1.context.stateWrites, writes0 + 1, 'identical prefs do not rewrite globalState');

    // 3. A second video tab (and a fresh VS Code session sharing globalState) inherits the saved prefs.
    const s2 = h1.open(fileB);
    await s2.shown;
    const cfg2 = webviewConfig(s2.panel.webview);
    assert.strictEqual(cfg2.prefs.volume, 0.35);
    assert.strictEqual(cfg2.prefs.muted, true);
    assert.strictEqual(cfg2.prefs.rate, 1.75);
    assert.strictEqual(cfg2.prefs.timeMode, 2);

    // 3b. Open tabs follow a change made in another tab at once (their pages stay alive in the background), and the
    // step size is shared too.
    const before = s1.posted.length;
    await s2.send({ type: 'playbackPrefs', volume: 0.35, muted: false, rate: 1.75, timeMode: 2, stepSize: 5 });
    const live = s1.posted.slice(before).find((m) => m.type === 'playbackPrefs');
    assert.deepStrictEqual(live && live.prefs, { volume: 0.35, muted: false, rate: 1.75, timeMode: 2, stepSize: 5 },
      'the other open tab receives the new prefs');
    await s2.send({ type: 'playbackPrefs', volume: 0.35, muted: true, rate: 1.75, timeMode: 2, stepSize: 'bogus' });
    assert.strictEqual(state.get(KEY).stepSize, 5, 'an unknown step size keeps the previous one');
    await s2.send({ type: 'playbackPrefs', volume: 0.35, muted: true, rate: 1.75, timeMode: 2, stepSize: null });
    s1.panel.dispose();
    s2.panel.dispose();
    h1.dispose();

    const h2 = load({ state, settings });
    const s3 = h2.open(fileA);
    await s3.shown;
    const cfg3 = webviewConfig(s3.panel.webview);
    assert.strictEqual(cfg3.prefs.volume, 0.35);
    assert.strictEqual(cfg3.prefs.muted, true);
    assert.strictEqual(cfg3.prefs.rate, 1.75);
    assert.strictEqual(cfg3.prefs.timeMode, 2);

    // 4. Compare inherits playbackPrefs and persists updates from Compare back to globalState.
    let compareWebview = null;
    h2.vscode.window.createWebviewPanel = () => ({
      webview: (compareWebview = {
        html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u,
        postMessage() {}, onDidReceiveMessage() {},
      }),
      onDidDispose() {}, onDidChangeViewState() {},
    });
    const cmp = await h2.vscode._commands['videoPreviewEnhanced.compare'](null, [fileA, fileB].map(h2.vscode.Uri.file));
    const cmpCfg = webviewConfig(compareWebview);
    assert.strictEqual(cmpCfg.prefs.volume, 0.35);
    assert.strictEqual(cmpCfg.prefs.muted, true);
    assert.strictEqual(cmpCfg.prefs.rate, 1.75);
    assert.strictEqual(cmpCfg.prefs.timeMode, 2);
    await cmp.onMessage({ type: 'playbackPrefs', page: cmpCfg.page, volume: 0.8, muted: false, rate: 0.5, timeMode: 1 });
    assert.deepStrictEqual(state.get(KEY), { volume: 0.8, muted: false, rate: 0.5, timeMode: 1, stepSize: null });

    // 5. Invalid values are ignored in favour of previous or default values.
    await s3.send({ type: 'playbackPrefs', volume: -2, muted: 'yes', rate: 99, timeMode: 7 });
    assert.deepStrictEqual(state.get(KEY), { volume: 0.8, muted: false, rate: 0.5, timeMode: 1, stepSize: null });
    state.set(KEY, { volume: 'bad', muted: 123, rate: 0, timeMode: -1 });
    const s4 = h2.open(fileB);
    await s4.shown;
    const cfg4 = webviewConfig(s4.panel.webview);
    assert.strictEqual(cfg4.prefs.volume, 1);
    assert.strictEqual(cfg4.prefs.muted, false);
    assert.strictEqual(cfg4.prefs.rate, 1);
    assert.strictEqual(cfg4.prefs.timeMode, 0);
    cmp.dispose();
    s3.panel.dispose();
    s4.panel.dispose();
    h2.dispose();

    // 6. Player webview logic: inherits cfg.prefs, does NOT persist transient autoplay mute (setMuteUi(true)),
    // and DOES persist explicit user mute/unmute, volume, rate, and timeMode changes.
    {
      const posted = [];
      let savedState = {};
      const noop = () => {};
      const el = () => ({
        value: '', textContent: '', title: '', attributes: {}, classList: { toggle: noop },
        setAttribute(k, v) { this.attributes[k] = v; },
      });
      const ui = { rate: el(), mute: el(), volume: el(), time: el() };
      const playerCalls = [];
      const listeners = {};
      const ctx = vm.createContext({
        vscode: {
          getState: () => savedState,
          setState: (st) => { savedState = st; },
          postMessage: (m) => posted.push({ ...m }),
        },
        cfg: { loop: true, prefs: { volume: 0.65, muted: false, rate: 1.25, timeMode: 1 } },
        ui,
        VpeControls: require('../../media/controls'),
        VpePicture: require('../../media/picture'),
        toast: noop,
        updateUi: noop,
        controls: null,
        lastUi: '',
        stepTips: () => {},
        Element: class {},
        window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
      });
      vm.runInContext([
        slice(playerSrc, '  const saved = vscode.getState() || {};', '  const actionBtn ='),
        slice(playerSrc, '  function postPlaybackPrefs()', '  /** Z (and the Picture size button)'),
        slice(playerSrc, '  ui.time.onclick = () => {', '  ui.seek.addEventListener(\'input\''),
        slice(playerSrc, '  setRate(rate, false);', '\n\n  // Controls hide'),
      ].join('\n'), ctx);
      const setMuteUi = vm.runInContext(`(${slice(playerSrc, '(m) => {\n      if (m) {', '    onReady:').trim().replace(/,$/, '')})`, ctx);
      vm.runInContext(`player = {
        meta: { duration: 10 },
        setRate: (r) => playerCalls.push(['rate', r]),
        setVolume: (v, m) => playerCalls.push(['vol', v, m]),
      }`, Object.assign(ctx, { playerCalls }));
      const stateOf = () => ({ ...vm.runInContext('({ volume, muted, userMuted, autoplayMuted, rate, timeMode })', ctx) });

      assert.deepStrictEqual(stateOf(), {
        volume: 0.65, muted: false, userMuted: false, autoplayMuted: false, rate: 1.25, timeMode: 1,
      });
      assert.strictEqual(posted.length, 0, 'initial setup posts no playbackPrefs message');

      // Chromium autoplay policy suspends AudioContext -> engine calls setMuteUi(true).
      setMuteUi(true);
      assert.strictEqual(stateOf().muted, true, 'UI reflects transient autoplay mute');
      assert.strictEqual(stateOf().userMuted, false, 'saved user mute preference remains false');
      assert.strictEqual(stateOf().autoplayMuted, true);
      assert.strictEqual(posted.length, 0, 'autoplay mute must never overwrite persisted muted preference');

      // If AudioContext.resume() resolves right after play(), setMuteUi(false) restores unmuted state quietly.
      setMuteUi(false);
      assert.strictEqual(stateOf().muted, false);
      assert.strictEqual(stateOf().autoplayMuted, false);
      assert.strictEqual(posted.length, 0);

      // Autoplay mute again, then user clicks Unmute explicitly.
      setMuteUi(true);
      assert.strictEqual(stateOf().muted, true);
      vm.runInContext('setMute(!muted)', ctx);
      assert.strictEqual(stateOf().muted, false);
      assert.strictEqual(stateOf().userMuted, false);
      assert.strictEqual(stateOf().autoplayMuted, false);
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.65, muted: false, rate: 1.25, timeMode: 1, stepSize: null,
      });

      // User explicitly mutes, changes volume, changes speed, and cycles timeMode.
      vm.runInContext('setMute(true)', ctx);
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.65, muted: true, rate: 1.25, timeMode: 1, stepSize: null,
      });
      vm.runInContext('setVolume(0.4)', ctx); // volume > 0 while muted also unmutes
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.4, muted: false, rate: 1.25, timeMode: 1, stepSize: null,
      });
      vm.runInContext('changeRate(2)', ctx);
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.4, muted: false, rate: 2, timeMode: 1, stepSize: null,
      });
      ui.time.onclick();
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.4, muted: false, rate: 2, timeMode: 2, stepSize: null,
      });
      // A new tab plays muted until the page gets a gesture; the first click there turns the sound on.
      setMuteUi(true);
      assert.strictEqual(stateOf().muted, true);
      listeners.pointerdown({ target: null });
      assert.strictEqual(stateOf().muted, false, 'the first click ends the autoplay mute');
      assert.strictEqual(posted.length, 0, 'ending the autoplay mute is not a preference change');

      // Another tab's change arrives: follow it without echoing it back.
      vm.runInContext('applyPlaybackPrefs({ volume: 0.2, muted: true, rate: 1.5, timeMode: 0, stepSize: 5 })', ctx);
      assert.deepStrictEqual(stateOf(), {
        volume: 0.2, muted: true, userMuted: true, autoplayMuted: false, rate: 1.5, timeMode: 0,
      });
      assert.strictEqual(vm.runInContext('prefs.stepSize', ctx), 5);
      assert.strictEqual(posted.length, 0, 'a followed change is not posted back');
    }

    // 7. Compare webview logic: inherits cfg.prefs, ignores autoplay mute for persisted prefs, persists user changes.
    {
      const posted = [];
      let savedState = {};
      const noop = () => {};
      const el = () => ({
        value: '', textContent: '', title: '', attributes: {}, classList: { toggle: noop },
        setAttribute(k, v) { this.attributes[k] = v; },
      });
      const ui = { rate: el(), mute: el(), volume: el(), time: el() };
      const ctx = vm.createContext({
        vscode: {
          getState: () => savedState,
          setState: (st) => { savedState = st; },
          postMessage: (m) => posted.push({ ...m }),
        },
        cfg: { names: ['a.mp4', 'b.mp4'], prefs: { volume: 0.5, muted: false, rate: 1.5, timeMode: 2 } },
        names: ['a.mp4', 'b.mp4'],
        N: 2,
        KEYS: ['A', 'B'],
        INTERNAL: false,
        Grid: require('../../media/compare-grid'),
        VpeControls: require('../../media/controls'),
        VpePicture: require('../../media/picture'),
        VpeAbLoop: require('../../media/abloop'),
        tileOr0: (i) => (Number.isInteger(i) && i >= 0 && i < 2 ? i : 0),
        tileLabel: (i) => ['A', 'B'][i],
        $: () => el(),
        window: { addEventListener() {} },
        Element: class {},
        ui,
        tiles: [],
        clock: null,
        begun: false,
        pendingStart: 0,
        lastUi: '',
        controls: null,
        updateOverlays: noop,
        requestTileSize: noop,
        updateUi: noop,
        save: noop,
        toast: noop,
      });
      vm.runInContext([
        slice(compareSrc, '  const saved = vscode.getState() || {};', '  // Decoder keys'),
        slice(compareSrc, '  function applyVolume()', '  /** A jump:'),
      ].join('\n'), ctx);
      const setMuteUiA = vm.runInContext(
        `((key) => (${slice(compareSrc, '(m) => {\n        if (key !== KEYS[st.sound])', '      onReady:').trim().replace(/,$/, '')}))('A')`,
        ctx,
      );
      const stOf = () => ({ ...vm.runInContext('({ ...st, userMuted, autoplayMuted })', ctx) });

      assert.strictEqual(stOf().volume, 0.5);
      assert.strictEqual(stOf().muted, false);
      assert.strictEqual(stOf().rate, 1.5);
      assert.strictEqual(stOf().timeMode, 2);

      // Autoplay mute on sound tile A updates UI state only, never posting playbackPrefs.
      setMuteUiA(true);
      assert.strictEqual(stOf().muted, true);
      assert.strictEqual(stOf().userMuted, false);
      assert.strictEqual(stOf().autoplayMuted, true);
      assert.strictEqual(posted.length, 0);

      // User unmutes explicitly in Compare.
      vm.runInContext('setMute(!st.muted)', ctx);
      assert.strictEqual(stOf().muted, false);
      assert.strictEqual(stOf().userMuted, false);
      assert.strictEqual(stOf().autoplayMuted, false);
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.5, muted: false, rate: 1.5, timeMode: 2, stepSize: null,
      });
    }

    console.log('playback prefs: ok');
  } finally {
    fs.rmSync(fileA, { force: true });
    fs.rmSync(fileB, { force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
