#!/usr/bin/env node
'use strict';
// The extension in a real VS Code Remote-SSH window (research track E, docs/notes/remote-stream.md).
//
//   node test/vscode/remote_ssh.js --ssh-config <file> [--host vpe-wsl] [--mode default|off|auto|on] [--seeks] [--long N]
//        [--remote-home /home/<user>] [--unc //wsl.localhost/Ubuntu] [--remote-ffmpeg <path on the remote>]
//        [--code <Code.exe>] [--seconds N] [--keep] [--json file]
//
// Needs an SSH server you can log in to with a key (the config file names host, port, key;
// StrictHostKeyChecking no), here sshd in WSL started as the user on a high port (no admin), and
// the remote's file system reachable from Windows (--unc, for WSL \\wsl.localhost\<distro>).
// The remote side must set VPE_LOG=<remote-home>/vpe-e/vpe.log for SSH sessions (sshd_config
// SetEnv), so the remote extension host writes the test log there.
//
// Copies this checkout (package.json, src, media, build) and the test clips to <remote-home>/vpe-e,
// installs ms-vscode-remote.remote-ssh into a fresh temporary profile, starts the portable VS Code on
// a hidden desktop (test/vscode/run.js HiddenCode) connected to the host with the remote copy as
// --extensionDevelopmentPath, the VS Code server in <remote-home>/vpe-e/server (not ~/.vscode-server),
// then plays each clip like run.js (first frame, decoder path, shownFps, paused seeks).
// --mode sets videoPreviewEnhanced.remoteStream in the remote's Machine settings (the setting is
// machine-scoped: a local user setting doesn't apply in a remote window); default (the default)
// leaves it unset, which is "auto": the H.264 re-encode on the remote (src/remotestream.js) for
// what the GPU decoder can't play; off: the built-in decoder in the webview.
// --seeks: on hevc_10_1080p (2 s, all in memory), a burst of seeks and steps back: no restarts.
// --long N: a generated 200 s clip (sound track starting late) played N seconds: position vs wall
// clock, picture and sound sent in step, no restarts; then a burst of seeks across it and steps
// back (test/vscode/cases/remote_stream.js).
const fs = require('fs');
const path = require('path');
const { HiddenCode, findCode, playClip, closeClip } = require('./run');

const ROOT = path.resolve(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'test', 'media');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HOST = opt('--host', 'vpe-wsl');
const MODE = opt('--mode', 'default');
const LONG = Number(opt('--long', 0));
// Home folder of the SSH user on the remote (default: /home/<your local user name>).
const RHOME = opt('--remote-home', `/home/${require('os').userInfo().username}`);
const UNC = opt('--unc', '//wsl.localhost/Ubuntu');
const SSH_CONFIG = opt('--ssh-config');
const RFFMPEG = opt('--remote-ffmpeg', '');
const SECONDS = Number(opt('--seconds', 5));
const CLIPS = (opt('--clips', 'hevc_10_2160p.mp4,hevc_10_1080p.mp4,h264_8_1080p.mp4')).split(',');
const EXPECT = { off: { h264_8_1080p: 'webcodecs' }, auto: {}, default: {}, on: {} };
const rscase = require('./cases/remote_stream');

const R = `${RHOME}/vpe-e`;
const local = (p) => `${UNC}${p}`; // remote path as seen from Windows
const remoteUri = (p) => `vscode-remote://ssh-remote+${HOST}${p}`;

function copyExtension() {
  const dst = local(`${R}/ext`);
  fs.rmSync(dst, { recursive: true, force: true });
  for (const f of ['package.json', 'LICENSE', 'src', 'media', 'build']) {
    if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(dst, f), { recursive: true });
  }
  fs.mkdirSync(local(`${R}/media`), { recursive: true });
  if (LONG) fs.copyFileSync(rscase.makeLongClip(), local(`${R}/media/rs_sync_200s.mkv`));
  for (const c of CLIPS) {
    const to = local(`${R}/media/${c}`);
    if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(path.join(MEDIA, c)).size) fs.copyFileSync(path.join(MEDIA, c), to);
  }
  // Machine settings of the test server only (ffmpegPath is machine-scoped: remote settings).
  fs.rmSync(local(`${R}/server/.vscode-server/data/logs`), { recursive: true, force: true }); // run.js waits for a new one
  const mdir = local(`${R}/server/.vscode-server/data/Machine`);
  fs.mkdirSync(mdir, { recursive: true });
  const machine = {};
  if (RFFMPEG) machine['videoPreviewEnhanced.ffmpegPath'] = RFFMPEG;
  if (MODE !== 'default') machine['videoPreviewEnhanced.remoteStream'] = MODE;
  fs.writeFileSync(path.join(mdir, 'settings.json'), JSON.stringify(machine, null, 1));
}

