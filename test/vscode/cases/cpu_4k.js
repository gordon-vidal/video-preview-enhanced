'use strict';
// CPU per process while native ffmpeg plays 4K HEVC 10-bit (docs/notes/cpu-4k.md). Only with
// VPE_CPU_BENCH=1 in the runner's environment; run it through test/benchq.js.
//   cpu-4k-<variant>: a fresh profile (no GPU test record), the seek-bar preview pass off (VPE_THUMB_PASS=0),
//   20 s stream copies of hevc_10_2160p.mp4 and hevc_10_pq_2160p.mp4 (made in the temp folder).
//   After the first frame and 2 s, the CPU time of every process of this VS Code instance (main,
//   renderers, GPU process, extension host, its ffmpeg children) is read twice, VPE_CPU_SECONDS
//   (default 12) apart, with Win32_Process. CPU is % of one logical core.
// Variants: VPE_CPU_VARIANTS (default "default,cuda,d3d11va,auto"): "default" is what a fresh
// install decides; the others hold the method with VPE_NATIVE_METHOD (as a stored GPU test would).
// VPE_CPU_HEIGHT sets nativeMaxHeight (default 0, automatic).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sample, cpuBetween } = require('../proc_cpu');

const res = (name, problems, extra = {}) => ({ name, ok: !problems.length, problems, ...extra });

function clips() {
  const dir = path.join(os.tmpdir(), 'vpe-cpu-4k-clips');
  fs.mkdirSync(dir, { recursive: true });
  const media = path.join(__dirname, '..', '..', 'media');
  return ['hevc_10_2160p', 'hevc_10_pq_2160p'].map((n) => {
    const out = path.join(dir, `${n}_20s.mp4`);
    if (!fs.existsSync(out)) {
      spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-stream_loop', '9', '-i', path.join(media, `${n}.mp4`), '-c', 'copy', out], { windowsHide: true });
    }
    return out;
  });
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const variants = !process.env.VPE_CPU_BENCH ? [] : (process.env.VPE_CPU_VARIANTS || 'default,cuda,d3d11va,auto').split(',');
const height = Number(process.env.VPE_CPU_HEIGHT || 0);
const secs = Number(process.env.VPE_CPU_SECONDS || 12);

module.exports = variants.map((variant) => ({
  name: `cpu-4k-${variant}`,
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.nativeMaxHeight': height },
  env: { VPE_THUMB_PASS: '0', ...(variant === 'default' ? {} : { VPE_NATIVE_METHOD: variant }) },
  async run(vs, h) {
    const out = [];
    for (const file of clips()) {
      const name = path.basename(file);
      const tag = `\\[${h.esc(name)}\\]`;
      const p = [];
      try {
        const from = await h.openClip(vs, file);
        await vs.waitLog(new RegExp(`${tag} webview: first frame shown`), { from, timeout: 45000 });
        await h.sleep(2000);
        const m0 = vs.mark();
        const a = sample(vs.dir);
        await h.sleep(secs * 1000);
        const b = sample(vs.dir);
        const lines = vs.lines.slice(from).filter((l) => l.includes(`[${name}]`));
        const fps = vs.lines.slice(m0).filter((l) => l.includes(`[${name}] webview: status`))
          .map((l) => Number((/shownFps=([\d.]+)/.exec(l) || [])[1])).filter(Number.isFinite);
        const dec = [...lines].reverse().find((l) => /native decode from/.test(l)) || '';
        const cpu = cpuBetween(a, b);
        if (!cpu.ffmpeg && !/software/.test(dec)) p.push('no ffmpeg CPU seen');
        if (!fps.length) p.push('no status lines');
        out.push(res(name, p, {
          cpu, shownFps: med(fps), fpsWindows: fps,
          decision: ((lines.find((l) => /decoder: /.test(l)) || '').replace(/^.*decoder: /, '')),
          decode: dec.replace(/^.*native decode from [\d.]+ s: /, ''),
          retries: lines.filter((l) => /failed on this file/.test(l)).map((l) => l.replace(/^.*\] /, '')),
          stats: lines.filter((l) => /native stats:/.test(l)).slice(-1).map((l) => l.replace(/^.*native stats: /, ''))[0],
        }));
        console.log(`  ${variant} ${name}: ${JSON.stringify(cpu)} shownFps=${med(fps)} ${dec.replace(/^.*native decode from [\d.]+ s: /, '')}`);
      } catch (e) { out.push(res(name, [...p, e.message])); }
      try { await h.closeClip(vs); } catch { /* gone */ }
      await h.sleep(1500);
    }
    return out;
  },
}));
