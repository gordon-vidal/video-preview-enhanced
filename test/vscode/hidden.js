'use strict';
// A VS Code instance on its own hidden Windows desktop with a temporary profile (layers 3 and 4).
// Used by test/vscode/scenarios.js (layer 3), test/perf/run.js (layer 4) and test/vscode/activation.js. See README.md here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'test', 'media');
const LAUNCHER = path.join(__dirname, 'hidden_launch.py');
const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => p.split('\\').join('/');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

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
      // A page without WebGL2: the instance is broken (its GPU process); every wait ends now, not at its timeout.
      if (NO_WEBGL.test(line)) for (const w of [...this.waiters]) { this.waiters.delete(w); clearTimeout(w.timer); w.reject(new Error(`no WebGL2 in this VS Code instance: ${line.replace(/^.*?webview: /, '')}`)); }
    }
  }

  /** The first log line from index `from` on that matches; rejects after `timeout` ms. */
  waitLog(re, { from = 0, timeout = 20000, what } = {}) {
    const hit = this.lines.slice(from).find((l) => re.test(l));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { re, idx: from, resolve, reject };
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
// Any page line that says so (the decoder's start message, or a page's state echoing its hint: URL pages
// and compare tiles report it only there).
const NO_WEBGL = /webview: .*WebGL2 is not available/;

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

/** VS Code's background updater (CodeSetup-*.exe /update, started by a running VS Code when an
 * update is ready). While it runs, a new Code.exe of that install stalls before it writes any log,
 * so every clip times out. Seen on 2026-11-18; finishing or restarting VS Code clears it. */
function updaterRunning() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? [...new Set((r.stdout.match(/"CodeSetup-[^"]*"/gi) || []).map((s) => s.slice(1, -1)))] : [];
}


module.exports = { HiddenCode, findCode, findFfmpeg, pathWithoutFfmpeg, codePidsUsing, saveGpuLogs, updaterRunning, openClip, closeClip, run, NO_WEBGL, STRIP, ROOT, MEDIA, OUT, sleep, fwd };
