// Decoder worker: demuxes with libav.js (WebAssembly) and decodes what the
// browser can't. Runs in a Worker created from a blob URL by player.js.
// Nothing is re-encoded: packets go to WebCodecs (hardware) or are decoded here
// to raw YUV / float PCM.
'use strict';

const AVMEDIA_TYPE_VIDEO = 0;
const AVMEDIA_TYPE_AUDIO = 1;
const AV_PIX_FMT_YUV420P = 0;
const AV_PIX_FMT_YUVJ420P = 12;
const AV_PKT_FLAG_KEY = 1;
const BLOCK = 1 << 20;

let libav = null;
let fmt = 0;
let pkt = 0;
let streams = [];
const V = { idx: -1, mode: 'none', c: 0, pkt: 0, frame: 0, tb: [1, 1], filter: null, convWarned: false };

/** Dolby Vision configuration record of the stream ({ profile, compat }), null when none (media/hdr.js dolbyVision). */
function dolbyVision(cp) {
  // AV_PKT_DATA_DOVI_CONF (29): AVDOVIDecoderConfigurationRecord, bytes: version major, minor,
  // dv_profile, dv_level, rpu, el, bl present, dv_bl_signal_compatibility_id.
  for (const sd of cp.coded_side_data || []) {
    const d = sd && sd.data;
    if (sd && sd.type === 29 && d && d.byteLength >= 8) return { profile: d[2], compat: d[7] };
  }
  return null;
}

/**
 * HDR content peak in nits from the stream's side data: content light level (MaxCLL,
 * AV_PKT_DATA_CONTENT_LIGHT_LEVEL 22), else the mastering display's max luminance
 * (AV_PKT_DATA_MASTERING_DISPLAY_METADATA 20, AVRational at byte 72). 0 when unknown.
 */
function hdrPeak(cp) {
  let cll = 0;
  let mdcv = 0;
  for (const sd of cp.coded_side_data || []) {
    const d = sd && sd.data;
    if (!d || !d.byteLength) continue;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (sd.type === 22 && d.byteLength >= 4) cll = dv.getUint32(0, true);
    if (sd.type === 20 && d.byteLength >= 88 && dv.getInt32(84, true)) { // has_luminance
      const den = dv.getInt32(76, true);
      if (den > 0) mdcv = dv.getInt32(72, true) / den;
    }
  }
  const peak = cll || mdcv;
  return peak >= 100 && peak <= 10000 ? peak : 0;
}
const A = { idx: -1, mode: 'none', c: 0, pkt: 0, frame: 0, tb: [1, 1] };
let gen = 0;
let eof = false;
let seekGen = 0; // newest seek received (seeks queued behind a newer one are skipped)
let readPos = 0; // latest packet time read since the last seek or rewind
let pendingRead = null; // [res, packets] read by seek() to check where it landed; more() hands them out

const post = (m, transfer) => self.postMessage(m, transfer || []);
const log = (msg) => post({ type: 'log', msg: `worker: ${msg}` });

// All libav calls go through one queue: libav.js in direct mode must not interleave.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'block') {
    // Answers can arrive while a queued call is waiting for exactly this data.
    if (libav) libav.ff_block_reader_dev_send('in', m.pos, m.data.byteLength ? m.data : null);
    return;
  }
  if (m.type === 'seek') seekGen = Math.max(seekGen, m.gen);
  // Frame buffers back from the engine after upload (see takeBuffer).
  if (m.type === 'recycle') { recycle(m.bufs); return; }
  // Segment flow control (pool.js) acts at once, between libav calls.
  if (m.type === 'segctl') { segControl(m); return; }
  if (m.type === 'segment') {
    // The new segment exists at once, so flow control sent right after it applies.
    if (SEG.cur) SEG.cur.cancelled = true;
    const s = segNew(m);
    SEG.cur = s;
    serial(() => startSegment(s, m).catch((err) => post({ type: 'error', where: 'segment', sid: s.sid, message: String(err && err.message || err) })));
    return;
  }
  serial(async () => {
    try {
      switch (m.type) {
        case 'init': return await init(m);
        case 'remoteAudio': return await remoteAudio(m);
        case 'open': return await open(m);
        case 'config': return await configure(m);
        case 'more': return await more(m);
        case 'seek': return await seek(m);
        case 'video': return await videoOnOff(m);
        case 'selectAudio': return await selectAudio(m);
        case 'selectSub': return await selectSub(m);
        case 'skipNonRef': return await skipNonRef(m);
        case 'fastDecode': return await fastDecode(m);
        case 'videoMode': return await videoToSoft();
        default: return undefined;
      }
    } catch (err) {
      post({ type: 'error', where: m.type, id: m.id, message: String(err && err.message || err), stack: err && err.stack });
      return undefined;
    }
  });
};

async function init(m) {
  const t0 = performance.now();
  if (m.freeBytes > 0) FREE_BYTES = m.freeBytes;
  self.LibAV = {};
  importScripts(m.loader);
  libav = await self.LibAV.LibAV({ noworker: true, nothreads: true, toImport: m.toImport, wasmurl: m.wasmurl, variant: m.variant });
  log(`init: libav ready (${libav.libavjsMode}) in ${Math.round(performance.now() - t0)} ms`);
  post({ type: 'ready', mode: libav.libavjsMode });
}

const f64 = (lo, hi) => libav.i64tof64(lo || 0, hi || 0);

async function open(m) {
  libav.onblockread = (name, pos, len) => post({ type: 'read', pos, len: Math.max(len, BLOCK) });
  await libav.mkblockreaderdev('in', m.size);
  [fmt, streams] = await libav.ff_init_demuxer_file('in');
  pkt = await libav.av_packet_alloc();
  // A pool video worker (pool.js) demuxes and decodes the picture only.
  const videoOnly = m.role === 'video';
  T.videoOnly = videoOnly;
  const info = { duration: 0, video: null, audio: null };
  const fmtDur = await libav.AVFormatContext_duration(fmt);
  if (fmtDur > 0 && fmtDur < 1e15) info.duration = fmtDur / 1e6;
  if (!videoOnly) info.tracks = await listTracks();
  const firstAudio = info.tracks ? preferredAudio(info.tracks.audio) : -1;
  for (const s of streams) {
    const cp = await libav.ff_copyout_codecpar(s.codecpar);
    const name = await libav.avcodec_get_name(s.codec_id);
    const tb = [s.time_base_num, s.time_base_den];
    // Cover art shows up as a one-frame PNG/MJPEG/BMP "video" stream; prefer real video.
    const coverArt = /^(png|bmp|gif)$/.test(name) || (name === 'mjpeg' && s.duration_time_base <= 1);
    if (s.codec_type === AVMEDIA_TYPE_VIDEO && V.idx < 0 && cp.width > 0 && !coverArt) {
      V.idx = s.index;
      V.tb = tb;
      info.video = {
        codec: name, width: cp.width, height: cp.height, format: cp.format, profile: cp.profile, level: cp.level,
        extradata: cp.extradata || null, tb, colorRange: cp.color_range, colorSpace: cp.color_space,
        colorTrc: cp.color_trc, colorPrimaries: cp.color_primaries, hdrPeak: hdrPeak(cp), dv: dolbyVision(cp),
        // Bit depth as coded (the host files decode speeds per codec/depth/size).
        depth: cp.format >= 0 ? ((await describe(cp.format)) || { depth: 0 }).depth : 0,
        bitRate: Number(cp.bit_rate) > 0 ? Number(cp.bit_rate) : 0, // for the "About this video" panel
        ...(await streamRate(s)),
      };
      V.codec = name;
      V.nalLen = name === 'h264' && cp.extradata && cp.extradata[0] === 1 && cp.extradata.length > 4 ? (cp.extradata[4] & 3) + 1 : 0;
      V.fullRange = cp.color_range === 2; // AVCOL_RANGE_JPEG
      // AVCOL_SPC: 1 BT.709, 5/6 BT.601, 9/10 BT.2020; unknown -> guess from size in the renderer
      V.space = cp.color_space === 1 ? 709 : (cp.color_space === 5 || cp.color_space === 6) ? 601 : (cp.color_space === 9 || cp.color_space === 10) ? 2020 : 0;
      // HDR transfer (AVCOL_TRC 16 PQ / 18 HLG) and primaries (AVCOL_PRI 9 BT.2020): the renderer tone-maps.
      V.trc = cp.color_trc === 16 || cp.color_trc === 18 ? cp.color_trc : 0;
      V.prim = cp.color_primaries;
    } else if (s.codec_type === AVMEDIA_TYPE_AUDIO && A.idx < 0 && !videoOnly && (firstAudio < 0 || s.index === firstAudio)) {
      A.idx = s.index;
      A.tb = tb;
      info.audio = {
        id: s.index,
        codec: name, sampleRate: cp.sample_rate, channels: cp.ch_layout_nb_channels || cp.channels || 2, format: cp.format,
        extradata: cp.extradata || null, tb, bitRate: Number(cp.bit_rate) > 0 ? Number(cp.bit_rate) : 0,
      };
    }
    if (!info.duration && s.duration > 0) info.duration = s.duration;
  }
  // Skip the other streams' packets in the demuxer (no reads for their data).
  if (videoOnly) for (const s of streams) if (s.index !== V.idx) await discard(s.index, true);
  if (!videoOnly) info.chapters = await xrayChapters(); // xray: chapter list for the seek bar
  post({ type: 'streams', info });
}

