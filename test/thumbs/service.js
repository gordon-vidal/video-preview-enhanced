#!/usr/bin/env node
// ThumbService (media/thumbs.js) with the real thumbnail worker under
// worker_threads: a fast sweep over the bar must end on the last position
// (stale requests cancelled, few decodes), the neighbours of a resting pointer
// are filled (not while busy() says playback needs the CPU, not for remote
// files), repeats come from the cache, and nothing decodes after the pointer left. On a generated 10 s-GOP clip
// (test/lib/gop_clip.js) the worker's 'near' mode returns the closer keyframe and both keyframe times, and
// 'between' returns the frame at the target (ffmpeg reference), not the keyframe; 'sweep' (the between pass)
// returns the frame at each step of the stretch asked for.
//
//   node test/thumbs/service.js <video file>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Worker: WT } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const file = process.argv[2];
if (!file) { console.error('usage: node test/thumbs/service.js <video file>'); process.exit(2); }

// Browser bits thumbs.js uses.
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
URL.createObjectURL = () => 'blob:thumbs';
globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
globalThis.createImageBitmap = async (id) => ({ width: id.width, height: id.height, close() { this.closed = true; } });
globalThis.Worker = class {
  constructor() {
    this.w = new WT(path.join(root, 'test', 'pool', 'worker-shim.js'), { workerData: { script: path.join(root, 'media', 'thumbs-worker.js') } });
    this.w.on('message', (d) => this.onmessage && this.onmessage({ data: d }));
    this.w.on('error', (e) => this.onerror && this.onerror(e));
    sent.length = 0;
  }
  postMessage(m, t) { if (m.type === "thumb" || m.type === "cancel") { m.at = Math.round(performance.now()); sent.push(m); } this.w.postMessage(m, t || []); }
  terminate() { this.w.terminate(); }
};
const sent = [];
vm.runInThisContext(`${fs.readFileSync(path.join(root, 'media', 'thumbs.js'), 'utf8')}\nglobalThis.ThumbService = ThumbService;`);

const libdir = path.join(root, 'media', 'libav-vpe');
const size = fs.statSync(file).size;
const fd = fs.openSync(file, 'r');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;
let svc;
const reads = [];
const logs = [];

