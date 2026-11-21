'use strict';
// Finding a native ffmpeg and probing files with it (optional decode backend).

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Drops a background ffmpeg (playback decode, thumbnails, streaming) to below-normal priority: it
 * still gets every idle core, but the mouse, the desktop compositor and the editor UI go first.
 * Several software decodes at normal priority filled all cores and made the cursor lag on Windows.
 * Not for the speed checks in src/probe.js: their fps must not depend on what else is running.
 */
function lowerPriority(proc) {
  try {
    if (proc && proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch { /* exited already, or not allowed: it keeps normal priority */ }
  return proc;
}

function run(cmd, args, timeoutMs = 30000, signal) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true, signal });
    } catch (e) {
      resolve({ code: -1, stdout, stderr: String(e) });
      return;
    }
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** The file a command name runs: an absolute path as it is, else the first match on PATH; null if none. */
async function whichFile(cmd) {
  const isFile = (f) => fs.promises.stat(f).then((st) => st.isFile(), () => false);
  if (path.isAbsolute(cmd)) return (await isFile(cmd)) ? cmd : null;
  if (/[\\/]/.test(cmd)) return null; // relative to a working folder: not worth guessing
  // spawn() without a shell runs only .com and .exe files on Windows (libuv's search), in this order.
  const exts = process.platform === 'win32' && !path.extname(cmd) ? ['.com', '.exe'] : [''];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const all = dirs.flatMap((dir) => exts.map((ext) => path.join(dir, cmd + ext)));
  const found = await Promise.all(all.map(isFile)); // in parallel: PATH often has 50 folders
  const i = found.indexOf(true);
  return i < 0 ? null : all[i];
}

/** size:mtime of a file (and of its folder: a shared build's DLLs added or removed), or null. */
async function fileStamp(file) {
  try {
    const [s, d] = await Promise.all([fs.promises.stat(file), fs.promises.stat(path.dirname(file))]);
    return `${s.size}:${Math.round(s.mtimeMs)}:${Math.round(d.mtimeMs)}`;
  } catch { return null; }
}

/** What identifies an ffmpeg / ffprobe pair on disk (resolved paths, sizes, times), or null when either can't be found. */
async function toolsKey(ffmpeg, ffprobe) {
  const parts = await Promise.all([ffmpeg, ffprobe].map(async (cmd) => {
    const f = await whichFile(cmd);
    const st = f && await fileStamp(f);
    return st ? `${f}|${st}` : null;
  }));
  return parts.includes(null) ? null : parts.join('|');
}

/**
 * Resolves ffmpeg and ffprobe, checking GPU filters once for the cached tools. cache ({ get(), set(rec) },
 * globalState in the extension): the result of the three checks (-version twice, -filters) for this exact
 * pair of files, so a window or a reload doesn't start them again; a changed, moved or replaced binary
 * (path, size or time) checks again. Only working tools are cached.
 */
// Bump when the set of discovered GPU filters changes so stale cached inventories re-probe.
const TOOLS_CACHE_VER = 2;

/** Parses GPU scale/VPP filter names from `ffmpeg -filters` stdout. */
function parseGpuFilters(stdout) {
  return new Set(Array.from(String(stdout || '').matchAll(/^\s*[.A-Z]+\s+(scale_cuda|vpp_qsv|scale_vaapi)\s+V->V\b/gm), (m) => m[1]));
}

/**
 * Checks that ffmpeg and ffprobe run, and learns the version and GPU filters.
 * ...
 */
async function locateTools(ffmpegSetting, ffprobeSetting, cache) {
  const ffmpeg = ffmpegSetting || 'ffmpeg';
  let ffprobe = ffprobeSetting;
  if (!ffprobe) {
    ffprobe = 'ffprobe';
    if (path.isAbsolute(ffmpeg)) {
      const sib = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      if (fs.existsSync(sib)) ffprobe = sib;
    }
  }
  const key = cache ? await toolsKey(ffmpeg, ffprobe) : null;
  const stamp = key || '';
  if (key) {
    const c = cache.get();
    if (c && c.key === key && c.v === TOOLS_CACHE_VER && typeof c.version === 'string') {
      return { ffmpeg, ffprobe, version: c.version, legacy: !!c.legacy, gpuFilters: new Set(c.gpuFilters || []), stamp, cached: true };
    }
  }
  const v = await run(ffmpeg, ['-hide_banner', '-version'], 10000);
  if (v.code !== 0) return null;
  const [p, filters] = await Promise.all([
    run(ffprobe, ['-hide_banner', '-version'], 10000),
    run(ffmpeg, ['-hide_banner', '-filters'], 10000),
  ]);
  if (p.code !== 0) return null;
  const version = v.stdout.split(/\r?\n/)[0];
  // -fps_mode arrived in ffmpeg 5.1; older builds use -vsync. Git builds (N-...) are new.
  const m = /version n?(\d+)\.(\d+)/.exec(version);
  const legacy = !!m && (Number(m[1]) < 5 || (Number(m[1]) === 5 && Number(m[2]) < 1));
  const gpuFilters = filters.code === 0 ? parseGpuFilters(filters.stdout) : new Set();
  // A failed -filters run is not cached: it would hide the GPU filters until the binary changes.
  if (key && filters.code === 0) {
    try { await cache.set({ key, v: TOOLS_CACHE_VER, version, legacy, gpuFilters: [...gpuFilters] }); } catch { /* not stored: checked again next time */ }
  }
  return { ffmpeg, ffprobe, version, legacy, gpuFilters, stamp };
}

