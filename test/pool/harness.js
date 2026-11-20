#!/usr/bin/env node
// Drives media/pool.js (DecoderPool) and a single decoder worker over media files
// the way engine.js does (block reads, more/batch, seek) and compares them.
//
//   node test/pool/harness.js [--workers=N] [--budget=MB] [--mode=both|single|pool]
//        [--seek] [--soft-all] [--json=out.json] <file|dir>...
//
// Per file: frames/s for one worker and for the pool (decode to eof, frames
// consumed at once), peak RSS, and a check that the pool hands out exactly the
// single worker's frames: same timestamps, same order, same pixel hash, same
// number of sound items. --seek also checks an accurate and a fast seek.
// --soft-all decodes H.264/VP8 in software too (the engine sends those to WebCodecs).
// POOL_LOG=1 prints the pool's log lines.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker: WT } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const media = path.join(root, 'media');
const opt = { workers: undefined, budget: 600, mode: 'both', seek: false, softAll: false, json: null };
const inputs = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) { inputs.push(a); continue; }
  if (m[1] === 'workers') opt.workers = +m[2];
  else if (m[1] === 'budget') opt.budget = +m[2];
  else if (m[1] === 'mode') opt.mode = m[2];
  else if (m[1] === 'seek') opt.seek = true;
  else if (m[1] === 'soft-all') opt.softAll = true;
  else if (m[1] === 'json') opt.json = m[2];
  else if (m[1] === 'engine-cache') opt.engineCache = true;
  else if (m[1] === 'fault') opt.fault = +m[2]; // a pool worker fails after this many batches
}
const files = [];
for (const i of inputs) {
  if (fs.statSync(i).isDirectory()) {
    for (const f of fs.readdirSync(i).sort()) if (!/\.(json|txt|md)$/i.test(f)) files.push(path.join(i, f));
  } else files.push(i);
}

// Browser Worker on top of worker_threads; the URL is ignored (always decoder-worker.js).
const shim = path.join(__dirname, 'worker-shim.js');
const workerScript = path.join(media, 'decoder-worker.js');
globalThis.Worker = class {
  constructor() {
    this.w = new WT(shim, { workerData: { script: workerScript } });
    this.w.on('message', (d) => this.onmessage && this.onmessage({ data: d }));
    this.w.on('error', (e) => this.onerror && this.onerror(e));
  }
  postMessage(m, transfer) { this.w.postMessage(m, transfer || []); }
  terminate() { this.w.terminate(); }
};
if (process.env.POOL_MINPIX) globalThis.DecoderPoolOptions = { minPixels: +process.env.POOL_MINPIX };
require(path.join(media, 'pool.js'));

const libdir = path.join(media, 'libav-vpe');
const initMsg = {
  type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'),
  wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe',
};

/** Hash of the visible samples (rows can carry uninitialised padding past the width). */
function hashFrame(v) {
  let h = 2166136261;
  const bps = (v.depth || 8) > 8 ? 2 : 1;
  const cw = v.cw === undefined ? 1 : v.cw;
  const chh = v.ch === undefined ? 1 : v.ch;
  for (let p = 0; p < 3; p++) {
    const w = (p ? (v.width + (1 << cw) - 1) >> cw : v.width) * bps;
    const hh = p ? (v.height + (1 << chh) - 1) >> chh : v.height;
    const { offset, stride } = v.layout[p];
    for (let y = 0; y < hh; y += 3) {
      const row = offset + y * stride;
      for (let x = (y * 7) % 13; x < w; x += 13) h = Math.imul(h ^ v.data[row + x], 16777619);
    }
  }
  return (h >>> 0).toString(16);
}

let peakRss = 0;
setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50).unref();

/**
 * --engine-cache: file reads go through the block cache proposed for engine.js
 * (same code: 1 MB aligned blocks from a simulated extension host, read-ahead,
 * answers keyed by reader id), instead of exact reads.
 */
