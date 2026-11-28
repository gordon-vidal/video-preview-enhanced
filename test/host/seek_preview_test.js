'use strict';
// node test/host/seek_preview_test.js: lazy seek-bar previews (media/thumbs.js) and the native
// ffmpeg thumbnail (src/thumbhost.js). docs/notes/seek-preview.md.
// - nothing is requested before the first hover; a hover decodes the pointer's place first, then a few
//   neighbours, newest position wins; leaving stops decoding and the service closes after the idle time;
//   no neighbours while playback is busy or for remote files;
// - the native request path (o.request) works without the libav.js worker;
// - Live transcode (EncodedStream) answers seek-bar thumbnails through the same host path with the real source
//   keyframe time, cancels on abort, and a page for a URL never asks (engine.js net);
// - thumbhost decodes one keyframe to RGBA of the asked box (real ffmpeg, when on PATH);
// - the bar is a grid of N slots of X s (at least 20, at most 240); pictures are kept as JPEG with a few hot
//   bitmaps, within the smallest memory budget; frames the player showed (offer) are served on hover without a
//   request, one per slot, and the nearest picture comes at once;
// - the nearer keyframe on either side is shown; after a rest the exact picture is asked for (cancelled by movement,
//   not while dragging, busy or over budget); thumbhost's exact mode decodes the right frame of a 10 s-GOP clip.
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
  Blob,
  // A bitmap from RGBA (ImageData) has its size; one from a JPEG (Blob) is the fake encoder's 160 x 90.
  createImageBitmap: async (img) => {
    ctx.decodes++;
    return { width: img.width || 160, height: img.height || 90, close() { this.closed = true; } };
  },
  decodes: 0,
};
// The page's JPEG encoder (OffscreenCanvas.convertToBlob): 2.5 KB per 160 x 90 picture, as measured.
class FakeOffscreen {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { drawImage() {} }; }
  async convertToBlob(o) { return new Blob([new Uint8Array(2500)], { type: o.type }); }
}
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

  // The grid: X = max(D / 240, min(2 s, D / 20)), at least one frame; N = ceil(D / X).
  const grid = (duration, fps = 30) => {
    const g = new ThumbService({ duration, startT: 0, size: 1, fps, request: async () => null }).stats0();
    return [Math.round(g.X * 1000) / 1000, g.n];
  };
  assert.deepStrictEqual(grid(10), [0.5, 20], '10 s: 20 pictures');
  assert.deepStrictEqual(grid(20), [1, 20], '20 s: one per second');
  assert.deepStrictEqual(grid(60), [2, 30], '1 min: every 2 s');
  assert.deepStrictEqual(grid(300), [2, 150], '5 min: every 2 s');
  assert.deepStrictEqual(grid(600), [2.5, 240], '10 min: 240 pictures');
  assert.deepStrictEqual(grid(3600), [15, 240], '1 h: 240 pictures');
  assert.deepStrictEqual(grid(7200), [30, 240], '2 h: 240 pictures');
  assert.deepStrictEqual(grid(0.5, 30), [0.033, 15], 'half a second: one picture per frame');

  // Frames the player showed (offer): one per slot, kept as JPEG, served on hover without a request.
  {
    ctx.OffscreenCanvas = FakeOffscreen;
    const reqs = [];
    const floor = require('../../media/membudget.js').budgets(1).thumbs; // the smallest mem.thumbs
    const mkCap = (duration, cap, extra) => new ThumbService({
      duration, startT: 10, size: 1e9, fps: 30, cap, log: () => {}, idleMs: 50,
      request: async (t, w, h) => {
        reqs.push(t);
        await tick(2);
        return { kt: t, covered: true, w, h, data: new Uint8Array(w * h * 4) };
      },
      ...extra,
    });
    const bmp = () => ({ width: 160, height: 90, close() { this.closed = true; } });
    // Playback over a 20 s file at 30 fps: the engine offers a shown frame when wants() says so.
    const c = mkCap(20, floor);
    let offered = 0;
    for (let f = 0; f < 600; f++) {
      const t = 10 + f / 30;
      if (c.wants(t)) { c.offer(t, bmp(), 0, 1); offered++; }
    }
    assert.strictEqual(offered, 20, 'one capture per slot of playback (20 s: 20)');
    const extra = bmp();
    assert.strictEqual(c.offer(10.5, extra), false, 'a slot with a picture takes no second one');
    assert.ok(extra.closed, 'a refused bitmap is closed');
    await tick(5);
    let st = c.stats0();
    assert.strictEqual(st.frames, 20);
    assert.strictEqual(st.jpegs, 20, 'every capture is stored as JPEG');
    assert.ok(st.bytes <= floor, `within the smallest budget (${st.bytes} B)`);
    // Hover between two captured frames: the slot's own picture at once, no request.
    const got = [];
    c.hover(7.5, (p) => got.push(p));
    assert.strictEqual(got.length, 1, 'the captured picture is drawn at once');
    assert.ok(Math.abs(got[0].t - 10 - 7.5) <= st.X, `its time is within X of the pointer (${got[0].t - 10})`);
    assert.strictEqual(c.stats0().shown.kind, 'frame');
    await tick(60);
    assert.strictEqual(reqs.length, 0, 'every slot near the pointer has a captured picture: no request');
    c.leave(true);
    c.dispose();

    // A 2 h file under the smallest budget: all 240 slots fit as JPEG, at most 32 hot bitmaps.
    const long = mkCap(7200, floor);
    for (let i = 0; i < 240; i++) { long.offer(10 + (i + 0.5) * 30, bmp()); await tick(); } // one per X of playback
    await tick(5);
    st = long.stats0();
    assert.strictEqual(st.cached, 240, `all 240 pictures kept (${st.cached})`);
    assert.ok(st.hot <= 32, `at most 32 ready bitmaps (${st.hot})`);
    assert.ok(st.bytes <= floor && st.bytes < 2.5e6, `bytes count real sizes (${st.bytes} B)`);
    // A cold picture (JPEG only) is decoded on show.
    const cold = [];
    const d0 = ctx.decodes;
    long.hover(15, (p) => cold.push(p));
    await tick(5);
    const last = cold[cold.length - 1];
    assert.ok(ctx.decodes > d0 && last && Math.abs(last.t - 25) < 1e-6, 'a JPEG-only picture is decoded and shown');
    long.leave(true);
    long.dispose();

    // A Compare tile's share of the floor (16 tiles): still within it.
    const tile = mkCap(7200, floor / 16);
    for (let i = 0; i < 240; i++) { tile.offer(10 + (i + 0.5) * 30, bmp()); await tick(); }
    await tick(5);
    assert.ok(tile.stats0().bytes <= floor / 16, `a 16-tile share holds (${tile.stats0().bytes} B of ${floor / 16})`);
    assert.ok(tile.stats0().cached >= 100, `and keeps most pictures (${tile.stats0().cached})`);
    tile.dispose();

    // Nothing cached near the pointer: the nearest picture at once, the slot's keyframe later.
    const near = mkCap(600, floor, { remote: true });
    near.offer(10 + 2.2, bmp());
    const ng = [];
    near.hover(300, (p) => ng.push(p));
    assert.strictEqual(ng.length, 1, 'the nearest picture is drawn at once');
    assert.ok(Math.abs(ng[0].t - 12.2) < 1e-6, 'the nearest is the captured one');
    await tick(80);
    assert.ok(ng.length >= 2 && Math.abs(ng[ng.length - 1].t - 311.25) < 1e-6, "then the slot's own keyframe");
    near.dispose();
    delete ctx.OffscreenCanvas;
  }

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
  assert.deepStrictEqual(requests.map((r) => r.t), [136.25], 'one active request during a sweep');
  requests[0].complete(130);
  await tick();
  assert.deepStrictEqual(requests.map((r) => r.t), [136.25, 221.25], 'only the latest pending target dispatches');
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
  const input = args.indexOf('-i');
  assert.deepStrictEqual(args.slice(input - 2, input + 2), ['-protocol_whitelist', 'file', '-i', 'a.mp4']);
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

  // Exact mode (refine): the frame at T, decoded cheaply from the keyframe; 'near' brings the next keyframe too.
  {
    const ex = th.thumbArgs('a.mp4', 5, 160, 90, false, 'v:0', 'jpeg', 'exact');
    const before = ex.slice(0, ex.indexOf('-i'));
    for (const [k, v] of [['-skip_frame', 'noref'], ['-skip_loop_filter', 'all'], ['-flags2', 'fast'], ['-threads', '2']]) {
      assert.strictEqual(before[before.indexOf(k) + 1], v, `exact: ${k} ${v} before the input`);
    }
    assert.ok(!ex.includes('-noaccurate_seek') && !ex.includes('bidir') && !ex.includes('-hwaccel'), 'exact: accurate seek, no bidir, no hwaccel');
    assert.ok(ex.some((a) => /flags=fast_bilinear/.test(a)), 'exact: fast_bilinear scaling');
    assert.strictEqual(th.thumbArgs('a.mp4', 5, 160, 90, false, 'v:0', 'jpeg', 'near')[th.thumbArgs('a.mp4', 5, 160, 90, false, 'v:0', 'jpeg', 'near').indexOf('-frames:v') + 1], '2', 'near: two keyframes');
    const gop = require('../lib/gop_clip');
    const gopFile = ff.status === 0 ? gop.make() : null;
    if (gopFile) {
      const tools = { ffmpeg: 'ffmpeg' };
      const ms = [];
      for (const T of [1, 5, 9]) {
        const t0 = Date.now();
        const r = await th.decodeThumb(tools, gopFile, { w: 320, h: 180 }, T, 160, 120, undefined, undefined, 'rgba', 'exact');
        ms.push(Date.now() - t0);
        const k = Math.round(T * gop.FPS);
        assert.ok(r && r.kt >= T - 1e-6 && r.kt <= T + 2 / gop.FPS + 1e-6, `exact at ${T} s: picture time ${r && r.kt}`);
        const slot = await gop.frameOf(r.data, r.w, r.h, k, gopFile);
        assert.ok(slot >= k && slot <= k + 2, `exact at ${T} s shows frame ${slot} (ffmpeg reference), want ${k}..${k + 2}`);
        const key = await th.decodeThumb(tools, gopFile, { w: 320, h: 180 }, T, 160, 120);
        assert.strictEqual(key.kt, 0, 'the keyframe mode still gives the keyframe');
        assert.notDeepStrictEqual(Buffer.from(key.data), Buffer.from(r.data), `exact at ${T} s differs from the keyframe`);
      }
      const v = { pr: { video: { width: 320, height: 180, index: 0, startTime: 0 } }, file: gopFile, tools };
      const near = await th.nativeThumb(v, { t: 7, w: 160, h: 120, mode: 'near' });
      assert.ok(near.kt === 0 && near.next && near.next.kt === 10 && near.next.rel === 10, `near at 7 s: keyframes 0 and 10 (${near.kt}, ${near.next && near.next.kt})`);
      assert.deepStrictEqual([near.next.data[0], near.next.data[1]], [0xff, 0xd8], 'the next keyframe is a JPEG too');
      const last = await th.nativeThumb(v, { t: 11, w: 160, h: 120, mode: 'near' });
      assert.ok(last.kt === 10 && !last.next && last.kn === null, 'near in the last GOP: no keyframe after');
      console.log(`native exact pictures at 1/5/9 s after a keyframe (320x180): ${ms.join(', ')} ms`);
    } else console.log('skip: ffmpeg missing (exact-mode decode)');
  }

  // The nearer keyframe on either side, and refining while the pointer rests (fake host with the three modes).
  {
    const calls = [];
    let playing = false;
    let busyNow = false;
    let exactDelay = 2;
    const keyBefore = (t) => Math.floor(t / 10 + 1e-9) * 10; // keyframes every 10 s
    const mkR = (extra) => new ThumbService({
      duration: 60, startT: 0, size: 1e9, fps: 30, cap: 30e6, log: () => {}, idleMs: 5000, radius: 0, restMs: 60,
      frameMs: 1, playing: () => playing, busy: () => busyNow,
      request: async (t, w, h, signal, mode) => {
        const call = { t, mode, signal };
        calls.push(call);
        // Like engine.js hostThumb: an abort answers null at once.
        await new Promise((r) => { setTimeout(r, mode === 'exact' ? exactDelay : 2); signal.addEventListener('abort', r); });
        if (signal.aborted) return null;
        const data = new Uint8Array(w * h * 4);
        if (mode === 'exact') return { kt: Math.round(t * 30) / 30, w, h, data };
        const kp = keyBefore(t);
        return { kt: kp, w, h, data, covered: true, ...(mode === 'near' ? { next: { kt: kp + 10, data } } : {}) };
      },
      ...extra,
    });
    const last = (a) => a[a.length - 1];
    const exacts = () => calls.filter((c) => c.mode === 'exact');

    // 8 s: keyframes 0 and 10 are both learnt from one 'near' reply; 10 is closer.
    let s1 = mkR();
    const pics = [];
    s1.hover(8, (p) => pics.push(p));
    await tick(30);
    assert.strictEqual(calls[0].mode, 'near', 'unknown keyframes: a near request');
    assert.strictEqual(last(pics).t, 10, 'the keyframe after the pointer is closer than the one before');
    // 3 s: the keyframe before is closer and already there: at once, no request.
    const n0 = calls.length;
    const at3 = [];
    s1.hover(3, (p) => at3.push(p));
    assert.ok(at3.length === 1 && at3[0].t === 0, 'known GOP: the closer keyframe at once');
    await tick(30);
    assert.strictEqual(calls.length, n0, 'no request inside a known GOP whose pictures are there');
    s1.dispose();

    // Rest at 5 s (both keyframes 5 s away, X = 2 s): after the rest, one exact request; the frame is shown.
    calls.length = 0;
    s1 = mkR();
    const rp = [];
    s1.hover(5, (p) => rp.push(p));
    await tick(30);
    assert.strictEqual(exacts().length, 0, 'no refine before the pointer rested');
    await tick(120);
    assert.strictEqual(exacts().length, 1, 'one refine after the rest');
    assert.strictEqual(exacts()[0].t, 5, 'the refine asks for the slot time');
    assert.strictEqual(last(rp).t, 5, 'the exact picture replaces the keyframe');
    assert.ok(s1.stats0().refines === 1 && s1.stats0().shown.refined, 'counted and shown as refined');
    await tick(150);
    assert.strictEqual(exacts().length, 1, 'a refined slot is not refined again');
    // 9 s: the keyframe at 10 is within X: nothing to refine.
    s1.hover(9, () => {});
    await tick(150);
    assert.strictEqual(exacts().length, 1, 'a keyframe within X needs no refine');
    s1.dispose();

    // Movement cancels a running refine; the slot is refined when the pointer rests there again.
    calls.length = 0;
    exactDelay = 300;
    s1 = mkR();
    s1.hover(5, () => {});
    await tick(120);
    assert.strictEqual(exacts().length, 1, 'refine running');
    s1.hover(25, () => {});
    assert.ok(exacts()[0].signal.aborted, 'moving to another slot cancels the refine');
    await tick(20);
    assert.strictEqual(s1.stats0().refines, 0, 'a cancelled refine adds nothing');
    exactDelay = 2;
    s1.hover(5, () => {});
    await tick(200);
    assert.ok(exacts().filter((c) => c.t === 5).length === 2 && s1.stats0().refines >= 1, 'back on the slot: refined');
    s1.dispose();

    // Never while dragging.
    calls.length = 0;
    s1 = mkR();
    s1.hover(5, () => {}, true);
    await tick(200);
    assert.strictEqual(exacts().length, 0, 'no refine during a drag');
    s1.dispose();

    // Over budget: skipped (and counted once); the smaller budget applies while playing.
    calls.length = 0;
    s1 = mkR({ frameMs: 50 }); // 150 frames x 50 ms: 7.5 s
    s1.hover(5, () => {});
    await tick(200);
    assert.ok(exacts().length === 0 && s1.stats0().skipped === 1, `over budget: skipped (${s1.stats0().skipped})`);
    s1.dispose();
    playing = true;
    s1 = mkR({ frameMs: 5 }); // 150 frames x 5 ms: 0.75 s, over 0.5 s while playing, under 2 s paused
    s1.hover(5, () => {});
    await tick(200);
    assert.strictEqual(exacts().length, 0, 'over the playing budget: skipped');
    playing = false;
    s1.hover(25, () => {});
    s1.hover(5, () => {});
    await tick(200);
    assert.strictEqual(exacts().length, 1, 'paused: the same refine fits');
    s1.dispose();

    // Nothing while playback is busy; it comes once playback has room again.
    calls.length = 0;
    busyNow = true;
    s1 = mkR();
    s1.hover(5, () => {});
    await tick(200);
    assert.strictEqual(exacts().length, 0, 'no refine while playback is busy');
    busyNow = false;
    await tick(700);
    assert.strictEqual(exacts().length, 1, 'refined when playback has room');
    s1.dispose();
  }

  // Live transcode: the page asks the host like native ffmpeg (no remoteStream exclusion), URLs stay out.
  const engineSrc = fs.readFileSync(path.join(root, 'media', 'engine.js'), 'utf8');
  assert.ok(!engineSrc.includes('cfg.native ? this.remoteStream'), 'engine: Live transcode is not excluded from thumbnails');
  assert.ok(engineSrc.includes('if (this.cfg.net) return null;'), 'engine: URL tabs have no thumbnails');
  const viewerSrc = fs.readFileSync(path.join(root, 'src', 'unified-viewer.js'), 'utf8');
  const onThumbSrc = viewerSrc.slice(viewerSrc.indexOf('  async function onThumb('), viewerSrc.indexOf('  async function onExactFrame('));
  assert.ok(onThumbSrc.includes("kind === 'native' || kind === 'stream'"), 'host: Live transcode (EncodedStream) gets thumbnails');
  assert.ok(onThumbSrc.includes('isFileClip(c)'), 'host: URL clips excluded');
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

  // The first cost guess per frame counts the source's pixels: native ffmpeg decodes the full 1080p picture even
  // when it sends the page a smaller one.
  {
    const opts = [];
    const ectx = { performance, ThumbService: class { constructor(o) { opts.push(o); } } };
    ectx.VpeBlockCache = require('../../media/block-cache');
    ectx.VpeGlRenderer = require('../../media/gl-renderer');
    ectx.VpeCodecUtils = require('../../media/codec-utils');
    ectx.VpeDecoderBoot = require('../../media/decoder-boot');
    const engine = vm.runInNewContext(`${fs.readFileSync(path.join(root, 'media', 'engine.js'), 'utf8')}\ncreateEngine`, ectx);
    const proto = engine({ log: () => {}, onMeta: () => {} }).LibavPlayer.prototype;
    const guess = (video, cfg) => {
      opts.length = 0;
      Object.assign(Object.create(proto), {
        info: { video }, meta: { duration: 60, size: 1e8 }, vmode: 'soft', startT: 0, fps: 30, mem: { thumbs: 30e6 },
        cfg: { workerUrl: 'decoder-worker.js', ...cfg }, libavBlobs: {},
      }).thumbService();
      return opts[0].frameMs;
    };
    const sent = { width: 1280, height: 720, sourceWidth: 1920, sourceHeight: 1080 };
    assert.ok(Math.abs(guess(sent, { native: true }) - 1920 * 1080 * 1e-6) < 1e-9,
      `native 1080p sent at 720p: ${guess(sent, { native: true })} ms, expected the 1080p source's cost`);
    assert.ok(Math.abs(guess({ width: 1920, height: 1080 }, { native: true }) - 1920 * 1080 * 1e-6) < 1e-9, 'native, no source size');
  }

  console.log('seek_preview_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
