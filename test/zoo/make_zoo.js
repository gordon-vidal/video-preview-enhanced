'use strict';
// node test/zoo/make_zoo.js <datadir> [--big]
// Generates the codec/container "zoo" with ffmpeg lavfi (testsrc2 + sine).
// Writes <datadir>/manifest.json describing each file and what to expect.
// --big also makes a >2 GB H.264 MKV (stream-copied loop); skipped otherwise.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.resolve(process.argv[2] || path.join(__dirname, 'data'));
const big = process.argv.includes('--big');
fs.mkdirSync(dir, { recursive: true });

const D = 6;
const src = (size = '640x360', rate = 30, dur = D) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${dur}`];
const sine = (dur = D, extra = '') => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${dur}${extra}`];
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];

// expect: ok | noVideo | probeFail | partial ; audio: whether the source has audio
const files = [
  { name: 'h264_aac.mp4', args: [...src(), ...sine(), ...X264, '-c:a', 'aac'] },
  { name: 'h264_noaudio.mp4', args: [...src(), ...X264, '-an'], audio: false },
  { name: 'h264_aac.mkv', args: [...src(), ...sine(), ...X264, '-c:a', 'aac'] },
  { name: 'h264_aac.mov', args: [...src(), ...sine(), ...X264, '-c:a', 'aac'] },
  { name: 'h264_mp3.avi', args: [...src(), ...sine(), ...X264, '-c:a', 'libmp3lame'] },
  { name: 'h264_aac.flv', args: [...src(), ...sine(), ...X264, '-c:a', 'aac'] },
  { name: 'h264_aac.m2ts', args: [...src(), ...sine(), ...X264, '-c:a', 'aac', '-f', 'mpegts'] },
  { name: 'h264_ac3.mts', args: [...src(), ...sine(), ...X264, '-c:a', 'ac3', '-f', 'mpegts'] },
  { name: 'h264_high10.mp4', args: [...src(), ...sine(), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac'] },
  { name: 'h264_444.mp4', args: [...src(), ...sine(), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv444p', '-c:a', 'aac'] },
  { name: 'hevc8_aac.mp4', args: [...src(), ...sine(), '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', '-x265-params', 'log-level=error'] },
  { name: 'hevc10_aac.mp4', args: [...src(), ...sine(), '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-c:a', 'aac', '-x265-params', 'log-level=error'] },
  { name: 'hevc10_opus.mkv', args: [...src(), ...sine(), '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-c:a', 'libopus', '-x265-params', 'log-level=error'] },
  { name: 'vp8_vorbis.webm', args: [...src(), ...sine(), '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libvorbis'] },
  { name: 'vp9_opus.webm', args: [...src(), ...sine(), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-c:a', 'libopus'] },
  { name: 'av1_opus.mkv', args: [...src(), ...sine(), '-c:v', 'libsvtav1', '-preset', '12', '-crf', '40', '-c:a', 'libopus'] },
  { name: 'xvid_mp3.avi', args: [...src(), ...sine(), '-c:v', 'mpeg4', '-vtag', 'XVID', '-q:v', '4', '-c:a', 'libmp3lame'] },
  { name: 'mpeg2_mp2.mpg', args: [...src(), ...sine(), '-c:v', 'mpeg2video', '-q:v', '4', '-c:a', 'mp2', '-f', 'mpeg'] },
  { name: 'mpeg2_ac3.vob', args: [...src('720x480', '30000/1001'), ...sine(), '-c:v', 'mpeg2video', '-q:v', '4', '-c:a', 'ac3', '-f', 'vob'] },
  { name: 'mpeg2_interlaced.mpg', args: [...src('720x480', '30000/1001'), ...sine(), '-c:v', 'mpeg2video', '-q:v', '4', '-vf', 'setfield=tff', '-flags', '+ilme+ildct', '-c:a', 'mp2', '-f', 'mpeg'], note: 'interlaced, no deinterlace in plans' },
  { name: 'wmv2_wma.wmv', args: [...src(), ...sine(), '-c:v', 'wmv2', '-q:v', '4', '-c:a', 'wmav2', '-b:a', '128k'] },
  { name: 'wmv2_wma.asf', args: [...src(), ...sine(), '-c:v', 'wmv2', '-q:v', '4', '-c:a', 'wmav2', '-b:a', '128k', '-f', 'asf'] },
  { name: 'prores_pcm.mov', args: [...src(), ...sine(), '-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le'] },
  { name: 'dnxhr_pcm.mxf', args: [...src(), ...sine(), '-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le'] },
  { name: 'mjpeg_pcm.avi', args: [...src(), ...sine(), '-c:v', 'mjpeg', '-q:v', '4', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le'], note: 'extension uses AVI MJPEG path' },
  { name: 'theora_vorbis.ogv', args: [...src(), ...sine(), '-c:v', 'libtheora', '-q:v', '6', '-c:a', 'libvorbis'] },
  { name: 'flv1_mp3.flv', args: [...src(), ...sine(), '-c:v', 'flv', '-q:v', '4', '-c:a', 'libmp3lame', '-ar', '44100'] },
  { name: 'odd_853x479.mkv', args: [...src('853x479'), ...sine(), '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac'], note: 'odd dimensions' },
  { name: 'h264_odd_853x479.mp4', args: [...src('853x479'), ...sine(), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv444p', '-c:a', 'aac'], note: 'odd dims (4:4:4 since x264 4:2:0 needs even)' },
  { name: 'h264_vfr.mkv', args: [...src('640x360', 60), ...sine(), '-vf', "select='lt(n\\,60)+not(mod(n\\,4))'", '-fps_mode', 'vfr', ...X264, '-c:a', 'aac'], note: 'VFR: 60 fps first second, 15 fps after' },
  { name: 'rotated_phone.mp4', derive: 'h264_aac.mp4', pre: ['-display_rotation', '90'], args: ['-c', 'copy'], note: 'rotation metadata 90' },
  { name: 'h264_ac3_51.mkv', args: [...src(), ...sine(), ...X264, '-c:a', 'ac3', '-ac', '6', '-channel_layout', '5.1'], note: '5.1 audio' },
  { name: 'audio_only.m4a', args: [...sine(), '-c:a', 'aac'], expect: 'noVideo' },
  { name: 'audio_cover.mp3', args: [...sine(), ...src('300x300', 1, 1), '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-id3v2_version', '3'], expect: 'noVideo', note: 'mp3 with cover art (attached_pic)' },
  { name: 'truncated_moov.mp4', truncate: 'h264_aac.mp4', note: 'non-faststart MP4 cut at 50%: moov lost', expect: 'probeFail' },
  { name: 'truncated.mkv', truncate: 'h264_aac.mkv', note: 'MKV cut at 50%', expect: 'partial' },
  { name: 'truncated_faststart.mp4', truncate: 'h264_aac_faststart.mp4', note: 'faststart MP4 cut at 50% (moov present, data missing)', expect: 'partial' },
];
// helper for truncated_faststart
files.splice(1, 0, { name: 'h264_aac_faststart.mp4', derive: 'h264_aac.mp4', args: ['-c', 'copy', '-movflags', '+faststart'], helper: true });

function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || `exit ${r.status}`).trim();
}

const manifest = [];
for (const f of files) {
  const out = path.join(dir, f.name);
  const t0 = Date.now();
  let err = null;
  if (fs.existsSync(out) && fs.statSync(out).size > 0) {
    // keep
  } else if (f.truncate) {
    const s = path.join(dir, f.truncate);
    if (!fs.existsSync(s)) err = `source ${f.truncate} missing`;
    else {
      const buf = fs.readFileSync(s);
      fs.writeFileSync(out, buf.subarray(0, Math.floor(buf.length / 2)));
    }
  } else if (f.derive) {
    err = ff([...(f.pre || []), '-i', path.join(dir, f.derive), ...f.args, out]);
  } else {
    err = ff([...f.args, out]);
  }
  const rec = {
    name: f.name, file: out, expect: f.expect || (f.truncate ? 'partial' : 'ok'),
    audio: f.audio !== false,
    note: f.note || '', helper: !!f.helper, genError: err, genMs: Date.now() - t0,
  };
  manifest.push(rec);
  console.log(`${err ? 'GENFAIL' : 'ok     '} ${f.name} ${err ? err.split('\n').slice(-2).join(' | ') : ''}`);
}

if (big) {
  const seed = path.join(dir, 'big_seed.mkv');
  const out = path.join(dir, 'big_2gb.mkv');
  const t0 = Date.now();
  let err = null;
  if (!fs.existsSync(out)) {
    // High-bitrate noise so few seconds weigh a lot; then loop with stream copy.
    err = fs.existsSync(seed) ? null : ff([...src('1280x720', 30, 10), ...sine(10), '-vf', 'noise=alls=60:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', seed]);
    if (!err) {
      const seedSize = fs.statSync(seed).size;
      const loops = Math.ceil(2.15e9 / seedSize);
      console.log(`big seed ${(seedSize / 1e6).toFixed(0)} MB, looping ${loops}x`);
      err = ff(['-stream_loop', String(loops - 1), '-i', seed, '-c', 'copy', out]);
    }
  }
  manifest.push({ name: 'big_2gb.mkv', file: out, expect: 'ok', audio: true, note: '>2 GB, stream-copied loop', big: true, genError: err, genMs: Date.now() - t0 });
  console.log(`${err ? 'GENFAIL' : 'ok     '} big_2gb.mkv ${err || ''} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest: ${manifest.length} files in ${dir}`);
