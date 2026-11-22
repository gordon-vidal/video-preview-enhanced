'use strict';

const fs = require('fs');
const { hevcFormat, av1Format, pixelFormat } = require('./sniff-codecs');

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const CODECS = new Map([['V_MPEGH/ISO/HEVC', 'hevc'], ['V_VP9', 'vp9'], ['V_AV1', 'av1']]);

// The length marker stays in IDs, but is removed from sizes and block track numbers.
function vint(b, p, end, id = false) {
  const first = b[p];
  let width = 1;
  let mask = 128;
  while (mask && !(first & mask)) { width++; mask >>= 1; }
  if (!mask || p + width > end || (id && width > 4)) throw new Error('invalid EBML integer');
  let value = id ? first : first & (mask - 1);
  let unknown = !id && value === mask - 1;
  for (let i = 1; i < width; i++) {
    value = value * 256 + b[p + i];
    unknown = unknown && b[p + i] === 255;
  }
  if (unknown || !Number.isSafeInteger(value)) throw new Error('unbounded EBML integer');
  return { value, next: p + width };
}

function* elements(b, start, end) {
  for (let p = start; p < end;) {
    const id = vint(b, p, end, true);
    const size = vint(b, id.next, end);
    p = size.next + size.value;
    if (p > end) throw new Error('truncated EBML element');
    yield { id: id.value, start: size.next, end: p };
  }
}

function fields(b, box) {
  const out = new Map();
  for (const x of elements(b, box.start, box.end)) {
    if (out.has(x.id) && x.id !== 0xec) throw new Error('repeated EBML field');
    out.set(x.id, x);
  }
  return out;
}

function uint(b, x, fallback = 0) {
  if (!x) return fallback;
  if (x.end - x.start > 6) throw new Error('large EBML integer');
  let n = 0;
  for (let p = x.start; p < x.end; p++) n = n * 256 + b[p];
  return n;
}

function vp9Keyframe(b) {
  if (b.length < 5 || (b[0] & 0xc0) !== 0x80 || (b[0] & 0x0c) || b.readUIntBE(1, 3) !== 0x498342) return null;
  const profile = (b[0] >> 5 & 1) + (b[0] >> 3 & 2);
  // Profiles 0 and 2 have implicit 4:2:0. RGB requires a different profile.
  if (profile === 0 && b[4] >> 5 !== 7) return 'yuv420p';
  if (profile === 2 && (b[4] >> 4 & 7) !== 7) return pixelFormat(420, b[4] & 0x80 ? 12 : 10);
  return null;
}

function trackInfo(b, box, index) {
  const t = fields(b, box);
  const type = uint(b, t.get(0x83));
  const number = uint(b, t.get(0xd7));
  if (!number || (type !== 1 && type !== 2) || t.has(0x6d80) || t.has(0x23314f)) return null;
  if (type === 2) return { index, number };
  const v = t.get(0xe0);
  const id = t.get(0x86);
  if (!v || !id) return null;
  const codec = CODECS.get(b.toString('latin1', id.start, id.end));
  if (!codec) return null;
  const f = fields(b, v);
  const width = uint(b, f.get(0xb0));
  const height = uint(b, f.get(0xba));
  const period = uint(b, t.get(0x23e383));
  if (width < 2 || height < 2 || width > 65535 || height > 65535 || width % 2 || height % 2 ||
      !period || uint(b, f.get(0x53c0)) || [0x54aa, 0x54bb, 0x54cc, 0x54dd].some((key) => f.has(key))) return null;
  // DefaultDuration is rounded to a whole nanosecond. Recover common rates exactly
  // so native uses the same rate as ffprobe when it adopts the early process.
  const nominal = 1e9 / period;
  const fps = [Math.round(nominal), Math.round(nominal * 1001 / 1000) * 1000 / 1001]
    .find((rate) => rate > 0 && rate < 1000 && Math.abs(1e9 / rate - period) <= 1);
  if (!fps) return null;
  const cp = t.get(0x63a2);
  const config = cp ? b.subarray(cp.start, cp.end) : Buffer.alloc(0);
  const pixFmt = codec === 'hevc' ? hevcFormat(config) : codec === 'av1' ? av1Format(config) : null;
  if (!pixFmt && codec !== 'vp9') return null;
  return { index, number, codec, width, height, fps, pixFmt };
}

