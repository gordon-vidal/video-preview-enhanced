#!/usr/bin/env node
'use strict';
// Review launcher (docs/REVIEW.md): a fresh VS Code with a given build of the extension installed and a
// folder of test videos open, in a throwaway profile. Windows, macOS and Linux; no dependencies.
//
//   node tools/review.js [target] [flags]     (--help lists them)
//   node tools/review.js                      in a terminal: a small menu instead of flags (--ui forces it)
//
// Flags are accepted PowerShell-style (-DryRun) and POSIX-style (--dry-run): case and hyphens are ignored.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

// ---- options -------------------------------------------------------------------------------------

/** Simulated Remote-SSH link presets (menu text); the key is the --link value. */
const LINKS = {
  off: 'Off (local)',
  'fast-ssh': 'Fast SSH (25 Mbps, 15ms)',
  'typical-ssh': 'Typical SSH (8 Mbps, 40ms)',
  'slow-ssh': 'Slow SSH (2.5 Mbps, 80ms)',
  'flaky-ssh': 'Flaky SSH (4 Mbps, 120ms + drops)',
  remote: 'Remote-SSH (no throttle)',
};
const TRANSCODES = ['auto', 'always', 'off'];

const USAGE = `Review launcher: a fresh VS Code with a build of the extension and sample videos (docs/REVIEW.md)

Usage: node tools/review.js [target] [flags]      (no arguments in a terminal: interactive menu)
  target                a git ref of the main repo (branch, tag, commit; default main) or a .vsix file
  --dirty               build from the worktree that has the branch checked out, uncommitted changes included
  --dev                 no packaging: --extensionDevelopmentPath (faster)
  --code <version>      another portable VS Code version instead of the pinned one (Windows)
  --installed           use the installed 'code' instead of the portable build (always, off Windows)
  --media <folder>      open this folder instead of the generated review folder
  --checklist <file.md> copy it into the folder as REVIEW.md and open it
  --link <preset>       simulate a Remote-SSH link: ${Object.keys(LINKS).join(' | ')}
  --transcode <mode>    seed the Live transcode setting: ${TRANSCODES.join(' | ')}
  --no-ffmpeg-on-path   hide ffmpeg on PATH only
  --first-run           open the setup guide on start, as after a fresh install (needs a fresh profile: always here)
  --no-ffmpeg           no ffmpeg at all (PATH hidden and the lookup in the usual places off)
  --dry-run             print every command and path; create and launch nothing
  --no-wait             return once VS Code started; nothing is cleaned up
  --keep                keep the temp profile, worktree and folder
  --ui                  open the interactive menu       -h, --help   this text
PowerShell spellings (-Dev, -DryRun, -NoFfmpegOnPath ...) work too.`;

class ReviewError extends Error {}
const fail = (message) => { throw new ReviewError(message); };

const SWITCHES = {
  dirty: 'dirty', dev: 'dev', installed: 'installed', dryrun: 'dryRun', nowait: 'noWait', keep: 'keep',
  noffmpeg: 'noFfmpeg', noffmpegonpath: 'noFfmpegOnPath', firstrun: 'firstRun', ui: 'ui', help: 'help', h: 'help',
};
const VALUES = { code: 'code', media: 'media', checklist: 'checklist', link: 'link', transcode: 'transcode' };

/** argv -> options. Throws ReviewError on an unknown flag or a bad value. */
function parseArgs(argv) {
  const o = {
    target: 'main', dirty: false, dev: false, installed: false, code: '', media: '', checklist: '',
    link: 'off', transcode: '', dryRun: false, noWait: false, keep: false, noFfmpeg: false, noFfmpegOnPath: false, firstRun: false,
    ui: false, help: false,
  };
  let haveTarget = false;
  for (let i = 0; i < argv.length; i++) {
    const m = /^--?([A-Za-z][\w-]*)(?:[=:]([\s\S]*))?$/.exec(argv[i]);
    if (!m) {
      if (haveTarget) fail(`unexpected argument: ${argv[i]}`);
      o.target = argv[i]; haveTarget = true;
      continue;
    }
    const name = m[1].replace(/-/g, '').toLowerCase();
    if (SWITCHES[name]) {
      if (m[2] !== undefined) fail(`${argv[i]} takes no value`);
      o[SWITCHES[name]] = true;
    } else if (VALUES[name]) {
      const v = m[2] !== undefined ? m[2] : argv[++i];
      if (v === undefined) fail(`${argv[i - 1]} needs a value`);
      o[VALUES[name]] = v;
    } else fail(`unknown option: ${argv[i]} (see --help)`);
  }
  o.link = o.link.toLowerCase(); o.transcode = o.transcode.toLowerCase();
  if (!LINKS[o.link]) fail(`--link must be one of: ${Object.keys(LINKS).join(', ')}`);
  if (o.transcode && !TRANSCODES.includes(o.transcode)) fail(`--transcode must be one of: ${TRANSCODES.join(', ')}`);
  return o;
}