/** Main thread tells us which streams it decodes itself (WebCodecs) and which we decode. */
async function configure(m) {
  V.mode = V.idx >= 0 ? m.video : 'none';
  V.deep = !!m.deep; // the renderer draws 16-bit and 4:2:2/4:4:4 planes itself
  A.mode = A.idx >= 0 ? m.audio : 'none';
  const result = { video: V.mode, audio: A.mode };
  for (const [S, key] of [[V, 'video'], [A, 'audio']]) {
    if (S.mode !== 'soft') continue;
    try {
      const st = streams.find((s) => s.index === S.idx);
      [, S.c, S.pkt, S.frame] = await libav.ff_init_decoder(st.codec_id, { codecpar: st.codecpar, time_base: S.tb });
    } catch (err) {
      S.mode = 'none';
      result[key] = 'none';
      result[`${key}Error`] = `no ${key} decoder for this codec in the built-in decoder (${err && err.message || err})`;
    }
  }
  if (m.keepStreams) T.keepStreams = true; // tests: measure without stream discard
  await applyDiscard();
  post({ type: 'configured', ...result });
}

// dtsFallback = false: null without a PTS. DTS is decode order (AVI with B-frames), so
// WebCodecs packets then get the engine's evenly spaced output times (noPts) instead.
function packetTime(p, tb, dtsFallback = true) {
  let t = p.pts;
  if (t === undefined || (p.pts === libav.AV_NOPTS_VALUE_LO && p.ptshi === libav.AV_NOPTS_VALUE_HI)) {
    if (!dtsFallback || p.dts === undefined || (p.dts === libav.AV_NOPTS_VALUE_LO && p.dtshi === libav.AV_NOPTS_VALUE_HI)) return null;
    return f64(p.dts, p.dtshi) * tb[0] / tb[1];
  }
  return f64(p.pts, p.ptshi) * tb[0] / tb[1];
}

function frameTime(f, tb) {
  const noPts = f.pts === undefined || (f.pts === libav.AV_NOPTS_VALUE_LO && f.ptshi === libav.AV_NOPTS_VALUE_HI);
  if (!noPts) return f64(f.pts, f.ptshi) * tb[0] / tb[1];
  const noBest = f.best_effort_timestamp === undefined || (f.best_effort_timestamp === libav.AV_NOPTS_VALUE_LO && f.best_effort_timestamphi === libav.AV_NOPTS_VALUE_HI);
  if (!noBest) return f64(f.best_effort_timestamp, f.best_effort_timestamphi) * tb[0] / tb[1];
  return null;
}

/**
 * Describes a pixel format (cached): planar YUV with 8..16 bits and any chroma
 * subsampling is drawn directly by the WebGL shader; anything else is converted.
 */
const fmtInfo = new Map();
async function describe(format) {
  if (fmtInfo.has(format)) return fmtInfo.get(format);
  let d = null;
  try {
    const desc = await libav.av_pix_fmt_desc_get(format);
    if (desc) {
      const flags = await libav.AVPixFmtDescriptor_flags(desc);
      const nb = await libav.AVPixFmtDescriptor_nb_components(desc);
      const depth = await libav.AVPixFmtDescriptor_comp_depth(desc, 0);
      const cw = await libav.AVPixFmtDescriptor_log2_chroma_w(desc);
      const chh = await libav.AVPixFmtDescriptor_log2_chroma_h(desc);
      // AV_PIX_FMT_FLAG_BE = 1, PAL = 2, PLANAR = 16, RGB = 32
      const direct = (flags & 16) && !(flags & 32) && !(flags & 1) && !(flags & 2) && nb >= 3 && depth >= 8 && depth <= 16 && cw <= 1 && chh <= 1;
      d = { direct: !!direct, depth, cw, ch: chh, full: format === AV_PIX_FMT_YUVJ420P || format === 13 || format === 14 };
    }
  } catch (e) { log(`describe(${format}) failed: ${e && e.message || e}`); }
  fmtInfo.set(format, d);
  return d;
}

// ---- frame output -------------------------------------------------------------
// Decoded pictures leave the wasm heap with one copy: the three planes (rows at
// the decoder's stride, no gaps between planes) go into one ArrayBuffer, which is
// transferred to the engine. After the upload the engine hands buffers back
// ('recycle'), so steady playback allocates no new frame memory.
const FREE = []; // returned ArrayBuffers, newest last
let FREE_BYTES = 64e6; // keep at most this much (but two buffers at any size); 'init' sets it from the machine's memory

function recycle(bufs) {
  for (const b of bufs || []) {
    if (!(b instanceof ArrayBuffer) || !b.byteLength) continue;
    FREE.push(b);
    // Drop the oldest (e.g. a size no longer in use) beyond the cap.
    let bytes = 0;
    for (const x of FREE) bytes += x.byteLength;
    while (FREE.length > 2 && bytes > FREE_BYTES) bytes -= FREE.shift().byteLength;
  }
}

function takeBuffer(n) {
  for (let i = FREE.length - 1; i >= 0; i--) {
    const b = FREE[i];
    if (b.byteLength >= n && b.byteLength - n <= n >> 3) { FREE.splice(i, 1); return b; }
  }
  return new ArrayBuffer(n);
}

