// @ts-check
// Seek-bar thumbnails for the native ffmpeg backend (media/thumbs.js asks via the
// engine's 'thumb' message). One short keyframe-only ffmpeg per thumbnail:
//   ffmpeg -skip_frame nokey -ss T -i FILE -frames:v 1 -vf scale=W:H -f rawvideo -pix_fmt rgba -
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
function thumbArgs(file, t, w, h, legacy) {
  // -threads 2 (decoder and filters): one keyframe needs no more, and ffmpeg's default (~40 threads on 8 cores)
  // next to playback made the desktop stutter (2026-11-20).
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-noautorotate', '-skip_frame', 'nokey', '-noaccurate_seek',
    '-threads', '2', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-filter_threads', '1', '-map', '0:v:0', '-an', '-sn', '-dn',
    ...(legacy ? ['-vsync', '0'] : ['-fps_mode', 'passthrough']), '-frames:v', '1',
    '-vf', `scale=${w}:${h}:flags=bilinear`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
}

/**
 * Decodes one thumbnail. Resolves {w, h, data: Buffer (RGBA)} or null.
 * @param {{ffmpeg: string, legacy?: boolean}} tools
 * @param {string} file
 * @param {{w: number, h: number}} src video size (before rotation)
 * @param {number} t seconds from the start
 * @param {number} bw box width
 * @param {number} bh box height
 * @param {(m: string) => void} [log]
 */
function decodeThumb(tools, file, src, t, bw, bh, log) {
  const { w, h } = fitBox(src.w, src.h, bw, bh);
  const want = w * h * 4;
  return new Promise((resolve) => {
    const proc = lowerPriority(spawn(tools.ffmpeg, thumbArgs(file, t, w, h, tools.legacy), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    const parts = [];
    let got = 0;
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 8000);
    proc.stdout.on('data', (d) => { parts.push(d); got += d.length; });
    proc.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    proc.on('error', (e) => { clearTimeout(timer); if (log) log(`thumb ffmpeg: ${e.message}`); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      if (got < want) { if (log && err) log(`thumb at ${t.toFixed(2)} s: ${err.trim().slice(0, 300)}`); resolve(null); return; }
      resolve({ w, h, data: Buffer.concat(parts, got).subarray(0, want) });
    });
  });
}

module.exports = { decodeThumb, thumbArgs, fitBox };
