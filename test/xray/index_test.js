#!/usr/bin/env node
// Runs media/xray-worker.js (the Codec X-ray packet index) under worker_threads
// and checks it against ffprobe.
//
//   node test/xray/index_test.js [--order=seq|shuffle|both] [--segs=N] [--no-probe]
//        [--frames] [--json=out.json] <file|dir>...
//
// Per file: packets, time, packets/s and MB/s for the index, pts/dts monotonicity,
// --order=both: the shuffled (seeking) pass yields exactly the sequential packets.
// ffprobe (on PATH): packet count, sizes, pts and key flags; --frames also decodes
// with ffprobe and compares the parsed picture types with pict_type.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Worker } = require('worker_threads');

const root = path.resolve(__dirname, '..', '..');
const media = path.join(root, 'media');
const opt = { order: 'seq', segs: 0, probe: true, frames: false, json: null };
const inputs = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) inputs.push(a);
  else if (m[1] === 'order') opt.order = m[2];
  else if (m[1] === 'segs') opt.segs = +m[2];
  else if (m[1] === 'no-probe') opt.probe = false;
  else if (m[1] === 'frames') opt.frames = true;
  else if (m[1] === 'json') opt.json = m[2];
  else if (m[1] === 'check') opt.check = true; // layer 2: exit 1 on any difference from ffprobe or between read orders
}
const files = [];
for (const i of inputs) {
  if (fs.statSync(i).isDirectory()) {
    for (const f of fs.readdirSync(i).sort()) if (!/\.(json|txt|md)$/i.test(f)) files.push(path.join(i, f));
  } else files.push(i);
}

const libdir = path.join(media, 'libav-vpe');
const initMsg = {
  type: 'init', loader: path.join(libdir, 'libav-6.11.9.0.2-vpe.js'), toImport: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.js'),
  wasmurl: path.join(libdir, 'libav-6.11.9.0.2-vpe.wasm.wasm'), variant: 'vpe',
};
const TYPES = '?IPB';

/** Index one file; order 'seq' or 'shuffle' (segments in random order: every segment but the first seeks). */
function index(file, order) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const w = new Worker(path.join(root, 'test', 'pool', 'worker-shim.js'), { workerData: { script: process.env.XRAY_WORKER || path.join(media, 'xray-worker.js') } });
    const res = { packets: [], segs: 0, bytesRead: 0, ms: 0, chapters: [] };
    let t0 = 0;
    let queue = [];
    let closed = false;
    const seen = new Set();
    const timer = setTimeout(() => done(new Error('timeout')), 600e3);
    const done = (err) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      fs.closeSync(fd);
      w.terminate();
      res.ms = performance.now() - t0;
      if (err) reject(err); else resolve(res);
    };
    const next = () => {
      const s = queue.shift();
      if (!s) { done(); return; }
      w.postMessage({ type: 'seg', id: s.id, t0: s.t0, t1: s.t1 });
    };
    w.on('error', (e) => done(e));
    w.on('message', (m) => {
      if (closed) return;
      switch (m.type) {
        case 'ready': t0 = performance.now(); w.postMessage({ type: 'open', size }); break;
        case 'read': {
          const n = Math.max(0, Math.min(m.len, size - m.pos));
          const buf = Buffer.alloc(n);
          if (n) fs.readSync(fd, buf, 0, n, m.pos);
          res.bytesRead += n;
          w.postMessage({ type: 'block', pos: m.pos, data: new Uint8Array(buf.buffer, buf.byteOffset, n) });
          break;
        }
        case 'opened': {
          if (!m.video) { res.noVideo = true; done(); return; }
          Object.assign(res, { codec: m.codec, stream: m.stream, duration: m.duration, chapters: m.chapters, first: m.first });
          const n = opt.segs || Math.max(1, Math.min(64, Math.ceil(m.duration / 2)));
          const len = m.duration > 0 ? m.duration / n : 0;
          for (let k = 0; k < n; k++) queue.push({ id: k, t0: k ? m.first + k * len : m.first, t1: k < n - 1 && len ? m.first + (k + 1) * len : null });
          if (!len) queue = queue.slice(0, 1);
          if (order === 'shuffle') {
            // Deterministic shuffle (keep segment 0 first: it continues from open()).
            const rest = queue.slice(1);
            for (let i = rest.length - 1; i > 0; i--) { const j = (i * 7919 + 13) % (i + 1); [rest[i], rest[j]] = [rest[j], rest[i]]; }
            queue = [queue[0], ...rest];
          }
          next();
          break;
        }
        case 'pk':
          // Like xray.js: one packet per pts and size (MPEG-PS guesses dts differently after a seek,
          // so a packet near a segment boundary can come from both segments).
          for (let i = 0; i < m.pts.length; i++) {
            const k = `${key(m.pts[i])}:${m.size[i]}`;
            if (isFinite(m.pts[i]) && seen.has(k)) continue;
            seen.add(k);
            res.packets.push({ seg: m.id, pts: m.pts[i], dts: m.dts[i], dur: m.dur[i], size: m.size[i], key: m.key[i], type: m.pict[i] });
          }
          break;
        case 'segdone': res.segs++; next(); break;
        case 'log': if (process.env.XRAY_LOG) console.log(`  ${m.msg}`); break;
        case 'error': done(new Error(`${m.where}: ${m.message}`)); break;
        default: break;
      }
    });
    w.postMessage(initMsg);
  });
}

