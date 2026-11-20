'use strict';
// node test/host/review_test.js: tools/review.ps1 -DryRun prints the right commands and launches nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') { console.log('review_test: skipped (Windows only)'); process.exit(0); }
const root = path.join(__dirname, '..', '..');
const script = path.join(root, 'tools', 'review.ps1');
const tmp = os.tmpdir().toLowerCase();

function ps(...args) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', ...args],
    { encoding: 'utf8', cwd: os.tmpdir(), windowsHide: true });
}
function dry(...args) {
  const r = ps(...args);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
const cmds = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('CMD: ')).map((l) => l.slice(5));
const arg = (line, flag) => (line.match(new RegExp(`${flag} "([^"]+)"`)) || [])[1];

function checkCommon(out) {
  const c = cmds(out);
  const launch = c.find((x) => /Code\.exe" /.test(x));
  assert(launch, 'launch command printed');
  const ud = arg(launch, '--user-data-dir'), ed = arg(launch, '--extensions-dir');
  assert(ud && ed, 'fresh --user-data-dir and --extensions-dir');
  for (const d of [ud, ed]) assert(d.toLowerCase().startsWith(tmp) && /vpe-review-\d{8}-\d{6}/.test(d), `under TEMP: ${d}`);
  assert(!/Roaming\\Code/i.test(out), 'real profile untouched');
  assert(!/\.vscode\\extensions/i.test(out), 'home extensions untouched');
  assert(/videos" "[^"]*REVIEW\.md"/.test(launch), 'folder and REVIEW.md opened');
  assert(c.some((x) => /settings\.json/.test(x)), 'settings seeded');
  return c;
}

// main: temp worktree, package, install, launch.
let out = dry('main');
let c = checkCommon(out);
assert(c.some((x) => /worktree add --detach/.test(x)), 'temp worktree');
assert(c.some((x) => /vsce package -o ".*vpe-[0-9a-f]{7}\.vsix"/.test(x)), 'vsce package');
assert(c.some((x) => /bin\\code\.cmd" --extensions-dir ".*" --user-data-dir ".*" --install-extension ".*\.vsix"/.test(x)), 'VSIX install');
assert(/version\s+:\s+\d+\.\d+\.\d+/.test(out) && /commit\s+:\s+[0-9a-f]{40}/.test(out), 'summary');
assert(c.some((x) => /hardlink-or-copy .*h264_aac_anim_1080p\.mp4/.test(x)), 'media linked');

// a .vsix path is used as is: no worktree, no build.
const vsix = path.join(os.tmpdir(), 'vpe-review-test.vsix');
fs.writeFileSync(vsix, 'not a real package');
try {
  out = dry(vsix);
  c = checkCommon(out);
  assert(!c.some((x) => /worktree add|vsce/.test(x)), 'no build for a vsix');
  assert(c.some((x) => x.includes('--install-extension "' + vsix + '"')), 'installs the given vsix');
  c = cmds(dry('main', '-Dev'));
  assert(c.some((x) => /--extensionDevelopmentPath=/.test(x)) && !c.some((x) => /--install-extension|vsce/.test(x)), '-Dev');
} finally { fs.rmSync(vsix, { force: true }); }

// a bad target is a clear error
const bad = ps('no-such-ref-xyz');
assert.notStrictEqual(bad.status, 0);
assert(/neither a \.vsix file nor a git ref/.test(bad.stdout + bad.stderr));
console.log('review_test: ok');
