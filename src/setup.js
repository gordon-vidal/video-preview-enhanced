'use strict';
// Picks and downloads an ffmpeg build that fits this machine, then verifies it.
// Downloads go through the proxy from VS Code's http.proxy setting or HTTPS_PROXY
// (setAgentFor; see src/proxy.js).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { run } = require('./ffmpeg');

const UA = { 'User-Agent': 'video-preview-enhanced-vscode', Accept: 'application/vnd.github+json' };
const BTBN_DL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/';
const RIEDL = 'https://ffmpeg.martin-riedl.de/redirect/latest';
// A connection that sends nothing for this long fails instead of hanging the setup.
const IDLE_TIMEOUT_MS = 30000;

// url -> https.Agent or undefined: the proxy tunnel, when one is configured.
let agentFor = () => undefined;
function setAgentFor(fn) { agentFor = fn || (() => undefined); }

// https, or plain http to this machine only (the tests' fake download server). A redirect
// to http: anywhere else fails, so a download never leaves TLS.
function client(url) {
  const u = new URL(url);
  if (u.protocol === 'https:') return https;
  if (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.host.replace(/:\d+$/, ''))) return http;
  throw new Error(`refusing to download from ${u.protocol}//${u.host} (https only)`);
}

function get(url, { json = false, redirects = 6, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^https:/i.test(url)) { try { client(url); } catch (e) { reject(e); return; } }
    const req = client(url).get(url, { headers: UA, signal, agent: agentFor(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), { json, redirects: redirects - 1, signal }));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(json ? JSON.parse(body) : body); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`no response from ${new URL(url).host} for ${IDLE_TIMEOUT_MS / 1000} s`)));
    req.on('error', reject);
  });
}

/** Streams url to dest and resolves with its SHA-256. A stalled or cancelled (signal) download rejects. */
function download(url, dest, onBytes, signal, redirects = 6) {
  return new Promise((resolve, reject) => {
    if (!/^https:/i.test(url)) { try { client(url); } catch (e) { reject(e); return; } }
    const req = client(url).get(url, { headers: { 'User-Agent': UA['User-Agent'] }, signal, agent: agentFor(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, onBytes, signal, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      let bytes = 0;
      res.on('data', (d) => { hash.update(d); bytes += d.length; if (onBytes) onBytes(bytes, total); });
      res.pipe(out);
      out.on('finish', () => {
        if (total && bytes !== total) reject(new Error(`download ended early (${bytes} of ${total} bytes)`));
        else resolve(hash.digest('hex'));
      });
      out.on('error', reject);
      res.on('error', (e) => { out.destroy(); reject(e); });
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`no data from ${new URL(url).host} for ${IDLE_TIMEOUT_MS / 1000} s`)));
    req.on('error', reject);
  });
}

/** Approximate download size in MB of the recommended build (shown before anything is fetched). */
function downloadSizeMB(os = process.platform, arch = process.arch) {
  if (os === 'darwin') return 60;
  if (os === 'win32') return arch === 'arm64' ? 54 : 77;
  return 135;
}

/**
 * Chooses a build for this machine. Returns
 * { source, label, licence, files: [{url, sha256Url | sha256, name}], sizeMB, note }.
 *
 * Playback only decodes, and every decoder that matters is in FFmpeg's LGPL core
 * (plus dav1d, BSD), so the LGPL build is the one to fetch: it decodes exactly what
 * the GPL build does (only niche AVS2 via libdavs2 is GPL-only) and sits better next
 * to this MIT extension. GPU decoding needs no particular driver version: d3d11va,
 * dxva2, vaapi and videotoolbox use the system's video driver; NVIDIA's cuda (NVDEC)
 * loads the driver at run time. Whether a method works is not guessed from driver
 * numbers: the probe (src/probe.js) tries each one after the install.
 */
