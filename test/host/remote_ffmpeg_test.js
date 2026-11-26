'use strict';
// node test/host/remote_ffmpeg_test.js: ffmpeg downloaded on the remote for the remote stream
// (src/remoteff.js, src/setup.js, the offer in src/extension.js). A fake BtbN release on
// 127.0.0.1 (checksums.sha256 and archives) and a fake Linux remote (mock vscode with
// remoteName, VPE_TEST_PLATFORM / VPE_TEST_ARCH): x64 and arm64 builds, checksum failure,
// unsafe archive members (../, absolute, links), only ffmpeg and ffprobe kept, and the offer
// (once per remote and session, "Don't Show Again", not in WSL, local, builtin or off windows).
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const rf = require('../../src/remoteff');
const setup = require('../../src/setup');

// ---- a tiny ustar writer (plain files, folders, symlinks) ----------------------------------
function header(name, { size = 0, type = '0', link = '', mode = 0o755 } = {}) {
  const h = Buffer.alloc(512);
  const put = (s, off, len) => h.write(s, off, Math.min(len, Buffer.byteLength(s)), 'latin1');
  const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(1700000000, 12), 136, 12);
  h.fill(0x20, 148, 156);
  put(type, 156, 1); put(link, 157, 100);
  put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}
function tarOf(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data || '');
    parts.push(header(e.name, { size: e.type && e.type !== '0' ? 0 : data.length, type: e.type || '0', link: e.link || '' }));
    if (!e.type || e.type === '0') { parts.push(data); parts.push(Buffer.alloc((512 - (data.length % 512)) % 512)); }
  }
  parts.push(Buffer.alloc(1024));
  // gzip, not xz: the tests run on Windows' bsdtar too, which has no xz. tar reads either by content.
  return zlib.gzipSync(Buffer.concat(parts));
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const goodTree = (arch) => [
  { name: `ffmpeg-n8.0-latest-${arch}-lgpl-8.0/`, type: '5' },
  { name: `ffmpeg-n8.0-latest-${arch}-lgpl-8.0/bin/`, type: '5' },
  { name: `ffmpeg-n8.0-latest-${arch}-lgpl-8.0/bin/ffmpeg`, data: `ffmpeg ${arch}` },
  { name: `ffmpeg-n8.0-latest-${arch}-lgpl-8.0/bin/ffprobe`, data: `ffprobe ${arch}` },
  { name: `ffmpeg-n8.0-latest-${arch}-lgpl-8.0/bin/ffplay`, data: 'ffplay' },
  { name: `ffmpeg-n8.0-latest-${arch}-lgpl-8.0/LICENSE.txt`, data: 'LGPL' },
  { name: `ffmpeg-n8.0-latest-${arch}-lgpl-8.0/doc/ffmpeg.html`, data: '<html>' },
];

