'use strict';
/** @import { ReadBlockRequest } from '../tools/read-block-contract.js' */
/** @import { ExportGrab, ThumbReply, ThumbRequest } from '../tools/page-work-contract.js' */
const T_LOAD = Date.now(); // start-up timeline (tests): when the extension's module started loading
// Video Preview Enhanced: a decode-only video player for VS Code.
// The extension host only reads files; all decoding happens in the webview
// (WebCodecs for what the GPU decoder handles, libav.js WebAssembly for the rest).
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { serveBlock, readFileBlock } = require('./read-block');
// Modules a feature needs (URLs, ffmpeg setup and download, A-B export, AVI, the remote stream) load on first use:
// a window start pays only for what it runs. The proxy forwards property reads to the real module.
const lazy = (load) => { let m; return new Proxy({}, { get: (_, k) => (m || (m = load()))[k] }); };
const avi = lazy(() => require('./avi'));
const { findSequence } = require('./sequence');
const ff = require('./ffmpeg');
const setup = lazy(() => require('./setup'));
const hardware = require('./hardware');
const { NativeDecoder, onGuessFailed } = require('./native');
const { decodeThumb } = require('./thumbhost');
const { ExactFrameGrabber } = require('./exact_frame');
const { toggleFocusMode, noteFocusModeExited, resetFocusMode, setFocusModeListener } = require('./focus-mode');
const frameserver = require('./frameserver'); // native frames over 127.0.0.1 (local windows)
const remotestream = lazy(() => require('./remotestream')); // unified Live transcode stream engine (ADR 0002)
const transcodePolicy = lazy(() => require('./transcode_policy'));
const transcodeProbe = lazy(() => require('./transcode_probe'));
const probe = lazy(() => require('./probe')); // ffmpeg's GPU decoding tested on this machine
const decide = require('./decide'); // native ffmpeg or built-in, per file
const localff = lazy(() => require('./localff')); // "Use an ffmpeg I already have…"
const remoteff = lazy(() => require('./remoteff')); // ffmpeg downloaded on the remote host, for the remote stream
const proxy = lazy(() => require('./proxy'));
const { rotationOf, sniffNativeMp4 } = require('./rotation');
const { sniffNativeMatroska } = require('./sniff-matroska');
const { registerCompare, setPickHook } = require('./compare'); // compare mode (src/compare.js)
const { barHtml, playFlashHtml } = require('./bar');
const { parseFragment } = require('../media/inspect.js');
const { findSidecars, MAX_BYTES: MAX_SUB_BYTES } = require('./sidecars');
const rangecmd = lazy(() => require('./rangecmd')); // A-B frame export and ffmpeg command
const clipExport = lazy(() => require('./clipexport'));
const { syntheticRefusal } = require('./clipsource');
const membudget = require('../media/membudget.js'); // decoder pool and frame caches sized from the machine's memory
const urlsource = lazy(() => require('./urlsource')); // Open Video URL… (docs/notes/url-stream.md)

const HIDE_SLOW_PLAYBACK_NOTICE = 'videoPreviewEnhanced.hideSlowPlaybackNotice';
const HIDE_REDUCED_RES_NOTICE = 'videoPreviewEnhanced.hideReducedResNotice';
const VIEW_TYPES = ['videoPreviewEnhanced.player', 'videoPreviewEnhanced.playerOptional'];
const MAX_WAV_BYTES = 512 * 1024 * 1024;
const WAV_PART_BYTES = 8 * 1024 * 1024;
const MAX_BLOCK = 8 * 1024 * 1024;

let out;
let globalState;
let storageDir = '';
let toolsPromise = null;
let extensionDir = '';
let hwPromise = null; // hardware.detect(), once per session (Re-test detects again)
let probeRun = null; // the running probe (one at a time)
let probeChecked = false; // fingerprint compared this session
let hintShown = false; // the "set up ffmpeg" hint, at most once per session
let onboardPending = false; // the first-open popup is showing (no other popup meanwhile)
let onboardShown = false; // the first-open popup was shown in this session
let hintPending = false; // the "set up ffmpeg" hint is showing
let probeOfferShown = false; // the GPU test offer, at most once per session
let probeOfferPending = false; // that offer is showing
const remoteOfferAsked = new Set(); // remotes asked about an ffmpeg download in this session
let remoteOfferPending = false; // that question is showing
let speedsMem = null; // built-in speed records, written to globalState in batches
let speedsTimer = null;
const POSITIONS_KEY = 'videoPreviewEnhanced.positions';
// Schemes whose fsPath is the real file for this (workspace) extension host: local
// files, and files on the remote machine in SSH/WSL/container windows.
const FS_SCHEMES = new Set(['file', 'vscode-remote']);
const VIDEO_EXT = /\.(avi|mkv|mov|wmv|flv|mpe?g|m2ts|mts|3gp|ogv|m4v|vob|divx|asf|mxf|y4m|mp4|webm)$/i;
// Test logging and the debug command hook: only the VPE_LOG env var turns them on.
// Never a setting: a workspace could point it at any file and run commands.
const logFile = process.env.VPE_LOG || '';
// Tests (with VPE_LOG only): decoder pool options for the webview, e.g. {"workers":4,"budget":1e9}.
const debugPool = (() => { try { return logFile && process.env.VPE_POOL ? JSON.parse(process.env.VPE_POOL) : undefined; } catch { return undefined; } })();
// Commands the test hook may run: opening files and closing editors only, not the
// ones that change settings or install things (makeDefault, setupFfmpeg…).
const DEBUG_COMMANDS = new Set([
  'videoPreviewEnhanced.openWith', 'videoPreviewEnhanced.playSequence', 'videoPreviewEnhanced.compareWith',
  'videoPreviewEnhanced.addToCompareFromPlayer',
  'videoPreviewEnhanced.showLog', 'workbench.action.closeActiveEditor', 'workbench.action.closeAllEditors', 'workbench.action.reloadWindow',
  'notifications.clearAll', 'videoPreviewEnhanced.exportRange', 'videoPreviewEnhanced.addFromExplorer', 'videoPreviewEnhanced.stopAddFromExplorer', 'workbench.files.action.refreshFilesExplorer',
  'videoPreviewEnhanced.exportVideoRange', 'videoPreviewEnhanced.exportCompareVideoRange',
]);
const sessions = new Set();
const compareSessions = new Set(); // open compare panels (src/compare.js)
const clipExports = new WeakSet();
/** Sound codecs whose WebCodecs decoder lagged in this VS Code session ('audio-aac', ...): the built-in decoder plays them from then on. */
const wcFailed = new Set();
// Frame links (vscode://<id>/open?…) waiting for their player: file URI string -> {t, frame}.
const pendingGoto = new Map();
const PENDING_GOTO_MS = 30e3; // a link's player normally opens within a second
let lastActive = null;
/** Compare's add mode (src/compare.js registerCompare): claimOpen(uri) takes a video VS Code is opening. */
let compareApi = null;

