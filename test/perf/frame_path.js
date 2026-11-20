#!/usr/bin/env node
// End-to-end frame path benchmark: decoder -> copy out of the wasm heap ->
// postMessage (transfer) -> a consumer that does the renderer's CPU side.
//
//   node test/perf/frame_path.js [--modes=decode,single,pool] [--workers=N] [--upload=1] [--repeat=1] <file|dir>...  (e.g. test/media)
//
// Modes (frames per second, wall clock, whole file, video only):
//   decode  libav.js in this process, read + decode, frames freed in the heap (no copy):
//           the upper bound for one core.
//   copy    the same with libav.js's copyout ('video': one slice of the heap per frame).
//   single  media/decoder-worker.js in a worker thread (test/pool/worker-shim.js),
//           driven like engine.js ('more' with 96 KB, one request in flight).
//   pool    media/pool.js DecoderPool over the same worker.
// The consumer reads each frame's planes the way GLRenderer.drawYuv uploads
// them (--upload=1: copies the visible rows into a staging buffer, which is
// what the GL driver does in texImage2D/texSubImage2D; 0: views only), then
// hands the buffer back like engine.js (--recycle=0: doesn't).
// Time it through the queue: node test/benchq.js node test/perf/frame_path.js ...
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker: WT } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const media = path.join(root, 'media');
const libdir = path.join(media, 'libav-vpe');
const opt = { modes: 'decode,single,pool', workers: undefined, upload: 1, recycle: 1, repeat: 1 };
const inputs = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else inputs.push(a);
}
const files = [];
for (const i of inputs) {
  if (fs.statSync(i).isDirectory()) { for (const f of fs.readdirSync(i).sort()) if (/\.(mp4|mkv|mov|webm|mpg|avi|wmv|m2ts|mxf)$/i.test(f)) files.push(path.join(i, f)); } else files.push(i);
}

globalThis.Worker = class {
  constructor() {
    this.w = new WT(path.join(root, 'test', 'pool', 'worker-shim.js'), { workerData: { script: path.join(media, 'decoder-worker.js') } });
    this.w.on('message', (d) => this.onmessage && this.onmessage({ data: d }));
    this.w.on('error', (e) => this.onerror && this.onerror(e));
  }
  postMessage(m, transfer) { this.w.postMessage(m, transfer || []); }
  terminate() { this.w.terminate(); }
};
require(path.join(media, 'pool.js'));

const initMsg = {
  type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'),
  wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe',
};

// ---- consumer: the CPU side of GLRenderer.drawYuv ---------------------------
let staging = new Uint8Array(0);
function consume(v) {
  const bps = (v.depth || 8) > 8 ? 2 : 1;
  const cw = v.cw === undefined ? 1 : v.cw;
  const chh = v.ch === undefined ? 1 : v.ch;
  const pw = (v.width + (1 << cw) - 1) >> cw;
  const ph = (v.height + (1 << chh) - 1) >> chh;
  const need = (v.width * v.height + 2 * pw * ph) * bps;
  if (bps === 2) new Uint16Array(v.data.buffer, v.data.byteOffset, v.data.byteLength >> 1); // the R16 view
  if (+opt.upload) {
    if (staging.length < need) staging = new Uint8Array(need);
    let o = 0;
    for (let p = 0; p < 3; p++) {
      const w = (p ? pw : v.width) * bps;
      const h = p ? ph : v.height;
      const { offset, stride } = v.layout[p];
      if (stride === w) { staging.set(v.data.subarray(offset, offset + w * h), o); o += w * h; continue; }
      for (let y = 0; y < h; y++, o += w) staging.set(v.data.subarray(offset + y * stride, offset + y * stride + w), o);
    }
  }
}

