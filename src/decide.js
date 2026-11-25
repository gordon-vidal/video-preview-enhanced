'use strict';
// Which decoder plays a file: native ffmpeg or the built-in one (WebAssembly +
// WebCodecs in the webview), and which ffmpeg method. Plain functions over what is
// known: the setting, the window (local or remote), the codec, the ffmpeg probe
// results for this machine (they only pick the method), and files native ffmpeg failed on.

const hwaccel = require('./hwaccel');

// The order's first method at least this much faster than the file needs wins over faster ones further down.
const COMFORT = 2;
// Below that, a method further down the order must be this much faster to replace an earlier one.
const HYSTERESIS = 1.3;
// Raw frames from the extension host to the webview: about this many bytes per second (VS Code's
// postMessage, measured with the 'bench' debug command in a real VS Code 1.146 on a busy Core Ultra
// laptop: 140-180 MB/s; the host spends ~5 ms per MB posting). The probe times ffmpeg alone.
const TRANSPORT_BPS = 150e6;
// The localhost frame server (src/frameserver.js, local windows). Raw: 430-890 MB/s into a real
// VS Code 1.147 webview ('transfer-bench' in test/vscode/cases/native_transfer.js, i7-9700K, busy
// machine). While playing 4K the webview takes 370-470 MB/s (it also uploads and draws each frame;
// the host is ~idle): 4K30 plays in full, 4K60 at 30-37 fps. docs/notes/native-transfer.md.
const FRAME_SERVER_BPS = 400e6;
// Automatic nativeMaxHeight over the frame server: the largest of these whose frames fit FRAME_SERVER_BPS
// at the video's frame rate (4K 4:2:0 is 12.4 MB a frame: 30 fps fits, 60 fps gets 1440p).
const FRAME_SERVER_HEIGHTS = [2160, 1440, 1080];
const FRAME_SERVER_HEIGHT = FRAME_SERVER_HEIGHTS[0];

/**
 * Frames per second the host can send to the webview at the output size (yuv420p, scaled to maxHeight).
 * transport: 'message' (postMessage, the default) or 'stream' (the frame server).
 */
function transportFps(v, maxHeight = 1080, transport = 'message') {
  const h = Math.min(v.height, maxHeight);
  const w = (v.width * h) / Math.max(1, v.height);
  return Math.round((transport === 'stream' ? FRAME_SERVER_BPS : TRANSPORT_BPS) / Math.max(1, w * h * 1.5));
}

/**
 * The automatic frame height over the frame server for a video {width, height, fps}: full size
 * when its frames fit FRAME_SERVER_BPS, else the largest of FRAME_SERVER_HEIGHTS that does (at
 * least 1080p, which postMessage carries too).
 */
function streamHeight(v) {
  if (!v || !(v.height > 0)) return FRAME_SERVER_HEIGHT;
  const fps = v.fps > 0 ? v.fps : 30;
  const last = FRAME_SERVER_HEIGHTS[FRAME_SERVER_HEIGHTS.length - 1];
  // (transportFps counts the size actually sent: a 1080p video at "2160" is sent at 1080p.)
  return FRAME_SERVER_HEIGHTS.find((h) => h === last || transportFps(v, h, 'stream') >= fps * 0.98);
}

/** The probe class of an ffprobe'd video stream. */
function videoClass(v) {
  return hwaccel.classOf(v.codec, hwaccel.depthOf(v.pixFmt, v.codec), v.width, v.height);
}

/**
 * Probe results for a video: the class itself, or the other resolution of the same
 * codec and depth, or an intra codec like ProRes for DNxHR/CineForm. Speeds are
 * scaled by pixel count. Null when nothing comparable was tested (MPEG-2, WMV…).
 */
function probeEntry(record, v) {
  if (!record || !record.results) return null;
  const cls = videoClass(v);
  const [fam, depth] = cls.split('/');
  const fams = [fam];
  if (/^(dnxhd|dnxhr|cfhd|hqx|v210)$/.test(fam)) fams.push('prores');
  const px = Math.max(1, v.width * v.height);
  const res = cls.split('/')[2];
  const other = res === '1080' ? '2160' : '1080';
  const candidates = [cls];
  for (const f of fams) for (const r of [res, other]) for (const d of [depth, depth === '8' ? '10' : '8']) candidates.push(`${f}/${d}/${r}`);
  for (const c of candidates) {
    const e = record.results[c];
    if (e && e.method) return { cls, from: c, scale: hwaccel.CLASS_PIXELS[c.split('/')[2]] / px, entry: e };
  }
  return null;
}

