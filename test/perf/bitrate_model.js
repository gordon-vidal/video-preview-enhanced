#!/usr/bin/env node
'use strict';
// How well the probe's speeds predict real files: the probe clips (media/probe) and the
// test/media files go through the same runs as the probe (src/probe.js ffRun: same pipeline,
// clip repeated by a concat list, per-frame times), with every method of this machine. Then
// decide.js's estimate for each test file (probe clip speed x pixels x bit-rate factor) is
// set against the file's own measured speed, and the bit-rate exponent each file implies is
// printed (src/decide.js BPP_EXPONENT is their median, rounded).
//
//   node test/benchq.js node test/perf/bitrate_model.js [--ffmpeg <exe>] [--reps 3] [--methods none,d3d11va,...] [--json out.json]
//   node test/perf/bitrate_model.js --from out.json      (the table again from saved measurements)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const probe = require('../../src/probe');
const decide = require('../../src/decide');
const hwaccel = require('../../src/hwaccel');
const hardware = require('../../src/hardware');
const lm = require('../loadmon');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const repo = path.resolve(__dirname, '..', '..');
const MEDIA = ['h264_8_1080p.mp4', 'h264_10_1080p.mp4', 'h264_8_2160p.mp4', 'hevc_8_1080p.mp4', 'hevc_10_1080p.mp4', 'hevc_10_2160p.mp4', 'hevc_10_pq_2160p.mp4',
  'av1_8_1080p.mp4', 'av1_10_1080p.mp4', 'av1_10_2160p.mp4', 'vp9_1080p.webm', 'vp9_2160p.webm', 'prores_proxy_1080p.mov', 'dnxhr_lb_1080p.mov'];
