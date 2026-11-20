#!/usr/bin/env node
// Seek-bar thumbnail worker (media/thumbs-worker.js) under worker_threads.
//
//   node test/thumbs/bench.js [--n=8] [--png=dir] <file|dir>...
//
// Per file: start (init + open), the first thumbnail (cold), then n thumbnails
// at evenly spaced times in shuffled order (like hovering), and the worker's
// memory (process RSS growth while it runs). File reads go through a copy of the
// engine's block cache (1 MB blocks, read-ahead). --png writes the thumbnails.
// Timings: run through `node test/benchq.js node test/thumbs/bench.js ...`.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const opt = { n: 8, png: null };
const inputs = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) inputs.push(a);
  else if (m[1] === 'n') opt.n = +m[2];
  else if (m[1] === 'png') opt.png = m[2];
}
const files = [];
for (const i of inputs) {
  if (fs.statSync(i).isDirectory()) for (const f of fs.readdirSync(i).sort()) { if (!/\.(json|txt|md)$/i.test(f)) files.push(path.join(i, f)); } else files.push(i);
}
const libdir = path.join(root, 'media', 'libav-vpe');
const initMsg = {
  type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'),
  wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe',
};

function png(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function run(file) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    const memT = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const w = new Worker(path.join(root, 'test', 'pool', 'worker-shim.js'), { workerData: { script: path.join(root, 'media', 'thumbs-worker.js') } });
    // Engine block cache, reduced: aligned 1 MB blocks, one ahead.
    const BS = 1 << 20;
    const blocks = new Map();
    const block = (b) => { if (!blocks.has(b)) { const n = Math.max(0, Math.min(BS, size - b)); const buf = Buffer.alloc(n); if (n) fs.readSync(fd, buf, 0, n, b); blocks.set(b, buf); } return blocks.get(b); };
    let bytesRead = 0;
    const res = { file: path.basename(file), thumbs: [] };
    const t0 = performance.now();
    let id = 0;
    let times = [];
    let sent = 0;
    let timer = 0;
    const done = (err) => { if (res.closed) return; res.closed = true; clearTimeout(timer); clearInterval(memT); fs.closeSync(fd); w.terminate(); res.peakMB = Math.round((peak - rss0) / 1e6); res.readMB = +(bytesRead / 1e6).toFixed(1); if (err) reject(err); else resolve(res); };
    timer = setTimeout(() => done(new Error('timeout')), 120e3);
    const ask = () => {
      if (sent >= times.length) { clearTimeout(timer); done(); return; }
      res.sentAt = performance.now();
      w.postMessage({ type: 'thumb', id: ++id, t: times[sent++], w: 160, h: 120 });
    };
    w.on('error', (e) => done(e));
    w.on('message', (m) => {
      switch (m.type) {
        case 'ready': res.initMs = Math.round(performance.now() - t0); w.postMessage({ type: 'open', size }); break;
        case 'read': {
          setImmediate(() => {
            const b = Math.floor(m.pos / BS) * BS;
            const data = block(b).subarray(m.pos - b);
            bytesRead += data.length;
            const copy = new Uint8Array(data);
            w.postMessage({ type: 'block', pos: m.pos, data: copy }, [copy.buffer]);
          });
          break;
        }
        case 'opened': {
          res.openMs = Math.round(performance.now() - t0);
          if (!m.ok) { res.skip = m.why; clearTimeout(timer); done(); return; }
          res.codec = m.codec;
          const dur = m.duration || 10;
          // First: the middle (cold). Then evenly spaced, shuffled.
          const st = m.start || 0;
          times = [st + dur * 0.5];
          const grid = [];
          for (let i = 0; i < opt.n; i++) grid.push(st + (dur * (i + 0.5)) / opt.n);
          for (let i = grid.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [grid[i], grid[j]] = [grid[j], grid[i]]; }
          times.push(...grid);
          ask();
          break;
        }
        case 'thumb': {
          const ms = performance.now() - res.sentAt;
          res.thumbs.push({ t: times[sent - 1], kt: m.kt, ms: Math.round(ms), w: m.w, h: m.h, known: !!m.known });
          if (opt.png && m.data) png(path.join(opt.png, `${res.file}_${sent - 1}.png`), m.w, m.h, m.data);
          ask();
          break;
        }
        case 'error': done(new Error(`${m.where}: ${m.message}`)); break;
        case 'log': if (process.env.THUMBS_LOG) console.error(m.msg); break;
      }
    });
    w.postMessage(initMsg);
  });
}

(async () => {
  if (opt.png) fs.mkdirSync(opt.png, { recursive: true });
  const rows = [];
  for (const f of files) {
    try {
      const r = await run(f);
      if (r.skip) { console.log(`${r.file}: skipped (${r.skip})`); continue; }
      const dec = r.thumbs.slice(1).filter((x) => !x.known && x.kt !== null).map((x) => x.ms).sort((a, b) => a - b);
      const med = dec.length ? dec[Math.floor(dec.length / 2)] : null;
      const row = { file: r.file, codec: r.codec, startMs: r.openMs, firstMs: r.thumbs[0].ms, medianMs: med, maxMs: dec.length ? dec[dec.length - 1] : null, size: `${r.thumbs[0].w}x${r.thumbs[0].h}`, keyframes: new Set(r.thumbs.map((x) => x.kt)).size, peakMB: r.peakMB, readMB: r.readMB };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (e) { console.log(`${path.basename(f)}: FAILED ${e.message}`); }
  }
  if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(rows, null, 1));
})();
