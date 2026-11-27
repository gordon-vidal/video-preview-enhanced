'use strict';
const T_LOAD = Date.now(); // start-up timeline (tests): when the extension's module started loading
// Video Preview Enhanced: a decode-only video player for VS Code.
// The extension host only reads files; all decoding happens in the webview
// (WebCodecs for what the GPU decoder handles, libav.js WebAssembly for the rest).
// Every video opens in the unified viewer (src/unified-viewer.js over src/unified-session.js, the page
// media/player-unified.js): one panel that shows one video and grows to a comparison of several and back.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  VIDEO_EXT, MOVE_TO_NEW_WINDOW, videoPickerOptions, isLocalFile, videoColumn, localVideoTarget, playerViewType,
} = require('./open-video');
// Modules a feature needs (URLs, ffmpeg setup and download, A-B export, AVI, the remote stream) load on first use:
// a window start pays only for what it runs. The proxy forwards property reads to the real module.
const lazy = (load) => { let m; return new Proxy({}, { get: (_, k) => (m || (m = load()))[k] }); };
const { findSequence } = require('./sequence');
const ff = require('./ffmpeg');
const setup = lazy(() => require('./setup'));
const hardware = require('./hardware');
const { NativeDecoder, onGuessFailed } = require('./native');
const { ExactFrameGrabber } = require('./exact_frame');
const { toggleFocusMode, noteFocusModeExited, resetFocusMode, setFocusModeListener } = require('./focus-mode');
const frameserver = require('./frameserver'); // native frames over 127.0.0.1 (local windows)
const remotestream = lazy(() => require('./remotestream')); // unified Live transcode stream engine (ADR 0002)
const transcodePolicy = lazy(() => require('./transcode_policy'));
const transcodeProbe = lazy(() => require('./transcode_probe'));
const transcodeArgs = lazy(() => require('./transcode_args'));
const probe = lazy(() => require('./probe')); // ffmpeg's GPU decoding tested on this machine
const decide = require('./decide'); // native ffmpeg or built-in, per file
const localff = lazy(() => require('./localff')); // "Use an ffmpeg I already have…"
const remoteff = lazy(() => require('./remoteff')); // ffmpeg downloaded on the remote host, for the remote stream
const walkthrough = lazy(() => require('./walkthrough')); // Setup Guide walkthrough + AI agent snippet
const proxy = lazy(() => require('./proxy'));
const { rotationOf } = require('./rotation');
const { createUnifiedRegistry } = require('./unified-session'); // which viewer takes a newly opened video (capture)
const unifiedViewer = require('./unified-viewer'); // the viewer's host (one panel, 1 to N videos)
const { createSequenceDecoder, createUrlDecoder, sequenceFacts } = require('./unified-sources'); // URL and sequence clips
const {
  pickRows, pushRecent, droppedVideos, collectFolderVideos, compareTargets, VIDEO_EXT: COMPARE_VIDEO_EXT, setPickHook, getPickHook,
} = require('./comparepick'); // Compare's quick pick, selections and the test hook
const { BURST_WINDOW_MS, createBurst, togetherNotice } = require('./burst'); // Open Together
const Grid = require('../media/compare-grid');
const { parseFragment } = require('../media/inspect.js');
const { findSidecars, MAX_BYTES: MAX_SUB_BYTES } = require('./sidecars');
const rangecmd = lazy(() => require('./rangecmd')); // A-B frame export and ffmpeg command
const exclusiveWrite = lazy(() => require('./exclusivewrite')); // create-only frame writes (no overwrite race)
const clipExport = lazy(() => require('./clipexport'));
const { syntheticRefusal, compareClipJobs } = require('./clipsource');
const membudget = require('../media/membudget.js'); // decoder pool and frame caches sized from the machine's memory
const urlsource = lazy(() => require('./urlsource')); // Open Video URL… (docs/notes/url-stream.md)
const { createSettings, PREFS } = require('./settings'); // settings, player prefs, globalState fallback
const { createOffers } = require('./offers'); // onboarding, hint, GPU test and remote ffmpeg offers
const { createAssociations } = require('./associations'); // default viewer for MP4/WebM, file icons
const { createFrameLink, isLocalVideo, hlsPlanText } = require('./framelink'); // frame links, native frame sizes
const { createDebugCommands } = require('./debug-cmd'); // the VPE_LOG test hook (<log>.cmd)
const { linkSimulatorFromEnv, effectiveRemoteName } = require('./link-sim'); // VPE_SIMULATE_LINK / VPE_SIMULATE_REMOTE
const { LinkSessionMemory } = require('./stream-adapt');
const { watchFile } = require('./file-watch');
const folderRail = require('./folder-rail'); // the folder rail, neighbours, Autoplay's next video, tab-swap handoff

const HIDE_SLOW_PLAYBACK_NOTICE = 'videoPreviewEnhanced.hideSlowPlaybackNotice';
const HIDE_REDUCED_RES_NOTICE = 'videoPreviewEnhanced.hideReducedResNotice';
/** The notices "Don't show again" hides for good, by the page's action id. */
const NOTICE_KEYS = { hideSlowPlaybackNotice: HIDE_SLOW_PLAYBACK_NOTICE, hideReducedResNotice: HIDE_REDUCED_RES_NOTICE };
const VIEW_TYPES = ['videoPreviewEnhanced.player', 'videoPreviewEnhanced.playerOptional'];
/** The webview panel type of a viewer a Compare command opens (not a custom editor: it has several files). */
const COMPARE_VIEW_TYPE = 'videoPreviewEnhanced.compare';
const SEQUENCE_VIEW_TYPE = 'videoPreviewEnhanced.sequence';
const RECENT_KEY = 'videoPreviewEnhanced.compareRecent';

let out;
let globalState;
let storageDir = '';
let toolsPromise = null;
let extensionDir = '';
let hwPromise = null; // hardware.detect(), once per session (Re-test detects again)
let probeRun = null; // the running probe (one at a time)
let probeChecked = false; // fingerprint compared this session
let offers = null; // createOffers(), built in activate once globalState exists
let speedsMem = null; // built-in speed records, written to globalState in batches
let speedsTimer = null;
const POSITIONS_KEY = 'videoPreviewEnhanced.positions';
// Schemes whose fsPath is the real file for this (workspace) extension host: local
// files, and files on the remote machine in SSH/WSL/container windows.
const FS_SCHEMES = new Set(['file', 'vscode-remote']);
// Test logging and the debug command hook: only the VPE_LOG env var turns them on.
// Never a setting: a workspace could point it at any file and run commands.
const logFile = process.env.VPE_LOG || '';
// Tests (with VPE_LOG only): decoder pool options for the webview, e.g. {"workers":4,"budget":1e9}.
const debugPool = (() => { try { return logFile && process.env.VPE_POOL ? JSON.parse(process.env.VPE_POOL) : undefined; } catch { return undefined; } })();
/**
 * The window kind that decides what this window can do (raw native frames, Live transcode, link-limited streaming).
 * vscode.env.remoteName, unless VPE_SIMULATE_REMOTE / VPE_SIMULATE_LINK pretend otherwise (src/link-sim.js). Real
 * remote paths, URIs and the host's own state keys keep using vscode.env.remoteName.
 */
const remoteName = () => effectiveRemoteName(vscode);
/** VPE_SIMULATE_LINK: one slow / flaky link shared by every player and Compare panel (null when unset, the normal case). */
let linkSim = null;
const sessionLink = new LinkSessionMemory();
// The open viewers (src/unified-viewer.js), the registry that says which one captures a newly opened video, and what
// they get from this host (set in activate).
const unifiedViewers = new Set();
const unifiedRegistry = createUnifiedRegistry();
let unifiedDeps = null;
/** The viewer the user used last (export and subtitle commands act on it when no viewer is active). */
let lastViewer = null;
const clipExports = new WeakSet();
/** Sound codecs whose WebCodecs decoder lagged in this VS Code session ('audio-aac', ...): the built-in decoder plays them from then on. */
const wcFailed = new Set();
// Frame links (vscode://<id>/open?…) waiting for their viewer: file URI string -> {t, frame}.
const pendingGoto = new Map();
// Folder navigation (src/folder-rail.js): the intent a new tab takes over (rail state, Autoplay), registered before
// vscode.openWith, and the file metadata (ffprobe) the rails of every viewer share.
const railHandoffs = folderRail.createHandoffs();
const railMeta = folderRail.createMetaCache();
/** ffprobe (cached by size and date) for the rail's Duration column and hover card; none in Restricted Mode. */
async function railProbe(file, signal) {
  if (!vscode.workspace.isTrusted || config().decoder === 'builtin') return null;
  const t = await tools();
  if (!t || signal.aborted) return null;
  const pr = await ff.probe(t, file, signal);
  return { duration: pr.duration, width: pr.video && pr.video.width, height: pr.video && pr.video.height, codec: pr.video && pr.video.codec };
}
/** The rail's remembered look (width, column, Playable formats), shared by every viewer. */
const railPrefs = {
  get: () => globalState.get(folderRail.RAIL_PREFS_KEY),
  set: (v) => globalState.update(folderRail.RAIL_PREFS_KEY, v),
};
// How long a page may take to adopt a folder rail handed over to it (src/unified-viewer.js railHandoff).
const ADOPT_MS = Number(process.env.VPE_ADOPT_MS) > 0 && logFile ? Number(process.env.VPE_ADOPT_MS) : 20000;
const PENDING_GOTO_MS = 30e3; // a link's viewer normally opens within a second

function log(msg) {
  out.appendLine(msg);
  if (logFile) fs.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`, () => {});
}

const { prefTarget, rememberPlaybackPrefs, prefsOf, config, setSetting } = createSettings({
  vscode, getState: () => globalState, log, transcodePolicy, pages: unifiedViewers,
});
const { makeDefault, undoDefault, autoDefault, fileIcons } = createAssociations({ vscode, getState: () => globalState, log });
const {
  gotoFrom, parseLink, parseCompareLink, remoteAuthority, localTarget, frameLink, nativeHeights, fitsView, nativeHeight, probeSummary, urlBase,
} = createFrameLink({ vscode, config, decide, nativeTransport, probe, urlsource, parseFragment });

const EXT_ID = 'gordon-vidal.video-preview-enhanced'; // publisher.name in package.json

function broadcastFocusMode(active) {
  for (const v of unifiedViewers) v.post({ type: 'focusMode', active: !!active });
}
setFocusModeListener(broadcastFocusMode);

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
      if (globalState) globalState.update(gpuCacheKey(), hwKnown);
    }, () => {});
  }
  return hwPromise;
}

// The GPUs found last (hardware.detect(): a WMI / lspci query, nothing decodes), kept across sessions:
// before any GPU test, they choose ffmpeg's method (decide.vendorMethod; docs/notes/cpu-4k.md).
function gpuCacheKey() { return hardware.gpuCacheKey(vscode.env.remoteName); }
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
 * Starts the GPU detection early (beside the ffmpeg lookup) when gpusForMethod would have to wait for it: GPU
 * decoding on and no fresh stored result. A GPU test record needs the tools, so it is not known here; it only
 * exists after a user-run test, which also stores the GPUs, so this costs nothing then. Nothing decodes.
 */
function prefetchGpus(c = config()) {
  if (!c.gpuDecoding || (hwKnown && !hwStale && Date.now() - (hwKnown.at || 0) < HW_MAX_AGE_MS)) return;
  machine();
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
        for (let said = false; !abort.signal.aborted && [...unifiedViewers].some((v) => v.busy()); said = true) {
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
 * Raw frames from a native decoder cross from the extension host to the webview.
 * That's fine on this machine and in WSL, too much for SSH and containers.
 */
function nativeAllowedHere() {
  const remote = remoteName();
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
  if (remoteName()) return 'message';
  const t = logFile ? process.env.VPE_NATIVE_TRANSPORT : '';
  return /^(message|http|ws|fail)$/.test(t || '') ? t : 'http';
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

/** Picks the Linux build for this host's CPU, downloads it into the extension's folder here, and reloads open players. */
async function downloadRemoteFfmpeg() {
  const host = os.hostname();
  setup.setAgentFor(proxyAgent());
  let build;
  try {
    build = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Video Preview: finding the ffmpeg build for ${host}…` },
      () => remoteff.chooseRemoteBuild(hostArch(), { base: buildBase(), detect: machine }));
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
  vscode.window.showInformationMessage(nt ? `Video Preview: ffmpeg ready on ${host} (${nt.version.replace(/ Copyright.*/, '')}). Live transcode uses it from now on.` : `Video Preview: ffmpeg was downloaded on ${host} but does not run there; see the output log.`);
  reloadViewers('ffmpeg changed');
}

