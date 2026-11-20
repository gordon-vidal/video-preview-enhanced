#!/usr/bin/env node
'use strict';
// Records the README hero GIF (media/marketing/hero-remote.gif and .mp4): a Remote-SSH workspace,
// a video opened from the Explorer with a double-click, playing, paused, stepped back one frame,
// then two encodes of the same clip compared in split view with the divider dragged.
//
//   node tools/hero-gif/record.js [--out media/marketing] [--vsix file.vsix] [--distro Ubuntu]
//        [--width 1280] [--fps 15] [--keep] [--interactive]
//
// Nothing appears on the screen. VS Code (the pinned portable build: VPE_CODE or
// test/vscode/get_code.js) runs on a hidden desktop (test/vscode/hidden_launch.py, test/vscode/run.js
// HiddenCode) with a throwaway profile, connected with Remote-SSH to sshd in WSL, started as your
// user on 127.0.0.1:2244 (the loopback setup of test/vscode/remote_ssh.js and
// docs/notes/remote-stream.md, "Test setup"). tools/hero-gif/driver.py runs on the same desktop:
// it posts mouse and key messages to the window and captures it with PrintWindow, about 25 times a
// second, each frame named with its time. The input is scripted below (STEPS); the cursor is drawn
// afterwards from the logged input positions (PrintWindow has no cursor). The frames are then picked
// by time at a steady rate (the machine may stutter), cut to the GIF's timeline (CUTS) and encoded
// with ffmpeg (palettegen / paletteuse for the GIF, x264 for the MP4).
//
// What it sets up (once; kept for the next run):
//   - WSL: /home/demo (made with `wsl -u root`, owned by your WSL user) holding the clips: a neutral
//     workspace path. ~/vpe-demo/sshd (host key, authorized_keys, sshd_config with
//     SetEnv VPE_LOG=~/vpe-demo/vpe.log for the extension's test hook) and ~/vpe-demo/server (the
//     VS Code server, remote.SSH.serverInstallPath; the extension's VSIX is installed into it).
//   - Windows: an SSH key and config in a temp folder; the host alias is "demo-server".
// Needs: Windows, WSL with openssh-server, Python 3, ffmpeg on PATH, network on the first run (the
// Remote-SSH extension, the VS Code server, vsce for the VSIX unless --vsix).
//
// --interactive: set up and connect, then wait (for exploring coordinates); stops when the file
// named on stdout appears. Coordinates in STEPS are client pixels of a 1280x800 window at a 125 %
// display scale with window.zoomLevel set for an effective 100 % (ZOOM below); after a UI change, run
// with --interactive, take shots ({"op":"shot"} in the driver's command file) and adjust STEPS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'test', 'media');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DISTRO = opt('--distro', 'Ubuntu');
const OUT = path.resolve(ROOT, opt('--out', path.join('media', 'marketing')));
const WIDTH = Number(opt('--width', 1280));
const FPS = Number(opt('--fps', 15));
const HOST = 'demo-server';
const PORT = 2244;
const WORKSPACE = '/home/demo';
const WIN = { w: 1280, h: 800 };
// Effective 100 % on any display scale: window.zoomLevel is log1.2(1 / scale).
const DPI = (() => { try { return Number(execFileSync('python', ['-c', 'import ctypes;ctypes.windll.user32.SetProcessDPIAware();print(ctypes.windll.user32.GetDpiForSystem())'], { encoding: 'utf8' }).trim()) || 96; } catch { return 96; } })();
const ZOOM = Math.log(96 / DPI) / Math.log(1.2);

// The workspace: [name in /home/demo, source in test/media, low-bitrate re-encode?]
const FILES = [
  ['big_buck_bunny_1080p.mp4', 'h264_aac_anim_1080p.mp4'],
  ['tears_of_steel_1080p.mp4', 'h264_8_1080p.mp4'],
  ['meridian_2160p.mp4', 'h264_8_2160p.mp4'],
  ['tmp/big_buck_bunny_1080p_300k.mp4', 'h264_aac_anim_1080p.mp4', ['-c:v', 'libx264', '-b:v', '300k', '-maxrate', '360k', '-bufsize', '360k', '-preset', 'veryfast', '-g', '90', '-c:a', 'copy']],
];

