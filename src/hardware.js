'use strict';
// What machine are we on: OS, CPU architecture, GPUs and the NVIDIA driver
// version (which decides which ffmpeg builds can use NVENC). No admin rights needed.

const fs = require('fs');
const { run } = require('./ffmpeg');

function vendorOf(text) {
  const t = String(text).toLowerCase();
  if (t.includes('nvidia')) return 'nvidia';
  if (t.includes('amd') || t.includes('advanced micro') || t.includes('radeon')) return 'amd';
  if (t.includes('intel')) return 'intel';
  if (t.includes('apple')) return 'apple';
  if (t.includes('qualcomm') || t.includes('adreno')) return 'qualcomm';
  return 'other';
}

/** Windows reports NVIDIA drivers as e.g. 32.0.15.8115 -> 581.15. */
function nvidiaFromWindowsVersion(v) {
  const digits = String(v).replace(/\./g, '');
  if (!/^\d{5,}$/.test(digits)) return null; // also non-numeric text (a missing DriverVersion is "undefined")
  const last5 = digits.slice(-5);
  return `${Number(last5.slice(0, 3))}.${last5.slice(3)}`;
}

async function detect() {
  const hw = { os: process.platform, arch: process.arch, gpus: [], nvidiaDriver: null, vaapi: false };
  try {
    if (process.platform === 'win32') {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,DriverVersion | ConvertTo-Json -Compress'], 15000);
      let list = [];
      try { list = JSON.parse(r.stdout || '[]'); } catch { list = []; }
      if (!Array.isArray(list)) list = [list];
      for (const g of list) {
        if (!g || !g.Name || /basic display|remote display|virtual/i.test(g.Name)) continue;
        const vendor = vendorOf(`${g.AdapterCompatibility} ${g.Name}`);
        const gpu = { vendor, name: g.Name, driver: g.DriverVersion || '' };
        if (vendor === 'nvidia') gpu.driver = nvidiaFromWindowsVersion(g.DriverVersion) || gpu.driver;
        hw.gpus.push(gpu);
      }
    } else if (process.platform === 'linux') {
      const r = await run('lspci', ['-mm'], 5000);
      for (const line of r.stdout.split('\n')) {
        if (!/VGA|3D controller|Display controller/i.test(line)) continue;
        const name = line.split('"').filter((x, i) => i % 2 === 1).slice(1, 3).join(' ');
        hw.gpus.push({ vendor: vendorOf(name), name, driver: '' });
      }
      try {
        const v = fs.readFileSync('/proc/driver/nvidia/version', 'utf8');
        const m = /Kernel Module\s+(?:for \S+\s+)?([\d.]+)/.exec(v);
        if (m) hw.nvidiaDriver = m[1];
      } catch { /* no NVIDIA kernel module */ }
      hw.vaapi = fs.existsSync('/dev/dri/renderD128');
    } else if (process.platform === 'darwin') {
      const r = await run('system_profiler', ['SPDisplaysDataType', '-json'], 15000);
      try {
        for (const g of JSON.parse(r.stdout).SPDisplaysDataType || []) {
          hw.gpus.push({ vendor: vendorOf(`${g.spdisplays_vendor || ''} ${g.sppci_model || g._name}`), name: g.sppci_model || g._name, driver: '' });
        }
      } catch { /* ignore */ }
    }
  } catch { /* detection is best effort */ }
  const nv = hw.gpus.find((g) => g.vendor === 'nvidia');
  if (nv && !hw.nvidiaDriver && /^\d+\.\d+$/.test(nv.driver)) hw.nvidiaDriver = nv.driver;
  if (nv && hw.nvidiaDriver) nv.driver = hw.nvidiaDriver;
  return hw;
}

/** Hardware encoders worth trying on this machine, best first. */
function candidateEncoders(hw) {
  const v = new Set(hw.gpus.map((g) => g.vendor));
  const list = [];
  if (hw.os === 'darwin') list.push('h264_videotoolbox');
  if (v.has('nvidia')) list.push('h264_nvenc');
  if (v.has('intel')) list.push('h264_qsv');
  if (v.has('amd') && hw.os === 'win32') list.push('h264_amf');
  if (hw.os === 'linux' && hw.vaapi) list.push('h264_vaapi');
  if (hw.os === 'win32' && v.has('qualcomm')) list.push('h264_mf');
  return list;
}

/**
 * Encodes a few frames with each encoder to see which really work
 * (compiled-in is not enough: drivers and devices decide).
 */
async function testEncoders(ffmpeg, encoders) {
  const results = {};
  for (const enc of encoders) {
    const pre = enc === 'h264_vaapi' ? ['-vaapi_device', '/dev/dri/renderD128'] : [];
    const vf = enc === 'h264_vaapi' ? ['-vf', 'format=nv12,hwupload'] : ['-pix_fmt', enc === 'h264_qsv' ? 'nv12' : 'yuv420p'];
    const t0 = Date.now();
    const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', ...pre, '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-frames:v', '10', ...vf, '-c:v', enc, '-f', 'null', '-'], 20000);
    const err = (r.stderr || '').trim().split(/\r?\n/).filter(Boolean);
    results[enc] = r.code === 0
      ? { ok: true, ms: Date.now() - t0 }
      : { ok: false, error: (err.find((l) => /driver|required|not|fail|cannot|unsupported/i.test(l)) || err[0] || `exit ${r.code}`).replace(/^\[[^\]]+\]\s*/, '') };
  }
  return results;
}

module.exports = { detect, candidateEncoders, testEncoders, nvidiaFromWindowsVersion };
