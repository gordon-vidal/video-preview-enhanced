#!/usr/bin/env node
'use strict';
// The extension in a real VS Code, on a hidden desktop (Windows only, no admin).
//
//   node test/vscode/run.js [--code <Code.exe>] [--ffmpeg <ffmpeg.exe or its bin dir>]
//                           [--grep re | --only re] [--seconds N] [--keep] [--json file] [--activation]
//
// Starts VS Code with a fresh temporary profile (user data + extensions dirs), this checkout
// as --extensionDevelopmentPath and VPE_LOG set, on its own Windows desktop
// (test/vscode/hidden_launch.py): nothing appears on the user's screen. Files are opened through
// VS Code's CLI (also started on that desktop, so a CLI that finds no running instance starts it
// there too), then the extension's test hook takes JSON lines appended to <VPE_LOG>.cmd (debug
// actions for the players, allowed commands) and everything the extension and its webviews log
// lands in VPE_LOG, which this runner tails.
//
// Suite (about 2-3 min):
//   wcprobe   WebCodecs/AudioDecoder/<video> support in the real webview (H.264 and VP8 expected)
//   play/*    test/media clips: first frame, decoder path, playing, a seek spot check, and
//             shownFps over --seconds (default 5) as a real-VS-Code speed figure; rows taken
//             while other processes load the CPU (test/loadmon.js) are marked noisy
//   native/*  a second VS Code with videoPreviewEnhanced.ffmpegPath set (--ffmpeg, VPE_FFMPEG,
//             or ffmpeg on PATH): the logged decision, and the picture playing
// --activation: only the check whether a file given on the first command line opens in the
// extension (it does not with --extensionDevelopmentPath; see README.md in this folder).
//
// Always cleans up: kills the VS Code process tree (and any Code.exe still using the temp
// profile), deletes the profile unless --keep. Timing figures are only comparable when run
// through test/benchq.js. Results: printed, and as JSON (test/vscode/out/run-<time>.json or --json).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lm = require('../loadmon');

const ROOT = path.resolve(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'test', 'media');
const LAUNCHER = path.join(__dirname, 'hidden_launch.py');
const OUT = path.join(__dirname, 'out');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => p.replace(/\\/g, '/');

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
if (process.platform !== 'win32') { console.error('test/vscode runs on Windows only (hidden desktops)'); process.exit(2); }

// Variables VS Code (or an agent running inside it) leaves in the environment. Inherited, they
// would make Code.exe run as plain Node (ELECTRON_RUN_AS_NODE) or the CLI talk to the parent VS Code.
const STRIP = ['ELECTRON_RUN_AS_NODE', 'VSCODE_PID', 'VSCODE_IPC_HOOK', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_CWD', 'VSCODE_NLS_CONFIG',
  'VSCODE_HANDLES_UNCAUGHT_ERRORS', 'VSCODE_CODE_CACHE_PATH', 'VSCODE_ESM_ENTRYPOINT', 'VSCODE_DEV', 'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
  'VSCODE_L10N_BUNDLE_LOCATION', 'VSCODE_INJECTION', 'VSCODE_GIT_IPC_HANDLE', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN'];

function findCode() {
  // The pinned portable build (node test/vscode/get_code.js) first: the user's install can be
  // blocked by its updater and changes version. --installed skips it.
  const portable = flag('--installed') ? '' : require('./get_code').portableCode();
  const cands = [opt('--code'), process.env.VPE_CODE, portable, 'C:/Program Files/Microsoft VS Code/Code.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')].filter(Boolean);
  const exe = cands.find((c) => fs.existsSync(c));
  if (!exe) throw new Error(`Code.exe not found (tried ${cands.join(', ')}); pass --code`);
  const dir = path.dirname(exe);
  // cli.js sits in resources/app/out, or under a commit-named folder (newer installs): take the one bin/code.cmd names.
  let cli = path.join(dir, 'resources', 'app', 'out', 'cli.js');
  try {
    const m = /"%~dp0\.\.\\([^"]*cli\.js)"/.exec(fs.readFileSync(path.join(dir, 'bin', 'code.cmd'), 'utf8'));
    if (m) cli = path.join(dir, m[1]);
  } catch { /* no code.cmd */ }
  if (!fs.existsSync(cli)) throw new Error(`VS Code CLI script not found at ${cli}`);
  return { exe, cli };
}

