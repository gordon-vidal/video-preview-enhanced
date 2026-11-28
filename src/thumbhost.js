// @ts-check
// Seek-bar thumbnails for native ffmpeg and Live transcode clips (media/thumbs.js asks via the engine's 'thumb'
// message). One short ffmpeg per request on the source file, never the running stream, in one of these modes:
// - 'key': the keyframe at or before T (-skip_frame nokey, -noaccurate_seek): one keyframe decode (~50-200 ms of
//   one core even for long-GOP 4K);
// - 'near': the same plus the next keyframe (two frames), so the page can show the closer one and learns the GOP;
// - 'exact': the frame at T, decoded cheaply from the keyframe (-skip_frame noref -skip_loop_filter all -flags2
//   fast, fast_bilinear). skip_frame bidir gives wrong pictures (B-frames can be references);
// - 'run' (background pass): the next RUN_KEYS keyframes from T in one process, when keyframes are few per slot;
// - 'sweep' (background fill): decodes from the keyframe before T on and keeps the first frame at or after each of
//   T, T + step, ... before `to` (one picture per slot, select filter).
// Background sweeps decode on the GPU when one is known (hwaccel.previewMethods): a whole 2 min 4K HEVC file costs
// about 1 s of CPU there instead of 53 s. Hover pictures and runs stay software: GPU start-up costs about as much as
// one picture or 8 keyframes (docs/notes/seek-preview.md). A method that fails falls back to software in the same
// request and is not tried again for that codec and depth while this ffmpeg is in use.
// Background requests (`pass`) decode with one thread instead of two and report their CPU time (-benchmark).
// The page always gets JPEG (3-6 KB instead of ~60 KB RGBA, which matters on a remote link's RPC pipe) plus each
// picture's time read from showinfo. decodeThumb's 'rgba' format remains for tests and benches.
// One at a time per player; the page asks for one at a time anyway. ffmpeg only decodes (docs/PRODUCT.md).
'use strict';

const { spawn } = require('child_process');
const { lowerPriority } = require('./ffmpeg');
const hwaccel = require('./hwaccel');

const MAX_JPEG = 25 * 1024;
const RUN_KEYS = 8;
const SWEEP_MAX = 240;
// CPU of a GPU ffmpeg's device start that -benchmark does not count (measured: d3d12va 0.2-0.25 s, cuda 0.15-0.2 s).
const GPU_START_CPU_MS = 200;
// -hwaccel_output_format per method: the decoded surfaces stay on the GPU until the kept frames are downloaded.
const SURFACE = { d3d12va: 'd3d12', d3d11va: 'd3d11', cuda: 'cuda', vaapi: 'vaapi', videotoolbox: 'videotoolbox_vld' };
/** @type {WeakMap<object, Set<string>>} per ffmpeg tools: 'method|codec|depth' that failed */
const failedGpu = new WeakMap();

/** Fits a w x h picture into a box (even sizes, at least 2). */
function fitBox(w, h, bw, bh) {
  if (!(w > 0 && h > 0)) return { w: bw, h: bh };
  const s = Math.min(bw / w, bh / h, 1);
  const even = (x) => Math.max(2, 2 * Math.round((x * s) / 2));
  return { w: even(w), h: even(h) };
}

/**
 * ffmpeg arguments for one thumbnail at `t` seconds (from the file's start).
 * @param {string} file @param {number} t @param {number} w @param {number} h @param {boolean} [legacy]
 * @param {string} [stream] @param {'rgba' | 'jpeg'} [format] @param {'key' | 'near' | 'exact' | 'run' | 'sweep'} [mode]
 * @param {{pass?: boolean, from?: number, step?: number, count?: number,
 *   hw?: {method: string, depth: number, scaleCuda?: boolean}}} [opts] sweep: the first picture's time as the filters
 *   see it (-copyts: the file's), the step and the number of pictures; hw: decode a sweep on the GPU
 */