async function chooseBuild(hw, { base = BTBN_DL } = {}) {
  if (hw.os === 'darwin') {
    const arch = hw.arch === 'arm64' ? 'arm64' : 'amd64';
    return {
      source: 'martin-riedl.de', label: `ffmpeg (latest release, macOS ${arch}, signed)`, licence: 'GPL', page: 'https://ffmpeg.martin-riedl.de/',
      sizeMB: downloadSizeMB('darwin'), note: 'VideoToolbox GPU decoding',
      files: ['ffmpeg', 'ffprobe'].map((n) => ({ name: `${n}.zip`, url: `${RIEDL}/macos/${arch}/release/${n}.zip`, sha256Url: `${RIEDL}/macos/${arch}/release/${n}.zip.sha256` })),
    };
  }

  const plat = hw.os === 'win32' ? (hw.arch === 'arm64' ? 'winarm64' : 'win64') : (hw.arch === 'arm64' ? 'linuxarm64' : 'linux64');
  const ext = hw.os === 'win32' ? 'zip' : 'tar.xz';
  // Shared builds are about half the size on Windows; Linux uses the static ones (no library path to set up).
  const variant = hw.os === 'win32' ? 'lgpl-shared' : 'lgpl';
  const extRe = ext.replace('.', '\\.');
  // checksums.sha256 lists every asset of a release with its hash; reading it
  // needs no GitHub API call (and so no API rate limit).
  const text = await get(`${base}latest/checksums.sha256`);
  const latest = text.split(/\r?\n/).map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(l.trim())).filter(Boolean)
    .map((m) => ({ sha256: m[1].toLowerCase(), name: m[2], url: `${base}latest/${m[2]}` }));
  const re = new RegExp(`^ffmpeg-n(\\d+)\\.(\\d+)-latest-${plat}-${variant}-[\\d.]+\\.${extRe}$`);
  const pick = latest.map((a) => ({ a, m: re.exec(a.name) })).filter((x) => x.m)
    .map((x) => ({ asset: x.a, major: Number(x.m[1]), minor: Number(x.m[2]) }))
    .sort((p, q) => q.major - p.major || q.minor - p.minor)[0];
  if (!pick) throw new Error(`no ${plat} build found in BtbN's latest release`);
  const vendors = new Set(hw.gpus.map((g) => g.vendor));
  const gpu = [];
  if (hw.os === 'win32') gpu.push('Direct3D 11');
  if (vendors.has('intel')) gpu.push('Intel Quick Sync');
  if (vendors.has('nvidia')) gpu.push('NVIDIA NVDEC');
  if (hw.os === 'linux' && hw.vaapi) gpu.push('VA-API');
  return {
    source: 'BtbN/FFmpeg-Builds', label: `ffmpeg ${pick.major}.${pick.minor} (${plat}, LGPL)`, licence: 'LGPL-2.1',
    page: 'https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest',
    sizeMB: downloadSizeMB(hw.os, hw.arch), note: gpu.length ? `GPU decoding via ${gpu.join(', ')}` : 'CPU decoding',
    files: [pick.asset],
  };
}

async function expectedSha(file, signal) {
  if (file.sha256) return file.sha256;
  if (!file.sha256Url) return null;
  const text = await get(file.sha256Url, { signal });
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && (m[2] === file.name || text.trim().split(/\r?\n/).length === 1)) return m[1].toLowerCase();
  }
  const bare = /^([0-9a-f]{64})\b/i.exec(text.trim());
  return bare ? bare[1].toLowerCase() : null;
}

function findBinary(dir, name) {
  const want = process.platform === 'win32' ? `${name}.exe` : name;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === want) return p;
    }
  }
  return null;
}

/**
 * Downloads, verifies and unpacks a build. Returns { ffmpeg, ffprobe, dir }.
 * Always unpacks into a new folder, so the build in use stays intact until the
 * caller switches over; a failed or cancelled (signal) install removes its folder.
 * opts.extract(archive, dir) replaces the unpack: it returns { ffmpeg, ffprobe } it
 * extracted (src/remoteff.js keeps only those two).
 */
