#!/usr/bin/env node
// Video DECODE throughput benchmark for the player's decode routes.
//   node test/benchq.js node test/bench/run_bench.js [--media=<dir>] [--only=<regex>] [--routes=wasm,cpu1,cpuN,d3d,cuda]
//        [--repeat=3] [--wasmMaxSec=45] [--out=<dir>] [--renderOnly=1]  (rebuild results.md from results.json)
// Media: test/media (real footage, 1-3 s clips; test/media/LICENSES.md). Each route runs up to
// --repeat times and stops early once two runs agree within 3 %; the tables show the median,
// results.json also keeps best, all runs and the spread. Before each file the CPU load of other
// processes is sampled (test/loadmon.js); rows measured while it was high are marked noisy.
// ffmpeg: VPE_FFMPEG (exe) or PATH; cuda route: VPE_FFMPEG_CUDA (an ffmpeg with -hwaccel cuda).
// Routes (all wall-clock, decode only, video stream only):
//   wasm      libav.js "vpe" build in Node, single thread, mirroring decoder-worker.js:
//             block reader -> ff_read_frame_multi (512 KB) -> ff_decode_multi -> format=yuv420p
//             filter for non-420 frames. Runs in a child process per file.
//   cpu1/cpuN native ffmpeg -threads 1 / default; *_conv adds -vf format=yuv420p
//   d3d       ffmpeg -hwaccel d3d11va: frames kept on GPU, and download + scale <=1440p + yuv420p
//   cuda      ffmpeg -hwaccel cuda: frames on GPU, and scale_cuda <=1440p + hwdownload + yuv420p
// Native fps uses ffmpeg's -benchmark rtime (excludes process start and probing, includes hw init).
// Results: results.json + results.md next to this script (or --out).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const lm = require('../loadmon');
const LIBAV_DIR = path.resolve(__dirname, '..', '..', 'media', 'libav-vpe');
const FF = process.env.VPE_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.VPE_FFMPEG ? path.join(path.dirname(FF), path.basename(FF).replace(/ffmpeg/i, 'ffprobe')) : 'ffprobe';
const FF_CUDA = process.env.VPE_FFMPEG_CUDA || '';

const opt = { media: path.join(__dirname, '..', 'media'), only: '', routes: 'wasm,cpu1,cpuN,d3d,cuda', repeat: 3, wasmMaxSec: 45, out: __dirname };
for (const a of process.argv.slice(2)) {
  const m = /^--(\w+)=(.*)$/.exec(a);
  if (m) opt[m[1]] = m[2];
}

if (opt.wasmChild) { wasmChild(opt.wasmChild, +opt.wasmMaxSec).catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); }); }
else if (opt.renderOnly) { const o = JSON.parse(fs.readFileSync(path.join(opt.out, 'results.json'), 'utf8')); fs.writeFileSync(path.join(opt.out, 'results.md'), renderMd(o)); }
else main();

// ---------- native ----------
function probe(file) {
  const j = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,nb_read_packets:format=duration,size,bit_rate', '-of', 'json', file], { windowsHide: true }));
  const s = j.streams[0];
  return { codec: s.codec_name, profile: s.profile, pix_fmt: s.pix_fmt, w: s.width, h: s.height, frames: +s.nb_read_packets,
    duration: +j.format.duration, sizeMB: +(j.format.size / 1e6).toFixed(2), mbps: +(j.format.bit_rate / 1e6).toFixed(2) };
}

function ffRun(exe, pre, file, post, frames) {
  const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'level+info', '-benchmark', ...pre, '-i', file, '-an', ...post, '-f', 'null', '-'];
  const t = Date.now();
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const wall = (Date.now() - t) / 1000;
  const err = (r.stderr || '') + (r.stdout || '');
  const m = /rtime=([\d.]+)s/.exec(err);
  const rtime = m ? +m[1] : null;
  const warn = err.split(/\r?\n/).filter((l) => /\[(warning|error|fatal)\]/.test(l));
  const fallback = warn.some((l) => /Failed setup|not supported|doesn't support|hwaccel initialisation returned error|Could not find ref|No device|Failed to create|fallback|unsupported/i.test(l));
  return { ok: r.status === 0 && rtime !== null, status: r.status, rtime, wall: +wall.toFixed(2),
    fps: r.status === 0 && rtime ? +(frames / rtime).toFixed(1) : 0, fallback, warn: [...new Set(warn)].slice(0, 3), args: args.join(' ') };
}

