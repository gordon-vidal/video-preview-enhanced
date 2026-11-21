'use strict';
// Run only through: node test/benchq.js node tools/gpu-encode-research.js <ffmpeg> <scratch-dir>
// No download or product changes. Outputs contain local paths; keep them out of Git.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lm = require('../test/loadmon');
const [ffmpeg, scratch] = process.argv.slice(2);
if (!ffmpeg || !scratch) throw new Error('usage: <ffmpeg> <scratch-dir>');
const dir = path.resolve(scratch);
fs.mkdirSync(dir, { recursive: true });
const source = process.env.VPE_GPU_SOURCE || path.join(dir, 'source-4k60.mp4');
const probe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
const base = ['-hide_banner', '-nostdin', '-y'];
const sync = (args) => {
  const r = spawnSync(ffmpeg, [...base, ...args], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  if (r.error || r.status) throw new Error(r.error ? r.error.message : r.stderr);
  return r.stderr;
};
const inventory = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true }).stdout;
fs.writeFileSync(path.join(dir, 'version.txt'), inventory);
const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true }).stdout;
fs.writeFileSync(path.join(dir, 'encoders.txt'), encoders);
if (!fs.existsSync(source) || fs.statSync(source).size < 1024) {
  // Duplicated frames, not genuine 60 fps motion. Compare quality against this generated source.
  sync(['-stream_loop', '-1', '-i', 'test/media/hevc_10_2160p.mp4', '-t', '12', '-an',
    '-vf', 'fps=60,format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'pools=2:frame-threads=2', '-crf', '18', source]);
}
const info = spawnSync(probe, ['-v', 'error', '-show_streams', '-of', 'json', source],
  { encoding: 'utf8', windowsHide: true });
if (info.status) throw new Error(info.stderr);
const results = { source: JSON.parse(info.stdout), runs: [], quality: [] };
function save() { fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2)); }

async function encode(encoder, mbps, repeat) {
  const raw = path.join(dir, `${encoder}-${mbps}-${repeat}.${encoder === 'hevc_nvenc' ? 'hevc' : 'h264'}`);
  const nv = /nvenc/.test(encoder);
  const args = [...base, '-benchmark', ...(nv ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
    '-i', source, '-an', '-vf', nv ? 'scale_cuda=format=nv12' : 'format=nv12', '-c:v', encoder,
    ...(nv ? ['-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-rc-lookahead', '0'] :
      encoder === 'libx264' ? ['-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '4'] : []),
    '-b:v', `${mbps}M`, '-maxrate', `${Math.round(mbps * 1.5)}M`, '-bufsize', `${mbps}M`,
    '-g', '60', '-bf', '0', '-f', encoder === 'hevc_nvenc' ? 'hevc' : 'h264', 'pipe:1'];
  const loadBefore = await lm.sample(1);
  const gpu = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder',
    '--format=csv,noheader,nounits', '-lms', '200'], { windowsHide: true });
  let gpuText = '';
  gpu.stdout.on('data', (d) => { gpuText += d; });
  gpu.on('error', () => {});
  const start = performance.now();
  const p = spawn(ffmpeg, args, { windowsHide: true });
  const timer = setTimeout(() => p.kill(), 180000);
  const out = fs.createWriteStream(raw);
  let log = '', firstVclMs = null, tail = Buffer.alloc(0), bytes = 0;
  p.stderr.on('data', (d) => { log += d; });
  p.stdout.on('data', (d) => {
    bytes += d.length;
    if (firstVclMs === null) {
      const b = Buffer.concat([tail, d]);
      for (let i = 0; i + 3 < b.length; i++) {
        if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
          const type = encoder === 'hevc_nvenc' ? (b[i + 3] >> 1) & 63 : b[i + 3] & 31;
          if (encoder === 'hevc_nvenc' ? type <= 31 : type === 1 || type === 5) {
            firstVclMs = performance.now() - start; break;
          }
        }
      }
      tail = b.subarray(-4);
    }
  });
  p.stdout.pipe(out);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      p.on('error', reject); p.on('close', (value) => resolve(value === null ? -1 : value));
    });
  } finally { clearTimeout(timer); gpu.kill(); }
  await new Promise((resolve, reject) => { if (out.writableFinished) resolve();
    else { out.on('finish', resolve); out.on('error', reject); } });
  const elapsed = (performance.now() - start) / 1000;
  gpu.kill();
  fs.writeFileSync(`${raw}.log`, log);
  const cpu = /utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(log);
  const frame = [...log.matchAll(/frame=\s*(\d+)/g)].pop();
  const samples = gpuText.trim().split(/\r?\n/).map((s) => s.split(',').map(Number))
    .filter((a) => a.length === 3 && a.every(Number.isFinite));
  const row = { encoder, mbps, repeat, code, loadBefore: loadBefore.load, firstVclMs,
    elapsed, frames: frame ? +frame[1] : 0, fps: frame ? +frame[1] / elapsed : null,
    cpuOneCore: cpu ? 100 * (+cpu[1] + +cpu[2]) / +cpu[3] : null,
    actualMbps: bytes * 8 / 12e6,
    gpuMean: [0, 1, 2].map((i) => samples.length ? samples.reduce((s, a) => s + a[i], 0) / samples.length : null),
    gpuSamples: samples.length, error: code ? log.slice(-2200) : undefined };
  results.runs.push(row); save(); console.log(JSON.stringify(row));
  if (!code && (encoder === 'h264_nvenc' || encoder === 'libx264') && repeat === 1) {
    const mp4 = path.join(dir, `${encoder}-${mbps}.mp4`);
    sync(['-r', '60', '-i', raw, '-c:v', 'copy', '-movflags', '+faststart', mp4]);
    for (const metric of ['psnr', 'ssim', 'libvmaf']) {
      // The reference and test are both converted to 8-bit: these scores exclude 10->8 bit loss.
      const graph = `[0:v]setpts=PTS-STARTPTS,format=yuv420p[a];` +
        `[1:v]setpts=PTS-STARTPTS,format=yuv420p[b];[a][b]${metric}`;
      try {
        const text = sync(['-i', mp4, '-i', source, '-lavfi', graph, '-an', '-f', 'null', '-']);
        const summary = text.split(/[\r\n]+/).filter((s) => /PSNR |SSIM |VMAF score/.test(s)).join('\n');
        results.quality.push({ encoder, mbps, metric, summary });
      } catch (e) { results.quality.push({ encoder, mbps, metric, error: e.message.slice(-1200) }); }
      save();
    }
  }
}
(async () => {
  for (const encoder of ['h264_qsv', 'h264_amf', 'hevc_nvenc']) await encode(encoder, 24, 1);
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const mbps of [12, 24, 40]) await encode('h264_nvenc', mbps, repeat);
  }
  // A diagnostic control only; libx264 is not available in the managed LGPL build.
  if (/\blibx264\s/.test(encoders)) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      for (const mbps of [12, 24, 40]) await encode('libx264', mbps, repeat);
    }
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