const median = (v) => { const s = v.filter((x) => x > 0).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

async function measure() {
  const ffmpeg = opt('--ffmpeg', process.env.VPE_FFMPEG || 'ffmpeg');
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  const reps = Number(opt('--reps', 3));
  const hw = await hardware.detect();
  const methods = opt('--methods', hwaccel.methodOrder(hw).join(',')).split(',');
  const items = probe.CLIPS.map((c) => {
    const f = path.join(repo, 'media', 'probe', c.file);
    return { ...c, path: f, name: c.file, bpp: probe.clipBpp(f, c), probe: true };
  });
  for (const m of MEDIA) {
    const f = path.join(repo, 'test', 'media', m);
    const j = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt,nb_read_frames', '-of', 'json', f], { windowsHide: true }).toString());
    const s = j.streams[0];
    const frames = Number(s.nb_read_frames);
    items.push({ file: m, path: f, name: m, frames, res: s.height > 1440 ? '2160' : '1080', codec: s.codec_name, pixFmt: s.pix_fmt, width: s.width, height: s.height,
      bpp: Math.round(((fs.statSync(f).size * 8) / frames / (s.width * s.height)) * 10000) / 10000 });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-bitrate-'));
  const fps = {};
  const mon = lm.monitor();
  const before = lm.sampleSync(1);
  for (let r = 0; r < reps; r++) {
    for (const m of methods) {
      for (const res of ['1080', '2160']) {
        let todo = items.filter((it) => it.res === res && (m === 'none' || hwaccel.methodMayDecode(m, it.codec)) && (m === 'none' || !/dnxhd/.test(it.codec)));
        for (let a = 0; todo.length && a < 6; a++) {
          const x = await probe.ffRun(ffmpeg, probe.runArgs(m, todo, probe.outSize(res, 1440), dir), todo);
          const rest = [];
          todo.forEach((it, i) => {
            if (!x.done[i]) { if (i !== x.bad) rest.push(it); return; }
            const fb = m === 'none' ? { hw: true } : hwaccel.checkFallback(m, x.stderr, { rate: probe.CHECK_RATE + i, codec: it.codec });
            if (fb.hw) (fps[`${it.name}|${m}`] = fps[`${it.name}|${m}`] || []).push(x.fps[i]);
          });
          todo = rest;
        }
      }
    }
  }
  const load = mon.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  return { ffmpeg, methods, load: { before: before.load, during: load.median, max: load.max }, items: items.map((it) => ({ ...it, fps: Object.fromEntries(methods.map((m) => [m, fps[`${it.name}|${m}`] || []])) })) };
}

function report(data) {
  const { methods, items } = data;
  // A probe record from the clips' measured medians, as the probe would store it.
  const results = {};
  for (const it of items.filter((x) => x.probe)) {
    const cls = hwaccel.classOf(it.codec, it.depth, it.res === '2160' ? 3840 : 1920, it.res === '2160' ? 2160 : 1080);
    const tried = methods.map((m) => ({ method: m, ok: median(it.fps[m]) > 0, fps: median(it.fps[m]) })).filter((t) => t.ok);
    results[cls] = { method: tried.length ? tried[0].method : null, bpp: it.bpp, tried };
  }
  const record = { results };
  console.log(`load before ${data.load.before} %, during ${data.load.during} % (max ${data.load.max} %); ${data.ffmpeg}`);
  console.log('file                     bpp     probe class    CPU meas  pred   err   implied exp | GPU best meas  pred   err');
  const exps = [];
  const errs = [];
  for (const it of items.filter((x) => !x.probe)) {
    const v = { codec: it.codec, pixFmt: it.pixFmt, width: it.width, height: it.height, fps: 30, bitRate: it.bpp * it.width * it.height * 30 };
    const p = decide.probeEntry(record, v);
    if (!p) { console.log(`${it.name.padEnd(24)} (no probe class)`); continue; }
    const cpuClip = (p.entry.tried.find((t) => t.method === 'none') || {}).fps || 0;
    const cpuMeas = median(it.fps.none);
    const cpuPred = cpuClip * p.scale * hwaccel.bitrateFactor('none', p.entry.bpp, v);
    const exp = cpuMeas > 0 && cpuClip > 0 && it.bpp > p.entry.bpp * 1.5 ? -Math.log(cpuMeas / (cpuClip * p.scale)) / Math.log(it.bpp / p.entry.bpp) : null;
    if (exp !== null) exps.push(exp);
    const err = cpuMeas > 0 ? (cpuPred / cpuMeas - 1) * 100 : null;
    if (err !== null) errs.push(err);
    const gpus = methods.filter((m) => m !== 'none').map((m) => ({ m, meas: median(it.fps[m]), pred: ((p.entry.tried.find((t) => t.method === m) || {}).fps || 0) * p.scale })).filter((g) => g.meas > 0 && g.pred > 0);
    const g = gpus.sort((a, b) => b.meas - a.meas)[0];
    console.log(`${it.name.padEnd(24)} ${String(it.bpp).padEnd(7)} ${p.from.padEnd(14)} ${String(Math.round(cpuMeas)).padStart(8)} ${String(Math.round(cpuPred)).padStart(5)} ${err === null ? '    -' : `${err > 0 ? '+' : ''}${Math.round(err)}%`.padStart(5)}   ${exp === null ? '   -' : exp.toFixed(2)}` +
      `        | ${g ? `${g.m.padEnd(8)} ${String(Math.round(g.meas)).padStart(5)} ${String(Math.round(g.pred)).padStart(5)} ${`${g.pred > g.meas ? '+' : ''}${Math.round((g.pred / g.meas - 1) * 100)}%`.padStart(5)}` : '-'}`);
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  console.log(`CPU estimate error: median |err| ${Math.round(abs[abs.length >> 1])} %, max ${Math.round(abs[abs.length - 1])} %; implied exponents ${exps.map((e) => e.toFixed(2)).join(' ')} (median ${median(exps).toFixed(2)})`);
}

(async () => {
  const data = opt('--from') ? JSON.parse(fs.readFileSync(opt('--from'), 'utf8')) : await measure();
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(data, null, 1));
  report(data);
})().catch((e) => { console.error(e); process.exit(1); });
