'use strict';
// node test/host/review_test.js: tools/review.js --dry-run prints the right commands and launches nothing, on every
// platform; the interactive menu is a pure state machine; the PowerShell wrapper still works on Windows.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'tools', 'review.js');
const review = require(script);
const tmp = os.tmpdir().toLowerCase();

function node(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true });
}
function dry(...args) {
  const r = node('--dry-run', ...args);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
const cmds = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('CMD: ')).map((l) => l.slice(5));
const envs = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('ENV: ')).map((l) => l.slice(5));
const arg = (line, flag) => (line.match(new RegExp(`${flag} "([^"]+)"`)) || [])[1];
const isLaunch = (x) => /--user-data-dir/.test(x) && !/--install-extension/.test(x) && !/^git /.test(x);

function checkCommon(out) {
  const c = cmds(out);
  const launch = c.find(isLaunch);
  assert(launch, 'launch command printed');
  const ud = arg(launch, '--user-data-dir'), ed = arg(launch, '--extensions-dir');
  assert(ud && ed, 'fresh --user-data-dir and --extensions-dir');
  for (const d of [ud, ed]) assert(d.toLowerCase().startsWith(tmp) && /vpe-review-\d{8}-\d{6}/.test(d), `under TEMP: ${d}`);
  assert(!/Roaming[\\/]Code/i.test(out), 'real profile untouched');
  assert(!/\.vscode[\\/]extensions/i.test(out), 'home extensions untouched');
  assert(/videos" "[^"]*REVIEW\.md"/.test(launch), 'folder and REVIEW.md opened');
  assert(c.some((x) => /settings\.json/.test(x)), 'settings seeded');
  return c;
}

// ---- --dry-run, POSIX flags ----

// HEAD (CI checkouts have no local main): temp worktree, package, install, launch.
let out = dry('HEAD');
let c = checkCommon(out);
assert(c.some((x) => /worktree add --detach/.test(x)), 'temp worktree');
assert(c.some((x) => /vsce package -o ".*vpe-[0-9a-f]{7}\.vsix"/.test(x)), 'vsce package');
assert(c.some((x) => /code(\.cmd)?" --extensions-dir ".*" --user-data-dir ".*" --install-extension ".*\.vsix"/.test(x)),
  'VSIX install');
assert(/version\s+:\s+\d+\.\d+\.\d+/.test(out) && /commit\s+:\s+[0-9a-f]{40}/.test(out), 'summary');
assert(c.some((x) => /hardlink-or-copy .*h264_aac_anim_1080p\.mp4/.test(x)), 'media linked');
assert(!/ssh link|transcode\s+:/.test(out) && envs(out).length === 0, 'no link or transcode unless asked');
assert(!/transcode/.test(c.find((x) => /settings\.json/.test(x))), 'no transcode seeded');

// a .vsix path is used as is: no worktree, no build.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-review-fixture-'));
const vsix = path.join(fixtureDir, 'test.vsix');
try {
  fs.writeFileSync(vsix, 'not a real package');
  for (const flags of [[], ['-DryRun']]) { // PowerShell spelling too
    const r = node(...(flags.length ? flags : ['--dry-run']), vsix);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    out = r.stdout;
    c = checkCommon(out);
    assert(!c.some((x) => /worktree add|vsce/.test(x)), 'no build for a vsix');
    assert(c.some((x) => x.includes(`--install-extension "${vsix}"`)), 'installs the given vsix');
    assert(/version\s+: \(unknown\)/.test(out), 'unreadable package: version unknown');
  }
  const bad = node('--dry-run', '--dev', vsix);
  assert.notStrictEqual(bad.status, 0);
  assert(/needs source code/.test(bad.stdout + bad.stderr), '--dev with a vsix is refused');
} finally { fs.rmSync(fixtureDir, { recursive: true, force: true }); }

// --dev / -Dev: no package, no install
for (const flag of ['--dev', '-Dev']) {
  const r = node('--dry-run', 'HEAD', flag);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  c = cmds(r.stdout);
  assert(c.some((x) => /--extensionDevelopmentPath="/.test(x)) && !c.some((x) => /--install-extension|vsce/.test(x)), flag);
}

// --link: simulated Remote-SSH link, in the summary, the environment and the checklist
out = dry('HEAD', '--dev', '--link', 'flaky-ssh');
assert(/ssh link\s+: Flaky SSH \(4 Mbps, 120ms \+ drops\)/.test(out), 'link in summary');
assert.deepStrictEqual(envs(out).sort(), ['VPE_SIMULATE_LINK=flaky-ssh', 'VPE_SIMULATE_REMOTE=ssh-remote']);
assert.deepStrictEqual(envs(dry('HEAD', '--dev', '-Link', 'remote')), ['VPE_SIMULATE_REMOTE=ssh-remote']);
assert.deepStrictEqual(envs(dry('HEAD', '--dev', '--link=fast-ssh')).sort(),
  ['VPE_SIMULATE_LINK=fast-ssh', 'VPE_SIMULATE_REMOTE=ssh-remote']);
assert.deepStrictEqual(envs(dry('HEAD', '--dev', '--link', 'off')), []);
assert.deepStrictEqual(review.linkEnv('slow-ssh'), { VPE_SIMULATE_LINK: 'slow-ssh', VPE_SIMULATE_REMOTE: 'ssh-remote' });
// A link the extension has no preset for goes as its key=val spec (src/link-sim.js parseLinkSpec).
assert.deepStrictEqual(review.linkEnv('very-slow-ssh'),
  { VPE_SIMULATE_LINK: 'mbps=1,rtt=150,jitter=30', VPE_SIMULATE_REMOTE: 'ssh-remote' });
assert.deepStrictEqual(require('../../src/link-sim').parseLinkSpec(review.LINK_SPECS['very-slow-ssh']).downMbps, 1);

// --stress / --stress-quick: the generator runs (printed only in a dry run) and its clips go in a 'stress' group.
for (const [flag, quick] of [['--stress', false], ['--stress-quick', true]]) {
  out = dry('HEAD', '--dev', flag);
  const gen = cmds(out).find((x) => /make_stress_media\.js/.test(x));
  assert(gen && /--out ".*[\\/]test[\\/]media[\\/]\.stress"/.test(gen), `${flag}: generator into test/media/.stress`);
  assert.strictEqual(/ --quick/.test(gen), quick, `${flag}: quick or full`);
  assert(cmds(out).some((x) => /hardlink-or-copy .*hevc10_pq_2160p25_100mbps_gop250\.mp4" -> ".*[\\/]stress[\\/]/.test(x)),
    `${flag}: stress clips linked into the stress group`);
}
assert(!cmds(dry('HEAD', '--dev')).some((x) => /make_stress_media/.test(x)), 'no stress clips unless asked');

// --ffmpeg: seeds videoPreviewEnhanced.ffmpegPath; a missing file or --no-ffmpeg alongside is refused.
{
  const exe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-review-ff-')), 'ffmpeg.exe');
  fs.writeFileSync(exe, '');
  out = dry('HEAD', '--dev', '--ffmpeg', exe);
  assert(cmds(out).some((x) => /settings\.json.*ffmpegPath .*ffmpeg\.exe/.test(x)), 'ffmpegPath seeded');
  assert(/ffmpeg\s+: .*ffmpeg\.exe/.test(out), 'ffmpeg in summary');
  assert.notStrictEqual(node('--dry-run', 'HEAD', '--ffmpeg', `${exe}.missing`).status, 0, 'missing --ffmpeg refused');
  assert.throws(() => review.parseArgs(['--ffmpeg', exe, '--no-ffmpeg']), /cannot be combined/);
  fs.rmSync(path.dirname(exe), { recursive: true, force: true });
}

// --transcode: seeded into the throwaway profile's settings.json
for (const flags of [['--transcode', 'always'], ['-Transcode', 'always']]) {
  out = dry('HEAD', '--dev', ...flags);
  assert(/transcode\s+: always/.test(out), 'transcode in summary');
  assert(cmds(out).some((x) => /settings\.json.*transcode always/.test(x)), 'transcode seeded');
}

// --no-ffmpeg also turns the install-place lookup off for the launched VS Code
assert.deepStrictEqual(envs(dry('HEAD', '--dev', '--no-ffmpeg')), ['VPE_FFMPEG_SEARCH=off']);
assert.deepStrictEqual(envs(dry('HEAD', '--dev', '-NoFfmpegOnPath')), []);
assert(/ffmpeg hidden/.test(dry('HEAD', '--dev', '-NoFfmpegOnPath')));

// --keep drops the clean-up lines
assert(!cmds(dry('HEAD', '--dev', '--keep')).some((x) => /^remove /.test(x)));

// --help, bad values and a bad target are clear errors
assert(/Usage: node tools\/review\.js/.test(node('--help').stdout));
for (const bad of [['--link', 'dialup'], ['--transcode', 'sometimes'], ['--frobnicate'], ['--link']]) {
  const r = node('--dry-run', ...bad);
  assert.notStrictEqual(r.status, 0, bad.join(' '));
  assert(/review: ERROR/.test(r.stderr), r.stderr);
}
const badRef = node('--dry-run', 'no-such-ref-xyz');
assert.notStrictEqual(badRef.status, 0);
assert(/neither a \.vsix file nor a git ref/.test(badRef.stdout + badRef.stderr));
assert(/no such \.vsix/.test(node('--dry-run', 'missing.vsix').stderr));
// no arguments and no terminal: runs the default target, never waits for keys
assert.strictEqual(node('--ui').status, 1);
assert(/needs an interactive terminal/.test(node('--ui').stderr));

// ---- argument spellings ----
const posix = review.parseArgs(['HEAD', '--dev', '--dirty', '--dry-run', '--no-wait', '--keep', '--installed',
  '--no-ffmpeg-on-path', '--code', '1.100.0', '--media', 'm', '--checklist', 'c.md', '--ui']);
const legacy = review.parseArgs(['HEAD', '-Dev', '-Dirty', '-DryRun', '-NoWait', '-Keep', '-Installed',
  '-NoFfmpegOnPath', '-Code', '1.100.0', '-Media', 'm', '-Checklist', 'c.md', '-Ui']);
assert.deepStrictEqual(posix, legacy);
assert.strictEqual(posix.dev && posix.dirty && posix.dryRun && posix.noWait && posix.keep && posix.installed, true);
assert.strictEqual(posix.noFfmpegOnPath && posix.ui, true);
assert.strictEqual(posix.noFfmpeg, false);
assert.strictEqual(review.parseArgs(['--no-ffmpeg']).noFfmpeg, true);
assert.strictEqual(review.parseArgs([]).target, 'main');
assert.strictEqual(review.parseArgs(['-h']).help, true);
assert.throws(() => review.parseArgs(['a', 'b']), /unexpected argument/);

// ---- the interactive menu ----
function press(state, ...keys) {
  let action = null;
  for (const k of keys) { const r = review.applyKey(state, k); state = r.state; action = r.action; }
  return { state, action };
}
const fresh = () => review.createUiState({ branches: ['feat/x', 'main'], platform: 'win32' });

let s = fresh();
assert.deepStrictEqual(review.stateToArgs(s), ['main', '--dev'], 'defaults: main, dev host');
assert.deepStrictEqual(review.stateToArgs(review.createUiState({ platform: 'linux' })), ['main', '--dev', '--installed'],
  'no portable build off Windows');

// move down to each row and change it
({ state: s } = press(s, 'down', 'right')); // Mode -> Installed VSIX
assert.deepStrictEqual(review.stateToArgs(s), ['main']);
({ state: s } = press(s, 'down', ' ')); // Working copy -> Dirty (Space)
assert.deepStrictEqual(review.stateToArgs(s), ['main', '--dirty']);
({ state: s } = press(s, 'down', 'right')); // VS Code -> Installed
({ state: s } = press(s, 'down', 'right', 'right', 'right', 'right', 'right')); // link: off, fast, typical, slow, very slow, flaky
({ state: s } = press(s, 'down', 'right')); // Live transcode -> Always
({ state: s } = press(s, 'down', 'right', 'right')); // FFmpeg -> No ffmpeg at all
({ state: s } = press(s, 'down', 'right')); // Setup guide -> Open on start
({ state: s } = press(s, 'down', 'right')); // Stress clips -> Quick
({ state: s } = press(s, 'down', 'right')); // Keep -> Yes
assert.deepStrictEqual(review.stateToArgs(s), ['main', '--dirty', '--installed', '--link', 'flaky-ssh', '--transcode',
  'always', '--no-ffmpeg', '--first-run', '--stress-quick', '--keep']);
const parsed = review.parseArgs(review.stateToArgs(s)); // the menu only makes arguments the launcher accepts
assert.strictEqual(parsed.link, 'flaky-ssh');
assert.strictEqual(parsed.transcode, 'always');
assert.strictEqual(parsed.noFfmpeg, true);
assert.strictEqual(parsed.firstRun, true);
assert.strictEqual(parsed.stressQuick, true);
assert.strictEqual(review.createUiState({ args: review.parseArgs(['--stress']) }).v.stress, 2, '--stress pre-selects Full');
({ state: s } = press(s, 'left', 'left')); // Yes -> No -> Yes
assert.strictEqual(s.v.keep, 1, 'a two-state row wraps');
({ state: s } = press(s, 'up', 'up', 'up', 'left')); // FFmpeg: No ffmpeg -> Hide on PATH
assert(review.stateToArgs(s).includes('--no-ffmpeg-on-path'));
assert.strictEqual(Object.keys(review.LINKS).length, 7);

// target: cycle the known refs, wrap, or type one
s = fresh();
({ state: s } = press(s, 'right'));
assert.strictEqual(s.target, 'HEAD');
({ state: s } = press(s, 'right'));
assert.strictEqual(s.target, 'feat/x');
({ state: s } = press(s, 'right'));
assert.strictEqual(s.target, 'main', 'wraps around');
({ state: s } = press(s, 'left'));
assert.strictEqual(s.target, 'feat/x');
({ state: s } = press(s, 'down', 'up', 'up')); // Up from the first row goes to Launch
assert.strictEqual(s.row, 10);
({ state: s } = press(s, 'down'));
assert.strictEqual(s.row, 0, 'wraps to the top');
({ state: s } = press(fresh(), 'e', 'q', 'x', '.', 'v', 's', 'i', 'x', 'backspace', 'x')); // 'q' is text while typing
assert.strictEqual(s.edit, 'qx.vsix');
({ state: s } = press(s, 'enter'));
assert.strictEqual(s.target, 'qx.vsix');
assert.strictEqual(s.edit, null);
assert.deepStrictEqual(review.stateToArgs(s), ['qx.vsix'], 'a package is neither built nor developed');
({ state: s } = press(s, 'enter', 'esc')); // Enter on Target types; Esc cancels and keeps the target
assert.strictEqual(s.target, 'qx.vsix');
assert.strictEqual(s.edit, null);
assert.strictEqual(press(s, 'enter', 'enter').state.target, 'qx.vsix'); // an empty edit keeps the target
assert.strictEqual(press(fresh(), 'enter', ...'my branch'.split(''), 'enter').state.target, 'my branch');
assert.deepStrictEqual(review.stateToArgs(press(fresh(), 'enter', ...'my branch'.split(''), 'enter').state),
  ['my branch', '--dev']);

// actions
assert.strictEqual(press(fresh(), 'd').action, 'dry');
assert.strictEqual(press(fresh(), 'D').action, 'dry');
assert.strictEqual(press(fresh(), 'q').action, 'quit');
assert.strictEqual(press(fresh(), 'esc').action, 'quit');
assert.strictEqual(press(fresh(), 'ctrl-c').action, 'quit');
assert.strictEqual(press(fresh(), 'enter').action, null, 'Enter on Target edits');
assert.strictEqual(press(fresh(), 'up', 'enter').action, 'launch', 'Enter on Launch launches');
assert.strictEqual(press(fresh(), 'down', 'enter').action, null, 'Enter on an option row changes it');
assert.strictEqual(press(fresh(), 'down', 'enter').state.v.mode, 1);
const before = fresh();
const same = JSON.stringify(before);
press(before, 'down', 'right', 'e', 'x');
assert.strictEqual(JSON.stringify(before), same, 'applyKey does not change the state it is given');

// pre-selected from the command line (--ui with flags)
const seeded = review.createUiState({
  platform: 'win32', args: review.parseArgs(['feat/x', '--dirty', '--link', 'slow-ssh', '--transcode', 'off', '--no-ffmpeg-on-path']),
});
assert.deepStrictEqual(review.stateToArgs(seeded),
  ['feat/x', '--dirty', '--link', 'slow-ssh', '--transcode', 'off', '--no-ffmpeg-on-path']);

// the text on screen
const screen = review.renderUi(fresh());
for (const label of ['Target', 'Mode', 'Working copy', 'VS Code', 'SSH / Link sim', 'Live transcode', 'FFmpeg',
  'Keep temp profile', '[ Launch ]', 'Dev host (fast)', 'Committed', 'Pinned portable', 'Off (local)', 'Auto (default)', 'Normal']) {
  assert(screen.includes(label), `menu shows ${label}`);
}
assert(/^> Target\s+main$/m.test(screen), 'cursor on Target');
assert(/Command: node tools\/review\.js main --dev$/.test(screen), 'shows the command');
assert(screen.split('\n').filter((l) => /^[> ] /.test(l)).length === 11, '10 rows and Launch');
const typing = review.renderUi(press(fresh(), 'e', 'x').state);
assert(/Target\s+x_/.test(typing) && /Esc = cancel/.test(typing), 'typing is visible');
assert(/\(not used for a \.vsix\)/.test(review.renderUi(press(fresh(), 'e',
  '.', 'v', 's', 'i', 'x', 'enter').state)));
for (const [i, text] of Object.values(review.LINKS).entries()) {
  assert(review.renderUi(press(fresh(), 'down', 'down', 'down', 'down', ...Array(i).fill('right')).state).includes(text), text);
}

// raw terminal input
assert.deepStrictEqual(review.parseKeys('\x1b[A\x1b[B\x1b[C\x1b[Dq\r'), ['up', 'down', 'right', 'left', 'q', 'enter']);
assert.deepStrictEqual(review.parseKeys('\x1b'), ['esc']);
assert.deepStrictEqual(review.parseKeys('\x7f\x03 '), ['backspace', 'ctrl-c', ' ']);
assert.deepStrictEqual(review.parseKeys('\x1b[3~'), ['unknown']);

// ---- .vsix version, read without a zip library ----
function zip(name, content, deflate) {
  const raw = Buffer.from(content);
  const data = deflate ? zlib.deflateRawSync(raw) : raw;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
  const offset = 0;
  central.writeUInt32LE(offset, 42);
  const body = Buffer.concat([local, nameBuf, data]);
  const dir = Buffer.concat([central, nameBuf]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, end]);
}
const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-review-package-'));
const pkgFile = path.join(pkgDir, 'test.vsix');
try {
  for (const deflate of [false, true]) {
    fs.writeFileSync(pkgFile, zip('extension/package.json', '{"version":"1.2.3"}', deflate));
    assert.strictEqual(review.readVsixVersion(pkgFile), '1.2.3');
    out = dry(pkgFile);
    assert(/version\s+: 1\.2\.3/.test(out), 'summary shows the package version');
  }
  fs.writeFileSync(pkgFile, zip('other.txt', 'x', false));
  assert.throws(() => review.readVsixVersion(pkgFile));
} finally { fs.rmSync(pkgDir, { recursive: true, force: true }); }

// ---- the old PowerShell entry point still works (Windows) ----
if (process.platform === 'win32') {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'review.ps1'),
    '-DryRun', '-Dev', '-Link', 'slow-ssh', 'HEAD'], { encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert(/Review launcher \(DRY RUN/.test(r.stdout) && /commit\s+:\s+[0-9a-f]{40}/.test(r.stdout), 'ps1 wrapper summary');
  assert(cmds(r.stdout).some((x) => /--extensionDevelopmentPath=/.test(x)), 'ps1 wrapper passes -Dev');
  assert(envs(r.stdout).includes('VPE_SIMULATE_LINK=slow-ssh'), 'ps1 wrapper passes -Link');
  const badPs = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', 'review.ps1'),
    '-DryRun', 'no-such-ref-xyz'], { encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true });
  assert.notStrictEqual(badPs.status, 0, 'ps1 wrapper passes the exit code');
}

// ---- regressions: what the menu keeps, temp folders, environment, quitting ----

// Ctrl+C quits, also while typing a ref
assert.strictEqual(press(fresh(), 'e', 'x', 'ctrl-c').action, 'quit');

// Launch from the menu keeps what the menu cannot change (--dry-run, --media, --checklist, --code, --no-wait)
{
  const original = review.parseArgs(['--ui', '--dry-run', '--media', 'm', '--checklist', 'c.md', '--code', '1.1.1',
    '--no-wait', '--keep', 'HEAD']);
  const menu = review.stateToArgs(press(review.createUiState({ args: original, platform: 'win32' }), 'right').state);
  const merged = review.mergeMenuArgs(original, menu);
  assert.strictEqual(merged.dryRun && merged.noWait, true);
  assert.deepStrictEqual([merged.media, merged.checklist, merged.code], ['m', 'c.md', '1.1.1']);
  assert.strictEqual(merged.keep, true, 'menu choices still come from the menu');
  assert.strictEqual(merged.target, 'main', 'target from the menu (HEAD -> next)');
  const off = review.mergeMenuArgs(original, ['main', '--dev']);
  assert.strictEqual(off.keep, false, 'a menu choice turned off stays off');
  const asked = review.mergeMenuArgs(review.parseArgs(['--ui']), ['main', '--dry-run']); // the menu's own D key
  assert.strictEqual(asked.dryRun, true);
  assert.strictEqual(review.mergeMenuArgs(review.parseArgs(['--ui']), ['main']).dryRun, false);
}

// every run gets its own folder, even in the same second
{
  const a = review.makeWorkDir('20990101-000000'), b = review.makeWorkDir('20990101-000000');
  try {
    assert.notStrictEqual(a, b);
    assert(fs.statSync(a).isDirectory() && fs.statSync(b).isDirectory() && fs.readdirSync(a).length === 0);
    assert(/vpe-review-20990101-000000-.+$/.test(path.basename(a)));
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('vpe-review-')).length;
  dry('HEAD');
  assert.strictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('vpe-review-')).length, before,
    'a dry run creates nothing');
  const refused = node('no-such-ref-xyz');
  assert.notStrictEqual(refused.status, 0);
  assert.strictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('vpe-review-')).length, before,
    'a refused target leaves no folder behind');
}

