// Codec X-ray index worker: a demux-only pass over the video stream (libav.js,
// no decoding). For every video packet it reports pts, dts, duration, size, the
// keyframe flag and the picture type (I/P/B), parsed in JS from the first bytes
// of the packet (H.264 and HEVC slice headers, MPEG-1/2 picture headers, MPEG-4
// VOP headers; codecs without B-frames: keyframe = I, others = P).
//
// Its file reads go through the engine's block cache as reader 'xray', so a
// remote file's blocks are fetched once for playback and the index.
//
// Work comes in time segments ('seg' {id, t0, t1}): packets whose decode time
// (dts, else pts) is in [t0, t1). A segment that follows the previous one is read
// on without seeking; any other one seeks to the keyframe at or before t0.
// Results stream back as 'pk' chunks of typed arrays, then 'segdone'.
'use strict';

const AVMEDIA_TYPE_VIDEO = 0;
const AV_PKT_FLAG_KEY = 1;
const BLOCK = 1 << 20;
const T_UNKNOWN = 0;
const T_I = 1;
const T_P = 2;
const T_B = 3;

let libav = null;
let fmt = 0;
let pkt = 0;
let vidx = -1;
let tb = 1;
let codec = '';
let carry = []; // packets read past the previous segment's end (records)
let lastEnd = NaN; // t1 of the previous segment when carry continues it
let atEof = false;
const parser = { lengthSize: 0, pps: new Map() };

const post = (m, transfer) => self.postMessage(m, transfer || []);
const log = (msg) => post({ type: 'log', msg: `xray: ${msg}` });
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'block') {
    if (libav) libav.ff_block_reader_dev_send('in', m.pos, m.data.byteLength ? m.data : null);
    return;
  }
  serial(async () => {
    try {
      if (m.type === 'init') await init(m);
      else if (m.type === 'open') await open(m);
      else if (m.type === 'seg') await segment(m);
    } catch (err) {
      post({ type: 'error', where: m.type, id: m.id, message: String(err && err.message || err) });
    }
  });
};

async function init(m) {
  self.LibAV = {};
  importScripts(m.loader);
  libav = await self.LibAV.LibAV({ noworker: true, nothreads: true, toImport: m.toImport, wasmurl: m.wasmurl, variant: m.variant });
  post({ type: 'ready' });
}

const f64 = (lo, hi) => libav.i64tof64(lo || 0, hi || 0);
const isNo = (lo, hi) => lo === undefined || (lo === libav.AV_NOPTS_VALUE_LO && hi === libav.AV_NOPTS_VALUE_HI);

async function open(m) {
  libav.onblockread = (name, pos, len) => post({ type: 'read', pos, len: Math.max(len, BLOCK) });
  await libav.mkblockreaderdev('in', m.size);
  const [ctx, streams] = await libav.ff_init_demuxer_file('in');
  fmt = ctx;
  pkt = await libav.av_packet_alloc();
  let extradata = null;
  for (const s of streams) {
    if (s.codec_type !== AVMEDIA_TYPE_VIDEO || vidx >= 0) continue;
    const cp = await libav.ff_copyout_codecpar(s.codecpar);
    const name = await libav.avcodec_get_name(s.codec_id);
    // Same choice as decoder-worker.js: skip cover art.
    const coverArt = /^(png|bmp|gif)$/.test(name) || (name === 'mjpeg' && s.duration_time_base <= 1);
    if (cp.width > 0 && !coverArt) { vidx = s.index; tb = s.time_base_num / s.time_base_den; codec = name; extradata = cp.extradata || null; }
  }
  for (const s of streams) if (s.index !== vidx) await libav.AVStream_discard_s(await libav.AVFormatContext_streams_a(fmt, s.index), 48); // AVDISCARD_ALL
  if (vidx < 0) { post({ type: 'opened', video: false }); return; }
  setupParser(extradata);
  const fmtDur = await libav.AVFormatContext_duration(fmt);
  const duration = fmtDur > 0 && fmtDur < 1e15 ? fmtDur / 1e6 : 0;
  const chapters = await xrayChapters();
  // The first packets tell where the timeline starts; they start segment 0.
  carry = await readSome();
  const first = carry.find((r) => isFinite(r.k));
  lastEnd = first ? first.k : 0;
  post({ type: 'opened', video: true, stream: vidx, codec, duration, chapters, first: first ? first.k : 0, firstPts: first ? first.pts : 0 });
}