const DRIVER_NOTICE_KEY = 'videoPreviewEnhanced.nvencDriverNotice';

/** Shows a one-time notice per ffmpeg binary + NVIDIA driver when NVENC refuses an older driver. */
function maybeShowDriverNotice(t, notice, nvidiaDriver) {
  if (!notice || !globalState) return;
  const key = `${t.ffmpeg}|${t.version || ''}|${nvidiaDriver || ''}`;
  const seen = globalState.get(DRIVER_NOTICE_KEY) || {};
  if (seen[key]) return;
  if (offers && offers.popupPending()) return;
  seen[key] = Date.now();
  globalState.update(DRIVER_NOTICE_KEY, seen).then(undefined, () => {});
  const text = transcodePolicy.driverNoticeText(notice);
  log(`[live transcode] ${text}${notice.requiredApi && notice.foundApi ? ` (NVENC API ${notice.requiredApi} vs ${notice.foundApi})` : ''}`);
  vscode.window.showInformationMessage(text, 'Got it', 'Set up ffmpeg').then((ans) => {
    if (ans === 'Set up ffmpeg') setupFfmpeg();
  }, () => {});
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
  if (vscode.env.remoteName && vscode.env.remoteName !== 'wsl' && remoteff.supported(hostPlatform(), hostArch())) {
    return downloadRemoteFfmpeg();
  }
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
  reloadViewers('ffmpeg changed');
  // No automatic GPU test after setup either; "Video Preview: Re-test ffmpeg" runs it on request.
}

/** The bundled decode-only libav.js build (media/libav-vpe, LGPL). */
function libavBuild(extUri) {
  const dir = vscode.Uri.joinPath(extUri, 'media', 'libav-vpe');
  const loader = fs.readdirSync(dir.fsPath).find((n) => /^libav-[\d.]+-vpe\.js$/.test(n));
  return { dir, loader, variant: 'vpe' };
}

/** The viewer the export and subtitle commands act on: the active one, else the one used last. */
function activeViewer() {
  return [...unifiedViewers].find((v) => v.panel.active) || (lastViewer && !lastViewer.disposed ? lastViewer : null);
}

/** Export commands: ask the active viewer for its A-B range (it replies with 'exportRange', 'ffmpegRange' or 'clipRange'). */
function askRange(then) {
  const v = activeViewer();
  const first = v && v.session.clips[0];
  if (!v || (first && first.kind === 'sequence')) {
    vscode.window.showInformationMessage(v ? 'Video Preview: frame export works for video files.' : 'Video Preview: open a video and set an A-B loop (A and B keys) first.');
    return undefined;
  }
  v.queryAb(then);
  return undefined;
}

function askClipRange(compare) {
  const target = [...unifiedViewers].find((v) => v.panel.active && (!compare || v.session.clips.length >= 2));
  if (target) target.queryAb('clip');
  else vscode.window.showInformationMessage('Video Preview: open a video or Compare and mark an A-B range first.');
}

/** A viewer's file clips, all reloaded (ffmpeg was set up, downloaded or changed). @param {string} why */
function reloadViewers(why) {
  for (const v of unifiedViewers) v.reloadAll(why).catch((e) => log(`reload (${why}) failed: ${e && e.message || e}`));
}

/**
 * A-B clip export (src/clipexport.js) of a viewer's clip: native ffmpeg cuts the file. `clip` is the clip the page's
 * range is for. One export per viewer at a time.
 */
async function exportClips(viewer, clip, jobs, compare = false) {
  if (clipExports.has(viewer)) return;
  const source = clip && clip.uri;
  if (!source || clip.kind === 'url' || clip.kind === 'sequence' || !FS_SCHEMES.has(source.scheme)) {
    vscode.window.showInformationMessage('Video Preview: clip export requires a video file on this host.');
    return;
  }
  if (!jobs.length) {
    vscode.window.showInformationMessage('Video Preview: set an A-B loop first with A and B.');
    return;
  }
  const live = viewer.session.clips.flatMap((c, i) => (viewer.decoderKind(c.id) === 'stream' ? [i] : []));
  const refusal = syntheticRefusal(jobs, live, compare);
  if (refusal) {
    // Marks without source timestamps: refuse before any ffmpeg work, and offer the switch in one click.
    const answer = await vscode.window.showWarningMessage(refusal.message, ...(refusal.label ? [refusal.label] : []));
    if (answer && answer === refusal.label && !viewer.disposed) {
      if (refusal.tiles.length) viewer.useOriginalVideo();
      else viewer.useFullRes();
    }
    return;
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Video Preview: clip export requires native ffmpeg in a trusted workspace.');
    return;
  }
  clipExports.add(viewer);
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
      announce: (message) => viewer.post({ type: 'toast', text: message, ms: 5000 }),
      testFolder: testDir ? vscode.Uri.file(testDir) : undefined,
      testConfirm: !!testDir && process.env.VPE_CLIP_EXPORT_CONFIRM === '1',
    });
  } catch (e) {
    log(`A–B export failed: ${e.message}`);
    vscode.window.showErrorMessage(`Video Preview: A–B export failed. ${e.message}`);
  } finally {
    clipExports.delete(viewer);
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
  if (!emulated && remoteName() && !(forNative && nativeAllowedHere())) return null;
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

/** Network options for src/urlsource.js: proxy (http.proxy / HTTPS_PROXY, like the ffmpeg download) and the variant cap. */
function netOpts() {
  const h = vscode.workspace.getConfiguration('http');
  const cfg = { proxy: h.get('proxy') || '', strictSSL: h.get('proxyStrictSSL', true), env: process.env };
  return { agentFor: proxy.agentFactory(cfg), proxyFor: (u) => proxy.proxyFor(u, cfg), maxHeight: 1080 };
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
 * Opens a viewer panel for a URL the user entered (checked again here). where: 'active' (this editor group),
 * 'side' (the group beside it, as VS Code's "Open to the Side") or 'window' (a new window: the panel opens
 * here, then VS Code moves it with workbench.action.moveEditorToNewWindow).
 */
async function openUrl(context, url, where = 'active') {
  const c = urlsource.checkUrl(url);
  if (c.error) { vscode.window.showWarningMessage(`Video Preview: ${c.error}`); return undefined; }
  await urlsource.rememberUrl(globalState, c.url);
  const column = videoColumn(where, vscode.ViewColumn);
  const name = urlsource.displayName(c.url);
  const panel = vscode.window.createWebviewPanel(URL_VIEW_TYPE, name, { viewColumn: column, preserveFocus: false }, { retainContextWhenHidden: true, enableFindWidget: false });
  panel.iconPath = new vscode.ThemeIcon('globe');
  if (where === 'window') {
    // The new panel is the active editor: move it (the webview moves with its context kept).
    try { await vscode.commands.executeCommand(MOVE_TO_NEW_WINDOW); }
    catch (e) { log(`open URL in a new window: ${e && e.message || e}`); }
  }
  const clip = unifiedViewer.sourceClip('url', c.url, { label: name, source: { url: c.url } });
  const viewer = await showViewer(context, panel, clip);
  log(`[${name}] URL tab opened (${where})`);
  return viewer;
}

/** @param {import('./open-video').OpenTarget} where @param {unknown} [clicked] */
async function openLocalVideo(where, clicked) {
  const activeInput = () => vscode.window.tabGroups?.activeTabGroup.activeTab?.input;
  let moving = false;
  try {
    const target = localVideoTarget(where, clicked, activeInput()?.uri ?? vscode.window.activeTextEditor?.document.uri)
      ?? (await vscode.window.showOpenDialog(videoPickerOptions()))?.[0];
    if (target === undefined) return;
    if (!isLocalFile(target)) {
      void vscode.window.showWarningMessage('Video Preview: choose a local video file.');
      return;
    }
    if (where === 'window') {
      moving = true;
      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes(MOVE_TO_NEW_WINDOW)) {
        throw new Error('requires VS Code 1.85 or newer');
      }
      moving = false;
    }
    const viewType = playerViewType(target);
    await vscode.commands.executeCommand('vscode.openWith', target, viewType, {
      viewColumn: videoColumn(where, vscode.ViewColumn), preview: false, preserveFocus: false,
    });
    if (where === 'window') {
      moving = true;
      // The move command acts on the active tab. Focus can change while openWith is running.
      const input = activeInput();
      if (input?.viewType !== viewType || input.uri?.toString() !== target.toString()) {
        throw new Error('the video tab is no longer active');
      }
      await vscode.commands.executeCommand(MOVE_TO_NEW_WINDOW);
    }
  } catch (e) {
    const action = moving ? 'open the video in a new window' : 'open the video file';
    void vscode.window.showErrorMessage(`Video Preview: could not ${action}: ${e?.message || e}`);
  }
}

/** Open Together (src/burst.js): videos VS Code opens within a moment of each other become one viewer. */
let burst = null;
/** The viewer a panel hosts (a burst can catch a video whose tab already became a viewer). */
const panelViewers = new WeakMap();
/** Tests (VPE_LOG only): the next Start Compare's open dialog result. */
let testCompareFiles;

/** First start after install: open the setup guide once (walkthrough.shouldOpenGuide says when). */
function maybeOpenSetupGuide() {
  const ctx = {
    opened: globalState.get(walkthrough.GUIDE_KEY),
    onboarding: globalState.get(decide.ONBOARD_KEY),
    openOnInstall: vscode.workspace.getConfiguration('workbench.welcomePage').get('walkthroughs.openOnInstall'),
  };
  if (!walkthrough.shouldOpenGuide(ctx)) return;
  globalState.update(walkthrough.GUIDE_KEY, Date.now()).then(undefined, () => {});
  log('first start: opening the setup guide');
  vscode.commands.executeCommand('videoPreviewEnhanced.openSetupGuide').then(undefined, (e) => log(`setup guide failed: ${e && e.message || e}`));
}

/**
 * A setup guide step's Next / Got it / Skip / Done button: mark the step done and show the next step this window has,
 * or close the guide after the last one. `id` comes from the button's command link.
 * Skipping the ffmpeg step explicitly declines the first-video ffmpeg popup too (people who close the tour still get it).
 */
async function setupNext(context, id, { skipped = true } = {}) {
  if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) return;
  if (id === 'ffmpeg' && skipped) {
    await globalState.update(decide.ONBOARD_KEY, decide.afterOnboard(decide.ONBOARD_BUILTIN));
  }
  await vscode.commands.executeCommand('setContext', walkthrough.doneKey(id), true);
  const steps = context.extension.packageJSON.contributes.walkthroughs[0].steps;
  const next = walkthrough.nextStep(steps, id, vscode.env.remoteName);
  if (!next) { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); return; }
  await vscode.commands.executeCommand('workbench.action.openWalkthrough',
    { category: `${EXT_ID}#${walkthrough.WALKTHROUGH_ID}`, step: next }, false);
}

/** Pick the Live transcode mode (Auto / Always / Off) in a list, with the setting's own one-line explanations. */
async function chooseTranscode(context) {
  // contributes.configuration may be one object or a list of them
  const props = [].concat(context.extension.packageJSON.contributes.configuration)
    .reduce((all, g) => ({ ...all, ...g.properties }), {});
  const spec = props['videoPreviewEnhanced.transcode'];
  const now = vscode.workspace.getConfiguration('videoPreviewEnhanced').get('transcode', spec.default);
  const names = { auto: 'Auto (recommended)', always: 'Always', off: 'Off' };
  const pick = await vscode.window.showQuickPick(spec.enum.map((v, i) => ({
    value: v, label: names[v] || v, description: v === now ? 'current' : '', detail: spec.enumDescriptions[i],
  })), { title: 'Live transcode: when should a lighter copy be streamed?', placeHolder: `Now: ${names[now] || now}` });
  if (!pick || pick.value === now) return;
  await vscode.workspace.getConfiguration('videoPreviewEnhanced').update('transcode', pick.value, vscode.ConfigurationTarget.Global);
}

