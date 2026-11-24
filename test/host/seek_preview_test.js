'use strict';
// node test/host/seek_preview_test.js: lazy seek-bar previews (media/thumbs.js) and the native
// ffmpeg thumbnail (src/thumbhost.js). docs/notes/seek-preview.md.
// - nothing is requested before the first hover; a hover decodes the pointer's place first, then a few
//   neighbours, newest position wins; leaving stops decoding and the service closes after the idle time;
//   no neighbours while playback is busy or for remote files;
// - the native request path (o.request) works without the libav.js worker;
// - Live transcode (EncodedStream) answers seek-bar thumbnails through the same host path with the real source
//   keyframe time, cancels on abort, and a page for a URL never asks (engine.js net);
// - thumbhost decodes one keyframe to RGBA of the asked box (real ffmpeg, when on PATH).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'media', 'thumbs.js'), 'utf8');
const ctx = {
  performance, setTimeout, clearTimeout, console, Uint8ClampedArray, Uint8Array, Map, Promise, Math, AbortController,
  ImageData: class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } },
  createImageBitmap: async (img) => ({ w: img.width, h: img.height, close() { this.closed = true; } }),
};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.ThumbService = ThumbService;`, ctx);
const { ThumbService } = ctx;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Coarse to fine: every index once; the first ones spread over the range.
  for (const n of [1, 2, 7, 24, 100]) {
    const o = ThumbService.coarseToFine(n);
    assert.strictEqual(o.length, n, `coarseToFine(${n}) length`);
    assert.strictEqual(new Set(o).size, n, `coarseToFine(${n}) unique`);
  }
  const first4 = [...ThumbService.coarseToFine(100).slice(0, 4)];
  assert.deepStrictEqual(first4, [50, 25, 75, 12], 'middle, then quarters');

  // Lazy: nothing is requested until the first hover; one request at a time (request path = native backend).
  let busy = false;
  let active = 0;
  let maxActive = 0;
  const asked = [];
  const mk = (extra) => new ThumbService({
    duration: 600, startT: 10, size: 1e9, fps: 30, cap: 30e6, log: () => {},
    busy: () => busy, idleMs: 120,
    request: async (t, w, h) => {
      active++; maxActive = Math.max(maxActive, active);
      asked.push(t);
      await tick(5);
      active--;
      return { kt: t, w, h, data: new Uint8Array(w * h * 4) };
    },
    ...extra,
  });
  const s = mk();
  await tick(150);
  assert.strictEqual(asked.length, 0, 'nothing decoded before the first hover');
  assert.strictEqual(s.stats0().requests, 0);
  assert.strictEqual(typeof s.strip, 'undefined', 'no strip');

  // Hover: the picture under the pointer first, then neighbours while the pointer stays.
  const got = [];
  s.hover(126, (p) => got.push(p));
  await tick(300);
  assert.ok(asked.length >= 1 && Math.abs(asked[0] - (10 + 126)) < 3, `first request is the pointer's place (${asked[0]})`);
  assert.ok(got.length >= 1, 'exact picture delivered');
  assert.ok(asked.length === 9, `hover place plus 4 neighbours each side (${asked.length})`);
  assert.ok(asked.slice(1).every((t) => Math.abs(t - asked[0]) <= 4 * 3 + 0.01), 'neighbours are near the pointer');
  assert.strictEqual(maxActive, 1, 'one thumbnail at a time');
  assert.strictEqual(s.stats0().cached, 9);
  // A neighbour is a cache hit at once.
  const g2 = [];
  s.hover(126 + 3, (p) => g2.push(p));
  assert.strictEqual(g2.length, 1, 'neighbour picture at once');

  // Newest position wins; leaving stops everything.
  asked.length = 0;
  s.hover(400, () => {});
  s.hover(450, () => {});
  await tick(10);
  s.leave();
  const n0 = asked.length;
  await tick(200);
  assert.ok(asked.length - n0 <= 1, 'after leaving at most the running request finishes');
  assert.strictEqual(s.stats0().hovering, false);
  assert.ok(s.stats0().state === 'off', 'worker/service closed after the idle time');
  const cached = s.stats0().cached;
  assert.ok(cached >= 9, 'pictures stay cached');
  // Hovering a fully cached place needs no work.
  asked.length = 0;
  const g3 = [];
  s.hover(126, (p) => g3.push(p));
  await tick(100);
  assert.strictEqual(g3.length, 1);
  assert.strictEqual(asked.length, 0, 'cached place and neighbours: no request');
  s.leave();
  s.dispose();

  // Busy playback: only the pointer's own place is decoded, no neighbours.
  asked.length = 0;
  busy = true;
  const b = mk();
  b.hover(300, () => {});
  await tick(200);
  assert.strictEqual(asked.length, 1, 'busy playback: only the hovered place');
  b.dispose();
  busy = false;

  // Small thumbnail budget (membudget): never over the cap.
  const small = mk({ cap: 3 * 160 * 120 * 4 });
  small.hover(300, () => {});
  await tick(300);
  assert.ok(small.stats0().bytes <= 3 * 160 * 120 * 4, 'within the budget');
  small.dispose();

  // Remote (SSH) files: the hovered place only (every thumbnail costs blocks over the link).
  asked.length = 0;
  const remote = mk({ remote: true });
  remote.hover(300, () => {});
  await tick(200);
  assert.strictEqual(asked.length, 1, 'remote: no neighbour filling');
  remote.dispose();

  // During a drag, retain the active decode and replace the pending target.
  const requests = [];
  const pictures = [];
  const scrub = mk({
    request: (t, w, h, signal) => new Promise((resolve) => {
      requests.push({ t, signal, complete: (kt) => resolve({ kt, covered: true, w, h, data: new Uint8Array(w * h * 4) }) });
    }),
  });
  const preview = (t) => scrub.hover(t, (p) => pictures.push(p), true);
  preview(126);
  preview(180);
  preview(210);
  assert.deepStrictEqual(requests.map((r) => r.t), [136], 'one active request during a sweep');
  requests[0].complete(130);
  await tick();
  assert.deepStrictEqual(requests.map((r) => r.t), [136, 220], 'only the latest pending target dispatches');
  requests[1].complete(190);
  await tick();
  assert.ok(pictures.length, 'latest picture publishes');
  scrub.leave(true);
  const revisited = [];
  scrub.hover(192, (p) => revisited.push(p), true);
  assert.strictEqual(revisited.length, 1, 'an unrequested slot in the observed range paints immediately');
  assert.strictEqual(requests.length, 2, 'an anchor hit avoids a native start');

  preview(300);
  preview(390);
  scrub.leave(true);
  assert.ok(requests[2].signal.aborted, 'release cancels the active native job');
  const beforeLateReply = pictures.length;
  requests[2].complete(280);
  await tick(70);
  assert.strictEqual(pictures.length, beforeLateReply, 'a stale reply cannot publish');
  assert.strictEqual(requests.length, 3, 'release drops the pending target');
  scrub.dispose();

  // Native ffmpeg: one keyframe as RGBA of the box.
  const th = require('../../src/thumbhost.js');
  assert.deepStrictEqual(th.fitBox(3840, 2160, 160, 120), { w: 160, h: 90 });
  assert.deepStrictEqual(th.fitBox(1080, 1920, 120, 160), { w: 90, h: 160 });
  const args = th.thumbArgs('a.mp4', 12.3456, 160, 90);
  assert.ok(args.indexOf('-skip_frame') < args.indexOf('-i') && args.includes('nokey'), 'keyframes only, before the input');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'input-side seek');
  const ff = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
  const clip = path.join(root, 'test', 'media', 'cases', 'long_20s.mp4');
  if (ff.status === 0 && fs.existsSync(clip)) {
    const ms = [];
    for (const t of [0, 7.5, 19.5]) {
      const t0 = Date.now();
      const r = await th.decodeThumb({ ffmpeg: 'ffmpeg' }, clip, { w: 1920, h: 1080 }, t, 160, 120);
      ms.push(Date.now() - t0);
      assert.ok(r, `thumbnail at ${t} s`);
      assert.ok(Number.isFinite(r.kt) && r.kt <= t, `source timestamp ${r.kt} at ${t}`);
      assert.strictEqual(r.w, 160);
      assert.strictEqual(r.h, 90);
      assert.strictEqual(r.data.length, 160 * 90 * 4);
      let sum = 0;
      for (let i = 0; i < r.data.length; i += 4) sum += r.data[i] + r.data[i + 1] + r.data[i + 2];
      assert.ok(sum > 0, 'not black');
    }
    // The host sends JPEG (a few KB) instead of RGBA (~58 KB) over the RPC pipe, with the same keyframe timestamp.
    for (const t of [0, 7.5, 19.5]) {
      const raw = await th.decodeThumb({ ffmpeg: 'ffmpeg' }, clip, { w: 1920, h: 1080 }, t, 160, 120);
      const j = await th.decodeThumb({ ffmpeg: 'ffmpeg' }, clip, { w: 1920, h: 1080 }, t, 160, 120, undefined, undefined, 'jpeg');
      assert.ok(j, `jpeg thumbnail at ${t} s`);
      assert.deepStrictEqual([j.data[0], j.data[1]], [0xff, 0xd8], 'a JPEG file');
      assert.deepStrictEqual([j.data[j.data.length - 2], j.data[j.data.length - 1]], [0xff, 0xd9], 'a complete JPEG file');
      assert.ok(j.data.length * 8 < raw.data.length, `jpeg ${j.data.length} B is far smaller than rgba ${raw.data.length} B`);
      assert.ok(j.data.length < 20 * 1024, `jpeg ${j.data.length} B stays small`);
      assert.strictEqual(j.kt, raw.kt, 'same real keyframe timestamp');
      assert.deepStrictEqual([j.w, j.h], [160, 90]);
    }
    const viaHost = await th.nativeThumb({ pr: { video: { width: 1920, height: 1080, index: 0, startTime: 0 } }, file: clip, tools: { ffmpeg: 'ffmpeg' } },
      { t: 7.5, w: 160, h: 120 });
    assert.strictEqual(viaHost.fmt, 'jpeg', 'host replies are tagged jpeg');
    assert.ok(Number.isFinite(viaHost.kt) && viaHost.rel === viaHost.kt, `kt ${viaHost.kt} / rel ${viaHost.rel} kept`);
    assert.ok(th.thumbArgs('a.mp4', 1, 160, 90, false, 'v:0', 'jpeg').includes('mjpeg'));
    assert.strictEqual(await th.decodeThumb({ ffmpeg: 'ffmpeg' }, path.join(root, 'missing.mp4'), { w: 1920, h: 1080 }, 0, 160, 120), null, 'missing file: null');
    console.log(`native thumbnails (long_20s.mp4): ${ms.join(', ')} ms`);
  } else console.log('skip: ffmpeg or test/media/cases/long_20s.mp4 missing (native thumbnail decode)');

  // Live transcode: the page asks the host like native ffmpeg (no remoteStream exclusion), URLs stay out.
  const engineSrc = fs.readFileSync(path.join(root, 'media', 'engine.js'), 'utf8');
  assert.ok(!engineSrc.includes('cfg.native ? this.remoteStream'), 'engine: Live transcode is not excluded from thumbnails');
  assert.ok(engineSrc.includes('if (this.cfg.net) return null;'), 'engine: URL tabs have no thumbnails');
  const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
  const sendThumbSrc = extSrc.slice(extSrc.indexOf('  sendThumb(m) {'), extSrc.indexOf('  async sendExactFrame'));
  assert.ok(sendThumbSrc.includes('nd instanceof remotestream.EncodedStream'), 'host: EncodedStream gets thumbnails');
  assert.ok(sendThumbSrc.includes('!this.url'), 'host: URL tabs excluded');
  {
    const { EncodedStream } = require('../../src/remotestream.js');
    const probed = { duration: 20, video: { index: 0, codec: 'hevc', width: 1920, height: 1080, fps: 30, startTime: 0 }, audio: null };
    const mkStream = (file, tools) => new EncodedStream({ tools, file, post: () => {}, log: () => {}, remote: false, encoder: 'h264_nvenc', cpuEncoder: null, probed });
    const bad = mkStream('x.mkv', {});
    assert.strictEqual(th.nativeThumb(bad, { t: 1, w: 200, h: 90 }, () => {}), null, 'box over 160: refused');
    assert.strictEqual(th.nativeThumb(mkStream('', {}), { t: 1, w: 160, h: 90 }, () => {}), null, 'no file: refused');
    bad.dispose();
    // Cancellation: the child is killed and the answer is null, as for native ffmpeg.
    if (ff.status === 0 && fs.existsSync(clip)) {
      const lt = mkStream(clip, { ffmpeg: 'ffmpeg' });
      const ac = new AbortController();
      const pending = th.nativeThumb(lt, { t: 5, w: 160, h: 90 }, () => {}, ac.signal);
      ac.abort(); // release, hide, reload or dispose while ffmpeg is still starting
      assert.strictEqual(await pending, null, 'abort ends the thumbnail with null');
      assert.strictEqual(await th.nativeThumb(lt, { t: 5, w: 160, h: 90 }, () => {}, ac.signal), null, 'already aborted: no spawn');
      lt.dispose();
    }
    // Real decode: the answer carries the decoded source keyframe time, so the page's cache dedupes the range.
    if (ff.status === 0 && fs.existsSync(clip)) {
      const lt = mkStream(clip, { ffmpeg: 'ffmpeg' });
      const r = await th.nativeThumb(lt, { t: 7.5, w: 160, h: 90 }, () => {});
      assert.ok(r, 'Live transcode thumbnail');
      assert.ok(Number.isFinite(r.kt) && r.kt <= 7.5, `real keyframe time ${r.kt}`);
      assert.strictEqual(r.rel, r.kt - 0, 'rel = kt - source start');
      assert.strictEqual(r.fmt, 'jpeg');
      assert.ok(r.data.length > 0 && r.data.length < r.w * r.h * 4 / 8, 'compact JPEG reply');
      lt.dispose();
      // The page-side cache then answers the whole visited range without another host request.
      let asks = 0;
      const svc = new ThumbService({
        duration: 20, startT: 0, size: 1e6, fps: 30, cap: 30e6, log: () => {}, busy: () => false, idleMs: 50,
        request: async (t, w, h) => { asks++; return { ...r, fmt: undefined, kt: r.kt, covered: true, w, h, data: new Uint8Array(w * h * 4) }; },
      });
      svc.hover(7.5, () => {}, true);
      await tick(30);
      svc.leave(true);
      const n = asks;
      const again = [];
      svc.hover(7.5, (pic) => again.push(pic), true);
      assert.strictEqual(again.length, 1, 'revisited place paints from the cache');
      assert.strictEqual(asks, n, 'no second host request for a visited keyframe range');
      svc.dispose();
    }
  }

  console.log('seek_preview_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
