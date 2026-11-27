'use strict';
// node test/run.js unit --grep setup_recommend: the download entry of the ffmpeg setup list (src/setup.js
// downloadItem). It is marked recommended when no ffmpeg is found, and when the ffmpeg found cannot use GPU encoding
// (NVENC) with this NVIDIA driver while the download is the build line that matches the driver (src/driver_notice.js
// "Set up matching ffmpeg" opens this list).
const assert = require('assert');
const setup = require('../../src/setup');

const build81 = { source: 'BtbN/FFmpeg-Builds', label: 'ffmpeg 8.1 (win64, LGPL)', sizeMB: 77, note: 'GPU decoding via NVIDIA NVDEC', line: { major: 8, minor: 1 } };
const build90 = { ...build81, label: 'ffmpeg 9.0 (win64, LGPL)', line: { major: 9, minor: 0 } };
const found = (version) => ({ version: `ffmpeg version ${version} Copyright (c) 2000-2026 the FFmpeg developers`, source: 'PATH' });
const RECOMMENDED = /\(recommended\)$/;

// ---- ffmpegLine: the release line from `ffmpeg -version` ----
assert.deepStrictEqual(setup.ffmpegLine('ffmpeg version n9.0-12-gabc Copyright'), { major: 9, minor: 0 });
assert.deepStrictEqual(setup.ffmpegLine('ffmpeg version 8.1-full_build-www.gyan.dev Copyright'), { major: 8, minor: 1 });
assert.deepStrictEqual(setup.ffmpegLine('ffmpeg version 7.1.1 Copyright'), { major: 7, minor: 1 });
assert.strictEqual(setup.ffmpegLine('ffmpeg version N-114833-g1234 Copyright'), null, 'a master build has no release line');
assert.strictEqual(setup.ffmpegLine('ffmpeg version 2024-11-03-git-df00705e00-full_build Copyright'), null, 'a dated git build either');

// ---- no ffmpeg found: recommended, as before ----
{
  const it = setup.downloadItem({ build: build81, found: null, nvidiaDriver: '581.15' });
  assert.strictEqual(it.id, 'build');
  assert.match(it.label, RECOMMENDED);
  assert.ok(it.recommended);
  assert.strictEqual(it.description, 'ffmpeg 8.1 (win64, LGPL), ~77 MB from BtbN/FFmpeg-Builds, no admin rights');
}

// ---- ffmpeg 9.0 on PATH, driver 581: 9.x needs 610, the download (8.1) matches -> recommended, and says why ----
{
  const it = setup.downloadItem({ build: build81, found: found('n9.0-12-gabc'), nvidiaDriver: '581.15' });
  assert.match(it.label, RECOMMENDED);
  assert.ok(it.recommended);
  assert.ok(it.detail.startsWith('Matches NVIDIA driver 581.15, so GPU encoding (NVENC) works. The ffmpeg you have (9.0) '
    + 'needs driver 610 or newer for it. '), it.detail);
  assert.ok(!/decod(es|ing) (fails|doesn)/i.test(it.detail), 'GPU decoding still works with the old ffmpeg');
}

// ---- the encoder check already saw the mismatch (a master build: no line in its version): recommended ----
{
  const it = setup.downloadItem({
    build: build81, found: found('N-114833-g1234'), nvidiaDriver: '581.15',
    driverNotice: { requiredApi: '13.1', foundApi: '13.0', minDriver: '610.00' },
  });
  assert.match(it.label, RECOMMENDED);
  assert.ok(it.detail.startsWith('Matches NVIDIA driver 581.15, so GPU encoding (NVENC) works. The ffmpeg you have '
    + 'needs driver 610 or newer for it. '), it.detail);
}

// ---- not recommended ----
for (const [why, o] of [
  ['ffmpeg 8.1 on PATH already matches driver 581', { build: build81, found: found('n8.1'), nvidiaDriver: '581.15' }],
  ['driver 610+: no NVENC cap, any line works', { build: build90, found: found('n9.0'), nvidiaDriver: '612.10' }],
  ['no NVIDIA driver', { build: build90, found: found('n9.0'), nvidiaDriver: null }],
  ['master build, nothing known about NVENC', { build: build81, found: found('N-114833-g1234'), nvidiaDriver: '581.15' }],
  ['the download is not a matching line', { build: build90, found: found('n9.0'), nvidiaDriver: '581.15' }],
  // ffmpegPath set: it wins over a downloaded build, so the download would change nothing.
  ['ffmpeg from the ffmpegPath setting', { build: build81, found: { ...found('n9.0'), source: 'setting' }, nvidiaDriver: '581.15' }],
  ['a build without a line (macOS)', { build: { ...build81, line: undefined }, found: found('n9.0'), nvidiaDriver: '581.15' }],
]) {
  const it = setup.downloadItem(o);
  assert.doesNotMatch(it.label, RECOMMENDED, why);
  assert.ok(!it.recommended, why);
  assert.ok(it.detail.startsWith('Real-time 4K, HEVC 10-bit, AV1 and ProRes. GPU decoding via NVIDIA NVDEC. '), `${why}: ${it.detail}`);
}

// ---- the mismatch the encoder check stored for this ffmpeg + driver reaches the list (src/transcode_probe.js) ----
{
  const tp = require('../../src/transcode_probe');
  const tools = { ffmpeg: '/x/ffmpeg', version: 'ffmpeg version N-1' };
  const notice = { requiredApi: '13.1', foundApi: '13.0', minDriver: '610.00' };
  const all = { [tp.encoderCacheKey(tools, '581.15')]: { v: tp.ENCODER_CACHE_VER, encoder: 'h264_qsv', driverNotice: notice } };
  const store = { get: (k) => (k === tp.ENCODER_KEY ? all : undefined) };
  assert.deepStrictEqual(tp.knownDriverNotice(tools, store, '581.15'), notice);
  assert.strictEqual(tp.knownDriverNotice(tools, store, '612.10'), null, 'another driver: not known');
  assert.strictEqual(tp.knownDriverNotice(null, store, '581.15'), null, 'no ffmpeg');
}

console.log('setup recommend: ok');
