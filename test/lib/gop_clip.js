'use strict';
// Long-GOP clips for seek-bar preview tests and benches (docs/notes/seek-preview.md): testsrc2 at 30 fps with
// B-frames and keyframes at 0 and 10 s only. Generated once into the temp folder (no LFS media).
//
//   const gop = require('../lib/gop_clip');
//   const file = gop.make();               // 12 s, 320x180 H.264; null without ffmpeg
//   gop.make({ size: '1920x1080' })        // bench sizes; codec 'hevc10' for HEVC Main10, 'mpeg2' for MPEG-PS (no index)
//   gop.frameOf(rgba, w, h, k, file)       // -> the reference frame index that best matches an RGBA picture near k
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fr = require('./frames');

const FPS = 30;

function make(o = {}) {
  const size = o.size || '320x180';
  const codec = o.codec || 'h264';
  const ffmpeg = o.ffmpeg || fr.ffTool(undefined, 'ffmpeg');
  const ext = codec === 'mpeg2' ? 'mpg' : 'mp4';
  const out = path.join(os.tmpdir(), `vpe-gop10-${codec}-${size}-v1.${ext}`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  const tmp = `${out}.${process.pid}.${ext}`;
  const enc = codec === 'hevc10'
    ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=300:min-keyint=300:scenecut=0:bframes=2:log-level=error', '-pix_fmt', 'yuv420p10le']
    : codec === 'mpeg2' ? ['-c:v', 'mpeg2video', '-g', '300', '-bf', '2', '-q:v', '4']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p'];
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${FPS}`, '-t', '12', ...enc, tmp], { windowsHide: true });
  if (r.status !== 0) return null;
  try { fs.renameSync(tmp, out); } catch { /* another process made it */ }
  return out;
}

/** An RGBA picture as 64x36 luma, matched against ffmpeg's decode of `file` near frame k: the frame index. */
async function frameOf(rgba, w, h, k, file) {
  const refs = await fr.refFrames(file);
  const y = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) y[i] = Math.round(0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2]);
  return fr.match(fr.thumbOfPlane(y, w, h, w), refs, k, FPS).slot;
}

module.exports = { make, frameOf, FPS };
