#!/usr/bin/env node
// wasm decode benchmark across libav.js vpe builds (same flow as test/bench/run_bench.js
// wasm route: block reader -> ff_read_frame_multi 512 KB -> ff_decode_multi -> format=yuv420p).
//   node wbench.js --dirs=name=dir,name=dir [--media=dir] [--only=regex] [--frames=120] [--repeat=1] [--out=file.json]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const opt = { media: path.join(__dirname, '..', 'bench', 'media'), only: '', frames: 120, repeat: 1, out: '' };
for (const a of process.argv.slice(2)) { const m = /^--(\w+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }

if (opt.child) child(opt.child, opt.file, +opt.frames).catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); });
else main();

function main() {
  const dirs = opt.dirs.split(',').map((s) => s.split('=')).map(([n, d]) => [n, path.resolve(d)]);
  const files = fs.readdirSync(opt.media).filter((f) => (!opt.only || new RegExp(opt.only).test(f)) && (!opt.list || opt.list.split(',').some((p) => f.startsWith(p)))).sort();
  const res = {};
  for (const f of files) {
    res[f] = {};
    for (const [name, dir] of dirs) {
      let best = null;
      for (let i = 0; i < +opt.repeat; i++) {
        const c = spawnSync(process.execPath, [__filename, `--child=${dir}`, `--file=${path.join(opt.media, f)}`, `--frames=${opt.frames}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
        let r;
        try { r = JSON.parse((c.stdout || '').trim().split(/\r?\n/).pop()); } catch { r = { ok: false, fps: 0, error: (c.stderr || '').slice(0, 200) }; }
        if (!best || (r.fps || 0) > (best.fps || 0)) best = r;
      }
      res[f][name] = best;
    }
    const line = dirs.map(([n]) => { const r = res[f][n]; return `${n} ${r.ok ? '' : 'FAIL '}${r.fps} (dec ${r.decodeOnlyFps})`; }).join(' | ');
    console.log(f.padEnd(22), line);
    if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(res, null, 1));
  }
}

async function child(dir, file, maxFrames) {
  const log = [];
  console.error = (...a) => log.push(a.join(' '));
  console.warn = console.error;
  global.LibAV = { base: dir };
  require(path.join(dir, 'libav-vpe.js'));
  const libav = await LibAV.LibAV({ noworker: true, nothreads: true, base: dir, variant: 'vpe' });
  await libav.av_log_set_level(16);
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const BLOCK = 1 << 20;
  libav.onblockread = (name, pos, len) => setImmediate(() => {
    const n = Math.max(0, Math.min(Math.max(len, BLOCK), size - pos));
    const buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, pos);
    libav.ff_block_reader_dev_send(name, pos, n ? new Uint8Array(buf.buffer, buf.byteOffset, n) : null);
  });
  await libav.mkblockreaderdev('in0', size);
  const [fmt, streams] = await libav.ff_init_demuxer_file('in0');
  const vs = streams.find((s) => s.codec_type === 0);
  const tb = [vs.time_base_num, vs.time_base_den];
  const [, c, pkt, frame] = await libav.ff_init_decoder(vs.codec_id, { codecpar: vs.codecpar, time_base: tb });
  const rpkt = await libav.av_packet_alloc();
  let filter = null, frames = 0, decMs = 0, convMs = 0, srcFmt = null;
  let sum = 0; // cheap checksum of the first plane bytes of every 10th frame, to compare builds
  const toYuv = async (frs) => {
    const o = [];
    for (const f of frs) {
      if (f.format === 0 || f.format === 12) { o.push(f); continue; }
      if (!filter) {
        const [graph, src, sink] = await libav.ff_init_filter_graph('format=yuv420p',
          { type: 0, width: f.width, height: f.height, pix_fmt: f.format, time_base: tb }, { type: 0, pix_fmt: 0, time_base: tb });
        filter = { graph, src, sink, frame: await libav.av_frame_alloc() };
      }
      o.push(...await libav.ff_filter_multi(filter.src, filter.sink, filter.frame, [f], { copyoutFrame: 'video' }));
    }
    return o;
  };
  const t0 = performance.now();
  for (;;) {
    const [res, packets] = await libav.ff_read_frame_multi(fmt, rpkt, { limit: 512 * 1024 });
    const atEnd = res === libav.AVERROR_EOF;
    const vp = packets[vs.index] || [];
    if (vp.length || atEnd) {
      const t = performance.now();
      let fr = await libav.ff_decode_multi(c, pkt, frame, vp, { fin: atEnd, ignoreErrors: true, copyoutFrame: 'video' });
      const t2 = performance.now();
      if (fr.length && srcFmt === null) srcFmt = fr[0].format;
      fr = await toYuv(fr);
      convMs += performance.now() - t2;
      decMs += t2 - t;
      for (const f of fr) {
        if (frames % 10 === 0 && f.data && f.layout) {
          // visible pixels only (linesize padding depends on alignment), all three planes
          const d = f.data;
          f.layout.slice(0, 3).forEach((L, p) => {
            const w = p ? f.width >> 1 : f.width, h = p ? f.height >> 1 : f.height;
            for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x += 13) sum = (sum * 31 + d[L.offset + y * L.stride + x]) >>> 0;
          });
        }
        frames++;
      }
    }
    if (atEnd || (res !== 0 && res !== -libav.EAGAIN)) break;
    if (frames >= maxFrames) break;
  }
  const wall = (performance.now() - t0) / 1000;
  fs.closeSync(fd);
  console.log(JSON.stringify({ ok: frames > 0, frames, wall: +wall.toFixed(2), fps: +(frames / wall).toFixed(1),
    decodeOnlyFps: +(frames / (decMs / 1000)).toFixed(1), convMs: Math.round(convMs), srcFmt, filtered: !!filter, sum,
    logs: [...new Set(log)].slice(0, 2) }));
  process.exit(0);
}