function thumbArgs(file, t, w, h, legacy, stream = 'v:0', format = 'rgba', mode = 'key', opts = {}) {
  const sweep = mode === 'sweep';
  const exact = mode === 'exact' || sweep;
  const hw = sweep && opts.hw && SURFACE[opts.hw.method] ? opts.hw : null;
  // Key modes: -noaccurate_seek and passthrough timing, because the keyframe before T has a time before the cut and
  // would otherwise be dropped (with every other frame skipped, nothing would come out).
  // -threads 2 (decoder and filters): ffmpeg's default (~40 threads on 8 cores) next to playback made the desktop
  // stutter (2026-11-20).
  // GPU: the skip flags do not apply; the kept frames are selected before the download, so only they are copied.
  const decode = hw ? ['-hwaccel', hw.method, '-hwaccel_output_format', SURFACE[hw.method]]
    : exact ? ['-skip_frame', 'noref', '-skip_loop_filter', 'all', '-flags2', 'fast']
      : ['-skip_frame', 'nokey', '-noaccurate_seek'];
  const shrink = hw && hw.scaleCuda ? [`scale_cuda=${w}:${h}:format=nv12`, 'hwdownload', 'format=nv12']
    : [...(hw ? ['hwdownload', `format=${hw.depth > 8 ? 'p010le' : 'nv12'}`] : []), `scale=${w}:${h}:flags=${exact ? 'fast_bilinear' : 'bilinear'}`];
  const vf = [...(sweep ? [sweepSelect(opts.from || 0, opts.step || 1)] : []), ...shrink, 'showinfo'].join(',');
  return ['-hide_banner', '-loglevel', 'info', '-nostats', ...(opts.pass ? ['-benchmark'] : []), '-copyts', '-nostdin', '-noautorotate', ...decode,
    '-threads', opts.pass ? '1' : '2', '-ss', Math.max(0, sweep ? t - 0.01 : t).toFixed(3), '-protocol_whitelist', 'file', '-i', file, '-filter_threads', '1', '-map', `0:${stream}`, '-an', '-sn', '-dn',
    ...(legacy ? ['-vsync', '0'] : ['-fps_mode', 'passthrough']), '-frames:v', String(frameCount(mode, opts)),
    '-vf', vf,
    ...(format === 'jpeg' ? ['-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe']
      : ['-f', 'rawvideo', '-pix_fmt', 'rgba']), '-'];
}

/** @param {string} mode @param {{count?: number}} [opts] */
function frameCount(mode, opts = {}) {
  if (mode === 'sweep') return Math.max(1, Math.min(SWEEP_MAX, Math.floor(opts.count || 1)));
  return mode === 'run' ? RUN_KEYS : mode === 'near' ? 2 : 1;
}

/** The first frame at or after a (1 ms early, for rounding), then the first one in each later step. */
function sweepSelect(from, step) {
  const a = (from - 0.001).toFixed(6);
  const s = step.toFixed(6);
  return `select='gte(t,${a})*(isnan(prev_selected_t)+gte(floor((t-${a})/${s}),floor((prev_selected_t-${a})/${s})+1))'`;
}