// simulation variables from the parent shell never leak in
{
  const env = review.cleanEnv({ PATH: '/x', Path2: 'y', VSCODE_PID: '1', vscode_ipc: '2', ELECTRON_RUN_AS_NODE: '1',
    VPE_SIMULATE_LINK: 'slow-ssh', VPE_SIMULATE_REMOTE: 'ssh-remote', VPE_FFMPEG_SEARCH: 'off', VPE_OTHER: 'keep' });
  assert.deepStrictEqual(env, { PATH: '/x', Path2: 'y', VPE_OTHER: 'keep' });
}

// ---- real runs against a fake VS Code (nothing visible starts) ----
const FAKE_CLI = `
const fs = require('fs');
if (process.argv[2] === '--version') { console.log('9.9.9'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ args: process.argv.slice(2), ras: process.env.ELECTRON_RUN_AS_NODE,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^VPE_(SIMULATE|FFMPEG)/.test(k))) }));
`;

/** A VS Code stand-in. Windows: Code.exe is node itself and bin\\code.cmd is laid out like the real one (Code.exe plus
 *  cli.js), so install goes through the cli; Linux/macOS: a `code` script that sleeps when launched. */
function fakeVsCode(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cli.js'), FAKE_CLI);
  if (process.platform === 'win32') {
    const exe = path.join(dir, 'Code.exe');
    try { fs.linkSync(process.execPath, exe); } catch { fs.copyFileSync(process.execPath, exe); }
    fs.writeFileSync(path.join(bin, 'code.cmd'), '@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n'
      + '"%~dp0..\\Code.exe" "%~dp0..\\cli.js" %*\r\n');
  } else {
    fs.writeFileSync(path.join(bin, 'code'), '#!/bin/sh\n'
      + 'case " $* " in *" --new-window "*)\n'
      + '  env | grep -E "^VPE_(SIMULATE|FFMPEG)" > "$FAKE_DIR/launch-env.txt"; echo $$ > "$FAKE_DIR/pid"\n'
      + '  if [ -n "$FAKE_STUBBORN" ]; then trap "" TERM; sleep 60; exit; fi # ignores SIGTERM, as do its children\n'
      + '  exec sleep 60;;\n'
      + 'esac\n'
      + 'exec node "$FAKE_DIR/cli.js" "$@"\n', { mode: 0o755 });
  }
  return bin;
}