const wsl = (cmd, { root = false } = {}) => execFileSync('wsl.exe', ['-d', DISTRO, ...(root ? ['-u', 'root'] : []), '-e', 'sh', '-c', cmd], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
const unc = (p) => `\\\\wsl.localhost\\${DISTRO}${p.replace(/\//g, '\\')}`;

function log(...a) { console.log(`[hero ${new Date().toISOString().slice(11, 19)}]`, ...a); }

/** WSL side: the workspace with the clips, sshd config and its key. Returns { user, home }. */
function setupWsl(tmp) {
  const [user, home] = wsl('echo "$(id -un) $HOME"').split(' ');
  wsl(`mkdir -p ${WORKSPACE} && chown ${user}:${user} ${WORKSPACE}`, { root: true });
  for (const [name, src, enc] of FILES) {
    const to = unc(`${WORKSPACE}/${name}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) continue;
    const from = path.join(MEDIA, src);
    if (fs.statSync(from).size < 10000) throw new Error(`${from} is a Git LFS pointer: run git lfs pull`);
    if (!enc) { fs.copyFileSync(from, to); continue; }
    const local = path.join(tmp, path.basename(name));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', from, ...enc, local]);
    fs.copyFileSync(local, to);
  }
  const d = `${home}/vpe-demo`;
  wsl(`mkdir -p ${d}/sshd ${d}/server && cd ${d}/sshd && ([ -f host_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -f host_ed25519)`);
  fs.writeFileSync(unc(`${d}/sshd/sshd_config`), [
    `Port ${PORT}`, 'ListenAddress 127.0.0.1', `HostKey ${d}/sshd/host_ed25519`, `PidFile ${d}/sshd/sshd.pid`,
    `AuthorizedKeysFile ${d}/sshd/authorized_keys`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
    'AllowTcpForwarding yes', 'AllowStreamLocalForwarding yes', 'PermitUserEnvironment no', `SetEnv VPE_LOG=${d}/vpe.log`,
    'Subsystem sftp /usr/lib/openssh/sftp-server', 'LogLevel INFO', ''].join('\n'));
  return { user, home, d };
}

/** Windows side: a key (owner-only ACL, or OpenSSH ignores it) and an SSH config for the alias. */
function setupSsh(tmp, w) {
  const key = path.join(tmp, 'id');
  if (!fs.existsSync(key)) {
    execFileSync('C:/Windows/System32/OpenSSH/ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'demo']);
    execFileSync('icacls', [key, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'ignore' });
  }
  fs.writeFileSync(unc(`${w.d}/sshd/authorized_keys`), fs.readFileSync(`${key}.pub`));
  wsl(`chmod 600 ${w.d}/sshd/authorized_keys`);
  const cfg = path.join(tmp, 'ssh_config');
  const f = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(cfg, [`Host ${HOST}`, '  HostName 127.0.0.1', `  Port ${PORT}`, `  User ${w.user}`, `  IdentityFile ${f(key)}`,
    '  IdentitiesOnly yes', '  StrictHostKeyChecking no', `  UserKnownHostsFile ${f(path.join(tmp, 'known_hosts'))}`, '  LogLevel ERROR', ''].join('\n'));
  return cfg;
}

const ssh = (cfg, cmd) => execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', ['-F', cfg, HOST, cmd], { encoding: 'utf8' });

async function startSshd(cfg, w) {
  try { if (ssh(cfg, 'echo up').trim() === 'up') return null; } catch { /* not running */ }
  const p = spawn('wsl.exe', ['-d', DISTRO, '-e', '/usr/sbin/sshd', '-D', '-e', '-f', `${w.d}/sshd/sshd_config`], { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { if (ssh(cfg, 'echo up').trim() === 'up') return p; } catch { /* starting */ }
  }
  throw new Error('sshd in WSL did not start');
}

function buildVsix(tmp) {
  const given = opt('--vsix');
  if (given) return path.resolve(given);
  const out = path.join(tmp, 'vpe.vsix');
  log('packaging the extension (vsce)');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', '@vscode/vsce@4.1.1', 'package', '-o', out], { cwd: ROOT, stdio: 'ignore', shell: true });
  return out;
}

/** The extension into the remote's VS Code server (its own code-server CLI), replacing an older copy. */
function installOnRemote(cfg, w, vsix) {
  const remote = `${w.d}/vpe.vsix`;
  fs.copyFileSync(vsix, unc(remote));
  const data = `${w.d}/server/.vscode-server`;
  const out = ssh(cfg, `CS=$(ls -d ${data}/cli/servers/*/server/bin/code-server 2>/dev/null | head -1); [ -n "$CS" ] || { echo no-server; exit 0; }; `
    + `"$CS" --server-data-dir ${data} --extensions-dir ${data}/extensions --install-extension ${remote} --force 2>&1 | tail -2`);
  return !/no-server/.test(out);
}


const HIDDEN = path.join(ROOT, 'test', 'vscode', 'hidden_launch.py');

/** VS Code on a hidden desktop, connected to the workspace, with the extension on the remote and the driver beside it. */
async function startSession({ cfg, w, vsix, tmp }) {
  const { HiddenCode, findCode, run } = require('../../test/vscode/run');
  const code = findCode();
  const data = `${w.d}/server/.vscode-server`;
  const vs = new HiddenCode({
    code, devPath: false, tag: 'vpehero', keep: flag('--keep'),
    settings: {
      'remote.SSH.configFile': cfg.replace(/\\/g, '/'),
      'remote.SSH.path': 'C:/Windows/System32/OpenSSH/ssh.exe',
      'remote.SSH.remotePlatform': { [HOST]: 'linux' },
      'remote.SSH.serverInstallPath': { [HOST]: `${w.d}/server` },
      'remote.SSH.showLoginTerminal': false,
      'remote.SSH.connectTimeout': 120,
      'remote.SSH.localServerDownload': 'off',
      'workbench.colorTheme': 'Default Dark Modern',
      'window.zoomLevel': Number(ZOOM.toFixed(4)),
      'workbench.editorAssociations': { '*.mp4': 'videoPreviewEnhanced.playerOptional' },
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.tips.enabled': false,
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'extensions.ignoreRecommendations': true,
      'update.showReleaseNotes': false,
      'git.enabled': false,
      'explorer.compactFolders': false,
      'workbench.tree.indent': 12,
    },
  });
  vs.log = unc(`${w.d}/vpe.log`); // the extension runs on the remote: its log and command file are there
  const resetLog = () => { for (const f of [vs.log, `${vs.log}.cmd`]) fs.writeFileSync(f, ''); vs.pos = 0; vs.lines = []; };
  resetLog();
  log(`profile ${vs.dir}; installing Remote - SSH`);
  await vs.cli(['--install-extension', 'ms-vscode-remote.remote-ssh']);
  vs.work = `--folder-uri=vscode-remote://ssh-remote+${HOST}${WORKSPACE}`;
  const logs = unc(`${data}/data/logs`);
  const hostUp = () => { try { return fs.readdirSync(logs, { recursive: true }).some((f) => /remoteexthost\.log$/.test(String(f))); } catch { return false; } };
  const connect = async () => {
    fs.rmSync(logs, { recursive: true, force: true });
    const t = Date.now();
    await vs.start([]);
    while (!hostUp()) {
      if (Date.now() - t > 300000) throw new Error('no remote extension host after 300 s');
      await sleep(500);
    }
    log(`connected in ${Date.now() - t} ms`);
  };
  let installed = installOnRemote(cfg, w, vsix);
  await connect();
  if (!installed) { // first run: the server came with this connection
    if (!installOnRemote(cfg, w, vsix)) throw new Error('VS Code server not found on the remote');
    await vs.kill();
    resetLog();
    await connect();
  }
  const cmd = path.join(tmp, 'driver.cmd');
  const frames = path.join(tmp, 'frames');
  fs.rmSync(frames, { recursive: true, force: true });
  for (const f of [cmd, `${cmd}.out`]) fs.writeFileSync(f, '');
  // pythonw: a GUI-subsystem child doesn't get hidden_launch's stdout pipe, so run() returns at once.
  await run('python', ['-I', HIDDEN, vs.desktop, vs.envMain, 'pythonw.exe', '-I', path.join(__dirname, 'driver.py'), cmd, frames]);
  const drv = new Driver(cmd);
  return { vs, drv, frames, data, tmp };
}

/** The driver's command file: send() resolves with its reply (which carries the driver's clock). */
class Driver {
  constructor(cmd) { this.cmd = cmd; this.id = 0; this.events = []; }
  async send(c, timeout = 15000) {
    const id = ++this.id;
    fs.appendFileSync(this.cmd, `${JSON.stringify({ ...c, id })}\n`);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const hit = fs.readFileSync(`${this.cmd}.out`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === id);
      if (hit) { this.events.push({ ...c, t: hit.t }); if (hit.error) throw new Error(`driver: ${hit.error}`); return hit; }
      await sleep(5);
    }
    throw new Error(`driver: no reply to ${JSON.stringify(c)}`);
  }
}

// ---- The scripted take ----
// Client pixels of the 1280x800 window (see --interactive in the header). Explorer rows are 22 px apart.
const AT = {
  start: { x: 760, y: 430 },
  rowTmp: { x: 100, y: 116 }, // collapsed tmp/ first, then the files
  rowBbb: { x: 165, y: 138 }, // big_buck_bunny_1080p.mp4 with tmp/ collapsed
  rowBbbBelowTmp: { x: 165, y: 160 }, // the same row once tmp/ is open
  rowLow: { x: 200, y: 138 }, // tmp/big_buck_bunny_1080p_300k.mp4
  menuCompare: { dx: 100, dy: 150 }, // "Compare / Play Together" in the Explorer's context menu, from where it opened
  play: { x: 426, y: 735 },
  stepBack: { x: 387, y: 735 },
  time: { x: 662, y: 735 }, // click: time -> timecode -> frame number
  cmpView: { x: 1049, y: 736 },
  cmpSplit: { x: 1195, y: 570 },
  divider: { x: 815, y: 385 },
};

async function record(s) {
  const { vs, drv } = s;
  const cur = { ...AT.start };
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2);
  const glide = async (to, ms = 600, held) => {
    const from = { ...cur }, t0 = Date.now();
    for (;;) {
      const k = Math.min(1, (Date.now() - t0) / ms), e = ease(k);
      cur.x = Math.round(from.x + (to.x - from.x) * e); cur.y = Math.round(from.y + (to.y - from.y) * e);
      await drv.send({ op: 'move', ...cur, ...(held ? { held } : {}) });
      if (k >= 1) break;
      await sleep(12);
    }
  };
  const click = async (p, extra = {}) => {
    if (p) await glide(p, extra.ms || 450);
    await drv.send({ op: 'down', ...cur, ...extra });
    await sleep(50);
    await drv.send({ op: 'up', ...cur, ...extra });
  };
  const cut = async (fn) => { await drv.send({ op: 'mark', cut: 'start' }); await fn(); await drv.send({ op: 'mark', cut: 'end' }); };
  const waitLog = (re, from, what) => vs.waitLog(re, { from, timeout: 60000, what });
  const mark = (still) => drv.send({ op: 'mark', still });

  await drv.send({ op: 'move', ...cur });
  await sleep(1500);
  await drv.send({ op: 'rec', on: true });
  await sleep(250);
  // 1. Double-click the video in the Explorer: it opens in the player and plays.
  await glide(AT.rowBbb, 600);
  await sleep(120);
  let from = vs.mark();
  await drv.send({ op: 'dbl', ...cur });
  await cut(async () => { await waitLog(/\[big_buck_bunny_1080p\.mp4\] webview: first frame shown/, from, 'the player'); await sleep(150); });
  await sleep(250);
  // 2. While it plays: the time display to frame numbers (two clicks: timecode, then frame number).
  await click(AT.time, { ms: 450 });
  await mark('1-playing');
  await sleep(300);
  await click();
  await sleep(350);
  // 3. Pause, then one frame back.
  await click(AT.play, { ms: 380 });
  await sleep(450);
  await mark('2-paused');
  await click(AT.stepBack, { ms: 280 });
  await sleep(650);
  await mark('3-stepped-back');
  // 4. Two encodes of the clip: open tmp/, select both, Compare / Play Together (pointer travel at 1.4x).
  const fast = () => drv.send({ op: 'mark', speed: '1.4' });
  const normal = () => drv.send({ op: 'mark', speed: 'end' });
  await fast();
  await click(AT.rowTmp, { ms: 550 });
  await sleep(150);
  await click(AT.rowBbbBelowTmp, { ms: 280 });
  await sleep(100);
  await click(AT.rowLow, { ms: 250, mods: ['ctrl'] });
  await sleep(150);
  await click(null, { button: 'right' });
  await normal();
  await sleep(350);
  await mark('4-menu');
  from = vs.mark();
  await click({ x: cur.x + AT.menuCompare.dx, y: cur.y + AT.menuCompare.dy }, { ms: 380 });
  await cut(async () => {
    for (const re of [/\[compare [^\]]*\] webview: \[A\] first frame shown/, /\[compare [^\]]*\] webview: \[B\] first frame shown/]) await waitLog(re, from, 'compare');
    await sleep(500);
  });
  // 5. Split view (the view menu: Split, Escape closes it), play both, drag the divider.
  await fast();
  await click(AT.cmpView, { ms: 480 });
  await normal();
  await sleep(250);
  await click(AT.cmpSplit, { ms: 280 });
  await sleep(250);
  await drv.send({ op: 'key', vk: 0x1B });
  await sleep(100);
  await fast();
  await glide(AT.play, 450);
  await normal();
  await click();
  await glide(AT.divider, 420);
  await drv.send({ op: 'down', ...cur });
  await glide({ x: AT.divider.x - 210, y: AT.divider.y + 10 }, 500, 'left');
  await sleep(100);
  await glide({ x: AT.divider.x + 90, y: AT.divider.y + 5 }, 550, 'left');
  await drv.send({ op: 'up', ...cur });
  await sleep(300);
  await mark('5-split');
  await sleep(300);
  await drv.send({ op: 'rec', on: false });
  await sleep(500);
  fs.writeFileSync(path.join(s.tmp, 'events.json'), JSON.stringify(drv.events));
  return drv.events;
}

module.exports = { setupWsl, setupSsh, startSshd, buildVsix, installOnRemote, startSession, Driver, record, AT, unc, wsl, log, HOST, WORKSPACE, WIN, ZOOM, FPS, WIDTH, OUT, ROOT, DISTRO, opt, flag, sleep };

async function main() {
  const tmp = path.join(os.tmpdir(), 'vpe-hero');
  fs.mkdirSync(tmp, { recursive: true });
  const w = setupWsl(tmp);
  const cfg = setupSsh(tmp, w);
  const sshd = await startSshd(cfg, w);
  const vsix = buildVsix(tmp);
  let s;
  try {
    s = await startSession({ cfg, w, vsix, tmp });
    await s.drv.send({ op: 'size', w: WIN.w, h: WIN.h });
    if (flag('--interactive')) {
      const stop = path.join(tmp, 'stop');
      fs.rmSync(stop, { force: true });
      console.log(JSON.stringify({ desktop: s.vs.desktop, driver: s.drv.cmd, vpeLog: s.vs.log, stop }));
      while (!fs.existsSync(stop)) await sleep(500);
      return;
    }
    await record(s);
    await s.drv.send({ op: 'quit' }, 3000).catch(() => {});
    await s.vs.stop();
    s = null;
    await require('./compose').compose({ tmp, frames: path.join(tmp, 'frames'), out: OUT, width: WIDTH, fps: FPS });
  } finally {
    if (s) { try { await s.drv.send({ op: 'quit' }, 3000); } catch { /* gone */ } await s.vs.stop(); }
    if (sshd) { try { wsl(`kill $(cat ${w.d}/sshd/sshd.pid)`); } catch { /* gone */ } sshd.kill(); } // only the sshd this run started
  }
}

if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
