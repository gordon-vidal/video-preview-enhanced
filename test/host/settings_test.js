'use strict';
// node test/run.js unit --grep settings: src/settings.js with fake vscode / globalState (no VS Code):
// playback-pref sanitising, workspace-vs-global write target, the globalState fallback when a write fails,
// the broadcast that skips the sender, and config() / prefsOf() resolution (transcode precedence).
const assert = require('assert');
const { createSettings, sanitizePlaybackPrefs, PREFS } = require('../../src/settings');
const transcodePolicy = require('../../src/transcode_policy');

function make({ values = {}, inspected = {}, failWrites = false } = {}) {
  const store = new Map();
  const globalState = { get: (k) => store.get(k), update: async (k, v) => { if (v === undefined) store.delete(k); else store.set(k, v); } };
  const written = [];
  const logs = [];
  const cfg = {
    get: (k, d) => (k in values ? values[k] : d),
    inspect: (k) => inspected[k] || (k in values ? { globalValue: values[k] } : {}),
    update: async (k, v, t) => { if (failWrites) throw new Error('not a registered configuration'); written.push([k, v, t]); },
  };
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: { getConfiguration: () => cfg },
  };
  const page = () => { const p = { posts: [], transcodes: [], post: (m) => p.posts.push(m), updateTranscode: (x) => p.transcodes.push(x) }; return p; };
  const sessions = new Set();
  const compareSessions = new Set();
  const s = createSettings({ vscode, getState: () => globalState, log: (m) => logs.push(m), transcodePolicy, sessions, compareSessions });
  return { s, store, globalState, written, logs, page, sessions, compareSessions };
}

const FB = 'videoPreviewEnhanced.settingFallback';
const PB = 'videoPreviewEnhanced.playbackPrefs';

