'use strict';
// node test/host/tools_cache_test.js: the ffmpeg tool check and ffprobe results are cached (src/ffmpeg.js).
//  - locateTools with a cache record for this exact pair of binaries (resolved path, size, time) starts
//    nothing; a changed binary (size or time) or another path checks again; only working tools are stored.
//  - probe() of the same file again is served from memory (a copy); a touched or changed file probes again.
// With ffmpeg on PATH, also the real check and a real file; prints the times (docs/notes/perf-invisible.md).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('../../src/ffmpeg');

const exe = process.platform === 'win32' ? '.exe' : '';

async function fakeBinaries() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-tools-'));
  const ffmpeg = path.join(dir, `ffmpeg${exe}`);
  const ffprobe = path.join(dir, `ffprobe${exe}`);
  // Not programs: running them fails, so a result can only come from the cache.
  fs.writeFileSync(ffmpeg, 'not a program');
  fs.writeFileSync(ffprobe, 'not a program either');
  const store = { rec: undefined, sets: 0 };
  const cache = { get: () => store.rec, set: (r) => { store.sets++; store.rec = r; } };
  assert.strictEqual(await ff.locateTools(ffmpeg, '', cache), null, 'binaries that do not run');
  assert.strictEqual(store.sets, 0, 'a failed check is stored');
  const key = await ff.toolsKey(ffmpeg, ffprobe);
  assert.ok(key && key.includes(ffmpeg) && key.includes(ffprobe), key);
  // Stale cache record (older filter inventory without current version): re-checked (and fails on fake binaries).
  store.rec = { key, version: 'ffmpeg version 9.0.2-full_build', legacy: false, gpuFilters: ['scale_cuda'] };
  assert.strictEqual(await ff.locateTools(ffmpeg, '', cache), null, 'stale cache version is invalidated');
  store.rec = { key, v: ff.TOOLS_CACHE_VER, version: 'ffmpeg version 9.0.2-full_build', legacy: false, gpuFilters: ['scale_cuda'] };
  const t = await ff.locateTools(ffmpeg, '', cache);
  assert.ok(t && t.cached && t.ffprobe === ffprobe && t.version === store.rec.version && t.gpuFilters.has('scale_cuda'), JSON.stringify(t));
  // Replaced (another time) or rebuilt (another size): checked again (and fails here).
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(ffmpeg, later, later);
  assert.notStrictEqual(await ff.toolsKey(ffmpeg, ffprobe), key, 'a new time keeps the key');
  assert.strictEqual(await ff.locateTools(ffmpeg, '', cache), null, 'a replaced ffmpeg was not checked again');
  store.rec.key = await ff.toolsKey(ffmpeg, ffprobe);
  assert.ok((await ff.locateTools(ffmpeg, '', cache)).cached);
  fs.appendFileSync(ffprobe, '!');
  assert.strictEqual(await ff.locateTools(ffmpeg, '', cache), null, 'a changed ffprobe was not checked again');
  // Not found: no key, no cache.
  assert.strictEqual(await ff.toolsKey(path.join(dir, 'missing'), ffprobe), null);
  assert.strictEqual(await ff.whichFile('surely-not-a-command-vpe'), null);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function real() {
  if (!(await ff.whichFile('ffmpeg')) || !(await ff.whichFile('ffprobe'))) { console.log('tools cache: real ffmpeg part skipped (none on PATH)'); return null; }
  const store = { rec: undefined };
  const cache = { get: () => store.rec, set: (r) => { store.rec = r; } };
  let t0 = process.hrtime.bigint();
  const cold = await ff.locateTools('', '', cache);
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(cold && !cold.cached && store.rec && store.rec.version === cold.version);
  t0 = process.hrtime.bigint();
  const warm = await ff.locateTools('', '', cache);
  const warmMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(warm.cached && warm.version === cold.version && [...warm.gpuFilters].join() === [...cold.gpuFilters].join() && warm.legacy === cold.legacy);
  // ffprobe: a copy of a clip, probed twice, then touched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe-probe-'));
  const clip = path.join(dir, 'clip.mkv');
  fs.copyFileSync(path.join(__dirname, '..', '..', 'media', 'probe', 'h264_8_1080.mkv'), clip);
  t0 = process.hrtime.bigint();
  const a = await ff.probe(warm, clip);
  const probeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  const b = await ff.probe(warm, clip);
  const hitMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepStrictEqual(b, a, 'the cached result differs');
  b.video.width = 1;
  assert.notStrictEqual((await ff.probe(warm, clip)).video.width, 1, 'callers share the cached object');
  assert.ok(hitMs < probeMs / 3, `a cached probe took ${hitMs} ms (ffprobe ${probeMs} ms)`);
  const n = ff.probeCache.size;
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(clip, later, later);
  await ff.probe(warm, clip);
  assert.strictEqual(ff.probeCache.size, n + 1, 'a touched file was served from the cache');
  // Other tools (another ffprobe build): their own entry.
  await ff.probe({ ...warm, version: `${warm.version} other`, stamp: `${warm.stamp}x` }, clip);
  assert.strictEqual(ff.probeCache.size, n + 2, 'another ffprobe was served from the cache');
  fs.rmSync(dir, { recursive: true, force: true });
  return { coldMs, warmMs, probeMs, hitMs };
}

(async () => {
  await fakeBinaries();
  const r = await real();
  console.log(`tools cache: ok${r ? ` (tool check ${r.coldMs.toFixed(0)} ms -> ${r.warmMs.toFixed(1)} ms cached; ffprobe ${r.probeMs.toFixed(0)} ms -> ${r.hitMs.toFixed(1)} ms cached)` : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
