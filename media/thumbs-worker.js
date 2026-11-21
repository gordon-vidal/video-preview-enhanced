// Seek-bar thumbnail worker: a second, keyframe-only libav.js instance, started
// by thumbs.js on the first hover. Separate from decoder-worker.js so playback
// never waits on it. For a request at time t it seeks to the latest keyframe at
// or before t, decodes that one picture in software (also H.264/VP8, which
// playback sends to WebCodecs), scales it down with swscale and returns packed
// RGBA. File reads go through the engine's block cache as reader 'thumbs'.
'use strict';

const AVMEDIA_TYPE_VIDEO = 0;
const AV_PKT_FLAG_KEY = 1;
const AV_PIX_FMT_RGBA = 26;
const SWS_BILINEAR = 2;
const BLOCK = 1 << 20;
const MAX_PACKETS = 400; // packets read looking for a keyframe before giving up

let libav = null;
let fmt = 0;
let pkt = 0;
const V = { idx: -1, c: 0, pkt: 0, frame: 0, tb: [1, 1], sws: 0, swsKey: '', dst: 0 };
const known = new Set(); // keyframe times main already has (it says when it drops one)
let cancelBelow = 0; // requests with a smaller id are stale

const post = (m, transfer) => self.postMessage(m, transfer || []);
const log = (msg) => post({ type: 'log', msg: `thumbs: ${msg}` });

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'block') {
    if (libav) libav.ff_block_reader_dev_send('in', m.pos, m.data.byteLength ? m.data : null);
    return;
  }
  // Acted on at once, between libav calls: a newer hover makes older requests stale.
  if (m.type === 'cancel') { cancelBelow = Math.max(cancelBelow, m.below); return; }
  if (m.type === 'forget') { known.delete(m.kt); return; }
  serial(async () => {
    try {
      switch (m.type) {
        case 'init': return await init(m);
        case 'open': return await open(m);
        case 'thumb': return await thumb(m);
        default: return undefined;
      }
    } catch (err) {
      post({ type: 'error', where: m.type, id: m.id, message: String(err && err.message || err) });
      return undefined;
    }
  });
};

/**
 * The page compiled the decoder once and sent the WebAssembly.Module: V8 shares its compiled code between
 * the workers, so each extra worker (pool, thumbnails) skips the compile. libav.js's own loader fetches
 * and compiles the wasm by URL with instantiateStreaming; this answers that one call from the module
 * (any failure falls back to the URL path).
 */
function useSharedModule(mod) {
  if (!mod || typeof WebAssembly.instantiateStreaming !== 'function') return () => {};
  const orig = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async function (source, imports) {
    WebAssembly.instantiateStreaming = orig;
    try { return { module: mod, instance: await WebAssembly.instantiate(mod, imports) }; } catch (e) { return orig.call(WebAssembly, source, imports); }
  };
  return () => { if (WebAssembly.instantiateStreaming !== orig) WebAssembly.instantiateStreaming = orig; };
}

async function init(m) {
  self.LibAV = {};
  importScripts(m.loader);
  const restore = useSharedModule(m.wasmModule);
  try {
    libav = await self.LibAV.LibAV({ noworker: true, nothreads: true, toImport: m.toImport, wasmurl: m.wasmurl, variant: m.variant });
  } finally { restore(); }
  post({ type: 'ready' });
}

const f64 = (lo, hi) => libav.i64tof64(lo || 0, hi || 0);
const noTs = (lo, hi) => lo === undefined || (lo === libav.AV_NOPTS_VALUE_LO && hi === libav.AV_NOPTS_VALUE_HI);

async function open(m) {
  libav.onblockread = (name, pos, len) => post({ type: 'read', pos, len: Math.max(len, BLOCK) });
  await libav.mkblockreaderdev('in', m.size);
  let streams;
  [fmt, streams] = await libav.ff_init_demuxer_file('in');
  pkt = await libav.av_packet_alloc();
  for (const s of streams) {
    if (s.codec_type !== AVMEDIA_TYPE_VIDEO || V.idx >= 0) continue;
    const cp = await libav.ff_copyout_codecpar(s.codecpar);
    const name = await libav.avcodec_get_name(s.codec_id);
    // Same rule as decoder-worker.js: cover art is not the video.
    const coverArt = /^(png|bmp|gif)$/.test(name) || (name === 'mjpeg' && s.duration_time_base <= 1);
    if (cp.width > 0 && !coverArt) { V.idx = s.index; V.tb = [s.time_base_num, s.time_base_den]; V.codec = name; }
  }
  if (V.idx < 0) { post({ type: 'opened', ok: false, why: 'no video stream' }); return; }
  // Only the picture's packets are read; sound and other streams are skipped in the demuxer.
  for (const s of streams) {
    if (s.index === V.idx) continue;
    await libav.AVStream_discard_s(await libav.AVFormatContext_streams_a(fmt, s.index), 48); // AVDISCARD_ALL
  }
  const st = streams.find((s) => s.index === V.idx);
  [, V.c, V.pkt, V.frame] = await libav.ff_init_decoder(st.codec_id, { codecpar: st.codecpar, time_base: V.tb });
  // Keyframes only: anything else that reaches the decoder is dropped unparsed.
  const r = await libav.av_opt_set(V.c, 'skip_frame', 'nokey', 0);
  if (r < 0) log(`skip_frame not set (${r})`);
  V.dst = await libav.av_frame_alloc();
  const d = await libav.AVFormatContext_duration(fmt);
  const st0 = await libav.AVFormatContext_start_time(fmt);
  post({ type: 'opened', ok: true, codec: V.codec, duration: d > 0 && d < 1e15 ? d / 1e6 : 0, start: st0 > 0 && st0 < 1e15 ? st0 / 1e6 : 0 });
}