(async () => {
  // Sanitising: out-of-range values keep the base, two decimals, step sizes from the known list.
  assert.deepStrictEqual(sanitizePlaybackPrefs(undefined), { volume: 1, rate: 1, timeMode: 0, stepSize: null });
  assert.deepStrictEqual(sanitizePlaybackPrefs({ volume: 0.456, rate: 2.5, timeMode: 2, stepSize: 'frames5' }),
    { volume: 0.46, rate: 2.5, timeMode: 2, stepSize: 'frames5' });
  assert.deepStrictEqual(sanitizePlaybackPrefs({ volume: 2, rate: 9, timeMode: 7, stepSize: 'x' }, { volume: 0.5, rate: 1.5, timeMode: 1, stepSize: 10 }),
    { volume: 0.5, rate: 1.5, timeMode: 1, stepSize: 10 });
  assert.deepStrictEqual(sanitizePlaybackPrefs('junk'), { volume: 1, rate: 1, timeMode: 0, stepSize: null });
  assert.strictEqual(sanitizePlaybackPrefs({ stepSize: null }, { volume: 1, rate: 1, timeMode: 0, stepSize: 5 }).stepSize, null);

  // prefTarget: a workspace value is written back to the workspace, else global.
  let t = make({ inspected: { 'jump.arrow': { workspaceValue: 10 } } });
  assert.strictEqual(t.s.prefTarget('jump.arrow'), 2);
  assert.strictEqual(t.s.prefTarget('jump.shift'), 1);

  // setSetting: success writes the setting and clears a stale fallback.
  t = make({ values: { transcode: 'ask' } });
  assert.strictEqual(t.s.config().transcode, 'auto', 'a stored ask (retired) behaves as auto');
  t = make({ values: { transcode: 'off' } });
  assert.strictEqual(t.s.config().transcode, 'off');
  t = make();
  t.store.set(FB, { whenSlow: 'skip', other: 1 });
  assert.strictEqual(await t.s.setSetting('whenSlow', 'every', 1), true);
  assert.deepStrictEqual(t.written, [['whenSlow', 'every', 1]]);
  assert.deepStrictEqual(t.store.get(FB), { other: 1 });

  // setSetting: a refused write is kept in globalState, logged, and the pages get the prefs (no error to the user).
  t = make({ failWrites: true });
  const player = t.page(); const cmp = t.page(); const other = t.page();
  t.sessions.add(player); t.sessions.add(other); t.compareSessions.add(cmp);
  assert.strictEqual(await t.s.setSetting('transcode', 'off', 1), false);
  assert.deepStrictEqual(t.store.get(FB), { transcode: 'off' });
  assert.match(t.logs[0], /setting transcode: write failed, kept in globalState: not a registered configuration/);
  for (const p of [player, other, cmp]) assert.strictEqual(p.posts[0].type, 'prefs');
  assert.strictEqual(player.posts[0].prefs.transcode, 'off', 'the fallback already applies in the broadcast prefs');
  assert.strictEqual(cmp.transcodes.length, 1, 'compare panels re-read transcode');
  assert.strictEqual(player.transcodes.length, 0);
  // A key that is neither a pref nor a transcode setting: stored, no broadcast.
  await t.s.setSetting('ffmpegPath', 'x', 1);
  assert.strictEqual(player.posts.length, 1);
  assert.strictEqual(t.store.get(FB).ffmpegPath, 'x');
  // A jump pref refused: broadcast to pages, but compare panels get no transcode update.
  await t.s.setSetting('jump.arrow', 10, 1);
  assert.strictEqual(player.posts.length, 2);
  assert.strictEqual(cmp.transcodes.length, 1);
  assert.strictEqual(player.posts[1].prefs.jump.arrow, 10, 'the fallback value shows in prefs');
  // The fallback bookkeeping itself failing is logged, not thrown.
  const bad = make();
  bad.globalState.get = () => { throw new Error('boom'); };
  assert.strictEqual(await bad.s.setSetting('whenSlow', 'skip', 1), true);
  assert.match(bad.logs[0], /fallback save failed: boom/);

  // settingOr: the fallback applies only while no scope sets the setting.
  t = make();
  t.store.set(FB, { whenSlow: 'skip' });
  const c0 = { get: (k, d) => d, inspect: () => ({}) };
  assert.strictEqual(t.s.settingOr(c0, 'whenSlow', 'every'), 'skip');
  assert.strictEqual(t.s.settingOr({ get: () => 'every', inspect: () => ({ workspaceValue: 'every' }) }, 'whenSlow', 'every'), 'every');
  assert.strictEqual(t.s.settingOr(c0, 'sequenceFps', 30), 30);

  // config(): defaults and clamping.
  t = make();
  let c = t.s.config();
  assert.strictEqual(c.nativeMaxHeight, 1080); assert.strictEqual(c.nativeMaxAuto, true);
  assert.strictEqual(c.pictureSize, 'fit'); assert.strictEqual(c.transcode, 'auto'); assert.strictEqual(c.hdrOutput, 'auto');
  assert.strictEqual(c.jumps['jump.arrow'], 5);
  t = make({ values: { nativeMaxHeight: 720, pictureSize: 'bogus', hdrOutput: 'off', transcodeMaxBitrate: -3, 'jump.ctrl': 30 } });
  c = t.s.config();
  assert.strictEqual(c.nativeMaxHeight, 720); assert.strictEqual(c.nativeMaxAuto, false);
  assert.strictEqual(c.pictureSize, 'fit'); assert.strictEqual(c.hdrOutput, 'off'); assert.strictEqual(c.transcodeMaxBitrate, 0);
  assert.strictEqual(c.jumps['jump.ctrl'], 30);

  // config().transcode precedence: explicit transcode > explicit remoteStream > default 'auto'.
  t = make({ values: { remoteStream: 'on' } });
  assert.strictEqual(t.s.config().transcode, 'always', 'only the older remoteStream is set');
  t = make({ values: { remoteStream: 'on', transcode: 'off' } });
  assert.strictEqual(t.s.config().transcode, 'off', 'an explicit transcode wins');
  t = make({ values: { remoteStream: 'off' } });
  assert.strictEqual(t.s.config().transcode, 'off');
  t = make();
  t.store.set(FB, { transcode: 'auto' });
  assert.strictEqual(t.s.config().transcode, 'auto', 'a globalState fallback counts as explicit');

  // prefsOf: invalid jump values fall back to the defaults; remembered playback prefs ride along.
  t = make();
  t.store.set(PB, { volume: 0.3, rate: 2, timeMode: 1, stepSize: 5 });
  const prefs = t.s.prefsOf({
    jumps: { 'jump.arrow': 99, 'jump.shift': 10, stepButtons: 'jump' }, pictureSize: 'fill', transcode: 'auto', transcodeMaxBitrate: 8, transcodeSplitBitrate: false,
  });
  assert.deepStrictEqual(prefs.jump, { arrow: PREFS['jump.arrow'].dflt, shift: 10, ctrl: 'frame', wheel: 'frame', wheelShift: 1 });
  assert.strictEqual(prefs.stepButtons, 'jump');
  assert.strictEqual(prefs.pictureSize, 'fill'); assert.strictEqual(prefs.transcode, 'auto');
  assert.strictEqual(prefs.transcodeMaxBitrate, 8); assert.strictEqual(prefs.transcodeSplitBitrate, false);
  assert.deepStrictEqual([prefs.volume, prefs.rate, prefs.timeMode, prefs.stepSize], [0.3, 2, 1, 5]);

  // rememberPlaybackPrefs: broadcast to every page but the sender, then store; no change = no post, no write.
  t = make();
  const a = t.page(); const b = t.page(); const cp = t.page();
  t.sessions.add(a); t.sessions.add(b); t.compareSessions.add(cp);
  const want = { volume: 0.5, rate: 1.25, timeMode: 2, stepSize: 'frame' };
  await t.s.rememberPlaybackPrefs(want, a);
  assert.strictEqual(a.posts.length, 0, 'the sender gets no echo');
  for (const p of [b, cp]) assert.deepStrictEqual(p.posts, [{ type: 'playbackPrefs', prefs: want }]);
  assert.deepStrictEqual(t.store.get(PB), want);
  assert.strictEqual(t.s.rememberPlaybackPrefs({ ...want }, a), undefined);
  assert.strictEqual(b.posts.length, 1, 'unchanged: nothing sent');
  // A partial or invalid update keeps what was stored.
  await t.s.rememberPlaybackPrefs({ volume: 'loud', rate: 3 }, a);
  assert.deepStrictEqual(t.store.get(PB), { volume: 0.5, rate: 3, timeMode: 2, stepSize: 'frame' });
  assert.strictEqual(t.s.rememberPlaybackPrefs(null, a), undefined);
  assert.strictEqual(t.s.rememberPlaybackPrefs('x', a), undefined);
  // Without globalState (before activate) nothing happens.
  const nogs = createSettings({ vscode: {}, getState: () => undefined, log() {}, transcodePolicy, sessions: [], compareSessions: [] });
  assert.strictEqual(nogs.rememberPlaybackPrefs({ volume: 0.2 }, null), undefined);

  console.log('settings tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