/**
 * The method and estimated fps for this video: the first method (in the probe's order) that
 * decodes it comfortably faster than needed; else the fastest, where a method further down
 * replaces an earlier one only when it is HYSTERESIS times faster (no flip-flopping between
 * two methods of about the same speed). Speeds: the probe's, scaled by pixels and, for
 * software decoding, by the file's bit rate. gpu false: software only.
 */
function nativeEstimate(record, v, gpu = true) {
  const p = probeEntry(record, v);
  if (!p) return null;
  const fps = v.fps || 30;
  const ok = p.entry.tried.filter((t) => t.ok && t.fps > 0 && (gpu || t.method === 'none'))
    .map((t) => ({ method: t.method, fps: t.fps * p.scale * hwaccel.bitrateFactor(t.method, p.entry.bpp, v) }));
  if (!ok.length) return null;
  let pick = ok.find((t) => t.fps >= fps * COMFORT);
  if (!pick) for (const t of ok) if (!pick || t.fps >= pick.fps * HYSTERESIS) pick = t;
  return { method: pick.method, fps: Math.round(pick.fps), factor: Math.round((pick.fps / fps) * 100) / 100, from: p.from };
}

/** The method for a video when nothing comparable was probed: what most 1080p classes chose, not qsv (it can't fall back). */
function defaultMethod(record, gpu = true) {
  if (!gpu) return 'none';
  if (!record || !record.results) return 'auto';
  const count = {};
  for (const [cls, r] of Object.entries(record.results)) {
    if (!r.method || !cls.endsWith('/1080')) continue;
    const m = r.method === 'qsv' ? (r.tried.find((t) => t.ok && t.method !== 'qsv') || {}).method : r.method;
    if (m) count[m] = (count[m] || 0) + 1;
  }
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'none';
}

/** Measured built-in speed for a video (x real time), from the per-machine records; null when unknown. */
function builtinSpeed(speeds, v) {
  if (!speeds) return null;
  const s = speeds[videoClass(v)];
  return s && s.n > 0 ? s.ratio : null;
}

/**
 * What the editor's GPU decoder (WebCodecs) plays: 8-bit 4:2:0 H.264 and VP8, the only video
 * codecs VS Code allows there. 10-bit or 4:2:2 H.264 goes to WebAssembly in the built-in decoder.
 */
function webcodecsPlays(v) {
  if (!v) return false;
  if (v.codec === 'vp8') return true;
  return v.codec === 'h264' && /^yuvj?420p$/.test(v.pixFmt || 'yuv420p');
}

/**
 * The method before any GPU test ran (none runs on its own: docs/PRODUCT.md), from the GPU vendors
 * hardware.detect() found (a WMI / lspci query, no decoding). NVIDIA: cuda, whose scale_cuda path
 * converts 10-bit to 8-bit and scales on the GPU (4K HEVC 10-bit in VS Code: ffmpeg ~40 % of a core against
 * 115-135 % with -hwaccel auto (dxva2) / d3d11va, which download P010 and convert on the CPU;
 * docs/notes/cpu-4k.md). Intel: qsv (vpp_qsv does the same on the GPU). Other Windows GPUs (AMD):
 * d3d11va. Elsewhere, or hw null (not detected yet): ffmpeg's own pick ('auto'). A guessed method that fails on
 * a file falls back to 'auto', then software (src/native.js).
 */
function vendorMethod(hw) {
  if (!hw || !Array.isArray(hw.gpus)) return 'auto';
  const v = new Set(hw.gpus.map((g) => g.vendor));
  if (hw.os === 'win32' || hw.os === 'linux') {
    if (v.has('nvidia')) return 'cuda';
    if (hw.os === 'win32' && v.has('intel')) return 'qsv';
    // AMD and others on Windows: d3d11va. -hwaccel auto takes dxva2 here, which fell to 9-14 fps on the
    // 4K PQ clip where d3d11va kept 30 (docs/notes/cpu-4k.md).
    if (hw.os === 'win32' && hw.gpus.length) return 'd3d11va';
  }
  return 'auto';
}

/**
 * The ffmpeg method for a video: the probe's choice for it, the common one, or before the probe
 * ran the GPU vendor's (vendorMethod; guessed: true).
 */
function nativeMethod(record, v, gpu, hw) {
  if (!gpu) return { method: 'none', est: null };
  if (!record || !record.results) return { method: vendorMethod(hw), est: null, guessed: true };
  const est = v ? nativeEstimate(record, v, gpu) : null;
  return { method: est ? est.method : defaultMethod(record, gpu), est };
}

