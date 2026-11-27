// @ts-check
// Seek-bar thumbnails for native ffmpeg and Live transcode clips (media/thumbs.js asks via the engine's 'thumb'
// message). One short ffmpeg per picture on the source file, never the running stream, in one of three modes:
// - 'key': the keyframe at or before T (-skip_frame nokey, -noaccurate_seek): one keyframe decode (~50-200 ms of
//   one core even for long-GOP 4K);
// - 'near': the same plus the next keyframe (two frames), so the page can show the closer one and learns the GOP;
// - 'exact': the frame at T, decoded cheaply from the keyframe (-skip_frame noref -skip_loop_filter all -flags2
//   fast, fast_bilinear). skip_frame bidir gives wrong pictures (B-frames can be references) and -hwaccel does not
//   pay off for one picture (docs/notes/seek-preview.md, measurements);
// - 'run' (background pass): the next RUN_KEYS keyframes from T in one process, when keyframes are few per slot.
// Background pass requests (`pass`) decode with one thread instead of two.
// The page always gets JPEG (3-6 KB instead of ~60 KB RGBA, which matters on a remote link's RPC pipe) plus each
// picture's time read from showinfo. decodeThumb's 'rgba' format remains for tests and benches.
// One at a time per player; the page asks for one at a time anyway. ffmpeg only decodes (docs/PRODUCT.md).
'use strict';

const { spawn } = require('child_process');
const { lowerPriority } = require('./ffmpeg');

const MAX_JPEG = 25 * 1024;
const RUN_KEYS = 8;

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
 * @param {string} [stream] @param {'rgba' | 'jpeg'} [format] @param {'key' | 'near' | 'exact' | 'run'} [mode]
 * @param {{pass?: boolean}} [opts]
 */
function thumbArgs(file, t, w, h, legacy, stream = 'v:0', format = 'rgba', mode = 'key', opts = {}) {
  const exact = mode === 'exact';
  // Key modes: -noaccurate_seek and passthrough timing, because the keyframe before T has a time before the cut and
  // would otherwise be dropped (with every other frame skipped, nothing would come out).
  // -threads 2 (decoder and filters): ffmpeg's default (~40 threads on 8 cores) next to playback made the desktop
  // stutter (2026-11-20).
  const decode = exact
    ? ['-skip_frame', 'noref', '-skip_loop_filter', 'all', '-flags2', 'fast']
    : ['-skip_frame', 'nokey', '-noaccurate_seek'];
  return ['-hide_banner', '-loglevel', 'info', '-nostats', '-copyts', '-nostdin', '-noautorotate', ...decode,
    '-threads', opts.pass ? '1' : '2', '-ss', Math.max(0, t).toFixed(3), '-protocol_whitelist', 'file', '-i', file, '-filter_threads', '1', '-map', `0:${stream}`, '-an', '-sn', '-dn',
    ...(legacy ? ['-vsync', '0'] : ['-fps_mode', 'passthrough']), '-frames:v', String(frameCount(mode)),
    '-vf', `scale=${w}:${h}:flags=${exact ? 'fast_bilinear' : 'bilinear'},showinfo`,
    ...(format === 'jpeg' ? ['-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe']
      : ['-f', 'rawvideo', '-pix_fmt', 'rgba']), '-'];
}

/** @param {string} mode */
function frameCount(mode) { return mode === 'run' ? RUN_KEYS : mode === 'near' ? 2 : 1; }

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
 * Decodes one thumbnail. Resolves {kt, w, h, data: Buffer (RGBA, or a JPEG file when format is 'jpeg')} or null;
 * kt is the picture's time (the keyframe's in the key modes). Mode 'near' adds `next`: {kt, data} of the following
 * keyframe when there is one; mode 'run' adds `more`: [{kt, data}] of the following keyframes and `end` (ffmpeg
 * reached the end of the file before RUN_KEYS).
 * @param {{ffmpeg: string, legacy?: boolean}} tools
 * @param {string} file
 * @param {{w: number, h: number, index?: number, lead?: number}} src video size (before rotation)
 * @param {number} t seconds from the start
 * @param {number} bw box width
 * @param {number} bh box height
 * @param {(m: string) => void} [log]
 * @param {AbortSignal} [signal]
 * @param {'rgba' | 'jpeg'} [format]
 * @param {'key' | 'near' | 'exact' | 'run'} [mode]
 * @param {{pass?: boolean}} [opts]
 */