function checkCluster(b, box, video, audio, scale, times) {
  let base;
  for (const x of elements(b, box.start, box.end)) {
    if (x.id === 0xe7) {
      if (base !== undefined) return false;
      base = uint(b, x);
      continue;
    }
    if (x.id !== 0xa3 && x.id !== 0xa0) continue;
    const group = x.id === 0xa0 ? fields(b, x) : null;
    const block = group ? group.get(0xa1) : x;
    if (base === undefined || !block) return false;
    const track = vint(b, block.start, block.end);
    if (track.value === audio?.number) continue;
    const p = track.next;
    if (track.value !== video.number || p + 4 > block.end || (b[p + 2] & 0x0e) ||
        group?.has(0x75a1) || times.length >= 32768) return false;
    if (group?.has(0x9b) && Math.abs(uint(b, group.get(0x9b)) * scale - 1e9 / video.fps) > scale) return false;
    if (!video.pixFmt) video.pixFmt = vp9Keyframe(b.subarray(p + 3, block.end));
    if (!video.pixFmt) return false;
    times.push(base + b.readInt16BE(p));
  }
  return true;
}

function parse(b) {
  const file = elements(b, 0, b.length);
  const header = file.next().value;
  const segment = file.next().value;
  if (header?.id !== EBML || segment?.id !== SEGMENT || !file.next().done) return null;
  const doc = fields(b, header).get(0x4282);
  if (!doc || !/^(matroska|webm)$/.test(b.toString('latin1', doc.start, doc.end))) return null;
  let video = null;
  let audio = null;
  let scale;
  const times = [];
  for (const x of elements(b, segment.start, segment.end)) {
    if (x.id === INFO) {
      if (scale !== undefined) return null;
      scale = uint(b, fields(b, x).get(0x2ad7b1), 1e6);
      if (!scale || scale > 1e6) return null;
    } else if (x.id === TRACKS) {
      if (video || audio) return null;
      let index = 0;
      for (const entry of elements(b, x.start, x.end)) {
        if (entry.id !== 0xae) continue;
        const track = trackInfo(b, entry, index++);
        if (!track) return null;
        if (track.codec && !video) video = track;
        else if (!track.codec && !audio) audio = track;
        else return null;
      }
      if (!video || video.number === audio?.number) return null;
    } else if (x.id === CLUSTER) {
      if (!video || !scale || !checkCluster(b, x, video, audio, scale, times)) return null;
    } else if (x.id === 0x1941a469 || x.id === SEGMENT) return null; // attachments can add streams
  }
  if (times.length < 2) return null;
  times.sort((a, b) => a - b);
  const step = 1e9 / video.fps / scale;
  // EBML only declares a default duration. Check all video timestamps, allowing
  // one tick of rounding, before using it for the native decoder's constant rate.
  if (times.some((t, i) => (i > 0 && t === times[i - 1]) || Math.abs(t - times[0] - i * step) > 1)) return null;
  const { index, codec, width, height, fps, pixFmt } = video;
  return { video: { index, codec, width, height, fps, pixFmt }, audio: audio ? { index: audio.index } : null };
}

async function sniffNativeMatroska(file, stat, signal) {
  if (!/\.(mkv|webm)$/i.test(file) || stat.size > 4 * 1024 * 1024) return null;
  let fd;
  try {
    fd = await fs.promises.open(file, 'r');
    signal?.throwIfAborted();
    const st = await fd.stat();
    if (st.size !== stat.size || st.mtimeMs !== stat.mtimeMs) return null;
    // Read a small segment in one asynchronous operation. The walk skips packet payloads.
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length ? parse(buf) : null;
  } catch { return null; } finally {
    if (fd) try { await fd.close(); } catch { /* ignore */ }
  }
}

module.exports = { sniffNativeMatroska };
