'use strict';
// node test/host/playback_prefs_test.js: volume, rate, timeMode, and stepSize persist in globalState across
// video tabs, Compare panels, and VS Code sessions (and broadcast live to open tabs), while every new tab
// starts muted by default and videos without an audio track dim and disable the mute button.
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
    assert.strictEqual(cmpCfg.prefs.muted, undefined);
    assert.strictEqual(cmpCfg.prefs.rate, 1.75);
    assert.strictEqual(cmpCfg.prefs.timeMode, 2);
    await cmp.onMessage({ type: 'playbackPrefs', page: cmpCfg.page, volume: 0.8, rate: 0.5, timeMode: 1 });
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
    cmp.dispose();
    s3.panel.dispose();
    s4.panel.dispose();
    h2.dispose();

    // 6. Player webview logic: starts muted by default while inheriting volume, rate, timeMode;
    // unmutes only explicitly (button, M, volume > 0); dims and disables #mute when there is no audio track.
    {
      const posted = [];
      const toasts = [];
      let savedState = {};
      const noop = () => {};
      const makeClassList = () => {
        const set = new Set();
        return {
          toggle(cls, force) {
            const on = force === undefined ? !set.has(cls) : !!force;
            if (on) set.add(cls); else set.delete(cls);
            return on;
          },
          contains(cls) { return set.has(cls); },
        };
      };
      const el = (parent = null) => ({
        value: '', textContent: '', title: '', disabled: false, parentElement: parent,
        attributes: {}, classList: makeClassList(),
        setAttribute(k, v) { this.attributes[k] = v; },
        removeAttribute(k) { delete this.attributes[k]; },
      });
      const volWrap = el();
      const ui = { rate: el(), mute: el(volWrap), volume: el(volWrap), time: el() };
      const playerCalls = [];
      class FramePlayer {}
      const ctx = vm.createContext({
        vscode: {
          getState: () => savedState,
          setState: (st) => { savedState = st; },
          postMessage: (m) => posted.push({ ...m }),
        },
        cfg: { loop: true, prefs: { volume: 0.65, rate: 1.25, timeMode: 1 } },
        ui,
        FramePlayer,
        VpeControls: require('../../media/controls'),
        VpePicture: require('../../media/picture'),
        toast: (msg) => toasts.push(msg),
        updateUi: noop,
        controls: null,
        lastUi: '',
        stepTips: () => {},
      });
      vm.runInContext([
        slice(playerSrc, '  const saved = vscode.getState() || {};', '  const actionBtn ='),
        slice(playerSrc, '  function postPlaybackPrefs()', '  /** Z (and the Picture size button)'),
        slice(playerSrc, '  ui.time.onclick = () => {', '  // Hover tip:'),
        slice(playerSrc, '  setRate(rate, false);', '\n\n  // Controls hide'),
      ].join('\n'), ctx);
      vm.runInContext(`player = {
        meta: { duration: 10 },
        info: { audio: { codec: 'aac' } },
        setRate: (r) => playerCalls.push(['rate', r]),
        setVolume: (v, m) => playerCalls.push(['vol', v, m]),
      }`, Object.assign(ctx, { playerCalls }));
      const stateOf = () => ({ ...vm.runInContext('({ volume, muted, rate, timeMode })', ctx) });

      // New tab starts muted by default, with remembered volume, rate, timeMode.
      assert.deepStrictEqual(stateOf(), {
        volume: 0.65, muted: true, rate: 1.25, timeMode: 1,
      });
      assert.strictEqual(ui.mute.attributes['aria-pressed'], 'true');
      assert.strictEqual(ui.mute.attributes['aria-label'], 'Unmute');
      assert.strictEqual(ui.mute.disabled, false);
      assert.strictEqual(volWrap.classList.contains('no-audio'), false);
      assert.strictEqual(posted.length, 0, 'initial setup posts no playbackPrefs message');

      // User clicks Unmute / presses M: unmutes this tab at the remembered volume without posting playbackPrefs.
      vm.runInContext('setMute(!muted)', ctx);
      assert.strictEqual(stateOf().muted, false);
      assert.strictEqual(ui.mute.attributes['aria-pressed'], 'false');
      assert.strictEqual(ui.mute.attributes['aria-label'], 'Mute');
      assert.deepStrictEqual([...playerCalls.pop()], ['vol', 0.65, false]);
      assert.strictEqual(posted.length, 0, 'mute is per-tab and not broadcast in playbackPrefs');

      // User mutes again, then adjusts volume > 0 -> unmutes and persists volume.
      vm.runInContext('setMute(true)', ctx);
      assert.strictEqual(stateOf().muted, true);
      vm.runInContext('setVolume(0.4)', ctx);
      assert.strictEqual(stateOf().muted, false);
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.4, rate: 1.25, timeMode: 1, stepSize: null,
      });

      // Speed and timeMode changes persist in playbackPrefs.
      vm.runInContext('changeRate(2)', ctx);
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.4, rate: 2, timeMode: 1, stepSize: null,
      });
      ui.time.onclick();
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.4, rate: 2, timeMode: 2, stepSize: null,
      });

      // Another tab's volume/rate/timeMode/stepSize change arrives: updates volume without changing this tab's muted state.
      vm.runInContext('setMute(true)', ctx);
      vm.runInContext('applyPlaybackPrefs({ volume: 0.2, rate: 1.5, timeMode: 0, stepSize: 5 })', ctx);
      assert.deepStrictEqual(stateOf(), {
        volume: 0.2, muted: true, rate: 1.5, timeMode: 0,
      });
      assert.strictEqual(vm.runInContext('prefs.stepSize', ctx), 5);
      assert.strictEqual(posted.length, 0, 'a followed change is not posted back');

      // Video without an audio track (!info.audio): dims and disables #mute, hides volume slider (.no-audio),
      // and refuses unmute with a 'No audio track' toast.
      vm.runInContext('player.info = { video: { codec: "h264" }, audio: null }; updateMuteUi();', ctx);
      assert.strictEqual(ui.mute.disabled, true);
      assert.strictEqual(ui.volume.disabled, true);
      assert.strictEqual(ui.mute.title, 'No audio track');
      assert.strictEqual(ui.mute.attributes['aria-label'], 'No audio track');
      assert.strictEqual(ui.mute.attributes['aria-pressed'], undefined);
      assert.strictEqual(ui.mute.classList.contains('muted'), true);
      assert.strictEqual(volWrap.classList.contains('no-audio'), true);
      toasts.length = 0;
      vm.runInContext('setMute(!muted)', ctx);
      assert.strictEqual(stateOf().muted, true, 'cannot unmute when there is no audio track');
      assert.deepStrictEqual(toasts, ['No audio track']);

      // Reloading/switching to a video with an audio track re-enables #mute and restores a11y attributes.
      vm.runInContext('player.info = { video: { codec: "h264" }, audio: { codec: "aac" } }; updateMuteUi();', ctx);
      assert.strictEqual(ui.mute.disabled, false);
      assert.strictEqual(ui.volume.disabled, false);
      assert.strictEqual(volWrap.classList.contains('no-audio'), false);
      assert.strictEqual(ui.mute.attributes['aria-pressed'], 'true');
      assert.strictEqual(ui.mute.attributes['aria-label'], 'Unmute');
      assert.strictEqual(ui.mute.title, 'Unmute  M');
    }

    // 7. Compare webview logic: starts muted by default, inherits volume/rate/timeMode, dims/disables #mute when no tile has audio.
    {
      const posted = [];
      const toasts = [];
      let savedState = {};
      const noop = () => {};
      const makeClassList = () => {
        const set = new Set();
        return {
          toggle(cls, force) {
            const on = force === undefined ? !set.has(cls) : !!force;
            if (on) set.add(cls); else set.delete(cls);
            return on;
          },
          contains(cls) { return set.has(cls); },
        };
      };
      const el = (parent = null) => ({
        value: '', textContent: '', title: '', disabled: false, parentElement: parent,
        attributes: {}, classList: makeClassList(),
        setAttribute(k, v) { this.attributes[k] = v; },
        removeAttribute(k) { delete this.attributes[k]; },
      });
      const volWrap = el();
      const ui = { rate: el(), mute: el(volWrap), volume: el(volWrap), time: el() };
      const ctx = vm.createContext({
        vscode: {
          getState: () => savedState,
          setState: (st) => { savedState = st; },
          postMessage: (m) => posted.push({ ...m }),
        },
        cfg: { names: ['a.mp4', 'b.mp4'], prefs: { volume: 0.5, rate: 1.5, timeMode: 2 } },
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
        ui,
        tiles: [
          { info: { audio: { codec: 'aac' } }, setVolume: noop, setRate: noop },
          { info: { audio: null }, setVolume: noop, setRate: noop },
        ],
        clock: null,
        begun: false,
        pendingStart: 0,
        lastUi: '',
        controls: null,
        updateOverlays: noop,
        requestTileSize: noop,
        updateUi: noop,
        save: noop,
        toast: (msg) => toasts.push(msg),
      });
      vm.runInContext([
        slice(compareSrc, '  const saved = vscode.getState() || {};', '  // Decoder keys'),
        slice(compareSrc, '  function hasAudio()', '  /** A jump:'),
      ].join('\n'), ctx);
      const stOf = () => ({ ...vm.runInContext('({ ...st })', ctx) });

      assert.strictEqual(stOf().volume, 0.5);
      assert.strictEqual(stOf().muted, true, 'Compare starts muted by default');
      assert.strictEqual(stOf().rate, 1.5);
      assert.strictEqual(stOf().timeMode, 2);

      // Unmuting in Compare when at least one tile has audio works and does not post playbackPrefs.
      vm.runInContext('setMute(!st.muted)', ctx);
      assert.strictEqual(stOf().muted, false);
      assert.strictEqual(ui.mute.disabled, false);
      assert.strictEqual(posted.length, 0);

      // Adjusting volume posts playbackPrefs without muted.
      vm.runInContext('setVolume(0.75)', ctx);
      assert.deepStrictEqual(posted.pop(), {
        type: 'playbackPrefs', volume: 0.75, rate: 1.5, timeMode: 2, stepSize: null,
      });

      // When none of the loaded tiles have an audio track, Compare dims and disables #mute.
      vm.runInContext('tiles[0].info.audio = null; setMute(true, false);', ctx);
      assert.strictEqual(ui.mute.disabled, true);
      assert.strictEqual(ui.volume.disabled, true);
      assert.strictEqual(ui.mute.title, 'No audio track');
      assert.strictEqual(ui.mute.attributes['aria-label'], 'No audio track');
      assert.strictEqual(ui.mute.attributes['aria-pressed'], undefined);
      assert.strictEqual(volWrap.classList.contains('no-audio'), true);
      toasts.length = 0;
      vm.runInContext('setMute(!st.muted)', ctx);
      assert.strictEqual(stOf().muted, true);
      assert.deepStrictEqual(toasts, ['No audio track']);

      // Re-enables as soon as any tile has audio.
      vm.runInContext('tiles[1].info.audio = { codec: "opus" }; updateMuteUi();', ctx);
      assert.strictEqual(ui.mute.disabled, false);
      assert.strictEqual(ui.volume.disabled, false);
      assert.strictEqual(volWrap.classList.contains('no-audio'), false);
      assert.strictEqual(ui.mute.attributes['aria-pressed'], 'true');
    }

    console.log('playback prefs: ok');
  } finally {
    fs.rmSync(fileA, { force: true });
    fs.rmSync(fileB, { force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