function log(msg) {
  out.appendLine(msg);
  if (logFile) fs.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`, () => {});
}

/** Where to write a player preference: the scope that sets it now, so a workspace value doesn't shadow the change (review 2026-11-19 #6). */
function prefTarget(key) {
  const i = vscode.workspace.getConfiguration('videoPreviewEnhanced').inspect(key) || {};
  if (i.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

/** Player preferences the page shows and changes (the jump sizes): only the values package.json declares. */
const JUMPS = ['frame', 1, 5, 10, 30];
const PREFS = {
  'jump.arrow': { values: JUMPS, dflt: 5 }, 'jump.shift': { values: JUMPS, dflt: 1 }, 'jump.ctrl': { values: JUMPS, dflt: 'frame' },
  'jump.wheel': { values: JUMPS, dflt: 'frame' }, 'jump.wheelShift': { values: JUMPS, dflt: 1 },
  // The buttons beside Play: 'frame' steps one frame, 'jump' jumps by the Ctrl+arrow size.
  stepButtons: { values: ['frame', 'jump'], dflt: 'frame' },
};
const PLAYBACK_PREFS_KEY = 'videoPreviewEnhanced.playbackPrefs';
const DEFAULT_PLAYBACK_PREFS = { volume: 1, rate: 1, timeMode: 0, stepSize: null };
// The step buttons' size (media/controls.js STEP_SIZES); null follows the stepButtons setting.
const STEP_SIZES = ['frame', 'frames5', 1, 5, 10];

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

function storedPlaybackPrefs() {
  return sanitizePlaybackPrefs(globalState && globalState.get(PLAYBACK_PREFS_KEY));
}

function rememberPlaybackPrefs(m, from) {
  if (!globalState || !m || typeof m !== 'object') return undefined;
  const prev = storedPlaybackPrefs();
  const next = sanitizePlaybackPrefs(m, prev);
  if (['volume', 'rate', 'timeMode', 'stepSize'].every((k) => next[k] === prev[k])) return undefined;
  // Every other player and Compare follows at once (their pages stay alive in the background), not only new tabs.
  // Not the sender: an echo would snap its slider back mid-drag and redraw its open panel.
  for (const sess of [...sessions, ...compareSessions]) if (sess !== from) sess.post({ type: 'playbackPrefs', prefs: next });
  return globalState.update(PLAYBACK_PREFS_KEY, next);
}

function broadcastFocusMode(active) {
  for (const sess of [...sessions, ...compareSessions]) sess.post({ type: 'focusMode', active: !!active });
}
setFocusModeListener(broadcastFocusMode);

function prefsOf(c) {
  const v = (k) => (PREFS[k].values.includes(c.jumps[k]) ? c.jumps[k] : PREFS[k].dflt);
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

const EXT_ID = 'gordon-vidal.video-preview-enhanced'; // publisher.name in package.json
const FALLBACK_KEY = 'videoPreviewEnhanced.settingFallback';

/**
 * Writes one of our settings. When VS Code refuses (e.g. "not a registered configuration": an older
 * install's manifest is still loaded in this window) the choice is kept in globalState instead,
 * logged, and no error reaches the user. Returns true when the setting itself was written.
 */
async function setSetting(key, value, target) {
  let ok = true;
  try {
    await vscode.workspace.getConfiguration('videoPreviewEnhanced').update(key, value, target);
  } catch (e) {
    ok = false;
    log(`setting ${key}: write failed, kept in globalState: ${e && e.message || e}`);
  }
  try {
    const fb = { ...(globalState.get(FALLBACK_KEY) || {}) };
    if (ok) delete fb[key]; else fb[key] = value;
    await globalState.update(FALLBACK_KEY, fb);
  } catch (e) { log(`setting ${key}: fallback save failed: ${e && e.message || e}`); }
  if (!ok && (PREFS[key] || key.startsWith('transcode'))) {
    const prefs = prefsOf(config());
    const msg = { type: 'prefs', prefs };
    for (const sess of [...sessions, ...compareSessions]) sess.post(msg);
    if (key.startsWith('transcode')) for (const sess of compareSessions) sess.updateTranscode(prefs);
  }
  return ok;
}

/** The setting, or the globalState fallback when a write failed and the setting has no value of its own. */
function settingOr(c, key, dflt) {
  const fb = globalState && globalState.get(FALLBACK_KEY);
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
      const fb = (globalState && globalState.get(FALLBACK_KEY)) || {};
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

/** Native ffmpeg: the setting, then a build downloaded by setup, then PATH. Null when absent. */
function tools() {
  if (!toolsPromise) {
    probeChecked = false;
    const c = config();
    // Remote windows: this host's build; an older install there may still be under the shared key.
    const managed = [globalState.get(managedKey()), globalState.get(remoteff.MANAGED_KEY)].find((m) => m && m.ffmpeg && fs.existsSync(m.ffmpeg));
    const useManaged = !c.ffmpegPath && managed && fs.existsSync(managed.ffmpeg);
    // The tool check (three ffmpeg/ffprobe starts) is kept per binary in globalState (ff.locateTools).
    const cache = globalState ? { get: () => globalState.get(TOOLS_KEY), set: (rec) => globalState.update(TOOLS_KEY, rec) } : undefined;
    toolsPromise = ff.locateTools(useManaged ? managed.ffmpeg : c.ffmpegPath, useManaged ? managed.ffprobe : '', cache).then((t) => {
      if (t) t.source = c.ffmpegPath ? 'setting' : useManaged ? 'downloaded' : 'PATH';
      log(t ? `native ffmpeg: ${t.version.replace(/ Copyright.*/, '')} [${t.source}] ${t.ffmpeg}${t.cached ? ' (checked before)' : ''}` : 'native ffmpeg: not found (optional)');
      return t;
    });
  }
  return toolsPromise;
}

// The last ffmpeg tool check (src/ffmpeg.js locateTools): { key, version, legacy, gpuFilters }.
const TOOLS_KEY = 'videoPreviewEnhanced.toolsCheck';

// ---- ffmpeg probe, built-in speed records, setup hint --------------------------

function machine() {
  if (!hwPromise) {
    hwPromise = hardware.detect();
    hwPromise.then((hw) => {
      if (!hw) return;
      hwKnown = { os: hw.os, gpus: hw.gpus.map((g) => ({ vendor: g.vendor, name: g.name })), at: Date.now() };
      hwStale = false;
      if (globalState) globalState.update(HW_KEY, hwKnown);
    }, () => {});
  }
  return hwPromise;
}

// The GPUs found last (hardware.detect(): a WMI / lspci query, nothing decodes), kept across sessions:
// before any GPU test, they choose ffmpeg's method (decide.vendorMethod; docs/notes/cpu-4k.md).
const HW_KEY = 'videoPreviewEnhanced.gpus';
let hwKnown = null;
// Detected again only when the stored record is older than this, or a method guessed from it produced no
// picture (hwStale: a new GPU or driver); one PowerShell start (~0.3-1 s of CPU) per session otherwise.
const HW_MAX_AGE_MS = 30 * 24 * 3600e3;
let hwStale = false;
// The first time ever, a video waits this long at most for the detection (it runs alongside ffprobe).
const HW_WAIT_MS = 2500;

/**
 * The GPUs for choosing ffmpeg's method when no GPU test result fits (null when one does, or
 * GPU decoding is off): the stored ones at once (detected again in the background when they are
 * older than HW_MAX_AGE_MS or a guessed method failed), else the detection, waited for HW_WAIT_MS at most.
 */
function gpusForMethod(t, c = config()) {
  if (!t || !c.gpuDecoding || probeRecordFor(t)) return Promise.resolve(null);
  if (hwKnown && !hwStale && Date.now() - (hwKnown.at || 0) < HW_MAX_AGE_MS) return Promise.resolve(hwKnown);
  const detecting = machine();
  if (hwKnown) return Promise.resolve(hwKnown);
  return Promise.race([detecting.then(() => hwKnown, () => null), new Promise((r) => setTimeout(() => r(null), HW_WAIT_MS))]);
}

/**
 * Stored probe results that fit this ffmpeg (same build and path, same GPU switch).
 * The GPU test runs only on request ("Video Preview: Re-test ffmpeg").
 */
function probeRecordFor(t) {
  const r = probe.latest(globalState);
  if (!r || !r.complete || !t) return null;
  if (r.ffmpeg !== t.version || r.ffmpegPath !== t.ffmpeg || !!r.cpuOnly !== !config().gpuDecoding) return null;
  return r;
}

/** One-line result for a notification: how many formats play in real time, with what. */
function probeSummary(rec) {
  const all = Object.entries(rec.results);
  const rt = all.filter(([, r]) => r.fps >= probe.CLIP_FPS * 1.2);
  const methods = [...new Set(all.map(([, r]) => r.method).filter((m) => m && m !== 'none'))];
  const slow = all.filter(([, r]) => r.fps < probe.CLIP_FPS * 1.2)
    .map(([c, r]) => `${c.replace(/\/(\d+)\//, ' $1-bit ').replace(/ 2160$/, ' 4K').replace(/ 1080$/, ' 1080p')}: ${r.fps} fps`);
  return `ffmpeg plays ${rt.length} of ${all.length} tested formats in real time here (30 fps)` +
    `${methods.length ? `, decoding on the GPU with ${methods.join(', ')} where that is fast enough` : ', on the CPU'}.${slow.length ? ` Slower: ${slow.join('; ')}.` : ''}`;
}

/**
 * Tests ffmpeg on this machine in the background (cancellable notification, low
 * priority, no windows) and stores the results. userAsked: say how it went.
 */
function runProbeUi(t, hw, { userAsked = false, reload = null } = {}) {
  if (probeRun) return probeRun;
  const gpu = config().gpuDecoding;
  const abort = new AbortController();
  probeRun = Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Video Preview: testing ffmpeg on this computer', cancellable: true }, async (progress, token) => {
    token.onCancellationRequested(() => abort.abort());
    let last = 0;
    return probe.runProbe({
      tools: t, hw, clipDir: path.join(extensionDir, 'media', 'probe'), maxHeight: config().nativeMaxHeight,
      methods: gpu ? undefined : ['none'], signal: abort.signal, log,
      // Not while native ffmpeg plays: both would slow down (4K HEVC played at 6 instead of 15 fps
      // under a running probe on the Core Ultra laptop), and the probe's timings would be too low.
      idle: async () => {
        for (let said = false; !abort.signal.aborted && [...sessions].some((x) => x.native && x.native.busy()); said = true) {
          if (!said) { log('ffmpeg probe: waiting while native playback runs'); progress.report({ message: 'waiting while a video plays' }); }
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
      onProgress: (fr, text) => { const pct = Math.round(fr * 100); progress.report({ increment: Math.max(0, pct - last), message: text }); last = Math.max(last, pct); },
    });
  })).then(async (rec) => {
    if (!rec || !rec.complete) { log('ffmpeg probe cancelled; results not stored'); return null; }
    rec.cpuOnly = !gpu;
    await probe.save(globalState, rec);
    log(probe.table(rec));
    if (userAsked) {
      // Offered on a slow video (maybeOfferProbe): its method changes on the next open, or now with a reload.
      const again = reload && !reload.disposed ? 'Reopen video' : null;
      vscode.window.showInformationMessage(`Video Preview: ${probeSummary(rec)}${again ? ' The new method applies when a video opens.' : ''}`, ...(again ? [again] : []), 'Show Details').then((p) => {
        if (p === 'Show Details') out.show();
        else if (p && p === again && !reload.disposed) reload.reload('GPU test done');
      });
    }
    return rec;
  }, (e) => {
    log(`ffmpeg probe failed: ${e && e.stack || e}`);
    if (userAsked) vscode.window.showErrorMessage(`Video Preview: the ffmpeg test failed: ${e && e.message || e}`);
    return null;
  }).finally(() => { probeRun = null; });
  return probeRun;
}

/** "Video Preview: Re-test ffmpeg": detect the GPU again and run the probe. */
async function retestFfmpeg() {
  toolsPromise = null;
  hwPromise = null;
  const t = await tools();
  probeChecked = true;
  if (!t) {
    const p = await vscode.window.showInformationMessage('Video Preview: no ffmpeg found to test.', 'Set Up ffmpeg…');
    if (p) setupFfmpeg();
    return null;
  }
  return runProbeUi(t, await machine(), { userAsked: true });
}

function speeds() {
  return speedsMem || globalState.get(decide.SPEED_KEY) || {};
}

/** A built-in decode speed sample from a player: stored per class (written at most every 15 s). */
function recordSpeed(sample) {
  speedsMem = decide.recordSpeed(speeds(), sample);
  if (!speedsTimer) {
    speedsTimer = setTimeout(() => { speedsTimer = null; globalState.update(decide.SPEED_KEY, speedsMem); }, 15000);
  }
}

function flushSpeeds() {
  if (speedsTimer) { clearTimeout(speedsTimer); speedsTimer = null; }
  if (speedsMem) globalState.update(decide.SPEED_KEY, speedsMem);
}

/**
 * The first video of a session while no ffmpeg is found: "Set up ffmpeg",
 * "Not now" / "Don't Show Again". Once per session until "Don't Show Again"; never in SSH/container or untrusted windows.
 */
async function maybeOnboard() {
  const base = { state: globalState.get(decide.ONBOARD_KEY), remote: vscode.env.remoteName, trusted: vscode.workspace.isTrusted, pending: onboardPending, shownThisSession: onboardShown };
  if (!decide.shouldOnboard({ ...base, toolsInstalled: false })) return;
  onboardPending = true;
  try {
    const t = await tools();
    if (t) { await globalState.update(decide.ONBOARD_KEY, decide.afterOnboard('had-ffmpeg')); return; }
    const st0 = globalState.get(decide.ONBOARD_KEY);
    if (st0 && st0.choice === 'builtin') return; // "Don't Show Again"
    onboardShown = true;
    log('onboarding: first video, asking about ffmpeg');
    const answer = await vscode.window.showInformationMessage(decide.ONBOARD_TEXT.replace('{mb}', setup.downloadSizeMB()), decide.ONBOARD_SETUP, decide.ONBOARD_LATER, decide.ONBOARD_BUILTIN);
    const st = decide.afterOnboard(answer);
    await globalState.update(decide.ONBOARD_KEY, st);
    log(`onboarding: answer ${st.choice}`);
    if (st.choice === 'ffmpeg') setupFfmpeg();
  } finally {
    onboardPending = false;
  }
}

/** The built-in decoder stays below real time and there's no ffmpeg: suggest it, without nagging. */
async function maybeHint(sess, sample) {
  if (onboardPending || hintPending || probeOfferPending) return; // one question at a time
  if (!vscode.workspace.isTrusted) return; // shouldHint says no anyway; don't run ffmpeg -version to learn it
  const t = await tools();
  const ok = decide.shouldHint({
    hint: globalState.get(decide.HINT_KEY), onboard: globalState.get(decide.ONBOARD_KEY), now: Date.now(), shownThisSession: hintShown, toolsInstalled: !!t,
    remote: vscode.env.remoteName, trusted: vscode.workspace.isTrusted, slowRun: sess.slowRun, ratio: sample.ratio,
  });
  if (!ok) return;
  hintShown = true;
  const rec = probe.latest(globalState); // an earlier ffmpeg's probe, if any
  const text = decide.hintText(sample, { mb: setup.downloadSizeMB(), probeRecord: rec && rec.complete ? rec : null });
  log(`[${sess.name}] built-in decoding at ${sample.ratio.toFixed(2)}x (sample ${sess.slowRun}); suggesting ffmpeg: ${text}`);
  hintPending = true;
  let answer;
  try { answer = await vscode.window.showInformationMessage(text, 'Set up', 'Not now', "Don't Show Again"); } finally { hintPending = false; }
  await globalState.update(decide.HINT_KEY, decide.afterHint(globalState.get(decide.HINT_KEY), answer));
  if (answer === 'Set up') setupFfmpeg();
}

/** Another popup of ours is showing (onboarding, the setup hint, the remote download offer, the GPU test offer). */
function popupPending() {
  return onboardPending || hintPending || remoteOfferPending || probeOfferPending;
}

/**
 * Playback stays below real time with ffmpeg installed (native ffmpeg, or the built-in decoder) and no GPU
 * test result fits this ffmpeg and GPU: offer the test once (decide.shouldOfferProbe). It never runs by
 * itself; "Run test" pauses the videos playing natively (the test would wait for them) and runs it with
 * its progress and Cancel; the result applies to the next open, or to this video with "Reopen video".
 */
async function maybeOfferProbe(sess, sample) {
  if (probeOfferShown || popupPending() || probeRun) return;
  const remote = vscode.env.remoteName;
  if (remote || !vscode.workspace.isTrusted) return; // never run ffmpeg -version to learn what shouldOfferProbe says anyway
  const t = await tools();
  const ctx = {
    offer: globalState.get(decide.PROBE_OFFER_KEY), shownThisSession: probeOfferShown, toolsInstalled: !!t, probeRecord: !!probeRecordFor(t),
    gpu: config().gpuDecoding, remote, trusted: vscode.workspace.isTrusted, pending: popupPending(), running: !!probeRun,
    slowRun: sess.slowRun, ratio: sample.ratio,
  };
  if (!decide.shouldOfferProbe(ctx)) return;
  probeOfferShown = true;
  probeOfferPending = true;
  log(`[${sess.name}] ${sample.native ? 'native ffmpeg' : 'built-in decoder'} at ${sample.ratio.toFixed(2)}x (sample ${sess.slowRun}), no GPU test yet: offering it`);
  let answer;
  try {
    answer = await vscode.window.showInformationMessage(decide.PROBE_OFFER_TEXT, decide.PROBE_OFFER_RUN, decide.PROBE_OFFER_LATER, decide.PROBE_OFFER_NEVER);
  } finally { probeOfferPending = false; }
  await globalState.update(decide.PROBE_OFFER_KEY, decide.afterProbeOffer(globalState.get(decide.PROBE_OFFER_KEY), answer));
  log(`GPU test offer: ${answer || 'dismissed'}`);
  if (answer !== decide.PROBE_OFFER_RUN) return null;
  for (const x of sessions) if (x.native && !x.disposed) x.post({ type: 'pauseForTest' });
  return runProbeUi(t, await machine(), { userAsked: true, reload: sess });
}

/**
 * Raw frames from a native decoder cross from the extension host to the webview.
 * That's fine on this machine and in WSL, too much for SSH and containers.
 */
function nativeAllowedHere() {
  const remote = vscode.env.remoteName;
  return !remote || remote === 'wsl';
}

/**
 * How native frames reach the player (src/frameserver.js, docs/notes/native-transfer.md): the
 * localhost frame server in a local window ('http', with postMessage as the automatic fallback),
 * postMessage in remote windows (WSL included: 127.0.0.1 there is the remote side). Tests (VPE_LOG
 * only) can pick another with VPE_NATIVE_TRANSPORT: message, http, ws, or fail (a channel the
 * player can't open, to exercise the fallback).
 */
function nativeTransport() {
  if (vscode.env.remoteName) return 'message';
  const t = logFile ? process.env.VPE_NATIVE_TRANSPORT : '';
  return /^(message|http|ws|fail)$/.test(t || '') ? t : 'http';
}

/**
 * Native frame size caps: { stream: over the frame server, message: by postMessage (the fallback,
 * and every remote window) }. nativeMaxHeight set: that, for both (720 at most in WSL). Automatic
 * (0, the default): over the frame server, full resolution up to 2160p when the frames fit what it
 * carries at the video's frame rate (decide.streamHeight: 4K30 in full, 4K60 at 1440p), 1080p by
 * postMessage. v: the ffprobe'd video stream, when known.
 */
function nativeHeights(c = config(), v = null) {
  const message = vscode.env.remoteName === 'wsl' ? Math.min(720, c.nativeMaxHeight) : c.nativeMaxHeight;
  return { stream: c.nativeMaxAuto ? decide.streamHeight(v) : c.nativeMaxHeight, message };
}

// The last player's picture area in device pixels (NativeDecoder fitView): the size an ffmpeg started before its page guesses.
// Kept in globalState (LAST_VIEW_KEY) too, so the first video of the next session starts at the right size.
let lastView = null;
const LAST_VIEW_KEY = 'videoPreviewEnhanced.lastView';
let lastViewTimer = null;
function storedView() {
  const v = globalState && globalState.get(LAST_VIEW_KEY);
  return v && v.w >= 16 && v.h >= 16 && v.w <= 32768 && v.h <= 32768 ? { w: Math.round(v.w), h: Math.round(v.h) } : null;
}
/** Remembers a non-zoomed picture size; the globalState write waits until resizing has settled. */
function rememberView(w, h) {
  if (lastView && lastView.w === w && lastView.h === h) return;
  lastView = { w, h };
  if (lastViewTimer) clearTimeout(lastViewTimer);
  lastViewTimer = setTimeout(flushView, 1000);
  if (lastViewTimer.unref) lastViewTimer.unref();
}
function flushView() {
  if (lastViewTimer) { clearTimeout(lastViewTimer); lastViewTimer = null; }
  const s = storedView();
  if (lastView && globalState && !(s && s.w === lastView.w && s.h === lastView.h)) globalState.update(LAST_VIEW_KEY, lastView);
}

/** How long an ffmpeg started before the page waits for it (Session.startNativeEarly). */
const EARLY_NATIVE_MS = 15000;

/** Same file (size and modification time) as when it was probed. */
function sameFile(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The launch parameters open() must confirm before keeping an early native decoder. */
/** Native frames sized to the player's picture: the automatic nativeMaxHeight with sizeFramesToView on. */
function fitsView(c = config()) {
  return c.nativeMaxAuto && c.sizeFramesToView;
}

function nativeKey(t, pr, d, c, framePort) {
  const h = nativeHeights(c, pr.video);
  return JSON.stringify([t.ffmpeg, t.version, pr.video ? [pr.video.index, pr.video.codec, pr.video.width, pr.video.height, pr.video.fps] : null, pr.audio ? pr.audio.index : null, d.method, h.stream, h.message, fitsView(c), framePort ? nativeTransport() : 'message']);
}

/** The frame height native playback will most likely use here (for the decision's log line). */
function nativeHeight(c = config(), v = null) {
  const h = nativeHeights(c, v);
  return nativeTransport() === 'message' ? h.message : h.stream;
}

/** Proxy for downloads: http.proxy / HTTPS_PROXY tunnelled here; otherwise VS Code's own routing applies. */
function proxyAgent() {
  const h = vscode.workspace.getConfiguration('http');
  return proxy.agentFactory({ proxy: h.get('proxy') || '', strictSSL: h.get('proxyStrictSSL', true), env: process.env });
}

/**
 * "Use an ffmpeg I already have…": ffmpeg(.exe), a folder holding it (bin/ is searched),
 * or an archive (unpacked into the extension's storage). Validated, saved to the
 * machine-scoped ffmpegPath setting. kind: 'file' or 'folder'. True when one was set.
 */
async function pickLocalFfmpeg(kind) {
  const win = process.platform === 'win32';
  const f = await vscode.window.showOpenDialog(kind === 'folder'
    ? { canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use the ffmpeg in this folder' }
    : { canSelectFiles: true, canSelectMany: false, openLabel: 'Use this ffmpeg', filters: win ? { 'ffmpeg or archive': ['exe', 'zip', '7z'], 'All files': ['*'] } : undefined });
  if (!f || !f.length) return false;
  let found;
  try {
    found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Video Preview: checking that ffmpeg…' },
      () => localff.resolveLocal(f[0].fsPath, { storageDir }));
  } catch (e) {
    const again = await vscode.window.showErrorMessage(`Video Preview: can't use that ffmpeg: ${e.message}`, 'Choose Another…');
    return again ? pickLocalFfmpeg(kind) : false;
  }
  log(`local ffmpeg: ${found.version} at ${found.ffmpeg}${found.unpackedTo ? ` (unpacked to ${found.unpackedTo})` : ''}`);
  await setSetting('ffmpegPath', found.ffmpeg, vscode.ConfigurationTarget.Global);
  return true;
}

/** globalState key of the downloaded build: per host in remote windows (globalState is shared with the client). */
function managedKey() { return remoteff.managedKey(vscode.env.remoteName); }

/** This extension host's OS and CPU; tests (VPE_LOG only) emulate a Linux remote with VPE_TEST_PLATFORM / VPE_TEST_ARCH. */
function hostPlatform() { return (logFile && process.env.VPE_TEST_PLATFORM) || process.platform; }
function hostArch() { return (logFile && process.env.VPE_TEST_ARCH) || process.arch; }
/** BtbN's release URL; tests (VPE_LOG only) point VPE_BTBN_URL at a fake server on 127.0.0.1. */
function buildBase() { return (logFile && process.env.VPE_BTBN_URL) || undefined; }

/**
 * Downloads build into this host's extension folder (in a remote window: the remote's, with only
 * ffmpeg and ffprobe unpacked), with progress and cancel, and records it. On a blocked network it
 * offers the user's own ffmpeg or the link. Returns the install, 'picked', or null (cancelled).
 * Other errors throw.
 */
async function downloadManaged(build) {
  const remote = vscode.env.remoteName;
  const abort = new AbortController();
  let res = null;
  try {
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${build.label}${remote ? ` on ${os.hostname()}` : ''}`, cancellable: true }, async (progress, token) => {
      let last = 0;
      token.onCancellationRequested(() => abort.abort());
      const onProgress = (fr) => {
        const pct = Math.round(fr * 100);
        if (pct > last) { progress.report({ increment: pct - last, message: `${pct}%` }); last = pct; }
      };
      return remote ? remoteff.installRemoteBuild(build, storageDir, onProgress, abort.signal) : setup.installBuild(build, storageDir, onProgress, abort.signal);
    });
  } catch (e) {
    if (abort.signal.aborted) { vscode.window.showInformationMessage('Video Preview: ffmpeg download cancelled.'); return null; }
    if (!proxy.looksBlocked(e)) throw e;
    log(`download blocked: ${e.stack || e}`);
    const next = await vscode.window.showErrorMessage(
      `Video Preview: the ffmpeg download didn't get through (${e.message}). Behind a proxy, set "http.proxy"; or download the build in a browser and choose it here.`,
      'Use an ffmpeg I already have…', 'Copy Download Link');
    if (next === 'Copy Download Link') { await vscode.env.clipboard.writeText(build.files[0].url); return null; }
    if (!next || !(await pickLocalFfmpeg('file'))) return null;
    return 'picked';
  }
  await globalState.update(managedKey(), { ffmpeg: res.ffmpeg, ffprobe: res.ffprobe, label: build.label });
  log(`downloaded ${build.label} to ${res.dir}`);
  return res;
}

/**
 * Remote windows (SSH, containers, tunnels): the picture of this file decodes in WebAssembly, the
 * remote stream would take it, and the remote has no ffmpeg. Offers BtbN's static Linux build
 * (x64, arm64) in the extension's folder there: once per remote and session, "Don't Show Again" per
 * remote (docs/notes/remote-stream.md).
 */
async function maybeOfferRemoteFfmpeg(sess, m) {
  const remote = vscode.env.remoteName;
  const c = config();
  const key = remoteff.remoteKey(remote);
  const ctx = () => ({
    remote, platform: hostPlatform(), arch: hostArch(), trusted: vscode.workspace.isTrusted,
    streamOn: c.transcode !== 'off', builtinOnly: c.decoder === 'builtin',
    askedThisSession: remoteOfferAsked, state: globalState.get(remoteff.OFFER_KEY), key, pending: remoteOfferPending || onboardPending,
  });
  if (!remoteff.shouldOffer(ctx())) return;
  if (await tools()) return;
  if (!remoteff.shouldOffer(ctx())) return; // another tab asked meanwhile
  remoteOfferAsked.add(key);
  remoteOfferPending = true;
  const host = os.hostname();
  const codec = typeof m.codec === 'string' && /^[\w-]{1,24}$/.test(m.codec) ? m.codec : '';
  let answer;
  try {
    log(`[${sess.name}] ${codec || 'video'} decodes in WebAssembly and ${host} has no ffmpeg: offering the download`);
    answer = await vscode.window.showInformationMessage(remoteff.offerText({ codec, host, mb: setup.downloadSizeMB('linux', hostArch()) }),
      remoteff.OFFER_DOWNLOAD, remoteff.OFFER_LATER, remoteff.OFFER_NEVER);
  } finally { remoteOfferPending = false; }
  await globalState.update(remoteff.OFFER_KEY, remoteff.afterOffer(globalState.get(remoteff.OFFER_KEY), key, answer));
  if (answer === remoteff.OFFER_DOWNLOAD) await downloadRemoteFfmpeg();
}

/** Picks the Linux build for this host's CPU, downloads it into the extension's folder here, and reloads open players. */
async function downloadRemoteFfmpeg() {
  const host = os.hostname();
  setup.setAgentFor(proxyAgent());
  let build;
  try {
    build = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Video Preview: finding the ffmpeg build for ${host}…` },
      () => remoteff.chooseRemoteBuild(hostArch(), { base: buildBase() }));
  } catch (e) {
    log(`remote ffmpeg: no build: ${e.stack || e}`);
    vscode.window.showErrorMessage(`Video Preview: no ffmpeg download for ${host}: ${e.message}${proxy.looksBlocked(e) ? ' (behind a proxy? set "http.proxy")' : ''}. Install ffmpeg there, or set "videoPreviewEnhanced.ffmpegPath".`);
    return;
  }
  let res;
  try { res = await downloadManaged(build); } catch (e) {
    log(`remote ffmpeg: download failed: ${e.stack || e}`);
    vscode.window.showErrorMessage(`Video Preview: the ffmpeg download on ${host} failed: ${e.message}`);
    return;
  }
  if (!res) return;
  toolsPromise = null;
  const nt = await tools();
  vscode.window.showInformationMessage(nt ? `Video Preview: ffmpeg ready on ${host} (${nt.version.replace(/ Copyright.*/, '')}). Videos the GPU can't decode stream from there now.` : `Video Preview: ffmpeg was downloaded on ${host} but does not run there; see the output log.`);
  for (const s of sessions) s.reload('ffmpeg changed');
}

const DRIVER_NOTICE_KEY = 'videoPreviewEnhanced.nvencDriverNotice';
let transcodeOfferPending = false;

/** Shows a one-time notice per ffmpeg binary + NVIDIA driver when NVENC refuses an older driver. */
function maybeShowDriverNotice(t, notice, nvidiaDriver) {
  if (!notice || !globalState) return;
  const key = `${t.ffmpeg}|${t.version || ''}|${nvidiaDriver || ''}`;
  const seen = globalState.get(DRIVER_NOTICE_KEY) || {};
  if (seen[key]) return;
  seen[key] = Date.now();
  globalState.update(DRIVER_NOTICE_KEY, seen).then(undefined, () => {});
  const text = transcodePolicy.driverNoticeText(notice);
  log(`[live transcode] ${text}`);
  vscode.window.showInformationMessage(text, 'Set Up Optional ffmpeg').then((ans) => {
    if (ans === 'Set Up Optional ffmpeg') setupFfmpeg();
  }, () => {});
}

/** First remote video when transcode is 'ask': let the user pick Live transcode vs original quality. */
async function maybeOfferRemoteTranscode(sess, remote, onAccept) {
  if (transcodeOfferPending || sess.disposed) return;
  transcodeOfferPending = true;
  let answer;
  try {
    answer = await vscode.window.showInformationMessage(
      transcodePolicy.remotePromptText(remote),
      transcodePolicy.REMOTE_PROMPT_YES,
      transcodePolicy.REMOTE_PROMPT_NO,
    );
  } finally { transcodeOfferPending = false; }
  if (answer === transcodePolicy.REMOTE_PROMPT_YES) {
    await setSetting('transcode', 'auto', vscode.ConfigurationTarget.Global);
    if (!sess.disposed && onAccept) onAccept();
  } else if (answer === transcodePolicy.REMOTE_PROMPT_NO) {
    await setSetting('transcode', 'off', vscode.ConfigurationTarget.Global);
  }
}

/** Shared hardware-first stream selection for the player and Compare. */
async function transcodeOptions(t, pr, c, remote, reprobe = true) {
  const hw = await machine().catch(() => null);
  const nvidiaDriver = hw && hw.nvidiaDriver;
  const [enc, audioEncoder] = await Promise.all([
    transcodeProbe.encoderFor(t, ff.run, globalState, log, { nvidiaDriver }),
    remote && pr.audio ? remotestream.audioEncoderFor(t) : null,
  ]);
  if (enc.driverNotice) maybeShowDriverNotice(t, enc.driverNotice, nvidiaDriver);
  if (!enc.encoder) return null;
  const decodeMethod = c.gpuDecoding === false ? 'none'
    : decide.nativeMethod(remote ? null : probeRecordFor(t), pr.video, true, hw).method;
  return {
    encoder: enc.encoder, device: enc.device, cpuEncoder: enc.cpu, audioEncoder, decodeMethod, remote,
    // Compare can exhaust simultaneous GPU sessions even when the cached open probe is valid.
    onEncoderFail: reprobe ? () => transcodeProbe.encoderFailed(t, enc, nvidiaDriver) : undefined,
  };
}

/** Local playback falling behind on raw frame transfer when transcode is 'ask': offer Live transcode. */
async function maybeOfferLocalTranscode(sess) {
  if (transcodeOfferPending || sess.disposed) return;
  transcodeOfferPending = true;
  let answer;
  try {
    answer = await vscode.window.showInformationMessage(
      transcodePolicy.localOfferText(),
      transcodePolicy.LOCAL_OFFER_YES,
      transcodePolicy.LOCAL_OFFER_KEEP,
      transcodePolicy.LOCAL_OFFER_NEVER,
    );
  } finally { transcodeOfferPending = false; }
  if (answer === transcodePolicy.LOCAL_OFFER_YES) {
    await setSetting('transcode', 'auto', vscode.ConfigurationTarget.Global);
    if (!sess.disposed) { sess.forceTranscode = true; sess.reload('live transcode accepted'); }
  } else if (answer === transcodePolicy.LOCAL_OFFER_NEVER) {
    await setSetting('transcode', 'off', vscode.ConfigurationTarget.Global);
  }
}

/**
 * Asks before downloading, showing exactly what comes from where (2026-11-20): the file's address
 * and checksum, licence, size and the target folder; "Show source" opens the release page in the
 * browser and asks again. Returns true for Download.
 */
async function confirmDownload(build) {
  const f = build.files[0] || {};
  const SHOW = 'Show source';
  const DL = 'Download';
  for (;;) {
    const detail = [
      `${build.label}, about ${build.sizeMB} MB, licence ${build.licence}, from ${build.source}.`,
      '',
      `File: ${f.url || f.name}`,
      f.sha256 ? `SHA-256: ${f.sha256} (checked after the download)` : 'Checked against the SHA-256 published next to it after the download.',
      build.page ? `Release page: ${build.page}` : '',
      '',
      `It goes into the extension's own folder (${path.join(storageDir, 'ffmpeg-builds')}): nothing is installed system-wide and no admin rights are needed. "Remove the downloaded ffmpeg" in the setup menu deletes it again.`,
    ].filter((l, i, a) => l || a[i - 1]).join('\n');
    const pick = await vscode.window.showInformationMessage('Download portable ffmpeg?', { modal: true, detail }, DL, ...(build.page ? [SHOW] : []));
    if (pick === SHOW) { await vscode.env.openExternal(vscode.Uri.parse(build.page)); continue; }
    return pick === DL;
  }
}

/** Setup for the optional native decoder: a build matched to this machine, or the user's own. */
async function setupFfmpeg() {
  const state = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Video Preview: checking this computer…' }, async () => {
    hwPromise = null;
    const info = await machine();
    toolsPromise = null;
    const t = await tools();
    let build = null;
    let buildError = '';
    setup.setAgentFor(proxyAgent());
    try { build = await setup.chooseBuild(info); } catch (e) { buildError = e.message; }
    return { info, t, build, buildError };
  });
  const { info, t, build, buildError } = state;
  // No ffmpeg on PATH: look where it is usually installed first, and offer the download only when
  // nothing is found (2026-11-20: the first popup never mentions a download).
  if (!t) {
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Video Preview: looking for ffmpeg on this computer…' },
      () => localff.findInstalled().catch(() => null));
    if (found) {
      try {
        const r = await localff.resolveLocal(found, { storageDir });
        await setSetting('ffmpegPath', r.ffmpeg, vscode.ConfigurationTarget.Global);
        log(`setup: found ffmpeg ${r.version} at ${r.ffmpeg}`);
        return finishSetup();
      } catch (e) { log(`setup: found ${found} but can't use it: ${e.message}`); }
    }
    if (build) {
      const DL = 'Download portable ffmpeg';
      const OWN = 'Use one I already have…';
      const MORE = 'More options…';
      const choice = await vscode.window.showInformationMessage('Video Preview: no ffmpeg found on this computer. Download portable ffmpeg?', {
        modal: true,
        detail: `About ${build.sizeMB} MB from ${build.source}, into the extension's own folder: nothing is installed system-wide and no admin rights are needed. The next step shows the exact file and its checksum.`,
      }, DL, OWN, MORE);
      try {
        if (choice === DL) { if (!(await confirmDownload(build)) || !(await downloadManaged(build))) return; return finishSetup(); }
        if (choice === OWN) { if (!(await pickLocalFfmpeg('file'))) return; return finishSetup(); }
      } catch (e) {
        vscode.window.showErrorMessage(`Video Preview setup failed: ${e.message}`);
        log(`setup failed: ${e.stack || e}`);
        return;
      }
      if (choice !== MORE) return;
    }
  }
  const gpus = info.gpus.map((g) => `${g.name}${g.driver ? ` (driver ${g.driver})` : ''}`).join(', ') || 'no GPU found';
  const now = t ? `${t.version.replace(/ Copyright.*/, '')} [${t.source}]` : 'not installed — the built-in decoder plays everything up to about 1080p';
  const items = [];
  if (build) {
    items.push({
      id: 'build', label: `$(cloud-download) Download portable ffmpeg${t ? '' : '  (recommended)'}`, description: `${build.label}, ~${build.sizeMB} MB from ${build.source}, no admin rights`,
      detail: `Real-time 4K, HEVC 10-bit, AV1 and ProRes. ${build.note ? `${build.note}. ` : ''}Checked against the SHA-256 listed in the same release; stored in the extension's folder.`,
    });
  } else {
    const blocked = buildError && proxy.looksBlocked({ message: buildError });
    items.push({ id: 'none', label: '$(warning) No ffmpeg download available', detail: `${buildError}${blocked ? ' (blocked? set http.proxy, or download ffmpeg in a browser and use it below)' : ''}` });
  }
  items.push({
    id: 'pickFile', label: '$(file-binary) Use an ffmpeg I already have…', description: process.platform === 'win32' ? 'ffmpeg.exe, or a downloaded .zip / .7z' : 'ffmpeg, or a downloaded archive',
    detail: 'ffprobe is looked up next to it; an archive is unpacked into the extension\'s folder.',
  });
  items.push({ id: 'pickFolder', label: '$(folder) Use an ffmpeg folder I already have…', detail: 'A folder with ffmpeg and ffprobe in it or in its bin/ folder (an unpacked build).' });
  items.push({ id: 'pm', label: '$(terminal) Install ffmpeg with the package manager', description: setup.packageManagerCommand(), detail: 'Opens a terminal with the command typed in; you press Enter. May need admin rights.' });
  if (t) items.push({ id: 'retest', label: '$(beaker) Re-test ffmpeg on this computer', detail: 'Measures each GPU decoding method with short test clips (a minute or two, in the background).' });
  if (t && t.source === 'downloaded') items.push({ id: 'remove', label: '$(trash) Remove the downloaded ffmpeg' });
  items.push({ id: 'keep', label: '$(check) Keep current setup', detail: `Native ffmpeg: ${now}` });
  const pick = await vscode.window.showQuickPick(items, {
    title: `Video Preview: optional ffmpeg · ${process.platform} ${process.arch} · ${gpus}`,
    placeHolder: `Native ffmpeg now: ${now}`, matchOnDetail: true, ignoreFocusOut: true,
  });
  if (!pick || pick.id === 'keep' || pick.id === 'none') return;
  if (pick.id === 'retest') { retestFfmpeg(); return; }
  try {
    if (pick.id === 'build') {
      if (!(await confirmDownload(build))) return;
      const res = await downloadManaged(build);
      if (!res) return;
    } else if (pick.id === 'pm') {
      const term = vscode.window.createTerminal('Install ffmpeg');
      term.show();
      term.sendText(setup.packageManagerCommand(), false);
      vscode.window.showInformationMessage('Press Enter in the terminal to install ffmpeg, then run "Video Preview: Re-test ffmpeg".');
      return;
    } else if (pick.id === 'pickFile' || pick.id === 'pickFolder') {
      if (!(await pickLocalFfmpeg(pick.id === 'pickFolder' ? 'folder' : 'file'))) return;
    } else if (pick.id === 'remove') {
      await globalState.update(managedKey(), undefined);
      await fs.promises.rm(path.join(storageDir, 'ffmpeg-builds'), { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Video Preview setup failed: ${e.message}`);
    log(`setup failed: ${e.stack || e}`);
    return;
  }
  return finishSetup();
}

/** After a setup step: look for ffmpeg again, say so, and reopen the open videos with it. */
async function finishSetup() {
  toolsPromise = null;
  const nt = await tools();
  vscode.window.showInformationMessage(nt ? `Video Preview: ffmpeg is set up (${nt.version.replace(/ Copyright.*/, '')}).` : 'Video Preview: ffmpeg not found yet');
  for (const sess of sessions) sess.reload('ffmpeg changed');
  // No automatic GPU test after setup either; "Video Preview: Re-test ffmpeg" runs it on request.
}

/** The bundled decode-only libav.js build (media/libav-vpe, LGPL). */
function libavBuild(extUri) {
  const dir = vscode.Uri.joinPath(extUri, 'media', 'libav-vpe');
  const loader = fs.readdirSync(dir.fsPath).find((n) => /^libav-[\d.]+-vpe\.js$/.test(n));
  return { dir, loader, variant: 'vpe' };
}

// MP4/WebM: VS Code's built-in preview also claims them, so the player is only an "option" for these
// (package.json). Every other supported format is priority "default" already. On first activation the
// player is made the default for these too, by writing workbench.editorAssociations (user settings).
const DEFAULT_PATTERNS = ['*.mp4', '*.webm', '*.MP4', '*.WEBM'];
const OURS = 'videoPreviewEnhanced.playerOptional';
const AUTO_DEFAULT_KEY = 'videoPreviewEnhanced.autoDefault';
const isOurs = (v) => typeof v === 'string' && v.startsWith('videoPreviewEnhanced.');

/** User-level associations only (workspace values are never copied into user settings). */
function userAssociations() {
  const i = vscode.workspace.getConfiguration('workbench').inspect('editorAssociations') || {};
  const g = i.globalValue;
  return g && typeof g === 'object' && !Array.isArray(g) ? { ...g } : {};
}
function effectiveAssociation(p) {
  const all = vscode.workspace.getConfiguration('workbench').get('editorAssociations');
  return all && typeof all === 'object' && !Array.isArray(all) ? all[p] : undefined;
}

/**
 * The command: fills every MP4/WebM pattern that is missing (an entry the user set to another editor
 * stays). on=false removes only entries pointing at this player. Returns the patterns changed.
 */
async function makeDefault(on, { silent = false } = {}) {
  const assoc = userAssociations();
  const changed = [];
  for (const p of DEFAULT_PATTERNS) {
    if (on) { if (assoc[p] === undefined) { assoc[p] = OURS; changed.push(p); } }
    else if (isOurs(assoc[p])) { delete assoc[p]; changed.push(p); }
  }
  try {
    if (changed.length) await vscode.workspace.getConfiguration('workbench').update('editorAssociations', assoc, vscode.ConfigurationTarget.Global);
  } catch (e) {
    log(`editorAssociations: write failed: ${e && e.message || e}`);
    return [];
  }
  if (!silent) vscode.window.showInformationMessage(on
    ? 'Video Preview Enhanced now opens MP4 and WebM files. Undo with "Video Preview: Use VS Code\'s Preview for MP4/WebM".'
    : 'MP4 and WebM open in VS Code\'s own preview again.');
  return changed;
}

/** Undo: removes our entries and forgets what autoDefault added (patterns stay "seen": it never re-adds them). */
async function undoDefault({ silent = false } = {}) {
  await makeDefault(false, { silent });
  const st = globalState.get(AUTO_DEFAULT_KEY);
  if (st) await globalState.update(AUTO_DEFAULT_KEY, { ...st, added: [] });
}

/**
 * Once per install, and again when an update adds patterns: fills workbench.editorAssociations for the
 * patterns VS Code's built-in preview claims, without asking. A pattern the user already set (to anything,
 * in any scope) is left alone. Runs in untrusted workspaces too: it only touches user settings.
 * State: { seen: patterns handled, added: patterns written by us }.
 */
async function autoDefault() {
  try {
    const st = globalState.get(AUTO_DEFAULT_KEY) || { seen: [], added: [] };
    const todo = DEFAULT_PATTERNS.filter((p) => !st.seen.includes(p));
    if (!todo.length) return;
    const assoc = userAssociations();
    const added = [];
    for (const p of todo) {
      if (assoc[p] === undefined && effectiveAssociation(p) === undefined) { assoc[p] = OURS; added.push(p); }
    }
    if (added.length) await vscode.workspace.getConfiguration('workbench').update('editorAssociations', assoc, vscode.ConfigurationTarget.Global);
    await globalState.update(AUTO_DEFAULT_KEY, { seen: [...st.seen, ...todo], added: [...st.added, ...added] });
    // No notification: installing this extension is the request for a better video preview.
    // The command "Use VS Code's Preview for MP4/WebM" (undoDefault) still reverts it.
    if (added.length) log(`default viewer for ${added.join(', ')} (undo: the "Use VS Code's Preview for MP4/WebM" command)`);
  } catch (e) {
    log(`autoDefault failed: ${e && e.message || e}`); // never shown; the command still works
  }
}

// ---- file icons ----
// Seti (VS Code's default file icon theme) gives only some video extensions its pink video icon. The manifest
// contributes a language "vpe-video" (no extensions of its own, no name, so not in the language picker) whose icon
// is a copy of Seti's; this maps the rest of the player's formats to it with files.associations (user settings).
// Not .mts (TypeScript's module extension, so a mapping would break .mts source files) and not .ts.
const FILE_ICON_EXTS = ['mkv', 'flv', 'mpeg', 'm2ts', 'wmv', '3gp', 'm4v', 'vob', 'divx', 'asf', 'mxf', 'y4m'];
const FILE_ICON_LANG = 'vpe-video';
const FILE_ICONS_KEY = 'videoPreviewEnhanced.fileIcons'; // globalState: { added: [patterns we wrote], seen: [patterns handled] }

async function fileIcons({ force = false } = {}) {
  try {
    const on = vscode.workspace.getConfiguration('videoPreviewEnhanced').get('overrideFileIcons', true);
    const cfg = vscode.workspace.getConfiguration('files');
    const g = (cfg.inspect('associations') || {}).globalValue;
    const assoc = g && typeof g === 'object' && !Array.isArray(g) ? { ...g } : {};
    const eff = cfg.get('associations');
    const st = globalState.get(FILE_ICONS_KEY) || { added: [], seen: [] };
    let added = [...st.added];
    let seen = [...st.seen];
    let changed = false;
    if (on) {
      for (const ext of FILE_ICON_EXTS) {
        const p = `*.${ext}`;
        if (!force && seen.includes(p)) continue; // the user may have removed it on purpose
        if (!seen.includes(p)) seen.push(p);
        const other = eff && typeof eff === 'object' && !Array.isArray(eff) ? eff[p] : undefined;
        if (assoc[p] === undefined && other === undefined) { assoc[p] = FILE_ICON_LANG; if (!added.includes(p)) added.push(p); changed = true; }
      }
    } else {
      for (const p of added) if (assoc[p] === FILE_ICON_LANG) { delete assoc[p]; changed = true; }
      added = [];
      seen = [];
    }
    if (changed) await cfg.update('associations', assoc, vscode.ConfigurationTarget.Global);
    // Every window start runs this: write only when the record changed (a globalState write is a disk round trip).
    if (JSON.stringify(st) !== JSON.stringify({ added, seen })) await globalState.update(FILE_ICONS_KEY, { added, seen });
  } catch (e) {
    log(`fileIcons failed: ${e && e.message || e}`); // never shown
  }
}
// ---- end file icons ----

/** Export commands: ask the active player for its A-B range (it replies with 'exportRange' or 'ffmpegRange'). */
function askRange(then) {
  const s = [...sessions].find((x) => x.panel.active) || (lastActive && !lastActive.disposed ? lastActive : null);
  if (!s || s.sequence) {
    vscode.window.showInformationMessage(s ? 'Video Preview: frame export works for video files.' : 'Video Preview: open a video and set an A-B loop (A and B keys) first.');
    return undefined;
  }
  s.post({ type: 'abQuery', then });
  return undefined;
}

function askClipRange(compare) {
  const target = [...(compare ? compareSessions : sessions)].find((s) => s.panel.active);
  if (target) target.post({ type: 'abQuery', then: 'clip' });
  else vscode.window.showInformationMessage('Video Preview: open a video or Compare and mark an A-B range first.');
}

async function exportClips(session, jobs, source, compare = false) {
  if (clipExports.has(session)) return;
  if (!source || session.url || session.sequence || !FS_SCHEMES.has(source.scheme)) {
    vscode.window.showInformationMessage('Video Preview: clip export requires a video file on this host.');
    return;
  }
  if (!jobs.length) {
    vscode.window.showInformationMessage('Video Preview: set an A-B loop first with A and B.');
    return;
  }
  const refusal = syntheticRefusal(jobs, session.liveTranscodeTiles ? session.liveTranscodeTiles() : [], compare);
  if (refusal) {
    // Marks without source timestamps: refuse before any ffmpeg work, and offer the switch in one click.
    const answer = await vscode.window.showWarningMessage(refusal.message, ...(refusal.label ? [refusal.label] : []));
    if (answer && answer === refusal.label && !session.disposed) session.useOriginalForClips(refusal.tiles);
    return;
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Video Preview: clip export requires native ffmpeg in a trusted workspace.');
    return;
  }
  clipExports.add(session);
  try {
    const native = await tools();
    if (!native) {
      const setup = 'Set Up Optional ffmpeg';
      const answer = await vscode.window.showInformationMessage(
        'Video Preview: A-B clip export requires native ffmpeg and ffprobe on this host.', setup,
      );
      if (answer === setup) await vscode.commands.executeCommand('videoPreviewEnhanced.setupFfmpeg');
      return;
    }
    const testDir = logFile && process.env.VPE_CLIP_EXPORT_DIR;
    await clipExport.exportClips({
      vscode, tools: native, jobs, compare, defaultUri: vscode.Uri.joinPath(source, '..'), log,
      announce: (message) => session.post({ type: 'toast', text: message, ms: 5000 }),
      testFolder: testDir ? vscode.Uri.file(testDir) : undefined,
      testConfirm: !!testDir && process.env.VPE_CLIP_EXPORT_CONFIRM === '1',
    });
  } catch (e) {
    log(`A–B export failed: ${e.message}`);
    vscode.window.showErrorMessage(`Video Preview: A–B export failed. ${e.message}`);
  } finally {
    clipExports.delete(session);
  }
}

/**
 * Memory budgets for this machine (media/membudget.js): from os.totalmem() and os.freemem() in local
 * windows. Remote windows: null (this host is the remote machine; the webview sizes from its own
 * navigator.deviceMemory). Tests (VPE_LOG only): VPE_TOTALMEM emulates a machine with that many bytes.
 */
function memBudgets(forNative = false) {
  const emulated = logFile && Number(process.env.VPE_TOTALMEM) > 0 ? Number(process.env.VPE_TOTALMEM) : 0;
  // WSL's native queue lives on the host, even though its webview is on the client.
  if (!emulated && vscode.env.remoteName && !(forNative && nativeAllowedHere())) return null;
  // macOS reports only wholly free pages (its file cache counts as used), so a healthy Mac would look
  // nearly full: size it from the total alone (review 2026-11-19-3 M4).
  const free = process.platform === 'darwin' ? undefined : os.freemem();
  return membudget.budgets(emulated ? membudget.basisGB(emulated) : membudget.basisGB(os.totalmem(), free));
}

function nativeQueue() { return (memBudgets(true) || membudget.budgets(null)).nativeQueue; }

let T_ACTIVATE = 0;
let T_ACTIVATED = 0;

// ---- Open Video URL… (src/urlsource.js, docs/notes/url-stream.md) ----

/** The webview panel type of a URL player (not a custom editor: there is no file). */
const URL_VIEW_TYPE = 'videoPreviewEnhanced.url';

/**
 * Asks for a URL in VS Code's own input (the recent list first, when there is one). The URL only ever
 * comes from here: typed, pasted (the clipboard pre-fills the box when it holds an http(s) URL, for the
 * user to confirm) or picked from URLs entered here before. Resolves the checked URL or undefined.
 */
async function promptUrl() {
  const recent = urlsource.recentUrls(globalState);
  if (recent.length) {
    const NEW = { label: '$(link) Enter a URL…', alwaysShow: true };
    const pick = await vscode.window.showQuickPick([NEW, ...recent.map((u) => ({ label: urlsource.displayName(u), description: urlsource.redact(u), url: u }))], {
      placeHolder: 'Open a video URL: enter a new one or pick a recent one', matchOnDescription: true,
    });
    if (!pick) return undefined;
    if (pick.url) return pick.url;
  }
  let clip = '';
  try { clip = (await vscode.env.clipboard.readText()).trim(); } catch { /* no clipboard */ }
  const text = await vscode.window.showInputBox({
    title: 'Open Video URL',
    prompt: 'A direct link to a video file (MP4, WebM, MKV…) or an HLS (.m3u8) / DASH (.mpd) stream. http:// and https:// only.',
    placeHolder: 'https://example.com/video.mp4',
    value: !urlsource.checkUrl(clip).error ? clip : '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? urlsource.checkUrl(v).error || null : null),
  });
  if (text === undefined || !text.trim()) return undefined;
  const c = urlsource.checkUrl(text);
  if (c.error) { vscode.window.showWarningMessage(`Video Preview: ${c.error}`); return undefined; }
  return c.url;
}

/** The first workspace folder (a default for dialogs of URL players, which have no folder), or undefined. */
function workspaceFolder() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri : undefined;
}

/** A file-name stem for frames saved from a URL player. */
function urlBase(url) {
  return urlsource.displayName(url).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video';
}

/** Network options for src/urlsource.js: proxy (http.proxy / HTTPS_PROXY, like the ffmpeg download) and the variant cap. */
function netOpts() {
  const h = vscode.workspace.getConfiguration('http');
  const cfg = { proxy: h.get('proxy') || '', strictSSL: h.get('proxyStrictSSL', true), env: process.env };
  return { agentFor: proxy.agentFactory(cfg), proxyFor: (u) => proxy.proxyFor(u, cfg), maxHeight: 1080 };
}

/** The log's words for an HLS plan: the variant and how it was chosen. */
function hlsPlanText(plan) {
  if (!plan.master) return plan.playlist.encrypted ? ', AES-128' : '';
  const v = plan.variant;
  const rate = plan.throughput ? `, measured ${(plan.throughput / 1e6).toFixed(1)} Mb/s` : '';
  return `, ${plan.variants.length} variants, ${plan.auto ? 'auto' : 'chosen'}: ${v.width}x${v.height} ${v.bandwidth} b/s${rate}` +
    `${plan.master.media.length ? `, ${plan.master.media.length} renditions` : ''}${plan.master.iframes.length ? `, ${plan.master.iframes.length} I-frame playlists` : ''}${plan.playlist.encrypted ? ', AES-128' : ''}`;
}

/** The first 256 KB of an HLS plan's stream (init segment and first segment), for urlsource.streamStart. */
async function firstBytes(plan, opts) {
  const pl = plan.playlist;
  const s = pl.segments[0];
  if (!s || pl.encrypted) return Buffer.alloc(0);
  const get = async (url, range, max) => {
    const a = range ? range.start : 0;
    const n = range ? Math.min(range.len, max) : max;
    const r = await urlsource.fetchRange(url, a, a + n - 1, { ...opts, maxBody: 64 * 1024 * 1024 });
    return r.status === 200 ? r.body.subarray(a, a + n) : r.body;
  };
  const init = pl.map ? await get(pl.map.url, pl.map.range, 64 * 1024) : Buffer.alloc(0);
  return Buffer.concat([init, await get(s.url, s.range, 256 * 1024)]);
}

/**
 * Opens a player panel for a URL the user entered (checked again here). where: 'active' (this editor group),
 * 'side' (the group beside it, as VS Code's "Open to the Side") or 'window' (a new window: the panel opens
 * here, then VS Code moves it with workbench.action.moveEditorToNewWindow).
 */
async function openUrl(context, url, where = 'active') {
  const c = urlsource.checkUrl(url);
  if (c.error) { vscode.window.showWarningMessage(`Video Preview: ${c.error}`); return undefined; }
  await urlsource.rememberUrl(globalState, c.url);
  const column = where === 'side' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  const panel = vscode.window.createWebviewPanel(URL_VIEW_TYPE, urlsource.displayName(c.url), { viewColumn: column, preserveFocus: false }, { retainContextWhenHidden: true, enableFindWidget: false });
  panel.iconPath = new vscode.ThemeIcon('globe');
  const sess = new Session(context, { url: c.url }, panel);
  if (where === 'window') {
    // The new panel is the active editor: move it (the webview moves with its context kept).
    try { await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); }
    catch (e) { log(`open URL in a new window: ${e && e.message || e}`); }
  }
  log(`[${sess.name}] URL tab opened (${where})`);
  await sess.show();
  return sess;
}

function activate(context) {
  T_ACTIVATE = Date.now();
  out = vscode.window.createOutputChannel('Video Preview Enhanced');
  globalState = context.globalState;
  hwKnown = globalState.get(HW_KEY) || null;
  // A method guessed from the stored GPUs produced no picture: maybe another GPU or driver now; detect again.
  onGuessFailed(() => { hwStale = true; hwPromise = null; });
  storageDir = context.globalStorageUri.fsPath;
  extensionDir = context.extensionUri.fsPath;

  const provider = {
    openCustomDocument: (uri) => ({ uri, dispose() {} }),
    resolveCustomEditor: (doc, panel) => {
      if (logFile) log(`[${path.basename(doc.uri.path)}] player resolve started`);
      // Add mode (docs/notes/compare-ui.md): the video goes into compare, and this new tab closes unused.
      if (compareApi && compareApi.claimOpen(doc.uri)) { setTimeout(() => panel.dispose(), 0); return undefined; }
      // Several videos opened at once (an Explorer multi-selection) become one compare (src/burst.js).
      const noted = !!compareApi && compareApi.noteOpen(doc.uri, { panel });
      const session = new Session(context, { uri: doc.uri }, panel);
      // Opened with others within a moment: compare takes these videos, so the heavy start-up (page, decoder, ffprobe) waits
      // for its verdict and never happens for them. A video opened alone starts at once (one macrotask later).
      const hold = noted ? compareApi.holdOpen(doc.uri) : null;
      if (!hold) return session.show();
      return hold.then((taken) => (taken ? undefined : session.show()));
    },
  };
  for (const viewType of VIEW_TYPES) {
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('videoPreviewEnhanced.openWith', (uri) => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) vscode.commands.executeCommand('vscode.openWith', target, 'videoPreviewEnhanced.player');
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.playSequence', async (uri) => {
      let target = uri;
      if (!target) {
        const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, openLabel: 'Play sequence' });
        if (!pick) return;
        target = pick[0];
      }
      const seq = await findSequence(target.fsPath);
      if (!seq) {
        vscode.window.showWarningMessage('Video Preview: no numbered image sequence found there (needs at least two files like frame_0001.png).');
        return;
      }
      const panel = vscode.window.createWebviewPanel('videoPreviewEnhanced.sequence', seq.name, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
      panel.iconPath = new vscode.ThemeIcon('device-camera-video');
      await new Session(context, { uri: target, sequence: seq }, panel).show();
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.showLog', () => out.show()),
    // Arguments are ignored: the URL comes from the input box only (never from a command link or a page).
    vscode.commands.registerCommand('videoPreviewEnhanced.openUrl', async () => {
      const url = await promptUrl();
      if (url) await openUrl(context, url);
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.openUrlToSide', async () => {
      const url = await promptUrl();
      if (url) await openUrl(context, url, 'side');
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.openUrlInNewWindow', async () => {
      const url = await promptUrl();
      if (url) await openUrl(context, url, 'window');
    }),
    vscode.window.registerUriHandler({ handleUri: (uri) => openLink(uri).catch((e) => log(`link failed: ${e && e.stack || e}`)) }),
    vscode.commands.registerCommand('videoPreviewEnhanced.setupFfmpeg', () => setupFfmpeg()),
    vscode.commands.registerCommand('videoPreviewEnhanced.retestFfmpeg', () => retestFfmpeg()),
    vscode.commands.registerCommand('videoPreviewEnhanced.makeDefault', () => makeDefault(true)),
    vscode.commands.registerCommand('videoPreviewEnhanced.undoDefault', () => undoDefault()),
    vscode.commands.registerCommand('videoPreviewEnhanced.loadSubtitles', () => {
      const s = [...sessions].find((x) => x.panel.active) || (lastActive && !lastActive.disposed ? lastActive : null);
      if (s) return s.loadSubtitles();
      vscode.window.showInformationMessage('Video Preview: open a video first, then load subtitles for it.');
      return undefined;
    }),
    // ---- A-B export: the page answers 'abQuery' with its range, then the host runs it ----
    vscode.commands.registerCommand('videoPreviewEnhanced.exportRange', () => askRange('export')),
    vscode.commands.registerCommand('videoPreviewEnhanced.copyFfmpegRange', () => askRange('ffmpeg')),
    vscode.commands.registerCommand('videoPreviewEnhanced.exportVideoRange', () => askClipRange(false)),
    vscode.commands.registerCommand('videoPreviewEnhanced.exportCompareVideoRange', () => askClipRange(true)),
    // ---- end A-B export ----
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('videoPreviewEnhanced.ffmpegPath')) toolsPromise = null;
      if (e.affectsConfiguration('videoPreviewEnhanced.gpuDecoding')) probeChecked = false;
      // Cheap to apply at once: larger frames with a seek to the same moment, smaller ones at the next seek.
      if (e.affectsConfiguration('videoPreviewEnhanced.sizeFramesToView')) for (const s of sessions) if (s.native && s.native.setFit) s.native.setFit(fitsView());
      if (e.affectsConfiguration('videoPreviewEnhanced.overrideFileIcons')) fileIcons({ force: true });
      if (Object.keys(PREFS).some((k) => e.affectsConfiguration(`videoPreviewEnhanced.${k}`))
        || e.affectsConfiguration('videoPreviewEnhanced.transcode')
        || e.affectsConfiguration('videoPreviewEnhanced.transcodeMaxBitrate')
        || e.affectsConfiguration('videoPreviewEnhanced.transcodeSplitBitrate')
        || e.affectsConfiguration('videoPreviewEnhanced.remoteStream')) {
        const c = config();
        if (e.affectsConfiguration('videoPreviewEnhanced.transcodeMaxBitrate')) {
          for (const s of sessions) {
            if (s.native instanceof remotestream.EncodedStream) {
              s.native.setMaxBitrateMbps(c.transcodeMaxBitrate);
            }
          }
        }
        const msg = { type: 'prefs', prefs: prefsOf(c) };
        for (const sess of [...sessions, ...compareSessions]) sess.post(msg);
        for (const sess of compareSessions) sess.updateTranscode(msg.prefs);
      }
    }),
    { dispose: flushSpeeds },
    { dispose: flushView },
    { dispose: () => {
      for (const s of [...compareSessions]) s.dispose();
      frameserver.stop();
    } },
    out,
  );
  autoDefault();
  fileIcons();

  // ---- Compare and Add to Compare (src/compare.js) ----
  let testCompareFiles;
  compareApi = registerCompare(context, {
    vscode, log, sessions, compareSessions, nativeTransport, nativeQueue, exportClips,
    compareOpenChanged: () => { for (const session of sessions) session.sendCompareOpen(); },
    showOpenDialog: logFile ? (options) => {
      const files = testCompareFiles;
      testCompareFiles = undefined;
      return files || vscode.window.showOpenDialog(options);
    } : undefined,
    lastActivePlayer: () => lastActive,
    // Videos compared lately (uri strings): the quick pick on key D lists them first.
    recent: { get: () => (globalState && globalState.get('videoPreviewEnhanced.compareRecent')) || [], set: (v) => globalState && globalState.update('videoPreviewEnhanced.compareRecent', v) },
    // Compare's bar and panels are the player's: the same jump sizes, written the same way.
    prefs: () => prefsOf(config()),
    setPlaybackPrefs: (m, from) => rememberPlaybackPrefs(m, from),
    setTranscodePref: (key, value) => setSetting(key, value, vscode.ConfigurationTarget.Global),
    offerTranscode: (sess) => maybeOfferRemoteTranscode(sess, vscode.env.remoteName),
    setPref: (key, value) => (PREFS[key] && PREFS[key].values.includes(value) ? setSetting(key, value, prefTarget(key)) : undefined),
    // Leave compare: the player takes compare's place, at the kept video's moment.
    openPlayer: async (uri, t, viewColumn) => {
      const key = uri.with({ fragment: '' }).toString();
      if (t > 0) pendingGoto.set(key, { g: { t }, until: Date.now() + PENDING_GOTO_MS });
      const viewType = /\.(mp4|webm)$/i.test(uri.path) ? 'videoPreviewEnhanced.playerOptional' : 'videoPreviewEnhanced.player';
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { viewColumn, preview: false });
    },
    engineCfg: (w) => {
      const build = libavBuild(context.extensionUri);
      const base = w.asWebviewUri(build.dir).toString();
      return {
        workerUrl: w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'decoder-worker.js')).toString(),
        libavBase: base, loader: `${base}/${build.loader}`, variant: build.variant,
        remote: !!vscode.env.remoteName, whenSlow: 'every', debug: !!logFile,
        wcFailed: [...wcFailed],
        mem: memBudgets(), // the whole machine's; media/compare.js shares it among the tiles (review 2026-11-19-3 M3)
      };
    },
    // Compare shares probe and decoder policy with the player, then sizes the tile in the panel.
    nativeFor: async (file, transport, tile) => {
      const c = config();
      const remote = vscode.env.remoteName;
      const rawAllowed = nativeAllowedHere();
      if (c.decoder === 'builtin' || !vscode.workspace.isTrusted || (!rawAllowed && c.transcode === 'off')) return null;
      const t = await tools();
      if (!t) return null;
      const [pr] = await Promise.all([ff.probe(t, file), rawAllowed ? gpusForMethod(t, c) : null]);
      const stat = await fs.promises.stat(file);
      const failed = decide.failedBefore(globalState.get(decide.FAILED_KEY), file, stat);
      const maxStreamHeight = c.nativeMaxAuto ? decide.FRAME_SERVER_HEIGHT : c.nativeMaxHeight;
      if (!failed && c.transcode !== 'off' && pr.video) {
        const remoteLink = !!remote && remote !== 'wsl';
        const decision = transcodePolicy.shouldTranscodeOnOpen({
          mode: c.transcode, remote, video: pr.video, compare: true,
          maxBitrateMbps: c.transcodeMaxBitrate, viewHeight: tile && tile.h,
        });
        if (decision.action === 'prompt_remote') return { promptTranscode: true };
        if (decision.action === 'stream') {
          const stream = await transcodeOptions(t, pr, c, remoteLink, false);
          if (stream) return { tools: t, probed: pr, maxHeight: maxStreamHeight, stream };
        }
      }
      if (!rawAllowed) return null;
      const messageMaxHeight = nativeHeights(c).message;
      const maxHeight = transport === 'message' ? messageMaxHeight : c.nativeMaxAuto ? decide.FRAME_SERVER_HEIGHT : c.nativeMaxHeight;
      const d = decide.decide({
        setting: c.decoder, remote, trusted: true, tools: t, video: pr.video, probe: probeRecordFor(t), hw: hwKnown,
        failed, gpu: c.gpuDecoding, maxHeight,
        transport: transport === 'message' ? 'message' : 'stream',
      });
      return { tools: d.use === 'native' ? t : null, probed: pr, method: d.method, methodGuessed: !!d.guessed, maxHeight, messageMaxHeight, reason: d.reason };
    },
  });
  // ---- end compare mode ----

  // Test hook: with VPE_LOG set, JSON lines appended to <log>.cmd are sent to
  // open players (debug actions) or run as commands.
  if (logFile) {
    const cmdFile = `${logFile}.cmd`;
    let seen = 0;
    fs.watchFile(cmdFile, { interval: 300 }, () => {
      fs.readFile(cmdFile, 'utf8', (err, text) => {
        if (err) return;
        const lines = text.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
        for (const line of lines.slice(seen)) {
          try {
            const c = JSON.parse(line);
            if (c.command) {
              if (DEBUG_COMMANDS.has(c.command)) vscode.commands.executeCommand(c.command, c.arg ? vscode.Uri.file(c.arg) : undefined);
              else log(`debug command not allowed: ${c.command}`);
              continue;
            }
            if (c.openUrl) { openUrl(context, String(c.openUrl), c.where === 'side' || c.where === 'window' ? c.where : 'active').catch((e) => log(`debug openUrl: ${e && e.stack || e}`)); continue; } // tests: skips the input box
            if (c.compareFiles) { // 2-4 files into compare: the command takes the selection form (uri, uris)
              const list = c.compareFiles.map((f) => vscode.Uri.file(f));
              vscode.commands.executeCommand('videoPreviewEnhanced.compare', list[0], list);
              continue;
            }
            if (c.startCompare || c.addToCompare) { // primary resource, then the selection
              const action = c.startCompare ? 'startCompare' : 'addToCompare';
              const list = c[action].map((f) => vscode.Uri.file(f));
              vscode.commands.executeCommand(`videoPreviewEnhanced.${action}`, list[0], list.length > 1 ? list : undefined)
                .then(() => log(`debug done ${c.id || ''} ${action}`), (e) => log(`debug ${action} failed: ${e.message}`));
              continue;
            }
            if (c.pickCompare) { // tests: the next compare quick pick logs its rows and picks one (label part, or Browse…)
              setPickHook(async (items) => {
                setPickHook(null);
                log(`debug comparepick ${JSON.stringify(items.map((i) => i.label))}`);
                return items.find((i) => i.uri && i.label.includes(c.pickCompare)) || undefined;
              });
              continue;
            }
            if (c.openFile) { // tests: opens a file as an Explorer click would (a preview tab in the active group)
              vscode.commands.executeCommand('vscode.open', vscode.Uri.file(c.openFile), { preview: c.preview !== false, preserveFocus: c.preserveFocus !== false })
                .then(() => log(`debug done ${c.id || ''} openFile`), (e) => log(`debug openFile failed: ${e && e.message || e}`));
              continue;
            }
            if (c.openWithBurst) { // tests: several files opened at once through vscode.openWith, as an Explorer multi-selection does
              for (const f of c.openWithBurst) vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(f), c.viewType || 'videoPreviewEnhanced.player', { preview: false, preserveFocus: true }).then(undefined, (e) => log(`debug openWithBurst failed: ${e && e.message || e}`));
              continue;
            }
            if (c.compareAdd) { for (const s of compareSessions) s.addUris(c.compareAdd.map((f) => vscode.Uri.file(f))); continue; }
            // Scenario tests (test/vscode/scenarios.js) run many checks in one VS Code: between them they change
            // user settings, the extension host's environment (the VPE_* test switches, PATH) and clear the stored
            // state, as a fresh profile would have. Each answers "debug done <id>" once applied.
            if (c.settings) {
              const cfg = vscode.workspace.getConfiguration();
              Promise.all(Object.entries(c.settings).map(([k, v]) => cfg.update(k, v === null ? undefined : v, vscode.ConfigurationTarget.Global)))
                .then(() => log(`debug done ${c.id} settings`), (e) => log(`debug done ${c.id} settings failed: ${e && e.message || e}`));
              continue;
            }
            if (c.env) {
              for (const [k, v] of Object.entries(c.env)) { if (v === null) delete process.env[k]; else process.env[k] = String(v); }
              toolsPromise = null; // PATH may have gained or lost ffmpeg
              log(`debug done ${c.id} env`);
              continue;
            }
            if (c.resetState) {
              const keys = context.globalState.keys();
              Promise.all(keys.map((k) => context.globalState.update(k, undefined)))
                .then(() => log(`debug done ${c.id} resetState ${keys.length}`), (e) => log(`debug done ${c.id} resetState failed: ${e && e.message || e}`));
              continue;
            }
            if (c.tabs) { // the editor tabs, for tests (compare takes a player's place)
              const tabs = vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => ({ label: t.label, active: t.isActive, viewType: t.input && t.input.viewType ? String(t.input.viewType) : '' })));
              log(`tabs ${JSON.stringify(tabs)}`);
              continue;
            }
            if (c.compareReplace) { for (const s of compareSessions) s.replaceUri(Number(c.compareReplace.index), vscode.Uri.file(c.compareReplace.file)); continue; }
            if (c.compareWith) { // Start Compare from a player, with the open dialog's result supplied by the test
              const from = [...sessions].find((s) => !s.url && !s.sequence && (!c.name || s.name.includes(c.name)));
              if (from) {
                testCompareFiles = c.compareWith.map((f) => vscode.Uri.file(f));
                vscode.commands.executeCommand('videoPreviewEnhanced.compareWith', from.uri, { t: Number(c.t) || 0 })
                  .catch((e) => log(`debug compareWith failed: ${e.message}`));
              }
              continue;
            }
            if (c.compare) { for (const s of compareSessions) s.post({ ...c, type: 'debug' }); continue; }
            if (c.pickSubtitles) {
              for (const s of sessions) if (s.name === c.name) s.testPickSubtitles = c.pickSubtitles.map((f) => vscode.Uri.file(f));
              log('debug subtitles picker ready');
              continue;
            }
            if (c.bench) {
              // Throughput of extension host -> webview messages (raw-frame transport test).
              for (const sess of sessions) if (!c.name || sess.name.includes(c.name)) {
                const size = c.size || 3110400;
                sess.post({ type: 'benchStart', count: c.count || 60, size });
                for (let i = 0; i < (c.count || 60); i++) sess.post({ type: 'bench', i, data: new Uint8Array(size) });
              }
              continue;
            }
            if (c.benchFs) { benchFrameServer(c); continue; }
            if (c.action === 'remoteStreamKill') {
              for (const s of sessions) if (s.name === c.name && s.native instanceof remotestream.RemoteStream) s.native.proc?.kill("SIGKILL");
              continue;
            }
            if (c.action === 'defaultKeybindings') {
              // VS Code's default keybindings for the given keys (docs/notes/ui-simple.md: which player keys a workbench command also gets).
              vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile').then(async () => {
                await new Promise((r) => setTimeout(r, 1500));
                const ed = vscode.window.activeTextEditor;
                const text = ed ? ed.document.getText() : '';
                const want = new Set((c.keys || []).map((k) => String(k).toLowerCase()));
                const found = [];
                for (const m of text.matchAll(/\{\s*"key":\s*"([^"]+)",\s*"command":\s*"([^"]+)"(?:,\s*"when":\s*"((?:[^"\\]|\\.)*)")?/g)) {
                  if (want.has(m[1].toLowerCase()) || [...want].some((w) => m[1].toLowerCase().startsWith(`${w} `))) found.push({ key: m[1], command: m[2], when: m[3] || '' });
                }
                log(`debug keybindings ${JSON.stringify({ size: text.length, found })}`);
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
              }, (e) => log(`debug keybindings failed: ${e && e.message || e}`));
              continue;
            }
            if (c.action === 'tabs') {
              const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => ({ label: t.label, active: t.isActive })));
              log(`debug tabs: ${JSON.stringify(tabs)}`);
              continue;
            }
            for (const s of sessions) if (!c.name || s.name.includes(c.name)) s.post({ ...c, type: 'debug' }); // type last: a line can't pose as another message
          } catch { log(`bad debug command: ${line}`); }
        }
        seen = lines.length;
      });
    });
    context.subscriptions.push({ dispose: () => fs.unwatchFile(cmdFile) });
  }
  T_ACTIVATED = Date.now();
  if (logFile) log(`activated: module load ${T_ACTIVATE - T_LOAD} ms, activate() ${T_ACTIVATED - T_ACTIVATE} ms, pid ${process.pid}`);
}

/**
 * Test hook: throughput of the localhost frame server (src/frameserver.js) into the webview.
 * c: { benchFs: 'ws'|'http', size, count, name }. The webview logs "benchFs: ... MB/s".
 */
function benchFrameServer(c) {
  if (c.benchFs !== 'http' && c.benchFs !== 'ws') return;
  const size = c.size || 3110400;
  const count = c.count || 60;
  let data;
  for (const sess of sessions) {
    if (c.name && !sess.name.includes(c.name)) continue;
    if (!sess.framePort || !sess.webviewOrigin) continue;
    data ||= Buffer.alloc(size, 7);
    const ch = new frameserver.Channel({
      origin: sess.webviewOrigin,
      expiresIn: 60000,
      onClose: () => sess.benchChannels.delete(ch),
      onConnect: () => {
        let i = 0;
        const pump = () => {
          while (i < count && ch.connected) {
            ch.sendFrame(0, i / 30, 0, 0, 0, data);
            i++;
            if (ch.buffered > 4 * size) { ch.onDrain(pump); return; }
          }
          if (i >= count) ch.sendEnd(0);
        };
        pump();
      },
      onLost: () => ch.close(),
    });
    sess.benchChannels.add(ch);
    const urls = ch.urls();
    sess.post({ type: 'benchFs', mode: c.benchFs, url: urls[c.benchFs], count, size });
  }
}

/** Seek target from a link query or fragment: `t` (seconds or 1:02.5) and/or `frame` (1-based, as the player shows it). */
function gotoFrom(text) {
  const g = parseFragment(text);
  return g.t !== undefined || g.frame !== undefined ? g : null;
}

/**
 * vscode://<publisher>.<name>/open?frame=N&t=S&file=<path> (or uri=<full URI> for remote files):
 * opens the file in this player at that frame, or seeks an already open one.
 * The file comes last and runs to the end, so paths with & or + survive (VS Code has
 * already decoded the query once).
 */
function parseLink(query) {
  const m = /(?:^|&)(file|uri)=(.*)$/s.exec(query);
  if (!m) return null;
  const target = m[1] === 'uri' ? vscode.Uri.parse(m[2]) : vscode.Uri.file(m[2]);
  return { target, goto: gotoFrom(query.slice(0, m.index)) };
}

// This window's remote authority (ssh-remote+host, wsl+Ubuntu), learned once.
let windowAuthority = '';

/**
 * The remote authority of this window, or '' in a local window or when unknown.
 * The remote extension host sees its files as file: URIs, so a frame link has to
 * name the host itself. env.remoteAuthority is proposed API (it throws for us);
 * a webview resource URI carries the same authority, encoded into its host name
 * (vscode-remote+<authority, non-alphanumerics as -xxxx>.vscode-resource...).
 */
function remoteAuthority(webview) {
  const name = vscode.env.remoteName;
  if (!name) return '';
  if (windowAuthority) return windowAuthority;
  let a = '';
  try { a = vscode.env.remoteAuthority || ''; } catch { a = ''; }
  if (!a && webview) {
    try {
      const host = String(webview.asWebviewUri(vscode.Uri.file('/')).authority || '');
      const m = /^vscode-remote\+((?:[A-Za-z0-9]|-[0-9a-f]{4})+)\./.exec(host);
      if (m) a = m[1].replace(/-([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    } catch { a = ''; }
  }
  if (a && a.startsWith(`${name}+`)) windowAuthority = a;
  return windowAuthority;
}

/**
 * Maps a link target to a URI this extension host can open: vscode-remote links
 * only in the window connected to that host (where they are plain files);
 * null when the link belongs to another machine.
 */
function localTarget(target) {
  if (target.scheme !== 'vscode-remote') return target;
  const name = vscode.env.remoteName;
  const auth = String(target.authority || '').toLowerCase();
  const here = remoteAuthority(null).toLowerCase();
  // Before any player has opened, the authority may be unknown: the remote kind must still match.
  const ok = here ? auth === here : !!name && auth.startsWith(`${name.toLowerCase()}+`);
  return ok ? target.with({ scheme: 'file', authority: '' }) : null;
}

async function openLink(link) {
  log(`link: ${link.toString(true)}`);
  if (link.path !== '/open') return;
  const parsed = parseLink(link.query);
  if (!parsed) { vscode.window.showWarningMessage('Video Preview: the link names no file.'); return; }
  const { goto: g } = parsed;
  const target = localTarget(parsed.target);
  if (!target) {
    vscode.window.showWarningMessage(`Video Preview: this frame link is for ${parsed.target.authority || 'another machine'}. Open it in a window connected there.`);
    return;
  }
  // Links come from anywhere (a chat, a web page): only video files on a real file
  // system, never a share on another machine (opening \\host\share reaches out to it).
  const unc = !!target.authority || /^[\\/]{2}/.test(target.fsPath || '');
  if (!FS_SCHEMES.has(target.scheme) || unc || !VIDEO_EXT.test(target.path)) {
    log(`link refused: ${target.toString()}`);
    vscode.window.showWarningMessage('Video Preview: frame links only open video files (no network shares or other schemes).');
    return;
  }
  const key = target.with({ fragment: '' }).toString();
  for (const sess of sessions) {
    if (sess.uri.toString() !== key) continue;
    sess.panel.reveal();
    if (g) sess.post({ type: 'goto', ...g });
    return;
  }
  const now = Date.now();
  for (const [k, p] of pendingGoto) if (p.until < now) pendingGoto.delete(k);
  // Only for the player this link opens: a file opened by hand later starts normally.
  if (g) pendingGoto.set(key, { g, until: now + PENDING_GOTO_MS });
  const viewType = /\.(mp4|webm)$/i.test(target.path) ? 'videoPreviewEnhanced.playerOptional' : 'videoPreviewEnhanced.player';
  await vscode.commands.executeCommand('vscode.openWith', target, viewType);
}

/**
 * The link that reopens this file at a frame; a local path where possible, so it
 * reads well. In a remote window it names the host (uri=vscode-remote://<authority>/path).
 */
function frameLink(context, uri, frame, t, webview) {
  const auth = uri.scheme === 'file' ? remoteAuthority(webview) : '';
  if (auth) uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: auth, path: uri.path });
  const where = uri.scheme === 'file' ? `file=${encodeURIComponent(uri.fsPath)}` : `uri=${encodeURIComponent(uri.toString())}`;
  return `${vscode.env.uriScheme}://${context.extension.id}/open?frame=${frame}&t=${t}&${where}`;
}

class Session {
  constructor(context, { uri, sequence, url }, panel) {
    this.t = { load: T_LOAD, activate: T_ACTIVATE, activated: T_ACTIVATED, session: Date.now() }; // start-up timeline (logged for tests)
    this.context = context;
    // A URL the user entered (Open Video URL…): no file; file-only features are off or adapted.
    this.url = url || null;
    if (url) uri = vscode.Uri.parse(url);
    // Markdown links can carry #t=12.3 or #frame=42 (VS Code keeps the fragment on vscode.open).
    const frag = uri.fragment && !url ? gotoFrom(uri.fragment) : null;
    if (uri.fragment) uri = uri.with({ fragment: '' });
    const pending = pendingGoto.get(uri.toString());
    pendingGoto.delete(uri.toString());
    this.goto = (pending && pending.until >= Date.now() ? pending.g : null) || frag;
    this.uri = uri;
    this.file = url ? null : uri.fsPath;
    this.sequence = sequence || null;
    this.panel = panel;
    this.hiddenCount = 0;
    this.webview = panel.webview;
    remoteAuthority(this.webview); // learn the host for frame links arriving later
    this.disposed = false;
    this.page = 0;
    this.boots = new Set();
    this.pageAbort = new AbortController();
    this.exact = new ExactFrameGrabber({ log: (m) => log(`[${this.name}] ${m}`) }); // single exact frames (src/exact_frame.js)
    this.benchChannels = new Set();
    this.fh = null;
    this.frames = null;
    this.name = sequence ? sequence.name : url ? urlsource.displayName(url) : path.basename(this.file);
    if (logFile) log(`[${this.name}] session resolved: visible=${panel.visible}`);
    this.build = libavBuild(context.extensionUri);

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    // Only the extension's own media: video data, frames and images reach the page as messages.
    this.webview.options = { enableScripts: true, localResourceRoots: [media] };
    this.media = media;
    this.webview.onDidReceiveMessage((m) => {
      const pending = this.onMessage(m);
      const gen = this.loadGen;
      return pending.catch((e) => { if (!this.stale(gen)) this.fail(e); });
    });
    panel.onDidDispose(() => this.dispose());
    // VS Code does not fire visibilitychange in webviews; tell the player directly.
    panel.onDidChangeViewState(() => {
      if (this.disposed) return;
      if (panel.active) lastActive = this;
      if (!panel.visible) this.hiddenCount++;
      if (panel.visible && this.shown) this.startEarly();
      this.post({ type: 'visible', visible: panel.visible });
      if (panel.visible) this.sendCompareOpen();
      if (panel.visible && this.onShown) { const f = this.onShown; this.onShown = null; f(); }
    });
    this.extraSubs = []; // subtitle files the user loaded; sent again after a reload
    sessions.add(this);
    lastActive = this;
  }

  async show() {
    if (!vscode.env.remoteName && (logFile || (!this.sequence && nativeTransport() !== 'message'))) {
      // The CSP needs the selected port before the page is created.
      try { await frameserver.start(); this.framePort = frameserver.port; }
      catch (e) { log(`frame server could not start: ${e.message}`); }
    }
    if (this.disposed) return;
    this.webview.html = this.html();
    this.watch();
    this.shown = true;
    this.startEarly();
  }

  startEarly() {
    if (!this.panel.visible || this.earlyStarted || this.opened || this.disposed || this.loadGen) return;
    this.earlyStarted = true;
    // ffmpeg's lookup and ffprobe run while the webview loads; open() takes the result (first page
    // only). When they choose native ffmpeg, it starts too (startNativeEarly).
    const early = this.sequence ? null : this.probeEarly();
    this.early = early;
    if (early) early.result.then((e) => this.startNativeEarly(early, e)).catch((e) => log(`[${this.name}] early native start: ${e && e.stack || e}`));
  }

  /** Reload when the file is rewritten (render or capture loops), keeping the position. */
  watch() {
    if (this.sequence || !FS_SCHEMES.has(this.uri.scheme)) return;
    let lastStamp = 0;
    try {
      this.watcher = fs.watch(path.dirname(this.file), (_ev, name) => {
        if (this.disposed) return;
        if (name && name.toLowerCase() !== path.basename(this.file).toLowerCase()) return;
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          fs.stat(this.file, (err, st) => {
            if (this.disposed || err || st.mtimeMs === lastStamp) return;
            lastStamp = st.mtimeMs;
            if (this.opened) this.reload();
            else this.dropEarly('file changed'); // the page's open() probes the new file
          });
        }, 800);
      });
      fs.stat(this.file, (err, st) => { if (!err) lastStamp = st.mtimeMs; });
    } catch (e) {
      log(`[${this.name}] cannot watch for changes: ${e.message}`);
    }
  }

  /** Opens the next (d = 1) or previous (d = -1) video in the same folder, in this tab's place. */
  async openNeighbour(d) {
    if (this.sequence || this.url) return;
    const dir = path.dirname(this.file);
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const vids = names.filter((n) => VIDEO_EXT.test(n)).sort(coll.compare);
    const i = vids.indexOf(path.basename(this.file));
    const target = vids[i + d];
    if (!target) { this.post({ type: 'toast', text: d > 0 ? 'Last video in this folder' : 'First video in this folder' }); return; }
    // Same scheme and authority as this file, so it also works in remote windows.
    const uri = vscode.Uri.joinPath(this.uri, '..', target);
    const viewType = /\.(mp4|webm)$/i.test(target) ? 'videoPreviewEnhanced.playerOptional' : 'videoPreviewEnhanced.player';
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { viewColumn: this.panel.viewColumn, preview: false });
    this.panel.dispose();
  }

  /** Where this file was left last time (same size and date), unless it was near the start or end. */
  resumeAt() {
    if (this.sequence || this.url || !globalState) return 0;
    const all = globalState.get(POSITIONS_KEY) || {};
    const e = all[this.file];
    try {
      const st = fs.statSync(this.file);
      if (!e || e.size !== st.size || e.mtime !== st.mtimeMs) return 0;
    } catch { return 0; }
    return e.t > 5 && e.d - e.t > 5 ? e.t : 0;
  }

  /**
   * The webview reports the position every second. Stored when it stops moving (pause,
   * end), jumps (seek), every 30 s while playing, and on close; not on every report.
   */
  rememberPos(t, d) {
    if (this.sequence || this.url || !globalState || !(t >= 0)) return;
    const prev = this.pos;
    this.pos = { t, d };
    if (this.savedPos && this.savedPos.t === t) return;
    const playing = prev && t > prev.t && t - prev.t < 5;
    if (playing && Date.now() - (this.savedAt || 0) < 30000) return;
    this.savePos();
  }

  savePos() {
    const { t, d } = this.pos;
    this.savedPos = this.pos;
    this.savedAt = Date.now();
    let st;
    try { st = fs.statSync(this.file); } catch { return; }
    const all = { ...(globalState.get(POSITIONS_KEY) || {}) };
    all[this.file] = { t, d, size: st.size, mtime: st.mtimeMs, at: Date.now() };
    // Keep the 200 most recent files.
    const keys = Object.keys(all).sort((x, y) => all[y].at - all[x].at);
    for (const k of keys.slice(200)) delete all[k];
    globalState.update(POSITIONS_KEY, all);
  }

  reload(why = 'file changed on disk') {
    if (this.disposed) return;
    log(`[${this.name}] ${why}, reloading`);
    this.resetPage();
    this.boot = undefined;
    this.boots.clear();
    this.webview.html = `${this.html()}<!-- ${Date.now()} -->`;
  }

  resetPage() {
    this.closePage('reload');
    this.pageAbort = new AbortController();
  }

  closePage(why) {
    this.loadGen = (this.loadGen || 0) + 1;
    this.pageAbort.abort();
    this.thumbChain = null;
    this.exporting = null;
    this.onShown = null;
    if (this.exportWait) for (const finish of this.exportWait.values()) finish({ error: 'export cancelled' });
    this.hlsPlan = null;
    if (this.disposed) this.exact.dispose();
    else this.exact.cancel();
    this.closeBenchChannels();
    this.webviewOrigin = null;
    this.closeFile();
    this.dropEarly(why);
    if (this.native) { this.native.dispose(); this.native = null; }
    this.frames = null;
  }

  closeBenchChannels() {
    for (const ch of this.benchChannels) ch.close();
  }

  post(msg) {
    if (!this.disposed) this.webview.postMessage(msg);
  }

  canCompare() {
    return !this.sequence && !this.url && FS_SCHEMES.has(this.uri.scheme);
  }

  /** Whether a Compare is open: the player's Compare button then adds to it (media/player.js setCompareOpen). */
  compareOpen() {
    return [...compareSessions].some((c) => !c.disposed);
  }

  sendCompareOpen() {
    if (this.canCompare()) this.post({ type: 'compareOpen', open: this.compareOpen() });
  }

  fail(err, hint) {
    log(`[${this.name}] error: ${err && err.stack ? err.stack : err}`);
    this.post({ type: 'error', message: String(err && err.message ? err.message : err), hint: hint || '' });
  }

  html() {
    const w = this.webview;
    const media = this.media;
    const nonce = crypto.randomBytes(16).toString('base64');
    const c = config();
    const uri = (...p) => w.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const base = w.asWebviewUri(this.build.dir).toString();
    // A link's frame applies to the first page only: a reload (file changed on disk) resumes instead.
    const goto = this.goto || null;
    this.goto = null;
    const cfg = JSON.stringify({
      page: ++this.page,
      autoplay: c.autoplay, loop: c.loop, prefs: prefsOf(c), canOpenExternal: this.canOpenExternal(), name: this.name, debug: !!logFile, resume: this.resumeAt(), goto,
      // A URL tab (Open Video URL…): file-only tools are off; the info panel names the host instead of a size.
      url: this.url ? { host: new URL(this.url).host } : null,
      sequence: !!this.sequence,
      hideSlowPlaybackNotice: !!globalState.get(HIDE_SLOW_PLAYBACK_NOTICE),
      hideReducedResNotice: !!globalState.get(HIDE_REDUCED_RES_NOTICE),
      engine: {
        workerUrl: uri('decoder-worker.js'), xrayWorkerUrl: uri('xray-worker.js'), libavBase: base, loader: `${base}/${this.build.loader}`, variant: this.build.variant,
        remote: !!vscode.env.remoteName, whenSlow: c.whenSlow, fastWhenBehind: c.fastWhenBehind,
        net: !!this.url, // blocks come over the network: larger blocks, more read-ahead, no seek-bar thumbnails
        wcFailed: [...wcFailed],
        rotation: this.sequence || this.url ? 0 : rotationOf(this.file),
        pool: debugPool,
        mem: memBudgets(),
        hdrOutput: c.hdrOutput,
        // Tests (VPE_LOG only): VPE_HDR_FORCE=1 takes the HDR output path on an SDR display.
        hdrForce: !!logFile && process.env.VPE_HDR_FORCE === '1',
        // Tests (VPE_LOG only): VPE_NO_WEBGL=1 makes the decoder fail as on a machine without WebGL2 (the error screen).
        noWebgl: !!logFile && process.env.VPE_NO_WEBGL === '1',
        // Tests (VPE_LOG only): VPE_THUMB_STRIP=0 leaves out the background seek-bar strip (CPU measurements).
      },
    });
    const loopback = this.framePort ? `127.0.0.1:${this.framePort}` : '';
    const transport = nativeTransport();
    const frameSources = loopback ? [
      ...((logFile || transport === 'http') ? [`http://${loopback}`] : []),
      ...((logFile || transport === 'ws') ? [`ws://${loopback}`] : []),
    ] : [];
    const csp = [
      "default-src 'none'",
      `img-src ${w.cspSource} blob: data:`,
      `media-src ${w.cspSource} blob: data:`,
      `style-src ${w.cspSource}`,
      // The decoder worker is created from a blob and imports libav.js and its WebAssembly.
      `script-src 'nonce-${nonce}' ${w.cspSource} blob: 'wasm-unsafe-eval'`,
      'worker-src blob:',
      // Native frames from the localhost frame server (src/frameserver.js), local windows only.
      ['connect-src', w.cspSource, 'blob:', ...frameSources].join(' '),
    ].join('; ');
    // The decoder's files (8 MB of WebAssembly) start downloading before the page's scripts load;
    // engine.js takes the responses (self.vpeEarly). Not for image sequences (no decoder).
    const stem = `${base}/${this.build.loader}`.replace(/\.js$/, '');
    const early = this.sequence ? [] : [uri('decoder-worker.js'), `${base}/${this.build.loader}`, `${stem}.wasm.js`, `${stem}.wasm.wasm`];
    const earlyJs = early.length ? `<script nonce="${nonce}">{const controller=new AbortController(), responses={};self.vpeEarly={controller,responses};for(const u of ${JSON.stringify(early).replace(/</g, '\\u003c')})responses[u]=fetch(u,{signal:controller.signal}).catch(()=>null);}</script>\n` : '';
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1">
${earlyJs}<link rel="stylesheet" href="${uri('player.css')}">
</head><body>
<script type="application/json" id="cfg">${cfg.replace(/</g, '\\u003c')}</script>
<div id="stage" class="fit">
  <canvas id="canvas" hidden role="img" aria-label="Video"></canvas>
  <div id="subs" hidden></div>
  <div id="overlay"><div id="message">Opening…</div><div id="hint"></div><button id="action" hidden></button></div>
  ${playFlashHtml}
  <div id="toast" hidden aria-hidden="true"></div>
  <div id="notice" hidden>
    <span id="noticeText"></span>
    <button id="noticeAction"></button>
    <button id="noticeSettings" class="noticeSecondary" hidden></button>
    <button id="noticeHide" class="noticeSecondary" hidden></button>
    <button id="noticeClose" title="Dismiss" aria-label="Dismiss">×</button>
  </div>
</div>
${barHtml({ canCompare: this.canCompare(), compareOpen: this.compareOpen() })}
<div id="startCompareBackdrop" hidden>
  <div id="startCompareDialog" tabindex="-1" role="dialog" aria-modal="true" aria-label="Start comparison" aria-describedby="startCompareHint">
    <p id="startCompareHint">Start Compare with this video, then click videos in the Explorer to add them.</p>
    <div class="compare-actions">
      <button id="cancelCompareBtn" type="button">Cancel</button>
      <button id="confirmCompareBtn" type="button">Start comparison</button>
    </div>
  </div>
</div>
<div id="panel" class="panel" role="dialog" aria-label="Player settings" hidden></div>
<div id="sheet" hidden></div>
<div id="ctxmenu" class="ctxmenu" role="menu" aria-label="Player menu" tabindex="-1" hidden></div>
<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<script nonce="${nonce}" src="${uri('membudget.js')}"></script>
<script nonce="${nonce}" src="${uri('timestretch.js')}"></script>
<script nonce="${nonce}" src="${uri('pool.js')}"></script>
<script nonce="${nonce}" src="${uri('thumbs.js')}"></script>
<script nonce="${nonce}" src="${uri('framestream.js')}"></script>
<script nonce="${nonce}" src="${uri('hdr.js')}"></script>
<script nonce="${nonce}" src="${uri('engine.js')}"></script>
<script nonce="${nonce}" src="${uri('picture.js')}"></script>
<script nonce="${nonce}" src="${uri('inspect.js')}"></script>
<script nonce="${nonce}" src="${uri('scopes.js')}"></script>
<script nonce="${nonce}" src="${uri('exactframe.js')}"></script>
<script nonce="${nonce}" src="${uri('reduced-res-notice.js')}"></script>
<script nonce="${nonce}" src="${uri('slow-notice.js')}"></script>
<script nonce="${nonce}" src="${uri('subtitles.js')}"></script>
<script nonce="${nonce}" src="${uri('tracks-menu.js')}"></script>
<script nonce="${nonce}" src="${uri('xray.js')}"></script>
<script nonce="${nonce}" src="${uri('modes.js')}"></script>
<script nonce="${nonce}" src="${uri('range-drag.js')}"></script>
<script nonce="${nonce}" src="${uri('controls.js')}"></script>
<script nonce="${nonce}" src="${uri('ctxmenu.js')}"></script>
<script nonce="${nonce}" src="${uri('timefmt.js')}"></script>
<script nonce="${nonce}" src="${uri('abloop.js')}"></script>
<script nonce="${nonce}" src="${uri('debug-probe.js')}"></script>
<script nonce="${nonce}" src="${uri('player.js')}"></script>
</body></html>`;
  }

  /** Native ffmpeg seek-bar thumbnail (src/thumbhost.js); one at a time, answered with {type: 'thumb', id, ...}.
   * @param {ThumbRequest} m
   */
  sendThumb(m) {
    const { signal } = this.pageAbort;
    const boot = this.boot;
    const nd = this.native;
    const reply = (r) => {
      // checkJs: start
      const message = /** @satisfies {ThumbReply} */ ({
        type: 'thumb', boot, page: m.page, id: m.id,
        ...(r ? { w: r.w, h: r.h, data: new Uint8Array(r.data) } : {}),
      });
      // checkJs: end
      if (!signal.aborted) this.post(message);
    };
    const v = nd && nd.pr && nd.pr.video;
    // Only the local native decoder (not the remote stream) and sane requests.
    if (!(nd instanceof NativeDecoder) || !v || !nd.file || !Number.isFinite(m.t) || !(m.w > 0 && m.w <= 640 && m.h > 0 && m.h <= 640)) { reply(null); return undefined; }
    const src = { w: v.sourceWidth || v.width, h: v.sourceHeight || v.height };
    this.thumbChain = (this.thumbChain || Promise.resolve()).then(() => {
      if (!signal.aborted) return decodeThumb(nd.tools, nd.file, src, m.t, m.w, m.h,
        (x) => log(`[${this.name}] ${x}`), signal);
    }).then(reply, () => reply(null));
    return undefined;
  }

  /**
   * One full-resolution PNG of the source at m.t for the pixel tools (src/exact_frame.js).
   * Answers {type: 'exactFrame', page, reqId, t, png | error}; a newer request, a reload or a closed tab ends this one,
   * and an answer for a replaced page is dropped.
   */
  async sendExactFrame(m) {
    const page = this.page;
    const gen = this.loadGen;
    const boot = this.boot;
    const reqId = Number(m.reqId);
    const t = Number(m.t);
    if (m.page !== page || !Number.isSafeInteger(reqId)) return undefined; // a message of another page
    const reply = (r) => { if (!this.stale(gen)) this.post({ type: 'exactFrame', boot, page, reqId, t, ...r }); };
    const nd = this.native;
    const eligible = nd instanceof remotestream.EncodedStream || (nd instanceof NativeDecoder && nd.lossy());
    const video = eligible && nd.pr && nd.pr.video;
    if (!video || this.url || this.sequence || !nd.file || !nd.tools) {
      reply({ error: 'exact frames are for Live transcode or downscaled native ffmpeg of a video file' });
      return undefined;
    }
    const r = await this.exact.grab({ tools: nd.tools, file: nd.file, t, video, rotation: rotationOf(nd.file), page, isCurrent: (p) => !this.stale(gen) && p === this.page });
    if (r.cancelled || r.stale) return undefined; // superseded or replaced: the newer request answers
    reply(r.png ? { png: new Uint8Array(r.png.buffer, r.png.byteOffset, r.png.length), w: r.w, h: r.h, matrix: r.matrix } : { error: r.error || 'failed' });
    return undefined;
  }

  async onMessage(m) {
    // A page can only send objects; null or a primitive is not one of ours.
    if (!m || typeof m !== 'object') return undefined;
    if (this.disposed || (m.type !== 'ready' && m.boot !== undefined && m.boot !== this.boot)) return undefined;
    switch (m.type) {
      case 'ready':
        if (m.page !== this.page || typeof m.boot !== 'string' || !m.boot || this.boots.has(m.boot)) return undefined;
        // VS Code can recreate the document from the same HTML without asking the extension to reload.
        if (this.boot !== undefined) this.resetPage();
        this.boot = m.boot;
        this.boots.add(m.boot);
        // VS Code delivers this through the owning webview, whose origin isn't exposed by its host API.
        this.webviewOrigin = typeof m.origin === 'string' && /^vscode-webview:\/\/[a-z0-9-]+$/.test(m.origin) ? m.origin : null;
        // The picture area (device pixels) for the HLS "Auto" quality.
        this.pageView = m.view && Number.isInteger(m.view.w) && Number.isInteger(m.view.h) && m.view.w > 0 && m.view.h > 0 && m.view.w <= 32768 && m.view.h <= 32768 ? { w: m.view.w, h: m.view.h } : null;
        this.t.ready = this.t.ready || Date.now();
        this.sendSubtitles().catch((e) => log(`[${this.name}] subtitles: ${e && e.stack || e}`));
        this.sendFfmpegState();
        if (globalState.get(HIDE_SLOW_PLAYBACK_NOTICE)) this.post({ type: 'hideSlowPlaybackNotice' });
        if (globalState.get(HIDE_REDUCED_RES_NOTICE)) this.post({ type: 'hideReducedResNotice' });
        // The bar was rendered with the Compare state. A Compare that opened or closed while the page loaded is sent
        // after the video opened, so nothing comes before the first sound and frames (test/host/wav_parts_test.js).
        return Promise.resolve(this.sequence ? this.openSequence() : this.open())
          .finally(() => { if (!this.disposed && this.page === m.page && this.boot === m.boot) this.sendCompareOpen(); });
      case 'loadSubs': return this.loadSubtitles();
      // The settings panel's "Extension settings" row: VS Code's Settings, filtered to this extension.
      case 'openSettings': return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXT_ID}`);
      case 'frames': return this.sendFrames(m.indices || []);
      // checkJs: start
      case /** @satisfies {ReadBlockRequest['type']} */ ('readBlock'): {
        const request = /** @type {ReadBlockRequest} */ (m);
        const gen = this.loadGen;
        const boot = this.boot;
        const isCurrent = (/** @type {number} */ page) => !this.stale(gen) && page === this.page;
        return serveBlock(request, isCurrent,
          (pos, len) => this.readBlock(pos, len, () => isCurrent(request.page)),
          (reply) => this.post(m.boot === undefined ? reply : { ...reply, boot }));
      }
      // checkJs: end
      case 'nd':
        // The page's picture area, with open and after a resize: the next prestart's guess (fitView).
        // A zoomed picture is no guess for the next video's player.
        if (m.m && m.m.type === 'view' && !m.m.zoomed && m.m.w > 0 && m.m.h > 0) rememberView(m.m.w, m.m.h);
        else if (m.m && m.m.type === 'open' && m.m.view && m.m.view.w > 0 && m.m.view.h > 0) rememberView(m.m.view.w, m.m.view.h);
        return this.native ? this.native.handle(m.m) : undefined;
      case 'thumb': return m.page === this.page ? this.sendThumb(m) : undefined;
      case 'grabExactFrame': return this.sendExactFrame(m);
      // Jump sizes and speed step from the player's panels: only declared values.
      case 'pref': return PREFS[m.key] && PREFS[m.key].values.includes(m.value) ? setSetting(m.key, m.value, prefTarget(m.key)) : undefined;
      case 'playbackPrefs': return rememberPlaybackPrefs(m, this);
      // Live transcode mode and max bitrate from the ⚙ panel (machine-scoped).
      case 'transcodePref': {
        if (m.mode !== undefined && transcodePolicy.MODES.includes(m.mode)) {
          await setSetting('transcode', m.mode, vscode.ConfigurationTarget.Global);
          const isStreaming = this.native instanceof remotestream.EncodedStream;
          if (m.mode === 'off' && isStreaming) this.useFullRes();
          else if (m.mode === 'always' && !isStreaming) {
            this.forceTranscode = true;
            this.fullRes = false;
            this.noRemoteStream = false;
            this.reload('live transcode enabled');
          }
        }
        if (m.maxBitrateMbps !== undefined) {
          const mbps = Math.max(0, Number(m.maxBitrateMbps) || 0);
          await setSetting('transcodeMaxBitrate', mbps, vscode.ConfigurationTarget.Global);
          if (this.native instanceof remotestream.EncodedStream) {
            this.native.setMaxBitrateMbps(mbps);
          }
        }
        return undefined;
      }
      case 'compareWith':
        if (this.url || this.sequence) { this.post({ type: 'toast', text: this.url ? 'Compare works with video files, not URLs' : 'Compare works with video files, not image sequences', ms: 3000 }); return undefined; }
        // Compare takes this tab's place and starts where the player is (src/compare.js).
        return vscode.commands.executeCommand('videoPreviewEnhanced.compareWith', this.uri, { t: Number(m.t) || 0 });
      case 'toolbarCompare':
        if (!this.canCompare()) return;
        return compareApi.addFromPlayer(this, Number(m.t) || 0, m.confirmStart === true);
      case 'comparePick': // key D: a quick pick of other videos
        if (this.url || this.sequence) { this.post({ type: 'toast', text: this.url ? 'Compare works with video files, not URLs' : 'Compare works with video files, not image sequences', ms: 3000 }); return undefined; }
        return vscode.commands.executeCommand('videoPreviewEnhanced.comparePick', this.uri, { t: Number(m.t) || 0 });
      case 'addMode': // Shift+D: the next video opened (an Explorer click) is compared with this one
        if (this.url || this.sequence) { this.post({ type: 'toast', text: this.url ? 'Compare works with video files, not URLs' : 'Compare works with video files, not image sequences', ms: 3000 }); return undefined; }
        if (Number(m.t) >= 0) this.pos = { ...(this.pos || {}), t: Number(m.t) };
        return compareApi ? compareApi.toggleAddMode(this) : undefined;
      case 'stopAddMode': return compareApi ? compareApi.stopAddMode() : undefined; // Esc in the page
      case 'compareDrop': // videos dropped on the player (docs/notes/compare-ui.md "Starting a compare")
        if (this.url || this.sequence || !Array.isArray(m.uris)) return undefined;
        return vscode.commands.executeCommand('videoPreviewEnhanced.compareDrop', this.uri, m.uris.filter((x) => typeof x === 'string').slice(0, 20), { t: Number(m.t) || 0 });
      // The ⚙ panel's Quality page (HLS): 'auto' or a variant index of this stream (checked in setQuality).
      case 'quality': return this.url ? this.setQuality(m.pick === 'auto' ? 'auto' : Number(m.pick)) : undefined;
      case 'openUrl': { // the ⚙ panel's "Open video URL…": only opens the input box; the URL comes from there
        const url = await promptUrl();
        if (url) await openUrl(this.context, url);
        return undefined;
      }
      // The page writes a user (global) setting: only the values the setting declares (security review 2026-11-19 #7).
      case 'whenSlow': return m.value === 'every' || m.value === 'skip' ? setSetting('whenSlow', m.value, vscode.ConfigurationTarget.Global) : undefined;
      case 'action':
        if (m.id === 'setupFfmpeg') {
          // A URL that needed ffmpeg opens again once it is set up.
          setupFfmpeg().then(() => (this.url && !this.disposed ? tools() : null)).then((t) => { if (t && !this.disposed) this.reload('ffmpeg set up'); }, () => {});
        }
        if (m.id === 'fullRes') this.useFullRes();
        if (m.id === 'nativeResolutionSettings') {
          return vscode.commands.executeCommand('workbench.action.openSettings', '@id:videoPreviewEnhanced.nativeMaxHeight');
        }
        if (m.id === 'transcodeSettings') {
          return vscode.commands.executeCommand('workbench.action.openSettings', '@id:videoPreviewEnhanced.transcode');
        }
        if (m.id === 'whenSlowSettings' || m.id === 'fastPreviewSettings') {
          const setting = m.id === 'whenSlowSettings' ? 'whenSlow' : 'fastPreviewWhenBehind';
          return vscode.commands.executeCommand('workbench.action.openSettings', `@id:videoPreviewEnhanced.${setting}`);
        }
        if (m.id === 'hideSlowPlaybackNotice') {
          await globalState.update(HIDE_SLOW_PLAYBACK_NOTICE, true);
          for (const session of sessions) session.post({ type: 'hideSlowPlaybackNotice' });
        }
        if (m.id === 'hideReducedResNotice') {
          await globalState.update(HIDE_REDUCED_RES_NOTICE, true);
          for (const session of sessions) session.post({ type: 'hideReducedResNotice' });
        }
        return undefined;
      case 'decodeSpeed': return this.onSpeed(m);
      case 'softVideo': if (vscode.env.remoteName && !this.native && !this.fullRes) maybeOfferRemoteFfmpeg(this, m).catch((e) => log(`remote ffmpeg offer: ${e && e.stack || e}`)); return undefined;
      case 'saveFrame': return m.page === this.page ? this.saveFrame(m.data, m.frame) : undefined;
      case 'exportRange': return m.page === this.page ? this.exportRange(m.range) : undefined;
      case 'ffmpegRange': return m.page === this.page ? this.copyFfmpegRange(m.range) : undefined;
      case 'clipRange': return m.page === this.page ? exportClips(this, m.range ? [{ uri: this.uri, range: m.range }] : [], this.uri) : undefined;
      case 'exportFrame':
        if (m.page === this.page && this.exportWait) this.exportWait.get(m.id)?.(m);
        return undefined;
      case 'external': if (!this.canOpenExternal()) return undefined; return vscode.env.openExternal(this.sequence ? vscode.Uri.file(this.sequence.files[0]) : this.uri);
      case 'log': log(`[${this.name}] webview: ${m.msg}`); return undefined;
      case 'wcFailed':
        // WebCodecs lagged on this sound codec: the built-in decoder plays it in every later player this session.
        if (typeof m.codec === 'string' && /^[\w-]{1,16}$/.test(m.codec)) { wcFailed.add(m.codec); log(`[${this.name}] WebCodecs failed for ${m.codec}: ${String(m.reason || '').slice(0, 200)}`); }
        return undefined;
      case 'playing': return undefined;
      case 'pos': return this.rememberPos(m.t, m.d);
      case 'neighbour': return this.openNeighbour(m.d);
      case 'focusMode': return toggleFocusMode(vscode);
      case 'focusModeExited': noteFocusModeExited(); return undefined;
      case 'copyText': return vscode.env.clipboard.writeText(String(m.text || ''));
      case 'copyLink': {
        if (this.url) { this.post({ type: 'toast', text: 'Frame links work for video files only, not URLs', ms: 3000 }); return undefined; }
        if (this.sequence) { this.post({ type: 'toast', text: 'Links work for video files only' }); return undefined; }
        await vscode.env.clipboard.writeText(frameLink(this.context, this.uri, m.frame, m.t, this.webview));
        this.post({ type: 'toast', text: `Link to frame ${m.frame} copied` });
        return undefined;
      }
      default: return undefined;
    }
  }

  // ---- opening -----------------------------------------------------------

  /** The system player can only open a file on this machine. */
  canOpenExternal() {
    return !vscode.env.remoteName && (this.sequence || this.uri.scheme === 'file');
  }

  /** True once the page that asked has been replaced (reload) or closed: its answer must not reach the new page. */
  stale(gen) {
    return gen !== this.loadGen || this.disposed;
  }

  async open() {
    const early = this.opened ? null : this.early;
    this.opened = true;
    // A reload while this runs (probe, AVI scan) starts a second open() for the new page.
    const gen = this.loadGen;
    const { signal } = this.pageAbort;
    // The page owns the claimed decoder while it waits for the probe.
    const r = { nd: this.earlyNd };
    const discard = () => {
      const nd = r.nd;
      r.nd = null;
      if (nd) { log(`[${this.name}] native: early ffmpeg stopped: not used`); nd.dispose(); }
    };
    signal.addEventListener('abort', discard, { once: true });
    this.earlyNd = null;
    clearTimeout(this.earlyTimer);
    try {
      return await this.openPage(gen, early, r, signal);
    } finally {
      if (early) early.abort.abort();
      if (this.early === early) this.early = null;
      signal.removeEventListener('abort', discard);
      discard();
    }
  }

  /** open() for page gen. early: the session's probe (or null); r.nd: the early native decoder (taken by clearing r.nd). */
  async openPage(gen, early, r, signal) {
    // git:, vscode-vfs: and other virtual files: fsPath would name a different file (git: the working tree).
    if (this.url) return this.openUrlPage(gen, signal);
    if (!FS_SCHEMES.has(this.uri.scheme)) return this.fail(new Error(`Can't play ${this.uri.scheme}: files`), 'Open the file from the Explorer instead.');
    maybeOnboard().catch((e) => log(`onboarding failed: ${e && e.message || e}`));
    const stat = await fs.promises.stat(this.file);
    if (this.stale(gen)) return undefined;
    if (early && !sameFile(await early.stat, stat)) early.abort.abort();
    if (this.stale(gen)) return undefined;
    if (/\.avi$/i.test(this.file)) {
      const info = await (early && !early.abort.signal.aborted ? early.avi : this.scanAvi(signal));
      if (this.stale(gen)) return undefined;
      // MJPEG (with PCM sound) plays straight from the file: each frame is a JPEG.
      if (this.playsMjpeg(info)) return this.startMjpeg(info, stat, signal);
    }
    // Native ffmpeg when installed, except 8-bit H.264/VP8 and when there's a reason not to
    // (src/decide.js): an SSH/container window, a file it failed on, pixel tools.
    const c = config();
    const remote = vscode.env.remoteName;
    // Live transcode "always" (or forced for this session): stream before raw native ffmpeg, in any window.
    if (c.transcode === 'always' || this.forceTranscode) {
      if (early) early.abort.abort();
      if (await this.tryRemoteStream(gen, stat, null, { forced: !!this.forceTranscode })) return undefined;
    }
    let probed = null; // ffmpeg and its probe of the file, for the stream below
    const nativePossible = this.nativePossible(c);
    if (!nativePossible && early) early.abort.abort();
    if (this.stale(gen)) return undefined;
    if (nativePossible) {
      // The probe started with the session (probeEarly), for the first page only and only for the
      // same file (size and date): a reload or a rewritten file is probed again.
      let e = null;
      if (early && !early.abort.signal.aborted) {
        log(`[${this.name}] waiting for early ffprobe`);
        e = await early.result.catch(() => null);
      }
      if (this.stale(gen)) return undefined;
      const t = e ? e.t : await tools();
      if (this.stale(gen)) return undefined;
      this.t.tools = Date.now();
      const gpus = gpusForMethod(t, c); // usually known already (stored, or detected alongside the early ffprobe)
      if (t) {
        // No automatic GPU test (2026-11-20: background decoding right after install looks like malware):
        // until the user runs it, the GPU's vendor picks the method (decide.vendorMethod; a failing one falls back).
        let pr = null;
        if (e && e.t === t && !e.err) pr = e.pr;
        else {
          try { pr = await ff.probe(t, this.file, signal); } catch (err) { log(`[${this.name}] ffprobe failed: ${err.message}`); }
        }
        await gpus;
        if (this.stale(gen)) return undefined;
        this.t.probed = Date.now();
        if (pr) probed = { t, pr };
        const d = !pr ? { use: 'builtin', reason: 'ffprobe could not read the file' } : this.decideNative(c, t, pr, stat);
        log(`[${this.name}] decoder: ${d.use === 'native' ? `native ffmpeg (${d.method})` : 'built-in'}: ${d.reason}`);
        if (pr && d.use === 'native') {
          // The ffmpeg started before the page when it was started for this same decision; else one
          // starts now (still before the page's transport is known: NativeDecoder.open() restarts it
          // if the frame size changes).
          let nd = r.nd;
          r.nd = null;
          const sameProbe = nd && (nd.pr === pr || (nd.guessed && e && e.pr === pr && sameFile(e.stat, stat)));
          if (sameProbe && !nd.disposed && !nd.failed && nd.decided === nativeKey(t, pr, d, c, this.framePort) &&
              (!nd.guessed || (nd.method === d.method && nd.pr.video?.pixFmt === pr.video?.pixFmt))) {
            nd.pr = pr;
            log(`[${this.name}] native: using the ffmpeg started before the page`);
          } else {
            if (nd) { log(`[${this.name}] native: early ffmpeg stopped: ${nd.failed ? 'it failed' : 'the decision changed'}`); nd.dispose(); }
            nd = this.newNative(t, pr, d, c);
          }
          nd.attach({
            post: (msg) => { if (!signal.aborted) this.post({ type: 'nd', m: msg }); },
            postRaw: (msg) => { if (!signal.aborted) this.post(msg); },
            onFail: (err) => this.nativeFailed(err, gen), origin: this.webviewOrigin,
          });
          this.native = nd;
          this.post({ type: 'libav', meta: { size: stat.size, duration: 0, label: '', native: true } });
          this.logStartup('native');
          return undefined;
        }
      }
    }
    if (this.stale(gen)) return undefined;
    // Remote windows where raw native ffmpeg didn't take the file (SSH, containers, tunnels):
    // consult the unified Live transcode policy (auto -> stream, ask -> prompt once on first remote use).
    if (c.transcode !== 'always' && !this.forceTranscode && remote && remote !== 'wsl') {
      if (await this.tryRemoteStream(gen, stat, probed)) return undefined;
    }
    if (this.stale(gen)) return undefined;
    log(`[${this.name}] decoding with libav.js (${this.build.variant})`);
    this.post({ type: 'libav', meta: { size: stat.size, duration: 0, label: '' } });
    this.logStartup('libav');
    return undefined;
  }

  /**
   * A URL player's page (Open Video URL…, docs/notes/url-stream.md). Native ffmpeg plays HLS/DASH and
   * anything the decoder rule gives it (the URL goes to ffmpeg with the network protocol whitelist);
   * otherwise the built-in decoder reads blocks over HTTP (urlsource.HttpFile / HlsFile).
   */
  async openUrlPage(gen, signal) {
    const c = config();
    const opts = { ...netOpts(), signal };
    const red = urlsource.redact(this.url);
    this.netFailed = false;
    let host = '';
    try { host = new URL(this.url).host; } catch { /* checked before */ }
    this.post({ type: 'status', text: `Connecting to ${host}…` });
    let info;
    try { info = await urlsource.inspect(this.url, opts); } catch (e) {
      if (this.stale(gen)) return undefined;
      return this.fail(e, `Could not open ${red}.${vscode.env.remoteName ? ` URLs are fetched from the ${vscode.env.remoteName} host this window is connected to.` : ''}`);
    }
    if (this.stale(gen)) return undefined;
    if (info.kind === 'html') {
      return this.fail(new Error('This URL is a web page, not a video'), 'Use a direct link to a video file (.mp4, .webm, .mkv…) or an HLS (.m3u8) / DASH (.mpd) stream. Video sites such as YouTube are not supported.');
    }
    const stream = info.kind !== 'media';
    // Native ffmpeg: streams always (the built-in decoder plays HLS VOD only), files by the decoder rule.
    let t = null;
    if (this.nativePossible(c) && !this.noNative) {
      t = await tools();
      if (this.stale(gen)) return undefined;
    }
    // HLS: the master playlist, the variant to play (the quality menu, else "Auto": picture size and measured rate)
    // and its media playlist; DRM is refused here for both decoders.
    let plan = null;
    try {
      if (info.kind === 'hls') {
        if (this.hlsPick !== 'auto' && !Number.isInteger(this.hlsPick)) this.hlsPick = 'auto';
        plan = await urlsource.hlsOpen(info, opts, { pick: this.hlsPick, view: this.pageView || lastView, maxHeight: t ? 4320 : 1080 });
        if (this.stale(gen)) return undefined;
        this.live = plan.live;
      } else this.live = info.kind === 'dash' ? urlsource.dashLive(info.text) : false;
    } catch (e) {
      if (this.stale(gen)) return undefined;
      log(`[${this.name}] playlist: ${e.message}`);
      return this.fail(e, `Could not read the HLS playlist of ${red}.`);
    }
    if (this.stale(gen)) return undefined;
    this.hlsPlan = plan;
    log(`[${this.name}] url ${red}: ${info.kind}${this.live ? ' (live)' : ''}${info.kind === 'media' ? `, ${Number.isFinite(info.size) ? `${info.size} bytes` : 'size unknown'}, ranges ${info.rangeOk ? 'yes' : 'no'}` : ''}${plan ? hlsPlanText(plan) : ''}`);
    if (plan && plan.drm) {
      return this.fail(new urlsource.Protected(plan.drm), 'DRM-protected video (SAMPLE-AES, FairPlay, Widevine, PlayReady) needs a licence and a content decryption module, which VS Code does not have; ffmpeg can\'t play it either. Streams encrypted with plain AES-128 play.');
    }
    let pr = null;
    let probeError = '';
    if (t) {
      this.post({ type: 'status', text: `Reading ${stream ? 'the stream' : 'the video'} with ffmpeg…` });
      try { [pr] = await Promise.all([ff.probe(t, this.ffInput(info), signal), gpusForMethod(t, c)]); } catch (e) { probeError = e.message; log(`[${this.name}] ffprobe failed: ${e.message}`); }
      if (this.stale(gen)) return undefined;
      if (pr && !pr.video && !pr.audio) pr = null;
    }
    const startNative = (d) => {
      if (this.live) pr.duration = 0;
      const nd = this.newNative(t, pr, d, c, this.ffInput(info));
      nd.attach({
        post: (msg) => { if (!signal.aborted) this.post({ type: 'nd', m: msg }); },
        postRaw: (msg) => { if (!signal.aborted) this.post(msg); },
        onFail: (err) => this.nativeFailed(err, gen), origin: this.webviewOrigin,
      });
      this.native = nd;
      this.postStream();
      this.post({ type: 'libav', meta: { size: 0, duration: 0, label: '', native: true, live: !!this.live, url: true } });
      this.logStartup('native');
      this.sendHlsSubs(gen, null);
      return undefined;
    };
    const forced = () => decide.decide({ setting: 'ffmpeg', trusted: true, tools: t, video: pr.video, probe: probeRecordFor(t), hw: hwKnown, gpu: c.gpuDecoding });
    let d = null;
    if (pr) {
      d = decide.decide({
        setting: stream && c.decoder === 'auto' ? 'ffmpeg' : c.decoder, remote: vscode.env.remoteName, trusted: true, tools: t, video: pr.video,
        probe: probeRecordFor(t), hw: hwKnown, failed: false, gpu: c.gpuDecoding, maxHeight: nativeHeight(c, pr.video), transport: nativeTransport() === 'message' ? 'message' : 'stream',
      });
      log(`[${this.name}] decoder: ${d.use === 'native' ? `native ffmpeg (${d.method})` : 'built-in'}: ${stream ? `${info.kind} stream` : d.reason}`);
      if (d.use === 'native') return startNative(d);
    }
    // The built-in decoder, reading over HTTP.
    try {
      if (info.kind === 'dash') throw new urlsource.NeedsFfmpeg(this.live ? 'A live DASH stream' : 'A DASH stream');
      if (info.kind === 'hls') {
        // Chosen for native ffmpeg (no height cap) but played here: "Auto" again with the built-in decoder's cap.
        if (plan.auto && plan.variant && plan.variant.height > 1080) {
          plan = await urlsource.hlsOpen(info, opts, { pick: 'auto', view: this.pageView || lastView, maxHeight: 1080 });
          if (this.stale(gen)) return undefined;
          this.hlsPlan = plan;
        }
        this.post({ type: 'status', text: 'Reading the HLS playlist…' });
        const hls = new urlsource.HlsFile(plan, opts);
        const close = () => hls.close();
        signal.addEventListener('abort', close, { once: true });
        try {
          await hls.open((n, all) => { if (!signal.aborted) this.post({ type: 'status', text: `Reading the HLS playlist… ${n} / ${all} segments` }); });
          if (signal.aborted) return undefined;
          this.net = hls;
        } finally {
          signal.removeEventListener('abort', close);
          if (!signal.aborted && this.net !== hls) close();
        }
        log(`[${this.name}] HLS for the built-in decoder: ${hls.segments} ${hls.fmp4 ? 'fMP4' : 'MPEG-TS'} segments${hls.encrypted ? ' (AES-128, decrypted here)' : ''}, ${hls.size} bytes, ${hls.duration.toFixed(1)} s${hls.variant ? `, variant ${hls.variant.width}x${hls.variant.height} ${hls.variant.bandwidth} b/s` : ''}`);
      } else {
        this.net = new urlsource.HttpFile(info, opts);
      }
    } catch (e) {
      if (this.stale(gen)) return undefined;
      if (e.protected) return this.fail(e, 'DRM-protected video needs a licence and a content decryption module, which VS Code does not have.');
      // A file the built-in decoder can't read this way (no ranges, too large) still plays with ffmpeg.
      if (pr && t && !e.needsFfmpeg && c.decoder !== 'builtin') {
        log(`[${this.name}] the built-in decoder can't read it (${e.message}); native ffmpeg instead`);
        return startNative(forced());
      }
      return this.failUrl(e, { t, probeError });
    }
    if (this.stale(gen)) return undefined;
    log(`[${this.name}] decoding with libav.js (${this.build.variant}) over HTTP`);
    this.postStream();
    this.post({ type: 'libav', meta: { size: this.net.size, duration: this.net.duration || 0, label: '', url: true } });
    this.logStartup('libav');
    this.sendHlsSubs(gen, this.net instanceof urlsource.HlsFile ? this.net : null);
    return undefined;
  }

  /** The HLS quality menu for the page ('stream'): the variants, the pick ('auto' or an index) and what plays. */
  postStream() {
    const plan = this.hlsPlan;
    if (!plan || !plan.master || plan.variants.length < 2 || this.live) return;
    this.post({
      type: 'stream',
      quality: {
        pick: plan.auto ? 'auto' : plan.index, current: plan.index,
        variants: plan.variants.map((v, id) => ({ id, width: v.width, height: v.height, bandwidth: v.bandwidth, codecs: v.codecs.slice(0, 80) })),
      },
    });
  }

  /** The page's quality menu: play variant pick ('auto' or an index) from the same moment (the page saved its time). */
  setQuality(pick) {
    const plan = this.hlsPlan;
    if (!plan || !plan.master) return;
    if (pick !== 'auto' && !(Number.isInteger(pick) && pick >= 0 && pick < plan.variants.length)) return;
    if (pick === (plan.auto ? 'auto' : plan.index)) return;
    this.hlsPick = pick;
    const v = pick === 'auto' ? null : plan.variants[pick];
    this.reload(`quality: ${v ? `${v.width}x${v.height} ${v.bandwidth} b/s` : 'auto'}`);
  }

  /**
   * The HLS stream's WebVTT subtitle renditions (urlsource.hlsSubtitles), fetched here and given to the page
   * as loaded subtitle files (the CC menu names them by NAME and LANGUAGE). Kept for reloads (quality changes).
   * file: the opened HlsFile (its first bytes give the timeline's start), else the start is read from the first segment.
   */
  async sendHlsSubs(gen, file) {
    const opts = { ...netOpts(), signal: this.pageAbort.signal };
    const plan = this.hlsPlan;
    if (!plan || !plan.master || this.live || !plan.master.media.some((m) => m.type === 'SUBTITLES' && m.url)) return;
    try {
      const group = (plan.variant && plan.variant.subtitles) || '*';
      let subs = this.hlsSubs && this.hlsSubs.group === group ? this.hlsSubs.list : null;
      if (!subs) {
        let start = null;
        try {
          const head = file ? await file.read(0, 256 * 1024) : await firstBytes(plan, opts);
          start = urlsource.streamStart(head);
        } catch (e) { log(`[${this.name}] HLS subtitles: no start time (${e.message})`); }
        if (this.stale(gen)) return;
        subs = await urlsource.hlsSubtitles(plan, opts, { start });
        if (this.stale(gen)) return;
        this.hlsSubs = { group, list: subs };
        for (const x of subs) log(`[${this.name}] HLS subtitles ${x.lang || '-'} "${x.name}": ${x.error ? `failed: ${x.error}` : `${x.text.length} bytes`}`);
      }
      if (this.stale(gen)) return;
      const files = subs.filter((x) => !x.error).map((x) => ({
        id: x.id, name: `${x.name}.vtt`, title: x.name, lang: x.lang, stream: true, auto: !!x.default,
        flags: x.forced ? ['forced'] : [], data: new Uint8Array(Buffer.from(x.text, 'utf8')),
      }));
      if (files.length) this.post({ type: 'subs', files });
    } catch (e) { log(`[${this.name}] HLS subtitles: ${e && e.stack || e}`); }
  }

  /** What ffmpeg reads for this URL player: the URL (after redirects) and the proxy (src/ffmpeg.js inputArgs). */
  ffInput(info) {
    const url = info && info.url ? info.url : this.url;
    const h = vscode.workspace.getConfiguration('http');
    const p = proxy.proxyFor(url, { proxy: h.get('proxy') || '', env: process.env });
    // HLS master playlist: ffprobe picks the streams of the chosen variant (src/ffmpeg.js probe).
    const plan = this.hlsPlan;
    const variant = plan && plan.master && plan.variant ? { bandwidth: plan.variant.bandwidth } : undefined;
    return { url, proxy: p || undefined, variant };
  }

  /** The built-in decoder can't play this URL: say why, and offer ffmpeg where it would run. */
  failUrl(e, { t, probeError }) {
    if (!e.needsFfmpeg) return this.fail(e);
    const remote = vscode.env.remoteName;
    let hint = '';
    let action = null;
    if (probeError) hint = `ffmpeg could not open it either: ${probeError.slice(0, 300)}`;
    else if (this.noNative) hint = `Native ffmpeg failed on it: ${this.noNative.slice(0, 300)}`;
    else if (!vscode.workspace.isTrusted) hint = 'Native ffmpeg does not run in Restricted Mode (untrusted workspaces).';
    else if (remote && remote !== 'wsl') hint = `Native ffmpeg is not used in ${remote} windows (frames would cross the connection). Open the URL in a local window.`;
    else if (config().decoder === 'builtin') hint = 'The decoder setting is "builtin": set videoPreviewEnhanced.decoder to "auto" to use ffmpeg.';
    else if (!t) {
      hint = 'The built-in decoder plays direct video links (MP4, WebM, MKV…) and HLS VOD playlists (also AES-128 encrypted). Live HLS and DASH play with ffmpeg (one click, no admin rights).';
      action = 'setupFfmpeg';
    }
    log(`[${this.name}] ${e.message}`);
    this.post({ type: 'error', message: `${e.why} needs native ffmpeg`, hint, action });
    return undefined;
  }

  scanAvi(signal) {
    return avi.parseAvi(this.file, signal).catch((e) => {
      if (signal.aborted) return null;
      log(`[${this.name}] AVI parse failed: ${e.message}`);
      return null;
    });
  }

  playsMjpeg(info) {
    return info && info.isMjpeg && info.frames.length && (!info.audio || info.audio.pcm);
  }

  nativePossible(c) {
    return c.decoder !== 'builtin' && !this.fullRes && !this.noRemoteStream && vscode.workspace.isTrusted && nativeAllowedHere();
  }

  /** First visible page only: ffmpeg lookup and ffprobe overlap the webview's load. */
  probeEarly() {
    const c = config();
    if (!FS_SCHEMES.has(this.uri.scheme) || !this.nativePossible(c) || c.transcode === 'always' || this.forceTranscode) return null;
    const abort = new AbortController();
    const stat = fs.promises.stat(this.file).catch(() => null);
    // The page reuses this scan, unless the file changed. Only probe AVI after ruling out the frame player.
    const scan = /\.avi$/i.test(this.file) ? stat.then((st) => st && !abort.signal.aborted ? this.scanAvi(abort.signal) : null) : null;
    const result = Promise.all([stat, scan, scan ? null : tools()]).then(async ([st, info, found]) => {
      if (abort.signal.aborted || !st || (info && info.isMjpeg)) return null;
      if (decide.failedBefore(globalState.get(decide.FAILED_KEY), this.file, st)) return null;
      const t = scan ? await tools() : found;
      const current = config();
      if (abort.signal.aborted || !this.nativePossible(current) || current.transcode === 'always' || this.forceTranscode) return null;
      if (!t) return { t };
      let probing = true;
      const gpus = gpusForMethod(t, current); // the method depends on them before any GPU test (hardware.detect, no decoding)
      if (!this.opened) {
        // The header is tentative. Run both reads at once so a slow sniff never delays ffprobe.
        const sniff = /\.(mkv|webm)$/i.test(this.file) ? sniffNativeMatroska : sniffNativeMp4;
        Promise.all([sniff(this.file, st, abort.signal), gpus]).then(([pr]) => {
          if (pr && probing && !this.opened && !abort.signal.aborted) this.tryStartNativeEarly(t, pr, st, true);
        }).catch((e) => log(`[${this.name}] early native start: ${e && e.stack || e}`));
      }
      this.t.probeStart = Date.now();
      if (logFile) log(`[${this.name}] early ffprobe started`);
      try {
        const [pr] = await Promise.all([ff.probe(t, this.file, abort.signal), gpus]);
        if (abort.signal.aborted) return null;
        this.t.probeDone = Date.now();
        return { t, pr, stat: st };
      }
      catch (err) { return abort.signal.aborted ? null : { t, err }; }
      finally { probing = false; }
    });
    return { abort, stat, avi: scan, result };
  }

  /** decide.decide() for native ffmpeg on this file (open() and the early start ask the same). */
  decideNative(c, t, pr, stat) {
    const d = decide.decide({
      setting: c.decoder, remote: vscode.env.remoteName, trusted: true, tools: t, video: pr.video, probe: probeRecordFor(t), hw: hwKnown,
      failed: decide.failedBefore(globalState.get(decide.FAILED_KEY), this.file, stat), gpu: c.gpuDecoding,
      maxHeight: nativeHeight(c, pr.video), transport: nativeTransport() === 'message' ? 'message' : 'stream',
    });
    // Tests (VPE_LOG only): VPE_NATIVE_METHOD holds ffmpeg's method (cuda, d3d11va, auto, none…), as a stored probe would.
    const forced = logFile ? process.env.VPE_NATIVE_METHOD : '';
    if (forced && d.use === 'native') return { ...d, method: forced, reason: `${d.reason}; method ${forced} (VPE_NATIVE_METHOD)` };
    return d;
  }

  /** A native decoder for decision d with ffmpeg started at once (NativeDecoder.prestart); attach() connects it to the page. */
  newNative(t, pr, d, c, input) {
    const h = nativeHeights(c, pr.video);
    const nd = new NativeDecoder({
      // Frame server locally (full size); postMessage in WSL (~90 MB/s measured: 720p there) and as the fallback.
      tools: t, file: this.file, input, maxHeight: h.stream, messageMaxHeight: h.message, method: d.method, methodGuessed: !!d.guessed, probed: pr, stats: !!logFile, maxQueued: nativeQueue(),
      // Automatic size: frames no larger than the picture shows (the last player's area until this page says).
      fitView: fitsView(c), view: lastView || storedView(),
      post: () => {}, postRaw: () => {}, log: (msg) => log(`[${this.name}] ${msg}`),
      transport: this.framePort ? nativeTransport() : 'message',
    });
    nd.decided = nativeKey(t, pr, d, c, this.framePort);
    nd.prestart();
    this.t.nativeStart = this.t.nativeStart || Date.now();
    return nd;
  }

  /**
   * Native ffmpeg started as soon as the early probe chooses it, before the page is ready (its
   * spawn and first decode, 300-450 ms at 4K, overlap the page load). open() uses it when it
   * decides the same; anything else (another decoder, a reload, the file changed, the tab
   * closed, no page within EARLY_NATIVE_MS) stops it.
   */
  async startNativeEarly(p, e) {
    const usable = () => !this.disposed && !this.opened && this.early === p && (!this.earlyNd || this.earlyNd.guessed);
    if (!e || !e.t || !e.pr || e.err || !e.stat || !usable()) return;
    const stat = await fs.promises.stat(this.file).catch(() => null);
    if (!usable() || !sameFile(e.stat, stat)) return;
    // A decoder started from the header guess: keep it when the probe agrees, else replace it now
    // instead of letting the wrong one run until the page opens (review 2026-11-19-5 #1).
    const nd = this.earlyNd;
    if (nd) {
      const c = config();
      const d = this.decideNative(c, e.t, e.pr, stat);
      if (d.use === 'native' && !nd.disposed && !nd.failed && nd.decided === nativeKey(e.t, e.pr, d, c, this.framePort) &&
          nd.method === d.method && nd.pr.video?.pixFmt === e.pr.video?.pixFmt) return;
      this.earlyNd = null;
      clearTimeout(this.earlyTimer);
      log(`[${this.name}] native: early ffmpeg stopped: the probe disagrees with the header guess`);
      nd.dispose();
    }
    this.tryStartNativeEarly(e.t, e.pr, stat, false);
  }

  tryStartNativeEarly(t, pr, stat, guessed) {
    const c = config();
    // Live transcode "always" (or forced) streams first; pixel tools want the built-in decoder.
    if (c.transcode === 'always' || this.forceTranscode || !this.nativePossible(c)) return;
    const d = this.decideNative(c, t, pr, stat);
    if (d.use !== 'native') return;
    this.earlyNd = this.newNative(t, pr, d, c);
    this.earlyNd.guessed = guessed;
    if (guessed && logFile) log(`[${this.name}] native: guessed ${pr.video.codec} from the header`);
    this.earlyTimer = setTimeout(() => this.dropEarly(`no page within ${EARLY_NATIVE_MS / 1000} s`), EARLY_NATIVE_MS);
  }

  /** Forgets the session's early probe and stops the early ffmpeg (why: logged). */
  dropEarly(why) {
    if (this.early) this.early.abort.abort();
    this.early = null;
    clearTimeout(this.earlyTimer);
    const nd = this.earlyNd;
    this.earlyNd = null;
    if (nd) { log(`[${this.name}] native: early ffmpeg stopped: ${why}`); nd.dispose(); }
  }

  /** Tests: the host's part of the start-up timeline (epoch ms), once per page. */
  logStartup(path_) {
    if (!logFile || this.t.posted) return;
    this.t.posted = Date.now();
    log(`[${this.name}] startup host ${JSON.stringify({ path: path_, ...this.t })}`);
  }

  /**
   * Unified Live transcode (ADR 0002, src/stream.js): ffmpeg on this host (local or remote)
   * decodes (GPU when available), scales and re-encodes a low-latency H.264 stream for WebCodecs.
   * True when it took over playback.
   */
  async tryRemoteStream(gen, stat, probed, opts = {}) {
    const { signal } = this.pageAbort;
    const c = config();
    const remote = vscode.env.remoteName;
    if (this.fullRes || this.noRemoteStream || !vscode.workspace.isTrusted) return false;
    if (c.decoder === 'builtin' || decide.failedBefore(globalState.get(decide.FAILED_KEY), this.file, stat)) return false;
    const t = probed ? probed.t : await tools();
    if (!t || this.stale(gen)) return false;
    let pr = probed ? probed.pr : null;
    if (!pr) {
      try { pr = await ff.probe(t, this.file, signal); } catch (e) { log(`[${this.name}] ffprobe failed: ${e.message}`); }
    }
    if (this.stale(gen) || !pr || !pr.video) return false;
    const lastView = globalState && globalState.get(LAST_VIEW_KEY);
    const decision = transcodePolicy.shouldTranscodeOnOpen({
      mode: c.transcode,
      remote,
      video: pr.video,
      maxBitrateMbps: c.transcodeMaxBitrate,
      viewHeight: lastView && lastView.h > 0 ? lastView.h : 0,
      forced: !!opts.forced,
      remotePrompted: !!this.remoteTranscodePrompted,
    });
    if (decision.action === 'prompt_remote') {
      this.remoteTranscodePrompted = true;
      maybeOfferRemoteTranscode(this, remote, () => {
        if (this.stale(gen)) return;
        this.forceTranscode = true;
        this.reload('live transcode accepted');
      }).catch((e) => log(`remote transcode prompt failed: ${e && e.message || e}`));
      return false;
    }
    if (decision.action !== 'stream') return false;
    const isRemoteLink = (!!remote && remote !== 'wsl') || c.remoteStream === 'on';
    const stream = await transcodeOptions(t, pr, c, isRemoteLink);
    if (this.stale(gen)) return false;
    if (!stream) {
      log(`[${this.name}] live transcode: no usable H.264 encoder available on this host; keeping original decoder`);
      return false;
    }
    log(`[${this.name}] decoder: remote stream / live transcode (${stream.encoder}, decode=${stream.decodeMethod}, ${remote || 'local'} window): ${pr.video.codec} ${pr.video.pixFmt} ${pr.video.width}x${pr.video.height}`);
    this.native = new remotestream.EncodedStream({
      ...stream, tools: t, file: this.file, maxHeight: c.nativeMaxHeight, fitView: fitsView(c), probed: pr,
      stats: !!logFile, maxBitrateMbps: c.transcodeMaxBitrate, allowLinkAdapt: isRemoteLink,
      post: (msg) => {
        if (!signal.aborted) this.post(msg.type === 'remoteNotice' ? { type: 'toast', text: msg.text, ms: 6000 } : { type: 'nd', m: msg });
      },
      log: (msg) => log(`[${this.name}] ${msg}`),
      onFail: (err) => {
        if (signal.aborted) return;
        log(`[${this.name}] remote stream failed (${err}); using the built-in decoder`);
        this.noRemoteStream = true;
        this.forceTranscode = false;
        vscode.window.showWarningMessage(`${path.basename(this.file)}: live transcode failed (${err}). Using the original decoder.`);
        this.reload('live transcode failed');
      },
    });
    this.post({ type: 'libav', meta: { size: stat.size, duration: 0, label: '', native: true } });
    return true;
  }

  /** The file opened once for block reads, even when several reads race; size taken at open (a change reloads). */
  blockFile() {
    if (!this.blockFh) {
      const p = fs.promises.open(this.file, 'r').then(async (fh) => {
        try { return { fh, size: (await fh.stat()).size }; } catch (e) { fh.close().catch(() => {}); throw e; }
      });
      p.catch(() => { if (this.blockFh === p) this.blockFh = null; });
      this.blockFh = p;
    }
    return this.blockFh;
  }

  /** @param {number} pos @param {number} len @param {() => boolean} isCurrent */
  async readBlock(pos, len, isCurrent) {
    let data = new Uint8Array(0);
    if (this.url) {
      // Over the network (src/urlsource.js): an empty answer is a read error for the decoder.
      const net = this.net;
      if (net && Number.isInteger(pos) && pos >= 0 && len > 0) {
        try {
          const buf = await net.read(pos, Math.min(len, MAX_BLOCK));
          data = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        } catch (e) {
          log(`[${this.name}] read ${pos}+${len}: ${e.message}`);
          if (isCurrent() && !this.netFailed) { this.netFailed = true; this.fail(e, 'Check the connection and open the URL again.'); }
        }
      }
      return net === this.net ? data : undefined;
    }
    try {
      const { fh, size } = await this.blockFile();
      if (!isCurrent()) return undefined;
      data = await readFileBlock(fh, size, pos, len, MAX_BLOCK);
    } catch (e) {
      if (isCurrent()) this.fail(e);
    }
    // Always answer (empty on error), or the webview keeps the block in flight forever.
    return data;
  }

  async openSequence() {
    const gen = this.loadGen;
    const seq = this.sequence;
    this.frames = seq.files;
    const fps = config().sequenceFps || 30;
    const sample = seq.files.slice(0, 50);
    const sizes = await Promise.all(sample.map((f) => fs.promises.stat(f).then((s) => s.size, () => 0)));
    const total = (sizes.reduce((a, b) => a + b, 0) / sample.length) * seq.files.length;
    const meta = {
      mode: 'frames', width: 0, height: 0, fps, frames: seq.files.length, duration: seq.files.length / fps,
      size: total, label: `image sequence · ${seq.files.length} files in ${seq.dir} · ${fps} fps (videoPreviewEnhanced.sequenceFps)`,
    };
    if (this.stale(gen)) return;
    log(`[${this.name}] image sequence: ${seq.files.length} frames`);
    this.post({ type: 'frames', meta, wav: null });
  }

  async startMjpeg(info, stat, signal) {
    const gen = this.loadGen;
    const fh = await fs.promises.open(this.file, 'r');
    if (this.stale(gen)) { await fh.close(); return; }
    this.frames = info.frames;
    this.fh = fh;
    let audioNote = 'no audio';
    if (info.audio && info.audio.pcm) {
      const bytes = info.audio.chunks.reduce((n, c) => n + c.size, 0);
      if (bytes > 0 && bytes <= MAX_WAV_BYTES) {
        // The sound goes ahead in parts of up to 8 MB ('wavPart'), not one message of up to 512 MB.
        const parts = avi.pcmWavParts(this.file, info.audio, WAV_PART_BYTES, signal);
        // The iterator can be suspended at a yield while the webview acknowledges the previous part.
        const close = () => { parts.return().catch(() => {}); };
        signal.addEventListener('abort', close, { once: true });
        try {
          for await (const part of parts) {
            if (signal.aborted) return;
            await this.webview.postMessage({ type: 'wavPart', data: new Uint8Array(part.buffer, part.byteOffset, part.length) });
          }
        } finally {
          signal.removeEventListener('abort', close);
        }
        audioNote = `PCM ${info.audio.sampleRate / 1000} kHz`;
      } else if (bytes > 0) {
        audioNote = 'audio skipped (too long)';
      }
    }
    const meta = {
      mode: 'frames', width: info.width, height: info.height, fps: info.fps || 30,
      frames: info.frames.length, duration: info.frames.length / (info.fps || 30),
      label: `MJPEG · frames shown directly · ${audioNote}`, size: stat.size,
    };
    if (this.stale(gen)) return;
    log(`[${this.name}] MJPEG direct: ${meta.width}x${meta.height} ${meta.fps}fps ${meta.frames} frames, ${audioNote}`);
    this.post({ type: 'frames', meta, wav: null });
  }

  async sendFrames(indices) {
    if (!this.frames) return;
    const gen = this.loadGen;
    for (const i of indices) {
      if (this.disposed || gen !== this.loadGen) return;
      const f = this.frames[i];
      let data = Buffer.alloc(0);
      try {
        if (typeof f === 'string') {
          data = await fs.promises.readFile(f);
        } else if (f) {
          const buf = Buffer.alloc(f.size);
          const { bytesRead } = await this.fh.read(buf, 0, f.size, f.offset);
          data = avi.fixJpeg(buf.subarray(0, bytesRead));
        }
      } catch (e) {
        log(`[${this.name}] frame ${i}: ${e.message}`);
      }
      // Always answer (empty when unreadable), or the player keeps the frame in flight forever.
      if (gen === this.loadGen) this.post({ type: 'frame', index: i, data: new Uint8Array(data.buffer, data.byteOffset, data.length) });
    }
  }

  // ---- subtitles ---------------------------------------------------------

  /** Sidecar subtitles next to the video, plus files loaded earlier in this tab. */
  async sendSubtitles() {
    const gen = this.loadGen;
    const files = this.sequence || this.url ? [] : await findSidecars(vscode, this.uri, (msg) => log(`[${this.name}] ${msg}`));
    if (files.length) log(`[${this.name}] subtitles found: ${files.map((f) => f.name).join(', ')}`);
    const extra = [];
    for (const uri of this.extraSubs) {
      try { extra.push({ id: uri.toString(), name: uri.path.split('/').pop(), data:new Uint8Array(await vscode.workspace.fs.readFile(uri)) }); } catch { /* moved or deleted */ }
    }
    if (this.stale(gen)) return;
    if (files.length) this.post({ type: 'subs', files });
    if (extra.length) this.post({ type: 'subs', files: extra, restore: true });
  }

  /** "Load subtitles…": pick files (in remote windows, on the remote side) and show the first. */
  async loadSubtitles() {
    const folder = this.sequence ? vscode.Uri.file(this.sequence.dir) : this.url ? workspaceFolder() : vscode.Uri.joinPath(this.uri, '..');
    const testPicked = this.testPickSubtitles;
    this.testPickSubtitles = undefined;
    const picked = testPicked || await vscode.window.showOpenDialog({
      defaultUri: folder, canSelectMany: true, openLabel: 'Load subtitles',
      filters: { Subtitles: ['srt', 'vtt', 'ass', 'ssa'], 'All files': ['*'] },
    });
    if (!picked || this.disposed) return;
    const files = [];
    for (const uri of picked) {
      const name = uri.path.split('/').pop();
      try {
        const st = await vscode.workspace.fs.stat(uri);
        if (st.size > MAX_SUB_BYTES) throw new Error('file is larger than 20 MB');
        files.push({ id: uri.toString(), name, data: new Uint8Array(await vscode.workspace.fs.readFile(uri)) });
        if (!this.extraSubs.some((u) => u.toString() === uri.toString())) this.extraSubs.push(uri);
      } catch (e) {
        vscode.window.showWarningMessage(`Video Preview: cannot load ${name}: ${e.message}`);
      }
    }
    if (files.length) this.post({ type: 'subs', files, select: true });
  }

  // ---- frame export ------------------------------------------------------

  async saveFrame(data, frame) {
    const { signal } = this.pageAbort;
    // From the page: PNG bytes and a frame index that names the default file (security review 2026-11-19 #7).
    if (!(data instanceof Uint8Array) || !Number.isInteger(frame) || frame < 0) return;
    const base = this.sequence ? this.sequence.name.replace(/#+/, '').replace(/\.[^.]+$/, '') : this.url ? urlBase(this.url) : path.parse(this.file).name;
    const dir = this.sequence ? this.sequence.dir : this.url ? (workspaceFolder() || vscode.Uri.file(os.homedir())).fsPath : path.dirname(this.file);
    const defaultUri = vscode.Uri.file(path.join(dir, `${base}_frame${String(frame + 1).padStart(5, '0')}.png`));
    // Tests (VPE_LOG with VPE_SAVE_DIR): no native dialog, the file goes to that folder.
    const target = logFile && process.env.VPE_SAVE_DIR ? vscode.Uri.file(path.join(process.env.VPE_SAVE_DIR, path.basename(defaultUri.fsPath)))
      : await vscode.window.showSaveDialog({ defaultUri, filters: { 'PNG image': ['png'] } });
    if (!target || signal.aborted) return;
    await vscode.workspace.fs.writeFile(target, data);
    if (signal.aborted) return;
    const pick = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, 'Open');
    if (pick === 'Open' && !signal.aborted) vscode.commands.executeCommand('vscode.open', target);
  }

  // ---- A-B export (rangecmd.js) -------------------------------------------

  /** Asks the page for frame k (0-based) as PNG bytes; resolves with {data} or {error}. */
  grabFrame(frame, signal) {
    if (this.pageAbort.signal.aborted || signal.aborted) return Promise.resolve({ error: 'export cancelled' });
    if (!this.exportWait) { this.exportWait = new Map(); this.exportSeq = 0; }
    const id = ++this.exportSeq;
    return new Promise((resolve) => {
      let timer;
      const finish = (reply) => {
        if (!this.exportWait.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolve(reply);
      };
      const cancel = () => finish({ error: 'export cancelled' });
      // The page draws nothing while hidden: only time it is shown counts.
      const arm = () => {
        timer = setTimeout(() => {
          if (!this.panel.visible) { arm(); return; }
          finish({ error: 'the player did not answer within 30 s' });
        }, 30000);
      };
      this.exportWait.set(id, finish);
      signal.addEventListener('abort', cancel, { once: true });
      arm();
      // checkJs: start
      this.post(/** @satisfies {ExportGrab} */ ({ type: 'exportGrab', boot: this.boot, page: this.page, id, frame }));
      // checkJs: end
    });
  }

  /** Every frame of A-B as `<video>_f000123.png` in a folder the user picks (written through workspace.fs: remote too). */
  async exportRange(range) {
    const { signal } = this.pageAbort;
    if (this.exporting) { vscode.window.showInformationMessage('Video Preview: an export is already running.'); return; }
    const problem = rangecmd.rangeProblem(range);
    if (problem) { vscode.window.showInformationMessage(`Video Preview: ${problem}`); return; }
    const count = range.fb - range.fa + 1;
    if (count > rangecmd.MAX_FRAMES) {
      vscode.window.showWarningMessage(`Video Preview: A-B holds ${count} frames; export takes at most ${rangecmd.MAX_FRAMES}. Shorten the loop, or use "Copy ffmpeg Command for A–B".`);
      return;
    }
    if (count > rangecmd.CONFIRM_FRAMES) {
      const ok = await vscode.window.showWarningMessage(`Export ${count} frames as PNG? This can take a while and use a lot of disk space.`, { modal: true }, 'Export');
      if (signal.aborted || ok !== 'Export') return;
    }
    if (this.native && this.native.lossy()) {
      const n = this.native;
      const fullResolution = 'Switch to Full Resolution (This Tab)';
      const ok = await vscode.window.showWarningMessage(
        `Native ffmpeg decodes this video at ${n.w}×${n.h} (${n.deep ? 10 : 8}-bit) for smooth playback. Exported PNGs will use this playback picture.`,
        { modal: true }, fullResolution, 'Export Anyway');
      if (signal.aborted) return;
      if (ok === fullResolution) {
        this.useFullRes();
        vscode.window.showInformationMessage('Video Preview: now on the built-in decoder at full resolution. Run the export again once the video shows.');
        return;
      }
      if (ok !== 'Export Anyway') return;
    }
    const base = this.url ? urlBase(this.url) : path.parse(this.file).name;
    // Tests (VPE_LOG with VPE_EXPORT_DIR): no native dialog, the frames go to that folder.
    const pick = logFile && process.env.VPE_EXPORT_DIR ? [vscode.Uri.file(process.env.VPE_EXPORT_DIR)] : await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: `Export ${count} frames here`, defaultUri: this.url ? workspaceFolder() : vscode.Uri.joinPath(this.uri, '..'),
    });
    if (signal.aborted || !pick || !pick.length) return;
    const folder = pick[0];
    // Ask before writing over frames exported before.
    let existing = 0;
    try {
      const names = new Set((await vscode.workspace.fs.readDirectory(folder)).map(([n]) => n));
      for (let k = range.fa; k <= range.fb; k++) if (names.has(rangecmd.frameFileName(base, k + 1))) existing++;
    } catch { /* unreadable: writing reports the problem */ }
    if (signal.aborted) return;
    if (existing) {
      const ok = await vscode.window.showWarningMessage(`Overwrite ${existing} existing file${existing === 1 ? '' : 's'}?`, { modal: true, detail: `${folder.scheme === 'file' ? folder.fsPath : folder.toString()} already holds ${existing === 1 ? 'a frame' : 'frames'} of this range.` }, 'Overwrite');
      if (ok !== 'Overwrite') return;
    }
    if (signal.aborted || this.exporting) return; // another export started while the dialogs were open
    this.exporting = signal;
    // The page decodes and draws only while shown: bring it to the front.
    if (this.panel) this.panel.reveal(undefined, true);
    let done = 0;
    let failed = null;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting frames ${range.fa + 1}–${range.fb + 1}`, cancellable: true }, async (progress, token) => {
        const controller = new AbortController();
        const work = controller.signal;
        const cancel = () => controller.abort();
        const sub = token?.onCancellationRequested(cancel);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted || token?.isCancellationRequested) cancel();
        try {
          let last = -1; // the last frame written
          for (let k = range.fa; k <= range.fb && !work.aborted;) {
            if (!this.panel.visible) {
              progress.report({ message: `${done} / ${count}, paused while the player is hidden` });
              if (!work.aborted) await new Promise((resolve) => {
                const go = () => {
                  work.removeEventListener('abort', go);
                  this.onShown = null;
                  resolve();
                };
                this.onShown = go;
                work.addEventListener('abort', go, { once: true });
              });
              continue;
            }
            const hiddenCount = this.hiddenCount;
            const r = await this.grabFrame(k, work);
            if (work.aborted) break;
            // Showing the player again can re-seek to the last picture and supersede this grab's seek.
            if (hiddenCount !== this.hiddenCount) continue;
            if (!r || r.error || !r.data) { failed = r && r.error ? r.error : 'no picture'; break; }
            // VFR or gapped video: the seek can settle on a neighbour. Name the file from the frame shown; skip repeats.
            const shown = Number.isInteger(r.frame) ? r.frame : k;
            if (shown > last && shown >= range.fa && shown <= range.fb) {
              await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, rangecmd.frameFileName(base, shown + 1)), new Uint8Array(r.data));
              done++;
              if (work.aborted) break;
              last = shown;
            }
            const next = Math.max(k + 1, shown + 1);
            progress.report({ increment: (100 * (Math.min(next, range.fb + 1) - k)) / count, message: `${done} / ${count}` });
            k = next;
          }
        } finally {
          signal.removeEventListener('abort', cancel);
          sub?.dispose();
        }
      });
    } catch (e) {
      failed = e && e.message ? e.message : String(e);
    } finally {
      if (this.exporting === signal) this.exporting = null;
      if (!signal.aborted) this.post({ type: 'exportEnd' });
    }
    if (signal.aborted) return;
    log(`[${this.name}] exported ${done}/${count} frames to ${folder.toString()}${failed ? ` (stopped: ${failed})` : ''}`);
    if (failed) vscode.window.showErrorMessage(`Video Preview: exported ${done} of ${count} frames, then stopped: ${failed}`);
    else vscode.window.showInformationMessage(`Video Preview: exported ${done} of ${count} frames to ${folder.scheme === 'file' ? folder.fsPath : folder.toString()}`);
  }

  /** Copies an ffmpeg command that cuts A-B: exact (re-encode) or fast (-c copy, keyframe-aligned). */
  async copyFfmpegRange(range) {
    const { signal } = this.pageAbort;
    if (this.url) { vscode.window.showInformationMessage('Video Preview: the ffmpeg command for A–B is for video files, not URLs.'); return; }
    const problem = rangecmd.rangeProblem(range);
    if (problem) { vscode.window.showInformationMessage(`Video Preview: ${problem}`); return; }
    let cmd;
    try { cmd = rangecmd.ffmpegRange(this.file, range, process.platform, vscode.env.shell); } catch (e) { vscode.window.showWarningMessage(`Video Preview: ${e.message}`); return; }
    const pick = await vscode.window.showQuickPick([
      { label: 'Exact cut (re-encode)', detail: cmd.exact, cmd: cmd.exact },
      { label: 'Fast cut (-c copy)', description: 'keyframe-aligned: starts at the keyframe at or before A', detail: cmd.copy, cmd: cmd.copy },
    ], { placeHolder: `ffmpeg command for frames ${range.fa + 1}–${range.fb + 1} (${cmd.ss} s to ${cmd.to} s)` });
    if (!pick || signal.aborted) return;
    await vscode.env.clipboard.writeText(pick.cmd);
    if (signal.aborted) return;
    this.post({ type: 'toast', text: 'ffmpeg command copied' });
  }

  /** Tile numbers playing through Live transcode (0 for this single player), for the clip export's early refusal. */
  liveTranscodeTiles() { return this.native instanceof remotestream.EncodedStream ? [0] : []; }

  /** The user took the early refusal's switch: the built-in decoder for this tab, so A and B are set again on exact times. */
  useOriginalForClips() { this.useFullRes(); }

  /** Pixel tools asked for the file's own pixels: the built-in decoder for this tab (kept across reloads). */
  useFullRes() {
    if (this.fullRes || !this.native) return;
    this.fullRes = true;
    this.forceTranscode = false;
    this.reload('full resolution asked for: built-in decoder');
  }

  /** Native ffmpeg failed on this file (also in software): remembered, and the built-in decoder takes over. */
  async nativeFailed(error, gen) {
    if (this.stale(gen)) return;
    if (this.url) { // not remembered (no file): this tab tries the built-in decoder
      log(`[${this.name}] native ffmpeg can't play this URL (${error}); trying the built-in decoder`);
      this.noNative = String(error || '');
      this.reload('native ffmpeg failed');
      return;
    }
    log(`[${this.name}] native ffmpeg can't play this file (${error}); using the built-in decoder`);
    // The next window checks the tools again instead of trusting the stored check.
    globalState.update(TOOLS_KEY, undefined).then(undefined, () => {});
    try {
      const st = fs.statSync(this.file);
      await globalState.update(decide.FAILED_KEY, decide.addFailed(globalState.get(decide.FAILED_KEY), this.file, st, error));
    } catch { /* gone: nothing to remember */ }
    if (!this.stale(gen)) this.reload('native ffmpeg failed');
  }

  /**
   * Whether the page may offer the ffmpeg setup (status pill) and mention ffmpeg (toast):
   * offered when it isn't installed, in a local trusted window, unless "Don't Show Again".
   */
  sendFfmpegState() {
    const gen = this.loadGen;
    // Restricted Mode runs no ffmpeg at all, not even `-version` (security review 2026-11-19 #6).
    (vscode.workspace.isTrusted ? tools() : Promise.resolve(null)).then((t) => {
      if (this.stale(gen)) return;
      const h = globalState.get(decide.HINT_KEY) || {};
      const offer = !t && !vscode.env.remoteName && vscode.workspace.isTrusted && !h.never;
      this.post({ type: 'ffmpegState', installed: !!t, offer, mb: setup.downloadSizeMB() });
    }, () => {});
  }

  /**
   * A decode speed sample from the page (media/engine.js sampleSpeed): built-in samples are stored per
   * class and may bring the setup hint; slow ones, and native ones, may bring the GPU test offer.
   */
  onSpeed(m) {
    if (m.remoteStream || this.native instanceof remotestream.EncodedStream) return;
    const native = !!this.native;
    if (!!m.native !== native) return; // a sample from before the page switched decoders
    const sample = {
      codec: String(m.codec || ''), depth: Number(m.depth) || 8, width: Number(m.width) || 0, height: Number(m.height) || 0,
      fps: Number(m.fps) || 0, ratio: Number(m.ratio) || 0, realtime: !!m.realtime, native,
    };
    if (!sample.codec || !sample.width || !sample.height || !(sample.ratio > 0)) return;
    if (native) {
      const was = this.slowRun || 0;
      this.slowRun = sample.realtime ? 0 : was + 1;
      if (!sample.realtime && was === 0) log(`[${this.name}] native ffmpeg below real time: ${sample.ratio.toFixed(2)}x (${decide.describe(sample)}, ${this.native.method})`);
      if (!sample.realtime) {
        const c = config();
        const v = this.native.pr && this.native.pr.video;
        // Distinguish raw transfer bottleneck from decode bottleneck using measured producer backpressure
        // rather than nominal source dimensions, so decode-bound files still trigger the GPU decode test.
        const hostKeepsUp = typeof this.native.hostKeepsUp === 'function' ? this.native.hostKeepsUp() : false;
        const outputVideo = v ? { ...v, width: this.native.w || v.width, height: this.native.h || v.height, fps: this.native.fps || v.fps } : null;
        const stallAction = transcodePolicy.evaluateLocalStall({
          mode: c.transcode,
          slowWindows: this.slowRun,
          hostKeepsUp,
          playing: m.playing !== undefined ? !!m.playing : true,
          rate: m.rate !== undefined ? Number(m.rate) : 1,
          hidden: !!m.hidden,
          sinceEventMs: m.sinceEventMs !== undefined ? Number(m.sinceEventMs) : transcodePolicy.STALL_SETTLE_MS,
          video: outputVideo,
          alreadyTranscoding: false,
          promptedThisSession: !!this.localTranscodePrompted,
        });
        if (stallAction === 'switch') {
          log(`[${this.name}] live transcode: auto-switching after transfer stall`);
          this.forceTranscode = true;
          this.reload('live transcode auto');
          return;
        }
        if (stallAction === 'prompt') {
          this.localTranscodePrompted = true;
          maybeOfferLocalTranscode(this).catch((e) => log(`local transcode prompt failed: ${e && e.message || e}`));
          return;
        }
        if (!hostKeepsUp) maybeOfferProbe(this, sample).catch((e) => log(`GPU test offer failed: ${e && e.message || e}`));
      }
      return;
    }
    recordSpeed(sample);
    const was = this.slowRun || 0;
    this.slowRun = sample.realtime ? 0 : was + 1;
    if (!sample.realtime && was === 0) log(`[${this.name}] built-in decoder below real time: ${sample.ratio.toFixed(2)}x (${decide.describe(sample)})`);
    if (sample.realtime && was > 0) log(`[${this.name}] built-in decoder back to real time`);
    if (!sample.realtime) {
      maybeHint(this, sample).catch((e) => log(`hint failed: ${e && e.message || e}`));
      maybeOfferProbe(this, sample).catch((e) => log(`GPU test offer failed: ${e && e.message || e}`));
    }
  }

  closeFile() {
    if (this.net) { this.net.close(); this.net = null; }
    if (this.fh) { this.fh.close().catch(() => {}); this.fh = null; }
    if (this.blockFh) { this.blockFh.then((h) => h.fh.close(), () => {}).catch(() => {}); this.blockFh = null; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    sessions.delete(this);
    if (lastActive === this) lastActive = null;
    if (logFile) log(`[${this.name}] session closed`);
    clearTimeout(this.watchTimer);
    this.watchTimer = null;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    this.closePage('closed');
    this.boots.clear();
    if (this.pos && this.pos !== this.savedPos) this.savePos();
  }
}

function deactivate() {
  resetFocusMode();
}

module.exports = { activate, deactivate };