/** Environment the simulated link adds to the launched VS Code (read by the extension host). */
function linkEnv(link) {
  if (link === 'off') return {};
  return link === 'remote'
    ? { VPE_SIMULATE_REMOTE: 'ssh-remote' }
    : { VPE_SIMULATE_LINK: link, VPE_SIMULATE_REMOTE: 'ssh-remote' };
}

const isVsixPath = (target) => /\.vsix$/i.test(target);

// ---- interactive menu (pure state machine; the terminal loop is runUi) ----------------------------------

const UI_ROWS = [
  { id: 'target', label: 'Target' },
  { id: 'mode', label: 'Mode', options: ['Dev host (fast)', 'Installed VSIX'] },
  { id: 'dirty', label: 'Working copy', options: ['Committed', 'Dirty (uncommitted)'] },
  { id: 'code', label: 'VS Code', options: ['Pinned portable', 'Installed code'] },
  { id: 'link', label: 'SSH / Link sim', options: Object.values(LINKS) },
  { id: 'transcode', label: 'Live transcode', options: ['Auto (default)', 'Always', 'Off'] },
  { id: 'ffmpeg', label: 'FFmpeg', options: ['Normal', 'Hide on PATH', 'No ffmpeg at all'] },
  { id: 'firstRun', label: 'Setup guide', options: ['Closed', 'Open on start (first run)'] },
  { id: 'keep', label: 'Keep temp profile', options: ['No', 'Yes'] },
];
const LAUNCH_ROW = UI_ROWS.length;
const LINK_IDS = Object.keys(LINKS);

/** Fresh menu state. `args` (from parseArgs) pre-selects what was already given on the command line. */
function createUiState({ branches = [], platform = process.platform, args = null } = {}) {
  const a = args;
  return {
    row: 0,
    edit: null, // text being typed into Target, or null
    target: a ? a.target : 'main',
    targets: ['main', 'HEAD', ...branches.filter((b) => b !== 'main' && b !== 'HEAD')],
    v: {
      mode: a && !a.dev ? 1 : 0,
      dirty: a && a.dirty ? 1 : 0,
      code: (a && a.installed) || platform !== 'win32' ? 1 : 0,
      link: a ? LINK_IDS.indexOf(a.link) : 0,
      transcode: a && a.transcode ? TRANSCODES.indexOf(a.transcode) : 0,
      ffmpeg: a && a.noFfmpeg ? 2 : a && a.noFfmpegOnPath ? 1 : 0,
      firstRun: a && a.firstRun ? 1 : 0,
      keep: a && a.keep ? 1 : 0,
    },
  };
}

function cycle(index, step, length) { return (index + step + length) % length; }

/** Apply one key (see parseKeys); returns { state, action } with action null | 'launch' | 'dry' | 'quit'. */
function applyKey(state, key) {
  const s = { ...state, v: { ...state.v } };
  const done = (action = null) => ({ state: s, action });

  if (key === 'ctrl-c') return done('quit'); // also while typing a ref
  if (s.edit !== null) { // typing a ref or .vsix path
    if (key === 'enter') { if (s.edit.trim()) s.target = s.edit.trim(); s.edit = null; }
    else if (key === 'esc') s.edit = null;
    else if (key === 'backspace') s.edit = s.edit.slice(0, -1);
    else if (key.length === 1 && key >= ' ') s.edit += key;
    return done();
  }

  const change = (step) => {
    const row = UI_ROWS[s.row];
    if (!row) return;
    if (row.id === 'target') {
      const at = s.targets.indexOf(s.target);
      s.target = s.targets[cycle(at < 0 && step < 0 ? 0 : at, step, s.targets.length)];
    } else s.v[row.id] = cycle(s.v[row.id], step, row.options.length);
  };
  switch (key) {
    case 'up': s.row = cycle(s.row, -1, LAUNCH_ROW + 1); break;
    case 'down': s.row = cycle(s.row, 1, LAUNCH_ROW + 1); break;
    case 'left': change(-1); break;
    case 'right': case ' ': change(1); break;
    case 'e': case 'E': s.row = 0; s.edit = ''; break;
    case 'enter':
      if (s.row === LAUNCH_ROW) return done('launch');
      if (s.row === 0) s.edit = ''; else change(1);
      break;
    case 'd': case 'D': return done('dry');
    case 'q': case 'Q': case 'esc': case 'ctrl-c': return done('quit');
    default: break;
  }
  return done();
}