class EngineBlocks {
  constructor(worker, readBlock) {
    this.worker = worker;
    this.readBlock = readBlock; // (pos, len) -> Uint8Array, delivered async to onBlock
    this.cfg = { remote: false };
  }

  // ---- from here: the proposed engine.js code --------------------------------
  initBlocks() {
    this.blockSize = this.cfg.remote ? 4 << 20 : 1 << 20;
    this.readAhead = this.cfg.remote ? 4 : 1;
    this.blocks = new Map(); // aligned pos -> Uint8Array
    this.inflight = new Set();
    this.wantReads = new Map(); // reader id (pool worker, 0 for one worker) -> {pos, len} it waits for
    this.readerPos = new Map(); // reader id -> last read position, for cache eviction
    this.blockBytes = 0;
  }

  requestBlock(bpos) {
    if (bpos < 0 || bpos >= this.size || this.blocks.has(bpos) || this.inflight.has(bpos)) return;
    this.inflight.add(bpos);
    this.readBlock(bpos, this.blockSize); // engine: vscode.postMessage({ type: 'readBlock', pos: bpos, len: this.blockSize })
  }

  onWorkerRead(pos, len, rid = 0) {
    if (!this.blocks) this.initBlocks();
    this.wantReads.set(rid, { pos, len });
    this.readerPos.set(rid, pos);
    const first = Math.floor(pos / this.blockSize) * this.blockSize;
    for (let k = 0; k <= this.readAhead; k++) this.requestBlock(first + k * this.blockSize);
    this.answerReads();
  }

  onBlock(pos, data) {
    if (!this.blocks) this.initBlocks();
    this.inflight.delete(pos);
    this.blocks.set(pos, data);
    this.blockBytes += data.byteLength;
    // Keep about 64 MB (more with several readers); drop the blocks furthest from every reader.
    const limit = Math.max(64e6, this.readerPos.size * (this.readAhead + 2) * this.blockSize);
    const readers = [...this.readerPos.values()];
    const dist = (k) => Math.min(...readers.map((r) => Math.abs(k - r)));
    while (this.blockBytes > limit && this.blocks.size > this.readAhead + 2) {
      let far = null;
      let farD = -1;
      for (const k of this.blocks.keys()) { const d = dist(k); if (d > farD) { far = k; farD = d; } }
      this.blockBytes -= this.blocks.get(far).byteLength;
      this.blocks.delete(far);
    }
    this.answerReads();
  }

  answerReads() {
    for (const [rid, w] of this.wantReads) {
      const bpos = Math.floor(w.pos / this.blockSize) * this.blockSize;
      const b = this.blocks.get(bpos);
      if (!b) continue;
      this.wantReads.delete(rid);
      // Send from the block containing pos; the worker copies, so slice a fresh buffer.
      const data = b.slice(w.pos - bpos);
      this.worker.postMessage({ type: 'block', pos: w.pos, data, rid }, [data.buffer]);
      // Keep the pipeline full.
      for (let k = 1; k <= this.readAhead; k++) this.requestBlock(bpos + k * this.blockSize);
    }
  }
  // ---- end of the proposed engine.js code ------------------------------------
}