// d3d11va falls back to software silently for codecs it lacks; ask get_format what it picked.
function hwFormat(exe, hw, file) {
  const r = spawnSync(exe, ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'debug', '-hwaccel', hw, '-hwaccel_output_format', hw === 'cuda' ? 'cuda' : 'd3d11',
    '-i', file, '-an', '-frames:v', '3', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const all = [...((r.stderr || '').matchAll(/Format (\w+) chosen by get_format/g))].map((m) => m[1]);
  return all.length ? all[all.length - 1] : '?';
}

/** Up to n runs (stops once two agree within 3 %): the median run, with best, all runs and spread. */
function bestOf(n, fn) {
  const all = [];
  for (let i = 0; i < n; i++) {
    all.push(fn());
    const k = all.length;
    if (k >= 2 && Math.abs(all[k - 1].fps - all[k - 2].fps) <= 0.03 * Math.max(1, all[k - 1].fps)) break;
  }
  const sp = lm.spread(all.map((r) => r.fps));
  const sorted = [...all].sort((a, b) => a.fps - b.fps);
  const med = { ...sorted[Math.floor((sorted.length - 1) / 2)] };
  med.fps = sp.median;
  med.best = sp.best;
  med.spreadPct = sp.spreadPct;
  med.runs = all.map((r) => r.fps);
  return med;
}

function scaleCpu(p) { return p.h > 1440 ? ['-vf', 'scale=-2:1440:flags=bilinear,format=yuv420p'] : ['-vf', 'format=yuv420p']; }
function scaleCuda(p) {
  const s = p.h > 1440 ? 'scale_cuda=-2:1440:format=yuv420p' : 'scale_cuda=format=yuv420p';
  return ['-vf', `${s},hwdownload,format=yuv420p`];
}

function main() {
  const routes = new Set(opt.routes.split(','));
  const rx = new RegExp(opt.only || '.');
  const files = fs.readdirSync(opt.media).filter((f) => rx.test(f) && /\.(mp4|mkv|mov|webm|mpg|avi|wmv|m2ts|mxf)$/i.test(f)).sort();
  const jsonPath = path.join(opt.out, 'results.json');
  const prev = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : { files: {} };
  // Rows of files that are no longer in the media folder are dropped.
  const kept = Object.fromEntries(Object.entries(prev.files || {}).filter(([k]) => fs.existsSync(path.join(opt.media, k))));
  const out = { cpu: cpuName(), gpu: gpuName(), date: new Date().toISOString(), node: process.version, repeat: +opt.repeat || 1, files: kept };
  const rep = +opt.repeat || 1;
  for (const f of files) {
    const file = path.join(opt.media, f);
    const p = probe(file);
    const idle = lm.sampleSync(0.5);
    const r = { probe: p, othersLoad: idle.load, load: lm.verdict(idle.load) };
    const conv = !/^yuvj?420p$/.test(p.pix_fmt);
    const log = (k, v) => process.stdout.write(`${f.padEnd(28)} ${k.padEnd(10)} ${v.ok === false ? 'FAIL ' : ''}${v.fps} fps${v.runs && v.runs.length > 1 ? ` (best ${v.best}, spread ${v.spreadPct} %, ${v.runs.length} runs)` : ''}${r.load !== 'quiet' ? ` [others ${r.othersLoad} % ${r.load}]` : ''}${v.nohw ? ' (no hw: ' + v.chosen + ')' : v.fallback ? ' (fallback?)' : ''}${v.note ? ' ' + v.note : ''}\n`);
    if (routes.has('cpu1')) {
      r.cpu1 = bestOf(rep, () => ffRun(FF, ['-threads', '1'], file, [], p.frames)); log('cpu1', r.cpu1);
      if (conv) { r.cpu1_conv = bestOf(rep, () => ffRun(FF, ['-threads', '1'], file, ['-threads', '1', '-filter_threads', '1', '-vf', 'format=yuv420p'], p.frames)); log('cpu1_conv', r.cpu1_conv); }
    }
    if (routes.has('cpuN')) {
      r.cpuN = bestOf(rep, () => ffRun(FF, [], file, [], p.frames)); log('cpuN', r.cpuN);
      if (conv) { r.cpuN_conv = bestOf(rep, () => ffRun(FF, [], file, ['-vf', 'format=yuv420p'], p.frames)); log('cpuN_conv', r.cpuN_conv); }
    }
    if (routes.has('d3d')) {
      r.d3d_fmt = hwFormat(FF, 'd3d11va', file);
      const sw = r.d3d_fmt !== 'd3d11';
      const noHw = (fmt) => ({ ok: false, fps: 0, nohw: true, chosen: fmt });
      r.d3d_gpu = sw ? noHw(r.d3d_fmt) : bestOf(rep, () => ffRun(FF, ['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11'], file, [], p.frames)); log('d3d_gpu', r.d3d_gpu);
      r.d3d_dl = sw ? noHw(r.d3d_fmt) : bestOf(rep, () => ffRun(FF, ['-hwaccel', 'd3d11va'], file, scaleCpu(p), p.frames)); log('d3d_dl', r.d3d_dl);
    }
    if (routes.has('cuda') && FF_CUDA && fs.existsSync(FF_CUDA)) {
      r.cuda_fmt = hwFormat(FF_CUDA, 'cuda', file);
      const sw = r.cuda_fmt !== 'cuda';
      const noHw = (fmt) => ({ ok: false, fps: 0, nohw: true, chosen: fmt });
      r.cuda_gpu = sw ? noHw(r.cuda_fmt) : bestOf(rep, () => ffRun(FF_CUDA, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], file, [], p.frames)); log('cuda_gpu', r.cuda_gpu);
      r.cuda_dl = sw ? noHw(r.cuda_fmt) : bestOf(rep, () => ffRun(FF_CUDA, ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], file, scaleCuda(p), p.frames)); log('cuda_dl', r.cuda_dl);
    }
    if (routes.has('wasm')) {
      r.wasm = bestOf(rep, () => {
        const c = spawnSync(process.execPath, [__filename, `--wasmChild=${file}`, `--wasmMaxSec=${opt.wasmMaxSec}`], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
        const line = (c.stdout || '').trim().split(/\r?\n/).pop() || '{}';
        try { return JSON.parse(line); } catch { return { ok: false, fps: 0, error: (c.stderr || '').slice(0, 300) }; }
      });
      log('wasm', r.wasm);
    }
    out.files[f] = r;
    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 1));
  }
  fs.writeFileSync(path.join(opt.out, 'results.md'), renderMd(out));
}