function startReview(args, env) {
  const child = require('child_process').spawn(process.execPath, [script, ...args], { env, cwd: os.tmpdir(), windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, done, out: () => stdout, err: () => stderr };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, what, ms = 30000) {
  for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-review-fake-'));
  try {
    const bin = fakeVsCode(dir);
    const env = { ...process.env, FAKE_DIR: dir, FAKE_OUT: path.join(dir, 'install.json'),
      VPE_SIMULATE_LINK: 'slow-ssh', VPE_SIMULATE_REMOTE: 'stale', VPE_FFMPEG_SEARCH: 'off', VSCODE_FAKE: '1' };
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
    const pkg = path.join(dir, 'a%TEMP%b.vsix'); // '%TEMP%' must reach VS Code as is, not be expanded by cmd.exe
    fs.writeFileSync(pkg, 'not a package');
    const profileOf = (text) => (/profile\s+: (.+?)  \(user-data/.exec(text) || [])[1];

    const r = startReview(['--installed', '--link', 'remote', pkg], env);
    if (process.platform === 'win32') {
      const end = await r.done;
      assert.strictEqual(end.code, 0, r.out() + r.err());
      const seen = JSON.parse(fs.readFileSync(env.FAKE_OUT, 'utf8'));
      assert(seen.args.includes(pkg), `install got the literal path: ${seen.args}`);
      assert.strictEqual(seen.ras, '1', 'cli runs as node');
      assert.deepStrictEqual(seen.env, { VPE_SIMULATE_REMOTE: 'ssh-remote' }, 'stale link variables are replaced');
      assert(!fs.existsSync(profileOf(r.out())), 'normal exit cleans up');
    } else {
      // no signal handling on Windows consoles to test: Ctrl+C there is the same code path via taskkill
      const pidFile = path.join(dir, 'pid');
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 'the fake VS Code to start');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const profile = profileOf(r.out());
      assert(profile && fs.existsSync(profile), 'profile exists while VS Code runs');
      assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'launch-env.txt'), 'utf8').trim().split('\n'),
        ['VPE_SIMULATE_REMOTE=ssh-remote'], 'stale link and ffmpeg variables are replaced');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(env.FAKE_OUT, 'utf8')).env, { VPE_SIMULATE_REMOTE: 'ssh-remote' });
      assert(alive(pid));
      r.child.kill('SIGINT');
      const end = await r.done;
      assert.strictEqual(end.code, 130, r.out() + r.err());
      assert(!alive(pid), 'VS Code was stopped before the clean-up');
      assert(!fs.existsSync(profile), 'profile removed after Ctrl+C');
      assert(/Cleaned up/.test(r.out()));

      // a VS Code that does not stop: nothing is deleted while it may still be using the profile
      fs.rmSync(pidFile);
      const stubborn = startReview(['--installed', pkg], { ...env, FAKE_STUBBORN: '1' });
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 'the stubborn VS Code');
      const stubbornPid = Number(fs.readFileSync(pidFile, 'utf8'));
      const stubbornProfile = profileOf(stubborn.out());
      stubborn.child.kill('SIGTERM');
      const end2 = await stubborn.done;
      try {
        assert.strictEqual(end2.code, 130, stubborn.out() + stubborn.err());
        assert(alive(stubbornPid), 'still running');
        assert(fs.existsSync(path.join(stubbornProfile, 'user-data')), 'profile kept');
        assert(!/Cleaned up/.test(stubborn.out()), 'nothing deleted');
        assert(stubborn.out().includes(`could not confirm that VS Code has exited; ${stubbornProfile}`), stubborn.out());
        assert(stubborn.out().includes(`Kept: ${stubbornProfile}`));
      } finally {
        try { process.kill(-stubbornPid, 'SIGKILL'); } catch { /* gone */ }
        fs.rmSync(stubbornProfile, { recursive: true, force: true });
      }
    }

    // stopVsCode: true only when the whole tree is gone, false (quickly, here) when that is not confirmed
    const { spawn } = require('child_process');
    const detached = process.platform !== 'win32';
    const start = (args) => {
      const c = spawn(args[0], args.slice(1), { detached, stdio: 'ignore' });
      return { c, exited: new Promise((resolve) => c.once('exit', resolve)) };
    };
    const idle = ['-e', 'setInterval(() => {}, 1000)'];
    let p = start([process.execPath, ...idle]);
    await until(() => p.c.pid, 'the child');
    assert.strictEqual(await review.stopVsCode(p.c, p.exited, 5000), true, 'a running child is stopped');
    assert(!alive(p.c.pid));
    assert.strictEqual(await review.stopVsCode(p.c, p.exited, 5000), true, 'an already exited child is fine');
    assert.strictEqual(await review.stopVsCode(null, null), true, 'nothing started');
    if (process.platform !== 'win32') {
      // the leader obeys SIGTERM but a member of its process group ignores it: not confirmed
      p = start(['/bin/sh', '-c', '(trap "" TERM; exec sleep 30) & exec sleep 30']);
      await sleep(300);
      const t0 = Date.now();
      assert.strictEqual(await review.stopVsCode(p.c, p.exited, 600), false, 'a surviving group member is not confirmed');
      assert(Date.now() - t0 < 5000);
      try { process.kill(-p.c.pid, 'SIGKILL'); } catch { /* gone */ }
      // a child that ignores SIGTERM
      p = start(['/bin/sh', '-c', 'trap "" TERM; sleep 30']);
      await sleep(300);
      assert.strictEqual(await review.stopVsCode(p.c, p.exited, 600), false, 'a child that stays is not confirmed');
      try { process.kill(-p.c.pid, 'SIGKILL'); } catch { /* gone */ }
      await p.exited;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('review_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