async function main() {
  // Duration from a probe run of the worker itself.
  const duration = +(process.env.DUR || 0) || await probeDuration();
  svc = new globalThis.ThumbService({
    workerSrcUrl: 'thumbs-worker.js',
    libav: { loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'), wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe' },
    size, duration, startT: 0, fps: 30, rotation: 0,
    onRead: (pos) => {
      reads.push(pos);
      setImmediate(() => {
        const n = Math.max(0, Math.min(1 << 20, size - pos));
        const b = Buffer.alloc(n);
        if (n) fs.readSync(fd, b, 0, n, pos);
        svc.post({ type: 'block', pos, data: new Uint8Array(b.buffer, b.byteOffset, n), rid: 'thumbs' });
      });
    },
    busy: () => busy,
    log: (m) => logs.push(m),
  });
  const ok = [];
  const check = (name, cond, extra = '') => { ok.push(cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };

  // 1. A fast sweep: 60 positions, 8 ms apart. Only the last one matters.
  let got = [];
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) {
    const rel = (duration * i) / 60;
    svc.hover(rel, (p) => got.push({ rel, p, at: performance.now() - t0 }));
    await sleep(8);
  }
  const lastRel = (duration * 59) / 60;
  for (let i = 0; i < 400 && !got.some((g) => g.rel === lastRel); i++) await sleep(10);
  const final = got.filter((g) => g.rel === lastRel);
  check('sweep ends on the last position', final.length >= 1, `${Math.round(final[0] ? final[0].at : -1)} ms after the sweep began`);
  const finalAt = final.length ? t0 + final[0].at : performance.now();
  const sweepAsked = sent.filter((m) => m.type === 'thumb' && m.at <= finalAt).length;
  if (process.env.THUMBS_LOG) console.log(JSON.stringify(sent.map((m) => ({ ty: m.type, id: m.id, t: m.t, at: m.at }))));
  // Each move replaces the pending target while the active decode finishes.
  check('sweep: few decodes (stale requests dropped)', svc.stats.decoded <= 20, `${svc.stats.decoded} decoded, ${sweepAsked} requests, ${sent.filter((m) => m.type === 'cancel').length} cancels for 60 positions`);
  check('picture size', final[0] && final[0].p.w === 160 && final[0].p.h > 0, final[0] ? `${final[0].p.w}x${final[0].p.h}` : '');

  // 2. The pointer stays: the neighbouring places (radius 4) are filled, then the worker rests.
  for (let i = 0; i < 1000 && (svc.nextNear() !== null || svc.inflight); i++) await sleep(10);
  check('neighbours filled while the pointer stays', svc.nextNear() === null, `${svc.list.length} pictures cached`);

  // 3. Same slot again: from the cache, synchronously, and no new request (picture and neighbours there).
  got = [];
  const before = sent.length;
  svc.hover(lastRel, (p) => got.push(p));
  check('cached hover is immediate', got.length === 1 && sent.length === before, `${got.length} callbacks, ${sent.length - before} requests`);

  // 4. Busy (playback needs the CPU): the hovered place still comes, but no neighbour filling.
  busy = true;
  const mid = duration / 3;
  const b0 = sent.filter((m) => m.type === 'thumb').length;
  got = [];
  svc.hover(mid, (p) => got.push(p));
  for (let i = 0; i < 400 && !(got.length && !svc.inflight); i++) await sleep(10);
  await sleep(1200);
  const busyAsked = sent.filter((m) => m.type === 'thumb').length - b0;
  check('busy: only the hovered place is decoded', busyAsked <= 1 && got.length >= 1, `${busyAsked} requests`);
  busy = false;

  // 5. The pointer leaves: nothing more is decoded (no idle prefetch since bff54bc: docs/PRODUCT.md).
  svc.leave();
  for (let i = 0; i < 200 && svc.inflight; i++) await sleep(10);
  const l0 = sent.filter((m) => m.type === 'thumb').length;
  await sleep(2500);
  check('no decoding after the pointer left', sent.filter((m) => m.type === 'thumb').length === l0, `${sent.filter((m) => m.type === 'thumb').length - l0} requests`);
  // Use a fresh cache so a different slot inside the observed range cannot be a slot hit.
  svc.dispose();
  svc = new globalThis.ThumbService({ ...svc.o });
  svc.hover(duration * 0.6, () => {}, true);
  // One answer teaches the keyframes around the pointer: another slot between them needs no request.
  for (let i = 0; i < 400 && !(svc.stats.decoded && !svc.inflight); i++) await sleep(10);
  let revisit = 0;
  while (revisit < svc.n && (revisit === svc.want || svc.asked.has(revisit) || svc.need(revisit))) revisit++;
  check('observed range contains an unrequested slot', revisit < svc.n);
  svc.leave(true);
  const readsBefore = reads.length;
  let immediate = false;
  svc.hover(svc.target(revisit), () => { immediate = true; }, true);
  await sleep(100);
  check('cached random-access range needs no reads or worker restart',
    immediate && svc.stats.requests === 1 && reads.length === readsBefore && !svc.worker);

  const ms = svc.stats.ms.slice().sort((x, y) => x - y);
  if (ms.length) console.log(`decode latency (decoded requests): median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms over ${ms.length}`);

  // 6. Cache cap: 30 MB worth of pictures at most.
  check('cache under cap', svc.bytes <= svc.cap);
  // 7. Remote file: every thumbnail costs a 4 MB block over the connection, so no neighbour filling.
  const rsvc = new globalThis.ThumbService({ workerSrcUrl: 'thumbs-worker.js', libav: {}, size, duration, startT: 0, fps: 30, remote: true, onRead: () => {}, busy: () => false });
  rsvc.want = 3;
  check('no neighbour filling when remote', rsvc.nextNear() === null);
  svc.dispose();
  fs.closeSync(fd);
  await gopChecks(check);
  if (process.env.THUMBS_LOG) console.log(logs.join('\n'));
  process.exit(ok.every(Boolean) ? 0 : 1);
}