/** Copies an AVFrame (pointer, planar YUV described by d) out of the heap and frees it. */
function copyOut(ptr, d) {
  const L = libav;
  try {
    const width = L.AVFrame_width_sync(ptr);
    const height = L.AVFrame_height_sync(ptr);
    const bps = d.depth > 8 ? 2 : 1;
    const layout = [];
    const src = [];
    let n = 0;
    for (let p = 0; p < 3; p++) {
      const stride = L.AVFrame_linesize_a_sync(ptr, p);
      const rows = p ? (height + (1 << d.ch) - 1) >> d.ch : height;
      const row = (p ? (width + (1 << d.cw) - 1) >> d.cw : width) * bps;
      if (stride < row) throw new Error(`unexpected linesize ${stride} for plane ${p}`);
      layout.push({ offset: n, stride });
      // The last row only up to the picture's width: its padding need not exist.
      src.push(L.AVFrame_data_a_sync(ptr, p), stride * (rows - 1) + row);
      n += stride * rows;
    }
    const data = new Uint8Array(takeBuffer(n), 0, n);
    const heap = L.HEAPU8;
    for (let p = 0; p < 3; p++) data.set(heap.subarray(src[2 * p], src[2 * p] + src[2 * p + 1]), layout[p].offset);
    return {
      width, height, data, layout, desc: d, format: L.AVFrame_format_sync(ptr),
      pts: L.AVFrame_pts_sync(ptr), ptshi: L.AVFrame_ptshi_sync(ptr),
      best_effort_timestamp: L.AVFrame_best_effort_timestamp_sync(ptr), best_effort_timestamphi: L.AVFrame_best_effort_timestamphi_sync(ptr),
      key_frame: L.AVFrame_key_frame_sync(ptr), flags: L.AVFrame_flags_sync(ptr),
    };
  } finally { L.av_frame_free_js_sync(ptr); }
}

/**
 * Decoded frames (pointers from ff_decode_multi with copyoutFrame 'ptr') to frame
 * objects; formats the shader can't draw go to planar YUV 4:2:0 through a libavfilter graph.
 */
async function toYuv420(ptrs) {
  const out = [];
  let i = 0;
  try {
    for (; i < ptrs.length; i++) {
      const ptr = ptrs[i];
      ptrs[i] = 0; // from here on copyOut or the filter frees it
      const format = libav.AVFrame_format_sync(ptr);
      if (format === AV_PIX_FMT_YUV420P || format === AV_PIX_FMT_YUVJ420P) { out.push(copyOut(ptr, { depth: 8, cw: 1, ch: 1, full: format === AV_PIX_FMT_YUVJ420P })); continue; }
      const d = V.deep ? await describe(format) : null;
      if (d && d.direct) { out.push(copyOut(ptr, d)); continue; }
      const width = libav.AVFrame_width_sync(ptr);
      const height = libav.AVFrame_height_sync(ptr);
      if (!V.filter || V.filter.w !== width || V.filter.h !== height || V.filter.fmt !== format) {
        if (V.filter) await libav.avfilter_graph_free_js(V.filter.graph);
        V.filter = null;
        const [graph, src, sink] = await libav.ff_init_filter_graph('format=yuv420p', {
          type: AVMEDIA_TYPE_VIDEO, width, height, pix_fmt: format, time_base: V.tb,
        }, { type: AVMEDIA_TYPE_VIDEO, pix_fmt: AV_PIX_FMT_YUV420P, time_base: V.tb });
        V.filter = { graph, src, sink, w: width, h: height, fmt: format, frame: await libav.av_frame_alloc() };
      }
      // The filter takes over (and frees) the input frame.
      const conv = await libav.ff_filter_multi(V.filter.src, V.filter.sink, V.filter.frame, [ptr], { copyoutFrame: 'ptr' });
      for (const c of conv) out.push(copyOut(c, { depth: 8, cw: 1, ch: 1, full: false }));
      if (!V.convWarned) { V.convWarned = true; log(`pixel format ${format} converted to yuv420p`); }
    }
  } finally {
    for (; i < ptrs.length; i++) if (ptrs[i]) libav.av_frame_free_js_sync(ptrs[i]);
  }
  return out;
}

const PLANAR = new Set([5, 6, 7, 8, 9, 11]); // u8p s16p s32p fltp dblp s64p
function audioToFloat(f) {
  const ch = f.channels || (f.channel_layout ? 2 : 1);
  const n = f.nb_samples;
  const norm = (arr) => {
    if (arr instanceof Float32Array) return arr;
    if (arr instanceof Float64Array) return Float32Array.from(arr);
    if (arr instanceof Int16Array) { const o = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = arr[i] / 32768; return o; }
    if (arr instanceof Int32Array) { const o = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = arr[i] / 2147483648; return o; }
    if (arr instanceof Uint8Array) { const o = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = (arr[i] - 128) / 128; return o; }
    return Float32Array.from(arr, Number);
  };
  if (PLANAR.has(f.format) && Array.isArray(f.data)) return f.data.slice(0, ch).map((p) => norm(p).subarray(0, n));
  const inter = norm(Array.isArray(f.data) ? f.data[0] : f.data);
  const planes = [];
  for (let c = 0; c < ch; c++) {
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = inter[i * ch + c];
    planes.push(p);
  }
  return planes;
}

async function more(m) {
  if (m.gen !== gen || eof) return;
  const [res, packets] = pendingRead || await libav.ff_read_frame_multi(fmt, pkt, { limit: m.limit || 512 * 1024 });
  pendingRead = null;
  const atEnd = res === libav.AVERROR_EOF;
  if (res !== 0 && !atEnd && res !== -libav.EAGAIN) log(`read result ${res}`);
  readPos = Math.max(readPos, lastTime(packets));
  const vp = afterRewind(V, V.idx >= 0 ? packets[V.idx] || [] : []);
  const ap = afterRewind(A, A.idx >= 0 ? packets[A.idx] || [] : []);
  if (S.idx >= 0) await onSubPackets(packets[S.idx], packets, false);
  const msg = { type: 'batch', gen: m.gen, eof: atEnd, video: [], audio: [] };
  const transfer = [];

  if (V.mode === 'webcodecs') {
    for (const p of vp) {
      const key = !!(p.flags & AV_PKT_FLAG_KEY);
      msg.video.push({ kind: 'packet', t: packetTime(p, V.tb, false), dts: p.dts === undefined ? null : f64(p.dts, p.dtshi) * V.tb[0] / V.tb[1], key, idr: key ? isIdr(p.data) : undefined, data: p.data });
      transfer.push(p.data.buffer);
    }
  } else if (V.mode === 'soft' && !V.off && (vp.length || (atEnd && !V.drained))) {
    if (atEnd) V.drained = true;
    let frames = await libav.ff_decode_multi(V.c, V.pkt, V.frame, vp, { fin: atEnd, ignoreErrors: true, copyoutFrame: 'ptr' });
    frames = await toYuv420(frames);
    for (const f of frames) {
      msg.video.push({
        kind: 'yuv', t: frameTime(f, V.tb), width: f.width, height: f.height, data: f.data, layout: f.layout,
        fullRange: f.desc.full || V.fullRange, depth: f.desc.depth, cw: f.desc.cw, ch: f.desc.ch, space: V.space, trc: V.trc, prim: V.prim, recycle: true,
      });
      transfer.push(f.data.buffer);
    }
  }

  if (A.mode === 'webcodecs') {
    for (const p of ap) {
      msg.audio.push({ kind: 'packet', t: packetTime(p, A.tb), key: true, data: p.data, aid: A.idx });
      transfer.push(p.data.buffer);
    }
  } else if (A.mode === 'soft' && (ap.length || (atEnd && !A.drained))) {
    if (atEnd) A.drained = true;
    const frames = await libav.ff_decode_multi(A.c, A.pkt, A.frame, ap, { fin: atEnd, ignoreErrors: true });
    for (const f of frames) {
      const planes = audioToFloat(f);
      // The layout mask: the engine mixes layouts WebAudio can't downmix (7.1, 2.1, ...) to stereo.
      msg.audio.push({ kind: 'pcm', t: frameTime(f, A.tb), sampleRate: f.sample_rate, planes, mask: Number(f.channel_layout) || 0, aid: A.idx });
      for (const p of planes) transfer.push(p.buffer);
    }
  }
  if (atEnd) eof = true;
  // Deduplicate transfer list (planes can share a buffer).
  post(msg, [...new Set(transfer)]);
}

async function seek(m) {
  // Scrubbing queues many seeks: only the newest one runs; the others are answered at once.
  if (m.gen < seekGen) { post({ type: 'seeked', gen: m.gen, iid: m.iid }); return; }
  // Answered also when the seek throws: the pool waits for its internal seeks.
  try { await seekNow(m); } finally { post({ type: 'seeked', gen, iid: m.iid }); }
}