const key = (t) => Math.round(t * 1000);

function probePackets(file, stream) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', String(stream), '-show_entries', 'packet=pts_time,dts_time,size,flags', '-of', 'csv=p=0', file], { maxBuffer: 1 << 28 }).toString();
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [pts, dts, size, flags] = l.split(',');
    const p = parseFloat(pts);
    return { pts: isFinite(p) ? p : parseFloat(dts), dts: parseFloat(dts), size: +size, key: flags.includes('K') ? 1 : 0 };
  });
}

function probeFrames(file, stream) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-threads', '2', '-select_streams', String(stream), '-show_entries', 'frame=pts_time,best_effort_timestamp_time,pict_type', '-of', 'csv=p=0', file], { maxBuffer: 1 << 28 }).toString();
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [pts, be, pt] = l.split(',');
    const p = parseFloat(pts);
    return { pts: isFinite(p) ? p : parseFloat(be), type: pt };
  });
}

(async () => {
  const out = [];
  for (const file of files) {
    const r = { file: path.basename(file) };
    try {
      const a = await index(file, opt.order === 'shuffle' ? 'shuffle' : 'seq');
      if (a.noVideo) { r.note = 'no video'; out.push(r); console.log(`${r.file.padEnd(28)} no video`); continue; }
      r.codec = a.codec;
      r.packets = a.packets.length;
      r.ms = Math.round(a.ms);
      r.pps = Math.round(a.packets.length / (a.ms / 1000));
      r.mbps = +(a.bytesRead / 1e6 / (a.ms / 1000)).toFixed(0);
      r.chapters = a.chapters.length;
      let bad = 0;
      for (let i = 1; i < a.packets.length; i++) if (isFinite(a.packets[i].dts) && isFinite(a.packets[i - 1].dts) && !(a.packets[i].dts > a.packets[i - 1].dts)) bad++;
      r.dtsNonMono = bad;
      const sorted = a.packets.map((p) => p.pts).filter(isFinite).sort((x, y) => x - y);
      let dup = 0;
      for (let i = 1; i < sorted.length; i++) if (key(sorted[i]) === key(sorted[i - 1])) dup++;
      r.ptsDup = dup;
      r.types = {};
      for (const p of a.packets) r.types[TYPES[p.type]] = (r.types[TYPES[p.type]] || 0) + 1;
      if (opt.order === 'both') {
        const b = await index(file, 'shuffle');
        const sig = (x) => x.packets.map((p) => `${key(p.pts)}:${p.size}:${p.type}`).sort().join(',');
        r.shuffle = sig(a) === sig(b) ? 'same' : `DIFFERENT ${a.packets.length} vs ${b.packets.length}`;
        if (r.shuffle !== 'same' && process.env.XRAY_DIFF) {
          const ca = new Map();
          for (const p of a.packets) ca.set(key(p.pts), (ca.get(key(p.pts)) || 0) + 1);
          for (const p of b.packets) { const c = ca.get(key(p.pts)) || 0; if (c) ca.set(key(p.pts), c - 1); else console.log('  extra in shuffle', JSON.stringify(p), 'seq:', JSON.stringify(a.packets.filter((q) => key(q.pts) === key(p.pts))), 'shuffle:', JSON.stringify(b.packets.filter((q) => key(q.pts) === key(p.pts)).map((q) => q.seg))); }
        }
        r.shuffleMs = Math.round(b.ms);
      }
      if (opt.probe) {
        const fp = probePackets(file, a.stream);
        const mine = new Map(a.packets.map((p) => [key(p.pts), p]));
        let size = 0;
        let keyd = 0;
        let miss = 0;
        for (const q of fp) {
          const p = mine.get(key(q.pts));
          if (!p) { miss++; continue; }
          if (p.size !== q.size) size++;
          if (p.key !== q.key) keyd++;
        }
        r.ffprobe = `${fp.length} pkts, missing ${miss}, size diff ${size}, key diff ${keyd}`;
        r.diff = miss + size + keyd;
        if (opt.frames) {
          const ff = probeFrames(file, a.stream);
          let ok = 0;
          let n = 0;
          const conf = {};
          for (const q of ff) {
            const p = mine.get(key(q.pts));
            if (!p) continue;
            n++;
            const t = TYPES[p.type];
            if (t === q.type) ok++; else conf[`${t}->${q.type}`] = (conf[`${t}->${q.type}`] || 0) + 1;
          }
          r.pict = `${ok}/${n} (${n ? ((ok / n) * 100).toFixed(1) : '-'}%) of ${ff.length} frames${Object.keys(conf).length ? ` ${JSON.stringify(conf)}` : ''}`;
        }
      }
    } catch (e) {
      r.error = String(e && e.stack || e).split('\n').slice(0, 3).join(' ');
    }
    out.push(r);
    console.log([
      r.file.padEnd(28), (r.codec || '').padEnd(10),
      r.packets !== undefined ? `${String(r.packets).padStart(6)} pkts ${String(r.ms).padStart(6)} ms ${String(r.pps).padStart(7)} pkt/s ${String(r.mbps).padStart(5)} MB/s` : '',
      r.types ? JSON.stringify(r.types) : '', r.dtsNonMono ? `dts non-monotonic ${r.dtsNonMono}` : '', r.ptsDup ? `pts dup ${r.ptsDup}` : '',
      r.chapters ? `chapters ${r.chapters}` : '', r.shuffle ? `shuffle ${r.shuffle} (${r.shuffleMs} ms)` : '',
      r.ffprobe ? `| ffprobe ${r.ffprobe}` : '', r.pict ? `| pict ${r.pict}` : '', r.error ? `ERROR ${r.error}` : '',
    ].filter(Boolean).join('  '));
  }
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(out, null, 1));
  if (opt.check) {
    const bad = out.filter((r) => r.error || r.diff || r.dtsNonMono || (r.shuffle && r.shuffle !== 'same') || !r.packets);
    for (const r of bad) console.log(`FAIL ${r.file}: ${r.error || [r.diff ? `ffprobe ${r.ffprobe}` : '', r.dtsNonMono ? `dts non-monotonic ${r.dtsNonMono}` : '', r.shuffle && r.shuffle !== 'same' ? `shuffle ${r.shuffle}` : '', !r.packets ? 'no packets' : ''].filter(Boolean).join(', ')}`);
    console.log(`${out.length - bad.length} passed, ${bad.length} failed`);
    process.exit(bad.length ? 1 : 0);
  }
  process.exit(0);
})();
