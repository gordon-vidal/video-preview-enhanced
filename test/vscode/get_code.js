'use strict';
// Downloads a pinned, portable VS Code (the zip build) for the real-VS-Code tests into
// test/vscode/.code/<version>/. run.js uses it when it is there, so the tests don't depend on the
// user's installed VS Code: its background updater (CodeSetup-*.exe /update) makes every new
// Code.exe of that install stall, and its version changes under us.
//
//   node test/vscode/get_code.js [version]      (default: PINNED below)
//
// Prints the path of Code.exe. Windows x64 only, like the rest of test/vscode.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const PINNED = '1.147.0';
const BASE = path.join(__dirname, '.code');

function codeDir(version = PINNED) { return path.join(BASE, version); }

/** Code.exe of the pinned portable build, or '' when it isn't downloaded. */
function portableCode(version = PINNED) {
  const exe = path.join(codeDir(version), 'Code.exe');
  return fs.existsSync(exe) ? exe : '';
}

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'vpe-tests' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), file, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensure(version = PINNED) {
  const have = portableCode(version);
  if (have) return have;
  const dir = codeDir(version);
  fs.mkdirSync(BASE, { recursive: true });
  const zip = path.join(os.tmpdir(), `vscode-${version}-win32-x64.zip`);
  const url = `https://update.code.visualstudio.com/${version}/win32-x64-archive/stable`;
  console.error(`downloading ${url}`);
  await download(url, zip);
  const tmp = `${dir}.part`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // Windows' bsdtar unpacks zips; Git's GNU tar (often first on PATH) doesn't.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-xf', zip, '-C', tmp], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`unpacking ${zip} failed`);
  fs.rmSync(zip, { force: true });
  fs.renameSync(tmp, dir);
  const exe = portableCode(version);
  if (!exe) throw new Error(`no Code.exe in ${dir}`);
  return exe;
}

if (require.main === module) {
  ensure(process.argv[2] || PINNED).then((exe) => console.log(exe), (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { PINNED, portableCode, ensure };