/**
 * The decision. ctx: {
 *   setting: 'auto'|'builtin'|'ffmpeg', remote: vscode.env.remoteName, trusted, tools (or null),
 *   video: ffprobe'd stream {codec, pixFmt, width, height, fps} or null, probe: stored probe record or null,
 *   failed: native failed on this file before, fullRes: the user asked for exact pixels,
 *   gpu: the gpuDecoding setting, maxHeight: the native frame height (what the frames cost to send),
 *   transport: 'message' or 'stream' (the localhost frame server), hw: hardware.detect() or null }
 * Returns { use: 'native'|'builtin', method, guessed (no GPU test: the method is vendorMethod's), reason }.
 *
 * The rule (docs/PRODUCT.md): with ffmpeg installed, in a local window or WSL, ffmpeg plays
 * everything except 8-bit H.264 and VP8, which stay on the editor's GPU decoder (full
 * resolution, no extension-host cost). The probe only picks ffmpeg's method.
 */
function decide(ctx) {
  const builtin = (reason) => ({ use: 'builtin', method: null, reason });
  if (ctx.setting === 'builtin') return builtin('setting: built-in decoder');
  if (ctx.fullRes) return builtin('full resolution asked for (pixel tools)');
  if (!ctx.trusted) return builtin('Restricted Mode');
  if (!ctx.tools) return builtin('ffmpeg not installed');
  if (ctx.failed) return builtin('native ffmpeg failed on this file before');
  // Raw frames cross from the extension host: fine locally and in WSL, too much over SSH.
  if (ctx.remote && ctx.remote !== 'wsl') return builtin(`remote window (${ctx.remote}): raw frames would cross the network`);
  const gpu = ctx.gpu !== false;
  const v = ctx.video;
  if (ctx.setting === 'ffmpeg') {
    const n = nativeMethod(ctx.probe, v, gpu, ctx.hw);
    return { use: 'native', method: n.method, guessed: !!n.guessed, reason: 'setting: ffmpeg' };
  }
  // auto
  if (!v) return builtin('no video stream');
  if (webcodecsPlays(v)) return builtin(`${v.codec === 'vp8' ? 'VP8' : '8-bit H.264'}: the editor's GPU decoder (WebCodecs)`);
  const { method, est, guessed } = nativeMethod(ctx.probe, v, gpu, ctx.hw);
  if (!est) {
    const why = !gpu ? 'gpuDecoding off' : !ctx.probe ? `GPU test not run yet: ${method === 'auto' ? "ffmpeg's own pick" : `${method} for this GPU`}` : `${videoClass(v)} not probed`;
    return { use: 'native', method, guessed: !!guessed, reason: `${videoClass(v)}: ffmpeg (${why})` };
  }
  // What the host can send to the editor at the output size: for the log line only.
  const cap = transportFps(v, ctx.maxHeight, ctx.transport);
  const fps = Math.min(est.fps, cap);
  const capped = cap < est.fps ? `, capped by sending ${Math.min(v.height, ctx.maxHeight || 1080)}p frames to the editor` : '';
  return { use: 'native', method, reason: `${videoClass(v)}: ffmpeg ${method} ~${fps} fps (probe ${est.from}${capped})` };
}

// ---- built-in speed records (per-machine calibration) -------------------------

const SPEED_KEY = 'videoPreviewEnhanced.builtinSpeed';

/**
 * Adds one measured sample to the per-class records. sample: { codec, depth, width, height, ratio, realtime }.
 * Slow samples carry the measured ratio; real-time ones count as 1 (it kept up, it may well be faster).
 * An exponential average keeps one bad moment from deciding.
 */
function recordSpeed(speeds, sample, now = Date.now()) {
  const cls = hwaccel.classOf(sample.codec, sample.depth, sample.width, sample.height);
  const ratio = sample.realtime ? Math.max(1, sample.ratio || 1) : sample.ratio;
  if (!(ratio > 0)) return speeds || {};
  const all = { ...(speeds || {}) };
  const prev = all[cls];
  const r = prev && prev.n > 0 ? prev.ratio * 0.7 + ratio * 0.3 : ratio;
  all[cls] = { ratio: Math.round(r * 1000) / 1000, n: Math.min(1000, (prev ? prev.n : 0) + 1), at: now };
  return all;
}

// ---- the "set up ffmpeg" hint ---------------------------------------------------

