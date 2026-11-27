'use strict';
// CPU per process of one VS Code test instance (Windows, Win32_Process): every process whose command line names the
// profile folder, and their descendants (extension host, ffmpeg). Used by layer-4 benches.
const path = require('path');
const { execFileSync } = require('child_process');

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

module.exports = { sample, cpuBetween };