/** One read call: records for the video packets, [] at the end of the file. */
async function readSome(limit = 2 << 20) {
  if (atEof) return [];
  const [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit });
  if (res === libav.AVERROR_EOF) atEof = true;
  else if (res < 0 && res !== -libav.EAGAIN) { log(`read result ${res}`); atEof = true; }
  const out = [];
  for (const p of packets[vidx] || []) {
    const dts = isNo(p.dts, p.dtshi) ? NaN : f64(p.dts, p.dtshi) * tb;
    let pts = isNo(p.pts, p.ptshi) ? NaN : f64(p.pts, p.ptshi) * tb;
    if (!isFinite(pts)) pts = dts;
    const key = !!(p.flags & AV_PKT_FLAG_KEY);
    out.push({
      pts, dts, k: isFinite(dts) ? dts : pts, size: p.data.byteLength, dur: f64(p.duration, p.durationhi) * tb,
      key, type: pictType(p.data, key),
    });
  }
  // Repeat the previous decode time for packets without one (they stay in its segment).
  return out;
}

async function seekTo(t) {
  const [lo, hi] = libav.f64toi64(Math.max(0, Math.round(t * 1e6)));
  atEof = false;
  carry = [];
  prevK = NaN;
  return libav.avformat_seek_file_max(fmt, -1, lo, hi, 0);
}

let prevK = NaN;
async function segment(m) {
  const { id } = m;
  const t0 = m.t0;
  const t1 = m.t1 === null ? Infinity : m.t1;
  if (!(Math.abs(lastEnd - t0) < 1e-9)) {
    // Not a continuation: seek to the keyframe at or before t0 and start reading at
    // a keyframe packet (MPEG-PS guesses wrong times for packets before it).
    // Containers without an exact index can land past t0; then go back further.
    for (let back = 0; ; back = back ? back * 2 : 1) {
      const r = await seekTo(t0 - back);
      const buf = [];
      let ki = -1;
      for (let bytes = 0; ki < 0 && buf.length < 600 && bytes < (16 << 20) && !atEof;) {
        for (const x of await readSome(256 << 10)) { buf.push(x); bytes += x.size; }
        ki = buf.findIndex((x) => x.key && isFinite(x.k));
      }
      // No keyframe close by (e.g. one IDR per file): take the times as they come.
      carry = ki >= 0 ? buf.slice(ki) : buf;
      const at = carry.find((x) => isFinite(x.k));
      if (r < 0 || !at || at.k <= t0 + 1e-6 || back >= 64 || t0 - back < -1) break;
    }
  }
  let out = [];
  let done = false;
  let n = 0;
  const flush = (last) => {
    const len = out.length;
    const a = { pts: new Float64Array(len), dts: new Float64Array(len), dur: new Float32Array(len), size: new Uint32Array(len), key: new Uint8Array(len), pict: new Uint8Array(len) };
    out.forEach((r, i) => { a.pts[i] = r.pts; a.dts[i] = r.dts; a.dur[i] = r.dur; a.size[i] = r.size; a.key[i] = r.key ? 1 : 0; a.pict[i] = r.type; });
    n += len;
    post({ type: 'pk', id, ...a, last, eof: last && atEof && !carry.length }, Object.values(a).map((x) => x.buffer));
    out = [];
  };
  while (!done) {
    const recs = carry.length ? carry : await readSome();
    carry = [];
    if (!recs.length && atEof) break;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!isFinite(r.k)) r.k = prevK; // no timestamp: stays with the previous packet
      prevK = r.k;
      if (r.k >= t1) { carry = recs.slice(i); done = true; break; }
      // Before t0 (read after a seek), or untimed right after a seek: not this segment's.
      if (r.k >= t0 - 1e-9) out.push(r);
    }
    if (out.length >= 4000 && !done) flush(false);
  }
  lastEnd = done ? t1 : NaN;
  flush(true);
  post({ type: 'segdone', id, n, eof: atEof && !carry.length });
}