async function installBuild(build, storageDir, onProgress, signal, opts = {}) {
  const root = path.join(storageDir, 'ffmpeg-builds');
  const hash = crypto.createHash('sha1').update(build.files.map((f) => f.url).join('|')).digest('hex').slice(0, 10);
  const id = `${hash}-${Date.now().toString(36)}`;
  const dir = path.join(root, id);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    return await unpackInto(build, dir, root, id, onProgress, signal, opts.extract);
  } catch (e) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function unpackInto(build, dir, root, id, onProgress, signal, extract) {
  let done = 0;
  let found = {};
  const totalMB = build.sizeMB || 100;
  for (const f of build.files) {
    const archive = path.join(dir, f.name);
    const want = await expectedSha(f, signal);
    const got = await download(f.url, archive, (b) => onProgress && onProgress(Math.min(0.97, (done + b / 1e6) / totalMB)), signal);
    if (!want) throw new Error(`no checksum published for ${f.name}`);
    if (got !== want) throw new Error(`${f.name} failed its checksum (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
    done += fs.statSync(archive).size / 1e6;
    if (extract) {
      Object.assign(found, await extract(archive, dir, signal));
      await fs.promises.unlink(archive).catch(() => {});
      continue;
    }
    // bsdtar (Windows 10+, macOS) and GNU tar (Linux, .tar.xz) both unpack these.
    // On Windows use the system bsdtar explicitly: Git's GNU tar (often on PATH)
    // reads "C:" as a remote host and can't unpack zips.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = await run(tar, ['-xf', archive, '-C', dir], 10 * 60 * 1000);
    if (r.code !== 0) throw new Error(`could not unpack ${f.name}: ${r.stderr.trim()}`);
    await fs.promises.unlink(archive).catch(() => {});
  }
  const ffmpeg = extract ? found.ffmpeg : findBinary(dir, 'ffmpeg');
  const ffprobe = extract ? found.ffprobe : findBinary(dir, 'ffprobe');
  if (!ffmpeg || !ffprobe) throw new Error('the archive did not contain ffmpeg and ffprobe');
  if (!extract) await prune(dir);
  if (process.platform !== 'win32') {
    await fs.promises.chmod(ffmpeg, 0o755);
    await fs.promises.chmod(ffprobe, 0o755);
  }
  if (onProgress) onProgress(1);
  // Remove older managed builds (best effort: one still running may be locked on Windows; the next install retries).
  for (const other of fs.readdirSync(root)) {
    if (other !== id) await fs.promises.rm(path.join(root, other), { recursive: true, force: true }).catch(() => {});
  }
  return { ffmpeg, ffprobe, dir };
}

/**
 * Keeps what playback needs: ffmpeg, ffprobe and (shared builds) their DLLs.
 * Drops ffplay (a player with its own window), headers, HTML docs, encoder presets, and on Windows the
 * import libraries (the DLLs live in bin/). Licence files stay.
 */
async function prune(dir) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const drop = e.isDirectory()
        ? /^(include|doc|presets)$/.test(e.name) || (process.platform === 'win32' && e.name === 'lib')
        : /^ffplay(\.exe)?$/i.test(e.name);
      if (drop) await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
      else if (e.isDirectory()) stack.push(p);
    }
  }
}

function packageManagerCommand() {
  if (process.platform === 'win32') return 'winget install --id Gyan.FFmpeg -e';
  if (process.platform === 'darwin') return 'brew install ffmpeg';
  return 'sudo apt install ffmpeg   # or: sudo dnf install ffmpeg / sudo pacman -S ffmpeg';
}

module.exports = { chooseBuild, installBuild, packageManagerCommand, downloadSizeMB, setAgentFor, prune, findBinary, BTBN_DL };
