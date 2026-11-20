'use strict';
// Short clips that check the listing's claim: H.264 plays on the GPU decoder (WebCodecs) in every
// container we detect, and VP8 in WebM. Remuxed (no re-encode) from h264_aac_anim_1080p.mp4, so they
// carry the same licence (Big Buck Bunny, CC BY; see LICENSES.md). VP8 is encoded from it.
//
//   node test/media/make_containers.js [ffmpeg.exe]

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ff = process.argv[2] || process.env.VPE_FFMPEG || 'ffmpeg';
const dir = path.join(__dirname, 'containers');
const src = path.join(__dirname, 'h264_aac_anim_1080p.mp4');
fs.mkdirSync(dir, { recursive: true });

const jobs = [
  // name, extra args (after -i), what it checks
  ['h264_aac.mkv', ['-c', 'copy']],
  ['h264_aac.mov', ['-c', 'copy']],
  ['h264_aac.m2ts', ['-c', 'copy', '-f', 'mpegts', '-mpegts_m2ts_mode', '1']],
  ['h264_aac.flv', ['-c', 'copy']],
  ['h264_aac.avi', ['-c', 'copy']],
  ['vp8_vorbis.webm', ['-c:v', 'libvpx', '-b:v', '2M', '-vf', 'scale=1280:-2', '-c:a', 'libvorbis']],
];

for (const [name, args] of jobs) {
  const out = path.join(dir, name);
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-t', '3', '-i', src, ...args, out], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`failed: ${name}`); process.exitCode = 1; continue; }
  console.log(`${name} ${Math.round(fs.statSync(out).size / 1024)} KB`);
}
