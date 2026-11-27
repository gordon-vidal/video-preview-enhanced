'use strict';
// node test/run.js unit --grep seek_preview_pass: the background keyframe pass of the seek-bar previews
// (media/thumbs.js passArm, docs/notes/seek-preview.md phase 3) and the host's keyframe run (src/thumbhost.js).
// - starts only when armed, after its delay; asks coarse to fine (middle, quarters, eighths ...), one at a time;
// - skips slots already answered (captured frames, keyframes known from earlier replies);
// - pauses while busy, hidden, the pointer is on the bar (also dragging), or another tile sets the clock; a running
//   pass request is cancelled when the pointer comes or playback gets busy; resumes on the 500 ms retry;
// - stops when the bar is complete, and the service closes (worker / host job ends); pictures stay within the cap;
// - none for a remote file read by the worker; a far host (Live transcode, remote native) has a total budget;
// - native: with few keyframes per slot, keyframe runs (one ffmpeg for up to 8 keyframes) instead of per-slot asks.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'media', 'thumbs.js'), 'utf8');
const ctx = {
  performance, setTimeout, clearTimeout, console, Uint8ClampedArray, Uint8Array, Map, Set, Promise, Math, AbortController, Blob,
  ImageData: class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } },
  createImageBitmap: async (img) => ({ width: img.width || 160, height: img.height || 90, close() {} }),
  OffscreenCanvas: class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob(o) { return new Blob([new Uint8Array(2500)], { type: o.type }); }
  },
};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.ThumbService = ThumbService;`, ctx);
const { ThumbService } = ctx;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await tick(5); return f(); };
const jpeg = () => new Uint8Array(2500);
const bmp = () => ({ width: 160, height: 90, close() {} });

/**
 * A service over the host path. gop: keyframe every `gop` s (0: every asked time is a keyframe). Records each
 * request {slot, mode, t, aborted}; `ms` per request.
 */
function mk(o = {}) {
  const calls = [];
  const env = { busy: false, hidden: false, on: true, active: 0, max: 0 };
  const D = o.duration || 60;
  const gop = o.gop || 0;
  const keyAt = (t) => (gop ? Math.floor((t - 10) / gop + 1e-9) * gop + 10 : t);
  const s = new ThumbService({
    duration: D, startT: 10, size: 1e9, fps: 30, cap: o.cap || 30e6, log: o.log || (() => {}), idleMs: 50,
    busy: () => env.busy, hidden: () => env.hidden, passOn: () => env.on,
    pass: { delayMs: o.delayMs ?? 20, far: !!o.far, ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}) },
    remote: o.remote,
    request: o.noRequest ? undefined : async (t, w, h, signal, mode, opts) => {
      const c = { t, slot: Math.floor((t - 10) / s.X + 1e-9), mode, pass: !!(opts && opts.pass), aborted: false };
      calls.push(c);
      env.active++; env.max = Math.max(env.max, env.active);
      if (o.ms === 0) await null;
      else await new Promise((r) => { const tm = setTimeout(r, o.ms ?? 5); signal.addEventListener('abort', () => { clearTimeout(tm); r(); }, { once: true }); });
      env.active--;
      if (signal.aborted) { c.aborted = true; return null; }
      if (mode === 'run') {
        const ks = [];
        for (let k = keyAt(t); k < 10 + D && ks.length < 8; k += gop) ks.push(k);
        return { kt: ks[0], w, h, fmt: 'jpeg', data: jpeg(), more: ks.slice(1).map((kt) => ({ kt, data: jpeg() })), end: ks.length < 8 };
      }
      const kp = keyAt(t);
      if (!gop) return { kt: t, covered: true, w, h, fmt: 'jpeg', data: jpeg() };
      const kn = kp + gop < 10 + D ? kp + gop : null;
      if (mode === 'near') return { kt: kp, w, h, fmt: 'jpeg', data: jpeg(), covered: true, ...(kn === null ? { kn: null } : { next: { kt: kn, data: jpeg() } }) };
      return { kt: kp, w, h, fmt: 'jpeg', data: jpeg(), covered: true };
    },
  });
  return { s, calls, env };
}

(async () => {
  // 1. Not before it is armed, not before its delay; then coarse to fine, one at a time, until the bar is complete.
  {
    const { s, calls, env } = mk({ delayMs: 150 });
    await tick(100);
    assert.strictEqual(calls.length, 0, 'nothing before passArm');
    s.passArm();
    await tick(80);
    assert.strictEqual(calls.length, 0, 'nothing before the delay');
    assert.ok(await until(() => /^done/.test(s.stats0().pass.state)), `the pass finishes (${JSON.stringify(s.stats0().pass)})`);
    const order = calls.map((c) => c.slot);
    assert.deepStrictEqual(order, [...ThumbService.coarseToFine(30)], 'coarse to fine over the 30 slots, each once');
    assert.deepStrictEqual(order.slice(0, 7), [15, 7, 22, 3, 11, 18, 26], 'middle, quarters, eighths');
    assert.ok(calls.every((c) => c.pass), 'every request is marked as a pass request (one thread, low priority)');
    assert.strictEqual(env.max, 1, 'one picture at a time');
    const st = s.stats0();
    assert.strictEqual(st.bar, 30, `the bar is complete (${st.bar} of 30)`);
    assert.strictEqual(st.pass.state, 'done:complete');
    assert.strictEqual(st.state, 'off', 'the service closes after the pass (worker / host job ends)');
    const n = calls.length;
    s.passArm();
    await tick(200);
    assert.strictEqual(calls.length, n, 'one pass per file: arming again does nothing');
    s.dispose();
  }

  // 2. Skips answered slots: captured frames, and keyframes known from earlier replies (10 s GOP: about one ask per
  //    keyframe, not per slot).
  {
    const { s, calls } = mk();
    for (const slot of [15, 7, 22]) s.offer(10 + slot * 2 + 1, bmp());
    s.passArm();
    assert.ok(await until(() => /^done/.test(s.stats0().pass.state)));
    const asked = calls.map((c) => c.slot);
    assert.ok(![15, 7, 22].some((x) => asked.includes(x)), `captured slots are not asked for (${asked})`);
    assert.strictEqual(asked.length, 27, 'every other slot once');
    s.dispose();

    const g = mk({ gop: 10 });
    g.s.passArm();
    assert.ok(await until(() => /^done/.test(g.s.stats0().pass.state)));
    assert.strictEqual(g.s.stats0().bar, 30, 'the bar is complete');
    assert.ok(g.calls.length <= 7, `a 60 s file with a 10 s GOP needs about one ask per keyframe (${g.calls.length} asks)`);
    g.s.dispose();
  }

  // 3. Pauses while busy, hidden, or another tile sets the clock; resumes on the 500 ms retry.
  for (const why of ['busy', 'hidden', 'on']) {
    const { s, calls, env } = mk({ ms: 300 });
    const flip = (v) => { if (why === 'on') env.on = !v; else env[why] = v; };
    flip(true);
    s.passArm();
    await tick(400);
    assert.strictEqual(calls.length, 0, `no pass work while ${why === 'on' ? 'not the clock tile' : why}`);
    assert.ok(/^paused/.test(s.stats0().pass.state), `paused (${s.stats0().pass.state})`);
    flip(false);
    assert.ok(await until(() => calls.length > 0, 1000), `resumes within the retry (${why})`);
    // A running pass request is cancelled when playback gets busy (or the tab hides), then retried.
    if (why !== 'on') {
      assert.ok(s.inflight && s.inflight.pass, 'a pass request runs');
      flip(true);
      assert.ok(await until(() => calls[calls.length - 1].aborted, 300), `the running pass request is cancelled (${why})`);
      const n = calls.length;
      const slot = calls[n - 1].slot;
      await tick(700);
      assert.strictEqual(calls.length, n, 'nothing more while paused');
      flip(false);
      assert.ok(await until(() => calls.length > n, 1500), 'resumes');
      assert.strictEqual(calls[n].slot, slot, 'the cancelled slot is asked for again first');
    }
    s.dispose();
  }

  // 4. The pointer wins: a hover cancels a running pass request and is served first; no pass while the pointer is
  //    on the bar or drags; it resumes after leaving.
  {
    const { s, calls } = mk({ ms: 40 });
    s.passArm();
    await until(() => s.inflight && s.inflight.pass, 1000);
    const pc = calls[calls.length - 1];
    s.hover(51, () => {}); // slot 25
    await tick(5);
    assert.ok(pc.aborted, 'the pass request is cancelled by the hover');
    assert.ok(await until(() => calls.some((c) => !c.pass)), 'the hover is asked for');
    assert.strictEqual(calls.find((c) => !c.pass).slot, 25, "the pointer's slot first");
    await tick(600);
    assert.ok(calls.filter((c) => c.pass).length === 1, 'no pass requests while the pointer is on the bar');
    s.hover(31, () => {}, true); // drag
    await tick(300);
    assert.ok(calls.filter((c) => c.pass).length === 1, 'none while dragging');
    s.leave();
    assert.ok(await until(() => calls.filter((c) => c.pass).length > 1, 1500), 'resumes after the pointer left');
    s.dispose();
  }

  // 5. No pass for a remote file read by the worker (each keyframe is a file block over the link); a far host
  //    (Live transcode, remote native) paces slower and stops at its budget.
  {
    const r = mk({ remote: true, noRequest: true });
    r.s.passArm();
    await tick(200);
    assert.strictEqual(r.s.stats0().pass, null, 'remote worker file: no pass');
    assert.strictEqual(r.s.stats0().state, 'off', 'no worker started');
    r.s.dispose();

    const near = mk({ ms: 30 });
    const far = mk({ ms: 30, far: true });
    near.s.passArm(); far.s.passArm();
    await tick(700);
    assert.ok(far.calls.length < near.calls.length * 0.75, `a far host paces slower (${far.calls.length} vs ${near.calls.length} asks)`);
    near.s.dispose(); far.s.dispose();
    const b = mk({ ms: 30, far: true, budgetMs: 70 });
    b.s.passArm();
    assert.ok(await until(() => /^done/.test(b.s.stats0().pass.state), 3000));
    assert.strictEqual(b.s.stats0().pass.state, 'done:budget', 'stops at its budget');
    assert.ok(b.calls.length <= 4, `${b.calls.length} asks within a 70 ms budget of 30 ms asks`);
    b.s.dispose();
  }

  // 6. Memory: a 2 h file under a tiny cap still ends (evicted slots are not asked for again), within the cap.
  {
    const { s, calls } = mk({ duration: 7200, cap: 60e3, ms: 0 });
    s.passArm();
    assert.ok(await until(() => /^done/.test(s.stats0().pass.state), 8000), 'the pass ends under a tiny cap');
    assert.ok(calls.length <= 240, `at most one ask per slot (${calls.length})`);
    assert.ok(s.stats0().bytes <= 60e3, `within the cap (${s.stats0().bytes} B)`);
    s.dispose();
  }

  // 7. Native rule: once the known GOPs say at most 1.25 keyframes per slot, one ffmpeg run decodes the next 8
  //    keyframes; with many keyframes per slot it keeps asking per slot.
  {
    const few = mk({ duration: 300, gop: 2 , ms: 0 }); // X = 2 s, a keyframe every 2 s: 1 per slot
    few.s.passArm();
    assert.ok(await until(() => /^done/.test(few.s.stats0().pass.state), 8000));
    const runs = few.calls.filter((c) => c.mode === 'run').length;
    assert.ok(runs > 0, 'keyframe runs');
    assert.ok(few.calls.length <= 40, `150 slots in ${few.calls.length} asks (${runs} runs)`);
    assert.strictEqual(few.s.stats0().bar, 150, 'the bar is complete');
    few.s.dispose();
    const many = mk({ duration: 300, gop: 0.5 , ms: 0 }); // 4 keyframes per slot
    many.s.passArm();
    assert.ok(await until(() => /^done/.test(many.s.stats0().pass.state), 8000));
    assert.strictEqual(many.calls.filter((c) => c.mode === 'run').length, 0, 'no runs with 4 keyframes per slot');
    many.s.dispose();
  }

  // 8. thumbhost: pass requests use one decoder thread; a run decodes up to 8 keyframes in one process.
  const th = require('../../src/thumbhost.js');
  {
    const a = th.thumbArgs('a.mp4', 1, 160, 90, false, 'v:0', 'jpeg', 'run', { pass: true });
    assert.strictEqual(a[a.indexOf('-threads') + 1], '1', 'one thread for the pass');
    assert.strictEqual(a[a.indexOf('-frames:v') + 1], '8', 'a run asks for 8 keyframes');
    assert.ok(a.includes('nokey') && a.includes('-noaccurate_seek'), 'keyframes only');
    const k = th.thumbArgs('a.mp4', 1, 160, 90, false, 'v:0', 'jpeg', 'near');
    assert.strictEqual(k[k.indexOf('-threads') + 1], '2', 'a hover keeps 2 threads');
    const gop = require('../lib/gop_clip').make();
    if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 && gop) {
      const decoder = { tools: { ffmpeg: 'ffmpeg' }, file: gop, pr: { video: { width: 320, height: 180, index: 0, startTime: 0 } } };
      const r = await th.nativeThumb(decoder, { t: 0, w: 160, h: 90, mode: 'run', pass: true }, () => {});
      assert.ok(r, 'a run reply');
      assert.deepStrictEqual([r.rel, ...r.more.map((m) => m.rel)].map((x) => Math.round(x)), [0, 10], 'both keyframes of the 12 s clip');
      assert.strictEqual(r.end, true, 'fewer than 8: the run reached the end');
      assert.ok(r.more.every((m) => m.data.length > 0), 'each with its JPEG');
    }
  }

  console.log('seek_preview_pass_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