function cpuName() {
  try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Processor).Name'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return '?'; }
}

function renderMd(out) {
  const fmt = (v) => (v && v.ok !== false && v.fps ? (v.fallback ? `sw ${v.fps}` : `${v.fps}`) : (v ? (v.nohw ? 'no hw' : 'fail') : '-'));
  const pick = (r, k) => r[k + '_conv'] || r[k];
  const files = Object.keys(out.files).sort();
  const dec = (v) => (v && v.ok !== false && v.decodeOnlyFps ? `${v.decodeOnlyFps}` : '-');
  const routes = ['wasm', 'cpu1', 'cpu1_conv', 'cpuN', 'cpuN_conv', 'd3d_gpu', 'd3d_dl', 'cuda_gpu', 'cuda_dl'];
  const maxSpread = (r) => Math.max(0, ...routes.map((k) => (r[k] && r[k].spreadPct) || 0));
  const loads = files.map((f) => out.files[f].othersLoad).filter((x) => typeof x === 'number');
  const ld = lm.spread(loads);
  let s = `# Video decode benchmark

CPU: ${out.cpu}; GPU: ${out.gpu || '?'}; Node ${out.node}; ${out.date}

` +
    'Frames per second, decode only, wall clock, video stream only. Media: test/media, 1-3 s clips of real footage ' +
    '(Tears of Steel 1080p, Meridian 4K SDR, Sparks 4K HDR, Big Buck Bunny; test/media/LICENSES.md). ' +
    'Real time needs >= the frame rate of the clip (24, 29.97 or 30). wasm = libav.js vpe build, 1 thread, incl. demux and conversion to yuv420p; ' +
    'wasm dec = the same run without the conversion (the player converts 10-bit and 4:2:2 on the GPU, so this is the column that matches it). ' +
    'cpu1/cpuN = native ffmpeg 1 thread / all threads (with format=yuv420p for non-420 sources). ' +
    'd3d11va / cuda "gpu" = frames stay on GPU; "dl" = download to RAM + scale to <=1440p + yuv420p. ' +
    'no hw = the hwaccel does not take this stream. Each cell is the median of up to ' + (out.repeat || 3) + ' runs (stops early when two agree within 3 %); ' +
    '"spread" = the largest (max-min)/median of the row; "others" = CPU load of other processes just before the row (% of all logical CPUs). ' +
    `Native fps uses ffmpeg's -benchmark rtime, so on short clips GPU numbers in the hundreds are bounded by fixed overhead.

` +
    `Load of other processes during the run: median ${ld.median} %, max ${ld.best} % (${lm.verdict(ld.median)}).

`;
  for (const res of ['1080', '2160']) {
    s += `## ${res}p

| file | codec / pix_fmt | Mb/s | wasm | wasm dec | cpu 1t | cpu Nt | d3d11va gpu | d3d11va dl | cuda gpu | cuda dl | spread | others |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
`;
    for (const f of files.filter((x) => x.includes(`_${res}p`))) {
      const r = out.files[f], p = r.probe;
      s += `| ${f} | ${p.codec} ${p.pix_fmt} | ${p.mbps} | ${fmt(r.wasm)} | ${dec(r.wasm)} | ${fmt(pick(r, 'cpu1'))} | ${fmt(pick(r, 'cpuN'))} | ${fmt(r.d3d_gpu)} | ${fmt(r.d3d_dl)} | ${fmt(r.cuda_gpu)} | ${fmt(r.cuda_dl)} | ${maxSpread(r)} % | ${r.othersLoad ?? '-'} %${r.load && r.load !== 'quiet' ? ` ${r.load}` : ''} |
`;
    }
    s += '\n';
  }
  // Hand-written sections (player measurements, notes) between these markers survive a re-render.
  try {
    const m = /<!-- keep -->[\s\S]*?<!-- \/keep -->\n/.exec(fs.readFileSync(path.join(opt.out, 'results.md'), 'utf8'));
    if (m) s += m[0] + '\n';
  } catch { /* first run */ }
  return s;
}

