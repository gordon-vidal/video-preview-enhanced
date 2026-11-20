#!/usr/bin/env node
// Node smoke/speed test for the libav.js "vpe" variant, mirroring the player's
// decoder-worker.js flow: block reader device -> ff_init_demuxer_file ->
// ff_read_frame_multi (512 KB batches) -> ff_decode_multi (video + audio) ->
// format=yuv420p filter graph for non-420 video -> seek to the middle and decode again.
//
// Usage: node vpe-test.js <libav dir> [--max=<seconds>] [--json=<out>] <file|dir>...
//   --max limits decoding to the first N seconds of video (default: whole file;
//   files over 60 MB default to 3 s).
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const libdir = path.resolve(args.shift());
let maxSec = 0, jsonOut = null;
const inputs = [];
for (const a of args) {
  if (a.startsWith('--max=')) maxSec = +a.slice(6);
  else if (a.startsWith('--json=')) jsonOut = a.slice(7);
  else inputs.push(a);
}
const names = JSON.parse(fs.readFileSync(path.join(__dirname, 'fmtnames.json'), 'utf8'));
const pixName = (n) => names.pix[n] || String(n);
const smpName = (n) => names.smp[n] || String(n);

const files = [];
for (const i of inputs) {
  if (fs.statSync(i).isDirectory()) {
    for (const f of fs.readdirSync(i).sort()) {
      if (/\.(json|txt|out)$/i.test(f)) continue;
      const p = path.join(i, f);
      if (fs.statSync(p).isFile()) files.push(p);
    }
  } else files.push(i);
}

const AVMEDIA_TYPE_VIDEO = 0, AVMEDIA_TYPE_AUDIO = 1;
const YUV420 = 0, YUVJ420 = 12;
const BLOCK = 1 << 20;

// Capture libav's stderr logging so it can be counted per file.
let logLines = [];
const origErr = console.error, origWarn = console.warn;
console.error = (...a) => logLines.push(a.join(' '));
console.warn = (...a) => logLines.push(a.join(' '));