/** The command-line arguments that the menu state stands for (what is run, and shown at the bottom). */
function stateToArgs(state) {
  const args = [state.target];
  const vsix = isVsixPath(state.target); // a package is neither built nor developed
  if (!vsix && state.v.mode === 0) args.push('--dev');
  if (!vsix && state.v.dirty === 1) args.push('--dirty');
  if (state.v.code === 1) args.push('--installed');
  if (state.v.link > 0) args.push('--link', LINK_IDS[state.v.link]);
  if (state.v.transcode > 0) args.push('--transcode', TRANSCODES[state.v.transcode]);
  if (state.v.ffmpeg === 1) args.push('--no-ffmpeg-on-path');
  if (state.v.ffmpeg === 2) args.push('--no-ffmpeg');
  if (state.v.firstRun === 1) args.push('--first-run');
  if (state.v.keep === 1) args.push('--keep');
  return args;
}

const showArgs = (args) => args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');

/** The menu as plain text (no colours), one string. */
function renderUi(state) {
  const vsix = isVsixPath(state.target);
  const lines = [
    'Review launcher',
    'Up/Down move   Left/Right or Space change   Enter edit/launch   D dry-run   Q quit',
    '',
  ];
  UI_ROWS.forEach((row, i) => {
    let value;
    if (row.id === 'target') value = state.edit !== null ? `${state.edit}_` : state.target;
    else value = `< ${row.options[state.v[row.id]]} >`;
    if (vsix && (row.id === 'mode' || row.id === 'dirty')) value += '  (not used for a .vsix)';
    lines.push(`${state.row === i ? '>' : ' '} ${row.label.padEnd(18)}${value}`);
  });
  lines.push(`${state.row === LAUNCH_ROW ? '>' : ' '} [ Launch ]`, '');
  lines.push(state.edit !== null
    ? 'Type a git ref or the path of a .vsix.  Enter = ok   Esc = cancel'
    : 'On Target: Left/Right picks a branch, E or Enter types a ref or .vsix path.');
  lines.push(`Command: node tools/review.js ${showArgs(stateToArgs(state))}`);
  return lines.join('\n');
}

const KEYS = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\r': 'enter', '\n': 'enter', '\x1b': 'esc', '\x7f': 'backspace', '\b': 'backspace', '\x03': 'ctrl-c',
};

/** Raw terminal input -> key names ('up', 'enter', 'q', ' ' ...); other escape sequences become 'unknown'. */
function parseKeys(chunk) {
  const tokens = chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|\x1b|[\s\S]/gu) || [];
  return tokens.map((t) => KEYS[t] || ([...t].length === 1 ? t : 'unknown'));
}

/** Runs the menu on the terminal; resolves to the argument list to run, or null when the user quit. */
function runUi(initial) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let state = initial;
    const draw = () => stdout.write(`\x1b[2J\x1b[H${renderUi(state)}\n`);
    const finish = (value) => {
      stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause();
      stdout.write('\n');
      resolve(value);
    };
    function onData(chunk) {
      for (const key of parseKeys(String(chunk))) {
        const r = applyKey(state, key);
        state = r.state;
        if (r.action === 'quit') return finish(null);
        if (r.action === 'launch') return finish(stateToArgs(state));
        if (r.action === 'dry') return finish([...stateToArgs(state), '--dry-run']);
      }
      draw();
      return undefined;
    }
    stdin.setEncoding('utf8'); stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData);
    draw();
  });
}

// ---- helpers -------------------------------------------------------------------------------------

const q = (s) => `"${s}"`;
const say = (s = '') => console.log(s);
const cmd = (s) => console.log(`CMD: ${s}`);
const note = (s) => console.log(`review: ${s}`);
/** Display form of launch arguments: values quoted, bare flags as they are. */
const showLaunch = (args) => args.map((a) => {
  if (!a.startsWith('--')) return q(a);
  const eq = a.indexOf('=');
  return eq < 0 ? a : `${a.slice(0, eq + 1)}${q(a.slice(eq + 1))}`;
}).join(' ');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), raw: r.stdout || '' };
}

/** Runs a program to completion; .cmd/.bat files (npx.cmd) go through cmd.exe. */
function run(file, args, opts = {}) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    // cmd.exe expands %NAME% even inside quotes and there is no way to escape it on a command line.
    if ([file, ...args].some((a) => a.includes('%'))) {
      fail(`cannot pass '%' in an argument to ${file}: ${args.join(' ')}`);
    }
    const plain = (a) => /^[\w@.:=/\\-]+$/.test(a); // flags stay bare; paths with spaces or & ( ) get quotes
    const line = `"${[file, ...args].map((a) => (plain(a) ? a : q(a))).join(' ')}"`;
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line],
      { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, ...opts });
  }
  return spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