/** Splits ffmpeg's output into pictures: JPEG files (SOI ... EOI) or RGBA frames of `size` bytes. */
function splitPictures(buf, jpeg, size) {
  const out = [];
  if (!jpeg) {
    for (let at = 0; at + size <= buf.length; at += size) out.push(buf.subarray(at, at + size));
    return out;
  }
  let at = 0;
  while (at + 4 <= buf.length && buf[at] === 0xff && buf[at + 1] === 0xd8) {
    // Entropy-coded data stuffs every 0xff, so the first EOI marker ends the picture.
    let end = -1;
    for (let i = at + 2; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { end = i + 2; break; }
    if (end < 0 || end - at > MAX_JPEG) break;
    out.push(buf.subarray(at, end));
    at = end;
  }
  return out;
}

/**
 * Decodes one thumbnail. Resolves {kt, w, h, data: Buffer (RGBA, or a JPEG file when format is 'jpeg'), cpu?} or
 * null; kt is the picture's time (the keyframe's in the key modes), cpu the ms of CPU ffmpeg reported (pass requests).
 * Mode 'near' adds `next`: {kt, data} of the following keyframe when there is one; modes 'run' and 'sweep' add `more`:
 * [{kt, data}] of the following pictures and `end` (ffmpeg reached the end of the file before all of them). A GPU
 * sweep (opts.hw) that gave no picture resolves {failed: reason} instead of null.
 * @param {{ffmpeg: string, legacy?: boolean}} tools
 * @param {string} file
 * @param {{w: number, h: number, index?: number, lead?: number, start?: number}} src video size (before rotation);
 *   start: the picture's first time (what -copyts frame times count from)
 * @param {number} t seconds from the start
 * @param {number} bw box width
 * @param {number} bh box height
 * @param {(m: string) => void} [log]
 * @param {AbortSignal} [signal]
 * @param {'rgba' | 'jpeg'} [format]
 * @param {'key' | 'near' | 'exact' | 'run' | 'sweep'} [mode]
 * @param {{pass?: boolean, step?: number, count?: number, hw?: {method: string, depth: number, scaleCuda?: boolean}}} [opts]
 */
function decodeThumb(tools, file, src, t, bw, bh, log, signal, format = 'rgba', mode = 'key', opts = {}) {
  if (signal?.aborted) return Promise.resolve(null);
  const { w, h } = fitBox(src.w, src.h, bw, bh);
  const jpeg = format === 'jpeg';
  const count = frameCount(mode, opts);
  const args = mode === 'sweep' ? { ...opts, from: t + (src.start || 0) } : opts;
  const max = jpeg ? count * MAX_JPEG : count * w * h * 4;
  return new Promise((resolve) => {
    const proc = lowerPriority(spawn(tools.ffmpeg, thumbArgs(file, t + (src.lead || 0), w, h, tools.legacy, src.index, format, mode, args), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    const parts = [];
    let got = 0;
    let err = '';
    /** @type {number[]} */
    const times = [];
    // checkJs: start
    let settled = false;
    /** @param {any} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      parts.length = 0;
      resolve(result);
    };
    const cancel = () => {
      if (settled) return;
      // A replaced page can release its job before the child emits close.
      finish(null);
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
    };
    const timer = setTimeout(() => {
      if (opts.hw) finish({ failed: 'timed out' });
      cancel();
    }, mode === 'sweep' ? 30e3 : mode === 'run' ? 20e3 : 8000);
    signal?.addEventListener('abort', cancel, { once: true });
    // checkJs: end
    proc.stdout.on('data', (d) => {
      if (settled || got > max) return;
      // Keep one overflow byte so an oversized picture cannot be mistaken for a complete one.
      const part = d.subarray(0, max + 1 - got);
      parts.push(part);
      got += part.length;
    });
    proc.stderr.on('data', (d) => {
      if (settled) return;
      err = (err + d).slice(-8192);
      // showinfo prints one line per frame that reached the filter, numbered from 0.
      const re = /Parsed_showinfo_[^\r\n]*\bn:\s*(\d+)[^\r\n]*\bpts_time:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?=\s)/gi;
      for (let m = re.exec(err); m; m = re.exec(err)) {
        const n = Number(m[1]);
        if (n === times.length && n < count) times.push(Number(m[2]));
      }
    });
    proc.on('error', (e) => {
      if (log && !signal?.aborted) log(`thumb ffmpeg: ${e.message}`);
      finish(opts.hw ? { failed: e.message } : null);
    });
    proc.on('close', () => {
      if (settled) return;
      const pics = got > max ? [] : splitPictures(Buffer.concat(parts, got), jpeg, w * h * 4);
      if (!pics.length) {
        if (opts.hw) { finish({ failed: hwaccel.fallbackReason(err) || err.trim().split(/\r?\n/).pop() || 'no picture' }); return; }
        if (log && err) log(`thumb at ${t.toFixed(2)} s: ${err.trim().slice(0, 300)}`);
        finish(null);
        return;
      }
      const kt = Number.isFinite(times[0]) ? times[0] : null;
      const b = /bench: utime=([\d.]+)s stime=([\d.]+)s/.exec(err);
      const cpu = b ? { cpu: Math.round((Number(b[1]) + Number(b[2])) * 1000 + (opts.hw ? GPU_START_CPU_MS : 0)) } : {};
      if (mode === 'run' || mode === 'sweep') {
        const more = [];
        for (let i = 1; i < pics.length && Number.isFinite(times[i]); i++) more.push({ kt: times[i], data: Buffer.from(pics[i]) });
        finish({ kt, w, h, data: Buffer.from(pics[0]), more, end: pics.length < count, ...cpu });
        return;
      }
      const next = pics[1] && Number.isFinite(times[1]) ? { kt: times[1], data: Buffer.from(pics[1]) } : undefined;
      finish({ kt, w, h, data: Buffer.from(pics[0]), ...(next ? { next } : {}), ...cpu });
    });
  });
}

/**
 * Shared request handling for the player and Compare. hw: the machine's GPUs (hardware.detect()'s shape) when GPU
 * decoding is on, else null; only background sweeps use them.
 */
function nativeThumb(decoder, request, log, signal, hw = null) {
  const v = decoder.pr?.video;
  const { t, w, h } = request;
  const mode = ['near', 'exact', 'run', 'sweep'].includes(request.mode) ? request.mode : 'key';
  const { step, to } = request;
  if (!v || !decoder.file || !Number.isFinite(t) ||
      !Number.isInteger(w) || w <= 0 || w > 160 || !Number.isInteger(h) || h <= 0 || h > 160) return null;
  if (mode === 'sweep' && !(Number.isFinite(step) && step > 0 && Number.isFinite(to) && to > t)) return null;
  const src = { w: v.sourceWidth || v.width, h: v.sourceHeight || v.height, index: v.index, lead: v.lead,
    start: Number.isFinite(v.startTime) ? v.startTime : 0 };
  const rel = (kt) => (Number.isFinite(kt) && Number.isFinite(v.startTime) ? kt - v.startTime : null);
  const opts = { pass: !!request.pass, ...(mode === 'sweep' ? { step, count: Math.ceil((to - t) / step - 1e-9) } : {}) };
  return decodeWith(decoder, v, src, rel, request, mode, opts, log, signal, hw);
}

/** nativeThumb's decode: on the GPU first for a background sweep, in software otherwise or after a GPU failure. */
async function decodeWith(decoder, v, src, rel, { t, w, h }, mode, opts, log, signal, hw) {
  const tools = decoder.tools;
  const depth = hwaccel.depthOf(v.pixFmt, v.codec);
  const keyOf = (m) => `${m}|${v.codec || ''}|${depth}`;
  const method = mode === 'sweep' && opts.pass
    ? hwaccel.previewMethods(hw).find((m) => !failedGpu.get(tools)?.has(keyOf(m))) : undefined;
  const decode = (o) => decodeThumb(tools, decoder.file, src, t, w, h, log, signal, 'jpeg', mode, o);
  let r = null;
  if (method) {
    r = await decode({ ...opts, hw: { method, depth, scaleCuda: method === 'cuda' && !!tools.gpuFilters?.has('scale_cuda') } });
    if (r && r.failed) {
      const why = r.failed;
      r = await decode(opts);
      // Software found pictures where the GPU found none: the method does not work here (not an empty stretch).
      if (r) {
        if (!failedGpu.has(tools)) failedGpu.set(tools, new Set());
        failedGpu.get(tools)?.add(keyOf(method));
        if (log) log(`seek-bar previews: GPU decoding with ${method} failed (${why}); software for ${v.codec || 'this codec'} from now on`);
      }
    } else if (r) r.gpu = method;
  } else r = await decode(opts);
  if (!r) return null;
  const extra = { ...(Number.isFinite(r.cpu) ? { cpu: r.cpu } : {}), ...(r.gpu ? { gpu: r.gpu } : {}) };
  if (mode === 'run' || mode === 'sweep') {
    const more = r.more.map((x) => ({ kt: x.kt, rel: rel(x.kt), data: new Uint8Array(x.data) }));
    return { w: r.w, h: r.h, data: new Uint8Array(r.data), fmt: 'jpeg', kt: r.kt, rel: rel(r.kt), more, end: r.end, ...extra };
  }
  const next = r.next ? { kt: r.next.kt, rel: rel(r.next.kt), data: new Uint8Array(r.next.data) } : undefined;
  // 'near' without a second picture: ffmpeg read to the end and found no keyframe after.
  const last = mode === 'near' && !next ? { kn: null } : {};
  return { w: r.w, h: r.h, data: new Uint8Array(r.data), fmt: 'jpeg', kt: r.kt, rel: rel(r.kt), ...(next ? { next } : last), ...extra };
}

module.exports = { decodeThumb, thumbArgs, fitBox, nativeThumb };