const HINT_KEY = 'videoPreviewEnhanced.setupHint';
const HINT_SLOW_SAMPLES = 2; // consecutive slow samples (about 3 s each) before the hint
// One sample this far below real time is enough: no blip looks like that (4K HEVC/AV1/VP9 in
// WebAssembly run at 0.05-0.2x), and waiting for a second one only makes the user wait longer.
const HINT_HOPELESS = 0.5;
const SNOOZE_MS = 7 * 24 * 3600e3;

/**
 * Whether to suggest setting up ffmpeg now. ctx: { hint: stored {never, snoozedUntil},
 * now, shownThisSession, toolsInstalled, remote, trusted, slowRun: consecutive slow samples of this file,
 * ratio: the last sample's speed (x real time) }.
 */
/** After "Use built-in decoder": no slow-decoding reminder for 30 days. */
const BUILTIN_QUIET_MS = 30 * 24 * 3600 * 1000;

function shouldHint(ctx) {
  const h = ctx.hint || {};
  if (h.never) return false;
  if (h.snoozedUntil && ctx.now < h.snoozedUntil) return false;
  if (ctx.shownThisSession || ctx.toolsInstalled || ctx.remote || !ctx.trusted) return false;
  // "Don't Show Again" in the first-video popup is final (2026-11-20).
  const o = ctx.onboard;
  if (o && o.choice === 'builtin') return false;
  return ctx.slowRun >= HINT_SLOW_SAMPLES || (ctx.slowRun >= 1 && ctx.ratio > 0 && ctx.ratio < HINT_HOPELESS);
}

// What native ffmpeg gains over the built-in decoder, for the hint when ffmpeg isn't there yet
// (nothing probed). Measured 2026-11-19 on a desktop PC: Intel i7-9700K (8 cores), NVIDIA
// RTX 4070, 32 GB, ffmpeg 9.0.2 (gyan.dev full build), test/media clips, with
// node test/benchq.js node test/bench/run_bench.js --routes=wasm,cpuN,d3d,cuda.
// Ratios of decode fps against one WebAssembly decoder in Node ("wasm dec", the player's own
// decoder without colour conversion): cpu = ffmpeg on all cores (with conversion to yuv420p for
// 10-bit/4:2:2); gpu = the better of d3d11va and cuda with download and scaling (what playback
// does). The WebAssembly decoder is about 2x slower in VS Code than in Node, so these ratios are
// on the low side for a real player; a laptop gains less on the CPU. Native frames in VS Code are
// also capped by what the extension host can send (transportFps). Other sessions were using the
// machine: for AV1 10-bit 4K and VP9 4K (busy in both runs) the lower of two runs is kept;
// HEVC 10-bit 4K is the HLG and PQ clips (quiet rows; the SDR clip's rows were noisy).
const MEASURED_GAIN = {
  'hevc/8/1080': { cpu: 9.3, gpu: 11.4 },
  'hevc/10/1080': { cpu: 9.4, gpu: 15.3 },
  'hevc/10/2160': { cpu: 7.5, gpu: 27 },
  'av1/8/1080': { cpu: 16.5, gpu: 13.8 },
  'av1/10/1080': { cpu: 8.9, gpu: 7.3 },
  'av1/10/2160': { cpu: 10.3, gpu: 36 },
  'vp9/8/1080': { cpu: 13.8, gpu: 12 },
  'vp9/8/2160': { cpu: 14.1, gpu: 20.5 },
  'prores/10/1080': { cpu: 6.6, gpu: null },
  'mpeg2video/8/1080': { cpu: 8.6, gpu: 2.4 },
};

/** The measured gain for a sample's class, else the lowest measured for the same codec (any depth or size); null when not measured. */
function measuredGain(sample) {
  const cls = hwaccel.classOf(sample.codec, sample.depth, sample.width, sample.height);
  if (MEASURED_GAIN[cls]) return { ...MEASURED_GAIN[cls], from: cls };
  const fam = cls.split('/')[0];
  const same = Object.entries(MEASURED_GAIN).filter(([c]) => c.split('/')[0] === fam);
  if (!same.length) return null;
  const low = (k) => Math.min(...same.map(([, g]) => g[k] || g.cpu));
  return { cpu: low('cpu'), gpu: low('gpu'), from: `${fam}, other sizes` };
}

/**
 * How much faster ffmpeg would be for a slow sample: { fps, gain, source, cpu, gpu } or null.
 * A stored probe (an earlier ffmpeg on this machine) wins over the measured table; both are
 * capped at what the extension host can send to the editor at 1080p.
 */
