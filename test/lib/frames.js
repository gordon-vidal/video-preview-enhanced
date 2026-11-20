'use strict';
// ffmpeg's decode of a file as small luma pictures, to check that a player shows frame k of the file
// (not just a counter that says k). Shared by layer 2 (test/engine) and layer 3 (test/vscode/lib.js).
//
//   const fr = require('../lib/frames');
//   const refs = await fr.refFrames(file);          // every frame as 64x36 luma (Buffer), .t = its time
//   fr.match(thumb, refs, k, fps)                    // -> { slot, score }: the best-matching frame near k
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const THUMB_W = 64;
const THUMB_H = 36;

function ffTool(ffmpeg, tool) {
  const ff = ffmpeg || process.env.VPE_FFMPEG || 'ffmpeg';
  return tool === 'ffmpeg' ? ff : ff.replace(/ffmpeg(\.exe)?$/i, `${tool}$1`);
}

function collect(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { resolve(null); return; }
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks) : null));
  });
}

/** Presentation times of the first video stream's frames in output order (ffprobe), or null. */
async function frameTimes(file, ffmpeg) {
  const b = await collect(ffTool(ffmpeg, 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file]);
  return b ? b.toString().split(/\r?\n/).filter((l) => l.trim()).map((l) => { const v = parseFloat(l); return Number.isFinite(v) ? v : null; }) : null;
}

// Parallel test processes decode the same files: the pictures are cached on disk by file, size and time.
const CACHE = path.join(os.tmpdir(), 'vpe-ref-frames');
const cacheKey = (file, raw) => { const st = fs.statSync(file); return crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}|${THUMB_W}x${THUMB_H}${raw ? '|raw' : ''}`).digest('hex').slice(0, 20); };

const memo = new Map();
/**
 * All frames of a file as 64x36 luma (area-averaged), decoded by ffmpeg; each has .t (its time) when known.
 * Null without ffmpeg. o.raw: as stored, not turned by the file's rotation (what the decoder hands the
 * renderer; the player turns it on the GPU).
 */
function refFrames(file, ffmpeg, o = {}) {
  file = path.resolve(file);
  const mkey = `${file}|${!!o.raw}`;
  if (memo.has(mkey)) return memo.get(mkey);
  const p = (async () => {
    const key = cacheKey(file, o.raw);
    const bin = path.join(CACHE, `${key}.y`);
    const meta = path.join(CACHE, `${key}.json`);
    let buf = null;
    let ts = null;
    try { buf = fs.readFileSync(bin); ts = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { buf = null; }
    if (!buf) {
      buf = await collect(ffTool(ffmpeg, 'ffmpeg'), ['-v', 'error', ...(o.raw ? ['-noautorotate'] : []), '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', `scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray`, '-f', 'rawvideo', '-']);
      if (!buf) return null;
      ts = await frameTimes(file, ffmpeg);
      try {
        fs.mkdirSync(CACHE, { recursive: true });
        const tmp = `${bin}.${process.pid}`;
        fs.writeFileSync(tmp, buf);
        fs.writeFileSync(`${meta}.${process.pid}`, JSON.stringify(ts));
        fs.renameSync(`${meta}.${process.pid}`, meta);
        fs.renameSync(tmp, bin);
      } catch { /* another process wrote it */ }
    }
    const sz = THUMB_W * THUMB_H;
    const frames = [];
    for (let i = 0; i + sz <= buf.length; i += sz) frames.push(buf.subarray(i, i + sz));
    frames.forEach((f, i) => { f.t = ts && ts.length === frames.length ? ts[i] : null; });
    return frames;
  })();
  memo.set(mkey, p);
  return p;
}

/** Frame slot of each reference picture at `fps` (picture i sits at slot i unless the file leaves slots empty). */
function refSlots(refs, fps) {
  const t0 = refs.length ? refs[0].t : null;
  return refs.map((f, i) => (fps > 0 && t0 !== null && t0 !== undefined && f.t !== null && f.t !== undefined ? Math.round((f.t - t0) * fps) : i));
}

/** Normalised cross-correlation of two luma thumbnails. */
function ncc(a, b) {
  const n = a.length;
  let ma = 0; let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma; const y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** The reference picture (searched within k±15) that best matches `y`, as its slot at `fps`, and the score. */
function match(y, refs, k, fps) {
  const slots = refSlots(refs, fps || 30);
  const lo = Math.max(0, k - 15); const hi = Math.min(refs.length - 1, k + 15);
  let best = -1; let bs = -2;
  for (let i = lo; i <= hi; i++) { const s = ncc(y, refs[i]); if (s > bs) { bs = s; best = i; } }
  return { slot: best >= 0 ? slots[best] : null, score: bs };
}

/**
 * A plane (8- or 16-bit samples, `stride` in samples) area-averaged to 64x36, 8-bit, as ffmpeg's
 * scale=64:36:flags=area does (close enough for the correlation: the match is by best score).
 */
function thumbOfPlane(data, width, height, stride, deep) {
  const out = Buffer.alloc(THUMB_W * THUMB_H);
  const shift = deep ? (deep === true ? 2 : deep - 8) : 0;
  for (let ty = 0; ty < THUMB_H; ty++) {
    const y0 = Math.floor((ty * height) / THUMB_H); const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / THUMB_H));
    for (let tx = 0; tx < THUMB_W; tx++) {
      const x0 = Math.floor((tx * width) / THUMB_W); const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / THUMB_W));
      let sum = 0; let n = 0;
      for (let y = y0; y < y1; y++) { const row = y * stride; for (let x = x0; x < x1; x++) { sum += data[row + x]; n++; } }
      out[ty * THUMB_W + tx] = Math.min(255, Math.round(sum / n) >> shift);
    }
  }
  return out;
}

/** Makes the reference frames of the generated clips the engine tests use (one process, before the parallel run). */
function prepare() { /* references are cached on first use; nothing to do ahead */ }

module.exports = { THUMB_W, THUMB_H, ffTool, frameTimes, refFrames, refSlots, ncc, match, thumbOfPlane, prepare };