/** PATH without the folders that hold ffmpeg, so the play/ instance takes the built-in decoder
 * like a user without ffmpeg (the extension falls back to PATH when nothing else is set). */
function pathWithoutFfmpeg() {
  const exts = ['.exe', '.cmd', '.bat', ''];
  return (process.env.PATH || '').split(path.delimiter)
    .filter((d) => d && !exts.some((e) => fs.existsSync(path.join(d, `ffmpeg${e}`))))
    .join(path.delimiter);
}

function findFfmpeg() {
  const c = opt('--ffmpeg') || process.env.VPE_FFMPEG;
  if (c) return c;
  const r = spawnSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
}

/** One VS Code instance with its own temporary profile, on its own hidden desktop. */
class HiddenCode {
  constructor({ code, settings, env: extraEnv, devPath = true, keep = false, tag = 'vpe' }) {
    this.code = code;
    this.devPath = devPath;
    this.keep = keep;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-vscode-`));
    this.desktop = `${tag}-${process.pid}-${path.basename(this.dir).slice(-6)}`;
    this.user = path.join(this.dir, 'user');
    this.ext = path.join(this.dir, 'ext');
    this.work = path.join(this.dir, 'work');
    this.log = fwd(path.join(this.dir, 'vpe.log'));
    for (const d of [path.join(this.user, 'User'), this.ext, this.work]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(this.user, 'User', 'settings.json'), JSON.stringify({
      'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
      'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none', 'workbench.enableExperiments': false,
      'chat.disableAIFeatures': true, 'window.restoreWindows': 'none', 'files.hotExit': 'off',
      // `code file.mp4` opens the extension's (optional) editor; also makes VS Code wait for the
      // extension when a file comes on the first command line of a fresh profile (README.md here).
      'workbench.editorAssociations': { '*.mp4': 'videoPreviewEnhanced.playerOptional', '*.webm': 'videoPreviewEnhanced.playerOptional' },
      ...(settings || {}),
    }, null, 1));
    const env = Object.fromEntries(STRIP.map((k) => [k, null]));
    env.VPE_LOG = this.log;
    Object.assign(env, extraEnv);
    this.envMain = path.join(this.dir, 'env-main.json');
    fs.writeFileSync(this.envMain, JSON.stringify(env));
    this.envCli = path.join(this.dir, 'env-cli.json');
    fs.writeFileSync(this.envCli, JSON.stringify({ ...env, ELECTRON_RUN_AS_NODE: '1' }));
    this.lines = [];
    this.waiters = new Set();
    this.pos = 0;
    this.pid = 0;
  }

  /** Launches Code.exe on the hidden desktop; extra args (e.g. a file) go on its command line. */
  async start(extra = []) {
    const args = ['--user-data-dir', this.user, '--extensions-dir', this.ext, '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--disable-telemetry', '--new-window'];
    if (this.devPath) args.push(`--extensionDevelopmentPath=${ROOT}`);
    args.push(this.work, ...extra);
    const out = await run('python', ['-I', LAUNCHER, this.desktop, this.envMain, this.code.exe, ...args]);
    this.pid = Number(out.trim().split(/\s+/).pop());
    if (!this.pid) throw new Error(`hidden launch failed: ${out}`);
    this.tail = setInterval(() => this.readLog(), 150);
    return this.pid;
  }

  /** VS Code's CLI, also on the hidden desktop (waits for it; it forwards to the running instance). */
  cli(args) {
    return run('python', ['-I', LAUNCHER, '--wait', this.desktop, this.envCli, this.code.exe, this.code.cli,
      '--user-data-dir', this.user, '--extensions-dir', this.ext, ...args]);
  }

  /** A line for the extension's test hook (debug action for players, or an allowed command). */
  send(obj) { fs.appendFileSync(`${this.log}.cmd`, `${JSON.stringify(obj)}\n`); }

  readLog() {
    let buf;
    try {
      const fd = fs.openSync(this.log, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= this.pos) { fs.closeSync(fd); return; }
      buf = Buffer.alloc(size - this.pos);
      fs.readSync(fd, buf, 0, buf.length, this.pos);
      fs.closeSync(fd);
    } catch { return; }
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return;
    this.pos += Buffer.byteLength(text.slice(0, end + 1));
    for (const raw of text.slice(0, end).split('\n')) {
      const line = raw.replace(/\r$/, '');
      this.lines.push(line);
      for (const w of [...this.waiters]) if (w.idx <= this.lines.length - 1 && w.re.test(line)) { this.waiters.delete(w); clearTimeout(w.timer); w.resolve(line); }
    }
  }

  /** The first log line from index `from` on that matches; rejects after `timeout` ms. */
  waitLog(re, { from = 0, timeout = 20000, what } = {}) {
    const hit = this.lines.slice(from).find((l) => re.test(l));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { re, idx: from, resolve };
      w.timer = setTimeout(() => { this.waiters.delete(w); reject(new Error(`timed out after ${timeout / 1000} s waiting for ${what || re}`)); }, timeout);
      this.waiters.add(w);
    });
  }

  mark() { this.readLog(); return this.lines.length; }

  /** Ends VS Code (process tree, and anything else still using this profile); the profile stays. */
  async kill() {
    clearInterval(this.tail);
    if (this.pid) spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    for (const pid of codePidsUsing(this.dir)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    this.pid = 0;
    await sleep(1000);
  }

  async stop() {
    await this.kill();
    if (this.keep) { console.log(`kept profile ${this.dir}`); return; }
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(this.dir, { recursive: true, force: true }); return; } catch { await sleep(500); }
    }
    console.warn(`could not delete ${this.dir}`);
  }
}

/** A page of this instance got no WebGL2 context (media/player.js, compare.js log it). */
const NO_WEBGL = /webview: decoder could not start: WebGL2 is not available/;

/** Keeps an instance's VS Code logs (main.log and the rest: GPU process exits) and our log in out/ for later. */
function saveGpuLogs(vs, name, attempt) {
  const dest = path.join(OUT, `nogl-${new Date().toISOString().replace(/[:.]/g, '-')}-${name}-${attempt}`);
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'vpe.log'), vs.lines.join('\n'));
    const logs = path.join(vs.user, 'logs');
    if (fs.existsSync(logs)) fs.cpSync(logs, path.join(dest, 'logs'), { recursive: true });
    console.log(`  VS Code logs of the instance without WebGL2: ${dest}`);
  } catch (e) { console.warn(`could not keep the logs: ${e.message}`); }
}

function codePidsUsing(dir) {
  const needle = path.basename(dir).replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process -Filter "Name='Code.exe' or Name='python.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split(/\s+/).map(Number).filter((n) => n > 0 && n !== process.pid);
}

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out`)); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(out); else reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${code}: ${err || out}`)); });
  });
}

// ---- the suite ---------------------------------------------------------------------------

/** Clips: what decodes them in VS Code (webcodecs = H.264/VP8 WebCodecs, soft = WebAssembly). */
const CLIPS = [
  { file: 'mpeg2_1080p.mpg', expect: 'soft' },
  { file: 'h264_8_2160p.mp4', expect: 'webcodecs' },
  { file: 'hevc_10_2160p.mp4', expect: 'soft' },
  { file: 'av1_8_1080p.mp4', expect: 'soft' },
  { file: 'vp9_2160p.webm', expect: 'soft' },
  { file: 'prores_proxy_1080p.mov', expect: 'soft' },
  { file: 'h264_aac_anim_1080p.mp4', expect: 'webcodecs', sound: true },
  { file: 'hevc_8_1080p.mp4', expect: 'soft' },
  // The listing's claim: H.264 on the GPU decoder in every container, VP8 in WebM (test/media/make_containers.js).
  // (.ts is TypeScript in VS Code: the extension doesn't claim it; README "Formats".)
  ...['mkv', 'mov', 'm2ts', 'flv', 'avi'].map((x) => ({ file: `containers/h264_aac.${x}`, expect: 'webcodecs', sound: true })),
  { file: 'containers/vp8_vorbis.webm', expect: 'webcodecs', sound: true },
];
const NATIVE_CLIPS = ['hevc_10_2160p.mp4', 'av1_10_2160p.mp4'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

/** Opens a clip as `code <file>` would (the profile associates .mp4/.webm with the extension's editor). */
async function openClip(vs, file) {
  const from = vs.mark();
  await vs.cli(['--reuse-window', file]);
  return from;
}

/** Closes every editor (a hidden player tab would keep decoding: retainContextWhenHidden). */
async function closeClip(vs) {
  vs.send({ command: 'workbench.action.closeAllEditors' });
  await sleep(700);
}

async function playClip(vs, clip, { seconds, native, onShown }) {
  const name = path.basename(clip.file);
  const tag = `\\[${esc(name)}\\]`;
  const r = { clip: name, ok: true, problems: [] };
  const bad = (m) => { r.ok = false; r.problems.push(m); };
  const t0 = Date.now();
  const idle = await lm.sample(1); // others' load, before our clip runs
  r.othersLoad = Math.round(idle.load);
  const from = await openClip(vs, path.join(MEDIA, clip.file));
  await vs.waitLog(new RegExp(`${tag} webview: first frame shown`), { from, timeout: 45000, what: `${name}: first frame` });
  r.openMs = Date.now() - t0; // command to first frame
  const dec = native ? await vs.waitLog(new RegExp(`${tag} decoder: `), { from, timeout: 8000 }).catch(() => null)
    : vs.lines.slice(from).find((l) => new RegExp(`${tag} decoder: `).test(l));
  if (dec) r.decision = dec.replace(/^.*?decoder: /, '');
  // The extension appends log lines asynchronously: on a busy machine they can come late or out of order.
  const streams = await vs.waitLog(new RegExp(`${tag} webview: streams: `), { from, timeout: 8000 }).catch(() => null);
  if (streams) {
    const m = /-> video (\w+), audio (\w+)/.exec(streams);
    if (m) { r.video = m[1]; r.audio = m[2]; }
  }
  if (native) r.video = 'native';
  if (clip.expect && r.video !== clip.expect) bad(`decoded by ${r.video}, expected ${clip.expect}`);
  if (onShown) await onShown(name);
  // shownFps from the 2 s status lines; the first window after opening is skipped.
  const fromPlay = vs.mark();
  await sleep(seconds * 1000 + 2500);
  vs.mark();
  const status = vs.lines.slice(fromPlay).filter((l) => new RegExp(`${tag} webview: status `).test(l));
  const fpsList = status.map((l) => Number((/shownFps=([\d.]+)/.exec(l) || [])[1])).filter((x) => Number.isFinite(x));
  r.fps = Math.max(0, ...status.map((l) => Number((/ fps=([\d.]+)/.exec(l) || [])[1]) || 0)) || null;
  const win = fpsList.slice(1);
  r.shownFps = win.length ? med(win) : fpsList.length ? fpsList[0] : null;
  r.shownFpsWindows = fpsList;
  const playing = status.some((l) => /playing=true/.test(l));
  if (!playing) bad('not playing');
  if (!fpsList.slice(1).some((x) => x > 0)) bad(`no frames shown after the first window (${JSON.stringify(fpsList)})`);
  if (clip.sound) {
    const last = status[status.length - 1] || '';
    r.sound = { amode: r.audio, ac: (/ ac=(\S+)/.exec(last) || [])[1], clock: (/clock=(\S+)/.exec(last) || [])[1], sources: Number((/playingSources=(\d+)/.exec(last) || [])[1]) };
    if (!r.audio || r.audio === 'none') bad('no sound stream picked');
  }
  // Seek spot check: paused, the middle of frame k must come to show frame k (report frame= is
  // 1-based). Polled (test/vscode/lib.js expectFrame does the same): a 4K seek in WebAssembly takes seconds.
  if (!r.fps && !native) r.note = 'no frame rate logged: seek check skipped';
  if (r.fps && !native) {
    const report = async () => {
      const m0 = vs.mark();
      vs.send({ action: 'report', name, delay: 0 });
      const rep = await vs.waitLog(new RegExp(`${tag} webview: report frame=`), { from: m0, timeout: 10000, what: `${name}: report` });
      return { frame: Number(/frame=(\d+)/.exec(rep)[1]) - 1, frames: Number((/frames=(\d+)/.exec(rep) || [])[1]) || Infinity, playing: /playing=true/.test(rep) };
    };
    vs.send({ action: 'pause', name });
    const p0 = Date.now();
    let rep0;
    while ((rep0 = await report()).playing && Date.now() - p0 < 5000) await sleep(200);
    const seeks = [];
    // Within the clip: the ProRes one has 24 frames (a seek past the end shows the last frame).
    for (const k of [Math.min(Math.round(r.fps * 1.2) + 3, rep0.frames - 2), 7]) {
      vs.send({ action: 'seek', name, t: (k + 0.5) / r.fps });
      const s0 = Date.now();
      let got = null;
      try {
        for (;;) {
          await sleep(250);
          got = (await report()).frame;
          if (got === k || Date.now() - s0 > 12000) break;
        }
      } catch (e) { bad(e.message); }
      seeks.push({ want: k, got, ms: Date.now() - s0 });
      if (got !== k) bad(`seek to frame ${k} showed ${got} after ${((Date.now() - s0) / 1000).toFixed(1)} s`);
    }
    r.seeks = seeks;
  }
  const errs = vs.lines.slice(from).filter((l) => new RegExp(`${tag} (error:|webview: (error:|unhandled rejection))`).test(l));
  if (errs.length) bad(`errors: ${errs.slice(0, 2).join(' | ')}`);
  if (clip.known) {
    const k = r.problems.filter((m) => clip.known.re.test(m));
    if (k.length) { r.known = `${clip.known.why}: ${k.join('; ')}`; r.problems = r.problems.filter((m) => !k.includes(m)); r.ok = !r.problems.length; }
  }
  r.noisy = lm.verdict(r.othersLoad);
  await closeClip(vs);
  return r;
}

async function wcprobe(vs, name) {
  const from = vs.mark();
  vs.send({ action: 'wcprobe', name });
  const l = await vs.waitLog(/webview: wcprobe /, { from, timeout: 15000, what: 'wcprobe' });
  const r = JSON.parse(l.replace(/^.*?webview: wcprobe /, ''));
  const problems = [];
  for (const where of ['page', 'worker']) {
    const m = r[where];
    if (!m || typeof m !== 'object') { problems.push(`${where}: ${m}`); continue; }
    if (!/Y/.test(m.h264 || '')) problems.push(`${where}: no H.264`);
    if (!/Y/.test(m.vp8 || '')) problems.push(`${where}: no VP8`);
  }
  return { ok: !problems.length, problems, ...r };
}

async function activationCheck(code) {
  const file = path.join(MEDIA, 'mpeg2_1080p.mpg');
  const out = {};
  // 1. The file on the first command line.
  let vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact' });
  try {
    await vs.start([file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.firstCommandLine = 'opened in the extension'; } catch { out.firstCommandLine = 'not opened in the extension (no log within 25 s)'; }
    // 2. The same file forwarded to the running instance afterwards.
    const from = vs.mark();
    await vs.cli(['--reuse-window', file]);
    try { await vs.waitLog(/first frame shown/, { from, timeout: 25000 }); out.forwarded = 'opened in the extension'; } catch { out.forwarded = 'not opened (no log within 25 s)'; }
  } finally { await vs.stop(); }
  // 2b. Installed (copied into the profile's extensions dir) instead of --extensionDevelopmentPath.
  vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact', devPath: false });
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const dst = path.join(vs.ext, `${pkg.publisher}.${pkg.name}-${pkg.version}`);
    for (const f of ['package.json', 'LICENSE', 'README.md', 'src', 'media', 'build']) {
      if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(dst, f), { recursive: true });
    }
    await vs.start([file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.installedFirstCommandLine = 'opened in the extension'; } catch { out.installedFirstCommandLine = 'not opened in the extension (no log within 25 s)'; }
  } finally { await vs.stop(); }
  // 3. Launched without a file, then the file forwarded once the window is up (what the suite does).
  // 4. Then the same profile restarted with the file on the first command line.
  vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact' });
  try {
    await vs.start();
    await sleep(4000);
    await vs.cli(['--reuse-window', file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.startThenForward = 'opened in the extension'; } catch { out.startThenForward = 'not opened (no log within 25 s)'; }
    await sleep(2000);
    await vs.kill();
    const from = vs.mark();
    const other = path.join(MEDIA, 'prores_proxy_1080p.mov'); // not open before: not a restored editor
    await vs.start([other]);
    try { await vs.waitLog(/\[prores_proxy_1080p\.mov\] webview: first frame shown/, { from, timeout: 25000 }); out.secondStartFirstCommandLine = 'opened in the extension'; } catch { out.secondStartFirstCommandLine = 'not opened (no log within 25 s)'; }
  } finally { await vs.stop(); }
  // 5. A fresh profile whose settings associate the file type with the extension's editor.
  vs = new HiddenCode({ code, keep: flag('--keep'), tag: 'vpeact', settings: { 'workbench.editorAssociations': { '*.mpg': 'videoPreviewEnhanced.player' } } });
  try {
    await vs.start([file]);
    try { await vs.waitLog(/first frame shown/, { timeout: 25000 }); out.freshWithAssociation = 'opened in the extension'; } catch { out.freshWithAssociation = 'not opened (no log within 25 s)'; }
  } finally { await vs.stop(); }
  return out;
}

/** VS Code's background updater (CodeSetup-*.exe /update, started by a running VS Code when an
 * update is ready). While it runs, a new Code.exe of that install stalls before it writes any log,
 * so every clip times out. Seen on 2026-11-18; finishing or restarting VS Code clears it. */
function updaterRunning() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? [...new Set((r.stdout.match(/"CodeSetup-[^"]*"/gi) || []).map((s) => s.slice(1, -1)))] : [];
}

// --quick: a functional check in about a minute. Two clips (GPU and WebAssembly, one with sound),
// one native clip, the cases, short play windows; fps is recorded but never judged. Several quick
// runs may run at once (each has its own profile and desktop). Speed numbers come only from full
// runs, one at a time (node test/benchq.js node test/vscode/run.js).
const QUICK_CLIPS = ['h264_aac_anim_1080p.mp4', 'hevc_8_1080p.mp4'];
const QUICK_NATIVE = ['hevc_10_1080p.mp4'];

/** Test cases from test/vscode/cases/*.js: { name, settings?, env?, ffmpeg?, run(vs, h) -> [{ name, ok, problems }] }. */
function loadCases() {
  const dir = path.join(__dirname, 'cases');
  if (!fs.existsSync(dir)) return [];
  // A module exports one case or an array of them (each still gets its own instance).
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().flatMap((f) => [].concat(require(path.join(dir, f))));
}

async function main() {
  const code = findCode();
  const upd = /Microsoft VS Code[\\/]Code\.exe$/i.test(code.exe) ? updaterRunning() : [];
  if (upd.length) {
    console.error(`VS Code's updater is running (${upd.join(', ')}): new VS Code instances stall until it ends.`
      + ' Restart VS Code to finish the update, or wait for it, then run again'
      + ' (or use the portable build: node test/vscode/get_code.js).');
    return 2;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const quick = flag('--quick');
  const seconds = Number(opt('--seconds', quick ? 2 : 5));
  const grep = opt('--grep') || opt('--only') ? new RegExp(opt('--grep') || opt('--only')) : null;
  const want = (n) => !grep || grep.test(n);
  const res = { started: new Date().toISOString(), code: code.exe, host: os.hostname(), cpus: os.cpus().length, tests: [] };
  const add = (name, r) => { res.tests.push({ name, ...r }); console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name}${r.problems && r.problems.length ? `: ${r.problems.join('; ')}` : ''}`); };
  if (flag('--activation')) {
    const a = await activationCheck(code);
    console.log(JSON.stringify(a, null, 1));
    return 0;
  }
  const tStart = Date.now();
  let vs = new HiddenCode({ code, keep: flag('--keep'), env: { PATH: pathWithoutFfmpeg() } });
  const pool = quick ? CLIPS.filter((c) => QUICK_CLIPS.includes(c.file)) : CLIPS;
  const clips = pool.filter((c) => want(`play/${c.file}`));
  if (want('wcprobe') && !clips.length) clips.push(CLIPS[0]);
  try {
    await vs.start();
    console.log(`VS Code pid ${vs.pid} on hidden desktop ${vs.desktop}, profile ${vs.dir}`);
    await sleep(3000); // the window's single-instance pipe is up well before this
    // The first clip activates the extension; wcprobe runs in its webview.
    let probe = want('wcprobe');
    for (const clip of clips) {
      const name = `play/${clip.file}`;
      const onShown = probe ? async (n) => {
        probe = false;
        try { add('wcprobe', await wcprobe(vs, n)); } catch (e) { add('wcprobe', { ok: false, problems: [e.message] }); }
      } : null;
      try {
        const r = await playClip(vs, clip, { seconds, onShown });
        if (want(name)) add(name, r);
      } catch (e) { add(name, { ok: false, problems: [e.message] }); try { await closeClip(vs); } catch { /* gone */ } }
    }
  } finally { await vs.stop(); }
  // Native ffmpeg in a second instance (a fresh profile with ffmpegPath set).
  const ff = findFfmpeg();
  const natives = (quick ? QUICK_NATIVE : NATIVE_CLIPS).filter((f) => want(`native/${f}`));
  if (natives.length && !ff) add('native', { ok: true, skipped: 'no ffmpeg (--ffmpeg, VPE_FFMPEG or PATH)', problems: [] });
  else if (natives.length) {
    vs = new HiddenCode({ code, keep: flag('--keep'), settings: { 'videoPreviewEnhanced.ffmpegPath': fwd(ff) } });
    try {
      await vs.start();
      await sleep(3000);
      for (const f of natives) {
        const name = `native/${f}`;
        try {
          const r = await playClip(vs, { file: f }, { seconds, native: true });
          if (!/^native ffmpeg/.test(r.decision || '')) { r.ok = false; r.problems.push(`decision: ${r.decision || 'none logged'}`); }
          add(name, r);
        } catch (e) { add(name, { ok: false, problems: [e.message] }); try { await closeClip(vs); } catch { /* gone */ } }
      }
    } finally { await vs.stop(); }
  }
  // Cases: each in its own instance with its own settings (no ffmpeg on PATH unless it asks for it).
  const h = { MEDIA, sleep, fwd, esc, openClip, closeClip, playClip, seconds, quick, ffmpeg: ff };
  for (const c of loadCases().filter((x) => want(`case/${x.name}`))) {
    if (c.ffmpeg && !ff) { add(`case/${c.name}`, { ok: true, skipped: 'no ffmpeg', problems: [] }); continue; }
    const settings = { ...(c.ffmpeg ? { 'videoPreviewEnhanced.ffmpegPath': fwd(ff) } : {}), ...(c.settings || {}) };
    // An instance whose GPU process gave the pages no WebGL2 (seen about once per full run since 2026-11-20, on a
    // random case, never reproduced alone) fails every engine result of that case without saying why: its
    // VS Code logs are kept in out/ and the case runs once more in a fresh instance (the result says so).
    for (let attempt = 1; ; attempt++) {
      vs = new HiddenCode({ code, keep: flag('--keep'), settings, env: { PATH: c.ffmpeg ? process.env.PATH : pathWithoutFfmpeg(), ...(c.env || {}) } });
      let rs;
      try {
        await vs.start();
        await sleep(3000);
        rs = await c.run(vs, h);
      } catch (e) { rs = [{ name: '', ok: false, problems: [e.message] }]; }
      const noGl = vs.lines.some((l) => NO_WEBGL.test(l)) && rs.some((r) => !r.ok);
      if (noGl) saveGpuLogs(vs, c.name, attempt);
      await vs.stop();
      if (noGl && attempt === 1) {
        console.log(`case/${c.name}: no WebGL2 in this VS Code instance (GPU process); once more in a fresh one in 20 s`);
        await sleep(20000); // seen lasting several instances in a row
        continue;
      }
      for (const r of rs) {
        if (attempt > 1) r.retried = 'the first instance had no WebGL2 (GPU process)';
        add(r.name ? `case/${c.name}/${r.name}` : `case/${c.name}`, r);
      }
      break;
    }
  }
  res.seconds = Math.round((Date.now() - tStart) / 1000);
  const file = opt('--json') || path.join(OUT, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(res, null, 1));
  console.log('\nclip                        path       open ms  fps   shown (windows)          load  seeks (frame->shown ms)');
  for (const t of res.tests.filter((x) => x.clip)) {
    console.log(`${t.clip.padEnd(27)} ${String(t.video || '-').padEnd(10)} ${String(t.openMs ?? '-').padEnd(8)} ${String(t.fps ? +t.fps.toFixed(2) : '-').padEnd(5)} ${String(t.shownFps ?? '-').padEnd(5)} ${JSON.stringify(t.shownFpsWindows || []).padEnd(18)} ${String(t.othersLoad).padStart(3)}% ${t.noisy !== 'quiet' ? t.noisy : ''} ${(t.seeks || []).map((s) => `${s.want}->${s.got} ${s.ms}`).join(', ')}`);
  }
  const w = res.tests.find((x) => x.name === 'wcprobe');
  if (w && w.page) console.log(`\nwcprobe page ${JSON.stringify(w.page)}\n        worker ${JSON.stringify(w.worker)}\n        media ${JSON.stringify(w.media)}`);
  for (const t of res.tests.filter((x) => x.known)) console.log(`known: ${t.name}: ${t.known}`);
  for (const t of res.tests.filter((x) => x.retried)) console.log(`retried: ${t.name}: ${t.retried}`);
  console.log(`\n${res.tests.filter((x) => !x.ok).length} failed of ${res.tests.length}, ${res.seconds} s; ${file}`);
  return res.tests.some((x) => !x.ok) ? 1 : 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
module.exports = { HiddenCode, findCode, playClip, closeClip, run };
