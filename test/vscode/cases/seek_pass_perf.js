'use strict';
// Layer 4, only with VPE_SEEK_PASS_BENCH=1 (test/perf/benches.js 'seek-pass-*'): the background seek-bar preview pass
// (docs/notes/seek-preview.md, phases 3 and 4) must not cost playback.
//   seek-pass-play-<path>: 4K HEVC 10-bit (a 2 min stream copy of hevc_10_2160p.mp4, a keyframe every 2 s) plays 15 s
//     from 3.5 s after the first frame (the pass starts at 3 s), with the pass off and on (debug probe 'thumbPass'),
//     alternating, twice each, in one instance: dropped, late and shown frames, CPU per role (% of one core), and
//     what the pass did meanwhile. The same on a generated 20 s 1080p H.264 clip with a keyframe every 10 s, where the
//     between pass runs during playback.
//   seek-pass-fill-<path>: paused, the time until the pass has given the whole bar pictures and the CPU it took, for
//     1080p HEVC 8-bit of 20 s, 5 min and 1 h (stream copies of one generated 20 s clip, a keyframe every 2 s), and
//     for 1080p H.264 of 20 s and 60 s with a keyframe every 10 s (the between pass's cases).
// <path>: native (native ffmpeg) or wasm (the built-in decoder).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');
const { sample, cpuBetween } = require('../proc_cpu');

const res = (name, problems, extra = {}) => ({ name, ok: !problems.length, problems, ...extra });
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const DIR = path.join(os.tmpdir(), 'vpe-seek-pass-clips');

function loop(src, name, loops) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, name);
  if (!fs.existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-stream_loop', String(loops - 1), '-i', src, '-c', 'copy', out], { windowsHide: true });
    if (r.status !== 0) throw new Error(`making ${name}: ${String(r.stderr).slice(0, 300)}`);
  }
  return out;
}

function base1080() {
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, 'hevc_1080p_g60_20s.mp4');
  if (!fs.existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '20',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'keyint=60:min-keyint=60:scenecut=0:log-level=error', '-crf', '30',
      '-pix_fmt', 'yuv420p', out], { windowsHide: true });
    if (r.status !== 0) throw new Error(`making the 1080p clip: ${String(r.stderr).slice(0, 300)}`);
  }
  return out;
}

/** testsrc2 1080p30 H.264 with B-frames and a keyframe every 10 s. */
function h264Gop10(seconds) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, `h264_1080p_g300_${seconds}s.mp4`);
  if (!fs.existsSync(out)) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p', out], { windowsHide: true });
    if (r.status !== 0) throw new Error(`making the H.264 clip: ${String(r.stderr).slice(0, 300)}`);
  }
  return out;
}

const done = (x) => x.strip && x.strip.pass && /^done/.test(x.strip.pass.state);

async function playRuns(vs, h, out, file, label) {
  const runs = { off: [], on: [] };
  for (const on of [false, true, false, true]) {
    const p = [];
    const P = await lib.open(vs, h, file, { timeout: 60000 });
    try {
      await P.waitFirstFrame(45000);
      await P.ask('thumbPass', { on });
      await lib.sleep(3500);
      const a = await P.state();
      const ca = sample(vs.dir);
      P.play();
      await lib.sleep(15000);
      const cb = sample(vs.dir);
      const b = await P.state();
      P.pause();
      const run = {
        dropped: b.dropped - a.dropped, late: b.late - a.late, shown: b.shownCount - a.shownCount,
        cpu: cpuBetween(ca, cb), pass: b.strip && b.strip.pass, bar: b.strip && `${b.strip.bar}/${b.strip.n}`,
      };
      runs[on ? 'on' : 'off'].push(run);
      console.log(`  pass ${on ? 'on ' : 'off'}: ${JSON.stringify(run)}`);
      if (on && !(b.strip && b.strip.pass)) p.push('the pass did not start');
    } catch (e) { p.push(e.message); }
    try { await P.close(); } catch { /* gone */ }
    if (p.length) out.push(res(`${label}-${on ? 'on' : 'off'}`, p));
    await lib.sleep(1500);
  }
  const sum = (k) => Object.fromEntries(['off', 'on'].map((m) => [m, {
    dropped: med(runs[m].map((x) => x.dropped)), late: med(runs[m].map((x) => x.late)), shown: med(runs[m].map((x) => x.shown)),
    cpuTotal: med(runs[m].map((x) => x.cpu.total)), cpuRenderer: med(runs[m].map((x) => x.cpu.renderer)),
    cpuFfmpeg: med(runs[m].map((x) => x.cpu.ffmpeg)), cpuExthost: med(runs[m].map((x) => x.cpu.exthost)),
  }]))[k];
  out.push(res(label, [], { off: sum('off'), on: sum('on'), runs }));
}

async function fillRuns(vs, h, out) {
  const src = base1080();
  const clips = [['20s', 1], ['5min', 15], ['1h', 180]].map(([label, loops]) => [label, loops === 1 ? src : loop(src, `hevc_1080p_g60_${label}.mp4`, loops)]);
  for (const sec of [20, 60]) clips.push([`h264-${sec}s`, h264Gop10(sec)]);
  for (const [label, file] of clips) {
    const p = [];
    const P = await lib.open(vs, h, file, { timeout: 60000 });
    let x = null;
    try {
      await P.waitFirstFrame(45000);
      const t0 = Date.now();
      const ca = sample(vs.dir);
      const s = await P.waitState(done, { timeout: 10 * 60e3, interval: 500, what: `the pass over ${label}` });
      const cb = sample(vs.dir);
      x = { fullBarS: s.strip.pass.s, waitedS: (Date.now() - t0) / 1000, pass: s.strip.pass, bar: `${s.strip.bar}/${s.strip.n}`, X: s.strip.X, cpu: cpuBetween(ca, cb) };
      if (s.strip.bar !== s.strip.n) p.push(`bar ${x.bar}`);
      console.log(`  ${label}: ${JSON.stringify(x)}`);
    } catch (e) { p.push(e.message); }
    try { await P.close(); } catch { /* gone */ }
    out.push(res(`fill-${label}`, p, x || {}));
    await lib.sleep(1500);
  }
}

const PATHS = { native: { 'videoPreviewEnhanced.decoder': 'ffmpeg' }, wasm: { 'videoPreviewEnhanced.decoder': 'builtin' } };
module.exports = !process.env.VPE_SEEK_PASS_BENCH ? [] : Object.entries(PATHS).flatMap(([p, settings]) => [
  { name: `seek-pass-play-${p}`, ffmpeg: p === 'native', settings: { ...settings, 'videoPreviewEnhanced.autoplay': false },
    async run(vs, h) {
      const out = [];
      await playRuns(vs, h, out, loop(path.join(__dirname, '..', '..', 'media', 'hevc_10_2160p.mp4'), 'hevc_10_2160p_2min.mp4', 60), 'play');
      await playRuns(vs, h, out, h264Gop10(20), 'play-h264');
      return out;
    } },
  { name: `seek-pass-fill-${p}`, ffmpeg: p === 'native', settings: { ...settings, 'videoPreviewEnhanced.autoplay': false },
    async run(vs, h) { const out = []; await fillRuns(vs, h, out); return out; } },
]);