function activate(context) {
  T_ACTIVATE = Date.now();
  out = vscode.window.createOutputChannel('Video Preview Enhanced');
  globalState = context.globalState;
  linkSim = linkSimulatorFromEnv(process.env, log);
  if (linkSim) context.subscriptions.push({ dispose: () => { if (linkSim) linkSim.dispose(); linkSim = null; } });
  hwKnown = globalState.get(gpuCacheKey()) || null;
  offers = createOffers({
    vscode, globalState, log, decide, probe, remoteff, setup, tools, config, probeRecordFor, probeRunning: () => !!probeRun, machine, runProbeUi,
    setupFfmpeg,
    turnOffTranscode: async () => {
      await setSetting('transcode', 'off', vscode.ConfigurationTarget.Global);
      for (const v of unifiedViewers) if (!v.disposed) v.useOriginalVideo();
    },
    downloadRemoteFfmpeg,
    openSettings: (id) => vscode.commands.executeCommand('workbench.action.openSettings', id),
    hostPlatform, hostArch, hostname: () => os.hostname(),
    // The GPU test pauses what plays through native ffmpeg ('pauseForTest').
    sessions: { [Symbol.iterator]: () => [...unifiedViewers].map((v) => ({
      native: v.session.clips.some((c) => v.decoderKind(c.id) === 'native'), disposed: v.disposed, post: (m) => v.post(m),
    }))[Symbol.iterator]() },
  });
  // A method guessed from the stored GPUs produced no picture: maybe another GPU or driver now; detect again.
  onGuessFailed(() => { hwStale = true; hwPromise = null; });
  storageDir = context.globalStorageUri.fsPath;
  extensionDir = context.extensionUri.fsPath;
  burst = createBurst({
    // Tests (VPE_BURST_MS): a shorter window.
    windowMs: Number(process.env.VPE_BURST_MS) > 0 ? Number(process.env.VPE_BURST_MS) : BURST_WINDOW_MS,
    max: maxVideos, onBurst: (b) => openBurst(context, b),
  });

  const provider = {
    openCustomDocument: (uri) => ({ uri, dispose() {} }),
    resolveCustomEditor: (doc, panel) => resolveVideo(context, doc.uri, panel),
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
    vscode.commands.registerCommand('videoPreviewEnhanced.openVideoFile', () => openLocalVideo('active')),
    vscode.commands.registerCommand('videoPreviewEnhanced.playToSide', (uri) => openLocalVideo('side', uri)),
    vscode.commands.registerCommand('videoPreviewEnhanced.playInNewWindow', (uri) => openLocalVideo('window', uri)),
    vscode.commands.registerCommand('videoPreviewEnhanced.playSequence', async (uri) => {
      let target = uri;
      if (!target) {
        const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, openLabel: 'Play sequence' });
        if (!pick) return;
        target = pick[0];
      }
      await openSequence(context, target);
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
    vscode.window.registerUriHandler({ handleUri: (uri) => openLink(context, uri).catch((e) => log(`link failed: ${e && e.stack || e}`)) }),
    vscode.commands.registerCommand('videoPreviewEnhanced.setupFfmpeg', () => setupFfmpeg()),
    vscode.commands.registerCommand('videoPreviewEnhanced.retestFfmpeg', () => retestFfmpeg()),
    vscode.commands.registerCommand('videoPreviewEnhanced.makeDefault', () => makeDefault(true)),
    vscode.commands.registerCommand('videoPreviewEnhanced.undoDefault', () => undoDefault()),
    vscode.commands.registerCommand('videoPreviewEnhanced.openSetupGuide', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${walkthrough.WALKTHROUGH_ID}`, false)),
    // Setup guide buttons (package.json walkthrough): Next / Got it / Done on every step, and ffmpeg setup that moves on.
    vscode.commands.registerCommand('videoPreviewEnhanced.setupNext', (id) => setupNext(context, id)),
    vscode.commands.registerCommand('videoPreviewEnhanced.setupFfmpegFromGuide', async (id) => {
      await setupFfmpeg();
      toolsPromise = null;
      if (await tools()) await setupNext(context, id, { skipped: false }); // set up (or already there): on to the next step
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.chooseTranscode', () => chooseTranscode(context)),
    // Types the skills.sh install command into a terminal without running it: the user sees what runs and presses Enter.
    vscode.commands.registerCommand('videoPreviewEnhanced.installAgentSkill', () => {
      const term = vscode.window.createTerminal('Install AI agent skill');
      term.show();
      term.sendText(walkthrough.SKILL_COMMAND, false);
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.copyAgentSnippet', async () => {
      await vscode.env.clipboard.writeText(walkthrough.AGENT_SNIPPET);
      vscode.window.showInformationMessage('AI agent video-link instructions copied. Paste them into AGENTS.md, CLAUDE.md, or .cursorrules.');
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.loadSubtitles', () => {
      const v = activeViewer();
      if (v) return v.session.onMessage({ type: 'loadSubs' });
      vscode.window.showInformationMessage('Video Preview: open a video first, then load subtitles for it.');
      return undefined;
    }),
    // ---- A-B export: the page answers 'abQuery' with its range, then the host runs it ----
    vscode.commands.registerCommand('videoPreviewEnhanced.exportRange', () => askRange('export')),
    vscode.commands.registerCommand('videoPreviewEnhanced.copyFfmpegRange', () => askRange('ffmpeg')),
    vscode.commands.registerCommand('videoPreviewEnhanced.exportVideoRange', () => askClipRange(false)),
    vscode.commands.registerCommand('videoPreviewEnhanced.exportCompareVideoRange', () => askClipRange(true)),
    // ---- Compare: more videos into a viewer (docs/notes/compare-ui.md) ----
    vscode.commands.registerCommand('videoPreviewEnhanced.startCompare', (uri, uris) => compareSelection(context, uri, uris)),
    vscode.commands.registerCommand('videoPreviewEnhanced.addToCompare', (uri, uris) => compareSelection(context, uri, uris)),
    vscode.commands.registerCommand('videoPreviewEnhanced.compareFolder', (uri, uris) => compareSelection(context, uri, uris)),
    vscode.commands.registerCommand('videoPreviewEnhanced.compare', (uri, uris) => compareList(context, uri, uris)),
    vscode.commands.registerCommand('videoPreviewEnhanced.compareWith', (uri, opts) => compareWith(context, uri, opts)),
    vscode.commands.registerCommand('videoPreviewEnhanced.comparePick', (uri) => comparePick(context, uri)),
    vscode.commands.registerCommand('videoPreviewEnhanced.addToCompareFromPlayer', (uri) => addToCompareFromPlayer(uri)),
    // Add from Explorer is the viewer's Capture: the next videos opened join it instead of opening their own tab.
    vscode.commands.registerCommand('videoPreviewEnhanced.addFromExplorer', () => {
      const v = activeViewer();
      if (v) v.session.setCapture(!v.session.capture);
    }),
    vscode.commands.registerCommand('videoPreviewEnhanced.stopAddFromExplorer', () => {
      for (const v of unifiedViewers) v.session.setCapture(false);
    }),
    // Switching to a text editor ends Add Mode (docs/PRODUCT.md "Add Mode"); a video opening in a tab of its own does not.
    ...[vscode.window.onDidChangeActiveTextEditor && vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      for (const v of unifiedViewers) {
        if (!v.session.capture) continue;
        captureWhy = 'switched editor';
        v.session.setCapture(false);
        captureWhy = '';
      }
    })].filter(Boolean), // (test doubles of the vscode API may lack the event)
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('videoPreviewEnhanced.ffmpegPath')) toolsPromise = null;
      if (e.affectsConfiguration('videoPreviewEnhanced.gpuDecoding')) probeChecked = false;
      if (e.affectsConfiguration('videoPreviewEnhanced.overrideFileIcons')) fileIcons({ force: true });
      // Docked or overlaid: the same rail, another class; every open viewer follows at once.
      if (e.affectsConfiguration('videoPreviewEnhanced.folderRail.layout')) {
        const layout = config().railLayout;
        for (const v of unifiedViewers) v.post({ type: 'rail', op: 'layout', layout });
      }
      if (Object.keys(PREFS).some((k) => e.affectsConfiguration(`videoPreviewEnhanced.${k}`))
        || e.affectsConfiguration('videoPreviewEnhanced.transcode')
        || e.affectsConfiguration('videoPreviewEnhanced.transcodeMaxBitrate')
        || e.affectsConfiguration('videoPreviewEnhanced.transcodeSplitBitrate')
        || e.affectsConfiguration('videoPreviewEnhanced.transcodeResolution')
        || e.affectsConfiguration('videoPreviewEnhanced.remoteStream')) {
        const c = config();
        if (e.affectsConfiguration('videoPreviewEnhanced.transcodeMaxBitrate')) {
          // One stream in a panel takes the cap itself; several share it (src/unified-viewer.js resizeDecoders).
          for (const v of unifiedViewers) {
            const streams = v.session.clips.filter((x) => v.decoderKind(x.id) === 'stream');
            const s = streams.length === 1 ? v.decoderOf(streams[0].id) : null;
            if (s && s.setMaxBitrateMbps) s.setMaxBitrateMbps(c.transcodeMaxBitrate);
          }
        }
        const msg = { type: 'prefs', prefs: prefsOf(c) };
        for (const v of unifiedViewers) v.post(msg);
      }
    }),
    { dispose: flushSpeeds },
    { dispose: () => {
      for (const v of [...unifiedViewers]) v.dispose();
      frameserver.stop();
    } },
    out,
  );
  autoDefault();
  fileIcons();

  // ---- what every viewer gets from this host (src/unified-viewer.js o.deps) ----
  unifiedDeps = {
    log, engineCfg: (w) => engineCfg(context, w), nativeFor, nativeTransport, nativeQueue, rotationOf,
    fitTiles: () => fitsView(config()),
    nativeFailed,
    libavBuild: () => libavBuild(context.extensionUri), prefs: () => prefsOf(config()), maxVideos,
    pick: (label, defaultUri, many) => pickVideos(label, defaultUri, many),
    setPlaybackPrefs: (m, from) => rememberPlaybackPrefs(m, from),
    focusMode: (what) => (what === 'toggle' ? toggleFocusMode(vscode) : noteFocusModeExited()),
    rail: {
      cache: railMeta, probe: railProbe, prefs: railPrefs, layout: () => config().railLayout,
      caseless: process.platform === 'win32' || process.platform === 'darwin',
    },
    createStream, transcodePrefs: () => {
      const c = config();
      return { transcodeMaxBitrate: c.transcodeMaxBitrate, transcodeSplitBitrate: c.transcodeSplitBitrate };
    },
    openUrlStream: (c, io) => createUrlDecoder(c, io, urlDeps(c, io)),
    openSequence: (c, io) => createSequenceDecoder(c, io),
    findSidecars: (uri, logTo) => findSidecars(vscode, uri, logTo),
    loadSubtitles: (c, viewer) => loadSubtitles(c, viewer),
    saveFrame: (c, m, viewer) => saveFrame(c, m, viewer),
    copyLink: (c, at, viewer) => frameLink(context, c.uri, at.frame, at.t, viewer.panel.webview),
    exportAb: (kind, c, m, viewer) => exportAb(kind, c, m, viewer),
    grabExactFrame: (a) => grabExactFrame(a),
    savePos: (c, pos) => savePos(c.fsPath, pos),
    watchFile: (file, onChange, onError) => watchFile(file, onChange, onError),
    external: (c, viewer) => openExternal(c, viewer),
    openUrl: async () => { const url = await promptUrl(); if (url) await openUrl(context, url); },
    setupFfmpeg: () => setupFfmpeg(),
    setSetting: (key, value) => setSetting(key, value, vscode.ConfigurationTarget.Global),
    hideNotice: async (id) => {
      if (!NOTICE_KEYS[id]) return;
      await globalState.update(NOTICE_KEYS[id], true);
      for (const v of unifiedViewers) v.post({ type: id });
    },
    hiddenNotices: () => Object.keys(NOTICE_KEYS).filter((id) => globalState.get(NOTICE_KEYS[id])),
    ffmpegState,
    setTranscodePref: (m) => setTranscodePref(m),
    onPageMessage: (m, viewer) => onPageMessage(m, viewer),
    compareFolder: (folder, viewer) => compareFolderRow(viewer, folder),
    openFolderFile: (viewer, target, opts) => openFolderFile(viewer, target, opts),
    // The first-open popup (no ffmpeg yet) once a video's page shows, as the player did.
    onReady: () => { offers.maybeOnboard().catch((e) => log(`onboarding failed: ${e && e.message || e}`)); },
    adoptMs: ADOPT_MS,
    // VPE_SIMULATE_LINK (tests): every panel's native traffic shares one slow link.
    link: (name) => (linkSim ? linkSim.wrapChannel(name) : null),
    debug: !!logFile, remote: !!vscode.env.remoteName,
  };

  // Test hook: with VPE_LOG set, JSON lines appended to <log>.cmd are sent to open viewers or run as commands.
  createDebugCommands({
    vscode, fs, log, logFile, viewers: unifiedViewers, frameserver, remotestream, setPickHook, openUrl, openLink: (uri) => openLink(context, uri),
    resetTools: () => { toolsPromise = null; }, // PATH may have gained or lost ffmpeg
    setCompareFiles: (files) => { testCompareFiles = files; },
    replaceClip: async (viewer, index, uri) => {
      const old = viewer.session.clips[index];
      if (!old) return false;
      const clip = await unifiedViewer.prepareClip(uri, prepDeps(viewer.session.clips.length >= 2));
      return viewer.session.replaceClip(old.id, clip);
    },
  }).install(context);
  maybeOpenSetupGuide(); // after the commands above are registered
  T_ACTIVATED = Date.now();
  if (logFile) log(`activated: module load ${T_ACTIVATE - T_LOAD} ms, activate() ${T_ACTIVATED - T_ACTIVATE} ms, pid ${process.pid}`);
}

// ---- the decoder config and the native decision, per clip ----

/** The page's decoder config (media/engine.js cfg), shared by every clip of a viewer. */
function engineCfg(context, w) {
  const c = config();
  const build = libavBuild(context.extensionUri);
  const base = w.asWebviewUri(build.dir).toString();
  const media = (f) => w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f)).toString();
  return {
    workerUrl: media('decoder-worker.js'), xrayWorkerUrl: media('xray-worker.js'),
    libavBase: base, loader: `${base}/${build.loader}`, variant: build.variant,
    remote: !!remoteName(), whenSlow: c.whenSlow, fastWhenBehind: c.fastWhenBehind, debug: !!logFile,
    wcFailed: [...wcFailed],
    pool: debugPool,
    mem: memBudgets(), // the whole machine's; the page shares it among the clips it shows
    hdrOutput: c.hdrOutput,
    // Tests (VPE_LOG only): VPE_HDR_FORCE=1 takes the HDR output path on an SDR display.
    hdrForce: !!logFile && process.env.VPE_HDR_FORCE === '1',
    // Tests (VPE_LOG only): VPE_NO_WEBGL=1 makes the decoder fail as on a machine without WebGL2 (the error screen).
    noWebgl: !!logFile && process.env.VPE_NO_WEBGL === '1',
  };
}

/**
 * Native ffmpeg or Live transcode for a file (src/unified-viewer.js prepareClip): the probe, the transcode policy and
 * the decoder rule. Null: the built-in decoder. `tile`: the tile's picture size when known (Live transcode's height).
 * `o.compare`: the file shows beside others (Compare's transcode policy); a single video in its tab does not.
 */
async function nativeFor(file, transport, tile, o = {}) {
  const c = config();
  const remote = remoteName();
  const rawAllowed = nativeAllowedHere();
  if (c.decoder === 'builtin' || !vscode.workspace.isTrusted || (!rawAllowed && c.transcode === 'off')) return null;
  const t = await tools();
  if (!t) return null;
  const [pr] = await Promise.all([ff.probe(t, file), rawAllowed ? gpusForMethod(t, c) : null]);
  const stat = await fs.promises.stat(file);
  const failed = decide.failedBefore(globalState.get(decide.FAILED_KEY), file, stat);
  const name = path.basename(file);
  if (!failed && c.transcode !== 'off' && pr.video) {
    const remoteLink = (!!remote && remote !== 'wsl') || c.remoteStream === 'on';
    const maxStreamHeight = c.nativeMaxAuto ? (remoteLink ? 1080 : decide.FRAME_SERVER_HEIGHT) : c.nativeMaxHeight;
    const decision = transcodePolicy.shouldTranscodeOnOpen({
      mode: c.transcode, remote, video: pr.video, compare: !!(o && o.compare),
      maxBitrateMbps: c.transcodeMaxBitrate, viewHeight: tile && tile.h, toneMap: transcodeArgs.toneMapSupport(t.gpuFilters),
    });
    // Each clip decides on its own (codec, bit rate): say why, so a mixed grid can be explained from the log.
    if (decision.action !== 'stream') log(`${name}: live transcode skipped: ${decision.reason}`);
    else {
      const stream = await transcodeOptions(t, pr, c, remoteLink, false);
      // Policy chose it; whether it runs depends on an encoder being available.
      log(stream ? `[${name}] decoder: remote stream (${stream.encoder}): ${decision.reason}`
        : `[${name}] live transcode chosen (${decision.reason}) but no encoder is available: falling back`);
      if (stream) return { tools: t, probed: pr, maxHeight: maxStreamHeight, stream, informTranscode: c.transcode !== 'always' };
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
  // Tests (VPE_LOG only): VPE_NATIVE_METHOD holds ffmpeg's method (cuda, d3d11va, auto, none…), as a stored probe would.
  const forced = logFile ? process.env.VPE_NATIVE_METHOD : '';
  const method = forced && d.use === 'native' ? forced : d.method;
  log(`[${name}] decoder: ${d.use === 'native' ? `native ffmpeg (${method})` : 'built-in'}: ${d.reason}`);
  return { tools: d.use === 'native' ? t : null, probed: pr, method, methodGuessed: !!d.guessed, maxHeight, messageMaxHeight, reason: d.reason };
}

/**
 * Native ffmpeg failed on a file (the viewer plays it in the page from now on). Remembered only when ffmpeg ran and
 * rejected the media; otherwise the tools are looked up again (the next window checks them instead of trusting the
 * stored check).
 */
async function nativeFailed(c, error, rejectedMedia) {
  log(`[${c.label}] native ffmpeg can't play this file (${error && error.message || error}); using the built-in decoder`);
  globalState.update(TOOLS_KEY, undefined).then(undefined, () => {});
  if (rejectedMedia && c.fsPath) {
    try {
      const st = fs.statSync(c.fsPath);
      await globalState.update(decide.FAILED_KEY, decide.addFailed(globalState.get(decide.FAILED_KEY), c.fsPath, st, String(error || '')));
      return;
    } catch { /* gone: nothing to remember */ }
  }
  toolsPromise = null;
}

/** A Live transcode stream for a clip whose decision has one (src/unified-viewer.js startStream). */
function createStream(c, o) {
  const d = o.decision;
  const stream = new remotestream.EncodedStream({
    ...d.stream, tools: d.tools, file: c.fsPath, probed: d.probed, hidden: o.hidden, rotation: o.rotation || 0,
    allowOverlap: false, maxHeight: o.maxHeight, maxKbps: o.maxKbps, fitView: !!o.fitView, allowLinkAdapt: !!d.stream.remote,
    resolution: o.resolution !== undefined ? o.resolution : config().transcodeResolution, stats: !!logFile,
    initialLink: d.stream.remote ? sessionLink.read() : undefined,
    onLinkUpdate: (snapshot) => sessionLink.update(snapshot),
    post: o.post, log: o.log, onFail: o.onFail,
  });
  // The one-time "Live transcode is on" notice; not when the user chose Always, nor for a lossless Direct Stream.
  if (d.informTranscode && stream.lossy()) {
    const viewer = () => [...unifiedViewers].find((v) => v.session.clipOf(c.id));
    offers.maybeInformTranscode({
      name: c.label, get disposed() { return !viewer(); }, useOriginalVideo: () => { const v = viewer(); if (v) v.useOriginalVideo(); },
    }).catch((e) => log(`live transcode notice failed: ${e && e.message || e}`));
  }
  return stream;
}

/** Live transcode mode, max bitrate or default resolution from the ⚙ panel (machine-scoped settings). */
async function setTranscodePref(m) {
  if (m.mode !== undefined && transcodePolicy.MODES.includes(m.mode)) await setSetting('transcode', m.mode, vscode.ConfigurationTarget.Global);
  if (m.maxBitrateMbps !== undefined) {
    await setSetting('transcodeMaxBitrate', Math.max(0, Number(m.maxBitrateMbps) || 0), vscode.ConfigurationTarget.Global);
  }
  // Save as default: new clips start at it; open ones keep their own resolution.
  if (m.resolution !== undefined) {
    await setSetting('transcodeResolution', transcodePolicy.resolutionOf(m.resolution), vscode.ConfigurationTarget.Global);
  }
}

/**
 * Whether the page may offer the ffmpeg setup (status pill) and mention ffmpeg (toast): offered when it isn't
 * installed, in a local trusted window, unless "Don't Show Again". Restricted Mode runs no ffmpeg at all.
 */
async function ffmpegState() {
  const t = vscode.workspace.isTrusted ? await tools() : null;
  const h = globalState.get(decide.HINT_KEY) || {};
  return { installed: !!t, offer: !t && !vscode.env.remoteName && vscode.workspace.isTrusted && !h.never, mb: setup.downloadSizeMB() };
}

// ---- URL clips (src/unified-sources.js createUrlDecoder) ----

/** What a URL clip's decoder needs from this host. @param {any} c @param {any} io */
function urlDeps(c, io) {
  const url = c.source && c.source.url;
  return {
    urlsource, netOpts,
    // Native ffmpeg where it may run: not with the builtin setting, in Restricted Mode or where frames cross a link.
    tools: async () => {
      const cfg = config();
      return cfg.decoder !== 'builtin' && vscode.workspace.isTrusted && nativeAllowedHere() ? tools() : null;
    },
    probe: async (t, input, signal) => (await Promise.all([ff.probe(t, input, signal), gpusForMethod(t, config())]))[0],
    ffInput: (info, plan) => {
      const target = info && info.url ? info.url : url;
      const h = vscode.workspace.getConfiguration('http');
      const p = proxy.proxyFor(target, { proxy: h.get('proxy') || '', env: process.env });
      // HLS master playlist: ffprobe picks the streams of the chosen variant (src/ffmpeg.js probe).
      const variant = plan && plan.master && plan.variant ? { bandwidth: plan.variant.bandwidth } : undefined;
      return { url: target, proxy: p || undefined, strictSSL: h.get('proxyStrictSSL', true) !== false, variant };
    },
    decide: ({ t, pr, stream, forced }) => {
      const cfg = config();
      if (forced) return decide.decide({ setting: 'ffmpeg', trusted: true, tools: t, video: pr.video, probe: probeRecordFor(t), hw: hwKnown, gpu: cfg.gpuDecoding });
      return decide.decide({
        setting: stream && cfg.decoder === 'auto' ? 'ffmpeg' : cfg.decoder, remote: remoteName(), trusted: true, tools: t, video: pr.video,
        probe: probeRecordFor(t), hw: hwKnown, failed: false, gpu: cfg.gpuDecoding, maxHeight: nativeHeight(cfg, pr.video),
        transport: io.transport && io.transport !== 'message' ? 'stream' : 'message',
      });
    },
    openNative: ({ t, pr, d, input, io: sink, onFail }) => {
      const h = nativeHeights(config(), pr.video);
      return new NativeDecoder({
        tools: t, file: null, input, maxHeight: h.stream, messageMaxHeight: h.message, method: d.method, methodGuessed: !!d.guessed,
        probed: pr, stats: !!logFile, maxQueued: nativeQueue(), transport: sink.transport || 'message', origin: sink.origin || null,
        post: sink.post, postRaw: sink.postRaw, log: sink.log, onFail,
      });
    },
    firstBytes, planText: hlsPlanText, libavVariant: 'vpe',
    builtinOnly: () => config().decoder === 'builtin',
    why: () => {
      const remote = remoteName();
      if (!vscode.workspace.isTrusted) return 'Native ffmpeg does not run in Restricted Mode (untrusted workspaces).';
      if (remote && remote !== 'wsl') return `Native ffmpeg is not used in ${remote} windows (frames would cross the connection). Open the URL in a local window.`;
      if (config().decoder === 'builtin') return 'The decoder setting is "builtin": set videoPreviewEnhanced.decoder to "auto" to use ffmpeg.';
      return '';
    },
  };
}

// ---- subtitles, frames, positions, the system player ----

/** "Load subtitles…": pick files (in remote windows, on the remote side); the viewer shows the first. */
async function loadSubtitles(c, viewer) {
  const kind = c ? c.kind || 'file' : 'file';
  const folder = !c ? workspaceFolder() : kind === 'sequence' ? vscode.Uri.file(c.source.dir) : kind === 'url' ? workspaceFolder() : vscode.Uri.joinPath(c.uri, '..');
  const testPicked = viewer.testPickSubtitles;
  viewer.testPickSubtitles = undefined;
  const picked = testPicked || await vscode.window.showOpenDialog({
    defaultUri: folder, canSelectMany: true, openLabel: 'Load subtitles',
    filters: { Subtitles: ['srt', 'vtt', 'ass', 'ssa'], 'All files': ['*'] },
  });
  if (!picked || viewer.disposed) return undefined;
  const files = [];
  for (const uri of picked) {
    const name = uri.path.split('/').pop();
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size > MAX_SUB_BYTES) throw new Error('file is larger than 20 MB');
      files.push({ id: uri.toString(), name, data: new Uint8Array(await vscode.workspace.fs.readFile(uri)) });
    } catch (e) {
      vscode.window.showWarningMessage(`Video Preview: cannot load ${name}: ${e.message}`);
    }
  }
  return files;
}