/** One playthrough: open, decode to eof, optional seeks. Resolves with what was seen. */
function run(file, usePool) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const w = usePool
      ? new globalThis.DecoderPool('decoder-worker.js', { multiRead: true, workers: opt.workers, budget: opt.budget * 1e6 })
      : new globalThis.Worker('decoder-worker.js');
    let eb = null;
    if (opt.engineCache) {
      eb = new EngineBlocks(w, (pos, len) => setImmediate(() => {
        if (closed) return;
        const n = Math.max(0, Math.min(len, size - pos));
        const buf = Buffer.alloc(n);
        if (n) fs.readSync(fd, buf, 0, n, pos);
        eb.onBlock(pos, new Uint8Array(buf.buffer, buf.byteOffset, n));
      }));
      eb.size = size;
    }
    let gen = 0;
    let phase = 'play';
    const res = { frames: [], arrive: [], audio: 0, seeks: {}, t0: 0, ms: 0, logs: [] };
    let cur = res.frames;
    let info = null;
    const timer = setTimeout(() => done(new Error('timeout')), 900e3);
    let closed = false;
    const done = (err) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      fs.closeSync(fd);
      w.terminate();
      if (usePool) res.stats = { ...w.stats, frameBytes: Math.round(w.frameBytes), mode: w.mode };
      if (err) reject(err); else resolve(res);
    };
    const more = () => w.postMessage({ type: 'more', gen, limit: 96 * 1024 });
    const seek = (t, fast) => { gen++; cur = []; w.postMessage({ type: 'seek', gen, t, fast }); };
    w.onerror = (e) => done(new Error(`worker error ${e && e.message}`));
    w.onmessage = (e) => {
      const m = e.data;
      if (closed) return;
      switch (m.type) {
        case 'ready': w.postMessage({ type: 'open', size }); break;
        case 'read':
          if (eb) { eb.onWorkerRead(m.pos, m.len, m.rid); break; }
          setImmediate(() => {
            if (closed) return;
            const n = Math.max(0, Math.min(m.len, size - m.pos));
            const buf = Buffer.alloc(n);
            if (n) fs.readSync(fd, buf, 0, n, m.pos);
            w.postMessage({ type: 'block', pos: m.pos, data: new Uint8Array(buf.buffer, buf.byteOffset, n), rid: m.rid });
          });
          break;
        case 'streams': {
          info = m.info;
          res.info = info && info.video ? `${info.video.codec} ${info.video.width}x${info.video.height}` : 'no video';
          const hw = !opt.softAll && info.video && /^(h264|vp8)$/.test(info.video.codec);
          w.postMessage({ type: 'config', video: info.video ? (hw ? 'webcodecs' : 'soft') : 'none', audio: info.audio ? 'soft' : 'none', deep: true });
          break;
        }
        case 'configured':
          res.vmode = m.video;
          res.t0 = performance.now();
          more();
          break;
        case 'batch': {
          if (m.gen !== gen) break;
          for (const v of m.video) cur.push(v.kind === 'yuv' ? [v.t, hashFrame(v)] : [v.t, 'pkt']);
          if (phase === 'play') for (let i = 0; i < m.video.length; i++) res.arrive.push(performance.now());
          if (phase === 'play') res.audio += m.audio.length;
          res.batches = (res.batches || 0) + 1;
          if (usePool && opt.fault && res.batches === opt.fault && w.extras.length) w.extraFailed(w.extras[1].rid, 'injected fault');
          if (!m.eof) { more(); break; }
          if (phase === 'play') {
            res.ms = performance.now() - res.t0;
            const dur = (info && info.duration) || 0;
            if (!opt.seek || dur < 1) { done(); break; }
            phase = 'accurate';
            seek(dur * 0.53, false);
          } else if (phase === 'accurate') {
            res.seeks.accurate = cur;
            phase = 'fast';
            seek(info.duration * 0.31, true);
          } else {
            res.seeks.fast = cur;
            done();
          }
          break;
        }
        case 'seeked': if (m.gen === gen) more(); break;
        case 'log': if (/parallel video/.test(m.msg)) res.switchMs = performance.now() - res.t0; res.logs.push(m.msg); if (process.env.POOL_LOG) console.log(`  ${m.msg}`); break;
        case 'error':
          res.logs.push(`ERROR ${m.where}: ${m.message}`);
          if (process.env.POOL_LOG) console.log(`  ERROR ${m.where}: ${m.message}`);
          if (m.where === 'open' || m.where === 'init') done(new Error(m.message));
          break;
        default: break;
      }
    };
    w.postMessage(initMsg);
  });
}