async function main() {
  global.LibAV = { base: libdir };
  require(path.join(libdir, 'libav-vpe.js'));
  const t0 = Date.now();
  const libav = await LibAV.LibAV({ noworker: true, nothreads: true, base: libdir, variant: 'vpe' });
  process.stdout.write(`libav ready: mode=${libav.libavjsMode} in ${Date.now() - t0} ms\n`);
  await libav.av_log_set_level(16); // AV_LOG_ERROR

  const results = [];
  let devN = 0;
  for (const file of files) {
    const size = fs.statSync(file).size;
    const limit = maxSec || (size > 60e6 ? 3 : 0);
    const r = { file: path.basename(file), sizeMB: +(size / 1e6).toFixed(1), limit, video: null, audio: null, seek: null, errors: [] };
    logLines = [];
    const fd = fs.openSync(file, 'r');
    const dev = `in${devN++}`;
    libav.onblockread = (name, pos, len) => {
      // Deliver asynchronously, like the worker's message round trip.
      setImmediate(() => {
        const n = Math.max(0, Math.min(Math.max(len, BLOCK), size - pos));
        const buf = Buffer.alloc(n);
        if (n) fs.readSync(fd, buf, 0, n, pos);
        libav.ff_block_reader_dev_send(name, pos, n ? new Uint8Array(buf.buffer, buf.byteOffset, n) : null);
      });
    };
    let fmt = 0, pkt = 0;
    const V = { idx: -1, c: 0, pkt: 0, frame: 0, tb: [1, 1], filter: null, frames: 0, fmts: new Set(), ms: 0, last: 0, w: 0, h: 0, codec: '' };
    const A = { idx: -1, c: 0, pkt: 0, frame: 0, tb: [1, 1], frames: 0, samples: 0, fmts: new Set(), ms: 0, rate: 0, ch: 0, codec: '' };
    try {
      await libav.mkblockreaderdev(dev, size);
      const tOpen = Date.now();
      let streams;
      [fmt, streams] = await libav.ff_init_demuxer_file(dev);
      r.openMs = Date.now() - tOpen;
      pkt = await libav.av_packet_alloc();
      const fmtDur = await libav.AVFormatContext_duration(fmt);
      r.duration = fmtDur > 0 && fmtDur < 1e15 ? +(fmtDur / 1e6).toFixed(2) : 0;
      for (const s of streams) {
        const cp = await libav.ff_copyout_codecpar(s.codecpar);
        const name = await libav.avcodec_get_name(s.codec_id);
        const coverArt = /^(png|bmp|gif)$/.test(name) || (name === 'mjpeg' && s.duration_time_base <= 1);
        if (s.codec_type === AVMEDIA_TYPE_VIDEO && V.idx < 0 && cp.width > 0 && !(coverArt && streams.length > 1)) {
          Object.assign(V, { idx: s.index, tb: [s.time_base_num, s.time_base_den], codec: name, w: cp.width, h: cp.height, s });
        } else if (s.codec_type === AVMEDIA_TYPE_AUDIO && A.idx < 0) {
          Object.assign(A, { idx: s.index, tb: [s.time_base_num, s.time_base_den], codec: name, rate: cp.sample_rate, ch: cp.ch_layout_nb_channels || cp.channels, s });
        }
      }
      for (const S of [V, A]) {
        if (S.idx < 0) continue;
        try {
          [, S.c, S.pkt, S.frame] = await libav.ff_init_decoder(S.s.codec_id, { codecpar: S.s.codecpar, time_base: S.tb });
        } catch (e) {
          S.initError = String(e && e.message || e);
          S.c = 0;
        }
      }
      const frameT = (f, tb) => {
        const noPts = f.pts === undefined || (f.pts === libav.AV_NOPTS_VALUE_LO && f.ptshi === libav.AV_NOPTS_VALUE_HI);
        return noPts ? null : libav.i64tof64(f.pts, f.ptshi) * tb[0] / tb[1];
      };
      const toYuv = async (frames) => {
        const out = [];
        for (const f of frames) {
          if (f.format === YUV420 || f.format === YUVJ420) { out.push(f); continue; }
          if (!V.filter || V.filter.w !== f.width || V.filter.h !== f.height || V.filter.fmt !== f.format) {
            if (V.filter) await libav.avfilter_graph_free_js(V.filter.graph);
            const [graph, src, sink] = await libav.ff_init_filter_graph('format=yuv420p',
              { type: AVMEDIA_TYPE_VIDEO, width: f.width, height: f.height, pix_fmt: f.format, time_base: V.tb },
              { type: AVMEDIA_TYPE_VIDEO, pix_fmt: YUV420, time_base: V.tb });
            V.filter = { graph, src, sink, w: f.width, h: f.height, fmt: f.format, frame: await libav.av_frame_alloc() };
          }
          out.push(...await libav.ff_filter_multi(V.filter.src, V.filter.sink, V.filter.frame, [f], { copyoutFrame: 'video' }));
        }
        return out;
      };
      const decodeBatch = async (packets, atEnd, stats) => {
        const vp = V.idx >= 0 ? packets[V.idx] || [] : [];
        const ap = A.idx >= 0 ? packets[A.idx] || [] : [];
        if (V.c && (vp.length || atEnd)) {
          const t = performance.now();
          let fr = await libav.ff_decode_multi(V.c, V.pkt, V.frame, vp, { fin: atEnd, ignoreErrors: true, copyoutFrame: 'video' });
          for (const f of fr) V.fmts.add(pixName(f.format));
          fr = await toYuv(fr);
          stats.vms += performance.now() - t;
          stats.vframes += fr.length;
          for (const f of fr) {
            if (f.format !== YUV420 && f.format !== YUVJ420) stats.badConv++;
            const ft = frameT(f, V.tb);
            if (ft !== null) { stats.vlast = Math.max(stats.vlast, ft); if (stats.vfirst === undefined) stats.vfirst = ft; }
          }
        }
        if (A.c && (ap.length || atEnd)) {
          const t = performance.now();
          const fr = await libav.ff_decode_multi(A.c, A.pkt, A.frame, ap, { fin: atEnd, ignoreErrors: true });
          stats.ams += performance.now() - t;
          stats.aframes += fr.length;
          for (const f of fr) { stats.asamples += f.nb_samples; A.fmts.add(smpName(f.format)); }
        }
      };
      // Full (or limited) linear decode
      const st = { vframes: 0, vms: 0, vlast: 0, aframes: 0, asamples: 0, ams: 0, badConv: 0 };
      const tAll = performance.now();
      let firstT = null;
      for (;;) {
        const [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 512 * 1024 });
        const atEnd = res === libav.AVERROR_EOF;
        if (res !== 0 && !atEnd && res !== -libav.EAGAIN) { r.errors.push(`read ${res}`); }
        await decodeBatch(packets, atEnd, st);
        if (firstT === null && st.vframes) firstT = st.vlast;
        if (atEnd || (res !== 0 && res !== -libav.EAGAIN)) break;
        if (limit && st.vframes && st.vlast - (firstT || 0) >= limit) break;
        if (limit && V.idx < 0 && st.asamples / (A.rate || 48000) >= limit) break;
      }
      const wall = performance.now() - tAll;
      if (V.idx >= 0) r.video = {
        codec: V.codec, size: `${V.w}x${V.h}`, ok: !!V.c && st.vframes > 0, frames: st.vframes,
        pix_fmt: [...V.fmts].join('/'), filtered: !!V.filter, badConv: st.badConv,
        fps: st.vms ? +(st.vframes / (st.vms / 1000)).toFixed(1) : 0, initError: V.initError,
      };
      if (A.idx >= 0) r.audio = {
        codec: A.codec, rate: A.rate, ch: A.ch, ok: !!A.c && st.asamples > 0, frames: st.aframes, samples: st.asamples,
        sample_fmt: [...A.fmts].join('/'), xRealtime: st.ams ? +((st.asamples / A.rate) / (st.ams / 1000)).toFixed(0) : 0, initError: A.initError,
      };
      r.wallMs = Math.round(wall);
      // Seek check: middle of the file, flush, decode one batch
      const dur = r.duration || st.vlast;
      if (dur > 1 && !limit) {
        const ts = Math.round(dur / 2 * 1e6);
        const [lo, hi] = libav.f64toi64(ts);
        const sr = await libav.avformat_seek_file_max(fmt, -1, lo, hi, 0);
        if (V.c) await libav.avcodec_flush_buffers(V.c);
        if (A.c) await libav.avcodec_flush_buffers(A.c);
        const s2 = { vframes: 0, vms: 0, vlast: 0, aframes: 0, asamples: 0, ams: 0, badConv: 0 };
        for (let i = 0; i < 8 && !(s2.vframes || (V.idx < 0 && s2.asamples)); i++) {
          const [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 512 * 1024 });
          await decodeBatch(packets, res === libav.AVERROR_EOF, s2);
          if (res !== 0 && res !== -libav.EAGAIN) break;
        }
        r.seek = { ret: sr, ok: sr >= 0 && (s2.vframes > 0 || (V.idx < 0 && s2.asamples > 0)), at: s2.vfirst !== undefined ? +s2.vfirst.toFixed(2) : null, target: +(dur / 2).toFixed(2) };
      }
    } catch (e) {
      r.errors.push(`EXC ${e && e.message || e}`);
    }
    try {
      if (V.filter) await libav.avfilter_graph_free_js(V.filter.graph);
      if (V.c) await libav.ff_free_decoder(V.c, V.pkt, V.frame);
      if (A.c) await libav.ff_free_decoder(A.c, A.pkt, A.frame);
      if (fmt && libav.avformat_close_input_js) await libav.avformat_close_input_js(fmt);
      await libav.unlink(dev);
    } catch (e) { r.errors.push(`free ${e && e.message || e}`); }
    fs.closeSync(fd);
    r.logCount = logLines.length;
    r.logSample = [...new Set(logLines.map((l) => l.trim()))].slice(0, 3);
    results.push(r);
    const v = r.video, a = r.audio;
    process.stdout.write([
      r.file.padEnd(26),
      v ? `V ${v.ok ? 'ok ' : 'BAD'} ${v.codec}/${v.size} ${v.frames}f ${v.pix_fmt}${v.filtered ? '->yuv420p' : ''} ${v.fps}fps` : 'V -',
      a ? `| A ${a.ok ? 'ok ' : 'BAD'} ${a.codec} ${a.samples}smp ${a.sample_fmt} ${a.xRealtime}x` : '| A -',
      r.seek ? `| seek ${r.seek.ok ? "ok" : "BAD"}@${r.seek.at}(${r.seek.target})` : '',
      r.errors.length ? `| ERR ${r.errors.join('; ')}` : '',
      r.logCount ? `| log ${r.logCount}: ${r.logSample[0].slice(0, 90)}` : '',
    ].join(' ') + '\n');
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  process.exit(0);
}
main().catch((e) => { origErr(e); process.exit(1); });
