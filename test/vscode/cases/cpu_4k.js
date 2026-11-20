'use strict';
// CPU per process while native ffmpeg plays 4K HEVC 10-bit (docs/notes/cpu-4k.md). Only with
// VPE_CPU_BENCH=1 in the runner's environment; run it through test/benchq.js.
//   cpu-4k-<variant>: a fresh profile (no GPU test record), the seek-bar strip off (VPE_THUMB_STRIP=0),
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
const { spawnSync, execFileSync } = require('child_process');

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

/** CPU times (s) of this instance's processes: those whose command line names the profile folder, and their descendants (extension host, ffmpeg). */
function sample(profileDir) {
  const key = path.basename(profileDir);
  const ps = `Get-CimInstance Win32_Process -Filter "Name='Code.exe' OR Name='ffmpeg.exe'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name;
 mine = [bool]($_.CommandLine -and $_.CommandLine.Contains('${key}'));
 type = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { '' };
 sub = if ($_.CommandLine -match '--utility-sub-type=([a-zA-Z.]+)') { $matches[1] } else { '' };
 cpu = ($_.KernelModeTime + $_.UserModeTime) / 1e7 } } | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let all = JSON.parse(out || '[]');
  if (!Array.isArray(all)) all = [all];
  const ours = new Set(all.filter((p) => p.mine).map((p) => p.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!ours.has(p.pid) && ours.has(p.ppid)) { ours.add(p.pid); grew = true; }
  }
  return { at: Date.now(), list: all.filter((p) => ours.has(p.pid)) };
}

/** % of one core per role between two samples (processes in both; ffmpeg also counts one that started in between). */
function cpuBetween(a, b) {
  const dt = (b.at - a.at) / 1000;
  const before = new Map(a.list.map((p) => [p.pid, p]));
  const parents = new Set(b.list.filter((p) => p.name === 'ffmpeg.exe').map((p) => p.ppid));
  const role = (p) => p.name === 'ffmpeg.exe' ? 'ffmpeg' : parents.has(p.pid) ? 'exthost' : p.type === 'renderer' ? 'renderer'
    : p.type === 'gpu-process' ? 'gpu' : !p.type ? 'main' : 'other';
  const out = { ffmpeg: 0, exthost: 0, renderer: 0, gpu: 0, main: 0, other: 0 };
  const each = [];
  for (const p of b.list) {
    const p0 = before.get(p.pid);
    if (!p0 && p.name !== 'ffmpeg.exe') continue;
    const pct = ((p.cpu - (p0 ? p0.cpu : 0)) / dt) * 100;
    out[role(p)] += pct;
    if (pct >= 1) each.push(`${role(p)}${p.sub ? `(${p.sub})` : ''}:${Math.round(pct)}`);
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  out.total = Object.values(out).reduce((x, y) => x + y, 0);
  return { ...out, each: each.join(' ') };
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const variants = !process.env.VPE_CPU_BENCH ? [] : (process.env.VPE_CPU_VARIANTS || 'default,cuda,d3d11va,auto').split(',');
const height = Number(process.env.VPE_CPU_HEIGHT || 0);
const secs = Number(process.env.VPE_CPU_SECONDS || 12);

module.exports = variants.map((variant) => ({
  name: `cpu-4k-${variant}`,
  ffmpeg: true,
  settings: { 'videoPreviewEnhanced.nativeMaxHeight': height },
  env: { VPE_THUMB_STRIP: '0', ...(variant === 'default' ? {} : { VPE_NATIVE_METHOD: variant }) },
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