function nativeGain(sample, probeRecord) {
  const fps = sample.fps || 30;
  const builtinFps = sample.ratio * fps;
  if (!(builtinFps > 0)) return null;
  const v = { codec: sample.codec, pixFmt: sample.depth > 8 ? 'yuv420p10le' : 'yuv420p', width: sample.width, height: sample.height, fps };
  const cap = transportFps(v);
  const est = probeRecord ? nativeEstimate(probeRecord, v) : null;
  if (est) { const f = Math.min(est.fps, cap); return { fps: f, gain: f / builtinFps, source: 'probe' }; }
  const g = measuredGain(sample);
  if (!g) return null;
  const best = Math.max(g.cpu, g.gpu || 0);
  // Real time is only claimed from the CPU number: which GPU decoders work differs per machine.
  return { fps: Math.min(builtinFps * g.cpu, cap), gain: best, cpu: g.cpu, gpu: g.gpu, source: 'table' };
}

/** "27×", "2.4×": the gains as said in the hint. */
const times = (x) => `${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}×`;

/** The hint's text for a slow sample. */
function hintText(sample, { mb, probeRecord } = {}) {
  const r = sample.ratio >= 0.1 ? sample.ratio.toFixed(1) : sample.ratio.toFixed(2);
  const fps = sample.fps || 30;
  const shown = Math.max(0.1, sample.ratio * fps);
  const head = `${describe(sample)} decodes at ${r}× here (${shown >= 10 ? Math.round(shown) : shown.toFixed(1)} of ${Math.round(fps)} fps).`;
  const size = `(≈${mb} MB, no admin needed)`;
  const g = nativeGain(sample, probeRecord);
  if (!g) return `${head} Set up ffmpeg ${size}: it decodes this natively, usually much faster.`;
  if (g.source === 'probe') {
    return g.fps >= fps ? `${head} Set up ffmpeg ${size}: it plays this in real time here (about ${times(g.gain)} faster, tested on this computer).`
      : `${head} Set up ffmpeg ${size}: about ${times(g.gain)} faster here (tested on this computer).`;
  }
  const how = g.gpu && g.gpu > g.cpu * 1.2 ? `about ${times(g.gpu)} faster with the GPU, ${times(g.cpu)} on the CPU alone` : `about ${times(g.cpu)} faster`;
  const rt = g.fps >= fps ? ', likely real time here' : '';
  return `${head} Set up ffmpeg ${size}: on an 8-core test PC it decoded this kind of video ${how}${rt}.`;
}

/** The hint state after the user's answer ('Set up', 'Not now', "Don't Show Again" or nothing). */
function afterHint(hint, answer, now = Date.now()) {
  const h = { ...(hint || {}), shownAt: now };
  if (answer === "Don't Show Again") h.never = true;
  else if (answer === 'Not now' || !answer) h.snoozedUntil = now + SNOOZE_MS;
  return h;
}

// The GPU test never runs by itself (docs/PRODUCT.md): without a test record the GPU's vendor picks
// the method (vendorMethod) and a failing one falls back. When playback still falls behind real time
// with ffmpeg installed (native, or the built-in decoder), one notification offers the test.
const PROBE_OFFER_KEY = 'videoPreviewEnhanced.gpuTestOffer';
const PROBE_OFFER_TEXT = 'Video Preview: this video plays slower than real time. Test ffmpeg on this computer (about 20 seconds) to find the fastest way to decode on your GPU?';
const PROBE_OFFER_RUN = 'Run test';
const PROBE_OFFER_LATER = 'Not now';
const PROBE_OFFER_NEVER = "Don't Show Again";

/**
 * Whether to offer the GPU test now. ctx: { offer: stored {never}, shownThisSession, toolsInstalled,
 * probeRecord: a test record fits this ffmpeg and GPU, gpu: the gpuDecoding setting, remote, trusted,
 * pending: another of our popups is up, running: a test runs, slowRun, ratio (as for shouldHint) }.
 */
function shouldOfferProbe(ctx) {
  if (ctx.offer && ctx.offer.never) return false;
  if (ctx.shownThisSession || !ctx.toolsInstalled || ctx.probeRecord || ctx.gpu === false) return false;
  if (ctx.remote || !ctx.trusted || ctx.pending || ctx.running) return false;
  return ctx.slowRun >= HINT_SLOW_SAMPLES || (ctx.slowRun >= 1 && ctx.ratio > 0 && ctx.ratio < HINT_HOPELESS);
}