async function seekNow(m) {
  gen = m.gen;
  eof = false;
  pendingRead = null;
  readPos = m.t;
  // Nothing has been handed out since this seek: a following rewind must not skip to packets of before it.
  V.last = null;
  A.last = null;
  try { await subPrescan(m.t); } catch (err) { log(`subtitle prescan failed: ${err && err.message || err}`); await applyDiscard(); }
  V.skip = null;
  A.skip = null;
  V.drained = false;
  A.drained = false;
  const seekTo = async (t) => {
    const [lo, hi] = libav.f64toi64(Math.max(0, Math.round(t * 1e6)));
    // Accurate: latest keyframe at or before the target (the player drops frames up to it).
    // Fast (real-time catch-up): first keyframe at or after the target.
    const r = m.fast ? await libav.avformat_seek_file_min(fmt, -1, lo, hi, 0) : await libav.avformat_seek_file_max(fmt, -1, lo, hi, 0);
    if (r < 0) log(`seek to ${t} returned ${r}`);
  };
  await seekTo(m.t);
  if (!m.fast && V.idx >= 0 && V.mode !== 'none' && !V.off) {
    // Timestamp-searching demuxers (MPEG-PS/TS) land on any packet, possibly past the target or at the
    // end: go back further (finally to 0) until a picture keyframe at or before the target follows.
    // At most 8 tries (back to ~64 s before the target; each reads up to 64 MB): then take where it landed.
    for (let back = 0.5, t = m.t, tries = 1; ; back *= 2, tries++) {
      const { read, key, keyT } = await readToKey(m.t);
      const late = !key || (keyT !== null && keyT > m.t + 1e-3);
      if (!late || t <= 0 || tries >= 8) {
        if (late && t > 0) log(`seek to ${m.t}: no keyframe before it within ${back / 2} s; continuing from where the demuxer landed`);
        pendingRead = read;
        break;
      }
      t = Math.max(0, m.t - back);
      await seekTo(t);
    }
  }
  if (V.mode === 'soft') await libav.avcodec_flush_buffers(V.c);
  if (A.mode === 'soft') await libav.avcodec_flush_buffers(A.c);
}

/** After an accurate seek: reads to the first picture keyframe, a picture past `until`, or the end (kept for more()). */
async function readToKey(until) {
  const all = {};
  let res = 0;
  let bytes = 0;
  for (;;) {
    let packets;
    [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 64 * 1024 });
    for (const k of Object.keys(packets)) {
      (all[k] = all[k] || []).push(...packets[k]);
      for (const p of packets[k]) bytes += p.data.byteLength;
    }
    const vp = packets[V.idx] || [];
    const key = vp.find((p) => p.flags & AV_PKT_FLAG_KEY);
    if (key) return { read: [res, all], key: true, keyT: packetTime(key, V.tb) };
    const last = vp.length ? packetTime(vp[vp.length - 1], V.tb) : null;
    if ((last !== null && last > until) || res === libav.AVERROR_EOF || (res < 0 && res !== -libav.EAGAIN) || bytes > 64e6) return { read: [res, all], key: false, keyT: null };
  }
}

// ---- parallel video (pool.js) ---------------------------------------------
// With software video on a multi-core machine, DecoderPool runs extra copies of
// this worker that each decode one time segment of the picture; this worker
// (the primary) then demuxes and decodes only the sound.

async function discard(index, all) {
  const st = await libav.AVFormatContext_streams_a(fmt, index);
  await libav.AVStream_discard_s(st, all ? 48 : 0); // AVDISCARD_ALL / AVDISCARD_DEFAULT
}

/** Primary: stop (or resume) demuxing and decoding the picture. Resuming needs a seek. */
async function videoOnOff(m) {
  if (V.idx < 0) return;
  V.off = !m.on;
  V.skip = null;
  await applyDiscard();
  if (V.mode === 'soft') await libav.avcodec_flush_buffers(V.c);
}

// One segment at a time: frames with lo <= t < hi, in presentation order.
// K is the time of the first keyframe the segment decodes (from the decoder's
// output, so leading pictures that need the previous GOP never count). The
// first segment after a seek keeps every frame like seek() + more() (lo -inf),
// or, when the pool takes over mid-stream, frames after lo (re-seeking earlier
// if the demuxer landed past lo). Later segments seek to the first keyframe at
// or after their nominal start s and keep t >= max(K, s). hi is the next
// segment's lo; until the pool knows it, decoding pauses at the first frame
// >= next (which is <= hi). allow: cumulative bytes of frames the pool takes
// for now; finding K ignores it so the previous segment never waits on it.
const SEG = { cur: null };
const SEG_YIELD = new MessageChannel();
const segYield = () => new Promise((res) => { SEG_YIELD.port1.onmessage = () => res(); SEG_YIELD.port2.postMessage(0); });
const isKey = (f) => !!(f.key_frame || (f.flags & 2)); // AV_FRAME_FLAG_KEY

function segControl(m) {
  const s = SEG.cur;
  if (!s || s.sid !== m.sid) return;
  if (m.cancel) { s.cancelled = true; return; }
  if (m.allow !== undefined) s.allow = Math.max(s.allow, m.allow);
  if (m.next !== undefined) s.next = m.next;
  if (m.hi !== undefined) {
    s.hi = m.hi;
    if (s.maxT >= s.hi && !s.done) { s.done = true; segPost(s, [], [], []); }
  }
  if (s.waitHi && (s.hi !== null || s.maxT < s.next)) s.waitHi = false;
  segKick(s);
}

function segPost(s, frames, keys, transfer) {
  post({ type: 'vframes', sid: s.sid, gen: s.gen, frames, keys, done: s.done, eof: !!s.eof, K: s.reportK ? s.K : undefined }, transfer);
  s.reportK = false;
}

const segCanRun = (s) => !s.done && !s.cancelled && !s.waitHi && (s.emitted < s.allow || s.K === undefined);

function segKick(s) {
  if (s.running || SEG.cur !== s || !segCanRun(s)) return;
  s.running = true;
  serial(async () => {
    try {
      while (segCanRun(s)) {
        await segStep(s);
        await segYield(); // let flow-control messages in
      }
    } catch (err) {
      post({ type: 'error', where: 'segment', sid: s.sid, message: String(err && err.message || err), stack: err && err.stack });
      s.done = true;
    } finally { s.running = false; }
  });
}

async function segSeek(s, mode, t) {
  const ts = Math.max(0, Math.round(t * 1e6));
  const [lo, hi] = libav.f64toi64(ts);
  // 'max': latest keyframe at or before t (accurate seek); 'min': first at or after t.
  const r = mode === 'min' ? await libav.avformat_seek_file_min(fmt, -1, lo, hi, 0) : await libav.avformat_seek_file_max(fmt, -1, lo, hi, 0);
  await libav.avcodec_flush_buffers(V.c);
  s.pending = null;
  return r;
}

function segNew(m) {
  return {
    sid: m.sid, gen: m.gen, first: !!m.first, lo: m.first && typeof m.lo === 'number' ? m.lo : -Infinity,
    start: m.start, next: m.next, hi: typeof m.hi === 'number' ? m.hi : null, allow: m.allow || 0, limit: m.limit || 32 * 1024,
    emitted: 0, maxT: -Infinity, K: undefined, reportK: false, pending: null, pendingEof: false, done: false, eof: false,
    cancelled: false, running: false, waitHi: false, seekT: m.t, retries: 0,
  };
}

