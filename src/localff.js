'use strict';
// "Use an ffmpeg I already have…": the user points at ffmpeg(.exe), a folder that
// holds it (a build's root with bin/ inside is fine), or a downloaded archive
// (.zip, .7z, .tar.xz), which is unpacked into the extension's storage like a
// managed download. It must run (`ffmpeg -version`) and come with ffprobe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run } = require('./ffmpeg');

const EXE = process.platform === 'win32' ? '.exe' : '';
const ARCHIVE_RE = /\.(zip|7z|tar\.xz|txz|tar\.gz|tgz|tar)$/i;
const MAX_DEPTH = 4;

/** ffmpeg and ffprobe in dir: dir itself, dir/bin, then a few levels down (an unpacked build). */
function findIn(dir) {
  const names = [`ffmpeg${EXE}`, `ffprobe${EXE}`];
  const has = (d) => names.every((n) => fs.existsSync(path.join(d, n)));
  for (const d of [dir, path.join(dir, 'bin')]) if (has(d)) return { ffmpeg: path.join(d, names[0]), ffprobe: path.join(d, names[1]) };
  const queue = [[dir, 0]];
  while (queue.length) {
    const [d, depth] = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (has(p)) return { ffmpeg: path.join(p, names[0]), ffprobe: path.join(p, names[1]) };
      if (depth + 1 < MAX_DEPTH) queue.push([p, depth + 1]);
    }
  }
  return null;
}

/** Unpacks an archive into <storageDir>/ffmpeg-local/<id>; returns that folder. A failed unpack leaves nothing. */
async function unpack(archive, storageDir, runFn = run) {
  const id = `${crypto.createHash('sha1').update(path.resolve(archive)).digest('hex').slice(0, 8)}-${Date.now().toString(36)}`;
  const dir = path.join(storageDir, 'ffmpeg-local', id);
  await fs.promises.mkdir(dir, { recursive: true });
  // bsdtar (Windows 10+, macOS) reads zip and 7z; GNU tar (Linux) reads the tar family.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = await runFn(tar, ['-xf', archive, '-C', dir], 10 * 60 * 1000);
  if (r.code !== 0) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`could not unpack ${path.basename(archive)}: ${(r.stderr || '').trim() || `exit ${r.code}`}${/\.7z$/i.test(archive) ? ' (unpack it yourself and choose the folder)' : ''}`);
  }
  return dir;
}

/**
 * Resolves what the user picked to { ffmpeg, ffprobe, version, unpackedTo? }, or throws
 * an Error saying what is wrong. opts: { storageDir, run }.
 */
async function resolveLocal(picked, opts = {}) {
  const runFn = opts.run || run;
  let st;
  try { st = fs.statSync(picked); } catch { throw new Error(`${picked} does not exist`); }
  let found = null;
  let unpackedTo = null;
  if (st.isDirectory()) {
    found = findIn(picked);
    if (!found) throw new Error(`no ffmpeg${EXE} with ffprobe${EXE} next to it in ${picked} (looked in bin/ and below)`);
  } else if (ARCHIVE_RE.test(picked)) {
    if (!opts.storageDir) throw new Error('no folder to unpack into');
    unpackedTo = await unpack(picked, opts.storageDir, runFn);
    found = findIn(unpackedTo);
    if (!found) {
      await fs.promises.rm(unpackedTo, { recursive: true, force: true }).catch(() => {});
      throw new Error(`${path.basename(picked)} holds no ffmpeg${EXE} with ffprobe${EXE}`);
    }
  } else {
    const base = path.basename(picked).toLowerCase();
    if (base === `ffprobe${EXE}`) found = { ffmpeg: path.join(path.dirname(picked), `ffmpeg${EXE}`), ffprobe: picked };
    else found = { ffmpeg: picked, ffprobe: path.join(path.dirname(picked), `ffprobe${EXE}`) };
    if (!fs.existsSync(found.ffprobe)) throw new Error(`ffprobe${EXE} is missing next to ${path.basename(found.ffmpeg)} (both come in every ffmpeg build)`);
  }
  const v = await runFn(found.ffmpeg, ['-hide_banner', '-version'], 15000);
  const line = (v.stdout || '').split(/\r?\n/)[0] || '';
  if (v.code !== 0 || !/^ffmpeg version/i.test(line)) {
    if (unpackedTo) await fs.promises.rm(unpackedTo, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${found.ffmpeg} does not run as ffmpeg: ${((v.stderr || '').trim().split(/\r?\n/)[0]) || line || `exit ${v.code}`}`);
  }
  const p = await runFn(found.ffprobe, ['-hide_banner', '-version'], 15000);
  if (p.code !== 0 || !/^ffprobe version/i.test((p.stdout || '').split(/\r?\n/)[0] || '')) {
    if (unpackedTo) await fs.promises.rm(unpackedTo, { recursive: true, force: true }).catch(() => {});
    throw new Error(`${found.ffprobe} does not run as ffprobe`);
  }
  return { ...found, version: line, unpackedTo };
}

/**
 * Where ffmpeg is commonly installed besides PATH (winget, Chocolatey, Scoop, Homebrew, MacPorts, Snap,
 * hand-unpacked builds). Only existence checks here; the caller verifies with `ffmpeg -version`.
 */
function commonLocations(env = process.env, platform = process.platform) {
  const out = [];
  const add = (...p) => { if (p.every(Boolean)) out.push(path.join(...p)); };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    add(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    // winget packages: Packages\<id>_<source>\<build>\bin\ffmpeg.exe
    const pk = local && path.join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const d of listDirs(pk).filter((n) => /ffmpeg/i.test(n))) {
      for (const b of listDirs(path.join(pk, d))) add(pk, d, b, 'bin', 'ffmpeg.exe');
      add(pk, d, 'bin', 'ffmpeg.exe');
    }
    add(env.ProgramData, 'chocolatey', 'bin', 'ffmpeg.exe');
    add(env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe');
    add(env.USERPROFILE, 'scoop', 'apps', 'ffmpeg', 'current', 'bin', 'ffmpeg.exe');
    add(env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe');
    add(env.SystemDrive || 'C:', path.sep, 'ffmpeg', 'bin', 'ffmpeg.exe');
  } else {
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/snap/bin']) add(d, 'ffmpeg');
    add(env.HOME, '.local', 'bin', 'ffmpeg');
  }
  return [...new Set(out)];
}

function listDirs(dir) {
  try { return dir ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []; } catch { return []; }
}

/** The first ffmpeg in commonLocations() that runs (`-version`, nothing decoded), or null. */
async function findInstalled({ env, platform, runFn = run } = {}) {
  // review.cmd -NoFfmpeg sets this, to try setup as on a machine without ffmpeg.
  if ((env || process.env).VPE_FFMPEG_SEARCH === 'off') return null;
  for (const p of commonLocations(env, platform)) {
    if (!fs.existsSync(p)) continue;
    const v = await runFn(p, ['-hide_banner', '-version'], 10000);
    if (v.code === 0) return p;
  }
  return null;
}

module.exports = { resolveLocal, findIn, unpack, ARCHIVE_RE, commonLocations, findInstalled };
