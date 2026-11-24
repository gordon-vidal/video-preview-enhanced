// @ts-check
// Seek-bar thumbnails for the native ffmpeg backend (media/thumbs.js asks via the
// engine's 'thumb' message). One short keyframe-only ffmpeg per thumbnail:
//   ffmpeg -skip_frame nokey -ss T -i FILE -frames:v 1 -vf scale=W:H -f rawvideo -pix_fmt rgba -
// (format 'jpeg': mjpeg -q:v 6, 3-6 KB instead of ~60 KB RGBA, which matters on a remote link's RPC pipe).
// An input-side -ss seeks to the keyframe at or before T and -skip_frame nokey
// makes the decoder drop everything else, so a long-GOP 4K file costs one
// keyframe decode (~50-200 ms of one core). ffmpeg only decodes (docs/PRODUCT.md).
// One at a time per player; the page asks for one at a time anyway.
'use strict';

const { spawn } = require('child_process');
const { lowerPriority } = require('./ffmpeg');

/** Fits a w x h picture into a box (even sizes, at least 2). */
function fitBox(w, h, bw, bh) {
  if (!(w > 0 && h > 0)) return { w: bw, h: bh };
  const s = Math.min(bw / w, bh / h, 1);
  const even = (x) => Math.max(2, 2 * Math.round((x * s) / 2));
  return { w: even(w), h: even(h) };
}

/** ffmpeg arguments for one thumbnail at `t` seconds (from the file's start). */
// -noaccurate_seek and passthrough timing: the keyframe before T has a time before the cut, and
// would otherwise be dropped (with every other frame skipped, nothing would come out).
function thumbArgs(file, t, w, h, legacy, stream = 'v:0', format = 'rgba') {
  // -threads 2 (decoder and filters): one keyframe needs no more, and ffmpeg's default (~40 threads on 8 cores)
  // next to playback made the desktop stutter (2026-11-20).
  return ['-hide_banner', '-loglevel', 'info', '-nostats', '-copyts', '-nostdin', '-noautorotate', '-skip_frame', 'nokey', '-noaccurate_seek',
    '-threads', '2', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-filter_threads', '1', '-map', `0:${stream}`, '-an', '-sn', '-dn',
    ...(legacy ? ['-vsync', '0'] : ['-fps_mode', 'passthrough']), '-frames:v', '1',
    '-vf', `scale=${w}:${h}:flags=bilinear,showinfo`,
    ...(format === 'jpeg' ? ['-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe']
      : ['-f', 'rawvideo', '-pix_fmt', 'rgba']), '-'];
}

/**
 * Decodes one thumbnail. Resolves {kt, w, h, data: Buffer (RGBA, or a JPEG file when format is 'jpeg')} or null.
 * @param {{ffmpeg: string, legacy?: boolean}} tools
 * @param {string} file
 * @param {{w: number, h: number, index?: number, lead?: number}} src video size (before rotation)
 * @param {number} t seconds from the start
 * @param {number} bw box width
 * @param {number} bh box height
 * @param {(m: string) => void} [log]
 * @param {AbortSignal} [signal]
 * @param {'rgba' | 'jpeg'} [format]
 */
function decodeThumb(tools, file, src, t, bw, bh, log, signal, format = 'rgba') {
  if (signal?.aborted) return Promise.resolve(null);
  const { w, h } = fitBox(src.w, src.h, bw, bh);
  const jpeg = format === 'jpeg';
  const want = jpeg ? 0 : w * h * 4;
  const MAX_JPEG = 256 * 1024;
  return new Promise((resolve) => {
    const proc = lowerPriority(spawn(tools.ffmpeg, thumbArgs(file, t + (src.lead || 0), w, h, tools.legacy, src.index, format), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    const parts = [];
    let got = 0;
    let err = '';
    let kt = null;
    // checkJs: start
    let settled = false;
    /** @param {{kt: number|null, w: number, h: number, data: Uint8Array} | null} result */
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
    const timer = setTimeout(cancel, 8000);
    signal?.addEventListener('abort', cancel, { once: true });
    // checkJs: end
    proc.stdout.on('data', (d) => {
      if (settled || (jpeg ? got >= MAX_JPEG : got >= want)) return;
      const part = jpeg ? d.subarray(0, MAX_JPEG - got) : d.subarray(0, want - got);
      parts.push(part);
      got += part.length;
    });
    proc.stderr.on('data', (d) => {
      if (settled) return;
      err = (err + d).slice(-8192);
      const match = err.match(/Parsed_showinfo_[^\r\n]*\bpts_time:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?=\s)/i);
      if (kt === null && match) kt = Number(match[1]);
    });
    proc.on('error', (e) => { if (log && !signal?.aborted) log(`thumb ffmpeg: ${e.message}`); finish(null); });
    proc.on('close', () => {
      if (settled) return;
      if (jpeg ? got < 4 || got >= MAX_JPEG || parts[0][0] !== 0xff || parts[0][1] !== 0xd8 : got < want) { if (log && err) log(`thumb at ${t.toFixed(2)} s: ${err.trim().slice(0, 300)}`); finish(null); return; }
      finish({ kt, w, h, data: jpeg ? Buffer.concat(parts, got) : Buffer.concat(parts, got).subarray(0, want) });
    });
  });
}

/** Shared request handling for the player and Compare. */
function nativeThumb(decoder, request, log, signal) {
  const v = decoder.pr?.video;
  const { t, w, h } = request;
  if (!v || !decoder.file || !Number.isFinite(t) ||
      !Number.isInteger(w) || w <= 0 || w > 160 || !Number.isInteger(h) || h <= 0 || h > 160) return null;
  const src = { w: v.sourceWidth || v.width, h: v.sourceHeight || v.height, index: v.index, lead: v.lead };
  return decodeThumb(decoder.tools, decoder.file, src, t, w, h, log, signal, 'jpeg').then((r) => {
    if (!r) return null;
    const rel = Number.isFinite(r.kt) && Number.isFinite(v.startTime) ? r.kt - v.startTime : null;
    return { w: r.w, h: r.h, data: new Uint8Array(r.data), fmt: 'jpeg', kt: r.kt, rel };
  });
}

module.exports = { decodeThumb, thumbArgs, fitBox, nativeThumb };
