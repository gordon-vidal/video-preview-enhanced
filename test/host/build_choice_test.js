'use strict';
// node test/host/build_choice_test.js: which ffmpeg build setup recommends (src/setup.js
// chooseBuild) with https stubbed: the LGPL build of the newest release branch, no
// NVENC-driver gating, the proxy agent passed through; and prune() keeping only
// ffmpeg, ffprobe and their DLLs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const setup = require('../../src/setup');

const names = [
  'ffmpeg-master-latest-win64-gpl-shared.zip', 'ffmpeg-master-latest-win64-lgpl-shared.zip',
  'ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip', 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip',
  'ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip', 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip', 'ffmpeg-n9.0-latest-win64-lgpl-9.0.zip',
  'ffmpeg-n9.0-latest-winarm64-lgpl-shared-9.0.zip', 'ffmpeg-n9.0-latest-winarm64-gpl-shared-9.0.zip',
  'ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz', 'ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz', 'ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz',
  'ffmpeg-n9.0-latest-linux64-lgpl-shared-9.0.tar.xz',
];
const listing = names.map((n, i) => `${String(i).padStart(64, 'a')}  ${n}`).join('\n');
const requests = [];
https.get = (url, opts, cb) => {
  requests.push({ url: String(url), agent: opts.agent });
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  setImmediate(() => {
    const res = new PassThrough();
    res.statusCode = 200;
    res.headers = {};
    cb(res);
    res.end(listing);
  });
  return req;
};

const hw = (extra) => ({ os: 'win32', arch: 'x64', gpus: [], nvidiaDriver: null, vaapi: false, ...extra });

(async () => {
  let b = await setup.chooseBuild(hw({ gpus: [{ vendor: 'intel', name: 'Intel(R) Graphics', driver: '31.0.101.5234' }] }));
  assert.strictEqual(b.files[0].name, 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip', 'win64: newest LGPL shared');
  assert.strictEqual(b.licence, 'LGPL-2.1');
  assert.match(b.label, /9\.0 \(win64, LGPL\)/);
  assert.match(b.note, /Direct3D 11, Intel Quick Sync/);
  assert.doesNotMatch(b.note, /encod|NVENC/i, 'no encoding talk');
  assert.strictEqual(b.sizeMB, 77);

  // An old NVIDIA driver no longer pins an old build: decoding doesn't need NVENC's driver level.
  b = await setup.chooseBuild(hw({ gpus: [{ vendor: 'nvidia', name: 'GTX 1060', driver: '456.71' }], nvidiaDriver: '456.71' }));
  assert.strictEqual(b.files[0].name, 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip', 'old NVIDIA driver: still the newest build');
  assert.match(b.note, /NVIDIA NVDEC/);
  assert.ok(!requests.some((r) => /autobuild-/.test(r.url)), 'no pinned old release fetched');

  b = await setup.chooseBuild(hw({ arch: 'arm64' }));
  assert.strictEqual(b.files[0].name, 'ffmpeg-n9.0-latest-winarm64-lgpl-shared-9.0.zip');
  b = await setup.chooseBuild(hw({ os: 'linux', vaapi: true, gpus: [{ vendor: 'amd', name: 'Radeon', driver: '' }] }));
  assert.strictEqual(b.files[0].name, 'ffmpeg-n9.0-latest-linux64-lgpl-9.0.tar.xz', 'linux: static LGPL');
  assert.match(b.note, /VA-API/);
  b = await setup.chooseBuild(hw({ os: 'darwin', arch: 'arm64' }));
  assert.strictEqual(b.files.length, 2);
  assert.match(b.files[0].url, /macos\/arm64/);

  // The proxy agent reaches every request.
  const agent = { fake: true };
  setup.setAgentFor((url) => (/github\.com/.test(url) ? agent : undefined));
  requests.length = 0;
  await setup.chooseBuild(hw());
  assert.strictEqual(requests[0].agent, agent, 'agent passed to https.get');
  setup.setAgentFor(null);
  requests.length = 0;
  await setup.chooseBuild(hw());
  assert.strictEqual(requests[0].agent, undefined, 'no agent without a proxy');

  // prune(): ffplay, headers and (Windows) import libraries go; binaries, DLLs and licences stay.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_prune_'));
  try {
    const root = path.join(dir, 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0');
    for (const f of ['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'bin/ffplay.exe', 'bin/avcodec-62.dll', 'include/libavcodec/avcodec.h', 'lib/avcodec.lib', 'LICENSE.txt', 'doc/ffmpeg.html']) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), 'x');
    }
    await setup.prune(dir);
    const left = (p) => fs.existsSync(path.join(root, p));
    assert.ok(left('bin/ffmpeg.exe') && left('bin/ffprobe.exe') && left('bin/avcodec-62.dll') && left('LICENSE.txt'), 'kept what playback needs');
    assert.ok(!left('bin/ffplay.exe') && !left('include') && !left('doc'), 'ffplay, headers and docs dropped');
    assert.strictEqual(left('lib'), process.platform !== 'win32', 'import libraries dropped on Windows');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  assert.strictEqual(setup.downloadSizeMB('win32', 'x64'), 77);
  console.log('build choice: ok');
})().catch((e) => { console.error(e); process.exit(1); });
