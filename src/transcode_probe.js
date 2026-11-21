'use strict';
// Platform hardware-first, software-last H.264 encoder chain and open-probe (ADR 0002).
// Never trusts `ffmpeg -encoders` alone: opens each candidate on a tiny synthetic frame (~0.2 s)
// and parses NVENC driver/API mismatch errors so the user gets a clear driver notice.

const fs = require('fs');
const os = require('os');
const { CPU_ENCODERS, GPU_ENCODERS, encoderArgs, encoderFrame } = require('./transcode_args');

/** VAAPI render nodes on a Linux host (none elsewhere). */
function renderNodes(platform = process.platform) {
  if (platform !== 'linux') return [];
  try {
    return fs.readdirSync('/dev/dri').filter((f) => /^renderD\d+$/.test(f)).sort().map((f) => `/dev/dri/${f}`);
  } catch { return []; }
}

/**
 * Hardware encoder chain for a platform, best first (ADR 0002):
 * - Windows: h264_nvenc -> h264_qsv -> h264_amf -> h264_mf (with -hw_encoding 1)
 * - macOS:   h264_videotoolbox
 * - Linux:   h264_nvenc -> h264_vaapi
 * @param {string} [platform]
 * @returns {string[]}
 */
function platformEncoders(platform = process.platform) {
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'];
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'linux') return ['h264_nvenc', 'h264_vaapi'];
  return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi'];
}

/** The CPU encoder in an `ffmpeg -encoders` listing: libx264, else libopenh264 (libx264 when neither). */
function cpuEncoder(listing) {
  if (/\slibx264\s/.test(listing || '')) return 'libx264';
  return /\slibopenh264\s/.test(listing || '') ? 'libopenh264' : 'libx264';
}

/**
 * Parses FFmpeg's NVENC API/driver mismatch error from stderr.
 * Example:
 *   "Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0"
 *   "The minimum required Nvidia driver for nvenc is 610.00 or newer"
 * @param {string} stderr
 * @returns {{ requiredApi: string|null, foundApi: string|null, minDriver: string|null }|null}
 */
function parseNvencDriverError(stderr) {
  const s = String(stderr || '');
  const api = /Required:\s*([\d.]+)\s+Found:\s*([\d.]+)/i.exec(s);
  const drv = /minimum required Nvidia driver[^0-9]*([\d.]+)/i.exec(s);
  if (!api && !drv && !/does not support the required nvenc API/i.test(s)) return null;
  return {
    requiredApi: api ? api[1] : null,
    foundApi: api ? api[2] : null,
    minDriver: drv ? drv[1] : null,
  };
}

/**
 * Open-probes hardware encoders in platform order using a tiny 256x256, 3-frame test encode (~0.2 s)
 * with the stream's actual encoder arguments. Falls back to the CPU encoder (libx264 / libopenh264)
 * only if every hardware encoder fails or is absent.
 *
 * @param {string} ffmpeg
 * @param {(cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number, stdout?: string, stderr?: string }>} run
 * @param {{ platform?: string, nodes?: string[] }} [opts]
 * @returns {Promise<{ encoder: string, hw: boolean, device?: string, tried: Array<any>, cpu: string, driverNotice: any }>}
 */
async function probeEncoder(ffmpeg, run, opts = {}) {
  const platform = opts.platform || process.platform;
  const nodes = opts.nodes !== undefined ? opts.nodes : renderNodes(platform);
  const tried = [];
  const list = await run(ffmpeg, ['-hide_banner', '-encoders'], 10000);
  if (list.code !== 0) throw new Error(`ffmpeg -encoders failed (${list.code}): ${String(list.stderr || '').trim()}`);
  const chain = [...platformEncoders(platform)];
  if (nodes.length && !chain.includes('h264_vaapi')) chain.push('h264_vaapi');
  const have = new Set(chain.filter((e) => new RegExp(`\\s${e}\\s`).test(list.stdout || '')));
  const cpu = cpuEncoder(list.stdout);
  let driverNotice = null;
  for (const enc of chain) {
    if (!have.has(enc)) continue;
    for (const device of enc === 'h264_vaapi' ? nodes : [undefined]) {
      const fr = encoderFrame(enc, device);
      const args = [
        '-hide_banner', '-nostdin', '-v', 'error', ...fr.pre,
        '-f', 'lavfi', '-i', 'color=s=256x256:r=30:d=0.2',
        '-vf', fr.vf, ...encoderArgs(enc, 30), '-frames:v', '3', '-f', 'null', '-',
      ];
      const r = await run(ffmpeg, args, 8000);
      const ok = r.code === 0;
      const stderr = String(r.stderr || r.code);
      const lines = stderr.trim().split(/\r?\n/);
      const why = lines.find((l) => l.includes(`[${enc} @`)) || lines[lines.length - 1];
      if (!ok && enc === 'h264_nvenc') {
        const parsed = parseNvencDriverError(stderr);
        if (parsed) driverNotice = parsed;
      }
      tried.push({ encoder: enc, device, ok, error: ok ? undefined : why.replace(/^\[[^\]]*\]\s*/, '') });
      if (ok) return { encoder: enc, hw: true, device, tried, cpu, driverNotice: null };
    }
  }
  return { encoder: cpu, hw: false, tried, cpu, driverNotice };
}