// ---- the fake release ------------------------------------------------------------------------
const files = new Map(); // name -> Buffer
let badSum = new Set(); // names listed with a wrong checksum
const hits = [];
function checksums() {
  return [...files.entries()].map(([n, b]) => `${badSum.has(n) ? '0'.repeat(64) : sha(b)}  ${n}`).join('\n') + '\n';
}
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      hits.push(req.url);
      const name = decodeURIComponent(req.url.replace(/^\/latest\//, ''));
      if (req.url === '/latest/checksums.sha256') { res.end(checksums()); return; }
      if (!files.has(name)) { res.statusCode = 404; res.end(); return; }
      const b = files.get(name);
      res.setHeader('content-length', b.length);
      res.end(b);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_remoteff_'));
const storage = path.join(work, 'storage');
const root = path.join(storage, 'ffmpeg-builds');
const builds = () => (fs.existsSync(root) ? fs.readdirSync(root) : []);

/** Every file below dir, relative, with forward slashes. */
function listAll(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join('/')); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  try {
    // ---- pure rules --------------------------------------------------------------------------
    assert.ok(rf.supported('linux', 'x64') && rf.supported('linux', 'arm64'));
    for (const [p, a] of [['linux', 'ia32'], ['linux', 'arm'], ['darwin', 'arm64'], ['win32', 'x64']]) assert.ok(!rf.supported(p, a), `${p} ${a}`);
    assert.strictEqual(rf.managedKey(undefined), rf.MANAGED_KEY, 'local key unchanged');
    assert.strictEqual(rf.managedKey('ssh-remote', 'box'), `${rf.MANAGED_KEY}@ssh-remote:box`);
    for (const ok of ['a/bin/ffmpeg', 'ffmpeg', 'x-1.0/bin/ffprobe']) assert.ok(rf.safeMember(ok), ok);
    for (const bad of ['../ffmpeg', 'a/../../ffmpeg', '/usr/bin/ffmpeg', 'C:/x/ffmpeg', 'a\\..\\ffmpeg', 'a/*/ffmpeg', 'a/b\nc/ffmpeg', '']) assert.ok(!rf.safeMember(bad), JSON.stringify(bad));
    assert.strictEqual(rf.pickMember(['a/', 'a/bin/ffmpeg', 'a/x/y/ffmpeg', 'a/ffmpeg/'], 'ffmpeg'), 'a/bin/ffmpeg');

    const key = 'ssh-remote:box';
    const base0 = { remote: 'ssh-remote', platform: 'linux', arch: 'x64', trusted: true, streamOn: true, builtinOnly: false, toolsInstalled: false, askedThisSession: new Set(), state: undefined, key, pending: false };
    assert.strictEqual(rf.shouldOffer(base0), true);
    for (const over of [{ remote: undefined }, { remote: 'wsl' }, { trusted: false }, { streamOn: false }, { builtinOnly: true }, { toolsInstalled: true }, { pending: true },
      { arch: 'ia32' }, { platform: 'darwin' }, { askedThisSession: new Set([key]) }, { state: rf.afterOffer(undefined, key, rf.OFFER_NEVER) }]) {
      assert.strictEqual(rf.shouldOffer({ ...base0, ...over }), false, JSON.stringify(over, (k, v) => (v instanceof Set ? [...v] : v)));
    }
    assert.strictEqual(rf.shouldOffer({ ...base0, state: rf.afterOffer(undefined, key, rf.OFFER_LATER) }), true, '"Not now" asks again in a later session');
    assert.strictEqual(rf.shouldOffer({ ...base0, state: rf.afterOffer(undefined, 'ssh-remote:other', rf.OFFER_NEVER) }), true, '"Don\'t Show Again" is per remote');

    // ---- build choice: x64 and arm64 from the same checksums.sha256 --------------------------
    for (const arch of ['linux64', 'linuxarm64']) {
      files.set(`ffmpeg-n7.1-latest-${arch}-lgpl-7.1.tar.xz`, tarOf(goodTree(arch).map((e) => ({ ...e, name: e.name.replace('n8.0', 'n7.1').replace('-8.0', '-7.1') }))));
      files.set(`ffmpeg-n8.0-latest-${arch}-lgpl-8.0.tar.xz`, tarOf(goodTree(arch)));
      files.set(`ffmpeg-n8.0-latest-${arch}-gpl-8.0.tar.xz`, tarOf(goodTree(arch)));
      files.set(`ffmpeg-n8.0-latest-${arch}-lgpl-shared-8.0.tar.xz`, tarOf(goodTree(arch)));
    }
    files.set('ffmpeg-n8.0-latest-win64-lgpl-8.0.zip', Buffer.from('zip'));
    const x64 = await rf.chooseRemoteBuild('x64', { base });
    assert.strictEqual(x64.files[0].name, 'ffmpeg-n8.0-latest-linux64-lgpl-8.0.tar.xz', 'x64: newest static LGPL');
    assert.strictEqual(x64.licence, 'LGPL-2.1');
    const arm = await rf.chooseRemoteBuild('arm64', { base });
    assert.strictEqual(arm.files[0].name, 'ffmpeg-n8.0-latest-linuxarm64-lgpl-8.0.tar.xz', 'arm64: the arm64 build');
    assert.strictEqual(arm.files[0].url, `${base}latest/ffmpeg-n8.0-latest-linuxarm64-lgpl-8.0.tar.xz`);
    await assert.rejects(rf.chooseRemoteBuild('ia32', { base }), /no ffmpeg download for Linux ia32/);
    // The remote host's NVIDIA driver caps the release line, as in the local setup (n9.0 needs NVENC driver 610+).
    const lines = ['n9.0', 'n8.1', 'n7.1'].map((n) => `ffmpeg-${n}-latest-linux64-lgpl-${n.slice(1)}.tar.xz`);
    for (const n of lines) files.set(n, Buffer.from(n));
    const hwOf = (nvidiaDriver, extra = {}) => async () => ({
      os: 'linux', arch: 'x64', vaapi: false, nvidiaDriver, gpus: nvidiaDriver ? [{ vendor: 'nvidia', name: 'RTX', driver: nvidiaDriver }] : [], ...extra,
    });
    const pickFor = async (detect) => (await rf.chooseRemoteBuild('x64', { base, detect })).files[0].name;
    assert.strictEqual(await pickFor(hwOf('570.133.07')), lines[1], 'NVIDIA 570: n8.1, not n9.0');
    assert.strictEqual(await pickFor(hwOf('550.54.14')), lines[2], 'NVIDIA 550: n7.1');
    assert.strictEqual(await pickFor(hwOf('610.10')), lines[0], 'NVIDIA 610: newest');
    assert.strictEqual(await pickFor(hwOf(null, { vaapi: true, gpus: [{ vendor: 'intel', name: 'UHD', driver: '' }] })), lines[0], 'VA-API only: newest');
    assert.strictEqual(await pickFor(hwOf(null)), lines[0], 'no GPU: newest LGPL static');
    assert.strictEqual(await pickFor(async () => { throw new Error('lspci missing'); }), lines[0], 'failed detection: newest');
    assert.strictEqual(await pickFor(hwOf('550.54.14', { gpus: [{ vendor: 'intel', name: 'UHD', driver: '' }] })), lines[0], 'driver without an NVIDIA GPU is ignored');
    const withGpu = await rf.chooseRemoteBuild('x64', { base, detect: hwOf(null, { vaapi: true, gpus: [{ vendor: 'intel', name: 'UHD', driver: '' }] }) });
    assert.match(withGpu.note, /Intel Quick Sync, VA-API/, 'the build note names the remote GPU decoders');
    for (const n of lines) files.delete(n);

    // The offer says what Live transcode does and that the build is matched to the host.
    const text = rf.offerText({ codec: 'hevc', host: 'box', mb: 135 });
    assert.match(text, /^HEVC plays slowly in this remote window/);
    assert.match(text, /With ffmpeg on box, Live transcode plays it smoothly/);
    assert.match(text, /Download portable ffmpeg \(~135 MB, no admin\) into the extension's folder on box\?/);
    assert.ok(!/remote stream/i.test(text), 'no pre-Live-transcode wording');
    assert.match(rf.offerText({ host: 'box', mb: 135 }), /^This video plays/);

    // https only, except the loopback test server.
    await assert.rejects(setup.chooseBuild({ os: 'linux', arch: 'x64', gpus: [] }, { base: 'http://example.com/' }), /https only/);

    // ---- install: only ffmpeg and ffprobe, from the arm64 archive ------------------------------
    const a = await rf.installRemoteBuild(arm, storage);
    assert.strictEqual(fs.readFileSync(a.ffmpeg, 'utf8'), 'ffmpeg linuxarm64');
    assert.strictEqual(fs.readFileSync(a.ffprobe, 'utf8'), 'ffprobe linuxarm64');
    assert.deepStrictEqual(listAll(a.dir), ['ffmpeg-n8.0-latest-linuxarm64-lgpl-8.0/bin/ffmpeg', 'ffmpeg-n8.0-latest-linuxarm64-lgpl-8.0/bin/ffprobe'], 'only ffmpeg and ffprobe (no ffplay, docs, archive)');
    assert.ok(a.dir.startsWith(root + path.sep));

    // ---- checksum failure: rejected, nothing left, the build in use kept ------------------------
    badSum = new Set([arm.files[0].name]);
    const armBad = await rf.chooseRemoteBuild('arm64', { base });
    await assert.rejects(rf.installRemoteBuild(armBad, storage), /failed its checksum/);
    assert.deepStrictEqual(builds(), [path.basename(a.dir)], 'checksum failure: no leftovers');
    assert.ok(fs.existsSync(a.ffmpeg), 'build in use kept');
    badSum = new Set();

    // ---- unsafe archives -----------------------------------------------------------------------
    const outside = path.join(work, 'evil');
    const cases = [
      ['../ in the name', [{ name: '../evil/ffmpeg', data: 'x' }, { name: 'b/bin/ffprobe', data: 'p' }], /unsafe path/],
      ['../ deeper', [{ name: 'b/../../evil/ffmpeg', data: 'x' }, { name: 'b/bin/ffprobe', data: 'p' }], /unsafe path/],
      ['absolute name', [{ name: `${outside.split(path.sep).join('/').replace(/^[A-Za-z]:/, '')}/ffmpeg`, data: 'x' }, { name: 'b/bin/ffprobe', data: 'p' }], /unsafe path/],
      ['ffmpeg is a symlink', [{ name: 'b/bin/ffmpeg', type: '2', link: '/bin/sh' }, { name: 'b/bin/ffprobe', data: 'p' }], /not a plain file|could not unpack/],
      ['ffprobe missing', [{ name: 'b/bin/ffmpeg', data: 'x' }], /did not contain ffprobe/],
      ['not an archive', null, /could not read/],
    ];
    for (const [what, entries, re] of cases) {
      const name = 'ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz';
      files.set(name, entries ? tarOf(entries) : Buffer.from('not a tar'));
      const b = await rf.chooseRemoteBuild('x64', { base });
      assert.strictEqual(b.files[0].name, name);
      await assert.rejects(rf.installRemoteBuild(b, storage), re, what);
      assert.deepStrictEqual(builds(), [path.basename(a.dir)], `${what}: no leftovers`);
      assert.ok(!fs.existsSync(outside), `${what}: nothing written outside`);
      files.delete(name);
    }

    // ---- the offer, in a fake SSH remote ------------------------------------------------------
    process.env.VPE_LOG = path.join(work, 'vpe.log');
    process.env.VPE_TEST_PLATFORM = 'linux';
    process.env.VPE_TEST_ARCH = 'arm64';
    process.env.VPE_BTBN_URL = base;
    const { load } = require('./mock_vscode');
    const clip = path.join(__dirname, '..', '..', 'media', 'probe', 'hevc_10_2160.mkv');
    const noFfmpeg = { 'videoPreviewEnhanced.ffmpegPath': path.join(work, 'no-such-ffmpeg') };
    async function session({ remote = 'ssh-remote', answer, settings = {} } = {}) {
      const h = load({ settings: { ...noFfmpeg, ...settings } });
      const offers = [];
      const infos = [];
      h.vscode.env.remoteName = remote;
      h.vscode.window.showInformationMessage = async (text, ...items) => {
        infos.push(text);
        if (items.includes(rf.OFFER_DOWNLOAD)) { offers.push({ text, items }); return answer; }
        return undefined;
      };
      h.vscode.window.withProgress = async (o, fn) => fn({ report() {} }, { onCancellationRequested() {} });
      const s = h.open(clip);
      await s.send({ type: 'ready' });
      await s.until((p) => p.some((m) => m.type === 'sessionState'), 15000);
      const soft = async () => { await s.send({ type: 'softVideo', codec: 'hevc', depth: 10 }); await new Promise((r) => setTimeout(r, 100)); };
      return { h, s, offers, infos, soft };
    }
    const hostKey = rf.remoteKey('ssh-remote');
    const managed = `${rf.MANAGED_KEY}@${hostKey}`;
    const storage2 = path.join(os.tmpdir(), 'vpe_host_test_storage', 'ffmpeg-builds');

    // "Download ffmpeg": the arm64 build lands in the remote's extension folder, under this host's key.
    let x = await session({ answer: rf.OFFER_DOWNLOAD });
    await x.soft();
    await x.s.until(() => x.h.context.globalState.get(managed), 10000);
    assert.strictEqual(x.offers.length, 1, 'asked once');
    assert.match(x.offers[0].text, /HEVC plays slowly in this remote window.*Live transcode.*Download portable ffmpeg \(~135 MB, no admin\)/);
    assert.deepStrictEqual(x.offers[0].items, [rf.OFFER_DOWNLOAD, rf.OFFER_LATER, rf.OFFER_NEVER]);
    const rec = x.h.context.globalState.get(managed);
    assert.ok(rec.ffmpeg.startsWith(storage2) && /linuxarm64/.test(rec.ffmpeg), rec.ffmpeg);
    assert.strictEqual(fs.readFileSync(rec.ffmpeg, 'utf8'), 'ffmpeg linuxarm64');
    assert.strictEqual(x.h.context.globalState.get(rf.MANAGED_KEY), undefined, 'the local build record is untouched');
    assert.ok(hits.includes('/latest/ffmpeg-n8.0-latest-linuxarm64-lgpl-8.0.tar.xz'));
    await x.soft();
    assert.strictEqual(x.offers.length, 1, 'not again in this session');
    x.s.panel.dispose(); x.h.dispose();

    // "Don't Show Again" is stored for this remote.
    x = await session({ answer: rf.OFFER_NEVER });
    await x.soft();
    assert.strictEqual(x.offers.length, 1);
    assert.strictEqual(x.h.context.globalState.get(rf.OFFER_KEY)[hostKey].never, true);
    assert.strictEqual(x.h.context.globalState.get(managed), undefined, 'nothing downloaded');
    x.s.panel.dispose(); x.h.dispose();

    // Not asked: WSL (the first-open popup covers it), local windows, decoder builtin, remoteStream off.
    for (const o of [{ remote: 'wsl' }, { remote: null }, { settings: { 'videoPreviewEnhanced.decoder': 'builtin' } }, { settings: { 'videoPreviewEnhanced.remoteStream': 'off' } }]) {
      x = await session({ ...o, answer: rf.OFFER_DOWNLOAD });
      await x.soft();
      assert.strictEqual(x.offers.length, 0, JSON.stringify(o));
      x.s.panel.dispose(); x.h.dispose();
    }

    // Unsupported CPU: not asked.
    process.env.VPE_TEST_ARCH = 'ia32';
    x = await session({ answer: rf.OFFER_DOWNLOAD });
    await x.soft();
    assert.strictEqual(x.offers.length, 0, 'ia32: not asked');
    x.s.panel.dispose(); x.h.dispose();
    fs.rmSync(storage2, { recursive: true, force: true });
    console.log('remote ffmpeg: ok');
  } finally {
    srv.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