// ---- chapters (same as decoder-worker.js) -----------------------------------
async function xrayChapters() {
  const out = [];
  try {
    const n = Math.min(await libav.AVFormatContext_nb_chapters(fmt), 2000);
    for (let i = 0; i < n; i++) {
      const c = await libav.AVFormatContext_chapters_a(fmt, i);
      const ctb = (await libav.AVChapter_time_base_num(c)) / (await libav.AVChapter_time_base_den(c));
      const start = f64(await libav.AVChapter_start(c), await libav.AVChapter_starthi(c)) * ctb;
      const end = f64(await libav.AVChapter_end(c), await libav.AVChapter_endhi(c)) * ctb;
      const md = await libav.ff_copyout_dict(await libav.AVChapter_metadata(c));
      if (isFinite(start)) out.push({ start, end, title: (md && (md.title || md.TITLE)) || '' });
    }
  } catch (e) { log(`chapters: ${e && e.message || e}`); }
  return out.sort((a, b) => a.start - b.start);
}

// ---- picture types --------------------------------------------------------------

/** Exp-Golomb bit reader over NAL payload bytes, skipping emulation prevention bytes. */
class Bits {
  constructor(b, o, end) { this.b = b; this.p = o; this.end = Math.min(end, b.length); this.cur = 0; this.left = 0; this.zeros = 0; }
  byte() {
    if (this.p >= this.end) throw new RangeError('eob');
    let v = this.b[this.p++];
    if (this.zeros >= 2 && v === 3) {
      this.zeros = 0;
      if (this.p >= this.end) throw new RangeError('eob');
      v = this.b[this.p++];
    }
    this.zeros = v === 0 ? this.zeros + 1 : 0;
    return v;
  }
  u1() { if (!this.left) { this.cur = this.byte(); this.left = 8; } this.left--; return (this.cur >> this.left) & 1; }
  u(n) { let v = 0; while (n-- > 0) v = v * 2 + this.u1(); return v; }
  ue() { let z = 0; while (!this.u1()) if (++z > 31) throw new RangeError('ue'); return 2 ** z - 1 + this.u(z); }
}

/** NAL units of a packet as [start, end) of each NAL (header included). */
function* nals(b) {
  const n = b.length;
  const L = parser.lengthSize;
  // Length-prefixed (avcC/hvcC) unless the first length doesn't fit: a short NAL's
  // 4-byte length starts 00 00 01 like an Annex B start code, so lengths win.
  let first = 0;
  for (let i = 0; i < L && i < n; i++) first = first * 256 + b[i];
  if (L && first > 0 && first <= n - L) {
    for (let o = 0; o + L < n;) {
      let len = 0;
      for (let i = 0; i < L; i++) len = len * 256 + b[o + i];
      const s = o + L;
      yield [s, Math.min(n, s + len)];
      o = s + len;
    }
    return;
  }
  // Annex B: start codes 00 00 01, found lazily (big SEIs come before the slice).
  let s = -1;
  for (let i = 0; i + 2 < n; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (s >= 0) yield [s, b[i - 1] === 0 ? i - 1 : i];
      s = i + 3;
      i += 2;
    }
  }
  if (s >= 0 && s < n) yield [s, n];
}