function packetTime(p) {
  if (!noTs(p.pts, p.ptshi)) return f64(p.pts, p.ptshi) * V.tb[0] / V.tb[1];
  if (!noTs(p.dts, p.dtshi)) return f64(p.dts, p.dtshi) * V.tb[0] / V.tb[1];
  return null;
}

async function seekTo(t, mode) {
  const [lo, hi] = libav.f64toi64(Math.max(0, Math.round(t * 1e6)));
  return mode === 'min' ? libav.avformat_seek_file_min(fmt, -1, lo, hi, 0) : libav.avformat_seek_file_max(fmt, -1, lo, hi, 0);
}

/** One thumbnail: m = {id, t (absolute seconds), w, h (box)}. */
async function thumb(m) {
  const t0 = Date.now();
  const stale = () => m.id < cancelBelow;
  if (stale()) { post({ type: 'thumb', id: m.id, cancelled: true }); return; }
  let frames = [];
  let kt = null;
  // Formats without an index (MPEG-TS, some MKV) can land past the keyframe:
  // step back (2, 6, 14 s ...) and finally to the start before giving up.
  for (let back = 0, tries = 0; !frames.length && tries < 6; tries++) {
    const t = m.t - back;
    if ((await seekTo(Math.max(0, t), t > 0 ? 'max' : 'min')) < 0 && t > 0) await seekTo(t, 'min');
    await libav.avcodec_flush_buffers(V.c);
    for (let n = 0; n < MAX_PACKETS && !frames.length; n++) {
      if (stale()) { post({ type: 'thumb', id: m.id, cancelled: true }); return; }
      const [res, packets] = await libav.ff_read_frame_multi(fmt, pkt, { limit: 1 });
      const atEnd = res === libav.AVERROR_EOF || (res < 0 && res !== -libav.EAGAIN);
      const key = (packets[V.idx] || []).filter((p) => p.flags & AV_PKT_FLAG_KEY);
      if (key.length) {
        const p = key[0];
        kt = packetTime(p);
        if (kt !== null && known.has(kt)) { post({ type: 'thumb', id: m.id, kt, known: true, ms: Date.now() - t0 }); return; }
        // Decode just this packet and drain the decoder (no reordering wait).
        frames = await libav.ff_decode_multi(V.c, V.pkt, V.frame, [p], { fin: true, ignoreErrors: true, copyoutFrame: 'ptr' });
        await libav.avcodec_flush_buffers(V.c);
      }
      if (atEnd) break;
    }
    if (t <= 0) break;
    back = back * 2 + 2;
  }
  if (!frames.length) { post({ type: 'thumb', id: m.id, kt: null, ms: Date.now() - t0 }); return; }
  try {
    const out = await scale(frames[0], m.w, m.h);
    if (kt === null) kt = out.t;
    if (kt !== null) known.add(kt);
    post({ type: 'thumb', id: m.id, kt, w: out.w, h: out.h, data: out.data, ms: Date.now() - t0 }, [out.data.buffer]);
  } finally {
    for (const f of frames) await libav.av_frame_free_js(f);
  }
}

/** swscale to RGBA inside the box, keeping the display aspect (sample aspect ratio). */
async function scale(src, boxW, boxH) {
  const sw = await libav.AVFrame_width(src);
  const sh = await libav.AVFrame_height(src);
  const sf = await libav.AVFrame_format(src);
  const sarN = await libav.AVFrame_sample_aspect_ratio_num(src);
  const sarD = await libav.AVFrame_sample_aspect_ratio_den(src);
  const sar = sarN > 0 && sarD > 0 ? sarN / sarD : 1;
  const aspect = (sw * sar) / sh;
  let w = boxW;
  let h = Math.round(w / aspect);
  if (h > boxH) { h = boxH; w = Math.round(h * aspect); }
  w = Math.max(2, w & ~1);
  h = Math.max(2, h & ~1);
  const key = `${sw}x${sh}:${sf}>${w}x${h}`;
  if (key !== V.swsKey) {
    if (V.sws) await libav.sws_freeContext(V.sws);
    V.sws = await libav.sws_getContext(sw, sh, sf, w, h, AV_PIX_FMT_RGBA, SWS_BILINEAR, 0, 0, 0);
    V.swsKey = key;
    if (!V.sws) throw new Error(`no scaler for format ${sf}`);
  }
  await libav.av_frame_unref(V.dst);
  await libav.AVFrame_width_s(V.dst, w);
  await libav.AVFrame_height_s(V.dst, h);
  await libav.AVFrame_format_s(V.dst, AV_PIX_FMT_RGBA);
  const r = await libav.sws_scale_frame(V.sws, V.dst, src);
  if (r < 0) throw new Error(`scale failed (${r})`);
  const out = await libav.ff_copyout_frame_video_packed(V.dst);
  const lo = await libav.AVFrame_pts(src);
  const hi = await libav.AVFrame_ptshi(src);
  return { w, h, data: out.data, t: noTs(lo, hi) ? null : f64(lo, hi) * V.tb[0] / V.tb[1] };
}