// ---- decode-only baseline ------------------------------------------------------
async function decodeOnly(file, copy) {
  if (!globalThis.LibAV) { globalThis.LibAV = { base: libdir }; require(path.join(libdir, 'libav-vpe.js')); }
  console.error = () => {};
  const libav = await globalThis.LibAV.LibAV({ noworker: true, nothreads: true, base: libdir, variant: 'vpe' });
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  libav.onblockread = (name, pos, len) => setImmediate(() => {
    const n = Math.max(0, Math.min(Math.max(len, 1 << 20), size - pos));
    const buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, pos);
    libav.ff_block_reader_dev_send(name, pos, n ? new Uint8Array(buf.buffer, buf.byteOffset, n) : null);
  });
  await libav.mkblockreaderdev('in0', size);
  const [fmt, streams] = await libav.ff_init_demuxer_file('in0');
  const vs = streams.find((s) => s.codec_type === 0);
  const [, c, pkt, frame] = await libav.ff_init_decoder(vs.codec_id, { codecpar: vs.codecpar, time_base: [vs.time_base_num, vs.time_base_den] });
  const rpkt = await libav.av_packet_alloc();
  const t0 = performance.now();
  let frames = 0;
  for (;;) {
    const [res, packets] = await libav.ff_read_frame_multi(fmt, rpkt, { limit: 96 * 1024 });
    const atEnd = res === libav.AVERROR_EOF;
    const vp = packets[vs.index] || [];
    if (vp.length || atEnd) {
      const fr = await libav.ff_decode_multi(c, pkt, frame, vp, { fin: atEnd, ignoreErrors: true, copyoutFrame: copy ? 'video' : 'ptr' });
      if (!copy) for (const f of fr) await libav.av_frame_free_js(f);
      frames += fr.length;
    }
    if (atEnd || (res !== 0 && res !== -libav.EAGAIN)) break;
  }
  const ms = performance.now() - t0;
  fs.closeSync(fd);
  libav.terminate();
  return { frames, fps: +(frames / (ms / 1000)).toFixed(1) };
}

// ---- the real path ----------------------------------------------------------------
function run(file, usePool) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const w = usePool ? new globalThis.DecoderPool('w', { multiRead: true, workers: opt.workers === undefined ? undefined : +opt.workers, log: false }) : new globalThis.Worker('w');
    let frames = 0;
    let t0 = 0;
    let closed = false;
    let consumeMs = 0;
    const done = (err, r) => { if (closed) return; closed = true; fs.closeSync(fd); w.terminate(); if (err) reject(err); else resolve(r); };
    const timer = setTimeout(() => done(new Error('timeout')), 600e3);
    w.onerror = (e) => done(new Error(`worker error ${e && e.message}`));
    w.onmessage = (e) => {
      const m = e.data;
      if (closed) return;
      switch (m.type) {
        case 'ready': w.postMessage({ type: 'open', size }); break;
        case 'read':
          setImmediate(() => {
            if (closed) return;
            const n = Math.max(0, Math.min(m.len, size - m.pos));
            const buf = Buffer.alloc(n);
            if (n) fs.readSync(fd, buf, 0, n, m.pos);
            w.postMessage({ type: 'block', pos: m.pos, data: new Uint8Array(buf.buffer, buf.byteOffset, n), rid: m.rid });
          });
          break;
        case 'streams':
          w.postMessage({ type: 'config', video: m.info.video ? 'soft' : 'none', audio: 'none', deep: true });
          break;
        case 'configured':
          t0 = performance.now();
          w.postMessage({ type: 'more', gen: 0, limit: 96 * 1024 });
          break;
        case 'batch': {
          const c0 = performance.now();
          for (const v of m.video) {
            if (v.kind !== 'yuv') continue;
            consume(v);
            frames++;
            // Like engine.js after the upload: the buffer goes back to the decoder.
            if (v.recycle && +opt.recycle) w.postMessage({ type: 'recycle', bufs: [v.data.buffer] }, [v.data.buffer]);
          }
          consumeMs += performance.now() - c0;
          if (m.eof) {
            clearTimeout(timer);
            const ms = performance.now() - t0;
            done(null, { frames, fps: +(frames / (ms / 1000)).toFixed(1), consumeMsPerFrame: +(consumeMs / Math.max(1, frames)).toFixed(2) });
          } else w.postMessage({ type: 'more', gen: 0, limit: 96 * 1024 });
          break;
        }
        case 'error': if (m.where === 'open' || m.where === 'init') done(new Error(m.message)); break;
        default: break;
      }
    };
    w.postMessage(initMsg);
  });
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

(async () => {
  const modes = String(opt.modes).split(',');
  const rep = +opt.repeat || 1;
  console.log(`upload ${+opt.upload ? 'copy' : 'views'}; repeat ${rep} (median)`);
  for (const file of files) {
    const row = [path.basename(file).padEnd(22)];
    for (const mode of modes) {
      const fps = [];
      let extra = '';
      for (let i = 0; i < rep; i++) {
        const r = mode === 'decode' || mode === 'copy' ? await decodeOnly(file, mode === 'copy') : await run(file, mode === 'pool');
        fps.push(r.fps);
        if (r.consumeMsPerFrame !== undefined) extra = ` (consumer ${r.consumeMsPerFrame} ms/f)`;
      }
      row.push(`${mode} ${String(median(fps)).padStart(6)}${rep > 1 ? ` [${fps.join(' ')}]` : ''}${extra}`);
    }
    console.log(row.join('  '));
  }
  process.exit(0);
})();