function compare(a, b) {
  for (let i = 1; i < b.length; i++) if (b[i][1] !== 'pkt' && b[i][0] !== null && b[i - 1][0] !== null && !(b[i][0] > b[i - 1][0])) return `pool not increasing at ${i}`;
  if (a.length !== b.length) {
    const sa = new Set(a.map((x) => x[0]));
    const sb = new Set(b.map((x) => x[0]));
    const miss = a.filter((x) => !sb.has(x[0])).slice(0, 3).map((x) => x[0]);
    const extra = b.filter((x) => !sa.has(x[0])).slice(0, 3).map((x) => x[0]);
    return `count ${a.length} vs ${b.length} missing [${miss}] extra [${extra}]`;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0]) return `t[${i}] ${a[i][0]} vs ${b[i][0]}`;
    if (a[i][1] !== b[i][1]) return `pixels differ at t=${a[i][0]}`;
  }
  return 'ok';
}

(async () => {
  const out = [];
  console.log(`cores ${os.cpus().length}, workers ${opt.workers === undefined ? 'auto' : opt.workers}, budget ${opt.budget} MB`);
  for (const file of files) {
    const r = { file: path.basename(file) };
    try {
      let s = null;
      let p = null;
      const fps = (x) => +(x.frames.length / (x.ms / 1000)).toFixed(1);
      // Second half of the frames: decode rate once the pool runs (no start-up).
      const half = (x) => { const a = x.arrive; const i = a.length >> 1; return a.length > 8 ? +((a.length - 1 - i) / ((a[a.length - 1] - a[i]) / 1000)).toFixed(1) : 0; };
      if (opt.mode !== 'pool') {
        peakRss = process.memoryUsage().rss;
        s = await run(file, false);
        r.single = { fps: fps(s), half: half(s), frames: s.frames.length, rssMB: Math.round(peakRss / 1e6) };
      }
      if (opt.mode !== 'single') {
        peakRss = process.memoryUsage().rss;
        p = await run(file, true);
        r.pool = { fps: fps(p), half: half(p), switchMs: Math.round(p.switchMs || 0), frames: p.frames.length, rssMB: Math.round(peakRss / 1e6), stats: p.stats };
      }
      r.info = (s || p).info;
      r.vmode = (s || p).vmode;
      if (s && p) {
        r.check = compare(s.frames, p.frames);
        if (opt.seek) {
          r.seekAccurate = compare(s.seeks.accurate || [], p.seeks.accurate || []);
          r.seekFast = compare(s.seeks.fast || [], p.seeks.fast || []);
        }
        r.audio = s.audio === p.audio ? s.audio : `${s.audio} vs ${p.audio}`;
        r.speedup = +(r.pool.fps / r.single.fps).toFixed(2);
      }
      if (p) r.poolLogs = p.logs.filter((l) => /pool:|ERROR/.test(l)).slice(0, 8);
    } catch (e) {
      r.error = String(e && e.stack || e);
    }
    out.push(r);
    const st = r.pool && r.pool.stats;
    console.log([
      r.file.padEnd(24), (r.info || '').padEnd(20),
      r.single ? `single ${String(r.single.fps).padStart(6)} fps (2nd half ${String(r.single.half).padStart(6)}) ${String(r.single.rssMB).padStart(5)} MB` : '',
      r.pool ? `pool ${String(r.pool.fps).padStart(6)} fps (2nd half ${String(r.pool.half).padStart(6)}, pool from ${r.pool.switchMs} ms) ${String(r.pool.rssMB).padStart(5)} MB` : '',
      r.speedup ? `x${r.speedup}` : '',
      r.check ? `frames ${r.check}` : '',
      r.seekAccurate ? `seek ${r.seekAccurate} / fast ${r.seekFast}` : '',
      r.audio ? `audio ${r.audio}` : '',
      st ? `${st.mode} segs ${st.segments} dup ${st.dupes} peak ${Math.round(st.peakBytes / 1e6)}MB` : '',
      r.error ? `ERROR ${r.error.split('\n').slice(0, 2).join(' ')}` : '',
    ].filter(Boolean).join('  '));
  }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(out, null, 1));
  process.exit(0);
})();
