'use strict';
// Settings and player preferences: where a write goes, the globalState fallback when VS Code refuses it,
// playback-pref sanitising and the broadcast to open pages. Everything VS Code-shaped is injected, so a Node
// test can drive it (test/host/settings_test.js); src/extension.js wires the real objects.

/** The jump sizes the page shows and changes: only the values package.json declares. */
const JUMPS = ['frame', 1, 5, 10, 30];
const PREFS = {
  'jump.arrow': { values: JUMPS, dflt: 5 }, 'jump.shift': { values: JUMPS, dflt: 1 }, 'jump.ctrl': { values: JUMPS, dflt: 'frame' },
  'jump.wheel': { values: JUMPS, dflt: 'frame' }, 'jump.wheelShift': { values: JUMPS, dflt: 1 },
  // The buttons beside Play: 'frame' steps one frame, 'jump' jumps by the Ctrl+arrow size.
  stepButtons: { values: ['frame', 'jump'], dflt: 'frame' },
};
const PLAYBACK_PREFS_KEY = 'videoPreviewEnhanced.playbackPrefs';
const FALLBACK_KEY = 'videoPreviewEnhanced.settingFallback';
const DEFAULT_PLAYBACK_PREFS = { volume: 1, rate: 1, timeMode: 0, stepSize: null };
// The step buttons' size (media/controls.js STEP_SIZES); null follows the stepButtons setting.
const STEP_SIZES = ['frame', 'frames5', 1, 5, 10];

// checkJs: start
/**
 * @typedef {{ volume: number, rate: number, timeMode: number, stepSize: string | number | null }} PlaybackPrefs
 * @typedef {{ get(key: string): any, update(key: string, value: any): PromiseLike<void> }} Memento
 * @typedef {{ post(msg: any): void, updateTranscode?(prefs: any): void }} PageTarget
 */

/**
 * Cleans a playback-prefs record from the page or from globalState; what is invalid keeps `base`.
 * @param {any} raw
 * @param {PlaybackPrefs} [base]
 * @returns {PlaybackPrefs}
 */
function sanitizePlaybackPrefs(raw, base = DEFAULT_PLAYBACK_PREFS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const vol = Number(src.volume);
  const volume = Number.isFinite(vol) && vol >= 0 && vol <= 1 ? Math.round(vol * 100) / 100 : base.volume;
  const r = Number(src.rate);
  const rate = Number.isFinite(r) && r >= 0.25 && r <= 4 ? Math.round(r * 100) / 100 : base.rate;
  const tm = Number(src.timeMode);
  const timeMode = tm === 0 || tm === 1 || tm === 2 ? tm : base.timeMode;
  const stepSize = src.stepSize === null || STEP_SIZES.includes(src.stepSize) ? src.stepSize : base.stepSize;
  return { volume, rate, timeMode, stepSize };
}

/**
 * @param {object} deps
 * @param {any} deps.vscode            workspace.getConfiguration, ConfigurationTarget
 * @param {() => Memento | undefined} deps.getState  globalState (set when the extension activates)
 * @param {(msg: string) => void} deps.log
 * @param {{ resolveSetting(o: any): any }} deps.transcodePolicy
 * @param {Iterable<PageTarget>} deps.sessions         open players
 * @param {Iterable<PageTarget>} deps.compareSessions  open compare panels
 */
