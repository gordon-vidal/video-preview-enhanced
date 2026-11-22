'use strict';
// node test/run.js unit --grep shim: Chocolatey and Scoop launchers are replaced by the real ffmpeg (src/ffmpeg.js
// unwrapShim). They don't forward pipe:3 / pipe:4, so the native decoder got "Bad file descriptor".
// Folders are built in a temp dir; the platform is passed in, so this runs on any OS.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unwrapShim } = require('../../src/ffmpeg');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-shim-'));
const put = (...p) => {
  const f = path.join(root, ...p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x');
  return f;
};
const same = (a, b, msg) => assert.strictEqual(path.resolve(a), path.resolve(b), msg);

try {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    // Scoop: quoted, unquoted, spaces around "=", CRLF.
    const real = put('scoop', 'apps', 'ffmpeg', 'current', 'bin', `${tool}.exe`);
    const exe = put('scoop', 'shims', `${tool}.exe`);
    const shim = path.join(root, 'scoop', 'shims', `${tool}.shim`);
    fs.writeFileSync(shim, `path = "${real}"\r\n`);
    same(unwrapShim(exe, 'win32'), real, `${tool}: quoted`);
    fs.writeFileSync(shim, `path = ${real}\n`);
    same(unwrapShim(exe, 'win32'), real, `${tool}: unquoted`);
    fs.writeFileSync(shim, `path='${real}'\nargs = -x\n`);
    same(unwrapShim(exe, 'win32'), real, `${tool}: single quotes`);
    fs.writeFileSync(shim, `path = ${path.join(root, 'gone', `${tool}.exe`)}\n`);
    assert.strictEqual(unwrapShim(exe, 'win32'), exe, `${tool}: missing target keeps the launcher`);
    fs.writeFileSync(shim, 'garbage\n');
    assert.strictEqual(unwrapShim(exe, 'win32'), exe, `${tool}: shim without a path line`);

    // Chocolatey: direct, then nested versioned folder, case-insensitive folder name.
    const choExe = put('ProgramData', 'Chocolatey', 'bin', `${tool}.exe`);
    assert.strictEqual(unwrapShim(choExe, 'win32'), choExe, `${tool}: no lib folder`);
    const direct = put('ProgramData', 'Chocolatey', 'lib', 'ffmpeg', 'tools', 'ffmpeg', 'bin', `${tool}.exe`);
    same(unwrapShim(choExe, 'win32'), direct, `${tool}: direct`);
    fs.rmSync(path.join(root, 'ProgramData', 'Chocolatey', 'lib'), { recursive: true });
    const nested = put('ProgramData', 'Chocolatey', 'lib', 'ffmpeg', 'tools', 'ffmpeg-7.1-full_build', 'bin', `${tool}.exe`);
    same(unwrapShim(choExe, 'win32'), nested, `${tool}: one level down`);
    fs.rmSync(path.join(root, 'ProgramData', 'Chocolatey', 'lib'), { recursive: true });
    const deep = put('ProgramData', 'Chocolatey', 'lib', 'ffmpeg', 'tools', 'x', 'ffmpeg-7.1', 'bin', `${tool}.exe`);
    same(unwrapShim(choExe, 'win32'), deep, `${tool}: two levels down`);
  }

  // Not shims: unchanged. Other OS: untouched even with a .shim beside it.
  const plain = put('tools', 'bin', 'ffmpeg.exe');
  assert.strictEqual(unwrapShim(plain, 'win32'), plain, 'plain path');
  const lone = put('chocolatey2', 'bin', 'ffmpeg.exe');
  put('chocolatey2', 'lib', 'ffmpeg', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
  assert.strictEqual(unwrapShim(lone, 'win32'), lone, 'folder is not named chocolatey');
  const choExe2 = path.join(root, 'ProgramData', 'Chocolatey', 'bin', 'ffmpeg.exe');
  assert.strictEqual(unwrapShim(choExe2, 'linux'), choExe2, 'not Windows');
  assert.strictEqual(unwrapShim('ffmpeg', 'win32'), 'ffmpeg', 'bare command name');
  console.log('shim unwrap: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