/** A clip's name for files written from it (frames, exports). */
function baseNameOf(c) {
  if (c.kind === 'sequence') return c.source.name.replace(/#+/, '').replace(/\.[^.]+$/, '');
  if (c.kind === 'url') return urlBase(c.source.url);
  return path.parse(c.fsPath).name;
}

/** The folder files written from a clip go to by default. */
function folderOf(c) {
  if (c.kind === 'sequence') return vscode.Uri.file(c.source.dir);
  if (c.kind === 'url') return workspaceFolder() || vscode.Uri.file(os.homedir());
  return vscode.Uri.joinPath(c.uri, '..');
}

/** "Save frame": the page's PNG of the frame shown, to a file the user picks. */
async function saveFrame(c, m, viewer) {
  // From the page: PNG bytes and a frame index that names the default file (security review 2026-11-19 #7).
  const data = m.data;
  const frame = m.frame;
  if (!(data instanceof Uint8Array) || !Number.isInteger(frame) || frame < 0) return;
  const defaultUri = vscode.Uri.joinPath(folderOf(c), `${baseNameOf(c)}_frame${String(frame + 1).padStart(5, '0')}.png`);
  // Tests (VPE_LOG with VPE_SAVE_DIR): no native dialog, the file goes to that folder.
  const target = logFile && process.env.VPE_SAVE_DIR ? vscode.Uri.file(path.join(process.env.VPE_SAVE_DIR, path.basename(defaultUri.fsPath)))
    : await vscode.window.showSaveDialog({ defaultUri, filters: { 'PNG image': ['png'] } });
  if (!target || viewer.disposed) return;
  await vscode.workspace.fs.writeFile(target, data);
  if (viewer.disposed) return;
  const pick = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, 'Open');
  if (pick === 'Open' && !viewer.disposed) vscode.commands.executeCommand('vscode.open', target);
}

