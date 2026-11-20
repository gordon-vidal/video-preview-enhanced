'use strict';
// node test/host/setup_install_test.js: the managed ffmpeg install (src/setup.js)
// with https stubbed. Checks that a re-install never touches the build in use
// until the new one is complete, and that failed, stalled and cancelled
// downloads leave nothing behind.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { execFileSync } = require('child_process');
const setup = require('../../src/setup');

const exe = process.platform === 'win32' ? '.exe' : '';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_setup_'));
const storage = path.join(work, 'storage');
const root = path.join(storage, 'ffmpeg-builds');

// A tiny archive with fake ffmpeg and ffprobe binaries.
const src = path.join(work, 'src', 'ffmpeg-x', 'bin');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, `ffmpeg${exe}`), 'ffmpeg');
fs.writeFileSync(path.join(src, `ffprobe${exe}`), 'ffprobe');
const archive = path.join(work, 'build.zip');
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-a', '-cf', archive, '-C', path.join(work, 'src'), 'ffmpeg-x']);
const body = fs.readFileSync(archive);
const sha = crypto.createHash('sha256').update(body).digest('hex');

let mode = 'ok';
let onServe = null;
https.get = (url, opts, cb) => {
  const req = new EventEmitter();
  let res = null;
  req.destroy = (e) => {
    if (req.destroyed) return;
    req.destroyed = true;
    if (res) res.destroy(e);
    process.nextTick(() => req.emit('error', e || new Error('socket hang up')));
  };
  req.setTimeout = (_ms, fn) => { req.onTimeout = fn; };
  if (opts.signal) opts.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  setImmediate(() => {
    if (req.destroyed) return;
    res = new PassThrough();
    res.statusCode = 200;
    res.headers = { 'content-length': String(body.length) };
    cb(res);
    if (onServe) onServe();
    if (mode === 'stall') { res.write(body.subarray(0, 100)); req.onTimeout(); return; }
    if (mode === 'abort') { res.write(body.subarray(0, 100)); return; }
    res.end(body);
  });
  return req;
};

const build = (s = sha) => ({ sizeMB: 1, files: [{ name: 'build.zip', url: 'https://example.invalid/build.zip', sha256: s }] });
const dirs = () => (fs.existsSync(root) ? fs.readdirSync(root).sort() : []);

(async () => {
  try {
    const a = await setup.installBuild(build(), storage);
    assert.ok(fs.existsSync(a.ffmpeg) && fs.existsSync(a.ffprobe), 'first install has both binaries');

    // Same build again: a new folder; the one in use stays intact during the download.
    let inUseDuring = null;
    onServe = () => { inUseDuring = fs.existsSync(a.ffmpeg); };
    await new Promise((r) => setTimeout(r, 5)); // distinct folder stamp
    const b = await setup.installBuild(build(), storage);
    onServe = null;
    assert.strictEqual(inUseDuring, true, 'build in use untouched while downloading');
    assert.notStrictEqual(b.dir, a.dir, 'reinstall goes to a new folder');
    assert.ok(fs.existsSync(b.ffmpeg));
    assert.deepStrictEqual(dirs(), [path.basename(b.dir)], 'older build removed after the switch');

    // Failures leave the current build alone and remove their own folder.
    for (const [m, bld, re] of [['ok', build('0'.repeat(64)), /checksum/], ['stall', build(), /no data/], ['abort', build(), /abort/i]]) {
      mode = m;
      const ac = new AbortController();
      if (m === 'abort') setTimeout(() => ac.abort(), 20);
      await assert.rejects(setup.installBuild(bld, storage, null, ac.signal), re, `${m} rejects`);
      assert.deepStrictEqual(dirs(), [path.basename(b.dir)], `${m}: no leftovers, build in use kept`);
      assert.ok(fs.existsSync(b.ffmpeg));
    }
    console.log('setup install: ok');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