/** Windows: the Code.exe and cli.js that VS Code's bin\code.cmd starts, read from the script (null if it differs). */
function parseCodeCmd(cli) {
  let text;
  try { text = fs.readFileSync(cli, 'utf8'); } catch { return null; }
  const m = /"%~dp0([^"]*Code\.exe)"\s+"%~dp0([^"]*cli\.js)"/i.exec(text);
  const dir = path.dirname(cli);
  return m ? { exe: path.resolve(dir, m[1]), script: path.resolve(dir, m[2]) } : null;
}

/** Runs VS Code's command-line interface. On Windows it starts what code.cmd would, without cmd.exe (which would
 *  expand a %NAME% in a path argument). */
function runCode(cli, args, env) {
  const p = IS_WIN && /\.cmd$/i.test(cli) ? parseCodeCmd(cli) : null;
  if (p) {
    return spawnSync(p.exe, [p.script, ...args],
      { encoding: 'utf8', windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
  }
  return run(cli, args, { env });
}

function which(name) {
  for (const d of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d.replace(/^"|"$/g, ''), name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return '';
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function linkOrCopy(from, to) {
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

/** Version from extension/package.json inside a .vsix (a zip), without a zip library. */
function readVsixVersion(file) {
  const buf = fs.readFileSync(file);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  let p = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === 'extension/package.json') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return JSON.parse((method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8')).version;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('no extension/package.json');
}

// ---- the launch ----------------------------------------------------------------------------------

function findMain(toolRoot) {
  const r = git(toolRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!r.ok || !r.out) fail(`${toolRoot} is not a git checkout`);
  return path.dirname(path.normalize(r.out));
}

/** Path of the worktree that has `target` checked out as a branch, or ''. */
function worktreeOf(main, target) {
  let found = '', cur = {};
  for (const line of git(main, 'worktree', 'list', '--porcelain').raw.split(/\r?\n/).concat('')) {
    if (line === '') {
      if (cur.path && cur.branch && (cur.branch === `refs/heads/${target}` || cur.branch === target)) found = cur.path;
      cur = {};
    } else if (line.startsWith('worktree ')) cur.path = path.normalize(line.slice(9));
    else if (line.startsWith('branch ')) cur.branch = line.slice(7);
  }
  return found;
}

/** Which VS Code to start: { cli, exe, version, fetch, wait }. */
function resolveVsCode(o, getCode) {
  const r = { cli: '', exe: '', version: '', fetch: false, wait: false };
  if (o.installed || !IS_WIN) { // get_code.js only knows the Windows portable build
    const cli = which(IS_WIN ? 'code.cmd' : 'code');
    if (!cli) {
      if (o.dryRun && !o.installed) { // CI has no VS Code: still print the plan
        return { ...r, cli: 'code', exe: 'code', version: "(no portable build here, 'code' not on PATH)", wait: true };
      }
      fail(o.installed ? "--installed: 'code' is not on PATH"
        : "no portable VS Code build for this platform and 'code' is not on PATH");
    }
    if (!o.installed && o.code) note(`--code ${o.code}: no portable builds on this platform; using the installed code`);
    r.cli = cli;
    r.exe = IS_WIN ? path.join(path.dirname(path.dirname(cli)), 'Code.exe') : cli;
    if (IS_WIN && !isFile(r.exe)) fail(`Code.exe not found next to ${cli}`);
    r.wait = !IS_WIN; // the `code` script returns at once unless told to wait
    const v = runCode(cli, ['--version'], cleanEnv());
    r.version = `${(v.stdout || '').split(/\r?\n/)[0]} (installed)`;
    return r;
  }
  r.version = o.code;
  if (!r.version) {
    const m = /PINNED\s*=\s*'([^']+)'/.exec(fs.readFileSync(getCode, 'utf8'));
    if (!m) fail(`cannot read PINNED from ${getCode}`);
    r.version = m[1];
  }
  const dir = path.join(path.dirname(getCode), '.code', r.version);
  r.exe = path.join(dir, 'Code.exe'); r.cli = path.join(dir, 'bin', 'code.cmd');
  r.fetch = !isFile(r.exe);
  return r;
}

// Review folder: group, path relative to test/media (the file keeps its own name).
const MEDIA_PLAN = [
  ['codecs', 'h264_aac_anim_1080p.mp4'], ['codecs', 'hevc_10_2160p.mp4'], ['codecs', 'av1_10_1080p.mp4'],
  ['codecs', 'vp9_opus_anim_1080p.webm'], ['codecs', 'prores_proxy_1080p.mov'], ['codecs', 'dnxhr_lb_1080p.mov'],
  ['codecs', 'mpeg2_1080p.mpg'],
  ['hdr', 'hevc_10_pq_2160p.mp4'], ['hdr', 'hevc_10_hlg_2160p.mp4'],
  ['containers', 'containers/h264_aac.avi'], ['containers', 'containers/h264_aac.flv'],
  ['containers', 'containers/h264_aac.m2ts'], ['containers', 'containers/h264_aac.mkv'],
  ['containers', 'containers/h264_aac.mov'], ['containers', 'containers/vp8_vorbis.webm'],
  ['tracks-and-subtitles', 'cases/tracks_multi.mkv'],
  ['tracks-and-subtitles', 'tracks/tracks_vtt.webm'], ['tracks-and-subtitles', 'tracks/opengop_hevc.mkv'],
  ['long-and-odd', 'cases/long_20s.mp4'], ['long-and-odd', 'cases/rotated.mp4'],
  ['long-and-odd', 'cases/h264_60fps.mkv'], ['long-and-odd', 'cases/ntsc_2997.mkv'],
  ['long-and-odd', 'cases/truehd_51side.mkv'],
  ['long-and-odd', 'cases/damaged_h264.mkv'], ['long-and-odd', 'cases/trunc.mkv'],
];

const BASE_SETTINGS = {
  'workbench.startupEditor': 'none',
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'update.showReleaseNotes': false,
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false,
  'extensions.ignoreRecommendations': true,
  'telemetry.telemetryLevel': 'off',
  'window.restoreWindows': 'none',
};

const pad2 = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return `${date}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

// Set by this launcher only: a value inherited from the parent shell must not leak into the run.
const OWN_ENV = ['ELECTRON_RUN_AS_NODE', 'VPE_SIMULATE_LINK', 'VPE_SIMULATE_REMOTE', 'VPE_FFMPEG_SEARCH'];

/** The environment of the launched VS Code: no VSCODE_* / ELECTRON_RUN_AS_NODE leaking in from a VS Code terminal,
 *  and none of the simulation variables (--link and --no-ffmpeg add theirs afterwards). */
function cleanEnv(parent = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(parent)) {
    if (!/^VSCODE_/i.test(k) && !OWN_ENV.includes(k.toUpperCase())) env[k] = v;
  }
  return env;
}

/** A new, empty temp folder for one run; mkdtemp makes the name unique even within the same second. */
function makeWorkDir(when = stamp()) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vpe-review-${when}-`));
}

/**
 * --no-ffmpeg-on-path / --no-ffmpeg: the new VS Code sees no ffmpeg on PATH, as on a machine without it (to try
 * the first-video offer and the download). Changes `env` only. Off Windows ffmpeg usually sits in /usr/bin next to
 * everything else, so such a directory is replaced by a shim directory of symlinks to all its other files.
 */
function hideFfmpeg(o, env, work, dryRun) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const dirs = (env[key] || '').split(path.delimiter).filter(Boolean);
  const hasFf = (d) => ['ffmpeg.exe', 'ffmpeg'].some((n) => isFile(path.join(d, n)));
  const dropped = dirs.filter(hasFf);
  say(dropped.length
    ? `  ffmpeg hidden: removed from PATH: ${dropped.join('; ')}` : '  ffmpeg hidden: none was on PATH');
  let n = 0;
  env[key] = dirs.map((d) => {
    if (!hasFf(d)) return d;
    if (IS_WIN) return null;
    const shim = path.join(work, 'path', String(n++));
    if (!dryRun) {
      fs.mkdirSync(shim, { recursive: true });
      for (const f of fs.readdirSync(d)) {
        if (f === 'ffmpeg' || f === 'ffprobe') continue;
        try { fs.symlinkSync(path.join(d, f), path.join(shim, f)); } catch { /* skip */ }
      }
    }
    return shim;
  }).filter(Boolean).join(path.delimiter);
  if (o.noFfmpeg) {
    say('  ffmpeg hidden: lookup in the usual install places off (VPE_FFMPEG_SEARCH=off)');
    env.VPE_FFMPEG_SEARCH = 'off';
  }
}

async function launch(o) {
  const toolRoot = path.resolve(__dirname, '..');
  const main = findMain(toolRoot);
  const isVsix = isVsixPath(o.target);

  // 1. target. buildDir stays '' when the temp worktree (made once the temp folder exists) is the source.
  let vsix = '', buildDir = '', sha = '', short = '', version = '', describe = '';
  if (isVsix) {
    if (!isFile(o.target)) fail(`no such .vsix: ${o.target}`);
    if (o.dev) fail('--dev needs source code (a git ref), not a .vsix');
    vsix = path.resolve(o.target);
    short = 'vsix'; sha = '(prebuilt package)'; describe = `package ${vsix}`;
    try { version = readVsixVersion(vsix); } catch { version = '(unknown)'; }
  } else {
    const rev = git(main, 'rev-parse', '--verify', '--quiet', `${o.target}^{commit}`);
    if (!rev.ok || !rev.out) fail(`'${o.target}' is neither a .vsix file nor a git ref in ${main}`);
    sha = rev.out;
    short = git(main, 'rev-parse', '--short=7', sha).out;
    describe = `${o.target} @ ${short}`;
    const wt = worktreeOf(main, o.target); // a worktree that has this branch checked out?
    if (wt) {
      const dirtyCount = git(wt, 'status', '--porcelain').raw.split(/\r?\n/).filter(Boolean).length;
      if (o.dirty) {
        buildDir = wt; describe += ` (working copy of ${wt}, ${dirtyCount} uncommitted change(s))`;
      } else if (dirtyCount > 0) {
        note(`${wt} has ${dirtyCount} uncommitted change(s); building the COMMITTED state (${short}). `
          + 'Use --dirty to include them.');
      }
    } else if (o.dirty) note(`--dirty: no worktree has '${o.target}' checked out; using the committed state.`);
    if (buildDir) {
      sha = git(buildDir, 'rev-parse', 'HEAD').out;
      short = `${git(buildDir, 'rev-parse', '--short=7', 'HEAD').out}-dirty`;
      version = JSON.parse(fs.readFileSync(path.join(buildDir, 'package.json'), 'utf8')).version;
    } else {
      version = JSON.parse(git(main, 'show', `${sha}:package.json`).raw).version;
    }
  }

  // 3a. VS Code
  let getCode = path.join(main, 'test', 'vscode', 'get_code.js');
  if (!isFile(getCode)) getCode = path.join(toolRoot, 'test', 'vscode', 'get_code.js');
  const vs = resolveVsCode(o, getCode);

  // 4. review folder
  const findMedia = (rel) => {
    for (const root of [toolRoot, main]) {
      const p = path.join(root, 'test', 'media', ...rel.split('/'));
      if (fs.existsSync(p)) return p;
    }
    return '';
  };
  const items = [], missing = [];
  for (const [group, rel] of MEDIA_PLAN) {
    const p = findMedia(rel);
    if (p) items.push([group, p, path.basename(rel)]); else missing.push(rel);
  }
  const sidecarSrc = findMedia('cases/long_20s.mp4');
  const srt = [toolRoot, main].map((r) => path.join(r, 'test', 'subtitles', 'fixtures', 'overlap.srt'))
    .find(isFile) || '';
  if (o.media && !isDir(o.media)) fail(`--media folder not found: ${o.media}`);
  if (o.checklist && !isFile(o.checklist)) fail(`--checklist file not found: ${o.checklist}`);

  // The run's own temp folder, made only now that nothing can be refused any more (a dry run just names one).
  const work = o.dryRun ? path.join(os.tmpdir(), `vpe-review-${stamp()}-XXXXXX`) : makeWorkDir();
  const src = path.join(work, 'src'); // temp worktree (when needed)
  const userData = path.join(work, 'user-data');
  const extDir = path.join(work, 'extensions');
  const videos = path.join(work, 'videos');
  const openFolder = o.media || videos;
  const reviewMd = path.join(openFolder, 'REVIEW.md');
  const needWorktree = !isVsix && !buildDir;
  if (needWorktree) buildDir = src;
  if (!isVsix) vsix = path.join(work, `vpe-${short}.vsix`);

  // summary
  const needBuild = !o.dev && !isVsix;
  const extra = linkEnv(o.link);
  say();
  say(`Review launcher${o.dryRun ? ' (DRY RUN: nothing is created or launched)' : ''}`);
  say(`  target       : ${describe}`);
  say(`  commit       : ${sha}`);
  say(`  version      : ${version} (package.json)`);
  say(`  mode         : ${o.dev ? 'development host (--extensionDevelopmentPath, no package)' : 'installed VSIX'}`);
  say(`  VS Code      : ${vs.version}  [${vs.exe}]`);
  say(`  profile      : ${work}  (user-data, extensions)`);
  say(`  folder       : ${openFolder}${o.media ? '  (your own folder)' : ''}`);
  if (o.link !== 'off') say(`  ssh link     : ${LINKS[o.link]}  [${o.link}]`);
  if (o.transcode) say(`  transcode    : ${o.transcode}  (seeded in settings.json)`);
  if (o.firstRun) say('  first run    : the setup guide opens on start, as after a fresh install');
  if (missing.length) {
    say(`  missing media: ${missing.join(', ')}  (made by test/media/make_media.js, test/tracks/make_media.js)`);
  }
  say();

  const settings = { ...BASE_SETTINGS };
  if (o.transcode) settings['videoPreviewEnhanced.transcode'] = o.transcode;
  // VS Code's default; the extension then opens its setup guide on the first start (src/walkthrough.js shouldOpenGuide)
  if (o.firstRun) settings['workbench.welcomePage.walkthroughs.openOnInstall'] = true;
  const settingsFile = path.join(userData, 'User', 'settings.json');
  const buildArgs = ['--yes', '--prefer-offline', '@vscode/vsce', 'package', '-o', vsix];
  const buildCmd = `(cd ${q(buildDir)}) npx --yes --prefer-offline @vscode/vsce package -o ${q(vsix)}`;
  const wtCmd = `git -C ${q(main)} worktree add --detach ${q(src)} ${sha}`;
  const installArgs = ['--extensions-dir', extDir, '--user-data-dir', userData, '--install-extension', vsix];
  const installCmd = `${q(vs.cli)} ${installArgs.map((a, i) => (i % 2 ? q(a) : a)).join(' ')}`;
  const launchArgs = ['--user-data-dir', userData, '--extensions-dir', extDir, '--new-window', '--skip-release-notes',
    '--skip-welcome', '--disable-workspace-trust'];
  if (o.dev) launchArgs.push(`--extensionDevelopmentPath=${buildDir}`);
  if (vs.wait && !o.noWait) launchArgs.push('--wait');
  launchArgs.push(openFolder, reviewMd);
  const launchCmd = `${q(vs.exe)} ${showLaunch(launchArgs)}`;
  const envLines = Object.entries({ ...extra, ...(o.noFfmpeg ? { VPE_FFMPEG_SEARCH: 'off' } : {}) })
    .map(([k, v]) => `ENV: ${k}=${v}`);

  if (o.dryRun) {
    say('Plan:');
    const env = cleanEnv();
    if (o.noFfmpeg || o.noFfmpegOnPath) hideFfmpeg(o, env, work, true);
    if (vs.fetch) cmd(`node ${q(getCode)} ${vs.version}`);
    if (needWorktree) cmd(wtCmd);
    if (needBuild) cmd(buildCmd);
    cmd(`write ${q(settingsFile)}  (no welcome page, no trust prompt, no updates, telemetry off${
      o.transcode ? `, transcode ${o.transcode}` : ''})`);
    if (!o.dev) cmd(installCmd);
    if (!o.media) {
      for (const i of items) cmd(`hardlink-or-copy ${q(i[1])} -> ${q(path.join(videos, i[0], i[2]))}`);
      if (sidecarSrc && srt) {
        cmd(`sidecar pair: ${q(path.join(videos, 'subtitles', 'long_20s.mp4'))} + long_20s.en.srt (from ${q(srt)})`);
      }
    }
    cmd(o.checklist ? `copy ${q(o.checklist)} -> ${q(reviewMd)}` : `write default ${q(reviewMd)}`);
    for (const l of envLines) say(l);
    cmd(launchCmd);
    if (!o.keep) {
      if (needWorktree) cmd(`git -C ${q(main)} worktree remove --force ${q(src)}`);
      cmd(`remove ${q(work)}  (after the window closes)`);
    }
    return;
  }

  let madeWorktree = false, keep = o.keep;
  const cleanup = () => {
    if (keep) { say(`Kept: ${work}`); return; }
    if (madeWorktree) {
      git(main, 'worktree', 'remove', '--force', src); git(main, 'worktree', 'prune'); madeWorktree = false;
    }
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 2000 });
    } catch { /* reported below */ }
    if (fs.existsSync(work)) note(`could not fully remove ${work}`); else say(`Cleaned up ${work}`);
    keep = true; // once
  };
  // Ctrl+C: from the first signal on, this path alone cleans up, and only once VS Code is confirmed gone.
  let child = null, exited = Promise.resolve(), shutdown = null;
  const onSignal = () => {
    shutdown = shutdown || (async () => {
      if (await stopVsCode(child, exited)) cleanup();
      else {
        keep = true; // the profile and the worktree may still be in use
        note(`could not confirm that VS Code has exited; ${work} (profile, worktree) is left in place. `
          + 'Remove it yourself once VS Code is closed.');
        cleanup();
      }
      process.exit(130);
    })();
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  try {
    const env = cleanEnv();
    if (o.noFfmpeg || o.noFfmpegOnPath) hideFfmpeg(o, env, work, false);
    Object.assign(env, extra);
    if (vs.fetch) {
      say(`Fetching VS Code ${vs.version} ...`);
      cmd(`node ${q(getCode)} ${vs.version}`);
      const f = spawnSync(process.execPath, [getCode, vs.version], { stdio: 'inherit', windowsHide: true });
      if (f.status !== 0 || !isFile(vs.exe)) fail(`could not fetch VS Code ${vs.version} (network? try --installed)`);
    }
    if (needWorktree) {
      cmd(wtCmd);
      madeWorktree = git(main, 'worktree', 'add', '--detach', src, sha).ok;
      if (!madeWorktree) fail('git worktree add failed');
    }
    if (needBuild) {
      cmd(buildCmd);
      const b = run(IS_WIN ? 'npx.cmd' : 'npx', buildArgs, { cwd: buildDir, stdio: 'inherit', env });
      if (b.status !== 0 || !isFile(vsix)) {
        fail("vsce failed. It is fetched with npx on first use (needs network once; later runs use the npm cache). "
          + "Check 'npx --yes @vscode/vsce --version', or build a .vsix yourself and pass its path.");
      }
    }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    if (!o.dev) {
      cmd(installCmd);
      const r = runCode(vs.cli, installArgs, env);
      for (const l of `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).filter(Boolean)) say(`  ${l}`);
      if (r.status !== 0) fail('installing the VSIX failed');
    }
    if (!o.media) {
      for (const [group, from, name] of items) {
        fs.mkdirSync(path.join(videos, group), { recursive: true });
        linkOrCopy(from, path.join(videos, group, name));
      }
      if (sidecarSrc && srt) {
        const d = path.join(videos, 'subtitles');
        fs.mkdirSync(d, { recursive: true });
        linkOrCopy(sidecarSrc, path.join(d, 'long_20s.mp4')); fs.copyFileSync(srt, path.join(d, 'long_20s.en.srt'));
      }
    }
    if (o.checklist) fs.copyFileSync(o.checklist, reviewMd);
    else {
      const sidecar = Boolean(sidecarSrc && srt);
      fs.writeFileSync(reviewMd, defaultChecklist({ o, describe, version, sha, vs, items, missing, sidecar }));
    }
    say('Launching VS Code ...');
    for (const l of envLines) say(l);
    cmd(launchCmd);
    child = spawn(vs.exe, launchArgs, { env, stdio: 'ignore', detached: o.noWait || !IS_WIN });
    exited = new Promise((resolve) => child.once('exit', resolve));
    if (o.noWait) {
      child.unref(); keep = true; note(`--no-wait: leaving ${work} in place; delete it yourself.`);
    } else {
      await Promise.race([exited, new Promise((_, reject) => child.once('error', reject))]);
    }
  } finally {
    if (shutdown) await shutdown; // never returns: it exits the process
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    cleanup();
  }
}

/**
 * Stops the VS Code process tree started as `child` and resolves true only once nothing of it is left (so its
 * profile can be deleted): on Windows taskkill exited 0 and the child exited; elsewhere the child
 * exited and its whole process group is gone. False when that is not confirmed within `timeoutMs`.
 */
async function stopVsCode(child, exited, timeoutMs = 10000) {
  if (!child) return true;
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const groupAlive = () => {
    try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  if (!gone()) {
    if (IS_WIN) {
      const rem = Math.max(100, deadline - Date.now());
      const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: rem });
      if (r.error || r.status !== 0) return false; // 128 ("not found") cannot confirm descendants exited
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') return false; }
    }
    await Promise.race([exited, sleep(Math.max(0, deadline - Date.now()))]);
    if (!gone()) return false;
  }
  while (!IS_WIN && groupAlive()) { // the child is its own process group leader (spawned detached)
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/** The default REVIEW.md: what was started and a tick list of the clips. */
function defaultChecklist({ o, describe, version, sha, vs, items, missing, sidecar }) {
  let md = `# Review: ${describe}\n\nversion ${version}, commit ${sha}, VS Code ${vs.version}\n\n`;
  if (o.link !== 'off') {
    const vars = Object.entries(linkEnv(o.link)).map(([k, v]) => `${k}=${v}`).join(', ');
    md += `SSH link simulation: ${LINKS[o.link]} (${vars})\n\n`;
  }
  if (o.transcode) md += `Live transcode setting: ${o.transcode}\n\n`;
  if (o.media) return `${md}Your own folder: ${o.media}\n`;
  md += 'This folder holds linked copies of test clips (deleted when the window closes). '
    + 'Open them and check they play:\n\n';
  for (const g of [...new Set(items.map((i) => i[0]))]) {
    md += `## ${g}\n${items.filter((i) => i[0] === g).map((i) => `- [ ] ${i[2]}\n`).join('')}\n`;
  }
  if (sidecar) md += '## subtitles\n- [ ] long_20s.mp4 (with long_20s.en.srt next to it)\n\n';
  if (missing.length) md += `Not available here: ${missing.join(', ')}\n`;
  return md;
}

/** The menu's choice as options, plus what was given on the command line and the menu cannot change
 *  (--dry-run, --media, --checklist, --code, --no-wait). */
function mergeMenuArgs(original, picked) {
  const o = parseArgs(picked);
  for (const k of ['media', 'checklist', 'code', 'noWait']) o[k] = original[k];
  o.dryRun = o.dryRun || original.dryRun;
  return o;
}

async function cli(argv) {
  let o = parseArgs(argv);
  if (o.help) { say(USAGE); return; }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (o.ui || (argv.length === 0 && interactive)) {
    if (!interactive) fail('--ui needs an interactive terminal');
    let branches = [];
    try {
      const main = findMain(path.resolve(__dirname, '..'));
      branches = git(main, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads')
        .raw.split(/\r?\n/).filter(Boolean).slice(0, 30);
    } catch { /* no git: only main and HEAD */ }
    const picked = await runUi(createUiState({ branches, args: argv.length ? o : null }));
    if (!picked) return;
    o = mergeMenuArgs(o, picked);
  }
  await launch(o);
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(() => process.exit(0), (e) => {
    console.error(`review: ERROR: ${e instanceof ReviewError ? e.message : e.stack || e}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, linkEnv, createUiState, applyKey, renderUi, stateToArgs, parseKeys, readVsixVersion, LINKS,
  mergeMenuArgs, cleanEnv, makeWorkDir, stopVsCode,
};
