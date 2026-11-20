'use strict';
// node test/host/localff_test.js: "Use an ffmpeg I already have…" (src/localff.js):
// ffmpeg(.exe) picked directly, a build folder (bin/ found), a downloaded .zip
// unpacked into storage, and the errors for a missing ffprobe, a program that isn't
// ffmpeg, and an archive without ffmpeg. ffmpeg itself is faked (run is injected).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { run } = require('../../src/ffmpeg');
const localff = require('../../src/localff');

const exe = process.platform === 'win32' ? '.exe' : '';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_localff_'));
const storage = path.join(work, 'storage');
const put = (p, text = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
// Fake binaries: their content says what they answer to -version.
const fakeRun = async (cmd, args, ms) => {
  if (/tar(\.exe)?$/i.test(cmd)) return run(cmd, args, ms);
  const kind = fs.readFileSync(cmd, 'utf8');
  if (kind === 'ffmpeg') return { code: 0, stdout: 'ffmpeg version 9.0-test Copyright (c) 2000-2026\n', stderr: '' };
  if (kind === 'ffprobe') return { code: 0, stdout: 'ffprobe version 9.0-test\n', stderr: '' };
  return { code: 1, stdout: '', stderr: 'not ffmpeg' };
};

(async () => {
  try {
    // 1. The exe itself.
    const binDir = path.join(work, 'ffmpeg-9.0-full_build', 'bin');
    const ff = put(path.join(binDir, `ffmpeg${exe}`), 'ffmpeg');
    put(path.join(binDir, `ffprobe${exe}`), 'ffprobe');
    let r = await localff.resolveLocal(ff, { run: fakeRun, storageDir: storage });
    assert.strictEqual(r.ffmpeg, ff);
    assert.strictEqual(r.ffprobe, path.join(binDir, `ffprobe${exe}`));
    assert.match(r.version, /^ffmpeg version 9\.0-test/);
    // ffprobe picked by mistake: still finds ffmpeg next to it.
    r = await localff.resolveLocal(path.join(binDir, `ffprobe${exe}`), { run: fakeRun });
    assert.strictEqual(r.ffmpeg, ff);

    // 2. The build's root folder: bin/ is searched; deeper too.
    r = await localff.resolveLocal(path.join(work, 'ffmpeg-9.0-full_build'), { run: fakeRun });
    assert.strictEqual(r.ffmpeg, ff);
    r = await localff.resolveLocal(work, { run: fakeRun });
    assert.strictEqual(r.ffmpeg, ff, 'found two levels down');

    // 3. A zip as downloaded from a build site: unpacked into storage.
    const zip = path.join(work, 'ffmpeg-release.zip');
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-a', '-cf', zip, '-C', work, 'ffmpeg-9.0-full_build']);
    r = await localff.resolveLocal(zip, { run: fakeRun, storageDir: storage });
    assert.ok(r.unpackedTo && r.unpackedTo.startsWith(path.join(storage, 'ffmpeg-local')), r.unpackedTo);
    assert.ok(r.ffmpeg.startsWith(r.unpackedTo) && fs.existsSync(r.ffmpeg));

    // Errors.
    const lone = put(path.join(work, 'lone', `ffmpeg${exe}`), 'ffmpeg');
    await assert.rejects(localff.resolveLocal(lone, { run: fakeRun }), /ffprobe.* is missing/);
    const notff = put(path.join(work, 'other', `ffmpeg${exe}`), 'something else');
    put(path.join(work, 'other', `ffprobe${exe}`), 'ffprobe');
    await assert.rejects(localff.resolveLocal(notff, { run: fakeRun }), /does not run as ffmpeg/);
    await assert.rejects(localff.resolveLocal(path.join(work, 'empty-dir-missing'), { run: fakeRun }), /does not exist/);
    fs.mkdirSync(path.join(work, 'nothing'));
    await assert.rejects(localff.resolveLocal(path.join(work, 'nothing'), { run: fakeRun }), /no ffmpeg/);
    const emptyZip = path.join(work, 'empty.zip');
    put(path.join(work, 'zsrc', 'readme.txt'));
    execFileSync(tar, ['-a', '-cf', emptyZip, '-C', path.join(work, 'zsrc'), 'readme.txt']);
    const before = fs.readdirSync(path.join(storage, 'ffmpeg-local')).length;
    await assert.rejects(localff.resolveLocal(emptyZip, { run: fakeRun, storageDir: storage }), /holds no ffmpeg/);
    assert.strictEqual(fs.readdirSync(path.join(storage, 'ffmpeg-local')).length, before, 'a useless archive leaves nothing behind');
    const broken = put(path.join(work, 'broken.zip'), 'not a zip');
    await assert.rejects(localff.resolveLocal(broken, { run: fakeRun, storageDir: storage }), /could not unpack/);
    // Setup looks in the usual install places before offering a download (winget package, Chocolatey).
    const la = path.join(work, 'LocalAppData');
    const pkgFf = put(path.join(la, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0-full_build', 'bin', 'ffmpeg.exe'), 'ffmpeg');
    const winEnv = { LOCALAPPDATA: la, ProgramData: path.join(work, 'ProgramData'), USERPROFILE: path.join(work, 'user'), ProgramFiles: path.join(work, 'PF'), SystemDrive: path.join(work, 'sys') };
    assert.ok(localff.commonLocations(winEnv, 'win32').includes(pkgFf), 'winget package bin');
    assert.strictEqual(await localff.findInstalled({ env: winEnv, platform: 'win32', runFn: fakeRun }), pkgFf);
    // A file that isn't ffmpeg is skipped; nothing found gives null.
    fs.writeFileSync(pkgFf, 'not ffmpeg');
    assert.strictEqual(await localff.findInstalled({ env: winEnv, platform: 'win32', runFn: fakeRun }), null);
    const choco = put(path.join(work, 'ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'), 'ffmpeg');
    assert.strictEqual(await localff.findInstalled({ env: winEnv, platform: 'win32', runFn: fakeRun }), choco);
    assert.ok(localff.commonLocations({ HOME: '/home/u' }, 'linux').includes(path.join('/opt/homebrew/bin', 'ffmpeg')));
    console.log('local ffmpeg: ok');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