async function startSegment(s, m) {
  if (s.cancelled) return;
  const r = await segSeek(s, m.mode, m.t);
  if (r < 0 && !s.first) { s.K = null; s.reportK = true; s.done = true; s.eof = true; segPost(s, [], [], []); return; } // past the end
  if (r < 0) log(`segment seek to ${m.t} returned ${r}`);
  if (s.first && s.lo === -Infinity && m.mode === 'max') {
    // An accurate seek, as seekNow: MPEG-PS/TS land on any packet, also past the target. Go back
    // further (finally to 0) until a picture keyframe at or before the target follows.
    for (let back = 0.5, t = m.t, tries = 1; !s.cancelled; back *= 2, tries++) {
      const { read, key, keyT } = await readToKey(m.t);
      const late = !key || (keyT !== null && keyT > m.t + 1e-3);
      if (!late || t <= 0 || tries >= 8) {
        s.pending = read[1][V.idx] || [];
        s.pendingEof = read[0] === libav.AVERROR_EOF || (read[0] < 0 && read[0] !== -libav.EAGAIN);
        break;
      }
      t = Math.max(0, m.t - back);
      await segSeek(s, 'max', t);
    }
  }
  if (!s.first) {
    // Formats without an index can land anywhere: start decoding at a keyframe packet.
    for (let n = 0; s.pending === null && !s.cancelled; n++) {
      const [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 1 });
      const atEnd = res === libav.AVERROR_EOF || (res < 0 && res !== -libav.EAGAIN);
      const vp = packets[V.idx] || [];
      const i = vp.findIndex((p) => p.flags & AV_PKT_FLAG_KEY);
      const pt = vp.length ? packetTime(vp[vp.length - 1], V.tb) : null;
      // No keyframe within reach (e.g. one IDR per file): the previous segment runs on.
      const far = pt !== null && pt > s.start + 30;
      if (i >= 0) { s.pending = vp.slice(i); s.pendingEof = atEnd; } else if (atEnd || far || n > 20000) {
        s.K = null; s.reportK = true; s.done = true; s.eof = true; segPost(s, [], [], []); return;
      }
    }
  }
  segKick(s);
}

async function segStep(s) {
  let vp;
  let atEnd;
  if (s.pending) {
    vp = s.pending;
    atEnd = s.pendingEof;
    s.pending = null;
  } else {
    const [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit: s.limit });
    atEnd = res === libav.AVERROR_EOF;
    if (res < 0 && !atEnd && res !== -libav.EAGAIN) { log(`segment read result ${res}`); atEnd = true; }
    vp = packets[V.idx] || [];
  }
  if (s.cancelled) return;
  const keys = [];
  for (const p of vp) if (p.flags & AV_PKT_FLAG_KEY) keys.push(packetTime(p, V.tb));
  let raw = await toYuv420(await libav.ff_decode_multi(V.c, V.pkt, V.frame, vp, { fin: atEnd, ignoreErrors: true, copyoutFrame: 'ptr' }));
  if (s.K === undefined) {
    const i = raw.findIndex((f) => isKey(f) && frameTime(f, V.tb) !== null);
    const keepLeading = s.first && s.lo === -Infinity; // exactly like a single worker after a seek
    // Taking over mid-stream needs a keyframe at or before lo. Past lo without
    // one (inexact seeking, or the keyframe is before where the seek landed):
    // go back further, finally to the start; then give up (the pool falls back).
    const late = s.first && s.lo > -Infinity && (i >= 0 ? frameTime(raw[i], V.tb) > s.lo + 1e-6 : raw.some((f) => frameTime(f, V.tb) > s.lo + 1e-6) || atEnd);
    if (late) {
      if (s.seekT <= 0 && s.retries > 0) throw new Error(`no keyframe before ${s.lo}`);
      s.seekT = Math.max(0, s.seekT - (1 << s.retries++));
      const r = await segSeek(s, s.seekT > 0 ? 'max' : 'min', s.seekT);
      if (r < 0) await segSeek(s, 'min', (s.seekT = 0));
      return;
    }
    if (i >= 0) {
      const K = frameTime(raw[i], V.tb);
      s.K = K;
      s.reportK = true;
      if (!s.first) s.lo = Math.max(K, s.start);
      if (!keepLeading) raw = raw.slice(i);
    } else if (!keepLeading) raw = [];
    if (atEnd && s.K === undefined) { s.K = null; s.reportK = true; }
  }
  const frames = raw;
  const out = [];
  const transfer = [];
  for (const f of frames) {
    const t = frameTime(f, V.tb);
    if (t !== null && t < s.lo) continue;
    if (s.hi !== null && t !== null && t >= s.hi) { s.done = true; break; }
    out.push({
      kind: 'yuv', t, width: f.width, height: f.height, data: f.data, layout: f.layout,
      fullRange: f.desc.full || V.fullRange, depth: f.desc.depth, cw: f.desc.cw, ch: f.desc.ch, space: V.space, trc: V.trc, prim: V.prim, recycle: true,
    });
    transfer.push(f.data.buffer);
    s.emitted += f.data.byteLength;
    if (t !== null) s.maxT = Math.max(s.maxT, t);
    if (s.hi === null && t !== null && t >= s.next) s.waitHi = true;
  }
  if (atEnd && !s.done) { s.done = true; s.eof = true; }
  if (s.cancelled) return;
  if (out.length || s.done || s.reportK || keys.length) segPost(s, out, keys, [...new Set(transfer)]);
}

// ---- tracks, stream discard, subtitles (tracks-streams) -------------------
// Every audio and subtitle stream is listed in info.tracks. Streams that are not
// the selected picture, sound or subtitle are set to AVDISCARD_ALL, so the
// demuxer skips their packets. Switching the sound or the subtitle rewinds the
// demuxer a little; packets of the other streams that were already handed out
// are skipped (matched by timestamps and size), so the picture continues as if
// nothing happened. Text subtitles are parsed here and sent as cues ('subs').
// Picture subtitles (PGS, DVB, DVD) are decoded here to palette bitmaps; see
// "picture subtitles" below.

const AVMEDIA_TYPE_SUBTITLE = 3;
const DISPOSITION_DEFAULT = 1;
const DISPOSITION_FORCED = 0x40;
const TEXT_SUBS = new Set(['subrip', 'srt', 'text', 'ass', 'ssa', 'webvtt', 'mov_text']);
const T = { videoOnly: false, keepStreams: false };
// Selected subtitle. cov: time ranges (s) the demuxer has read with each track selected.
// Picture subtitles: c/pkt/frame (decoder), span (see bitmapSpan), video size for the canvas fallback.
const S = { idx: -1, codec: '', text: false, tb: [1, 1], window: 10, cov: new Map(), run: null, maxDur: 0, c: 0, pkt: 0, frame: 0, span: 0, prev: null, vw: 0, vh: 0 };
const utf8 = new TextDecoder('utf-8');

/** AVStream.disposition is not exported by libav.js; read it when the struct layout checks out. */
async function disposition(s) {
  try {
    const w = await libav.copyout_s32(s.ptr, 19);
    // wasm32 AVStream: av_class, index, id, codecpar, priv_data, time_base, start_time,
    // duration, nb_frames, disposition (word 14), discard (15), sample_aspect_ratio, metadata (18)
    if (w[1] !== s.index || w[3] !== s.codecpar || w[15] !== await libav.AVStream_discard(s.ptr) || w[18] !== await libav.AVStream_metadata(s.ptr)) return 0;
    return w[14] >>> 0;
  } catch { return 0; }
}

/**
 * The container's frame rate (AVStream.avg_frame_rate) and frame count (nb_frames, the sample table of MP4),
 * 0 when it states none. libav.js has no getters for them: read the struct, with the same layout check as
 * disposition() (wasm32: ... metadata word 18, avg_frame_rate num/den words 19-20, nb_frames int64 words 12-13).
 */
