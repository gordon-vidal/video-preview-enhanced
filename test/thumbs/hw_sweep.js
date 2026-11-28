#!/usr/bin/env node
// The thumbnail worker's sweeps on the WebCodecs preview decoder (media/thumbs-worker.js hwSink; docs/notes/
// seek-preview.md), with a stand-in VideoDecoder (test/thumbs/fake_webcodecs.js) on a generated 12 s H.264 clip with
// keyframes at 0 and 10 s (test/lib/gop_clip.js):
// - open with playback's config: the decoder is checked with prefer-hardware; none in workers, or not supported: the
//   worker says why and sweeps stay software;
// - a sweep with hw picks the same frames as the software sweep (first at or after each step), starts on a key chunk,
//   returns bitmaps, and closes every frame and its decoder;
// - a decoder error falls back to software in the same request (hwFailed, the software pictures), and later sweeps
//   do not use it again;
// - a cancelled sweep closes its decoder and frames.
//
//   node test/thumbs/hw_sweep.js
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker: WT } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const libdir = path.join(root, 'media', 'libav-vpe');
const INIT = { type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'), wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe' };
const CONF = { codec: 'avc1.64001e', codedWidth: 320, codedHeight: 180 };

/** A worker with the fake decoder; ask(m) posts a request and resolves its reply. */
function openWorker(file, fake, hw = CONF) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const w = new WT(path.join(root, 'test', 'pool', 'worker-shim.js'), {
    workerData: { script: path.join(root, 'media', 'thumbs-worker.js'), preload: path.join(__dirname, 'fake_webcodecs.js'), fake },
  });
  let recv = null;
  w.on('message', (m) => {
    if (m.type === 'ready') w.postMessage({ type: 'open', size, ...(hw ? { hw } : {}) });
    else if (m.type === 'read') {
      const n = Math.max(0, Math.min(m.len, size - m.pos));
      const b = Buffer.alloc(n);
      if (n) fs.readSync(fd, b, 0, n, m.pos);
      w.postMessage({ type: 'block', pos: m.pos, data: new Uint8Array(b.buffer, b.byteOffset, n) });
    } else if (m.type === 'opened' || m.type === 'thumb' || m.type === 'error') { const r = recv; recv = null; if (r) r(m); }
  });
  const ask = (m) => new Promise((resolve) => { recv = resolve; w.postMessage(m); });
  const post = (m) => w.postMessage(m);
  const close = async () => { await w.terminate(); fs.closeSync(fd); };
  return { ask, post, close };
}

const kts = (r) => (Number.isFinite(r.kt) ? [r.kt, ...(r.more || []).map((x) => x.kt)] : []);
const sweep = (id, o = {}) => ({ type: 'thumb', id, t: 0.5, to: 12, step: 1, w: 160, h: 120, mode: 'sweep', ...o });

