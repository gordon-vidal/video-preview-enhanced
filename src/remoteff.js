'use strict';
// ffmpeg for the remote stream (src/remotestream.js) on a Remote-SSH / container / tunnel host:
// the same BtbN LGPL static Linux build as the local setup (src/setup.js: checksums.sha256 of
// the same release, proxy, progress, cancel), downloaded into the extension's folder on the
// remote (context.globalStorageUri of the remote extension host). Only ffmpeg and ffprobe are
// unpacked, by exact member name, after the archive's listing has been checked; the extracted
// files must be plain files inside the build folder (no links, no ../, no absolute names).

const fs = require('fs');
const path = require('path');
const os = require('os');
const setup = require('./setup');
const { run } = require('./ffmpeg');

const OFFER_KEY = 'videoPreviewEnhanced.remoteFfmpegOffer';
const MANAGED_KEY = 'videoPreviewEnhanced.managedFfmpeg';
const ARCHES = { x64: 'x64', arm64: 'arm64' };

/** Linux x64 and arm64 hosts get the offer (BtbN publishes static builds for both). */
function supported(platform = process.platform, arch = process.arch) {
  return platform === 'linux' && !!ARCHES[arch];
}

/**
 * The key a remote's state is kept under. globalState is shared by the local and every remote
 * extension host (VS Code keeps it on the client), so remote entries carry the host's identity.
 */
function remoteKey(remoteName, hostname = os.hostname()) {
  return `${remoteName || 'local'}:${hostname}`;
}

/** globalState key of the downloaded build: the local one as before, per host in remote windows. */
function managedKey(remoteName, hostname) {
  return remoteName ? `${MANAGED_KEY}@${remoteKey(remoteName, hostname)}` : MANAGED_KEY;
}

/**
 * Whether to offer the download now. ctx: { remote, platform, arch, trusted, streamOn (the
 * remoteStream setting lets this window stream), builtinOnly (decoder: builtin), toolsInstalled,
 * askedThisSession (Set of remote keys), state (globalState OFFER_KEY), key, pending }.
 * WSL is left to the first-open popup (native ffmpeg plays there).
 */
function shouldOffer(ctx) {
  if (!ctx.remote || ctx.remote === 'wsl' || !ctx.trusted || !ctx.streamOn || ctx.builtinOnly) return false;
  if (ctx.toolsInstalled || ctx.pending || !supported(ctx.platform, ctx.arch)) return false;
  if (ctx.askedThisSession && ctx.askedThisSession.has(ctx.key)) return false;
  const s = ctx.state && ctx.state[ctx.key];
  return !(s && s.never);
}

const OFFER_DOWNLOAD = 'Download ffmpeg';
const OFFER_LATER = 'Not now';
const OFFER_NEVER = "Don't ask again";

function offerText({ codec, host, mb }) {
  const what = codec ? String(codec).toUpperCase() : 'This video';
  return `${what} plays in the built-in decoder in this window (4K slowly). With ffmpeg on ${host}, videos like this ` +
    `are decoded there and streamed to this window in real time. Download ffmpeg (~${mb} MB, LGPL build, no admin) ` +
    `into the extension's folder on ${host}?`;
}

/** globalState OFFER_KEY after an answer: "Don't ask again" is kept per remote. */
function afterOffer(state, key, answer, now = Date.now()) {
  const next = { ...(state || {}) };
  next[key] = { at: now, answer: answer === OFFER_DOWNLOAD ? 'download' : answer === OFFER_NEVER ? 'never' : 'later', never: answer === OFFER_NEVER };
  // Keep the newest 20 remotes.
  const keys = Object.keys(next).sort((a, b) => (next[b].at || 0) - (next[a].at || 0));
  for (const k of keys.slice(20)) delete next[k];
  return next;
}

function tarCmd() {
  // Windows (tests only): the system bsdtar; Git's GNU tar reads "C:" as a remote host.
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

/** A member name that is safe to pass to tar and to extract under a folder. */
function safeMember(name) {
  if (!name || name.length > 1024 || /[\0-\x1f\\*?[\]]/.test(name)) return false;
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return false;
  return !name.split('/').some((p) => p === '..');
}

/** The shallowest member whose last path part is base (not a folder entry). */
function pickMember(names, base) {
  return names.filter((n) => !n.endsWith('/') && path.posix.basename(n) === base)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0] || null;
}

/**
 * Unpacks only ffmpeg and ffprobe from archive into dir; returns their paths. Rejects an archive
 * whose ffmpeg/ffprobe entries are unsafe names, links, or would land outside dir.
 * opts: { names: binaries to keep (default ffmpeg, ffprobe), run }.
 */
async function extractTools(archive, dir, signal, opts = {}) {
  const runFn = opts.run || run;
  const want = opts.names || ['ffmpeg', 'ffprobe'];
  const tar = opts.tar || tarCmd();
  const list = await runFn(tar, ['-tf', archive], 10 * 60 * 1000, signal);
  if (list.code !== 0) throw new Error(`could not read ${path.basename(archive)}: ${(list.stderr || '').trim() || `exit ${list.code}`}${/xz/i.test(list.stderr || '') ? ' (is xz installed on this host?)' : ''}`);
  const names = (list.stdout || '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  const members = want.map((b) => pickMember(names, b));
  members.forEach((m, i) => { if (!m) throw new Error(`the archive did not contain ${want[i]}`); });
  for (const m of members) if (!safeMember(m)) throw new Error(`unsafe path in the archive: ${JSON.stringify(m.slice(0, 200))}`);
  const x = await runFn(tar, ['-xf', archive, '-C', dir, '--no-same-owner', '--', ...members], 10 * 60 * 1000, signal);
  if (x.code !== 0) throw new Error(`could not unpack ${path.basename(archive)}: ${(x.stderr || '').trim() || `exit ${x.code}`}`);
  const realDir = await fs.promises.realpath(dir);
  const out = {};
  for (const [i, m] of members.entries()) {
    const p = path.join(dir, ...m.split('/'));
    let st;
    try { st = await fs.promises.lstat(p); } catch { throw new Error(`${want[i]} was not unpacked`); }
    if (!st.isFile()) throw new Error(`${m} in the archive is not a plain file`);
    const real = await fs.promises.realpath(p);
    if (!real.startsWith(realDir + path.sep)) throw new Error(`${m} would land outside the build folder`);
    out[want[i]] = p;
  }
  return out;
}

/**
 * Chooses the static LGPL Linux build for arch (BtbN's latest release) and downloads it into
 * storageDir/ffmpeg-builds with ffmpeg and ffprobe only. Returns { build, ffmpeg, ffprobe, dir }.
 * opts: { base (test server), extract options }.
 */
function chooseRemoteBuild(arch = process.arch, opts = {}) {
  if (!ARCHES[arch]) return Promise.reject(new Error(`no ffmpeg download for Linux ${arch}`));
  return setup.chooseBuild({ os: 'linux', arch, gpus: [], vaapi: false }, opts.base ? { base: opts.base } : {});
}

function installRemoteBuild(build, storageDir, onProgress, signal, opts = {}) {
  return setup.installBuild(build, storageDir, onProgress, signal, {
    extract: (archive, dir, sig) => extractTools(archive, dir, sig, opts),
  });
}

module.exports = {
  OFFER_KEY, MANAGED_KEY, OFFER_DOWNLOAD, OFFER_LATER, OFFER_NEVER,
  supported, remoteKey, managedKey, shouldOffer, offerText, afterOffer,
  safeMember, pickMember, extractTools, chooseRemoteBuild, installRemoteBuild,
};