// checkJs: start
/** Where a file was left last time (same size and date), unless it was near the start or end. @param {string} file */
function resumeAt(file) {
  if (!globalState || !file) return null;
  const e = (globalState.get(POSITIONS_KEY) || {})[file];
  try {
    const st = fs.statSync(file);
    if (!e || e.size !== st.size || e.mtime !== st.mtimeMs) return null;
  } catch { return null; }
  return e.t > 5 && e.d - e.t > 5 ? { t: e.t, d: e.d } : null;
}

/**
 * A file's resume position (the viewer decides when: stopped, jumped, every 30 s, closed); the 200 most recent.
 * @param {string} file @param {{ t: number, d: number }} pos
 */
function savePos(file, pos) {
  if (!globalState || !file || !(pos.t >= 0)) return;
  let st;
  try { st = fs.statSync(file); } catch { return; }
  const all = { ...(globalState.get(POSITIONS_KEY) || {}) };
  all[file] = { t: pos.t, d: pos.d, size: st.size, mtime: st.mtimeMs, at: Date.now() };
  const keys = Object.keys(all).sort((x, y) => all[y].at - all[x].at);
  for (const k of keys.slice(200)) delete all[k];
  globalState.update(POSITIONS_KEY, all);
}
// checkJs: end

/** The system player: only for a file (or a sequence's first picture) on this machine. */
function openExternal(c, viewer) {
  if (!c || vscode.env.remoteName || c.kind === 'url') {
    viewer.post({ type: 'toast', text: 'The system player opens files on this computer only', ms: 3000 });
    return undefined;
  }
  if (c.kind === 'sequence') return vscode.env.openExternal(vscode.Uri.file(c.source.files[0]));
  return c.uri && c.uri.scheme === 'file' ? vscode.env.openExternal(c.uri) : undefined;
}

/** Single full-resolution frames for the pixel tools (src/exact_frame.js), one grabber per host decoder. */
const exactGrabbers = new WeakMap();
async function grabExactFrame({ clip, decoder, t, isCurrent }) {
  const video = decoder && decoder.pr && decoder.pr.video;
  if (!video || !decoder.file || !decoder.tools) return { error: 'exact frames are for Live transcode or downscaled native ffmpeg of a video file' };
  let grabber = exactGrabbers.get(decoder);
  if (!grabber) {
    grabber = new ExactFrameGrabber({ log: (m) => log(`[${clip.label}] ${m}`) });
    exactGrabbers.set(decoder, grabber);
  }
  return grabber.grab({ tools: decoder.tools, file: decoder.file, t, video, rotation: clip.rotation || 0, page: 0, isCurrent: () => isCurrent() });
}

// ---- A-B export (src/rangecmd.js) ----

/** The page's A-B range for an export, or a grabbed frame nobody waits for any more. */
function exportAb(kind, c, m, viewer) {
  if (!c) return undefined;
  if (kind === 'exportRange') return exportRange(viewer, c, m.range);
  if (kind === 'ffmpegRange') return copyFfmpegRange(viewer, c, m.range);
  if (kind === 'clipRange') {
    // Compare: one clip per tile, each from the range the page measured for it (A_, B_ ... in display order).
    if (Array.isArray(m.ranges) && viewer.session.clips.length >= 2) {
      return exportClips(viewer, c, compareClipJobs(viewer.session.clips, m.ranges, Grid.TILE_KEYS), true);
    }
    const tile = viewer.session.clips.findIndex((x) => x.id === c.id);
    return exportClips(viewer, c, m.range ? [{ uri: c.uri, range: m.range, tile: Math.max(0, tile) }] : []);
  }
  return undefined;
}

