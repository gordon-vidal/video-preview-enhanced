#!/usr/bin/env node
// Screenshots of a real VS Code window on the hidden desktop (nothing appears on screen).
//   node test/vscode/screenshot.js <out.png> <video file> [--wait seconds] [--theme name] [--code Code.exe] [--act '<json>' ...]
// --act: a test-hook line for the player (README "Hooks"), e.g. '{"action":"panel","view":"main"}', sent after the
// wait (VPE_LOG is set only then); the capture follows 2 s later.
// Starts the pinned portable VS Code (test/vscode/get_code.js) with this checkout as the
// development extension and a throwaway profile, opens the file, waits, captures the window
// with PrintWindow (capture_window.py, run on the same hidden desktop), converts it to PNG with
// ffmpeg and cleans up. Needs ffmpeg and Python 3 on PATH.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args.splice(i, 2)[1]; };
const wait = +opt('--wait', 30);
const acts = [];
for (let a = opt('--act', null); a !== null; a = opt('--act', null)) acts.push(JSON.parse(a));
let code = opt('--code', '');
const theme = opt('--theme', ''); // e.g. "Default High Contrast"
const [out, file] = args;
if (!out || !file) { console.error('usage: screenshot.js <out.png> <video> [--wait s] [--code Code.exe]'); process.exit(2); }
const ROOT = path.resolve(__dirname, '..', '..');
if (!code) {
  const base = path.join(__dirname, '.code');
  const v = fs.existsSync(base) ? fs.readdirSync(base)[0] : null;
  code = v && path.join(base, v, 'Code.exe');
}
if (!code || !fs.existsSync(code)) { console.error('no Code.exe: run test/vscode/get_code.js or pass --code'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-shot-'));
const prof = path.join(dir, 'prof'), ext = path.join(dir, 'ext'), desk = 'vpeshot' + process.pid;
fs.mkdirSync(path.join(prof, 'User'), { recursive: true }); fs.mkdirSync(ext);
fs.writeFileSync(path.join(prof, 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
  'extensions.autoUpdate': false, 'update.mode': 'none', 'workbench.enableExperiments': false, ...(theme ? { 'workbench.colorTheme': theme } : {}),
  'chat.disableAIFeatures': true, 'window.restoreWindows': 'none', 'files.hotExit': 'off',
  'workbench.activityBar.location': 'hidden', 'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'window.commandCenter': false, 'workbench.tips.enabled': false, 'breadcrumbs.enabled': false }));
const env = path.join(dir, 'env.json');
// no ffmpeg on PATH: the extension would otherwise start its ffmpeg test and show a toast
const PATH = (process.env.PATH || process.env.Path || '').split(path.delimiter)
  .filter((d) => d && !fs.existsSync(path.join(d, 'ffmpeg.exe'))).join(path.delimiter);
const noWebgl = process.env.VPE_NO_WEBGL === '1'; // the error screen without WebGL2 (hook needs VPE_LOG)
const vpeLog = acts.length || noWebgl ? path.join(dir, 'vpe.log') : null;
fs.writeFileSync(env, JSON.stringify({ PATH, ...(vpeLog ? { VPE_LOG: vpeLog } : {}), ...(noWebgl ? { VPE_NO_WEBGL: '1' } : {}), ELECTRON_RUN_AS_NODE: null, VSCODE_IPC_HOOK_CLI: null, VSCODE_PID: null, VSCODE_CWD: null }));
const envCli = path.join(dir, 'env-cli.json');
fs.writeFileSync(envCli, JSON.stringify({ PATH, ELECTRON_RUN_AS_NODE: '1', VSCODE_IPC_HOOK_CLI: null, VSCODE_PID: null, VSCODE_CWD: null }));
let cli = path.join(path.dirname(code), 'resources', 'app', 'out', 'cli.js');
if (!fs.existsSync(cli)) {  // newer builds keep it in a commit-named folder; bin/code.cmd names it
  const m = /%~dp0\.\.\\([^"]*cli\.js)/.exec(fs.readFileSync(path.join(path.dirname(code), 'bin', 'code.cmd'), 'utf8'));
  if (m) cli = path.join(path.dirname(code), m[1]);
}
const L = path.join(__dirname, 'hidden_launch.py');
const py = (...a) => spawnSync('python', ['-I', L, ...a], { encoding: 'utf8' });
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
function kill() {  // only processes of this throwaway profile
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(dir)}*' } | ForEach-Object { taskkill /T /F /PID $_.ProcessId | Out-Null }`]);
}
try {
  // Keep the editor resource out of the checkout and preserve its display name.
  const footage = path.join(dir, path.basename(file));
  fs.copyFileSync(file, footage);
  py(desk, env, code, '--user-data-dir', prof, '--extensions-dir', ext, '--extensionDevelopmentPath', ROOT, '--new-window');
  sleep(12);
  py('--wait', desk, envCli, code, cli, '--user-data-dir', prof, '--extensions-dir', ext, '--reuse-window', footage);
  sleep(wait);
  if (acts.length) {
    for (const a of acts) { fs.appendFileSync(vpeLog + '.cmd', JSON.stringify({ name: path.basename(file), ...a }) + String.fromCharCode(10)); sleep(1); }
    sleep(2);
  }
  const raw = path.join(dir, 'w.raw');
  const r = py('--wait', desk, env, 'python.exe', '-I', path.join(__dirname, 'capture_window.py'), raw);
  console.log(r.stdout.trim() || r.stderr.trim());
  const buf = fs.readFileSync(raw), w = buf.readInt32LE(0), h = buf.readInt32LE(4);
  fs.writeFileSync(raw + '.bgra', buf.subarray(8));
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-video_size', `${w}x${h}`, '-i', raw + '.bgra', path.resolve(out)]);
  console.log('wrote', out, `${w}x${h}`);
} finally { kill(); sleep(2); fs.rmSync(dir, { recursive: true, force: true }); }
