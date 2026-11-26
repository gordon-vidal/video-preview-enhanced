'use strict';
// Start-up time and memory in a real VS Code (docs/notes/startup-memory.md).
//   startup-gpu / startup-wasm / startup-native: open a clip in a fresh VS Code (cold: the
//       extension activates, nothing compiled yet), close it, open it twice more (warm). Each
//       open: command to first frame, and the phases from the extension's and the webview's
//       start-up timelines (VPE_LOG only: "startup host {...}", "webview: startup {...}").
//   memory / memory-8gb: 4K HEVC 10-bit in the built-in decoder: plays, then paused (decodes
//       ahead up to the budget, the "Fully decoded" cache); the private memory of the extension
//       host, the webview's renderer and the whole VS Code process tree, before and at peak.
//       memory-8gb emulates an 8 GB machine (VPE_TOTALMEM, test only).
// Timings are only comparable when run through test/benchq.js. Nothing is judged except that
// the clips open; the numbers are in the results (and the runner's JSON).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const caseMedia = require('../../media/make_cases_media');

const res = (name, problems, extra = {}) => ({ name, ok: !problems.length, problems, ...extra });
const GB = 1024 ** 3;

/** Phases (ms) from the host and webview timelines of one open. */
function phases(t0, host, web) {
  const d = (a, b) => (a && b ? b - a : undefined);
  const p = {
    total: d(t0, web.firstFrame),
    cliToSession: d(t0, host.session),
    sessionToFirstFrame: d(host.session, web.firstFrame),
    activate: host.activated && host.activate >= t0 ? d(host.load, host.activated) : 0,
    webviewCreate: d(host.session, web.origin), // panel + iframe until the page's navigation starts
    pageLoad: d(web.origin, web.ready), // HTML, CSS, 12 scripts, parse and run
    hostDecide: d(host.ready, host.posted), // ffmpeg lookup, ffprobe, decision
    toEngine: d(web.ready, web.engine), // ready -> 'libav' message -> engine (or the preload)
    libavFetch: d(web.engine, web.libavFetched),
    libavInit: d(web.libavFetched, web.libavReady), // worker: importScripts + wasm compile/instantiate
    openStreams: d(web.libavReady || web.engine, web.streams), // demuxer open, first block reads (native: ffmpeg starts)
    configure: d(web.streams, web.configured),
    firstFrame: d(web.configured || web.streams, web.firstFrame),
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

async function openTimed(vs, h, clip, label, expectNative) {
  const file = path.basename(clip);
  const tag = `[${file}]`;
  const t0 = Date.now();
  const from = await h.openClip(vs, path.join(h.MEDIA, clip));
  await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] webview: first frame shown`), { from, timeout: 60000, what: `${file}: first frame` });
  const hl = await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] startup host `), { from, timeout: 5000 }).catch(() => null);
  const wl = await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] webview: startup `), { from, timeout: 5000 }).catch(() => null);
  const host = hl ? JSON.parse(hl.replace(/^.*?startup host /, '')) : {};
  const web = wl ? JSON.parse(wl.replace(/^.*?webview: startup /, '')) : {};
  if (expectNative && (host.path !== 'native' || !web.nativeDraw)) throw new Error(`${file}: native decoder did not show the first frame`);
  const init = vs.lines.slice(from).filter((l) => l.includes(tag) && /init: libav ready/.test(l)).map((l) => Number((/in (\d+) ms/.exec(l) || [])[1]));
  const ph = phases(t0, host, web);
  if (host.path === 'native') {
    const lines = vs.lines.slice(from).filter((l) => l.includes(tag));
    const timeOf = (re) => {
      const line = lines.find((l) => re.test(l));
      return line ? Date.parse(line.split(' ')[0]) : undefined;
    };
    const decoded = timeOf(/native: first frame \d+ ms after start/);
    const sent = timeOf(/native: first frame sent/);
    const connected = /connected after (\d+) ms/.exec(lines.find((l) => /native transport:.*connected after/.test(l)) || '');
    const d = (a, b) => a && b ? b - a : undefined;
    Object.assign(ph, {
      probeToSpawn: d(host.probeStart, host.nativeStart),
      sessionToSpawn: d(host.session, host.nativeStart),
      spawnToProbeDone: d(host.nativeStart, host.probeDone),
      spawnToDecoded: d(host.nativeStart, decoded),
      connect: connected ? Number(connected[1]) : undefined,
      prepareCanvas: d(web.nativePrepareStart, web.nativePrepareEnd),
      decodedToSend: d(decoded, sent),
      sendToReceived: d(sent, web.nativeFrameReceived),
      receivedToDraw: d(web.nativeFrameReceived, web.nativeDraw),
      drawToShown: d(web.nativeDraw, web.firstFrame),
    });
  }
  // What happened, ms after the command (the extension's log lines carry their time).
  const trace = vs.lines.slice(from).filter((l) => !/ webview: status /.test(l)).map((l) => {
    const m = /^(\S+Z) (.*)$/.exec(l);
    return m ? `${String(Date.parse(m[1]) - t0).padStart(5)} ${m[2].slice(0, 160)}` : l.slice(0, 160);
  });
  console.log(`  ${label.padEnd(5)} ${file}: ${JSON.stringify(ph)} workerInit ${JSON.stringify(init)}`);
  await h.sleep(1500);
  await h.closeClip(vs);
  await h.sleep(800);
  return { label, ...ph, workerInit: init, lib: web.lib, trace };
}

function startupCase(name, file, extra = {}) {
  return {
    name,
    ...extra,
    async run(vs, h) {
      const runs = [];
      const p = [];
      try {
        if (extra.generated && !caseMedia.make(path.basename(file))) throw new Error(`could not generate ${file}`);
        runs.push(await openTimed(vs, h, file, 'cold', extra.ffmpeg));
        for (let i = 1; i <= 2; i++) runs.push(await openTimed(vs, h, file, `warm${i}`, extra.ffmpeg));
      } catch (e) { p.push(e.message); }
      return [res(file, p, { runs })];
    },
  };
}

const restore = {
  name: 'startup-restore',
  ffmpeg: true,
  async run(vs, h) {
    const background = 'hevc_10_2160p.mp4';
    const foreground = 'hevc_8_1080p.mp4';
    const fileLog = (file, message) => new RegExp(h.esc(`[${file}] ${message}`));
    const firstFrame = (file, from) => vs.waitLog(fileLog(file, 'webview: first frame shown'), { from, timeout: 60000 });
    await firstFrame(background, await h.openClip(vs, path.join(h.MEDIA, background)));
    await firstFrame(foreground, await h.openClip(vs, path.join(h.MEDIA, foreground)));
    const from = vs.mark();
    vs.send({ command: 'workbench.action.reloadWindow' });
    // A reload restores both editor tabs in the same workspace. Wait for the selected one.
    await firstFrame(foreground, from);
    const snapshot = vs.mark();
    // The new extension host starts the command stream at line one.
    fs.writeFileSync(`${vs.log}.cmd`, `${JSON.stringify({ action: 'tabs' })}\n`);
    const tabLog = await vs.waitLog(/debug tabs: /, { from: snapshot });
    const tabs = JSON.parse(tabLog.replace(/^.*?debug tabs: /, ''));
    const problems = [];
    if (!tabs.some((t) => t.label === background && !t.active)) problems.push('background tab was not restored');
    const beforeReveal = vs.lines.slice(from, vs.mark()).filter((l) => l.includes(`[${background}]`));
    if (beforeReveal.some((l) => /player resolve started|viewer opened|startup host/.test(l))) problems.push('background tab started decoding before it was shown');
    const shown = await h.openClip(vs, path.join(h.MEDIA, background));
    await vs.waitLog(fileLog(background, 'player resolve started'), { from: shown });
    await firstFrame(background, shown);
    return [res('background-probe', problems, {
      beforeReveal, onReveal: vs.lines.slice(shown).filter((l) => l.includes(`[${background}]`) && /player resolve started|session resolved|viewer opened/.test(l)),
    })];
  },
};

// ---- memory ------------------------------------------------------------------------------

/** Every process under pid: { pid, ppid, priv (private bytes), ws, kind }. */
function processTree(rootPid) {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'Code.exe\' or Name=\'ffmpeg.exe\' or Name=\'ffprobe.exe\'" | '
    + 'Select-Object ProcessId,ParentProcessId,PrivatePageCount,WorkingSetSize,CommandLine | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  let all = [];
  try { all = [].concat(JSON.parse(r.stdout || '[]')); } catch { return []; }
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const out = [];
  const walk = (pid) => {
    for (const p of kids.get(pid) || []) {
      const cl = p.CommandLine || '';
      const kind = /--type=renderer/.test(cl) ? 'renderer' : /--type=gpu-process/.test(cl) ? 'gpu'
        : /node\.mojom\.NodeService/.test(cl) ? 'node' : /--type=/.test(cl) ? (/--type=(\S+)/.exec(cl) || [])[1] : /ff(mpeg|probe)/i.test(cl) ? 'ffmpeg' : 'main';
      out.push({ pid: p.ProcessId, ppid: p.ParentProcessId, priv: Number(p.PrivatePageCount) || 0, ws: Number(p.WorkingSetSize) || 0, kind });
      walk(p.ProcessId);
    }
  };
  const root = all.find((p) => p.ProcessId === rootPid);
  if (root) out.push({ pid: root.ProcessId, ppid: root.ParentProcessId, priv: Number(root.PrivatePageCount) || 0, ws: Number(root.WorkingSetSize) || 0, kind: 'main' });
  walk(rootPid);
  return out;
}

/** The Code.exe the hidden launcher started (vs.pid is python's child, Code.exe itself or its launcher). */
function codeRoot(vs) {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  const all = [].concat(JSON.parse(r.stdout || '[]'));
  const me = all.find((p) => p.ProcessId === vs.pid);
  if (me && /^code\.exe$/i.test(me.Name)) return vs.pid;
  const child = all.find((p) => p.ParentProcessId === vs.pid && /^code\.exe$/i.test(p.Name));
  return child ? child.ProcessId : vs.pid;
}

const MB = (b) => Math.round(b / 1e6);

function snapshot(root, extPid, baseRenderers) {
  const tree = processTree(root);
  const ext = tree.find((p) => p.pid === extPid);
  // The webview's renderer: a renderer that wasn't there before the clip opened (site isolation),
  // else the biggest one.
  const rends = tree.filter((p) => p.kind === 'renderer');
  const fresh = rends.filter((p) => !baseRenderers.has(p.pid));
  const web = (fresh.length ? fresh : rends).sort((a, b) => b.priv - a.priv)[0];
  const gpu = tree.find((p) => p.kind === 'gpu');
  return {
    total: MB(tree.reduce((n, p) => n + p.priv, 0)), extHost: ext ? MB(ext.priv) : null, webview: web ? MB(web.priv) : null,
    webviewWs: web ? MB(web.ws) : null, gpu: gpu ? MB(gpu.priv) : null, ffmpeg: MB(tree.filter((p) => p.kind === 'ffmpeg').reduce((n, p) => n + p.priv, 0)),
    n: tree.length,
  };
}

function memoryCase(name, extra = {}) {
  return {
    name,
    ...extra,
    async run(vs, h) {
      const file = 'hevc_10_2160p.mp4';
      const p = [];
      const out = {};
      try {
        // Activate the extension on a small clip first, so the host pid is known and the baseline is "VS Code with the extension".
        const warm = 'hevc_8_1080p.mp4';
        const f0 = await h.openClip(vs, path.join(h.MEDIA, warm));
        await vs.waitLog(new RegExp(`\\[${h.esc(warm)}\\] webview: first frame shown`), { from: f0, timeout: 60000 });
        await h.closeClip(vs);
        await h.sleep(4000);
        const act = vs.lines.find((l) => /activated: .*pid (\d+)/.test(l));
        const extPid = act ? Number(/pid (\d+)/.exec(act)[1]) : 0;
        const root = codeRoot(vs);
        const base = processTree(root);
        const baseRenderers = new Set(base.filter((x) => x.kind === 'renderer').map((x) => x.pid));
        out.before = snapshot(root, extPid, new Set());
        const from = await h.openClip(vs, path.join(h.MEDIA, file));
        await vs.waitLog(new RegExp(`\\[${h.esc(file)}\\] webview: first frame shown`), { from, timeout: 60000 });
        const peak = { total: 0, extHost: 0, webview: 0, gpu: 0, ffmpeg: 0 };
        const samples = [];
        const sample = (phase) => {
          const s = snapshot(root, extPid, baseRenderers);
          samples.push({ phase, ...s });
          for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], s[k] || 0);
        };
        for (let i = 0; i < 5; i++) { sample('playing'); await h.sleep(1000); }
        vs.send({ action: 'pause', name: file });
        for (let i = 0; i < 10; i++) { sample('paused'); await h.sleep(1000); }
        const pool = vs.lines.slice(from).filter((l) => l.includes(`[${file}]`) && /pool: |memory budget|budgets/.test(l)).slice(0, 6);
        // Paused for a while: the decode-ahead cache is full, the steady state.
        const med = (k) => { const v = samples.filter((x) => x.phase === 'paused').slice(-5).map((x) => x[k] || 0).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
        out.paused = { total: med('total'), extHost: med('extHost'), webview: med('webview'), gpu: med('gpu') };
        out.peak = peak;
        out.samples = samples;
        out.poolLines = pool;
        console.log(`  ${name}: before ${JSON.stringify(out.before)} peak ${JSON.stringify(peak)} paused ${JSON.stringify(out.paused)}`);
        for (const l of pool) console.log(`    ${l.replace(/^\S+ /, '')}`);
      } catch (e) { p.push(e.message); }
      await h.closeClip(vs).catch(() => {});
      return [res(file, p, out)];
    },
  };
}

module.exports = [
  startupCase('startup-gpu', 'h264_aac_anim_1080p.mp4'),
  startupCase('startup-wasm', 'hevc_8_1080p.mp4'),
  startupCase('startup-native', 'hevc_10_2160p.mp4', { ffmpeg: true }),
  startupCase('startup-av1-mp4', 'av1_10_2160p.mp4', { ffmpeg: true }),
  startupCase('startup-h264-mp4', 'h264_10_1080p.mp4', { ffmpeg: true }),
  startupCase('startup-prores-mov', 'prores_proxy_1080p.mov', { ffmpeg: true }),
  startupCase('startup-vp9-webm', 'vp9_2160p.webm', { ffmpeg: true }),
  startupCase('startup-vp9-mp4', 'cases/startup_vp9_cfr.mp4', { ffmpeg: true, generated: true }),
  startupCase('startup-h264-mov', 'cases/startup_h264_422.mov', { ffmpeg: true, generated: true }),
  startupCase('startup-hevc-mkv', 'cases/startup_hevc.mkv', { ffmpeg: true, generated: true }),
  startupCase('startup-av1-mkv', 'cases/startup_av1.mkv', { ffmpeg: true, generated: true }),
  restore,
  memoryCase('memory'),
  memoryCase('memory-8gb', { env: { VPE_TOTALMEM: String(8 * GB) } }),
  // Run-to-run spread: the same two again (VPE_MEMORY_REPEAT=1).
  ...(process.env.VPE_MEMORY_REPEAT ? [memoryCase('memory-again'), memoryCase('memory-8gb-again', { env: { VPE_TOTALMEM: String(8 * GB) } })] : []),
];