/** A bare worker on `file`: ask(m) posts a request and resolves its reply. */
function openWorker(file) {
  const wfd = fs.openSync(file, 'r');
  const wsize = fs.fstatSync(wfd).size;
  const w = new WT(path.join(root, 'test', 'pool', 'worker-shim.js'), { workerData: { script: path.join(root, 'media', 'thumbs-worker.js') } });
  let recv = null;
  w.on('message', (m) => {
    if (m.type === 'ready') w.postMessage({ type: 'open', size: wsize });
    else if (m.type === 'read') {
      const n = Math.max(0, Math.min(m.len, wsize - m.pos));
      const b = Buffer.alloc(n);
      if (n) fs.readSync(wfd, b, 0, n, m.pos);
      w.postMessage({ type: 'block', pos: m.pos, data: new Uint8Array(b.buffer, b.byteOffset, n) });
    } else if (m.type === 'opened' || m.type === 'thumb' || m.type === 'error') recv(m);
  });
  const ask = (m) => new Promise((resolve) => { recv = resolve; w.postMessage(m); });
  const close = async () => { await w.terminate(); fs.closeSync(wfd); };
  return { ask, close };
}

async function gopChecks(check) {
  const gop = require('../lib/gop_clip');
  const file = gop.make();
  if (!file) { console.log('skip: no ffmpeg for the 10 s-GOP clip'); return; }
  const w = openWorker(file);
  try {
    await w.ask({ type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'), wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe' });
    let id = 0;
    const near3 = await w.ask({ type: 'thumb', id: ++id, t: 3, w: 160, h: 120, mode: 'near' });
    check('near at 3 s: the keyframe before, both keyframe times', near3.kt === 0 && near3.kp === 0 && near3.kn === 10, JSON.stringify({ kt: near3.kt, kp: near3.kp, kn: near3.kn }));
    const near7 = await w.ask({ type: 'thumb', id: ++id, t: 7, w: 160, h: 120, mode: 'near' });
    check('near at 7 s: the keyframe after is closer', near7.kt === 10 && near7.kp === 0 && near7.data, JSON.stringify({ kt: near7.kt, kp: near7.kp, kn: near7.kn }));
    for (const T of [1, 5, 9]) {
      const t0 = performance.now();
      const r = await w.ask({ type: 'thumb', id: ++id, t: T, w: 160, h: 120, mode: 'between' });
      const ms = Math.round(performance.now() - t0);
      const k = Math.round(T * gop.FPS);
      const slot = r.data ? await gop.frameOf(r.data, r.w, r.h, k, file) : null;
      check(`between at ${T} s: the frame at the target (ffmpeg reference)`, r.kp === 0 && r.kt <= T + 1e-6 && r.kt > T - 3 / gop.FPS && slot >= k - 2 && slot <= k,
        `kt ${r.kt}, frame ${slot} of ${k}, ${r.frames} packets, ${ms} ms`);
    }
    // A key request after 'between' is a keyframe again (the cheap flags are reset).
    const key = await w.ask({ type: 'thumb', id: ++id, t: 5.5, w: 160, h: 120, mode: 'key' });
    check('key after between: the keyframe', key.kt === 0, JSON.stringify({ kt: key.kt }));
    // The between pass's 'sweep': one job decodes the clip cheaply and keeps the first frame at or after each step.
    const t1 = performance.now();
    const sw = await w.ask({ type: 'thumb', id: ++id, t: 0.5, to: 13, step: 1, w: 160, h: 120, mode: 'sweep' });
    const pics = sw.data ? [{ kt: sw.kt, data: sw.data }, ...(sw.more || [])] : [];
    const bad = [];
    for (let i = 0; i < pics.length; i++) {
      const k = Math.round((0.5 + i) * gop.FPS);
      const f = await gop.frameOf(pics[i].data, sw.w, sw.h, k, file);
      if (!(pics[i].kt >= 0.5 + i - 0.002 && pics[i].kt <= 0.5 + i + 2 / gop.FPS + 1e-6 && f >= k && f <= k + 2)) bad.push({ i, kt: pics[i].kt, f, k });
    }
    check('sweep: a picture per step, each the frame at its step (ffmpeg reference)', pics.length === 12 && !bad.length && sw.end,
      `${pics.length} pictures, ${sw.frames} packets, ${Math.round(performance.now() - t1)} ms${bad.length ? `, off: ${JSON.stringify(bad.slice(0, 3))}` : ''}`);
    check('sweep: between keyframes they differ from the keyframe', pics.length === 12 && pics.slice(1, 9).every((x) => Buffer.compare(Buffer.from(x.data), Buffer.from(pics[0].data)) !== 0));
    const cut = await w.ask({ type: 'thumb', id: ++id, t: 2.5, to: 5, step: 1, w: 160, h: 120, mode: 'sweep' });
    check('sweep: only the stretch asked for', cut.kt > 2.49 && cut.kt < 2.6 && (cut.more || []).length === 2, JSON.stringify({ kt: cut.kt, more: (cut.more || []).map((x) => x.kt) }));
    const key2 = await w.ask({ type: 'thumb', id: ++id, t: 5.5, w: 160, h: 120, mode: 'key' });
    check('key after sweep: the keyframe', key2.kt === 0, JSON.stringify({ kt: key2.kt }));
  } finally { await w.close(); }
  // MPEG-PS has no index: a seek can land past the keyframe, which must not answer with the keyframe after.
  const ps = gop.make({ codec: 'mpeg2' });
  const p = openWorker(ps);
  try {
    const info = await p.ask({ type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'), wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe' });
    const t0 = info.start || 0;
    const key = await p.ask({ type: 'thumb', id: 1, t: t0 + 5, w: 160, h: 120, mode: 'key' });
    check('MPEG-PS key at 5 s: the keyframe before, not after', Math.abs(key.kt - t0) < 0.05, JSON.stringify({ kt: key.kt, start: t0 }));
    const r = await p.ask({ type: 'thumb', id: 2, t: t0 + 7, w: 160, h: 120, mode: 'between' });
    check('MPEG-PS between at 7 s: from the keyframe before', Math.abs(r.kp - t0) < 0.05 && Math.abs(r.kt - t0 - 7) < 3 / gop.FPS, JSON.stringify({ kt: r.kt, kp: r.kp }));
    // A one-slot sweep (the fill's floor) 7 s after the keyframe: decoded from the keyframe before, not empty.
    const one = await p.ask({ type: 'thumb', id: 3, t: t0 + 7, to: t0 + 7.5, step: 1, w: 160, h: 120, mode: 'sweep' });
    check('MPEG-PS one-slot sweep at 7 s: its frame', Number.isFinite(one.kt) && one.kt >= t0 + 7 - 1e-3 && one.kt < t0 + 7.5 && !(one.more || []).length,
      JSON.stringify({ kt: one.kt, more: (one.more || []).length, frames: one.frames }));
  } finally { await p.close(); }
}

function probeDuration() {
  return new Promise((resolve) => {
    const w = new WT(path.join(root, 'test', 'pool', 'worker-shim.js'), { workerData: { script: path.join(root, 'media', 'thumbs-worker.js') } });
    w.on('message', (m) => {
      if (m.type === 'ready') w.postMessage({ type: 'open', size });
      else if (m.type === 'read') {
        const n = Math.max(0, Math.min(1 << 20, size - m.pos));
        const b = Buffer.alloc(n);
        if (n) fs.readSync(fd, b, 0, n, m.pos);
        w.postMessage({ type: 'block', pos: m.pos, data: new Uint8Array(b.buffer, b.byteOffset, n) });
      } else if (m.type === 'opened') { w.terminate(); resolve(m.duration || 10); }
    });
    w.postMessage({ type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'), wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe' });
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