/** Every frame (or every Nth frame) of A-B as `<video>_f000123.png` in a folder the user picks (written through workspace.fs: remote too). */
async function exportRange(viewer, c, range) {
  if (viewer.exporting) { vscode.window.showInformationMessage('Video Preview: an export is already running.'); return; }
  const problem = rangecmd.rangeProblem(range);
  if (problem) { vscode.window.showInformationMessage(`Video Preview: ${problem}`); return; }
  let stride = 1;
  if (range.stride !== undefined) {
    stride = rangecmd.parseStride(range.stride);
  } else if (!(logFile && process.env.VPE_EXPORT_DIR && process.env.VPE_EXPORT_STRIDE === undefined)) {
    const raw = logFile && process.env.VPE_EXPORT_DIR
      ? process.env.VPE_EXPORT_STRIDE
      : await vscode.window.showInputBox(rangecmd.strideInputOptions(range));
    if (viewer.disposed || raw === undefined) return;
    const strideErr = rangecmd.strideProblem(raw);
    if (strideErr) { vscode.window.showWarningMessage(`Video Preview: ${strideErr}`); return; }
    stride = rangecmd.parseStride(raw);
  }
  const count = rangecmd.rangeFrameCount(range, stride);
  if (count > rangecmd.MAX_FRAMES) {
    vscode.window.showWarningMessage(`Video Preview: A-B holds ${count} frames${stride > 1 ? ` at stride ${stride}` : ''}; export takes at most ${rangecmd.MAX_FRAMES}. Shorten the loop, or use "Copy ffmpeg Command for A–B".`);
    return;
  }
  if (count > rangecmd.CONFIRM_FRAMES) {
    const ok = await vscode.window.showWarningMessage(`Export ${count} frames as PNG? This can take a while and use a lot of disk space.`, { modal: true }, 'Export');
    if (viewer.disposed || ok !== 'Export') return;
  }
  const n = viewer.decoderOf(c.id);
  if (n && typeof n.lossy === 'function' && n.lossy()) {
    const fullResolution = 'Switch to Full Resolution (This Tab)';
    const ok = await vscode.window.showWarningMessage(
      `This video plays at ${n.w}×${n.h} (${n.deep ? 10 : 8}-bit) for smooth playback. Exported PNGs will use this reduced picture.`,
      { modal: true }, fullResolution, 'Export Anyway');
    if (viewer.disposed) return;
    if (ok === fullResolution) {
      viewer.useFullRes();
      vscode.window.showInformationMessage('Video Preview: now on the built-in decoder at full resolution. Run the export again once the video shows.');
      return;
    }
    if (ok !== 'Export Anyway') return;
  }
  const base = baseNameOf(c);
  // Tests (VPE_LOG with VPE_EXPORT_DIR): no native dialog, the frames go to that folder.
  const pick = logFile && process.env.VPE_EXPORT_DIR ? [vscode.Uri.file(process.env.VPE_EXPORT_DIR)] : await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    openLabel: `Export ${count} frames here`, defaultUri: folderOf(c),
  });
  if (viewer.disposed || !pick || !pick.length) return;
  const folder = pick[0];
  const where = folder.scheme === 'file' ? folder.fsPath : folder.toString();
  // Ask before writing over frames exported before.
  const caseInsensitive = folder.scheme === 'file' && (process.platform === 'win32' || process.platform === 'darwin');
  const nameKey = (x) => (caseInsensitive ? x.toLowerCase() : x);
  const hasStat = typeof vscode.workspace.fs.stat === 'function';
  const fileExists = async (uri) => {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch (e) {
      if (e && (e.code === 'FileNotFound' || e.code === 'ENOENT')) return false;
      throw e;
    }
  };
  let existingNames = null;
  const plannedCollisions = [];
  try {
    existingNames = new Set((await vscode.workspace.fs.readDirectory(folder)).map(([x]) => nameKey(x)));
    for (const k of rangecmd.rangeFrames(range, stride)) {
      const name = rangecmd.frameFileName(base, k + 1);
      if (existingNames.has(nameKey(name))) plannedCollisions.push(name);
    }
  } catch (e) {
    if (viewer.disposed) return;
    if (!hasStat) {
      vscode.window.showErrorMessage(`Video Preview: could not read ${where}: ${e && e.message ? e.message : String(e)}`);
      return;
    }
    // Directory listing failed; each destination is checked with stat before writing.
  }
  if (viewer.disposed) return;
  const approvedOverwrites = new Set();
  if (plannedCollisions.length) {
    const existing = plannedCollisions.length;
    const ok = await vscode.window.showWarningMessage(`Overwrite ${existing} existing file${existing === 1 ? '' : 's'}?`, { modal: true, detail: `${where} already holds ${existing === 1 ? 'a frame' : 'frames'} of this range.` }, 'Overwrite');
    if (ok !== 'Overwrite') return;
    for (const x of plannedCollisions) approvedOverwrites.add(nameKey(x));
  }
  if (viewer.disposed || viewer.exporting) return; // another export started while the dialogs were open
  const job = new AbortController();
  viewer.exporting = job;
  // The page decodes and draws only while shown: bring it to the front.
  viewer.panel.reveal(undefined, true);
  let done = 0;
  let failed = null;
  const overwrite = async (name) => {
    const ok = await vscode.window.showWarningMessage(`Overwrite existing file ${name}?`, { modal: true, detail: `${where} already holds ${name}.` }, 'Overwrite');
    return ok === 'Overwrite';
  };
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting frames ${range.fa + 1}–${range.fb + 1}`, cancellable: true }, async (progress, token) => {
      const work = job.signal;
      const sub = token && token.onCancellationRequested(() => job.abort());
      const closed = setInterval(() => { if (viewer.disposed) job.abort(); }, 500);
      try {
        const end = range.fa + count * stride;
        let last = -1; // the last frame written
        for (let k = range.fa; k <= range.fb && !work.aborted;) {
          if (!viewer.panel.visible) {
            // The page draws nothing while hidden: wait until it is shown again.
            progress.report({ message: `${done} / ${count}, paused while the player is hidden` });
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          const r = await viewer.grabFrame(k, work, c.id);
          if (work.aborted) break;
          if (!r || r.error || !r.data) { failed = r && r.error ? r.error : 'no picture'; break; }
          // VFR or gapped video: the seek can settle on a neighbour. Name the file from the frame shown; skip repeats.
          const shown = Number.isInteger(r.frame) ? r.frame : k;
          if (shown > last && shown >= range.fa && shown <= range.fb) {
            const name = rangecmd.frameFileName(base, shown + 1);
            const dest = vscode.Uri.joinPath(folder, name);
            const key = nameKey(name);
            if (!approvedOverwrites.has(key)) {
              const collides = (existingNames && existingNames.has(key)) || (hasStat && await fileExists(dest));
              if (work.aborted) break;
              if (collides) {
                if (!(await overwrite(name)) || work.aborted) { job.abort(); break; }
                approvedOverwrites.add(key);
              }
            }
            const bytes = new Uint8Array(r.data);
            let res = await exclusiveWrite.writeNew(vscode.workspace.fs, dest, bytes, { overwrite: approvedOverwrites.has(key) });
            if (res === 'exists') {
              // Appeared after the checks above (another export or program): never replace it unasked.
              if (!(await overwrite(name)) || work.aborted) { job.abort(); break; }
              approvedOverwrites.add(key);
              res = await exclusiveWrite.writeNew(vscode.workspace.fs, dest, bytes, { overwrite: true });
            }
            done++;
            last = shown;
          }
          const next = rangecmd.nextRangeFrame(k, shown, stride);
          progress.report({ increment: (100 * ((Math.min(next, end) - k) / stride)) / count, message: `${done} / ${count}` });
          k = next;
        }
      } finally {
        clearInterval(closed);
        if (sub) sub.dispose();
      }
    });
  } catch (e) {
    failed = e && e.message ? e.message : String(e);
  } finally {
    if (viewer.exporting === job) viewer.exporting = null;
    if (!viewer.disposed) viewer.post({ type: 'exportEnd' });
  }
  if (viewer.disposed) return;
  log(`[${c.label}] exported ${done}/${count} frames to ${folder.toString()}${failed ? ` (stopped: ${failed})` : ''}`);
  if (failed) vscode.window.showErrorMessage(`Video Preview: exported ${done} of ${count} frames, then stopped: ${failed}`);
  else vscode.window.showInformationMessage(`Video Preview: exported ${done} of ${count} frames to ${where}`);
}

/** Copies an ffmpeg command that cuts A-B: exact (re-encode) or fast (-c copy, keyframe-aligned). */
async function copyFfmpegRange(viewer, c, range) {
  if (c.kind === 'url' || c.kind === 'sequence') { vscode.window.showInformationMessage('Video Preview: the ffmpeg command for A–B is for video files.'); return; }
  const problem = rangecmd.rangeProblem(range);
  if (problem) { vscode.window.showInformationMessage(`Video Preview: ${problem}`); return; }
  let cmd;
  try { cmd = rangecmd.ffmpegRange(c.fsPath, range, process.platform, vscode.env.shell); } catch (e) { vscode.window.showWarningMessage(`Video Preview: ${e.message}`); return; }
  const pick = await vscode.window.showQuickPick([
    { label: 'Exact cut (re-encode)', detail: cmd.exact, cmd: cmd.exact },
    { label: 'Fast cut (-c copy)', description: 'keyframe-aligned: starts at the keyframe at or before A', detail: cmd.copy, cmd: cmd.copy },
  ], { placeHolder: `ffmpeg command for frames ${range.fa + 1}–${range.fb + 1} (${cmd.ss} s to ${cmd.to} s)` });
  if (!pick || viewer.disposed) return;
  await vscode.env.clipboard.writeText(pick.cmd);
  if (!viewer.disposed) viewer.post({ type: 'toast', text: 'ffmpeg command copied' });
}

// ---- page messages the viewer passes on: decode speed, WebCodecs failures, drops ----

/** Per viewer: the slow-playback run the offers look at (src/offers.js). */
const speedStates = new WeakMap();
function speedStateOf(viewer) {
  let st = speedStates.get(viewer);
  if (!st) {
    st = {
      slowRun: 0,
      get name() { return viewer.session.title; },
      get disposed() { return viewer.disposed; },
      reload: (why) => viewer.reloadAll(why),
      useOriginalVideo: () => viewer.useOriginalVideo(),
    };
    speedStates.set(viewer, st);
  }
  return st;
}

function onPageMessage(m, viewer) {
  switch (m.type) {
    case 'wcFailed':
      // WebCodecs lagged on this sound codec: the built-in decoder plays it in every later page this session.
      if (typeof m.codec === 'string' && /^[\w-]{1,16}$/.test(m.codec)) { wcFailed.add(m.codec); log(`[${viewer.session.title}] WebCodecs failed for ${m.codec}: ${String(m.reason || '').slice(0, 200)}`); }
      return undefined;
    case 'decodeSpeed': return onSpeed(m, viewer);
    case 'softVideo': {
      const id = typeof m.clipId === 'string' ? m.clipId : null;
      if (vscode.env.remoteName && !(id && viewer.decoderOf(id))) offers.maybeOfferRemoteFfmpeg(speedStateOf(viewer), m).catch((e) => log(`remote ffmpeg offer: ${e && e.stack || e}`));
      return undefined;
    }
    // Jump sizes and speed step from the panels: only declared values.
    case 'pref': return PREFS[m.key] && PREFS[m.key].values.includes(m.value) ? setSetting(m.key, m.value, prefTarget(m.key)) : undefined;
    // Videos dropped on the page (docs/notes/compare-ui.md "Starting a compare"): they join this viewer.
    case 'compareDrop': return Array.isArray(m.uris) ? addDropped(viewer, m.uris) : undefined;
    case 'addMode': return viewer.session.setCapture(!viewer.session.capture);
    case 'stopAddMode': return viewer.session.setCapture(false);
    default: return undefined;
  }
}

/**
 * A decode speed sample from the page (media/engine.js sampleSpeed): built-in samples are stored per class and may
 * bring the setup hint; slow ones, and native ones whose host keeps up, may bring the GPU test offer.
 */
function onSpeed(m, viewer) {
  if (m.remoteStream) return;
  const clip = typeof m.clipId === 'string' ? viewer.session.clipOf(m.clipId) : viewer.session.clips[0];
  if (!clip || clip.transcode || viewer.decoderKind(clip.id) === 'stream') return;
  // Native ffmpeg: the clip's decoder once it runs, else what the clip was prepared for (a file's native decision).
  const nd = viewer.decoderKind(clip.id) === 'native' ? viewer.decoderOf(clip.id) : null;
  const native = !!nd || !!(clip.native && clip.decision && clip.decision.tools);
  const method = nd ? nd.method : native ? clip.decision.method : '';
  if (!!m.native !== native) return; // a sample from before the page switched decoders
  const sample = {
    codec: String(m.codec || ''), depth: Number(m.depth) || 8, width: Number(m.width) || 0, height: Number(m.height) || 0,
    fps: Number(m.fps) || 0, ratio: Number(m.ratio) || 0, realtime: !!m.realtime, native,
  };
  if (!sample.codec || !sample.width || !sample.height || !(sample.ratio > 0)) return;
  const st = speedStateOf(viewer);
  const was = st.slowRun;
  st.slowRun = sample.realtime ? 0 : was + 1;
  const name = viewer.session.title;
  if (native) {
    if (!sample.realtime && was === 0) log(`[${name}] native ffmpeg below real time: ${sample.ratio.toFixed(2)}x (${decide.describe(sample)}, ${method})`);
    // A transfer bottleneck (the host keeps up, the page does not) is no reason for a GPU decode test.
    const hostKeepsUp = nd && typeof nd.hostKeepsUp === 'function' ? nd.hostKeepsUp() : false;
    if (!sample.realtime && !hostKeepsUp) offers.maybeOfferProbe(st, sample).catch((e) => log(`GPU test offer failed: ${e && e.message || e}`));
    return;
  }
  recordSpeed(sample);
  if (!sample.realtime && was === 0) log(`[${name}] built-in decoder below real time: ${sample.ratio.toFixed(2)}x (${decide.describe(sample)})`);
  if (sample.realtime && was > 0) log(`[${name}] built-in decoder back to real time`);
  if (!sample.realtime) {
    offers.maybeHint(st, sample).catch((e) => log(`hint failed: ${e && e.message || e}`));
    offers.maybeOfferProbe(st, sample).catch((e) => log(`GPU test offer failed: ${e && e.message || e}`));
  }
}

// ---- opening videos: a file, a URL (openUrl above), a sequence, a frame link, Open Together ----

/**
 * What prepareClip needs (src/unified-viewer.js). `compare`: the clip shows beside others (Compare's transcode
 * policy); false for a single video opened in its own tab.
 */
function prepDeps(compare = false) {
  return { rotationOf, nativeFor, transport: nativeTransport, log, streams: true, compare };
}

/** The setting compare.maxVideos: how many videos one viewer shows at most. */
function maxVideos() {
  return Grid.clampMax(vscode.workspace.getConfiguration('videoPreviewEnhanced').get('compare.maxVideos'));
}

/** The frame server's port for a new page (local windows; the CSP names it), or undefined. */
async function framePortForPage() {
  if (remoteName() || nativeTransport() === 'message') return undefined;
  try { await frameserver.start(); return frameserver.port; }
  catch (e) { log(`frame server could not start: ${e.message}`); return undefined; }
}

/** Whether `panel` has closed since this call (a tab closed while its video was being probed gets no viewer). */
function closeWatch(panel) {
  let gone = !!panelClosed.get(panel);
  if (!panelClosed.has(panel)) {
    panelClosed.set(panel, false);
    panel.onDidDispose(() => { panelClosed.set(panel, true); });
  }
  return () => gone || !!panelClosed.get(panel);
}
const panelClosed = new WeakMap();

/** The context keys of the editor menus: a comparison is open (2+ videos), a viewer captures (Add from Explorer). */
function updateContexts() {
  const all = [...unifiedViewers];
  const set = (key, on) => {
    // Tests read the menu context's changes from the log (VPE_LOG).
    if (logFile && contextLogged.get(key) !== on) log(`compare: ${key}=${on}`);
    contextLogged.set(key, on);
    return Promise.resolve(vscode.commands.executeCommand('setContext', key, on)).catch(() => {});
  };
  set('videoPreviewEnhanced.compareOpen', all.some((v) => v.session.clips.length >= 2));
  set('videoPreviewEnhanced.addMode', all.some((v) => v.session.capture));
}
/** The last value each editor-menu context key was set to (the log says when it changes). @type {Map<string, boolean>} */
const contextLogged = new Map();

/** Why the next Add Mode change happens, for the log line (set just before the session is told). */
let captureWhy = '';

/**
 * A viewer in `panel` showing `clip` first (and `more` beside it). `openTarget`: a frame link's moment or the saved
 * position. Resolves the viewer, or null when the panel closed meanwhile.
 */
async function showViewer(context, panel, clip, openTarget = null, more = [], { allowDuplicate = false } = {}) {
  const closed = closeWatch(panel);
  const framePort = await framePortForPage();
  if (closed()) return null;
  remoteAuthority(panel.webview); // learn the host for frame links arriving later
  const viewer = unifiedViewer.createUnifiedViewer({
    vscode, context, panel, clip, registry: unifiedRegistry, openTarget, deps: { ...unifiedDeps, framePort },
  });
  for (const c of more) viewer.session.addClip(c, { compare: true, allowDuplicate });
  unifiedViewers.add(viewer);
  panelViewers.set(panel, viewer);
  lastViewer = viewer;
  viewer.session.onChange((e) => {
    if (e === 'active' && viewer.session.active) lastViewer = viewer;
    if (e === 'clips' || e === 'capture') updateContexts();
    // A VS Code preview tab (italic) is replaced by the next single-click in the Explorer before routeOpen() runs:
    // keep the tab permanently as soon as Capture turns on or it grows into a comparison.
    if (((e === 'capture' && viewer.session.capture) || (e === 'clips' && viewer.session.clips.length >= 2))
      && viewer.panel && viewer.panel.active && vscode.commands && typeof vscode.commands.executeCommand === 'function') {
      Promise.resolve(vscode.commands.executeCommand('workbench.action.keepEditor')).catch(() => {});
    }
    if (e === 'capture' && logFile) {
      log(`[${viewer.session.title}] compare: add from the Explorer ${viewer.session.capture ? 'on' : 'off'}${captureWhy ? ` (${captureWhy})` : ''}`);
      captureWhy = '';
    }
  });
  viewer.onDispose = () => {
    unifiedViewers.delete(viewer);
    if (lastViewer === viewer) lastViewer = null;
    updateContexts();
  };
  viewer.show();
  updateContexts();
  if (logFile) log(`[${viewer.session.title}] viewer opened (${viewer.session.clips.length} video${viewer.session.clips.length === 1 ? '' : 's'})`);
  return viewer;
}

/**
 * A video file VS Code opens in our editor (resolveCustomEditor): a frame link's moment (#t= / #frame=, a pending
 * vscode:// link) or the saved position applies; a viewer whose Capture is on takes it and this tab closes unused;
 * several opened together become one viewer (Open Together); else this tab becomes a viewer.
 */
async function resolveVideo(context, rawUri, panel) {
  if (logFile) log(`[${path.basename(rawUri.path)}] player resolve started`);
  const closed = closeWatch(panel);
  const frag = rawUri.fragment ? gotoFrom(rawUri.fragment) : null;
  const uri = rawUri.fragment ? rawUri.with({ fragment: '' }) : rawUri;
  const key = uri.toString();
  const pending = pendingGoto.get(key);
  pendingGoto.delete(key);
  const goto = (pending && pending.until >= Date.now() ? pending.g : null) || frag;
  // git:, vscode-vfs: and other virtual files: fsPath would name a different file (git: the working tree).
  if (!unifiedViewer.isViewable(uri)) {
    vscode.window.showWarningMessage(`Video Preview: can't play ${uri.scheme}: files. Open the file from the Explorer instead.`);
    setTimeout(() => panel.dispose(), 0);
    return undefined;
  }
  // A folder navigation of a single-video tab (Shift+N, the rail, Autoplay) opens this tab in its place: never taken
  // by Open Together or Compare's Add Mode.
  const handoff = railHandoffs.take(fileKey(uri), panel.viewColumn);
  // Opened with others within a moment: the burst takes them into one viewer and this tab waits for its verdict.
  if (!goto && !handoff && noteOpen(uri, panel) && await holdOpen(uri)) return undefined;
  if (panelViewers.has(panel) || closed()) return undefined; // the burst made this tab a viewer, or it closed
  let clip;
  try {
    clip = await unifiedViewer.prepareClip(uri, prepDeps(false)); // one video in its own tab
  } catch (e) {
    log(`cannot open ${path.basename(uri.fsPath)}: ${e && e.stack || e}`);
    vscode.window.showErrorMessage(`Video Preview: cannot open ${path.basename(uri.fsPath)}: ${e && e.code === 'ENOENT' ? 'the file does not exist' : e && e.message || e}`);
    setTimeout(() => panel.dispose(), 0);
    return undefined;
  }
  if (closed()) return undefined;
  if (!goto && !handoff) {
    const routed = unifiedRegistry.routeOpen(clip);
    if (routed.captured) {
      log(`${clip.label} ${routed.added ? 'joined' : 'not added to'} ${routed.session.title}`);
      setTimeout(() => panel.dispose(), 0);
      return undefined;
    }
  }
  const savedPos = goto || (handoff && handoff.fromAutoNext) ? null : resumeAt(uri.fsPath);
  const openTarget = goto || savedPos || handoff ? {
    ...(goto ? { goto } : {}),
    ...(savedPos ? { savedPos } : {}),
    ...(handoff ? { railCarry: handoff.rail, railBrowse: handoff.browse, fromAutoNext: !!handoff.fromAutoNext } : {}),
  } : null;
  const viewer = await showViewer(context, panel, clip, openTarget);
  if (viewer && logFile) log(`[${clip.label}] session resolved`);
  return undefined;
}