async function streamRate(s) {
  try {
    const w = await libav.copyout_s32(s.ptr, 21);
    if (w[1] !== s.index || w[3] !== s.codecpar || w[15] !== await libav.AVStream_discard(s.ptr) || w[18] !== await libav.AVStream_metadata(s.ptr)) return { fps: 0, frames: 0 };
    const fps = w[19] > 0 && w[20] > 0 ? w[19] / w[20] : 0;
    const frames = w[13] === 0 && w[12] > 0 ? w[12] : 0;
    return { fps: fps > 0 && fps < 1000 ? fps : 0, frames };
  } catch { return { fps: 0, frames: 0 }; }
}

async function listTracks() {
  const out = { audio: [], sub: [] };
  for (const s of streams) {
    if (s.codec_type !== AVMEDIA_TYPE_AUDIO && s.codec_type !== AVMEDIA_TYPE_SUBTITLE) continue;
    const md = s.metadata || {};
    const disp = await disposition(s);
    const codec = await libav.avcodec_get_name(s.codec_id);
    const lang = md.language && md.language !== 'und' ? md.language : '';
    let title = md.title || md.handler_name || '';
    if (/^(Sound|Subtitle|Text)Handler$/.test(title)) title = '';
    const base = { id: s.index, codec, lang, title, default: !!(disp & DISPOSITION_DEFAULT), forced: !!(disp & DISPOSITION_FORCED) };
    const cp = await libav.ff_copyout_codecpar(s.codecpar);
    if (s.codec_type === AVMEDIA_TYPE_AUDIO) {
      out.audio.push({ ...base, channels: cp.ch_layout_nb_channels || cp.channels || 0, sampleRate: cp.sample_rate, extradata: cp.extradata || null });
    } else {
      const sub = { ...base, kind: TEXT_SUBS.has(codec) ? 'text' : 'bitmap' };
      if ((codec === 'ass' || codec === 'ssa') && cp.extradata) sub.header = utf8.decode(cp.extradata);
      out.sub.push(sub);
    }
  }
  return out;
}

/** The sound played first: the default-flagged track, else the first. */
function preferredAudio(list) {
  const d = list.find((a) => a.default);
  return d ? d.id : list.length ? list[0].id : -1;
}

/** Discards every stream that is not the selected picture, sound or subtitle. */
async function applyDiscard() {
  if (!fmt) return;
  for (const s of streams) {
    let keep;
    if (T.videoOnly) keep = s.index === V.idx;
    else if (T.keepStreams) keep = !(s.index === V.idx && V.off);
    else keep = (s.index === V.idx && V.mode !== 'none' && !V.off) || (s.index === A.idx && A.mode !== 'none') || s.index === S.idx;
    await discard(s.index, !keep);
  }
}

// ---- rewinding without repeating the picture ----

const pktKey = (p) => `${p.pts}/${p.ptshi}/${p.dts}/${p.dtshi}/${p.data ? p.data.byteLength : 0}`;

/** Drops packets of X handed out before a rewind; records the last one handed out. */
function afterRewind(X, list) {
  if (X.skip && list.length) {
    const i = list.findIndex((p) => pktKey(p) === X.skip.key);
    if (i >= 0) { list = list.slice(X.skip.incl ? i : i + 1); X.skip = null; } else {
      // Passed it without a match (inexact seek): continue after its time.
      const j = list.findIndex((p) => { const t = packetTime(p, X.tb); return t !== null && X.skip.t !== null && (X.skip.incl ? t >= X.skip.t - 1e-6 : t > X.skip.t + 2); });
      if (j < 0) return [];
      log(`rewind: stream ${X.idx} did not find its last packet again; continuing at ${packetTime(list[j], X.tb)}`);
      list = list.slice(j);
      X.skip = null;
    }
  }
  if (list.length) {
    const p = list[list.length - 1];
    X.last = { key: pktKey(p), t: packetTime(p, X.tb) };
  }
  return list;
}

/**
 * Seeks the demuxer back to t at most, for a new sound or subtitle track. The
 * picture (and the sound, when it stays) continue after the packets already
 * handed out. Returns false when that can't be done safely.
 */
async function rewind(t, keepAudio) {
  // Packets read by seek() but not handed out yet: continue at their first one (kept) instead.
  const pend = pendingRead && pendingRead[1];
  const firstPending = (X) => {
    const p = pend && pend[X.idx] && pend[X.idx][0];
    return p ? { key: pktKey(p), t: packetTime(p, X.tb), incl: true } : null;
  };
  const skips = [];
  for (const X of [V, ...(keepAudio ? [A] : [])]) {
    if (X.idx < 0 || X.mode === 'none' || (X === V && V.off)) continue;
    const mark = firstPending(X) || (pend ? null : X.last);
    if (mark) skips.push([X, mark]);
  }
  let target = t;
  for (const [, mark] of skips) {
    if (mark.t === null) return false;
    target = Math.min(target, mark.t);
  }
  endRun();
  const ts = Math.max(0, Math.round(target * 1e6));
  const [lo, hi] = libav.f64toi64(ts);
  const r = await libav.avformat_seek_file_max(fmt, -1, lo, hi, 0);
  if (r < 0) { log(`rewind to ${target} returned ${r}`); return false; }
  pendingRead = null;
  readPos = target;
  for (const [X, mark] of skips) X.skip = mark;
  if (!keepAudio && A.mode === 'soft' && A.c) await libav.avcodec_flush_buffers(A.c);
  eof = false;
  V.drained = false;
  A.drained = false;
  return true;
}

// ---- sound track ----

async function selectAudio(m) {
  const st = streams.find((s) => s.index === m.id && s.codec_type === AVMEDIA_TYPE_AUDIO);
  if (!st || T.videoOnly) throw new Error(`no audio stream ${m.id}`);
  if (A.mode === 'soft' && A.c) { await libav.ff_free_decoder(A.c, A.pkt, A.frame); A.c = 0; }
  A.idx = st.index;
  A.tb = [st.time_base_num, st.time_base_den];
  A.mode = m.mode;
  A.last = null;
  A.skip = null;
  let error;
  if (A.mode === 'soft') {
    try {
      [, A.c, A.pkt, A.frame] = await libav.ff_init_decoder(st.codec_id, { codecpar: st.codecpar, time_base: A.tb });
    } catch (err) {
      A.mode = 'none';
      error = `no audio decoder for this codec in the built-in decoder (${err && err.message || err})`;
    }
  }
  await applyDiscard();
  const rewound = A.mode !== 'none' && typeof m.t === 'number' ? await rewind(m.t, false) : false;
  post({ type: 'audioSelected', id: A.idx, audio: A.mode, audioError: error, rewound });
}

// ---- dropping non-reference frames when behind (Movi) ----

async function skipNonRef(m) {
  if (V.mode !== 'soft' || !V.c) return;
  // AVCodecContext.skip_frame has no libav.js accessor; it is an AVOption.
  const r = await libav.av_opt_set(V.c, 'skip_frame', m.on ? '8' : '0', 0); // AVDISCARD_NONREF ("noref") / AVDISCARD_DEFAULT
  if (r < 0) log(`skip_frame ${m.on ? 'nonref' : 'default'} failed: ${r}`);
}

// ---- fast preview when behind (opt-in) ----
// skip_loop_filter = all: HEVC and H.264 leave out deblocking (and HEVC SAO), about 1.2-1.5x
// faster at 4K. The picture is approximate (the error builds up until the next keyframe), so
// the engine uses it only while playing behind real time and decodes exactly again (a re-seek)
// as soon as playback pauses. Other decoders (AV1, VP9, ProRes...) ignore the option.
async function fastDecode(m) {
  V.fast = !!m.on;
  if (V.mode !== 'soft' || !V.c) return;
  const r = await libav.av_opt_set(V.c, 'skip_loop_filter', m.on ? '48' : '0', 0); // AVDISCARD_ALL / AVDISCARD_DEFAULT
  if (r < 0) log(`skip_loop_filter ${m.on ? 'all' : 'default'} failed: ${r}`);
}

