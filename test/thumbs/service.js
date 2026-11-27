#!/usr/bin/env node
// ThumbService (media/thumbs.js) with the real thumbnail worker under
// worker_threads: a fast sweep over the bar must end on the last position
// (stale requests cancelled, few decodes), the neighbours of a resting pointer
// are filled (not while busy() says playback needs the CPU, not for remote
// files), repeats come from the cache, and nothing decodes after the pointer left.
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
  // A keyframe answer covers [its time, the asked time]: a slot inside that range needs no request.
  const covering = () => svc.list.find((e) => e.kind === 'key' && e.end > e.t);
  for (let i = 0; i < 400 && !covering(); i++) await sleep(10);
  const key = covering() || { t: 0, end: 0 };
  let revisit = 0;
  while (revisit < svc.n && !(svc.target(revisit) > key.t)) revisit++;
  check('observed range contains an unrequested slot', svc.target(revisit) <= key.end && !svc.asked.has(revisit));
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
  if (process.env.THUMBS_LOG) console.log(logs.join('\n'));
  process.exit(ok.every(Boolean) ? 0 : 1);
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