/**
 * Folder navigation from a single-video tab (next/prev, capsule, rail row, Autoplay "Play next in folder"): opens the
 * target file in its own VS Code tab in this editor group (or hands over to an existing tab for it), carries over the
 * rail state and Autoplay mode, then closes the source tab (tab swap).
 */
async function openFolderFile(viewer, targetPath, { rail = null, fromAutoNext = false } = {}) {
  const f = viewer.session.clips.find((c) => c.uri && (!c.kind || c.kind === 'file'));
  const local = vscode.Uri.file(targetPath);
  const uri = f ? f.uri.with({ path: local.path, fragment: '', query: '' }) : local;
  const key = fileKey(uri);
  const column = viewer.panel.viewColumn;
  const carry = folderRail.sanitizeRailCarry(rail);
  const browse = carry.open && viewer.railDir ? viewer.railDir() : null;
  const intent = { rail: carry, fromAutoNext: !!fromAutoNext, browse };
  if (logFile) log(`[${viewer.session.title}] folder: open ${path.basename(targetPath)}${fromAutoNext ? ' (autoplay next)' : ''}`);
  // Open already in this editor group as a single-video tab: focus it and hand off the rail state; close this tab once adopted.
  const open = [...unifiedViewers].find((v) => v !== viewer && !v.disposed
    && v.session.clips.length === 1 && v.session.clips[0].uri
    && fileKey(v.session.clips[0].uri) === key && v.panel.viewColumn === column);
  if (open) {
    open.panel.reveal(column, false);
    await open.railHandoff(intent);
    if (!viewer.disposed) viewer.panel.dispose();
    return;
  }
  const token = railHandoffs.register(key, column, intent);
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, playerViewType(uri), { viewColumn: column, preview: false });
  } catch (e) {
    railHandoffs.drop(token);
    throw e;
  }
  if (!viewer.disposed) viewer.panel.dispose();
}