// ---- H.264 entry points (WebCodecs needs an IDR after configure/flush) ----

/** Open-GOP H.264 without IDRs to start WebCodecs at: the engine falls back to software. */
async function videoToSoft() {
  let error;
  if (V.idx >= 0 && V.mode !== 'soft') {
    try {
      const st = streams.find((s) => s.index === V.idx);
      [, V.c, V.pkt, V.frame] = await libav.ff_init_decoder(st.codec_id, { codecpar: st.codecpar, time_base: V.tb });
      V.mode = 'soft';
      V.drained = false;
    } catch (err) { error = String(err && err.message || err); }
  }
  post({ type: 'videoMode', video: V.mode, error });
}

/** True when a key packet holds an IDR slice, false for a recovery-point I-frame (open GOP). */
function isIdr(d) {
  if (V.codec !== 'h264' || !d) return undefined;
  const nal = (i) => d[i] & 0x1f;
  if (V.nalLen) {
    for (let i = 0; i + V.nalLen < d.length;) {
      let n = 0;
      for (let k = 0; k < V.nalLen; k++) n = n * 256 + d[i + k];
      const t = nal(i + V.nalLen);
      if (t === 5) return true;
      if (t === 1) return false;
      i += V.nalLen + n;
    }
    return undefined;
  }
  for (let i = 0; i + 3 < d.length; i++) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      const t = nal(i + 3);
      if (t === 5) return true;
      if (t === 1) return false;
      i += 2;
    }
  }
  return undefined;
}

// ---- subtitles ----

async function selectSub(m) {
  const want = typeof m.id === 'number' && m.id >= 0;
  const st = want ? streams.find((s) => s.index === m.id && s.codec_type === AVMEDIA_TYPE_SUBTITLE) : null;
  if (want && !st) throw new Error(`no subtitle stream ${m.id}`);
  endRun();
  if (S.c) { try { await libav.ff_free_decoder(S.c, S.pkt, S.frame); } catch { /* freed */ } S.c = 0; }
  S.idx = st ? st.index : -1;
  S.codec = st ? await libav.avcodec_get_name(st.codec_id) : '';
  S.text = TEXT_SUBS.has(S.codec);
  S.tb = st ? [st.time_base_num, st.time_base_den] : [1, 1];
  S.maxDur = 0;
  S.window = 10;
  let error;
  if (st && !S.text) {
    try {
      [, S.c, S.pkt, S.frame] = await libav.ff_init_decoder(st.codec_id, { codecpar: st.codecpar, time_base: S.tb });
    } catch (err) { S.c = 0; error = `no decoder for ${S.codec} subtitles (${err && err.message || err})`; }
    const vs = streams.find((s) => s.index === V.idx);
    const cp = vs ? await libav.ff_copyout_codecpar(vs.codecpar) : null;
    S.vw = cp ? cp.width : 0;
    S.vh = cp ? cp.height : 0;
    if (S.c) await bitmapSpan();
  }
  await applyDiscard();
  let rewound = false;
  // Cues that started before now may still be showing: read them again.
  // Covered only up to where the demuxer is now: read on from there with this track discarded, its cues are missing.
  // Picture subtitles always read again: the overlay keeps only the pictures of one contiguous read (bitmapSpan).
  if (st && (S.text ? !covered(m.t, readPos) : S.c) && typeof m.t === 'number') rewound = await rewind(Math.max(0, m.t - S.window), true);
  post({ type: 'subSelected', id: S.idx, kind: st ? (S.text ? 'text' : 'bitmap') : null, rewound, error });
}

/** ASS event text to plain text: drops {override} blocks; \N and \n break lines. */
const assPlain = (t) => t.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');

function subCue(p) {
  const start = packetTime(p, S.tb);
  if (start === null || !p.data) return null;
  const dur = f64(p.duration, p.durationhi) * S.tb[0] / S.tb[1];
  const d = p.data;
  let raw;
  if (S.codec === 'mov_text') {
    if (d.length < 2) return null;
    raw = utf8.decode(d.subarray(2, 2 + ((d[0] << 8) | d[1]))); // 16-bit length, then style boxes
  } else raw = utf8.decode(d);
  raw = raw.replace(/\0+$/, '');
  const cue = { start, end: dur > 0 ? start + dur : start + 5, text: raw };
  if (S.codec === 'ass' || S.codec === 'ssa') {
    // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    let i = -1;
    for (let k = 0; k < 8; k++) { i = raw.indexOf(',', i + 1); if (i < 0) break; }
    cue.ass = raw;
    cue.text = assPlain(i >= 0 ? raw.slice(i + 1) : raw);
  }
  if (!cue.text.trim()) return null; // mov_text "clear" samples
  if (dur > S.maxDur) S.maxDur = dur;
  return cue;
}

/** Cues from the selected subtitle's packets; also records which times have been read. */
async function onSubPackets(sp, all, prescan) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of Object.keys(all)) {
    const list = all[k];
    const st = streams[k];
    if (!list || !list.length || !st) continue;
    const tb = [st.time_base_num, st.time_base_den];
    const a = packetTime(list[0], tb);
    const b = packetTime(list[list.length - 1], tb);
    if (a !== null) lo = Math.min(lo, a);
    if (b !== null) hi = Math.max(hi, b);
  }
  if (lo <= hi) {
    if (!S.run) S.run = [lo, hi]; else S.run[1] = Math.max(S.run[1], hi);
  }
  if (!sp || !sp.length) return;
  if (!S.text) { if (S.c) await bitmapPackets(sp); return; }
  const cues = [];
  for (const p of sp) { const c = subCue(p); if (c) cues.push(c); }
  if (cues.length) post({ type: 'subs', id: S.idx, cues, prescan });
  S.window = Math.min(30, Math.max(10, S.maxDur + 1));
}

/** Closes the current contiguous read and merges it into the track's covered ranges. */
function endRun() {
  if (S.idx < 0 || !S.run) { S.run = null; return; }
  const list = S.cov.get(S.idx) || [];
  list.push(S.run);
  list.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of list) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 0.5) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]);
  }
  S.cov.set(S.idx, merged);
  S.run = null;
}

/** Cues that can still be showing at t, and those up to `upto` (where reading continues), have all been read already. */
function covered(t, upto = t) {
  endRun();
  const list = S.cov.get(S.idx) || [];
  return list.some((r) => r[0] <= Math.max(0, t - S.window) + 1e-3 && r[1] >= Math.max(t, upto) - 0.5);
}

/** The latest packet time of a read (any stream). */
function lastTime(all) {
  let hi = -Infinity;
  for (const k of Object.keys(all)) {
    const list = all[k];
    const st = streams[k];
    if (!list || !list.length || !st) continue;
    const b = packetTime(list[list.length - 1], [st.time_base_num, st.time_base_den]);
    if (b !== null && b > hi) hi = b;
  }
  return hi;
}

/**
 * Before a seek: cues that started up to S.window before t (and may still show)
 * are read with every other stream but one discarded (its timestamps tell when to
 * stop). Skipped when those times were read before (text only: picture
 * subtitles start a new span and always read again).
 */