function decodeThumb(tools, file, src, t, bw, bh, log, signal, format = 'rgba', mode = 'key', opts = {}) {
  if (signal?.aborted) return Promise.resolve(null);
  const { w, h } = fitBox(src.w, src.h, bw, bh);
  const jpeg = format === 'jpeg';
  const count = frameCount(mode);
  const max = jpeg ? count * MAX_JPEG : count * w * h * 4;
  return new Promise((resolve) => {
    const proc = lowerPriority(spawn(tools.ffmpeg, thumbArgs(file, t + (src.lead || 0), w, h, tools.legacy, src.index, format, mode, opts), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
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
    const timer = setTimeout(cancel, mode === 'run' ? 20e3 : 8000);
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
    proc.on('error', (e) => { if (log && !signal?.aborted) log(`thumb ffmpeg: ${e.message}`); finish(null); });
    proc.on('close', () => {
      if (settled) return;
      const pics = got > max ? [] : splitPictures(Buffer.concat(parts, got), jpeg, w * h * 4);
      if (!pics.length) { if (log && err) log(`thumb at ${t.toFixed(2)} s: ${err.trim().slice(0, 300)}`); finish(null); return; }
      const kt = Number.isFinite(times[0]) ? times[0] : null;
      if (mode === 'run') {
        const more = [];
        for (let i = 1; i < pics.length && Number.isFinite(times[i]); i++) more.push({ kt: times[i], data: Buffer.from(pics[i]) });
        finish({ kt, w, h, data: Buffer.from(pics[0]), more, end: pics.length < count });
        return;
      }
      const next = pics[1] && Number.isFinite(times[1]) ? { kt: times[1], data: Buffer.from(pics[1]) } : undefined;
      finish({ kt, w, h, data: Buffer.from(pics[0]), ...(next ? { next } : {}) });
    });
  });
}

/** Shared request handling for the player and Compare. */
function nativeThumb(decoder, request, log, signal) {
  const v = decoder.pr?.video;
  const { t, w, h } = request;
  const mode = ['near', 'exact', 'run'].includes(request.mode) ? request.mode : 'key';
  if (!v || !decoder.file || !Number.isFinite(t) ||
      !Number.isInteger(w) || w <= 0 || w > 160 || !Number.isInteger(h) || h <= 0 || h > 160) return null;
  const src = { w: v.sourceWidth || v.width, h: v.sourceHeight || v.height, index: v.index, lead: v.lead };
  const rel = (kt) => (Number.isFinite(kt) && Number.isFinite(v.startTime) ? kt - v.startTime : null);
  return decodeThumb(decoder.tools, decoder.file, src, t, w, h, log, signal, 'jpeg', mode, { pass: !!request.pass }).then((r) => {
    if (!r) return null;
    if (mode === 'run') {
      const more = r.more.map((x) => ({ kt: x.kt, rel: rel(x.kt), data: new Uint8Array(x.data) }));
      return { w: r.w, h: r.h, data: new Uint8Array(r.data), fmt: 'jpeg', kt: r.kt, rel: rel(r.kt), more, end: r.end };
    }
    const next = r.next ? { kt: r.next.kt, rel: rel(r.next.kt), data: new Uint8Array(r.next.data) } : undefined;
    // 'near' without a second picture: ffmpeg read to the end and found no keyframe after.
    const last = mode === 'near' && !next ? { kn: null } : {};
    return { w: r.w, h: r.h, data: new Uint8Array(r.data), fmt: 'jpeg', kt: r.kt, rel: rel(r.kt), ...(next ? { next } : last) };
  });
}

module.exports = { decodeThumb, thumbArgs, fitBox, nativeThumb };
