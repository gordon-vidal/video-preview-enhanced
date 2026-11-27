'use strict';
// node test/run.js unit --grep seek_keyframe: a Live transcode start or seek (src/stream.js args) decodes from the
// keyframe at or before its target, not one GOP earlier, and still lands on the exact frame. With ffmpeg on PATH:
// generated long-GOP H.264 clips with B-frames (MP4 and MKV; MKV is where ffmpeg moves its seek point back by 3/23 s),
// targets on a keyframe, just before and after one, between two frames, and a variable-frame-rate clip. Measured by
// what ffmpeg reads for the stream's own command (video packets demuxed before the first frame out) and by the number
// each frame shows in its picture.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EncodedStream } = require('../../src/stream');
const { createGpuSessions } = require('../../src/gpu-sessions');
const { probe } = require('../../src/ffmpeg');

const FPS = 25;
const GOP = 250; // 10 s: a GOP decoded for nothing is unmistakable
const W = 320;
const H = 192;

/** The stream's argv for a start at t, run until its first frame: { shown, packets } (packets: video packets read). */
function firstFrame(s, t) {
  const argv = s.args(t, false).slice();
  // The stream's command as built, only made to report what it reads (-debug_ts, at info level) and to stop after one frame.
  argv.splice(argv.indexOf('-v'), 2, '-v', 'info', '-debug_ts');
  argv.splice(argv.lastIndexOf('-f'), 0, '-frames:v', '1');
  const r = spawnSync('ffmpeg', argv, { windowsHide: true, maxBuffer: 1 << 28 });
  assert.strictEqual(r.status, 0, String(r.stderr).slice(-2000));
  const packets = (String(r.stderr).match(/demuxer -> ist_index:0[:\s]/g) || []).length;
  assert.ok(packets > 0, 'ffmpeg reports the packets it reads (-debug_ts)');
  return { shown: numberIn(r.stdout), packets };
}

/** What ffmpeg's own accurate seek shows with the margin the stream used before (-ss t-0.0005, constant rate out). */
function reference(file, t) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', Math.max(0, t - 0.0005).toFixed(4), '-i', file, '-fps_mode', 'cfr',
    '-r', String(FPS), '-frames:v', '1', '-c:v', 'libx264', '-f', 'h264', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, String(r.stderr));
  return numberIn(r.stdout);
}

/** The frame number drawn in the first picture of an H.264 stream. */
function numberIn(h264) {
  const y = spawnSync('ffmpeg', ['-v', 'error', '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'],
    { input: h264, windowsHide: true });
  const Y = y.stdout;
  assert.strictEqual(Y.length, W * H, String(y.stderr));
  let shown = 0;
  for (let bit = 0; bit < 10; bit++) {
    let sum = 0;
    for (let row = 60; row < 132; row++) for (let x = bit * 32 + 8; x < bit * 32 + 24; x++) sum += Y[row * W + x];
    if (sum / (72 * 16) > 125) shown |= 1 << bit;
  }
  return shown;
}

(async () => {
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
  if (ff.status !== 0) { console.log('seek_keyframe_test: no ffmpeg on PATH, skipped'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-seekkey-'));
  try {
    // Frame n shows its number in binary: 10 columns of 32 px, white for a 1; noise makes frames of a real size.
    const bits = String.raw`format=yuv420p,geq=lum='if(bitand(N\,pow(2\,floor(X/32)))\,235\,16)':cb=128:cr=128,noise=alls=30:allf=t`;
    const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '3', '-g', String(GOP), '-keyint_min', String(GOP),
      '-sc_threshold', '0', '-pix_fmt', 'yuv420p'];
    const clips = [
      { name: 'mp4', file: 'long.mp4', vf: bits, extra: [] },
      { name: 'mkv', file: 'long.mkv', vf: bits, extra: [] },
      // Variable frame rate: every odd frame 0.4 frame late (keyframes stay on the grid).
      { name: 'vfr mp4', file: 'vfr.mp4', vf: `${bits},setpts='(N+0.4*mod(N\\,2))/${FPS}/TB'`, extra: ['-fps_mode', 'passthrough', '-video_track_timescale', '1000'] },
    ];
    for (const c of clips) {
      const file = path.join(dir, c.file);
      const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=${FPS}:d=24`,
        '-vf', c.vf, ...x264, ...c.extra, file], { encoding: 'utf8', windowsHide: true });
      assert.strictEqual(mk.status, 0, mk.stderr);
      const probed = await probe({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, file);
      const s = new EncodedStream({ tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set() }, file, post: () => {}, log: () => {}, remote: false,
        maxHeight: 1080, encoder: 'libx264', cpuEncoder: 'libx264', gpuSessions: createGpuSessions(8), probed });
      s.fps = FPS;
      s.directStreamFailed = true; // a small H.264 clip would be copied (Direct Stream), not re-encoded
      s.sizeVideo();
      const vfr = c.name.startsWith('vfr');
      const time = (n) => (vfr ? (n + 0.4 * (n % 2)) / FPS : n / FPS);
      // [target time, frame it must show, frames from the keyframe that has to be decoded to reach it]
      const cases = [
        [time(250), 250, 0], // on a keyframe
        [time(500), 500, 0],
        [time(249), 249, 249], // just before one
        [time(251), 251, 1], // just after one (within ffmpeg's 3/23 s for MKV)
        [time(253), 253, 3],
        [time(375), 375, 125], // deep in a GOP
      ];
      if (!vfr) cases.push([(250.5) / FPS, 251, 1]); // between two frames: the next one, as before
      for (const [t, exact, needed] of cases) {
        // Variable frame rate: the constant-rate output picks its first frame as ffmpeg's own seek did before.
        const want = vfr ? reference(file, t) : exact;
        const { shown, packets } = firstFrame(s, t);
        assert.strictEqual(shown, want, `${c.name}: a start at ${t.toFixed(4)} s shows frame ${shown}, not ${want}`);
        // Decoder read-ahead and the encoder's first frame: a few dozen packets beyond those needed; a GOP more is 250.
        assert.ok(packets <= needed + 60, `${c.name}: a start at ${t.toFixed(4)} s (frame ${want}) read ${packets} video packets; `
          + `${needed} needed from its keyframe: a whole GOP before it was decoded`);
      }
      console.log(`seek_keyframe: ${c.name}: ${cases.length} starts on the exact frame, none decoding the GOP before its keyframe`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().then(() => console.log('seek_keyframe_test ok'), (e) => { console.error(e); process.exit(1); });