/** "Play sequence": numbered pictures in a folder, played by the page's frame player. */
async function openSequence(context, target) {
  const seq = await findSequence(target.fsPath);
  if (!seq) {
    vscode.window.showWarningMessage('Video Preview: no numbered image sequence found there (needs at least two files like frame_0001.png).');
    return null;
  }
  const facts = await sequenceFacts(seq, config().sequenceFps || 30);
  log(`[${seq.name}] image sequence: ${seq.files.length} frames`);
  const panel = vscode.window.createWebviewPanel(SEQUENCE_VIEW_TYPE, seq.name, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
  panel.iconPath = new vscode.ThemeIcon('device-camera-video');
  const clip = unifiedViewer.sourceClip('sequence', path.join(seq.dir, seq.name), { label: seq.name, ...facts, hasAudio: false, source: seq });
  return showViewer(context, panel, clip);
}

/** The setting compare.openTogether: several videos opened at once (an Explorer multi-selection) become one viewer. */
function openTogether() {
  return vscode.workspace.getConfiguration('videoPreviewEnhanced').get('compare.openTogether', true) !== false;
}

/** A video our editor is opening: part of a burst? (not while a viewer captures: that one takes them) */
function noteOpen(uri, panel) {
  if (!burst || !COMPARE_VIDEO_EXT.test(uri.path) || !openTogether() || unifiedRegistry.capturing()) return false;
  burst.add(uri.toString(), uri, { panel });
  return true;
}

/**
 * After noteOpen: one macrotask is waited first, so that opens VS Code delivered together are all noted. Resolves
 * true once a burst took the video, false when it is alone or after 10 s (open it as usual).
 */
async function holdOpen(uri) {
  if (!burst.waiting) return false;
  await new Promise((done) => setImmediate(done));
  const held = burst.wait(uri.toString());
  if (!held) return false;
  let timer;
  const cap = new Promise((r) => { timer = setTimeout(() => r(false), 10000); });
  return Promise.race([held, cap]).finally(() => clearTimeout(timer));
}

/** Open Together: the burst's videos in one viewer (in a tab that already is one, else the first tab). */
async function openBurst(context, { items, extra }) {
  const panels = items.flatMap((it) => it.panels);
  const host = panels.map((p) => panelViewers.get(p)).find((v) => v && !v.disposed) || null;
  const clips = [];
  for (const it of items) {
    if (host && host.session.clips.some((c) => c.uri && c.uri.toString() === it.key)) continue;
    try { clips.push(await unifiedViewer.prepareClip(it.uri, prepDeps(true))); }
    catch (e) { log(`open together: cannot open ${path.basename(it.uri.fsPath)}: ${e && e.message || e}`); }
  }
  if (!host && clips.length < 2) return false;
  // A tab that already became a viewer (it opened alone a moment before) takes the others only while there is room;
  // else they open as usual.
  if (host && (!clips.length || host.session.clips.length + clips.length > host.session.maxVideos)) return false;
  let viewer = host;
  if (viewer) for (const c of clips) viewer.session.addClip(c, { compare: true });
  else viewer = await showViewer(context, panels[0], clips[0], null, clips.slice(1));
  if (!viewer) return false;
  for (const p of panels) if (p !== viewer.panel) { try { p.dispose(); } catch { /* gone already */ } }
  log(`${viewer.session.clips.length} videos opened together -> one compare${extra.length ? `, ${extra.length} more stay as tabs` : ''}`);
  noticeTogether(viewer.session.clips.length);
  if (extra.length) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${maxVideos()} videos; the other ${extra.length} stay open as they are.`);
  return true;
}

/** The one-time notice after the first Open Together, with the way to turn it off. */
function noticeTogether(n) {
  const key = 'videoPreviewEnhanced.openTogetherNoticed';
  if (globalState.get(key)) return;
  Promise.resolve(globalState.update(key, true)).catch(() => {});
  Promise.resolve(vscode.window.showInformationMessage(togetherNotice(n), 'Got it', 'Open Settings')).then((c) => (
    c === 'Open Settings' ? vscode.commands.executeCommand('workbench.action.openSettings', 'videoPreviewEnhanced.compare.openTogether') : undefined
  )).catch(() => {});
}

// ---- Compare: more videos into a viewer ----

const fileKey = (uri) => uri.with({ query: '', fragment: '' }).toString();

/** The viewer showing `uri` (the active one first), or null. */
function viewerOf(uri) {
  const key = fileKey(uri);
  const all = [...unifiedViewers].filter((v) => !v.disposed && v.session.clips.some((c) => c.uri && fileKey(c.uri) === key));
  return all.find((v) => v.panel.active) || all.find((v) => v.panel.visible) || all[0] || null;
}

/** The first file the active viewer shows (the "current video" of the Compare commands), or null. */
function activeVideo() {
  const v = [...unifiedViewers].find((x) => x.panel.active);
  const c = v && v.session.clips.find((x) => x.uri && (!x.kind || x.kind === 'file'));
  return c ? c.uri : null;
}

/** Prepared clips for uris; one that cannot be opened is logged and left out. */
async function prepareUris(uris) {
  const out = [];
  for (const u of uris) {
    if (!unifiedViewer.isViewable(u)) continue;
    try { out.push(await unifiedViewer.prepareClip(u, prepDeps(true))); }
    catch (e) { log(`compare: cannot open ${path.basename(u.fsPath)}: ${e && e.message || e}`); }
  }
  return out;
}

/** Remembers videos compared lately (the quick pick lists them first). */
function rememberRecent(uris) {
  let recent = globalState.get(RECENT_KEY) || [];
  for (const u of uris) recent = pushRecent(recent, u.toString());
  globalState.update(RECENT_KEY, recent);
}

/**
 * A new viewer tab with `uris` side by side (up to compare.maxVideos). `goto`: a compare link's moment. `allowDuplicate`:
 * a file named twice shows twice (an explicit list, e.g. identical pictures for the metrics); otherwise once.
 */
async function openCompare(context, uris, { goto = null, allowDuplicate = false } = {}) {
  const max = maxVideos();
  if (uris.length > max) vscode.window.showWarningMessage(`Video Preview: compare shows up to ${max} videos; showing the first ${max}.`);
  const clips = await prepareUris(uris.slice(0, max));
  if (!clips.length) { vscode.window.showWarningMessage('Video Preview: none of these videos can be opened.'); return null; }
  log(`compare: ${clips.map((c) => c.label).join(' <-> ')}`);
  rememberRecent(uris.slice(0, max));
  const panel = vscode.window.createWebviewPanel(COMPARE_VIEW_TYPE, clips.map((c) => c.label).join(' · '), vscode.ViewColumn.Active, { retainContextWhenHidden: true });
  panel.iconPath = new vscode.ThemeIcon('split-horizontal');
  return showViewer(context, panel, clips[0], goto ? { goto } : null, clips.slice(1), { allowDuplicate });
}

/** `uris` join `viewer` (no duplicates, up to compare.maxVideos); the page says what happened. */
async function addToViewer(viewer, uris) {
  const have = new Set(viewer.session.clips.filter((c) => c.uri).map((c) => fileKey(c.uri)));
  const fresh = uris.filter((u, i) => !have.has(fileKey(u)) && uris.findIndex((x) => fileKey(x) === fileKey(u)) === i);
  if (!fresh.length) { viewer.post({ type: 'toast', text: 'Already in Compare', ms: 2500 }); return viewer; }
  const room = Math.max(0, viewer.session.maxVideos - viewer.session.clips.length);
  if (fresh.length > room) {
    const skipped = fresh.length - room;
    vscode.window.showInformationMessage(`Video Preview: skipped ${skipped} video${skipped === 1 ? '' : 's'} because Compare is full.`);
    fresh.length = room;
  }
  for (const u of fresh) {
    try { await viewer.addUri(u); } catch (e) { log(`compare: cannot add ${path.basename(u.fsPath)}: ${e && e.message || e}`); }
  }
  rememberRecent(fresh);
  viewer.panel.reveal(undefined, false);
  return viewer;
}

/** A file or folder of a selection: its videos (a folder's in natural order, subfolders too). */
async function selectionVideos(uri) {
  if (!(uri instanceof vscode.Uri) || !FS_SCHEMES.has(uri.scheme)) return [];
  try {
    const dir = vscode.FileType.Directory;
    const symlink = vscode.FileType.SymbolicLink ?? 64;
    const stat = await vscode.workspace.fs.stat(uri);
    if (!(stat.type & dir)) return COMPARE_VIDEO_EXT.test(uri.path) ? [uri] : [];
    return await collectFolderVideos(
      uri,
      (folder) => vscode.workspace.fs.readDirectory(folder),
      (folder, name) => vscode.Uri.joinPath(folder, name),
      {
        dir, symlink,
        stat: (u) => vscode.workspace.fs.stat(u),
        // Canonical path for loop detection (local files and Remote-SSH / container workspace hosts).
        realPath: (u) => (FS_SCHEMES.has(u.scheme) && u.fsPath ? fs.promises.realpath(u.fsPath) : Promise.resolve(u.toString())),
        key: fileKey,
        log: (m) => log(`compare folder: ${m}`),
      },
    );
  } catch (e) {
    log(`compare selection ${uri.toString()}: ${e && e.message || e}`);
    return [];
  }
}

/**
 * Start Compare / Add to Compare / Compare folder on an Explorer selection: the videos join the active viewer (or the
 * one used last), else a new viewer shows them.
 */
async function compareSelection(context, uri, uris) {
  const selection = compareTargets(uri, uris, vscode.window.tabGroups && vscode.window.tabGroups.all, (u) => COMPARE_VIDEO_EXT.test(u.path), fileKey);
  const videos = (await Promise.all(selection.map(selectionVideos))).flat();
  if (!videos.length) { vscode.window.showInformationMessage('Video Preview: no videos in the selection.'); return null; }
  const target = activeViewer();
  if (target && target.session.clips.some((c) => c.uri)) return addToViewer(target, videos);
  const viewer = await openCompare(context, videos);
  // One video starts a Compare of its own with Add Mode on (the next videos opened join it); several are the whole set.
  if (viewer && viewer.session.clips.length === 1) viewer.session.setCapture(true);
  return viewer;
}

/** The internal 'compare' command (tests): a new viewer with the list as given (the same file twice too), or two picked files. */
async function compareList(context, uri, uris) {
  const list = (Array.isArray(uris) && uris.length ? uris : uri ? [uri] : []).filter((u) => COMPARE_VIDEO_EXT.test(u.path));
  if (list.length >= 2) return openCompare(context, list, { allowDuplicate: true });
  const a = list[0] || activeVideo() || (await pickVideos('Compare: video A', undefined, false) || [])[0];
  if (!a) return null;
  const b = (await pickVideos(`Compare with ${path.basename(a.fsPath)} (B)`, vscode.Uri.joinPath(a, '..'), false) || [])[0];
  return b ? openCompare(context, [a, b]) : null;
}

/** Compare With…: pick files to show beside `uri` (the viewer showing it takes them). */
async function compareWith(context, uri) {
  const a = (uri instanceof vscode.Uri ? uri : null) || activeVideo() || (await pickVideos('Compare: video A', undefined, false) || [])[0];
  if (!a) return null;
  const more = await pickVideos(`Compare with ${path.basename(a.fsPath)}`, vscode.Uri.joinPath(a, '..'), true);
  const files = (more || []).filter((u) => FS_SCHEMES.has(u.scheme) && fileKey(u) !== fileKey(a));
  if (!files.length) return null;
  const v = viewerOf(a);
  return v ? addToViewer(v, files) : openCompare(context, [a, ...files]);
}

/** The quick pick's rows for video `a` (or a folder): its folder, the workspace, Browse… (src/comparepick.js). */
async function pickItems(a, folderUri) {
  const dir = folderUri || (a ? vscode.Uri.joinPath(a, '..') : null);
  let folder = [];
  if (dir) {
    try { folder = (await vscode.workspace.fs.readDirectory(dir)).filter(([, ty]) => ty !== 2).map(([n]) => vscode.Uri.joinPath(dir, n).toString()); } catch { /* unreadable: workspace only */ }
  }
  let workspace = [];
  try {
    const found = await vscode.workspace.findFiles('**/*.{avi,mkv,mov,wmv,flv,mpg,mpeg,m2ts,mts,3gp,ogv,m4v,vob,divx,asf,mxf,y4m,mp4,webm}', '**/node_modules/**', 300);
    workspace = found.map((u) => u.toString());
  } catch { /* no workspace */ }
  return pickRows({ current: a ? a.toString() : '', folder, workspace, recent: globalState.get(RECENT_KEY) || [] }).map((r) => (
    r.kind === 'sep' ? { kind: vscode.QuickPickItemKind.Separator, label: r.label }
      : {
        label: r.kind === 'browse' ? '$(folder-opened) Browse…' : r.kind === 'explorer' ? '$(list-tree) Click videos in the Explorer…' : r.label,
        browse: r.kind === 'browse', explorer: r.kind === 'explorer', uri: r.uri,
        description: r.uri && !folder.includes(r.uri) ? vscode.workspace.asRelativePath(vscode.Uri.parse(r.uri), false) : '',
      }));
}

/** Key D's quick pick from a command: other videos (same folder first) beside `uri`. */
async function comparePick(context, uri) {
  const a = (uri instanceof vscode.Uri ? uri : null) || activeVideo();
  if (!a) return null;
  const items = await pickItems(a);
  const hook = getPickHook();
  const chosen = await (hook ? hook(items) : vscode.window.showQuickPick(items, { placeHolder: `Compare ${path.basename(a.fsPath)} with…`, matchOnDescription: true }));
  if (!chosen) return null;
  const v = viewerOf(a);
  if (chosen.explorer) { if (v) v.session.setCapture(true); return v; }
  if (chosen.browse) return compareWith(context, a);
  const b = vscode.Uri.parse(chosen.uri);
  return v ? addToViewer(v, [b]) : openCompare(context, [a, b]);
}

/**
 * The page's "Add video" / "Replace" dialog (src/unified-viewer.js deps.pick). A test's pick hook
 * (src/comparepick.js setPickHook) answers from the quick pick's rows instead; a test's Start Compare files come next.
 */
async function pickVideos(label, defaultUri, many) {
  const hook = getPickHook();
  if (hook) {
    const chosen = await hook(await pickItems(activeVideo(), defaultUri));
    if (chosen && chosen.uri) return [vscode.Uri.parse(chosen.uri)];
    if (!chosen || !chosen.browse) return undefined;
  }
  const files = testCompareFiles;
  testCompareFiles = undefined;
  if (files) return files;
  return vscode.window.showOpenDialog({ canSelectMany: !!many, openLabel: label, defaultUri, filters: videoPickerOptions().filters });
}

/** "Add to Compare" from a player tab: the video joins the comparison used last. */
async function addToCompareFromPlayer(uri) {
  const video = (uri instanceof vscode.Uri ? uri : null) || activeVideo();
  if (!video || !FS_SCHEMES.has(video.scheme) || !COMPARE_VIDEO_EXT.test(video.path)) return null;
  const compare = [lastViewer, ...unifiedViewers].find((v) => v && !v.disposed && v.session.clips.length >= 2);
  return compare ? addToViewer(compare, [video]) : null;
}

/**
 * The folder rail's "Compare all videos in folder" on a folder row: the folder's videos (the same walk as Compare
 * folder in the Explorer) take a single video's place as a comparison, or join a comparison (no duplicates, up to
 * compare.maxVideos). A toast says when there is nothing to do.
 */
async function compareFolderRow(viewer, folderUri) {
  if (!folderUri || !FS_SCHEMES.has(folderUri.scheme)) return;
  const videos = await selectionVideos(folderUri);
  if (viewer.disposed) return;
  const max = maxVideos();
  const comparing = viewer.session.clips.length >= 2;
  const plan = folderRail.planFolderCompare({
    videoKeys: videos.map(fileKey), compareKeys: comparing ? viewer.session.clips.filter((c) => c.uri).map((c) => fileKey(c.uri)) : null, max,
  });
  const name = path.basename(folderUri.fsPath);
  const say = (text) => viewer.post({ type: 'toast', text, ms: 3000 });
  const byKey = new Map(videos.map((u) => [fileKey(u), u]));
  const uris = plan.keys.map((k) => byKey.get(k));
  log(`compare: folder rail: ${name} (${videos.length} videos) -> ${plan.action}`);
  if (plan.action === 'open') {
    // The folder's videos replace the single video: the first takes its tile, the others join.
    const only = viewer.session.clips[0];
    const [first, ...rest] = await prepareUris(uris);
    if (!first || viewer.disposed) return;
    if (!only || !viewer.session.replaceClip(only.id, first)) viewer.session.addClip(first, { compare: true });
    for (const c of rest) viewer.session.addClip(c, { compare: true });
    log(`compare: ${[first, ...rest].map((c) => c.label).join(' <-> ')}`);
    if (plan.skipped) say(`Compare shows up to ${max} videos: the first ${max} of ${name}`);
    return;
  }
  if (plan.action === 'add') {
    await addToViewer(viewer, uris);
    say(`Added ${uris.length} from ${name} to Compare${plan.skipped ? `; Compare is full (${max} videos)` : ''}`);
    return;
  }
  say(plan.action === 'few' ? (comparing ? `No videos in ${name}` : `${name} has fewer than 2 videos to compare`)
    : plan.action === 'full' ? `Compare is full (${max} videos)` : `The videos of ${name} are in Compare already`);
}

/** Videos dropped on a page (uri strings): they join its viewer. */
async function addDropped(viewer, dropped) {
  const authority = remoteAuthority(viewer.panel.webview);
  const files = droppedVideos(dropped.filter((x) => typeof x === 'string').slice(0, 20)).map((s) => {
    try {
      const u = vscode.Uri.parse(s);
      if (u.scheme !== 'vscode-remote') return u;
      if (authority && u.authority === authority) return u.with({ scheme: 'file', authority: '' });
    } catch { /* not a URI */ }
    return null;
  }).filter((u) => u && isLocalVideo(u, VIDEO_EXT));
  return files.length ? addToViewer(viewer, files) : undefined;
}

// ---- frame links (vscode://…/open, …/compare) ----

function resolveLinkTarget(rawTarget) {
  const target = localTarget(rawTarget);
  if (!target) {
    return { error: `Video Preview: this frame link is for ${rawTarget.authority || 'another machine'}. Open it in a window connected there.` };
  }
  // Links come from anywhere (a chat, a web page): only video files on a real file
  // system, never a share on another machine (opening \\host\share reaches out to it).
  if (!isLocalVideo(target, VIDEO_EXT)) {
    log(`link refused: ${target.toString()}`);
    return { error: 'Video Preview: frame links only open video files (no network shares or other schemes).' };
  }
  return { target };
}

async function openLink(context, link) {
  log(`link: ${link.toString(true)}`);
  if (link.path === '/compare') {
    const parsed = parseCompareLink(link.query);
    if (!parsed || parsed.targets.length < 2) {
      vscode.window.showWarningMessage('Video Preview: a compare link needs at least two video files.');
      return;
    }
    const targets = [];
    for (const raw of parsed.targets) {
      const r = resolveLinkTarget(raw);
      if (r.error) { vscode.window.showWarningMessage(r.error); return; }
      targets.push(r.target);
    }
    const goto = parsed.goto || parsed.mode ? { ...(parsed.goto || {}), ...(parsed.mode ? { mode: parsed.mode } : {}) } : null;
    // The same videos open already: that viewer shows the moment.
    const keys = targets.slice(0, maxVideos()).map(fileKey);
    const open = [...unifiedViewers].find((v) => !v.disposed && v.session.clips.length === keys.length
      && v.session.clips.every((c, i) => c.uri && fileKey(c.uri) === keys[i]));
    if (open) {
      open.panel.reveal();
      if (goto) open.goto(goto);
      return;
    }
    await openCompare(context, targets, { goto });
    return;
  }
  if (link.path !== '/open') return;
  const parsed = parseLink(link.query);
  if (!parsed) { vscode.window.showWarningMessage('Video Preview: the link names no file.'); return; }
  const { goto: g } = parsed;
  const r = resolveLinkTarget(parsed.target);
  if (r.error) { vscode.window.showWarningMessage(r.error); return; }
  const { target } = r;
  const key = target.with({ fragment: '' }).toString();
  const open = viewerOf(target);
  if (open) {
    open.panel.reveal();
    const c = open.session.clips.find((x) => x.uri && fileKey(x.uri) === fileKey(target));
    if (g) open.goto(g, c ? c.id : undefined);
    return;
  }
  const now = Date.now();
  for (const [k, p] of pendingGoto) if (p.until < now) pendingGoto.delete(k);
  // Only for the viewer this link opens: a file opened by hand later starts normally.
  if (g) pendingGoto.set(key, { g, until: now + PENDING_GOTO_MS });
  await vscode.commands.executeCommand('vscode.openWith', target, playerViewType(target));
}

function deactivate() {
  for (const v of [...unifiedViewers]) v.dispose();
  resetFocusMode();
}

module.exports = { activate, deactivate };