function hevcPps(b, s, e) {
  try {
    const r = new Bits(b, s + 2, e);
    const id = r.ue();
    r.ue(); // sps id
    r.u1(); // dependent_slice_segments_enabled_flag
    r.u1(); // output_flag_present_flag
    parser.pps.set(id, r.u(3)); // num_extra_slice_header_bits
  } catch { /* short */ }
}

function setupParser(ex) {
  parser.lengthSize = 0;
  if (!ex || !ex.length) return;
  if (codec === 'h264' && ex[0] === 1 && ex.length > 5) parser.lengthSize = (ex[4] & 3) + 1;
  else if (codec === 'hevc' && ex[0] === 1 && ex.length > 22) {
    parser.lengthSize = (ex[21] & 3) + 1;
    let o = 23;
    for (let a = 0; a < ex[22] && o + 3 <= ex.length; a++) {
      const type = ex[o] & 0x3f;
      const cnt = (ex[o + 1] << 8) | ex[o + 2];
      o += 3;
      for (let j = 0; j < cnt && o + 2 <= ex.length; j++) {
        const len = (ex[o] << 8) | ex[o + 1];
        o += 2;
        if (type === 34) hevcPps(ex, o, o + len);
        o += len;
      }
    }
  } else if (codec === 'hevc') {
    for (const [s, e] of nals(ex)) if (((ex[s] >> 1) & 0x3f) === 34) hevcPps(ex, s, e);
  }
}

const H264_TYPES = [T_P, T_B, T_I, T_P, T_I]; // P B I SP SI

function pictType(b, key) {
  try {
    switch (codec) {
      case 'h264':
        for (const [s, e] of nals(b)) {
          const t = b[s] & 0x1f;
          if (t === 1 || t === 5) {
            const r = new Bits(b, s + 1, e);
            r.ue(); // first_mb_in_slice
            return H264_TYPES[r.ue() % 5];
          }
        }
        return key ? T_I : T_UNKNOWN;
      case 'hevc':
        for (const [s, e] of nals(b)) {
          const t = (b[s] >> 1) & 0x3f;
          if (t === 34) { hevcPps(b, s, e); continue; }
          if (t >= 16 && t <= 23) return T_I; // IRAP pictures hold I slices only
          if (t <= 9) {
            const r = new Bits(b, s + 2, e);
            if (!r.u1()) return T_UNKNOWN; // not the picture's first slice
            const extra = parser.pps.get(r.ue()) || 0;
            r.u(extra);
            const st = r.ue();
            return st === 2 ? T_I : st === 1 ? T_P : st === 0 ? T_B : T_UNKNOWN;
          }
        }
        return key ? T_I : T_UNKNOWN;
      case 'mpeg1video':
      case 'mpeg2video':
        for (let i = 0; i + 5 < b.length; i++) {
          if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && b[i + 3] === 0) {
            const c = (b[i + 5] >> 3) & 7; // after the 10-bit temporal_reference
            return c === 1 ? T_I : c === 2 ? T_P : c === 3 ? T_B : T_UNKNOWN;
          }
        }
        return key ? T_I : T_UNKNOWN;
      case 'mpeg4':
        for (let i = 0; i + 4 < b.length; i++) {
          if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && b[i + 3] === 0xb6) {
            const c = b[i + 4] >> 6; // vop_coding_type: I P B S(GMC)
            return c === 0 ? T_I : c === 2 ? T_B : T_P;
          }
        }
        return key ? T_I : T_UNKNOWN;
      // No B-frames in these: everything that is not a keyframe predicts forward.
      case 'vp8': case 'vp9': case 'av1': case 'theora': case 'flv1': case 'h263': case 'h263p':
      case 'wmv1': case 'wmv2': case 'msmpeg4v1': case 'msmpeg4v2': case 'msmpeg4v3': case 'h261':
        return key ? T_I : T_P;
      default:
        return key ? T_I : T_UNKNOWN;
    }
  } catch {
    return key ? T_I : T_UNKNOWN;
  }
}