/**
 * A text manifest or playlist (DASH MPD, HLS, ffconcat) rather than a media container. ffmpeg picks
 * its demuxer from the content, not the name, so "clip.mp4" holding a DASH manifest makes ffprobe and
 * ffmpeg open every file: URL it lists, -protocol_whitelist file or not: any local file, and on
 * Windows \\host\share paths, which authenticate to that SMB server. No container these players
 * open starts with text like that (security review 2026-11-19 #1). head: the file's first bytes.
 */
function looksLikePlaylist(head) {
  // An MP4/MOV box whose 32-bit size happens to start with white space, '<' or '#' is still a box.
  if (head.length >= 8 && /^(ftyp|mdat|moov|free|skip|wide|pnot|uuid)$/.test(head.toString('latin1', 4, 8))) return false;
  let p = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0; // UTF-8 BOM
  while (p < head.length && (head[p] === 0x20 || (head[p] >= 0x09 && head[p] <= 0x0d))) p++;
  if (p >= head.length) return head.length > 0; // nothing but white space: XML may follow
  const text = head.toString('latin1', p, p + 8);
  return /^<[?!A-Za-z]/.test(text) || text.startsWith('#EXT') || text.startsWith('ffconcat');
}

const PLAYLIST_HEAD = 4096;

/** looksLikePlaylist() for a file on disk (false when it can't be read: ffprobe reports that). */
async function isPlaylistFile(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const b = Buffer.alloc(PLAYLIST_HEAD);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    return looksLikePlaylist(b.subarray(0, bytesRead));
  } catch { return false; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Network protocols ffmpeg may use for a URL the user entered (Open Video URL…, src/urlsource.js):
 * http(s) and what it rides on (tcp, tls), crypto (AES-128 HLS segments) and httpproxy (https
 * through a proxy). Never `file`: a remote playlist or manifest can't make ffmpeg read local files
 * or UNC shares. Files never get these (security review 2026-11-19 #1; docs/notes/url-stream.md).
 */
const URL_PROTOCOLS = 'http,https,tcp,tls,crypto,httpproxy';
const URL_RW_TIMEOUT_US = 20000000;

/** A URL input: { url, proxy?, variant? } (from the user's input box only; variant: the HLS quality choice for probe); a file input is a path string. */
function isUrlInput(input) {
  return !!input && typeof input === 'object' && typeof input.url === 'string';
}

/**
 * The input part of an ffmpeg/ffprobe command line: `-protocol_whitelist file -i <path>` for a file;
 * for a URL input the network whitelist above, an I/O timeout and the proxy (http.proxy), only for
 * http(s) URLs.
 */
function inputArgs(input) {
  if (isUrlInput(input)) {
    if (!/^https?:\/\/[^\s]+$/i.test(input.url)) throw new Error('only http and https URLs can be opened');
    const args = ['-protocol_whitelist', URL_PROTOCOLS, '-rw_timeout', String(URL_RW_TIMEOUT_US)];
    if (input.proxy && /^https?:\/\/[^\s]+$/i.test(input.proxy)) args.push('-http_proxy', input.proxy);
    return [...args, '-i', input.url];
  }
  if (typeof input !== 'string') throw new Error('no input');
  return ['-protocol_whitelist', 'file', '-i', input];
}

/** Seconds the video stream starts after the format's start (0 when unknown, negative or over 2 s). */
function leadOf(v, format) {
  const d = Number(v && v.start_time) - Number(format && format.start_time);
  return d > 0 && d < 2 ? d : 0;
}

/** Dolby Vision configuration record ({ profile, compat }), null when the stream has none. */
function dolbyVision(s) {
  const d = (s.side_data_list || []).find((x) => x && /DOVI configuration/i.test(x.side_data_type || ''));
  return d && Number.isFinite(Number(d.dv_profile)) ? { profile: Number(d.dv_profile), compat: Number(d.dv_bl_signal_compatibility_id) || 0 } : null;
}

// ffprobe results per file (path, size, modification time) and ffprobe (path, build, size, time): opening
// the same file again, compare and a reload's re-open don't start ffprobe again. Copies go out (callers keep them).
const PROBE_CACHE_MAX = 32;
const probeCache = new Map(); // key -> result, oldest first
const toolStamps = new WeakMap();

/** The cache key for a local file, or null (a URL, or the file or ffprobe can't be found). */
async function probeKey(tools, input) {
  if (isUrlInput(input) || typeof input !== 'string' || !tools) return null;
  let stamp = tools.stamp || toolStamps.get(tools);
  if (stamp === undefined) {
    const f = await whichFile(tools.ffprobe);
    stamp = (f && await fileStamp(f)) || '';
    toolStamps.set(tools, stamp);
  }
  if (!stamp) return null;
  try {
    const st = await fs.promises.stat(input);
    if (!st.isFile()) return null;
    return [tools.ffprobe, tools.version, stamp, path.resolve(input), st.size, Math.round(st.mtimeMs)].join('|');
  } catch { return null; }
}

async function probe(tools, input, signal) {
  const key = await probeKey(tools, input);
  if (key && probeCache.has(key)) {
    const hit = probeCache.get(key);
    probeCache.delete(key); // most recently used last
    probeCache.set(key, hit);
    return structuredClone(hit);
  }
  const r = await probeRun(tools, input, signal);
  if (key) {
    probeCache.set(key, structuredClone(r));
    while (probeCache.size > PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value);
  }
  return r;
}

async function probeRun(tools, input, signal) {
  const url = isUrlInput(input);
  // Local files only: a playlist-like file (HLS, concat) must not make ffprobe fetch URLs.
  // And no manifests at all: they would still open other local (or UNC) files.
  if (!url && await isPlaylistFile(input)) throw new Error('the file is a text playlist or manifest (DASH, HLS, ffconcat), not a video: native ffmpeg is not used for it');
  const r = await run(tools.ffprobe, ['-v', 'error', ...inputArgs(input).slice(0, -2), '-print_format', 'json', '-show_format', '-show_streams', ...inputArgs(input).slice(-2)], url ? 60000 : 30000, signal);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.trim() || r.code}`);
  const j = JSON.parse(r.stdout);
  const streams = j.streams || [];
  const videos = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  // An HLS/DASH stream lists every variant: the one the quality choice names (input.variant, matched by the
  // HLS variant_bitrate tag), else the largest picture (ffmpeg then reads only that one).
  const want = url && input.variant && input.variant.bandwidth > 0 ? String(input.variant.bandwidth) : '';
  const ofVariant = (s) => !!want && !!s.tags && String(s.tags.variant_bitrate) === want;
  const largest = (list) => list.reduce((b, s) => (!b || (s.width || 0) * (s.height || 0) > (b.width || 0) * (b.height || 0) ? s : b), null);
  const v = url ? largest(videos.some(ofVariant) ? videos.filter(ofVariant) : videos) : videos[0];
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const a = audios.find(ofVariant) || (v && v.tags && v.tags.variant_bitrate !== undefined && audios.find((s) => s.tags && s.tags.variant_bitrate === v.tags.variant_bitrate)) || audios[0];
  const rate = (s) => {
    if (!s) return 0;
    for (const k of ['avg_frame_rate', 'r_frame_rate']) {
      const [n, d] = String(s[k] || '0/0').split('/').map(Number);
      if (n > 0 && d > 0 && n / d < 1000) return n / d;
    }
    return 0;
  };
  const duration = Number((j.format && j.format.duration) || (v && v.duration) || 0);
  const fps = rate(v) || 30;
  // Video bit rate (b/s): the stream's, else the file's minus the other streams' (MKV/WebM give none per stream).
  const num = (x) => (Number(x) > 0 ? Number(x) : 0);
  const others = streams.filter((s) => s !== v).reduce((n, s) => n + num(s.bit_rate), 0);
  const bitRate = v ? num(v.bit_rate) || Math.max(0, num(j.format && j.format.bit_rate) - others) : 0;
  return {
    duration,
    video: v ? {
      index: v.index, codec: v.codec_name, profile: v.profile || '', pixFmt: v.pix_fmt || '',
      width: v.width, height: v.height, fps, fieldOrder: v.field_order || '',
      frames: Number(v.nb_frames) || Math.round(duration * fps), bitRate,
      colorSpace: v.color_space || '', colorTransfer: v.color_transfer || '', colorPrimaries: v.color_primaries || '',
      // How much later the picture starts than the file (sound first, as in HLS/DASH without edit lists): a seek adds it (src/native.js launch).
      lead: leadOf(v, j.format),
      dv: dolbyVision(v),
    } : null,
    audio: a ? { index: a.index, codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) || 0, bitRate: num(a.bit_rate) } : null,
    counts: { audio: streams.filter((s) => s.codec_type === 'audio').length, sub: streams.filter((s) => s.codec_type === 'subtitle').length },
    format: j.format ? j.format.format_long_name || j.format.format_name : '',
    formatName: (j.format && j.format.format_name) || '',
  };
}

module.exports = { run, lowerPriority, locateTools, parseGpuFilters, TOOLS_CACHE_VER, probe, whichFile, toolsKey, probeCache, looksLikePlaylist, isPlaylistFile, inputArgs, isUrlInput, URL_PROTOCOLS };