async function subPrescan(t) {
  endRun();
  if (S.idx < 0) return;
  if (!S.text) { if (!S.c) return; await bitmapSpan(); } else if (covered(t)) return;
  // The picture's packets time the read also when this worker doesn't decode it (V.off: the pool's primary on a silent video).
  const clock = A.idx >= 0 && A.mode !== 'none' ? A : V.idx >= 0 && V.tb ? V : null;
  if (!clock) return;
  const t0 = performance.now();
  for (const s of streams) await discard(s.index, s.index !== clock.idx && s.index !== S.idx);
  const [lo, hi] = libav.f64toi64(Math.max(0, Math.round((t - S.window) * 1e6)));
  let n = 0;
  if (await libav.avformat_seek_file_max(fmt, -1, lo, hi, 0) >= 0) {
    for (; n < 5000; n++) {
      const [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 16 * 1024 });
      await onSubPackets(packets[S.idx], packets, true);
      const cp = packets[clock.idx] || [];
      const ct = cp.length ? packetTime(cp[cp.length - 1], clock.tb) : null;
      if (res < 0 && res !== -libav.EAGAIN) break;
      if (ct !== null && ct >= t) break;
    }
  }
  endRun();
  await applyDiscard();
  log(`subtitles: read ${S.window} s before ${t.toFixed(2)} in ${(performance.now() - t0).toFixed(0)} ms (${n + 1} reads)`);
}

// ---- picture subtitles (PGS, DVB, DVD) ----
// Decoded here to palette bitmaps (one byte per pixel plus the rect's palette,
// 0xAARRGGBB); the overlay turns the shown one into RGBA (subtitles.js). Each
// picture replaces the one before it: PGS has no end times (an empty display set
// clears the screen), DVB pages time out and ffmpeg-made streams send a clearing
// page, DVD has stop times. Empty subtitles are sent too, as cues without rects.
// A span is one contiguous read of the track, from a seek (prescan) or a track
// switch on. The overlay drops pictures of older spans, so "shown until the next
// one" never joins two pictures across a part that was not read.

const NO_END = 0xffffffff;

/** Starts a new span: tells the overlay, and resets the decoder (PGS keeps objects between display sets). */
async function bitmapSpan() {
  S.span++;
  S.prev = null;
  try { await libav.avcodec_flush_buffers(S.c); } catch { /* nothing to flush */ }
  post({ type: 'subs', id: S.idx, bitmap: true, span: S.span, gen, cues: [] });
}

/** DVB in MPEG-TS: the PES data starts with data_identifier 0x20 and stream id 0, which libav's dvbsub parser (not in this build) strips. */
function dvbPayload(p) {
  const d = p.data;
  if (S.codec !== 'dvb_subtitle' || !d || d.length < 3 || d[0] !== 0x20 || d[1] !== 0x00 || d[2] !== 0x0f) return p;
  return { ...p, data: d.subarray(2, d[d.length - 1] === 0xff ? d.length - 1 : d.length) };
}

/** Decodes picture subtitle packets and posts them as cues {start, end|null, rects, frame: [w, h]}. */
async function bitmapPackets(sp) {
  let subs;
  try {
    subs = await libav.ff_decode_subtitle_multi(S.c, S.pkt, sp.map(dvbPayload), { ignoreErrors: true });
  } catch (err) { log(`subtitle decode: ${err && err.message || err}`); return; }
  if (!subs.length) return;
  // The subtitle canvas: PGS and DVB (display definition) set it; DVB without one is 720x576; else the video's size.
  let fw = await libav.AVCodecContext_width(S.c);
  let fh = await libav.AVCodecContext_height(S.c);
  if (!(fw > 0 && fh > 0)) [fw, fh] = S.codec === 'dvb_subtitle' || !(S.vw > 0 && S.vh > 0) ? [720, 576] : [S.vw, S.vh];
  const cues = [];
  const transfer = [];
  for (const s of subs) {
    const base = packetTime(s, S.tb, false);
    if (base === null) continue;
    const start = base + s.start_display_time / 1000;
    let end = s.end_display_time !== NO_END && s.end_display_time > s.start_display_time ? base + s.end_display_time / 1000 : null;
    const dur = f64(s.duration, s.durationhi) * S.tb[0] / S.tb[1];
    if (end === null && dur > 0) end = base + dur;
    const rects = [];
    let w = fw;
    let h = fh;
    for (const r of s.rects) {
      if (!r.bitmap || !r.palette || !(r.w > 0 && r.h > 0)) continue;
      rects.push({ x: r.x, y: r.y, w: r.w, h: r.h, bitmap: r.bitmap, palette: r.palette });
      transfer.push(r.bitmap.buffer, r.palette.buffer);
      w = Math.max(w, r.x + r.w);
      h = Math.max(h, r.y + r.h);
    }
    // How long pictures stay (for the prescan window): until their end or the next one.
    const p = S.prev;
    if (p && p.shown && start > p.start) S.maxDur = Math.max(S.maxDur, Math.min(p.end === null ? Infinity : p.end, start) - p.start);
    if (rects.length && end !== null) S.maxDur = Math.max(S.maxDur, end - start);
    S.prev = { start, end, shown: rects.length > 0 };
    cues.push({ start, end, rects, frame: [w, h] });
  }
  S.window = Math.min(30, Math.max(10, Math.min(30, S.maxDur) + 1));
  if (cues.length) post({ type: 'subs', id: S.idx, bitmap: true, span: S.span, gen, cues }, transfer);
}

// ---- xray: chapters ---------------------------------------------------------
// Chapter marks (MKV/MP4/OGG...) for the seek bar: [{start, end, title}] in
// seconds on the file's clock (same as frame times). Same code in xray-worker.js.
async function xrayChapters() {
  const out = [];
  try {
    const n = Math.min(await libav.AVFormatContext_nb_chapters(fmt), 2000);
    for (let i = 0; i < n; i++) {
      const c = await libav.AVFormatContext_chapters_a(fmt, i);
      const tb = (await libav.AVChapter_time_base_num(c)) / (await libav.AVChapter_time_base_den(c));
      const start = f64(await libav.AVChapter_start(c), await libav.AVChapter_starthi(c)) * tb;
      const end = f64(await libav.AVChapter_end(c), await libav.AVChapter_endhi(c)) * tb;
      const md = await libav.ff_copyout_dict(await libav.AVChapter_metadata(c));
      if (isFinite(start)) out.push({ start, end, title: (md && (md.title || md.TITLE)) || '' });
    }
  } catch (e) { log(`chapters: ${e && e.message || e}`); }
  return out.sort((a, b) => a.start - b.start);
}
// ---- end xray

// Remote Opus batches include 80 ms of preroll and explicit sample trimming. No WebCodecs
// audio support is needed, and a seek cannot inherit decoder state from the previous timeline.
async function remoteAudio(m) {
  const audio = [];
  for (const it of m.audio) {
    if (it.kind !== 'opus') { audio.push(it); continue; }
    const [, c, pkt, frame] = await libav.ff_init_decoder('opus', {
      codecpar: { codec_type: 1, sample_rate: 48000, channels: 2, channel_layout: 3, extradata: it.head },
      time_base: [1, 48000],
    });
    try {
      const frames = await libav.ff_decode_multi(c, pkt, frame,
        it.packets.map((data) => ({ data })), { fin: true });
      const planes = [new Float32Array(it.samples), new Float32Array(it.samples)];
      let pos = 0;
      for (const f of frames) {
        const decoded = audioToFloat(f);
        const lo = Math.max(0, it.skip - pos);
        const hi = Math.min(f.nb_samples, it.skip + it.samples - pos);
        if (hi > lo) for (let ch = 0; ch < 2; ch++) {
          planes[ch].set(decoded[ch].subarray(lo, hi), pos + lo - it.skip);
        }
        pos += f.nb_samples;
      }
      if (pos < it.skip + it.samples) throw new Error('Short remote Opus decode');
      audio.push({ kind: 'pcm', t: it.t, sampleRate: 48000, planes });
    } finally { await libav.ff_free_decoder(c, pkt, frame); }
  }
  post({ type: 'remoteAudio', id: m.id, audio },
    audio.flatMap((it) => (it.planes || []).map((p) => p.buffer)));
}
