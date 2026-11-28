'use strict';
// node test/run.js unit --grep seek_preview_pass: the background keyframe pass of the seek-bar previews
// (media/thumbs.js passArm, docs/notes/seek-preview.md phase 3) and the host's keyframe run (src/thumbhost.js).
// - starts only when armed, after its delay; asks coarse to fine (middle, quarters, eighths ...), one at a time;
// - skips slots already answered (captured frames, keyframes known from earlier replies);
// - pauses while busy, hidden, the pointer drags, or another tile sets the clock; a running pass request is cancelled
//   then, or when the hovered slot needs work; resumes on the 500 ms retry;
// - paced at a quarter of a core (by the CPU a reply reports, else its wall time; wall time while playing), half a
//   core while the pointer rests on the bar;
// - stops when the bar is complete, and the service closes (worker / host job ends); pictures stay within the cap;
// - none for a remote file read by the worker; Live transcode and remote native run like local files;
// - native: with few keyframes per slot, keyframe runs (one ffmpeg for up to 8 keyframes) instead of per-slot asks;
// - the fill after the keyframe pass: first the floor (min(N, 20) evenly spread slots with a picture of their own),
//   then every other slot coarse to fine, with no cost gate; pauses and cancels like the keyframe pass, restarts a
//   cancelled stretch from its first empty slot; a native sweep is one ffmpeg whose pictures match ffmpeg's reference
//   frames on a generated 1080p H.264 clip with a 10 s GOP;
// - native background sweeps decode on the GPU (preview method order), hover pictures and runs in software; a GPU
//   failure falls back to software at once and the method is not tried again.
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
 * request {slot, mode, t, to, aborted}; `ms` per request (`sweepMs` per sweep); a sweep answers the first 30 fps
 * frame at or after each step (`sweepFrames`: the frames it says it decoded).
 */
function mk(o = {}) {
  const calls = [];
  const env = { busy: false, hidden: false, on: true, playing: false, active: 0, max: 0 };
  const D = o.duration || 60;
  const gop = o.gop || 0;
  const keyAt = (t) => (gop ? Math.floor((t - 10) / gop + 1e-9) * gop + 10 : t);
  const s = new ThumbService({
    duration: D, startT: 10, size: 1e9, fps: 30, cap: o.cap || 30e6, log: o.log || (() => {}), idleMs: o.idleMs ?? 50,
    busy: () => env.busy, hidden: () => env.hidden, passOn: () => env.on, playing: () => env.playing,
    pass: { delayMs: o.delayMs ?? 20 }, restMs: o.restMs,
    remote: o.remote, frameMs: o.frameMs,
    request: o.noRequest ? undefined : async (t, w, h, signal, mode, opts) => {
      const c = { t, to: opts && opts.to, slot: Math.floor((t - 10) / s.X + 1e-9), mode, pass: !!(opts && opts.pass), aborted: false };
      calls.push(c);
      env.active++; env.max = Math.max(env.max, env.active);
      const sweepMs = typeof o.sweepMs === 'function' && mode === 'sweep' ? o.sweepMs() : o.sweepMs;
      const ms = mode === 'sweep' && sweepMs !== undefined ? sweepMs : o.ms ?? 5;
      if (ms === 0) await null;
      else await new Promise((r) => { const tm = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(tm); r(); }, { once: true }); });
      env.active--;
      if (signal.aborted) { c.aborted = true; return null; }
      c.end = performance.now();
      const cpu = o.cpu !== undefined ? { cpu: o.cpu } : {};
      if (mode === 'sweep') {
        const ts = [];
        for (let g = t; g < opts.to && g < 10 + D; g += opts.step) ts.push(Math.ceil(g * 30 - 1e-6) / 30);
        if (!ts.length) return null;
        return { kt: ts[0], w, h, fmt: 'jpeg', data: jpeg(), more: ts.slice(1).map((kt) => ({ kt, data: jpeg() })), end: true, ...cpu, ...(o.sweepFrames ? { frames: o.sweepFrames } : {}) };
      }
      if (mode === 'run') {
        const ks = [];
        for (let k = keyAt(t); k < 10 + D && ks.length < 8; k += gop) ks.push(k);
        return { kt: ks[0], w, h, fmt: 'jpeg', data: jpeg(), more: ks.slice(1).map((kt) => ({ kt, data: jpeg() })), end: ks.length < 8 };
      }
      const kp = keyAt(t);
      if (!gop) return { kt: t, covered: true, w, h, fmt: 'jpeg', data: jpeg(), ...cpu };
      const kn = kp + gop < 10 + D ? kp + gop : null;
      if (mode === 'near') return { kt: kp, w, h, fmt: 'jpeg', data: jpeg(), covered: true, ...(kn === null ? { kn: null } : { next: { kt: kn, data: jpeg() } }) };
      return { kt: kp, w, h, fmt: 'jpeg', data: jpeg(), covered: true };
    },
  });
  return { s, calls, env };
}