async function main() {
  const ok = [];
  const check = (name, cond, extra = '') => { ok.push(cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };
  const file = require('../lib/gop_clip').make();
  if (!file) { console.log('skip: no ffmpeg for the 10 s-GOP clip'); return; }

  // Software reference: the same worker without hw.
  let w = openWorker(file, {});
  let sw;
  try {
    const opened = await w.ask(INIT);
    check('open with a config: the preview decoder is there', opened.hw === true, JSON.stringify({ hw: opened.hw, why: opened.hwWhy }));
    sw = await w.ask(sweep(1));
    check('software sweep: RGBA pictures, no decoder made', kts(sw).length === 12 && sw.data && !sw.bmp && sw.fake.decoders === 0 && !sw.gpu,
      JSON.stringify({ n: kts(sw).length, decoders: sw.fake.decoders }));
    const hw = await w.ask(sweep(2, { hw: true }));
    // Every frame decodes on the GPU, so each step gets its exact frame; software skips non-reference frames (noref).
    const exact = Array.from({ length: 12 }, (_, i) => Math.ceil((0.5 + i) * 30 - 1e-6) / 30);
    const near = (a) => a.length === 12 && a.every((t, i) => t >= exact[i] - 1e-6 && t <= exact[i] + 2 / 30 + 1e-6);
    check('hw sweep: the first frame at or after each step', JSON.stringify(kts(hw)) === JSON.stringify(exact) && hw.gpu === 'webcodecs', JSON.stringify(kts(hw)));
    check('software sweep: within 2 frames of each step', near(kts(sw)), JSON.stringify(kts(sw)));
    check('hw sweep: bitmaps in the box, no RGBA', hw.bmp && hw.bmp.width === 160 && hw.bmp.height === 90 && !hw.data && hw.w === 160 && hw.h === 90
      && (hw.more || []).every((x) => x.bmp && !x.data), JSON.stringify({ bmp: hw.bmp, w: hw.w, h: hw.h }));
    const f = hw.fake;
    check('hw sweep: prefer-hardware, starts on a key chunk', f.firstType[0] === 'key' && f.configs === 1, JSON.stringify({ first: f.firstType, configs: f.configs }));
    check('hw sweep: every frame and the decoder closed', f.frames > 0 && f.frames === f.closedFrames && f.decoders === f.closedDecoders,
      JSON.stringify({ frames: f.frames, closed: f.closedFrames, decoders: f.decoders, closedDecoders: f.closedDecoders }));
    const cut = await w.ask(sweep(3, { t: 2.5, to: 5, hw: true }));
    check('hw sweep: only the stretch asked for', kts(cut).length === 3 && cut.kt > 2.49 && cut.kt < 2.6, JSON.stringify(kts(cut)));
    // Cancelled while the packets stream in.
    const p = w.ask(sweep(4, { hw: true }));
    w.post({ type: 'cancel', below: 5 });
    const c = await p;
    const key = await w.ask({ type: 'thumb', id: 6, t: 5.5, w: 160, h: 120, mode: 'key' });
    const g = key.fake || c.fake || {};
    check('cancelled hw sweep: cancelled, its decoder and frames closed', c.cancelled === true && g.decoders === g.closedDecoders && g.frames === g.closedFrames,
      JSON.stringify({ cancelled: c.cancelled, decoders: g.decoders, closed: g.closedDecoders, frames: g.frames, closedFrames: g.closedFrames }));
    check('key after a hw sweep: the keyframe (software)', key.kt === 0, JSON.stringify({ kt: key.kt }));
  } finally { await w.close(); }

  // A decoder error: software in the same request, and not again.
  w = openWorker(file, { failAfter: 40 });
  try {
    await w.ask(INIT);
    const r = await w.ask(sweep(1, { hw: true }));
    check('decoder error: the same request answers in software, says why', typeof r.hwFailed === 'string' && /fake decode error/.test(r.hwFailed)
      && !r.gpu && r.data && JSON.stringify(kts(r)) === JSON.stringify(kts(sw)), JSON.stringify({ hwFailed: r.hwFailed, kts: kts(r) }));
    const again = await w.ask(sweep(2, { hw: true }));
    check('decoder error: later sweeps stay software', again.fake.decoders === r.fake.decoders && !again.gpu && again.data && !again.hwFailed,
      JSON.stringify({ decoders: again.fake.decoders }));
    check('decoder error: frames closed', again.fake.frames === again.fake.closedFrames, JSON.stringify({ frames: again.fake.frames, closed: again.fake.closedFrames }));
  } finally { await w.close(); }

  // No VideoDecoder in workers / not supported: open says so, sweeps stay software.
  for (const [name, fake] of [['no VideoDecoder in workers', { none: true }], ['not supported', { unsupported: true }]]) {
    w = openWorker(file, fake);
    try {
      const opened = await w.ask(INIT);
      check(`${name}: open says why`, opened.hw === false && opened.hwWhy.length > 0, JSON.stringify({ hw: opened.hw, why: opened.hwWhy }));
      const r = await w.ask(sweep(1, { hw: true }));
      check(`${name}: the sweep is software`, !r.gpu && r.data && kts(r).length === 12);
    } finally { await w.close(); }
  }
  // Opened without a config (any other file): no decoder checked.
  w = openWorker(file, {}, null);
  try {
    const opened = await w.ask(INIT);
    check('no config: no preview decoder, nothing to explain', opened.hw === false && opened.hwWhy === '', JSON.stringify({ hw: opened.hw, why: opened.hwWhy }));
  } finally { await w.close(); }

  const failed = ok.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : `all ${ok.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