// Encoder choice per host, ffmpeg binary and NVIDIA driver: confirmed choices are kept in globalState.
const encoderMem = new Map();
const ENCODER_KEY = 'remoteStreamEncoders';
const ENCODER_RETRY_MS = 60000;

function encoderCacheKey(tools, nvidiaDriver) {
  return `${os.hostname()}|${tools.ffmpeg}|${tools.version || ''}${nvidiaDriver ? `|nv:${nvidiaDriver}` : ''}`;
}

/**
 * The cached encoder for this host and ffmpeg, open-probing on first use.
 * @param {{ ffmpeg: string, version?: string }} tools
 * @param {Function} run
 * @param {any} store VS Code globalState (Memento) or null
 * @param {Function} [log]
 * @param {{ platform?: string, nvidiaDriver?: string|null }} [opts]
 */
async function encoderFor(tools, run, store, log = () => {}, opts = {}) {
  if (process.env.VPE_RS_ENCODER) {
    const e = process.env.VPE_RS_ENCODER;
    return { encoder: e, hw: !CPU_ENCODERS.includes(e), cpu: 'libx264', driverNotice: null };
  }
  const key = encoderCacheKey(tools, opts.nvidiaDriver);
  const cached = encoderMem.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  const saved = !cached && store && (store.get(ENCODER_KEY) || {})[key];
  if (saved && (saved.noGpu || GPU_ENCODERS.includes(saved.encoder))) {
    const rec = { ...saved, hw: !CPU_ENCODERS.includes(saved.encoder) };
    encoderMem.set(key, { choice: rec, result: Promise.resolve(rec), until: Infinity });
    return rec;
  }
  const entry = { until: Infinity };
  entry.result = (async () => {
    const t0 = Date.now();
    let r;
    try { r = await probeEncoder(tools.ffmpeg, run, opts); } catch (e) {
      log(`live transcode encoder probe on ${os.hostname()} failed: ${e.message}; using libx264 for this stream`);
      entry.until = 0;
      return { encoder: 'libx264', hw: false, cpu: 'libx264', driverNotice: null };
    }
    log(`remote stream encoder on ${os.hostname()}: ${r.encoder}${r.device ? ` (${r.device})` : ''}, tested in ${Date.now() - t0} ms${r.tried.length ? `: ${r.tried.map((x) => `${x.encoder}${x.device ? ` ${x.device}` : ''} ${x.ok ? 'ok' : `failed (${x.error})`}`).join('; ')}` : ''}`);
    const rec = { encoder: r.encoder, hw: r.hw, device: r.device, cpu: r.cpu, driverNotice: r.driverNotice || null, at: Date.now() };
    entry.choice = rec;
    if (CPU_ENCODERS.includes(r.encoder)) {
      if (r.tried.length) { entry.until = Date.now() + ENCODER_RETRY_MS; return rec; }
      rec.noGpu = true;
    }
    if (store) {
      const all = { ...(store.get(ENCODER_KEY) || {}) };
      all[key] = rec;
      const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0));
      for (const k of keys.slice(20)) delete all[k];
      try { await store.update(ENCODER_KEY, all); } catch { /* memory only */ }
    }
    return rec;
  })();
  encoderMem.set(key, entry);
  return entry.result;
}

/** A runtime failure can be input-specific. Reprobe on next open. */
function encoderFailed(tools, choice, nvidiaDriver) {
  const entry = encoderMem.get(encoderCacheKey(tools, nvidiaDriver));
  if (entry && entry.choice === choice) entry.until = 0;
}

module.exports = {
  renderNodes,
  platformEncoders,
  cpuEncoder,
  parseNvencDriverError,
  probeEncoder,
  encoderCacheKey,
  encoderFor,
  encoderFailed,
  ENCODER_KEY,
};