function gpuName() {
  try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + " (" + $_.DriverVersion + ")" }) -join ", "'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return '?'; }
}

// ---------- wasm child ----------
async function wasmChild(file, maxSec) {
  const log = [];
  console.error = (...a) => log.push(a.join(' '));
  console.warn = console.error;
  global.LibAV = { base: LIBAV_DIR };
  require(path.join(LIBAV_DIR, 'libav-vpe.js'));
  const libav = await LibAV.LibAV({ noworker: true, nothreads: true, base: LIBAV_DIR, variant: 'vpe' });
  await libav.av_log_set_level(16);
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const BLOCK = 1 << 20;
  libav.onblockread = (name, pos, len) => setImmediate(() => {
    const n = Math.max(0, Math.min(Math.max(len, BLOCK), size - pos));
    const buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, pos);
    libav.ff_block_reader_dev_send(name, pos, n ? new Uint8Array(buf.buffer, buf.byteOffset, n) : null);
  });
  await libav.mkblockreaderdev('in0', size);
  const [fmt, streams] = await libav.ff_init_demuxer_file('in0');
  const vs = streams.find((s) => s.codec_type === 0);
  const tb = [vs.time_base_num, vs.time_base_den];
  const [, c, pkt, frame] = await libav.ff_init_decoder(vs.codec_id, { codecpar: vs.codecpar, time_base: tb });
  const rpkt = await libav.av_packet_alloc();
  let filter = null, frames = 0, decMs = 0, convMs = 0, srcFmt = null;
  const toYuv = async (frs) => {
    const o = [];
    for (const f of frs) {
      if (f.format === 0 || f.format === 12) { o.push(f); continue; }
      if (!filter) {
        const [graph, src, sink] = await libav.ff_init_filter_graph('format=yuv420p',
          { type: 0, width: f.width, height: f.height, pix_fmt: f.format, time_base: tb }, { type: 0, pix_fmt: 0, time_base: tb });
        filter = { graph, src, sink, frame: await libav.av_frame_alloc() };
      }
      o.push(...await libav.ff_filter_multi(filter.src, filter.sink, filter.frame, [f], { copyoutFrame: 'video' }));
    }
    return o;
  };
  const t0 = performance.now();
  let capped = false;
  for (;;) {
    const [res, packets] = await libav.ff_read_frame_multi(fmt, rpkt, { limit: 512 * 1024 });
    const atEnd = res === libav.AVERROR_EOF;
    const vp = packets[vs.index] || [];
    if (vp.length || atEnd) {
      const t = performance.now();
      let fr = await libav.ff_decode_multi(c, pkt, frame, vp, { fin: atEnd, ignoreErrors: true, copyoutFrame: 'video' });
      const t2 = performance.now();
      if (fr.length && srcFmt === null) srcFmt = fr[0].format;
      fr = await toYuv(fr);
      convMs += performance.now() - t2;
      decMs += t2 - t;
      frames += fr.length;
    }
    if (atEnd || (res !== 0 && res !== -libav.EAGAIN)) break;
    if ((performance.now() - t0) / 1000 > maxSec) { capped = true; break; }
  }
  const wall = (performance.now() - t0) / 1000;
  fs.closeSync(fd);
  console.log(JSON.stringify({ ok: frames > 0, frames, wall: +wall.toFixed(2), fps: +(frames / wall).toFixed(1),
    decodeOnlyFps: +(frames / (decMs / 1000)).toFixed(1), convMs: Math.round(convMs), srcFmt, filtered: !!filter,
    note: capped ? `(capped at ${maxSec}s)` : '', logs: [...new Set(log)].slice(0, 2) }));
  process.exit(0);
}