function createSettings({ vscode, getState, log, transcodePolicy, sessions, compareSessions }) {
  const allPages = () => [...sessions, ...compareSessions];

  /** Where to write a player preference: the scope that sets it now, so a workspace value doesn't shadow the change. */
  function prefTarget(/** @type {string} */ key) {
    const i = vscode.workspace.getConfiguration('videoPreviewEnhanced').inspect(key) || {};
    if (i.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
    return vscode.ConfigurationTarget.Global;
  }

  function storedPlaybackPrefs() {
    const gs = getState();
    return sanitizePlaybackPrefs(gs && gs.get(PLAYBACK_PREFS_KEY));
  }

  /** Saves a playback-prefs change and sends it to every page but `from`; undefined when nothing changed. */
  function rememberPlaybackPrefs(/** @type {any} */ m, /** @type {any} */ from) {
    const gs = getState();
    if (!gs || !m || typeof m !== 'object') return undefined;
    const prev = storedPlaybackPrefs();
    const next = sanitizePlaybackPrefs(m, prev);
    if (['volume', 'rate', 'timeMode', 'stepSize'].every((k) => next[k] === prev[k])) return undefined;
    // Every other player and Compare follows at once (their pages stay alive in the background), not only new tabs.
    // Not the sender: an echo would snap its slider back mid-drag and redraw its open panel.
    for (const sess of allPages()) if (sess !== from) sess.post({ type: 'playbackPrefs', prefs: next });
    return gs.update(PLAYBACK_PREFS_KEY, next);
  }

  /** The prefs object the pages get: jump sizes, step buttons, picture size, transcode, remembered playback prefs. */
  function prefsOf(/** @type {any} */ c) {
    const v = (/** @type {string} */ k) => (PREFS[k].values.includes(c.jumps[k]) ? c.jumps[k] : PREFS[k].dflt);
    return {
      jump: { arrow: v('jump.arrow'), shift: v('jump.shift'), ctrl: v('jump.ctrl'), wheel: v('jump.wheel'), wheelShift: v('jump.wheelShift') },
      stepButtons: v('stepButtons'),
      pictureSize: c.pictureSize,
      transcode: c.transcode,
      transcodeMaxBitrate: c.transcodeMaxBitrate,
      transcodeSplitBitrate: c.transcodeSplitBitrate,
      ...storedPlaybackPrefs(),
    };
  }

  /** The setting, or the globalState fallback when a write failed and the setting has no value of its own. */
  function settingOr(/** @type {any} */ c, /** @type {string} */ key, /** @type {any} */ dflt) {
    const gs = getState();
    const fb = gs && gs.get(FALLBACK_KEY);
    if (fb && fb[key] !== undefined) {
      const i = c.inspect(key) || {};
      if (i.globalValue === undefined && i.workspaceValue === undefined && i.workspaceFolderValue === undefined) return fb[key];
    }
    return c.get(key, dflt);
  }

  function config() {
    const c = vscode.workspace.getConfiguration('videoPreviewEnhanced');
    return {
      autoplay: c.get('autoplay', true),
      loop: c.get('loop', true),
      jumps: Object.fromEntries(Object.entries(PREFS).map(([k, p]) => [k, settingOr(c, k, p.dflt)])),
      sequenceFps: c.get('sequenceFps', 30),
      decoder: c.get('decoder', 'auto'),
      whenSlow: settingOr(c, 'whenSlow', 'every'),
      fastWhenBehind: c.get('fastPreviewWhenBehind', false),
      ffmpegPath: c.get('ffmpegPath', ''),
      // 0 (the default): automatic, see nativeHeights(). nativeMaxHeight is then the postMessage size (1080).
      nativeMaxHeight: c.get('nativeMaxHeight', 0) > 0 ? c.get('nativeMaxHeight', 0) : 1080,
      nativeMaxAuto: !(c.get('nativeMaxHeight', 0) > 0),
      // Performance: with the automatic nativeMaxHeight, frames only as large as the picture is shown (NativeDecoder fitView).
      sizeFramesToView: c.get('sizeFramesToView', true) !== false,
      gpuDecoding: c.get('gpuDecoding', true),
      remoteStream: c.get('remoteStream', 'auto'),
      transcode: (() => {
        const ti = (c.inspect && c.inspect('transcode')) || {};
        const ri = (c.inspect && c.inspect('remoteStream')) || {};
        const gs = getState();
        const fb = (gs && gs.get(FALLBACK_KEY)) || {};
        const rawTranscode = settingOr(c, 'transcode', 'ask');
        const rawRemote = c.get('remoteStream', 'auto');
        const tExp = ti.globalValue !== undefined || ti.workspaceValue !== undefined || ti.workspaceFolderValue !== undefined || fb.transcode !== undefined || rawTranscode !== 'ask';
        const rExp = ri.globalValue !== undefined || ri.workspaceValue !== undefined || ri.workspaceFolderValue !== undefined || rawRemote !== 'auto';
        return transcodePolicy.resolveSetting({
          transcode: rawTranscode,
          transcodeExplicit: tExp,
          remoteStream: rawRemote,
          remoteStreamExplicit: rExp,
        });
      })(),
      transcodeMaxBitrate: Math.max(0, Number(settingOr(c, 'transcodeMaxBitrate', 0)) || 0),
      transcodeSplitBitrate: settingOr(c, 'transcodeSplitBitrate', true),
      hdrOutput: c.get('hdrOutput', 'auto') === 'off' ? 'off' : 'auto',
      pictureSize: ['fit', 'fill', 'stretch', 'actual'].includes(c.get('pictureSize')) ? c.get('pictureSize') : 'fit',
    };
  }

  /**
   * Writes one of our settings. When VS Code refuses (e.g. "not a registered configuration": an older
   * install's manifest is still loaded in this window) the choice is kept in globalState instead,
   * logged, and no error reaches the user. Returns true when the setting itself was written.
   */
  async function setSetting(/** @type {string} */ key, /** @type {any} */ value, /** @type {any} */ target) {
    let ok = true;
    try {
      await vscode.workspace.getConfiguration('videoPreviewEnhanced').update(key, value, target);
    } catch (/** @type {any} */ e) {
      ok = false;
      log(`setting ${key}: write failed, kept in globalState: ${e && e.message || e}`);
    }
    try {
      const gs = /** @type {Memento} */ (getState());
      const fb = { ...(gs.get(FALLBACK_KEY) || {}) };
      if (ok) delete fb[key]; else fb[key] = value;
      await gs.update(FALLBACK_KEY, fb);
    } catch (/** @type {any} */ e) { log(`setting ${key}: fallback save failed: ${e && e.message || e}`); }
    if (!ok && (PREFS[key] || key.startsWith('transcode'))) {
      // No configuration-change event comes for a refused write, so the pages are told here.
      const prefs = prefsOf(config());
      const msg = { type: 'prefs', prefs };
      for (const sess of allPages()) sess.post(msg);
      if (key.startsWith('transcode')) for (const sess of compareSessions) if (sess.updateTranscode) sess.updateTranscode(prefs);
    }
    return ok;
  }

  return { prefTarget, rememberPlaybackPrefs, prefsOf, settingOr, config, setSetting };
}
// checkJs: end

module.exports = { createSettings, sanitizePlaybackPrefs, PREFS };