/** The stored offer state after an answer: "Don't Show Again" is kept; anything else waits for the next session. */
function afterProbeOffer(offer, answer, now = Date.now()) {
  const o = { ...(offer || {}), shownAt: now, answer: answer || 'dismissed' };
  if (answer === PROBE_OFFER_NEVER) o.never = true;
  return o;
}

/** "HEVC 10-bit 4K" for a sample. */
function describe(s) {
  const names = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', prores: 'ProRes', mpeg2video: 'MPEG-2', vvc: 'VVC' };
  const px = s.width * s.height;
  const res = px > 2560 * 1440 ? '4K' : px > 1920 * 1088 ? `${s.height}p` : s.height >= 1000 ? '1080p' : `${s.height}p`;
  return `${names[s.codec] || String(s.codec).toUpperCase()} ${s.depth > 8 ? `${s.depth}-bit ` : ''}${res}`;
}

// ---- the first-open popup ----------------------------------------------------------

const ONBOARD_KEY = 'videoPreviewEnhanced.onboarding';
const ONBOARD_SETUP = 'Set up ffmpeg';
const ONBOARD_LATER = 'Not now';
const ONBOARD_BUILTIN = "Don't Show Again";
const ONBOARD_TEXT = 'Video Preview works best with ffmpeg: 4K, HDR, HEVC, AV1 and ProRes play smoothly on your GPU. Set it up now?';

/**
 * Whether to offer "Set up ffmpeg" now (2026-11-20): the first video of every session while
 * no ffmpeg is found, until "Don't Show Again" (choice 'builtin'); "Not now", closing it, or a setup
 * that ended without ffmpeg ask again next session. Local (or WSL) trusted windows only.
 * ctx: { state: stored answer or undefined, shownThisSession, toolsInstalled, remote, trusted, pending }.
 */
function shouldOnboard(ctx) {
  if ((ctx.state && ctx.state.choice === 'builtin') || ctx.pending || ctx.shownThisSession) return false;
  if (!ctx.trusted || (ctx.remote && ctx.remote !== 'wsl')) return false;
  return !ctx.toolsInstalled;
}

/** What to store for the popup: { at, choice: 'ffmpeg' | 'builtin' | 'later' | 'dismissed' | 'had-ffmpeg' }. */
function afterOnboard(answer, now = Date.now()) {
  const choice = answer === ONBOARD_SETUP ? 'ffmpeg' : answer === ONBOARD_BUILTIN ? 'builtin' : answer === ONBOARD_LATER ? 'later'
    : answer === 'had-ffmpeg' ? 'had-ffmpeg' : 'dismissed';
  return { at: now, choice };
}

// ---- files native ffmpeg failed on -------------------------------------------------

// Earlier entries could include tool and spawn failures, so start with a fresh cache.
const FAILED_KEY = 'videoPreviewEnhanced.nativeRejectedMedia';

function failedBefore(list, file, st) {
  const e = list && list[file];
  return !!e && !!st && e.size === st.size && e.mtime === st.mtimeMs;
}

function addFailed(list, file, st, error, now = Date.now()) {
  const all = { ...(list || {}) };
  all[file] = { size: st.size, mtime: st.mtimeMs, at: now, error: String(error || '').slice(0, 300) };
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const k of keys.slice(100)) delete all[k];
  return all;
}

module.exports = {
  decide, webcodecsPlays, nativeEstimate, nativeMethod, vendorMethod, transportFps, streamHeight, FRAME_SERVER_HEIGHT, FRAME_SERVER_BPS, TRANSPORT_BPS, defaultMethod, probeEntry, videoClass, builtinSpeed,
  shouldOfferProbe, afterProbeOffer, PROBE_OFFER_KEY, PROBE_OFFER_TEXT, PROBE_OFFER_RUN, PROBE_OFFER_LATER, PROBE_OFFER_NEVER,
  recordSpeed, shouldHint, afterHint, describe, failedBefore, addFailed, nativeGain, hintText,
  BUILTIN_QUIET_MS, shouldOnboard, afterOnboard, ONBOARD_KEY, ONBOARD_SETUP, ONBOARD_LATER, ONBOARD_BUILTIN, ONBOARD_TEXT,
  SPEED_KEY, HINT_KEY, FAILED_KEY, HINT_SLOW_SAMPLES, HINT_HOPELESS, SNOOZE_MS, MEASURED_GAIN, measuredGain,
};