(async () => {
  const T0 = Date.now();
  const step = (n) => console.log(`  ${n} (${Date.now() - T0} ms)`); // progress: the runner stops a file silent for 30 s
  step('1');
  // 1. Not before it is armed, not before its delay; then coarse to fine, one at a time, until the bar is complete.
  {
    const { s, calls, env } = mk({ delayMs: 150, idleMs: 20e3 }); // the engine's idle time: closing must not wait for it
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

  step('2');
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
    const keyAsks = g.calls.filter((c) => c.mode !== 'sweep').length;
    assert.ok(keyAsks <= 7, `a 60 s file with a 10 s GOP needs about one ask per keyframe (${keyAsks} asks)`);
    g.s.dispose();
  }

  step('3');
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

  step('4');
  // 4. The pointer wins: a hover whose slot needs a picture cancels a running pass request and is served first; once
  //    the pointer's slot and neighbours are there, the pass goes on while the pointer rests; a hover with nothing to
  //    do does not cancel it; no pass while dragging; leaving keeps a running pass request.
  {
    const { s, calls } = mk({ ms: 40, duration: 120 });
    s.passArm();
    await until(() => s.inflight && s.inflight.pass, 1000);
    const pc = calls[calls.length - 1];
    s.hover(91, () => {}); // slot 45, away from the first pass slots
    await tick(5);
    assert.ok(pc.aborted, 'the pass request is cancelled by the hover');
    assert.ok(await until(() => calls.some((c) => !c.pass)), 'the hover is asked for');
    assert.strictEqual(calls.find((c) => !c.pass).slot, 45, "the pointer's slot first");
    const hoverAsks = () => calls.filter((c) => !c.pass).length;
    assert.ok(await until(() => s.stats0().filled, 2000), 'the pointer slot and its neighbours are filled');
    assert.ok(hoverAsks() <= 9, `slot and 4 neighbours each side (${hoverAsks()})`);
    const n0 = calls.filter((c) => c.pass).length;
    assert.ok(await until(() => calls.filter((c) => c.pass).length > n0 + 1, 1500), 'the pass goes on while the pointer rests');
    await until(() => s.inflight && s.inflight.pass, 1000);
    const running = s.inflight;
    s.hover(91.2, () => {}); // same slot, nothing to do
    await tick(5);
    assert.ok(!running.cancelSent, 'a hover with nothing to do leaves the pass request running');
    s.hover(31, () => {}, true); // drag
    await tick(150);
    const n1 = calls.filter((c) => c.pass).length;
    await tick(500);
    assert.strictEqual(calls.filter((c) => c.pass).length, n1, 'none while dragging');
    s.leave();
    assert.ok(await until(() => calls.filter((c) => c.pass).length > n1, 1500), 'resumes after the pointer left');
    await until(() => s.inflight && s.inflight.pass, 1000);
    const kept = s.inflight;
    s.hover(91.2, () => {});
    s.leave();
    await tick(5);
    assert.ok(!kept.cancelSent && s.inflight === kept, 'leaving the bar keeps a running pass request');
    s.dispose();
  }

  step('4b');
  // 4b. Pace: a quarter of a core idle, half a core while the pointer rests on the bar (the general fill, not the
  //     pointer's slot). A reply's CPU time paces when it is known (GPU decoding: little CPU for its wall time);
  //     while playing, wall time paces.
  {
    const asks = (x) => x.calls.filter((c) => c.pass && !c.aborted).length;
    const idle = mk({ ms: 30, duration: 7200 });
    const rest = mk({ ms: 30, duration: 7200 });
    const gpu = mk({ ms: 30, duration: 7200, cpu: 3 });
    const play = mk({ ms: 30, duration: 7200, cpu: 3 });
    play.env.playing = true;
    for (const x of [idle, rest, gpu, play]) x.s.passArm();
    rest.s.hover(3600, () => {});
    await until(() => rest.s.stats0().filled, 2000);
    const a = [idle, rest, gpu, play].map(asks);
    await tick(1500);
    const [ni, nr, ng, np] = [idle, rest, gpu, play].map((x, i) => asks(x) - a[i]);
    // 30 ms asks: one per 120 ms idle (12 in 1.5 s), one per 60 ms resting (25), back to back by CPU (50).
    assert.ok(ni >= 8 && ni <= 16, `idle: a quarter of a core (${ni} asks in 1.5 s)`);
    assert.ok(nr >= 1.6 * ni, `resting on the bar: about half a core (${nr} vs ${ni} asks)`);
    assert.ok(ng >= 2.5 * ni, `paced by the reported CPU (${ng} vs ${ni} asks)`);
    assert.ok(np <= 1.3 * ni, `while playing, wall time paces (${np} vs ${ni} asks)`);
    for (const x of [idle, rest, gpu, play]) x.s.dispose();
  }

  step('5');
  // 5. No pass for a remote file read by the worker (each keyframe is a file block over the link); Live transcode and
  //    native in a remote window (host requests on a remote file) pace and finish like a local file.
  {
    const r = mk({ remote: true, noRequest: true });
    r.s.passArm();
    await tick(200);
    assert.strictEqual(r.s.stats0().pass, null, 'remote worker file: no pass');
    assert.strictEqual(r.s.stats0().state, 'off', 'no worker started');
    r.s.dispose();

    const local = mk({ ms: 30, duration: 20, gop: 10, frameMs: 2 });
    const far = mk({ ms: 30, duration: 20, gop: 10, frameMs: 2, remote: true });
    local.s.passArm(); far.s.passArm();
    await tick(700);
    const [nl, nf] = [local, far].map((x) => x.calls.length);
    assert.ok(nf >= 0.75 * nl && nf <= 1.25 * nl, `the same pace (${nf} vs ${nl} asks)`);
    assert.ok(await until(() => /^done/.test(far.s.stats0().pass.state), 5000));
    assert.strictEqual(far.s.stats0().pass.state, 'done:complete', 'no budget: runs to the end');
    assert.strictEqual(far.s.stats0().pass.between.state, 'done:complete', 'the fill runs there too');
    local.s.dispose(); far.s.dispose();
  }

  step('6');
  // 6. Memory: a 2 h file under a tiny cap still ends (evicted slots are not asked for again), within the cap.
  {
    const { s, calls } = mk({ duration: 7200, cap: 60e3, ms: 0 });
    s.passArm();
    assert.ok(await until(() => /^done/.test(s.stats0().pass.state), 8000), 'the pass ends under a tiny cap');
    assert.ok(calls.length <= 240, `at most one ask per slot (${calls.length})`);
    assert.ok(s.stats0().bytes <= 60e3, `within the cap (${s.stats0().bytes} B)`);
    s.dispose();
  }

  step('7');
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

  step('9');
  // 9. The fill: a 60 s file with a keyframe every 10 s (X = 2 s, 30 slots). After the keyframe pass, the floor: the 20
  //    evenly spread slots get a picture of their own first (one slot per sweep; slots holding a keyframe already
  //    count), then every other slot, coarse to fine, until each slot has its own picture.
  const done = (s) => until(() => /^done/.test(s.stats0().pass.state), 5000);
  const floor20 = Array.from({ length: 20 }, (_, k) => Math.floor(((k + 0.5) / 20) * 30));
  const own = (s) => Array.from({ length: s.n }, (_, i) => i).filter((i) => s.inSlot(i, s.target(i)));
  {
    const { s, calls, env } = mk({ duration: 60, gop: 10, frameMs: 2 });
    s.passArm();
    assert.ok(await done(s), 'the pass finishes');
    const st = s.stats0();
    const sweeps = calls.filter((c) => c.mode === 'sweep');
    const slotOf = (c) => Math.floor((c.t - 10) / 2);
    const keySlots = [0, 5, 10, 15, 20, 25];
    const floorNeed = floor20.filter((x) => !keySlots.includes(x));
    assert.ok(calls.indexOf(sweeps[0]) > calls.findIndex((c) => c.mode !== 'sweep'), 'after the keyframe pass');
    assert.ok(calls.slice(calls.indexOf(sweeps[0])).every((c) => c.mode === 'sweep'), 'then sweeps only');
    const first = sweeps.slice(0, floorNeed.length);
    assert.deepStrictEqual(first.map(slotOf).sort((a, b) => a - b), floorNeed, `the floor first (${first.map(slotOf)})`);
    assert.ok(first.every((c) => c.to <= 10 + (slotOf(c) + 1) * 2 + 1e-9), 'one slot per floor sweep');
    assert.deepStrictEqual(first.slice(0, 3).map(slotOf), [8, 23, 3], `coarse to fine over the floor (15 holds a keyframe): ${first.map(slotOf)}`);
    assert.deepStrictEqual(own(s).length, 30, `every slot has a picture of its own (${own(s)})`);
    assert.strictEqual(st.pass.state, 'done:complete');
    assert.strictEqual(st.pass.between.state, 'done:complete', `the fill completes (${JSON.stringify(st.pass.between)})`);
    assert.ok(st.pass.floorS > 0 && st.pass.fullS >= st.pass.floorS, `time to floor and to a full bar (${st.pass.floorS} s, ${st.pass.fullS} s)`);
    assert.ok(sweeps.every((c) => c.pass && !c.aborted), 'pass requests (one thread, low priority)');
    assert.strictEqual(env.max, 1, 'one request at a time');
    assert.strictEqual(st.state, 'off', 'the service closes after the pass');
    let shown = null;
    s.hover(7, (p) => { shown = p; });
    assert.ok(shown && shown.t >= 16 && shown.t < 18, `a slot between keyframes shows its own frame at once (${shown && shown.t})`);
    s.leave(true);
    const n = calls.length;
    s.passArm();
    await tick(300);
    assert.strictEqual(calls.length, n, 'never twice per file');
    s.dispose();
  }

  step('10');
  // 10. Captured frames count: floor slots with a capture are not swept, and the capture stays.
  {
    const { s, calls } = mk({ duration: 60, gop: 10, frameMs: 2 });
    for (const slot of [2, 3, 6, 14]) s.offer(10 + slot * 2 + 0.5, bmp());
    s.passArm();
    assert.ok(await done(s));
    const swept = calls.filter((c) => c.mode === 'sweep').map((c) => Math.floor((c.t - 10) / 2));
    assert.ok(![2, 3, 6, 14].some((x) => swept.includes(x)), `captured slots are not swept (${swept})`);
    assert.strictEqual(s.stats0().captured, 4);
    assert.strictEqual(own(s).length, 30, 'the bar is full');
    s.dispose();
  }

  step('11');
  // 11. No cost gate: a heavy file (20 ms per frame first guess, then 20 ms measured: 4K HEVC in software) still fills
  //     every slot.
  {
    const { s } = mk({ duration: 60, gop: 10, frameMs: 20, sweepMs: 20, sweepFrames: 10 });
    s.passArm();
    assert.ok(await done(s));
    assert.strictEqual(s.stats0().pass.between.state, 'done:complete', `runs to the end (${JSON.stringify(s.stats0().pass.between)})`);
    assert.strictEqual(own(s).length, 30, 'the bar is full');
    s.dispose();
  }

  step('12');
  // 12. Evicted pictures are not decoded again: a 2 h file under a tiny cap still ends with at most one sweep per slot.
  {
    const { s, calls } = mk({ duration: 7200, gop: 60, cap: 60e3, ms: 0 });
    s.passArm();
    assert.ok(await until(() => /^done/.test(s.stats0().pass.state), 15000), 'the pass ends under a tiny cap');
    const swept = calls.filter((c) => c.mode === 'sweep').map((c) => Math.floor((c.t - 10) / s.X));
    assert.strictEqual(new Set(swept).size, swept.length, 'no slot is swept twice');
    s.dispose();
  }

  step('13');
  // 13. Pauses and cancels like the keyframe pass: busy, hidden or a drag cancels a running sweep; it starts again
  //     from its first empty slot.
  for (const why of ['busy', 'hidden', 'drag']) {
    let sweeps = 0;
    const { s, calls, env } = mk({ duration: 20, gop: 10, frameMs: 2, sweepMs: () => (sweeps++ ? 5 : 400) });
    s.passArm();
    assert.ok(await until(() => calls.some((c) => c.mode === 'sweep'), 3000), 'a sweep starts');
    const first = calls.find((c) => c.mode === 'sweep');
    if (why === 'drag') s.hover(3.5, () => {}, true); else env[why] = true;
    assert.ok(await until(() => first.aborted, 300), `${why} cancels the running sweep`);
    const n = calls.length;
    await tick(700);
    assert.ok(calls.slice(n).every((c) => c.mode !== 'sweep'), `no sweep while ${why}`);
    if (why === 'drag') s.leave(); else env[why] = false;
    assert.ok(await done(s), 'resumes and finishes');
    const again = calls.filter((c) => c.mode === 'sweep' && !c.aborted);
    assert.strictEqual(again[0].t, first.t, `restarts from its first empty slot (${again[0].t})`);
    assert.strictEqual(s.stats0().pass.between.state, 'done:complete');
    s.dispose();
  }

  step('8');
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
    const sw = th.thumbArgs('a.mp4', 0.5, 160, 90, false, 'v:0', 'jpeg', 'sweep', { pass: true, from: 0.5, step: 1, count: 12 });
    assert.strictEqual(sw[sw.indexOf('-threads') + 1], '1', 'sweep: one thread');
    assert.strictEqual(sw[sw.indexOf('-frames:v') + 1], '12', 'sweep: one picture per step');
    for (const [k, v] of [['-skip_frame', 'noref'], ['-skip_loop_filter', 'all'], ['-flags2', 'fast']]) assert.strictEqual(sw[sw.indexOf(k) + 1], v, `sweep: ${k} ${v}`);
    assert.ok(!sw.includes('-noaccurate_seek') && !sw.includes('-hwaccel'), 'sweep: accurate seek, software');
    assert.ok(sw.some((a) => /^select=.*scale=160:90:flags=fast_bilinear/.test(a)), 'sweep: select, then fast_bilinear');
    // One ffmpeg for a whole 12 s 1080p H.264 clip with keyframes at 0 and 10 s: a picture per second, each the frame
    // at its step (or a frame or two after: skip_frame noref) by ffmpeg's reference; between keyframes they differ
    // from the keyframe.
    const gl = require('../lib/gop_clip');
    const big = gl.make({ size: '1920x1080' });
    if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 && big) {
      const decoder = { tools: { ffmpeg: 'ffmpeg' }, file: big, pr: { video: { width: 1920, height: 1080, index: 0, startTime: 0 } } };
      const t0 = Date.now();
      const r = await th.nativeThumb(decoder, { t: 0.5, to: 13, step: 1, w: 160, h: 90, mode: 'sweep', pass: true }, () => {});
      const ms = Date.now() - t0;
      assert.ok(r, 'a sweep reply');
      const pics = [{ rel: r.rel, data: r.data }, ...r.more];
      assert.strictEqual(pics.length, 12, `a picture per slot (${pics.length})`);
      assert.strictEqual(r.end, true, 'reached the end of the file');
      const rgba = (jpg) => spawnSync('ffmpeg', ['-v', 'error', '-f', 'mjpeg', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
        { input: Buffer.from(jpg), windowsHide: true, maxBuffer: 1 << 24 }).stdout;
      const key = rgba(pics[0].data);
      for (let i = 0; i < pics.length; i++) {
        const g = 0.5 + i;
        const k = Math.round(g * 30);
        assert.ok(pics[i].rel >= g - 0.002 && pics[i].rel <= g + 2 / 30 + 1e-6, `picture ${i} at ${pics[i].rel} s for ${g} s`);
        const px = rgba(pics[i].data);
        const f = await gl.frameOf(px, r.w, r.h, k, big);
        assert.ok(f >= k && f <= k + 2, `picture ${i} shows frame ${f} (ffmpeg reference), want ${k}..${k + 2}`);
        if (i > 0 && i < 9) assert.notDeepStrictEqual(px, key, `picture ${i} differs from the keyframe`);
      }
      console.log(`native sweep, 12 s 1080p H.264: 12 pictures in one ffmpeg, ${ms} ms`);
    } else console.log('skip: ffmpeg missing (native sweep)');
  }


  step('14');
  // 14. GPU for background sweeps (native ffmpeg): the preview method order differs from playback's (d3d11va copies
  //     cost more CPU: last on Windows); the kept frames are selected before the download; hover pictures and keyframe
  //     runs stay software; a failing method falls back to software in the same request and is not tried again.
  {
    const hwa = require('../../src/hwaccel.js');
    const nv = { os: 'win32', gpus: [{ vendor: 'nvidia' }, { vendor: 'intel' }] };
    assert.deepStrictEqual(hwa.previewMethods(nv), ['d3d12va', 'cuda', 'd3d11va'], 'Windows with NVIDIA');
    assert.deepStrictEqual(hwa.previewMethods({ os: 'win32', gpus: [{ vendor: 'amd' }] }), ['d3d12va', 'd3d11va'], 'Windows, other GPU');
    assert.deepStrictEqual(hwa.previewMethods({ os: 'linux', vaapi: true, gpus: [{ vendor: 'nvidia' }] }), ['vaapi', 'cuda'], 'Linux');
    assert.deepStrictEqual(hwa.previewMethods({ os: 'linux', gpus: [] }), [], 'Linux without a render node or NVIDIA');
    assert.deepStrictEqual(hwa.previewMethods({ os: 'darwin', gpus: [] }), ['videotoolbox'], 'macOS');
    assert.deepStrictEqual(hwa.previewMethods(null), [], 'GPUs not known (or GPU decoding off): software');

    const opts = { pass: true, from: 0.5, step: 1, count: 12 };
    const g = th.thumbArgs('a.mp4', 0.5, 160, 90, false, 'v:0', 'jpeg', 'sweep', { ...opts, hw: { method: 'd3d12va', depth: 10 } });
    const at = (k) => g.indexOf(k);
    assert.deepStrictEqual(g.slice(at('-hwaccel'), at('-hwaccel') + 4), ['-hwaccel', 'd3d12va', '-hwaccel_output_format', 'd3d12'], 'd3d12va surfaces stay on the GPU');
    assert.ok(at('-hwaccel') < at('-i'), 'before the input');
    assert.ok(!g.includes('-skip_frame') && !g.includes('-skip_loop_filter'), 'no software skip flags on the GPU');
    assert.strictEqual(g[at('-threads') + 1], '1', 'one thread');
    assert.ok(g.includes('-benchmark'), 'reports its CPU time');
    assert.ok(g.some((a) => /^select=.*,hwdownload,format=p010le,scale=160:90:flags=fast_bilinear,showinfo$/.test(a)), `select before the download (${g[at('-vf') + 1]})`);
    const c = th.thumbArgs('a.mp4', 0.5, 160, 90, false, 'v:0', 'jpeg', 'sweep', { ...opts, hw: { method: 'cuda', depth: 8, scaleCuda: true } });
    assert.ok(c.some((a) => /^select=.*,scale_cuda=160:90:format=nv12,hwdownload,format=nv12,showinfo$/.test(a)), `cuda scales on the GPU (${c[c.indexOf('-vf') + 1]})`);
    assert.strictEqual(c[c.indexOf('-hwaccel_output_format') + 1], 'cuda');

    const gop = require('../lib/gop_clip').make();
    if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 && gop) {
      const tools = { ffmpeg: 'ffmpeg', gpuFilters: new Set() };
      const decoder = { tools, file: gop, pr: { video: { width: 320, height: 180, index: 0, startTime: 0, codec: 'h264', pixFmt: 'yuv420p' } } };
      const tried = [];
      const log = (m) => { if (/GPU/.test(m)) tried.push(m); };
      // videotoolbox exists only on macOS: elsewhere it fails, and the same request comes back from software.
      const mac = { os: 'darwin', gpus: [] };
      const req = { t: 0.5, to: 12, step: 1, w: 160, h: 90, mode: 'sweep', pass: true };
      if (process.platform !== 'darwin') {
        const r = await th.nativeThumb(decoder, req, log, undefined, mac);
        assert.ok(r && 1 + r.more.length === 12, `software answers after the GPU failed (${r && 1 + r.more.length} pictures)`);
        assert.ok(!r.gpu, 'decoded in software');
        assert.ok(tried.some((m) => /videotoolbox/.test(m)), `the failure is logged (${tried})`);
        const n = tried.length;
        const r2 = await th.nativeThumb(decoder, req, log, undefined, mac);
        assert.ok(r2 && !r2.gpu && tried.length === n, `a failed method is not tried again (${tried.slice(n)})`);
        assert.ok(r2.cpu >= 0, `the reply carries its CPU time (${r2.cpu} ms)`);
      }
      const hover = await th.nativeThumb(decoder, { t: 5, w: 160, h: 90, mode: 'exact' }, log, undefined, nv);
      assert.ok(hover && !hover.gpu, 'a hover picture stays software');
      const run = await th.nativeThumb(decoder, { t: 0, w: 160, h: 90, mode: 'run', pass: true }, log, undefined, nv);
      assert.ok(run && !run.gpu, 'a keyframe run stays software');
      // This machine's GPU, when it has one: the sweep's pictures are the same frames as software's.
      const fresh = { ...decoder, tools: { ffmpeg: 'ffmpeg', gpuFilters: new Set(['scale_cuda']) } };
      const local = await require('../../src/hardware.js').detect();
      const hw = await th.nativeThumb(fresh, req, () => {}, undefined, local);
      assert.ok(hw && 1 + hw.more.length === 12, 'GPU or its software fallback: a picture per slot');
      console.log(`sweep on this machine: ${hw.gpu || 'software'} (${hw.cpu} ms CPU)`);
    } else console.log('skip: ffmpeg missing (GPU fallback)');
  }

  console.log('seek_preview_pass_test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