async function main() {
  if (!SSH_CONFIG) throw new Error('--ssh-config <file> is required');
  copyExtension();
  const code = findCode();
  const vs = new HiddenCode({
    code, keep: flag('--keep'), devPath: false, tag: 'vpessh',
    settings: {
      'remote.SSH.configFile': SSH_CONFIG.replace(/\\/g, '/'),
      'remote.SSH.path': 'C:/Windows/System32/OpenSSH/ssh.exe',
      'remote.SSH.remotePlatform': { [HOST]: 'linux' },
      'remote.SSH.serverInstallPath': { [HOST]: `${R}/server` },
      'remote.SSH.showLoginTerminal': false,
      'remote.SSH.connectTimeout': 120,
      'remote.SSH.localServerDownload': 'off',
      // The runner's own associations (mp4, webm) plus the long clip's mkv: this setting replaces them.
      'workbench.editorAssociations': { '*.mp4': 'videoPreviewEnhanced.playerOptional', '*.webm': 'videoPreviewEnhanced.playerOptional', '*.mkv': 'videoPreviewEnhanced.playerOptional' },
    },
  });
  // The extension runs on the remote: its log and command file live there.
  vs.log = local(`${R}/vpe.log`);
  for (const f of [vs.log, `${vs.log}.cmd`]) fs.writeFileSync(f, '');
  // Clips open as files on the remote (the local MEDIA path is mapped to a vscode-remote URI).
  const cli = vs.cli.bind(vs);
  vs.cli = (args) => cli(args.flatMap((a) => (a.startsWith(MEDIA) ? ['--file-uri', remoteUri(`${R}/media/${path.relative(MEDIA, a).replace(/\\/g, '/')}`)] : [a])));
  const res = { started: new Date().toISOString(), mode: MODE, host: HOST, clips: [] };
  try {
    const t0 = Date.now();
    console.log(await cli(['--install-extension', 'ms-vscode-remote.remote-ssh']));
    res.installMs = Date.now() - t0;
    vs.work = `--folder-uri=${remoteUri(`${R}/media`)}`;
    const t1 = Date.now();
    await vs.start([`--extensionDevelopmentPath=${remoteUri(`${R}/ext`)}`]);
    console.log(`VS Code pid ${vs.pid} on hidden desktop ${vs.desktop}, profile ${vs.dir}; connecting to ${HOST}`);
    // Connected once the server has started a remote extension host (its log file appears); the
    // extension itself activates with the first clip.
    const logs = local(`${R}/server/.vscode-server/data/logs`);
    const hostUp = () => { try { return fs.readdirSync(logs, { recursive: true }).some((f) => /remoteexthost\.log$/.test(String(f))); } catch { return false; } };
    while (!hostUp()) {
      if (Date.now() - t1 > 240000) throw new Error('no remote extension host after 240 s');
      await sleep(500);
    }
    res.connectMs = Date.now() - t1;
    console.log(`remote extension host up after ${res.connectMs} ms`);
    await sleep(2000);
    for (const file of CLIPS) {
      try {
        const expect = (EXPECT[MODE] || {})[file.replace(/\.\w+$/, '')];
        const r = await playClip(vs, { file, expect }, { seconds: SECONDS });
        r.streamStats = vs.lines.filter((l) => l.includes(`[${file}] remote stream stats:`)).map((l) => l.replace(/^.*stats: /, '')).slice(-3);
        res.clips.push(r);
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${MODE}/${file}: ${r.video} open ${r.openMs} ms, shownFps ${r.shownFps} ${JSON.stringify(r.shownFpsWindows)}, seeks ${(r.seeks || []).map((s) => `${s.want}->${s.got} ${s.ms} ms`).join(', ')}${r.problems.length ? ` | ${r.problems.join('; ')}` : ''}`);
        console.log(`     decision: ${r.decision || '-'}${r.streamStats.length ? ` | ${r.streamStats.join(' || ')}` : ''}`);
      } catch (e) {
        res.clips.push({ clip: file, ok: false, problems: [e.message] });
        console.log(`FAIL ${MODE}/${file}: ${e.message}`);
        try { await closeClip(vs); } catch { /* gone */ }
      }
    }
    const h = { sleep, esc, MEDIA };
    const extra = async (name, file, fn) => {
      try {
        const from = vs.mark();
        await vs.cli(['--reuse-window', path.join(MEDIA, file)]); // mapped to the remote URI
        await vs.waitLog(new RegExp(`\\[${esc(file)}\\] webview: first frame shown`), { from, timeout: 60000 });
        const dec = vs.lines.slice(from).find((l) => l.includes(`[${file}] decoder: `));
        await sleep(1500);
        const r = await fn(file);
        r.decision = dec && dec.replace(/^.*?decoder: /, '');
        res.clips.push({ clip: name, ...r });
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${MODE}/${name}: ${JSON.stringify({ ...r, ok: undefined })}`);
      } catch (e) {
        res.clips.push({ clip: name, ok: false, problems: [e.message] });
        console.log(`FAIL ${MODE}/${name}: ${e.message}`);
      }
      try { await closeClip(vs); } catch { /* gone */ }
    };
    if (flag('--seeks')) await extra('seeks', 'hevc_10_1080p.mp4', (f) => rscase.seekChecks(vs, h, f, 24, Array.from({ length: 20 }, (_, i) => 0.15 + ((i * 7) % 20) * 0.08), 0, 0));
    if (LONG) {
      await extra('long', 'rs_sync_200s.mkv', async (f) => {
        const r = await rscase.longChecks(vs, h, f, LONG);
        const s = await rscase.seekChecks(vs, h, f, 25, rscase.LONG_TARGETS, 8, 1);
        return { ...r, ok: r.ok && s.ok, problems: [...r.problems, ...s.problems], scrub: s.scrub, stepsBack: s.stepsBack };
      });
    }
  } finally {
    await vs.stop();
    const out = opt('--json') || path.join(__dirname, 'out', `ssh-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(res, null, 1));
    console.log(out);
  }
  return res.clips.every((c) => c.ok) ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
